"use strict";

// Заметки с таймкодами в плеере YouTube (и во встроенном плеере «Моей библиотеки»):
//  - клавиша N или «Заметка» в меню кнопки расширения — видео на паузу, поверх плеера
//    поле «12:34 — …»: Enter — сохранить и продолжить, Esc — отмена;
//  - заметки — точками на полосе прогресса: наведение — текст, клик — перемотка;
//  - на странице видео справа от плеера (над рекомендациями) — список заметок этого
//    видео: перемотка, правка, удаление с «Вернуть», «Копировать».
// Логика без DOM — notes-core.js (globalThis.__ytcsNotesCore), хранение —
// chrome.storage.local.tcNotes. Раздел со всеми заметками — «Моя библиотека» → «Заметки».
(() => {
  // встроенный плеер — только внутри нашей «Моей библиотеки»; прочие фреймы YouTube — не наше
  if (location.pathname.startsWith("/embed/")) {
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
  if (globalThis.__ytcsNotes) return;
  const C = globalThis.__ytcsNotesCore;
  if (!C) return;
  const KEY = C.KEY; // chrome.storage.local.tcNotes
  const OUR_EMBED = location.pathname.startsWith("/embed/");

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };

  // ---------- видео ----------
  const player = () => document.querySelector("#movie_player");
  const mainVideo = () => document.querySelector("#movie_player video.html5-main-video") || document.querySelector("video.html5-main-video") || document.querySelector("#movie_player video");
  const adShowing = () => Boolean(player()?.classList.contains("ad-showing"));
  // полоса прогресса: привычная (.ytp-progress-bar) или новая у встроенного плеера (2026: yt-progress-bar
  // в отдельном слое #player-controls поверх плеера, вне #movie_player)
  const progressBar = () =>
    document.querySelector("#movie_player .ytp-progress-bar") ||
    document.querySelector("#movie_player .ytPlayerProgressBarProgressBar") ||
    (OUR_EMBED ? document.querySelector("#player-controls .ytPlayerProgressBarProgressBar") : null);
  // длина видео: у <video> бывает не известна (поток ещё не открыт) — тогда по полосе прогресса
  function duration() {
    const v = mainVideo();
    if (v && Number.isFinite(v.duration) && v.duration > 0) return v.duration;
    const max = Number(document.querySelector("#movie_player .ytp-progress-bar")?.getAttribute("aria-valuemax"));
    return max > 0 ? max : NaN;
  }
  function videoIdNow() {
    if (location.pathname === "/watch") return new URLSearchParams(location.search).get("v");
    if (OUR_EMBED) return location.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})/)?.[1] || null;
    return null;
  }
  const txt = (sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, " ").trim() || "";
  // название и канал — со страницы (у встроенного плеера — из его шапки)
  function pageMeta(id) {
    const d = duration();
    const len = Number.isFinite(d) ? Math.round(d) : 0;
    if (OUR_EMBED) return { title: txt(".ytp-title-link"), channel: txt(".ytp-title-channel-name"), len };
    // сразу после перехода шапка ещё от прошлого видео — тогда без названия
    const flexy = document.querySelector("ytd-watch-flexy");
    if (flexy && flexy.getAttribute("video-id") !== id) return { title: "", channel: "", len };
    return {
      title: txt("ytd-watch-metadata h1") || document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, ""),
      channel: txt("ytd-watch-metadata #owner ytd-channel-name a") || txt("ytd-watch-metadata ytd-channel-name a") || txt("#owner #channel-name a"),
      len,
    };
  }

  // ---------- хранилище ----------
  let store = {};
  let hideProgress = false;
  const notesOf = (id) => store[id]?.items || [];

  // читаем свежее перед записью: заметки могли поменять в другой вкладке или в библиотеке
  async function mutate(fn) {
    const cur = C.cleanStore((await chrome.storage.local.get(KEY))[KEY]);
    const r = fn(cur);
    if (r.store !== cur) await chrome.storage.local.set({ [KEY]: r.store });
    store = r.store;
    renderAll();
    return r;
  }

  // ---------- общий стиль окон поверх плеера (как меню и плашки расширения) ----------
  const X_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
  const OK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
  const NOTE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h14v10.5L13.5 20H5z"/><path d="M13.5 20v-5.5H19"/><path d="M8.5 8.5h7M8.5 12h4"/></svg>`;

  const EDITOR_CSS = `
    :host { all: initial; position: absolute; left: 0; right: 0; bottom: var(--lift, 76px); z-index: 78;
      display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 0 16px; pointer-events: none;
      font: 500 15px/1.3 "YouTube Noto", Roboto, Arial, sans-serif; color: #f1f1f1; }
    .ed, .ok-toast { box-sizing: border-box; border-radius: 16px; background: rgba(28, 28, 30, .9);
      -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6);
      box-shadow: 0 12px 40px rgba(0, 0, 0, .45), inset 0 0 0 1px rgba(255, 255, 255, .07);
      opacity: 0; transform: translateY(8px) scale(.98); transition: opacity .16s ease, transform .22s cubic-bezier(.22, 1, .36, 1); }
    .ed { container-type: inline-size; width: min(680px, 100%); padding: 8px; zoom: var(--z, 1); }
    .ed.show, .ok-toast.show { opacity: 1; transform: none; pointer-events: auto; }
    .row { display: flex; align-items: center; gap: 8px; }
    .tc { flex: none; display: grid; place-items: center; height: 40px; padding: 0 12px; box-sizing: border-box; border-radius: 999px;
      background: #ff3b5c; color: #fff; font-weight: 700; font-variant-numeric: tabular-nums; }
    input { flex: 1 1 auto; min-width: 0; height: 40px; box-sizing: border-box; padding: 0 14px; border: 0; border-radius: 999px;
      background: rgba(255, 255, 255, .1); color: #fff; font: 400 16px/40px "YouTube Noto", Roboto, Arial, sans-serif; outline: none;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .12); transition: box-shadow .12s ease, background-color .12s ease; }
    input:focus { background: rgba(255, 255, 255, .14); box-shadow: inset 0 0 0 2px #ff3b5c; }
    input::placeholder { color: rgba(255, 255, 255, .55); }
    .btns { flex: none; display: flex; gap: 8px; }
    button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 40px; padding: 0 16px;
      box-sizing: border-box; border: 0; border-radius: 999px; font: 600 14px/1 "YouTube Noto", Roboto, Arial, sans-serif;
      cursor: pointer; white-space: nowrap; transition: background-color .12s ease; }
    button svg { width: 18px; height: 18px; flex: none; }
    /* Roboto: заглавные выше середины строки — подпись на 1 px ниже (замер tools/align, yt-note) */
    button span { position: relative; top: 1px; }
    .save { background: #ff3b5c; color: #fff; }
    .save:hover, .save:focus-visible { background: #e8002d; outline: none; }
    .cancel { background: rgba(255, 255, 255, .12); color: #fff; }
    .cancel:hover, .cancel:focus-visible { background: rgba(255, 255, 255, .22); outline: none; }
    .msg { margin: 8px 6px 2px; color: #ff8fa3; font-size: 13px; }
    .msg:empty { display: none; }
    /* узкий плеер: кнопки — второй строкой, поровну и с подписями */
    @container (max-width: 520px) {
      .row { flex-wrap: wrap; }
      input { flex-basis: 0; }
      .btns { flex: 1 1 100%; display: grid; grid-template-columns: 1fr 1fr; }
    }
    .ok-toast { display: flex; align-items: center; gap: 10px; padding: 10px 18px 10px 14px; border-radius: 999px; max-width: 100%; zoom: var(--z, 1); }
    .ok-toast svg { width: 20px; height: 20px; flex: none; color: #ff6b85; }
    .ok-toast span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ok-toast[hidden], .ed[hidden] { display: none; }
    @media (prefers-reduced-motion: reduce) { .ed, .ok-toast, input, button { transition: none; } }`;

  const ed = { host: null, root: null, open: false, t: 0, id: "", wasPlaying: false, toastTimer: 0 };

  function editorHost() {
    const p = player();
    if (!p) return null;
    if (!ed.host) {
      const host = document.createElement("div");
      host.id = "ytcs-note-editor";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${EDITOR_CSS}</style>
        <div class="ed" role="dialog" aria-label="Заметка" hidden>
          <div class="row">
            <span class="tc"></span>
            <input type="text" maxlength="${C.MAX_TEXT}" autocomplete="off" spellcheck="true" placeholder="Заметка к этому моменту — Enter сохранит" aria-label="Текст заметки" />
            <span class="btns">
              <button type="button" class="save" title="Сохранить и продолжить — Enter">${OK_SVG}<span>Сохранить</span></button>
              <button type="button" class="cancel" title="Отмена — Esc"><span>Отмена</span></button>
            </span>
          </div>
          <div class="msg" role="alert"></div>
        </div>
        <div class="ok-toast" role="status" hidden>${NOTE_SVG}<span></span></div>`;
      // клики внутри окна не должны управлять плеером (пауза, полный экран); клавиши — перехват на window (ourInput) ниже
      for (const t of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "wheel"]) {
        host.addEventListener(t, (e) => e.stopPropagation());
      }
      root.querySelector(".save").addEventListener("click", () => void save());
      root.querySelector(".cancel").addEventListener("click", () => close(true));
      root.querySelector("input").addEventListener("input", () => (root.querySelector(".msg").textContent = ""));
      ed.host = host;
      ed.root = root;
    }
    if (ed.host.parentElement !== p) p.appendChild(ed.host);
    return ed.host;
  }

  // над панелью управления: у плеера разные размеры (обычный, кинорежим, полный экран)
  function liftFor(p) {
    const pr = p.getBoundingClientRect();
    let top = Infinity;
    for (const el of [p.querySelector(".ytp-progress-bar-container"), p.querySelector(".ytp-chrome-bottom"), OUR_EMBED && document.querySelector("#player-controls .ytPlayerProgressBarHost")]) {
      const r = el?.getBoundingClientRect?.();
      if (r && r.height > 0 && r.top > pr.top) top = Math.min(top, r.top);
    }
    return Number.isFinite(top) ? Math.max(16, Math.round(pr.bottom - top + 14)) : 76;
  }
  function placeHost(host) {
    const p = player();
    if (!p || !host) return;
    host.style.setProperty("--lift", liftFor(p) + "px");
    // во весь экран на большом мониторе — крупнее
    const w = p.clientWidth || 0;
    host.style.setProperty("--z", w >= 2200 ? "1.35" : w >= 1600 ? "1.15" : "1");
  }

  function toast(text) {
    const host = editorHost();
    if (!host) return;
    placeHost(host);
    const t = ed.root.querySelector(".ok-toast");
    t.querySelector("span").textContent = text;
    t.hidden = false;
    t.classList.remove("show");
    void t.offsetHeight;
    t.classList.add("show");
    clearTimeout(ed.toastTimer);
    ed.toastTimer = setTimeout(() => {
      t.classList.remove("show");
      ed.toastTimer = setTimeout(() => (t.hidden = true), 250);
    }, 2200);
  }

  /** Открыть поле заметки на текущей секунде (клавиша N, пункт меню). */
  function open() {
    if (!alive()) return false;
    const id = videoIdNow();
    const v = mainVideo();
    if (!id || !v) return false;
    if (adShowing()) {
      toast("Заметку можно написать после рекламы");
      return true;
    }
    const host = editorHost();
    if (!host) return false;
    const box = ed.root.querySelector(".ed");
    if (!ed.open) {
      ed.wasPlaying = !v.paused && !v.ended;
      ed.t = Math.max(0, Math.floor(v.currentTime || 0));
      ed.id = id;
      v.pause();
      ed.root.querySelector("input").value = "";
      ed.root.querySelector(".msg").textContent = "";
    }
    ed.open = true;
    placeHost(host);
    ed.root.querySelector(".tc").textContent = C.fmtTime(ed.t);
    box.setAttribute("aria-label", `Заметка к моменту ${C.fmtTime(ed.t)}`);
    ed.root.querySelector(".ok-toast").hidden = true;
    box.hidden = false;
    void box.offsetHeight;
    box.classList.add("show");
    const inp = ed.root.querySelector("input");
    inp.focus({ preventScroll: true });
    // YouTube после паузы может перевести фокус на плеер — вернём его в поле
    setTimeout(() => ed.open && ed.root.activeElement !== inp && inp.focus({ preventScroll: true }), 200);
    return true;
  }

  /** resume — вернуть видео в прежнее состояние (играло — продолжить). */
  function close(resume) {
    if (!ed.open) return;
    ed.open = false;
    const box = ed.root.querySelector(".ed");
    box.classList.remove("show");
    box.hidden = true;
    if (ed.root.contains(document.activeElement) || ed.host.contains(document.activeElement)) ed.root.activeElement?.blur();
    // фокус — плееру: дальше снова работают его клавиши (пробел, стрелки, N)
    player()?.focus({ preventScroll: true });
    const v = mainVideo();
    if (resume && ed.wasPlaying && v?.paused && videoIdNow() === ed.id) void v.play().catch(() => {});
  }

  async function save() {
    if (!ed.open) return;
    const text = C.cleanText(ed.root.querySelector("input").value);
    if (!text) {
      ed.root.querySelector(".msg").textContent = "Напишите хоть пару слов — или Esc, чтобы закрыть.";
      ed.root.querySelector("input").focus({ preventScroll: true });
      return;
    }
    const id = ed.id;
    const t = ed.t;
    if (!alive()) {
      ed.root.querySelector(".msg").textContent = "Расширение обновилось — обновите страницу (F5), заметка пока не сохранится.";
      return;
    }
    let r = null;
    try {
      r = await mutate((s) => C.addNote(s, id, { t, text }, pageMeta(id)));
    } catch (e) {
      r = null;
    }
    if (!r?.note) {
      ed.root.querySelector(".msg").textContent = r?.why === "full" ? `У этого видео уже ${C.notesWord(C.MAX_NOTES)} — больше не помещается.` : "Не получилось сохранить — попробуйте ещё раз.";
      return;
    }
    close(true);
    toast(`Заметка на ${C.fmtTime(t)} сохранена`);
  }

  // ---------- клавиши в наших полях ----------
  // YouTube ловит клавиши на document в фазе перехвата — раньше, чем они дойдут до поля в
  // тени: «k» в тексте заметки ставила бы видео на паузу, «f» — во весь экран. Поэтому
  // перехватываем ещё раньше, на window: до YouTube событие не доходит, буквы в поле
  // печатаются как обычно (действие по умолчанию не отменяем), Enter и Esc — здесь же.
  function ourInput(e) {
    const path = e.composedPath?.() || [];
    const el = path[0];
    if (!(el instanceof HTMLInputElement)) return null;
    if (ed.host && path.includes(ed.host)) return "editor";
    if (lst.host && path.includes(lst.host)) return "list";
    return null;
  }
  for (const type of ["keydown", "keypress", "keyup"]) {
    window.addEventListener(
      type,
      (e) => {
        let where = ourInput(e);
        // поле заметки открыто, а фокус увёл плеер (YouTube сам ставит его на себя при паузе):
        // печатное, Backspace, Enter и Esc — всё равно в поле, а не в клавиши плеера
        if (!where && ed.open && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || /^(Enter|Escape|Backspace|Delete)$/.test(e.key))) {
          const inp = ed.root.querySelector("input");
          if (type === "keydown" && e.key.length === 1) {
            e.preventDefault();
            inp.focus({ preventScroll: true });
            inp.setRangeText(e.key, inp.selectionStart ?? inp.value.length, inp.selectionEnd ?? inp.value.length, "end");
            inp.dispatchEvent(new Event("input", { bubbles: true }));
          } else if (type === "keydown" && (e.key === "Backspace" || e.key === "Delete")) {
            e.preventDefault();
            inp.focus({ preventScroll: true });
          }
          where = "editor";
        }
        if (!where) return;
        e.stopPropagation();
        if (type !== "keydown" || e.isComposing) return;
        if (where === "editor") {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            close(true);
          }
        } else if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          onListKey(e);
        }
      },
      true
    );
  }

  // ---------- клавиша N ----------
  function typing(e) {
    const el = e.composedPath?.()[0] || e.target;
    if (!(el instanceof Element)) return false;
    return Boolean(el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']")) || el.isContentEditable;
  }
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code !== "KeyN" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || e.isComposing) return;
      if (typing(e) || !videoIdNow() || !mainVideo()) return;
      if (ed.open) {
        e.preventDefault();
        ed.root.querySelector("input").focus({ preventScroll: true });
        return;
      }
      if (open()) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  // ---------- точки на полосе прогресса ----------
  // Слой как отрезки вставок (sponsor.js), но точки нажимаются: наведение — текст заметки,
  // клик — перемотка. Подсказку YouTube (время и кадр) на это время прячем — не налезает.
  const MARKS_CSS = `
    /* visibility: inherit — панель плеера прячется через visibility: hidden, точки — вместе с ней */
    :host { all: initial; position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 43; pointer-events: none; visibility: inherit; }
    .d { position: absolute; top: 50%; width: 11px; height: 11px; margin: -5.5px 0 0 -5.5px; box-sizing: border-box; border-radius: 50%;
      background: #fff; border: 2.5px solid #ff3b5c; box-shadow: 0 0 0 1.5px rgba(0, 0, 0, .55); pointer-events: auto; cursor: pointer;
      transition: transform .14s ease, background-color .14s ease; }
    /* попасть мышью проще — невидимое поле вокруг точки */
    .d::before { content: ""; position: absolute; inset: -7px -4px; }
    .d:hover, .d.on { transform: scale(1.45); background: #ff3b5c; border-color: #fff; }
    .tip { position: absolute; bottom: 24px; left: 0; z-index: 2; width: max-content; max-width: min(320px, 80vw); box-sizing: border-box;
      padding: 9px 14px; border-radius: 12px; background: rgba(28, 28, 30, .94); color: #f1f1f1;
      box-shadow: 0 8px 30px rgba(0, 0, 0, .45), inset 0 0 0 1px rgba(255, 255, 255, .08);
      font: 500 14px/1.35 "YouTube Noto", Roboto, Arial, sans-serif; pointer-events: none; opacity: 0; transform: translateY(4px);
      transition: opacity .12s ease, transform .16s cubic-bezier(.22, 1, .36, 1); }
    .tip.show { opacity: 1; transform: none; }
    .tip b { display: block; margin-bottom: 3px; color: #ff6b85; font-weight: 700; font-variant-numeric: tabular-nums; }
    .tip span { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
    .tip i { display: block; margin-top: 4px; color: rgba(255, 255, 255, .55); font-style: normal; font-size: 12px; }
    @media (prefers-reduced-motion: reduce) { .d, .tip { transition: none; } }`;
  let marks = null;
  let marksKey = "";
  const HOVER_STYLE = "#movie_player.ytcs-note-hover .ytp-tooltip { opacity: 0 !important; visibility: hidden !important; }";

  function ensureHoverStyle() {
    if (document.getElementById("ytcs-note-style")) return;
    const st = document.createElement("style");
    st.id = "ytcs-note-style";
    st.textContent = HOVER_STYLE;
    (document.head || document.documentElement).appendChild(st);
  }

  function marksHost(bar) {
    if (!marks) {
      marks = document.createElement("div");
      marks.id = "ytcs-note-marks";
      const root = marks.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${MARKS_CSS}</style><div class="dots"></div><div class="tip" role="tooltip"><b></b><span></span><i>Клик — перейти</i></div>`;
      const stop = (e) => {
        if (e.composedPath()[0]?.classList?.contains("d")) e.stopPropagation();
      };
      // нажатие на точку — наше: полоса YouTube не начинает перетаскивание
      for (const t of ["mousedown", "pointerdown", "mouseup", "pointerup", "touchstart", "dblclick"]) marks.addEventListener(t, stop);
      for (const t of ["mousemove", "pointermove", "mouseover"]) marks.addEventListener(t, stop);
      root.addEventListener("click", (e) => {
        const d = e.target.closest?.(".d");
        if (!d) return;
        e.stopPropagation();
        const v = mainVideo();
        if (v) v.currentTime = Number(d.dataset.t) || 0;
      });
      root.addEventListener("mouseover", (e) => {
        const d = e.target.closest?.(".d");
        if (d) showTip(d);
      });
      root.addEventListener("mouseout", (e) => {
        const d = e.target.closest?.(".d");
        if (d && !d.contains(e.relatedTarget)) hideTip();
      });
    }
    if (marks.parentElement !== bar) {
      bar.appendChild(marks);
      // точки ставятся по ширине полосы — ей нужна своя система координат
      if (getComputedStyle(bar).position === "static") bar.style.position = "relative";
    }
    return marks;
  }

  function showTip(d) {
    ensureHoverStyle();
    player()?.classList.add("ytcs-note-hover");
    const root = marks.shadowRoot;
    const tip = root.querySelector(".tip");
    tip.querySelector("b").textContent = C.fmtTime(d.dataset.t);
    tip.querySelector("span").textContent = d.dataset.text || "";
    const barW = marks.clientWidth || 1;
    const x = d.offsetLeft;
    tip.style.left = "0px";
    const w = tip.offsetWidth;
    tip.style.left = Math.round(Math.max(0, Math.min(barW - w, x - w / 2))) + "px";
    root.querySelectorAll(".d.on").forEach((o) => o.classList.remove("on"));
    d.classList.add("on");
    tip.classList.add("show");
  }
  function hideTip() {
    player()?.classList.remove("ytcs-note-hover");
    if (!marks) return;
    marks.shadowRoot.querySelector(".tip").classList.remove("show");
    marks.shadowRoot.querySelectorAll(".d.on").forEach((o) => o.classList.remove("on"));
  }

  function renderMarks() {
    const id = videoIdNow();
    const bar = progressBar();
    const d = mainVideo() && !adShowing() ? duration() : NaN;
    const items = id ? notesOf(id) : [];
    const show = !hideProgress && bar && items.length && Number.isFinite(d) && d > 0;
    if (!show) {
      if (marks?.isConnected) {
        hideTip();
        marks.remove();
      }
      marksKey = "";
      return;
    }
    const host = marksHost(bar);
    const key = `${id}|${d}|${items.map((n) => `${n.t}:${n.at}:${n.text}`).join("|")}`;
    if (key === marksKey && host.shadowRoot.querySelector(".dots").childElementCount) return;
    marksKey = key;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    host.shadowRoot.querySelector(".dots").innerHTML = items
      .filter((n) => n.t <= d + 1)
      .map((n) => {
        const l = Math.max(0, Math.min(100, (n.t / d) * 100));
        return `<span class="d" style="left:${l.toFixed(3)}%" data-t="${n.t}" data-text="${esc(n.text)}" aria-label="${esc(`${C.fmtTime(n.t)} — ${n.text}`)}"></span>`;
      })
      .join("");
  }

  // ---------- список заметок рядом с плеером (страница видео) ----------
  const LIST_CSS = `
    :host { all: initial; display: block; margin: 0 0 16px; }
    :host([below]) { margin: 12px 0 0; }
    .box { font: 400 14px/1.4 Roboto, Arial, sans-serif; color: #0f0f0f; border: 1px solid rgba(0,0,0,.1);
      border-radius: 12px; overflow: hidden; background: #fff; container-type: inline-size; }
    :host([dark]) .box { color: #f1f1f1; border-color: rgba(255,255,255,.2); background: #0f0f0f; }
    .head { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid rgba(0,0,0,.08); }
    :host([dark]) .head { border-bottom-color: rgba(255,255,255,.12); }
    .ttl { flex: 1; min-width: 0; }
    .ttl b { display: block; font: 700 20px/1.3 Roboto, Arial, sans-serif; }
    .ttl span { display: block; margin-top: 2px; color: #606060; font-size: 14px; }
    :host([dark]) .ttl span { color: #aaa; }
    kbd { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 5px; box-sizing: border-box;
      border: 1px solid rgba(0,0,0,.2); border-radius: 5px; font: 500 12px/1 Roboto, Arial, sans-serif; vertical-align: 1px; }
    :host([dark]) kbd { border-color: rgba(255,255,255,.3); }
    .pill { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 36px; padding: 0 14px; box-sizing: border-box;
      border: 0; border-radius: 18px; background: rgba(0,0,0,.05); color: inherit; font: 500 14px/1 Roboto, Arial, sans-serif;
      cursor: pointer; white-space: nowrap; transition: background-color .15s ease; }
    :host([dark]) .pill { background: rgba(255,255,255,.1); }
    .pill:hover { background: rgba(0,0,0,.1); }
    :host([dark]) .pill:hover { background: rgba(255,255,255,.2); }
    .pill svg { width: 18px; height: 18px; flex: none; }
    .pill.main, :host([dark]) .pill.main { background: #e8002d; color: #fff; font-weight: 600; }
    :host([dark]) .pill.main { background: #ff3b5c; }
    .pill.main:hover { background: #c80027; }
    :host([dark]) .pill.main:hover { background: #ff2149; }
    button:focus-visible, input:focus-visible { outline: 2px solid #ff3b5c; outline-offset: 2px; }
    .list { list-style: none; margin: 0; padding: 6px 8px 8px; max-height: min(420px, 55vh); overflow: auto; scrollbar-width: thin; }
    .list.scroll { overscroll-behavior: contain; }
    .row { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 4px 4px 4px 8px; border-radius: 10px; }
    .row:hover, .row:focus-within { background: rgba(0,0,0,.05); }
    :host([dark]) .row:hover, :host([dark]) .row:focus-within { background: rgba(255,255,255,.08); }
    .tc { flex: none; display: grid; place-items: center; min-width: 56px; height: 30px; padding: 0 10px; box-sizing: border-box; border: 0; border-radius: 15px;
      background: rgba(232,0,45,.1); color: #c80027; font: 700 13px/1 Roboto, Arial, sans-serif; font-variant-numeric: tabular-nums; cursor: pointer;
      transition: background-color .15s ease, color .15s ease; }
    :host([dark]) .tc { background: rgba(255,59,92,.16); color: #ff6b85; }
    .tc:hover, :host([dark]) .tc:hover { background: #e8002d; color: #fff; }
    :host([dark]) .tc:hover { background: #ff3b5c; }
    .tx { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 14px; line-height: 1.4; padding: 4px 0; }
    .acts { flex: none; display: flex; gap: 2px; opacity: .55; transition: opacity .15s ease; }
    .row:hover .acts, .row:focus-within .acts { opacity: 1; }
    .ib { display: grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 0; border-radius: 50%; background: none; color: inherit;
      cursor: pointer; transition: background-color .15s ease, color .15s ease; }
    .ib svg { width: 18px; height: 18px; }
    .ib:hover { background: rgba(0,0,0,.1); }
    :host([dark]) .ib:hover { background: rgba(255,255,255,.16); }
    .ib.del:hover { color: #e8002d; }
    :host([dark]) .ib.del:hover { color: #ff6b85; }
    .edit { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 2px 0; }
    .edit input { flex: 1 1 160px; min-width: 0; height: 36px; box-sizing: border-box; padding: 0 12px; border: 1px solid rgba(0,0,0,.2); border-radius: 18px;
      background: transparent; color: inherit; font: 400 14px/34px Roboto, Arial, sans-serif; outline: none; }
    :host([dark]) .edit input { border-color: rgba(255,255,255,.25); }
    .edit input:focus { border-color: #ff3b5c; box-shadow: 0 0 0 1px #ff3b5c; }
    .edit .eb { display: flex; gap: 8px; }
    .note { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 8px 8px; padding: 6px 6px 6px 14px;
      border-radius: 10px; background: rgba(255,59,92,.1); font-size: 14px; }
    .note[hidden] { display: none; }
    @container (max-width: 340px) { .hb .lbl { display: none; } .hb .pill { width: 36px; padding: 0; } }
    @media (prefers-reduced-motion: reduce) { .pill, .tc, .acts, .ib { transition: none; } }`;
  const LIST_SVG = {
    copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>`,
    edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>`,
    del: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10 11v5.5M14 11v5.5"/></svg>`,
    undo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>`,
    check: OK_SVG,
  };

  const lst = { host: null, editing: 0, undo: null, undoTimer: 0, copied: 0, key: "" };
  const escH = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // правая колонка; в узком окне YouTube прячет её целиком (рекомендации переезжают под
  // видео) — тогда список встаёт сразу под описанием видео
  function listSlot() {
    const side = document.querySelector("ytd-watch-flexy #secondary-inner") || document.querySelector("ytd-watch-flexy #secondary");
    if (side && side.getClientRects().length && side.offsetWidth > 0) return { place: side, after: null };
    const meta = document.querySelector("ytd-watch-flexy #below ytd-watch-metadata");
    if (meta?.parentElement) return { place: meta.parentElement, after: meta };
    return side ? { place: side, after: null } : null;
  }

  function listHost({ place, after }) {
    if (!lst.host) {
      const host = document.createElement("div");
      host.id = "ytcs-notes";
      host.attachShadow({ mode: "open" });
      host.shadowRoot.addEventListener("click", onListClick); // клавиши в поле правки — перехват на window (ourInput)
      lst.host = host;
    }
    lst.host.toggleAttribute("below", Boolean(after));
    if (after) {
      if (after.nextElementSibling !== lst.host) after.after(lst.host);
      return lst.host;
    }
    // под колонкой очереди, если она есть (queue.js ставит её первой), иначе — первым
    const q = place.querySelector(":scope > #ytcs-queue");
    if (q) {
      if (q.nextElementSibling !== lst.host) q.after(lst.host);
    } else if (lst.host.parentElement !== place || place.firstElementChild !== lst.host) {
      place.prepend(lst.host);
    }
    return lst.host;
  }

  function renderList(force = false) {
    if (OUR_EMBED || location.pathname !== "/watch") {
      lst.host?.remove();
      return;
    }
    const id = videoIdNow();
    const items = id ? notesOf(id) : [];
    const undo = lst.undo && lst.undo.id === id ? lst.undo : null;
    if (!items.length && !undo) {
      lst.host?.remove();
      lst.key = "";
      return;
    }
    const slot = listSlot();
    if (!slot) return;
    const host = listHost(slot);
    host.toggleAttribute("dark", document.documentElement.hasAttribute("dark"));
    const key = `${id}|${lst.editing}|${lst.copied}|${undo?.note.at || 0}|${items.map((n) => `${n.t}:${n.at}:${n.text}`).join("|")}`;
    if (!force && key === lst.key && host.shadowRoot.childElementCount) return;
    lst.key = key;
    const keepScroll = host.shadowRoot.querySelector(".list")?.scrollTop || 0;
    const row = (n) =>
      lst.editing === n.at
        ? `<li class="row" data-at="${n.at}">
            <button type="button" class="tc" data-seek="${n.t}" title="Перейти к ${C.fmtTime(n.t)}">${C.fmtTime(n.t)}</button>
            <span class="edit"><input type="text" maxlength="${C.MAX_TEXT}" value="${escH(n.text)}" aria-label="Текст заметки" />
              <span class="eb"><button type="button" class="pill main" data-act="save">${LIST_SVG.check}Сохранить</button><button type="button" class="pill" data-act="cancel">Отмена</button></span></span>
          </li>`
        : `<li class="row" data-at="${n.at}">
            <button type="button" class="tc" data-seek="${n.t}" title="Перейти к ${C.fmtTime(n.t)}">${C.fmtTime(n.t)}</button>
            <span class="tx">${escH(n.text)}</span>
            <span class="acts">
              <button type="button" class="ib" data-act="edit" title="Изменить" aria-label="Изменить заметку">${LIST_SVG.edit}</button>
              <button type="button" class="ib del" data-act="del" title="Удалить" aria-label="Удалить заметку">${LIST_SVG.del}</button>
            </span>
          </li>`;
    host.shadowRoot.innerHTML = `<style>${LIST_CSS}</style>
      <div class="box" role="region" aria-label="Заметки к видео">
        <div class="head">
          <div class="ttl"><b>Заметки</b><span>${items.length ? C.notesWord(items.length) : "нет заметок"} · новая — <kbd>N</kbd></span></div>
          <div class="hb">${items.length ? `<button type="button" class="pill" data-act="copy" title="Скопировать заметки с таймкодами-ссылками">${lst.copied ? LIST_SVG.check : LIST_SVG.copy}<span class="lbl">${lst.copied ? "Скопировано" : "Копировать"}</span></button>` : ""}</div>
        </div>
        ${undo ? `<div class="note" role="status"><span>Заметка на ${C.fmtTime(undo.note.t)} удалена</span><button type="button" class="pill" data-act="undo">${LIST_SVG.undo}Вернуть</button></div>` : ""}
        ${items.length ? `<ol class="list">${items.map(row).join("")}</ol>` : ""}
      </div>`;
    const list = host.shadowRoot.querySelector(".list");
    if (list) {
      list.scrollTop = keepScroll;
      list.classList.toggle("scroll", list.scrollHeight > list.clientHeight + 1);
    }
    if (lst.editing) {
      const inp = host.shadowRoot.querySelector(".edit input");
      if (inp && host.shadowRoot.activeElement !== inp) {
        inp.focus({ preventScroll: true });
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }
    }
  }

  async function onListClick(e) {
    const seek = e.target.closest("[data-seek]");
    const id = videoIdNow();
    if (seek) {
      const v = mainVideo();
      if (v) v.currentTime = Number(seek.dataset.seek) || 0;
      return;
    }
    const b = e.target.closest("[data-act]");
    if (!b || !id) return;
    const at = Number(b.closest("[data-at]")?.dataset.at) || 0;
    const act = b.dataset.act;
    if (act === "edit") {
      lst.editing = at;
      renderList();
    } else if (act === "cancel") {
      lst.editing = 0;
      renderList();
    } else if (act === "save") {
      await saveEdit(id, at);
    } else if (act === "del") {
      await removeWithUndo(id, at);
    } else if (act === "undo") {
      const u = lst.undo;
      lst.undo = null;
      clearTimeout(lst.undoTimer);
      if (u) await mutate((s) => C.restoreNote(s, u.id, u.note, u.meta));
      renderList(true);
    } else if (act === "copy") {
      const v = { id, ...(store[id] || {}), items: notesOf(id) };
      try {
        await navigator.clipboard.writeText(C.exportText([v]));
        lst.copied = Date.now();
        renderList();
        setTimeout(() => {
          lst.copied = 0;
          renderList();
        }, 1600);
      } catch (err) {
        /* буфер недоступен — ничего */
      }
    }
  }

  async function saveEdit(id, at) {
    const inp = lst.host?.shadowRoot.querySelector(".edit input");
    const text = C.cleanText(inp?.value);
    lst.editing = 0;
    if (!text) return removeWithUndo(id, at); // стёрли текст — значит, удалить
    await mutate((s) => C.updateNote(s, id, at, text));
    renderList(true);
  }

  async function removeWithUndo(id, at) {
    if (lst.editing === at) lst.editing = 0;
    const r = await mutate((s) => C.removeNote(s, id, at));
    if (!r.note) return;
    lst.undo = { id, note: r.note, meta: r.meta };
    clearTimeout(lst.undoTimer);
    lst.undoTimer = setTimeout(() => {
      lst.undo = null;
      renderList(true);
    }, 8000);
    renderList(true);
  }

  function onListKey(e) {
    const inp = e.composedPath()[0];
    if (!inp?.closest?.(".edit")) return;
    const at = Number(inp.closest("[data-at]")?.dataset.at) || 0;
    if (e.key === "Enter") {
      e.preventDefault();
      void saveEdit(videoIdNow(), at);
    } else if (e.key === "Escape") {
      e.preventDefault();
      lst.editing = 0;
      renderList();
    }
  }

  function renderAll() {
    renderMarks();
    renderList();
  }

  // ---------- переходы и подписки ----------
  let curVid = null;
  function onNavigate() {
    const id = videoIdNow();
    if (id === curVid) return;
    curVid = id;
    if (ed.open) close(false);
    lst.editing = 0;
    if (lst.undo && lst.undo.id !== id) lst.undo = null;
    renderAll();
  }
  const isMain = (e) => e.target instanceof HTMLVideoElement && e.target.classList.contains("html5-main-video");
  for (const t of ["loadedmetadata", "durationchange"]) {
    document.addEventListener(t, (e) => isMain(e) && (onNavigate(), renderMarks()), true);
  }
  window.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("popstate", onNavigate);
  window.addEventListener("resize", () => ed.open && placeHost(ed.host));
  // полоса и колонка перерисовываются YouTube — раз в секунду дёшево проверяем
  setInterval(() => {
    if (!alive()) return;
    onNavigate();
    const id = curVid;
    if (id && notesOf(id).length) {
      if (!marks?.isConnected) {
        marksKey = "";
        renderMarks();
      } else renderMarks();
      const slot = !OUR_EMBED && lst.host ? listSlot() : null;
      const moved = slot && (slot.after ? slot.after.nextElementSibling !== lst.host : lst.host.parentElement !== slot.place);
      if (!OUR_EMBED && (!lst.host?.isConnected || moved || lst.host.hasAttribute("dark") !== document.documentElement.hasAttribute("dark"))) renderList(true);
    }
  }, 1000);

  globalThis.__ytcsNotes = { open, close: () => close(true), count: () => notesOf(videoIdNow()).length };
  // встроенный плеер: «Моя библиотека» передаёт N, нажатую на её странице (фокус был не в плеере)
  if (OUR_EMBED) {
    window.addEventListener("message", (e) => {
      let ok = false;
      try {
        ok = e.origin === `chrome-extension://${chrome.runtime.id}` && e.data?.ytcsNote === "open";
      } catch (err) {
        ok = false;
      }
      if (ok) open();
    });
  }

  if (!alive()) return;
  chrome.storage.local
    .get([KEY, "settings"])
    .then((o) => {
      store = C.cleanStore(o[KEY]);
      hideProgress = Boolean(o.settings?.hideProgress);
      onNavigate();
      renderAll();
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[KEY]) store = C.cleanStore(changes[KEY].newValue);
    if (changes.settings) hideProgress = Boolean(changes.settings.newValue?.hideProgress);
    if (changes[KEY] || changes.settings) renderAll();
  });
})();
