// «Моя библиотека»: быстрое обновление — что изменилось в плейлисте с прошлого раза.
// Чистая логика без браузера (проверяется в tests/run.mjs).
//
// Идея. Плейлист читаем с начала, страница за страницей. После каждой страницы
// смотрим: совпал ли «хвост» прочитанного с куском прошлого списка, и сходится ли
// тогда число видео с тем, что пишет YouTube. Если сходится — дальше всё как было:
// берём остаток из сохранённого каталога и не читаем тысячи видео заново.
//   • ничего не менялось — хватает первой страницы;
//   • новые лайки сверху «Понравившихся», убрали просмотренное в начале
//     «Смотреть позже» — тоже первая страница (или несколько);
//   • изменение где-то в глубине — дочитываем до него.
// Совпадения «на глаз» нет: если YouTube пишет, что плейлист обновлялся после
// прошлой проверки, а на видимых страницах всё по-старому — читаем его целиком.
// Раз в сутки всё перечитывается полностью (FULL_EVERY) — на случай, когда два
// изменения в глубине взаимно погасили счётчик.

export const FULL_EVERY = 24 * 3600 * 1000; // полное перечитывание — не реже
export const CAP = 5000; // больше YouTube не показывает («Понравившиеся», «Смотреть позже»)
export const MIN_RUN = 20; // столько видео подряд должны совпасть, чтобы склеить с прошлым

// ключ записи плейлиста: номер записи (повторы одного видео различаются), иначе id
export const entryKey = (id, setId) => setId || id;

// полное обновление пора делать само?
export function fullDue(cat, now = Date.now()) {
  return !cat?.fullAt || now - cat.fullAt > FULL_EVERY;
}

// номер дня по местному календарю
export function dayOf(ts) {
  const d = new Date(ts);
  return Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 864e5);
}

const MONTHS = [
  [/^янв|^jan/i, 0], [/^фев|^feb/i, 1], [/^мар|^mar/i, 2], [/^апр|^apr/i, 3], [/^ма[йя]|^may/i, 4], [/^июн|^jun/i, 5],
  [/^июл|^jul/i, 6], [/^авг|^aug/i, 7], [/^сен|^sep/i, 8], [/^окт|^oct/i, 9], [/^ноя|^nov/i, 10], [/^дек|^dec/i, 11],
];
const month = (w) => MONTHS.find(([re]) => re.test(w))?.[1] ?? -1;

