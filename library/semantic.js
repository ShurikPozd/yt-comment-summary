// «Моя библиотека»: поиск по смыслу — находит видео по теме, даже без общих слов
// («что приготовить утром» → «Шакшука на завтрак», «learn english» → «Present Simple»).
//
// Модель paraphrase-multilingual-MiniLM-L12-v2 (русский, английский и ещё 50 языков)
// работает прямо в браузере через Transformers.js (vendor/transformers): один раз
// скачивается с Hugging Face (~120 МБ, кладётся в кеш браузера), дальше — без сети.
// Названия видео «читаются» один раз (вектор на видео) и хранятся в IndexedDB
// сжатыми до 8 бит; новые видео дочитываются после обновления каталога.

import { state } from "./state.js";
import { kv } from "./store.js";

const MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const KEY = "sem:v1";
const BATCH = 32;
const MIN_SCORE = 0.36; // ниже — уже не «по смыслу», а случайное

export const sem = {
  on: false, // включён ли поиск по смыслу (выбор запоминается)
  status: "off", // off | loading | indexing | ready | error
  dl: 0, // загрузка модели, %
  done: 0,
  total: 0,
  error: "",
  qvec: null, // { q, v } — вектор текущего запроса
};
let fe = null;
let index = null; // { dim, rows: Map(id → row), keys: [], vec: Int8Array, scale: Float32Array }
let listeners = [];
export const onSem = (f) => listeners.push(f);
const emit = () => listeners.forEach((f) => f());

const docText = (v) => `${v.title}${v.channel ? ` — ${v.channel}` : ""}`;
// у видео поменялось название — перечитать
const docKey = (v) => {
  let h = 0;
  for (const c of docText(v)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
};

async function loadModel() {
  if (fe) return fe;
  const { pipeline, env } = await import("../vendor/transformers/transformers.min.js");
  env.allowLocalModels = false;
  env.useBrowserCache = true; // модель — в кеш браузера, второй раз без сети
  const base = chrome.runtime.getURL("vendor/transformers/");
  env.backends.onnx.wasm.wasmPaths = { mjs: base + "ort-wasm-simd-threaded.asyncify.mjs", wasm: base + "ort-wasm-simd-threaded.asyncify.wasm" };
  env.backends.onnx.wasm.numThreads = 1; // многопоточность требует изоляции страницы — с ней не работал бы встроенный плеер
  const parts = new Map();
  fe = await pipeline("feature-extraction", MODEL, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (p) => {
      if (p.status !== "progress" || !p.total) return;
      parts.set(p.file, [p.loaded, p.total]);
      let a = 0;
      let b = 0;
      for (const [x, y] of parts.values()) {
        a += x;
        b += y;
      }
      sem.dl = Math.round((a / b) * 100);
      emit();
    },
  });
  return fe;
}

async function embed(texts) {
  const out = await (await loadModel())(texts, { pooling: "mean", normalize: true });
  return { data: out.data, dim: out.dims[1] };
}

function quantize(vec, dim, n) {
  const q = new Int8Array(n * dim);
  const scale = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 1e-9;
    for (let k = 0; k < dim; k++) m = Math.max(m, Math.abs(vec[i * dim + k]));
    scale[i] = m / 127;
    for (let k = 0; k < dim; k++) q[i * dim + k] = Math.round(vec[i * dim + k] / scale[i]);
  }
  return { q, scale };
}

async function loadIndex() {
  if (index) return index;
  const saved = await kv(KEY).catch(() => null);
  if (saved?.model === MODEL) {
    index = { dim: saved.dim, ids: saved.ids, keys: saved.keys, vec: new Int8Array(saved.vec), scale: new Float32Array(saved.scale) };
    index.rows = new Map(index.ids.map((id, i) => [id, i]));
  }
  return index;
}

async function saveIndex() {
  await kv(KEY, { model: MODEL, dim: index.dim, ids: index.ids, keys: index.keys, vec: index.vec.buffer, scale: index.scale.buffer });
}

