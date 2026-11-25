"use strict";

// Мягкий лимит времени — плашка поверх плеера: «Сегодня уже 2 ч на YouTube».
// Когда показывать, решает фон (limit-bg.js): он присылает «limit:show» ровно той
// вкладке и рамке, где сейчас играет видео, — один раз при пересечении лимита и
// ещё раз после «Ещё 15 мин». Просмотр ничем не блокируется.
//  - «Досмотреть это и хватит» — таймер сна «В конце видео» (sleep.js);
//  - «Ещё 15 мин» — напомнить через 15 минут просмотра;
//  - × — на сегодня всё. Не нажали ничего — плашка сама уйдёт через 25 с.
// Стиль — как у остальных плашек в плеере (resume.js, sleep.js).
(() => {
  // Встроенный плеер (youtube.com/embed) — только внутри нашей «Моей библиотеки»
  if (location.pathname.startsWith("/embed/")) {
    let ours = false;
    try {
      ours = location.ancestorOrigins?.[0] === `chrome-extension://${chrome.runtime.id}`;
    } catch (e) {
      ours = false;
    }
    if (!ours) return;
  } else if (window.top !== window) {
    return; // прочие фреймы YouTube — не наше
  }
  if (globalThis.__ytcsLimit) return;

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };

  // Основное видео и его плеер (как в sleep.js: обычное видео, мини-плеер, Shorts)
  function mainVideo() {
    const own = document.querySelector("#movie_player video.html5-main-video");
    if (own && !own.paused) return own;
    const list = [...document.querySelectorAll("video.html5-main-video")];
    return list.find((v) => !v.paused) || own || list[0] || document.querySelector("#movie_player video");
  }
  const playerOf = (v) => v?.closest(".html5-video-player") || document.getElementById("movie_player");

  const ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3.5h10M7 20.5h10"/><path d="M8 3.5v3.2a4 4 0 0 0 1.6 3.2L12 12l2.4-2.1A4 4 0 0 0 16 6.7V3.5"/><path d="M8 20.5v-3.2a4 4 0 0 1 1.6-3.2L12 12l2.4 2.1a4 4 0 0 1 1.6 3.2v3.2"/></svg>';
  const X =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const CSS = `
    :host { all: initial; position: absolute; top: 16px; left: 16px; right: 16px; z-index: 83;
      display: flex; justify-content: center; pointer-events: none; container-type: inline-size; }
    :host(.page) { position: fixed; top: 72px; z-index: 9999; }
    .n { display: flex; align-items: center; gap: 10px; min-width: 0; max-width: 100%; box-sizing: border-box; padding: 7px 7px 7px 16px;
      border-radius: 999px; background: rgba(28, 28, 30, .9);
      -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6);
      box-shadow: 0 8px 30px rgba(0, 0, 0, .4), inset 0 0 0 1px rgba(255, 255, 255, .07);
      color: #f1f1f1; font: 500 16px/1.3 "YouTube Noto", Roboto, Arial, sans-serif;
      opacity: 0; transform: translateY(-8px) scale(.97); transform-origin: 50% 0;
      transition: opacity .18s ease, transform .26s cubic-bezier(.22, 1, .36, 1); }
    .n.show { opacity: 1; transform: none; pointer-events: auto; }
    .ic { flex: none; width: 20px; height: 20px; color: #ff6b85; }
    .txt { flex: 1 1 auto; min-width: 0; white-space: nowrap; }
    b { font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .acts { display: flex; gap: 8px; flex: none; }
    button { flex: none; height: 34px; padding: 2px 16px 0; border: 0; border-radius: 999px; font: inherit; font-weight: 600;
      background: rgba(255, 255, 255, .14); color: #fff; cursor: pointer; white-space: nowrap; transition: background-color .12s ease; }
    button:hover, button:focus-visible { background: rgba(255, 255, 255, .24); outline: none; }
    button:active { background: rgba(255, 255, 255, .3); }
    button.go { background: #e8002d; }
    button.go:hover, button.go:focus-visible { background: #ff3b5c; }
    button.go:active { background: #c70027; }
    button[hidden] { display: none; }
    .x { width: 34px; padding: 0; display: grid; place-items: center; }
    .x svg { width: 16px; height: 16px; color: #fff; }
    /* плеер уже, чем вся строка (с длинным «2 ч 15 мин» — около 760 px): карточка — текст и ×,
       под ними обе кнопки; не влезают рядом — каждая на свою строку во всю ширину */
    @container (max-width: 800px) {
      .n { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "ic txt x" "acts acts acts";
        row-gap: 8px; border-radius: 18px; padding: 7px 7px 7px 16px; }
      .ic { grid-area: ic; }
      .txt { grid-area: txt; white-space: normal; }
      .x { grid-area: x; }
      .acts { grid-area: acts; flex-wrap: wrap; }
      .acts button { flex: 1 1 auto; }
    }
    @media (min-width: 1600px) { .n { zoom: 1.15; } }
    @media (min-width: 2200px) { .n { zoom: 1.35; } }
    @media (prefers-reduced-motion: reduce) { .n, button { transition: none; } }`;

  const ui = { host: null, root: null, timer: 0, hover: false, open: false };

  function act(what) {
    hide();
    if (!alive()) return;
    try {
      void chrome.runtime.sendMessage({ type: "limit:act", act: what }).catch(() => {});
    } catch (e) {
      /* расширение обновили — не страшно */
    }
  }

  function hide() {
    clearTimeout(ui.timer);
    ui.open = false;
    ui.hover = false;
    ui.root?.querySelector(".n")?.classList.remove("show");
  }
  function armHide(ms) {
    clearTimeout(ui.timer);
    if (!ui.hover) ui.timer = setTimeout(() => (ui.open ? act("close") : hide()), ms);
  }

  function build() {
    const host = document.createElement("div");
    host.id = "ytcs-limit-notice";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style>
      <div class="n" role="alert" aria-live="assertive"><span class="ic">${ICON}</span><span class="txt"></span>
        <div class="acts"><button type="button" class="go">Досмотреть это и хватит</button><button type="button" class="more">Ещё 15 мин</button></div>
        <button type="button" class="x" aria-label="Закрыть" title="Закрыть">${X}</button></div>`;
    // клики по плашке не должны ставить видео на паузу
    for (const t of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "keydown"]) {
      host.addEventListener(t, (e) => e.stopPropagation());
    }
    root.querySelector(".go").addEventListener("click", () => {
      globalThis.__ytcsSleep?.set("end");
      act("finish");
    });
    root.querySelector(".more").addEventListener("click", () => act("snooze"));
    root.querySelector(".x").addEventListener("click", () => act("close"));
    const box = root.querySelector(".n");
    box.addEventListener("mouseenter", () => {
      ui.hover = true;
      clearTimeout(ui.timer);
    });
    box.addEventListener("mouseleave", () => {
      ui.hover = false;
      if (ui.open) armHide(8000);
    });
    ui.host = host;
    ui.root = root;
  }

  // spent — «2 ч», «2 ч 15 мин»; true — плашка на экране
  function show(spent) {
    const v = mainVideo();
    const p = v && playerOf(v);
    // плеер на виду и не крошечный — над ним; иначе (мини-плеер) — сверху страницы
    const r = p?.getBoundingClientRect();
    const where = r && r.width >= 320 && r.height >= 150 ? p : document.body;
    if (!where || !v) return false;
    if (!ui.host) build();
    // в новом встроенном плеере — слой над его панелью управления (content.js), иначе кнопки не нажать
    const into = (where !== document.body && globalThis.__ytcsPlayerLayer?.(where)) || where;
    if (ui.host.parentElement !== into) into.appendChild(ui.host);
    ui.host.classList.toggle("page", where === document.body);
    ui.root.querySelector(".txt").innerHTML = `Сегодня уже <b>${String(spent || "").replace(/[<>&]/g, "")}</b> на YouTube`;
    // таймера сна здесь нет (не загрузился) — кнопку «Досмотреть» не показываем
    ui.root.querySelector(".go").hidden = !globalThis.__ytcsSleep;
    const box = ui.root.querySelector(".n");
    box.classList.remove("show");
    void box.offsetHeight; // перезапуск появления
    box.classList.add("show");
    ui.open = true;
    armHide(25000);
    return true;
  }

  globalThis.__ytcsLimit = { show, hide };
  if (alive()) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type !== "limit:show") return;
      let ok = false;
      try {
        ok = show(msg.spent);
      } catch (e) {
        ok = false;
      }
      sendResponse({ ok });
    });
  }
})();