// «Обновлено вчера», «Обновлено 3 дня назад», «Обновлено 12 окт. 2025 г.», «Updated today»
// → номер дня (как dayOf) или null, если не разобрали
export function updDay(text, now = Date.now()) {
  const s = String(text || "").toLowerCase();
  if (!/обновл|updated/.test(s)) return null;
  const today = dayOf(now);
  if (/сегодня|today|только что|just now|(\d+)\s*(сек|мин|час|second|minute|hour)/.test(s)) return today;
  if (/вчера|yesterday/.test(s)) return today - 1;
  let m = s.match(/(\d+)\s*(дн|день|day)/);
  if (m) return today - Number(m[1]);
  m = s.match(/(\d+)\s*(нед|week)/);
  if (m) return today - 7 * Number(m[1]);
  m = s.match(/(\d{1,2})\s+([a-zа-яё]+)\.?\s+(\d{4})/); // 12 окт. 2025
  if (m && month(m[2]) >= 0) return dayOf(new Date(Number(m[3]), month(m[2]), Number(m[1])).getTime());
  m = s.match(/([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/); // Oct 12, 2025
  if (m && month(m[1]) >= 0) return dayOf(new Date(Number(m[3]), month(m[1]), Number(m[2])).getTime());
  return null;
}

// «7 000 видео», «1,234 videos» → 7000 / 1234; иначе null
export function countOf(text) {
  const m = String(text || "").match(/^\s*([\d\s.,]+?)\s*(видео|videos?)\s*$/i);
  if (!m) return null;
  const n = Number(m[1].replace(/\D/g, ""));
  return Number.isFinite(n) && m[1].replace(/\D/g, "") ? n : null;
}

// Склейка прочитанного начала с прошлым списком.
//   read — ключи, прочитанные с начала плейлиста (по порядку);
//   old — ключи прошлого списка этого плейлиста;
//   now / was — сколько видео в плейлисте по словам YouTube сейчас и в прошлый раз.
// Ответ: null — читать дальше; { from, drop } — дальше как было: новый список =
// read + old.slice(from), а с конца убрать drop (плейлист упёрся в предел CAP).
export function splice(read, old, now, was, minRun = MIN_RUN) {
  if (!Number.isFinite(now) || !Number.isFinite(was) || !old?.length) return null;
  const L = Math.min(minRun, read.length);
  if (L < Math.min(5, minRun)) return null;
  const tail = read.slice(read.length - L);
  const last = tail[L - 1];
  const delta = now - was;
  let capped = null;
  for (let e = L - 1; e < old.length; e++) {
    if (old[e] !== last) continue;
    let same = true;
    for (let i = 0; i < L && same; i++) same = old[e - L + 1 + i] === tail[i];
    if (!same) continue;
    const grew = read.length - (e + 1); // насколько начало стало длиннее прошлого
    if (grew === delta) return { from: e + 1, drop: 0 };
    // упёрлись в предел: сверху прибавилось, а с конца YouTube столько же отрезал
    if (!capped && now === was && now >= CAP && grew > 0) capped = { from: e + 1, drop: grew };
  }
  return capped;
}

// Совпадает ли список плейлиста с прошлым (для «изменились N»)
export function sameList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Можно ли склеивать этот плейлист с прошлым или читать целиком.
//   old — запись плейлиста из прошлого каталога, full — полное обновление
export function canSplice(old, full) {
  return Boolean(!full && old && !old.failed && Number.isFinite(old.head) && old.checked);
}

// Видимое начало совпало с прошлым один в один, но YouTube пишет, что плейлист
// менялся после прошлой проверки — значит, изменение в глубине: читаем целиком.
export function touchedSince(old, updText, now = Date.now()) {
  const d = updDay(updText, now);
  return d != null && Boolean(old?.checked) && d > dayOf(old.checked);
}

// Списки плейлистов из каталога, каждый по порядку мест:
// { key, pos, setId, v } — видео, { key, pos, setId, g } — удалённое (из cat.gone)
export function listsOf(cat) {
  const out = new Map();
  if (!cat) return out;
  const add = (pid, e) => {
    if (!out.has(pid)) out.set(pid, []);
    out.get(pid).push(e);
  };
  for (const v of cat.videos || []) for (const [pid, pos, setId = ""] of v.in) add(pid, { key: entryKey(v.id, setId), pos, setId, v });
  for (const g of cat.gone || []) add(g.pid, { key: entryKey(g.id, g.setId), pos: g.pos, setId: g.setId || "", g });
  for (const list of out.values()) list.sort((a, b) => a.pos - b.pos);
  return out;
}

// Прочитать один плейлист — целиком или до места, где он сходится с прошлым.
//   page(token, from) → { items, next, head? } — запрос к YouTube (playlists-main.js);
//   old — запись плейлиста из прошлого каталога, olds — его список (listsOf);
//   full — читать целиком; lib — { count, updated } со страницы «Плейлисты» (запасной);
//   onItem(v) — каждое прочитанное видео (свежие данные — в каталог).
// Ответ: { head, upd, pages, reuse — продолжение из прошлого каталога (места
// продолжают прочитанные), count, changed — список стал не таким, как был }.
export async function readPlaylist({ page, old, olds = [], full = false, lib = null, onItem = () => {}, now = Date.now() }) {
  const oldKeys = olds.map((e) => e.key);
  let glue = canSplice(old, full);
  const read = [];
  let token = null;
  let lastPos = 0;
  let tail = null;
  let head = null;
  let upd = "";
  let pages = 0;
  for (; pages < 300; ) {
    const r = await page(token, read.length);
    if (!pages) {
      head = r.head?.count ?? lib?.count ?? null;
      upd = r.head?.updated || lib?.updated || "";
    }
    pages++;
    for (const v of r.items || []) {
      if (!v.id) continue;
      read.push(entryKey(v.id, v.setId));
      lastPos = Math.max(lastPos, v.pos || 0);
      onItem(v);
    }
    token = r.next;
    if (!token) break;
    if (!glue) continue;
    const s = splice(read, oldKeys, head, old.head);
    if (!s) continue;
    // начало такое же, как было, а YouTube пишет «обновлено» после прошлой проверки —
    // изменение где-то в глубине: дочитываем плейлист целиком
    if (!s.drop && s.from === read.length && sameList(read, oldKeys.slice(0, read.length)) && touchedSince(old, upd, now)) {
      glue = false;
      continue;
    }
    tail = olds.slice(s.from, Math.max(s.from, olds.length - s.drop));
    break;
  }
  const reuse = (tail || []).map((e, i) => ({ ...e, pos: lastPos + i + 1 }));
  const keys = reuse.length ? read.concat(reuse.map((e) => e.key)) : read;
  return { head, upd, pages, reuse, count: keys.length, changed: !old || !sameList(keys, oldKeys) };
}

// Из плейлиста убрали n записей прямо из библиотеки: каталог уже без них, а YouTube
// теперь насчитает на n меньше — сдвигаем и запомненное число, иначе быстрое
// обновление сочтёт плейлист изменившимся и перечитает его целиком
export function shrink(p, n) {
  if (!p || !n) return;
  p.count = Math.max(0, (p.count || 0) - n);
  if (Number.isFinite(p.head)) p.head = Math.max(0, p.head - n);
}

// Итог для второй строки статуса: «3 плейлиста изменились, +15 и −2 видео»
export function syncSummary({ changed, added, removed }) {
  const parts = [];
  if (changed) parts.push(`${changed} ${plural(changed, "плейлист", "плейлиста", "плейлистов")} ${plural(changed, "изменился", "изменились", "изменились")}`);
  if (added || removed) parts.push([added && `+${nfmt(added)}`, removed && `−${nfmt(removed)}`].filter(Boolean).join(" и ") + " видео");
  return parts.join(", ") || "изменений нет";
}

const nfmt = (n) => new Intl.NumberFormat("ru-RU").format(n);
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
}
