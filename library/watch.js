// «Моя библиотека»: просмотр прямо здесь — встроенный плеер.

import { icon } from "../sidepanel/icons.js";
import { myWindowId, saveHash } from "./library.js";
import { loadQueue, qLeft, qmsg, renderQueueSide } from "./queue-view.js";
import { $, EMBED, esc, nf, state } from "./state.js";
import { fmtLen } from "./view-lib.js";
import { yt } from "./youtube.js";

// ---------- просмотр прямо в библиотеке («свой клиент») ----------
// Встроенный плеер YouTube вместо тяжёлой страницы сайта: большой плеер,
// под ним — кнопки очереди, справа — галерея «Дальше». Управление и место
// просмотра — по протоколу встроенного плеера (postMessage), без чужих скриптов.
// Чтобы YouTube пустил плеер на страницу расширения, background.js ставит
// правило: запросам к youtube.com/embed с наших страниц — заголовок Referer.
export const watch = { on: false, id: "", source: "", t: 0, len: 0, frame: null, heard: false, saved: -1, ended: false };

export function watchHere() {
  return state.watchHere && !EMBED; // в узкой боковой панели плеер негде показать
}

export function watchList() {
  // что показывать в «Дальше»: очередь (по её порядку) или текущий список результатов
  if (watch.source === "queue") return state.queue;
  return state.list.map(({ d }) => state.cat?.videos[d]).filter(Boolean);
}

export function watchRec(id = watch.id) {
  return (watch.source === "queue" ? state.queue : state.cat?.videos || []).find((x) => x.id === id) || watch.rec || null;
}

// at — с какой секунды (фрагмент из субтитров); без него — с места, где остановились в очереди
export function openWatch(id, source, at = null) {
  const rec = (source === "queue" ? state.queue : state.cat?.videos || []).find((x) => x.id === id);
  if (!rec) return;
  saveWatchPos();
  Object.assign(watch, { on: true, id, source, rec, t: at ?? (source === "queue" ? state.qpos[id] || 0 : 0), len: rec.len || 0, heard: false, saved: -1, ended: false });
  document.body.dataset.watch = "1";
  $("#watch").hidden = false;
  renderWatch();
  window.scrollTo({ top: 0 });
  history.replaceState(null, "", location.pathname + location.search + `#${new URLSearchParams({ ...(state.view === "queue" ? { v: "queue" } : {}), w: id })}`);
}

export function closeWatch() {
  if (!watch.on) return;
  saveWatchPos();
  watch.on = false;
  watch.frame = null;
  delete document.body.dataset.watch;
  $("#watch").hidden = true;
  $("#watch").innerHTML = "";
  saveHash();
}

export function renderWatch() {
  const r = watchRec();
  if (!r) return closeWatch();
  const list = watchList();
  const i = list.findIndex((x) => x.id === watch.id);
  const next = list.filter((x) => x.id !== watch.id);
  const upNext = i >= 0 ? [...list.slice(i + 1), ...list.slice(0, i)] : next;
  const isQ = watch.source === "queue" && state.queue.some((x) => x.id === r.id);
  const start = Math.floor(watch.t > 5 ? watch.t : 0);
  const src = `https://www.youtube.com/embed/${encodeURIComponent(r.id)}?enablejsapi=1&autoplay=1&rel=0&playsinline=1&iv_load_policy=3${start ? `&start=${start}` : ""}`;
  const sub = [r.channel, r.len ? fmtLen(r.len) : r.short ? "Shorts" : "", watch.source === "queue" ? `${i + 1} из ${list.length} в очереди` : ""].filter(Boolean);
  $("#watch").innerHTML = `
    <div class="w-main">
      <div class="w-player">
        <iframe id="w-frame" title="${esc(r.title)}" src="${src}" allow="autoplay; fullscreen; picture-in-picture; encrypted-media; clipboard-write"></iframe>
        <div class="w-over" hidden></div>
      </div>
      <div class="w-info">
        <h1 class="w-title">${esc(r.title || "Видео")}</h1>
        <div class="w-sub">${sub.map(esc).join(" · ")}</div>
        <div class="w-acts">
          <button type="button" class="ghost" data-w="back" title="Вернуться к списку — Esc">${icon("chevron", { size: 16 }).replace("<svg", '<svg style="transform:rotate(180deg)"')}К списку</button>
          ${isQ ? `<button type="button" class="primary" data-w="done" title="Убрать из очереди и дальше — Shift+]">${icon("check", { size: 16 })}Досмотрел</button>` : ""}
          ${upNext.length ? `<button type="button" class="ghost" data-w="next" title="Следующее — ]">Дальше${icon("chevron", { size: 16 })}</button>` : ""}
          <button type="button" class="ghost" data-w="panel" title="Боковая панель: сводка, моменты, темы и поиск по комментариям этого видео">${icon("chat", { size: 16 })}Комментарии и сводка</button>
          <button type="button" class="ghost" data-w="yt" title="Открыть это видео на YouTube">${icon("external", { size: 16 })}На YouTube</button>
        </div>
      </div>
    </div>
    ${watchSideHtml(upNext)}`;
  watch.frame = $("#w-frame");
  watch.frame.addEventListener("load", listenPlayer);
}

