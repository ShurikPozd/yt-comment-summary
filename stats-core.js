// Статистика просмотра — общая логика без DOM и chrome.*: её используют фон
// (stats-bg.js — складывает прибавки от вкладок), страница «Статистика» в
// «Моей библиотеке» (library/stats-view.js) и автопроверки (tests/run.mjs).
//
// Хранение — chrome.storage.local["watchStats"], только на этом компьютере:
//   {
//     v: 1, since: 1732300000000,            // с какого момента собираем
//     days: { "2026-11-23": {                // по дням (локальная дата), до DAYS_KEEP дней
//       w: 1520,   // секунд смотрели обычные видео (реальное время, без рекламы и пауз)
//       s: 300,    // секунд смотрели Shorts
//       sp: 410,   // секунд сэкономила скорость быстрее 1×
//       sb: 95,    // секунд сэкономил пропуск рекламных вставок (SponsorBlock)
//       si: 30,    // секунд сэкономил пропуск тишины
//       n: 6,      // видео, которые смотрели дольше 30 с
//       fin: 3,    // видео досмотрено до конца (90% и дальше)
//       qd: 2,     // из очереди: досмотрено
//       qx: 4,     // из очереди: убрано без просмотра («Разобрать завалы», ×)
//     } },
//     ch: { "UC…" | "n:Название": {          // каналы, до CH_LIMIT штук
//       n: "Название", t: 1732300000000,     // t — когда последний раз смотрели
//       a: 12345,                            // секунд за всё время
//       d: { "2026-11-23": 600 },            // по дням — за последние CH_DAYS дней
//     } },
//   }
// Числа — целые секунды и штуки: так объект остаётся маленьким (≈ 30–60 КБ за год).

export const STATS_KEY = "watchStats";
export const DAYS_KEEP = 400; // по дням — чуть больше года
export const CH_DAYS = 92; // по дням у каналов — для топа за 7 / 30 / 90 дней
export const CH_LIMIT = 300; // каналов больше — вытесняем тех, кого давно не смотрели и мало
export const FIELDS = ["w", "s", "sp", "sb", "si", "n", "fin", "qd", "qx"];

const pad = (n) => String(n).padStart(2, "0");
// Локальная дата «2026-11-23» — день по часам компьютера, а не по Гринвичу
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// «2026-11-23» → полночь этого дня (локальная)
export function dayStart(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}
// Ключ дня на n дней раньше (без сюрпризов с переходом на летнее время)
export function shiftDay(key, n) {
  const [y, m, d] = String(key).split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + n, 12).getTime());
}

export function emptyStats(now = Date.now()) {
  return { v: 1, since: now, days: {}, ch: {} };
}

// Прочитанное из хранилища — к правильному виду (битое и чужое отбрасываем)
export function cleanStats(raw, now = Date.now()) {
  const out = emptyStats(Number(raw?.since) > 0 ? Number(raw.since) : now);
  const days = raw && typeof raw.days === "object" ? raw.days : {};
  for (const [k, v] of Object.entries(days)) {
    if (!/^\d{4}-\d\d-\d\d$/.test(k) || !v || typeof v !== "object") continue;
    const rec = {};
    for (const f of FIELDS) if (Number(v[f]) > 0) rec[f] = Math.round(Number(v[f]));
    if (Object.keys(rec).length) out.days[k] = rec;
  }
  const ch = raw && typeof raw.ch === "object" ? raw.ch : {};
  for (const [k, v] of Object.entries(ch)) {
    if (!v || typeof v !== "object" || !k) continue;
    const d = {};
    for (const [dk, sec] of Object.entries(v.d || {})) if (/^\d{4}-\d\d-\d\d$/.test(dk) && Number(sec) > 0) d[dk] = Math.round(Number(sec));
    out.ch[k] = { n: String(v.n || "").slice(0, 80), t: Number(v.t) || 0, a: Math.round(Number(v.a) || 0), d };
  }
  return out;
}

