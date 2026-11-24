"use strict";

// «С того же места после обновления» — общая логика без DOM: её используют
// resume.js (страница YouTube) и автопроверки (tests/run.mjs). Обычный скрипт,
// не модуль: всё лежит в globalThis.__ytcsResumeCore.
//
// YouTube после F5 ставит видео на место из своей истории просмотра, а она
// обновляется раз в десятки секунд — видео откатывается назад на ~20 с. Мы
// каждую секунду кладём { id, t, d, at } в sessionStorage вкладки (переживает
// перезагрузку, у каждой вкладки своё) и после перезагрузки возвращаем t.
// А раз в 10 с — ещё и в chrome.storage.local (см. «надолго» ниже).
(() => {
  const KEY = "ytcs:resume";
  const TTL_MS = 12 * 3600 * 1000; // запись старше — не наша сессия просмотра
  const MIN_T = 5; // первые секунды — не о чем жалеть
  const END_GAP = 5; // у самого конца — видео досмотрено, начнёт YouTube как обычно
  const DRIFT = 2; // разница меньше — не дёргаем плеер

  /** Запись для sessionStorage. Эфир (duration Infinity) и пустое — null. */
  function pack({ id, t, d, now }) {
    if (!id || !Number.isFinite(t) || !Number.isFinite(d) || d <= 0) return null;
    return { id: String(id), t: Math.round(t * 10) / 10, d: Math.round(d * 10) / 10, at: now };
  }

  function unpack(raw) {
    let o = null;
    try {
      o = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) {
      return null;
    }
    if (!o || typeof o.id !== "string" || !Number.isFinite(o.t) || !Number.isFinite(o.d) || !Number.isFinite(o.at)) return null;
    return { id: o.id, t: o.t, d: o.d, at: o.at };
  }

  /** Куда вернуть видео при загрузке страницы (секунда) или null — не трогаем.
   *  nav — тип загрузки документа: возвращаем только после «Обновить» и
   *  «Назад/Вперёд» (и восстановления вкладок), но не при обычном переходе. */
  function plan(saved, { id, nav, now }) {
    if (!saved || !id || saved.id !== id) return null;
    if (nav !== "reload" && nav !== "back_forward") return null;
    if (!(now - saved.at >= 0 && now - saved.at < TTL_MS)) return null;
    if (saved.t < MIN_T || saved.t > saved.d - END_GAP) return null;
    return saved.t;
  }

  /** Тот ли это ролик (а не реклама перед ним): длительность совпадает. */
  function sameVideo(saved, duration) {
    return Number.isFinite(duration) && Math.abs(duration - saved.d) < 1.5;
  }

  /** Нужно ли переставить: видео стоит заметно в другом месте. */
  function needSeek(target, currentTime) {
    return Number.isFinite(currentTime) && Math.abs(currentTime - target) > DRIFT;
  }

  // ---------- надолго: chrome.storage.local, переживает закрытие вкладки и браузера ----------
  // { [id]: { t, d, at } } — до LONG_MAX роликов, не старше LONG_TTL_MS. Открыли
  // ролик снова: если YouTube сам поставил его чуть раньше (его история отстаёт
  // на десятки секунд) — тихо догоняем; если начал с нуля — плашка «Продолжить с 12:34».
  const LONG_KEY = "resumeLong";
  const LONG_MAX = 400;
  const LONG_TTL_MS = 60 * 24 * 3600 * 1000;
  const LONG_MIN = 30; // меньше полуминуты — не о чем напоминать
  const LONG_END = 30; // последние полминуты (титры) — считаем досмотренным
  const CATCH_UP = 90; // YouTube поставил не дальше стольких секунд позади — догоняем молча

  /** Новая таблица мест: запись rec добавлена (или убрана — ролик досмотрен), лишнее срезано. */
  function put(map, rec, now) {
    const out = {};
    for (const [id, r] of Object.entries(map && typeof map === "object" ? map : {})) {
      if (r && Number.isFinite(r.t) && Number.isFinite(r.d) && Number.isFinite(r.at) && now - r.at < LONG_TTL_MS) out[id] = r;
    }
    // досмотрели — забываем; первые полминуты (открыл и закрыл) — прежнее место не трогаем
    if (rec && rec.t > rec.d - LONG_END) delete out[rec.id];
    else if (rec && rec.t >= LONG_MIN) {
      delete out[rec.id]; // заново в конец — порядок ключей не важен, но так нагляднее
      out[rec.id] = { t: rec.t, d: rec.d, at: rec.at };
    }
    const ids = Object.keys(out);
    if (ids.length > LONG_MAX) {
      ids.sort((a, b) => out[a].at - out[b].at);
      for (const id of ids.slice(0, ids.length - LONG_MAX)) delete out[id];
    }
    return out;
  }

  /** Сохранённое место ролика id или null. urlT — в адресе есть &t= (место выбрано явно). */
  function longTarget(map, { id, now, urlT }) {
    const r = id && map && typeof map === "object" ? map[id] : null;
    if (urlT || !r || !Number.isFinite(r.t) || !Number.isFinite(r.d) || !Number.isFinite(r.at)) return null;
    if (!(now - r.at >= 0 && now - r.at < LONG_TTL_MS)) return null;
    if (r.t < LONG_MIN || r.t > r.d - LONG_END) return null;
    return { id, t: r.t, d: r.d, at: r.at };
  }

  /** Ролик загрузился и стоит на currentTime: "none" — уже там (или дальше: досмотрели
   *  на другом устройстве), "seek" — YouTube отстал чуть-чуть, догоняем, "offer" — спросить. */
  function longAction(target, currentTime) {
    if (!Number.isFinite(currentTime) || currentTime >= target - DRIFT) return "none";
    if (currentTime > MIN_T && currentTime >= target - CATCH_UP) return "seek";
    return "offer";
  }

  /** 754 → "12:34", 3723 → "1:02:03". */
  function clock(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  globalThis.__ytcsResumeCore = {
    KEY, TTL_MS, MIN_T, END_GAP, pack, unpack, plan, sameVideo, needSeek,
    LONG_KEY, LONG_MAX, LONG_TTL_MS, LONG_MIN, LONG_END, CATCH_UP, put, longTarget, longAction, clock,
  };
})();
