// «Без отвлечений»: прячет то, на чём легко залипнуть на YouTube, — Shorts, рекомендации
// справа, заставки и карточки поверх видео в конце, по желанию комментарии,
// счётчики и всю главную ленту. Одна общая кнопка (settings.focusMode)
// включает выбранный набор (settings.focus*).
//
// Работает с document_start: классы на <html> ставятся по копии настроек в
// localStorage до первой отрисовки, стиль один и тот же — переключение мгновенное
// и без мелькания. Вместо рекомендаций — аккуратная карточка, вместо ленты —
// поиск и кнопки «Очередь» / «Моя библиотека» по центру. Наша панель очереди
// (#ytcs-queue) и подборка в конце видео (#ytcs-queue-offer) не прячутся.
(() => {
  if (globalThis.__ytcsFocus) return;

  // встроенный плеер — только наш, в «Моей библиотеке» (как в early.js)
  const EMBED = location.pathname.startsWith("/embed/");
  if (EMBED) {
    let ours = false;
    try {
      ours = location.ancestorOrigins?.[0] === `chrome-extension://${chrome.runtime.id}`;
    } catch (e) {
      ours = false;
    }
    if (!ours) return;
  }
  globalThis.__ytcsFocus = true;

  // [ключ настройки, класс на <html>, по умолчанию]. Значения по умолчанию —
  // то, что включится при первом нажатии «Без отвлечений»: главное, на чём
  // залипают (Shorts, рекомендации, заставки в конце). Комментарии, счётчики и
  // лента целиком — сильнее, их включают сами. Тот же список — в sidepanel/focus-settings.js.
  const PARTS = [
    ["focusShorts", "shorts", true],
    ["focusRelated", "related", true],
    ["focusEndscreen", "end", true],
    ["focusComments", "comments", false],
    ["focusCounts", "counts", false],
    ["focusHome", "home", false],
  ];
  const CACHE_KEY = "ytcs:focus";
  let prefs = { on: false };
  try {
    prefs = { ...prefs, ...JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") };
  } catch (e) {
    /* нет копии — дождёмся chrome.storage */
  }
  const active = (cls) => Boolean(prefs.on && prefs[cls]);

  // ---------- Стиль: один на всё, включается классами на <html> ----------
  // Каждая группа — отдельным правилом: если YouTube или браузер не примет
  // один селектор, перестанет работать только его группа, а не все разом.
  const SHORTS_ITEM = "ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-reel-item-renderer";
  const CSS = `
    /* Shorts: полки на главной, в поиске и под видео, плитки в подписках, вкладка в меню */
    html.ytcs-f-shorts ytd-rich-section-renderer:has(${SHORTS_ITEM}, ytd-rich-shelf-renderer[is-shorts]),
    html.ytcs-f-shorts ytd-rich-shelf-renderer:has(${SHORTS_ITEM}),
    html.ytcs-f-shorts ytd-rich-shelf-renderer[is-shorts],
    html.ytcs-f-shorts ytd-reel-shelf-renderer,
    html.ytcs-f-shorts grid-shelf-view-model:has(${SHORTS_ITEM}),
    html.ytcs-f-shorts ytd-rich-item-renderer:has(a[href^="/shorts/"]),
    html.ytcs-f-shorts ytd-grid-video-renderer:has(a#thumbnail[href^="/shorts/"]),
    html.ytcs-f-shorts ytd-video-renderer:has(a#thumbnail[href^="/shorts/"]),
    html.ytcs-f-shorts ytd-guide-entry-renderer:has(> a[title="Shorts"]),
    html.ytcs-f-shorts ytd-guide-entry-renderer:has(> a[href^="/shorts"]),
    html.ytcs-f-shorts ytd-mini-guide-entry-renderer:has(> a[title="Shorts"]),
    html.ytcs-f-shorts ytd-mini-guide-entry-renderer[aria-label="Shorts"],
    html.ytcs-f-shorts yt-tab-shape[tab-title="Shorts"] { display: none !important; }

    /* рекомендации справа (на узком окне YouTube переносит их под описание):
       прячем содержимое #related, наша карточка остаётся на его месте */
    html.ytcs-f-related ytd-watch-flexy #related > :not(#ytcs-focus-related) { display: none !important; }

    /* поверх видео: карточки и заставки в конце, «Ещё видео» в паузе встроенного
       плеера, сетка рекомендаций во весь экран и обратный отсчёт автоперехода */
    html.ytcs-f-end .ytp-ce-element,
    html.ytcs-f-end .ytp-cards-teaser,
    html.ytcs-f-end .ytp-cards-button,
    html.ytcs-f-end .html5-endscreen,
    html.ytcs-f-end .ytp-autonav-endscreen-countdown-overlay,
    html.ytcs-f-end .ytp-fullscreen-grid,
    html.ytcs-f-end .ytp-fullscreen-grid-expand-button,
    html.ytcs-f-end .ytp-pause-overlay,
    html.ytcs-f-end .ytp-pause-overlay-container { display: none !important; }

    /* комментарии под видео (и их превью на узком окне) */
    html.ytcs-f-comments ytd-watch-flexy ytd-comments#comments,
    html.ytcs-f-comments ytd-watch-metadata ytd-comments-entry-point-header-renderer,
    html.ytcs-f-comments ytd-watch-flexy #comments-entry-point-header { display: none !important; }

    /* счётчики: просмотры, лайки, подписчики, число комментариев и их лайки */
    html.ytcs-f-counts ytd-watch-info-text #view-count,
    html.ytcs-f-counts ytd-video-owner-renderer #owner-sub-count,
    html.ytcs-f-counts ytd-comments-header-renderer #count > *,
    html.ytcs-f-counts ytd-comment-engagement-bar #vote-count-middle,
    html.ytcs-f-counts ytd-comment-action-buttons-renderer #vote-count-middle,
    html.ytcs-f-counts like-button-view-model .yt-spec-button-shape-next__button-text-content,
    html.ytcs-f-counts ytd-video-view-count-renderer,
    html.ytcs-f-counts [data-ytcs-count] { display: none !important; }

    /* главная лента целиком — вместо неё наш экран с поиском */
    html.ytcs-f-home ytd-browse[page-subtype="home"] > :not(#ytcs-focus-home) { display: none !important; }

    /* наши заглушки видны только при своём режиме */
    html:not(.ytcs-f-related) #ytcs-focus-related,
    html:not(.ytcs-f-home) #ytcs-focus-home { display: none !important; }

    /* «1 482 комментария» → просто «Комментарии» (заголовок остаётся на месте) */
    html.ytcs-f-counts ytd-comments-header-renderer #count::before { content: "Комментарии"; }
    /* без числа у «Нравится» значок встаёт ровно по центру кнопки */
    html.ytcs-f-counts like-button-view-model .yt-spec-button-shape-next__icon { margin: 0 !important; }
    html.ytcs-f-counts like-button-view-model .yt-spec-button-shape-next--icon-leading { padding: 0 16px !important; }`;

  function ensureStyle() {
    if (document.getElementById("ytcs-focus-css")) return;
    const st = document.createElement("style");
    st.id = "ytcs-focus-css";
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function applyClasses() {
    const root = document.documentElement;
    root.classList.toggle("ytcs-focus", Boolean(prefs.on));
    for (const [, cls] of PARTS) root.classList.toggle(`ytcs-f-${cls}`, active(cls));
  }

  ensureStyle();
  applyClasses();

  // ---------- Общее для наших карточек ----------
  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };
  const send = (msg) => {
    if (!alive()) return Promise.resolve(null);
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch (e) {
      return Promise.resolve(null);
    }
  };
  const isDark = () => document.documentElement.hasAttribute("dark");
  const SVG = (paths, size = 20) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    // видоискатель с точкой — «Без отвлечений» (тот же знак, что в меню плеера)
    focus: '<path d="M4 8.5V6.5A2.5 2.5 0 0 1 6.5 4h2M15.5 4h2A2.5 2.5 0 0 1 20 6.5v2M20 15.5v2a2.5 2.5 0 0 1-2.5 2.5h-2M8.5 20h-2A2.5 2.5 0 0 1 4 17.5v-2"/><circle cx="12" cy="12" r="3.2"/>',
    queue: '<path d="M4 6h10"/><path d="M4 11h10"/><path d="M4 16h6"/><circle cx="17.5" cy="16.5" r="4"/><path d="M17.5 14.6v2.1l1.4.9"/>',
    library: '<rect x="3" y="8" width="14" height="12" rx="2"/><path d="M7 4.5h11a2.5 2.5 0 0 1 2.5 2.5v9"/><path d="M8.5 11.5v5l4-2.5z"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    subs: '<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M6 4h12"/><path d="M10.5 11v5l4-2.5z"/>',
  };
  let queueCount = 0;

  // кнопки «Очередь» и «Моя библиотека» — как в меню плеера и панели очереди
  async function openLibrary(view) {
    const { libraryWhere } = alive() ? await chrome.storage.local.get("libraryWhere").catch(() => ({})) : {};
    const where = libraryWhere === "panel" ? "panel" : "tab";
    void send(view ? { type: "lib:open", view, where } : { type: "lib:open", where });
  }

  // одинаковые кнопки на обеих карточках; главная (очередь) — цветом расширения
  const BTN_CSS = `
    .acts { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
    .acts button, .acts a { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 40px; padding: 0 18px;
      border: 0; border-radius: 20px; background: rgba(0,0,0,.05); color: inherit; font: 500 14px/1 Roboto, Arial, sans-serif;
      text-decoration: none; white-space: nowrap; cursor: pointer; transition: background-color .15s ease, transform .1s ease-out; }
    :host([dark]) .acts button, :host([dark]) .acts a { background: rgba(255,255,255,.1); }
    .acts button:hover, .acts a:hover { background: rgba(0,0,0,.1); }
    :host([dark]) .acts button:hover, :host([dark]) .acts a:hover { background: rgba(255,255,255,.2); }
    .acts .main, :host([dark]) .acts .main { background: #e8002d; color: #fff; }
    :host([dark]) .acts .main { background: #ff3b5c; }
    .acts .main:hover { background: #c80027; }
    :host([dark]) .acts .main:hover { background: #ff2149; }
    .acts button:active, .acts a:active { transform: scale(.97); }
    .acts svg { flex: none; }
    .acts .n { min-width: 22px; height: 22px; padding: 0 7px; margin-right: -8px; border-radius: 11px; box-sizing: border-box;
      background: rgba(255,255,255,.24); font: 600 12px/22px Roboto, Arial, sans-serif; text-align: center; }
    .acts .n:empty { display: none; }
    button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }`;

  const queueBtn = () =>
    `<button class="main" data-act="queue">${SVG(ICON.queue, 18)}<span>Очередь</span><span class="n">${queueCount || ""}</span></button>`;
  const libBtn = () => `<button data-act="library">${SVG(ICON.library, 18)}<span>Моя библиотека</span></button>`;

  function onCardClick(e) {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "queue") void openLibrary("queue");
    else if (act === "library") void openLibrary("");
  }

  function makeHost(id, css, html) {
    const host = document.createElement("div");
    host.id = id;
    host.attachShadow({ mode: "open" }).innerHTML = `<style>${BTN_CSS}${css}</style>${html}`;
    host.shadowRoot.addEventListener("click", onCardClick);
    host.toggleAttribute("dark", isDark());
    return host;
  }

  // ---------- Вместо рекомендаций справа ----------
  const RELATED_CSS = `
    :host { all: initial; display: block; margin: 0 0 16px; }
    .card { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 24px 20px; box-sizing: border-box;
      border: 1px solid rgba(0,0,0,.1); border-radius: 12px; background: #fff; color: #0f0f0f; text-align: center;
      font: 400 14px/1.45 Roboto, Arial, sans-serif; }
    :host([dark]) .card { border-color: rgba(255,255,255,.2); background: #0f0f0f; color: #f1f1f1; }
    .ic { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 50%; background: rgba(255,59,92,.12); color: #e8002d; }
    :host([dark]) .ic { color: #ff4e6a; }
    b { font: 700 18px/1.3 Roboto, Arial, sans-serif; }
    p { margin: -6px 0 4px; color: #606060; max-width: 340px; text-wrap: balance; }
    :host([dark]) p { color: #aaa; }`;
  function relatedHtml() {
    return `<div class="card" role="note" aria-label="Рекомендации скрыты">
      <span class="ic">${SVG(ICON.focus, 26)}</span>
      <b>Рекомендации скрыты</b>
      <p>Режим без отвлечений — смотрите то, за чем пришли.</p>
      <div class="acts">${queueBtn()}${libBtn()}</div>
    </div>`;
  }
  let relatedHost = null;
  function ensureRelated() {
    if (!active("related") || location.pathname !== "/watch") return;
    const place = document.querySelector("ytd-watch-flexy #related");
    if (!place) return;
    if (!relatedHost) relatedHost = makeHost("ytcs-focus-related", RELATED_CSS, relatedHtml());
    if (place.firstElementChild !== relatedHost) place.prepend(relatedHost);
  }

  // ---------- Вместо главной ленты ----------
  const HOME_CSS = `
    :host { all: initial; display: block; width: 100%; flex: 1 1 100%; }
    .wrap { display: flex; align-items: center; justify-content: center; box-sizing: border-box; min-height: calc(100vh - var(--ytcs-mast, 56px));
      padding: 32px 16px; color: #0f0f0f; font: 400 15px/1.45 Roboto, Arial, sans-serif; }
    :host([dark]) .wrap { color: #f1f1f1; }
    .in { display: flex; flex-direction: column; align-items: center; gap: 20px; width: min(640px, 100%); text-align: center; }
    .ic { display: grid; place-items: center; width: 64px; height: 64px; border-radius: 50%; background: rgba(255,59,92,.12); color: #e8002d; }
    :host([dark]) .ic { color: #ff4e6a; }
    h1 { margin: 0; font: 700 clamp(24px, 2.4vw, 32px)/1.25 Roboto, Arial, sans-serif; }
    p { margin: -10px 0 0; color: #606060; font-size: 15px; text-wrap: balance; }
    :host([dark]) p { color: #aaa; }
    form { position: relative; display: flex; width: 100%; }
    form svg { position: absolute; left: 20px; top: 50%; transform: translateY(-50%); color: #606060; pointer-events: none; }
    :host([dark]) form svg { color: #aaa; }
    input { flex: 1; min-width: 0; height: 56px; padding: 0 22px 0 54px; box-sizing: border-box; border: 1px solid rgba(0,0,0,.16);
      border-radius: 28px; background: #fff; color: inherit; font: 400 17px Roboto, Arial, sans-serif; outline: none;
      transition: border-color .15s ease, box-shadow .15s ease; }
    :host([dark]) input { border-color: rgba(255,255,255,.22); background: #121212; }
    input::placeholder { color: #8a8a8a; opacity: 1; }
    input:focus, input:focus-visible { border-color: #ff3b5c; box-shadow: 0 0 0 3px rgba(255,59,92,.22); outline: none; }
    input::-webkit-search-cancel-button { display: none; }
    .acts a { color: inherit; }
    /* большой монитор (2K и шире) — всё крупнее, в той же пропорции */
    @media (min-width: 1800px) {
      .in { gap: 26px; width: min(840px, 100%); }
      .ic { width: 84px; height: 84px; }
      .ic svg { width: 44px; height: 44px; }
      h1 { font-size: 42px; }
      p { margin-top: -12px; font-size: 18px; }
      input { height: 68px; padding-left: 64px; border-radius: 34px; font-size: 20px; }
      form svg { left: 24px; width: 26px; height: 26px; }
      .acts { gap: 12px; }
      .acts button, .acts a { height: 50px; padding: 0 24px; border-radius: 25px; font-size: 17px; gap: 10px; }
      .acts svg { width: 22px; height: 22px; }
      .acts .n { min-width: 26px; height: 26px; border-radius: 13px; font-size: 14px; line-height: 26px; margin-right: -12px; }
    }`;
  function homeHtml() {
    return `<div class="wrap"><div class="in" role="search">
      <span class="ic">${SVG(ICON.focus, 34)}</span>
      <h1>Что хотите посмотреть?</h1>
      <p>Лента скрыта — режим без отвлечений.</p>
      <form>${SVG(ICON.search, 22)}<input type="search" name="q" placeholder="Поиск на YouTube" aria-label="Поиск на YouTube" autocomplete="off" enterkeyhint="search" /></form>
      <div class="acts">${queueBtn()}${libBtn()}<a href="/feed/subscriptions" data-act="subs">${SVG(ICON.subs, 18)}<span>Подписки</span></a></div>
    </div></div>`;
  }
  let homeHost = null;
  function ensureHome() {
    if (!active("home")) return;
    const browse = document.querySelector('ytd-browse[page-subtype="home"]');
    if (!browse) return;
    if (!homeHost) {
      homeHost = makeHost("ytcs-focus-home", HOME_CSS, homeHtml());
      const root = homeHost.shadowRoot;
      root.querySelector("form").addEventListener("submit", (e) => {
        e.preventDefault();
        const q = root.querySelector("input").value.trim();
        if (q) location.assign(`/results?search_query=${encodeURIComponent(q)}`);
      });
      // «Подписки» — переходом YouTube без перезагрузки, если он есть рядом
      root.querySelector('[data-act="subs"]').addEventListener("click", (e) => {
        const a = document.querySelector('ytd-guide-entry-renderer a[href="/feed/subscriptions"], ytd-mini-guide-entry-renderer a[href="/feed/subscriptions"]');
        if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
        e.preventDefault();
        a.click();
      });
    }
    if (browse.firstElementChild !== homeHost) browse.prepend(homeHost);
    const mast = document.querySelector("#masthead-container, ytd-masthead")?.getBoundingClientRect().height;
    if (mast) homeHost.style.setProperty("--ytcs-mast", `${Math.round(mast)}px`);
    // пришли на главную — сразу в поиск (если вы ещё нигде не печатаете)
    if (location.pathname === "/" && !homeHost.dataset.focused && !document.activeElement?.closest?.("input, textarea, [contenteditable]")) {
      homeHost.dataset.focused = "1";
      setTimeout(() => homeHost?.shadowRoot.querySelector("input")?.focus({ preventScroll: true }), 50);
    }
  }

  function refreshCards() {
    const dark = isDark();
    for (const h of [relatedHost, homeHost]) {
      if (!h) continue;
      h.toggleAttribute("dark", dark);
      const n = h.shadowRoot.querySelector('[data-act="queue"] .n');
      if (n) n.textContent = queueCount ? String(queueCount) : "";
    }
  }

  // ---------- Счётчики в лентах и в развёрнутом описании ----------
  // Просмотры там — просто текст в строке «1,2 млн просмотров • 3 года назад»;
  // прячем этот кусок и соседнюю точку-разделитель, дата остаётся.
  // число (или «нет») и слово про просмотры — канал «Просмотры» не тронем
  const COUNT_RE = /^(нет\s+|\d[\d\s\u00a0.,]*(тыс\.?|млн|млрд|[KMB])?\s*)(просмотр|зрител|смотрят|views?\b|watching)/i;
  const DELIM_RE = /^[•·|]$/;
  const COUNT_SCOPES = "ytd-watch-info-text #info, yt-content-metadata-view-model, ytd-video-meta-block #metadata-line, ytd-grid-video-renderer #metadata-line";
  function markCounts() {
    const want = new Set();
    if (active("counts")) {
      for (const scope of document.querySelectorAll(COUNT_SCOPES)) {
        for (const span of scope.querySelectorAll("span")) {
          if (span.firstElementChild) continue; // берём самые вложенные куски текста
          const text = span.textContent.trim();
          if (text.length > 48 || !COUNT_RE.test(text)) continue;
          // поднимаемся до куска строки, у которого есть соседи (разделители)
          let el = span;
          while (el.parentElement && el.parentElement !== scope && el.parentElement.childElementCount === 1) el = el.parentElement;
          want.add(el);
          const delim = [el.nextElementSibling, el.previousElementSibling].find((x) => x && DELIM_RE.test(x.textContent.trim()));
          if (delim) want.add(delim);
        }
      }
    }
    // меняем только то, что поменялось: YouTube переиспользует строки для других видео
    for (const el of document.querySelectorAll("[data-ytcs-count]")) if (!want.has(el)) el.removeAttribute("data-ytcs-count");
    for (const el of want) if (!el.hasAttribute("data-ytcs-count")) el.setAttribute("data-ytcs-count", "");
  }

  // ---------- Конец видео: без автоперехода на чужую рекомендацию ----------
  // Обратный отсчёт YouTube спрятан — отменяем и сам переход, иначе через
  // несколько секунд откроется рекомендованное видео. В плейлисте — как обычно.
  function cancelAutonav() {
    if (!active("end") || location.pathname !== "/watch" || new URLSearchParams(location.search).has("list")) return;
    let n = 0;
    const timer = setInterval(() => {
      if (++n > 40) return clearInterval(timer); // отсчёт YouTube — до ~8 секунд
      document.querySelector("#movie_player .ytp-autonav-endscreen-upnext-cancel-button")?.click();
    }, 250);
  }
  document.addEventListener(
    "ended",
    (e) => {
      if (e.target instanceof HTMLVideoElement && e.target.closest("#movie_player")) cancelAutonav();
    },
    true
  );

  // ---------- Слежение за страницей ----------
  let observer = null;
  let pending = false;
  function tick() {
    pending = false;
    ensureRelated();
    ensureHome();
    markCounts();
  }
  function schedule() {
    if (pending) return;
    pending = true;
    setTimeout(tick, 250);
  }
  function watch() {
    const need = prefs.on && !EMBED;
    if (need && !observer && document.documentElement) {
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } else if (!need && observer) {
      observer.disconnect();
      observer = null;
    }
    if (need) schedule();
    else markCounts(); // снять отметки
  }
  if (!EMBED) {
    window.addEventListener("yt-navigate-finish", () => {
      if (homeHost && location.pathname === "/") delete homeHost.dataset.focused; // снова на главной — снова в поиск
      schedule();
    });
    // тема YouTube поменялась — карточки следом
    new MutationObserver(refreshCards).observe(document.documentElement, { attributes: true, attributeFilter: ["dark"] });
  }

  // ---------- Настройки ----------
  function readPrefs(settings) {
    const s = settings || {};
    prefs = { on: Boolean(s.focusMode) };
    for (const [key, cls, def] of PARTS) prefs[cls] = s[key] === undefined ? def : Boolean(s[key]);
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(prefs));
    } catch (e) {
      /* без копии — просто чуть позже при следующем открытии */
    }
    ensureStyle();
    applyClasses();
    watch();
  }
  function readQueue(q) {
    queueCount = Array.isArray(q) ? q.length : 0;
    refreshCards();
  }
  chrome.storage.local
    .get(["settings", "queue"])
    .then((o) => {
      readPrefs(o.settings);
      readQueue(o.queue);
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) readPrefs(changes.settings.newValue);
    if (changes.queue) readQueue(changes.queue.newValue);
  });
  watch();
})();
