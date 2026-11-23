// «Дайджест подписок»: чистая логика без страницы — слияние свежей ленты с
// сохранённой, что считать «новым», группы по дням и по каналам.
// Проверяется автотестами (tests/run.mjs) без браузера.

export const WEEK = 7 * 864e5; // сколько дней держим
export const MAX = 300; // и не больше стольких видео
export const MAX_PAGES = 15; // страниц ленты за одно обновление (обычно хватает 6–10)
export const DIGEST_STALE = 30 * 60e3; // старше — обновляем сами при открытии
export const READ_MAX = 5000; // сколько «прочитанных» id помнить

// Когда видео вышло: по «3 часа назад» из ленты, а если YouTube времени не дал
// (Shorts, эфиры) — когда мы его впервые увидели
export const timeOf = (it) => it.at || it.seenAt || 0;
export const isSoon = (it) => Boolean(it.upAt || it.upText);

// Свежая лента + сохранённая → один список, новые сверху.
//  - время «N часов назад» точнее, пока видео свежее: у знакомого видео время
//    оставляем первое (вчерашнее «3 часа назад» точнее сегодняшнего «1 день назад»);
//  - видео, которых нет в свежей ленте (YouTube отдаёт Shorts и дальние страницы
//    не всегда), держим, пока им меньше недели;
//  - старше недели — убираем, всего — не больше MAX.
export function mergeFeed(old, fresh, now = Date.now()) {
  const prev = new Map((old || []).map((x) => [x.id, x]));
  const out = [];
  const seen = new Set();
  for (const f of fresh || []) {
    if (!f?.id || seen.has(f.id)) continue;
    seen.add(f.id);
    const o = prev.get(f.id);
    const at = o?.at || f.at;
    out.push({ ...f, at: isSoon(f) || f.live ? 0 : at || 0, seenAt: o?.seenAt || now });
  }
  for (const o of old || []) if (!seen.has(o.id) && !o.live && !isSoon(o)) out.push(o);
  const order = new Map(out.map((x, i) => [x.id, i]));
  return out
    .filter((x) => isSoon(x) || x.live || now - timeOf(x) <= WEEK)
    .sort((a, b) => timeOf(b) - timeOf(a) || order.get(a.id) - order.get(b.id))
    .slice(0, MAX);
}

// Хватит ли страниц: набрали MAX или самое старое обычное видео — старше недели
export function enough(items, now = Date.now()) {
  if (items.length >= MAX) return true;
  return items.some((x) => !x.short && x.at && now - x.at > WEEK);
}

// ---------- «новое» и что показывать ----------
// marks: { read: Set|[] id, readAt, hidden: Set|[] id, hiddenCh: [{ id, name }] }
export function norm(marks) {
  const m = marks || {};
  return {
    read: m.read instanceof Set ? m.read : new Set(m.read || []),
    readAt: Number(m.readAt) || 0,
    hidden: m.hidden instanceof Set ? m.hidden : new Set(m.hidden || []),
    hiddenCh: Array.isArray(m.hiddenCh) ? m.hiddenCh : [],
  };
}
export const chKey = (it) => it.channelId || (it.channel ? `name:${it.channel}` : "");
export const isNew = (it, m) => !m.read.has(it.id);

// prefs: { show: "new" | "all", shorts: "shelf" | "hide" }, ch — только этот канал
export function visible(items, marks, prefs = {}, { ch = "", onlyNew = prefs.show === "new" } = {}) {
  const m = norm(marks);
  const hiddenCh = new Set(m.hiddenCh.map((c) => c.id));
  return (items || []).filter(
    (it) =>
      !m.hidden.has(it.id) &&
      !hiddenCh.has(chKey(it)) &&
      !(it.short && prefs.shorts === "hide") &&
      (!ch || chKey(it) === ch) &&
      (!onlyNew || isNew(it, m))
  );
}

export const newCount = (items, marks, prefs = {}) => visible(items, marks, prefs, { onlyNew: true }).length;

