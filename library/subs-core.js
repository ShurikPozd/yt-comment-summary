// «Моя библиотека»: поиск по субтитрам — чистое ядро (без DOM и сети, проверяется в Node).
//
//   - субтитры видео режутся на блоки ~25 с: { t — секунда начала, text };
//   - блоки хранятся сжатыми (deflate) — «t\tтекст» построчно;
//   - индекс: основа слова → номера блоков (номер = видео × SHIFT + блок), по возрастанию;
//   - поиск: все слова запроса в одном или соседних блоках — сильное совпадение,
//     просто в одном видео — слабое; минус-слова исключают видео;
//   - фрагмент: ~30 слов вокруг найденного и слова для подсветки.

import { parseQuery, stem, tokens } from "./search.js";

export const SPAN = 25; // секунд в блоке
export const SHIFT = 4096; // блоков на видео в номере (4096 × 25 с — больше суток)
const MAX_BLOCK = 700; // символов в блоке — длинная речь без пауз тоже режется

// [{ t, text }] (кусочки по 2–5 с) → блоки ~25 с
export function chunkSegments(segments, span = SPAN) {
  const out = [];
  let cur = null;
  for (const s of segments || []) {
    const text = String(s?.text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const t = Math.max(0, Math.floor(Number(s.t) || 0));
    if (!cur || t - cur.t >= span || cur.text.length >= MAX_BLOCK) out.push((cur = { t, text }));
    else cur.text += " " + text;
  }
  // очень длинная трансляция — блоки крупнее, чтобы номер блока поместился
  if (out.length >= SHIFT) return chunkSegments(segments, span * Math.ceil(out.length / (SHIFT - 1)) + 1);
  return out;
}

export const encodeBlocks = (blocks) => blocks.map((b) => `${b.t}\t${b.text.replace(/[\t\n]/g, " ")}`).join("\n");
export function decodeBlocks(s) {
  if (!s) return [];
  return s.split("\n").map((line) => {
    const i = line.indexOf("\t");
    return { t: Number(line.slice(0, i)) || 0, text: line.slice(i + 1) };
  });
}

async function through(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
// блоки → сжатые байты и обратно (CompressionStream есть и в браузере, и в Node 18+)
export const pack = (blocks) => through(new TextEncoder().encode(encodeBlocks(blocks)), new CompressionStream("deflate-raw"));
export const unpack = async (bytes) => decodeBlocks(new TextDecoder().decode(await through(bytes, new DecompressionStream("deflate-raw"))));

// ---------- индекс ----------
export function createIndex() {
  // docs[o] = { id, ts: секунды начала блоков, z: сжатые блоки } | null (заменён)
  return { docs: [], byId: new Map(), post: new Map(), stems: new Map(), blocks: 0 };
}

function stemOf(ix, w) {
  let s = ix.stems.get(w);
  if (s === undefined) {
    s = stem(w);
    if (ix.stems.size < 400000) ix.stems.set(w, s); // кеш основ — словарь речи большой, но конечный
  }
  return s;
}

// Слова блока: всё, кроме однобуквенных. Обычный русский/английский текст — быстрым путём
// (tokens() нормализует посимвольно — на тысячах видео это секунды), результат тот же.
const PLAIN = /^[\u0000-\u007fА-яЁё]*$/;
const PLAIN_WORD = /[a-z0-9а-я]+/g;
export function words(text) {
  const list = PLAIN.test(text) ? text.toLowerCase().replace(/ё/g, "е").match(PLAIN_WORD) || [] : tokens(text);
  return list.filter((w) => w.length > 1);
}

export function addDoc(ix, id, blocks, z = null) {
  const old = ix.byId.get(id);
  if (old != null) {
    ix.blocks -= ix.docs[old].ts.length;
    ix.docs[old] = null; // старые номера в индексе остаются, но больше никуда не ведут
  }
  const o = ix.docs.length;
  ix.docs.push({ id, ts: Uint32Array.from(blocks, (b) => b.t), z });
  ix.byId.set(id, o);
  ix.blocks += blocks.length;
  blocks.forEach((b, i) => {
    const key = o * SHIFT + i;
    const seen = new Set();
    for (const w of words(b.text)) {
      const s = stemOf(ix, w);
      if (seen.has(s)) continue;
      seen.add(s);
      let p = ix.post.get(s);
      if (!p) ix.post.set(s, (p = []));
      p.push(key);
    }
  });
  return o;
}

export function removeAll(ix) {
  Object.assign(ix, createIndex());
}

// Какие основы словаря подходят к слову запроса: та же основа — 1; если такой нет,
// слово, видимо, не дописано («майнкр» → «майнкрафт») — основы, которые так начинаются, 0.7.
// С дописанным словом префиксы не берём: «блок» не должен находить «блокнотик».
function matchTerms(ix, w) {
  const s = stem(w);
  const out = new Map();
  if (ix.post.has(s)) out.set(s, 1);
  else if (s.length >= 3) {
    for (const k of ix.post.keys()) if (k.length <= s.length + 7 && k.startsWith(s)) out.set(k, 0.7);
  }
  return out;
}

const alive = (ix, key) => ix.docs[Math.floor(key / SHIFT)] != null;

// Поиск: [{ id, b — блок, t — секунда, score 0..1 }] по убыванию, terms — основы для подсветки
export function searchSubs(ix, q, { limit = 2000 } = {}) {
  const { plus, minus } = parseQuery(q);
  const ws = [...new Set(plus.filter((w) => w.length > 1))];
  if (!ws.length || !ix.docs.length) return { results: [], terms: [] };
  const per = ws.map((w) => matchTerms(ix, w));
  if (per.some((m) => !m.size)) return { results: [], terms: [] };

  // минус-слово в субтитрах — видео не показываем
  const banned = new Set();
  for (const w of minus) for (const key of ix.post.get(stem(w)) || []) banned.add(Math.floor(key / SHIFT));

  // по каждому слову: номер блока → вес совпадения
  const maps = per.map((terms) => {
    const m = new Map();
    for (const [s, wt] of terms)
      for (const key of ix.post.get(s)) {
        if ((m.get(key) || 0) < wt) m.set(key, wt);
      }
    return m;
  });
  const order = maps.map((m, i) => i).sort((a, b) => maps[a].size - maps[b].size);
  const rare = maps[order[0]];

  const best = new Map(); // видео → { score, b, n }
  // сильные совпадения: все слова в этом блоке или по соседству
  for (const [key, wt0] of rare) {
    const o = Math.floor(key / SHIFT);
    if (banned.has(o) || !alive(ix, key)) continue;
    const blk = key % SHIFT;
    let from = key;
    let same = true;
    let sum = wt0;
    let ok = true;
    for (const i of order.slice(1)) {
      const m = maps[i];
      let wt = m.get(key);
      if (wt == null) {
        same = false;
        const prev = blk > 0 ? m.get(key - 1) : undefined;
        const next = m.get(key + 1);
        if (prev != null && (next == null || prev >= next)) {
          wt = prev;
          from = Math.min(from, key - 1);
        } else wt = next;
      }
      if (wt == null) {
        ok = false;
        break;
      }
      sum += wt;
    }
    if (!ok) continue;
    const score = 2 + (same ? 0.5 : 0) + 0.3 * (sum / ws.length);
    const cur = best.get(o);
    if (!cur) best.set(o, { score, b: from % SHIFT, n: 1 });
    else {
      cur.n++;
      if (score > cur.score) Object.assign(cur, { score, b: from % SHIFT });
    }
  }
  // слабые: все слова есть в видео, но врозь
  if (ws.length > 1) {
    const docSets = maps.map((m) => {
      const s = new Map();
      for (const [key, wt] of m) {
        const o = Math.floor(key / SHIFT);
        if (!s.has(o)) s.set(o, { key, wt });
        else if (wt > s.get(o).wt) s.get(o).wt = wt;
      }
      return s;
    });
    const first = docSets[order[0]];
    for (const [o, { key }] of first) {
      if (best.has(o) || banned.has(o) || !ix.docs[o]) continue;
      let sum = 0;
      let ok = true;
      for (const s of docSets) {
        const x = s.get(o);
        if (!x) {
          ok = false;
          break;
        }
        sum += x.wt;
      }
      if (ok) best.set(o, { score: 1 + 0.3 * (sum / ws.length), b: key % SHIFT, n: 0 });
    }
  }
  const results = [];
  for (const [o, r] of best) {
    const doc = ix.docs[o];
    // чем чаще встречается в видео, тем выше (немного)
    const score = Math.min(1, (r.score + 0.04 * Math.min(5, r.n)) / 3);
    results.push({ id: doc.id, o, b: r.b, t: doc.ts[r.b] ?? 0, score });
  }
  results.sort((a, b) => b.score - a.score || a.o - b.o);
  // основы по словам запроса — фрагмент выбирается так, чтобы в нём было побольше разных слов
  const terms = per.map((m) => [...m.keys()]);
  return { results: results.slice(0, limit), terms };
}

// Фрагмент вокруг найденного: блок b и следующий (слова могли попасть на стык).
// terms — основы по словам запроса: [[основы слова 1], [основы слова 2], …];
// окно выбирается так, чтобы в него попало больше разных слов запроса.
// Возвращает { text, hits } — hits: слова текста (как их нормализует поиск) для подсветки.
export function snippet(blocks, b, terms, { size = 28, before = 4 } = {}) {
  const groups = terms.map((g) => new Set(g));
  const group = (w) => {
    const s = stem(w);
    return groups.findIndex((g) => g.has(s) || g.has(w));
  };
  const text = [blocks[b]?.text, blocks[b + 1]?.text].filter(Boolean).join(" ");
  const parts = text.split(" ");
  const marks = parts.map((p) => {
    let m = 0;
    for (const w of words(p)) {
      const g = group(w);
      if (g >= 0) m |= 1 << Math.min(g, 30);
    }
    return m;
  });
  const bits = (x) => {
    let n = 0;
    for (; x; x &= x - 1) n++;
    return n;
  };
  // лучшее окно — больше разных слов; при равенстве — раньше
  let bestI = Math.max(0, marks.findIndex(Boolean));
  let bestN = 0;
  for (let i = 0; i < parts.length; i++) {
    if (!marks[i]) continue;
    let m = 0;
    for (let k = i; k < Math.min(parts.length, i + size - before); k++) m |= marks[k];
    if (bits(m) > bestN) {
      bestN = bits(m);
      bestI = i;
    }
  }
  const a = Math.max(0, bestI - before);
  const z = Math.min(parts.length, a + size);
  const cut = (a > 0 ? "…" : "") + parts.slice(a, z).join(" ") + (z < parts.length ? "…" : "");
  const hits = new Set();
  for (const w of tokens(cut)) if (w.length > 1 && group(w) >= 0) hits.add(w);
  return { text: cut, hits: [...hits] };
}
