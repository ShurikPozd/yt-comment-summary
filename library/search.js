// Мгновенный поиск по каталогу «Моей библиотеки» — без сети и без ИИ.
// Ищет по названию видео, каналу и названиям плейлистов, где оно лежит:
//   - регистр и «ё/е» не важны, диакритика снимается;
//   - слово можно не дописать: «майнкр» найдёт «Майнкрафт»;
//   - опечатки прощаются: «майнкрафр» → «майнкрафт» (1 ошибка, у длинных слов 2);
//   - запрос в другой раскладке понимается: «ghbdtn» → «привет»;
//   - «-слово» исключает видео, где оно есть.
// Модуль чистый (без DOM), его можно проверять в Node.

import "../words-core.js"; // globalThis.__ytcsWords

const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU = "йцукенгшщзхъфывапролджэячсмитьбюё";
const SWAP = new Map();
for (let i = 0; i < EN.length; i++) {
  SWAP.set(EN[i], RU[i]);
  SWAP.set(RU[i], EN[i]);
}

// Нормализация, слова, основы и подсветка — общие с «Поиском по речи» в плеере (words-core.js)
const W = globalThis.__ytcsWords;
export const norm = W.norm;
export const tokens = W.tokens;
export const stem = W.stem;
export const highlight = W.highlight;

// Запрос, набранный не в той раскладке: каждую букву — на соседнюю клавишу
export function swapLayout(q) {
  let out = "";
  for (const c of String(q).toLowerCase()) out += SWAP.get(c) ?? c;
  return out;
}

// Расстояние Дамерау — Левенштейна с ранним выходом, если уже больше max
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

// Одна основа — начало другой, разница не больше двух букв, короткая не короче пяти
function related(a, b) {
  const [x, y] = a.length <= b.length ? [a, b] : [b, a];
  return x.length >= 5 && y.length - x.length <= 2 && y.startsWith(x);
}

const FIELD = { title: 3, channel: 2, playlist: 1 };

// docs: [{ id, title, channel, playlists: [название, ...] }]
export function buildIndex(docs) {
  const postings = new Map(); // слово → Map(номер документа → вес поля)
  const add = (word, d, w) => {
    let m = postings.get(word);
    if (!m) postings.set(word, (m = new Map()));
    if ((m.get(d) || 0) < w) m.set(d, w);
  };
  docs.forEach((doc, d) => {
    for (const t of tokens(doc.title)) add(t, d, FIELD.title);
    for (const t of tokens(doc.channel)) add(t, d, FIELD.channel);
    for (const p of doc.playlists || []) for (const t of tokens(p)) add(t, d, FIELD.playlist);
  });
  // словарь — по нему ищутся начала слов и опечатки
  const vocab = [...postings.keys()];
  return { docs, postings, vocab, stems: vocab.map(stem), titles: docs.map((d) => norm(d.title)) };
}

// Какие слова словаря подходят к слову запроса и насколько (0..1)
function expand(index, q, cache) {
  if (cache.has(q)) return cache.get(q);
  const out = new Map();
  const maxTypos = q.length >= 8 ? 2 : q.length >= 4 ? 1 : 0;
  const qs = stem(q);
  index.vocab.forEach((w, i) => {
    let s = 0;
    if (w === q) s = 1;
    else if (q.length >= 4 && index.stems[i] === qs) s = 0.9; // та же основа: «котики» → «котов»
    else if (w.startsWith(q)) s = q.length >= 2 ? 0.85 - Math.min(0.25, (w.length - q.length) * 0.02) : 0;
    else if (related(qs, index.stems[i])) s = 0.7; // родственные основы: «постройка» → «построить»
    // внутри слова — только в склейках вроде «minecraftbuild», не «наркотики» по «котики»
    else if (q.length >= 5 && w.length >= q.length + 4 && w.includes(q)) s = 0.5;
    else if (maxTypos && Math.abs(w.length - q.length) <= maxTypos + 3) {
      // опечатка в слове или в его начале («майнкрафр», «майнкрфт-билд»)
      const head = w.length > q.length ? w.slice(0, q.length) : w;
      const d = distance(q, head, maxTypos);
      if (d <= maxTypos) s = (head === w ? 0.7 : 0.6) - (d - 1) * 0.15;
    }
    if (s > 0) out.set(w, s);
  });
  cache.set(q, out);
  return out;
}

// Разбор запроса: обычные слова и исключённые «-слово»
export function parseQuery(q) {
  const plus = [];
  const minus = [];
  for (const part of String(q || "").split(/\s+/)) {
    if (!part) continue;
    if (part.startsWith("-") && part.length > 1) minus.push(...tokens(part.slice(1)));
    else plus.push(...tokens(part));
  }
  return { plus, minus };
}

function run(index, q, allow) {
  const { plus, minus } = parseQuery(q);
  const cache = new Map();
  const banned = new Set();
  for (const m of minus) for (const d of index.postings.get(m)?.keys() || []) banned.add(d);
  if (!plus.length) return { results: null, banned, words: [] };

  // по каждому слову запроса: документ → лучший счёт и какие слова совпали
  const perWord = plus.map((q) => {
    const best = new Map();
    for (const [w, s] of expand(index, q, cache)) {
      for (const [d, f] of index.postings.get(w)) {
        if (banned.has(d) || (allow && !allow(d))) continue;
        const v = s * f;
        const cur = best.get(d);
        if (!cur) best.set(d, { v, hits: [w] });
        else {
          cur.hits.push(w);
          if (v > cur.v) cur.v = v;
        }
      }
    }
    return best;
  });

  const scored = new Map();
  perWord.forEach((best) => {
    for (const [d, { v, hits }] of best) {
      let r = scored.get(d);
      if (!r) scored.set(d, (r = { d, score: 0, matched: 0, hits: new Set() }));
      r.score += v;
      r.matched++;
      hits.forEach((h) => r.hits.add(h));
    }
  });

  const phrase = plus.join(" ");
  const all = [...scored.values()];
  for (const r of all) {
    // целая фраза в названии — наверх; полное совпадение всех слов — выше частичного
    if (plus.length > 1 && index.titles[r.d].includes(phrase)) r.score += 4;
    r.score += r.matched === plus.length ? 100 : r.matched * 10;
  }
  const full = all.filter((r) => r.matched === plus.length);
  return { results: full.length ? full : all, partial: !full.length && all.length > 0, banned, words: plus };
}

// Поиск. allow(d) — фильтр (плейлисты, длительность). Возвращает:
//   results: [{ d, score, hits }] по убыванию счёта, или null — запрос пустой
//   partial: true — ни одно видео не подошло целиком, показаны частичные
//   swapped: строка — понят как запрос в другой раскладке
export function search(index, q, allow = null) {
  const first = run(index, q, allow);
  if (first.results === null) return { results: null, banned: first.banned, partial: false, swapped: null };
  const strong = first.results.length && !first.partial;
  if (!strong && /[a-z\[\];',.`]/i.test(q) !== /[а-яё]/i.test(q)) {
    const alt = swapLayout(q);
    const second = run(index, alt, allow);
    if (second.results?.length && (!second.partial || !first.results.length)) {
      second.results.sort((a, b) => b.score - a.score);
      return { ...second, swapped: alt };
    }
  }
  first.results.sort((a, b) => b.score - a.score);
  return { ...first, swapped: null };
}
