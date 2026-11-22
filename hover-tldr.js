// «О чём видео» прямо в ленте YouTube (главная, подписки, поиск, рекомендации
// справа на странице видео, плейлисты, каналы, Shorts).
// Наведите на карточку — в правом верхнем углу превью кнопка; нажали — рядом
// с карточкой окно с кратким пересказом по субтитрам: абзац «о чём» и главные
// пункты с таймкодами (клик — видео с этого места). Текст появляется по мере
// написания. Пересказ делает фон (tldr-bg.js → общее ядро tldr-core.js) —
// сам контент-скрипт в сеть к боту не ходит; кеш общий с вкладкой «О видео»
// боковой панели.
//
// Левый верхний угол превью занят кружком выбора (select.js) и кнопкой
// «Пересказать» браузера; справа сверху во время живого превью YouTube ставит
// «Звук» и «Субтитры», в старой разметке — «Смотреть позже». Поэтому кнопка
// встаёт справа сверху левее этих значков и проверяет, что место свободно.
(() => {
  if (globalThis.__ytcsHoverTldr || location.hostname !== "www.youtube.com") return;
  globalThis.__ytcsHoverTldr = true;

  const PORT = "ytcs-tldr";
  const CARD =
    "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2";
  const THUMB =
    "yt-thumbnail-view-model, ytd-thumbnail, [class*='ThumbnailContainer'], .shortsLockupViewModelHostThumbnailContainer, a#thumbnail, a.reel-item-endpoint";
  // плейлисты, миксы и подборки — это не одно видео
  const COLLECTION = "yt-collection-thumbnail-view-model, ytd-playlist-thumbnail, [class*='CollectionStack'], [class*='collection-stack']";
  // чужие кнопки на превью, которые нельзя закрывать своей
  const FOREIGN =
    "button, [role='button'], yt-icon-button, ytd-thumbnail-overlay-toggle-button-renderer, [class*='summarization'], [class*='Summarization']";
  const ID_RE = /(?:[?&]v=|\/shorts\/)([A-Za-z0-9_-]{11})/;
  const MAX_POINTS = 6; // в окне — до шести пунктов равномерно по видео (в панели — все)

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };
  const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const isDark = () => document.documentElement.hasAttribute("dark");
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

  // ---------- карточки (как в select.js) ----------
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
      if (el.id === "ytcs-tldr" || el.id === "ytcs-select" || el.id === "ytcs-qmode") continue;
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
          "[class*='LockupMetadataViewModelTitle'], .yt-lockup-metadata-view-model__title, #video-title, [class*='shortsLockupViewModelHostMetadataTitle'], .shortsLockupViewModelHostMetadataTitle, h3"
        )
      ) ||
      a?.getAttribute("title") ||
      a?.getAttribute("aria-label") ||
      "";
    const badge = [...card.querySelectorAll("[class*='BadgeShapeText'], .yt-badge-shape__text, .badge-shape-wiz__text, ytd-thumbnail-overlay-time-status-renderer #text, badge-shape")]
      .map(text)
      .find((x) => /^\d+(:\d+)+$/.test(x));
    const len = badge ? badge.split(":").reduce((s, x) => s * 60 + Number(x), 0) : 0;
    return { title: title.slice(0, 300), len };
  }

  // ---------- оформление ----------
  const SVG = (paths, w = 1.9) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    // строки текста с искрой — «коротко о чём»
    tldr: SVG('<path d="M4 6.5h9"/><path d="M4 11.5h12"/><path d="M4 16.5h8"/><path d="M18.5 3.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>'),
    close: SVG('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>', 2.2),
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
    copy: SVG('<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>'),
    redo: SVG('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>'),
    subs: SVG('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 15h4"/><path d="M14 15h3"/><path d="M7 11h10"/>'),
    alert: SVG('<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/><path d="M12 17.5v.01"/>'),
    plug: SVG('<path d="M9 3v5"/><path d="M15 3v5"/><path d="M6.5 8h11v3a5.5 5.5 0 0 1-11 0z"/><path d="M12 16.5V21"/>'),
    stop: SVG('<rect x="6" y="6" width="12" height="12" rx="2.5"/>'),
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

    /* ---- кнопка на превью ---- */
    .hov { position: fixed; z-index: 2; height: var(--s, 32px); min-width: var(--s, 32px); padding: 0; border: 0; border-radius: 999px;
      cursor: pointer; display: none; align-items: center; justify-content: center; gap: 0; color: #fff;
      background: rgba(0, 0, 0, .62); box-shadow: 0 1px 6px rgba(0, 0, 0, .4), inset 0 0 0 1px rgba(255, 255, 255, .18);
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
      font: 600 14px/1 Roboto, "YouTube Sans", Arial, sans-serif; white-space: nowrap; overflow: hidden;
      transition: background-color .14s ease, transform .1s ease-out; }
    .hov.show { display: inline-flex; }
    .hov svg { width: 18px; height: 18px; flex: none; }
    .hov.small svg { width: 16px; height: 16px; }
    .hov .lbl { max-width: 0; opacity: 0; transition: max-width .2s ease-out, opacity .15s ease-out, margin .2s ease-out; }
    .hov.full, .hov:hover, .hov:focus-visible, .hov.open { padding: 0 13px 1px 10px; }
    .hov.full .lbl, .hov:hover .lbl, .hov:focus-visible .lbl, .hov.open .lbl { max-width: 160px; opacity: 1; margin-left: 6px; }
    .hov:hover { background: rgba(0, 0, 0, .8); }
    .hov.open { background: var(--acc); box-shadow: 0 1px 6px rgba(0, 0, 0, .4); }
    .hov:active { transform: scale(.95); }
    .hov:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

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
      .hov, .hov .lbl, .pop, .pop[hidden], .bar i { transition: none; }
      .skel i, .live .about::after { animation: none; }
    }`;

  // ---------- слой ----------
  let host = null;
  let $ = null;
  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.id = "ytcs-tldr";
    // свой слой: ниже шапки YouTube (2020), её меню и окон расширения — как у select.js
    host.style.cssText = "position:fixed;inset:auto;z-index:2019;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${UI_CSS}</style>
      <button class="hov" type="button" title="Коротко: о чём это видео (пересказ по субтитрам)" aria-label="О чём видео">${ICON.tldr}<span class="lbl">О чём видео</span></button>
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
    const hov = $(".hov");
    hov.addEventListener("pointerdown", (e) => e.preventDefault()); // фокус остаётся на странице
    hov.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!hovered?.isConnected) return;
      const vid = idOf(hovered);
      if (cur && cur.vid === vid && !$(".pop").hidden) return close();
      openFor(hovered);
    });
    $(".x").addEventListener("click", () => close());
    $(".pop").addEventListener("click", onPopClick);
    new ResizeObserver(() => cur && position()).observe($(".pop"));
    document.documentElement.appendChild(host);
  }

  // ---------- наведение ----------
  let hovered = null;
  let hovThumb = null;
  let hovOffset = 0; // отступ кнопки от правого края превью, с которым она встала
  let pointer = { x: -1, y: -1 };
  let recheck = 0;

  // свободно ли место под кнопкой: ни одной чужой кнопки в её углах и центре
  function spotFree(x, y, w, h) {
    const pts = [
      [x + 3, y + 3],
      [x + w - 3, y + 3],
      [x + 3, y + h - 3],
      [x + w - 3, y + h - 3],
      [x + w / 2, y + h / 2],
    ];
    for (const [px, py] of pts) {
      for (const el of document.elementsFromPoint(px, py)) {
        if (el === host) continue;
        if (el.matches?.(FOREIGN)) return false;
      }
    }
    return true;
  }

  function placeHover() {
    if (!host || !$) return;
    const hov = $(".hov");
    const r = hovThumb?.isConnected ? hovThumb.getBoundingClientRect() : null;
    const id = hovered ? idOf(hovered) : null;
    if (!r || !id || r.width < 100 || r.bottom < 0 || r.top > innerHeight) {
      hov.classList.remove("show");
      return;
    }
    const small = r.width < 220; // справа на странице видео, Shorts
    // на 2K/4K превью крупнее — и кнопка чуть крупнее (размеры ниже — экранные)
    const bz = small ? 1 : Math.min(zoomLevel(), 1.25);
    const s = (small ? 28 : 32) * bz;
    hov.style.setProperty("--s", `${s / bz}px`);
    hov.classList.toggle("small", small);
    hov.classList.toggle("open", Boolean(cur && cur.vid === id && !$(".pop").hidden));
    // У крупных превью справа сверху во время живого превью встают «Звук» и
    // «Субтитры» (колонка ~40 px) — сразу оставляем им место, чтобы кнопка не
    // прыгала, когда превью заиграет. У мелких — проверяем угол.
    const offsets = small ? [6, 40, 74] : [48, 88, 128];
    const pad = small ? 6 : 8;
    const fullW = 140 * bz; // ширина с подписью
    const tryPlace = (w) => {
      for (const off of offsets) {
        if (off < hovOffset) continue; // на той же карточке кнопка двигается только левее
        const x = r.right - off - w;
        if (x < r.left + 44) break; // левый угол — кружок выбора и чужие кнопки
        if (spotFree(x, r.top + pad, w, s)) return off;
      }
      return -1;
    };
    let full = r.width >= 300;
    let off = full ? tryPlace(fullW) : -1;
    if (off < 0) {
      full = false;
      off = tryPlace(s);
    }
    if (off < 0) off = Math.max(hovOffset, offsets[0]);
    hovOffset = off;
    hov.classList.toggle("full", full);
    // по правому краю: компактная кнопка при наведении раскрывает подпись влево
    const vw = document.documentElement.clientWidth || innerWidth;
    hov.style.zoom = bz;
    hov.style.left = "auto";
    hov.style.right = `${Math.round(vw - (r.right - off)) / bz}px`;
    hov.style.top = `${Math.round(r.top + pad) / bz}px`;
    hov.classList.add("show");
  }

  function setHovered(card) {
    if (card === hovered) return;
    hovered = card;
    hovThumb = card ? thumbOf(card) : null;
    hovOffset = 0;
    clearInterval(recheck);
    recheck = 0;
    if (card && idOf(card)) {
      ensureHost();
      host.toggleAttribute("dark", isDark());
      // превью YouTube и кнопка «Пересказать» появляются не сразу — сверяем место ещё пару раз
      let n = 0;
      recheck = setInterval(() => {
        if (++n > 8 || !hovered) {
          clearInterval(recheck);
          recheck = 0;
          return;
        }
        placeHover();
      }, 350);
    }
    placeHover();
  }

  const inside = (r, p) => r && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
  let moveRaf = 0;
  window.addEventListener(
    "pointermove",
    (e) => {
      pointer = { x: e.clientX, y: e.clientY };
      const path = e.composedPath();
      if (host && path.includes(host)) {
        // на нашей кнопке или в окне: карточка остаётся «под указателем»
        // и для YouTube, и для кружка выбора select.js
        e.stopPropagation();
        return;
      }
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        const card = cardFromPath(path) || (overPreview(path) ? cardAt(pointer.x, pointer.y) : null);
        setHovered(card);
      });
    },
    { passive: true, capture: true }
  );
  document.addEventListener("pointerleave", () => setHovered(null));
  let scrollRaf = 0;
  window.addEventListener(
    "scroll",
    () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        if (hovered && !inside(hovered.getBoundingClientRect(), pointer)) setHovered(null);
        else if (hovered) placeHover();
        if (cur && !$(".pop").hidden) position();
      });
    },
    { passive: true, capture: true }
  );
  window.addEventListener("resize", () => {
    if (cur && $ && !$(".pop").hidden) position();
    placeHover();
  });

  // ---------- окно: место на экране ----------
  let cur = null; // { vid, title, len, card, thumb, rect, state, ... }

  function zoomLevel() {
    if (innerWidth >= 2200 && innerHeight >= 1150) return 1.4;
    if (innerWidth >= 1600 && innerHeight >= 860) return 1.15;
    return 1;
  }

  function mastheadBottom() {
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
  const watchUrl = (t) => `/watch?v=${cur.vid}${t ? `&t=${Math.floor(t)}s` : ""}`;

  function pointsHtml(points) {
    if (!points.length) return "";
    const longest = Math.max(...points.map((p) => fmtTime(p.t).length));
    return `<div class="sub">Главное <span>нажмите — смотреть с этого места</span></div>
      <div class="pts" style="--tc-w: calc(40px + ${longest}ch)">${points
        .map(
          (p) => `<a class="row" href="${watchUrl(p.t)}" title="Смотреть с ${fmtTime(p.t)}">
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
  function openFor(card) {
    const vid = idOf(card);
    if (!vid) return;
    ensureHost();
    host.toggleAttribute("dark", isDark());
    const thumb = thumbOf(card) || card;
    const same = cur && cur.vid === vid;
    const info = infoOf(card);
    cur = {
      ...(same ? cur : { state: "run", phase: "Загружаю субтитры…", frac: 0.04, about: "", points: [] }),
      vid,
      title: info.title || cur?.title || "",
      len: info.len,
      card,
      thumb,
      rect: { card: card.getBoundingClientRect(), thumb: thumb.getBoundingClientRect() },
      retried: false,
    };
    const pop = $(".pop");
    render();
    pop.hidden = false;
    position();
    pop.focus({ preventScroll: true });
    placeHover();
    // готовый пересказ не переспрашиваем; идущий — переподписываемся (фон не дублирует)
    if (!same || !["done", "nosubs", "setup", "run"].includes(cur.state)) {
      Object.assign(cur, { state: "run", phase: "Загружаю субтитры…", frac: 0.04, about: "", points: [] });
      render();
    }
    if (cur.state === "run") request(false);
  }

  function close() {
    if (!$ || $(".pop").hidden) return;
    $(".pop").hidden = true;
    placeHover();
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
      if (e.key !== "Escape" || !$ || $(".pop").hidden) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    },
    true
  );

  // переход на другую страницу YouTube — окно и кнопка больше ни к чему
  window.addEventListener("yt-navigate-start", () => {
    close();
    setHovered(null);
  });
})();