// Ключ канала: id YouTube (UC…), а если плеер его не сказал — по названию
export function channelKey(id, name) {
  if (typeof id === "string" && /^UC[A-Za-z0-9_-]{22}$/.test(id)) return id;
  const n = String(name || "").trim();
  return n ? `n:${n.slice(0, 80)}` : "";
}

// Прибавка от вкладки (или фона) к статистике. delta:
//   { day?: "2026-11-23", w, s, sp, sb, si, n, fin, qd, qx, ch?: { id, name, sec } }
// Отрицательные значения разрешены только для qd/qx («Вернуть» после «Досмотрел»)
// и не уводят ниже нуля. Возвращает тот же объект (изменённый).
export function addDelta(stats, delta, now = Date.now()) {
  if (!delta || typeof delta !== "object") return stats;
  const day = /^\d{4}-\d\d-\d\d$/.test(delta.day || "") ? delta.day : dayKey(now);
  const rec = (stats.days[day] ||= {});
  for (const f of FIELDS) {
    let x = Number(delta[f]);
    if (!Number.isFinite(x) || x === 0) continue;
    if (x < 0 && f !== "qd" && f !== "qx") continue;
    x = Math.max(-1e6, Math.min(x, 86400)); // больше суток за раз не бывает — защита от мусора
    const v = Math.max(0, (rec[f] || 0) + x);
    if (v > 0) rec[f] = Math.round(v * 100) / 100;
    else delete rec[f];
  }
  const c = delta.ch;
  const sec = Number(c?.sec);
  const key = c ? channelKey(c.id, c.name) : "";
  if (key && sec > 0) {
    // канал раньше знали только по названию — переносим к id
    const byName = channelKey("", c.name);
    if (key !== byName && stats.ch[byName]) {
      const old = stats.ch[byName];
      delete stats.ch[byName];
      const to = (stats.ch[key] ||= { n: old.n, t: old.t, a: 0, d: {} });
      to.a += old.a;
      for (const [dk, s] of Object.entries(old.d)) to.d[dk] = (to.d[dk] || 0) + s;
    }
    const e = (stats.ch[key] ||= { n: "", t: 0, a: 0, d: {} });
    if (c.name) e.n = String(c.name).trim().slice(0, 80);
    e.t = now;
    e.a = Math.round((e.a + Math.min(sec, 86400)) * 100) / 100;
    e.d[day] = Math.round(((e.d[day] || 0) + Math.min(sec, 86400)) * 100) / 100;
  }
  if (!Object.keys(rec).length) delete stats.days[day];
  return stats;
}

// Убрать старое: дни старше DAYS_KEEP, дни каналов старше CH_DAYS; каналов
// больше limit — вытесняем тех, кого меньше всего смотрели за последние CH_DAYS
// дней (при равенстве — кого дольше не открывали). Секунды — к целым.
export function prune(stats, now = Date.now(), limit = CH_LIMIT) {
  const today = dayKey(now);
  const oldDay = shiftDay(today, -DAYS_KEEP + 1);
  const oldCh = shiftDay(today, -CH_DAYS + 1);
  for (const k of Object.keys(stats.days)) {
    if (k < oldDay) delete stats.days[k];
    else for (const f of FIELDS) if (stats.days[k][f] != null) stats.days[k][f] = Math.round(stats.days[k][f]);
  }
  for (const e of Object.values(stats.ch)) {
    for (const k of Object.keys(e.d)) {
      if (k < oldCh) delete e.d[k];
      else e.d[k] = Math.round(e.d[k]);
    }
    e.a = Math.round(e.a);
  }
  const keys = Object.keys(stats.ch);
  if (keys.length > limit) {
    const recent = (e) => Object.values(e.d).reduce((a, x) => a + x, 0);
    keys
      .sort((a, b) => recent(stats.ch[a]) - recent(stats.ch[b]) || stats.ch[a].t - stats.ch[b].t)
      .slice(0, keys.length - limit)
      .forEach((k) => delete stats.ch[k]);
  }
  return stats;
}

const sumDays = (stats, from, to, f) => {
  let s = 0;
  for (const [k, v] of Object.entries(stats.days)) if (k >= from && k <= to) s += v[f] || 0;
  return s;
};

