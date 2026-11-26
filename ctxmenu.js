"use strict";

// Своё меню по правому щелчку на YouTube — вместо меню браузера, в стиле меню расширения
// (как в «Моей библиотеке», library/ctxmenu.js). Три места:
//  1. карточки видео (главная, поиск, подписки, рекомендации справа, плейлисты, каналы,
//     полки Shorts): «Смотреть», «Открыть в новой вкладке», очередь по состоянию,
//     «Сохранить в плейлисты…», «Превью обложки», «О чём видео», «В архив Telegram»
//     (если бот настроен), «Копировать ссылку», «Канал «…»», «Не интересует» (штатное
//     действие YouTube — через его же меню «⋮» карточки);
//  2. ссылки на видео в тексте (описание, комментарии) — то же меню; у таймкода этого же
//     видео — «Перейти к 12:34» и «Заметка к этому месту» (notes.js);
//  3. плеер — вместо меню самого плеера YouTube: «Снимок кадра» (frame-shot.js), «Заметка»
//     (notes.js), «Повтор отрезка» A–B (abloop.js), «Скорость − / +» (speed.js), «Поиск по
//     речи» (speech.js), ссылки, очередь и последним — «Меню YouTube…»: родное меню плеера
//     (следующий contextmenu пропускается к YouTube). Во встроенном плеере «Моей библиотеки»
//     (/embed/) — тоже.
// Своих механизмов здесь нет: все действия — уже существующие API модулей
// (__ytcsVideoActions, __ytcsQueue, __ytcsLazy → __ytcsPlaylists, __ytcsNotes, …).
// Логика без DOM (пункты по состоянию, разбор ссылок, место меню, клавиши) — ctxmenu-core.js.
//   - Shift + правый щелчок, поле ввода или выделенный текст — обычное меню браузера;
//   - выключается переключателем «Меню по правому клику» (меню кнопки расширения
//     в плеере → «Плеер ›», и в меню браузера) — settings.ctxMenu, по умолчанию вкл.;
//   - закрывается по Esc, щелчку мимо, прокрутке, смене страницы (yt-navigate) и размера окна;
//   - стрелки, Home/End, Enter/пробел; клавиша меню и Shift+F10 открывают меню у фокуса,
//     после выбора с клавиатуры или Esc фокус возвращается;
//   - не вылезает за край окна и встаёт на чётные пиксели (ровные подписи на 150 %).
(() => {
  // встроенный плеер — только внутри нашей «Моей библиотеки»; прочие фреймы — не наше
  const OUR_EMBED = location.pathname.startsWith("/embed/");
  if (OUR_EMBED) {
    let ours = false;
    try {
      ours = location.ancestorOrigins?.[0] === `chrome-extension://${chrome.runtime.id}`;
    } catch (e) {
      ours = false;
    }
    if (!ours) return;
  } else if (window.top !== window) {
    return;
  }
  if (globalThis.__ytcsCtxMenu) return;
  const C = globalThis.__ytcsCtxCore;
  if (!C) return;

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

  // ---------- включено? (settings.ctxMenu, по умолчанию да) ----------
  let enabled = true;
  if (alive()) {
    chrome.storage.local
      .get("settings")
      .then((o) => (enabled = o.settings?.ctxMenu !== false))
      .catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch.settings) {
        enabled = ch.settings.newValue?.ctxMenu !== false;
        if (!enabled) close(false);
      }
      if (ch.queue) queue = Array.isArray(ch.queue.newValue) ? ch.queue.newValue : [];
    });
  }
  // очередь — для пунктов «В очередь» / «Наверх» / «Убрать» (пишет её только фон)
  let queue = [];
  if (alive()) {
    chrome.storage.local
      .get("queue")
      .then((o) => (queue = Array.isArray(o.queue) ? o.queue : []))
      .catch(() => {});
  }
  const qIndex = (id) => queue.findIndex((x) => x.id === id);

  // ---------- значки (рисунки — как в меню плеера и библиотеки) ----------
  const SVG = (p, w = 1.9) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${p}</svg>`;
  const ICON = {
    brand: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="M7 4.5h10a4 4 0 0 1 4 4V13a4 4 0 0 1-4 4h-5.6l-4.3 3.2a.6.6 0 0 1-.96-.48V17H7a4 4 0 0 1-4-4V8.5a4 4 0 0 1 4-4Zm3.4 3.9v5.2c0 .4.43.64.77.43l4.15-2.6a.5.5 0 0 0 0-.86l-4.15-2.6a.5.5 0 0 0-.77.43Z"/></svg>`,
    play: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 5.5v13l10.5-6.5z"/></svg>',
    // рисунки, что сидят выше заглавных, — на долю пикселя ниже (замер по пикселям, tools/align)
    tab: SVG('<g transform="translate(0 .6)"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></g>'),
    queue: SVG('<g transform="translate(0 .6)"><path d="M4 4.75h11"/><path d="M4 10.75h11"/><path d="M4 16.75h7"/><path d="M15 14.25v5l4.5-2.5z"/></g>'),
    top: SVG('<path d="M5 4h14"/><path d="M12 20V9"/><path d="M7.5 13.5L12 9l4.5 4.5"/>'),
    remove: SVG('<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 12.5h9l1-12.5"/><path d="M10 11v5"/><path d="M14 11v5"/>'),
    save: SVG('<path d="M4 4.5h11"/><path d="M4 10.5h11"/><path d="M4 16.5h7"/><path d="M17 13.5v6"/><path d="M14 16.5h6"/>'),
    preview: SVG('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    tldr: SVG('<g transform="translate(-.75 2.55)"><path d="M4 6.5h9"/><path d="M4 11.5h12"/><path d="M4 16.5h8"/><path d="M18.5 3.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/></g>'),
    archive: SVG('<g transform="translate(-.75 .2)"><path d="M20.4 4.3L3.7 10.8c-.9.35-.85 1.6.06 1.88l4.04 1.25 1.6 5.03c.25.8 1.25 1 1.83.4l2.2-2.25 4.3 3.17c.7.5 1.7.12 1.88-.72l2.73-12.6c.2-.92-.7-1.67-1.58-1.33z"/><path d="M7.8 13.93l9.7-6.43-6.6 7.4-.5 4.4"/></g>', 1.8),
    link: SVG('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L12 5.6"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>'),
    time: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    channel: SVG('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
    hide: SVG('<path d="M3 3l18 18"/><path d="M10.6 5.1A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1"/><path d="M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
    note: SVG('<path d="M5 4h14v10.5L13.5 20H5z"/><path d="M13.5 20v-5.5H19"/><path d="M8.5 8.5h7M8.5 12h4"/>'),
    camera: SVG('<path d="M4 9A2.5 2.5 0 0 1 6.5 6.5h1.8l1.5-2h4.4l1.5 2h1.8A2.5 2.5 0 0 1 20 9v8A2.5 2.5 0 0 1 17.5 19.5h-11A2.5 2.5 0 0 1 4 17z"/><circle cx="12" cy="13" r="3.5"/>'),
    loop: SVG('<path d="M17 4.5l2.5 2.5L17 9.5"/><path d="M19.5 7H8.5A4.5 4.5 0 0 0 4 11.5V12"/><path d="M7 19.5L4.5 17 7 14.5"/><path d="M4.5 17h11a4.5 4.5 0 0 0 4.5-4.5V12"/>'),
    close: SVG('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>', 2.1),
    speed: SVG('<path d="M4.2 19a9 9 0 1 1 15.6 0"/><path d="M12 15l4.2-4.6"/><circle cx="12" cy="15" r="1.4"/><path d="M12 6.7v1.6M6.3 9.5l1.2 1M17.7 9.5l-1.2 1" opacity=".6"/>'),
    speech: SVG('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.3 15.3L20 20"/><path d="M8.3 9.3v2.4M10.5 8v5M12.7 9.3v2.4"/>'),
    minus: SVG('<path d="M6 12h12"/>', 2.2),
    plus: SVG('<path d="M6 12h12"/><path d="M12 6v12"/>', 2.2),
    // родное меню плеера YouTube — три точки
    yt: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="currentColor"><circle cx="5.5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="18.5" cy="12" r="1.9"/></g></svg>',
  };
  // клавиши — справа в пункте, приглушённо (как в меню браузера)
  const HINT = { frame: "Shift+S", note: "N", abA: "A", abB: "B", abOff: "Esc", speech: "Ctrl+Shift+F" };

  // ---------- оформление ----------
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    :host { --bg: #fff; --fg: #0f0f0f; --fg-2: #3c3c43; --muted: #606068; --line: rgba(0, 0, 0, .1);
      --hover: rgba(0, 0, 0, .06); --press: rgba(0, 0, 0, .1); --acc: #e8002d; --acc-ink: #d1002a; --step: rgba(0, 0, 0, .06);
      --shadow: 0 16px 44px rgba(0, 0, 0, .2), 0 2px 8px rgba(0, 0, 0, .08); }
    :host([dark]) { --bg: #282828; --fg: #f1f1f1; --fg-2: #d0d0d6; --muted: #aaaab2; --line: rgba(255, 255, 255, .12);
      --hover: rgba(255, 255, 255, .1); --press: rgba(255, 255, 255, .16); --acc: #ff3b5c; --acc-ink: #ff6b85; --step: rgba(255, 255, 255, .1);
      --shadow: 0 16px 44px rgba(0, 0, 0, .55), 0 2px 8px rgba(0, 0, 0, .3); }
    /* в плеере — тёмное стекло, как меню кнопки расширения и самого плеера */
    :host([glass]) { --bg: rgba(28, 28, 30, .9); --line: rgba(255, 255, 255, .1); }

    .m { position: fixed; left: 0; top: 0; display: flex; flex-direction: column; width: max-content;
      min-width: 252px; max-width: min(360px, calc(100vw - 16px)); max-height: calc(100vh - 16px);
      overflow: auto; overscroll-behavior: contain; padding: 6px; border-radius: 14px;
      background: var(--bg); color: var(--fg); box-shadow: var(--shadow), 0 0 0 1px var(--line);
      font: 500 15px/20px Roboto, "YouTube Sans", Arial, sans-serif; -webkit-font-smoothing: antialiased;
      outline: none; scrollbar-width: thin; scrollbar-color: var(--line) transparent;
      animation: ctx-in .12s cubic-bezier(.2, .8, .2, 1); }
    :host([glass]) .m { -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6); }
    .m[hidden] { display: none; }
    @keyframes ctx-in { from { opacity: 0; scale: .97; } }

    /* о чём меню — название видео; высота целыми px, чтобы пункты не вставали на долю пикселя */
    .head { flex: none; display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px 2px; margin-bottom: 4px;
      border-bottom: 1px solid var(--line); color: var(--muted); font-size: 13px; font-weight: 600; line-height: 20px; }
    .head svg { flex: none; width: 16px; height: 16px; color: var(--acc); }
    .head span { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

    .it { all: unset; box-sizing: border-box; flex: none; display: flex; align-items: center; gap: 12px; width: 100%;
      height: 40px; padding: 0 14px 0 12px; border-radius: 9px; color: var(--fg); cursor: pointer; white-space: nowrap;
      font: inherit; transition: background-color .1s ease; }
    /* подпись — ровно по центру строки; значок — на высоте заглавных Roboto: они на полпикселя
       выше середины строки, а полпикселя разметкой не задать — только сдвигом рисунка (замер, tools/align) */
    .it > svg { flex: none; width: 20px; height: 20px; color: var(--fg-2); translate: 0 -.5px; }
    .it .lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .it .kb { flex: none; margin-left: 12px; color: var(--muted); font-size: 13px; font-weight: 400; }
    .it:hover, .it:focus { background: var(--hover); outline: none; }
    .it:active { background: var(--press); }
    .it:focus-visible { box-shadow: inset 0 0 0 2px var(--acc); }
    .it.danger, .it.danger > svg { color: var(--acc-ink); }
    .it[aria-disabled="true"] { opacity: .45; cursor: default; background: transparent; }

    /* «Скорость − 1,25× +» — меню не закрывается, можно нажать несколько раз; ←/→ с клавиатуры */
    .it.rate { cursor: default; padding-right: 6px; }
    .it.rate:active { background: var(--hover); }
    .st { all: unset; box-sizing: border-box; flex: none; display: grid; place-items: center; width: 32px; height: 32px;
      border-radius: 50%; background: var(--step); color: var(--fg); cursor: pointer; transition: background-color .1s ease, transform .08s ease-out; }
    .st:hover { background: var(--press); }
    .st:active { transform: scale(.92); }
    .st svg { width: 16px; height: 16px; }
    .rv { flex: none; min-width: 54px; text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; }

    /* 1 + 5 + 6 = 12 px: строки ниже черты остаются на чётных пикселях (ровные подписи на 150 %) */
    .sep { flex: none; height: 1px; margin: 5px 8px 6px; background: var(--line); }

    /* узкое окно и телефон — строки крупнее, под палец */
    @media (max-width: 640px) {
      .it { height: 44px; }
      .m { min-width: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .m { animation: none; }
      .it, .st { transition: none; }
    }`;

  // ---------- слой меню ----------
  let host = null;
  let menu = null;
  function ensure() {
    if (host) return;
    host = document.createElement("div");
    host.id = "ytcs-ctxmenu";
    // выше шапки, плеера, окон YouTube и слоя встроенного плеера (2147482000)
    host.style.cssText = "position: fixed; left: 0; top: 0; width: 0; height: 0; margin: 0; padding: 0; border: 0; z-index: 2147483000;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style><div class="m" role="menu" tabindex="-1" hidden></div>`;
    menu = root.querySelector(".m");
    // щелчки в меню — только меню: не до плеера (пауза) и не до страницы
    for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "touchstart", "touchend"]) host.addEventListener(t, (e) => e.stopPropagation());
    menu.addEventListener("click", onMenuClick);
    menu.addEventListener("pointermove", (e) => {
      const b = e.target.closest(".it");
      if (b && root.activeElement !== b) b.focus({ preventScroll: true });
    });
    menu.addEventListener("pointerleave", () => menu.contains(root.activeElement) && menu.focus({ preventScroll: true }));
    menu.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  const shadowActive = () => host?.shadowRoot.activeElement || null;
  const isOpen = () => Boolean(menu && !menu.hidden);

  // ---------- что под щелчком ----------
  const curVid = () => {
    if (OUR_EMBED) return location.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})/)?.[1] || "";
    if (location.pathname === "/watch") return new URLSearchParams(location.search).get("v") || "";
    return "";
  };
  const mainVideo = () => document.querySelector("#movie_player video.html5-main-video") || document.querySelector("#movie_player video") || document.querySelector("video");
  const isOwnUi = (el) => el instanceof Element && el !== host && (el.id?.startsWith("ytcs-") || el.classList?.contains("ytcs-menu"));

  function pageTitle() {
    if (OUR_EMBED) return text(document.querySelector(".ytp-title-link")) || document.title.replace(/\s*-\s*YouTube$/, "");
    return text(document.querySelector("ytd-watch-metadata h1 yt-formatted-string, h1.ytd-watch-metadata")) || document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, "");
  }
  function pageChannel() {
    if (OUR_EMBED) return text(document.querySelector(".ytp-title-channel-name"));
    return text(document.querySelector("ytd-watch-metadata #channel-name a, #owner #channel-name a"));
  }

  // ссылка на канал в карточке: /@имя, /channel/UC…, /c/…
  function channelLink(card) {
    if (!card) return null;
    for (const a of card.querySelectorAll("a[href]")) {
      if (/^\/(@[^/?#]+|channel\/UC[\w-]{22}|c\/[^/?#]+|user\/[^/?#]+)\/?(\?|$)/.test(a.getAttribute("href") || "")) return a;
    }
    return null;
  }
  // имя канала без ссылки (новые карточки справа): первая подпись в первой строке метаданных —
  // у просмотров и даты есть aria-label («3,2 миллиона просмотров»), у имени канала — нет
  function channelText(card) {
    const row = card?.querySelector("[class*='ContentMetadataViewModelMetadataRow'], .yt-content-metadata-view-model__metadata-row");
    const span = row && [...row.querySelectorAll("[class*='MetadataText'], .yt-content-metadata-view-model__metadata-text")].find((x) => !x.hasAttribute("aria-label"));
    return text(span);
  }
  // канал: по ссылке из карточки, а без неё — поиск каналов YouTube по имени (как в «Моей библиотеке»)
  const channelSearch = (name) => `https://www.youtube.com/results?search_query=${encodeURIComponent(name)}&sp=EgIQAg%253D%253D`;
  // ссылка на видео в карточке — та, по которой YouTube и так переходит
  function videoLink(card, id) {
    return [...card.querySelectorAll("a[href]")].find((a) => C.parseLink(a.href)?.id === id) || null;
  }
  // кнопка «⋮» карточки — через неё «Не интересует» самого YouTube
  const MORE_RE = /^(ещё|еще|меню действий|more|more actions|action menu|дії|ще)$/i;
  const signedIn = () => Boolean(document.querySelector("ytd-masthead #avatar-btn, ytd-topbar-menu-button-renderer #avatar-btn"));
  const moreButton = (card) => [...card.querySelectorAll("button")].find((b) => MORE_RE.test((b.getAttribute("aria-label") || "").trim())) || null;

  /** Что под правым щелчком: { kind: "player" | "card" | "link", … } или null (меню браузера). */
  function contextOf(e) {
    const path = e.composedPath();
    // свои окна и колонки расширения — как раньше; кнопки поверх обложки (кружок выбора select.js,
    // «Превью» / «О чём видео» video-actions.js) — это карточка под ними
    const own = path.find(isOwnUi);
    if (own) {
      const inner = path[0] instanceof Element ? path[0] : null;
      const overlay = (own.id === "ytcs-select" && inner?.closest(".hov")) || (own.id === "ytcs-tldr" && inner?.closest(".va"));
      if (!overlay) return null;
    }
    const player = OUR_EMBED ? document.getElementById("movie_player") || document.body : path.find((el) => el.id === "movie_player");
    const onWatch = OUR_EMBED || location.pathname === "/watch";
    // ссылка на другое видео прямо в плеере (заставки в конце, «Ещё видео») — как ссылка
    const a = path.find((el) => el instanceof HTMLAnchorElement && el.href);
    const link = a ? C.parseLink(a.href) : null;
    if (player && onWatch && !(link && link.id !== curVid())) {
      // окна самого плеера (⚙, его меню) — не трогаем
      if (path.some((el) => el instanceof Element && el.matches?.(".ytp-popup, .ytp-contextmenu, .ytp-settings-menu"))) return null;
      return { kind: "player", player };
    }
    if (player && !onWatch) return null; // превью на главной и т. п. — ниже, как карточка
    const va = globalThis.__ytcsVideoActions;
    const hit = va?.cardFor?.(path, e.clientX, e.clientY);
    if (hit) {
      const { card, info, thumb } = hit;
      const main = videoLink(card, info.videoId);
      const p = C.parseLink(main?.href || "") || { id: info.videoId, short: false, t: 0 };
      const ch = channelLink(card);
      const channel = (info.channel || text(ch) || channelText(card)).slice(0, 120);
      // время в ссылке карточки — «продолжить» от YouTube, меню — с начала, как щелчок;
      // щёлкнули по ссылке на момент этого видео в карточке (главы в поиске) — с её времени
      const t = C.cardTime(info.videoId, a?.href || "", main?.href || "");
      return {
        kind: "card",
        card,
        thumb,
        anchor: t ? a : main,
        id: info.videoId,
        short: p.short,
        t,
        title: info.title,
        channel,
        channelA: ch,
        channelUrl: ch?.href || (channel ? channelSearch(channel) : ""),
        len: info.len || 0,
      };
    }
    // ссылка в тексте; внутри карточки-подборки (микс, плейлист — cardFor их не берёт) — меню браузера
    const lt = C.linkTarget(link, { cur: curVid(), hasVideo: Boolean(mainVideo()), inCard: Boolean(va?.inCard?.(path)), pageTitle: link?.id === curVid() ? pageTitle() : "" });
    return lt ? { kind: "link", anchor: a, ...lt, channel: "", len: 0 } : null;
  }

  // ---------- пункты ----------
  function rateLabel() {
    const r = globalThis.__ytcsSpeed?.rate?.() ?? mainVideo()?.playbackRate ?? 1;
    return globalThis.__ytcsSpeedCore?.fmtRate?.(r) || `${String(Math.round(r * 100) / 100).replace(".", ",")}×`;
  }
  function itemsFor(ctx) {
    if (ctx.kind === "player") {
      const v = mainVideo();
      const ab = globalThis.__ytcsAb?.state?.();
      return C.playerItems({
        t: v?.currentTime || 0,
        rate: rateLabel(),
        ab,
        queue: curVid() ? { index: qIndex(curVid()) } : null,
        has: {
          frame: Boolean(globalThis.__ytcsFrameShot),
          notes: Boolean(globalThis.__ytcsNotes && curVid()),
          ab: Boolean(globalThis.__ytcsAb),
          speed: Boolean(globalThis.__ytcsSpeed?.step),
          speech: Boolean(globalThis.__ytcsSpeech),
        },
        // у нового встроенного плеера (слой #player-controls, «Моя библиотека») своего меню нет;
        // на самом YouTube элемент с таким id — не этот слой (как content.js: только при OUR_EMBED)
        native: !(OUR_EMBED && document.getElementById("player-controls")),
      });
    }
    const va = globalThis.__ytcsVideoActions;
    const card = ctx.kind === "card";
    return C.videoItems({
      short: ctx.short,
      t: ctx.t,
      here: ctx.here,
      queue: { index: qIndex(ctx.id) },
      channel: card ? ctx.channel : "",
      has: {
        playlists: !OUR_EMBED && Boolean(globalThis.__ytcsPlaylists || globalThis.__ytcsLazy),
        preview: Boolean(va),
        tldr: Boolean(va),
        archive: Boolean(va?.archiveReady?.()),
        notes: Boolean(globalThis.__ytcsNotes),
        // без входа в аккаунт YouTube «Не интересует» не предлагает (проверено вживую)
        notInterested: card && !OUR_EMBED && signedIn() && Boolean(moreButton(ctx.card)),
      },
    });
  }

  let acts = new Map(); // key → действие
  let cur = null; // контекст открытого меню
  function render(ctx) {
    const list = itemsFor(ctx);
    const head = ctx.kind === "player" ? pageTitle() : ctx.title || "Видео";
    menu.innerHTML =
      `<div class="head" title="${esc(head)}">${ICON.brand}<span>${esc(head || "Видео")}</span></div>` +
      list
        .map((x) => {
          if (x === "-") return `<div class="sep" role="separator"></div>`;
          if (x.kind === "rate")
            return `<div class="it rate" role="menuitem" data-k="${x.key}" tabindex="-1" aria-label="Скорость ${esc(x.value)}: ← медленнее, → быстрее">${ICON[x.icon] || ""}<span class="lbl">${esc(x.label)}</span><button type="button" class="st" data-rate="-1" tabindex="-1" title="Медленнее — Shift+&lt;" aria-label="Медленнее">${ICON.minus}</button><span class="rv">${esc(x.value)}</span><button type="button" class="st" data-rate="1" tabindex="-1" title="Быстрее — Shift+&gt;" aria-label="Быстрее">${ICON.plus}</button></div>`;
          const hint = ctx.kind === "player" && HINT[x.key] ? `<span class="kb">${esc(HINT[x.key])}</span>` : "";
          return `<button type="button" role="menuitem" class="it${x.danger ? " danger" : ""}" data-k="${x.key}" tabindex="-1">${ICON[x.icon] || ""}<span class="lbl">${esc(x.label)}</span>${hint}</button>`;
        })
        .join("");
    menu.setAttribute("aria-label", ctx.kind === "player" ? "Меню плеера" : "Действия с видео");
  }

  // ---------- действия (все — уже существующие) ----------
  function toast(msg, kind = "ok", ms) {
    if (globalThis.__ytcsPageToast) return void globalThis.__ytcsPageToast(msg, kind, ms ?? (kind === "err" ? 4200 : 2600));
    globalThis.__ytcsQueue?.toast?.(msg);
  }
  async function copy(textToCopy, done) {
    let ok = false;
    try {
      // без фокуса страницы запись может не ответить вовсе — ждём не дольше 1,5 с
      await Promise.race([navigator.clipboard.writeText(textToCopy), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 1500))]);
      ok = true;
    } catch (e) {
      // запасной путь: у страницы нет фокуса
      const ta = document.createElement("textarea");
      ta.value = textToCopy;
      ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.documentElement.append(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch (err) {
        ok = false;
      }
      ta.remove();
    }
    toast(ok ? done : "Не получилось скопировать — браузер не дал доступ к буферу обмена", ok ? "ok" : "err");
  }
  // переход — тем же щелчком по ссылке, что и мышью: YouTube откроет без перезагрузки
  // (ytcsMenu — чтобы режим выбора и «Режим очереди» select.js не перехватили щелчок)
  function follow(a, href) {
    if (a?.isConnected) {
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, button: 0, view: window });
      ev.ytcsMenu = true;
      a.dispatchEvent(ev);
      return;
    }
    if (href) location.assign(href);
  }
  const send = (m) => (alive() ? chrome.runtime.sendMessage(m).catch(() => null) : Promise.resolve(null));
  // очередь: на YouTube — queue.js (плашка с «Отменить»), во встроенном плеере — те же сообщения фону
  async function queueDo(key, rec) {
    const q = globalThis.__ytcsQueue;
    if (q?.add) {
      if (key === "queue") return q.add(rec);
      if (key === "qtop") return q.top(rec.id);
      return q.remove(rec.id);
    }
    const msg = key === "queue" ? { type: "queue:add", items: [rec] } : key === "qtop" ? { type: "queue:top", ids: [rec.id] } : { type: "queue:remove", ids: [rec.id], why: "drop" };
    const r = await send(msg);
    if (!r?.ok) return toast("Не получилось — обновите страницу (F5)", "err");
    toast(key === "queue" ? `В очереди: «${rec.title || "видео"}»` : key === "qtop" ? "Наверху очереди" : "Убрано из очереди", "ok");
  }

  // «Не интересует» — штатное действие YouTube: его же меню «⋮» карточки, невидимо, пункт по названию
  const NOPE_RE = /^(не интересует|не интересно|not interested|не цікаво)$/i;
  async function notInterested(card) {
    const btn = moreButton(card);
    if (!btn?.isConnected) return toast("Карточка уже обновилась — откройте меню ещё раз", "err");
    const st = document.createElement("style");
    st.textContent = "ytd-popup-container tp-yt-iron-dropdown, ytd-popup-container yt-sheet-view-model, ytd-popup-container ytd-menu-popup-renderer { opacity: 0 !important; }";
    document.documentElement.append(st);
    btn.click();
    let item = null;
    for (let i = 0; i < 30 && !item; i++) {
      await new Promise((r) => setTimeout(r, 50));
      item = [...document.querySelectorAll("ytd-popup-container yt-list-item-view-model, ytd-popup-container ytd-menu-service-item-renderer, ytd-popup-container tp-yt-paper-item")].find(
        (x) => x.getClientRects().length && NOPE_RE.test(text(x))
      );
    }
    if (item) (item.querySelector("button, [role='menuitem'], tp-yt-paper-item") || item).click();
    else {
      // YouTube не предложил — закрыть его меню, как Esc
      document.querySelector("ytd-popup-container tp-yt-iron-dropdown:not([aria-hidden='true'])")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      toast("YouTube не предлагает «Не интересует» для этого видео", "err");
    }
    setTimeout(() => st.remove(), 400);
  }

  // «Меню YouTube…» — родное меню плеера: тот же правый щелчок, пропущенный к плееру
  let passNext = false;
  function openNative(ctx) {
    const target = ctx.target?.isConnected ? ctx.target : ctx.player;
    if (!target) return;
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, button: 2, buttons: 2, clientX: ctx.x, clientY: ctx.y, view: window });
    passNext = true;
    try {
      target.dispatchEvent(ev);
    } finally {
      passNext = false;
    }
    // плеер сам показал меню — он отменяет событие; нет — своего меню у этого плеера нет
    if (!ev.defaultPrevented) toast("У этого плеера нет своего меню — Shift + правый щелчок откроет меню браузера", "err", 4200);
  }

  function videoRec(ctx, t = 0) {
    return { id: ctx.id, title: ctx.title || "", channel: ctx.channel || "", len: ctx.len || 0, short: Boolean(ctx.short), t: Math.floor(t) };
  }

  function run(key, ctx) {
    const va = globalThis.__ytcsVideoActions;
    if (ctx.kind === "player") {
      const v = mainVideo();
      const id = curVid();
      const t = Math.floor(v?.currentTime || 0);
      const pctx = { ...ctx, id, title: pageTitle(), channel: pageChannel(), len: Number.isFinite(v?.duration) ? Math.round(v.duration) : 0, short: false };
      switch (key) {
        case "frame":
          return void globalThis.__ytcsFrameShot?.shoot();
        case "note":
          return void globalThis.__ytcsNotes?.open();
        case "abA":
          return void globalThis.__ytcsAb?.setA();
        case "abB":
          return void globalThis.__ytcsAb?.setB();
        case "abOff":
          return void globalThis.__ytcsAb?.clear();
        case "speech":
          return void globalThis.__ytcsSpeech?.open();
        case "copy":
          return void copy(C.videoUrl(id), "Ссылка скопирована");
        case "copyT":
          return void copy(C.videoUrl(id, { t }), `Ссылка с ${C.fmtTime(t)} скопирована`);
        case "queue":
        case "qtop":
        case "qdel":
          return void queueDo(key, videoRec(pctx, t));
        case "native":
          return openNative(ctx);
      }
      return;
    }
    const info = { videoId: ctx.id, title: ctx.title, channel: ctx.channel, len: ctx.len };
    switch (key) {
      case "play":
        return follow(ctx.anchor, C.videoUrl(ctx.id, { short: ctx.short, t: ctx.t }));
      case "seek":
        // таймкод этого видео — тот же щелчок по нему: YouTube перематывает и поднимает к плееру
        return follow(ctx.anchor, "");
      case "note":
        return void globalThis.__ytcsNotes?.open(ctx.t);
      case "tab":
        return void window.open(C.videoUrl(ctx.id, { short: ctx.short, t: ctx.t }), "_blank", "noopener");
      case "queue":
      case "qtop":
      case "qdel":
        return void queueDo(key, videoRec(ctx));
      case "save":
        return void globalThis.__ytcsLazy
          ?.load("playlists")
          .then((ok) => (ok && globalThis.__ytcsPlaylists ? globalThis.__ytcsPlaylists.open({ videoId: ctx.id, title: ctx.title }) : toast("Не получилось открыть окно — обновите страницу (F5)", "err")));
      case "preview":
        return void va?.openPreview(info);
      case "tldr":
        return void va?.openTldr((ctx.thumb?.isConnected && ctx.thumb) || (ctx.card?.isConnected && ctx.card) || ctx.anchor, info, { card: ctx.card });
      case "archive":
        return void va?.archive(info);
      case "copy":
        return void copy(C.videoUrl(ctx.id, { short: ctx.short }), "Ссылка скопирована");
      case "copyT":
        return void copy(C.videoUrl(ctx.id, { t: ctx.t }), `Ссылка с ${C.fmtTime(ctx.t)} скопирована`);
      case "channel":
        return follow(ctx.channelA, ctx.channelUrl);
      case "nope":
        return void notInterested(ctx.card);
    }
  }

  function step(dir) {
    globalThis.__ytcsSpeed?.step?.(dir);
    const rv = menu.querySelector(".rv");
    if (rv) rv.textContent = rateLabel();
  }

  function onMenuClick(e) {
    const st = e.target.closest(".st");
    if (st) return step(Number(st.dataset.rate));
    const b = e.target.closest(".it");
    if (!b || b.classList.contains("rate") || b.getAttribute("aria-disabled") === "true") return;
    const ctx = cur;
    // выбрали с клавиатуры (Enter/пробел: detail 0) — фокус обратно туда, где был
    close(e.detail === 0);
    if (ctx) run(b.dataset.k, ctx);
  }

  // ---------- открыть / закрыть ----------
  let back = null; // куда вернуть фокус
  let openW = 0;
  function openMenu(ctx, x, y, keyboard) {
    ensure();
    const parent = document.fullscreenElement && !(document.fullscreenElement instanceof HTMLVideoElement) ? document.fullscreenElement : document.documentElement;
    if (host.parentNode !== parent) parent.append(host);
    host.toggleAttribute("dark", ctx.kind === "player" || document.documentElement.hasAttribute("dark"));
    host.toggleAttribute("glass", ctx.kind === "player");
    back = document.activeElement;
    cur = { ...ctx, x, y };
    render(ctx);
    menu.hidden = false;
    const W = Math.min(innerWidth, document.documentElement.clientWidth || innerWidth);
    const p = C.place(x, y, menu.offsetWidth, menu.offsetHeight, W, innerHeight);
    menu.style.left = `${p.left}px`;
    menu.style.top = `${p.top}px`;
    openW = innerWidth;
    const first = menu.querySelector(".it");
    if (keyboard && first) first.focus({ preventScroll: true });
    else menu.focus({ preventScroll: true });
    addEventListener("keydown", onKey, true);
    addEventListener("pointerdown", onDown, true);
    addEventListener("scroll", onScroll, true);
    addEventListener("wheel", onScroll, { capture: true, passive: true });
    addEventListener("resize", onResize);
    addEventListener("blur", onBlur);
  }

  function close(restore = true) {
    if (!isOpen()) return;
    const hadFocus = menu.contains(shadowActive()) || shadowActive() === menu;
    menu.hidden = true;
    removeEventListener("keydown", onKey, true);
    removeEventListener("pointerdown", onDown, true);
    removeEventListener("scroll", onScroll, true);
    removeEventListener("wheel", onScroll, { capture: true });
    removeEventListener("resize", onResize);
    removeEventListener("blur", onBlur);
    if (restore && hadFocus && back?.isConnected && back !== document.body) back.focus({ preventScroll: true });
    else if (hadFocus) host.blur?.();
    back = null;
    cur = null;
  }

  const onBlur = () => close(false);
  const inside = (e) => e.composedPath().includes(host);
  function onDown(e) {
    if (!inside(e)) close(false);
  }
  function onScroll(e) {
    if (!inside(e)) close(false);
  }
  // уже/шире — карточки перестроились, меню не у своей карточки; только высота — остаётся в окне
  function onResize() {
    if (innerWidth !== openW || !cur) return close(false);
    const p = C.place(cur.x, cur.y, menu.offsetWidth, menu.offsetHeight, Math.min(innerWidth, document.documentElement.clientWidth || innerWidth), innerHeight);
    menu.style.left = `${p.left}px`;
    menu.style.top = `${p.top}px`;
  }
  // смена страницы YouTube (без перезагрузки), во весь экран и обратно
  for (const ev of ["yt-navigate-start", "yt-navigate-finish", "popstate", "hashchange"]) addEventListener(ev, () => close(false));
  document.addEventListener("fullscreenchange", () => close(false));
  document.addEventListener("visibilitychange", () => document.hidden && close(false));

  // клавиши, которые меню не закрывают: модификаторы, клавиша меню и Shift+F10 (откроют заново)
  const KEEP = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "NumLock", "ContextMenu"]);
  function onKey(e) {
    // в перехвате на окне — раньше плеера (пробел, стрелки, Esc) и страницы, но ПОСЛЕ перехватов
    // на окне, поставленных раньше (select.js, abloop.js, notes.js, speech.js, video-actions.js):
    // те сами пропускают клавиши, пока меню открыто, — __ytcsCtxMenu.isOpen()
    const items = [...menu.querySelectorAll(".it:not([aria-disabled='true'])")];
    const a = shadowActive();
    if (!menu.contains(a) && a !== menu) return void close(false); // фокус ушёл (поиск по «/» и т. п.)
    const i = items.indexOf(a);
    const eat = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const n = C.nav(e.key, i, items.length);
    if (n >= 0) {
      eat();
      items[n].focus({ preventScroll: true });
    } else if (e.key === "Escape") {
      eat();
      close(true);
    } else if (e.key === "Tab") {
      eat();
      close(true);
    } else if (a?.classList.contains("rate") && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "-" || e.key === "+" || e.key === "=")) {
      eat();
      step(e.key === "ArrowLeft" || e.key === "-" ? -1 : 1);
    } else if (e.key === "Enter" || e.key === " ") {
      eat(); // пробел не ставит видео на паузу, Enter не жмёт кнопки страницы
      if (a?.matches?.(".it:not(.rate)")) a.click();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      eat(); // не перематывать видео, пока меню открыто
    } else if (!KEEP.has(e.key) && !(e.key === "F10" && e.shiftKey)) {
      close(false); // любая другая клавиша — как в меню браузера: закрыть, клавиша сработает как обычно
    }
  }

  // ---------- правый щелчок ----------
  let kbAt = -1e9; // когда нажали клавишу меню / Shift+F10
  addEventListener(
    "keydown",
    (e) => {
      if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) kbAt = performance.now();
    },
    true
  );

  function editableOrSelected(e) {
    const t = e.composedPath()[0];
    if (t instanceof Element && t.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']")) return { editable: true, selected: false };
    const s = getSelection();
    const selected = Boolean(s && !s.isCollapsed && s.toString().trim() && t instanceof Node && s.containsNode(t, true));
    return { editable: false, selected };
  }

  addEventListener(
    "contextmenu",
    (e) => {
      if (passNext) return; // «Меню YouTube…»: этот щелчок — плееру
      // правый щелчок, клавиша меню или Shift+F10 в самом меню — ни меню браузера, ни закрытия
      if (isOpen() && inside(e)) return void e.preventDefault();
      if (!enabled || !alive()) return void close(false);
      const keyboard = e.pointerType === "" || performance.now() - kbAt < 800;
      const es = editableOrSelected(e);
      // во весь экран развёрнут сам <video> (не плеер YouTube) — меню в него не встанет: обычное
      const videoFs = document.fullscreenElement instanceof HTMLVideoElement;
      if (C.nativeWanted({ shift: e.shiftKey, keyboard, videoFs, ...es })) {
        close(false);
        // Shift + правый щелчок по плееру — меню браузера: плеер YouTube на contextmenu рисует
        // своё меню и отменяет событие (см. openNative), поэтому до него событие не пускаем;
        // отмены нет — браузер покажет своё меню
        if (e.shiftKey && !keyboard && !videoFs && !es.editable && !es.selected && (OUR_EMBED || e.composedPath().some((el) => el.id === "movie_player"))) e.stopImmediatePropagation();
        return;
      }
      const ctx = contextOf(e);
      if (!ctx) return void close(false);
      e.preventDefault();
      e.stopImmediatePropagation(); // плеер YouTube не покажет своё меню поверх нашего
      let x = e.clientX;
      let y = e.clientY;
      if (keyboard) {
        // с клавиатуры — у элемента в фокусе (у карточки — у её обложки)
        const el = ctx.kind === "player" ? ctx.player : (ctx.thumb?.isConnected && ctx.thumb) || ctx.anchor || ctx.card;
        const r = (el || document.body).getBoundingClientRect();
        x = r.left + 12;
        y = Math.min(r.bottom - 4, r.top + 48);
      }
      ctx.target = e.composedPath()[0];
      openMenu(ctx, x, y, keyboard);
    },
    true
  );

  globalThis.__ytcsCtxMenu = { close, isOpen, open: (ctx, x, y) => openMenu(ctx, x, y, false) };
})();
