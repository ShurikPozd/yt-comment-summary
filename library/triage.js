// «Моя библиотека»: «Разобрать завалы» — быстрый разбор очереди по одному видео.
//
// Видео — крупно: обложка, название, канал, длина, когда добавлено, сколько
// досмотрено. Решение — клавишей или кнопкой: ← убрать, → оставить, ↑ первым
// в очереди, Enter — смотреть сейчас, Ctrl+Z — отменить последнее. Сверху —
// прогресс; порядок разбора — старые / новые / длинные / короткие / вперемешку.
// Рядом с видео — «О чём видео» (triage-tldr.js): готовый пересказ сразу, нет —
// кнопка «Пересказать» или Пробел; клик по пункту — смотреть с этого места.

import { icon } from "../sidepanel/icons.js";
import { fmtHours, loadQueue, qLeft, qmsg } from "./queue-view.js";
import { $, esc, nf, state, videosWord } from "./state.js";
import { tldrKey, tldrPanelHtml, tldrPreload, tldrShow, tldrStop } from "./triage-tldr.js";
import { ago, fmtLen } from "./view-lib.js";
import { openWatch, watchHere } from "./watch.js";

const ORDERS = [
  ["old", "Сначала старые"],
  ["new", "Сначала новые"],
  ["long", "Сначала длинные"],
  ["short", "Сначала короткие"],
  ["shuffle", "Вперемешку"],
];

const tri = { on: false, list: [], i: 0, removed: 0, kept: 0, topped: 0, undo: [], order: "old", busy: false };

