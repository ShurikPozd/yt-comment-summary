"use strict";

// «С того же места после обновления» — общая логика без DOM: её используют
// resume.js (страница YouTube) и автопроверки (tests/run.mjs). Обычный скрипт,
// не модуль: всё лежит в globalThis.__ytcsResumeCore.
//
// YouTube после F5 ставит видео на место из своей истории просмотра, а она
// обновляется раз в десятки секунд — видео откатывается назад на ~20 с. Мы
// каждую секунду кладём { id, t, d, at } в sessionStorage вкладки (переживает
// перезагрузку, у каждой вкладки своё) и после перезагрузки возвращаем t.
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

  globalThis.__ytcsResumeCore = { KEY, TTL_MS, MIN_T, END_GAP, pack, unpack, plan, sameVideo, needSeek };
})();
