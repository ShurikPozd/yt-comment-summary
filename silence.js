"use strict";

// Пропуск тишины: паузы между фразами в лекциях и подкастах проигрываются быстрее
// (в 2,5 раза, не выше 4×), речь — с вашей скоростью. Экономит 10–20 % времени и не
// ускоряет саму речь.
//  - Звук слушаем копией: video.captureStream() → AnalyserNode. Само воспроизведение
//    не перенаправляется (в отличие от createMediaElementSource): звук идёт как шёл,
//    без задержки, громкость и «без звука» не мешают, а если анализ не удался —
//    просто ничего не ускоряем.
//  - Детектор пауз с порогом под каждый ролик — silence-core.js.
//  - Не трогаем рекламу, прямые эфиры, музыку (категория «Музыка» у видео; у прочих
//    роликов с музыкой обычно нет пауз тише порога), Shorts и встроенные плееры.
//  - Со «Скоростью по каналам» (speed.js) — договор через globalThis.__ytcsSilence:
//    owns(rate) — эта смена скорости наша, временная (speed.js её не запоминает и не
//    «чинит»), baseRate(video) — скорость без нашего ускорения. Любую чужую смену
//    скорости (ваш выбор, speed.js, YouTube) принимаем как новую обычную скорость.
// Настройка — settings.silenceSkip (по умолчанию выкл.); сэкономленное время —
// chrome.storage.local.silenceSaved (формат — silence-core.js).
(() => {
  if (window.top !== window || location.pathname.startsWith("/embed/")) return;
  const core = globalThis.__ytcsSilenceCore;
  if (!core || globalThis.__ytcsSilence) return;

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };

  const TICK = 20; // мс между замерами
  const HOLD_USER = 1500; // после вашей смены скорости — не ускоряем
  const HOLD_OTHER = 600; // после чужой смены скорости
  const OWN_MS = 1500; // столько ждём событие ratechange от своей смены

  // ---------- Состояние ----------
  let enabled = false; // settings.silenceSkip
  let det = core.createDetector();
  let boosted = false;
  let base = 1; // ваша скорость (без нашего ускорения)
  let boostR = 0;
  let holdUntil = 0;
  let expect = []; // свои смены скорости: { r, at }
  let lastAt = 0;
  let pending = 0; // сэкономлено, ещё не записано (сек)
  let stored = null; // silenceSaved из хранилища
  let state = "idle"; // idle | wait (звук ещё не слушаем) | ok | none (звук недоступен)
  let info = { vid: null, data: null };

  // ---------- Плеер ----------
  const player = () => document.getElementById("movie_player");
  const mainVideo = () => player()?.querySelector("video.html5-main-video") || document.querySelector("video.html5-main-video");
  const adShowing = () => Boolean(player()?.classList.contains("ad-showing"));
  const isMain = (e) => e.target instanceof HTMLVideoElement && e.target.classList.contains("html5-main-video");
  const videoIdNow = () => (location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null);
  const same = (a, b) => Math.abs(Number(a) - Number(b)) < 0.001;

  // Канал, эфир, категория — у мира страницы (speed-main.js), ответ синхронный
  function askInfo() {
    let got = null;
    const on = (e) => {
      try {
        got = JSON.parse(e.detail);
      } catch (err) {
        got = null;
      }
    };
    document.addEventListener("ytcs-speed:info", on);
    document.dispatchEvent(new CustomEvent("ytcs-speed:ask"));
    document.removeEventListener("ytcs-speed:info", on);
    return got;
  }
  // false — видео не наше (эфир, музыка) или плеер ещё на прошлом видео
  function videoOk(v, id) {
    if (info.vid !== id || !info.data) {
      const d = askInfo();
      if (d && d.videoId !== id) return false; // плеер ещё не переключился
      info = { vid: id, data: d || {} };
    }
    const d = info.data;
    if (d.live || d.category === "Music" || !Number.isFinite(v.duration)) return false;
    return true;
  }

  // ---------- Скорость ----------
  function setOwn(v, r) {
    expect.push({ r, at: Date.now() });
    if (expect.length > 8) expect.shift();
    v.playbackRate = r;
  }
  function boost(v) {
    const r = core.boostRate(v.playbackRate);
    if (r == null) return;
    base = v.playbackRate;
    boostR = r;
    boosted = true;
    setOwn(v, r);
  }
  function restore(v = mainVideo()) {
    if (!boosted) return;
    boosted = false;
    sendStats(); // пауза кончилась
    if (v && same(v.playbackRate, boostR)) setOwn(v, base);
  }
  function owns(rate) {
    const now = Date.now();
    expect = expect.filter((e) => now - e.at < OWN_MS);
    return expect.some((e) => same(e.r, rate));
  }

  // ---------- Звук: копия дорожки → анализатор ----------
  let ctx = null;
  let cap = null; // { el, stream, src, an, buf }
  let retryAt = 0;
  function ensureCapture(v) {
    if (cap && cap.el === v && cap.stream.getAudioTracks().some((t) => t.readyState === "live")) return cap;
    dropCapture();
    if (typeof v.captureStream !== "function") {
      state = "none";
      return null;
    }
    if (Date.now() < retryAt) return null;
    try {
      ctx ||= new AudioContext({ latencyHint: "interactive" });
      const stream = v.captureStream();
      for (const t of stream.getVideoTracks()) t.stop(); // картинка не нужна — только звук
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((t) => t.stop());
        retryAt = Date.now() + 1000; // дорожки ещё нет — попробуем через секунду
        return null;
      }
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024; // ~21 мс при 48 кГц
      src.connect(an); // анализатор никуда не выводит: слышно по-прежнему сам <video>
      const track = stream.getAudioTracks()[0];
      // первые кадры анализатор отдаёт нули — их не считаем тишиной
      cap = { el: v, stream, src, an, buf: new Float32Array(an.fftSize), skip: 4 };
      // Chrome сообщает addtrack и про уже взятую дорожку; другая звуковая дорожка —
      // YouTube сменил источник (новое видео): подключаемся заново
      stream.addEventListener("addtrack", (e) => {
        if (e.track.kind === "video") e.track.stop();
        else if (e.track.id !== track.id && cap?.stream === stream) dropCapture();
      });
      return cap;
    } catch (e) {
      state = "none"; // защищённое видео и т. п. — без ускорения пауз
      retryAt = Date.now() + 5000;
      return null;
    }
  }
  function dropCapture() {
    if (!cap) return;
    try {
      cap.src.disconnect();
    } catch (e) {
      /* уже отключён */
    }
    for (const t of cap.stream.getTracks()) t.stop(); // копия; сам <video> играет дальше
    cap = null;
  }
  // AudioContext без щелчка по странице может стоять на паузе — запускаем при первом
  // же щелчке или клавише (воспроизведению это не мешает: звук идёт мимо него).
  for (const t of ["pointerdown", "keydown"]) {
    document.addEventListener(t, () => ctx?.state === "suspended" && void ctx.resume().catch(() => {}), true);
  }

  // ---------- Цикл ----------
  let timer = 0;
  function start() {
    if (timer) return;
    lastAt = performance.now();
    timer = setInterval(tick, TICK);
  }
  function stop() {
    clearInterval(timer);
    timer = 0;
    restore();
    dropCapture();
    det.interrupt();
    flush();
  }

  let curVid = null;
  function tick() {
    if (!alive()) return stop();
    const now = performance.now();
    const dt = Math.min(250, now - lastAt);
    lastAt = now;
    const v = mainVideo();
    const id = videoIdNow();
    if (id !== curVid) {
      curVid = id;
      restore(v);
      det = core.createDetector(); // новый ролик — свои уровни
      holdUntil = Date.now() + HOLD_OTHER;
    }
    const playing = v && !v.paused && !v.ended && !v.seeking && v.readyState >= 3;
    if (!enabled || !id || !playing || adShowing() || !videoOk(v, id)) {
      restore(v);
      det.interrupt();
      return;
    }
    const c = ensureCapture(v);
    if (!c) return restore(v);
    if (ctx.state !== "running") {
      state = "wait";
      return restore(v);
    }
    state = "ok";
    if (c.skip > 0 && c.skip--) return;
    c.an.getFloatTimeDomainData(c.buf);
    const silent = det.push(core.levelDb(c.buf), dt * v.playbackRate);
    if (boosted) {
      if (!same(v.playbackRate, boostR)) {
        boosted = false; // скорость сменили не мы, а событие ещё не дошло
      } else {
        addPending(core.savedSec(dt / 1000, boostR, base));
        if (!silent) restore(v);
      }
    } else if (silent && Date.now() >= holdUntil) {
      boost(v);
    }
  }

  // Чужая смена скорости (вы, «Скорость по каналам», YouTube) — новая обычная скорость
  document.addEventListener(
    "ratechange",
    (e) => {
      if (!isMain(e)) return;
      const rate = e.target.playbackRate;
      if (owns(rate)) return;
      boosted = false;
      base = rate;
      holdUntil = Math.max(holdUntil, Date.now() + HOLD_OTHER);
    },
    true
  );
  // Вы меняете скорость (Shift+> / Shift+<, меню YouTube или меню расширения) —
  // сначала возвращаем свою, чтобы шаг шёл от вашей скорости, а не от ускоренной.
  const MENU = ".ytp-settings-menu, .ytp-popup, .ytp-panel, [class*='ytp-speed'], [class*='ytp-variable-speed'], .ytcs-menu";
  function userInput() {
    restore();
    expect = expect.filter((e) => same(e.r, base)); // ваша новая скорость не спутается с нашей
    holdUntil = Date.now() + HOLD_USER;
  }
  document.addEventListener("pointerdown", (e) => e.target?.closest?.(MENU) && userInput(), true);
  document.addEventListener(
    "keydown",
    (e) => (e.key === ">" || e.key === "<" || (e.shiftKey && (e.code === "Period" || e.code === "Comma"))) && userInput(),
    true
  );
  // Новое видео, перемотка — паузу считаем заново
  for (const t of ["emptied", "loadstart", "seeking", "pause"]) {
    document.addEventListener(
      t,
      (e) => {
        if (!isMain(e)) return;
        restore(e.target);
        det.interrupt();
      },
      true
    );
  }
  window.addEventListener("yt-navigate-start", () => restore());

  // ---------- Сэкономленное время ----------
  function addPending(sec) {
    pending += sec;
    statsSec += sec;
    if (pending >= 30) flush();
  }
  // Статистике просмотра (stats.js, тот же кадр) — по событию на каждую паузу,
  // сколько секунд реального времени она сберегла (дни раскладывает сама)
  let statsSec = 0;
  function sendStats() {
    if (statsSec < 0.05) return;
    const sec = Math.round(statsSec * 100) / 100;
    statsSec = 0;
    document.dispatchEvent(new CustomEvent("ytcs-stats:saved", { detail: JSON.stringify({ kind: "silence", sec }) }));
  }
  let writing = Promise.resolve();
  function flush() {
    sendStats();
    const add = pending;
    if (add < 0.05 || !alive()) return;
    pending = 0;
    writing = writing
      .then(() => chrome.storage.local.get(core.storeKey))
      .then((o) => {
        stored = core.addSaved(o[core.storeKey], add);
        return chrome.storage.local.set({ [core.storeKey]: stored });
      })
      .catch(() => {});
  }
  document.addEventListener("visibilitychange", () => document.hidden && flush());
  window.addEventListener("pagehide", flush);

  // ---------- Для меню кнопки расширения в плеере (content.js) и speed.js ----------
  globalThis.__ytcsSilence = {
    owns,
    baseRate: (v) => (boosted && v && v === mainVideo() && same(v.playbackRate, boostR) ? base : v?.playbackRate),
    // { on, state, today, total } — today/total в секундах, с ещё не записанным
    status: () => ({ on: enabled, state, today: core.todaySaved(stored) + pending, total: (Number(stored?.total) || 0) + pending }),
  };

  // ---------- Настройки ----------
  if (!alive()) return;
  function setEnabled(on) {
    enabled = Boolean(on);
    if (enabled) start();
    else stop();
  }
  chrome.storage.local
    .get(["settings", core.storeKey])
    .then((o) => {
      stored = o[core.storeKey] || null;
      setEnabled(o.settings?.silenceSkip);
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) setEnabled(changes.settings.newValue?.silenceSkip);
    if (changes[core.storeKey]) stored = changes[core.storeKey].newValue || null;
  });
})();
