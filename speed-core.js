"use strict";

// Скорость по каналам — общая логика без DOM: её используют speed.js (страница
// YouTube и встроенный плеер «Моей библиотеки»), настройки боковой панели и
// автопроверки (tests/run.mjs). Обычный скрипт, не модуль: контент-скрипты
// модулями не бывают — всё лежит в globalThis.__ytcsSpeedCore.
//
// Хранение — chrome.storage.local["channelSpeeds"]:
//   { "UC…": { r: 1.5, n: "Название канала", t: 1732300000000 } }
// r — скорость, n — название (для плашки и списка в настройках), t — когда
// последний раз меняли или применяли (для вытеснения самых старых).
(() => {
  const storeKey = "channelSpeeds";
  const LIMIT = 400; // ~60 байт на канал — около 25 КБ в худшем случае
  const MIN = 0.25;
  const MAX = 4;

  // id канала YouTube: UC + 22 символа
  const isChannelId = (id) => typeof id === "string" && /^UC[A-Za-z0-9_-]{22}$/.test(id);

  // Скорость к виду хранения: число в пределах плеера, до сотых (1.25, 1.5, 1.05)
  function cleanRate(r) {
    const n = Number(r);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(Math.min(MAX, Math.max(MIN, n)) * 100) / 100;
  }

  const same = (a, b) => Math.abs(Number(a) - Number(b)) < 0.001;

  // 1.5 → «1,5×», 1.25 → «1,25×», 2 → «2×»
  function fmtRate(r) {
    const n = cleanRate(r);
    if (n == null) return "";
    return String(n).replace(".", ",") + "×";
  }

  // Запись для канала из хранилища — только целая и правильная
  function entryOf(map, id) {
    const e = map && isChannelId(id) ? map[id] : null;
    const r = cleanRate(e?.r);
    return r == null ? null : { r, n: String(e.n || ""), t: Number(e.t) || 0 };
  }

  // Запомнить скорость канала. Возвращает новый объект; сверх LIMIT
  // вытесняются каналы, которые дольше всех не открывали.
  function remember(map, id, rate, name, now = Date.now(), limit = LIMIT) {
    const r = cleanRate(rate);
    if (!isChannelId(id) || r == null) return { ...(map || {}) };
    const next = { ...(map || {}) };
    const prev = entryOf(next, id);
    next[id] = { r, n: String(name || prev?.n || "").trim().slice(0, 80), t: now };
    const ids = Object.keys(next);
    if (ids.length > limit) {
      ids
        .filter((k) => k !== id)
        .sort((a, b) => (Number(next[a]?.t) || 0) - (Number(next[b]?.t) || 0))
        .slice(0, ids.length - limit)
        .forEach((k) => delete next[k]);
    }
    return next;
  }

  function forget(map, id) {
    const next = { ...(map || {}) };
    delete next[id];
    return next;
  }

  // Отметить, что канал снова открывали (для вытеснения), не меняя скорость
  function touch(map, id, name, now = Date.now()) {
    const e = entryOf(map, id);
    if (!e) return map || {};
    return { ...map, [id]: { r: e.r, n: String(name || e.n || "").trim().slice(0, 80), t: now } };
  }

  // Что сделать со скоростью нового видео.
  //   enabled   — общая настройка «Запоминать скорость по каналам»;
  //   stored    — запомненная скорость канала или null;
  //   current   — скорость плеера сейчас;
  //   carried   — скорость, которую на прошлом видео этой вкладки поставили
  //               мы или вы (YouTube переносит её на следующее видео) — или null;
  //   userChose — вы уже сами меняли скорость в этом видео;
  //   live      — прямой эфир (или ещё не начался).
  // Ответ: { rate, why: "channel" | "restore" } или null — ничего не трогать.
  //  - у канала есть скорость → ставим её;
  //  - скорости нет, а плеер держит перенесённую с прошлого видео (лекции 1,5×
  //    не должны «утечь» на музыку) → обычная 1×;
  //  - ваш выбор в этом видео и эфиры не трогаем никогда.
  function plan({ enabled, stored, current, carried, userChose, live }) {
    if (!enabled || userChose || live) return null;
    const cur = cleanRate(current);
    if (cur == null) return null;
    const want = cleanRate(stored);
    if (want != null) return same(want, cur) ? null : { rate: want, why: "channel" };
    if (carried != null && same(carried, cur) && !same(cur, 1)) return { rate: 1, why: "restore" };
    return null;
  }

  // Список для настроек: сначала недавние
  function list(map) {
    return Object.keys(map || {})
      .map((id) => ({ id, ...entryOf(map, id) }))
      .filter((e) => e.r != null)
      .sort((a, b) => b.t - a.t);
  }

  globalThis.__ytcsSpeedCore = { storeKey, LIMIT, isChannelId, cleanRate, same, fmtRate, entryOf, remember, forget, touch, plan, list };
})();
