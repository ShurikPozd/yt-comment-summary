// Клипы: окно «Вырезать клип» поверх YouTube, склейка и сохранение файла.
// Захват кусков видео — в clip-main.js (мир страницы); здесь — интерфейс и
// сборка MP4 библиотекой Mediabunny (vendor/, без перекодирования: пакеты
// копируются как есть, поэтому быстро и без потери качества).
(() => {
  if (globalThis.__ytcsClip) return;

  const MAX_LEN = 180; // не длиннее 3 минут: и файл разумный, и память браузера
  const DEFAULT_LEN = 30;
  const MODES = [
    { id: "hd720", label: "720p" },
    { id: "hd1080", label: "1080p" },
    { id: "audio", label: "Только звук" },
  ];
  const ERRORS = {
    ad: "Сейчас идёт реклама — дождитесь её конца",
    live: "Прямые трансляции вырезать нельзя",
    codec: "YouTube не отдал видео в MP4 — обновите страницу и попробуйте ещё раз",
    stall: "YouTube перестал отдавать видео — проверьте связь и попробуйте ещё раз",
    busy: "Предыдущий клип ещё завершается — попробуйте через пару секунд",
    noplayer: "Плеер не найден — обновите страницу",
    range: "Отрезок слишком короткий",
    noreply: "Обновите страницу видео (F5): расширение обновилось",
    mux: "Не получилось собрать файл клипа",
    fail: "Не получилось вырезать клип",
  };

  const SVG = (paths) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    close: SVG('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
    download: SVG('<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>'),
    now: SVG('<path d="M12 3v3"/><circle cx="12" cy="14" r="7"/><path d="M12 11v3l2 1.5"/>'),
    link: SVG('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>'),
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13l10.5-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect fill="currentColor" x="6" y="5" width="4.2" height="14" rx="1.2"/><rect fill="currentColor" x="13.8" y="5" width="4.2" height="14" rx="1.2"/></svg>',
  };

  // ---------- время ----------
  const pad = (n) => String(n).padStart(2, "0");
  function fmt(t) {
    const s = Math.max(0, Math.round(t));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }
  // «90», «1:30», «1:02:03», «1:30,5» → секунды
  function parseTime(text) {
    const parts = String(text || "").trim().replace(",", ".").split(":");
    if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
    return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
  }
  const fileTime = (t) => fmt(t).replace(/:/g, ".");
  const safeName = (s) =>
    String(s || "YouTube")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "YouTube";

  // ---------- связь с clip-main.js ----------
  const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const toMain = (msg) => document.dispatchEvent(new CustomEvent("ytcs-clip", { detail: JSON.stringify(msg) }));
  const listeners = new Map(); // id → (data) => void
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || typeof e.data.__ytcsClip !== "string") return;
    listeners.get(e.data.__ytcsClip)?.(e.data);
  });
  function askInfo() {
    const id = newId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        listeners.delete(id);
        resolve(null);
      }, 1500);
      listeners.set(id, (d) => {
        if (d.type !== "info") return;
        clearTimeout(timer);
        listeners.delete(id);
        resolve(d);
      });
      toMain({ op: "info", id });
    });
  }

  // ---------- склейка ----------
  // Mediabunny (760 КБ) нужна только для клипов: по первому клипу фон вставляет
  // её в этот же изолированный мир (chrome.scripting) — не грузим на каждой
  // странице и не открываем файлы расширения сайту.
  let mbLoading = null;
  function mediabunny() {
    if (globalThis.__ytcsMediabunny) return Promise.resolve(globalThis.__ytcsMediabunny);
    mbLoading ||= chrome.runtime.sendMessage({ type: "clip:lib" }).then((r) => {
      if (!r?.ok || !globalThis.__ytcsMediabunny) {
        mbLoading = null;
        throw new Error(r?.error || "mediabunny not loaded");
      }
      return globalThis.__ytcsMediabunny;
    });
    return mbLoading;
  }

  // Дорожки из clip-main.js → один MP4 (или M4A) с отрезком [start, end].
  // Без перекодирования видео можно начать только с опорного кадра (у YouTube
  // они бывают и через 5 с), поэтому время отсчитываем от start: кадры между
  // опорным и start получают отрицательное время — плеер их декодирует, но не
  // показывает (список правок MP4). Клип начинается ровно с выбранной секунды.
  async function mux(tracks, start, end) {
    const M = await mediabunny();
    const open = (t) => new M.Input({ source: new M.BufferSource(t.bytes), formats: M.ALL_FORMATS });
    const vIn = tracks.find((t) => t.kind === "vide");
    const aIn = tracks.find((t) => t.kind === "soun");
    const vt = vIn ? await open(vIn).getPrimaryVideoTrack() : null;
    const at = aIn ? await open(aIn).getPrimaryAudioTrack() : null;
    if (!vt && !at) throw new Error("no tracks");
    const out = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: "in-memory" }), target: new M.BufferTarget() });
    const vSrc = vt && new M.EncodedVideoPacketSource(vt.codec);
    const aSrc = at && new M.EncodedAudioPacketSource(at.codec);
    if (vSrc) out.addVideoTrack(vSrc);
    if (aSrc) out.addAudioTrack(aSrc);
    await out.start();

    if (vt) {
      const sink = new M.EncodedPacketSink(vt);
      const key = (await sink.getKeyPacket(start)) || (await sink.getFirstPacket());
      if (!key) throw new Error("no video");
      let meta = { decoderConfig: await vt.getDecoderConfig() };
      for await (const p of sink.packets(key)) {
        if (p.timestamp >= end) break;
        await vSrc.add(p.clone({ timestamp: p.timestamp - start }), meta);
        meta = undefined;
      }
    }
    if (at) {
      const sink = new M.EncodedPacketSink(at);
      const first = (await sink.getPacket(start)) || (await sink.getFirstPacket());
      if (!first) throw new Error("no audio");
      let meta = { decoderConfig: await at.getDecoderConfig() };
      for await (const p of sink.packets(first)) {
        if (p.timestamp >= end) break;
        await aSrc.add(p.clone({ timestamp: p.timestamp - start }), meta);
        meta = undefined;
      }
    }
    await out.finalize();
    return { blob: new Blob([out.target.buffer], { type: vt ? "video/mp4" : "audio/mp4" }), start };
  }

  function saveFile(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.style.display = "none";
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---------- окно ----------
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 16px;
      font: 500 14px/1.35 Roboto, "YouTube Sans", "Segoe UI", system-ui, sans-serif; color: #f1f1f1; }
    .bg { position: absolute; inset: 0; background: rgba(8, 8, 10, .6);
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); opacity: 0; transition: opacity .2s ease-out; }
    .dlg { position: relative; display: flex; flex-direction: column; gap: 16px; width: min(520px, 100%);
      padding: 20px; border-radius: 18px; background: rgba(28, 28, 30, .94);
      -webkit-backdrop-filter: blur(24px) saturate(1.6); backdrop-filter: blur(24px) saturate(1.6);
      box-shadow: 0 24px 70px rgba(0, 0, 0, .55), inset 0 0 0 1px rgba(255, 255, 255, .07);
      opacity: 0; transform: translateY(8px) scale(.97);
      transition: opacity .18s ease-out, transform .26s cubic-bezier(.23, 1, .32, 1); }
    .wrap.open .bg { opacity: 1; }
    .wrap.open .dlg { opacity: 1; transform: none; }
    .dlg:focus { outline: none; }

    .top { display: flex; align-items: flex-start; gap: 12px; }
    .heads { flex: 1; min-width: 0; }
    h2 { margin: 0; font-size: 17px; font-weight: 650; line-height: 1.25; }
    .sub { margin-top: 3px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: #a6a6ad; font-size: 13px; }

    button { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center;
      justify-content: center; gap: 6px; height: 36px; padding: 0 14px 1px; border-radius: 10px;
      font: inherit; font-weight: 600; color: #f1f1f1; background: rgba(255, 255, 255, .1); white-space: nowrap;
      transition: background-color .14s ease, color .14s ease, transform .1s ease-out, opacity .14s ease; }
    button:hover { background: rgba(255, 255, 255, .18); }
    button:active { transform: scale(.97); }
    button:focus-visible { outline: 2px solid rgba(255, 255, 255, .75); outline-offset: 2px; }
    button:disabled { cursor: default; opacity: .45; transform: none; }
    button svg { width: 18px; height: 18px; flex: none; }
    .x { flex: none; width: 36px; padding: 0; border-radius: 50%; }

    .dlg { --z: 1; zoom: var(--z); width: min(560px, calc((100vw - 32px) / var(--z)));
      max-height: calc((100vh - 32px) / var(--z)); overflow: auto; scrollbar-width: none; }
    /* на больших экранах окно крупнее — пропорционально, со всеми надписями */
    @media (min-width: 1600px) and (min-height: 860px) { .dlg { --z: 1.2; } }
    @media (min-width: 2200px) and (min-height: 1150px) { .dlg { --z: 1.45; } }
    /* в низком окне блоки не сплющиваются — окно прокручивается */
    .dlg > * { flex-shrink: 0; }

    /* предпросмотр: кадр из видео; ручки и поля сразу показывают выбранный момент */
    .pv { position: relative; flex: none; aspect-ratio: 16 / 9; max-height: 36vh; border-radius: 12px; overflow: hidden;
      background: #000; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .06); }
    .pv canvas { display: block; width: 100%; height: 100%; object-fit: contain; }
    .pv-bar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 10px;
      padding: 28px 10px 10px; background: linear-gradient(transparent, rgba(0, 0, 0, .7)); }
    .pv-play { height: 32px; padding: 0 12px 0 9px; border-radius: 999px; background: rgba(255, 255, 255, .2);
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); font-size: 13px; }
    .pv-play:hover { background: rgba(255, 255, 255, .3); }
    .pv-play svg { width: 16px; height: 16px; }
    .pv-time { margin-left: auto; padding: 3px 8px 4px; border-radius: 6px; background: rgba(0, 0, 0, .55);
      font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }

    /* шкала видео с выделенным отрезком: колесо — приблизить, Shift+колесо — сдвинуть */
    .scale { position: relative; display: flex; flex-direction: column; gap: 6px; }
    .track { position: relative; height: 44px; border-radius: 10px; background: rgba(255, 255, 255, .08);
      cursor: pointer; touch-action: none; overflow: hidden; }
    .ticks { position: absolute; inset: 0; pointer-events: none; }
    .tick { position: absolute; bottom: 0; width: 1px; height: 7px; background: rgba(255, 255, 255, .2); }
    .tick.major { height: 13px; background: rgba(255, 255, 255, .38); }
    .labels { position: relative; height: 15px; color: #8e8e95; font-size: 12px; font-variant-numeric: tabular-nums; }
    .labels span { position: absolute; top: 0; transform: translateX(-50%); white-space: nowrap; }
    .hover { position: absolute; top: -28px; padding: 3px 8px 4px; border-radius: 7px; background: #f1f1f1; color: #111;
      font-size: 12px; font-weight: 650; font-variant-numeric: tabular-nums; transform: translateX(-50%);
      pointer-events: none; opacity: 0; transition: opacity .12s ease; white-space: nowrap; z-index: 2; }
    .hover.show { opacity: 1; }
    /* мини-полоса всего видео: рамка — видимая часть шкалы, красное — отрезок */
    .rail { position: relative; height: 8px; border-radius: 4px; background: rgba(255, 255, 255, .07); cursor: pointer;
      touch-action: none; transition: opacity .2s ease; }
    .rail.off { opacity: 0; pointer-events: none; }
    .rail .win { position: absolute; top: 0; bottom: 0; border-radius: 4px; background: rgba(255, 255, 255, .22);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .3); cursor: grab; }
    .rail .mark { position: absolute; top: 2px; bottom: 2px; min-width: 2px; border-radius: 2px; background: #ff3b5c; pointer-events: none; }
    .sel { position: absolute; top: 0; bottom: 0; border-radius: 8px; background: rgba(255, 59, 92, .26);
      box-shadow: inset 0 0 0 2px #ff3b5c; }
    .head { position: absolute; top: 6px; bottom: 6px; width: 2px; margin-left: -1px; border-radius: 1px;
      background: rgba(255, 255, 255, .55); pointer-events: none; }
    .h { position: absolute; top: 50%; width: 16px; height: 30px; margin: -15px 0 0 -8px; border-radius: 6px;
      background: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, .45); cursor: ew-resize; touch-action: none; }
    .h::after { content: ""; position: absolute; left: 50%; top: 9px; bottom: 9px; width: 2px; margin-left: -1px;
      border-radius: 1px; background: rgba(0, 0, 0, .25); }
    .h:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
    .h.out { display: none; }

    .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .field > span { color: #a6a6ad; font-size: 12.5px; }
    .row { display: flex; gap: 6px; }
    input { all: unset; box-sizing: border-box; flex: 1; min-width: 0; height: 36px; padding: 0 12px 1px;
      border-radius: 10px; background: rgba(255, 255, 255, .08); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .08);
      font: inherit; font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; color: #fff; }
    input:focus { box-shadow: inset 0 0 0 2px rgba(255, 255, 255, .55); }
    input.bad { box-shadow: inset 0 0 0 2px #ff6b85; }
    .now { padding: 0 11px 1px; color: #d6d6dc; font-size: 13px; }

    .modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; padding: 3px; border-radius: 12px;
      background: rgba(255, 255, 255, .08); }
    .modes button { height: 32px; padding: 0 8px 1px; border-radius: 9px; background: none; color: #bdbdc4; font-size: 13.5px; }
    .modes button:hover { color: #fff; background: rgba(255, 255, 255, .06); }
    .modes button[aria-pressed="true"] { background: rgba(255, 255, 255, .18); color: #fff; }

    .info { min-height: 18px; color: #a6a6ad; font-size: 13px; line-height: 1.4; }
    .info.err { color: #ff8095; }
    .prog { display: none; flex-direction: column; gap: 8px; }
    .prog .bar { height: 6px; border-radius: 3px; background: rgba(255, 255, 255, .1); overflow: hidden; }
    .prog .fill { height: 100%; width: 0; border-radius: 3px; background: #ff3b5c; transition: width .25s ease-out; }
    .prog .txt { color: #d6d6dc; font-size: 13px; font-variant-numeric: tabular-nums; }
    .dlg.busy .prog { display: flex; }
    .dlg.busy .info { display: none; }

    .acts { display: flex; gap: 10px; }
    .go { flex: 1; min-width: 0; height: 44px; font-size: 15px; background: #ff3b5c; color: #fff; }
    .link { flex: none; height: 44px; padding: 0 16px 1px 14px; }
    .go:hover { background: #ff2149; }
    .dlg.busy .go { background: rgba(255, 255, 255, .12); }
    .dlg.busy .go:hover { background: rgba(255, 255, 255, .2); }

    .msg { position: absolute; left: 50%; bottom: -54px; padding: 9px 16px 10px; border-radius: 999px;
      background: rgba(28, 28, 30, .94); box-shadow: 0 8px 24px rgba(0, 0, 0, .4); font-size: 13.5px; white-space: nowrap;
      transform: translate(-50%, 8px); opacity: 0; pointer-events: none;
      transition: opacity .16s ease-out, transform .22s cubic-bezier(.23, 1, .32, 1); }
    .msg.show { opacity: 1; transform: translate(-50%, 0); }

    @media (max-width: 440px) {
      .dlg { padding: 16px; gap: 14px; }
      .fields { grid-template-columns: 1fr; }
    }
    @media (prefers-reduced-motion: reduce) { .bg, .dlg, .msg, .prog .fill { transition: none; } }
  `;

  let ui = null; // состояние открытого окна

  const video = () => document.querySelector("#movie_player video, video.html5-main-video");
  const isWatch = () => location.pathname === "/watch";

  function toast(text, ms = 2600) {
    if (!ui) return;
    const m = ui.$(".msg");
    m.textContent = text;
    m.classList.add("show");
    clearTimeout(ui.msgTimer);
    ui.msgTimer = setTimeout(() => m.classList.remove("show"), ms);
  }

  function setInfo(text, err = false) {
    const el = ui.$(".info");
    el.textContent = text;
    el.classList.toggle("err", err);
  }

  // проверка отрезка: что не так (или null) — кнопка и подсказка следуют за ней
  function problem() {
    const len = ui.end - ui.start;
    if (len < 1) return "Конец должен быть позже начала хотя бы на секунду";
    if (len > MAX_LEN + 0.01) return `Клип — не длиннее ${MAX_LEN / 60} минут, сейчас ${fmt(len)}`;
    return null;
  }

  // ---------- шкала: видимое окно времени ----------
  const MIN_GAP = 1; // ручки не сходятся ближе секунды
  const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  // мелкие деления — «круглые» доли крупного шага
  const MINOR = { 2: [1], 5: [1], 10: [2, 5], 15: [5], 30: [5, 10], 60: [10, 15, 30], 120: [30, 60], 300: [60], 600: [60, 120], 900: [300], 1800: [300, 600], 3600: [600, 900], 7200: [1800] };
  const minView = () => Math.min(ui.duration, 8);
  const frac = (t) => (t - ui.view.a) / (ui.view.z - ui.view.a || 1);
  const pcv = (t) => `${Math.max(0, Math.min(1, frac(t))) * 100}%`;
  const prefersReduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  // окно [a, z] в пределах видео и не уже minView
  function clampView(a, z) {
    const d = ui.duration || 1;
    const w = Math.max(minView(), Math.min(d, z - a));
    a = Math.max(0, Math.min(a, d - w));
    return { a, z: a + w };
  }
  // плавно к окну (колесо, двойной клик, мини-полоса)
  function setView(a, z, animate = true) {
    ui.viewTarget = clampView(a, z);
    if (!animate || prefersReduced()) {
      cancelAnimationFrame(ui.viewRaf);
      ui.viewRaf = 0;
      ui.view = { ...ui.viewTarget };
      return render();
    }
    if (ui.viewRaf) return;
    let last = performance.now();
    const step = (now) => {
      if (!ui) return;
      const t = ui.viewTarget;
      // мягкое замедление, ~0,3 с при любой частоте кадров
      const k = 1 - Math.pow(0.72, Math.max(1, (now - last) / 16.7));
      last = now;
      ui.view = { a: ui.view.a + (t.a - ui.view.a) * k, z: ui.view.z + (t.z - ui.view.z) * k };
      const done = Math.abs(t.a - ui.view.a) + Math.abs(t.z - ui.view.z) < (t.z - t.a) * 0.002;
      if (done) ui.view = { ...t };
      render();
      ui.viewRaf = done ? 0 : requestAnimationFrame(step);
    };
    ui.viewRaf = requestAnimationFrame(step);
  }
  // начальное окно: на длинном видео сразу приближаем к отрезку
  function initialView() {
    const d = ui.duration || 1;
    const len = ui.end - ui.start;
    if (d <= 180) return { a: 0, z: d };
    const w = Math.max(60, Math.min(d, len * 6));
    const c = (ui.start + ui.end) / 2;
    return clampView(c - w / 2, c + w / 2);
  }
  // отрезок ушёл за край шкалы (ввели время, «Сейчас») — показываем его
  function revealRange() {
    const { a, z } = ui.viewTarget || ui.view;
    if (ui.start >= a && ui.end <= z) return;
    const w = Math.max(z - a, (ui.end - ui.start) * 1.4);
    const c = (ui.start + ui.end) / 2;
    setView(c - w / 2, c + w / 2);
  }

  // деления и подписи: шаг такой, чтобы подписи стояли не теснее ~70 px
  function renderTicks() {
    const px = ui.$(".track").clientWidth || 400;
    const { a, z } = ui.view;
    const key = `${a.toFixed(3)}|${z.toFixed(3)}|${px}`;
    if (ui.ticksKey === key) return;
    ui.ticksKey = key;
    const w = z - a || 1;
    const major = TICK_STEPS.find((st) => (w / st) * 70 <= px) || TICK_STEPS[TICK_STEPS.length - 1];
    const minor = (MINOR[major] || []).find((m) => (m / w) * px >= 9) || major;
    let ticks = "";
    let labels = "";
    for (let t = Math.ceil(a / minor - 1e-9) * minor; t <= z + 1e-6; t += minor) {
      const x = ((t - a) / w) * 100;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ticks += `<i class="tick${isMajor ? " major" : ""}" style="left:${x}%"></i>`;
      if (isMajor) {
        // подпись у края не обрезается — прижимаем к краю
        const xp = (x / 100) * px;
        const style = xp < 18 ? "left:0;transform:none" : xp > px - 18 ? "left:auto;right:0;transform:none" : `left:${x}%`;
        labels += `<span style="${style}">${fmt(t)}</span>`;
      }
    }
    ui.$(".ticks").innerHTML = ticks;
    ui.$(".labels").innerHTML = labels;
  }

  function render() {
    if (!ui) return;
    const d = ui.duration || 1;
    renderTicks();
    ui.$(".sel").style.left = pcv(ui.start);
    ui.$(".sel").style.width = `${Math.max(0, Math.min(1, frac(ui.end)) - Math.max(0, frac(ui.start))) * 100}%`;
    const [h1, h2] = ui.root.querySelectorAll(".h");
    h1.style.left = pcv(ui.start);
    h2.style.left = pcv(ui.end);
    h1.classList.toggle("out", ui.start < ui.view.a - 0.01 || ui.start > ui.view.z + 0.01);
    h2.classList.toggle("out", ui.end < ui.view.a - 0.01 || ui.end > ui.view.z + 0.01);
    // мини-полоса — только когда шкала приближена
    const rail = ui.$(".rail");
    rail.classList.toggle("off", ui.view.z - ui.view.a >= d - 0.5);
    rail.querySelector(".win").style.cssText = `left:${(ui.view.a / d) * 100}%;width:${((ui.view.z - ui.view.a) / d) * 100}%`;
    rail.querySelector(".mark").style.cssText = `left:${(ui.start / d) * 100}%;width:${((ui.end - ui.start) / d) * 100}%`;
    for (const [h, t, name] of [
      [h1, ui.start, "Начало"],
      [h2, ui.end, "Конец"],
    ]) {
      h.setAttribute("aria-valuemin", "0");
      h.setAttribute("aria-valuemax", String(Math.round(d)));
      h.setAttribute("aria-valuenow", String(Math.round(t)));
      h.setAttribute("aria-valuetext", `${name}: ${fmt(t)}`);
    }
    const ins = ui.root.querySelectorAll("input");
    if (ui.root.activeElement !== ins[0]) ins[0].value = fmt(ui.start);
    if (ui.root.activeElement !== ins[1]) ins[1].value = fmt(ui.end);
    ui.root.querySelectorAll(".modes button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === ui.mode)));
    if (ui.busy) return;
    if (ui.blocked) {
      ui.$(".go").disabled = true;
      setInfo(ui.blocked, true);
      return;
    }
    const p = problem();
    ui.$(".go").disabled = Boolean(p);
    if (p) setInfo(p, true);
    else {
      const what = ui.mode === "audio" ? "звук M4A" : `MP4 ${MODES.find((m) => m.id === ui.mode)?.label}`;
      setInfo(`Клип ${fmt(ui.end - ui.start)} · ${what} · без перекодирования, в исходном качестве`);
    }
  }

  // Поставить начало/конец. Ручки (мышь, стрелки) упираются в соседнюю и не
  // сдвигают её. push — для полей и «Сейчас»: начало позже конца переносит
  // конец, сохраняя длину клипа (ввели время — значит, хотят именно его).
  function setStart(t, { push = false } = {}) {
    t = Math.max(0, Math.min(t, ui.duration));
    if (push && t > ui.end - MIN_GAP) ui.end = Math.min(ui.duration, t + Math.max(MIN_GAP, ui.end - ui.start));
    ui.start = Math.max(0, Math.min(t, ui.end - MIN_GAP));
    if (push) revealRange();
    render();
    seekPreview(ui.start);
  }
  function setEnd(t, { push = false } = {}) {
    t = Math.max(0, Math.min(t, ui.duration));
    if (push && t < ui.start + MIN_GAP) ui.start = Math.max(0, t - Math.max(MIN_GAP, ui.end - ui.start));
    ui.end = Math.min(ui.duration, Math.max(t, ui.start + MIN_GAP));
    if (push) revealRange();
    render();
    seekPreview(ui.end);
  }

  // ---------- предпросмотр ----------
  // Окно закрывает плеер, поэтому кадр рисуем в своём холсте: ручки и поля
  // перематывают видео (на паузе), «Посмотреть отрезок» проигрывает выбранное.
  function seekPreview(t) {
    if (!ui || ui.busy) return;
    stopPreview();
    ui.seekWant = t; // частые перемотки при перетаскивании — не чаще кадра
    if (ui.seekRaf) return;
    ui.seekRaf = requestAnimationFrame(() => {
      if (!ui) return;
      ui.seekRaf = 0;
      const v = video();
      if (v && Number.isFinite(ui.seekWant)) v.currentTime = Math.min(ui.seekWant, Math.max(0, ui.duration - 0.05));
    });
  }
  function setPlayBtn(playing) {
    const b = ui.$(".pv-play");
    b.innerHTML = playing ? `${ICON.pause}<span>Пауза</span>` : `${ICON.play}<span>Посмотреть отрезок</span>`;
  }
  function stopPreview() {
    if (!ui?.previewing) return;
    ui.previewing = false;
    video()?.pause();
    setPlayBtn(false);
  }
  function togglePreview() {
    if (!ui || ui.busy) return;
    if (ui.previewing) return stopPreview();
    const v = video();
    if (!v) return;
    if (v.currentTime < ui.start - 0.25 || v.currentTime >= ui.end - 0.25) v.currentTime = ui.start;
    globalThis.__ytcs?.allowPlay?.(); // это ваше нажатие — автостоп не мешает
    v.play().catch(() => {});
    ui.previewing = true;
    setPlayBtn(true);
  }
  // кадр, отметка на шкале, время; конец отрезка — стоп
  function frame() {
    if (!ui) return;
    ui.raf = requestAnimationFrame(frame);
    const v = video();
    if (!v) return;
    const t = v.currentTime;
    if (ui.previewing && t >= ui.end) stopPreview();
    if (ui.duration) {
      const head = ui.$(".head");
      head.style.left = pcv(t);
      head.style.display = t < ui.view.a || t > ui.view.z ? "none" : "";
    }
    const label = fmt(t);
    if (ui.label !== label) ui.$(".pv-time").textContent = ui.label = label;
    // рисуем, когда кадр сменился; «нарисован» — только если кадр уже был готов
    if (t === ui.drawnAt && v.paused) return;
    if (v.readyState < 2 || !v.videoWidth) return;
    const c = ui.$("canvas");
    const h = Math.round((640 * v.videoHeight) / v.videoWidth);
    if (c.height !== h) c.height = h;
    try {
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      ui.drawnAt = t;
    } catch (e) {
      /* кадр недоступен — остаётся прежний */
    }
  }

  function timeAt(clientX) {
    const r = ui.$(".track").getBoundingClientRect();
    const f = Math.max(0, Math.min(clientX - r.left, r.width)) / (r.width || 1);
    return ui.view.a + f * (ui.view.z - ui.view.a);
  }

  // время под курсором над шкалой
  function showHover(clientX) {
    const scale = ui.$(".scale");
    const r = ui.$(".track").getBoundingClientRect();
    const sr = scale.getBoundingClientRect();
    const hv = ui.$(".hover");
    const x = Math.max(r.left, Math.min(clientX, r.right));
    hv.textContent = fmt(timeAt(x));
    const k = sr.width / (scale.offsetWidth || sr.width); // у окна может быть zoom
    hv.style.left = `${Math.max(24, Math.min((x - sr.left) / k, scale.offsetWidth - 24))}px`;
    hv.classList.add("show");
  }

  function bindTrack() {
    const track = ui.$(".track");
    let drag = null; // "start" | "end"
    track.addEventListener("pointerdown", (e) => {
      if (ui.busy || e.button !== 0) return;
      const t = timeAt(e.clientX);
      const h = e.target.closest(".h");
      drag = h ? h.dataset.h : Math.abs(t - ui.start) <= Math.abs(t - ui.end) ? "start" : "end";
      track.setPointerCapture(e.pointerId);
      (drag === "start" ? setStart : setEnd)(t);
      ui.root.querySelector(`.h[data-h="${drag}"]`).focus({ preventScroll: true });
      e.preventDefault();
    });
    track.addEventListener("pointermove", (e) => {
      showHover(e.clientX);
      if (drag) (drag === "start" ? setStart : setEnd)(timeAt(e.clientX));
    });
    track.addEventListener("pointerleave", () => {
      if (!drag) ui.$(".hover").classList.remove("show");
    });
    const stop = () => {
      drag = null;
    };
    track.addEventListener("pointerup", stop);
    track.addEventListener("pointercancel", stop);
    // колесо — приблизить/отдалить вокруг курсора; Shift+колесо или тачпад вбок — сдвинуть
    track.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const cur = ui.viewTarget || ui.view;
        const w = cur.z - cur.a;
        const r = track.getBoundingClientRect();
        const horiz = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
        const unit = e.deltaMode === 1 ? 33 : 1; // строки → пиксели
        if (horiz) {
          const dx = ((e.shiftKey ? e.deltaY || e.deltaX : e.deltaX) || 0) * unit;
          const dt = (dx / (r.width || 1)) * w;
          setView(cur.a + dt, cur.z + dt);
        } else {
          const f = Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
          const tc = cur.a + f * w;
          const nw = Math.max(minView(), Math.min(ui.duration, w * Math.pow(1.0018, e.deltaY * unit)));
          setView(tc - f * nw, tc - f * nw + nw);
        }
        showHover(e.clientX);
      },
      { passive: false }
    );
    track.addEventListener("dblclick", (e) => {
      if (!e.target.closest(".h")) setView(0, ui.duration);
    });
    // мини-полоса: перетащить рамку или щёлкнуть, чтобы перейти
    const rail = ui.$(".rail");
    let pan = null;
    const railTime = (x) => {
      const rr = rail.getBoundingClientRect();
      return (Math.max(0, Math.min(x - rr.left, rr.width)) / (rr.width || 1)) * ui.duration;
    };
    rail.addEventListener("pointerdown", (e) => {
      const cur = ui.viewTarget || ui.view;
      const w = cur.z - cur.a;
      const t = railTime(e.clientX);
      const onWin = Boolean(e.target.closest(".win"));
      pan = { off: onWin ? t - cur.a : w / 2, w };
      rail.setPointerCapture(e.pointerId);
      setView(t - pan.off, t - pan.off + w, !onWin);
      e.preventDefault();
    });
    rail.addEventListener("pointermove", (e) => {
      if (pan) setView(railTime(e.clientX) - pan.off, railTime(e.clientX) - pan.off + pan.w, false);
    });
    rail.addEventListener("pointerup", () => (pan = null));
    rail.addEventListener("pointercancel", () => (pan = null));
  }

  // стрелки на ручке: ±1 с, с Shift — ±5 с; Home/End — к краям
  function handleKey(h, e) {
    if (ui.busy) return;
    const step = e.shiftKey ? 5 : 1;
    const cur = h.dataset.h === "start" ? ui.start : ui.end;
    const set = h.dataset.h === "start" ? setStart : setEnd;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") set(cur - step);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") set(cur + step);
    else if (e.key === "Home") set(0);
    else if (e.key === "End") set(ui.duration);
    else return;
    e.preventDefault();
  }

  // применить время из поля; false — если введено непонятно
  function commitField(inp) {
    const i = [...ui.root.querySelectorAll("input")].indexOf(inp);
    const t = parseTime(inp.value);
    if (t === null || t > ui.duration + 0.5) {
      inp.classList.add("bad");
      setInfo("Время — в виде 1:30 или 1:02:03", true);
      return false;
    }
    inp.classList.remove("bad");
    (i === 0 ? setStart : setEnd)(t, { push: true });
    return true;
  }

  function bindFields() {
    ui.root.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("change", () => commitField(inp));
      inp.addEventListener("input", () => inp.classList.remove("bad"));
    });
    ui.root.querySelectorAll(".now").forEach((b, i) =>
      b.addEventListener("click", () => {
        const v = video();
        if (v) (i === 0 ? setStart : setEnd)(v.currentTime, { push: true });
      })
    );
  }

  // ---------- вырезать ----------
  async function start() {
    if (!ui || ui.busy || ui.blocked || problem()) return;
    const mine = ui;
    const id = newId();
    const audio = ui.mode === "audio";
    stopPreview();
    ui.busy = id;
    ui.$(".dlg").classList.add("busy");
    ui.$(".go").innerHTML = "Отменить";
    ui.root.querySelectorAll("input, .now, .modes button, .pv-play").forEach((el) => (el.disabled = true));
    const fill = ui.$(".fill");
    const txt = ui.$(".prog .txt");
    fill.style.width = "0%";
    txt.textContent = "Подкачиваю отрезок…";

    const result = await new Promise((resolve) => {
      const watchdog = setTimeout(() => resolve({ type: "error", code: "noreply" }), 4000);
      listeners.set(id, (d) => {
        clearTimeout(watchdog);
        if (d.type === "progress") {
          const pct = Math.round(d.share * 100);
          fill.style.width = `${Math.round(d.share * 90)}%`; // последние 10% — сборка файла
          txt.textContent = d.ad ? "Перед видео реклама — жду её конца…" : `Подкачиваю отрезок… ${pct}%`;
        } else if (d.type === "done" || d.type === "error") resolve(d);
      });
      toMain({ op: "start", id, start: ui.start, end: ui.end, quality: audio ? "tiny" : ui.mode, audioOnly: audio, restoreAt: ui.openTime });
    });
    listeners.delete(id);
    if (ui !== mine) return; // окно закрыли — клип отменён

    try {
      if (result.type === "error") {
        if (result.code !== "cancelled") setInfo(ERRORS[result.code] || ERRORS.fail, true);
        else toast("Отменено");
        return;
      }
      txt.textContent = "Собираю файл…";
      fill.style.width = "95%";
      const tracks = result.tracks.map((t) => ({ ...t, bytes: new Uint8Array(t.bytes) }));
      let made;
      try {
        made = await mux(tracks, result.start, result.end);
      } catch (e) {
        console.warn("clip mux:", e);
        setInfo(ERRORS.mux, true);
        return;
      }
      if (ui !== mine) return;
      fill.style.width = "100%";
      const name = `${safeName(ui.title)} (${fileTime(made.start)}–${fileTime(result.end)}).${audio ? "m4a" : "mp4"}`;
      saveFile(made.blob, name);
      const mb = (made.blob.size / 1048576).toFixed(made.blob.size > 10485760 ? 0 : 1).replace(".", ",");
      const q = !audio && result.height ? ` · ${result.height}p` : "";
      toast(`Клип сохранён в загрузки · ${fmt(made.start)}–${fmt(result.end)}${q} · ${mb} МБ`);
    } finally {
      if (ui === mine) {
        ui.busy = null;
        ui.$(".dlg").classList.remove("busy");
        ui.$(".go").innerHTML = `${ICON.download}Скачать клип`;
        ui.root.querySelectorAll("input, .now, .modes button, .pv-play").forEach((el) => (el.disabled = el.dataset.off === "1"));
        render();
        if (result.type === "error" && result.code !== "cancelled") setInfo(ERRORS[result.code] || ERRORS.fail, true);
      }
    }
  }

  function cancel() {
    if (ui?.busy) toMain({ op: "cancel", id: ui.busy, resume: false });
  }

  // ---------- открыть / закрыть ----------
  function close() {
    if (!ui) return;
    const cur = ui;
    if (cur.busy) {
      // клип ещё готовится — его отменяем, а плеер вернёт clip-main.js
      toMain({ op: "cancel", id: cur.busy, resume: !cur.openPaused });
    } else {
      const v = video();
      if (v) {
        v.pause();
        v.currentTime = cur.openTime;
        if (!cur.openPaused) {
          globalThis.__ytcs?.allowPlay?.();
          v.play().catch(() => {});
        }
      }
    }
    ui = null;
    cur.wrap.classList.remove("open");
    cur.wrap.style.pointerEvents = "none";
    window.removeEventListener("keydown", onKeys, true);
    cancelAnimationFrame(cur.raf);
    cancelAnimationFrame(cur.seekRaf);
    setTimeout(() => cur.host.remove(), 220);
    const back = cur.prevFocus?.isConnected && !cur.prevFocus.closest?.(".ytcs-menu") ? cur.prevFocus : document.querySelector("#movie_player");
    back?.focus?.({ preventScroll: true });
  }

  // Пока окно открыто, клавиши YouTube (пробел, K, F, стрелки…) не срабатывают:
  // перехват на window в фазе захвата, поэтому клавиши ручек и полей
  // обрабатываем здесь же (до них самих событие уже не дойдёт). В полях
  // печатается как обычно. Tab не выпускает фокус из окна.
  function onKeys(e) {
    if (!ui) return;
    e.stopImmediatePropagation();
    const k = e.key;
    const ae = ui.root.activeElement;
    if (k === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (k === "Tab") {
      const items = [...ui.root.querySelectorAll("button, input, .h")].filter((el) => !el.disabled && el.offsetParent !== null);
      const i = items.indexOf(ui.root.activeElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i < 0 || i === items.length - 1 ? 0 : i + 1;
      e.preventDefault();
      items[next]?.focus();
      return;
    }
    if (ae?.classList.contains("h")) return handleKey(ae, e);
    if (ae?.tagName === "INPUT") {
      if (k === "Enter" && !e.repeat) {
        e.preventDefault();
        if (commitField(ae)) start();
      }
      return;
    }
    // I / O — начало и конец по кадру в предпросмотре (как в видеоредакторах)
    const low = String(k).toLowerCase();
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !ui.busy && ["i", "ш", "o", "щ"].includes(low)) {
      e.preventDefault();
      const v = video();
      if (v) (low === "i" || low === "ш" ? setStart : setEnd)(v.currentTime, { push: true });
      return;
    }
    // страница под окном не прокручивается; пробел и Enter на кнопке нажимают её
    if (["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End"].includes(k)) e.preventDefault();
    if (k === " " && ae?.tagName !== "BUTTON") {
      e.preventDefault();
      if (!e.repeat) togglePreview();
    }
  }

  // Запомненное качество (720p / 1080p / звук) — общее для всех видео
  function saveMode(mode) {
    try {
      chrome.storage.local.set({ clipMode: mode }).catch(() => {});
    } catch (e) {
      /* расширение обновили — не запомним, не страшно */
    }
  }
  async function loadMode() {
    try {
      return (await chrome.storage.local.get("clipMode")).clipMode || null;
    } catch (e) {
      return null;
    }
  }

  // Ссылка на YouTube с начала клипа
  function copyLink() {
    if (!ui) return;
    const id = ui.videoId || new URLSearchParams(location.search).get("v");
    if (!id) return;
    const url = `https://youtu.be/${id}?t=${Math.floor(ui.start)}`;
    navigator.clipboard
      .writeText(url)
      .then(() => toast(`Ссылка с ${fmt(ui.start)} скопирована`))
      .catch(() => toast("Не получилось скопировать ссылку"));
  }

  // range — отрезок снаружи (кнопка «Клип» у момента в боковой панели)
  async function open(range = null) {
    if (!isWatch()) return false;
    close();
    const v = video();
    if (!v) return false;
    const host = document.createElement("div");
    host.id = "ytcs-clip";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style>
      <div class="wrap">
        <div class="bg"></div>
        <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="t" tabindex="-1">
          <div class="top">
            <div class="heads"><h2 id="t">Вырезать клип</h2><div class="sub"></div></div>
            <button class="x" aria-label="Закрыть (Esc)" title="Закрыть (Esc)">${ICON.close}</button>
          </div>
          <div class="pv">
            <canvas width="640" height="360" aria-hidden="true"></canvas>
            <div class="pv-bar">
              <button class="pv-play" title="Проиграть выбранный отрезок (пробел)">${ICON.play}<span>Посмотреть отрезок</span></button>
              <span class="pv-time"></span>
            </div>
          </div>
          <div class="scale">
            <div class="hover" aria-hidden="true"></div>
            <div class="track" title="Колесо — приблизить, Shift+колесо — сдвинуть, двойной клик — всё видео">
              <div class="ticks"></div>
              <div class="sel"></div><div class="head"></div>
              <div class="h" data-h="start" role="slider" tabindex="0" aria-label="Начало клипа"></div>
              <div class="h" data-h="end" role="slider" tabindex="0" aria-label="Конец клипа"></div>
            </div>
            <div class="labels" aria-hidden="true"></div>
            <div class="rail off" title="Всё видео: перетащите рамку, чтобы сдвинуть шкалу"><div class="mark"></div><div class="win"></div></div>
          </div>
          <div class="fields">
            <div class="field"><span>Начало</span><div class="row"><input inputmode="decimal" spellcheck="false" aria-label="Начало, например 1:30" /><button class="now" title="Поставить момент из предпросмотра (клавиша I)">${ICON.now}Сейчас</button></div></div>
            <div class="field"><span>Конец</span><div class="row"><input inputmode="decimal" spellcheck="false" aria-label="Конец, например 2:00" /><button class="now" title="Поставить момент из предпросмотра (клавиша O)">${ICON.now}Сейчас</button></div></div>
          </div>
          <div class="modes" role="group" aria-label="Что сохранить">${MODES.map((m) => `<button data-mode="${m.id}" aria-pressed="false">${m.label}</button>`).join("")}</div>
          <div class="info" aria-live="polite"></div>
          <div class="prog" aria-live="polite"><div class="txt"></div><div class="bar"><div class="fill"></div></div></div>
          <div class="acts">
            <button class="link" title="Скопировать ссылку на YouTube с начала клипа — если друзьям удобнее открыть само видео">${ICON.link}Ссылка</button>
            <button class="go">${ICON.download}Скачать клип</button>
          </div>
          <div class="msg" role="status"></div>
        </div>
      </div>`;
    (document.fullscreenElement || document.documentElement).appendChild(host);
    const wrap = root.querySelector(".wrap");
    const duration = v.duration && Number.isFinite(v.duration) ? v.duration : 0;
    const startAt = Math.floor(Math.min(v.currentTime, Math.max(0, duration - 1)));
    ui = {
      host,
      root,
      wrap,
      $: (s) => root.querySelector(s),
      duration,
      start: startAt,
      end: Math.min(duration, startAt + DEFAULT_LEN),
      mode: "hd720",
      title: document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, ""),
      videoId: new URLSearchParams(location.search).get("v"),
      busy: null,
      prevFocus: document.activeElement,
      openTime: v.currentTime, // при закрытии возвращаем видео сюда
      openPaused: v.paused,
      previewing: false,
      blocked: null, // причина, по которой клип сейчас нельзя вырезать (не про отрезок)
    };
    if (ui.end - ui.start < 1) ui.start = Math.max(0, ui.end - DEFAULT_LEN);
    if (range && Number.isFinite(range.start) && Number.isFinite(range.end) && duration) {
      ui.start = Math.max(0, Math.min(range.start, duration - 1));
      ui.end = Math.max(ui.start + 1, Math.min(range.end, duration));
      ui.openTime = v.currentTime;
      v.currentTime = ui.start; // предпросмотр — сразу с начала отрезка
    }
    const mine = ui;
    root.querySelector(".sub").textContent = ui.title;
    ui.view = initialView();
    ui.viewTarget = { ...ui.view };
    root.querySelector(".bg").addEventListener("click", close);
    root.querySelector(".x").addEventListener("click", close);
    root.querySelector(".go").addEventListener("click", () => (ui?.busy ? cancel() : start()));
    root.querySelector(".link").addEventListener("click", copyLink);
    root.querySelector(".modes").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mode]");
      if (b && !b.disabled && !ui.busy) {
        ui.mode = b.dataset.mode;
        render();
        saveMode(ui.mode);
      }
    });
    // клики в окне не должны доходить до плеера под ним
    for (const t of ["click", "mousedown", "pointerdown", "dblclick", "wheel"]) wrap.addEventListener(t, (e) => e.stopPropagation());
    wrap.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });
    bindTrack();
    bindFields();
    window.addEventListener("keydown", onKeys, true);
    root.querySelector(".pv-play").addEventListener("click", togglePreview);
    v.pause(); // выбираем отрезок на паузе; при закрытии вернём как было
    render();
    frame();
    void wrap.offsetWidth;
    wrap.classList.add("open");
    root.querySelector(".dlg").focus({ preventScroll: true }); // фокус в окне, без рамки на ручке

    // расширение обновили после загрузки страницы — склеить файл уже не выйдет
    let extAlive = false;
    try {
      extAlive = Boolean(chrome.runtime?.id);
    } catch (e) {
      /* осиротевший скрипт */
    }
    if (!extAlive) {
      ui.blocked = ERRORS.noreply;
      render();
      return true;
    }
    // уточняем у плеера: название, трансляция ли, есть ли 1080p
    const inf = await askInfo();
    if (ui !== mine) return true;
    if (!inf) {
      ui.blocked = ERRORS.noreply;
      render();
      return true;
    }
    if (inf.videoId) ui.videoId = inf.videoId;
    if (inf.title) {
      ui.title = inf.title;
      root.querySelector(".sub").textContent = inf.title;
    }
    if (inf.duration && Math.abs(inf.duration - ui.duration) > 0.5) {
      ui.duration = inf.duration;
      ui.view = initialView();
      ui.viewTarget = { ...ui.view };
    }
    const b1080 = root.querySelector('[data-mode="hd1080"]');
    if (inf.levels.length && !inf.levels.some((q) => ["hd1080", "hd1440", "hd2160"].includes(q))) {
      b1080.disabled = true;
      b1080.dataset.off = "1";
      b1080.title = "У этого видео нет 1080p";
    }
    if (inf.live) ui.blocked = ERRORS.live;
    // качество, выбранное в прошлый раз (если у этого видео оно есть)
    const saved = await loadMode();
    if (ui !== mine) return true;
    if (saved && MODES.some((m) => m.id === saved) && !root.querySelector(`[data-mode="${saved}"]`)?.disabled) ui.mode = saved;
    render();
    return true;
  }

  // уход на другое видео или выход из полноэкранного режима — окно закрываем
  window.addEventListener("yt-navigate-start", close);
  document.addEventListener("fullscreenchange", () => {
    if (ui && ui.host.parentElement !== (document.fullscreenElement || document.documentElement)) close();
  });

  globalThis.__ytcsClip = { open, close };
})();
