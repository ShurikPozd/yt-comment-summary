"use strict";

// Пропуск тишины — детектор пауз без DOM: его используют silence.js (страница
// YouTube) и автопроверки (tests/run.mjs). Обычный скрипт, не модуль: всё лежит в
// globalThis.__ytcsSilenceCore.
//
// На вход — громкость звука кадрами (дБ от полной шкалы, RMS ~20 мс) и сколько
// миллисекунд ВИДЕО прошло с прошлого кадра. Порог свой у каждого ролика:
//  - «речь» — уровень громких мест: догоняет вверх быстро, вниз опускается медленно
//    и только по громким кадрам;
//  - «шум» — уровень тишины между фразами: вниз — быстро, вверх — только по тихим
//    кадрам (на 15 дБ тише речи; на 25 дБ тише — быстрее, это точно пауза);
//  - порог тишины — чуть выше шума (на 30 % разницы, от 6 до 12 дБ), выход из тишины —
//    на 4 дБ выше (гистерезис: на границе порога скорость не дёргается);
//  - разница речь/шум меньше 15 дБ (музыка, шумная запись) — ничего не делаем.
// Тишина — тише порога не короче 250 мс (паузы между словами короче — их не трогаем);
// конец тишины — сразу, как только громче верхнего порога, или 60 мс выше нижнего.
(() => {
  const MIN_PAUSE = 250; // мс видео
  const RELEASE = 60; // мс видео
  const WARMUP = 2500; // мс звука, прежде чем решать
  const CONTRAST = 15; // дБ
  const QUIET = 15; // дБ ниже речи — кадр годится для оценки шума
  const DEEP = 25; // дБ ниже речи — точно пауза: шум по ней узнаём быстрее
  const FLOOR_DB = -90; // тише — считаем цифровой тишиной
  const MAX_RATE = 4; // звук браузер сохраняет до 4×
  const FACTOR = 2.5; // во сколько раз быстрее идут паузы

  const k = (dt, tau) => 1 - Math.exp(-dt / tau);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  // RMS кадра → дБ
  function levelDb(samples) {
    let s = 0;
    const n = samples?.length || 0;
    for (let i = 0; i < n; i++) s += samples[i] * samples[i];
    return n ? Math.max(FLOOR_DB, 20 * Math.log10(Math.sqrt(s / n) + 1e-12)) : FLOOR_DB;
  }

  function createDetector() {
    const st = { speech: -40, floor: FLOOR_DB, heard: 0, silent: false, below: 0, above: 0 };

    const thresholds = () => {
      const low = st.floor + clamp((st.speech - st.floor) * 0.3, 6, 12);
      return { low, high: low + 4 };
    };
    const ready = () => st.heard >= WARMUP && st.speech - st.floor >= CONTRAST;

    function push(db, dt) {
      db = Number.isFinite(db) ? Math.max(FLOOR_DB, db) : FLOOR_DB;
      dt = clamp(Number(dt) || 0, 0, 250);
      const { low, high } = thresholds();
      // уровни ролика
      if (db > st.speech) st.speech += (db - st.speech) * k(dt, 150);
      else if (db > high) st.speech += (db - st.speech) * k(dt, 8000);
      if (db < st.floor) st.floor += (db - st.floor) * k(dt, 100);
      else if (db < st.speech - QUIET) st.floor += (db - st.floor) * k(dt, db < st.speech - DEEP ? 400 : 2500);
      if (db > -80) st.heard += dt; // почти цифровая тишина (начало ролика) — ещё не звук
      // тишина / речь
      if (!st.silent) {
        st.below = db < low ? st.below + dt : 0;
        if (st.below >= MIN_PAUSE) {
          st.silent = true;
          st.above = 0;
        }
      } else if (db > high) {
        st.silent = false;
        st.below = 0;
      } else {
        st.above = db > low ? st.above + dt : 0;
        if (st.above >= RELEASE) {
          st.silent = false;
          st.below = 0;
        }
      }
      return ready() && st.silent;
    }

    // перемотка, пауза, реклама: тишину начинаем считать заново, уровни ролика помним
    function interrupt() {
      st.silent = false;
      st.below = 0;
      st.above = 0;
    }

    return {
      push,
      interrupt,
      ready,
      get silent() {
        return ready() && st.silent;
      },
      state: () => ({ ...st, ...thresholds(), ready: ready() }),
    };
  }

  // Скорость в паузе при вашей скорости base: в 2,5 раза быстрее, но не выше 4×;
  // выигрыш меньше четверти (вы и так смотрите на 3,25× и быстрее) — не ускоряем.
  function boostRate(base) {
    const b = Number(base);
    if (!Number.isFinite(b) || b <= 0) return null;
    const r = Math.min(MAX_RATE, Math.round(b * FACTOR * 4) / 4);
    return r >= b * 1.25 ? r : null;
  }

  // Сэкономлено за кадр: dt секунд при скорости rate вместо base
  const savedSec = (dt, rate, base) => (base > 0 && rate > base ? dt * (rate / base - 1) : 0);

  // «40 с», «3 мин», «1 ч 5 мин»
  function fmtSaved(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s < 60) return `${s} с`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} мин`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h} ч ${m % 60} мин` : `${h} ч`;
  }

  // Итог в хранилище: chrome.storage.local.silenceSaved =
  //   { sec: за день day, day: "2026-11-23" (местная дата), total: за всё время,
  //     days: { "2026-11-23": сек, … } — последние 90 дней }
  // С новым днём sec начинается с нуля. Читает и статистика просмотра (stats.js).
  const DAYS = 90;
  function dayKey(d = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function addSaved(prev, sec, day = dayKey()) {
    const o = prev && typeof prev === "object" ? prev : {};
    const add = Math.max(0, Number(sec) || 0);
    const days = { ...(o.days && typeof o.days === "object" ? o.days : {}) };
    days[day] = Math.round(((Number(days[day]) || 0) + add) * 10) / 10;
    const keys = Object.keys(days).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - DAYS))) delete days[old];
    return { sec: days[day], day, total: Math.round(((Number(o.total) || 0) + add) * 10) / 10, days };
  }
  // за сегодня (запись могла остаться со вчера)
  const todaySaved = (o, day = dayKey()) => Number(o?.days?.[day]) || 0;

  globalThis.__ytcsSilenceCore = { createDetector, levelDb, boostRate, savedSec, fmtSaved, addSaved, todaySaved, dayKey, storeKey: "silenceSaved", MIN_PAUSE, MAX_RATE };
})();
