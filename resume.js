"use strict";

// «С того же места»: видео продолжается там, где его оставили.
//  - После F5 (и «Назад/Вперёд», восстановления вкладок) — с той же секунды, а не
//    на ~20 с раньше, как ставит YouTube по своей истории: место раз в секунду
//    лежит в sessionStorage вкладки (resume-core.js: { id, t, d, at }).
//  - Надолго (вкладку закрыли, браузер перезапустили): раз в 10 с и на паузе место
//    кладётся в chrome.storage.local. Открыли ролик снова — если YouTube сам
//    поставил его чуть раньше, тихо догоняем; если начал с нуля — плашка
//    «Вы остановились на 12:34 · Продолжить». Метка &t= в адресе — выбор явный, не трогаем.
//  - Ждём сам ролик (не рекламу: длительность совпадает). Если YouTube следом сам
//    откатывает на своё место — возвращаем (до двух раз, в первые 4 с).
//  - Перемотал сам, пока ролик грузился, — не вмешиваемся.
(() => {
  if (window.top !== window || location.pathname.startsWith("/embed/")) return;
  const core = globalThis.__ytcsResumeCore;
  if (!core || globalThis.__ytcsResume) return;
  globalThis.__ytcsResume = true;
  const KEY = core.KEY;
  const LONG_KEY = core.LONG_KEY;

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };
  const curId = () => (location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null);
  const urlHasT = () => new URLSearchParams(location.search).has("t") || /(^|[#&])t=/.test(location.hash.slice(1));
  const player = () => document.getElementById("movie_player");
  const video = () => document.querySelector("#movie_player video.html5-main-video") || document.querySelector("#movie_player video");
  const adShowing = () => Boolean(player()?.classList.contains("ad-showing"));

  // ---------- хранилища ----------
  function read() {
    try {
      return core.unpack(sessionStorage.getItem(KEY));
    } catch (e) {
      return null;
    }
  }
  function write(rec) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(rec));
    } catch (e) {
      /* хранилище недоступно — просто не помним */
    }
  }
  async function getLong() {
    if (!alive()) return {};
    try {
      return (await chrome.storage.local.get(LONG_KEY))[LONG_KEY] || {};
    } catch (e) {
      return {};
    }
  }
  async function putLong(rec) {
    if (!alive()) return;
    try {
      const map = (await chrome.storage.local.get(LONG_KEY))[LONG_KEY];
      await chrome.storage.local.set({ [LONG_KEY]: core.put(map, rec, Date.now()) });
    } catch (e) {
      /* расширение обновили на ходу — со следующей страницы заработает */
    }
  }

  let nav = "navigate";
  try {
    nav = performance.getEntriesByType("navigation")[0]?.type || "navigate";
  } catch (e) {
    /* старый браузер — считаем обычным переходом */
  }

  // ---------- просмотр одного ролика ----------
  // visit: { id, target, d, kind: "reload" | "long" | null, pending, first, boundary, guardUntil, reapplied, startedAt }
  let visit = null;
  let firstVisit = true;
  let ourSeek = false;
  let userAt = 0;
  let savedAt = 0;
  let longAt = 0;
  let poll = 0;
  // При переходе внутри YouTube элемент <video> тот же, и сначала в нём ещё прежний
  // ролик. Новый — когда после начала перехода (или сброса источника) пришли его
  // метаданные.
  let navAt = 0;
  let emptiedAt = 0;
  let metaAt = 0;
  function loaded(v) {
    const el = video();
    if (!el || el.readyState < 1) return false;
    return v.first || metaAt > v.boundary;
  }

  function startVisit() {
    const id = curId();
    if (visit && visit.id === id) return;
    hideOffer();
    clearInterval(poll);
    const first = firstVisit;
    firstVisit = false;
    if (!id) {
      visit = null;
      return;
    }
    const v = { id, target: null, d: 0, kind: null, pending: true, first, boundary: Math.max(navAt, emptiedAt), guardUntil: 0, reapplied: 0, startedAt: Date.now() };
    visit = v;
    if (first) {
      const saved = read();
      const t = core.plan(saved, { id, nav, now: Date.now() });
      if (t !== null) {
        Object.assign(v, { target: t, d: saved.d, kind: "reload" });
        return arm(v);
      }
    }
    if (urlHasT()) {
      v.pending = false;
      return;
    }
    getLong().then((map) => {
      if (visit !== v) return;
      const r = core.longTarget(map, { id, now: Date.now(), urlT: urlHasT() });
      if (!r) {
        v.pending = false;
        return;
      }
      Object.assign(v, { target: r.t, d: r.d, kind: "long" });
      arm(v);
    });
  }

  function arm(v) {
    clearInterval(poll);
    // Пока видео на паузе (автозапуск выключен), timeupdate не идёт — проверяем сами.
    // Долгая реклама — ждём до 2 минут, дальше не вмешиваемся.
    poll = setInterval(() => {
      if (visit !== v || !v.pending) return clearInterval(poll);
      if (Date.now() - v.startedAt > 120000) return finish(v);
      tryRestore();
    }, 400);
    tryRestore();
  }

  function finish(v) {
    v.pending = false;
    clearInterval(poll);
  }

  function seek(el, t) {
    ourSeek = true;
    el.currentTime = t;
  }

  function tryRestore() {
    const v = visit;
    if (!v || !v.pending || v.target === null || curId() !== v.id) return;
    const el = video();
    if (!el || !loaded(v) || adShowing()) return; // ролик ещё не загрузился или идёт реклама
    if (!core.sameVideo(v, el.duration)) {
      // другой длины и уже играет давно — ролик заменили (или это не он): не ждём,
      // иначе всё это время место не записывалось бы
      if (Number.isFinite(el.duration) && el.duration > 0 && el.currentTime > 3 && Date.now() - v.startedAt > 8000) finish(v);
      return;
    }
    // место YouTube видно, когда кадр уже есть (или видео стоит на паузе пару секунд)
    if (v.kind === "long" && el.readyState < 2 && Date.now() - v.startedAt < 3000) return;
    finish(v); // до действий: что бы ни случилось с плашкой, место дальше записывается
    v.guardUntil = Date.now() + 4000;
    if (v.kind === "reload") {
      if (core.needSeek(v.target, el.currentTime)) seek(el, v.target);
      return;
    }
    const act = core.longAction(v.target, el.currentTime);
    if (act === "seek") seek(el, v.target);
    else if (act === "offer") showOffer(v);
  }

  function save(force) {
    const el = video();
    const id = curId();
    if (!el || !id || adShowing()) return;
    if (!visit || visit.id !== id) return startVisit(); // переход внутри YouTube — сначала новый ролик
    if (visit.pending || !loaded(visit)) return; // место ещё не вернули — иначе первая секунда затрёт наше
    const now = Date.now();
    if (!force && now - savedAt < 1000) return;
    savedAt = now;
    const rec = core.pack({ id, t: el.currentTime, d: el.duration, now });
    if (!rec) return;
    write(rec);
    if (force || now - longAt >= 10000) {
      longAt = now;
      putLong(rec);
    }
  }

  // ---------- события ----------
  // Видео-события не всплывают, но проходят фазу перехвата — слушаем на document.
  const mine = (e) => e.target === video();
  document.addEventListener(
    "timeupdate",
    (e) => {
      if (!mine(e)) return;
      if (visit?.pending) tryRestore();
      else save(false);
    },
    true
  );
  for (const type of ["loadedmetadata", "durationchange"]) {
    document.addEventListener(
      type,
      (e) => {
        if (!mine(e)) return;
        metaAt = Date.now();
        if (!visit || visit.id !== curId()) startVisit();
        tryRestore();
      },
      true
    );
  }
  for (const type of ["canplay", "playing"]) document.addEventListener(type, (e) => mine(e) && tryRestore(), true);
  document.addEventListener("pause", (e) => mine(e) && save(true), true);
  document.addEventListener(
    "emptied",
    (e) => {
      if (mine(e)) emptiedAt = Date.now();
    },
    true
  );
  document.addEventListener(
    "seeking",
    (e) => {
      const v = visit;
      const el = video();
      if (e.target !== el || !v) return;
      if (ourSeek) {
        ourSeek = false;
        return;
      }
      const byUser = Date.now() - userAt < 1500;
      if (byUser) {
        if (v.pending) finish(v); // перемотал сам — его выбор
        return;
      }
      if (v.pending || v.target === null || Date.now() > v.guardUntil || v.reapplied >= 2) return;
      // YouTube уже после нас переставил видео на своё место из истории.
      // Только назад: вперёд перематывает пропуск спонсорских вставок (sponsor.js).
      if (v.kind === "reload") {
        if (el.currentTime < v.target && core.needSeek(v.target, el.currentTime)) {
          v.reapplied += 1;
          setTimeout(() => video() === el && core.needSeek(v.target, el.currentTime) && seek(el, v.target), 0);
        }
        return;
      }
      const act = core.longAction(v.target, el.currentTime);
      if (act !== "offer") hideOffer();
      if (act === "seek") {
        v.reapplied += 1;
        setTimeout(() => video() === el && seek(el, v.target), 0);
      }
    },
    true
  );
  const gesture = () => {
    userAt = Date.now();
  };
  document.addEventListener("pointerdown", gesture, true);
  document.addEventListener("keydown", gesture, true);
  document.addEventListener("yt-navigate-start", () => {
    save(true);
    navAt = Date.now();
  });
  document.addEventListener("yt-navigate-finish", () => startVisit());
  window.addEventListener("pagehide", () => save(true));

  // ---------- плашка «Вы остановились на 12:34 · Продолжить» ----------
  // Стиль — как у остальных плашек расширения в плеере (sleep.js, .ytcs-toast в content.js):
  // тёмная «таблетка» сверху по центру плеера.
  const ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 3.5V8H8"/><path d="M10.5 9.2v5.6l4.6-2.8z" fill="currentColor" stroke="none"/></svg>';
  const CSS = `
    :host { all: initial; position: absolute; top: 16px; left: 16px; right: 16px; z-index: 82;
      display: flex; justify-content: center; pointer-events: none; }
    .n { display: flex; align-items: center; gap: 10px; min-width: 0; max-width: 100%; box-sizing: border-box; padding: 7px 7px 7px 16px;
      border-radius: 999px; background: rgba(28, 28, 30, .9);
      -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6);
      box-shadow: 0 8px 30px rgba(0, 0, 0, .4), inset 0 0 0 1px rgba(255, 255, 255, .07);
      color: #f1f1f1; font: 500 16px/1.3 "YouTube Noto", Roboto, Arial, sans-serif;
      opacity: 0; transform: translateY(-8px) scale(.97); transform-origin: 50% 0;
      transition: opacity .18s ease, transform .26s cubic-bezier(.22, 1, .36, 1); }
    .n.show { opacity: 1; transform: none; pointer-events: auto; }
    svg { flex: none; width: 20px; height: 20px; color: #ff6b85; }
    .txt { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    b { font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums; }
    button { flex: none; height: 34px; padding: 2px 16px 0; border: 0; border-radius: 999px; font: inherit; font-weight: 600;
      background: #e8002d; color: #fff; cursor: pointer; transition: background-color .12s ease; }
    button:hover, button:focus-visible { background: #ff3b5c; outline: none; }
    button:active { background: #c70027; }
    .x { width: 34px; padding: 0; display: grid; place-items: center; background: rgba(255, 255, 255, .14); }
    .x:hover, .x:focus-visible { background: rgba(255, 255, 255, .24); }
    .x:active { background: rgba(255, 255, 255, .3); }
    .x svg { width: 16px; height: 16px; color: #fff; }
    /* узкий плеер: текст переносится — «таблетка» становится карточкой */
    @container (max-width: 420px) { .txt { white-space: normal; } .n { border-radius: 18px; } }
    @media (min-width: 1600px) { .n { zoom: 1.15; } }
    @media (min-width: 2200px) { .n { zoom: 1.35; } }
    @media (prefers-reduced-motion: reduce) { .n, button { transition: none; } }`;
  const X =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  const offer = { host: null, root: null, timer: 0, hover: false, visit: null };

  function hideOffer() {
    clearTimeout(offer.timer);
    offer.visit = null;
    offer.root?.querySelector(".n")?.classList.remove("show");
  }
  function armHide(ms) {
    clearTimeout(offer.timer);
    if (!offer.hover) offer.timer = setTimeout(hideOffer, ms);
  }

  function showOffer(v) {
    const p = player();
    if (!p || !p.getClientRects().length) return;
    if (!offer.host) {
      const host = document.createElement("div");
      host.id = "ytcs-resume-offer";
      host.style.containerType = "inline-size";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${CSS}</style>
        <div class="n" role="status" aria-live="polite">${ICON}<span class="txt"></span>
          <button type="button" class="go">Продолжить</button><button type="button" class="x" aria-label="Закрыть" title="Закрыть">${X}</button></div>`;
      // клики по плашке не должны ставить видео на паузу
      for (const t of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "keydown"]) {
        host.addEventListener(t, (e) => e.stopPropagation());
      }
      root.querySelector(".go").addEventListener("click", () => {
        const w = offer.visit;
        const el = video();
        hideOffer();
        if (!w || !el || w !== visit) return;
        seek(el, w.target);
        el.play?.().catch(() => {});
      });
      root.querySelector(".x").addEventListener("click", hideOffer);
      const box = root.querySelector(".n");
      box.addEventListener("mouseenter", () => {
        offer.hover = true;
        clearTimeout(offer.timer);
      });
      box.addEventListener("mouseleave", () => {
        offer.hover = false;
        if (offer.visit) armHide(4000);
      });
      offer.host = host;
      offer.root = root;
    }
    if (offer.host.parentElement !== p) p.appendChild(offer.host);
    offer.visit = v;
    offer.root.querySelector(".txt").innerHTML = `Вы остановились на <b>${core.clock(v.target)}</b>`;
    const box = offer.root.querySelector(".n");
    requestAnimationFrame(() => box.classList.add("show"));
    armHide(12000);
  }

  startVisit();
})();
