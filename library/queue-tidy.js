// «Моя библиотека»: «Уборка очереди» — найти и разом убрать мусор из очереди.
//
// Группы (логика — queue-tidy-core.js): недоступные (удалённые, приватные,
// заблокированные), дубли, почти досмотренное, залежавшееся. Доступность —
// открытым oEmbed YouTube без ключей (404 — удалено; 401/403 — смотрим страницу
// видео: приватное или просто запрещено встраивание), не чаще 5 запросов в
// секунду, с «Остановить». Итоги проверки помнятся 3 дня (IndexedDB библиотеки).
// Убирает и возвращает — только сообщениями queue:remove / queue:put в фон.
// Модуль грузится по первому нажатию «Уборка очереди» (queue-view.js).

import { icon } from "../sidepanel/icons.js";
import { GROUPS, availOf, defaultPicked, groupQueue, groupState, needCheck, oembedVerdict, paced, playability, pruneCache, removalPlan } from "./queue-tidy-core.js";
import { qmsg } from "./queue-view.js";
import { $, esc, nf, state, videosWord } from "./state.js";
import { kv } from "./store.js";
import { ago, fmtLen } from "./view-lib.js";

const PER_SEC = 5; // запросов к YouTube в секунду — не больше
const LIMIT = 8; // видео в группе, пока не нажали «Показать все»
const CACHE_KEY = "qcheck";
const TITLE = {
  gone: ["Недоступные", "Удалены, стали приватными или заблокированы — посмотреть их уже нельзя"],
  dups: ["Дубли", "Одно видео в очереди несколько раз — лишние копии уйдут, первая останется"],
  almost: ["Почти досмотрено", "Досмотрены больше чем на 90% — скорее всего, уже не нужны"],
  stale: ["Залежалось", "Больше 60 дней в очереди и не начаты. Не отмечены — решите сами"],
};
const NONE = { gone: "недоступных нет", dups: "дублей нет", almost: "почти досмотренных нет", stale: "залежавшихся нет" };

export const qt = {
  open: false,
  queue: [],
  pos: {},
  groups: { gone: [], dups: [], almost: [], stale: [] },
  picked: new Set(),
  touched: new Set(), // что пользователь отметил или снял сам — пересчёт не трогает
  all: new Set(), // группы, раскрытые целиком
  cache: null,
  check: null, // { done, total, ac, unknown, stopped }
  busy: false,
  undo: null, // { n, plan }
  msg: "",
};

// ---------- группы ----------
function compute() {
  qt.groups = groupQueue(qt.queue, qt.pos, { avail: availOf(qt.cache || {}) });
  const def = defaultPicked(qt.groups);
  const ids = new Set(GROUPS.flatMap((g) => qt.groups[g].map((it) => it.id)));
  for (const id of ids) if (!qt.touched.has(id)) def.has(id) ? qt.picked.add(id) : qt.picked.delete(id);
  for (const id of [...qt.picked]) if (!ids.has(id)) qt.picked.delete(id);
}

// ---------- проверка доступности ----------
async function checkOne(id, signal) {
  const watch = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, { signal, credentials: "omit" }).catch(() => null);
  const v = oembedVerdict(r ? r.status : 0);
  if (v === "ok" || v === "gone") return v;
  if (v === "retry") return null;
  // 401/403: приватное — или автор запретил встраивание (смотреть можно). Смотрим страницу.
  const page = await fetch(`${watch}&hl=en`, { signal, credentials: "include" }).catch(() => null);
  if (!page?.ok) return null;
  return playability(await page.text().catch(() => ""));
}

async function loadCache() {
  if (qt.cache) return;
  qt.cache = (await kv(CACHE_KEY).catch(() => null)) || {};
}
const saveCache = () => kv(CACHE_KEY, pruneCache(qt.cache, qt.queue.map((x) => x.id))).catch(() => {});

