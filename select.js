// Выбор нескольких видео в ленте YouTube (главная, подписки, поиск,
// рекомендации справа, каналы, полки Shorts).
// Наведите на карточку — в углу превью кружок; нажали — карточка выбрана.
// Пока выбрано хоть что-то, клик по карточке ставит или снимает выбор,
// Shift+клик — диапазон, Esc — снять всё. Внизу полоса с действиями:
// «Сохранить в плейлисты» (окно из playlists.js) и «В очередь».
(() => {
  if (globalThis.__ytcsSelect || location.hostname !== "www.youtube.com") return;

  const CARD =
    "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2";
  // превью внутри карточки: новые и старые разметки YouTube
  const THUMB =
    "yt-thumbnail-view-model, ytd-thumbnail, [class*='ThumbnailContainer'], .shortsLockupViewModelHostThumbnailContainer, a#thumbnail, a.reel-item-endpoint";
  // плейлисты, миксы и подборки — это не одно видео
  const COLLECTION = "yt-collection-thumbnail-view-model, ytd-playlist-thumbnail, [class*='CollectionStack'], [class*='collection-stack']";
  // кнопки внутри карточки, которые должны работать и в режиме выбора
  const OWN_CONTROLS = "button, [role='button'], ytd-menu-renderer, yt-icon-button, tp-yt-paper-icon-button";
  const ID_RE = /(?:[?&]v=|\/shorts\/)([A-Za-z0-9_-]{11})/;

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };
  const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const isDark = () => document.documentElement.hasAttribute("dark");

  // ---------- карточки ----------
  // Ссылка на видео в карточке (не плейлист, не микс). null — карточка не про видео.
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

  // самая внутренняя карточка: ytd-rich-item-renderer обёрнут вокруг yt-lockup-view-model
  function cardFromPath(path) {
    for (const el of path) {
      if (el === document.body) return null;
      if (el instanceof Element && el.matches(CARD)) return el;
    }
    return null;
  }

  // Карточка под точкой экрана — сквозь играющее поверх неё превью YouTube
  function cardAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.id === "ytcs-select" || el.id === "ytcs-qmode") continue;
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

  // Название, канал, длина — из самой карточки (как в queue.js)
  function infoOf(card, id) {
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
    const channel =
      text(card.querySelector("ytd-channel-name a, #channel-name a, ytd-channel-name #text")) ||
      text(card.querySelector("[class*='ContentMetadataViewModelMetadataRow'] a, .yt-content-metadata-view-model__metadata-row a")) ||
      text(card.querySelector("[class*='ContentMetadataViewModelMetadataText'], .yt-content-metadata-view-model__metadata-text"));
    const badge = [...card.querySelectorAll("[class*='BadgeShapeText'], .yt-badge-shape__text, .badge-shape-wiz__text, ytd-thumbnail-overlay-time-status-renderer #text, badge-shape")]
      .map(text)
      .find((x) => /^\d+(:\d+)+$/.test(x));
    const len = badge ? badge.split(":").reduce((s, x) => s * 60 + Number(x), 0) : 0;
    const short = /\/shorts\//.test(a?.getAttribute("href") || "") || /SHORTS|REEL/.test(card.tagName);
    return { id, title: title.slice(0, 300), channel: channel.slice(0, 120), len, short };
  }

  // ---------- выбор ----------
  const picked = new Map(); // id → { id, title, channel, len, short } в порядке выбора
  let anchorId = null; // от чего считать диапазон при Shift+клике

  function allCards() {
    const out = [];
    for (const c of document.querySelectorAll(CARD)) {
      if (c.querySelector(CARD)) continue; // обёртка — берём внутреннюю
      const id = idOf(c);
      if (id) out.push([c, id]);
    }
    return out;
  }

  function setPicked(card, id, on) {
    if (on && !picked.has(id)) picked.set(id, infoOf(card, id));
    else if (!on) picked.delete(id);
  }

  function toggle(card, range = false) {
    const id = idOf(card);
    if (!id) return;
    if (range && anchorId && anchorId !== id) {
      const cards = allCards();
      const a = cards.findIndex(([, x]) => x === anchorId);
      const b = cards.findIndex(([c]) => c === card);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        for (const [c, x] of cards.slice(from, to + 1)) setPicked(c, x, true);
        anchorId = id;
        return refresh();
      }
    }
    setPicked(card, id, !picked.has(id));
    anchorId = id;
    refresh();
  }

  function clear() {
    picked.clear();
    anchorId = null;
    refresh();
  }

  // ---------- отметки на карточках ----------
  const PAGE_CSS = `
    .ytcs-pick-th { position: relative; }
    .ytcs-mark { position: absolute; inset: 0; z-index: 5; pointer-events: none; border-radius: inherit;
      transition: background-color .15s ease, box-shadow .15s ease; }
    .ytcs-mark i { position: absolute; left: 8px; top: 8px; width: 28px; height: 28px; border-radius: 50%;
      box-sizing: border-box; display: grid; place-items: center; color: transparent;
      background: rgba(0, 0, 0, .45); box-shadow: inset 0 0 0 2px rgba(255, 255, 255, .9), 0 1px 4px rgba(0, 0, 0, .35); }
    .ytcs-mark svg { width: 18px; height: 18px; }
    .ytcs-mark.on { background: rgba(255, 59, 92, .2); box-shadow: inset 0 0 0 3px #ff3b5c; }
    .ytcs-mark.on i { background: #ff3b5c; color: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, .35); }
    html:not([dark]) .ytcs-mark.on { background: rgba(232, 0, 45, .12); box-shadow: inset 0 0 0 3px #e8002d; }
    html:not([dark]) .ytcs-mark.on i { background: #e8002d; color: #fff; }
    /* кнопка «Пересказать» другого расширения (Яндекс) стоит в том же углу — сдвигаем её правее кружка */
    yt-thumbnail-view-model > .ya-video-summarization-preview-button, ytd-thumbnail .ya-video-summarization-preview-button { margin-left: 40px !important; }
    @media (prefers-reduced-motion: reduce) { .ytcs-mark { transition: none; } }`;
  const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;

  function ensurePageCss() {
    if (document.getElementById("ytcs-select-css")) return;
    const st = document.createElement("style");
    st.id = "ytcs-select-css";
    st.textContent = PAGE_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // Пока выбрано хоть что-то, у всех карточек виден пустой кружок —
  // понятно, что клик теперь выбирает. Выбранные — в рамке и с галочкой.
  // Карточки YouTube переиспользует под другие видео — сверяем id каждый раз.
  function syncMarks() {
    const on = picked.size > 0;
    if (on) ensurePageCss();
    const seen = new Set();
    if (on) {
      for (const [card, id] of allCards()) {
        const th = thumbOf(card);
        if (!th) continue;
        let m = th.querySelector(":scope > .ytcs-mark");
        if (!m) {
          m = document.createElement("span");
          m.className = "ytcs-mark";
          m.innerHTML = `<i>${CHECK}</i>`;
          if (getComputedStyle(th).position === "static") th.classList.add("ytcs-pick-th");
          // скругление — как у картинки превью
          const img = th.querySelector("img");
          if (img) m.style.borderRadius = getComputedStyle(img).borderRadius;
          th.appendChild(m);
        }
        m.classList.toggle("on", picked.has(id));
        seen.add(m);
      }
    }
    for (const m of document.querySelectorAll(".ytcs-mark")) if (!seen.has(m)) m.remove();
  }

  // ---------- своё окно: кружок при наведении и полоса внизу ----------
  // Кружок наведения — в своём слое поверх страницы: превью YouTube при
  // наведении начинает играть поверх карточки и закрыло бы вставленный в неё.
  // Слой ниже шапки YouTube (z 2020), меню и боковой панели — они его закрывают.
  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .hov { position: fixed; z-index: 2; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
      display: none; place-items: center; color: rgba(255, 255, 255, .0);
      background: rgba(0, 0, 0, .5); box-shadow: inset 0 0 0 2px #fff, 0 1px 6px rgba(0, 0, 0, .45);
      -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
      transition: background-color .14s ease, color .14s ease, transform .1s ease-out; }
    .hov.show { display: grid; }
    .hov:hover { background: rgba(0, 0, 0, .7); color: rgba(255, 255, 255, .9); }
    .hov:active { transform: scale(.92); }
    .hov.on { background: var(--acc); color: var(--on-acc); box-shadow: 0 1px 6px rgba(0, 0, 0, .45); }
    .hov svg { width: 20px; height: 20px; }
    .hov.q { width: auto; height: 34px; padding: 0 14px 1px 10px; gap: 6px; border-radius: 999px; color: #fff;
      font: 600 14px/1 Roboto, Arial, sans-serif; white-space: nowrap; display: none; align-items: center; }
    .hov.q.show { display: inline-flex; }
    .hov.q svg { width: 18px; height: 18px; }

    .bar { --z: 1; zoom: var(--z); position: fixed; left: 50%; bottom: calc(20px / var(--z)); z-index: 1;
      display: flex; align-items: center; gap: 8px; max-width: calc((100vw - 24px) / var(--z));
      padding: 8px; border-radius: 20px; background: var(--bg); color: var(--fg);
      font: 500 16px/1.3 Roboto, "YouTube Sans", "Segoe UI", system-ui, sans-serif;
      box-shadow: 0 12px 40px rgba(0, 0, 0, .35), 0 0 0 1px var(--line);
      transform: translate(-50%, 0); opacity: 1;
      transition: opacity .18s ease-out, transform .26s cubic-bezier(.23, 1, .32, 1); }
    .bar[hidden] { display: flex; opacity: 0; transform: translate(-50%, 16px); pointer-events: none; visibility: hidden;
      transition: opacity .14s ease-in, transform .2s ease-in, visibility 0s .2s; }
    @media (min-width: 1600px) and (min-height: 860px) { .bar { --z: 1.15; } }
    @media (min-width: 2200px) and (min-height: 1150px) { .bar { --z: 1.4; } }
    .count { padding: 0 10px 1px 12px; white-space: nowrap; font-weight: 600; font-size: 17px; }
    .count b { font-weight: 700; color: var(--acc-text); }
    button.act { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
      gap: 8px; height: 48px; padding: 0 20px 1px 16px; border-radius: 14px; white-space: nowrap;
      font: inherit; font-weight: 600; color: var(--fg); background: var(--btn);
      transition: background-color .14s ease, transform .1s ease-out; }
    button.act:hover { background: var(--btn-h); }
    button.act:active { transform: scale(.97); }
    button.act:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; }
    button.act.main { background: var(--acc); color: var(--on-acc); }
    button.act.main:hover { background: var(--acc-h); }
    button.act.x { width: 48px; padding: 0; }
    button.act svg { width: 22px; height: 22px; flex: none; }
    /* узкое окно — только значки, подсказки остаются */
    @media (max-width: 620px) {
      button.act:not(.x) { width: 48px; padding: 0; }
      button.act .lbl { display: none; }
      .count { padding: 0 6px 1px 8px; }
    }

    :host { --bg: #fff; --fg: #0f0f0f; --line: rgba(0, 0, 0, .08); --btn: rgba(0, 0, 0, .06); --btn-h: rgba(0, 0, 0, .11);
      --acc: #e8002d; --acc-h: #c80027; --on-acc: #fff; --acc-text: #d1002a; }
    :host([dark]) { --bg: #282828; --fg: #f1f1f1; --line: rgba(255, 255, 255, .1); --btn: rgba(255, 255, 255, .1); --btn-h: rgba(255, 255, 255, .18);
      --acc: #ff3b5c; --acc-h: #ff2149; --on-acc: #fff; --acc-text: #ff6b85; }
    @media (prefers-reduced-motion: reduce) { .bar, .bar[hidden], .hov { transition: none; } }`;
  const SVG = (paths) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    save: SVG('<path d="M6 4h12v16l-6-4-6 4z"/><path d="M12 8v5"/><path d="M9.5 10.5h5"/>'),
    queue: SVG('<path d="M4 6h11"/><path d="M4 12h11"/><path d="M4 18h7"/><path d="M15 15.5v5l4.5-2.5z"/>'),
    close: SVG('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
  };

  let host = null;
  let $ = null;
  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.id = "ytcs-select";
    // свой слой: ниже шапки YouTube, всплывающих меню и окон расширения
    host.style.cssText = "position:fixed;inset:auto;z-index:2019;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${UI_CSS}</style>
      <button class="hov" aria-label="Выбрать видео" title="Выбрать (Shift — диапазон)">${CHECK}</button>
      <div class="bar" role="toolbar" aria-label="Выбранные видео" hidden>
        <span class="count" aria-live="polite"></span>
        <button class="act main" data-act="save" title="Сохранить выбранные видео в плейлисты">${ICON.save}<span class="lbl">Сохранить в плейлисты</span></button>
        <button class="act" data-act="queue" title="Добавить выбранные видео в очередь">${ICON.queue}<span class="lbl">В очередь</span></button>
        <button class="act x" data-act="clear" title="Снять выбор (Esc)" aria-label="Снять выбор (Esc)">${ICON.close}</button>
      </div>`;
    $ = (s) => root.querySelector(s);
    const hov = $(".hov");
    hov.addEventListener("pointerdown", (e) => e.preventDefault()); // фокус остаётся на странице
    hov.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!hovered?.isConnected) return;
      if (qmode) qClick(hovered);
      else toggle(hovered, e.shiftKey);
    });
    $(".bar").addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "clear") clear();
      else if (act === "save") saveToPlaylists();
      else if (act === "queue") void addToQueue();
    });
    document.documentElement.appendChild(host);
  }

  function renderBar() {
    syncToggle();
    if (!picked.size && !host) return;
    ensureHost();
    host.toggleAttribute("dark", isDark());
    const bar = $(".bar");
    bar.hidden = !picked.size;
    if (picked.size) $(".count").innerHTML = `Выбрано: <b>${picked.size}</b>`;
  }

  // ---------- наведение ----------
  let hovered = null; // карточка под указателем
  let hovThumb = null;
  let pointer = { x: -1, y: -1 };

  function placeHover() {
    if (!host || !$) return;
    const hov = $(".hov");
    const r = hovThumb?.isConnected ? hovThumb.getBoundingClientRect() : null;
    const id = hovered ? idOf(hovered) : null;
    if (!r || !id || r.width < 60 || r.bottom < 0 || r.top > innerHeight) {
      hov.classList.remove("show");
      return;
    }
    const s = r.width < 200 ? 26 : 32; // мелкие превью (справа на странице видео, Shorts)
    hov.style.left = `${Math.round(r.left + 8)}px`;
    hov.style.top = `${Math.round(r.top + 8)}px`;
    // в режиме очереди — подсказка словами, что сделает клик
    hov.classList.toggle("q", qmode);
    if (qmode) {
      const inQ = queued.has(id);
      hov.style.width = hov.style.height = "";
      hov.innerHTML = inQ ? `${ICON.close}<span>Убрать из очереди</span>` : `${ICON.queue}<span>В очередь</span>`;
      hov.classList.toggle("on", false);
      hov.setAttribute("aria-label", inQ ? "Убрать из очереди" : "Добавить в очередь");
      hov.classList.add("show");
      return;
    }
    if (!hov.querySelector("svg path[d^='M5 12.5']") || hov.querySelector("span")) hov.innerHTML = CHECK;
    hov.style.width = hov.style.height = `${s}px`;
    const on = picked.has(id);
    hov.classList.toggle("on", on);
    hov.setAttribute("aria-label", on ? "Снять выбор" : "Выбрать видео");
    hov.classList.add("show");
  }

  function setHovered(card) {
    if (card === hovered) return;
    hovered = card;
    hovThumb = card ? thumbOf(card) : null;
    if (card && idOf(card)) {
      ensurePageCss();
      ensureHost();
      host.toggleAttribute("dark", isDark());
    }
    placeHover();
  }

  const inside = (r, p) => r && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
  let moveRaf = 0;
  document.addEventListener(
    "pointermove",
    (e) => {
      pointer = { x: e.clientX, y: e.clientY };
      const path = e.composedPath();
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        if (host && path.includes(host)) return; // на нашем кружке или полосе
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
      if (scrollRaf || !hovered) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        if (hovered && !inside(hovered.getBoundingClientRect(), pointer)) setHovered(null);
        else placeHover();
      });
    },
    { passive: true, capture: true }
  );

  // ---------- клики и клавиши ----------
  // окно плейлистов после закрытия ещё ~0.2 с доигрывает анимацию — оно уже не считается
  const dialogOpen = () => document.getElementById("ytcs-playlists")?.shadowRoot?.querySelector(".wrap.open") || document.getElementById("ytcs-clip");

  window.addEventListener(
    "click",
    (e) => {
      if (!(picked.size || qmode) || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || dialogOpen()) return;
      const path = e.composedPath();
      if (host && path.includes(host)) return;
      // клик по играющему превью YouTube — это карточка под ним
      const card = cardFromPath(path) || (overPreview(path) ? cardAt(e.clientX, e.clientY) : null);
      if (!card || !idOf(card)) return;
      // меню «⋮» и кнопки внутри карточки работают как обычно
      for (const el of path) {
        if (el === card) break;
        if (el instanceof Element && el.matches(OWN_CONTROLS)) return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (qmode) qClick(card);
      else toggle(card, e.shiftKey);
    },
    true
  );

  // Shift+клик по карточкам не выделяет текст страницы
  window.addEventListener(
    "mousedown",
    (e) => {
      if (picked.size && e.shiftKey && e.button === 0 && !dialogOpen() && (cardFromPath(e.composedPath()) || overPreview(e.composedPath()))) e.preventDefault();
    },
    true
  );

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !(picked.size || qmode) || dialogOpen()) return;
      const t = e.composedPath()[0];
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return;
      if (document.fullscreenElement) return; // Esc выходит из полноэкранного режима
      e.preventDefault();
      e.stopImmediatePropagation();
      if (qmode) setQMode(false);
      else clear();
    },
    true
  );

  // ---------- действия ----------
  function message(text, actions = []) {
    if (globalThis.__ytcsQueue?.toast) return globalThis.__ytcsQueue.toast(text, actions);
    console.info("[ytcs]", text);
  }

  function saveToPlaylists() {
    const videos = [...picked.values()];
    if (!videos.length) return;
    if (!alive() || !globalThis.__ytcsPlaylists?.open) return message("Обновите страницу (F5): расширение обновилось");
    void globalThis.__ytcsPlaylists.open({
      videos,
      // сохранили — выбор больше не нужен (если за это время не выбрали другое)
      onSaved: (ids) => {
        if (ids.every((id) => picked.has(id)) && picked.size === ids.length) clear();
      },
    });
  }

  async function addToQueue() {
    const items = [...picked.values()];
    if (!items.length) return;
    let r = null;
    try {
      r = alive() ? await chrome.runtime.sendMessage({ type: "queue:add", items }) : null;
    } catch (e) {
      r = null;
    }
    if (!r?.ok) return message("Не получилось добавить — обновите страницу (F5)");
    const added = Array.isArray(r.added) ? r.added : [];
    const had = items.length - added.length;
    const parts = [added.length ? `В очередь: +${added.length}` : "Все уже были в очереди"];
    if (added.length && had) parts.push(`уже были: ${had}`);
    parts.push(`всего ${r.total}`);
    message(parts.join(" · "), [
      ["Открыть очередь", () => chrome.runtime.sendMessage({ type: "lib:open", view: "queue" }).catch(() => {})],
      ...(added.length ? [["Отменить", () => chrome.runtime.sendMessage({ type: "queue:remove", ids: added }).catch(() => {})]] : []),
    ]);
    clear();
  }

  // ---------- режим очереди ----------
  // Справа колонка «Очередь», лента сужается. Клик по видео — обложка
  // улетает по дуге в колонку, видео — в очередь, карточка тускнеет.
  // Повторный клик — убрать из очереди. Выбор галочками в режиме выключен.
  let qmode = false;
  let queueList = []; // как в chrome.storage.local.queue
  let queued = new Set();
  let qhost = null;
  const flyingIds = new Set(); // обложки в полёте
  let q$ = null;
  const FEED = /^\/($|feed\/(subscriptions|trending|explore|history)|results|@|channel\/|c\/|user\/|gaming|playlist$)/;
  const isFeed = () => FEED.test(location.pathname);
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  const Q_PAGE_CSS = `
    html.ytcs-qmode { --ytcs-qw: min(clamp(320px, 27vw, 460px), 46vw); }
    @media (min-width: 2200px) { html.ytcs-qmode { --ytcs-qw: clamp(460px, 22vw, 600px); } }
    html.ytcs-qmode ytd-page-manager#page-manager { margin-right: var(--ytcs-qw) !important; }
    /* уже в очереди: превью притушено слоем (плашка на нём остаётся чёткой), текст бледнее */
    .ytcs-qbadge { position: absolute; inset: 0; z-index: 6; pointer-events: none; display: grid; place-items: center;
      border-radius: inherit; background: rgba(10, 10, 10, .58);
      -webkit-backdrop-filter: grayscale(1); backdrop-filter: grayscale(1); animation: ytcs-qin .25s ease-out; }
    .ytcs-qbadge b { display: inline-flex; align-items: center; gap: 7px; padding: 8px 16px 9px 14px; border-radius: 999px;
      background: rgba(255, 255, 255, .95); color: #0f0f0f; font: 600 15px/1 Roboto, Arial, sans-serif; white-space: nowrap;
      box-shadow: 0 4px 16px rgba(0, 0, 0, .35); }
    .ytcs-qbadge svg { width: 18px; height: 18px; stroke-width: 2.6; color: #e8002d; }
    @keyframes ytcs-qin { from { opacity: 0; } }
    html.ytcs-qmode .ytcs-queued [class*='LockupMetadataViewModelTextContainer'], html.ytcs-qmode .ytcs-queued [class*='LockupMetadata'] h3,
    html.ytcs-qmode .ytcs-queued #details, html.ytcs-qmode .ytcs-queued #meta,
    html.ytcs-qmode .ytcs-queued [class*='shortsLockupViewModelHostMetadata'] { opacity: .45; transition: opacity .25s ease; }
    html.ytcs-qmode ytd-rich-grid-renderer, html.ytcs-qmode #contents { cursor: default; }
    @media (prefers-reduced-motion: reduce) { .ytcs-qbadge { animation: none; } }`;

  const Q_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .col { --z: 1; zoom: var(--z); position: fixed; right: 0; top: var(--top, 56px); bottom: 0;
      width: calc(var(--qw, 340px) / var(--z)); height: calc((100vh - var(--top, 56px)) / var(--z));
      display: flex; flex-direction: column; gap: 16px; padding: 18px 20px 20px;
      background: var(--bg); color: var(--fg); border-left: 1px solid var(--line);
      font: 400 14px/1.35 Roboto, "YouTube Sans", "Segoe UI", system-ui, sans-serif;
      transform: translateX(0); transition: transform .3s cubic-bezier(.23, 1, .32, 1); }
    .col.off { transform: translateX(105%); }
    @media (min-width: 2200px) and (min-height: 1150px) { .col { --z: 1.3; } }
    /* заголовок с числом — по центру всей полосы от левого края до крестика */
    .head { display: grid; grid-template-columns: 1fr 44px; gap: 8px; align-items: center;
      margin: -2px -20px 0; padding: 0 20px 14px; border-bottom: 1px solid var(--line); }
    @media (max-width: 760px) { .head { margin: 0 -12px; padding: 0 12px 10px; } }
    .ttl { grid-column: 1; min-width: 0; }
    .ttl b { display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 24px; font-weight: 700; line-height: 1.2; }
    .head .x { grid-column: 2; justify-self: end; }
    .num { display: inline-grid; place-items: center; min-width: 30px; height: 30px; padding: 0 9px; border-radius: 999px;
      background: var(--acc); color: var(--on-acc); font-size: 16px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
    .num[hidden] { display: none; }
    button { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
      gap: 8px; height: 40px; padding: 0 16px 1px; border-radius: 12px; font: inherit; font-weight: 600; white-space: nowrap;
      color: var(--fg); background: var(--btn); transition: background-color .14s ease, transform .1s ease-out; }
    button:hover { background: var(--btn-h); }
    button:active { transform: scale(.97); }
    button:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; }
    button svg { width: 20px; height: 20px; flex: none; }
    .x { width: 40px; padding: 0; border-radius: 50%; }
    .list { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; margin: 0 -6px; padding: 0 6px;
      display: flex; flex-direction: column; gap: 10px; scrollbar-width: thin; }
    /* галерея: обложка во всю ширину, под ней название — читается и в узкой колонке */
    .it { position: relative; display: flex; flex-direction: column; gap: 8px; padding: 6px 6px 10px; border-radius: 14px; }
    .it:hover { background: var(--btn); }
    /* обложка — фоном, а не <img>: иначе к ней цепляются панельки чужих расширений-просмотрщиков */
    .it .th { flex: none; width: 100%; aspect-ratio: 16 / 9; border-radius: 10px; background: var(--btn) center / cover no-repeat; }
    .it .t { min-width: 0; padding: 0 4px; }
    .it b { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 16px; font-weight: 600; line-height: 1.3; }
    .it span { display: block; margin-top: 4px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--muted); font-size: 14px; }
    .it .rm { position: absolute; right: 14px; top: 14px; width: 34px; height: 34px; padding: 0; border-radius: 50%;
      background: rgba(15, 15, 15, .78); color: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, .35); opacity: 0; }
    .it .rm:hover { background: var(--acc); color: var(--on-acc); }
    .it:hover .rm, .it .rm:focus-visible { opacity: 1; }
    .it .rm svg { width: 18px; height: 18px; }
    .it.new { animation: land .45s cubic-bezier(.23, 1, .32, 1); }
    @keyframes land { from { transform: scale(.92); background: var(--acc-soft); } }
    .empty { padding: 20px 8px; color: var(--muted); text-align: center; line-height: 1.5; font-size: 14px; }
    /* пустая очередь — подсказка по центру колонки; сюда же «прилетает» первое видео */
    .hint { margin: auto 0; padding: 28px 16px; border: 2px dashed var(--line2); border-radius: 16px;
      display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; color: var(--muted); font-size: 15px; line-height: 1.45; }
    .hint svg { width: 40px; height: 40px; color: var(--acc); }
    .hint b { color: var(--fg); font-size: 17px; }
    /* узкое окно: колонка узкая — обложка над названием */
    @media (max-width: 760px) {
      .col { padding: 14px 12px 14px; gap: 12px; }
      .foot .open { padding: 0 10px; }
    }
    .foot { display: flex; gap: 8px; }
    .foot .open { flex: 1; background: var(--acc); color: var(--on-acc); }
    .foot .open:hover { background: var(--acc-h); }
    .pulse { animation: pulse .45s ease-out; }
    @keyframes pulse { 40% { transform: scale(1.35); } }

    .tog { position: fixed; right: 20px; bottom: 20px; height: 46px; padding: 0 18px 1px 14px; border-radius: 999px;
      background: var(--bg); color: var(--fg); box-shadow: 0 8px 28px rgba(0, 0, 0, .3), 0 0 0 1px var(--line);
      font: 600 15px/1 Roboto, "YouTube Sans", "Segoe UI", system-ui, sans-serif; }
    .tog:hover { background: var(--bg-h); }
    .tog[hidden] { display: none; }
    @media (min-width: 1600px) and (min-height: 860px) { .tog { zoom: 1.15; } }
    @media (min-width: 2200px) and (min-height: 1150px) { .tog { zoom: 1.4; } }
    @media (max-width: 620px) { .tog .lbl { display: none; } .tog { width: 46px; padding: 0; } }

    :host { --bg: #fff; --bg-h: #f2f2f2; --fg: #0f0f0f; --muted: #606060; --line: rgba(0, 0, 0, .1); --line2: rgba(0, 0, 0, .18);
      --btn: rgba(0, 0, 0, .05); --btn-h: rgba(0, 0, 0, .1); --acc: #e8002d; --acc-h: #c80027; --on-acc: #fff; --acc-soft: rgba(232, 0, 45, .08); }
    :host([dark]) { --bg: #181818; --bg-h: #262626; --fg: #f1f1f1; --muted: #aaa; --line: rgba(255, 255, 255, .1); --line2: rgba(255, 255, 255, .2);
      --btn: rgba(255, 255, 255, .08); --btn-h: rgba(255, 255, 255, .15); --acc: #ff3b5c; --acc-h: #ff2149; --on-acc: #fff; --acc-soft: rgba(255, 59, 92, .14); }
    @media (prefers-reduced-motion: reduce) { .col, .it.new, .pulse { transition: none; animation: none; } }`;

  const QICON = {
    queue: SVG('<path d="M4 6h11"/><path d="M4 12h11"/><path d="M4 18h7"/><path d="M15 15.5v5l4.5-2.5z"/>'),
    open: SVG('<path d="M14 5h5v5"/><path d="M19 5l-8 8"/><path d="M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/>'),
    check: SVG('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  };
  const escH = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function ensureQHost() {
    if (qhost?.isConnected) return;
    qhost = document.createElement("div");
    qhost.id = "ytcs-qmode";
    // выше ленты, но ниже шапки YouTube и всплывающих меню
    qhost.style.cssText = "position:fixed;inset:auto;z-index:2018;";
    const root = qhost.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${Q_CSS}</style>
      <button class="tog" data-q="on" hidden title="Режим очереди: нажимайте на видео — они улетают в очередь">${QICON.queue}<span class="lbl">Режим очереди</span></button>
      <aside class="col off" aria-label="Очередь" hidden>
        <div class="head">
          <div class="ttl"><b>Очередь <span class="num">0</span></b></div>
          <button class="x" data-q="off" title="Выйти из режима очереди (Esc)" aria-label="Выйти из режима очереди (Esc)">${ICON.close}</button>
        </div>
        <div class="list" role="list"></div>
        <div class="foot"><button class="open" data-q="open">${QICON.open}Открыть очередь</button></div>
      </aside>`;
    q$ = (s) => root.querySelector(s);
    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-q]");
      if (!b) return;
      const a = b.dataset.q;
      if (a === "on") setQMode(true);
      else if (a === "off") setQMode(false);
      else if (a === "open") chrome.runtime.sendMessage({ type: "lib:open", view: "queue" }).catch(() => {});
      else if (a === "rm") void queueRemove(b.dataset.id, null);
    });
    document.documentElement.appendChild(qhost);
  }

  function renderQ(newId = null) {
    if (!qhost || !q$) return;
    qhost.toggleAttribute("dark", isDark());
    const top = document.getElementById("masthead-container")?.getBoundingClientRect().bottom || 56;
    const col = q$(".col");
    col.style.setProperty("--top", `${Math.max(0, Math.round(top))}px`);
    col.style.setProperty("--qw", getComputedStyle(document.documentElement).getPropertyValue("--ytcs-qw") || "340px");
    q$(".tog").hidden = qmode || !isFeed() || picked.size > 0;
    q$(".num").textContent = String(queueList.length);
    q$(".num").hidden = !queueList.length; // пустая — без «0», об этом и так говорит подсказка
    if (!qmode) return;
    const rows = queueList.slice().reverse().slice(0, 60); // новые сверху
    q$(".list").innerHTML = rows.length
      ? rows
          .map(
            (r) => `<div class="it${r.id === newId ? " new" : ""}" role="listitem" title="${escH(r.title)}">
          <div class="th" style="background-image:url('https://i.ytimg.com/vi/${escH(r.id)}/mqdefault.jpg')"></div>
          <div class="t"><b>${escH(r.title || "Видео")}</b><span>${escH(r.channel || (r.short ? "Shorts" : ""))}</span></div>
          <button class="rm" data-q="rm" data-id="${escH(r.id)}" title="Убрать из очереди" aria-label="Убрать из очереди">${ICON.close}</button>
        </div>`
          )
          .join("")
      : `<div class="hint">${QICON.queue}<b>Очередь пуста</b>Нажмите на видео в ленте — оно прилетит сюда. Ещё раз по тому же видео — уберёт из очереди.</div>`;
    if (queueList.length > rows.length) q$(".list").insertAdjacentHTML("beforeend", `<div class="empty">и ещё ${queueList.length - rows.length} видео — в «Открыть очередь»</div>`);
  }

  function setQMode(on) {
    on = Boolean(on) && isFeed() && alive();
    if (on === qmode) return renderQ();
    qmode = on;
    if (on) {
      clear(); // выбор галочками в режиме очереди выключен
      setHovered(null);
      ensurePageCss();
      if (!document.getElementById("ytcs-qmode-css")) {
        const st = document.createElement("style");
        st.id = "ytcs-qmode-css";
        st.textContent = Q_PAGE_CSS;
        (document.head || document.documentElement).appendChild(st);
      }
    }
    document.documentElement.classList.toggle("ytcs-qmode", on);
    ensureQHost();
    const col = q$(".col");
    if (on) {
      col.hidden = false;
      void col.offsetWidth;
      col.classList.remove("off");
    } else {
      col.classList.add("off");
      setTimeout(() => !qmode && (col.hidden = true), 320);
    }
    renderQ();
    syncQueued();
    // лента перестраивается под новую ширину
    window.dispatchEvent(new Event("resize"));
  }

  // тусклые карточки — видео, которые уже в очереди
  function syncQueued() {
    const seen = new Set();
    if (qmode) {
      for (const [card, id] of allCards()) {
        const on = queued.has(id);
        card.classList.toggle("ytcs-queued", on);
        if (!on) continue;
        seen.add(card);
        const th = thumbOf(card);
        if (th && !th.querySelector(":scope > .ytcs-qbadge")) {
          if (getComputedStyle(th).position === "static") th.classList.add("ytcs-pick-th");
          const b = document.createElement("span");
          b.className = "ytcs-qbadge";
          b.innerHTML = `<b>${QICON.check}В очереди</b>`;
          const img = th.querySelector("img");
          if (img) b.style.borderRadius = getComputedStyle(img).borderRadius;
          th.appendChild(b);
        }
      }
    }
    for (const c of document.querySelectorAll(".ytcs-queued")) if (!seen.has(c)) c.classList.remove("ytcs-queued");
    for (const b of document.querySelectorAll(".ytcs-qbadge")) if (!b.closest(".ytcs-queued")) b.remove();
    // подсказка над карточкой под указателем: «В очередь» / «Убрать» / галочка — по текущему режиму
    if (hovered) placeHover();
  }

  async function loadQueue() {
    if (!alive()) return;
    try {
      const { queue } = await chrome.storage.local.get("queue");
      setQueue(queue);
    } catch (e) {
      /* расширение обновилось */
    }
  }
  function setQueue(q) {
    queueList = Array.isArray(q) ? q : [];
    queued = new Set(queueList.map((x) => x.id));
  }
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local" || !ch.queue) return;
      setQueue(ch.queue.newValue);
      for (const id of flyingIds) queued.add(id); // ещё летит — карточка уже тусклая
      if (qmode) {
        if (!flyingIds.size) renderQ(); // строка появится в колонке, когда обложка долетит
        syncQueued();
      } else if (qhost) renderQ();
    });
  } catch (e) {
    /* без хранилища режим не нужен */
  }

  // Полёт обложки по дуге: от карточки в колонку (или обратно)
  function fly(fromRect, toRect, src, back = false) {
    if (reduced() || !fromRect || !toRect || !src) return Promise.resolve();
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    const [a, b] = back ? [toRect, fromRect] : [fromRect, toRect];
    img.style.cssText = `position:fixed;left:${a.left}px;top:${a.top}px;width:${a.width}px;height:${a.height}px;object-fit:cover;` +
      "border-radius:12px;z-index:2147483000;pointer-events:none;box-shadow:0 18px 40px rgba(0,0,0,.45);transform-origin:0 0;will-change:transform";
    document.documentElement.appendChild(img);
    const s = b.width / a.width;
    const dx = b.left - a.left;
    const dy = b.top - a.top;
    // дуга: квадратичная кривая с вершиной выше обеих точек
    const lift = Math.min(260, Math.max(80, Math.hypot(dx, dy) * 0.35));
    const cx = dx * 0.5;
    const cy = Math.min(0, dy) - lift;
    const frames = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const x = 2 * (1 - t) * t * cx + t * t * dx;
      const y = 2 * (1 - t) * t * cy + t * t * dy;
      const k = 1 + (s - 1) * t;
      frames.push({ transform: `translate(${x}px, ${y}px) scale(${k})`, opacity: back ? 0.4 + 0.6 * t : 1 - 0.25 * t, offset: t });
    }
    const anim = img.animate(frames, { duration: 620, easing: "cubic-bezier(.45, 0, .25, 1)", fill: "forwards" });
    // вкладка ушла в фон посреди полёта — анимация замирает; не ждём её дольше секунды
    return Promise.race([anim.finished.catch(() => {}), new Promise((r) => setTimeout(r, 1000))]).then(() => img.remove());
  }

  const thumbSrc = (card, id) => {
    const img = thumbOf(card)?.querySelector("img");
    return img?.currentSrc || img?.src || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  };
  // куда летит обложка: на место верхней строки списка (новые — сверху) или в подсказку пустой очереди
  const dropRect = () => {
    const t = q$?.(".list .it .th") || q$?.(".list .hint") || q$?.(".list");
    if (!t) return null;
    const r = t.getBoundingClientRect();
    // зум колонки на больших экранах — getBoundingClientRect уже в пикселях экрана
    if (t.classList.contains("th")) return { left: r.left, top: r.top, width: r.width, height: r.height };
    const w = Math.min(r.width - 24, 160);
    return { left: r.left + (r.width - w) / 2, top: r.top + Math.max(0, (r.height - w * 0.5625) / 2), width: w, height: w * 0.5625 };
  };

  async function queueAdd(card, id) {
    const info = infoOf(card, id);
    const th = thumbOf(card);
    const from = th?.getBoundingClientRect();
    queued.add(id); // сразу тусклая — не ждём ответа
    syncQueued();
    flyingIds.add(id);
    const flight = fly(from, dropRect(), thumbSrc(card, id)).finally(() => flyingIds.delete(id));
    let r = null;
    try {
      r = await chrome.runtime.sendMessage({ type: "queue:add", items: [info] });
    } catch (e) {
      r = null;
    }
    await flight;
    if (!r?.ok) {
      queued.delete(id);
      syncQueued();
      return message("Не получилось добавить — обновите страницу (F5)");
    }
    if (!queueList.some((x) => x.id === id)) setQueue([...queueList, { ...info, addedAt: Date.now() }]);
    renderQ(id);
    const num = q$(".num");
    num.classList.remove("pulse");
    void num.offsetWidth;
    num.classList.add("pulse");
  }

  async function queueRemove(id, card) {
    if (!id) return;
    queued.delete(id);
    syncQueued();
    const from = card ? thumbOf(card)?.getBoundingClientRect() : null;
    const flight = card ? fly(from, dropRect(), thumbSrc(card, id), true) : Promise.resolve();
    setQueue(queueList.filter((x) => x.id !== id));
    renderQ();
    try {
      await chrome.runtime.sendMessage({ type: "queue:remove", ids: [id] });
    } catch (e) {
      message("Не получилось убрать — обновите страницу (F5)");
    }
    await flight;
  }

  function qClick(card) {
    const id = idOf(card);
    if (!id) return;
    if (queued.has(id)) void queueRemove(id, card);
    else void queueAdd(card, id);
  }

  // команда «Режим очереди» (своя клавиша — chrome://extensions/shortcuts)
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type !== "yt:queue-mode") return;
      const ok = isFeed();
      sendResponse({ ok });
      if (ok) {
        if (!qmode) void loadQueue().then(() => setQMode(true));
        else setQMode(false);
      } else message("Режим очереди — на главной, в подписках, поиске и на каналах");
    });
  } catch (e) {
    /* расширение обновилось */
  }

  // ---------- обновление ----------
  function refresh() {
    syncMarks();
    renderBar();
    placeHover();
  }
  // YouTube дорисовывает ленту при прокрутке и переходах — отметки догоняют
  setInterval(() => {
    if (picked.size || document.querySelector(".ytcs-mark")) syncMarks();
    if (host && picked.size) host.toggleAttribute("dark", isDark());
    if (qmode) syncQueued();
    syncToggle();
  }, 700);
  window.addEventListener("yt-navigate-finish", () => {
    setHovered(null);
    if (qmode && !isFeed()) setQMode(false);
    refresh();
    syncToggle();
  });

  // кнопка «Режим очереди» — только на лентах и пока не выбраны видео галочками
  function syncToggle() {
    const want = isFeed() && alive() && !qmode && !picked.size;
    if (!want && !qhost) return;
    ensureQHost();
    const tog = q$(".tog");
    if (tog.hidden === !want) return;
    qhost.toggleAttribute("dark", isDark());
    tog.hidden = !want;
  }
  void loadQueue();

  globalThis.__ytcsSelect = { clear, count: () => picked.size, queueMode: (on) => (on ? loadQueue().then(() => setQMode(true)) : setQMode(false)) };
})();
