"use strict";

// «Поиск по речи» в открытом видео (страница YouTube и встроенный плеер «Моей библиотеки»):
//  - Ctrl+Shift+F или «Поиск по речи» в меню кнопки расширения — поверх плеера поле;
//  - вводите слово — ниже места, где его говорят: таймкод и фраза с подсвеченным словом;
//  - клик или Enter — перемотка туда (и воспроизведение), ↑/↓ — по списку, Esc — закрыть;
//  - нет субтитров — так и говорит: «У видео нет субтитров».
// Субтитры — тем же путём, что «О видео» в панели (content.js → transcript.js: get_panel,
// запасные timedtext и панель «Расшифровка»), один раз на видео. Логика поиска без DOM —
// speech-core.js (globalThis.__ytcsSpeechCore), слова и основы — words-core.js.
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
  if (globalThis.__ytcsSpeech) return;
  const S = globalThis.__ytcsSpeechCore;
  if (!S) return;
  const OUR_EMBED = location.pathname.startsWith("/embed/");
  const MAX_ROWS = 300; // строк в списке; остальные — «уточните запрос»

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
  function videoIdNow() {
    if (location.pathname === "/watch") return new URLSearchParams(location.search).get("v");
    if (OUR_EMBED) return location.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})/)?.[1] || null;
    return null;
  }

  // ---------- субтитры: один раз на видео ----------
  // id → { state: "loading" | "ok" | "none" | "error", index, promise }
  const cache = new Map();
  function load(id, again = false) {
    let c = cache.get(id);
    // «нет субтитров» тоже не навсегда: YouTube мог временно отдать пусто — через 30 с спросим снова
    if (c && !(again && c.state === "error") && !(c.state === "none" && Date.now() - c.at > 30000)) return c;
    c = { state: "loading", index: null, promise: null, at: Date.now() };
    cache.delete(id);
    cache.set(id, c);
    if (cache.size > 6) cache.delete(cache.keys().next().value);
    // content.js — с запасными путями; без него (не должен) — прямо transcript.js
    const get = globalThis.__ytcsGetTranscript || ((v) => globalThis.__ytcsTranscript.fetchTranscript(v, {}));
    c.promise = Promise.resolve()
      .then(() => get(id))
      .then((r) => {
        const segs = r?.segments || [];
        c.index = segs.length ? S.buildIndex(segs) : null;
        c.state = c.index?.segs.length ? "ok" : "none";
      })
      .catch((e) => {
        console.warn("[ytcs] поиск по речи: субтитры не загрузились", e);
        c.state = "error";
      })
      .finally(() => {
        if (ui.open && ui.id === id) render();
      });
    return c;
  }

  // ---------- окно ----------
  const SVG = (d, w = "2") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICONS = {
    // лупа со звуком внутри — тот же знак, что у пункта меню
    find: SVG('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.3 15.3L20 20"/><path d="M8.3 9.3v2.4M10.5 8v5M12.7 9.3v2.4"/>', "1.9"),
    x: SVG('<path d="M6 6l12 12M18 6L6 18"/>', "2.2"),
    subs: SVG('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 10.5h10M7 14.5h6.5"/><path d="M4 4l16 16"/>', "1.8"),
    alert: SVG('<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/><path d="M12 17.5v.01"/>', "1.8"),
    spin: '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" opacity=".25"/><path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5"/></svg>',
  };

  // Размеры — целыми пикселями (дробные дают подписи «плавающие» на полпикселя); во весь экран
  // на большом мониторе окно целиком крупнее (zoom: --z), высоту под него считает place() (--maxh)
  const CSS = `
    :host { all: initial; position: absolute; left: 0; right: 0; top: var(--top, 12px); z-index: 79;
      display: flex; justify-content: center; padding: 0 16px; box-sizing: border-box; pointer-events: none;
      font: 500 15px/20px "YouTube Noto", Roboto, Arial, sans-serif; color: #f1f1f1; }
    .box { container-type: inline-size; display: flex; flex-direction: column; width: min(700px, 100%); max-height: var(--maxh, 420px); min-height: 0;
      box-sizing: border-box; padding: 8px; border-radius: 18px; background: rgba(28, 28, 30, .92); zoom: var(--z, 1);
      -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6);
      box-shadow: 0 12px 40px rgba(0, 0, 0, .5), inset 0 0 0 1px rgba(255, 255, 255, .07);
      opacity: 0; transform: translateY(-8px) scale(.98); transition: opacity .16s ease, transform .22s cubic-bezier(.22, 1, .36, 1); }
    .box.show { opacity: 1; transform: none; pointer-events: auto; }
    .box[hidden] { display: none; }
    .row { flex: none; display: flex; align-items: center; gap: 8px; }
    .field { position: relative; flex: 1 1 auto; min-width: 0; display: flex; }
    .field svg { position: absolute; left: 13px; top: 11px; width: 20px; height: 20px; color: rgba(255, 255, 255, .6); pointer-events: none; }
    input { flex: 1 1 auto; min-width: 0; height: 42px; box-sizing: border-box; padding: 0 16px 0 42px; border: 0; border-radius: 999px;
      background: rgba(255, 255, 255, .1); color: #fff; font: 400 16px/42px "YouTube Noto", Roboto, Arial, sans-serif; outline: none;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .12); transition: box-shadow .12s ease, background-color .12s ease; }
    input:focus { background: rgba(255, 255, 255, .14); box-shadow: inset 0 0 0 2px #ff3b5c; }
    input::placeholder { color: rgba(255, 255, 255, .55); }
    button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 0; cursor: pointer;
      font: 600 14px/1 "YouTube Noto", Roboto, Arial, sans-serif; transition: background-color .12s ease; }
    button svg { width: 20px; height: 20px; flex: none; }
    .x { flex: none; width: 42px; height: 42px; padding: 0; border-radius: 50%; background: rgba(255, 255, 255, .1); color: #fff; }
    .x:hover, .x:focus-visible { background: rgba(255, 255, 255, .22); outline: none; }
    /* строка итога и состояния — по центру */
    .state { flex: none; display: flex; align-items: center; justify-content: center; gap: 8px; margin: 10px 8px 2px; text-align: center;
      color: rgba(255, 255, 255, .72); font-size: 14px; line-height: 20px; }
    .state:empty { display: none; }
    .state b { color: #fff; font-weight: 700; }
    .state svg { width: 20px; height: 20px; flex: none; }
    .spin { animation: spin .9s linear infinite; color: #ff6b85; }
    @keyframes spin { to { transform: rotate(360deg); } }
    /* плашка «нет субтитров» / «не загрузились» — крупно, по центру */
    .plate { flex: none; display: flex; flex-direction: column; align-items: center; gap: 6px; margin: 10px 4px 4px; padding: 16px 18px;
      border-radius: 14px; background: rgba(255, 255, 255, .06); text-align: center; }
    .plate[hidden] { display: none; }
    .plate svg { width: 30px; height: 30px; color: #ff6b85; }
    .plate .ttl { font-size: 16px; line-height: 22px; font-weight: 700; color: #fff; }
    .plate .sub { max-width: 440px; color: rgba(255, 255, 255, .65); font-size: 14px; font-weight: 400; }
    .again { height: 36px; margin-top: 6px; padding: 0 18px; border-radius: 999px; background: #ff3b5c; color: #fff; }
    .again:hover, .again:focus-visible { background: #e8002d; outline: none; }
    /* Roboto: заглавные выше середины строки — подпись на 1 px ниже (как в окне заметки) */
    .again span { position: relative; top: 1px; }
    .list { flex: 1 1 auto; min-height: 0; margin: 6px 0 0; padding: 0 2px 0 0; list-style: none; overflow-y: auto; overscroll-behavior: contain;
      scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, .25) transparent; }
    .list:empty { display: none; }
    .it { display: flex; align-items: flex-start; gap: 12px; padding: 8px 10px; border-radius: 12px; cursor: pointer; }
    .it:hover { background: rgba(255, 255, 255, .06); }
    .it[aria-selected="true"] { background: rgba(255, 255, 255, .12); }
    /* таймкод-таблетка: Roboto — цифры выше середины, отступ сверху на 1 px больше (замер tools/align, yt-speech) */
    .tc { flex: none; display: grid; place-items: center; min-width: 54px; height: 24px; padding: 1px 8px 0; box-sizing: border-box; border-radius: 999px;
      background: rgba(255, 59, 92, .18); color: #ff8fa3; font: 700 14px/1 "YouTube Noto", Roboto, Arial, sans-serif; font-variant-numeric: tabular-nums; }
    .it[aria-selected="true"] .tc { background: #ff3b5c; color: #fff; }
    /* есть места после часа — все таймкоды одной ширины, текст в одну колонку */
    .list.hours .tc { min-width: 74px; }
    .tx { flex: 1 1 auto; min-width: 0; padding-top: 2px; color: rgba(255, 255, 255, .88); font-weight: 400; overflow-wrap: anywhere;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    mark { background: rgba(255, 59, 92, .34); color: #fff; font-weight: 700; border-radius: 4px; padding: 0 2px; }
    .more { padding: 8px 10px 2px; color: rgba(255, 255, 255, .55); font-size: 13px; text-align: center; cursor: default; }
    .foot { flex: none; display: flex; justify-content: center; flex-wrap: wrap; gap: 4px 16px; margin: 8px 6px 2px; color: rgba(255, 255, 255, .5); font-size: 12px; line-height: 20px; }
    .foot[hidden] { display: none; }
    .foot > span { display: inline-flex; align-items: center; gap: 5px; }
    /* клавиша: ровно 20 px — подпись по центру без сдвигов (замер tools/align, yt-speech) */
    kbd { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 6px; box-sizing: border-box; border-radius: 6px;
      background: rgba(255, 255, 255, .12); color: rgba(255, 255, 255, .85); font: 600 12px/1 "YouTube Noto", Roboto, Arial, sans-serif; }
    :host([compact]) .foot { display: none; }
    :host([compact]) .state { margin-top: 6px; }
    /* узкий плеер: без подсказок по клавишам, строки плотнее */
    @container (max-width: 460px) {
      .foot { display: none; }
      .it { gap: 8px; padding: 8px 6px; }
      .tc { min-width: 48px; }
      .list.hours .tc { min-width: 68px; }
    }
    @media (prefers-reduced-motion: reduce) { .box, input, button { transition: none; } .spin { animation-duration: 2.4s; } }`;

  const ui = { host: null, root: null, open: false, id: "", q: "", res: null, sel: -1, wasQ: new Map() };

  function host() {
    const p = player();
    if (!p) return null;
    if (!ui.host) {
      const h = document.createElement("div");
      h.id = "ytcs-speech";
      const root = h.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${CSS}</style>
        <div class="box" role="dialog" aria-label="Поиск по речи" hidden>
          <div class="row">
            <label class="field">${ICONS.find}<input type="text" autocomplete="off" spellcheck="false" maxlength="80"
              placeholder="Слово или фраза из речи" aria-label="Что ищем в речи" role="combobox" aria-expanded="true" aria-controls="ytcs-speech-list" /></label>
            <button type="button" class="x" title="Закрыть — Esc" aria-label="Закрыть">${ICONS.x}</button>
          </div>
          <div class="state" role="status" aria-live="polite"></div>
          <div class="plate" hidden></div>
          <ul class="list" id="ytcs-speech-list" role="listbox" aria-label="Где это говорят"></ul>
          <div class="foot"><span><kbd>↑</kbd> <kbd>↓</kbd> выбрать</span><span><kbd>Enter</kbd> перейти</span><span><kbd>Esc</kbd> закрыть</span></div>
        </div>`;
      // клики внутри окна не должны управлять плеером (пауза, полный экран)
      for (const t of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "wheel", "contextmenu"]) {
        h.addEventListener(t, (e) => e.stopPropagation());
      }
      root.querySelector(".x").addEventListener("click", () => close());
      const inp = root.querySelector("input");
      inp.addEventListener("input", () => {
        ui.q = inp.value;
        ui.sel = -1;
        render();
      });
      const list = root.querySelector(".list");
      list.addEventListener("click", (e) => {
        const it = e.target.closest?.(".it");
        if (it) go(Number(it.dataset.i));
      });
      // мышь над строкой не меняет выбор (как у подсказок поиска) — только клик
      root.querySelector(".plate").addEventListener("click", (e) => {
        if (e.target.closest?.(".again")) {
          load(ui.id, true);
          render();
        }
      });
      ui.host = h;
      ui.root = root;
    }
    // в новом встроенном плеере библиотеки — в слой над его панелью управления (иначе не нажимается)
    const into = globalThis.__ytcsPlayerLayer?.(p) || p;
    if (ui.host.parentElement !== into) into.appendChild(ui.host);
    return ui.host;
  }

  // между верхом плеера и панелью управления: у плеера разные размеры (обычный, кинорежим, полный экран)
  function place() {
    const p = player();
    if (!p || !ui.host) return;
    const pr = p.getBoundingClientRect();
    let top = Infinity;
    for (const el of [p.querySelector(".ytp-progress-bar-container"), p.querySelector(".ytp-chrome-bottom"), OUR_EMBED && document.querySelector("#player-controls .ytPlayerProgressBarHost")]) {
      const r = el?.getBoundingClientRect?.();
      if (r && r.height > 0 && r.top > pr.top) top = Math.min(top, r.top);
    }
    const lift = Number.isFinite(top) ? Math.max(12, Math.round(pr.bottom - top + 10)) : 64;
    const w = p.clientWidth || 0;
    const h = p.clientHeight || 0;
    const topGap = h >= 600 ? 20 : 10;
    // во весь экран на большом мониторе — крупнее
    const z = w >= 2200 ? 1.35 : w >= 1600 ? 1.15 : 1;
    ui.host.style.setProperty("--top", topGap + "px");
    ui.host.style.setProperty("--z", String(z));
    // окно — между верхом плеера и полосой прогресса (в своих, не увеличенных пикселях)
    const maxh = Math.max(90, Math.floor((h - topGap - lift) / z));
    ui.host.style.setProperty("--maxh", maxh + "px");
    // низкий плеер — без подсказок по клавишам: место под список
    ui.host.toggleAttribute("compact", maxh < 280);
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function setPlate(kind) {
    const plate = ui.root.querySelector(".plate");
    if (!kind) {
      plate.hidden = true;
      plate.innerHTML = "";
      return;
    }
    plate.hidden = false;
    plate.innerHTML =
      kind === "none"
        ? `${ICONS.subs}<div class="ttl">У видео нет субтитров</div><div class="sub">Искать не в чем: у этого видео нет ни своих, ни автоматических субтитров YouTube.</div>`
        : `${ICONS.alert}<div class="ttl">Не получилось загрузить субтитры</div><div class="sub">Проверьте интернет. Если не поможет — обновите страницу (F5).</div><button type="button" class="again"><span>Ещё раз</span></button>`;
  }

  function render() {
    if (!ui.root) return;
    const state = ui.root.querySelector(".state");
    const list = ui.root.querySelector(".list");
    const foot = ui.root.querySelector(".foot");
    const inp = ui.root.querySelector("input");
    const c = cache.get(ui.id) || { state: "loading" };
    ui.res = null;
    list.innerHTML = "";
    foot.hidden = true;
    inp.setAttribute("aria-activedescendant", "");
    if (c.state === "loading") {
      setPlate(null);
      state.innerHTML = `${ICONS.spin}<span>Загружаю субтитры…</span>`;
      return;
    }
    if (c.state !== "ok") {
      state.innerHTML = "";
      setPlate(c.state === "none" ? "none" : "error");
      return;
    }
    setPlate(null);
    const res = S.find(c.index, ui.q);
    if (!res) {
      state.innerHTML = `<span>Введите слово — покажу, где его говорят</span>`;
      return;
    }
    if (!res.results.length) {
      state.innerHTML = `<span>«${esc(ui.q.trim())}» в речи не звучит</span>`;
      return;
    }
    ui.res = res;
    const n = res.results.length;
    state.innerHTML = res.partial ? `<span>Подряд не нашлось. Все слова рядом — <b>${S.placesWord(n)}</b></span>` : `<span>Нашлось <b>${S.placesWord(n)}</b></span>`;
    if (ui.sel < 0 || ui.sel >= n) ui.sel = S.nearest(res.results, mainVideo()?.currentTime);
    const rows = [];
    res.results.slice(0, MAX_ROWS).forEach((r, i) => {
      const text = S.snippet(c.index, r)
        .map((p) => (p.hit ? `<mark>${esc(p.t)}</mark>` : esc(p.t)))
        .join("");
      rows.push(`<li class="it" role="option" id="ytcs-sp-${i}" data-i="${i}" aria-selected="${i === ui.sel}" title="Перейти к ${S.fmtTime(r.t)}"><span class="tc">${S.fmtTime(r.t)}</span><span class="tx">${text}</span></li>`);
    });
    if (n > MAX_ROWS) rows.push(`<li class="more" role="presentation">Показаны первые ${MAX_ROWS} — уточните запрос</li>`);
    list.innerHTML = rows.join("");
    list.classList.toggle("hours", res.results.some((r) => r.t >= 3600));
    foot.hidden = false;
    if (ui.sel >= MAX_ROWS) ui.sel = MAX_ROWS - 1;
    showSel(false);
  }

  // выбранная строка — видна в списке (прокрутка только списка, не страницы)
  function showSel(smooth) {
    const list = ui.root.querySelector(".list");
    list.querySelectorAll('.it[aria-selected="true"]').forEach((el) => el.setAttribute("aria-selected", "false"));
    const el = list.querySelector(`.it[data-i="${ui.sel}"]`);
    if (!el) return;
    el.setAttribute("aria-selected", "true");
    ui.root.querySelector("input").setAttribute("aria-activedescendant", el.id);
    const top = el.offsetTop - list.offsetTop;
    const pad = 6;
    let to = null;
    if (top < list.scrollTop + pad) to = top - pad;
    else if (top + el.offsetHeight > list.scrollTop + list.clientHeight - pad) to = top + el.offsetHeight - list.clientHeight + pad;
    if (to != null) list.scrollTo({ top: Math.max(0, to), behavior: smooth ? "smooth" : "auto" });
  }

  function move(d) {
    const n = Math.min(ui.res?.results.length || 0, MAX_ROWS);
    if (!n) return;
    ui.sel = ui.sel < 0 ? 0 : (ui.sel + d + n) % n;
    showSel(true);
  }

  /** Перейти к месту i: перемотка и воспроизведение, окно закрывается (запрос помним). */
  function go(i) {
    const r = ui.res?.results[i];
    const v = mainVideo();
    if (!r || !v) return;
    if (adShowing()) {
      ui.root.querySelector(".state").innerHTML = `<span>Перейти можно после рекламы</span>`;
      return;
    }
    v.currentTime = Math.max(0, r.t);
    // это ваше нажатие — блокировщик автозапуска не должен тут же ставить видео на паузу
    globalThis.__ytcs?.allowPlay?.();
    void v.play?.()?.catch?.(() => {});
    close();
  }

  /** Открыть окно поиска (Ctrl+Shift+F, пункт меню). Повторно — фокус в поле. */
  function open() {
    if (!alive()) return false;
    const id = videoIdNow();
    if (!id || !mainVideo() || !host()) return false;
    const box = ui.root.querySelector(".box");
    const inp = ui.root.querySelector("input");
    if (!ui.open) {
      // у каждого видео — свой последний запрос: открыли снова — тот же список
      if (ui.id !== id) {
        ui.id = id;
        ui.q = ui.wasQ.get(id) || "";
        inp.value = ui.q;
      }
      ui.sel = -1;
      load(id);
      render();
    }
    ui.open = true;
    place();
    box.hidden = false;
    void box.offsetHeight;
    box.classList.add("show");
    inp.focus({ preventScroll: true });
    inp.select();
    // YouTube может перевести фокус на плеер — вернём его в поле
    setTimeout(() => ui.open && ui.root.activeElement !== inp && inp.focus({ preventScroll: true }), 200);
    return true;
  }

  function close() {
    if (!ui.open) return;
    ui.open = false;
    if (ui.id) ui.wasQ.set(ui.id, ui.q);
    const box = ui.root.querySelector(".box");
    box.classList.remove("show");
    box.hidden = true;
    ui.root.activeElement?.blur();
    // фокус — плееру: дальше снова работают его клавиши (пробел, стрелки)
    player()?.focus({ preventScroll: true });
  }

  // ---------- клавиши ----------
  // YouTube ловит клавиши на document в фазе перехвата — раньше, чем они дойдут до поля в
  // тени: «k» в запросе ставила бы видео на паузу, «f» — во весь экран. Перехватываем ещё
  // раньше, на window: до YouTube событие не доходит, буквы печатаются как обычно.
  const ours = (e) => Boolean(ui.host && e.composedPath?.().includes(ui.host));
  function typing(e) {
    const el = e.composedPath?.()[0] || e.target;
    if (!(el instanceof Element)) return false;
    return Boolean(el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']")) || el.isContentEditable;
  }
  const isHotkey = (e) => e.code === "KeyF" && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
  for (const type of ["keydown", "keypress", "keyup"]) {
    window.addEventListener(
      type,
      (e) => {
        const inside = ours(e);
        // Ctrl+Shift+F — открыть (или вернуться в поле); в окне — закрыть
        if (isHotkey(e)) {
          if (type !== "keydown") {
            if (inside || ui.open) e.stopPropagation();
            return;
          }
          if (e.repeat || e.isComposing) return;
          if (inside) {
            e.preventDefault();
            e.stopPropagation();
            close();
            return;
          }
          // курсор в поиске YouTube, комментарии, заметке — сочетание не наше, ввод не прерываем
          if (typing(e)) return;
          if (!videoIdNow() || !mainVideo()) return;
          if (open()) {
            e.preventDefault();
            e.stopPropagation();
          }
          return;
        }
        // окно открыто, фокус увёл плеер — Esc всё равно закрывает (но сначала — меню по правому щелчку)
        if (!inside) {
          if (type === "keydown" && ui.open && e.key === "Escape" && !typing(e) && !globalThis.__ytcsCtxMenu?.isOpen?.()) {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
          return;
        }
        e.stopPropagation();
        if (type !== "keydown" || e.isComposing) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          move(e.key === "ArrowDown" ? 1 : -1);
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (ui.sel >= 0) go(ui.sel);
        } else if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      },
      true
    );
  }

  // ---------- переходы ----------
  function onNavigate() {
    if (ui.open && videoIdNow() !== ui.id) close();
  }
  window.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("popstate", onNavigate);
  window.addEventListener("resize", () => ui.open && place());
  document.addEventListener("fullscreenchange", () => ui.open && setTimeout(place, 150));

  globalThis.__ytcsSpeech = { open, close, isOpen: () => ui.open };
})();
