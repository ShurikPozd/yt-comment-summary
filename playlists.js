// Окно «Сохранить в плейлисты»: поиск по плейлистам, галочки на несколько
// сразу, новый плейлист из строки поиска. Запросы к YouTube — в
// playlists-main.js (мир страницы), здесь — окно, порядок «недавние сверху»
// и обложки (chrome.storage.local).
(() => {
  if (globalThis.__ytcsPlaylists) return;

  const RECENT_KEY = "plRecent"; // id плейлистов, куда сохраняли последними
  const LIB_KEY = "plLibrary"; // обложки и «обновлено…» со страницы библиотеки
  const LIB_TTL = 6 * 3600 * 1000;
  const ERRORS = {
    loggedout: "Войдите в аккаунт YouTube, чтобы сохранять в плейлисты",
    noconfig: "Обновите страницу (F5) и попробуйте ещё раз",
    denied: "YouTube не принял запрос — обновите страницу (F5) и попробуйте ещё раз",
    noreply: "Обновите страницу видео (F5): расширение обновилось",
    fail: "YouTube не ответил — попробуйте ещё раз",
  };
  const PRIVACY = { PRIVATE: "Приватный", UNLISTED: "Доступ по ссылке", PUBLIC: "Открытый" };

  const SVG = (paths) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    close: SVG('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
    search: SVG('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
    plus: SVG('<path d="M12 5v14"/><path d="M5 12h14"/>'),
    check: SVG('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    lock: SVG('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    link: SVG('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>'),
    globe: SVG('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>'),
    list: SVG('<path d="M4 6h11"/><path d="M4 12h11"/><path d="M4 18h7"/><path d="M17 15v6"/><path d="M14 18h6"/>'),
  };
  const privIcon = (p) => (p === "PUBLIC" ? ICON.globe : p === "UNLISTED" ? ICON.link : ICON.lock);

  // ---------- связь с playlists-main.js ----------
  const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const waiting = new Map();
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || typeof e.data.__ytcsPl !== "string") return;
    const w = waiting.get(e.data.__ytcsPl);
    if (!w) return;
    waiting.delete(e.data.__ytcsPl);
    clearTimeout(w.timer);
    e.data.ok ? w.resolve(e.data.data) : w.reject(Object.assign(new Error(e.data.message || e.data.error), { code: e.data.error }));
  });
  function call(op, args = {}, timeout = 20000) {
    const id = newId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(Object.assign(new Error("noreply"), { code: "noreply" }));
      }, timeout);
      waiting.set(id, { resolve, reject, timer });
      document.dispatchEvent(new CustomEvent("ytcs-pl:2", { detail: JSON.stringify({ op, id, ...args }) })); // имя — как в playlists-main.js
    });
  }

  // ---------- хранилище ----------
  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };
  async function load(key) {
    if (!alive()) return undefined;
    try {
      return (await chrome.storage.local.get(key))[key];
    } catch (e) {
      return undefined;
    }
  }
  function save(key, value) {
    if (!alive()) return;
    try {
      chrome.storage.local.set({ [key]: value }).catch(() => {});
    } catch (e) {
      /* не страшно */
    }
  }

  // ---------- поиск ----------
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  // подсветка найденных слов в названии
  function mark(title, words) {
    if (!words.length) return esc(title);
    const lower = String(title).toLowerCase().replace(/ё/g, "е");
    const hits = [];
    for (const w of words) {
      let i = lower.indexOf(w);
      while (i >= 0) {
        hits.push([i, i + w.length]);
        i = lower.indexOf(w, i + w.length);
      }
    }
    if (!hits.length) return esc(title);
    hits.sort((a, b) => a[0] - b[0]);
    let out = "";
    let pos = 0;
    for (const [a, b] of hits) {
      if (a < pos) continue;
      out += esc(title.slice(pos, a)) + `<mark>${esc(title.slice(a, b))}</mark>`;
      pos = b;
    }
    return out + esc(title.slice(pos));
  }

  // ---------- окно ----------
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 16px;
      font: 500 14px/1.35 Roboto, "YouTube Sans", "Segoe UI", system-ui, sans-serif; color: #f1f1f1; }
    .bg { position: absolute; inset: 0; background: rgba(8, 8, 10, .55);
      -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); opacity: 0; transition: opacity .2s ease-out; }
    .dlg { --z: 1; zoom: var(--z); position: relative; display: flex; flex-direction: column; gap: 14px;
      width: min(480px, calc((100vw - 32px) / var(--z))); max-height: calc((100vh - 32px) / var(--z));
      padding: 20px; border-radius: 18px; background: rgba(28, 28, 30, .95);
      -webkit-backdrop-filter: blur(24px) saturate(1.6); backdrop-filter: blur(24px) saturate(1.6);
      box-shadow: 0 24px 70px rgba(0, 0, 0, .55), inset 0 0 0 1px rgba(255, 255, 255, .07);
      opacity: 0; transform: translateY(8px) scale(.97);
      transition: opacity .18s ease-out, transform .26s cubic-bezier(.23, 1, .32, 1); }
    @media (min-width: 1600px) and (min-height: 860px) { .dlg { --z: 1.2; } }
    @media (min-width: 2200px) and (min-height: 1150px) { .dlg { --z: 1.45; } }
    .wrap.open .bg { opacity: 1; }
    .wrap.open .dlg { opacity: 1; transform: none; }
    .dlg > * { flex-shrink: 0; }

    .top { display: flex; align-items: flex-start; gap: 12px; }
    .heads { flex: 1; min-width: 0; }
    h2 { margin: 0; font-size: 17px; font-weight: 650; line-height: 1.25; }
    .sub { margin-top: 3px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: #a6a6ad; font-size: 13px; }

    button { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center;
      justify-content: center; gap: 6px; height: 36px; padding: 0 14px 1px; border-radius: 10px;
      font: inherit; font-weight: 600; color: #f1f1f1; background: rgba(255, 255, 255, .1); white-space: nowrap;
      transition: background-color .14s ease, transform .1s ease-out, opacity .14s ease; }
    button:hover { background: rgba(255, 255, 255, .18); }
    button:active { transform: scale(.97); }
    button:focus-visible { outline: 2px solid rgba(255, 255, 255, .75); outline-offset: 2px; }
    button:disabled { cursor: default; opacity: .45; transform: none; }
    button svg { width: 18px; height: 18px; flex: none; }
    .x { flex: none; width: 36px; padding: 0; border-radius: 50%; }

    .search { position: relative; }
    .search svg { position: absolute; left: 12px; top: 50%; width: 18px; height: 18px; margin-top: -9px; color: #8e8e95; pointer-events: none; }
    input { all: unset; box-sizing: border-box; width: 100%; height: 42px; padding: 0 14px 1px 40px; border-radius: 12px;
      background: rgba(255, 255, 255, .08); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .08);
      font: inherit; font-size: 15px; color: #fff; }
    input::placeholder { color: #8e8e95; }
    input:focus { box-shadow: inset 0 0 0 2px rgba(255, 255, 255, .5); }

    .list { flex: 1 1 auto; flex-shrink: 1; min-height: 120px; max-height: 52vh; overflow: auto; overscroll-behavior: contain; margin: 0 -8px;
      padding: 0 8px; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.2) transparent; }
    .sec { padding: 10px 4px 6px; color: #8e8e95; font-size: 12px; font-weight: 600; letter-spacing: .02em; }
    .row { display: flex; align-items: center; gap: 12px; width: 100%; height: auto; min-height: 56px; padding: 6px 8px;
      border-radius: 12px; background: none; text-align: left; font-weight: 500; }
    .row:hover { background: rgba(255, 255, 255, .07); }
    .row:focus-visible { outline: none; background: rgba(255, 255, 255, .1); box-shadow: inset 0 0 0 2px rgba(255, 255, 255, .45); }
    .thumb { position: relative; flex: none; width: 72px; height: 40px; border-radius: 8px; overflow: hidden;
      background: rgba(255, 255, 255, .08) center / cover no-repeat; display: grid; place-items: center; color: #8e8e95; }
    .thumb svg { width: 20px; height: 20px; }
    .txt { flex: 1; min-width: 0; }
    .t { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 14.5px; color: #f1f1f1; }
    .t mark { background: rgba(255, 59, 92, .32); color: #fff; border-radius: 3px; padding: 0 1px; }
    .m { display: flex; align-items: center; gap: 5px; margin-top: 2px; color: #8e8e95; font-size: 12.5px;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .m svg { width: 13px; height: 13px; flex: none; }
    .box { flex: none; width: 24px; height: 24px; border-radius: 7px; box-shadow: inset 0 0 0 2px rgba(255, 255, 255, .35);
      display: grid; place-items: center; color: transparent; transition: background-color .14s ease, box-shadow .14s ease; }
    .box svg { width: 16px; height: 16px; stroke-width: 2.6; }
    .row[aria-checked="true"] .box { background: #ff3b5c; box-shadow: none; color: #fff; }
    .row.changed .t::after { content: "•"; margin-left: 6px; color: #ff6b85; }
    .row.create .thumb { background: rgba(255, 59, 92, .16); color: #ff6b85; }
    .empty { padding: 28px 8px; color: #a6a6ad; text-align: center; line-height: 1.5; }
    .skel { height: 56px; margin: 4px 0; border-radius: 12px; background: linear-gradient(90deg, rgba(255,255,255,.05), rgba(255,255,255,.1), rgba(255,255,255,.05));
      background-size: 200% 100%; animation: sk 1.2s linear infinite; }
    @keyframes sk { to { background-position: -200% 0; } }

    .foot { display: flex; align-items: center; gap: 10px; }
    .info { flex: 1; min-width: 0; color: #a6a6ad; font-size: 13px; }
    .info.err { color: #ff8095; }
    .go { height: 42px; padding: 0 20px 1px; background: #ff3b5c; color: #fff; font-size: 15px; }
    .go:hover { background: #ff2149; }

    .msg { position: absolute; left: 50%; bottom: 24px; z-index: 3; padding: 9px 16px 10px; border-radius: 999px;
      background: rgba(28, 28, 30, .94); box-shadow: 0 8px 24px rgba(0, 0, 0, .4); font-size: 13.5px; white-space: nowrap;
      transform: translate(-50%, 8px); opacity: 0; pointer-events: none;
      transition: opacity .16s ease-out, transform .22s cubic-bezier(.23, 1, .32, 1); }
    .msg.show { opacity: 1; transform: translate(-50%, 0); }
    @media (prefers-reduced-motion: reduce) { .bg, .dlg, .msg { transition: none; } .skel { animation: none; } }
  `;

  let ui = null;

  function videoIdFromPage() {
    const v = new URLSearchParams(location.search).get("v");
    if (location.pathname === "/watch" && v) return v;
    return location.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{6,20})/)?.[1] || null;
  }
  const pageTitle = () => document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, "");

  function toast(text, ms = 2400) {
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

  // изменения относительно того, что было при открытии
  const changes = () => ui.items.filter((p) => p.checked !== p.contains);

  function rowHtml(p, words) {
    const lib = ui.lib.get(p.id);
    const thumb = lib?.thumb ? `style="background-image:url('${esc(lib.thumb)}')"` : "";
    const meta = [PRIVACY[p.privacy] || "", lib?.updated || ""].filter(Boolean).join(" · ");
    return `<button class="row${p.checked !== p.contains ? " changed" : ""}" role="checkbox" aria-checked="${p.checked}" data-id="${esc(p.id)}">
      <span class="thumb" ${thumb}>${thumb ? "" : ICON.list}</span>
      <span class="txt"><div class="t">${mark(p.title, words)}</div><div class="m">${privIcon(p.privacy)}${esc(meta)}</div></span>
      <span class="box">${ICON.check}</span>
    </button>`;
  }

  function render() {
    if (!ui) return;
    const list = ui.$(".list");
    if (ui.loading) {
      list.innerHTML = '<div class="skel"></div>'.repeat(6);
      return;
    }
    if (ui.error) {
      list.innerHTML = `<div class="empty">${esc(ui.error)}</div>`;
      ui.$(".go").disabled = true;
      return;
    }
    const q = norm(ui.query);
    const words = q ? q.split(" ") : [];
    const match = (p) => {
      const t = norm(p.title);
      return words.every((w) => t.includes(w));
    };
    let html = "";
    if (q) {
      const found = ui.items.filter(match);
      // точного совпадения нет — предлагаем создать плейлист с этим названием
      if (!ui.items.some((p) => norm(p.title) === q)) {
        html += `<button class="row create" data-create="1"><span class="thumb">${ICON.plus}</span>
          <span class="txt"><div class="t">Создать «${esc(ui.query.trim())}»</div><div class="m">${ICON.lock}Новый приватный плейлист — видео сразу в нём</div></span></button>`;
      }
      html += found.map((p) => rowHtml(p, words)).join("");
      if (!found.length) html += `<div class="empty">Плейлистов с «${esc(ui.query.trim())}» нет</div>`;
    } else {
      const recentIds = ui.recent.filter((id) => ui.items.some((p) => p.id === id)).slice(0, 5);
      const recent = recentIds.map((id) => ui.items.find((p) => p.id === id));
      if (recent.length) {
        html += `<div class="sec">Недавние</div>${recent.map((p) => rowHtml(p, [])).join("")}<div class="sec">Все плейлисты · ${ui.items.length}</div>`;
      }
      html += ui.items
        .filter((p) => !recentIds.includes(p.id))
        .map((p) => rowHtml(p, []))
        .join("");
    }
    list.innerHTML = html;
    // высота списка — по первому полному показу: при поиске окно не прыгает
    if (!q && !ui.listH && ui.items.length) {
      ui.listH = list.offsetHeight;
      list.style.height = `${ui.listH}px`;
    }
    renderFoot();
  }

  function renderFoot() {
    if (!ui || ui.loading || ui.error) return;
    const ch = changes();
    const add = ch.filter((p) => p.checked).length;
    const del = ch.length - add;
    const inN = ui.items.filter((p) => p.checked).length;
    const parts = [];
    if (add) parts.push(`+${add}`);
    if (del) parts.push(`−${del}`);
    setInfo(ch.length ? `Изменения: ${parts.join(", ")} · видео будет в ${inN}` : inN ? `Видео уже в ${inN} ${plural(inN)}` : "Отметьте плейлисты галочками");
    ui.$(".go").disabled = !ch.length || ui.saving;
  }
  const plural = (n) => (n % 10 === 1 && n % 100 !== 11 ? "плейлисте" : "плейлистах");

  function toggle(id) {
    const p = ui.items.find((x) => x.id === id);
    if (!p || ui.saving) return;
    p.checked = !p.checked;
    const row = ui.root.querySelector(`.row[data-id="${CSS_ESCAPE(id)}"]`);
    // обновляем строку на месте — фокус и прокрутка не прыгают
    if (row) {
      row.setAttribute("aria-checked", String(p.checked));
      row.classList.toggle("changed", p.checked !== p.contains);
    }
    renderFoot();
  }
  // globalThis.CSS — встроенный CSS.escape (здесь CSS — строка со стилями окна)
  const CSS_ESCAPE = (s) => (globalThis.CSS?.escape ? globalThis.CSS.escape(s) : String(s).replace(/"/g, '\\"'));

  async function createFromQuery() {
    const title = ui.query.trim();
    if (!title || ui.saving || ui.loading || ui.error) return;
    const mine = ui;
    ui.saving = true;
    setInfo(`Создаю «${title}»…`);
    try {
      const { id } = await call("create", { title, privacy: "PRIVATE", videoIds: [ui.videoId] });
      if (ui !== mine) return;
      ui.items.unshift({ id, title, privacy: "PRIVATE", contains: true, checked: true });
      remember(mine, [id]);
      ui.query = "";
      ui.$("input").value = "";
      toast(`Создан плейлист «${title}», видео в нём`);
    } catch (e) {
      if (ui === mine) setInfo(ERRORS[e.code] || ERRORS.fail, true);
    } finally {
      if (ui === mine) {
        ui.saving = false;
        render();
      }
    }
  }

  function remember(state, ids) {
    state.recent = [...ids, ...state.recent.filter((x) => !ids.includes(x))].slice(0, 20);
    save(RECENT_KEY, state.recent);
  }

  // Сообщение на странице — когда окно уже закрыто (сохранение доведено без него)
  function pageToast(text) {
    const t = document.createElement("div");
    t.textContent = text;
    t.setAttribute("role", "status");
    t.style.cssText =
      "position:fixed;left:50%;top:72px;z-index:2147483001;transform:translateX(-50%);padding:10px 18px 11px;" +
      "border-radius:999px;background:rgba(28,28,30,.94);color:#f1f1f1;font:500 14px/1.3 Roboto,Arial,sans-serif;" +
      "box-shadow:0 8px 30px rgba(0,0,0,.4);transition:opacity .2s ease;pointer-events:none";
    document.documentElement.appendChild(t);
    setTimeout(() => (t.style.opacity = "0"), 2600);
    setTimeout(() => t.remove(), 2900);
  }

  // Сохранить отмеченное: по одному запросу на плейлист, неспешно
  // Сохранение доводится до конца, даже если окно закрыли посреди него или
  // автовоспроизведение ушло на другое видео: итог — сообщением на странице.
  async function apply() {
    if (!ui || ui.loading || ui.error || ui.saving) return;
    const ch = changes();
    if (!ch.length) return;
    const mine = ui;
    const videoId = ui.videoId;
    mine.saving = true;
    mine.$(".go").disabled = true;
    let ok = 0;
    const failed = [];
    for (const p of ch) {
      if (ui === mine) setInfo(`Сохраняю… ${ok + failed.length + 1} из ${ch.length}`);
      try {
        await call("edit", { playlistId: p.id, videoId, add: p.checked });
        p.contains = p.checked;
        ok++;
      } catch (e) {
        failed.push(p);
        // своя причина от YouTube — покажем её, а не «попробуйте ещё раз»
        p.why = e.code === "yt" ? e.message.trim().replace(/\.$/, "") : "";
      }
    }
    mine.saving = false;
    const added = ch.filter((p) => p.checked && !failed.includes(p));
    if (added.length) remember(mine, added.map((p) => p.id));
    const a = added.length;
    const d = ok - a;
    const parts = [];
    if (a) parts.push(`добавлено в ${a}`);
    if (d) parts.push(`убрано из ${d}`);
    const lc = (s) => s.charAt(0).toLowerCase() + s.slice(1);
    const fail = failed.length
      ? `Не получилось: ${failed.map((p) => (p.why ? `«${p.title}» — ${lc(p.why)}` : `«${p.title}»`)).join("; ")}` +
        (failed.some((p) => !p.why) ? " — попробуйте ещё раз" : "")
      : "";
    if (ui !== mine) {
      pageToast(fail || `Сохранено: ${parts.join(", ")}`);
      return;
    }
    render();
    if (fail) return setInfo(fail, true);
    toast(`Сохранено: ${parts.join(", ")}`);
    setTimeout(() => ui === mine && close(), 900);
  }

  // ---------- клавиши ----------
  function onKeys(e) {
    if (!ui) return;
    e.stopImmediatePropagation(); // горячие клавиши YouTube не срабатывают
    const k = e.key;
    const ae = ui.root.activeElement;
    const rows = () => [...ui.root.querySelectorAll(".row")];
    if (k === "Escape") {
      e.preventDefault();
      return close();
    }
    if (k === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      return apply();
    }
    if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault();
      const r = rows();
      if (!r.length) return;
      const i = r.indexOf(ae);
      const next = k === "ArrowDown" ? (i < 0 ? 0 : Math.min(r.length - 1, i + 1)) : i <= 0 ? -1 : i - 1;
      if (next < 0) ui.$("input").focus();
      else r[next].focus();
      return;
    }
    if (k === "Tab") {
      // фокус не уходит на страницу под окном
      const items = [ui.$("input"), ...rows(), ...ui.root.querySelectorAll(".foot button, .x")].filter((el) => el && !el.disabled);
      const i = items.indexOf(ae);
      e.preventDefault();
      items[e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length]?.focus();
      return;
    }
    if (ui.loading || ui.error) return;
    if (ae?.tagName === "INPUT") {
      if (k === "Enter" && !e.repeat) {
        e.preventDefault();
        // Пустой поиск — сохранить. Есть плейлист с точно таким названием или
        // найден ровно один — отметить его. Ничего не найдено — создать.
        const q = norm(ui.query);
        if (!q) return apply();
        const exact = ui.items.find((p) => norm(p.title) === q);
        const r = rows().filter((x) => !x.dataset.create);
        if (exact) toggle(exact.id);
        else if (r.length === 1) toggle(r[0].dataset.id);
        else if (!r.length) createFromQuery();
      }
      return;
    }
    if (k === "Enter" && ae?.classList.contains("row")) {
      // Enter на строке — как клик: галочка или «Создать»; сохранить — Ctrl+Enter
      e.preventDefault();
      if (e.repeat) return;
      if (ae.dataset.create) createFromQuery();
      else toggle(ae.dataset.id);
      return;
    }
    // печать букв в любом месте окна — сразу в поиск
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && k !== " ") {
      ui.$("input").focus();
    }
  }

  // ---------- открыть / закрыть ----------
  function close() {
    if (!ui) return;
    const cur = ui;
    ui = null;
    cur.wrap.classList.remove("open");
    cur.wrap.style.pointerEvents = "none";
    window.removeEventListener("keydown", onKeys, true);
    setTimeout(() => cur.host.remove(), 220);
    cur.prevFocus?.focus?.({ preventScroll: true });
  }

  async function open(opts = {}) {
    const videoId = opts.videoId || videoIdFromPage();
    if (!videoId) return false;
    close();
    globalThis.__ytcsClip?.close?.(); // одно окно за раз — иначе спорят за клавиши
    const host = document.createElement("div");
    host.id = "ytcs-playlists";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style>
      <div class="wrap">
        <div class="bg"></div>
        <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="t">
          <div class="top">
            <div class="heads"><h2 id="t">Сохранить в плейлисты</h2><div class="sub"></div></div>
            <button class="x" aria-label="Закрыть (Esc)" title="Закрыть (Esc)">${ICON.close}</button>
          </div>
          <label class="search">${ICON.search}<input placeholder="Найти плейлист или создать новый" spellcheck="false" aria-label="Поиск плейлиста" /></label>
          <div class="list" role="group" aria-label="Плейлисты"></div>
          <div class="foot">
            <div class="info" aria-live="polite"></div>
            <button class="go" disabled>Сохранить</button>
          </div>
        </div>
        <div class="msg" role="status"></div>
      </div>`;
    (document.fullscreenElement || document.documentElement).appendChild(host);
    const wrap = root.querySelector(".wrap");
    ui = {
      host,
      root,
      wrap,
      $: (s) => root.querySelector(s),
      videoId,
      items: [],
      lib: new Map(),
      recent: [],
      query: "",
      loading: true,
      error: null,
      saving: false,
      prevFocus: document.activeElement,
    };
    const mine = ui;
    const own = videoId === videoIdFromPage();
    root.querySelector(".sub").textContent = opts.title || (own ? pageTitle() : "Ролик из ленты");
    // ролик не этой страницы (правый клик по превью) — название берём у YouTube
    if (!own && !opts.title) {
      fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (ui === mine && d?.title) root.querySelector(".sub").textContent = d.title;
        })
        .catch(() => {});
    }
    root.querySelector(".bg").addEventListener("click", close);
    root.querySelector(".x").addEventListener("click", close);
    root.querySelector(".go").addEventListener("click", apply);
    const input = root.querySelector("input");
    input.addEventListener("input", () => {
      ui.query = input.value;
      render();
      ui.$(".list").scrollTop = 0;
    });
    root.querySelector(".list").addEventListener("click", (e) => {
      const row = e.target.closest(".row");
      if (!row) return;
      if (row.dataset.create) createFromQuery();
      else toggle(row.dataset.id);
    });
    // клики и колесо не уходят в плеер под окном
    for (const t of ["click", "mousedown", "pointerdown", "dblclick"]) wrap.addEventListener(t, (e) => e.stopPropagation());
    window.addEventListener("keydown", onKeys, true);
    render();
    void wrap.offsetWidth;
    wrap.classList.add("open");
    input.focus({ preventScroll: true });

    if (!alive()) {
      ui.loading = false;
      ui.error = ERRORS.noreply;
      return render(), true;
    }
    // недавние и обложки — из хранилища сразу, список — с YouTube
    const [recent, lib] = await Promise.all([load(RECENT_KEY), load(LIB_KEY)]);
    if (ui !== mine) return true;
    ui.recent = Array.isArray(recent) ? recent : [];
    for (const it of lib?.items || []) ui.lib.set(it.id, it);
    try {
      const items = await call("list", { videoIds: [videoId] });
      if (ui !== mine) return true;
      ui.items = items.map((p) => ({ ...p, checked: p.contains }));
      ui.loading = false;
      render();
    } catch (e) {
      if (ui !== mine) return true;
      ui.loading = false;
      ui.error = ERRORS[e.code] || ERRORS.fail;
      render();
      return true;
    }
    // обложки устарели — обновляем тихо в фоне
    if (!lib?.ts || Date.now() - lib.ts > LIB_TTL) {
      call("library", {}, 30000)
        .then((items) => {
          if (!items?.length) return; // пусто — не запоминаем на 6 часов
          save(LIB_KEY, { ts: Date.now(), items });
          if (ui !== mine) return;
          for (const it of items) ui.lib.set(it.id, it);
          const scroll = ui.$(".list").scrollTop;
          render();
          ui.$(".list").scrollTop = scroll;
        })
        .catch(() => {});
    }
    return true;
  }

  window.addEventListener("yt-navigate-start", close);

  // ---------- кнопка «Сохранить» на Shorts ----------
  // Встаёт в правую колонку кнопок ролика (перед кнопкой звука) и выглядит
  // как соседние: круг 48 px и подпись под ним, в светлой и тёмной теме.
  const SHORTS_CSS = `
    .ytcs-sbtn { display: flex; flex-direction: column; align-items: center; padding-bottom: 8px;
      margin: 0 !important; /* у YouTube свой отступ для div в этой колонке */ }
    .ytcs-sbtn button { width: 48px; height: 48px; padding: 0; border: 0; border-radius: 24px; cursor: pointer;
      display: grid; place-items: center; background: rgba(0, 0, 0, .05); color: #0f0f0f;
      transition: background-color .15s ease, transform .1s ease-out; }
    html[dark] .ytcs-sbtn button { background: rgba(255, 255, 255, .1); color: #f1f1f1;
      -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); }
    .ytcs-sbtn button:hover { background: rgba(0, 0, 0, .1); }
    html[dark] .ytcs-sbtn button:hover { background: rgba(255, 255, 255, .2); }
    .ytcs-sbtn button:active { transform: scale(.94); }
    .ytcs-sbtn button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
    .ytcs-sbtn svg { width: 24px; height: 24px; }
    .ytcs-sbtn span { margin-top: 4px; font: 400 12px/18px Roboto, Arial, sans-serif; color: #0f0f0f; }
    html[dark] .ytcs-sbtn span { color: #f1f1f1; }`;
  const SAVE_ICON = SVG('<path d="M6 4h12v16l-6-4-6 4z"/><path d="M12 8v5"/><path d="M9.5 10.5h5"/>');

  // Колонка кнопок ролика, который сейчас на экране. Раньше YouTube помечал
  // его [is-active]; в новой раскладке колонка одна на все ролики, без пометки —
  // тогда берём ту, что видна на экране.
  function shortsBar() {
    const marked =
      document.querySelector("ytd-reel-video-renderer[is-active] reel-action-bar-view-model") ||
      document.querySelector("ytd-reel-video-renderer[is-active] #actions");
    if (marked) return marked;
    let best = null;
    let bestDist = Infinity;
    for (const b of document.querySelectorAll("ytd-shorts reel-action-bar-view-model")) {
      const r = b.getBoundingClientRect();
      if (!r.height || r.bottom < 0 || r.top > innerHeight) continue;
      const dist = Math.abs((r.top + r.bottom) / 2 - innerHeight / 2);
      if (dist < bestDist) [best, bestDist] = [b, dist];
    }
    return best;
  }

  function ensureShortsButton() {
    if (!location.pathname.startsWith("/shorts/") || !alive()) return;
    const bar = shortsBar();
    if (!bar || bar.querySelector(".ytcs-sbtn")) return;
    if (!document.getElementById("ytcs-shorts-css")) {
      const st = document.createElement("style");
      st.id = "ytcs-shorts-css";
      st.textContent = SHORTS_CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    const box = document.createElement("div");
    box.className = "ytcs-sbtn";
    box.innerHTML = `<button aria-label="Сохранить в плейлисты" title="Сохранить в плейлисты (Alt+Shift+S)">${SAVE_ICON}</button><span>Сохранить</span>`;
    box.querySelector("button").addEventListener("click", (e) => {
      e.stopPropagation();
      void open();
    });
    const pivot = bar.querySelector("pivot-button-view-model");
    if (pivot?.parentNode) pivot.parentNode.insertBefore(box, pivot);
    else bar.appendChild(box);
  }
  setInterval(ensureShortsButton, 1000);

  globalThis.__ytcsPlaylists = { open, close };
})();
