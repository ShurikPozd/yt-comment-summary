// Поиск по смыслу — модель в отдельном потоке: пока она читает тысячи названий,
// страница библиотеки не подвисает (прокрутка, поиск, плеер работают как обычно).
//
// Сообщения: { id, type: "init", base } — загрузить модель (base — адрес vendor/transformers/);
//            { id, type: "embed", texts } — векторы для текстов.
// Ответы:    { id, ok: true, data, dim } | { id, ok: false, error } | { type: "progress", pct }.

const MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
let fe = null;
let loading = null;

async function load(base) {
  if (fe) return fe;
  if (loading) return loading;
  loading = (async () => {
    const { pipeline, env } = await import("../vendor/transformers/transformers.min.js");
    env.allowLocalModels = false;
    env.useBrowserCache = true; // модель — в кеш браузера, второй раз без сети
    // без кеша загрузчика ONNX: Transformers.js подключает его через blob:-адрес, а правила
    // безопасности страниц расширения (CSP: только 'self') такие адреса запрещают —
    // «no available backend found … Failed to fetch dynamically imported module: blob:…».
    // Загрузчик и wasm берутся прямо из vendor/transformers (свои файлы, без сети).
    env.useWasmCache = false;
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
        self.postMessage({ type: "progress", pct: Math.round((a / b) * 100) });
      },
    });
    return fe;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

self.onmessage = async (e) => {
  const { id, type, base, texts } = e.data || {};
  try {
    if (type === "init") {
      await load(base);
      self.postMessage({ id, ok: true });
    } else if (type === "embed") {
      const out = await (await load(base))(texts, { pooling: "mean", normalize: true });
      const data = new Float32Array(out.data);
      self.postMessage({ id, ok: true, data, dim: out.dims[1] }, [data.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
