"use strict";

// Таймер сна: остановить видео через 15–90 минут или в конце текущего видео.
//  - время считается по часам и только пока видео играет: при скорости 2×
//    30 минут остаются 30 минутами, пауза таймер не тратит;
//  - переживает переход на следующее видео во вкладке (YouTube меняет видео без
//    перезагрузки) и автопереход очереди (там страница грузится заново —
//    состояние лежит в sessionStorage этой вкладки);
//  - за ~20 с до остановки громкость плавно уходит в ноль (video.volume), затем
//    пауза, громкость возвращается прежней (чтобы утром не было тихо), выход из
//    полноэкранного режима и плашка «Таймер сна: остановлено»;
//  - «В конце видео» — пауза за долю секунды до конца: тогда ни YouTube, ни
//    подборка очереди (queue.js), ни плеер «Моей библиотеки» не включат следующее.
// Выбор — в меню кнопки расширения в плеере (content.js) и горячей клавишей
// (команда sleep-timer в manifest.json — по кругу 15 → … → 90 → в конце → выкл.).
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
  const core = globalThis.__ytcsSleepCore;
  if (!core || globalThis.__ytcsSleep) return;
  const FADE_MS = core.FADE_MS;

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };

  // ---------- Состояние ----------
  let st = load();
  let lastAt = performance.now();
  let fade = null; // { v, base, last, f, span } — громкость до затухания и что ставили мы
  let stopTimer = 0; // точная остановка «в конце видео»
  let noticeKind = "";

  function load() {
    try {
      return core.unpack(sessionStorage.getItem(core.storeKey));
    } catch (e) {
      return core.make("off");
    }
  }
  function save() {
    try {
      const s = core.pack(st);
      if (s) sessionStorage.setItem(core.storeKey, s);
      else sessionStorage.removeItem(core.storeKey);
    } catch (e) {
      /* хранилище недоступно — таймер живёт до перезагрузки страницы */
    }
  }

  // ---------- Плеер ----------
  // Основное видео: на странице просмотра — #movie_player (и в мини-плеере),
  // иначе любое играющее видео плеера YouTube (Shorts)
  function mainVideo() {
    const own = document.querySelector("#movie_player video.html5-main-video");
    if (own && !own.paused) return own;
    const list = [...document.querySelectorAll("video.html5-main-video")];
    return list.find((v) => !v.paused) || own || list[0] || null;
  }
  const playerOf = (v) => v?.closest(".html5-video-player") || document.getElementById("movie_player");
  const adShowing = (v) => Boolean(playerOf(v)?.classList.contains("ad-showing"));
  const playing = (v) => Boolean(v && !v.paused && !v.ended);

  // ---------- Затухание ----------
  function applyFade(v, left) {
    if (fade && fade.v !== v) restoreVolume();
    // до остановки больше 20 с (или перемотали назад) — полная громкость
    if (!v || left == null || left >= FADE_MS || (fade && left > fade.span + 500)) {
      if (fade) restoreVolume();
      return;
    }
    // затухание длится 20 с, а если до конца уже меньше — сколько осталось
    if (!fade) fade = { v, base: v.volume, last: -1, f: 1, span: Math.max(1000, left) };
    // громкость поменяли вы (не мы) — она и будет «прежней»
    else if (fade.last >= 0 && Math.abs(v.volume - fade.last) > 0.015) fade.base = Math.min(1, v.volume / Math.max(fade.f, 0.05));
    const f = core.fadeFactor(left, fade.span);
    fade.f = f;
    const vol = Math.max(0, Math.min(1, fade.base * f));
    if (Math.abs(v.volume - vol) > 0.001) v.volume = vol;
    fade.last = v.volume;
  }
  function restoreVolume() {
    if (!fade) return;
    const { v, base } = fade;
    fade = null;
    try {
      if (v && Math.abs(v.volume - base) > 0.001) v.volume = base;
    } catch (e) {
      /* видео уже нет */
    }
  }

  // ---------- Остановка ----------
  function stop(v) {
    clearTimeout(stopTimer);
    const was = st.mode;
    st = core.make("off");
    save();
    if (was === "off") return;
    if (v && !v.paused) v.pause();
    // громкость возвращаем чуть позже паузы — иначе хвост звука прозвучит громко
    const back = fade;
    fade = null;
    if (back) setTimeout(() => {
      fade = back;
      restoreVolume();
    }, 400);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    showNotice("stopped");
    syncMark();
  }

  // «В конце видео»: под самый конец ставим паузу по точному таймеру, а не по
  // проверке раз в 250 мс — на скорости 4× за это время прошла бы секунда видео
  function armExactStop(v, left) {
    clearTimeout(stopTimer);
    if (left == null || left > 1500) return;
    stopTimer = setTimeout(() => {
      if (st.mode !== "end" || adShowing(v)) return;
      const l = core.remaining(st, v);
      if (l != null && l <= 450) stop(v);
      else tick();
    }, Math.max(0, left - 350));
  }

  // ---------- Ход таймера ----------
  function tick() {
    const now = performance.now();
    const dt = now - lastAt;
    lastAt = now;
    if (st.mode === "off") {
      if (fade) restoreVolume();
      return;
    }
    const v = mainVideo();
    const ad = adShowing(v);
    if (st.mode === "min") {
      st = core.advance(st, dt, playing(v));
      save();
    }
    // «В конце видео» во время рекламы не считаем: конец рекламы — не конец видео
    const left = st.mode === "end" && ad ? null : core.remaining(st, v);
    if (st.mode === "min" && left <= 0) return stop(v);
    if (st.mode === "end") {
      if (left != null && left <= 450 && playing(v)) return stop(v);
      if (playing(v)) armExactStop(v, left);
    }
    if (playing(v)) applyFade(v, left);
    // плашка «Видео остановится через 20 с» — пока идёт затухание
    if (fade && playing(v)) showNotice("fade", left);
    else if (noticeKind === "fade") hideNotice();
    syncMark();
  }

  // ---------- Управление (меню, горячая клавиша, плашка) ----------
  function apply(next) {
    clearTimeout(stopTimer);
    restoreVolume();
    st = next;
    lastAt = performance.now();
    save();
    showNotice("set");
    tick();
    syncMark();
    return api.state();
  }
  // 15 / 30 / 45 / 60 / 90 / "end" / "off"
  const set = (choice) => apply(core.make(choice));
  // горячая клавиша: следующий вариант по кругу
  const cycle = () => apply(core.next(st));
  // «Ещё 15 мин» на плашке затухания
  function extend() {
    restoreVolume();
    st = st.mode === "end" ? core.make("off") : { mode: "min", left: 15 * 60000, preset: st.preset };
    lastAt = performance.now();
    save();
    showNotice(st.mode === "off" ? "set" : "more");
    syncMark();
  }

  // ---------- Плашка поверх плеера (shadow DOM) ----------
  // Стиль — как у остальных плашек расширения в плеере (.ytcs-toast в content.js,
  // плашки speed.js): тёмная «таблетка» сверху по центру плеера.
  const MOON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19.5 14.2A7.8 7.8 0 1 1 9.8 4.5a6.2 6.2 0 0 0 9.7 9.7z"/><path d="M17.5 3.8v2.6M16.2 5.1h2.6" opacity=".7"/></svg>';
  const NOTICE_CSS = `
    :host { all: initial; position: absolute; top: 16px; left: 16px; right: 16px; z-index: 82;
      display: flex; justify-content: center; pointer-events: none; }
    :host(.page) { position: fixed; top: 72px; z-index: 9999; }
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
    .txt { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      position: relative; top: -.06em; }
    b { font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums; }
    /* узкий плеер: текст не обрезается, а переносится — «таблетка» становится карточкой */
    .n.wrap { border-radius: 18px; padding-top: 8px; padding-bottom: 8px; }
    .n.wrap .txt { white-space: normal; overflow: visible; top: 0; }
    button { flex: none; height: 34px; padding: 0 16px 1px; border: 0; border-radius: 999px; font: inherit; font-weight: 600;
      background: rgba(255, 255, 255, .14); color: #fff; cursor: pointer; transition: background-color .12s ease; }
    button:hover, button:focus-visible { background: rgba(255, 255, 255, .24); outline: none; }
    button:active { background: rgba(255, 255, 255, .3); }
    button[hidden] { display: none; }
    @media (min-width: 1600px) { .n { zoom: 1.15; } }
    @media (min-width: 2200px) { .n { zoom: 1.35; } }
    @media (prefers-reduced-motion: reduce) { .n, button { transition: none; } }`;

  const notice = { host: null, root: null, timer: 0, hover: false, text: "" };

  function noticeHost() {
    const v = mainVideo();
    const p = (v && playerOf(v)) || document.getElementById("movie_player");
    const where = p && p.getClientRects().length ? p : document.body;
    if (!where) return null;
    if (!notice.host) {
      const host = document.createElement("div");
      host.id = "ytcs-sleep-notice";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${NOTICE_CSS}</style>
        <div class="n" role="status" aria-live="polite">${MOON}<span class="txt"></span><button type="button"></button></div>`;
      // клики по плашке не должны ставить видео на паузу
      for (const t of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "keydown"]) {
        host.addEventListener(t, (e) => e.stopPropagation());
      }
      root.querySelector("button").addEventListener("click", () => (noticeKind === "fade" ? extend() : hideNotice()));
      const box = root.querySelector(".n");
      box.addEventListener("mouseenter", () => {
        notice.hover = true;
        clearTimeout(notice.timer);
      });
      box.addEventListener("mouseleave", () => {
        notice.hover = false;
        if (noticeKind && noticeKind !== "fade" && noticeKind !== "stopped") armHide(2500);
      });
      notice.host = host;
      notice.root = root;
    }
    if (notice.host.parentElement !== where) where.appendChild(notice.host);
    notice.host.classList.toggle("page", where === document.body);
    return notice.host;
  }

  function armHide(ms) {
    clearTimeout(notice.timer);
    if (!notice.hover && ms > 0) notice.timer = setTimeout(hideNotice, ms);
  }

  function noticeText(kind, left) {
    if (kind === "set") {
      if (st.mode === "off") return ["Таймер сна выключен", ""];
      if (st.mode === "end") return ["Таймер сна: остановлю <b>в конце видео</b>", ""];
      return [`Таймер сна: <b>${core.fmtLeft(st.left)}</b>`, ""];
    }
    if (kind === "more") return [`Таймер сна: ещё <b>${core.fmtLeft(st.left)}</b>`, ""];
    if (kind === "fade") return [`Видео остановится через <b>${core.fmtLeft(left)}</b>`, st.mode === "end" ? "Не останавливать" : "Ещё 15 мин"];
    return ["Таймер сна: остановлено", ""];
  }

  function showNotice(kind, left = null) {
    if (!noticeHost()) return;
    const r = notice.root;
    const [html, action] = noticeText(kind, left);
    const box = r.querySelector(".n");
    // затухание обновляет только цифры — без повторного появления
    if (kind === noticeKind && kind === "fade" && box.classList.contains("show")) {
      if (notice.text !== html) r.querySelector(".txt").innerHTML = notice.text = html;
      return;
    }
    const txt = r.querySelector(".txt");
    const btn = r.querySelector("button");
    txt.innerHTML = notice.text = html;
    btn.textContent = action;
    btn.hidden = !action;
    noticeKind = kind;
    box.classList.toggle("plain", !action);
    box.classList.remove("wrap");
    if (txt.scrollWidth > txt.clientWidth + 1) box.classList.add("wrap");
    box.classList.remove("show");
    void box.offsetHeight; // перезапуск появления
    box.classList.add("show");
    // затухание — пока идёт; «остановлено» — пока снова не включите видео
    armHide(kind === "fade" || kind === "stopped" ? 0 : 2600);
  }

  function hideNotice() {
    clearTimeout(notice.timer);
    notice.root?.querySelector(".n")?.classList.remove("show");
    noticeKind = "";
    notice.hover = false;
  }

  // Отметка на плеере: точка на кнопке расширения, пока таймер идёт (стиль — content.js)
  function syncMark() {
    const on = st.mode !== "off";
    for (const b of document.querySelectorAll(".html5-video-player .ytcs-btn")) {
      if (b.classList.contains("ytcs-sleep-on") !== on) b.classList.toggle("ytcs-sleep-on", on);
    }
  }

  // ---------- Для меню кнопки расширения в плеере (content.js) ----------
  const api = {
    // { mode: "off" | "min" | "end", preset, left (мс или null), label: «осталось 23 мин» }
    state() {
      const v = mainVideo();
      const left = st.mode === "end" && adShowing(v) ? null : core.remaining(st, v);
      return { mode: st.mode, preset: st.preset, left, label: core.label(st, left) };
    },
    set,
    cycle,
  };
  globalThis.__ytcsSleep = api;

  // ---------- Подписки ----------
  setInterval(tick, 250);
  document.addEventListener("timeupdate", (e) => e.target instanceof HTMLVideoElement && st.mode !== "off" && tick(), true);
  // включили видео после остановки — плашка «остановлено» больше не нужна
  document.addEventListener(
    "play",
    (e) => {
      if (noticeKind === "stopped" && e.target instanceof HTMLVideoElement) hideNotice();
      lastAt = performance.now();
    },
    true
  );
  // Страховка «в конце видео»: если пауза всё же не успела и видео кончилось —
  // событие «ended» не пускаем дальше (на window, раньше всех): ни плеер YouTube,
  // ни очередь не узнают о конце и не включат следующее.
  window.addEventListener(
    "ended",
    (e) => {
      const v = e.target;
      if (st.mode !== "end" || !(v instanceof HTMLVideoElement) || !v.classList.contains("html5-main-video") || adShowing(v)) return;
      e.stopImmediatePropagation();
      stop(v);
      // обратный отсчёт YouTube к следующему видео, если уже начался, — отменяем
      let n = 0;
      const t = setInterval(() => {
        if (++n > 40) return clearInterval(t);
        document.querySelector(".ytp-autonav-endscreen-upnext-cancel-button")?.click();
      }, 250);
    },
    true
  );
  // уходим со страницы посреди затухания — громкость возвращаем сразу
  window.addEventListener("pagehide", () => {
    restoreVolume();
    save();
  });
  if (alive()) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "yt:sleep-cycle") cycle();
    });
  }
  // после перезагрузки (автопереход очереди) таймер продолжает идти — напоминаем
  if (st.mode !== "off") setTimeout(() => syncMark(), 1500);
  tick();
})();
