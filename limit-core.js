// Мягкий лимит времени — общая логика без DOM и chrome.*: её используют фон
// (limit-bg.js — считает время за день и решает, когда напомнить), страница
// «Статистика» в «Моей библиотеке» (library/limit-view.js), блок в настройках
// панели (sidepanel/limit-settings.js) и автопроверки (tests/run.mjs).
//
// Время — то же, что собирает статистика просмотра (stats.js): только реальное
// воспроизведение на youtube.com и в плеере «Моей библиотеки», без пауз и рекламы.
// Просмотр ничем не блокируется: при превышении — одна плашка поверх плеера
// (limit.js), после «Ещё 15 мин» — ещё одна через 15 минут просмотра.
//
// Хранение — chrome.storage.local:
//   watchLimit    = { on: false, min: 120 }      — настройка (по умолчанию выключено)
//   watchLimitDay = { day: "2026-11-25",          — «день лимита» (см. limitDay)
//                     sec: 6000,                  — секунд просмотра за этот день
//                     lim: 120,                   — при каком лимите (мин) напоминали
//                     next: null | 7500,          — после «Ещё 15 мин»: когда напомнить снова (сек)
//                     done: false }               — сегодня уже напомнили, больше не надо
//
// Новый день — в 4:00 утра, а не в полночь: досмотр «до часу ночи» относится к
// вечеру, а не начинает новый день с полным запасом времени (именно ночью лимит
// и нужен). Плитка «Сегодня» в статистике считает от полуночи — до 4 утра цифры
// могут расходиться, это объясняет подпись под полоской.

export const LIMIT_CFG_KEY = "watchLimit";
export const LIMIT_DAY_KEY = "watchLimitDay";
export const PRESETS = [30, 60, 90, 120, 180, 240]; // минут в день
export const DEFAULT_MIN = 120;
export const DAY_START_HOUR = 4;
export const SNOOZE_SEC = 15 * 60;

const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// «День лимита»: с 4:00 до 4:00 следующих суток (по часам компьютера).
// В 2:30 ночи 26-го — это ещё день «25-е».
export function limitDay(ts = Date.now()) {
  const d = new Date(ts);
  if (d.getHours() < DAY_START_HOUR) return keyOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12));
  return keyOf(d);
}

// Настройка из хранилища — к правильному виду
export function cleanCfg(raw) {
  const min = Number(raw?.min);
  return { on: raw?.on === true, min: PRESETS.includes(min) ? min : DEFAULT_MIN };
}

const fresh = (day) => ({ day, sec: 0, lim: 0, next: null, done: false });

// Запись дня из хранилища: битое — заново, вчерашнее — новый день с нуля
export function cleanDay(raw, now = Date.now()) {
  const day = limitDay(now);
  if (!raw || typeof raw !== "object" || raw.day !== day) return fresh(day);
  const sec = Number(raw.sec);
  const next = Number(raw.next);
  return {
    day,
    sec: Number.isFinite(sec) && sec > 0 ? Math.min(sec, 86400) : 0,
    lim: PRESETS.includes(Number(raw.lim)) ? Number(raw.lim) : 0,
    next: raw.next != null && Number.isFinite(next) && next > 0 ? next : null,
    done: raw.done === true,
  };
}

// Прибавить просмотренные секунды. seed — сколько уже насмотрено сегодня по
// статистике: берётся, только если записи ещё не было совсем (первый запуск
// после обновления расширения), чтобы лимит не начинал день с нуля.
export function addWatch(raw, sec, now = Date.now(), seed = 0) {
  const rec = cleanDay(raw, now);
  if (!raw && Number(seed) > 0) rec.sec = Math.min(Number(seed), 86400);
  const s = Number(sec);
  if (Number.isFinite(s) && s > 0) rec.sec = Math.min(rec.sec + Math.min(s, 3600), 86400);
  return rec;
}

// Пора напомнить? Один раз при пересечении лимита и ещё раз после «Ещё 15 мин».
// Поменяли лимит — счёт напоминаний начинается заново под новое значение.
export function shouldShow(raw, cfg, now = Date.now()) {
  const c = cleanCfg(cfg);
  if (!c.on) return false;
  const rec = cleanDay(raw, now);
  const limit = c.min * 60;
  if (rec.lim !== c.min) return rec.sec >= limit;
  if (rec.done) return false;
  return rec.sec >= (rec.next ?? limit);
}

// Плашку показали — больше сегодня не напоминаем (пока не нажмут «Ещё 15 мин»)
export function markShown(raw, cfg, now = Date.now()) {
  const rec = cleanDay(raw, now);
  return { ...rec, lim: cleanCfg(cfg).min, next: null, done: true };
}

// Кнопки плашки: "snooze" — «Ещё 15 мин»; "finish" (досмотреть и хватит) и
// "close" — на сегодня всё
export function applyAction(raw, act, now = Date.now()) {
  const rec = cleanDay(raw, now);
  if (act === "snooze") return { ...rec, done: false, next: rec.sec + SNOOZE_SEC };
  if (act === "finish" || act === "close") return { ...rec, done: true, next: null };
  return rec;
}

// Сколько насмотрено сегодня и сколько это от лимита — для полоски
export function progress(raw, cfg, now = Date.now()) {
  const c = cleanCfg(cfg);
  const sec = cleanDay(raw, now).sec;
  const limit = c.min * 60;
  return { sec, limit, frac: Math.min(1, sec / limit), over: sec >= limit, left: Math.max(0, limit - sec) };
}

// «30 мин», «1 ч», «1,5 ч», «2 ч»
export function fmtLimit(min) {
  const m = Number(min) || 0;
  if (m < 60) return `${m} мин`;
  return `${String(Math.round((m / 60) * 10) / 10).replace(".", ",")} ч`;
}

// Просмотренное — вниз до минуты (чтобы «уже 2 ч» не появилось раньше двух часов):
// «0 мин», «45 мин», «2 ч», «1 ч 05 мин» (как в статистике)
export function fmtSpent(sec) {
  const m = Math.floor(Math.max(0, Number(sec) || 0) / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h} ч ${pad(mm)} мин` : `${h} ч`;
}

// Остаток или перебор — вверх до минуты: «осталось 1 мин», а не «0 мин»
export function fmtLeft(sec) {
  const m = Math.ceil(Math.max(0, Number(sec) || 0) / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h} ч ${pad(mm)} мин` : `${h} ч`;
}
