// Очередь «посмотреть потом» на страницах YouTube.
//   - Панель очереди над рекомендациями, когда видео из очереди: где вы в ней,
//     «Назад / Досмотрел / Дальше», ближайшие видео. Клавиши: [ и ] — назад и
//     дальше, Shift+] — досмотрел (убрать и дальше).
//   - Запоминает, где вы остановились (раз в несколько секунд и при уходе).
//   - Досмотрели — видео уходит из очереди, а поверх плеера — предложение
//     открыть следующее (или сразу следующее, если так включено в библиотеке).
//   - По желанию: средний клик / Ctrl+клик по видео — в очередь, а не в новую вкладку.
// Пишет в очередь только background.js (по сообщениям), здесь — только чтение.
(() => {
  if (globalThis.__ytcsQueue) return;

  const DEFAULTS = { removeWatched: true, autoNext: false, intercept: false, offerCount: 4, offerMode: "order" };
  const ID_RE = /^[A-Za-z0-9_-]{11}$/;
  let queue = [];
  let pos = {};
  let opts = { ...DEFAULTS };
  let doneId = null; // только что досмотренное (уже убрано) — панель остаётся с «Вернуть»
  let doneRec = null;
  let doneAt = -1; // где оно стояло — «Вернуть» ставит туда же

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

  function idFromHref(href) {
    try {
      const u = new URL(href, location.href);
      if (!/(^|\.)youtube\.com$|^youtu\.be$/.test(u.hostname)) return null;
      let id = null;
      if (u.hostname === "youtu.be") id = u.pathname.slice(1, 12);
      else if (u.pathname === "/watch") id = u.searchParams.get("v");
      else id = (u.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/) || [])[1];
      return ID_RE.test(id || "") ? id : null;
    } catch (e) {
      return null;
    }
  }
  const curId = () => (location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null);
  const video = () => document.querySelector("#movie_player video") || document.querySelector("video.html5-main-video");
  const inQueue = (id) => Boolean(id) && queue.some((x) => x.id === id);

  // ---------- данные ----------
  async function load() {
    if (!alive()) return;
    const r = await chrome.storage.local.get(["queue", "queuePos", "queueOpts"]).catch(() => ({}));
    queue = Array.isArray(r.queue) ? r.queue : [];
    pos = r.queuePos || {};
    opts = { ...DEFAULTS, ...(r.queueOpts || {}) };
    schedule();
  }
  if (alive()) {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch.queue) queue = Array.isArray(ch.queue.newValue) ? ch.queue.newValue : [];
      if (ch.queuePos) pos = ch.queuePos.newValue || {};
      if (ch.queueOpts) opts = { ...DEFAULTS, ...(ch.queueOpts.newValue || {}) };
      if (ch.queue || ch.queuePos) schedule();
    });
  }

  // ---------- переходы по очереди (в этой же вкладке) ----------
  function urlFor(rec) {
    const t = pos[rec.id] || 0;
    return rec.short ? `https://www.youtube.com/shorts/${rec.id}` : `https://www.youtube.com/watch?v=${rec.id}${t > 5 ? `&t=${t}s` : ""}`;
  }
  function go(rec) {
    if (!rec) return;
    savePos(true);
    location.assign(urlFor(rec));
  }
  function neighbour(id, step) {
    const i = queue.findIndex((x) => x.id === id);
    if (i < 0) return step > 0 ? queue[0] : null;
    return queue[i + step] || null;
  }
  async function finish(id, { next = true } = {}) {
    // «Досмотрел»: убрать из очереди и (по желанию) сразу следующее
    const rec = queue.find((x) => x.id === id);
    if (!rec) return;
    const after = neighbour(id, 1) || (queue[0]?.id !== id ? queue[0] : null);
    const choice = next === "offer" ? pick(rec, queue) : null;
    doneId = id;
    doneRec = rec;
    doneAt = queue.findIndex((x) => x.id === id);
    await send({ type: "queue:remove", ids: [id], why: "done" });
    if (choice) offer(choice);
    else if (next && after) go(after);
    schedule();
  }

  // ---------- «Что посмотреть дальше» поверх плеера (в конце видео) ----------
  // Несколько видео из очереди. Сколько и какие — настраивается в «Моей
  // библиотеке»: по порядку, вперемешку, короткие, начатые или похожие.
  const words = (t) => new Set((String(t || "").toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []));
  function pick(cur, list) {
    const n = [2, 4, 6].includes(Number(opts.offerCount)) ? Number(opts.offerCount) : 4;
    const rest = list.filter((r) => r.id !== cur?.id);
    if (!rest.length) return [];
    const at = cur ? list.findIndex((r) => r.id === cur.id) : -1;
    // «по порядку»: следующие после текущего, потом — с начала очереди
    const ordered = at >= 0 ? [...list.slice(at + 1), ...list.slice(0, at)].filter((r) => r.id !== cur.id) : rest;
    const mode = opts.offerMode;
    let out = ordered;
    if (mode === "shuffle") {
      out = rest.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
    } else if (mode === "short") out = ordered.slice().sort((a, b) => (left(a) || 1e9) - (left(b) || 1e9));
    else if (mode === "started") out = ordered.slice().sort((a, b) => Number((pos[b.id] || 0) > 5) - Number((pos[a.id] || 0) > 5));
    else if (mode === "similar" && cur) {
      const w = words(cur.title);
      const score = (r) => {
        let s = r.channel && r.channel === cur.channel ? 3 : 0;
        for (const x of words(r.title)) if (w.has(x)) s += 1;
        return s;
      };
      out = ordered.map((r, i) => ({ r, s: score(r), i })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.r);
    }
    return out.slice(0, n);
  }

  let offerHost = null;
  function hideOffer() {
    offerResize?.disconnect();
    offerResize = null;
    offerHost?.remove();
    offerHost = null;
    hidePill();
    document.querySelector("#movie_player")?.classList.remove("ytcs-offering");
  }

  // «Не сейчас» — подборка прячется, а в углу плеера остаётся кнопка вернуть её.
  // Кнопка уходит, когда видео снова запустили или ушли на другое.
  let pillHost = null;
  let pillPlay = null;
  function hidePill() {
    pillHost?.remove();
    pillHost = null;
    if (pillPlay) video()?.removeEventListener("play", pillPlay);
    pillPlay = null;
  }
  function showPill() {
    const player = document.querySelector("#movie_player");
    if (!player || !offerItems?.length) return;
    hidePill();
    pillHost = document.createElement("div");
    pillHost.id = "ytcs-queue-pill";
    pillHost.attachShadow({ mode: "open" }).innerHTML = `<style>
      button { position: absolute; top: 16px; right: 16px; display: inline-flex; align-items: center; gap: 8px; height: 40px;
        padding: 0 18px 0 14px; border: 0; border-radius: 20px; background: rgba(10,10,10,.82); color: #f1f1f1;
        box-shadow: 0 2px 12px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,255,255,.16);
        -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); font: 500 14px Roboto, Arial, sans-serif;
        cursor: pointer; white-space: nowrap; animation: in .2s ease-out; transition: background-color .15s ease; }
      button:hover { background: #ff3b5c; }
      button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
      svg { flex: none; color: #ff6b85; }
      button:hover svg { color: #fff; }
      @keyframes in { from { opacity: 0; transform: translateY(-6px); } }
      @media (prefers-reduced-motion: reduce) { button { animation: none; } }
    </style><button type="button" title="Снова показать подборку из очереди">${svg("list", 18)}Что дальше из очереди</button>`;
    pillHost.shadowRoot.querySelector("button").addEventListener("click", (e) => {
      e.stopPropagation();
      drawOffer(offerItems);
    });
    player.appendChild(pillHost);
    pillPlay = () => hidePill();
    video()?.addEventListener("play", pillPlay, { once: true });
  }
  // пока видна наша подборка — своя сетка рекомендаций YouTube в конце видео не нужна
  function offerPageStyle() {
    if (document.getElementById("ytcs-offer-css")) return;
    const st = document.createElement("style");
    st.id = "ytcs-offer-css";
    st.textContent =
      "#movie_player.ytcs-offering .ytp-fullscreen-grid,#movie_player.ytcs-offering .html5-endscreen,#movie_player.ytcs-offering .ytp-autonav-endscreen-countdown-overlay{display:none!important}" +
      "#ytcs-queue-offer{position:absolute;inset:0;z-index:1000}#ytcs-queue-pill{position:absolute;inset:0 0 auto auto;z-index:1001}";
    (document.head || document.documentElement).appendChild(st);
  }
  // Раскладка под размер плеера: сколько колонок и какой ширины карточки, чтобы
  // всё влезло без обрезки. Места совсем мало — показываем меньше видео, но крупно.
  function offerLayout(pw, ph, n, withAbout = false) {
    const pad = Math.max(14, Math.round(Math.min(pw, ph) * 0.05));
    const head = pw < 520 ? 44 : 56;
    // под названием — строка «о чём» из готового пересказа (если есть): закладываем место
    const text = pw < 520 ? 44 : withAbout ? 100 : 60;
    const gap = pw < 520 ? 10 : 16;
    for (let count = n; count >= 1; count--) {
      const all = [];
      for (let cols = 1; cols <= count; cols++) {
        const rows = Math.ceil(count / cols);
        const byW = (pw - 2 * pad - gap * (cols - 1)) / cols;
        const byH = ((ph - 2 * pad - head - gap * (rows - 1)) / rows - text) * (16 / 9);
        all.push({ cols, rows, w: Math.floor(Math.min(byW, byH, 420)) });
      }
      const maxW = Math.max(...all.map((x) => x.w));
      // меньше рядов (шире по плееру), если карточки от этого почти не мельчают
      const best = all.filter((x) => x.w >= maxW * 0.78).sort((a, b) => a.rows - b.rows || b.w - a.w)[0];
      if (best.w >= Math.min(150, pw * 0.4) || count === 1) return { count, cols: best.cols, w: Math.max(90, best.w), pad, gap, small: pw < 520 };
    }
  }
  // Автовоспроизведение YouTube через пару секунд уведёт на свою рекомендацию и
  // подборка пропадёт. Пока она на экране — жмём «Отмена» у его обратного отсчёта.
  function cancelAutoplay() {
    let n = 0;
    const timer = setInterval(() => {
      if (!offerHost || ++n > 40) return clearInterval(timer);
      for (const b of document.querySelectorAll(".ytp-autonav-endscreen-upnext-cancel-button, .ytp-autonav-endscreen-cancel-button")) {
        if (b.offsetParent !== null || b.getClientRects().length) b.click();
      }
    }, 250);
  }
  let offerItems = null;
  let offerResize = null;
  let offerAbout = {};
  // «О чём» — первая фраза уже готового пересказа (окно «О чём видео» или вкладка «О видео»),
  // ничего нового не запрашиваем
  const firstSentence = (t) => {
    const s = String(t || "").replace(/\s+/g, " ").trim();
    const m = s.match(/^.{20,220}?[.!?…](?=\s|$)/);
    return m ? m[0] : s.slice(0, 200);
  };
  async function offer(items) {
    offerAbout = {};
    try {
      const keys = (items || []).map((r) => `tldr:${r.id}`);
      const got = keys.length ? await chrome.storage.local.get(keys) : {};
      for (const r of items || []) {
        const about = got[`tldr:${r.id}`]?.about;
        if (about) offerAbout[r.id] = firstSentence(about);
      }
    } catch (e) {
      /* расширение обновилось — без строк «о чём» */
    }
    drawOffer(items);
  }
  function drawOffer(items) {
    hideOffer();
    const player = document.querySelector("#movie_player");
    if (!items?.length || !player) return;
    offerItems = items;
    const pw = player.clientWidth || 640;
    const L = offerLayout(pw, player.clientHeight || 360, items.length, pw >= 520 && items.some((r) => offerAbout[r.id]));
    const cols = L.cols;
    items = items.slice(0, L.count);
    offerPageStyle();
    player.classList.add("ytcs-offering");
    offerHost = document.createElement("div");
    offerHost.id = "ytcs-queue-offer";
    offerHost.attachShadow({ mode: "open" }).innerHTML = `<style>
      .o { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; gap: ${L.gap}px;
        padding: ${L.pad}px; background: rgba(10,10,10,.86); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
        color: #f1f1f1; font: 400 14px/1.4 Roboto, Arial, sans-serif; animation: in .2s ease-out; box-sizing: border-box; }
      .o > * { width: ${Math.max(cols * L.w + (cols - 1) * L.gap, 300)}px; max-width: 100%; margin: 0 auto; box-sizing: border-box; }
      .top { display: flex; align-items: center; gap: 12px; }
      .top b { flex: 1; min-width: 0; font: 700 ${L.small ? 15 : 20}px/1.3 Roboto, Arial, sans-serif;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .x { flex: none; white-space: nowrap; height: 36px; padding: 0 16px; border: 0; border-radius: 18px; background: rgba(255,255,255,.12); color: #f1f1f1;
        font: 500 14px Roboto, Arial, sans-serif; cursor: pointer; }
      .x:hover { background: rgba(255,255,255,.2); }
      .g { display: grid; grid-template-columns: repeat(${cols}, ${L.w}px); gap: ${L.gap}px; justify-content: center; }
      .c { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 0; border: 0; background: none; color: inherit;
        text-align: left; cursor: pointer; font: inherit; }
      .th { position: relative; width: 100%; aspect-ratio: 16/9; border-radius: 10px; overflow: hidden; background: #333;
        outline: 2px solid transparent; transition: outline-color .15s ease, transform .15s ease-out; }
      .c:hover .th, .c:focus-visible .th { outline-color: #fff; transform: translateY(-2px); }
      .c:focus-visible { outline: none; }
      .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .d { position: absolute; right: 6px; bottom: 6px; padding: 1px 5px; border-radius: 4px; background: rgba(0,0,0,.8);
        font: 500 12px Roboto, Arial, sans-serif; }
      .bar { position: absolute; left: 0; bottom: 0; height: 3px; background: #ff0033; }
      .c b { display: -webkit-box; -webkit-line-clamp: ${L.small ? 1 : 2}; -webkit-box-orient: vertical; overflow: hidden; font: 500 ${L.w < 200 ? 13 : 15}px/1.35 Roboto, Arial, sans-serif; }
      .c span.s { color: #aaa; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: -4px; }
      .c span.ab { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: #d0d0d6;
        font: 400 ${L.w < 200 ? 12 : 13}px/1.4 Roboto, Arial, sans-serif; padding-left: 8px; border-left: 2px solid #ff3b5c; }
      @keyframes in { from { opacity: 0; } }
      @media (prefers-reduced-motion: reduce) { .o { animation: none; } .th { transition: none; } }
    </style>
    <div class="o" role="dialog" aria-label="Что посмотреть дальше из очереди">
      <div class="top"><b title="Что посмотреть дальше из очереди">${L.small ? "Дальше из очереди" : "Что посмотреть дальше из очереди"}</b><button class="x" data-no>Не сейчас</button></div>
      <div class="g">${items
        .map((r) => {
          const p = pos[r.id] || 0;
          const pct = r.len && p > 5 ? Math.min(100, Math.round((p / r.len) * 100)) : 0;
          const sub = [r.channel, r.len ? (p > 5 ? `осталось ${fmtDur(left(r))}` : "") : r.short ? "Shorts" : ""].filter(Boolean).join(" · ");
          return `<button class="c" data-go="${esc(r.id)}" title="${esc(r.title)}">
            <span class="th"><img alt="" src="https://i.ytimg.com/vi/${esc(r.id)}/mqdefault.jpg">${r.len ? `<span class="d">${fmtClock(r.len)}</span>` : ""}${pct ? `<span class="bar" style="width:${pct}%"></span>` : ""}</span>
            <b>${esc(r.title || "Видео")}</b>${sub ? `<span class="s">${esc(sub)}</span>` : ""}${!L.small && offerAbout[r.id] ? `<span class="ab" title="${esc(offerAbout[r.id])}">${esc(offerAbout[r.id])}</span>` : ""}
          </button>`;
        })
        .join("")}</div>
    </div>`;
    const root = offerHost.shadowRoot;
    root.addEventListener("click", (e) => {
      if (e.target.closest("[data-no]")) {
        hideOffer();
        offerPageStyle();
        return showPill();
      }
      const c = e.target.closest("[data-go]");
      const rec = c && items.find((r) => r.id === c.dataset.go);
      if (rec) go(rec);
    });
    player.appendChild(offerHost);
    root.querySelector("[data-go]")?.focus({ preventScroll: true });
    cancelAutoplay();
    // плеер поменял размер (полный экран, кинорежим) — пересобрать под новый
    let last = `${player.clientWidth}x${player.clientHeight}`;
    offerResize = new ResizeObserver(() => {
      const now = `${player.clientWidth}x${player.clientHeight}`;
      if (now !== last && offerHost) {
        last = now;
        drawOffer(offerItems);
      }
    });
    offerResize.observe(player);
  }
  async function undoFinish() {
    if (!doneRec) return;
    const v = video();
    const len = v && Number.isFinite(v.duration) ? v.duration : 0;
    const t = v && len && v.currentTime < len - 15 ? v.currentTime : 0;
    await send({ type: "queue:add", items: [{ ...doneRec, t }], at: doneAt, undo: "done" });
    doneId = null;
    doneRec = null;
  }

  // ---------- где остановились ----------
  let lastSent = { id: null, t: -1 };
  let nearEnd = null;
  function savePos(force = false) {
    const id = curId();
    const v = video();
    if (!id || !v || !inQueue(id) || !(v.currentTime > 0)) return;
    const len = Number.isFinite(v.duration) ? v.duration : 0;
    const atEnd = len && v.currentTime >= len - Math.max(15, len * 0.03);
    if (atEnd) nearEnd = id;
    const t = atEnd ? 0 : Math.floor(v.currentTime); // досмотрели — следующий раз с начала
    if (!force && lastSent.id === id && Math.abs(lastSent.t - t) < 4) return;
    lastSent = { id, t };
    void send({ type: "queue:pos", id, t, len });
  }
  setInterval(() => {
    const v = video();
    if (v && !v.paused) savePos();
  }, 5000);
  document.addEventListener("pause", () => savePos(true), true);
  window.addEventListener("pagehide", () => savePos(true));
  document.addEventListener("yt-navigate-start", () => savePos(true));

  // досмотрели до конца
  document.addEventListener(
    "ended",
    (e) => {
      if (e.target !== video()) return;
      const id = curId();
      if (!inQueue(id)) return;
      const how = opts.autoNext ? true : "offer"; // по умолчанию — только предложить следующее
      if (opts.removeWatched) void finish(id, { next: how });
      else if (how === true) go(neighbour(id, 1));
      else offer(pick(queue.find((x) => x.id === id), queue));
    },
    true
  );

  // ушли с видео, досмотрев почти до конца (титры не ждали) — тоже «досмотрено»
  let lastId = curId();
  function onUrl() {
    const id = curId();
    if (id === lastId) return;
    if (opts.removeWatched && nearEnd && nearEnd === lastId && inQueue(lastId)) void send({ type: "queue:remove", ids: [lastId], why: "done" });
    nearEnd = null;
    if (doneId && id !== doneId) {
      doneId = null;
      doneRec = null;
    }
    lastId = id;
    // другое видео — выбор начинается заново
    selMode = false;
    sel.clear();
    anchor = null;
    hideOffer();
    schedule();
  }
  window.addEventListener("yt-navigate-finish", onUrl);
  setInterval(onUrl, 1000);

  // ---------- панель над рекомендациями ----------
  const ICON = {
    prev: '<path d="M15 6l-6 6 6 6"/>',
    next: '<path d="M9 6l6 6-6 6"/>',
    check: '<path d="M5 12.25l4.5 4.5L19 7.25"/>',
    list: '<path d="M3.5 4.5h11"/><path d="M3.5 10.5h11"/><path d="M3.5 16.5h7"/><path d="M16.5 13.5l4 3-4 3z"/>',
    undo: '<path d="M9 14.5L4 9.5l5-5"/><path d="M4 9.5h11a5 5 0 0 1 0 10h-3"/>',
    x: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    pick: '<path d="M4 7.25l2 2 3.5-3.5"/><path d="M13 7.25h7"/><path d="M4 16.25l2 2 3.5-3.5"/><path d="M13 16.25h7"/>',
    // как «Наверх» / «В конец» в выборе «Моей библиотеки»
    top: '<path d="M5 4h14"/><path d="M12 20V9"/><path d="M7.5 13.5L12 9l4.5 4.5"/>',
    bottom: '<path d="M5 20h14"/><path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/>',
  };
  const svg = (k, s = 20) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const left = (rec) => Math.max(0, (rec.len || 0) - (pos[rec.id] || 0));
  const fmtClock = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(Math.floor(s % 60)).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  };
  const fmtDur = (s) => {
    if (!s) return "";
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return h ? `${h} ч ${m} мин` : `${Math.max(1, m)} мин`;
  };

  const CSS = `
    :host { all: initial; display: block; margin: 0 0 16px; }
    .box { font: 400 14px/1.4 Roboto, Arial, sans-serif; color: #0f0f0f; border: 1px solid rgba(0,0,0,.1);
      border-radius: 12px; overflow: hidden; background: #fff; container-type: inline-size; }
    :host([dark]) .box { color: #f1f1f1; border-color: rgba(255,255,255,.2); background: #0f0f0f; }
    /* шапка панели отделена линией — сразу видно, где заголовок */
    .head { display: flex; align-items: center; gap: 12px; padding: 14px 16px; margin-bottom: 12px; border-bottom: 1px solid rgba(0,0,0,.08); }
    :host([dark]) .head { border-bottom-color: rgba(255,255,255,.12); }
    .ttl { flex: 1; min-width: 0; }
    .ttl b { display: block; font: 700 20px/1.3 Roboto, Arial, sans-serif; }
    .ttl span { display: block; margin-top: 2px; color: #606060; font-size: 14px; }
    :host([dark]) .ttl span { color: #aaa; }
    .all { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border: 0; border-radius: 17px;
      background: rgba(0,0,0,.05); color: inherit; font: 500 13px Roboto, Arial, sans-serif; cursor: pointer; white-space: nowrap; }
    :host([dark]) .all { background: rgba(255,255,255,.1); }
    .all:hover { background: rgba(0,0,0,.1); }
    :host([dark]) .all:hover { background: rgba(255,255,255,.2); }
    .ctl[hidden] { display: none; }
    .ctl { display: grid; grid-template-columns: 1fr 1.3fr 1fr; gap: 8px; padding: 0 16px 12px; }
    .ctl button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 0; height: 40px; padding: 0 10px;
      border: 0; border-radius: 20px; background: rgba(0,0,0,.05); color: inherit; font: 500 14px Roboto, Arial, sans-serif;
      cursor: pointer; transition: background-color .15s ease, transform .1s ease-out; white-space: nowrap; }
    :host([dark]) .ctl button { background: rgba(255,255,255,.1); }
    .ctl button:hover:not(:disabled) { background: rgba(0,0,0,.1); }
    :host([dark]) .ctl button:hover:not(:disabled) { background: rgba(255,255,255,.2); }
    .ctl button:active:not(:disabled) { transform: scale(.97); }
    .ctl button:disabled { opacity: .4; cursor: default; }
    /* шрифт YouTube: заглавные выше середины строки — подписи опускаем на 1 px,
       тогда они по центру кнопки и вровень со стрелками (замер tools/align) */
    .ctl button > .lbl { position: relative; top: 1px; }
    /* главная кнопка — цветом расширения, как «Открыть очередь» и «Сохранить» */
    .ctl .done, :host([dark]) .ctl .done { background: #e8002d; color: #fff; font-weight: 600; }
    :host([dark]) .ctl .done { background: #ff3b5c; }
    .ctl .done:hover:not(:disabled) { background: #c80027; }
    :host([dark]) .ctl .done:hover:not(:disabled) { background: #ff2149; }
    /* узкая колонка справа: «Назад»/«Дальше» и «Вся очередь» — только значками, ничего не обрезается */
    @container (max-width: 380px) {
      .ctl { grid-template-columns: 44px 1fr 44px; }
      .ctl [data-act="prev"], .ctl [data-act="next"] { padding: 0; }
      .ctl [data-act="prev"] .lbl, .ctl [data-act="next"] .lbl, .all .lbl { display: none; }
      .all { width: 36px; height: 36px; padding: 0; justify-content: center; border-radius: 50%; }
    }
    button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
    /* галерея: текущее — крупно на всю ширину, остальные — плиткой в две колонки */
    .list { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; max-height: min(640px, 70vh); overflow: auto;
      overscroll-behavior: contain; padding: 0 8px 10px; scrollbar-width: thin; }
    .row { display: flex; flex-direction: column; gap: 7px; min-width: 0; width: 100%; padding: 6px; border: 0; border-radius: 12px;
      background: transparent; color: inherit; text-align: left; cursor: pointer; font: inherit; transition: background-color .15s ease; }
    .row:hover { background: rgba(0,0,0,.05); }
    :host([dark]) .row:hover { background: rgba(255,255,255,.1); }
    .row.hero { grid-column: 1 / -1; padding: 8px; }
    .cur-line { display: flex; align-items: center; gap: 10px; margin: 0 16px 12px; padding: 10px 12px; border-radius: 10px;
      background: rgba(255,59,92,.1); min-width: 0; }
    .cur-line span { flex: none; padding: 2px 8px; border-radius: 999px; background: #ff3b5c; color: #fff; font: 500 12px Roboto, Arial, sans-serif; }
    .cur-line b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 14px Roboto, Arial, sans-serif; }
    .th { position: relative; width: 100%; aspect-ratio: 16/9; border-radius: 10px; overflow: hidden; background: rgba(127,127,127,.2); }
    .th img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .2s ease-out; }
    .row:hover .th img { transform: scale(1.04); }
    .bar { position: absolute; left: 0; bottom: 0; height: 4px; background: #ff0033; }
    .len { position: absolute; right: 6px; bottom: 6px; padding: 1px 5px; border-radius: 4px; background: rgba(0,0,0,.8); color: #fff;
      font: 500 12px Roboto, Arial, sans-serif; }
    .now { position: absolute; left: 8px; top: 8px; padding: 3px 9px; border-radius: 999px; background: #ff3b5c; color: #fff;
      font: 500 12px Roboto, Arial, sans-serif; }
    .rt { min-width: 0; padding: 0 2px; }
    .rt b { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font: 500 14px/1.35 Roboto, Arial, sans-serif; }
    .row.hero .rt b { font-size: 16px; }
    .rt span { display: block; margin-top: 3px; color: #606060; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    @media (prefers-reduced-motion: reduce) { .th img { transition: none; } }
    :host([dark]) .rt span { color: #aaa; }
    /* шапка: «Выбрать» и «Вся очередь» рядом */
    .hbtns { display: flex; gap: 8px; flex: none; }
    .all.on, :host([dark]) .all.on { background: #ff3b5c; color: #fff; }
    /* на обложке слева сверху: крестик «Убрать из очереди» (при наведении), в режиме выбора — кружок-отметка */
    .row { user-select: none; }
    .x, .pk { position: absolute; left: 8px; top: 8px; z-index: 2; display: grid; place-items: center; box-sizing: border-box;
      width: 34px; height: 34px; border-radius: 50%; color: #fff; }
    /* крестик — как круглые кнопки «Отправить / Превью» на той же обложке */
    .x { background: rgba(0,0,0,.62); box-shadow: 0 1px 6px rgba(0,0,0,.4), inset 0 0 0 1px rgba(255,255,255,.18);
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); opacity: 0; transition: opacity .15s ease, background-color .15s ease; }
    .row:hover .x, .row:focus-visible .x { opacity: 1; }
    .x:hover { background: #e8002d; }
    .pk { display: none; border: 2px solid rgba(255,255,255,.95); background: rgba(0,0,0,.4); }
    .pk svg { opacity: 0; }
    .sel .x { display: none; }
    .sel .pk { display: grid; }
    .row.on .pk { border-color: #ff3b5c; background: #ff3b5c; }
    .row.on .pk svg { opacity: 1; }
    .row.on, :host([dark]) .row.on { background: rgba(255,59,92,.14); box-shadow: inset 0 0 0 2px #ff3b5c; }
    /* «Дальше» у первой плитки — слева снизу: левый верх занят крестиком */
    .now { top: auto; bottom: 8px; }
    /* полоса выбора под галереей — всегда на виду, галерея листается над ней:
       сверху «Выбрано: N · Все · Отмена», под ней три действия поровну на всю ширину */
    .selbar { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px 12px; border-top: 1px solid rgba(0,0,0,.08); }
    :host([dark]) .selbar { border-top-color: rgba(255,255,255,.12); }
    .sb1 { display: flex; align-items: center; gap: 8px; }
    .sb2 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .sb2 button { min-width: 0; padding: 0 8px; }
    .selbar b { flex: 1; min-width: 0; padding-left: 4px; font: 500 14px Roboto, Arial, sans-serif; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .selbar button { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 36px; padding: 0 14px;
      border: 0; border-radius: 18px; background: rgba(0,0,0,.05); color: inherit; font: 500 14px Roboto, Arial, sans-serif; cursor: pointer; white-space: nowrap; }
    :host([dark]) .selbar button { background: rgba(255,255,255,.1); }
    .selbar button:hover:not(:disabled) { background: rgba(0,0,0,.1); }
    :host([dark]) .selbar button:hover:not(:disabled) { background: rgba(255,255,255,.2); }
    .selbar .drop, :host([dark]) .selbar .drop { background: #e8002d; color: #fff; }
    :host([dark]) .selbar .drop { background: #ff3b5c; }
    .selbar .drop:hover:not(:disabled) { background: #c80027; }
    :host([dark]) .selbar .drop:hover:not(:disabled) { background: #ff2149; }
    .selbar button:disabled { opacity: .45; cursor: default; }
    /* колонка средней ширины: кнопки шапки — значками, чтобы заголовок и «N из M» не переносились */
    @container (max-width: 520px) {
      .hbtns .all .lbl { display: none; }
      .hbtns .all { width: 36px; height: 36px; padding: 0; justify-content: center; border-radius: 50%; }
    }
    /* перетаскивание: красная черта — куда встанет; тянутые плитки бледнеют */
    .list { position: relative; }
    .row, .row img { -webkit-user-drag: none; }
    .list.dragging .row, .list.dragging .row:hover { background: transparent; cursor: grabbing; }
    .list.dragging .row.on { background: rgba(255,59,92,.14); }
    .list.dragging .row:hover .th img { transform: none; }
    .list.dragging .x { opacity: 0; }
    .row.dragged { opacity: .35; }
    .mark { position: absolute; z-index: 3; border-radius: 2px; background: #ff3b5c; pointer-events: none; }
    .mark[hidden] { display: none; }
    .mark::before, .mark::after { content: ""; position: absolute; width: 10px; height: 10px; border-radius: 50%; background: #ff3b5c; }
    .mark.v { width: 4px; }
    .mark.v::before { left: -3px; top: -5px; }
    .mark.v::after { left: -3px; bottom: -5px; }
    .mark.h { height: 4px; }
    .mark.h::before { top: -3px; left: -5px; }
    .mark.h::after { top: -3px; right: -5px; }
    .note { margin: 0 16px 12px; padding: 10px 12px; border-radius: 10px; background: rgba(0,0,0,.05); display: flex; align-items: center; gap: 10px; }
    :host([dark]) .note { background: rgba(255,255,255,.08); }
    .note span { flex: 1; }
    .note button { height: 32px; padding: 0 12px; border: 0; border-radius: 16px; background: rgba(0,0,0,.08); color: inherit;
      font: 500 13px Roboto, Arial, sans-serif; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
    :host([dark]) .note button { background: rgba(255,255,255,.14); }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }`;

  let host = null;
  let renderTimer = 0;
  function schedule() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 60);
  }

  function slot() {
    // правая колонка рекомендаций; на узком окне YouTube переносит её под видео
    return document.querySelector("ytd-watch-flexy #secondary-inner") || document.querySelector("ytd-watch-flexy #secondary");
  }

  function render() {
    // пока тянут плитку, галерею не перестраиваем (место просмотра пишется раз в 5 с) — дорисуем после
    if (drag?.on) return void (drag.dirty = true);
    const id = curId();
    const show = id && (inQueue(id) || doneId === id) && queue.length + (doneId === id ? 1 : 0) > 0;
    if (!show) {
      host?.remove();
      host = null;
      return;
    }
    const place = slot();
    if (!place) return void setTimeout(schedule, 800);
    if (!host || !host.isConnected || host.parentElement !== place) {
      host?.remove();
      host = document.createElement("div");
      host.id = "ytcs-queue";
      host.attachShadow({ mode: "open" });
      host.shadowRoot.addEventListener("click", onClick);
      host.shadowRoot.addEventListener("pointerdown", onPointerDown);
      host.shadowRoot.addEventListener("dragstart", (e) => e.preventDefault());
      place.prepend(host);
    }
    host.toggleAttribute("dark", document.documentElement.hasAttribute("dark"));
    const keepScroll = host.shadowRoot.querySelector(".list")?.scrollTop || 0;
    const i = queue.findIndex((x) => x.id === id);
    const total = queue.length;
    const leftAll = queue.reduce((a, r) => a + left(r), 0);
    const prev = i > 0 ? queue[i - 1] : null;
    const next = i >= 0 ? queue[i + 1] || null : queue[0] || null;
    // галерея — что дальше: следующее крупно, остальные плиткой (текущее — строкой выше)
    const rows = (i >= 0 ? queue.slice(i + 1) : queue.filter((x) => x.id !== id)).slice(0, 40);
    shown = rows.map((r) => r.id);
    for (const x of sel) if (!shown.includes(x)) sel.delete(x); // убранное или ушедшее из галереи — уже не отмечено
    const curRec = i >= 0 ? queue[i] : null;
    const row = (r, k) => {
      const p = pos[r.id] || 0;
      const pct = r.len ? Math.min(100, Math.round((p / r.len) * 100)) : 0;
      const sub = [r.channel, r.len && p > 5 ? `осталось ${fmtDur(left(r))}` : r.short ? "Shorts" : ""].filter(Boolean).join(" · ");
      return `<button class="row${k === 0 ? " hero" : ""}${sel.has(r.id) ? " on" : ""}" data-go="${esc(r.id)}" title="${esc(r.title)}"${selMode ? ` aria-pressed="${sel.has(r.id)}"` : ""}>
        <span class="th"><span class="x" data-drop="${esc(r.id)}" title="Убрать из очереди" aria-hidden="true">${svg("x", 18)}</span><span class="pk" aria-hidden="true">${svg("check", 18)}</span><img loading="lazy" alt="" draggable="false" src="https://i.ytimg.com/vi/${esc(r.id)}/${k === 0 ? "hqdefault" : "mqdefault"}.jpg">${r.len ? `<span class="len">${fmtClock(r.len)}</span>` : ""}${pct ? `<span class="bar" style="width:${pct}%"></span>` : ""}${k === 0 ? `<span class="now">Дальше</span>` : ""}</span>
        <span class="rt"><b>${esc(r.title || "Видео")}</b><span>${esc(sub)}</span></span>
      </button>`;
    };
    const done = doneId === id && !inQueue(id);
    host.shadowRoot.innerHTML = `<style>${CSS}</style>
      <div class="box" role="region" aria-label="Очередь">
        <div class="head">
          <div class="ttl"><b>Очередь</b><span>${i >= 0 ? `${i + 1} из ${total}` : total ? `${total} видео` : "больше ничего нет"}${leftAll ? ` · осталось ≈ ${fmtDur(leftAll)}` : ""}</span></div>
          <div class="hbtns">
            <button class="all${selMode ? " on" : ""}" data-act="select" aria-pressed="${selMode}" title="Выбрать несколько видео — убрать, наверх или в конец разом (или Ctrl/Shift+клик по видео)" aria-label="Выбрать">${svg("pick", 18)}<span class="lbl">Выбрать</span></button>
            <button class="all" data-act="all" title="Вся очередь — в «Моей библиотеке»" aria-label="Вся очередь">${svg("list", 18)}<span class="lbl">Вся очередь</span></button>
          </div>
        </div>
        ${done ? `<div class="note"><span>Досмотрено — убрано из очереди</span><button data-act="undo">${svg("undo", 16)}Вернуть</button></div>` : ""}
        <div class="ctl" ${done && !total ? "hidden" : ""}>
          <button data-act="prev" ${prev ? "" : "disabled"} title="Предыдущее в очереди — клавиша [" aria-label="Назад">${svg("prev")}<span class="lbl">Назад</span></button>
          <button class="done" data-act="done" ${i >= 0 ? "" : "disabled"} title="Досмотрел: убрать из очереди и дальше — Shift+]">${svg("check")}<span class="lbl">Досмотрел</span></button>
          <button data-act="next" ${next ? "" : "disabled"} title="Следующее в очереди — клавиша ]" aria-label="Дальше"><span class="lbl">Дальше</span>${svg("next")}</button>
        </div>
        ${curRec ? `<div class="cur-line"><span>Сейчас</span><b title="${esc(curRec.title)}">${esc(curRec.title || "Видео")}</b></div>` : ""}
        <div class="list${selMode ? " sel" : ""}">${rows.map(row).join("")}</div>
        ${
          selMode
            ? `<div class="selbar">
          <div class="sb1"><b>${sel.size ? `Выбрано: ${sel.size}` : "Отметьте видео"}</b>
            <button data-act="sel-all" title="Отметить все видео ниже">Все</button>
            <button data-act="sel-off" title="Выйти из выбора — Esc">Отмена</button></div>
          <div class="sb2">
            <button data-act="sel-top" ${sel.size ? "" : "disabled"} title="Сразу после текущего видео — первое станет «Дальше»">${svg("top", 16)}Наверх</button>
            <button data-act="sel-bottom" ${sel.size ? "" : "disabled"} title="В самый конец очереди">${svg("bottom", 16)}В конец</button>
            <button class="drop" data-act="sel-drop" ${sel.size ? "" : "disabled"}>${svg("x", 16)}Убрать</button></div></div>`
            : ""
        }
      </div>`;
    const list = host.shadowRoot.querySelector(".list");
    // новое видео — галерея с начала; то же — оставляем, где листали
    if (list) list.scrollTop = host.dataset.cur !== id ? 0 : keepScroll;
    host.dataset.cur = id;
    // на обложках галереи — те же «Превью» и «О чём видео», что на карточках YouTube
    // в режиме выбора клик по обложке — отметка, кнопки «Отправить / Превью» только мешали бы
    const VA = globalThis.__ytcsVideoActions;
    if (VA && list && !selMode) {
      for (const th of list.querySelectorAll(".row .th")) {
        const rowEl = th.closest(".row");
        const r = queue.find((x) => x.id === rowEl.dataset.go);
        if (r) VA.attach(th, { videoId: r.id, title: r.title, channel: r.channel, len: r.len, card: rowEl });
      }
      list.addEventListener("scroll", () => VA.refresh(), { passive: true });
    }
  }

  function onClick(e) {
    // отпустили после перетаскивания (или отменили его Esc) — это не клик
    if (eatClick) {
      eatClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const dropEl = e.target.closest("[data-drop]");
    if (dropEl) {
      e.stopPropagation();
      return void dropIds([dropEl.dataset.drop]);
    }
    const goEl = e.target.closest("[data-go]");
    // выбор: Ctrl/⌘+клик — отметить одно, Shift+клик — от прошлой отметки до этой; в режиме выбора — просто клик
    if (goEl && (selMode || e.ctrlKey || e.metaKey || e.shiftKey)) {
      e.preventDefault();
      const gid = goEl.dataset.go;
      if (e.shiftKey && anchor && shown.includes(anchor)) {
        const [a, b] = [shown.indexOf(anchor), shown.indexOf(gid)].sort((x, y) => x - y);
        for (const x of shown.slice(a, b + 1)) sel.add(x);
      } else if (sel.has(gid)) sel.delete(gid);
      else sel.add(gid);
      anchor = gid;
      selMode = true;
      return render();
    }
    if (goEl) {
      const rec = queue.find((x) => x.id === goEl.dataset.go);
      if (rec && rec.id !== curId()) go(rec);
      return;
    }
    const act = e.target.closest("[data-act]")?.dataset.act;
    const id = curId();
    if (act === "prev") go(neighbour(id, -1));
    else if (act === "next") go(inQueue(id) ? neighbour(id, 1) : queue[0]);
    else if (act === "done") void finish(id);
    else if (act === "undo") void undoFinish();
    else if (act === "all") void send({ type: "lib:open", view: "queue" });
    else if (act === "select" || act === "sel-off") {
      selMode = act === "select" ? !selMode : false;
      sel.clear();
      anchor = null;
      render();
    } else if (act === "sel-all") {
      for (const x of shown) sel.add(x);
      render();
    } else if (act === "sel-drop") void dropIds([...sel]);
    else if (act === "sel-top" || act === "sel-bottom") void moveSel(act === "sel-top");
  }

  // ---------- убрать из очереди (крестик или выбранные) — с «Вернуть» ----------
  const sel = new Set();
  let selMode = false;
  let anchor = null;
  let shown = [];
  async function dropIds(ids) {
    const items = ids
      .map((id) => ({ at: queue.findIndex((x) => x.id === id), rec: queue.find((x) => x.id === id), t: pos[id] || 0 }))
      .filter((x) => x.rec)
      .sort((a, b) => a.at - b.at);
    if (!items.length) return;
    const r = await send({ type: "queue:remove", ids: items.map((x) => x.rec.id), why: "drop" });
    if (!r) return toast("Не получилось убрать — обновите страницу (F5)");
    for (const x of items) sel.delete(x.rec.id);
    if (!sel.size) selMode = false;
    schedule();
    toast(items.length === 1 ? `Убрано из очереди: «${items[0].rec.title || "видео"}»` : `Убрано из очереди: ${items.length} видео`, [
      ["Вернуть", () => send({ type: "queue:put", items, undo: "drop" })],
    ]);
  }

  // ---------- перестановка: перетаскивание, «Наверх» / «В конец» — с «Вернуть» ----------
  // То же, что moveBefore / undoSteps в queue-core.js (там же проверки): ids — перед
  // видео before (null — в конец), в их нынешнем порядке; остальные не двигаются.
  function moveBefore(list, ids, before = null) {
    const pick = new Set(ids);
    const moved = list.filter((x) => pick.has(x.id));
    if (!moved.length) return list.slice();
    let target = null;
    if (before != null) {
      const at = list.findIndex((x) => x.id === before);
      if (at < 0) return list.slice();
      target = list.slice(at).find((x) => !pick.has(x.id))?.id ?? null;
    }
    const rest = list.filter((x) => !pick.has(x.id));
    const i = target == null ? rest.length : rest.findIndex((x) => x.id === target);
    return [...rest.slice(0, i), ...moved, ...rest.slice(i)];
  }
  function undoSteps(list, ids) {
    const pick = new Set(ids);
    const out = [];
    list.forEach((x, i) => {
      if (pick.has(x.id)) out.push({ ids: [x.id], before: list[i + 1]?.id ?? null });
    });
    return out.reverse();
  }
  const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => x.id === b[i].id);
  // Переставить сразу на экране, записать в фоне; не вышло — вернуть как было
  async function moveTo(ids, before, note) {
    const was = queue;
    const next = moveBefore(queue, ids, before);
    if (sameOrder(next, was)) return false;
    queue = next;
    render();
    const r = await send({ type: "queue:move", ids, before });
    if (!r?.ok) {
      toast("Не получилось переставить — обновите страницу (F5)");
      void load();
      return false;
    }
    if (note) toast(note, [["Вернуть", () => send({ type: "queue:move", steps: undoSteps(was, ids) })]]);
    return true;
  }
  // «Наверх» — сразу после текущего видео (первое из выбранных станет «Дальше»),
  // «В конец» — в самый конец очереди
  async function moveSel(top) {
    const ids = shown.filter((x) => sel.has(x));
    if (!ids.length) return;
    const before = top ? shown[0] : null;
    if (sameOrder(moveBefore(queue, ids, before), queue)) return toast(top ? "Уже стоят первыми после текущего" : "Уже в конце очереди");
    const one = ids.length === 1 ? `«${queue.find((x) => x.id === ids[0])?.title || "видео"}»` : `${ids.length} видео`;
    if (!(await moveTo(ids, before, top ? `Наверх, сразу после текущего: ${one}` : `В конец очереди: ${one}`))) return;
    const list = host?.shadowRoot.querySelector(".list");
    if (list) list.scrollTop = top ? 0 : list.scrollHeight;
  }

  // Перетаскивание мышью: плитку (в режиме выбора — все отмеченные, если тянете
  // отмеченную). Начинается после сдвига на несколько px — иначе это обычный клик.
  // Куда встанет — красная черта между плитками и подпись «№ N из M» у курсора;
  // у края списка он листается сам; Esc — отменить.
  const DRAG_PX = 6;
  let drag = null;
  let eatClick = false;
  let ghost = null;
  window.addEventListener("pointerdown", () => (eatClick = false), true);

  function onPointerDown(e) {
    if (e.button !== 0 || e.pointerType === "touch" || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || drag) return;
    const rowEl = e.target.closest(".row");
    if (!rowEl || e.target.closest("[data-drop]")) return;
    drag = { id: rowEl.dataset.go, el: rowEl, pid: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, on: false };
    window.addEventListener("pointermove", onDragMove, true);
    window.addEventListener("pointerup", onDragUp, true);
    window.addEventListener("pointercancel", onDragCancel, true);
    window.addEventListener("blur", onDragCancel);
  }
  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.on) {
      if (Math.hypot(drag.x - drag.x0, drag.y - drag.y0) < DRAG_PX) return;
      if (!startDrag()) return endDrag(false);
    }
    e.preventDefault();
    update();
  }
  const onDragUp = (e) => drag && e.pointerId === drag.pid && endDrag(true, true);
  const onDragCancel = () => endDrag(false);

  function startDrag() {
    const list = host?.shadowRoot.querySelector(".list");
    if (!list || !drag.el.isConnected) return false;
    drag.ids = selMode && sel.has(drag.id) ? shown.filter((x) => sel.has(x)) : [drag.id];
    drag.list = list;
    drag.on = true;
    // с какой стороны курсора держать обложку — решаем один раз, чтобы она не перескакивала:
    // справа от колонки есть место (стенд, узкий YouTube) — справа, иначе слева
    drag.left = host.getBoundingClientRect().right + 18 + 176 > innerWidth - 8;
    try {
      drag.el.setPointerCapture(drag.pid); // отпустили за окном — всё равно узнаем
    } catch (e) {
      /* без захвата */
    }
    list.classList.add("dragging");
    for (const r of list.querySelectorAll(".row")) if (drag.ids.includes(r.dataset.go)) r.classList.add("dragged");
    // кнопки «Превью / О чём видео» на обложках не всплывают, пока тянете
    const VA = globalThis.__ytcsVideoActions;
    if (VA) for (const th of list.querySelectorAll(".row .th")) VA.detach(th);
    drag.mark = document.createElement("div");
    drag.mark.className = "mark";
    drag.mark.hidden = true;
    list.appendChild(drag.mark);
    showGhost(drag.ids);
    drag.raf = requestAnimationFrame(autoScroll);
    return true;
  }

  // Куда встанет: ближайшая плитка; левая/правая половина — перед ней или после
  // (у крупной «Дальше» — верхняя/нижняя). Далеко от списка — никуда.
  function dropAt() {
    const lr = drag.list.getBoundingClientRect();
    if (drag.x < lr.left - 80 || drag.x > lr.right + 80 || drag.y < lr.top - 120 || drag.y > lr.bottom + 120) return null;
    const x = Math.min(Math.max(drag.x, lr.left + 1), lr.right - 1);
    const y = Math.min(Math.max(drag.y, lr.top + 1), lr.bottom - 1);
    let best = null;
    [...drag.list.querySelectorAll(".row")].forEach((el, k) => {
      const r = el.getBoundingClientRect();
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const d = dx * dx + 4 * dy * dy; // в просвете между рядами — по вертикали важнее
      if (!best || d < best.d) best = { d, el, k, r };
    });
    if (!best) return null;
    const hero = best.el.classList.contains("hero");
    const after = hero ? y > best.r.top + best.r.height / 2 : x > best.r.left + best.r.width / 2;
    const k = best.k + (after ? 1 : 0);
    // перед кем встать: видео на экране или следующее за последним показанным (null — конец очереди)
    let before = shown[k];
    if (before === undefined) {
      const last = queue.findIndex((q) => q.id === shown[shown.length - 1]);
      before = last >= 0 ? (queue[last + 1]?.id ?? null) : null;
    }
    return { before, hero, after, r: best.r, lr };
  }

  function update() {
    const t = dropAt();
    drag.target = t;
    const m = drag.mark;
    if (!t) {
      m.hidden = true;
      return ghostCaption("Отпустите над списком");
    }
    const next = moveBefore(queue, drag.ids, t.before);
    if (sameOrder(next, queue)) {
      drag.target = null;
      m.hidden = true;
      return ghostCaption("На прежнем месте");
    }
    // черта — посередине просвета между плитками
    const L = drag.list;
    const ox = -t.lr.left + L.scrollLeft;
    const oy = -t.lr.top + L.scrollTop;
    m.hidden = false;
    if (t.hero) {
      m.className = "mark h";
      Object.assign(m.style, { left: `${t.r.left + ox + 8}px`, width: `${t.r.width - 16}px`, height: "", top: `${Math.max(3, (t.after ? t.r.bottom : t.r.top) + oy - 2)}px` });
    } else {
      m.className = "mark v";
      Object.assign(m.style, { left: `${(t.after ? t.r.right : t.r.left) + ox - 2}px`, top: `${t.r.top + oy + 8}px`, height: `${t.r.height - 16}px`, width: "" });
    }
    const n = next.findIndex((x) => x.id === drag.ids[0]) + 1;
    const cur = next.findIndex((x) => x.id === curId());
    const range = drag.ids.length > 1 ? `Станут № ${n}–${n + drag.ids.length - 1}` : `Станет № ${n}`;
    ghostCaption(`${range} из ${next.length}${n - 1 === cur + 1 ? " · «Дальше»" : ""}`);
  }

  // у края списка (или окна, если список не влез) — листать, пока держат
  function autoScroll() {
    if (!drag?.on) return;
    const L = drag.list;
    const lr = L.getBoundingClientRect();
    const capTop = Math.max(0, document.querySelector("#masthead-container")?.getBoundingClientRect().bottom || 0);
    const top = Math.max(lr.top, capTop);
    const bottom = Math.min(lr.bottom, innerHeight);
    const zone = Math.min(64, (bottom - top) / 4);
    const near = drag.x > lr.left - 80 && drag.x < lr.right + 80;
    let v = 0;
    if (near && drag.y < top + zone) v = -Math.min(1, (top + zone - drag.y) / zone);
    else if (near && drag.y > bottom - zone) v = Math.min(1, (drag.y - (bottom - zone)) / zone);
    if (v) {
      const step = Math.round(v * 18) || Math.sign(v);
      const was = L.scrollTop;
      L.scrollTop += step;
      if (L.scrollTop === was && ((step > 0 && lr.bottom > innerHeight) || (step < 0 && lr.top < capTop))) window.scrollBy(0, step);
      update();
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  // клик, который браузер пришлёт следом за отпусканием, — не «открыть видео»;
  // отменили раньше (Esc) — ждём, пока отпустят кнопку
  function eatNextClick(now) {
    if (!now) return void window.addEventListener("pointerup", () => eatNextClick(true), { capture: true, once: true });
    eatClick = true;
    setTimeout(() => (eatClick = false), 0);
  }
  function endDrag(commit, released = false) {
    window.removeEventListener("pointermove", onDragMove, true);
    window.removeEventListener("pointerup", onDragUp, true);
    window.removeEventListener("pointercancel", onDragCancel, true);
    window.removeEventListener("blur", onDragCancel);
    const d = drag;
    drag = null;
    if (!d?.on) return;
    cancelAnimationFrame(d.raf);
    eatNextClick(released);
    try {
      d.el.releasePointerCapture(d.pid);
    } catch (e) {
      /* уже отпущен */
    }
    ghost?.remove();
    ghost = null;
    if (commit && d.target) void moveTo(d.ids, d.target.before);
    else render(); // отмена — всё как было (и то, что пришло, пока тянули)
  }

  // Esc — отменить перетаскивание (раньше, чем Esc снимет выбор)
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !drag?.on) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      endDrag(false);
    },
    true
  );

  // Под курсором — обложка того, что тянут (у группы — стопкой и с числом) и куда встанет
  function showGhost(ids) {
    ghost = document.createElement("div");
    ghost.id = "ytcs-queue-drag";
    const dark = document.documentElement.hasAttribute("dark");
    ghost.attachShadow({ mode: "open" }).innerHTML = `<style>
      :host { all: initial; position: fixed; left: 0; top: 0; z-index: 2147483000; pointer-events: none; }
      .g { position: absolute; left: 0; top: 0; display: flex; flex-direction: column; align-items: center; gap: 10px; width: 176px; }
      .th { position: relative; width: 160px; aspect-ratio: 16/9; }
      .th img, .th i { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border-radius: 10px; }
      .th img { background: #3a3a3a; box-shadow: 0 10px 28px rgba(0,0,0,.45), 0 0 0 2px #ff3b5c; }
      .th i { transform: translate(6px, 6px); background: ${dark ? "#3f3f3f" : "#d9d9d9"}; box-shadow: 0 6px 18px rgba(0,0,0,.3); }
      .n { position: absolute; right: -9px; top: -9px; min-width: 28px; height: 28px; padding: 0 8px; box-sizing: border-box; display: grid; place-items: center;
        border-radius: 14px; background: #ff3b5c; color: #fff; font: 600 14px/1 Roboto, Arial, sans-serif; box-shadow: 0 0 0 2px ${dark ? "#0f0f0f" : "#fff"}; }
      .cap { max-width: 260px; padding: 6px 12px; border-radius: 999px; background: ${dark ? "#f1f1f1" : "#0f0f0f"}; color: ${dark ? "#0f0f0f" : "#fff"};
        font: 500 13px/1.3 Roboto, Arial, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 4px 14px rgba(0,0,0,.3); }
    </style><div class="g"><div class="th">${ids.length > 1 ? "<i></i>" : ""}<img alt="" src="https://i.ytimg.com/vi/${esc(ids[0])}/mqdefault.jpg">${
      ids.length > 1 ? `<span class="n">${ids.length}</span>` : ""
    }</div><div class="cap"></div></div>`;
    document.documentElement.appendChild(ghost);
  }
  function ghostCaption(t) {
    if (!ghost || !drag) return;
    const g = ghost.shadowRoot.querySelector(".g");
    g.querySelector(".cap").textContent = t;
    const w = 176;
    const x = drag.left ? Math.max(8, drag.x - 18 - w) : drag.x + 18;
    const y = Math.min(drag.y + 14, innerHeight - 140);
    g.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // Esc — выйти из выбора
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !selMode || !host?.isConnected) return;
    selMode = false;
    sel.clear();
    anchor = null;
    render();
  });

  // клавиши [ ] и Shift+] — на видео из очереди, когда вы не печатаете
  window.addEventListener(
    "keydown",
    (e) => {
      // работают, как только видео из очереди — не ждём, пока панель дорисуется
      if (e.ctrlKey || e.altKey || e.metaKey || !(inQueue(curId()) || host?.isConnected)) return;
      // настоящая цель нажатия — даже внутри shadow DOM (окна плейлистов и клипа);
      // на русской раскладке [ и ] — это «х» и «ъ», их печатают
      const t = e.composedPath()[0];
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return;
      if (document.getElementById("ytcs-playlists") || document.getElementById("ytcs-clip")) return;
      const id = curId();
      if (e.code === "BracketRight") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.shiftKey) void finish(id);
        else go(inQueue(id) ? neighbour(id, 1) : queue[0]);
      } else if (e.code === "BracketLeft" && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        go(neighbour(id, -1));
      }
    },
    true
  );

  // ---------- «в очередь» вместо новой вкладки (по желанию) ----------
  const CARD =
    "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2";
  const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  function cardInfo(a, id) {
    const card = a.closest(CARD) || a.parentElement;
    const title =
      a.getAttribute("title") ||
      text(card?.querySelector("#video-title, .yt-lockup-metadata-view-model__title, h3 a, h3, .shortsLockupViewModelHostMetadataTitle")) ||
      a.getAttribute("aria-label") ||
      "";
    const channel = text(card?.querySelector("ytd-channel-name a, #channel-name a, .yt-content-metadata-view-model__metadata-row a, .yt-content-metadata-view-model__metadata-text"));
    const badge = [...(card?.querySelectorAll(".yt-badge-shape__text, .badge-shape-wiz__text, ytd-thumbnail-overlay-time-status-renderer #text, badge-shape") || [])]
      .map(text)
      .find((x) => /^\d+(:\d+)+$/.test(x));
    const len = badge ? badge.split(":").reduce((s, x) => s * 60 + Number(x), 0) : 0;
    let t = 0;
    try {
      t = parseInt(new URL(a.href).searchParams.get("t") || "0", 10) || 0;
    } catch (e) {
      /* без t */
    }
    return { id, title: title.slice(0, 300), channel, len, short: /\/shorts\//.test(a.href), t };
  }
  function linkFrom(e) {
    for (const el of e.composedPath()) {
      if (el === host) return null; // ссылки нашей панели
      if (el instanceof HTMLAnchorElement && el.href) return el;
    }
    return null;
  }
  async function intercept(e) {
    if (!opts.intercept || !alive()) return;
    const isNewTab = (e.type === "auxclick" && e.button === 1) || (e.type === "click" && e.button === 0 && (e.ctrlKey || e.metaKey) && !e.shiftKey);
    if (!isNewTab) return;
    const a = linkFrom(e);
    const id = a && idFromHref(a.href);
    if (!id) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const info = cardInfo(a, id);
    const r = await send({ type: "queue:add", items: [info] });
    if (!r?.ok) return toast("Не получилось добавить — обновите страницу (F5)");
    const fresh = r.added?.includes(id);
    toast(`${fresh ? "В очереди" : "Уже в очереди"}: «${info.title || "видео"}» · всего ${r.total}`, [
      ["Открыть сейчас", () => window.open(a.href, "_blank", "noopener")],
      ...(fresh ? [["Отменить", () => send({ type: "queue:remove", ids: [id] })]] : []),
    ]);
  }
  window.addEventListener("auxclick", intercept, true);
  window.addEventListener("click", intercept, true);
  // средний клик по ссылке иногда включает автопрокрутку — гасим её на видео-ссылках
  window.addEventListener(
    "mousedown",
    (e) => {
      if (!opts.intercept || e.button !== 1) return;
      // только над ссылкой на видео: пустой адрес new URL() дополнит текущей страницей,
      // и на /watch и /shorts автопрокрутка колёсиком гасла бы везде
      const a = linkFrom(e);
      if (a && idFromHref(a.href)) e.preventDefault();
    },
    true
  );

  // ---------- сообщение внизу страницы ----------
  let toastHost = null;
  let toastTimer = 0;
  function toast(msg, actions = []) {
    if (!toastHost) {
      toastHost = document.createElement("div");
      toastHost.attachShadow({ mode: "open" });
    }
    // во весь экран видно только то, что внутри развёрнутого элемента (у самого <video> детей не рисуется)
    const fs = document.fullscreenElement;
    const parent = fs && !(fs instanceof HTMLVideoElement) ? fs : document.documentElement;
    if (toastHost.parentNode !== parent) parent.appendChild(toastHost);
    const root = toastHost.shadowRoot;
    root.innerHTML = `<style>
      .t { position: fixed; left: 24px; bottom: 24px; z-index: 2147483001; display: flex; align-items: center; gap: 14px;
        max-width: min(560px, calc(100vw - 48px)); padding: 12px 12px 12px 18px; border-radius: 12px; background: #212121; color: #f1f1f1;
        font: 400 14px/1.4 Roboto, Arial, sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.35); animation: in .18s ease-out; }
      .t span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .t button { flex: none; height: 34px; padding: 0 14px; border: 0; border-radius: 17px; background: rgba(255,255,255,.12);
        color: #ff6b85; font: 500 14px Roboto, Arial, sans-serif; cursor: pointer; }
      .t button:hover { background: rgba(255,255,255,.2); }
      @keyframes in { from { opacity: 0; transform: translateY(8px); } }
      @media (prefers-reduced-motion: reduce) { .t { animation: none; } }
    </style><div class="t" role="status"><span></span></div>`;
    const box = root.querySelector(".t");
    box.querySelector("span").textContent = msg;
    for (const [label, fn] of actions) {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => {
        fn();
        root.innerHTML = "";
      });
      box.appendChild(b);
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (root.innerHTML = ""), actions.length ? 6000 : 3000);
  }

  // ---------- «Отложить» (меню плеера, правый клик, клавиша) ----------
  async function defer() {
    const id = curId() || (location.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/) || [])[1];
    if (!id) return false;
    const v = video();
    const title =
      text(document.querySelector("ytd-watch-metadata h1 yt-formatted-string, h1.ytd-watch-metadata")) || document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, "");
    const channel = text(document.querySelector("ytd-watch-metadata #channel-name a, #owner #channel-name a"));
    v?.pause();
    const r = await send({
      type: "queue:defer",
      item: { id, title, channel, len: v && Number.isFinite(v.duration) ? v.duration : 0, short: location.pathname.startsWith("/shorts/"), t: v?.currentTime || 0 },
    });
    if (!r?.ok) toast("Не получилось отложить — обновите страницу (F5)");
    return Boolean(r?.ok);
  }

  // ---------- своё меню правого щелчка (ctxmenu.js): в очередь, наверх, убрать ----------
  // Те же сообщения фону, что у кнопок выбора и «Режима очереди»; итог — плашкой с «Отменить».
  const index = (id) => queue.findIndex((x) => x.id === id);
  async function add(info) {
    const id = info?.id;
    if (!ID_RE.test(id || "")) return false;
    const r = await send({ type: "queue:add", items: [info] });
    if (!r?.ok) return toast("Не получилось добавить — обновите страницу (F5)"), false;
    const fresh = r.added?.includes(id);
    toast(`${fresh ? "В очереди" : "Уже в очереди"}: «${info.title || "видео"}» · всего ${r.total}`, fresh ? [["Отменить", () => send({ type: "queue:remove", ids: [id] })]] : []);
    return true;
  }
  // «Наверх очереди» — перед первым видео; «Убрать» — как крестик в колонке (с «Вернуть»)
  const toTop = (id) => index(id) > 0 && moveTo([id], queue[0].id, `Наверху очереди: «${queue[index(id)].title || "видео"}»`);
  const drop = (id) => dropIds([id]);

  globalThis.__ytcsQueue = { defer, toast, index, add, top: toTop, remove: drop };
  void load();
})();
