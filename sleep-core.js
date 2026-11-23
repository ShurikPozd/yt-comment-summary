"use strict";

// Таймер сна — общая логика без DOM: её используют sleep.js (страница YouTube и
// встроенный плеер «Моей библиотеки») и автопроверки (tests/run.mjs). Обычный
// скрипт, не модуль: контент-скрипты модулями не бывают — всё лежит в
// globalThis.__ytcsSleepCore.
//
// Состояние таймера: { mode: "off" | "min" | "end", left, preset }
//   min  — остановить через left мс воспроизведения (preset — выбранные минуты);
//   end  — остановить в конце текущего видео.
// Время считается по часам, а не по видео: при скорости 2× 30 минут остаются
// 30 минутами. Пока видео на паузе — таймер стоит.
(() => {
  const PRESETS = [15, 30, 45, 60, 90];
  const FADE_MS = 20000; // затухание громкости перед остановкой
  const MAX_GAP_MS = 70000; // больше между проверками — компьютер спал, не считаем
  const TTL_MS = 3 * 3600 * 1000; // сохранённый таймер старше — забываем
  const storeKey = "ytcs-sleep";

  const OFF = Object.freeze({ mode: "off", left: 0, preset: 0 });

  // Новый таймер по выбору в меню: 15/30/… минут, "end" или "off"
  function make(choice) {
    if (choice === "end") return { mode: "end", left: 0, preset: 0 };
    const m = Number(choice);
    if (PRESETS.includes(m)) return { mode: "min", left: m * 60000, preset: m };
    return { ...OFF };
  }

  // Горячая клавиша: выкл. → 15 → 30 → 45 → 60 → 90 мин → в конце видео → выкл.
  function next(st) {
    if (!st || st.mode === "off") return make(PRESETS[0]);
    if (st.mode === "end") return { ...OFF };
    const i = PRESETS.indexOf(st.preset);
    return i >= 0 && i < PRESETS.length - 1 ? make(PRESETS[i + 1]) : make("end");
  }

  // Прошло dt мс; таймер минут идёт, только пока видео играет
  function advance(st, dt, playing) {
    if (!st || st.mode !== "min" || !playing) return st;
    const d = Math.min(Math.max(0, Number(dt) || 0), MAX_GAP_MS);
    return { ...st, left: Math.max(0, st.left - d) };
  }

  // Сколько реального времени осталось до остановки (мс) или null — не известно.
  // «В конце видео»: остаток ролика делим на скорость (2× — вдвое быстрее).
  function remaining(st, video) {
    if (!st || st.mode === "off") return null;
    if (st.mode === "min") return Math.max(0, st.left);
    const dur = Number(video?.duration);
    const t = Number(video?.currentTime);
    if (!Number.isFinite(dur) || !(dur > 0) || !Number.isFinite(t)) return null; // эфир или ещё не загрузилось
    const rate = Number(video?.playbackRate) > 0 ? Number(video.playbackRate) : 1;
    return (Math.max(0, dur - t) / rate) * 1000;
  }

  // Громкость при затухании: 1 → 0 за последние span мс. Квадрат — на слух
  // ровнее, чем прямая (тихие ступени слышны сильнее громких).
  function fadeFactor(left, span = FADE_MS) {
    if (left == null || !(span > 0) || left >= span) return 1;
    const x = Math.max(0, left) / span;
    return x * x;
  }

  // 23 мин; меньше минуты — секунды (по 5, чтобы не мельтешило)
  function fmtLeft(ms) {
    if (ms == null) return "";
    if (ms >= 60000) return `${Math.ceil(ms / 60000)} мин`;
    return `${Math.max(1, Math.ceil(ms / 5000) * 5)} с`.replace(/^60 с$/, "1 мин");
  }

  // Подпись в меню: «осталось 23 мин» / «в конце видео»
  function label(st, left) {
    if (!st || st.mode === "off") return "";
    if (st.mode === "end") return left != null && left < FADE_MS ? `осталось ${fmtLeft(left)}` : "в конце видео";
    return `осталось ${fmtLeft(left ?? st.left)}`;
  }

  // Для sessionStorage: таймер переживает переход по очереди (полная загрузка страницы)
  function pack(st, now = Date.now()) {
    if (!st || st.mode === "off") return null;
    return JSON.stringify({ m: st.mode, l: Math.round(st.left), p: st.preset, at: now });
  }
  function unpack(s, now = Date.now()) {
    let o = null;
    try {
      o = JSON.parse(s);
    } catch (e) {
      return { ...OFF };
    }
    if (!o || typeof o !== "object" || !(now - Number(o.at) < TTL_MS) || Number(o.at) > now + 60000) return { ...OFF };
    if (o.m === "end") return make("end");
    const l = Number(o.l);
    if (o.m !== "min" || !Number.isFinite(l) || l <= 0 || l > 24 * 3600000) return { ...OFF };
    return { mode: "min", left: l, preset: PRESETS.includes(o.p) ? o.p : 0 };
  }

  globalThis.__ytcsSleepCore = { PRESETS, FADE_MS, MAX_GAP_MS, storeKey, make, next, advance, remaining, fadeFactor, fmtLeft, label, pack, unpack };
})();