// Прочитать названия, которых ещё нет в индексе (или которые поменялись)
export async function ensureIndex() {
  if (!state.cat || sem.status === "loading" || sem.status === "indexing") return;
  sem.error = "";
  try {
    if (!fe) {
      sem.status = "loading";
      emit();
      await loadModel();
    }
    await loadIndex();
    const vids = state.cat.videos;
    const todo = vids.filter((v) => {
      const r = index?.rows.get(v.id);
      return r == null || index.keys[r] !== docKey(v);
    });
    sem.total = todo.length;
    sem.done = 0;
    if (todo.length) {
      sem.status = "indexing";
      emit();
      let dim = index?.dim || 0;
      let lastSave = Date.now();
      for (let i = 0; i < todo.length; i += BATCH) {
        const part = todo.slice(i, i + BATCH);
        const e = await embed(part.map(docText));
        dim = e.dim;
        const { q, scale } = quantize(e.data, dim, part.length);
        if (!index) index = { dim, ids: [], keys: [], vec: new Int8Array(0), scale: new Float32Array(0), rows: new Map() };
        // дописываем: новые — в конец, изменившиеся — на своё место
        const add = part.filter((v) => !index.rows.has(v.id));
        const vec = new Int8Array(index.vec.length + add.length * dim);
        vec.set(index.vec);
        const sc = new Float32Array(index.scale.length + add.length);
        sc.set(index.scale);
        let next = index.ids.length;
        part.forEach((v, j) => {
          let r = index.rows.get(v.id);
          if (r == null) {
            r = next++;
            index.rows.set(v.id, r);
            index.ids.push(v.id);
            index.keys.push(0);
          }
          vec.set(q.subarray(j * dim, (j + 1) * dim), r * dim);
          sc[r] = scale[j];
          index.keys[r] = docKey(v);
        });
        index.vec = vec;
        index.scale = sc;
        index.dim = dim;
        sem.done = Math.min(todo.length, i + part.length);
        emit();
        if (Date.now() - lastSave > 15000) {
          await saveIndex(); // прервали на середине — продолжим с этого места
          lastSave = Date.now();
        }
        await new Promise((r) => setTimeout(r, 0)); // страница не замирает
      }
      await saveIndex();
    }
    sem.status = "ready";
    emit();
  } catch (e) {
    sem.status = "error";
    sem.error = String(e?.message || e);
    emit();
  }
}

// вектор запроса (ждать ~50 мс) — потом поиск синхронный
export async function embedQuery(q) {
  const text = q.trim();
  if (!text || sem.status !== "ready") return null;
  if (sem.qvec?.q === text) return sem.qvec;
  const e = await embed([text]);
  sem.qvec = { q: text, v: e.data };
  return sem.qvec;
}

// оценки по смыслу для документов каталога: Map(d → 0..1); только те, что выше порога
export function semanticScores(q, allow) {
  if (!index || sem.qvec?.q !== q.trim()) return null;
  const qv = sem.qvec.v;
  const dim = index.dim;
  const out = new Map();
  state.cat.videos.forEach((v, d) => {
    if (allow && !allow(d)) return;
    const r = index.rows.get(v.id);
    if (r == null) return;
    let s = 0;
    const off = r * dim;
    for (let k = 0; k < dim; k++) s += qv[k] * index.vec[off + k];
    s *= index.scale[r];
    if (s >= MIN_SCORE) out.set(d, s);
  });
  return out;
}

export async function setSemantic(on) {
  sem.on = on;
  await chrome.storage.local.set({ libSemantic: on });
  emit();
  if (on) await ensureIndex();
}

chrome.storage.local.get("libSemantic").then(({ libSemantic }) => {
  sem.on = Boolean(libSemantic);
  // включён — подгружаем молча, когда каталог готов
  if (sem.on) setTimeout(() => void ensureIndex(), 1500);
});