function ordered(order) {
  const q = state.queue.slice();
  const by = (f) => q.sort((a, b) => f(a, b));
  if (order === "old") by((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  else if (order === "new") by((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  else if (order === "long") by((a, b) => qLeft(b) - qLeft(a));
  else if (order === "short") by((a, b) => (qLeft(a) || 1e9) - (qLeft(b) || 1e9));
  else for (let i = q.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [q[i], q[j]] = [q[j], q[i]];
  }
  return q.map((x) => x.id);
}

export function openTriage(order = tri.order) {
  if (!state.queue.length) return;
  Object.assign(tri, { on: true, order, list: ordered(order), i: 0, removed: 0, kept: 0, topped: 0, undo: [] });
  document.body.dataset.triage = "1";
  $("#triage").hidden = false;
  void tldrPreload(tri.list);
  render();
}

function closeTriage() {
  tri.on = false;
  tldrStop();
  delete document.body.dataset.triage;
  $("#triage").hidden = true;
  $("#triage").innerHTML = "";
}

const cur = () => state.queue.find((x) => x.id === tri.list[tri.i]) || null;

function render(dir = "") {
  // пропускаем то, что уже убрали из очереди где-то ещё
  while (tri.i < tri.list.length && !cur()) tri.i++;
  const total = tri.list.length;
  const r = cur();
  const head = `<div class="t-top">
      <div class="t-ttl"><b>Разобрать очередь</b><span>${r ? `${nf.format(tri.i + 1)} из ${nf.format(total)}` : "готово"} · убрано ${nf.format(tri.removed)} · оставлено ${nf.format(tri.kept)}${tri.topped ? ` · наверх ${nf.format(tri.topped)}` : ""}</span></div>
      <label class="sort t-order"><span>Порядок</span><select data-t="order">${ORDERS.map(([v, l]) => `<option value="${v}" ${tri.order === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <button type="button" class="ghost" data-t="close" title="Закончить — Esc">${icon("close", { size: 16 })}Закончить</button>
    </div>
    <div class="t-progress"><div style="width:${total ? Math.round((tri.i / total) * 100) : 100}%"></div></div>`;
  if (!r) {
    tldrShow(null, null);
    $("#triage").innerHTML = `${head}<div class="t-done">
        <div class="empty-icon">${icon("check", { size: 30 })}</div>
        <div class="empty-title">Очередь разобрана</div>
        <div class="empty-text">Убрано ${videosWord(tri.removed)}, оставлено ${videosWord(tri.kept)}. В очереди сейчас ${videosWord(state.queue.length)}${state.queue.length ? ` — смотреть ${fmtHours(state.queue.reduce((a, x) => a + qLeft(x), 0))}` : ""}.</div>
        <div class="t-acts">${tri.undo.length ? `<button type="button" class="ghost" data-t="undo">${icon("history", { size: 16 })}Отменить последнее</button>` : ""}<button type="button" class="primary" data-t="close">К очереди</button></div>
      </div>`;
    return;
  }
  const t = state.qpos[r.id] || 0;
  const pct = r.len && t > 5 ? Math.min(100, Math.round((t / r.len) * 100)) : 0;
  const facts = [
    r.channel,
    r.len ? (t > 5 ? `осталось ${fmtHours(qLeft(r))} из ${fmtLen(r.len)}` : fmtLen(r.len)) : r.short ? "Shorts" : "",
    r.addedAt ? `в очереди ${ago(r.addedAt).replace(" назад", "")}` : "",
  ].filter(Boolean);
  const next = tri.list.slice(tri.i + 1).map((id) => state.queue.find((x) => x.id === id)).filter(Boolean).slice(0, 3);
  $("#triage").innerHTML = `${head}
    <div class="t-stage">
      <article class="t-card ${dir}" aria-live="polite">
        <div class="t-thumb"><img alt="" src="https://i.ytimg.com/vi/${esc(r.id)}/hqdefault.jpg" />
          ${r.len ? `<span class="dur">${fmtLen(r.len)}</span>` : r.short ? `<span class="dur">Shorts</span>` : ""}
          ${pct ? `<span class="prog"><i style="width:${pct}%"></i></span>` : ""}</div>
        <div class="t-info">
          <h2>${esc(r.title || "Видео")}</h2>
          <div class="t-facts">${facts.map(esc).join(" · ")}</div>
        </div>
      </article>
      ${tldrPanelHtml()}
      <div class="t-acts main">
        <button type="button" class="t-btn del" data-t="del" title="Убрать из очереди — ←">${icon("close", { size: 22 })}<span>Убрать</span><kbd>←</kbd></button>
        <button type="button" class="t-btn top" data-t="top" title="Первым в очереди — ↑">${icon("chevron", { size: 22 }).replace("<svg", '<svg style="transform:rotate(-90deg)"')}<span>Наверх</span><kbd>↑</kbd></button>
        <button type="button" class="t-btn t-watch" data-t="watch" title="Смотреть сейчас — Enter">${icon("play", { size: 22 })}<span>Смотреть</span><kbd>Enter</kbd></button>
        <button type="button" class="t-btn keep" data-t="keep" title="Оставить в очереди — →">${icon("check", { size: 22 })}<span>Оставить</span><kbd>→</kbd></button>
      </div>
      ${tri.undo.length ? `<button type="button" class="link-btn t-undo" data-t="undo">${icon("history", { size: 14 })}Отменить последнее · Ctrl+Z</button>` : ""}
      ${next.length ? `<div class="t-next"><span>Дальше:</span>${next.map((x) => `<img alt="" title="${esc(x.title)}" src="https://i.ytimg.com/vi/${esc(x.id)}/mqdefault.jpg" />`).join("")}</div>` : ""}
    </div>`;
  // пункты пересказа: в своём плеере с этого места (если он включён), иначе — YouTube
  tldrShow(r, next[0], {
    linkFor: watchHere()
      ? (vid, t) => {
          closeTriage();
          openWatch(vid, "queue", t);
        }
      : null,
  });
}

async function act(kind) {
  if (tri.busy) return;
  const r = cur();
  if (!r) return;
  tri.busy = true;
  const at = state.queue.findIndex((x) => x.id === r.id);
  try {
    if (kind === "del") {
      tri.undo.push({ kind, rec: r, at, t: state.qpos[r.id] || 0, i: tri.i });
      tri.removed++;
      await qmsg({ type: "queue:remove", ids: [r.id] });
    } else if (kind === "top") {
      tri.undo.push({ kind, rec: r, at, i: tri.i });
      tri.topped++;
      await qmsg({ type: "queue:top", id: r.id });
    } else {
      tri.undo.push({ kind, rec: r, i: tri.i });
      tri.kept++;
    }
    await loadQueue();
    tri.i++;
    render(kind === "del" ? "in-from-right" : kind === "top" ? "in-from-bottom" : "in-from-left");
  } finally {
    tri.busy = false;
  }
}

async function undo() {
  const u = tri.undo.pop();
  if (!u || tri.busy) return;
  tri.busy = true;
  try {
    if (u.kind === "del") {
      tri.removed--;
      await qmsg({ type: "queue:add", items: [{ ...u.rec, t: u.t }], at: u.at });
    } else if (u.kind === "top") {
      // вернуть на прежнее место: убрать и вставить туда же
      tri.topped--;
      await qmsg({ type: "queue:remove", ids: [u.rec.id] });
      await qmsg({ type: "queue:add", items: [{ ...u.rec, t: state.qpos[u.rec.id] || 0 }], at: u.at });
    } else tri.kept--;
    await loadQueue();
    tri.i = u.i;
    render();
  } finally {
    tri.busy = false;
  }
}

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-act=triage]")) return openTriage();
  if (!tri.on) return;
  const t = e.target.closest("[data-t]")?.dataset.t;
  if (!t || t === "order") return;
  if (t === "close") closeTriage();
  else if (t === "undo") void undo();
  else if (t === "watch") {
    const r = cur();
    if (!r) return;
    closeTriage();
    if (watchHere()) openWatch(r.id, "queue");
    else void qmsg({ type: "queue:play", id: r.id });
  } else void act(t);
});
document.addEventListener("change", (e) => {
  if (tri.on && e.target.matches?.("[data-t=order]")) openTriage(e.target.value);
});
document.addEventListener(
  "keydown",
  (e) => {
    if (!tri.on || e.altKey || e.metaKey) return;
    const t = e.composedPath()[0];
    if (t && ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
    const k = e.key;
    if ((e.ctrlKey && (k === "z" || k === "я")) || (e.ctrlKey && e.code === "KeyZ")) {
      e.preventDefault();
      return void undo();
    }
    if (e.ctrlKey) return;
    if (k === " " && !e.shiftKey && !e.repeat) {
      if (tldrKey()) e.preventDefault();
      return;
    }
    const map = { ArrowLeft: "del", Delete: "del", Backspace: "del", ArrowRight: "keep", ArrowUp: "top", Enter: "watch", Escape: "close" };
    const kind = map[k];
    if (!kind) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    document.querySelector(`#triage [data-t="${kind}"]`)?.click();
  },
  true
);
