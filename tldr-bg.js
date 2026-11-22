// Фон для окна «О чём видео» на обложках (video-actions.js): контент-скрипт сам в
// сеть к боту не ходит — открывает порт "ytcs-tldr", а фон грузит расшифровку
// (transcript.js), пересказывает (общее ядро tldr-core.js, стрим) и шлёт
// этапы и текст по мере написания. Задача живёт по videoId: закрыли окно —
// пересказ дописывается и ложится в кеш; открыли снова — подписка на ту же
// задачу. Отменяет только кнопка «Отменить».
//
// Протокол порта. Из страницы: {type:"start", vid, title, duration, force},
// {type:"cancel", vid}. В страницу: {type:"progress", vid, phase, frac, about, points}
// (уже разобранный текст по мере написания), {type:"done", vid, data, copy},
// {type:"nosubs", vid, music}, {type:"error", vid, kind, text}.

import "./transcript.js";
import { GroqProxy, createPacer } from "./groq.js";
import { DEFAULTS } from "./config.js";
import { runTldr, loadTldr, parseTldr, tldrCopyText, tldrErrorText } from "./tldr-core.js";

export const TLDR_PORT = "ytcs-tldr";

// Свой бюджет лимитов (панель ведёт свой — повторы на 429 в ядре страхуют
// от их пересечения). Значения — как у панели.
const pacer = createPacer({ itpm: 6000, otpm: 900, gapMs: 1500, maxOut: 800 });
const jobs = new Map(); // vid → { ac, ports:Set, last }

// Секрет бота может жить только в local-config.js (не в git): классический
// скрипт для страниц расширения, фону его не подключить — читаем как текст.
let localCfg = null;
async function localConfig() {
  if (localCfg) return localCfg;
  localCfg = {};
  try {
    const r = await fetch(chrome.runtime.getURL("local-config.js"));
    if (r.ok) {
      const src = (await r.text()).replace(/^\s*\/\/.*$/gm, "");
      for (const key of ["token", "baseUrl", "model"]) {
        const m = src.match(new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]*)["'\`]`));
        if (m) localCfg[key] = m[1];
      }
    }
  } catch (e) {
    /* файла нет — секрет в настройках панели */
  }
  return localCfg;
}

// Как loadSettings() в панели: сохранённые настройки поверх local-config и дефолтов.
async function serverSettings() {
  const lc = await localConfig();
  let saved = {};
  try {
    saved = (await chrome.storage.local.get("settings")).settings || {};
  } catch (e) {
    /* пусто */
  }
  const s = Object.assign(
    { baseUrl: lc.baseUrl || DEFAULTS.baseUrl, token: lc.token || "", model: lc.model || DEFAULTS.model, lang: DEFAULTS.lang },
    saved
  );
  return s;
}

function send(job, msg) {
  job.last = msg;
  for (const p of job.ports) {
    try {
      p.postMessage(msg);
    } catch (e) {
      job.ports.delete(p);
    }
  }
}

// Задача заводится сразу (до первого await) — второй «start» на то же видео
// подписывается на неё, а не запускает параллельный пересказ.
// Субтитры берёт вкладка YouTube (запрос со страницы YouTube, как у «О видео»):
// из фонового скрипта YouTube отвечает расширению отказом. Нет вкладки — пробуем сами.
async function transcriptFor(vid, tabId, signal) {
  const tabs = [];
  if (tabId != null) tabs.push(tabId);
  try {
    for (const t of await chrome.tabs.query({ url: ["https://www.youtube.com/*"] })) if (t.id !== tabId && !t.discarded) tabs.push(t.id);
  } catch (e) {
    /* без вкладок */
  }
  let lastErr = null;
  for (const id of tabs.slice(0, 3)) {
    if (signal.aborted) throw new Error("cancelled");
    try {
      const r = await chrome.tabs.sendMessage(id, { type: "yt:transcript-for", videoId: vid });
      if (r?.ok) return r.transcript;
      if (r?.error) {
        lastErr = new Error(r.error);
        if (/^transcript:/.test(r.error)) break; // YouTube ответил — другая вкладка ответит так же
      }
    } catch (e) {
      /* во вкладке нет нашего скрипта (открыта до обновления) — следующая */
    }
  }
  try {
    return await globalThis.__ytcsTranscript.fetchTranscript(vid, { signal });
  } catch (e) {
    throw lastErr && /^transcript:/.test(lastErr.message) ? lastErr : e;
  }
}