// Итоги за последние span дней (включая сегодня) — для страницы «Статистика».
//   { span, from, to, watch, video, shorts, speed, sponsor, silence, saved, n, fin, qd, qx,
//     avg, days, activeDays, series: [{ key, from, to, video, shorts }], channels: [{ key, name, sec, share }], other }
// series — по дням; при span > 31 — по неделям (столбики не тоньше пальца).
export function summarize(stats, span = 30, now = Date.now(), { top = 8 } = {}) {
  const to = dayKey(now);
  const from = shiftDay(to, -span + 1);
  const t = {};
  for (const f of FIELDS) t[f] = sumDays(stats, from, to, f);
  const series = [];
  const step = span > 31 ? 7 : 1;
  // недели считаем от сегодняшнего дня назад: последний столбик — 7 дней по сегодня
  for (let end = to, i = 0; i < Math.ceil(span / step); i++, end = shiftDay(end, -step)) {
    const start = shiftDay(end, -step + 1);
    const lo = start < from ? from : start;
    series.unshift({ key: lo, from: lo, to: end, video: sumDays(stats, lo, end, "w"), shorts: sumDays(stats, lo, end, "s") });
  }
  const chans = [];
  for (const [key, e] of Object.entries(stats.ch)) {
    let sec = 0;
    for (const [k, s] of Object.entries(e.d)) if (k >= from && k <= to) sec += s;
    if (sec >= 1) chans.push({ key, name: e.n || "Без названия", sec });
  }
  chans.sort((a, b) => b.sec - a.sec || a.name.localeCompare(b.name));
  const video = t.w;
  const watch = t.w + t.s;
  const known = chans.reduce((a, c) => a + c.sec, 0);
  const shown = chans.slice(0, top).map((c) => ({ ...c, share: video > 0 ? c.sec / video : 0 }));
  const rest = Math.max(0, known - shown.reduce((a, c) => a + c.sec, 0));
  let activeDays = 0;
  for (const [k, v] of Object.entries(stats.days)) if (k >= from && k <= to && (v.w || 0) + (v.s || 0) >= 60) activeDays++;
  // дней, за которые статистика вообще собиралась: начали считать позавчера —
  // среднее за 30 дней делим на 3, а не на 30
  const sinceKey = dayKey(Number(stats.since) > 0 ? stats.since : now);
  let days = span;
  if (sinceKey > from) days = Math.max(1, Math.round((dayStart(to) - dayStart(sinceKey)) / 86400000) + 1);
  return {
    span,
    from,
    to,
    watch,
    video,
    shorts: t.s,
    speed: t.sp,
    sponsor: t.sb,
    silence: t.si,
    saved: t.sp + t.sb + t.si,
    n: t.n,
    fin: t.fin,
    qd: t.qd,
    qx: t.qx,
    avg: watch / days,
    days,
    activeDays,
    series,
    channels: shown,
    other: { count: Math.max(0, chans.length - shown.length), sec: rest },
  };
}

// Сколько смотрели за сегодня / 7 / 30 дней — для плиток сверху
export function totals(stats, now = Date.now()) {
  const to = dayKey(now);
  const sum = (span) => {
    const from = shiftDay(to, -span + 1);
    return sumDays(stats, from, to, "w") + sumDays(stats, from, to, "s");
  };
  const y = shiftDay(to, -1);
  return { today: sum(1), week: sum(7), month: sum(30), yesterday: sumDays(stats, y, y, "w") + sumDays(stats, y, y, "s"), newToday: dayKey(Number(stats.since) || now) === to };
}

// Есть ли вообще что показать
export const hasData = (stats) => Object.keys(stats?.days || {}).length > 0;

// Длительность по-человечески: «35 с», «12 мин», «1 ч 05 мин», «128 ч»
export function fmtDur(sec, { short = false } = {}) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return s === 0 ? "0 мин" : `${s} с`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h >= 100 || (short && h >= 10)) return `${new Intl.NumberFormat("ru-RU").format(Math.round(s / 3600))} ч`;
  return mm ? `${h} ч ${pad(mm)} мин` : `${h} ч`;
}
