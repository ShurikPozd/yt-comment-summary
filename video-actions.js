// Действия с обложкой видео: «О чём видео» (пересказ по субтитрам), «Превью»
// (обложка крупно, скачать в максимальном качестве) и «В архив Telegram» (видео —
// в личный бот-архив; кнопка есть, только когда бот настроен). Общий модуль для
// любой обложки:
//  - на youtube.com сам подключается к карточкам ленты (главная, подписки,
//    поиск, рекомендации справа, плейлисты, каналы, Shorts);
//  - свои интерфейсы расширения вешают те же кнопки на свои обложки через API
//    globalThis.__ytcsVideoActions.attach(...) — select.js и queue.js (тот же
//    мир контент-скриптов), «Моя библиотека» (страница расширения: подключить
//    <script src="../thumb-preview.js"> и <script src="../video-actions.js">).
//
// При наведении на обложку справа сверху — маленькие круглые кнопки (подпись —
// плашкой при наведении). «О чём видео» открывает рядом с карточкой окно с
// кратким пересказом: абзац «о чём» и до шести пунктов с таймкодами, текст по
// мере написания. Пересказ делает фон (порт "ytcs-tldr" → tldr-bg.js → общее
// ядро tldr-core.js) — сам скрипт в сеть к боту не ходит; кеш общий с вкладкой
// «О видео» боковой панели. «Превью» — окно thumb-preview.js (то же, что у
// пункта меню «Превью видео»), адреса и имя файла даёт фон (ui:preview-info).
//
// На карточках YouTube левый верхний угол занят кружком выбора (select.js) и
// кнопкой «Пересказать» браузера; справа сверху во время живого превью YouTube
// ставит «Звук» и «Субтитры», в старой разметке — «Смотреть позже». Поэтому
// кнопки встают справа сверху левее этих значков и проверяют, что место свободно.
//
// API (подробно — README, раздел «Для разработчика»):
//   attach(thumbEl, { videoId, title, channel, len, getInfo, card, right, top, actions }) → detach()
//   openTldr(anchorEl, { videoId, title, channel, len }, { card })
//   openPreview({ videoId, title, channel })
//   archive({ videoId, title, channel, len }) → итог фона (archive-bg.js), archiveReady()
//   cardFor(path, x, y) → { card, thumb, info } — карточка под правым щелчком (ctxmenu.js)
//   inCard(path) → внутри любой карточки (и микса, плейлиста) — ctxmenu.js
//   close(), setTheme("dark" | "light" | null), refresh()
(() => {
  if (globalThis.__ytcsVideoActions) return;
  const ON_YT = location.hostname === "www.youtube.com";
  // на чужих сайтах (кроме страниц самого расширения) модуль не нужен
  if (!ON_YT && location.protocol !== "chrome-extension:" && !globalThis.__ytcsVideoActionsStand) return;

  const PORT = "ytcs-tldr";
  const CARD =
    "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2";
  const THUMB =
    "yt-thumbnail-view-model, ytd-thumbnail, [class*='ThumbnailContainer'], .shortsLockupViewModelHostThumbnailContainer, a#thumbnail, a.reel-item-endpoint";
  // плейлисты, миксы и подборки — это не одно видео
  const COLLECTION = "yt-collection-thumbnail-view-model, ytd-playlist-thumbnail, [class*='CollectionStack'], [class*='collection-stack']";
  const OWN_HOSTS = new Set(["ytcs-tldr", "ytcs-select", "ytcs-qmode"]);
  const ID_RE = /(?:[?&]v=|\/shorts\/)([A-Za-z0-9_-]{11})/;
  const VID_RE = /^[A-Za-z0-9_-]{11}$/;
  const MAX_POINTS = 6; // в окне — до шести пунктов равномерно по видео (в панели — все)

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };
  const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  let themeOverride = null;
  function isDark() {
    if (themeOverride) return themeOverride === "dark";
    if (ON_YT) return document.documentElement.hasAttribute("dark");
    // страницы расширения: тема из настроек (data-theme), иначе — как в системе
    const t = document.documentElement.dataset.theme || document.body?.dataset.theme;
    if (t === "dark" || t === "light") return t === "dark";
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function fmtTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }
  function pickEven(points, max) {
    const list = points || [];
    if (list.length <= max) return list.slice();
    const out = [];
    for (let i = 0; i < max; i++) out.push(list[Math.round((i * (list.length - 1)) / (max - 1))]);
    return out;
  }

  // ---------- карточки YouTube (как в select.js) ----------
  function linkOf(card) {
    if (!card || card.querySelector(COLLECTION)) return null;
    const keepList = /^YTD-PLAYLIST-(VIDEO|PANEL-VIDEO)-RENDERER$/.test(card.tagName);
    for (const a of card.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      if (!ID_RE.test(href)) continue;
      if (!keepList && /[?&](list|start_radio)=/.test(href)) return null;
      return a;
    }
    return null;
  }
  const idOf = (card) => (linkOf(card)?.getAttribute("href") || "").match(ID_RE)?.[1] || null;

  function cardFromPath(path) {
    for (const el of path) {
      if (el === document.body) return null;
      if (el instanceof Element && el.matches(CARD)) return el;
    }
    return null;
  }
  // карточка под точкой — сквозь играющее поверх неё превью YouTube
  function cardAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (OWN_HOSTS.has(el.id)) continue;
      const c = el.closest?.(CARD);
      if (c) return c.querySelector(CARD) ? null : c;
    }
    return null;
  }
  const overPreview = (path) => path.some((el) => el.tagName === "YTD-VIDEO-PREVIEW" || el.id === "video-preview");

  function thumbOf(card) {
    for (const el of card.querySelectorAll(THUMB)) {
      const r = el.getBoundingClientRect();
      if (r.width > 40 && r.height > 30) return el;
    }
    const img = card.querySelector("img");
    return img?.closest("a") || img?.parentElement || null;
  }

  function infoOf(card) {
    const a = linkOf(card);
    const title =
      text(
        card.querySelector(
          "[class*='LockupMetadataViewModelTitle']:not(yt-lockup-metadata-view-model), .yt-lockup-metadata-view-model__title, #video-title, [class*='shortsLockupViewModelHostMetadataTitle'], .shortsLockupViewModelHostMetadataTitle, h3"
        )
      ) ||
      a?.getAttribute("title") ||
      a?.getAttribute("aria-label") ||
      "";
    const channel =
      text(card.querySelector("ytd-channel-name a, #channel-name a, ytd-channel-name #text")) ||
      text(card.querySelector("[class*='ContentMetadataViewModelMetadataRow'] a, .yt-content-metadata-view-model__metadata-row a"));
    const badge = [...card.querySelectorAll("[class*='BadgeShapeText'], .yt-badge-shape__text, .badge-shape-wiz__text, ytd-thumbnail-overlay-time-status-renderer #text, badge-shape")]
      .map(text)
      .find((x) => /^\d+(:\d+)+$/.test(x));
    const len = badge ? badge.split(":").reduce((s, x) => s * 60 + Number(x), 0) : 0;
    return { videoId: idOf(card), title: title.slice(0, 300), channel: channel.slice(0, 120), len };
  }

  // ---------- оформление ----------
  const SVG = (paths, w = 1.9) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    // строки текста с искрой — «коротко о чём»
    eye: SVG('<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
    // рисунки сдвинуты переносом (translate) так, чтобы рамка рисунка была ровно в центре 24×24 (замер по пикселям)
    tldr: SVG('<g transform="translate(-.75 1.95)"><path d="M4 6.5h9"/><path d="M4 11.5h12"/><path d="M4 16.5h8"/><path d="M18.5 3.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/></g>'),
    close: SVG('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>', 2.2),
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
    copy: SVG('<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>'),
    redo: SVG('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>'),
    subs: SVG('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 15h4"/><path d="M14 15h3"/><path d="M7 11h10"/>'),
    alert: SVG('<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/><path d="M12 17.5v.01"/>'),
    plug: SVG('<path d="M9 3v5"/><path d="M15 3v5"/><path d="M6.5 8h11v3a5.5 5.5 0 0 1-11 0z"/><path d="M12 16.5V21"/>'),
    stop: SVG('<rect x="6" y="6" width="12" height="12" rx="2.5"/>'),
    // бумажный самолётик Telegram — «В архив Telegram» (как в меню плеера, content.js)
    archive: SVG('<g transform="translate(-.75 -.4)"><path d="M20.4 4.3L3.7 10.8c-.9.35-.85 1.6.06 1.88l4.04 1.25 1.6 5.03c.25.8 1.25 1 1.83.4l2.2-2.25 4.3 3.17c.7.5 1.7.12 1.88-.72l2.73-12.6c.2-.92-.7-1.67-1.58-1.33z"/><path d="M7.8 13.93l9.7-6.43-6.6 7.4-.5 4.4"/></g>', 1.8),
    done: SVG('<path d="M5.5 12.25l4.2 4.2L18.5 7.55"/>', 2.2),
    spin: '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8" opacity=".3"/><path d="M12 4a8 8 0 0 1 8 8"/></svg>',
    ok: SVG('<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.7 2.7L16.2 9.5"/>', 1.8),
  };

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    :host { --bg: #fff; --bg-2: #f4f4f6; --bg-3: #ececf0; --fg: #0f0f0f; --fg-2: #3c3c43; --muted: #606068;
      --line: rgba(0, 0, 0, .08); --acc: #e8002d; --acc-h: #c80027; --acc-soft: rgba(232, 0, 45, .08); --acc-ink: #d1002a;
      --shadow: 0 18px 50px rgba(0, 0, 0, .22), 0 2px 8px rgba(0, 0, 0, .08); }
    :host([dark]) { --bg: #212121; --bg-2: #2b2b2e; --bg-3: #343438; --fg: #f1f1f1; --fg-2: #d0d0d6; --muted: #a2a2aa;
      --line: rgba(255, 255, 255, .1); --acc: #ff3b5c; --acc-h: #ff2149; --acc-soft: rgba(255, 59, 92, .15); --acc-ink: #ff6b85;
      --shadow: 0 18px 50px rgba(0, 0, 0, .55), 0 2px 8px rgba(0, 0, 0, .3); }

    /* ---- кнопки на обложке: круглые, по правому краю, подпись — плашкой под ними ---- */
    .va { position: fixed; z-index: 2; display: none; gap: var(--g, 6px); }
    .va.show { display: flex; }
    .vb { all: unset; box-sizing: border-box; flex: none; width: var(--s, 32px); height: var(--s, 32px); border-radius: 50%;
      display: grid; place-items: center; cursor: pointer; color: #fff;
      background: rgba(0, 0, 0, .62); box-shadow: 0 1px 6px rgba(0, 0, 0, .4), inset 0 0 0 1px rgba(255, 255, 255, .18);
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
      transition: background-color .14s ease, transform .1s ease-out; }
    .vb svg { display: block; width: calc(var(--s, 32px) * .56); height: calc(var(--s, 32px) * .56); }
    .vb:hover { background: rgba(0, 0, 0, .82); }
    .vb:active { transform: scale(.92); }
    .vb:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .vb.on { background: var(--acc); box-shadow: 0 1px 6px rgba(0, 0, 0, .4); }
    .vb.busy { cursor: progress; }
    .spin { animation: va-spin .9s linear infinite; }
    @keyframes va-spin { to { transform: rotate(360deg); } }
    /* своя плашка — только на страницах расширения: внизу по центру, не закрывает шапку и обложки */
    .toast { position: fixed; bottom: 24px; left: 50%; z-index: 5; display: flex; align-items: center; gap: 10px;
      width: max-content; max-width: calc(100vw - 32px); padding: 10px 18px 11px 14px; border-radius: 999px;
      background: rgba(28, 28, 30, .9); -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6);
      box-shadow: 0 8px 30px rgba(0, 0, 0, .4), inset 0 0 0 1px rgba(255, 255, 255, .06);
      color: #f1f1f1; font: 500 14px/1.3 Roboto, "YouTube Sans", Arial, sans-serif;
      opacity: 0; transform: translate(-50%, 8px) scale(.97); pointer-events: none;
      transition: opacity .18s ease, transform .26s cubic-bezier(.22, 1, .36, 1); }
    .toast.show { opacity: 1; transform: translate(-50%, 0) scale(1); }
    .toast svg { width: 18px; height: 18px; flex: none; color: #ff6b85; }
    .toast span { min-width: 0; text-wrap: balance; }
    .tip { position: fixed; z-index: 4; display: none; height: 28px; padding: 0 11px; border-radius: 8px; align-items: center;
      background: rgba(15, 15, 15, .92); color: #fff; font: 600 13.5px/1 Roboto, "YouTube Sans", Arial, sans-serif; white-space: nowrap;
      box-shadow: 0 4px 14px rgba(0, 0, 0, .35); pointer-events: none; }
    .tip.show { display: inline-flex; }

    /* ---- окно ---- */
    .pop { --z: 1; zoom: var(--z); position: fixed; z-index: 3; display: flex; flex-direction: column;
      width: var(--w, 420px); max-height: var(--mh, 600px); overflow: hidden;
      background: var(--bg); color: var(--fg); border-radius: 18px; box-shadow: var(--shadow), 0 0 0 1px var(--line);
      font: 400 16px/1.5 Roboto, "YouTube Sans", "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased;
      opacity: 1; transform: none; transition: opacity .16s ease-out, transform .22s cubic-bezier(.23, 1, .32, 1); outline: none; }
    .pop[hidden] { display: flex; opacity: 0; transform: translateY(6px) scale(.985); pointer-events: none; visibility: hidden;
      transition: opacity .12s ease-in, transform .16s ease-in, visibility 0s .16s; }
    .head { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; align-items: start; padding: 16px 12px 12px 20px;
      border-bottom: 1px solid var(--line); }
    .kicker { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; letter-spacing: .02em;
      color: var(--acc-ink); text-transform: uppercase; padding-top: 3px; }
    .kicker svg { width: 16px; height: 16px; }
    .title { grid-column: 1; font-size: 17px; font-weight: 600; line-height: 1.35; color: var(--fg);
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .x { all: unset; grid-row: 1 / span 2; grid-column: 2; box-sizing: border-box; width: 36px; height: 36px; border-radius: 50%;
      display: grid; place-items: center; cursor: pointer; color: var(--muted); transition: background-color .14s ease, color .14s ease; }
    .x:hover { background: var(--bg-2); color: var(--fg); }
    .x:focus-visible { outline: 2px solid var(--acc); outline-offset: 1px; }
    .x svg { width: 20px; height: 20px; }

    .body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 16px 20px 18px;
      scrollbar-width: thin; scrollbar-color: var(--bg-3) transparent; }
    .phase { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 15px; color: var(--muted); }
    .bar { height: 4px; margin: 10px 0 16px; border-radius: 99px; background: var(--bg-3); overflow: hidden; }
    .bar i { display: block; height: 100%; width: 0; border-radius: inherit; background: var(--acc); transition: width .4s ease-out; }
    .about { margin: 0; font-size: 16px; line-height: 1.6; color: var(--fg); text-wrap: pretty; }
    .live .about:not(:empty)::after { content: ""; display: inline-block; width: 8px; height: 1em; margin-left: 3px; vertical-align: -2px;
      border-radius: 2px; background: var(--acc); animation: blink 1s steps(2, start) infinite; }
    @keyframes blink { to { visibility: hidden; } }
    .skel { display: grid; gap: 10px; }
    .skel i { display: block; height: 14px; border-radius: 7px; background: var(--bg-2); animation: pulse 1.4s ease-in-out infinite; }
    .skel i:nth-child(2) { width: 92%; } .skel i:nth-child(3) { width: 64%; }
    @keyframes pulse { 50% { opacity: .45; } }
    .sub { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 18px 0 6px;
      font-size: 13px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--muted); }
    .sub span { text-transform: none; letter-spacing: 0; font-weight: 400; }
    .pts { display: flex; flex-direction: column; gap: 2px; margin: 0 -10px; }
    a.row { display: flex; align-items: flex-start; gap: 12px; padding: 8px 10px; border-radius: 12px; color: inherit; text-decoration: none;
      transition: background-color .14s ease; }
    a.row:hover { background: var(--bg-2); }
    a.row:focus-visible { outline: 2px solid var(--acc); outline-offset: -2px; }
    .tc { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 28px;
      min-width: var(--tc-w, 0); padding: 0 11px; border-radius: 999px; background: var(--acc-soft); color: var(--acc-ink);
      font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; transition: background-color .14s ease, color .14s ease; }
    .tc svg { width: 11px; height: 11px; }
    a.row:hover .tc { background: var(--acc); color: #fff; }
    .tx { flex: 1; min-width: 0; padding-top: 3px; font-size: 15.5px; line-height: 1.5; color: var(--fg); }

    .foot { display: flex; flex-direction: column; gap: 10px; padding: 12px 16px 16px; border-top: 1px solid var(--line); }
    .foot:empty { display: none; }
    .note { font-size: 13.5px; line-height: 1.4; color: var(--muted); text-align: center; }
    .acts { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 8px; }
    button.b { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      height: 40px; padding: 0 16px 1px 13px; border-radius: 12px; font: inherit; font-size: 15px; font-weight: 600; white-space: nowrap;
      color: var(--fg); background: var(--bg-2); transition: background-color .14s ease, transform .1s ease-out; }
    button.b:hover { background: var(--bg-3); }
    button.b:active { transform: scale(.97); }
    button.b:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; }
    button.b svg { width: 18px; height: 18px; flex: none; }
    button.b.main { background: var(--acc); color: #fff; }
    button.b.main:hover { background: var(--acc-h); }
    button.b.wide { height: 46px; padding: 0 24px 1px; margin-top: 18px; }

    .empty { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 12px 8px 6px; }
    .empty .ic { width: 52px; height: 52px; border-radius: 50%; display: grid; place-items: center; margin-bottom: 14px;
      background: var(--acc-soft); color: var(--acc-ink); }
    .empty .ic svg { width: 24px; height: 24px; }
    .empty b { font-size: 17px; font-weight: 600; line-height: 1.35; color: var(--fg); }
    .empty p { margin: 8px 0 0; max-width: 34em; font-size: 15px; line-height: 1.55; color: var(--fg-2); text-wrap: pretty; }
    .empty kbd { font: 600 13px/1 Roboto, Arial, sans-serif; padding: 3px 6px; border-radius: 6px; background: var(--bg-3); }

    @media (prefers-reduced-motion: reduce) {
      .vb, .pop, .pop[hidden], .bar i, .toast { transition: none; }
      .spin { animation-duration: 2.4s; }
      .skel i, .live .about::after { animation: none; }
    }`;

  // ---------- слой ----------
  const BTN = {
    preview: { icon: () => ICON.eye, label: "Превью обложки", hint: "Превью: обложка крупно и скачать" },
    tldr: { icon: () => ICON.tldr, label: "О чём видео", hint: "О чём видео: краткий пересказ по субтитрам" },
    archive: { icon: () => ICON.archive, label: "В архив Telegram", hint: "В архив Telegram: сохранить видео в бот-архив" },
  };
  let host = null;
  let $ = null;
  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.id = "ytcs-tldr";
    // свой слой: ниже шапки YouTube (2020) и её меню; выше колонки «Режим очереди» и
    // кружка выбора (у них 2018–2019, наш слой добавлен позже)
    host.style.cssText = "position:fixed;inset:auto;z-index:2019;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${UI_CSS}</style>
      <div class="va" role="group" aria-label="Действия с видео"></div>
      <div class="tip" aria-hidden="true"></div>
      <div class="toast" role="status" aria-live="polite"></div>
      <div class="pop" role="dialog" aria-label="О чём видео" tabindex="-1" hidden>
        <div class="head">
          <div class="kicker">${ICON.tldr}О чём видео</div>
          <button class="x" type="button" title="Закрыть (Esc)" aria-label="Закрыть">${ICON.close}</button>
          <div class="title"></div>
        </div>
        <div class="body"></div>
        <div class="foot"></div>
      </div>`;
    $ = (s) => root.querySelector(s);
    const va = $(".va");
    va.addEventListener("pointerdown", (e) => e.preventDefault()); // фокус остаётся на странице
    va.addEventListener("click", (e) => {
      const act = e.target.closest("[data-va]")?.dataset.va;
      if (!act || !target) return;
      e.preventDefault();
      e.stopPropagation();
      const info = target.info();
      if (!info.videoId) return;
      hideTip();
      if (act === "preview") return void openPreview(info);
      if (act === "archive") return void archive(info);
      if (cur && cur.vid === info.videoId && !$(".pop").hidden) return close();
      openTldr(target.el, info, { card: target.card });
    });
    va.addEventListener("pointerover", (e) => showTip(e.target.closest("[data-va]")));
    va.addEventListener("pointerleave", hideTip);
    va.addEventListener("focusin", (e) => showTip(e.target.closest("[data-va]")));
    va.addEventListener("focusout", hideTip);
    $(".x").addEventListener("click", () => close());
    $(".pop").addEventListener("click", onPopClick);
    new ResizeObserver(() => cur && !$(".pop").hidden && position()).observe($(".pop"));
    document.documentElement.appendChild(host);
  }

  // подпись кнопки — плашкой под кнопками, по правому краю группы
  function showTip(btn) {
    if (!btn || !$) return hideTip();
    const tip = $(".tip");
    tip.textContent = labelOf(btn.dataset.va);
    tip.style.zoom = btnZoom; // на 2K/4K — вместе с кнопками
    tip.classList.add("show");
    const g = $(".va").getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    const w = tip.getBoundingClientRect().width;
    const vw = document.documentElement.clientWidth || innerWidth;
    // по центру под кнопкой, но не дальше правого края обложки и экрана
    const r = target?.el?.isConnected ? target.el.getBoundingClientRect() : g;
    const maxRight = Math.min(r.right - 4, vw - 8);
    const left = Math.max(8, Math.min(b.left + b.width / 2 - w / 2, maxRight - w));
    tip.style.left = `${Math.round(left) / btnZoom}px`;
    tip.style.top = `${Math.round(g.bottom + 6 * btnZoom) / btnZoom}px`;
  }
  function hideTip() {
    $?.(".tip")?.classList.remove("show");
  }

  // ---------- наведение ----------
  // target: { key, el (обложка), card, info(), right, top, actions, auto (карточка YouTube) }
  const bindings = new WeakMap(); // обложка → параметры attach()
  let target = null;
  let pointer = { x: -1, y: -1 };
  let recheck = 0;
  let btnZoom = 1;

  function bindingTarget(el, b) {
    return {
      key: el,
      el,
      card: b.card || el,
      info: () => {
        const extra = typeof b.getInfo === "function" ? b.getInfo() || {} : {};
        return { videoId: b.videoId, title: b.title || "", channel: b.channel || "", len: b.len || 0, ...extra };
      },
      right: b.right,
      top: b.top,
      actions: b.actions,
      zIndex: b.zIndex,
      auto: false,
    };
  }

  // Что под указателем: обложка, подключённая через attach() (в т.ч. внутри
  // открытых shadow DOM других окон расширения), либо карточка YouTube.
  function targetFromPath(path) {
    for (const el of path) {
      if (!(el instanceof Element)) continue;
      const b = bindings.get(el);
      if (b) return bindingTarget(el, b);
    }
    if (!ON_YT) return null;
    const card = cardFromPath(path) || (overPreview(path) ? cardAt(pointer.x, pointer.y) : null);
    if (!card) return null;
    const el = thumbOf(card);
    if (!el) return null;
    return { key: card, el, card, info: () => infoOf(card), auto: true };
  }

  // Видимая часть элемента: обложка может быть внутри прокручиваемого блока (колонка очереди,
  // лента в окне) — тогда её край прячется под шапкой блока. Пересекаем с каждым обрезающим
  // предком, в том числе через границу shadow DOM.
  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    let top = r.top;
    let bottom = r.bottom;
    let left = r.left;
    let right = r.right;
    // body и html не берём: у YouTube у body прокрутка при нулевой высоте, а окно и так обрезает
    for (let n = el.parentElement || el.getRootNode()?.host; n && n !== document.body && n !== document.documentElement; n = n.parentElement || n.getRootNode()?.host) {
      const cs = getComputedStyle(n);
      if (cs.overflowY === "visible" && cs.overflowX === "visible") continue;
      const b = n.getBoundingClientRect();
      top = Math.max(top, b.top);
      bottom = Math.min(bottom, b.bottom);
      left = Math.max(left, b.left);
      right = Math.min(right, b.right);
    }
    return { top, bottom, left, right, height: bottom - top, width: right - left, full: r };
  }

  function placeButtons() {
    if (!host || !$) return;
    const va = $(".va");
    const vis = target?.el?.isConnected ? visibleRect(target.el) : null;
    // по ширине — вся обложка (раскладка кнопок), по высоте — только видимая её часть
    const r = vis && { top: vis.top, bottom: vis.bottom, left: vis.full.left, right: vis.full.right, width: vis.full.width, height: vis.height };
    const info = r ? target.info() : null;
    const topLimit = mastheadBottom();
    if (!r || !info?.videoId || !VID_RE.test(info.videoId) || r.width < 90 || r.height < 50 || r.top < topLimit - r.height / 2 || r.top > innerHeight) {
      va.classList.remove("show");
      hideTip();
      return;
    }
    let actions = (Array.isArray(target.actions) && target.actions.length ? target.actions : defaultActions()).filter((a) => BTN[a]);
    const small = r.width < 220; // справа на странице видео, Shorts, узкие колонки
    // на 2K/4K обложки крупнее — и кнопки чуть крупнее (размеры ниже — экранные)
    const bz = small ? 1 : Math.min(zoomLevel(), 1.25);
    const s = (small ? 28 : 32) * bz;
    const g = (small ? 5 : 6) * bz;
    // На обложках YouTube (auto) кнопки — слева сверху, сразу за кружком выбора (select.js):
    // справа YouTube через секунду ставит «Звук» и «Субтитры» живого превью, и кнопки
    // прыгали бы влево. Кружок 8 px от края, 26/32 px; в режиме очереди он — плашка со словами.
    let leftX = 0;
    let pad = target.top ?? (small ? 6 : 8);
    if (target.auto) {
      const circle = s; // кружок того же размера (select.js)
      leftX = r.left + 8 + circle + g;
      const hv = document.getElementById("ytcs-select")?.shadowRoot?.querySelector(".hov.show")?.getBoundingClientRect();
      if (hv && hv.width && hv.left < r.left + 40 && hv.right + g > leftX) leftX = hv.right + g;
      pad = 8 + (circle - s) / 2; // по одной линии с кружком
    }
    // на узкой обложке три кнопки не влезают — «В архив» уступает место (есть в меню);
    // справа оставляем колонку под кнопки живого превью YouTube (~44 px)
    const room = target.auto ? r.right - 44 - leftX : r.width - ((target.right ?? (small ? 6 : 8)) + 4);
    if (actions.length > 1 && actions.includes("archive") && actions.length * s + (actions.length - 1) * g > room) {
      actions = actions.filter((a) => a !== "archive");
    }
    const w = actions.length * s + (actions.length - 1) * g;
    const key = actions.join();
    if (va.dataset.key !== key) {
      va.dataset.key = key;
      va.innerHTML = actions
        .map((a) => `<button class="vb" type="button" data-va="${a}" aria-label="${BTN[a].label}" title="${BTN[a].hint}">${BTN[a].icon()}</button>`)
        .join("");
    }
    va.style.zoom = bz;
    btnZoom = bz;
    va.style.setProperty("--s", `${s / bz}px`);
    va.style.setProperty("--g", `${g / bz}px`);
    va.querySelector('[data-va="tldr"]')?.classList.toggle("on", Boolean(cur && cur.vid === info.videoId && !$(".pop").hidden));
    paintArchive(va.querySelector('[data-va="archive"]'), info.videoId);
    host.style.zIndex = String(target.zIndex || 2019);
    if (target.auto) {
      va.style.right = "auto";
      va.style.left = `${Math.round(leftX) / bz}px`;
    } else {
      const off = target.right ?? (small ? 6 : 8);
      const vw = document.documentElement.clientWidth || innerWidth;
      va.style.left = "auto";
      va.style.right = `${Math.round(vw - (r.right - off)) / bz}px`;
    }
    va.style.top = `${Math.round(r.top + pad) / bz}px`;
    va.classList.add("show");
  }

  function setTarget(t) {
    if ((t?.key || null) === (target?.key || null)) return;
    target = t;
    hideTip();
    clearInterval(recheck);
    recheck = 0;
    if (t) {
      ensureHost();
      host.toggleAttribute("dark", isDark());
      void loadMark(t.info().videoId);
      if (t.auto) {
        // кружок выбора и живое превью YouTube появляются не сразу — сверяем место ещё пару раз
        let n = 0;
        recheck = setInterval(() => {
          if (++n > 14 || target !== t) {
            clearInterval(recheck);
            recheck = 0;
            return;
          }
          placeButtons();
        }, 350);
      }
    }
    placeButtons();
  }

  const inside = (r, p) => r && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
  let moveRaf = 0;
  window.addEventListener(
    "pointermove",
    (e) => {
      pointer = { x: e.clientX, y: e.clientY };
      const path = e.composedPath();
      if (host && path.includes(host)) {
        // на наших кнопках или в окне: карточка остаётся «под указателем»
        // и для YouTube, и для кружка выбора select.js
        e.stopPropagation();
        return;
      }
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        const t = targetFromPath(path);
        // та же обложка в своей колонке могла уехать прокруткой — догоняем
        if (t && target && t.key === target.key) {
          if (!t.auto) placeButtons();
        } else setTarget(t);
      });
    },
    { passive: true, capture: true }
  );
  document.addEventListener("pointerleave", () => setTarget(null));
  let scrollRaf = 0;
  window.addEventListener(
    "scroll",
    () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        const box = target?.card?.isConnected ? target.card.getBoundingClientRect() : null;
        if (target && !inside(box, pointer) && !inside(target.el?.getBoundingClientRect(), pointer)) setTarget(null);
        else if (target) placeButtons();
        if (cur && $ && !$(".pop").hidden) position();
      });
    },
    { passive: true, capture: true }
  );
  window.addEventListener("resize", () => {
    if (cur && $ && !$(".pop").hidden) position();
    placeButtons();
  });

  // ---------- окно: место на экране ----------
  let cur = null; // { vid, title, channel, len, card, thumb, rect, state, ... }

  function zoomLevel() {
    if (innerWidth >= 2200 && innerHeight >= 1150) return 1.4;
    if (innerWidth >= 1600 && innerHeight >= 860) return 1.15;
    return 1;
  }

  function mastheadBottom() {
    if (!ON_YT) return 0;
    const m = document.querySelector("#masthead-container, ytd-masthead");
    const b = m ? m.getBoundingClientRect().bottom : 56;
    return Number.isFinite(b) && b > 0 && b < 200 ? b : 0;
  }

  // Рядом с карточкой: справа, иначе слева, иначе под превью. Не вылезает за
  // край экрана и под шапку YouTube; при прокрутке едет вместе с карточкой.
  function position() {
    const pop = $(".pop");
    const z = zoomLevel();
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = innerHeight;
    const gap = 12;
    const edge = vw < 520 ? 8 : 16;
    const minTop = Math.max(edge, mastheadBottom() + 8);
    const W = Math.min(Math.max(380, Math.min(480, vw * 0.3)) * z, vw - edge * 2);
    pop.style.setProperty("--z", z);
    pop.style.setProperty("--w", `${W / z}px`);
    // карточка (превью + название) и само превью; карточку YouTube мог пересоздать — держим прошлое место
    const cardR = cur.card?.isConnected ? cur.card.getBoundingClientRect() : null;
    const thR = cur.thumb?.isConnected ? cur.thumb.getBoundingClientRect() : null;
    if (cardR && cardR.width) cur.rect = { card: cardR, thumb: thR && thR.width ? thR : cardR };
    const c = cur.rect.card;
    const t = cur.rect.thumb;
    let left;
    let top;
    let maxH;
    if (c.right + gap + W <= vw - edge) {
      left = c.right + gap;
    } else if (c.left - gap - W >= edge) {
      left = c.left - gap - W;
    }
    if (left != null) {
      maxH = Math.min(vh - minTop - edge, 760 * z);
      pop.style.setProperty("--mh", `${maxH / z}px`);
      const h = Math.min(pop.getBoundingClientRect().height || 320, maxH);
      top = Math.min(Math.max(t.top, minTop), vh - edge - h);
    } else {
      // узкое окно: под превью (или над ним, если внизу тесно), по ширине карточки
      const W2 = Math.min(Math.max(c.width, 320 * z), 600 * z, vw - edge * 2);
      pop.style.setProperty("--w", `${W2 / z}px`);
      left = Math.min(Math.max(c.left + c.width / 2 - W2 / 2, edge), vw - edge - W2);
      const below = vh - edge - (t.bottom + gap);
      const above = t.top - gap - minTop;
      if (below >= 300 || below >= above) {
        maxH = Math.min(Math.max(below, 200), 720 * z);
        top = Math.min(t.bottom + gap, vh - edge - maxH);
      } else {
        maxH = Math.min(above, 720 * z);
        pop.style.setProperty("--mh", `${maxH / z}px`);
        const h = Math.min(pop.getBoundingClientRect().height || 320, maxH);
        top = t.top - gap - h;
      }
      pop.style.setProperty("--mh", `${maxH / z}px`);
      top = Math.max(top, minTop);
    }
    pop.style.left = `${Math.round(left) / z}px`;
    pop.style.top = `${Math.round(top) / z}px`;
  }

  // ---------- связь с фоном ----------
  let port = null;
  function getPort() {
    if (port) return port;
    if (!alive()) return null;
    try {
      port = chrome.runtime.connect({ name: PORT });
    } catch (e) {
      return null;
    }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      // фон перезапустился посреди пересказа — один раз переспрашиваем (кеш или новая задача)
      if (cur?.state === "run" && !cur.retried && alive()) {
        cur.retried = true;
        request(false);
      } else if (cur?.state === "run") {
        setState({ state: alive() ? "error" : "reload", kind: "ai", text: "Связь с расширением прервалась. Попробуйте ещё раз." });
      }
    });
    return port;
  }

  function request(force) {
    const p = getPort();
    if (!p) return setState({ state: "reload" });
    try {
      p.postMessage({ type: "start", vid: cur.vid, title: cur.title, duration: cur.len, force: Boolean(force) });
    } catch (e) {
      port = null;
      setState({ state: "reload" });
    }
  }

  function onPortMessage(msg) {
    if (!cur || msg?.vid !== cur.vid) return; // старые задачи дописываются в кеш сами
    if (msg.type === "progress") {
      const first = cur.state !== "run";
      Object.assign(cur, { state: "run", phase: msg.phase, frac: msg.frac, about: msg.about || "", points: msg.points || [] });
      if (first) render();
      else paintRun();
    } else if (msg.type === "done") {
      setState({ state: "done", data: msg.data, copy: msg.copy || "" });
    } else if (msg.type === "nosubs") {
      setState({ state: "nosubs", music: Boolean(msg.music) });
    } else if (msg.type === "error") {
      setState({ state: msg.kind === "setup" ? "setup" : "error", kind: msg.kind, text: msg.text || "" });
    }
  }

  function setState(patch) {
    if (!cur) return;
    Object.assign(cur, patch);
    render();
  }

  // ---------- окно: содержимое ----------
  // на YouTube — в этой же вкладке, со страниц расширения (библиотека) — в новой
  const watchUrl = (t) => `${ON_YT ? "" : "https://www.youtube.com"}/watch?v=${cur.vid}${t ? `&t=${Math.floor(t)}s` : ""}`;
  const linkTarget = ON_YT ? "" : ' target="_blank" rel="noopener"';

  function pointsHtml(points) {
    if (!points.length) return "";
    const longest = Math.max(...points.map((p) => fmtTime(p.t).length));
    return `<div class="sub">Главное <span>нажмите — смотреть с этого места</span></div>
      <div class="pts" style="--tc-w: calc(40px + ${longest}ch)">${points
        .map(
          (p) => `<a class="row" href="${watchUrl(p.t)}"${linkTarget} title="Смотреть с ${fmtTime(p.t)}">
            <span class="tc">${ICON.play}${fmtTime(p.t)}</span><span class="tx">${esc(p.x)}</span></a>`
        )
        .join("")}</div>`;
  }

  const skeleton = '<div class="skel"><i></i><i></i><i></i></div>';

  function emptyHtml(icon, title, textHtml, btn = "") {
    return `<div class="empty"><div class="ic">${icon}</div><b>${esc(title)}</b><p>${textHtml}</p>${btn}</div>`;
  }

  function fmtDate(ts) {
    try {
      return new Date(ts).toLocaleString("ru-RU", { day: "numeric", month: "long" });
    } catch (e) {
      return "";
    }
  }

  function render() {
    if (!cur || !$) return;
    const body = $(".body");
    const foot = $(".foot");
    $(".title").textContent = cur.title || "Видео";
    $(".title").title = cur.title || "";
    const st = cur.state;
    body.classList.toggle("live", st === "run");
    if (st === "run") {
      body.innerHTML = `<div class="phase"><span class="ph"></span></div><div class="bar"><i></i></div>
        <p class="about"></p><div class="skw">${skeleton}</div><div class="lp"></div>`;
      foot.innerHTML = `<span class="note">ИИ читает субтитры — бесплатно, обычно до минуты</span>
        <div class="acts"><button class="b" type="button" data-act="cancel">${ICON.stop}Отменить</button></div>`;
      paintRun();
    } else if (st === "done") {
      const d = cur.data || {};
      const pts = pickEven(d.points || [], MAX_POINTS);
      body.innerHTML = `<p class="about">${esc(d.about || "")}</p>${pointsHtml(pts)}`;
      const notes = [`Пересказ по субтитрам от ${fmtDate(d.updatedAt)}`];
      if (d.trimmed) notes.push("видео длинное — по сокращённой расшифровке");
      foot.innerHTML = `<span class="note">${esc(notes.join(" · "))}</span>
        <div class="acts">
          <button class="b" type="button" data-act="copy" title="Скопировать пересказ текстом">${ICON.copy}Скопировать</button>
          <button class="b" type="button" data-act="redo" title="Пересказать заново (потратит бесплатный лимит Groq)">${ICON.redo}Заново</button>
        </div>`;
    } else if (st === "nosubs") {
      body.innerHTML = emptyHtml(
        ICON.subs,
        "У этого видео нет субтитров",
        cur.music
          ? "В субтитрах только пометки вроде «[музыка]» — речи, которую можно пересказать, в видео нет."
          : "Пересказ строится по субтитрам, а у видео их нет — ни авторских, ни автоматических. Пересказать не из чего."
      );
      foot.innerHTML = "";
    } else if (st === "setup") {
      body.innerHTML = emptyHtml(
        ICON.plug,
        "Подключите сервер с ИИ",
        "Для пересказа нужен адрес сервера и секрет. Откройте боковую панель расширения (<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Y</kbd>) → «Настройки» и заполните их."
      );
      foot.innerHTML = "";
    } else if (st === "reload") {
      body.innerHTML = emptyHtml(ICON.redo, "Расширение обновилось", "Обновите страницу (F5) — и пересказ заработает.");
      foot.innerHTML = "";
    } else if (st === "cancelled") {
      body.innerHTML = emptyHtml(
        ICON.tldr,
        "Пересказ отменён",
        "Можно запустить снова — ИИ прочитает субтитры и коротко расскажет, о чём видео.",
        `<button class="b main wide" type="button" data-act="redo">Пересказать</button>`
      );
      foot.innerHTML = "";
    } else {
      const head = cur.kind === "transcript" ? "Не получилось загрузить субтитры" : "Не получилось пересказать видео";
      body.innerHTML = emptyHtml(ICON.alert, head, esc(cur.text || "Попробуйте ещё раз."), `<button class="b main wide" type="button" data-act="redo">Попробовать ещё раз</button>`);
      foot.innerHTML = "";
    }
    position();
  }

  // во время работы обновляем только изменившееся — без мигания и сброса прокрутки
  function paintRun() {
    const body = $(".body");
    const ph = body.querySelector(".ph");
    if (!ph) return render();
    ph.textContent = cur.phase || "Пишу пересказ…";
    body.querySelector(".bar i").style.width = `${Math.round((cur.frac || 0) * 100)}%`;
    const about = body.querySelector(".about");
    if (about.textContent !== cur.about) about.textContent = cur.about || "";
    body.querySelector(".skw").innerHTML = cur.about ? "" : skeleton;
    const pts = pickEven(cur.points || [], MAX_POINTS);
    const key = pts.map((p) => `${p.t}|${p.x}`).join("\n");
    const lp = body.querySelector(".lp");
    if (lp.dataset.key !== key) {
      lp.dataset.key = key;
      lp.innerHTML = pointsHtml(pts);
    }
  }

  async function onPopClick(e) {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act || !cur) return;
    if (act === "cancel") {
      try {
        getPort()?.postMessage({ type: "cancel", vid: cur.vid });
      } catch (err) {
        /* фон и так остановится */
      }
      setState({ state: "cancelled" });
    } else if (act === "redo") {
      setState({ state: "run", phase: "Загружаю субтитры…", frac: 0.04, about: "", points: [], retried: false });
      request(true);
    } else if (act === "copy") {
      const btn = e.target.closest("button");
      try {
        await navigator.clipboard.writeText(cur.copy || "");
        btn.lastChild.textContent = "Скопировано";
      } catch (err) {
        btn.lastChild.textContent = "Не вышло";
      }
      setTimeout(() => btn.isConnected && (btn.lastChild.textContent = "Скопировать"), 1600);
    }
  }

  // ---------- открыть / закрыть ----------
  function openTldr(anchor, info, { card } = {}) {
    const vid = String(info?.videoId || "");
    if (!VID_RE.test(vid) || !anchor) return false;
    ensureHost();
    host.toggleAttribute("dark", isDark());
    globalThis.__ytcsPreview?.close?.();
    const box = card || anchor;
    const same = cur && cur.vid === vid;
    cur = {
      ...(same ? cur : { state: "run", phase: "Загружаю субтитры…", frac: 0.04, about: "", points: [] }),
      vid,
      title: String(info.title || (same ? cur.title : "") || "").slice(0, 300),
      channel: String(info.channel || "").slice(0, 120),
      len: Number(info.len) || 0,
      card: box,
      thumb: anchor,
      rect: { card: box.getBoundingClientRect(), thumb: anchor.getBoundingClientRect() },
      retried: false,
    };
    const pop = $(".pop");
    render();
    pop.hidden = false;
    position();
    pop.focus({ preventScroll: true });
    placeButtons();
    // готовый пересказ не переспрашиваем; идущий — переподписываемся (фон не дублирует)
    if (!same || !["done", "nosubs", "setup", "run"].includes(cur.state)) {
      Object.assign(cur, { state: "run", phase: "Загружаю субтитры…", frac: 0.04, about: "", points: [] });
      render();
    }
    if (cur.state === "run") request(false);
    return true;
  }

  // ---------- «В архив Telegram» ----------
  // Запрос к боту делает фон (archive-bg.js). Кнопка видна, только когда бот
  // настроен (есть секрет); пока ждём ответа — кольцо, после — галочка на акценте.
  // tgarch:<id> в storage.local — отметка «уже в архиве» (подсказка на кнопке).
  const MARK = "tgarch:";
  let archiveReady = false;
  const archiveState = new Map(); // videoId → "wait" | "done"
  const marks = new Map(); // videoId → категория (или "" — не в архиве)

  function checkArchiveReady() {
    if (!alive()) return;
    chrome.runtime
      .sendMessage({ type: "archive:ready" })
      .then((r) => {
        if (archiveReady === Boolean(r?.ok)) return;
        archiveReady = Boolean(r?.ok);
        placeButtons();
      })
      .catch(() => {});
  }
  checkArchiveReady();
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch.settings) checkArchiveReady(); // секрет ввели или стёрли в настройках панели
      for (const k of Object.keys(ch)) if (k.startsWith(MARK)) marks.set(k.slice(MARK.length), ch[k].newValue?.cat ?? "");
    });
  } catch (e) {
    /* расширение обновилось */
  }

  // «В архив» — слева: «Превью» и «О чём видео» остаются на привычных местах в углу.
  const defaultActions = () => (archiveReady ? ["archive", "preview", "tldr"] : ["preview", "tldr"]);

  function labelOf(act) {
    if (act !== "archive") return BTN[act]?.label || "";
    const vid = target?.info().videoId;
    if (archiveState.get(vid) === "wait") return "Отправляю в архив…";
    const cat = marks.get(vid);
    return cat ? `В архиве — «${cat}»` : BTN.archive.label;
  }

  function paintArchive(btn, vid) {
    if (!btn) return;
    const st = archiveState.get(vid) || (marks.get(vid) ? "done" : "");
    if (btn.dataset.st === st) return;
    btn.dataset.st = st;
    btn.innerHTML = st === "wait" ? ICON.spin : st === "done" ? ICON.done : ICON.archive;
    btn.classList.toggle("busy", st === "wait");
    btn.classList.toggle("on", st === "done");
  }

  async function loadMark(vid) {
    if (!vid || marks.has(vid) || !alive()) return;
    try {
      const v = (await chrome.storage.local.get(MARK + vid))[MARK + vid];
      marks.set(vid, v?.cat || "");
      if (v?.cat && target?.info().videoId === vid) placeButtons();
    } catch (e) {
      /* без отметки */
    }
  }

  // Плашка итога: на YouTube — общая с меню плеера (content.js, в плеере видна и во
  // весь экран), на страницах расширения — своя такая же.
  let toastTimer = 0;
  function toast(text, kind = "", ms = 2600) {
    const page = globalThis.__ytcsPageToast;
    if (typeof page === "function") return page(text, kind, ms);
    ensureHost();
    const t = $(".toast");
    t.innerHTML = `${kind === "wait" ? ICON.spin : kind === "ok" ? ICON.ok : kind === "err" ? ICON.alert : ICON.archive}<span></span>`;
    t.querySelector("span").textContent = text;
    void t.offsetHeight;
    t.classList.add("show");
    clearTimeout(toastTimer);
    if (ms > 0) toastTimer = setTimeout(() => t.classList.remove("show"), ms);
  }

  async function archive(info) {
    const vid = String(info?.videoId || "");
    if (!VID_RE.test(vid)) return null;
    if (archiveState.get(vid) === "wait") return null; // уже отправляем
    if (!alive()) {
      toast("Расширение обновилось — обновите страницу (F5)", "err", 4200);
      return null;
    }
    archiveState.set(vid, "wait");
    placeButtons();
    toast("Отправляю в архив Telegram…", "wait", 0);
    let r = null;
    try {
      r = await chrome.runtime.sendMessage({
        type: "archive:save",
        info: { videoId: vid, title: info.title || "", channel: info.channel || "", len: info.len || 0 },
      });
    } catch (e) {
      r = { ok: false, text: "Расширение обновилось — обновите страницу (F5)" };
    }
    archiveState.delete(vid);
    if (r?.ok) marks.set(vid, r.category || "Видео");
    placeButtons();
    toast(r?.text || "Не получилось сохранить в архив", r?.ok ? "ok" : "err", r?.ok ? 2600 : 4200);
    return r;
  }

  // итог пункта правого клика по вкладке без контент-скрипта (библиотека) — в видимой странице
  if (!ON_YT) {
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type !== "archive:result" || document.visibilityState !== "visible") return;
        const r = msg.result || {};
        if (r.ok) marks.set(String(msg.videoId || ""), r.category || "Видео");
        toast(r.text || "Не получилось сохранить в архив", r.ok ? "ok" : "err", r.ok ? 2600 : 4200);
      });
    } catch (e) {
      /* стенд без chrome.runtime */
    }
  }

  // Превью: адреса качеств и имя файла (шаблон из настроек) — у фона, окно — thumb-preview.js.
  let previewSeq = 0;
  async function openPreview(info) {
    const vid = String(info?.videoId || "");
    if (!VID_RE.test(vid)) return false;
    close();
    const seq = ++previewSeq;
    const fallback = {
      urls: ["maxresdefault", "sddefault", "hqdefault"].map((q) => `https://i.ytimg.com/vi/${vid}/${q}.jpg`),
      title: String(info.title || vid),
      name: `${vid}.jpg`,
    };
    let payload = fallback;
    // окно превью на YouTube грузится по требованию (lazy.js) — заодно с вопросом к фону;
    // на страницах расширения thumb-preview.js уже подключён
    const ready = globalThis.__ytcsPreview ? null : globalThis.__ytcsLazy?.load("preview");
    try {
      const r = alive() ? await chrome.runtime.sendMessage({ type: "ui:preview-info", videoId: vid, title: info.title || "", channel: info.channel || "" }) : null;
      if (r?.ok && Array.isArray(r.urls)) payload = { urls: r.urls, title: r.title || fallback.title, name: r.name || fallback.name };
    } catch (e) {
      /* фон не ответил — качаем под именем по id */
    }
    if (ready) await ready;
    if (seq !== previewSeq) return false; // за это время открыли другое
    const api = globalThis.__ytcsPreview;
    if (!api) {
      console.warn("[ytcs] thumb-preview.js не подключён — окна превью нет");
      toast(alive() ? "Не получилось открыть превью — обновите страницу (F5)" : "Расширение обновилось — обновите страницу (F5)", "err", 4200);
      return false;
    }
    return api.open(payload);
  }

  function close() {
    if (!$ || $(".pop").hidden) return;
    $(".pop").hidden = true;
    placeButtons();
  }

  // клик мимо окна — закрыть (прокрутка колесом окно не трогает)
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (!$ || $(".pop").hidden) return;
      if (e.composedPath().includes(host)) return;
      close();
    },
    true
  );

  // Esc закрывает окно раньше, чем его увидят select.js (снять выбор) и плеер
  window.addEventListener(
    "keydown",
    (e) => {
      // открыто меню по правому щелчку (ctxmenu.js) — Esc сначала его
      if (e.key !== "Escape" || !$ || $(".pop").hidden || globalThis.__ytcsCtxMenu?.isOpen?.()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    },
    true
  );

  // Колонки внутри чужих shadow DOM (очередь, библиотека) крутятся без события
  // scroll на window — кнопки догоняют обложку по колесу.
  window.addEventListener(
    "wheel",
    () => {
      if (!target || target.auto) return;
      requestAnimationFrame(placeButtons);
      setTimeout(placeButtons, 120);
    },
    { passive: true, capture: true }
  );

  // переход на другую страницу YouTube — окно и кнопки больше ни к чему
  window.addEventListener("yt-navigate-start", () => {
    close();
    setTarget(null);
  });

  // ---------- API для своих интерфейсов расширения ----------
  globalThis.__ytcsVideoActions = {
    /**
     * Кнопки «Превью» и «О чём видео» при наведении на обложку.
     * thumbEl — элемент обложки (может лежать в открытом shadow DOM); кнопки
     * рисуются в своём слое поверх страницы, стили подключать не нужно.
     * opts: videoId, title, channel, len (сек) — или getInfo() → те же поля
     *       (для карточек, которые переиспользуются под другие видео);
     *       card — рядом с чем ставить окно пересказа (по умолчанию обложка);
     *       right/top — отступы кнопок от правого верхнего угла обложки (8 px);
     *       actions — по умолчанию ["archive", "preview", "tldr"] (без "archive",
     *       если бот не настроен); zIndex — слоя (2019).
     * Возвращает detach().
     */
    attach(thumbEl, opts = {}) {
      if (!(thumbEl instanceof Element)) return () => {};
      bindings.set(thumbEl, { ...opts });
      return () => this.detach(thumbEl);
    },
    detach(thumbEl) {
      bindings.delete(thumbEl);
      if (target?.key === thumbEl) setTarget(null);
    },
    openTldr,
    openPreview,
    /** Видео в бот-архив Telegram с плашками «Отправляю…» → «Сохранено в «…»». */
    archive,
    /** Бот-архив настроен — кнопка и пункт «В архив Telegram» есть. */
    archiveReady: () => archiveReady,
    /**
     * Карточка видео YouTube под событием — для своего меню правого щелчка (ctxmenu.js).
     * path — composedPath(), x/y — точка (сквозь играющее превью YouTube).
     * → { card, thumb, info: { videoId, title, channel, len } } или null (не видео: плейлист, микс…).
     */
    cardFor(path, x, y) {
      // сквозь играющее превью YouTube и сквозь свои кнопки поверх обложки (кружок выбора, «О чём видео»)
      const through = overPreview(path) || path.some((el) => OWN_HOSTS.has(el.id));
      const card = cardFromPath(path) || (through ? cardAt(x, y) : null);
      const info = card && idOf(card) ? infoOf(card) : null;
      return info ? { card, thumb: thumbOf(card), info } : null;
    },
    /** Событие внутри карточки YouTube — любой, и не видео (микс, плейлист): ctxmenu.js не даёт по ссылке в ней меню видео. */
    inCard: (path) => Boolean(cardFromPath(path)),
    close,
    /** Тема окон: "dark" / "light", null — авто (YouTube: html[dark]; страницы расширения: data-theme / система). */
    setTheme(t) {
      themeOverride = t === "dark" || t === "light" ? t : null;
      host?.toggleAttribute("dark", isDark());
    },
    /** Перерисовать кнопки (после прокрутки/перестройки своей колонки без событий). */
    refresh() {
      placeButtons();
      if (cur && $ && !$(".pop").hidden) position();
    },
  };
})();