function start(vid, { title, duration }, port) {
  const job = { ac: new AbortController(), ports: new Set([port]), last: null, tabId: port?.sender?.tab?.id ?? null };
  jobs.set(vid, job);
  void runJob(job, vid, title, duration);
}

async function runJob(job, vid, title, duration) {
  const signal = job.ac.signal;
  const state = { phase: "Загружаю субтитры…", frac: 0.04, live: "" };
  const progress = () => {
    const { about, points } = parseTldr(state.live);
    return { type: "progress", vid, phase: state.phase, frac: state.frac, about, points };
  };
  send(job, progress());
  const s = await serverSettings();
  const proxy = new GroqProxy({ baseUrl: s.baseUrl, token: s.token, model: s.model });
  if (!proxy.configured) {
    send(job, { type: "error", vid, kind: "setup" });
    if (jobs.get(vid) === job) jobs.delete(vid);
    return;
  }
  // стрим идёт по слову — в страницу шлём не чаще ~12 раз в секунду
  let timer = 0;
  const flush = () => {
    timer = 0;
    send(job, progress());
  };
  const onUpdate = (patch) => {
    Object.assign(state, patch);
    if (!timer) timer = setTimeout(flush, 80);
  };
  try {
    const tr = await transcriptFor(vid, job.tabId, signal);
    if (signal.aborted) return;
    onUpdate({ phase: "Читаю субтитры…", frac: 0.12 });
    const data = await runTldr({ vid, transcript: tr, title, duration, lang: s.lang || "ru", proxy, pacer, signal, onUpdate });
    clearTimeout(timer);
    if (data.nosubs) send(job, { type: "nosubs", vid, music: data.music });
    else send(job, { type: "done", vid, data, copy: tldrCopyText(data, vid) });
  } catch (e) {
    clearTimeout(timer);
    if (e?.cancelled || signal.aborted || String(e?.message) === "cancelled") return;
    const kind = /^transcript:/.test(String(e?.message)) ? "transcript" : "ai";
    send(job, { type: "error", vid, kind, text: tldrErrorText(e) });
  } finally {
    if (jobs.get(vid) === job) jobs.delete(vid);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== TLDR_PORT) return;
  const mine = new Set(); // задачи, на которые подписан этот порт
  port.onMessage.addListener(async (msg) => {
    const vid = String(msg?.vid || "");
    if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) return;
    if (msg.type === "cancel") {
      const job = jobs.get(vid);
      if (job) {
        job.ac.abort();
        jobs.delete(vid);
      }
      return;
    }
    if (msg.type !== "start") return;
    mine.add(vid);
    const job = jobs.get(vid);
    if (job) {
      // уже пишется (окно закрывали или открыто в другой вкладке) — подписываемся
      job.ports.add(port);
      if (job.last) port.postMessage(job.last);
      return;
    }
    if (!msg.force) {
      const cached = await loadTldr(vid);
      if (cached) {
        port.postMessage({ type: "done", vid, data: cached, copy: tldrCopyText(cached, vid) });
        return;
      }
      if (jobs.has(vid)) {
        jobs.get(vid).ports.add(port);
        return;
      }
    }
    start(vid, { title: String(msg.title || "").slice(0, 300), duration: Number(msg.duration) || 0 }, port);
  });
  port.onDisconnect.addListener(() => {
    for (const vid of mine) jobs.get(vid)?.ports.delete(port);
  });
});