// «Всё просмотрено»: всё, что сейчас есть, — прочитано (список не растёт бесконечно)
export function markAllRead(marks, items, now = Date.now()) {
  const m = norm(marks);
  const read = [...new Set([...(items || []).map((x) => x.id), ...m.read])].slice(0, READ_MAX);
  return { ...m, read: new Set(read), readAt: now };
}

// ---------- группы ----------
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const WD = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
const MON = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
export function dayLabel(key, now = Date.now()) {
  if (key === dayKey(now)) return "Сегодня";
  if (key === dayKey(now - 864e5)) return "Вчера";
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${WD[dt.getDay()]}, ${d} ${MON[m - 1]}`;
}

// Группы для показа: [{ key, kind, title, items, channelId?, avatar? }]
//  по дням:    Сегодня (сверху — эфиры и премьеры) · Вчера · … · Shorts
//              (отдельные группы из одного эфира давали бы пустые строки)
//  по каналам: каналы (где больше нового — выше, потом — где свежее) · Shorts без канала
export function groupItems(list, mode, marks, now = Date.now()) {
  const m = norm(marks);
  const groups = [];
  const shorts = [];
  const top = []; // эфиры, потом премьеры — в начало «Сегодня»
  const rest = [];
  for (const it of list) {
    if (it.short && (mode === "day" || !chKey(it))) shorts.push(it);
    else if (mode === "day" && (it.live || isSoon(it))) top.push(it);
    else rest.push(it);
  }
  if (mode === "channel") {
    const by = new Map();
    for (const it of rest) {
      const k = chKey(it);
      if (!by.has(k)) by.set(k, { key: `ch:${k}`, kind: "channel", title: it.channel || "Без названия", channelId: k, avatar: "", items: [] });
      const g = by.get(k);
      g.items.push(it);
      if (!g.avatar && it.avatar) g.avatar = it.avatar;
    }
    const fresh = (g) => g.items.filter((x) => isNew(x, m)).length;
    const last = (g) => Math.max(...g.items.map(timeOf));
    groups.push(...[...by.values()].sort((a, b) => fresh(b) - fresh(a) || last(b) - last(a) || a.title.localeCompare(b.title, "ru")));
  } else {
    const by = new Map();
    const today = dayKey(now);
    if (top.length) by.set(today, { key: `day:${today}`, kind: "day", title: dayLabel(today, now), items: top.sort((a, b) => Number(Boolean(b.live)) - Number(Boolean(a.live))) });
    for (const it of rest) {
      const k = dayKey(timeOf(it) || now);
      if (!by.has(k)) by.set(k, { key: `day:${k}`, kind: "day", title: dayLabel(k, now), items: [] });
      by.get(k).items.push(it);
    }
    groups.push(...[...by.values()].sort((a, b) => (a.key < b.key ? 1 : -1)));
  }
  if (shorts.length) groups.push({ key: "shorts", kind: "shorts", title: "Shorts", items: shorts });
  return groups;
}

// Каналы для колонки слева: сколько видео и сколько нового (по видимым видео)
export function channelsOf(list, marks) {
  const m = norm(marks);
  const by = new Map();
  for (const it of list) {
    const k = chKey(it);
    if (!k) continue;
    if (!by.has(k)) by.set(k, { id: k, name: it.channel || "Без названия", avatar: it.avatar || "", n: 0, fresh: 0, last: 0 });
    const c = by.get(k);
    c.n++;
    if (isNew(it, m)) c.fresh++;
    c.last = Math.max(c.last, timeOf(it));
    if (!c.avatar && it.avatar) c.avatar = it.avatar;
  }
  return [...by.values()].sort((a, b) => b.fresh - a.fresh || b.last - a.last || a.name.localeCompare(b.name, "ru"));
}

// Что из канала ставить в очередь разом: обычные видео (не эфиры, не премьеры), старые — первыми
export const queueable = (items) => items.filter((x) => !x.live && !isSoon(x)).sort((a, b) => timeOf(a) - timeOf(b));