let paint = 0;
function renderSoon() {
  if (paint) return;
  paint = setTimeout(() => {
    paint = 0;
    compute();
    render();
  }, 250);
}

async function runCheck() {
  if (qt.check && !qt.check.stopped && !qt.check.finished) return;
  await loadCache();
  const ids = needCheck(
    qt.queue.map((x) => x.id),
    qt.cache
  );
  if (!ids.length) {
    qt.check = null;
    compute();
    return render();
  }
  const ac = new AbortController();
  const c = (qt.check = { done: 0, total: ids.length, ac, unknown: 0, stopped: false, finished: false });
  render();
  let unsaved = 0;
  const all = await paced(ids, checkOne, {
    perSec: PER_SEC,
    parallel: 3,
    signal: ac.signal,
    onDone: (id, v) => {
      c.done++;
      if (v) qt.cache[id] = { s: v, at: Date.now() };
      else c.unknown++;
      if (++unsaved >= 20) {
        unsaved = 0;
        void saveCache();
      }
      if (qt.check === c) renderSoon();
    },
  });
  await saveCache();
  if (qt.check !== c) return;
  c.finished = all;
  c.stopped = !all;
  compute();
  render();
}

function stopCheck() {
  qt.check?.ac.abort();
  if (qt.check) qt.check.stopped = true;
  render();
}

// ---------- разметка ----------
function rowHtml(g, it) {
  const r = it.rec;
  const title = r.title || "Видео без названия";
  const note =
    g === "gone"
      ? `<em>${esc(it.note)}</em>`
      : g === "stale"
        ? esc(r.addedAt ? `добавлено ${ago(r.addedAt)}` : "")
        : esc(it.note);
  const sub = [r.channel ? esc(r.channel) : r.short ? "Shorts" : "", note].filter(Boolean).join(" · ");
  return `<label class="qt-row${qt.picked.has(it.id) ? " on" : ""}" title="${esc(title)}">
    <input type="checkbox" data-qt-id="${esc(it.id)}" ${qt.picked.has(it.id) ? "checked" : ""} ${qt.busy ? "disabled" : ""} />
    <span class="qt-th"><img loading="lazy" decoding="async" alt="" src="https://i.ytimg.com/vi/${esc(it.id)}/mqdefault.jpg" />${r.len ? `<span class="dur">${fmtLen(r.len)}</span>` : ""}</span>
    <span class="qt-tx"><b>${esc(title)}</b><small>${sub}</small></span>
  </label>`;
}

function groupHtml(g) {
  const list = qt.groups[g];
  const st = groupState(list, qt.picked);
  const shown = qt.all.has(g) ? list : list.slice(0, LIMIT);
  const [title, why] = TITLE[g];
  return `<div class="qt-sec" data-g="${g}">
    <div class="qt-h">
      <label class="qt-all"><input type="checkbox" data-qt-all="${g}" ${st === "all" ? "checked" : ""} ${qt.busy ? "disabled" : ""} /><b>${title}</b></label><span class="qt-n">${nf.format(list.length)}</span>
      <span class="qt-why">${why}</span>
    </div>
    <div class="qt-list">${shown.map((it) => rowHtml(g, it)).join("")}</div>
    ${list.length > shown.length ? `<button type="button" class="ghost qt-more" data-qt-more="${g}">${icon("chevron", { size: 16 }).replace("<svg", '<svg style="transform:rotate(90deg)"')}Показать все · ${nf.format(list.length)}</button>` : ""}
  </div>`;
}

