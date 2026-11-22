// «Моя библиотека»: поиск по субтитрам — находит видео по тому, что в них говорят,
// и открывает с нужного места.
//
// Субтитры читаются с YouTube постепенно, пока открыта библиотека: по одному видео,
// с паузой 1,5–2,5 с, бережно (на отказ YouTube — ждём минуту, 5, 15, 30 мин).
// Читает одна вкладка библиотеки (Web Locks), остальные только ищут. Закрыли —
// при следующем открытии продолжит с того же места. Новые видео после «Обновить»
// дочитываются сами. Хранение и поиск — в отдельном потоке (subs-worker.js).
//
// Запрос субтитров со страницы расширения проходит благодаря правилу в background.js
// (подставляет Origin youtube.com для youtubei/v1/get_panel); не прошёл — просим
// открытую вкладку YouTube (контент-скрипт отвечает на «yt:transcript-for»).

import { state } from "./state.js";

const GAP = [1500, 2500]; // пауза между видео, мс
const BACKOFF = [60, 300, 900, 1800].map((s) => s * 1000); // YouTube просит не спешить
const LOCK = "ytcs-subs-reader";
export const PER_VIDEO = { sec: 2.6, kb: 6.5 }; // в среднем: время на видео и место (замерено)

export const subs = {
  on: false, // включён ли поиск по субтитрам (выбор запоминается)
  paused: false,
  status: "off", // off | loading | reading | waiting | idle | other | error
  ready: false, // поток загрузил прочитанное — можно искать
  stats: { ok: 0, none: 0, err: 0, bytes: 0, blocks: 0 },
  done: 0, // из видео каталога (кроме Shorts) прочитано
  total: 0,
  waitUntil: 0,
  error: "",
};
const known = new Map(); // videoId → { s, retry }
let listeners = [];
export const onSubs = (f) => listeners.push(f);
const emit = () => listeners.forEach((f) => f());
// пришли (или поменялись) найденные в субтитрах — перерисовать результаты
let found = [];
export const onSubsResults = (f) => found.push(f);

// ---------- поток ----------
let worker = null;
let seq = 0;
const waiting = new Map();
function call(msg) {
  if (!worker) {
    worker = new Worker(new URL("./subs-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "ready" || m.type === "added") {
        if (m.vid) known.set(m.vid, { s: m.s, retry: m.retry || 0 });
        if (m.type === "added" && !m.vid) known.clear(); // удалили в другой вкладке
        subs.stats = m.stats;
        if (m.type === "ready") subs.ready = true;
        recount();
        dirty = true; // найденное могло измениться — обновим без спешки
        emit();
        return;
      }
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.ok) w.resolve(m);
      else w.reject(new Error(m.error || "ошибка поиска по субтитрам"));
    };
    worker.onerror = (e) => {
      for (const w of waiting.values()) w.reject(new Error(e.message || "поток поиска остановился"));
      waiting.clear();
      worker = null;
      subs.ready = false;
      inited = null;
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id });
  });
}

let inited = null;
function init() {
  if (inited) return inited;
  inited = call({ type: "init" }).then((r) => {
    known.clear();
    for (const [v, s, retry] of r.known) known.set(v, { s, retry });
    subs.stats = r.stats;
    subs.ready = true;
    recount();
    emit();
  });
  inited.catch(() => (inited = null));
  return inited;
}

// ---------- что осталось прочитать ----------
const wanted = (v) => !v.short && !(v.len > 0 && v.len <= 60); // Shorts — пропускаем
const settled = (k, now) => k && (k.s !== "err" || k.retry > now);

function recount() {
  const vids = state.cat?.videos || [];
  const now = Date.now();
  let total = 0;
  let done = 0;
  for (const v of vids) {
    if (!wanted(v)) continue;
    total++;
    if (settled(known.get(v.id), now)) done++;
  }
  subs.total = total;
  subs.done = done;
}

// следующее видео — в порядке «как в плейлистах» («Смотреть позже» первым)
function nextVideo() {
  const vids = state.cat?.videos;
  if (!vids) return null;
  const now = Date.now();
  for (const { d } of state.order || vids.map((_, d) => ({ d }))) {
    const v = vids[d];
    if (wanted(v) && !settled(known.get(v.id), now)) return v;
  }
  return null;
}

export const leftSec = () => Math.max(0, subs.total - subs.done) * PER_VIDEO.sec;

// ---------- чтение ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let running = false;
let wake = null; // прервать паузу (кнопка «Повторить сейчас», «Продолжить»)
const nap = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(t);
      resolve();
    };
  });

async function viaTabs(vid) {
  const tabs = await chrome.tabs.query({ url: ["https://www.youtube.com/*"] }).catch(() => []);
  for (const t of tabs.filter((x) => !x.discarded).slice(0, 2)) {
    try {
      const r = await chrome.tabs.sendMessage(t.id, { type: "yt:transcript-for", videoId: vid });
      if (r?.ok) return r.transcript;
      if (r?.error) throw new Error(r.error);
    } catch (e) {
      if (/^transcript:/.test(String(e?.message))) throw e;
    }
  }
  return null;
}

async function fetchOne(vid) {
  try {
    return await globalThis.__ytcsTranscript.fetchTranscript(vid, { timeoutMs: 30000 });
  } catch (e) {
    // 403 — правило Origin не сработало: попробуем через открытую вкладку YouTube
    if (/^transcript:403/.test(String(e?.message))) {
      const r = await viaTabs(vid).catch(() => null);
      if (r) return r;
    }
    throw e;
  }
}

