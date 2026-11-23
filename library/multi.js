// «Моя библиотека»: выбор нескольких видео — в «Очереди», «Плейлистах» и «Подписках».
// Как на ленте YouTube (select.js): кружок в левом верхнем углу обложки при наведении;
// щелчок по кружку — выбрать или снять, Ctrl/Cmd+щелчок по карточке — добавить,
// Shift+щелчок — всё от прошлого выбранного до этого, Esc — снять выбор. Пока
// выбрано хоть что-то, щелчок по карточке тоже выбирает (видео не открывается).
// Внизу — полоса «Выбрано: N» с действиями для этого раздела.
// Кружки вставляются в карточки сами (как кнопки на обложках в cover-actions.js),
// очередь меняет только фон (queue:* в background.js), чистая логика — multi-core.js.

import { icon } from "../sidepanel/icons.js";
import { sync, useCatalog } from "./catalog.js";
import { hideMany, queueMany, toast } from "./digest.js";
import { rangeIds, snapshot } from "./multi-core.js";
import { qmsg } from "./queue-view.js";
import { $, EV, esc, nf, state, videosWord } from "./state.js";
import { kv } from "./store.js";
import { shrink } from "./sync-plan.js";
import { releaseTab, yt } from "./youtube.js";

const CARDS = "#grid .card, #cont .card, #digest .card";
const CHUNK = 50; // видео в одном запросе к YouTube
const svg = (body, size = 20) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const IC = {
  check: (s) => svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', s),
  top: (s) => svg('<path d="M5 4h14"/><path d="M12 20V9"/><path d="M7.5 13.5L12 9l4.5 4.5"/>', s),
  bottom: (s) => svg('<path d="M5 20h14"/><path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/>', s),
  // рисунки «списка» — по центру квадрата 24×24 (иначе значок «садится» ниже подписи)
  save: (s) => svg('<path d="M4 4.5h11"/><path d="M4 10.5h11"/><path d="M4 16.5h7"/><path d="M17 13.5v6"/><path d="M14 16.5h6"/>', s),
  queue: (s) => svg('<path d="M4 4.75h11"/><path d="M4 10.75h11"/><path d="M4 16.75h7"/><path d="M15 14.25v5l4.5-2.5z"/>', s),
  remove: (s) => svg('<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 12.5h9l1-12.5"/><path d="M10 11v5"/><path d="M14 11v5"/>', s),
  minus: (s) => svg('<path d="M4 4.75h11"/><path d="M4 10.75h7"/><path d="M4 16.75h6"/><circle cx="17" cy="14.75" r="4.5"/><path d="M15 14.75h4"/>', s),
  hide: (s) =>
    svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1"/><path d="M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>', s),
  all: (s) => svg('<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8 12.2l2.8 2.8L16 9.5"/>', s),
};

export const sel = { ids: new Set(), anchor: null, ctx: "", busy: "" };

const idOf = (card) => card?.dataset.qid || card?.dataset.vid || card?.dataset.did || "";
const ctxNow = () => `${state.view}|${state.view === "lib" ? state.pl : ""}`;
const overlayOpen = () =>
  !$("#watch")?.hidden || !$("#triage")?.hidden || !$("#stats")?.hidden || Boolean(document.getElementById("ytcs-playlists"));

// Все видео раздела по порядку на экране — для Shift и «Выбрать всё» (и ещё не
// дорисованные при прокрутке)
function orderIds() {
  if (state.view === "queue") {
    const cont = [...document.querySelectorAll("#cont .card[data-qid]")].map(idOf);
    return cont.concat(state.list.map((x) => state.queue[x.d]?.id).filter(Boolean));
  }
  if (state.view === "lib") return state.cat ? state.list.map((x) => state.cat.videos[x.d]?.id).filter(Boolean) : [];
  return [...new Set([...document.querySelectorAll("#digest .card[data-did]")].map(idOf))];
}

// ---------- кружки и отметки на карточках ----------
function pickHtml(on) {
  return `<button type="button" class="pick" aria-pressed="${on}" aria-label="${on ? "Снять выбор" : "Выбрать видео"}" title="${
    on ? "Снять выбор" : "Выбрать (Ctrl+щелчок — добавить, Shift — диапазон)"
  }">${IC.check(18)}</button>`;
}

