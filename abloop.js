"use strict";

// Повтор отрезка A–B в плеере YouTube (и во встроенном плеере «Моей библиотеки»):
//  - клавиша A — начало, B — конец (или пункт «Повтор отрезка» в меню кнопки расширения);
//    отрезок крутится по кругу, A ещё раз или Esc — снять повтор;
//  - отрезок — светлой полосой с отметками на полосе прогресса (если она не скрыта
//    «Скрыть полосу прогресса»);
//  - плашка сверху плеера «Повтор 1:23–1:41 · Снять» — видна вместе с панелью плеера;
//  - реклама: пока она идёт, повтор не трогает видео; вставки (sponsor.js), «Пропускать
//    тишину» и скорость не мешают; таймер сна «в конце видео» останавливает в конце отрезка.
// Клавиши [ и ] заняты очередью (queue.js), поэтому A и B. Логика без DOM — abloop-core.js
// (globalThis.__ytcsAbCore). Отрезок живёт, пока открыто это видео; в хранилище не пишется.
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
  if (globalThis.__ytcsAb) return;
  const C = globalThis.__ytcsAbCore;
  if (!C) return;
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
  const mainVideo = () => document.querySelector("#movie_player video.html5-main-video") || document.querySelector("#movie_player video");
  const adShowing = () => Boolean(player()?.classList.contains("ad-showing"));
  // полоса прогресса: привычная или новая у встроенного плеера (как в notes.js)
  const progressBar = () =>
    document.querySelector("#movie_player .ytp-progress-bar") ||
    document.querySelector("#movie_player .ytPlayerProgressBarProgressBar") ||
    (OUR_EMBED ? document.querySelector("#player-controls .ytPlayerProgressBarProgressBar") : null);
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

  // ---------- состояние ----------
  let st = C.empty();
  let hideProgress = false;
  let vid = null;

  // ---------- круг ----------
  // Свою перемотку к началу не путаем с вашей; вашей считаем ту, что случилась в
  // течение 1,5 с после нажатия клавиши или щелчка (полоса, J / L, стрелки, таймкод).
  let selfSeekAt = 0;
  let gestureAt = 0;
  let userJump = false;
  let timer = 0;

  function seekTo(v, t) {
    selfSeekAt = Date.now();
    userJump = false;
    v.currentTime = t;
  }

  function wrap(v) {
    // таймер сна «в конце видео»: конец отрезка — и есть конец, дальше не крутим
    const sleep = globalThis.__ytcsSleep;
    if (sleep?.state?.().mode === "end" && sleep.stopNow) {
      sleep.stopNow();
      seekTo(v, st.a);
      return;
    }
    seekTo(v, st.a);
  }

  function tick() {
    clearTimeout(timer);
    timer = 0;
    if (!alive()) return void stop(); // расширение перезагрузили — повтор снимаем, видео не держим
    if (!C.active(st)) return;
    const v = mainVideo();
    if (!v || adShowing()) return; // реклама — не наше видео, ждём её конца
    const dur = duration();
    const jumped = userJump;
    userJump = false;
    const r = C.step(st, { t: v.currentTime, dur, userJump: jumped });
    st = r.st;
    if (r.wrap) wrap(v);
    if (!v.paused && !v.ended) timer = setTimeout(tick, C.delay(st, { t: v.currentTime, dur, rate: v.playbackRate }));
  }

  // ---------- отметить ----------
  const MSG = {
    short: "Отрезок короче секунды — отметьте конец подальше",
    ad: "Повтор отрезка — после рекламы",
    live: "Повтор отрезка — только в записанных видео",
  };

  function mark(which) {
    if (!alive()) return false;
    const v = mainVideo();
    if (!videoIdNow() || !v) return false;
    if (adShowing()) return flash(MSG.ad), true;
    const dur = duration();
    if (!Number.isFinite(dur)) return flash(MSG.live), true;
    const r = which === "a" ? C.setA(st, v.currentTime, dur) : C.setB(st, v.currentTime, dur);
    if (r.did === "short") return flash(MSG.short), true;
    st = r.st;
    if (C.needSeek(st, v.currentTime, dur)) seekTo(v, st.a);
    render(true);
    tick();
    return true;
  }

  function clear() {
    if (!C.any(st)) return false;
    st = C.empty();
    clearTimeout(timer);
    render(false);
    return true;
  }

  // Расширение перезагрузили (или выключили): этот экземпляр больше не управляет видео —
  // снимаем отрезок, сообщение и отметки, иначе видео крутилось бы по кругу без плашки «Снять»
  function stop() {
    notice.msg = "";
    clearTimeout(notice.msgTimer);
    if (!clear()) render(false);
  }

  // ---------- клавиши ----------
  function typing(e) {
    const el = e.composedPath?.()[0] || e.target;
    if (!(el instanceof Element)) return false;
    return Boolean(el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']")) || el.isContentEditable;
  }
  // открыто поле заметки (notes.js), окно клипа или плейлистов — клавиши их
  const busy = () =>
    Boolean(document.getElementById("ytcs-note-editor")?.shadowRoot?.querySelector(".ed.show")) ||
    Boolean(document.getElementById("ytcs-playlists") || document.getElementById("ytcs-clip"));
  // 360° видео: A и D там поворачивают картинку — их не перехватываем
  const spherical = () => /\bytp-(webgl-)?spherical\b/.test(player()?.className || "");

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.isTrusted && !typing(e)) gestureAt = Date.now();
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.defaultPrevented) return;
      if (e.key === "Escape") {
        // Esc закрывает сначала меню расширения и выходит из полноэкранного режима
        if (!C.any(st) || typing(e) || busy() || document.fullscreenElement || document.querySelector(".ytcs-menu.open")) return;
        if (clear()) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if ((e.code !== "KeyA" && e.code !== "KeyB") || e.shiftKey || e.repeat) return;
      if (typing(e) || busy() || spherical() || !videoIdNow() || !mainVideo()) return;
      if (mark(e.code === "KeyA" ? "a" : "b")) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );
  document.addEventListener("pointerdown", (e) => e.isTrusted && (gestureAt = Date.now()), true);

  // ---------- плашка поверх плеера (shadow DOM) ----------
  // Стиль — как у плашек громкости и скорости (volume.js, speed.js): тёмная «таблетка»
  // сверху по центру. Видна, пока видна панель плеера (YouTube прячет её классом
  // ytp-autohide, когда видео играет и мышь не двигается), и под другими плашками.
  const ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 4.5l2.5 2.5L17 9.5"/><path d="M19.5 7H8.5A4.5 4.5 0 0 0 4 11.5V12"/><path d="M7 19.5L4.5 17 7 14.5"/><path d="M4.5 17h11a4.5 4.5 0 0 0 4.5-4.5V12"/></svg>';
  const NOTICE_CSS = `
    :host { all: initial; position: absolute; top: 16px; left: 16px; right: 16px; z-index: 80;
      display: flex; justify-content: center; pointer-events: none; transition: top .2s ease; }
    .n { display: flex; align-items: center; gap: 10px; min-width: 0; max-width: 100%; box-sizing: border-box; padding: 7px 7px 7px 16px;
      border-radius: 999px; background: rgba(28, 28, 30, .9);
      -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6);
      box-shadow: 0 8px 30px rgba(0, 0, 0, .4), inset 0 0 0 1px rgba(255, 255, 255, .07);
      color: #f1f1f1; font: 500 16px/1.3 "YouTube Noto", Roboto, Arial, sans-serif;
      opacity: 0; transform: translateY(-8px) scale(.97); transform-origin: 50% 0;
      transition: opacity .18s ease, transform .26s cubic-bezier(.22, 1, .36, 1); }
    .n.show { opacity: 1; transform: none; pointer-events: auto; }
    .n.plain { padding-right: 18px; min-height: 34px; }
    svg { flex: none; width: 20px; height: 20px; color: #ff6b85; }
    .txt { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    b { font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .hint { white-space: nowrap; color: rgba(255, 255, 255, .7); }
    /* 24 px и буква 12 px — буква ровно посередине на 150 % и 200 % (замер tools/align, yt-abloop-a; при 13 px — +0,67 px) */
    kbd { display: inline-grid; place-items: center; min-width: 24px; height: 24px; padding: 0 6px; box-sizing: border-box;
      border: 1px solid rgba(255, 255, 255, .35); border-radius: 6px; color: #fff; font: 600 12px/1 "YouTube Noto", Roboto, Arial, sans-serif; }
    /* узкий плеер: текст не обрезается, а переносится — «таблетка» становится карточкой */
    .n.wrap { border-radius: 18px; padding-top: 8px; padding-bottom: 8px; }
    .n.wrap .txt { white-space: normal; overflow: visible; }
    button { flex: none; height: 34px; padding: 2px 16px 0; border: 0; border-radius: 999px; font: inherit; font-weight: 600;
      background: rgba(255, 255, 255, .14); color: #fff; cursor: pointer; transition: background-color .12s ease; }
    button:hover, button:focus-visible { background: rgba(255, 255, 255, .24); outline: none; }
    button:active { background: rgba(255, 255, 255, .3); }
    button[hidden] { display: none; }
    /* большие экраны (2K/4K) — плашка крупнее, как остальные плашки расширения */
    @media (min-width: 1600px) { .n { zoom: 1.15; } }
    @media (min-width: 2200px) { .n { zoom: 1.35; } }
    @media (prefers-reduced-motion: reduce) { :host, .n, button { transition: none; } }`;

  const notice = { host: null, root: null, msg: "", msgTimer: 0, poke: 0, loop: 0 };

  function noticeHost() {
    const p = player();
    if (!p) return null;
    if (!notice.host) {
      const host = document.createElement("div");
      host.id = "ytcs-abloop-notice";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${NOTICE_CSS}</style>
        <div class="n" role="status" aria-live="polite">${ICON}<span class="txt"></span><button type="button" title="Снять повтор — Esc">Снять</button></div>`;
      // клики по плашке не должны ставить видео на паузу
      for (const t of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "keydown", "wheel"]) {
        host.addEventListener(t, (e) => e.stopPropagation());
      }
      root.querySelector("button").addEventListener("click", () => {
        clear();
        player()?.focus({ preventScroll: true });
      });
      notice.host = host;
      notice.root = root;
    }
    // в новом встроенном плеере — слой над его панелью управления (content.js), иначе «Снять» не нажимается
    const into = globalThis.__ytcsPlayerLayer?.(p) || p;
    if (notice.host.parentElement !== into) into.appendChild(notice.host);
    return notice.host;
  }

  // Под другими плашками сверху плеера (скорость и громкость канала, «Вы остановились…»,
  // таймер сна, мягкий лимит, вступление канала, плашки меню расширения) — во встроенном
  // плеере все они в одном слое с этой
  const OTHERS = ["ytcs-speed-notice", "ytcs-volume-notice", "ytcs-resume-offer", "ytcs-sleep-notice", "ytcs-limit-notice", "ytcs-intro-notice"];
  function place() {
    const host = notice.host;
    const p = host?.parentElement;
    if (!p) return;
    const top = p.getBoundingClientRect().top;
    let below = 0;
    const boxes = OTHERS.map((id) => {
      const h = document.getElementById(id);
      return h?.parentElement === p ? h.shadowRoot?.querySelector(".show") : null;
    });
    const toast = document.getElementById("ytcs-toast");
    if (toast?.parentElement === p && toast.classList.contains("show")) boxes.push(toast);
    for (const box of boxes) {
      const r = box?.getBoundingClientRect();
      if (r?.height) below = Math.max(below, r.bottom - top);
    }
    // встроенный плеер библиотеки: шапку с названием (#player-controls) не закрываем — встаём ниже
    if (OUR_EMBED) {
      const hr = document.querySelector("#player-controls .player-controls-top")?.getBoundingClientRect();
      if (hr?.height && hr.bottom > top) below = Math.max(below, hr.bottom - top);
    }
    const want = below ? `${Math.round(below + 8)}px` : "";
    if (host.style.top !== want) host.style.top = want;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // короткое сообщение вместо состояния («Отрезок короче секунды…»)
  function flash(text) {
    notice.msg = text;
    clearTimeout(notice.msgTimer);
    notice.msgTimer = setTimeout(() => {
      notice.msg = "";
      render(false);
    }, 2600);
    render(true);
  }

  // видна ли панель плеера (на паузе — всегда; когда играет — пока двигаете мышью)
  const controlsShown = () => !player()?.classList.contains("ytp-autohide");

  let shownKey = "";
  // fresh — только что поменяли отрезок: плашку показать, даже если панель плеера спрятана
  function renderNotice(fresh) {
    const has = C.any(st) || notice.msg;
    // на рекламе прячем состояние повтора, но не сообщение («Повтор отрезка — после рекламы»)
    if (!has || !alive() || (adShowing() && !notice.msg)) {
      hideNotice();
      return;
    }
    if (fresh) notice.poke = Date.now();
    // открыто меню расширения — плашка не наезжает на него (там тот же пункт «Повтор отрезка»);
    // во встроенном плеере меню вне #movie_player (поверх слоя управления), поэтому ищем по всей странице
    const menuOpen = Boolean(document.querySelector(".ytcs-menu.open"));
    const visible = !menuOpen && (notice.msg || controlsShown() || Date.now() - notice.poke < 2500);
    if (!visible) {
      notice.root?.querySelector(".n")?.classList.remove("show");
      shownKey = "";
      return;
    }
    if (!noticeHost()) return;
    const r = notice.root;
    const box = r.querySelector(".n");
    const txt = r.querySelector(".txt");
    const btn = r.querySelector("button");
    const p = C.pill(st);
    const html = notice.msg
      ? esc(notice.msg)
      : p.kind === "loop"
        ? `${p.lead} <b>${p.time}</b>`
        : `${p.lead} <b>${p.time}</b> · <span class="hint">${p.hint} <kbd>${p.key}</kbd></span>`;
    const key = `${html}|${Boolean(notice.msg)}`;
    if (key !== shownKey) {
      txt.innerHTML = html;
      btn.hidden = Boolean(notice.msg);
      box.classList.toggle("plain", btn.hidden);
      box.classList.remove("wrap");
      box.setAttribute("aria-label", notice.msg || (p.kind === "loop" ? `Повтор отрезка ${p.time}` : `${p.lead} повтора ${p.time}`));
      if (txt.scrollWidth > txt.clientWidth + 1) box.classList.add("wrap");
    }
    if (!box.classList.contains("show")) {
      void box.offsetHeight; // появление с анимацией
      box.classList.add("show");
    }
    shownKey = key;
    place();
  }

  function hideNotice() {
    notice.root?.querySelector(".n")?.classList.remove("show");
    shownKey = "";
  }

  // ---------- отметки на полосе прогресса ----------
  // Отрезок — светлая полоса поверх полосы прогресса, края — белые «скобки» с красной
  // обводкой (точки заметок — круглые, notes.js). Мышь не ловят: перемотка — как обычно.
  const MARKS_CSS = `
    /* visibility: inherit — панель плеера прячется через visibility: hidden, отметки — вместе с ней */
    :host { all: initial; position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 42; pointer-events: none; visibility: inherit; }
    .band { position: absolute; top: 0; bottom: 0; background: rgba(255, 255, 255, .38); box-shadow: inset 0 0 0 1px rgba(255, 59, 92, .55); }
    .m { position: absolute; top: 50%; width: 6px; height: 15px; margin: -7.5px 0 0 -3px; box-sizing: border-box; border-radius: 3px;
      background: #fff; border: 1.5px solid #ff3b5c; box-shadow: 0 0 0 1.5px rgba(0, 0, 0, .55); }
    [hidden] { display: none !important; }`;
  let marks = null;

  function marksHost(bar) {
    if (!marks) {
      marks = document.createElement("div");
      marks.id = "ytcs-abloop-marks";
      marks.attachShadow({ mode: "open" }).innerHTML = `<style>${MARKS_CSS}</style><div class="band" hidden></div><span class="m a" hidden></span><span class="m b" hidden></span>`;
    }
    if (marks.parentElement !== bar) {
      bar.appendChild(marks);
      if (getComputedStyle(bar).position === "static") bar.style.position = "relative";
    }
    return marks;
  }

  let marksKey = "";
  function renderMarks() {
    const bar = progressBar();
    const m = !hideProgress && bar && !adShowing() ? C.marks(st, duration()) : null;
    if (!m) {
      marks?.remove();
      marksKey = "";
      return;
    }
    const host = marksHost(bar);
    const key = JSON.stringify(m);
    if (key === marksKey) return;
    marksKey = key;
    const root = host.shadowRoot;
    const set = (el, pct) => {
      el.hidden = pct == null;
      if (pct != null) el.style.left = pct.toFixed(3) + "%";
    };
    set(root.querySelector(".a"), m.a);
    set(root.querySelector(".b"), m.b);
    const band = root.querySelector(".band");
    band.hidden = !m.band;
    if (m.band) {
      band.style.left = m.band.from.toFixed(3) + "%";
      band.style.width = (m.band.to - m.band.from).toFixed(3) + "%";
    }
  }

  function render(fresh) {
    renderNotice(fresh);
    renderMarks();
    // пока что-то отмечено — следим за панелью плеера и другими плашками
    clearInterval(notice.loop);
    notice.loop = C.any(st) || notice.msg ? setInterval(() => (alive() ? (onNavigate(), renderNotice(false), renderMarks()) : stop()), 300) : 0;
  }

  // ---------- переходы и события видео ----------
  function onNavigate() {
    const id = videoIdNow();
    if (id === vid) return;
    vid = id;
    if (C.any(st)) clear();
  }
  const isMain = (e) => e.target instanceof HTMLVideoElement && e.target === mainVideo();
  for (const t of ["playing", "play", "timeupdate", "seeked", "ratechange"]) {
    document.addEventListener(t, (e) => isMain(e) && C.active(st) && tick(), true);
  }
  document.addEventListener(
    "seeking",
    (e) => {
      if (!isMain(e) || !C.active(st)) return;
      const now = Date.now();
      if (now - selfSeekAt > 400 && now - gestureAt < 1500) userJump = true;
    },
    true
  );
  for (const t of ["loadedmetadata", "durationchange", "emptied"]) {
    document.addEventListener(t, (e) => isMain(e) && (onNavigate(), renderMarks()), true);
  }
  // Конец отрезка — конец видео, а проверка не успела (вкладка в фоне): событие «ended»
  // не пускаем дальше, чтобы YouTube не включил следующее, — и снова с начала отрезка.
  // Таймер сна «в конце видео» ловит его раньше (sleep.js) — тогда видео стоит.
  window.addEventListener(
    "ended",
    (e) => {
      const v = e.target;
      if (!C.active(st) || st.free || v !== mainVideo() || adShowing()) return;
      // расширение перезагрузили — конец видео обычный (YouTube включит следующее), не зацикливаем
      if (!alive()) return void stop();
      if (st.b < duration() - 1.5) return;
      e.stopImmediatePropagation();
      seekTo(v, st.a);
      void v.play().catch(() => {});
    },
    true
  );
  window.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("popstate", onNavigate);

  // ---------- для меню кнопки расширения (content.js) и проверок ----------
  globalThis.__ytcsAb = {
    setA: () => mark("a"),
    setB: () => mark("b"),
    clear,
    // { a, b, active, aside: «1:23–1:41» | «A 1:23» | «» }
    state: () => ({ a: st.a, b: st.b, active: C.active(st), free: st.free, aside: C.aside(st) }),
    // для проверок: отрезок напрямую, в секундах
    set(a, b) {
      st = C.clean({ a, b });
      const v = mainVideo();
      if (v && C.needSeek(st, v.currentTime, duration())) seekTo(v, st.a);
      render(true);
      tick();
      return C.active(st);
    },
  };
  // встроенный плеер: «Моя библиотека» передаёт A и B, нажатые на её странице
  if (OUR_EMBED) {
    window.addEventListener("message", (e) => {
      let ok = false;
      try {
        ok = e.origin === `chrome-extension://${chrome.runtime.id}` && (e.data?.ytcsAb === "a" || e.data?.ytcsAb === "b");
      } catch (err) {
        ok = false;
      }
      if (ok) mark(e.data.ytcsAb);
    });
  }

  if (!alive()) return;
  chrome.storage.local
    .get("settings")
    .then((o) => {
      hideProgress = Boolean(o.settings?.hideProgress);
      renderMarks();
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    hideProgress = Boolean(changes.settings.newValue?.hideProgress);
    renderMarks();
  });
  onNavigate();
})();
