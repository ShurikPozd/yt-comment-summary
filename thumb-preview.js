"use strict";

// Превью видео поверх страницы: затемнение, картинка, выбор качества,
// «Скачать» и «Копировать». Своя тень (shadow DOM), чтобы стили страницы не
// влияли на окно и наоборот. Общий код: контент-скрипты youtube.com (пункт
// «Превью» в меню расширения и контекстном меню — content.js, кнопка «Превью»
// на обложках — video-actions.js) и страницы расширения («Моя библиотека»).
// Скачивание и копирование — через фон (ui:thumb): у него доступ к i.ytimg.com.
//
// API: globalThis.__ytcsPreview.open({ urls, title, name }) → Promise<boolean>,
//      .close(). Список адресов и имя файла по шаблону из настроек отдаёт фон:
//      chrome.runtime.sendMessage({ type: "ui:preview-info", videoId, title, channel }).
(() => {
  if (globalThis.__ytcsPreview) return;

  const SVG = (paths) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const PV_URL_RE = /^https:\/\/i\.ytimg\.com\/vi\/[A-Za-z0-9_-]{11}\/\w+\.jpg$/;
  const PV_LABELS = { maxresdefault: "Макс.", sddefault: "SD", hqdefault: "HQ" };
  const PV_CSS = `
    :host { all: initial; }
    .wrap { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center;
      font: 500 14px/1.35 Roboto, "YouTube Sans", "Segoe UI", system-ui, sans-serif; color: #f1f1f1; }
    .bg { position: absolute; inset: 0; background: rgba(8, 8, 10, .72);
      -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
      opacity: 0; transition: opacity .2s ease-out; }
    .dlg { position: relative; display: flex; flex-direction: column; gap: 12px;
      max-width: min(94vw, 1320px); max-height: 94vh;
      opacity: 0; transform: scale(.96); transition: opacity .18s ease-out, transform .26s cubic-bezier(.23, 1, .32, 1); }
    .wrap.open .bg { opacity: 1; }
    .wrap.open .dlg { opacity: 1; transform: none; }
    .top { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
      font-size: 15px; font-weight: 600; }
    button { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center;
      justify-content: center; gap: 6px; height: 36px; padding: 0 14px 1px; border-radius: 10px;
      font: inherit; font-weight: 600; color: #f1f1f1; background: rgba(255, 255, 255, .1);
      transition: background-color .14s ease, transform .1s ease-out; white-space: nowrap; }
    button:hover { background: rgba(255, 255, 255, .18); }
    button:active { transform: scale(.97); }
    button:focus-visible { outline: 2px solid rgba(255, 255, 255, .7); outline-offset: 2px; }
    button svg { width: 18px; height: 18px; flex: none; }
    .x { width: 36px; padding: 0; border-radius: 50%; }
    .pri { background: #ff3b5c; color: #fff; }
    .pri:hover { background: #ff2149; }
    .stage { position: relative; display: grid; place-items: center; min-width: min(80vw, 480px); min-height: 220px; }
    img { display: block; max-width: min(94vw, 1320px); max-height: calc(94vh - 120px); width: auto; height: auto;
      border-radius: 12px; box-shadow: 0 20px 60px rgba(0, 0, 0, .55); background: #111; }
    .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .q { display: flex; gap: 4px; padding: 3px; border-radius: 12px; background: rgba(255, 255, 255, .08); }
    .q button { height: 30px; padding: 0 12px 1px; border-radius: 9px; background: none; color: #bdbdc4; font-size: 13px; }
    .q button:hover { color: #fff; background: none; }
    .q button[aria-pressed="true"] { background: rgba(255, 255, 255, .16); color: #fff; }
    .meta { flex: 1; min-width: 120px; color: #a6a6ad; font-size: 13px; font-variant-numeric: tabular-nums;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .acts { display: flex; gap: 8px; margin-left: auto; }
    .msg { position: absolute; left: 50%; bottom: 16px; padding: 9px 16px 10px; border-radius: 999px;
      background: rgba(28, 28, 30, .92); box-shadow: 0 8px 24px rgba(0, 0, 0, .4); font-size: 13px;
      transform: translate(-50%, 8px); opacity: 0; pointer-events: none;
      transition: opacity .16s ease-out, transform .22s cubic-bezier(.23, 1, .32, 1); }
    .msg.show { opacity: 1; transform: translate(-50%, 0); }
    .err { padding: 40px 24px; color: #bdbdc4; text-align: center; }
    .spin { width: 28px; height: 28px; border-radius: 50%; border: 3px solid rgba(255, 255, 255, .15);
      border-top-color: #fff; animation: spin .7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .bg, .dlg, .msg { transition: none; } }
  `;
  const PV_ICON = {
    close: SVG('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
    download: SVG('<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>'),
    copy: SVG('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>'),
  };
  let pv = null; // { host, root, wrap, urls, title, name, current, sizes, prevFocus }

  function pvToast(text, ms = 2000) {
    if (!pv) return;
    const m = pv.root.querySelector(".msg");
    m.textContent = text;
    m.classList.add("show");
    clearTimeout(pv.msgTimer);
    pv.msgTimer = setTimeout(() => m.classList.remove("show"), ms);
  }

  function pvProbe(url) {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im.naturalWidth > 120 ? { w: im.naturalWidth, h: im.naturalHeight } : null);
      im.onerror = () => resolve(null);
      im.src = url;
    });
  }

  function pvShow(url) {
    if (!pv || !pv.sizes.has(url)) return;
    pv.current = url;
    const { w, h } = pv.sizes.get(url);
    const stage = pv.root.querySelector(".stage");
    stage.innerHTML = "";
    const img = document.createElement("img");
    img.alt = pv.title;
    img.src = url;
    stage.appendChild(img);
    pv.root.querySelector(".meta").textContent = `${w}×${h} · ${pv.name}`;
    pv.root.querySelectorAll(".q button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.url === url)));
  }

  async function pvDownload() {
    if (!pv?.current) return;
    try {
      const r = await chrome.runtime.sendMessage({ type: "ui:thumb", op: "download", url: pv.current, name: pv.name });
      pvToast(r?.ok ? "Сохранено в загрузки" : "Не получилось скачать");
    } catch (e) {
      pvToast("Не получилось скачать — обновите страницу");
    }
  }

  // Буфер обмена принимает PNG. Картинку берёт фон (у него есть доступ к
  // i.ytimg.com), а промис внутри ClipboardItem сохраняет «жест» пользователя.
  function pvCopy() {
    if (!pv?.current) return;
    const url = pv.current;
    pvToast("Копирую…", 15000); // фон качает картинку 1–3 с — сразу показываем, что идёт работа
    const png = (async () => {
      const r = await chrome.runtime.sendMessage({ type: "ui:thumb", op: "data", url });
      if (!r?.ok) throw new Error("no data");
      const im = new Image();
      im.src = r.dataUrl;
      await im.decode();
      const c = document.createElement("canvas");
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      c.getContext("2d").drawImage(im, 0, 0);
      return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("png"))), "image/png"));
    })();
    navigator.clipboard
      .write([new ClipboardItem({ "image/png": png })])
      .then(() => pvToast("Картинка скопирована"))
      .catch(() => pvToast("Не получилось скопировать"));
  }

  function closePreviewOverlay() {
    if (!pv) return;
    const cur = pv;
    pv = null;
    cur.wrap.classList.remove("open");
    cur.wrap.style.pointerEvents = "none"; // во время исчезновения клики не проходят
    window.removeEventListener("keydown", pvKeys, true);
    setTimeout(() => cur.host.remove(), 220);
    // фокус — туда, откуда открыли; если это пункт уже закрытого меню — на плеер
    const back =
      cur.prevFocus?.isConnected && !cur.prevFocus.closest?.(".ytcs-menu") ? cur.prevFocus : document.querySelector("#movie_player");
    back?.focus?.({ preventScroll: true });
  }

  // Tab не выпускает фокус из окна (иначе буквы D/C срабатывали бы при вводе
  // в поиске YouTube).
  function pvTrapTab(e) {
    const items = [...pv.root.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
    if (!items.length) return;
    const i = items.indexOf(pv.root.activeElement);
    const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i < 0 || i === items.length - 1 ? 0 : i + 1;
    e.preventDefault();
    items[next].focus();
  }

  // Пока окно открыто, клавиши YouTube (пробел, K, F, стрелки…) не срабатывают,
  // а страница под окном не прокручивается.
  const PV_BLOCK = new Set([" ", "spacebar", "pageup", "pagedown", "arrowup", "arrowdown", "home", "end", "escape"]);
  function pvKeys(e) {
    if (!pv) return;
    const k = String(e.key || "").toLowerCase();
    e.stopImmediatePropagation();
    if (k === "tab") return pvTrapTab(e);
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (PV_BLOCK.has(k)) e.preventDefault();
    if (e.repeat) return; // зажатая D не качает файл десятки раз
    if (k === "escape") {
      e.preventDefault();
      closePreviewOverlay();
    } else if (k === "d" || k === "в") pvDownload();
    else if (k === "c" || k === "с") pvCopy();
    else if (k === "arrowleft" || k === "arrowright") {
      const list = pv.urls.filter((u) => pv.sizes.has(u));
      const i = list.indexOf(pv.current) + (k === "arrowright" ? 1 : -1);
      if (list[i]) pvShow(list[i]);
    }
  }

  async function openPreviewOverlay({ urls, title, name }) {
    urls = (Array.isArray(urls) ? urls : []).filter((u) => PV_URL_RE.test(u));
    if (!urls.length) return false;
    closePreviewOverlay();
    const host = document.createElement("div");
    host.id = "ytcs-preview";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${PV_CSS}</style>
      <div class="wrap">
        <div class="bg"></div>
        <div class="dlg" role="dialog" aria-modal="true" aria-label="Превью видео">
          <div class="top"><div class="title"></div><button class="x" aria-label="Закрыть (Esc)" title="Закрыть (Esc)">${PV_ICON.close}</button></div>
          <div class="stage"><div class="spin"></div></div>
          <div class="bar">
            <div class="q" role="group" aria-label="Качество"></div>
            <div class="meta"></div>
            <div class="acts">
              <button data-a="copy" title="Копировать картинку (C)">${PV_ICON.copy}Копировать</button>
              <button data-a="download" class="pri" title="Скачать (D)">${PV_ICON.download}Скачать</button>
            </div>
          </div>
          <div class="msg" role="status"></div>
        </div>
      </div>`;
    // в полноэкранном режиме виден только полноэкранный элемент — окно внутрь него
    (document.fullscreenElement || document.documentElement).appendChild(host);
    const wrap = root.querySelector(".wrap");
    pv = { host, root, wrap, urls, title: String(title || ""), name: String(name || "thumbnail.jpg"), current: null, sizes: new Map(), prevFocus: document.activeElement };
    const mine = pv;
    root.querySelector(".title").textContent = pv.title;
    root.querySelector(".bg").addEventListener("click", closePreviewOverlay);
    root.querySelector(".x").addEventListener("click", closePreviewOverlay);
    root.querySelector('[data-a="download"]').addEventListener("click", pvDownload);
    root.querySelector('[data-a="copy"]').addEventListener("click", pvCopy);
    root.querySelector(".q").addEventListener("click", (e) => {
      const b = e.target.closest("[data-url]");
      if (b) pvShow(b.dataset.url);
    });
    wrap.addEventListener("wheel", (e) => e.preventDefault(), { passive: false }); // страница под окном не крутится
    window.addEventListener("keydown", pvKeys, true);
    void wrap.offsetWidth;
    wrap.classList.add("open");
    root.querySelector(".x").focus({ preventScroll: true });

    const results = await Promise.all(urls.map(pvProbe));
    if (pv !== mine) return true;
    results.forEach((r, i) => r && pv.sizes.set(urls[i], r));
    const q = root.querySelector(".q");
    q.innerHTML = urls
      .filter((u) => pv.sizes.has(u))
      .map((u) => {
        const { w, h } = pv.sizes.get(u);
        const label = PV_LABELS[(u.match(/\/(\w+)\.jpg$/) || [])[1]] || "—";
        return `<button data-url="${u}" aria-pressed="false" title="${w}×${h}">${label}</button>`;
      })
      .join("");
    const best = urls.find((u) => pv.sizes.has(u));
    if (best) pvShow(best);
    else root.querySelector(".stage").innerHTML = `<div class="err">Превью этого видео недоступно.</div>`;
    return true;
  }

  // уход на другое видео или выход из полноэкранного режима — окно закрываем
  window.addEventListener("yt-navigate-start", closePreviewOverlay);
  document.addEventListener("fullscreenchange", () => {
    if (pv && !pv.host.isConnected) pv = null;
    else if (pv && pv.host.parentElement !== (document.fullscreenElement || document.documentElement)) closePreviewOverlay();
  });

  globalThis.__ytcsPreview = { open: openPreviewOverlay, close: closePreviewOverlay };
})();