async function readLoop() {
  let fails = 0;
  while (subs.on && !subs.paused) {
    await init();
    const v = nextVideo();
    if (!v) {
      subs.status = "idle";
      emit();
      return;
    }
    subs.status = "reading";
    emit();
    let tr = null;
    let err = "";
    try {
      tr = await fetchOne(v.id);
    } catch (e) {
      err = String(e?.message || e);
    }
    // YouTube отказывает всем подряд (лимит, сеть) — ждём и пробуем то же видео
    const general = err && (/transcript:(403|429|5\d\d)|network|timeout/.test(err) || !navigator.onLine);
    if (general) {
      fails++;
      if (fails === 1 && !/429/.test(err)) {
        await nap(5000); // разовый сбой — короткая пауза
        continue;
      }
      const ms = BACKOFF[Math.min(BACKOFF.length - 1, fails - 2)] ?? BACKOFF[0];
      subs.status = "waiting";
      subs.waitUntil = Date.now() + ms;
      subs.error = err;
      emit();
      await nap(ms);
      subs.waitUntil = 0;
      continue;
    }
    fails = 0;
    subs.error = "";
    try {
      const r = await call({ type: "put", vid: v.id, segments: tr?.segments || [], err: err || undefined });
      known.set(v.id, { s: r.s, retry: r.retry });
      subs.stats = r.stats;
    } catch (e) {
      subs.status = "error";
      subs.error = String(e?.message || e);
      emit();
      return;
    }
    recount();
    dirty = true;
    emit();
    await sleep(GAP[0] + Math.random() * (GAP[1] - GAP[0]));
  }
}

// Читает одна вкладка: замок держится, пока идёт чтение
export function kick() {
  if (!subs.on || subs.paused || running || !state.cat) return;
  if (!navigator.locks) return void runLocked();
  running = true;
  navigator.locks
    .request(LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        subs.status = "other"; // читает другая вкладка библиотеки — здесь только поиск
        emit();
        return;
      }
      await readLoop();
    })
    .finally(() => {
      running = false;
      if (subs.status === "reading" || subs.status === "waiting") subs.status = "idle";
      emit();
    });
}
async function runLocked() {
  running = true;
  try {
    await readLoop();
  } finally {
    running = false;
  }
}

// ---------- поиск ----------
let results = null; // { q, list: [{ id, t, score, snip, hits }] }
let asked = "";
let dirty = false; // прочитались новые видео — найденное стоит обновить
const sig = (list) => list.map((r) => `${r.id}@${r.t}`).join(",");

function run(text, quiet) {
  asked = text;
  void init()
    .then(() => call({ type: "search", q: text }))
    .then((r) => {
      if (asked !== text) return;
      asked = "";
      const same = quiet && results?.q === text && sig(results.list) === sig(r.results);
      results = { q: text, list: r.results };
      if (!same) found.forEach((f) => f());
    })
    .catch(() => {
      if (asked === text) asked = "";
      if (!quiet) results = { q: text, list: [] };
    });
}

// найденное в субтитрах для запроса: массив — готово, null — ищется (потом onSubsResults)
export function subsResults(q) {
  const text = q.trim();
  if (!subs.on || !text || text.replace(/[^\p{L}\p{N}]/gu, "").length < 3) return [];
  if (results?.q === text) return results.list;
  if (asked !== text) run(text, false);
  return null;
}
// пока идёт чтение — раз в 15 с дополняем найденное новыми видео (перерисовка — только если что-то изменилось)
setInterval(() => {
  if (!dirty || !results || asked || document.hidden) return;
  dirty = false;
  run(results.q, true);
}, 15000);

// ---------- включение ----------
async function save() {
  await chrome.storage.local.set({ libSubs: { on: subs.on, paused: subs.paused } });
}

export async function setSubs(on) {
  subs.on = on;
  subs.paused = false;
  results = null;
  asked = "";
  if (!on) {
    subs.status = "off";
    wake?.();
  } else subs.status = "loading";
  await save();
  emit();
  if (on) {
    await init().catch((e) => {
      subs.status = "error";
      subs.error = String(e?.message || e);
    });
    kick();
  }
}

export async function setPaused(p) {
  subs.paused = p;
  await save();
  if (!p) {
    wake?.();
    kick();
  } else wake?.();
  emit();
}

export function retryNow() {
  wake?.();
}

// выключить и удалить всё прочитанное
export async function clearSubs() {
  await setSubs(false);
  await init().catch(() => {});
  const r = await call({ type: "clear" });
  known.clear();
  subs.stats = r.stats;
  results = null;
  recount();
  emit();
}

// показать сведения (место, сколько прочитано), даже когда выключен
export const loadStats = () => init().catch(() => {});

chrome.storage.local.get("libSubs").then(({ libSubs }) => {
  subs.on = Boolean(libSubs?.on);
  subs.paused = Boolean(libSubs?.paused);
  if (!subs.on) return;
  subs.status = "loading";
  // включён — подгружаем прочитанное и продолжаем, когда каталог готов
  setTimeout(() => void init().then(kick, () => {}), 1200);
});

// каталог появился или обновился («Обновить») — пересчитать и дочитать новые
let seenCat = null;
setInterval(() => {
  if (state.cat === seenCat) return;
  seenCat = state.cat;
  if (!subs.ready) return;
  recount();
  emit();
  kick();
}, 3000);
// читает другая вкладка — вдруг её закрыли: подхватить
setInterval(() => {
  if (subs.on && !subs.paused && (subs.status === "other" || subs.status === "idle") && subs.done < subs.total) kick();
}, 30000);