function checkHtml() {
  const c = qt.check;
  if (!c) return "";
  if (c.finished && !c.unknown) return "";
  if (!c.finished && !c.stopped) {
    const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
    return `<div class="qt-check" role="status">
      <div class="qt-check-t"><b>Проверяю, все ли видео доступны</b><span>${nf.format(c.done)} из ${nf.format(c.total)}</span></div>
      <div class="wl-bar"><div style="width:${pct}%"></div></div>
      <button type="button" class="ghost" data-qt="stop">${icon("close", { size: 16 })}Остановить</button>
    </div>`;
  }
  const left = c.total - c.done + c.unknown;
  return `<div class="qt-check qt-check-off" role="status">
    <div class="qt-check-t"><b>${c.stopped ? "Проверка остановлена" : "Не все проверены"}</b><span>${c.stopped ? `проверено ${nf.format(c.done - c.unknown)} из ${nf.format(c.total)}` : `YouTube не ответил про ${videosWord(c.unknown)}`}</span></div>
    <button type="button" class="ghost" data-qt="recheck">${icon("refresh", { size: 16 })}Проверить ${c.stopped ? "остальные" : "ещё раз"} · ${nf.format(left)}</button>
  </div>`;
}

function html() {
  const g = qt.groups;
  const total = GROUPS.reduce((a, k) => a + g[k].length, 0);
  const n = qt.picked.size;
  const checking = qt.check && !qt.check.finished && !qt.check.stopped;
  // пустые группы — одной строкой внизу, без пустых карточек
  const none = GROUPS.filter((k) => !g[k].length && !(k === "gone" && (checking || qt.check?.stopped))).map((k) => NONE[k]);
  const undo = qt.undo
    ? `<div class="qt-done" role="status"><span>${icon("check", { size: 18 })}${esc(qt.undo.text)}</span><button type="button" class="ghost" data-qt="undo" ${qt.busy ? "disabled" : ""}>${icon("history", { size: 16 })}Вернуть</button></div>`
    : "";
  return `<section class="tidy qt" aria-label="Уборка очереди">
    <div class="td-top"><b>Уборка очереди</b><button type="button" class="ghost" data-qt="close">${icon("close", { size: 16 })}Закрыть</button></div>
    ${undo}${qt.msg ? `<div class="td-msg wl-err">${esc(qt.msg)}</div>` : ""}${checkHtml()}
    ${GROUPS.filter((k) => g[k].length).map(groupHtml).join("")}
    ${
      !total && !checking
        ? `<div class="qt-clean">${icon("check", { size: 20 })}<b>В очереди порядок — убирать нечего</b></div>`
        : none.length
          ? `<div class="qt-none">${icon("check", { size: 16 })}<span>${none.join(" · ").replace(/^./, (c) => c.toUpperCase())}</span></div>`
          : ""
    }
    ${
      total
        ? `<div class="qt-foot"><span>Отмечено <b>${nf.format(n)}</b> из ${nf.format(total)}</span><button type="button" class="primary" data-qt="go" ${!n || qt.busy ? "disabled" : ""}>${icon("close", { size: 16 })}Убрать отмеченные (${nf.format(n)})</button></div>`
        : ""
    }
  </section>`;
}

