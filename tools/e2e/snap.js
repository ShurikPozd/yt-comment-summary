// Переснять снимок страницы YouTube для сквозного теста (tools/e2e/fixtures/).
// Открыть в обычном Chrome www.youtube.com/watch?v=… (или главную), дождаться
// рекомендаций справа (на главной — ленты), открыть DevTools → Console, вставить
// этот файл целиком. В буфер обмена попадёт обезличенная разметка:
//   /watch   → fixtures/watch-flexy.html  (ytd-watch-flexy: плеер, название, 2 рекомендации, Shorts);
//   главная  → fixtures/home-browse.html  (ytd-browse: 3 карточки и полка Shorts).
// Обезличивание: все тексты → «Текст N» (кроме чисел и длительностей), ссылки и id видео,
// каналов, плейлистов → вымышленные, без картинок, стилей, скриптов, комментариев и
// атрибутов, кроме разметочных (id, class, href, role…). Перед коммитом всё равно
// просмотреть: git diff и поиск по своему имени/каналам.
(() => {
  const ids = new Map();
  const chans = new Map();
  const pls = new Map();
  const texts = new Map();
  const watch = location.pathname === "/watch";
  const prefix = watch ? "vid" : "hom";
  const fakeId = (id) => {
    if (!ids.has(id)) ids.set(id, (prefix + String(ids.size + 1).padStart(8, "0")).slice(0, 11));
    return ids.get(id);
  };
  const KEEP = new Set(["id", "class", "href", "role", "hidden", "type", "viewBox", "width", "height", "aria-hidden", "aria-haspopup", "tabindex", "disabled", "page-subtype", "lockup", "is-dark-theme"]);
  const mapHref = (h) => {
    try {
      const u = new URL(h, "https://www.youtube.com");
      if (u.hostname !== "www.youtube.com") return "#";
      let p = u.pathname;
      p = p.replace(/^\/shorts\/([\w-]{11})/, (_, x) => "/shorts/" + fakeId(x));
      p = p.replace(/^\/@[^/]+/, (m) => (chans.has(m) || chans.set(m, "/@channel" + (chans.size + 1)), chans.get(m)));
      p = p.replace(/^\/channel\/[\w-]+/, (m) => (chans.has(m) || chans.set(m, "/channel/UCfake" + (chans.size + 1)), chans.get(m)));
      const q = new URLSearchParams();
      if (u.searchParams.get("v")) q.set("v", fakeId(u.searchParams.get("v")));
      const l = u.searchParams.get("list");
      if (l) q.set("list", l === "WL" ? "WL" : (pls.has(l) || pls.set(l, "PLfake" + (pls.size + 1)), pls.get(l)));
      if (u.searchParams.get("index")) q.set("index", u.searchParams.get("index"));
      return p + (String(q) ? "?" + q : "");
    } catch {
      return "#";
    }
  };
  const anonText = (s) => {
    const t = s.trim();
    if (!t || /^[\d:.,\s •|/-]+$/.test(t)) return s; // длительность, числа
    if (!texts.has(t)) texts.set(t, "Текст " + (texts.size + 1));
    return texts.get(t);
  };
  function clean(node) {
    const c = node.cloneNode(true);
    c.querySelectorAll("script,style,link,iframe,template,dom-if,dom-repeat").forEach((e) => e.remove());
    const walk = (el) => {
      for (const a of [...el.attributes]) {
        const n = a.name;
        if (n === "href") el.setAttribute("href", mapHref(a.value));
        else if (n === "aria-label" || n === "title") el.setAttribute(n, "подпись");
        else if (!KEEP.has(n) && !(a.value === "" && /^[a-z-]+$/.test(n))) el.removeAttribute(n);
        else if (n === "id" && /[^\w-]/.test(a.value)) el.removeAttribute(n);
      }
      if (el.tagName === "IMG") el.removeAttribute("src");
      if (el.tagName.toLowerCase() === "svg") {
        while (el.firstChild) el.firstChild.remove();
        return;
      }
      for (const ch of [...el.childNodes]) {
        if (ch.nodeType === 3) ch.textContent = anonText(ch.textContent);
        else if (ch.nodeType === 8) ch.remove();
        else if (ch.nodeType === 1) walk(ch);
      }
    };
    walk(c);
    return c;
  }
  const rm = (root, sel) => root.querySelectorAll(sel).forEach((e) => e.remove());
  let root;
  if (watch) {
    root = document.querySelector("ytd-watch-flexy").cloneNode(true);
    rm(root, "#panels, ytd-watch-metadata #bottom-row, ytd-watch-metadata #actions, .ytp-overlays-container, .ytp-fullscreen-grid, .ytp-share-panel, .ytp-mdx-popup-dialog, .ytp-playlist-menu");
    rm(root, "#info.ytd-watch-flexy, ytd-video-primary-info-renderer, ytd-video-secondary-info-renderer, yt-related-chip-cloud-renderer, ytd-continuation-item-renderer, ytd-playlist-panel-renderer, #related-skeleton, .watch-skeleton");
    root.querySelectorAll("#secondary yt-lockup-view-model").forEach((e, i) => i >= 2 && e.remove());
    root.querySelectorAll("ytd-reel-shelf-renderer #items > *").forEach((e, i) => i >= 1 && e.remove());
    const com = root.querySelector("#comments");
    if (com) while (com.firstChild) com.firstChild.remove();
  } else {
    root = document.querySelector("ytd-browse[page-subtype=home]").cloneNode(true);
    const grid = root.querySelector("ytd-rich-grid-renderer #contents");
    let reg = 0;
    let sec = 0;
    for (const k of [...grid.children]) {
      if (k.tagName === "YTD-RICH-ITEM-RENDERER" && k.querySelector("yt-lockup-view-model") && reg < 3) {
        reg++;
        continue;
      }
      if (k.tagName === "YTD-RICH-SECTION-RENDERER" && k.querySelector("ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2") && sec < 1) {
        sec++;
        k.querySelectorAll("ytd-rich-item-renderer").forEach((e, i) => i >= 2 && e.remove());
        continue;
      }
      k.remove();
    }
    rm(root, "#header, #chips-wrapper, ytd-feed-filter-chip-bar-renderer, ytd-continuation-item-renderer, #masthead-ad, ytd-ad-slot-renderer, ytd-statement-banner-renderer, ytd-banner-promo-renderer");
  }
  let html = clean(root).outerHTML.replace(/\s+/g, " ").replace(/> </g, "><");
  // в классах бывают настоящие id видео: content-id-XXXXXXXXXXX → id из ссылки той же карточки
  html = html.replace(/content-id-([A-Za-z0-9_-]{11})/g, (m, id, off) => {
    const f = /href="\/(?:watch\?v=|shorts\/)([\w-]{11})/.exec(html.slice(off));
    return "content-id-" + (f ? f[1] : "unknown0000");
  });
  copy(html);
  console.log(`Скопировано ${html.length} символов → tools/e2e/fixtures/${watch ? "watch-flexy" : "home-browse"}.html`);
})();
