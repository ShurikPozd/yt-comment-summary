"use strict";

// Повтор отрезка A–B — логика без DOM. Её используют abloop.js (страница YouTube и
// встроенный плеер «Моей библиотеки») и автопроверки (tests/run.mjs). Обычный скрипт,
// не модуль: контент-скрипты модулями не бывают — всё лежит в globalThis.__ytcsAbCore.
//
// Состояние: { a, b, free }
//   a, b — начало и конец отрезка в секундах видео (null — не отмечено);
//   free — вы сами перемотали дальше конца: повтор ждёт, пока вернётесь в отрезок
//          (иначе перемотка вперёд тут же возвращала бы к началу).
// Функции не меняют переданное состояние — возвращают новое.
(() => {
  const MIN_LEN = 1; // отрезок не короче секунды
  const END_GAP = 0.3; // конец видео: возвращаемся чуть раньше, чем YouTube включит следующее
  const EPS = 0.02;

  const num = (x) => (x == null || x === "" ? NaN : Number(x));
  const fin = (x) => Number.isFinite(num(x));
  const empty = () => ({ a: null, b: null, free: false });

  function clean(st) {
    const a = fin(st?.a) && num(st.a) >= 0 ? num(st.a) : null;
    const b = fin(st?.b) && num(st.b) >= 0 ? num(st.b) : null;
    if (a != null && b != null && b - a < MIN_LEN) return empty();
    return { a, b, free: Boolean(st?.free) && a != null && b != null };
  }

  const active = (st) => st?.a != null && st?.b != null;
  const any = (st) => st?.a != null || st?.b != null;

  // последняя секунда, до которой можно отметить: у видео известной длины — чуть до конца
  const lastAt = (dur) => (fin(dur) && num(dur) > 0 ? Math.max(0, num(dur) - END_GAP) : Infinity);
  const clampT = (t, dur) => Math.max(0, Math.min(num(t) || 0, lastAt(dur)));

  // Отметить начало (клавиша A, пункт меню).
  //   did: "a" — отмечено начало; "loop" — отрезок готов (конец был отмечен раньше);
  //        "off" — повтор снят (A при идущем повторе); "short" — короче секунды, без изменений.
  function setA(st, t, dur) {
    st = clean(st);
    if (active(st)) return { st: empty(), did: "off" };
    const x = clampT(t, dur);
    if (st.b == null) return { st: { a: x, b: null, free: false }, did: "a" };
    if (Math.abs(st.b - x) < MIN_LEN) return { st, did: "short" };
    // начало отметили позже конца — меняем местами
    const [a, b] = x < st.b ? [x, st.b] : [st.b, x];
    return { st: { a, b, free: false }, did: "loop" };
  }

  // Отметить конец (клавиша B, пункт меню). При идущем повторе — передвинуть конец.
  //   did: "b" — отмечен конец (начала ещё нет); "loop" — отрезок готов; "moved" — конец
  //        передвинут; "short" — короче секунды, без изменений.
  function setB(st, t, dur) {
    st = clean(st);
    const x = clampT(t, dur);
    if (st.a == null) return { st: { a: null, b: x, free: false }, did: "b" };
    if (Math.abs(x - st.a) < MIN_LEN) return { st, did: "short" };
    const [a, b] = x > st.a ? [st.a, x] : [x, st.a];
    return { st: { a, b, free: false }, did: active(st) ? "moved" : "loop" };
  }

  // Где кончается круг: конец отрезка, но не дальше, чем за END_GAP до конца видео
  function endOf(st, dur) {
    if (!active(st)) return NaN;
    return Math.min(st.b, lastAt(dur));
  }

  // Нужно ли вернуться к началу (сразу после отметки: стоим на конце или за ним)
  function needSeek(st, t, dur) {
    return active(st) && num(t) >= endOf(st, dur) - EPS;
  }

  // Ход повтора: t — время видео, userJump — вы сами перемотали с прошлого хода.
  //   wrap — пора вернуться к началу.
  function step(st, { t, dur, userJump = false } = {}) {
    st = clean(st);
    if (!active(st) || !fin(t)) return { st, wrap: false };
    const end = endOf(st, dur);
    if (num(t) < end - EPS) return { st: st.free ? { ...st, free: false } : st, wrap: false };
    // за концом: дошли сами (или вставку пропустило расширение) — к началу;
    // перемотали сами — повтор ждёт, пока вернётесь в отрезок
    if (userJump || st.free) return { st: st.free ? st : { ...st, free: true }, wrap: false };
    return { st, wrap: true };
  }

  // Через сколько мс проверить снова: ближе к концу — чаще, чтобы вернуться вовремя
  // и на скорости 4×; издалека — не чаще четырёх раз в секунду
  function delay(st, { t, dur, rate = 1 } = {}) {
    if (!active(st) || !fin(t)) return 250;
    const r = num(rate) > 0 ? num(rate) : 1;
    const left = ((endOf(st, dur) - num(t)) / r) * 1000;
    return Math.round(Math.max(16, Math.min(250, left - 15)));
  }

  // 75 → «1:15», 3725 → «1:02:05» (секунды — целые, как у таймкодов YouTube)
  function fmtTime(sec) {
    const s = Math.max(0, Math.floor(num(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }
  const range = (st) => `${fmtTime(st.a)}–${fmtTime(st.b)}`;

  // Плашка поверх плеера: { lead, time, key } — «Повтор 1:23–1:41», «Начало 1:23 · конец — B»
  function pill(st) {
    st = clean(st);
    if (active(st)) return { kind: "loop", lead: "Повтор", time: range(st), key: "" };
    if (st.a != null) return { kind: "a", lead: "Начало", time: fmtTime(st.a), key: "B", hint: "конец —" };
    if (st.b != null) return { kind: "b", lead: "Конец", time: fmtTime(st.b), key: "A", hint: "начало —" };
    return { kind: "off", lead: "", time: "", key: "" };
  }

  // Подпись справа в пункте меню «Повтор отрезка»
  function aside(st) {
    st = clean(st);
    if (active(st)) return range(st);
    if (st.a != null) return `A ${fmtTime(st.a)}`;
    if (st.b != null) return `B ${fmtTime(st.b)}`;
    return "";
  }

  // Отметки на полосе прогресса, в процентах длины видео
  function marks(st, dur) {
    st = clean(st);
    const d = num(dur);
    if (!(d > 0) || !Number.isFinite(d) || !any(st)) return null;
    const pct = (x) => Math.max(0, Math.min(100, (x / d) * 100));
    const out = { a: st.a != null ? pct(st.a) : null, b: st.b != null ? pct(st.b) : null, band: null };
    if (active(st)) out.band = { from: out.a, to: out.b };
    return out;
  }

  globalThis.__ytcsAbCore = { MIN_LEN, END_GAP, empty, clean, active, any, setA, setB, endOf, needSeek, step, delay, fmtTime, pill, aside, marks };
})();