function syncCards() {
  for (const card of document.querySelectorAll(CARDS)) {
    const id = idOf(card);
    if (!id) continue;
    const on = sel.ids.has(id);
    let b = card.querySelector(":scope > .pick");
    if (!b) {
      card.insertAdjacentHTML("afterbegin", pickHtml(on));
      b = card.firstElementChild;
    } else if (b.getAttribute("aria-pressed") !== String(on)) b.outerHTML = pickHtml(on);
    if (card.classList.contains("picked") !== on) card.classList.toggle("picked", on);
  }
}

let syncQueued = false;
function scheduleSync() {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    // сменили раздел или плейлист — прежний выбор к новому списку не относится
    if (sel.ids.size && sel.ctx !== ctxNow()) return clear();
    prune();
    syncCards();
  });
}

// видео ушли из раздела (убраны в другой вкладке, скрыты) — из выбора тоже
function prune() {
  if (!sel.ids.size) return;
  let have = null;
  if (state.view === "queue") have = new Set(state.queue.map((x) => x.id));
  else if (state.view === "lib") have = state.cat ? new Set((state.pl ? state.cat.videos.filter((v) => v.in.some(([p]) => p === state.pl)) : state.cat.videos).map((v) => v.id)) : null;
  else if (state.digestById) have = state.digestById;
  if (!have) return;
  let gone = false;
  for (const id of sel.ids) if (!have.has(id)) (sel.ids.delete(id), (gone = true));
  if (gone) renderBar();
}

for (const s of ["#grid", "#cont", "#digest"]) {
  const el = $(s);
  if (el) new MutationObserver(scheduleSync).observe(el, { childList: true, subtree: true });
}

// ---------- выбор ----------
function setIds(ids, on) {
  if (!sel.ids.size) sel.ctx = ctxNow();
  for (const id of ids) on ? sel.ids.add(id) : sel.ids.delete(id);
  syncCards();
  renderBar();
}

function toggle(id, range = false) {
  if (range && sel.anchor && sel.anchor !== id && sel.ids.size) {
    const ids = rangeIds(orderIds(), sel.anchor, id);
    if (ids.length > 1) {
      sel.anchor = id;
      return setIds(ids, true);
    }
  }
  sel.anchor = id;
  setIds([id], !sel.ids.has(id));
}

export function clear() {
  if (!sel.ids.size && !sel.anchor) return;
  sel.ids.clear();
  sel.anchor = null;
  syncCards();
  renderBar();
}

function selectAll() {
  const ids = orderIds();
  if (ids.length && ids.every((id) => sel.ids.has(id))) return clear();
  setIds(ids, true);
}

// ---------- щелчки и клавиши ----------
document.addEventListener(
  "click",
  (e) => {
    if (e.button !== 0 || e.altKey || sel.busy) return;
    const card = e.target.closest?.(CARDS);
    const id = idOf(card);
    if (!id) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.target.closest(".pick")) {
      e.preventDefault();
      e.stopPropagation();
      return toggle(id, e.shiftKey);
    }
    if (!(sel.ids.size || mod || e.shiftKey)) return; // обычный щелчок — как раньше
    // кнопки в карточке («Наверх», «Убрать», плейлисты, канал) работают как обычно
    const ctl = e.target.closest("button, select, input, label");
    if (ctl && card.contains(ctl)) return;
    e.preventDefault();
    e.stopPropagation();
    toggle(id, e.shiftKey);
  },
  true
);

// Shift+щелчок по карточкам не выделяет текст страницы
document.addEventListener(
  "mousedown",
  (e) => {
    if (e.button === 0 && (e.shiftKey || ((e.ctrlKey || e.metaKey) && sel.ids.size)) && e.target.closest?.(CARDS)) e.preventDefault();
  },
  true
);

document.addEventListener(
  "keydown",
  (e) => {
    if (!sel.ids.size || overlayOpen()) return;
    const t = e.target;
    if (t && (t.isContentEditable || t.matches?.("input, textarea, select"))) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      clear();
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyA") {
      e.preventDefault();
      setIds(orderIds(), true);
    }
  },
  true
);

