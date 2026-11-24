"use strict";

// «С того же места после обновления»: после F5 (и «Назад/Вперёд», восстановления
// вкладок) видео продолжается с той секунды, где было, а не на ~20 с раньше.
//  - каждую секунду просмотра место кладётся в sessionStorage вкладки
//    (resume-core.js: { id, t, d, at });
//  - после перезагрузки ждём сам ролик (не рекламу: длительность совпадает) и
//    ставим сохранённую секунду; если YouTube следом сам перематывает на своё
//    место из истории — возвращаем ещё раз (до двух раз, в первые 4 с);
//  - перемотал сам, пока ролик грузился, — не вмешиваемся.
(() => {
  if (window.top !== window || location.pathname.startsWith("/embed/")) return;
  const core = globalThis.__ytcsResumeCore;
  if (!core || globalThis.__ytcsResume) return;
  globalThis.__ytcsResume = true;
  const KEY = core.KEY;

  const curId = () => (location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null);
  const video = () => document.querySelector("#movie_player video.html5-main-video") || document.querySelector("#movie_player video");
  const adShowing = () => Boolean(document.querySelector("#movie_player")?.classList.contains("ad-showing"));

  function read() {
    try {
      return core.unpack(sessionStorage.getItem(KEY));
    } catch (e) {
      return null;
    }
  }
  function write(rec) {
    if (!rec) return;
    try {
      sessionStorage.setItem(KEY, JSON.stringify(rec));
    } catch (e) {
      /* хранилище недоступно — просто не помним */
    }
  }

  let nav = "navigate";
  try {
    nav = performance.getEntriesByType("navigation")[0]?.type || "navigate";
  } catch (e) {
    /* старый браузер — считаем обычным переходом */
  }

  const startId = curId();
  const saved = read();
  const target = core.plan(saved, { id: startId, nav, now: Date.now() });
  // Пока место не вернули, не записываем: иначе первая же секунда с места
  // YouTube затрёт наше.
  let pending = target !== null;
  let guardUntil = 0;
  let reapplied = 0;
  let ourSeek = false;
  let userAt = 0;
  let savedAt = 0;
  let poll = 0;

  function seek(v) {
    ourSeek = true;
    v.currentTime = target;
  }

  function stopPending() {
    pending = false;
    clearInterval(poll);
  }

  function tryRestore() {
    if (!pending) return;
    if (curId() !== startId) return stopPending(); // ушли на другое видео
    const v = video();
    if (!v || adShowing()) return; // идёт реклама
    if (!core.sameVideo(saved, v.duration)) {
      // другой длины и уже играет — ролик заменили (или это не он): не ждём, иначе
      // всё это время место не записывалось бы
      if (Number.isFinite(v.duration) && v.duration > 0 && v.currentTime > 3) stopPending();
      return; // ещё не загрузился
    }
    if (core.needSeek(target, v.currentTime)) seek(v);
    stopPending();
    guardUntil = Date.now() + 4000;
  }

  function save(force) {
    if (pending) return;
    const v = video();
    const id = curId();
    if (!v || !id || adShowing()) return;
    const now = Date.now();
    if (!force && now - savedAt < 1000) return;
    savedAt = now;
    write(core.pack({ id, t: v.currentTime, d: v.duration, now }));
  }

  // Видео-события не всплывают, но проходят фазу перехвата — слушаем на document.
  document.addEventListener(
    "timeupdate",
    (e) => {
      if (e.target !== video()) return;
      if (pending) tryRestore();
      else save(false);
    },
    true
  );
  for (const type of ["loadedmetadata", "durationchange", "canplay", "playing"]) {
    document.addEventListener(type, (e) => e.target === video() && tryRestore(), true);
  }
  document.addEventListener(
    "seeking",
    (e) => {
      const v = video();
      if (e.target !== v) return;
      if (ourSeek) {
        ourSeek = false;
        return;
      }
      const byUser = Date.now() - userAt < 1500;
      if (pending && byUser) return stopPending(); // перемотал сам — его выбор
      // YouTube уже после нас откатил видео на своё место из истории — возвращаем.
      // Только назад: вперёд перематывает пропуск спонсорских вставок (sponsor.js).
      if (!pending && !byUser && Date.now() < guardUntil && reapplied < 2 && v.currentTime < target && core.needSeek(target, v.currentTime)) {
        reapplied += 1;
        setTimeout(() => video() === v && core.needSeek(target, v.currentTime) && seek(v), 0);
      }
    },
    true
  );
  const gesture = () => {
    userAt = Date.now();
  };
  document.addEventListener("pointerdown", gesture, true);
  document.addEventListener("keydown", gesture, true);
  window.addEventListener("pagehide", () => save(true));

  // Пока видео на паузе (автозапуск выключен), timeupdate не идёт — проверяем сами.
  // Долгая реклама — ждём до 2 минут, дальше не вмешиваемся.
  const startedAt = Date.now();
  if (pending) {
    poll = setInterval(() => {
      if (Date.now() - startedAt > 120000) return stopPending();
      tryRestore();
    }, 400);
    tryRestore();
  }
})();