export function watchSideHtml(upNext) {
  return `<aside class="w-next" aria-label="Дальше">
      <div class="w-h">${watch.source === "queue" ? "Дальше в очереди" : "Дальше в списке"}<span>${nf.format(upNext.length)}</span></div>
      <div class="w-list">${upNext
        .slice(0, 60)
        .map((x) => {
          const p = watch.source === "queue" ? state.qpos[x.id] || 0 : 0;
          const pct = x.len && p > 5 ? Math.min(100, Math.round((p / x.len) * 100)) : 0;
          return `<button type="button" class="w-item" data-wgo="${esc(x.id)}" title="${esc(x.title)}">
            <span class="w-th"><img loading="lazy" alt="" src="https://i.ytimg.com/vi/${esc(x.id)}/mqdefault.jpg" />${x.len ? `<span class="dur">${fmtLen(x.len)}</span>` : ""}${pct ? `<span class="prog"><i style="width:${pct}%"></i></span>` : ""}</span>
            <span class="w-it"><b>${esc(x.title || "Видео")}</b><span>${esc(x.channel || (x.short ? "Shorts" : ""))}</span></span>
          </button>`;
        })
        .join("")}</div>
    </aside>`;
}

// очередь поменялась (убрали, добавили) — обновить «Дальше», плеер не трогаем
export function refreshWatchSide() {
  if (!watch.on) return;
  const list = watchList();
  const i = list.findIndex((x) => x.id === watch.id);
  const upNext = i >= 0 ? [...list.slice(i + 1), ...list.slice(0, i)] : list.filter((x) => x.id !== watch.id);
  const side = $("#watch .w-next");
  if (side) side.outerHTML = watchSideHtml(upNext);
}

// встроенный плеер начинает присылать состояние, когда его «слушают»
export function listenPlayer() {
  let n = 0;
  const frame = watch.frame;
  const tick = () => {
    if (!frame?.isConnected || watch.heard || ++n > 30) return;
    frame.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), "*");
    setTimeout(tick, 400);
  };
  tick();
}

export function playerCmd(func, args = []) {
  watch.frame?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
}

window.addEventListener("message", (e) => {
  if (!watch.on || !watch.frame || e.source !== watch.frame.contentWindow) return;
  let d = e.data;
  try {
    if (typeof d === "string") d = JSON.parse(d);
  } catch (err) {
    return;
  }
  watch.heard = true;
  const info = d?.info;
  if (d?.event === "infoDelivery" && info) {
    if (typeof info.currentTime === "number") watch.t = info.currentTime;
    if (info.duration > 0) watch.len = info.duration;
    if (info.playerState === 0) onWatchEnded();
  } else if (d?.event === "onStateChange" && info === 0) onWatchEnded();
  else if (d?.event === "onError") showWatchError(Number(info));
});

export function saveWatchPos() {
  if (!watch.on || watch.source !== "queue" || !(watch.t > 0)) return;
  const t = Math.floor(watch.t);
  if (Math.abs(t - watch.saved) < 4) return;
  watch.saved = t;
  void qmsg({ type: "queue:pos", id: watch.id, t, len: watch.len });
}
setInterval(saveWatchPos, 5000);
window.addEventListener("pagehide", saveWatchPos);

export function watchGo(step) {
  const list = watchList();
  const i = list.findIndex((x) => x.id === watch.id);
  const to = list[i + step] || (step > 0 ? list.find((x) => x.id !== watch.id) : null);
  if (to) openWatch(to.id, watch.source);
}

export async function watchDone() {
  if (watch.source !== "queue") return watchGo(1);
  const list = watchList();
  const i = list.findIndex((x) => x.id === watch.id);
  const after = list[i + 1] || list.find((x) => x.id !== watch.id);
  const id = watch.id;
  watch.t = 0; // досмотрено — место не храним
  await qmsg({ type: "queue:remove", ids: [id], why: "done" });
  await loadQueue();
  if (after) openWatch(after.id, "queue");
  else closeWatch();
}

// подборка «что дальше» — как на YouTube: сколько и какие — из настроек очереди
export function watchPick() {
  const n = [2, 4, 6].includes(Number(state.qopts.offerCount)) ? Number(state.qopts.offerCount) : 4;
  const list = watchList();
  const i = list.findIndex((x) => x.id === watch.id);
  let out = i >= 0 ? [...list.slice(i + 1), ...list.slice(0, i)] : list.filter((x) => x.id !== watch.id);
  const mode = state.qopts.offerMode;
  const cur = watchRec();
  if (mode === "shuffle") out = out.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  else if (mode === "short") out = out.slice().sort((a, b) => (qLeft(a) || 1e9) - (qLeft(b) || 1e9));
  else if (mode === "started") out = out.slice().sort((a, b) => Number((state.qpos[b.id] || 0) > 5) - Number((state.qpos[a.id] || 0) > 5));
  else if (mode === "similar" && cur) {
    const words = (t) => new Set(String(t || "").toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []);
    const w = words(cur.title);
    const score = (r) => (r.channel && r.channel === cur.channel ? 3 : 0) + [...words(r.title)].filter((x) => w.has(x)).length;
    out = out.map((r, k) => ({ r, s: score(r), k })).sort((a, b) => b.s - a.s || a.k - b.k).map((x) => x.r);
  }
  return out.slice(0, n);
}