// ---------- полоса действий ----------
function actions() {
  if (state.view === "queue")
    return [
      ["top", IC.top, "Наверх", "Поставить выбранные первыми в очереди — в их нынешнем порядке", "accent"],
      ["bottom", IC.bottom, "В конец", "Отправить выбранные в конец очереди"],
      ["save", IC.save, "В плейлисты", "Сохранить выбранные в плейлисты YouTube"],
      ["qdel", IC.remove, "Убрать", "Убрать выбранные из очереди (можно вернуть)"],
    ];
  if (state.view === "lib") {
    const p = state.pl && state.pl !== "LL" ? state.plById.get(state.pl) : null;
    return [
      ["queue", IC.queue, "В очередь", "Поставить выбранные в очередь «посмотреть потом»", "accent"],
      ["save", IC.save, "В плейлисты", "Сохранить выбранные в другие плейлисты YouTube"],
      ...(p ? [["pldel", IC.minus, "Убрать из плейлиста", `Убрать выбранные из «${p.title}» на YouTube (можно вернуть)`]] : []),
    ];
  }
  return [
    ["dq", IC.queue, "В очередь", "Поставить выбранные в очередь «посмотреть потом»", "accent"],
    ["save", IC.save, "В плейлисты", "Сохранить выбранные в плейлисты YouTube"],
    ["dhide", IC.hide, "Не интересно", "Скрыть выбранные из дайджеста (можно вернуть)"],
  ];
}

const btn = ([act, ic, label, title, cls = ""]) =>
  `<button type="button" class="sel-btn${cls ? ` ${cls}` : ""}" data-sel="${act}" title="${esc(title)}" aria-label="${esc(label)}">${ic(20)}<span class="lbl">${esc(label)}</span></button>`;

let bar = null;
let barKey = "";
function ensureBar() {
  if (bar) return bar;
  bar = document.createElement("div");
  bar.id = "sel-bar";
  bar.className = "sel-bar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Выбранные видео");
  bar.hidden = true;
  bar.addEventListener("click", onBarClick);
  document.body.append(bar);
  addEventListener("resize", fit);
  return bar;
}

function renderBar() {
  const n = sel.ids.size;
  document.body.classList.toggle("sel-on", n > 0);
  if (!n && !bar) return;
  ensureBar();
  if (!n) {
    bar.hidden = true;
    return;
  }
  const all = orderIds();
  const full = all.length > 0 && all.every((id) => sel.ids.has(id));
  const acts = actions();
  const key = `${state.view}|${acts.map((a) => a[0]).join()}|${full}|${sel.busy}`;
  if (key !== barKey) {
    barKey = key;
    bar.innerHTML = `<div class="sel-head">
        <span class="sel-count" aria-live="polite"></span>
        ${btn(full ? ["all", IC.all, "Снять выбор", "Снять выбор со всех"] : ["all", IC.all, "Выбрать всё", "Выбрать все видео в списке (Ctrl+A)"])}
        <button type="button" class="sel-btn x" data-sel="clear" title="Снять выбор (Esc)" aria-label="Снять выбор (Esc)">${icon("close", { size: 20 })}</button>
      </div>
      <div class="sel-acts">${acts.map(btn).join("")}</div>`;
  }
  bar.querySelector(".sel-count").innerHTML = sel.busy ? esc(sel.busy) : `Выбрано: <b>${nf.format(n)}</b>`;
  for (const b of bar.querySelectorAll("button")) b.disabled = Boolean(sel.busy);
  bar.hidden = false;
  fit();
}

// В одну строку с подписями, если влезает; нет — в две строки (число и «Выбрать всё»
// сверху, действия снизу); совсем узко — только значки с подсказками
function fit() {
  if (!bar || bar.hidden) return;
  bar.classList.remove("stack", "grid2", "icons", "icons-all");
  const over = (sel = ".sel-btn, .sel-count") => bar.scrollWidth > bar.clientWidth + 1 || [...bar.querySelectorAll(sel)].some((b) => b.scrollWidth > b.clientWidth + 1);
  if (over()) bar.classList.add("stack");
  // в строку действия помещаются, но впритык (подпись почти касается краёв кнопки) —
  // сеткой 2×2 с подписями: так читается лучше, чем только значки
  const tight = () =>
    [...bar.querySelectorAll(".sel-acts .sel-btn")].some((b) => {
      const l = b.querySelector(".lbl");
      return l && l.getBoundingClientRect().width + 20 + 8 + 28 > b.clientWidth;
    });
  if (bar.classList.contains("stack") && tight()) bar.classList.add("grid2");
  if (over(".sel-acts .sel-btn")) bar.classList.add("icons");
  if (over()) bar.classList.add("icons-all");
  document.body.style.setProperty("--selbar-h", `${Math.ceil(bar.getBoundingClientRect().height)}px`);
}

