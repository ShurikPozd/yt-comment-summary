// «Моя библиотека» — мгновенный поиск по всем видео во всех ваших плейлистах.
//
// Как устроено:
//   1. Каталог (плейлисты и видео в них) читается с YouTube от вашего имени —
//      через вкладку YouTube: туда подключается playlists-main.js, и запросы
//      уходят ровно так же, как у самого сайта. Нет открытой вкладки — страница
//      откроет фоновую (раздел «Плейлисты», без звука) и закроет после сбора.
//   2. Каталог хранится в этом браузере (IndexedDB расширения), никуда не уходит.
//   3. Поиск — search.js: опечатки, окончания, раскладка, без сети.

import { icon } from "../sidepanel/icons.js";
import { sync, useCatalog } from "./catalog.js";
import { loadQueue, onQueueGridClick, refreshTabsCount } from "./queue-view.js";
import { $, EMBED, SORTS, STALE, esc, state } from "./state.js";
import { kv } from "./store.js";
import { more, renderSide, renderSync, update } from "./view-lib.js";
import { closeWatch, openWatch, watchHere } from "./watch.js";
import { yt } from "./youtube.js";

// ---------- адрес страницы: #q=…&pl=… (можно добавить в закладки) ----------
export function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  state.q = h.get("q") || "";
  state.pl = h.get("pl") || "";
  setView(h.get("v") === "queue" ? "queue" : "lib", { silent: true });
  if (Number(h.get("collected"))) state.justCollected = Number(h.get("collected")); // пришли сюда после «Собрать вкладки»
  $("#q").value = state.q;
}
export function saveHash() {
  const h = new URLSearchParams();
  if (state.view === "queue") h.set("v", "queue");
  if (state.q.trim()) h.set("q", state.q.trim());
  if (state.pl && state.view === "lib") h.set("pl", state.pl);
  const s = h.toString();
  history.replaceState(null, "", location.pathname + location.search + (s ? `#${s}` : ""));
}

// ---------- переключение разделов ----------
export function setView(v, { silent = false } = {}) {
  const changed = state.view !== v;
  if (changed && !silent) closeWatch();
  state.view = v;
  document.body.dataset.view = v;
  for (const b of document.querySelectorAll(".views [data-view]")) b.setAttribute("aria-selected", String(b.dataset.view === v));
  if (changed || !$("#sort").options.length) {
    $("#sort").innerHTML = SORTS[v].map(([val, label]) => `<option value="${val}">${label}</option>`).join("");
    state.sort = "auto";
    $("#sort").value = "auto";
  }
  document.title = v === "queue" ? "Очередь — Моя библиотека" : "Моя библиотека — плейлисты YouTube";
  if (v === "queue") void refreshTabsCount();
  if (silent) return;
  if (changed) {
    state.q = "";
    $("#q").value = "";
  }
  update();
  maybeSync();
}

export function maybeSync() {
  // каталог плейлистов — только в разделе «Плейлисты»
  if (state.view !== "lib" || state.syncing) return;
  const c = state.cat || state.cached;
  if (!c?.videos || Date.now() - c.syncedAt > STALE) sync();
}

document.querySelector(".views").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (b) setView(b.dataset.view);
});
setInterval(() => state.view === "queue" && document.visibilityState === "visible" && refreshTabsCount(), 10000);

// ---------- события ----------
export function setPl(id) {
  state.pl = state.pl === id && id ? "" : id;
  update();
}