export async function onWatchEnded() {
  if (watch.ended) return;
  watch.ended = true;
  const id = watch.id;
  const items = watchPick();
  if (watch.source === "queue" && state.qopts.removeWatched) {
    watch.t = 0;
    await qmsg({ type: "queue:remove", ids: [id], why: "done" });
    await loadQueue();
  }
  if (state.qopts.autoNext && items[0]) return openWatch(items[0].id, watch.source);
  showWatchOffer(items);
}

export function showWatchOffer(items) {
  const over = $("#watch .w-over");
  if (!over) return;
  if (!items.length) {
    over.innerHTML = `<div class="w-msg"><b>${watch.source === "queue" ? "Очередь досмотрена" : "Это было последнее"}</b><button type="button" class="ghost" data-w="back">К списку</button></div>`;
    over.hidden = false;
    return;
  }
  over.innerHTML = `<div class="w-offer">
      <div class="w-oh"><b>Что посмотреть дальше</b><button type="button" class="ghost" data-w="close-over">Не сейчас</button></div>
      <div class="w-og" style="--n:${Math.min(items.length, items.length === 4 ? 4 : 3)}">${items
        .map(
          (x) => `<button type="button" class="w-oc" data-wgo="${esc(x.id)}" title="${esc(x.title)}">
            <span class="w-th"><img alt="" src="https://i.ytimg.com/vi/${esc(x.id)}/mqdefault.jpg" />${x.len ? `<span class="dur">${fmtLen(x.len)}</span>` : ""}</span>
            <b>${esc(x.title || "Видео")}</b><span>${esc(x.channel || "")}</span>
          </button>`
        )
        .join("")}</div>
    </div>`;
  over.hidden = false;
}

export function showWatchError(code) {
  const over = $("#watch .w-over");
  if (!over) return;
  const why =
    code === 101 || code === 150
      ? "Автор запретил смотреть это видео на других страницах."
      : code === 153 || code === 152
        ? "YouTube не пустил плеер на эту страницу."
        : code === 100
          ? "Видео удалено или скрыто."
          : "Плеер YouTube не смог открыть видео.";
  over.innerHTML = `<div class="w-msg">
    <b>Здесь не получится</b><span>${why}</span>
    <div class="w-acts"><button type="button" class="primary" data-w="yt">${icon("external", { size: 16 })}Открыть на YouTube</button>
    ${watchList().length > 1 ? `<button type="button" class="ghost" data-w="next">Дальше${icon("chevron", { size: 16 })}</button>` : ""}</div>
  </div>`;
  over.hidden = false;
}

document.addEventListener("click", (e) => {
  if (!watch.on) return;
  const go = e.target.closest("[data-wgo]");
  if (go) return openWatch(go.dataset.wgo, watch.source);
  const a = e.target.closest("[data-w]")?.dataset.w;
  if (!a) return;
  if (a === "back") closeWatch();
  else if (a === "next") watchGo(1);
  else if (a === "done") void watchDone();
  else if (a === "close-over") $("#watch .w-over").hidden = true;
  else if (a === "panel") {
    // панель — сразу в ответ на клик (иначе Chrome не откроет); она сама найдёт
    // эту вкладку и видео в ней, скрипты расширения работают и во встроенном плеере
    chrome.sidePanel.open({ windowId: myWindowId }).catch(() => {});
  }
  else if (a === "yt") {
    saveWatchPos();
    playerCmd("pauseVideo");
    const r = watchRec();
    if (watch.source === "queue" && state.queue.some((x) => x.id === r?.id)) void qmsg({ type: "queue:play", id: r.id });
    else if (r) chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${encodeURIComponent(r.id)}${watch.t > 5 ? `&t=${Math.floor(watch.t)}s` : ""}` });
  }
});

document.addEventListener(
  "keydown",
  (e) => {
    if (!watch.on || e.ctrlKey || e.altKey || e.metaKey) return;
    const t = e.composedPath()[0];
    if (t && ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeWatch();
    } else if (e.code === "BracketRight") {
      e.preventDefault();
      if (e.shiftKey) void watchDone();
      else watchGo(1);
    } else if (e.code === "BracketLeft" && !e.shiftKey) {
      e.preventDefault();
      watchGo(-1);
    }
  },
  true
);

// открывать видео здесь (по умолчанию) или на YouTube — переключатель в настройках очереди
chrome.storage.local.get("libWatchHere").then(({ libWatchHere }) => {
  state.watchHere = libWatchHere !== false;
  if (state.view === "queue") renderQueueSide();
});
