// Клипы: захват отрезка видео из того, что качает сам плеер YouTube.
// Скрипт живёт в мире страницы (world: MAIN) — только здесь видны вызовы
// SourceBuffer.appendBuffer плеера и его API (качество, перемотка).
//
// Как это работает:
//  1. На время клипа плееру «говорим», что AV1/VP9/Opus не поддерживаются, —
//     он переходит на H.264 + AAC в MP4: такой файл открывается у всех.
//  2. Перезагружаем видео с начала отрезка в нужном качестве и, не проигрывая,
//     даём плееру подкачать отрезок (перемотка к краю подкачанного).
//  3. Куски, которые плеер отдаёт в буфер, разбираем на фрагменты MP4 (moof+mdat)
//     с точным временем и собираем чистую дорожку: init + фрагменты по порядку.
//  4. Дорожки уходят в изолированный мир (clip.js) — там склейка и сохранение.
//  5. Возвращаем плеер как было: то же место, качество, пауза или воспроизведение.
// Управление — событие "ytcs-clip" на document (JSON в detail), ответы —
// window.postMessage({ __ytcsClip: id, ... }).
(() => {
  if (window.__ytcsClipMain) return;
  window.__ytcsClipMain = true;

  // ---------- Подмена поддержки кодеков (только на время клипа) ----------
  let spoof = false;
  const BAD = /av01|vp0?9|vp8|opus|vorbis|webm/i;
  const wrapIts = (Cls) => {
    if (!Cls?.isTypeSupported) return;
    const orig = Cls.isTypeSupported;
    Cls.isTypeSupported = function isTypeSupported(t) {
      return spoof && BAD.test(String(t)) ? false : orig.call(this, t);
    };
  };
  wrapIts(window.MediaSource);
  wrapIts(window.ManagedMediaSource);
  const canPlay = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function canPlayType(t) {
    return spoof && BAD.test(String(t)) ? "" : canPlay.call(this, t);
  };
  const mc = navigator.mediaCapabilities;
  if (mc?.decodingInfo) {
    const dec = mc.decodingInfo.bind(mc);
    mc.decodingInfo = function decodingInfo(cfg) {
      const ct = `${cfg?.video?.contentType || ""} ${cfg?.audio?.contentType || ""}`;
      if (spoof && BAD.test(ct)) return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
      return dec(cfg);
    };
  }

  // ---------- Разбор MP4 (ISO BMFF) ----------
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const type4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  // дочерние боксы в диапазоне [start, end)
  function* boxes(b, start, end) {
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o);
      let hdr = 8;
      if (size === 1) {
        size = u64(b, o + 8);
        hdr = 16;
      } else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) return;
      yield { t: type4(b, o + 4), body: o + hdr, end: o + size };
      o += size;
    }
  }
  const child = (b, box, t) => {
    for (const c of boxes(b, box.body, box.end)) if (c.t === t) return c;
    return null;
  };
  const dig = (b, box, ...path) => path.reduce((cur, t) => cur && child(b, cur, t), box);
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };

  // init (ftyp+moov): шкала времени, тип дорожки, кодек, длительность сэмпла по умолчанию
  function parseInit(b) {
    const root = { body: 0, end: b.length };
    const moov = child(b, root, "moov");
    const trak = moov && child(b, moov, "trak");
    const mdhd = dig(b, trak, "mdia", "mdhd");
    const hdlr = dig(b, trak, "mdia", "hdlr");
    const stsd = dig(b, trak, "mdia", "minf", "stbl", "stsd");
    const trex = dig(b, moov, "mvex", "trex");
    if (!mdhd || !hdlr) return null;
    const ts = b[mdhd.body] === 1 ? u32(b, mdhd.body + 20) : u32(b, mdhd.body + 12);
    return {
      ts,
      kind: type4(b, hdlr.body + 8), // vide | soun
      codec: stsd ? type4(b, stsd.body + 12) : "", // avc1 | mp4a | av01 …
      height: stsd && type4(b, hdlr.body + 8) === "vide" ? (b[stsd.body + 42] << 8) | b[stsd.body + 43] : 0,
      // «отпечаток» формата: описание кодека (stsd) и шкала времени. После
      // перезагрузки видео YouTube присылает init с другими байтами (время
      // создания и т. п.), но фрагменты той же дорожки взаимозаменяемы.
      key: `${type4(b, hdlr.body + 8)}|${ts}|${stsd ? Array.prototype.join.call(b.subarray(stsd.body, stsd.end), ",") : ""}`,
      defDur: trex ? u32(b, trex.body + 12) : 0,
    };
  }

  // moof: время начала фрагмента (tfdt) и его длительность (сумма сэмплов trun)
  function parseMoof(b, defDur) {
    // b — весь бокс moof с заголовком: дети начинаются после него
    const traf = child(b, { body: u32(b, 0) === 1 ? 16 : 8, end: b.length }, "traf");
    if (!traf) return null;
    const tfdt = child(b, traf, "tfdt");
    const tfhd = child(b, traf, "tfhd");
    if (!tfdt) return null;
    const t = b[tfdt.body] === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4);
    let def = defDur;
    if (tfhd) {
      const fl = u32(b, tfhd.body) & 0xffffff;
      let o = tfhd.body + 8;
      if (fl & 0x1) o += 8;
      if (fl & 0x2) o += 4;
      if (fl & 0x8) def = u32(b, o);
    }
    let dur = 0;
    for (const c of boxes(b, traf.body, traf.end)) {
      if (c.t !== "trun") continue;
      const fl = u32(b, c.body) & 0xffffff;
      const n = u32(b, c.body + 4);
      let o = c.body + 8;
      if (fl & 0x1) o += 4;
      if (fl & 0x4) o += 4;
      const step = (fl & 0x100 ? 4 : 0) + (fl & 0x200 ? 4 : 0) + (fl & 0x400 ? 4 : 0) + (fl & 0x800 ? 4 : 0);
      if (fl & 0x100) for (let i = 0; i < n; i++) dur += u32(b, o + i * step);
      else dur += def * n;
    }
    return { t, dur };
  }

  // Поток одного SourceBuffer: куски приходят как угодно нарезанными —
  // копим и отдаём целыми боксами верхнего уровня.
  class Track {
    // formats — общий список форматов на весь клип: после перезагрузки видео у
    // плеера новые SourceBuffer, а уже собранные фрагменты должны сохраниться
    constructor(formats = []) {
      this.q = [];
      this.qLen = 0;
      this.ftyp = null;
      this.fmt = null; // текущий формат: { init, info, frags }
      this.formats = formats; // все встреченные форматы (смена качества посреди клипа)
      this.moof = null;
    }
    get info() {
      return this.fmt?.info || null;
    }
    // SourceBuffer.abort(): плеер выбросил недокачанный кусок — и мы тоже
    reset() {
      this.q = [];
      this.qLen = 0;
      this.moof = null;
    }
    push(u8) {
      this.q.push(u8);
      this.qLen += u8.length;
      while (this.qLen >= 8) {
        const h = this.peek(Math.min(16, this.qLen));
        let size = u32(h, 0);
        if (size === 1) {
          if (h.length < 16) return;
          size = u64(h, 8);
        }
        if (size < 8 || size > 1e9) return this.reset(); // не MP4 или сбой — начинаем заново
        if (this.qLen < size) return;
        this.onBox(type4(h, 4), this.take(size));
      }
    }
    peek(n) {
      const out = new Uint8Array(n);
      let k = 0;
      for (const c of this.q) {
        const m = Math.min(c.length, n - k);
        out.set(c.subarray(0, m), k);
        k += m;
        if (k === n) break;
      }
      return out;
    }
    take(n) {
      const out = new Uint8Array(n);
      let k = 0;
      while (k < n) {
        const c = this.q[0];
        const m = Math.min(c.length, n - k);
        out.set(c.subarray(0, m), k);
        k += m;
        if (m === c.length) this.q.shift();
        else this.q[0] = c.subarray(m);
      }
      this.qLen -= n;
      return out;
    }
    onBox(t, b) {
      if (t === "ftyp") this.ftyp = b;
      else if (t === "moov") {
        const init = this.ftyp ? concat(this.ftyp, b) : b;
        const info = parseInit(init);
        if (!info) return;
        // тот же формат (плеер повторил init или видео перезагрузили) — копим туда же
        this.fmt = this.formats.find((f) => f.info.key === info.key) || null;
        if (!this.fmt) this.formats.push((this.fmt = { init, info, frags: new Map() }));
        else this.fmt.init = init;
      } else if (t === "moof") this.moof = b;
      else if (t === "mdat" && this.moof && this.fmt) {
        const { info, frags } = this.fmt;
        const m = parseMoof(this.moof, info.defDur);
        if (m) frags.set(m.t, { t: m.t / info.ts, d: m.dur / info.ts, bytes: concat(this.moof, b) });
        this.moof = null;
      }
    }
    // Сколько секунд отрезка [a, z] покрыто фрагментами подряд. atEnd — отрезок
    // упирается в конец видео: дорожка там обычно кончается чуть раньше
    // заявленной длительности, поэтому дошли до последнего фрагмента — значит всё.
    static coverage(fmt, a, z, atEnd) {
      const list = [...fmt.frags.values()].sort((x, y) => x.t - y.t);
      let i = list.findIndex((f) => f.t <= a + 0.01 && f.t + f.d > a);
      if (i < 0) return 0;
      let end = list[i].t + list[i].d;
      for (i++; i < list.length && end < z; i++) {
        if (list[i].t > end + 0.15) break; // дыра
        end = Math.max(end, list[i].t + list[i].d);
      }
      if (atEnd && i >= list.length && end >= z - 1.5) end = z;
      return Math.max(0, Math.min(end, z) - a);
    }
    // формат дорожки kind (vide | soun), который лучше всех покрывает отрезок
    // (при равенстве — последний встреченный)
    best(a, z, atEnd, kind) {
      let pick = null;
      let got = -1;
      for (const f of this.formats) {
        if (kind && f.info.kind !== kind) continue;
        const c = Track.coverage(f, a, z, atEnd);
        if (c >= got) {
          got = c;
          pick = f;
        }
      }
      return { fmt: pick, got: Math.max(0, got) };
    }
    // чистая дорожка: init + фрагменты отрезка по порядку
    static build(fmt, a, z) {
      const list = [...fmt.frags.values()].filter((f) => f.t + f.d > a - 0.001 && f.t < z).sort((x, y) => x.t - y.t);
      return concat(fmt.init, ...list.map((f) => f.bytes));
    }
  }

  // ---------- Перехват буфера плеера ----------
  let cap = null; // { tracks: Map<SourceBuffer, Track> } — пока идёт клип
  const append = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function appendBuffer(data) {
    // копия — до вызова (плеер может отдать буфер дальше), а в захват — только
    // если плеер кусок принял: при ошибке он пришлёт его заново
    let copy = null;
    if (cap) {
      try {
        const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        copy = u8.slice();
      } catch (e) {
        /* захват не должен мешать воспроизведению */
      }
    }
    const r = append.call(this, data);
    if (copy && cap) {
      try {
        let tr = cap.tracks.get(this);
        if (!tr) cap.tracks.set(this, (tr = new Track(cap.formats)));
        tr.push(copy);
      } catch (e) {
        /* то же */
      }
    }
    return r;
  };
  const abort = SourceBuffer.prototype.abort;
  SourceBuffer.prototype.abort = function abortBuffer() {
    if (cap) cap.tracks.get(this)?.reset();
    return abort.call(this);
  };

  // ---------- Клип ----------
  const QUALITY = ["hd2160", "hd1440", "hd1080", "hd720", "large", "medium", "small", "tiny"];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const post = (id, msg, transfer = []) => window.postMessage({ __ytcsClip: id, ...msg }, location.origin, transfer);
  const fail = (code) => Object.assign(new Error(code), { code });
  const player = () => document.getElementById("movie_player");
  const videoEl = () => player()?.querySelector("video");
  let running = null;

  // Отладка: сводка последнего клипа — какие дорожки и куски собрались, что
  // делал плеер. В консоли страницы: __ytcsClipDebug()
  let lastRun = null;
  const summarize = (formats) =>
    formats.map((f) => {
      const list = [...f.frags.values()].sort((a, b) => a.t - b.t);
      const ranges = [];
      for (const fr of list) {
        const last = ranges[ranges.length - 1];
        if (last && fr.t <= last[1] + 0.15) last[1] = Math.max(last[1], fr.t + fr.d);
        else ranges.push([fr.t, fr.t + fr.d]);
      }
      return { kind: f.info.kind, codec: f.info.codec, height: f.info.height, frags: list.length, ranges: ranges.map(([a, z]) => `${a.toFixed(1)}–${z.toFixed(1)}`) };
    });
  window.__ytcsClipDebug = () => lastRun;

  function info() {
    const p = player();
    const v = videoEl();
    const d = p?.getVideoData?.() || {};
    return {
      ok: Boolean(p?.loadVideoById && v),
      videoId: d.video_id || null,
      title: d.title || "",
      author: d.author || "",
      duration: p?.getDuration?.() || v?.duration || 0,
      currentTime: v?.currentTime || 0,
      levels: p?.getAvailableQualityLevels?.() || [],
      live: Boolean(d.isLive),
      ad: Boolean(p?.classList.contains("ad-showing")),
    };
  }

  // лучшее доступное качество, не выше запрошенного
  function pickQuality(levels, want) {
    const wi = QUALITY.indexOf(want);
    return QUALITY.slice(Math.max(0, wi)).find((q) => levels.includes(q)) || levels.find((q) => q !== "auto") || want;
  }

  async function run(req) {
    const p = player();
    const before = info();
    if (!before.ok) throw fail("noplayer");
    if (before.ad) throw fail("ad");
    if (before.live) throw fail("live");
    const vid = before.videoId;
    const start = Math.max(0, Math.min(Number(req.start) || 0, before.duration));
    const end = Math.max(start, Math.min(Number(req.end) || 0, before.duration));
    if (end - start < 0.5) throw fail("range");
    const want = req.audioOnly ? ["soun"] : ["vide", "soun"];
    const saved = {
      // куда вернуть видео: окно клипа присылает место, с которого его открыли
      t: Number.isFinite(Number(req.restoreAt)) ? Number(req.restoreAt) : before.currentTime,
      muted: Boolean(p.isMuted?.()),
      // настройка качества пользователя («авто» или выбранное), а не текущее фактическое
      pref: p.getPreferredQuality?.() || "auto",
    };
    const atEnd = end >= before.duration - 1.5;
    // resume: продолжить воспроизведение после возврата (окно закрыли посреди клипа)
    const mine = (running = { id: req.id, cancelled: false, navigated: false, resume: false });
    let restored = false;

    const restore = async () => {
      if (restored) return;
      restored = true;
      try {
        // качество и звук возвращаем всегда — даже если вы уже ушли на другое видео
        if (saved.pref && saved.pref !== "auto") p.setPlaybackQualityRange?.(saved.pref, saved.pref);
        else p.setPlaybackQualityRange?.("auto", "auto");
        if (!saved.muted) p.unMute?.();
        if (mine.navigated) return; // своё место у нового видео — не трогаем
        p.loadVideoById({ videoId: vid, startSeconds: saved.t });
        if (mine.resume) {
          // окно закрыли, а до него видео играло — продолжаем; для блокировщика
          // автозапуска это ваше действие (early-main.js / early.js)
          document.dispatchEvent(new CustomEvent("ytcs-allow"));
          document.dispatchEvent(new CustomEvent("ytcs-gesture"));
          await sleep(300);
          p.playVideo?.();
        } else {
          // окно клипа ещё открыто (или видео стояло) — не даём плееру запуститься самому
          const until = Date.now() + 2500;
          while (Date.now() < until) {
            await sleep(150);
            if (videoEl() && !videoEl().paused) videoEl().pause();
          }
        }
      } catch (e) {
        /* вернуть как было не вышло — видео просто останется на месте клипа */
      }
    };

    spoof = true;
    cap = { tracks: new Map(), formats: [] };
    const log = []; // для __ytcsClipDebug
    const t0 = Date.now();
    const note = (what) => log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${what}`);
    note(`start ${start.toFixed(1)}–${end.toFixed(1)} ${req.audioOnly ? "audio" : req.quality}`);
    const anyTrack = new Track(cap.formats); // только для подсчёта покрытия по общему списку
    try {
      p.mute?.();
      p.loadVideoById({ videoId: vid, startSeconds: start, suggestedQuality: req.audioOnly ? "tiny" : req.quality });
      let qualitySet = false;
      let best = -1;
      let lastGain = Date.now();
      let adSince = 0;
      let bufEnd = 0; // край подкачанного и когда он последний раз двигался
      let bufMovedAt = Date.now();
      let reloads = 0;
      for (;;) {
        await sleep(200);
        if (mine.cancelled) throw fail(mine.navigated ? "navigated" : "cancelled");
        const v = videoEl();
        // перезагрузка видео может запустить рекламу — ждём её конца (без звука)
        if (p.classList.contains("ad-showing")) {
          if (!adSince) {
            adSince = Date.now();
            post(req.id, { type: "progress", share: Math.max(0, best), ad: true });
          }
          if (Date.now() - adSince > 90000) throw fail("ad");
          lastGain = Date.now();
          continue;
        }
        if (adSince) {
          adSince = 0;
          post(req.id, { type: "progress", share: Math.max(0, best) });
        }
        if (v && !v.paused) v.pause();
        if (!qualitySet) {
          const levels = p.getAvailableQualityLevels?.() || [];
          if (levels.length) {
            const q = req.audioOnly ? "tiny" : pickQuality(levels, req.quality);
            p.setPlaybackQualityRange?.(q, q);
            qualitySet = true;
          }
        }
        // плеер не послушался подмены кодеков — честно говорим, а не сохраняем непонятный файл
        for (const f of cap.formats) {
          if (f.info.kind === "vide" && !/^avc/.test(f.info.codec)) throw fail("codec");
          if (f.info.kind === "soun" && !/^mp4a/.test(f.info.codec)) throw fail("codec");
        }
        const picks = Object.fromEntries(want.map((k) => [k, anyTrack.best(start, end, atEnd, k)]));
        const got = Math.min(...want.map((k) => picks[k].got));
        const share = got / (end - start);
        if (share > best + 0.001) {
          best = share;
          lastGain = Date.now();
          post(req.id, { type: "progress", share });
        }
        if (got >= end - start - 0.05) {
          note("done");
          const out = want.map((k) => ({ kind: k, info: picks[k].fmt.info, bytes: Track.build(picks[k].fmt, start, end) }));
          const height = out.find((t) => t.kind === "vide")?.info.height || 0;
          post(
            req.id,
            { type: "done", start, end, height, tracks: out.map(({ kind, info: inf, bytes }) => ({ kind, codec: inf.codec, bytes: bytes.buffer })) },
            out.map((t) => t.bytes.buffer)
          );
          return;
        }
        if (Date.now() - lastGain > 25000) throw fail("stall");
        if (!v) continue;
        // край подкачанного вокруг текущего места
        let edge = 0;
        const b = v.buffered;
        for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5 && b.end(i) > v.currentTime) edge = b.end(i);
        if (Math.abs(edge - bufEnd) > 0.05) {
          bufEnd = edge;
          bufMovedAt = Date.now();
        }
        const idle = Date.now() - bufMovedAt > 700; // плеер докачал до своей цели и ждёт
        const gapAt = start + got; // где обрывается собранное подряд
        if (idle && edge > gapAt + 1 && Date.now() - lastGain > 2500 && reloads < 3) {
          // Дыра: плеер оборвал передачу куска (abort), но считает его своим и
          // заново не качает. Перезагружаем видео с места дыры — собранное
          // сохраняется (общий список форматов), недостающее докачается.
          reloads++;
          note(`reload at ${Math.max(start, gapAt - 1).toFixed(1)} (gap ${gapAt.toFixed(1)}, buffered to ${edge.toFixed(1)})`);
          p.loadVideoById({ videoId: vid, startSeconds: Math.max(start, gapAt - 1), suggestedQuality: req.audioOnly ? "tiny" : req.quality });
          qualitySet = false;
          bufEnd = 0;
          bufMovedAt = Date.now();
          lastGain = Date.now();
          continue;
        }
        // Подталкиваем плеер: на паузе он качает ~25 с вперёд. Перематываем к краю
        // подкачанного — но только когда он сам не качает: иначе перемотка обрывает
        // передачу куска на середине и в собранном остаётся дыра.
        if (idle && edge > 0 && edge < end && v.currentTime < edge - 2) {
          note(`seek ${Math.min(end, edge - 1).toFixed(1)} (have ${got.toFixed(1)} s)`);
          p.seekTo?.(Math.min(end, edge - 1), true);
          bufMovedAt = Date.now();
        }
      }
    } catch (e) {
      note(`error ${e?.code || e?.message || e}`);
      throw e;
    } finally {
      lastRun = { log, formats: summarize(cap.formats) };
      cap = null;
      spoof = false;
      await restore();
      running = null; // только после возврата: новый клип не пересечётся с ним
    }
  }

  document.addEventListener("ytcs-clip", (e) => {
    let req;
    try {
      req = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    if (!req?.id) return;
    if (req.op === "info") post(req.id, { type: "info", ...info() });
    else if (req.op === "cancel") {
      if (running?.id === req.id) {
        running.cancelled = true;
        running.resume = Boolean(req.resume);
      }
    } else if (req.op === "start") {
      if (running) return post(req.id, { type: "error", code: "busy" });
      run(req).catch((err) => post(req.id, { type: "error", code: err?.code || "fail", message: String(err?.message || err) }));
    }
  });

  // ушли на другое видео посреди клипа — останавливаемся; место в видео не трогаем,
  // звук и качество возвращаем (restore)
  window.addEventListener("yt-navigate-start", () => {
    if (!running) return;
    running.cancelled = true;
    running.navigated = true;
  });
})();
