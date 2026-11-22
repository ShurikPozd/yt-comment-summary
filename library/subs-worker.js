// Поиск по субтитрам — отдельный поток: хранит субтитры (IndexedDB «ytcs-subs»),
// держит индекс в памяти и ищет. Страница только скачивает субтитры и рисует.
// Тысячи видео разбираются здесь — прокрутка, поиск и плеер не подвисают.
//
// Сообщения:  { id, type: "init" }                         → { stats, known: [[videoId, s, retry]] }
//             { id, type: "put", vid, segments | err }     → { stats }  (segments: [] — субтитров нет)
//             { id, type: "search", q, limit }             → { results: [{ id, t, score, snip, hits }] }
//             { id, type: "clear" }                        → { stats }
// От потока:  { type: "ready", stats } — индекс собран; { type: "added", vid, s, retry, stats } — из другой вкладки.
//
// Запись в базе: { id, s: "ok" | "none" | "err", at, n — блоков, z — сжатые блоки, retry — когда повторить (err) }

import { addDoc, chunkSegments, createIndex, pack, removeAll, searchSubs, snippet, unpack } from "./subs-core.js";

const DB = "ytcs-subs";
const ERR_RETRY = 7 * 24 * 3600 * 1000; // не отдались субтитры — попробуем через неделю
let db = null;
const ix = createIndex();
const known = new Map(); // videoId → { s, retry, size }
let loaded = null;
const bc = new BroadcastChannel("ytcs-subs"); // другие вкладки библиотеки

function open() {
  if (db) return db;
  db = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("v", { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return db;
}

async function tx(mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction("v", mode);
    const out = fn(t.objectStore("v"));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("запись прервана"));
  });
}

function stats() {
  let ok = 0;
  let none = 0;
  let err = 0;
  let bytes = 0;
  for (const k of known.values()) {
    if (k.s === "ok") ok++;
    else if (k.s === "none") none++;
    else err++;
    bytes += k.size || 0;
  }
  return { ok, none, err, bytes, blocks: ix.blocks };
}

async function useRecord(r) {
  known.set(r.id, { s: r.s, retry: r.retry || 0, size: r.z?.byteLength || 0 });
  if (r.s === "ok" && r.z) addDoc(ix, r.id, await unpack(r.z), r.z);
}

// при открытии — всё прочитанное в индекс (порциями, чтобы успевать отвечать)
function load() {
  if (loaded) return loaded;
  loaded = (async () => {
    const all = (await tx("readonly", (st) => st.getAll())) || [];
    for (let i = 0; i < all.length; i++) {
      await useRecord(all[i]);
      if (i % 200 === 199) await new Promise((r) => setTimeout(r, 0));
    }
    self.postMessage({ type: "ready", stats: stats() });
  })();
  return loaded;
}

async function put(vid, segments, err) {
  await load();
  const at = Date.now();
  let rec;
  if (err) rec = { id: vid, s: "err", at, retry: at + ERR_RETRY, error: String(err).slice(0, 200) };
  else {
    const blocks = chunkSegments(segments);
    rec = blocks.length ? { id: vid, s: "ok", at, n: blocks.length, z: await pack(blocks) } : { id: vid, s: "none", at };
  }
  await tx("readwrite", (st) => st.put(rec));
  await useRecord(rec);
  bc.postMessage({ added: vid });
  return rec;
}

// кеш разобранных блоков для фрагментов — недавние видео
const cache = new Map();
async function blocksOf(o) {
  let b = cache.get(o);
  if (b) return b;
  b = await unpack(ix.docs[o].z);
  cache.set(o, b);
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return b;
}

const SNIPS = 400; // фрагменты — для первых; дальше по прокрутке редко доходят

async function search(q, limit) {
  await load();
  const { results, terms } = searchSubs(ix, q, { limit });
  const out = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const x = { id: r.id, t: r.t, score: r.score };
    if (i < SNIPS && ix.docs[r.o]?.z) {
      const s = snippet(await blocksOf(r.o), r.b, terms);
      x.snip = s.text;
      x.hits = s.hits;
    }
    out.push(x);
  }
  return out;
}

async function clear() {
  await tx("readwrite", (st) => st.clear());
  known.clear();
  cache.clear();
  removeAll(ix);
  bc.postMessage({ cleared: true });
}

bc.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.cleared) {
      known.clear();
      cache.clear();
      removeAll(ix);
      self.postMessage({ type: "added", stats: stats() });
    } else if (m.added && loaded) {
      await loaded;
      const r = await tx("readonly", (st) => st.get(m.added));
      if (r) {
        await useRecord(r);
        self.postMessage({ type: "added", vid: r.id, s: r.s, retry: r.retry || 0, stats: stats() });
      }
    }
  } catch (err) {
    /* другая вкладка записала — подхватим при следующем открытии */
  }
};

self.onmessage = async (e) => {
  const { id, type } = e.data || {};
  try {
    if (type === "init") {
      await load();
      self.postMessage({ id, ok: true, stats: stats(), known: [...known].map(([v, k]) => [v, k.s, k.retry]) });
    } else if (type === "put") {
      const r = await put(e.data.vid, e.data.segments || [], e.data.err);
      self.postMessage({ id, ok: true, s: r.s, retry: r.retry || 0, stats: stats() });
    } else if (type === "search") {
      self.postMessage({ id, ok: true, results: await search(e.data.q, e.data.limit || 2000) });
    } else if (type === "clear") {
      await clear();
      self.postMessage({ id, ok: true, stats: stats() });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