function picked() {
  const order = orderIds();
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...sel.ids].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
}

function info(id) {
  const q = state.queue.find((x) => x.id === id);
  if (q) return { id, title: q.title, channel: q.channel, len: q.len, short: Boolean(q.short) };
  const v = state.cat?.videos.find((x) => x.id === id);
  if (v) return { id, title: v.title, channel: v.channel, len: v.len, short: Boolean(v.short) };
  const d = state.digestById?.get(id);
  return { id, title: d?.title || "", channel: d?.channel || "", len: d?.len || 0, short: Boolean(d?.short) };
}

function onBarClick(e) {
  const act = e.target.closest("[data-sel]")?.dataset.sel;
  if (!act || sel.busy) return;
  const ids = picked();
  if (act === "clear") return clear();
  if (act === "all") return selectAll();
  if (act === "top" || act === "bottom") return void moveQueue(ids, act);
  if (act === "qdel") return void removeQueue(ids);
  if (act === "save") return void savePlaylists(ids);
  if (act === "queue") return void addQueue(ids);
  if (act === "pldel") return void removeFromPlaylist(ids);
  if (act === "dq") {
    clear();
    return void queueMany(ids);
  }
  if (act === "dhide") {
    clear();
    return hideMany(ids);
  }
}

// ---------- очередь ----------
async function moveQueue(ids, where) {
  // в порядке очереди, а не как показано (порядок «Сначала короткие» и т. п.)
  const inQ = state.queue.filter((x) => sel.ids.has(x.id)).map((x) => x.id);
  clear();
  const r = await qmsg({ type: where === "top" ? "queue:top" : "queue:bottom", ids: inQ.length ? inQ : ids });
  if (!r?.ok) return toast("Не получилось — обновите страницу библиотеки");
  toast(where === "top" ? `${videosWord(inQ.length)} — в начале очереди` : `${videosWord(inQ.length)} — в конце очереди`);
}

async function removeQueue(ids) {
  const items = snapshot(state.queue, ids, state.qpos);
  if (!items.length) return clear();
  clear();
  for (const id of ids) document.querySelectorAll(`.card[data-qid="${CSS.escape(id)}"]`).forEach((c) => c.style.setProperty("opacity", ".4"));
  const r = await qmsg({ type: "queue:remove", ids: items.map((x) => x.rec.id), why: "drop" });
  if (!r?.ok) return toast("Не получилось убрать — обновите страницу библиотеки");
  toast(`Убрано из очереди: ${videosWord(items.length)}`, () => void qmsg({ type: "queue:put", items, undo: "drop" }));
}

async function addQueue(ids) {
  const items = ids.map(info);
  clear();
  const r = await qmsg({ type: "queue:add", items });
  if (!r?.ok) return toast("Не получилось добавить в очередь — обновите страницу библиотеки");
  const added = Array.isArray(r.added) ? r.added : [];
  if (!added.length) return toast(items.length > 1 ? "Все выбранные уже в очереди" : "Уже в очереди");
  const had = items.length - added.length;
  toast(`В очереди: +${videosWord(added.length)}${had ? ` · уже были: ${nf.format(had)}` : ""}`, () => void qmsg({ type: "queue:remove", ids: added }));
}

// ---------- плейлисты YouTube ----------
// Окно «Сохранить в плейлисты» — то же, что на YouTube (playlists.js). Здесь его
// запросы (событие EV) уходят через вкладку YouTube, как остальные действия библиотеки.
let bridged = false;
function bridge() {
  if (bridged) return;
  bridged = true;
  document.addEventListener(EV, async (e) => {
    let req;
    try {
      req = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    if (typeof req?.id !== "string" || typeof req.op !== "string") return;
    const { op, id, ...args } = req;
    let reply;
    try {
      reply = { __ytcsPl: id, ok: true, data: await yt(op, args) };
    } catch (err) {
      reply = { __ytcsPl: id, ok: false, error: err?.code || "fail", message: String(err?.message || "") };
    }
    window.postMessage(reply, location.origin);
  });
}

function loadScript(src) {
  return new Promise((ok) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => ok(true);
    s.onerror = () => ok(false);
    document.head.append(s);
  });
}

