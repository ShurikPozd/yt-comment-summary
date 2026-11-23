// «Моя библиотека»: связь с YouTube через вкладку и playlists-main.js.

import { EV } from "./state.js";

// ---------- связь с YouTube ----------
// Выполняется В СТРАНИЦЕ YouTube (world: MAIN): шлёт запрос playlists-main.js
// и ждёт ответ. Функция самодостаточная — Chrome копирует её текст во вкладку.
export function bridgeCall(ev, op, args) {
  return new Promise((resolve) => {
    // скрипта во вкладке нет (её перезагрузили: playlists-main.js теперь не в
    // манифесте, а вставляется по требованию) — сказать сразу, а не ждать 45 с
    if (!window[`__ytcsPlMain:${ev}`]) return resolve({ ok: false, error: "noscript" });
    const id = `lib${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      resolve({ ok: false, error: "noreply" });
    }, 45000);
    function onMsg(e) {
      if (e.source !== window || e.data?.__ytcsPl !== id) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      resolve(e.data);
    }
    window.addEventListener("message", onMsg);
    document.dispatchEvent(new CustomEvent(ev, { detail: JSON.stringify({ ...args, op, id }) }));
  });
}

export let ytTab = null; // { id, temp }

export async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["playlists-main.js"] });
    return true;
  } catch (e) {
    return false;
  }
}

export function waitLoaded(tabId, ms = 25000) {
  return new Promise((resolve) => {
    const done = (ok) => {
      chrome.tabs.onUpdated.removeListener(onUpd);
      clearTimeout(timer);
      resolve(ok);
    };
    const onUpd = (id, info) => id === tabId && info.status === "complete" && done(true);
    const timer = setTimeout(() => done(false), ms);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((t) => t.status === "complete" && done(true), () => done(false));
  });
}

export let tabPending = null;
export function getTab() {
  // три сборщика спрашивают вкладку одновременно — открываем (или ищем) её один раз
  return (tabPending ||= findTab().finally(() => (tabPending = null)));
}
export async function findTab() {
  if (ytTab) {
    const t = await chrome.tabs.get(ytTab.id).catch(() => null);
    if (t && !t.discarded && /^https:\/\/www\.youtube\.com\//.test(t.url || "")) return ytTab;
    ytTab = null;
  }
  const tabs = await chrome.tabs.query({ url: ["https://www.youtube.com/*"] });
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const t of tabs) {
    if (t.discarded || t.status !== "complete") continue;
    if (await inject(t.id)) return (ytTab = { id: t.id, temp: false });
  }
  // своей вкладки YouTube нет — откроем фоновую: раздел «Плейлисты», там ничего не играет
  const t = await chrome.tabs.create({ url: "https://www.youtube.com/feed/playlists", active: false });
  ytTab = { id: t.id, temp: true };
  chrome.tabs.update(t.id, { muted: true }).catch(() => {});
  await waitLoaded(t.id);
  if (!(await inject(t.id))) throw Object.assign(new Error("tab"), { code: "tab" });
  return ytTab;
}

export async function releaseTab() {
  if (ytTab?.temp) await chrome.tabs.remove(ytTab.id).catch(() => {});
  ytTab = null;
}

export async function yt(op, args = {}) {
  for (let attempt = 0; ; attempt++) {
    const tab = await getTab();
    let res;
    try {
      [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: bridgeCall, args: [EV, op, args] });
    } catch (e) {
      ytTab = null; // вкладку закрыли или увели со страницы — возьмём другую
      if (attempt < 2) continue;
      throw Object.assign(new Error(String(e?.message || e)), { code: "tab" });
    }
    const r = res?.result;
    if (r?.ok) return r.data;
    if (r?.error === "noscript" && attempt < 2) {
      if (!(await inject(tab.id))) ytTab = null; // не вставился — возьмём другую вкладку
      continue;
    }
    // настройки YouTube в только что открытой вкладке ещё не готовы — подождём;
    // нет ответа — вкладку перезагрузили, скрипт пропал: подключимся заново
    if ((r?.error === "noconfig" || r?.error === "noreply") && attempt < 2) {
      if (r?.error === "noreply" && ytTab?.id === tab.id) await inject(tab.id);
      await new Promise((ok) => setTimeout(ok, 1500));
      continue;
    }
    const code = r?.error === "noscript" ? "noreply" : r?.error || "fail"; // для сообщений — как «не ответил»
    throw Object.assign(new Error(r?.message || code), { code });
  }
}