function render() {
  const box = $("#qtidy");
  if (!box) return;
  box.hidden = !qt.open;
  // фокус и прокрутку списка сохраняем: окно перерисовывается по ходу проверки
  const focus = document.activeElement?.closest?.("#qtidy") ? document.activeElement : null;
  const key = focus?.dataset.qtId || focus?.dataset.qtAll || focus?.dataset.qt || focus?.dataset.qtMore;
  box.innerHTML = qt.open ? html() : "";
  // часть группы отмечена — галочка группы «с чёрточкой»
  for (const el of box.querySelectorAll("[data-qt-all]")) el.indeterminate = groupState(qt.groups[el.dataset.qtAll], qt.picked) === "some";
  if (key) box.querySelector(`[data-qt-id="${CSS.escape(key)}"], [data-qt-all="${CSS.escape(key)}"], [data-qt="${CSS.escape(key)}"], [data-qt-more="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

// ---------- действия ----------
async function removePicked() {
  const plan = removalPlan(qt.queue, qt.pos, qt.groups, qt.picked);
  if (!plan.count) return;
  qt.busy = true;
  qt.msg = "";
  render();
  let ok = true;
  if (plan.drop.length) ok = (await qmsg({ type: "queue:remove", ids: plan.drop, why: "drop" }))?.ok && ok;
  if (plan.done.length) ok = (await qmsg({ type: "queue:remove", ids: plan.done }))?.ok && ok;
  if (plan.keep.length) ok = (await qmsg({ type: "queue:put", items: plan.keep, undo: "drop" }))?.ok && ok;
  qt.busy = false;
  for (const id of [...plan.drop, ...plan.done]) qt.touched.delete(id);
  if (!ok) qt.msg = "Не всё получилось убрать — обновите страницу библиотеки и попробуйте ещё раз.";
  qt.undo = { plan, text: `Убрано из очереди: ${videosWord(plan.count)}` };
  render();
}

async function undoRemove() {
  const u = qt.undo;
  if (!u) return;
  qt.busy = true;
  render();
  // сначала всё, кроме досмотренного, потом досмотренное — места посчитаны под этот порядок
  if (u.plan.undo.drop.length) await qmsg({ type: "queue:put", items: u.plan.undo.drop, undo: "drop" });
  if (u.plan.undo.done.length) await qmsg({ type: "queue:put", items: u.plan.undo.done });
  qt.busy = false;
  qt.undo = null;
  render();
}

function syncFromState() {
  qt.queue = state.queue.slice();
  qt.pos = { ...state.qpos };
}

// к окну — под липкую шапку библиотеки (на узком экране окно ниже колонки очереди)
function scrollToBox() {
  const box = $("#qtidy");
  if (!box) return;
  const head = document.querySelector("header.top")?.getBoundingClientRect().height || 0;
  window.scrollTo({ top: Math.max(0, box.getBoundingClientRect().top + window.scrollY - head - 12), behavior: "smooth" });
}

export async function openQTidy() {
  qt.open = true;
  qt.msg = "";
  syncFromState();
  await loadCache();
  compute();
  render();
  scrollToBox();
  void runCheck();
}

export function closeQTidy() {
  qt.open = false;
  qt.check?.ac.abort();
  qt.check = null;
  qt.undo = null;
  qt.all.clear();
  render();
}

document.addEventListener("click", (e) => {
  const more = e.target.closest("[data-qt-more]")?.dataset.qtMore;
  if (more) {
    qt.all.add(more);
    return render();
  }
  const a = e.target.closest("[data-qt]")?.dataset.qt;
  if (!a || a === "open") return; // «open» — queue-view.js (он и грузит этот модуль)
  if (a === "close") closeQTidy();
  else if (a === "stop") stopCheck();
  else if (a === "recheck") {
    qt.check = null;
    void runCheck();
  } else if (qt.busy) return;
  else if (a === "go") void removePicked();
  else if (a === "undo") void undoRemove();
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (!t.closest?.("#qtidy")) return;
  if (t.dataset.qtId) {
    const id = t.dataset.qtId;
    qt.touched.add(id);
    t.checked ? qt.picked.add(id) : qt.picked.delete(id);
    return render();
  }
  const g = t.dataset.qtAll;
  if (g) {
    for (const it of qt.groups[g]) {
      qt.touched.add(it.id);
      t.checked ? qt.picked.add(it.id) : qt.picked.delete(it.id);
    }
    render();
  }
});

// очередь поменялась (здесь, в колонке на YouTube, в другой вкладке) — пересчитать
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !qt.open || !(ch.queue || ch.queuePos)) return;
  if (ch.queue) qt.queue = Array.isArray(ch.queue.newValue) ? ch.queue.newValue : [];
  if (ch.queuePos) qt.pos = ch.queuePos.newValue || {};
  // в очереди новые видео — проверить и их (если проверка не идёт)
  if (ch.queue && qt.check?.finished !== false && needCheck(qt.queue.map((x) => x.id), qt.cache || {}).length) {
    qt.check = null;
    void runCheck();
  }
  renderSoon();
});