let saved = false;
async function savePlaylists(ids) {
  bridge();
  if (!globalThis.__ytcsPlaylists && !(await loadScript("../playlists.js"))) return toast("Не получилось открыть окно — обновите страницу библиотеки");
  const videos = ids.map(info).map((v) => ({ id: v.id, title: v.title }));
  saved = false;
  const ok = await globalThis.__ytcsPlaylists?.open({
    videos,
    onSaved: (done) => {
      saved = true;
      if (done.every((id) => sel.ids.has(id)) && done.length === sel.ids.size) clear();
    },
  });
  if (ok === false) return;
  // окно закрыли: временную вкладку YouTube — закрыть, каталог — подтянуть изменения
  const host = document.getElementById("ytcs-playlists");
  if (!host) return;
  const mo = new MutationObserver(() => {
    if (host.isConnected) return;
    mo.disconnect();
    if (saved && state.cat && !state.syncing) void sync();
    else if (!state.syncing) void releaseTab();
  });
  mo.observe(document.documentElement, { childList: true });
}

// «Убрать из плейлиста» — только когда слева открыт один плейлист
async function removeFromPlaylist(ids) {
  const pid = state.pl;
  const p = pid && state.plById.get(pid);
  if (!p || !state.cat) return;
  sel.busy = `Убираю из «${p.title}»…`;
  renderBar();
  const done = [];
  let err = "";
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      await yt("editMany", { playlistId: pid, videoIds: part, add: false });
      done.push(...part);
      sel.busy = `Убираю из «${p.title}»: ${nf.format(done.length)} из ${nf.format(ids.length)}`;
      renderBar();
    }
  } catch (e) {
    err = e?.message || "YouTube не ответил";
  } finally {
    sel.busy = "";
    if (!state.syncing) await releaseTab();
  }
  // каталог: этих видео в плейлисте больше нет (запомним, где стояли, — для «Вернуть»)
  const gone = new Set(done);
  const was = [];
  let n = 0;
  for (const v of state.cat.videos)
    if (gone.has(v.id)) {
      const mine = v.in.filter(([id]) => id === pid);
      if (!mine.length) continue;
      was.push([v, mine]);
      v.in = v.in.filter(([id]) => id !== pid);
      n += mine.length;
    }
  shrink(state.cat.playlists.find((x) => x.id === pid), n);
  for (const id of done) sel.ids.delete(id);
  await kv("catalog", state.cat);
  useCatalog(state.cat, { keep: true });
  renderBar();
  if (err) return toast(`Убрано ${nf.format(done.length)} из ${nf.format(ids.length)}: ${esc(err)}. Можно повторить.`);
  toast(`Убрано из «${esc(p.title.slice(0, 50))}»: ${videosWord(done.length)}`, () => void putBack(pid, done, was, n));
}

// «Вернуть» — снова в плейлист (YouTube ставит их в конец)
async function putBack(pid, ids, was, n) {
  try {
    for (let i = 0; i < ids.length; i += CHUNK) await yt("editMany", { playlistId: pid, videoIds: ids.slice(i, i + CHUNK), add: true });
  } catch (e) {
    toast(`Не получилось вернуть: ${esc(e?.message || "YouTube не ответил")}`);
    return;
  } finally {
    if (!state.syncing) await releaseTab();
  }
  const p = state.cat?.playlists.find((x) => x.id === pid);
  if (p) p.count = (p.count || 0) + n;
  for (const [v, entries] of was) if (!v.in.some(([id]) => id === pid)) v.in.push(...entries);
  await kv("catalog", state.cat);
  useCatalog(state.cat, { keep: true });
  toast(`Вернул в плейлист: ${videosWord(ids.length)} — в конец`);
}

// плеер «Смотреть прямо здесь» открылся (кнопкой «Смотреть очередь» и т. п.) — выбор не нужен
document.addEventListener("ytcs-lib:watch", () => clear());
