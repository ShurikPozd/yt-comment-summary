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
import "./cover-actions.js"; // «Превью» и «О чём видео» на обложках
import "./digest.js"; // «Подписки» — дайджест новых видео из подписок
import "./multi.js"; // выбор нескольких видео: кружок на обложке, Ctrl/Shift, полоса действий внизу

// ---------- адрес страницы: #q=…&pl=… (можно добавить в закладки) ----------
export function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  state.q = h.get("q") || "";
  state.pl = h.get("pl") || "";
  setView(VIEWS.includes(h.get("v")) ? h.get("v") : "lib", { silent: true });
  if (Number(h.get("collected"))) state.justCollected = Number(h.get("collected")); // пришли сюда после «Собрать вкладки»
  $("#q").value = state.q;
}
export function saveHash() {
  const h = new URLSearchParams();
  if (state.view !== "lib") h.set("v", state.view);
  if (state.q.trim()) h.set("q", state.q.trim());
  if (state.pl && state.view === "lib") h.set("pl", state.pl);
  const s = h.toString();
  history.replaceState(null, "", location.pathname + location.search + (s ? `#${s}` : ""));
}

// ---------- переключение разделов ----------
export const VIEWS = ["queue", "digest"]; // разделы кроме «Плейлистов» (#v=…)
const TITLES = {
  lib: "Моя библиотека — плейлисты YouTube",
  queue: "Очередь — Моя библиотека",
  digest: "Подписки — Моя библиотека",
};
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
  document.title = TITLES[v] || TITLES.lib;
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

// «Статистика» (stats-view.js) — грузим по первому нажатию или по адресу #stats / #v=stats;
// значок кнопки стоит прямо в library.html. Адрес запоминаем сразу: пока модуль грузится,
// раздел «Плейлисты» успевает переписать адрес (saveHash), и сам модуль #stats уже не увидит.
// Уже открытую статистику повторно не открываем (её открыл и сам модуль по тому же hashchange).
let statsMod = null;
const loadStats = () => (statsMod ||= import("./stats-view.js"));
const statsHash = () => location.hash === "#stats" || new URLSearchParams(location.hash.slice(1)).get("v") === "stats";
const statsFromHash = () => void loadStats().then((m) => !document.body.dataset.stats && m.openStats());
$("#st-tab").addEventListener("click", () => void loadStats().then((m) => m.toggleStats()));
window.addEventListener("hashchange", () => statsHash() && statsFromHash());
if (statsHash()) statsFromHash();
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
  // фрагмент из субтитров — открыть с этого места (в своём плеере или на YouTube по ссылке с &t=)
  const snip = e.target.closest("a.snip");
  if (snip && watchHere() && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
    e.preventDefault();
    return openWatch(snip.closest(".card")?.dataset.vid, "lib", Number(snip.dataset.t) || 0);
  }
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
// «Обновить» — только изменившиеся плейлисты; с Shift — перечитать все
$("#sync").addEventListener("click", (e) => sync({ full: e.shiftKey }));
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
      await chrome.runtime.sendMessage({ type: "lib:open", forceTab: true, view: state.view === "lib" ? "" : state.view, q: state.q }).catch(() => {});
      parent.postMessage({ ytcsLib: "tab" }, location.origin);
    } else {
      // панель открывается только сразу в ответ на клик — без ожиданий до вызова
      const ok = await chrome.sidePanel.open({ windowId: myWindowId }).then(() => true, () => false);
      if (!ok) return; // не открылась — вкладку не закрываем
      await chrome.storage.session.set({ panelLibrary: { at: Date.now(), q: state.q, view: state.view === "lib" ? "" : state.view } });
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

// Ленты, которые листаются вбок (чипы длины, плейлисты в узком окне): колесо мыши
// листает их влево-вправо, а затухание у края пропадает, когда долистали до конца.
document.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    for (let el = e.target; el && el !== document.body; el = el.parentElement) {
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      const ox = getComputedStyle(el).overflowX;
      if (ox !== "auto" && ox !== "scroll") continue;
      const before = el.scrollLeft;
      el.scrollLeft += e.deltaY;
      if (el.scrollLeft !== before) e.preventDefault(); // докрутили до края — дальше листается страница
      return;
    }
  },
  { passive: false }
);
document.addEventListener(
  "scroll",
  (e) => {
    const el = e.target;
    if (el instanceof Element && el.scrollWidth > el.clientWidth) el.classList.toggle("at-end", el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
  },
  true
);

// иконки из общего набора расширения
for (const el of document.querySelectorAll("[data-icon]")) el.innerHTML = icon(el.dataset.icon, { size: Number(el.dataset.size) || 16 });

// ---------- старт ----------
readHash();
// очередь (chrome.storage) и каталог (IndexedDB) читаем одновременно — сетка появляется раньше
const [, cached] = await Promise.all([loadQueue(), kv("catalog").catch(() => null)]);
if (cached?.videos) useCatalog(cached);
renderSync();
update();
// каталог обновляем сами, только когда смотрят плейлисты (а не очередь сразу после сбора вкладок)
state.cached = cached;
maybeSync();
const startW = new URLSearchParams(location.hash.slice(1)).get("w");
if (startW && !EMBED) openWatch(startW, state.view);
$("#q").focus();