export let qTimer = 0;
$("#q").addEventListener("input", (e) => {
  closeWatch();
  state.q = e.target.value;
  clearTimeout(qTimer);
  qTimer = setTimeout(update, 70);
});
$("#q").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && e.target.value) {
    e.preventDefault();
    e.target.value = state.q = "";
    update();
  } else if (e.key === "Enter") {
    // Enter — открыть первое найденное (в очереди — в её вкладке)
    const first = $("#grid .title");
    if (first && state.q.trim()) first.click();
  }
});
$("#pl-q").addEventListener("input", (e) => {
  state.plQ = e.target.value;
  renderSide();
});
$("#pl-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pl]");
  if (b) setPl(b.dataset.pl);
});
$("#cont").addEventListener("click", onQueueGridClick);
$("#grid").addEventListener("click", (e) => {
  if (state.view === "queue") return onQueueGridClick(e);
  const link = e.target.closest("a.thumb, a.title");
  if (link && watchHere() && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
    e.preventDefault();
    return openWatch(link.closest(".card")?.dataset.vid, "lib");
  }
  const chip = e.target.closest(".chip[data-pl]");
  if (chip) return setPl(chip.dataset.pl);
  const more = e.target.closest(".chip[data-more]");
  if (more) {
    // показать все плейлисты этого видео
    const v = state.cat.videos[Number(more.dataset.more)];
    const box = more.parentElement;
    box.innerHTML = v.in
      .map(([id]) => state.plById.get(id))
      .filter(Boolean)
      .map((p) => `<button type="button" class="chip" data-pl="${esc(p.id)}">${esc(p.title)}</button>`)
      .join("");
  }
});
$("#dur").addEventListener("click", (e) => {
  const b = e.target.closest("[data-dur]");
  if (!b) return;
  state.dur = b.dataset.dur;
  for (const x of $("#dur").children) x.setAttribute("aria-checked", String(x === b));
  update();
});
$("#sort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  update();
});
$("#sync").addEventListener("click", () => sync());
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-act]");
  if (!a) return;
  if (a.dataset.act === "sync") sync();
  else if (a.dataset.act === "open-yt") chrome.tabs.create({ url: "https://www.youtube.com/" });
  else if (a.dataset.act === "reset") {
    state.pl = "";
    state.dur = "";
    for (const x of $("#dur").children) x.setAttribute("aria-checked", String(!x.dataset.dur));
    update();
  }
});
document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName || "");
  if (!typing && (e.key === "/" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k"))) {
    e.preventDefault();
    $("#q").focus();
    $("#q").select();
  }
});
window.addEventListener("hashchange", async () => {
  await loadQueue(); // сначала данные, потом раздел — иначе на миг дорисуется чужой список
  readHash();
  update();
  maybeSync();
});
new IntersectionObserver((entries) => entries.some((x) => x.isIntersecting) && more(), { rootMargin: "1200px" }).observe($("#more"));
setInterval(() => !state.syncing && state.cat && renderSync(), 60000);

// ---------- где открыта: в панели или во вкладке ----------
export let myWindowId = null; // окно этой вкладки — узнаём заранее, чтобы открыть панель без ожидания
chrome.windows?.getCurrent().then((w) => (myWindowId = w.id)).catch(() => {});
export function setupWhere() {
  const b = $("#where");
  b.title = b.ariaLabel = EMBED ? "Развернуть во вкладку (и открывать так дальше)" : "Открывать в боковой панели";
  b.innerHTML = icon(EMBED ? "external" : "panel", { size: 18 });
  b.addEventListener("click", async () => {
    void chrome.storage.local.set({ libraryWhere: EMBED ? "tab" : "panel" });
    if (EMBED) {
      await chrome.runtime.sendMessage({ type: "lib:open", forceTab: true, view: state.view === "queue" ? "queue" : "", q: state.q }).catch(() => {});
      parent.postMessage({ ytcsLib: "tab" }, location.origin);
    } else {
      // панель открывается только сразу в ответ на клик — без ожиданий до вызова
      const ok = await chrome.sidePanel.open({ windowId: myWindowId }).then(() => true, () => false);
      if (!ok) return; // не открылась — вкладку не закрываем
      await chrome.storage.session.set({ panelLibrary: { at: Date.now(), q: state.q, view: state.view === "queue" ? "queue" : "" } });
      window.close();
    }
  });
  $("#where-back").addEventListener("click", () => parent.postMessage({ ytcsLib: "back" }, location.origin));
}
if (EMBED) {
  // в панели видео открываем в текущей вкладке, рядом с панелью
  document.addEventListener("click", async (e) => {
    const a = e.target.closest("a[href^='https://www.youtube.com/']");
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0 || a.dataset.play) return;
    e.preventDefault();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.update(tab.id, { url: a.href });
    else chrome.tabs.create({ url: a.href });
  });
}
setupWhere();

// иконки из общего набора расширения
for (const el of document.querySelectorAll("[data-icon]")) el.innerHTML = icon(el.dataset.icon, { size: Number(el.dataset.size) || 16 });

// ---------- старт ----------
readHash();
await loadQueue();
const cached = await kv("catalog").catch(() => null);
if (cached?.videos) useCatalog(cached);
renderSync();
update();
// каталог обновляем сами, только когда смотрят плейлисты (а не очередь сразу после сбора вкладок)
state.cached = cached;
maybeSync();
const startW = new URLSearchParams(location.hash.slice(1)).get("w");
if (startW && !EMBED) openWatch(startW, state.view === "queue" ? "queue" : "lib");
$("#q").focus();
