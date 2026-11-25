// «Моя библиотека»: «Заметки» — все заметки с таймкодами (notes.js пишет их на YouTube
// и во встроенном плеере, клавиша N или «Заметка» в меню кнопки расширения в плеере).
//
// Раздел открывается кнопкой «Заметки» в шапке и адресом #notes, поверх остальных
// разделов, как «Статистика»: видео с заметками (свежие — сверху), поиск по тексту,
// клик по заметке — видео с этой секунды во встроенном плеере, правка и удаление
// с «Вернуть», «Копировать все» (текст с таймкодами-ссылками) и «В Telegram»
// (если бот настроен — тем же путём, что «Отчёт недели»: текст сообщением в чат с ботом).
// Под встроенным плеером любого раздела — заметки этого видео (клик — перемотка).
// Логика без DOM — notes-core.js, хранение — chrome.storage.local.tcNotes.

import "../notes-core.js";
import { serverSettings } from "../bot-settings.js";
import { icon } from "../sidepanel/icons.js";
import { saveHash } from "./library.js";
import { $, esc, nf, state } from "./state.js";
import { fmtLen } from "./view-lib.js";
import { closeWatch, openWatch, playerCmd, watch, watchHere } from "./watch.js";

const C = globalThis.__ytcsNotesCore;
const KEY = C.KEY; // chrome.storage.local.tcNotes
const TG_MAX = C.TG_MAX; // знаков в одном сообщении Telegram

// значки, которых нет в общем наборе: листок-заметка, карандаш, корзина, «вернуть»
const SVG = (body, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const NOTE = '<path d="M5 4h14v10.5L13.5 20H5z"/><path d="M13.5 20v-5.5H19"/><path d="M8.5 8.5h7M8.5 12h4"/>';
const EDIT = '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>';
const DEL = '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10 11v5.5M14 11v5.5"/>';
const UNDO = '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>';

const nv = { on: false, q: "", store: {}, editing: null, undo: null, undoTimer: 0, toastTimer: 0, tg: false, sending: false, built: false };

// ---------- данные ----------
async function load() {
  try {
    nv.store = C.cleanStore((await chrome.storage.local.get(KEY))[KEY]);
  } catch (e) {
    nv.store = {};
  }
}
async function mutate(fn) {
  const cur = C.cleanStore((await chrome.storage.local.get(KEY))[KEY]);
  const r = fn(cur);
  if (r.store !== cur) await chrome.storage.local.set({ [KEY]: r.store });
  nv.store = r.store;
  return r;
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch[KEY]) return;
  nv.store = C.cleanStore(ch[KEY].newValue);
  if (nv.on) renderBody();
  renderUnder();
});

// название и канал — из каталога, очереди или подписок, если у заметки их нет
function recOf(id) {
  return (
    state.cat?.videos?.find((x) => x.id === id) ||
    state.queue?.find((x) => x.id === id) ||
    state.digestList?.find((x) => x.id === id) ||
    (watch.on && watch.id === id ? watch.rec : null) ||
    null
  );
}
function withRec(v) {
  if (v.title && v.channel && v.len) return v;
  const r = recOf(v.id);
  return r ? { ...v, title: v.title || r.title || "", channel: v.channel || r.channel || "", len: v.len || r.len || 0 } : v;
}

// ---------- кнопка в шапке и сам раздел ----------
const tab = $("#nt-tab");
const sec = $("#notes");
export const toggleNotes = () => (nv.on ? closeNotes() : openNotes());
tab.addEventListener("click", toggleNotes);
// «Плейлисты» / «Очередь» / «Подписки» / «Статистика» — уйти из заметок
$(".views").addEventListener("click", (e) => e.target.closest("[data-view]") && nv.on && closeNotes());
$("#st-tab").addEventListener("click", () => nv.on && closeNotes());

function selectTabs() {
  if (nv.on) for (const b of document.querySelectorAll(".views [data-view]")) b.setAttribute("aria-selected", "false");
  tab.setAttribute("aria-pressed", String(nv.on));
}

export async function openNotes() {
  if (document.body.dataset.stats) await import("./stats-view.js").then((m) => m.closeStats()).catch(() => {});
  closeWatch();
  nv.on = true;
  document.body.dataset.notes = "1";
  sec.hidden = false;
  selectTabs();
  document.title = "Заметки — Моя библиотека";
  history.replaceState(null, "", location.pathname + location.search + "#notes");
  await load();
  build();
  renderBody();
  window.scrollTo(0, 0);
  void checkTg();
}

export function closeNotes() {
  if (!nv.on) return;
  nv.on = false;
  nv.editing = null;
  delete document.body.dataset.notes;
  sec.hidden = true;
  sec.innerHTML = "";
  nv.built = false;
  for (const b of document.querySelectorAll(".views [data-view]")) b.setAttribute("aria-selected", String(b.dataset.view === state.view));
  selectTabs();
  document.title = state.view === "queue" ? "Очередь — Моя библиотека" : state.view === "digest" ? "Подписки — Моя библиотека" : "Моя библиотека — плейлисты YouTube";
  saveHash();
}

// бот настроен (адрес и секрет) — тогда есть «В Telegram»
async function checkTg() {
  try {
    const s = await serverSettings();
    nv.tg = Boolean(s.baseUrl && s.token);
  } catch (e) {
    nv.tg = false;
  }
  for (const b of document.querySelectorAll("[data-nt=tg], [data-nt=tg-v]")) b.hidden = !nv.tg;
}

// каркас раздела: шапка с поиском строится один раз — поле поиска не теряет фокус при вводе
function build() {
  if (nv.built) return;
  nv.built = true;
  sec.innerHTML = `<div class="nt-wrap">
      <div class="nt-head">
        <div class="nt-ttl"><h1>Заметки</h1><p id="nt-sum"></p></div>
        <div class="nt-tools">
          <label class="nt-search">${icon("search", { size: 18 })}<input id="nt-q" type="search" autocomplete="off" spellcheck="false" placeholder="Поиск по заметкам" aria-label="Поиск по тексту заметок, названию и каналу" /></label>
          <span class="nt-btns">
            <button type="button" class="ghost" data-nt="copy" title="Скопировать заметки с таймкодами-ссылками — вставить можно куда угодно">${icon("copy", { size: 16 })}<span class="nt-copy-l">Копировать все</span></button>
            <button type="button" class="ghost" data-nt="tg" ${nv.tg ? "" : "hidden"} title="Сообщением в ваш чат с ботом">${icon("send", { size: 16 })}В Telegram</button>
          </span>
        </div>
      </div>
      <div id="nt-list" class="nt-list"></div>
    </div>`;
  const q = $("#nt-q");
  q.value = nv.q;
  let t = 0;
  q.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      nv.q = q.value;
      renderBody();
    }, 80);
  });
  q.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && q.value) {
      e.preventDefault();
      q.value = nv.q = "";
      renderBody();
    }
  });
}

// подсветка найденных слов (как в поиске библиотеки)
function mark(text, ws) {
  const s = String(text ?? "");
  if (!ws.length) return esc(s);
  const low = C.norm(s);
  const hit = new Array(s.length).fill(false);
  for (const w of ws) for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + 1)) hit.fill(true, i, i + w.length);
  let out = "";
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j < s.length && hit[j] === hit[i]) j++;
    out += hit[i] ? `<mark>${esc(s.slice(i, j))}</mark>` : esc(s.slice(i, j));
    i = j;
  }
  return out;
}

// строка заметки — общая для раздела и для блока под плеером
function rowHtml(id, n, ws = []) {
  const href = esc(C.watchUrl(id, n.t));
  const tc = `<a class="nt-tc" href="${href}" target="_blank" rel="noreferrer" data-nt-open data-t="${n.t}" title="Открыть с ${C.fmtTime(n.t)}">${C.fmtTime(n.t)}</a>`;
  if (nv.editing?.id === id && nv.editing.at === n.at) {
    return `<li class="nt-row editing" data-vid="${esc(id)}" data-at="${n.at}">${tc}
      <span class="nt-edit"><input class="nt-in" type="text" maxlength="${C.MAX_TEXT}" value="${esc(n.text)}" aria-label="Текст заметки" />
        <span class="nt-eb"><button type="button" class="primary" data-nt="save">${icon("check", { size: 16 })}Сохранить</button><button type="button" class="ghost" data-nt="cancel">Отмена</button></span></span>
    </li>`;
  }
  return `<li class="nt-row" data-vid="${esc(id)}" data-at="${n.at}">${tc}
      <span class="nt-tx">${mark(n.text, ws)}</span>
      <span class="nt-ra">
        <button type="button" class="nt-ib" data-nt="edit" title="Изменить" aria-label="Изменить заметку">${SVG(EDIT)}</button>
        <button type="button" class="nt-ib del" data-nt="del" title="Удалить" aria-label="Удалить заметку">${SVG(DEL)}</button>
      </span>
    </li>`;
}

function cardHtml(v, ws) {
  const id = v.id;
  const sub = [v.channel, v.items.length < v.total ? `найдено ${nf.format(v.items.length)} из ${C.notesWord(v.total)}` : C.notesWord(v.total)].filter(Boolean);
  const href = esc(C.watchUrl(id, 0));
  return `<article class="nt-card" data-vid="${esc(id)}">
      <a class="nt-th" href="${href}" target="_blank" rel="noreferrer" data-nt-open data-t="0" tabindex="-1" aria-label="${esc(v.title || "Видео")}">
        <img loading="lazy" alt="" src="https://i.ytimg.com/vi/${esc(id)}/mqdefault.jpg" />${v.len ? `<span class="dur">${fmtLen(v.len)}</span>` : ""}
      </a>
      <div class="nt-vh">
        <div class="nt-vt">
          <a class="nt-title" href="${href}" target="_blank" rel="noreferrer" data-nt-open data-t="0" title="${esc(v.title || "Видео")}">${mark(v.title || "Видео YouTube", ws)}</a>
          <span class="nt-sub">${sub.map((x, i) => (i === 0 && v.channel ? mark(x, ws) : esc(x))).join(" · ")}</span>
        </div>
        <span class="nt-vacts">
          <button type="button" class="nt-ib" data-nt="copy-v" title="Копировать заметки этого видео" aria-label="Копировать заметки этого видео">${icon("copy", { size: 18 })}</button>
          <button type="button" class="nt-ib" data-nt="tg-v" ${nv.tg ? "" : "hidden"} title="Заметки этого видео — в Telegram" aria-label="Заметки этого видео — в Telegram">${icon("send", { size: 18 })}</button>
        </span>
      </div>
      <ol class="nt-items">${v.items.map((n) => rowHtml(id, n, ws)).join("")}</ol>
    </article>`;
}

function shown() {
  return C.search(nv.store, nv.q).map(withRec);
}

function renderBody() {
  if (!nv.on || !nv.built) return;
  const all = C.count(nv.store);
  const list = shown();
  const ws = C.words(nv.q);
  state.notesList = list.map((v) => ({ id: v.id, title: v.title, channel: v.channel, len: v.len })); // «Дальше» во встроенном плеере
  const found = list.reduce((n, v) => n + v.items.length, 0);
  $("#nt-sum").innerHTML = !all.notes
    ? "Мысли к моментам видео — с таймкодами"
    : ws.length
      ? `Найдено: ${C.notesWord(found)} в ${nf.format(list.length)} видео · всего ${C.notesWord(all.notes)}`
      : `${C.notesWord(all.notes)} в ${nf.format(all.videos)} видео · новая — <kbd>N</kbd> в плеере`;
  $(".nt-wrap").classList.toggle("is-empty", !all.notes);
  const copyL = $(".nt-copy-l");
  if (copyL) copyL.textContent = ws.length ? "Копировать найденное" : "Копировать все";
  for (const b of sec.querySelectorAll(".nt-btns button")) b.disabled = !list.length;
  const box = $("#nt-list");
  if (!all.notes) {
    box.innerHTML = `<div class="nt-empty"><div class="empty-box">
        <span class="empty-icon">${SVG(NOTE, 30)}</span>
        <div class="empty-title">Заметок пока нет</div>
        <div class="empty-text">Во время просмотра нажмите <kbd>N</kbd> или «Заметка» в меню кнопки расширения в плеере — видео встанет на паузу. Впишите мысль и нажмите <kbd>Enter</kbd>: видео продолжится, а заметка появится здесь, точкой на полосе прогресса и рядом с плеером.</div>
      </div></div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = `<div class="nt-empty"><div class="empty-box">
        <span class="empty-icon">${icon("search", { size: 30 })}</span>
        <div class="empty-title">Ничего не нашлось</div>
        <div class="empty-text">Ищем по тексту заметок, названию видео и каналу — все слова запроса сразу.</div>
      </div></div>`;
    return;
  }
  const keep = nv.editing ? box.querySelector(".nt-in")?.value : null;
  box.innerHTML = list.map((v) => cardHtml(v, ws)).join("");
  focusEdit(box, keep);
}

function focusEdit(root, keep) {
  const inp = root.querySelector(".nt-in");
  if (!inp) return;
  if (keep != null) inp.value = keep;
  inp.focus({ preventScroll: true });
  inp.setSelectionRange(inp.value.length, inp.value.length);
}

// ---------- заметки под встроенным плеером (любой раздел) ----------
function renderUnder() {
  const info = watch.on ? $("#watch .w-info") : null;
  let box = $("#w-notes");
  const id = watch.on ? watch.id : "";
  const v = id ? nv.store[id] : null;
  const undo = nv.undo && nv.undo.id === id ? nv.undo : null;
  if (!info || (!v && !undo)) {
    box?.remove();
    return;
  }
  if (!box || box.parentElement !== info) {
    box?.remove();
    box = document.createElement("section");
    box.id = "w-notes";
    box.className = "w-notes";
    box.setAttribute("aria-label", "Заметки к видео");
    info.appendChild(box);
  }
  // название — из библиотеки, если заметку писали без него (встроенный плеер не всегда знает)
  const r = watch.rec;
  if (v && r && (!v.title || !v.channel)) void mutate((s) => C.setMeta(s, id, { title: r.title, channel: r.channel, len: r.len }));
  const items = v?.items || [];
  const keep = nv.editing?.id === id ? box.querySelector(".nt-in")?.value : null;
  box.innerHTML = `<div class="w-nh"><span class="w-nt">${SVG(NOTE)}<b>Заметки</b><span>${items.length ? C.notesWord(items.length) : "нет заметок"} · новая — <kbd>N</kbd></span></span>
      ${items.length ? `<button type="button" class="ghost" data-nt="copy-v" data-vid="${esc(id)}" title="Скопировать заметки с таймкодами-ссылками">${icon("copy", { size: 16 })}Копировать</button>` : ""}</div>
    ${items.length ? `<ol class="nt-items">${items.map((n) => rowHtml(id, n)).join("")}</ol>` : ""}`;
  if (keep != null) focusEdit(box, keep);
}
new MutationObserver(() => {
  if (watch.on && !$("#w-notes") && $("#watch .w-info")) renderUnder();
  // вернулись из плеера в раздел — адрес снова #notes, список свежий
  if (nv.on && !watch.on && location.hash !== "#notes") {
    history.replaceState(null, "", location.pathname + location.search + "#notes");
    document.title = "Заметки — Моя библиотека";
    renderBody();
  }
}).observe($("#watch"), { childList: true, attributes: true, attributeFilter: ["hidden"] });
// пока открыт раздел, адрес — #notes (обновление каталога и другие разделы переписывают адрес
// своим saveHash) — так F5 вернёт в «Заметки»
setInterval(() => {
  if (nv.on && !watch.on && location.hash !== "#notes") history.replaceState(null, "", location.pathname + location.search + "#notes");
}, 1000);

// ---------- действия ----------
function msg(text, { undo = false, ms = 3200, err = false } = {}) {
  let t = $("#nt-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "nt-toast";
    t.className = "nt-toast";
    t.setAttribute("role", "status");
    document.body.appendChild(t);
  }
  t.classList.toggle("err", err);
  t.innerHTML = `<span>${esc(text)}</span>${undo ? `<button type="button" class="ghost" data-nt="undo">${SVG(UNDO, 16)}Вернуть</button>` : ""}`;
  void t.offsetHeight;
  t.classList.add("show");
  clearTimeout(nv.toastTimer);
  nv.toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

function videosFor(id) {
  if (id) {
    const v = nv.store[id];
    return v ? [withRec({ id, ...v })] : [];
  }
  return shown();
}

async function copy(id) {
  const list = videosFor(id);
  if (!list.length) return;
  const n = list.reduce((k, v) => k + v.items.length, 0);
  try {
    await navigator.clipboard.writeText(C.exportText(list));
    msg(`Скопировано: ${C.notesWord(n)} с таймкодами-ссылками`);
  } catch (e) {
    msg("Не получилось скопировать — нажмите ещё раз", { err: true });
  }
}

// «В Telegram» — тот же путь, что «Отчёт недели» (backup-bg.js): текст сообщением в чат с ботом
async function sendTg(id) {
  if (nv.sending) return;
  const list = videosFor(id);
  if (!list.length) return;
  const head = "Заметки с YouTube\n\n";
  const { text, cut } = C.tgText(list, TG_MAX - head.length);
  nv.sending = true;
  for (const b of document.querySelectorAll("[data-nt=tg], [data-nt=tg-v]")) b.disabled = true;
  msg("Отправляю в Telegram…", { ms: 60000 });
  let out = "";
  let err = true;
  try {
    const s = await serverSettings();
    if (!s.baseUrl || !s.token) throw new Error("setup");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000);
    let r;
    try {
      r = await fetch(`${String(s.baseUrl).replace(/\/+$/, "")}/api/weekly-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sec-Token": s.token },
        body: JSON.stringify({ text: head + text }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) {
      err = false;
      out = cut ? `Отправлено в Telegram. Не вошло ${C.notesWord(cut)} — сообщение вмещает до 3000 знаков, остальное — «Копировать»` : "Отправлено в ваш чат с ботом";
    } else if (r.status === 429) out = "Telegram: можно раз в минуту — попробуйте чуть позже";
    else if (r.status === 403) out = "Бот не принял секрет — проверьте его в настройках панели";
    else if (r.status === 404 || r.status === 405) out = "Бот пока не умеет принимать текст — обновите бота";
    else out = d.error ? `Не отправилось: ${d.error}` : `Не отправилось: бот ответил ${r.status}`;
  } catch (e) {
    out = e?.message === "setup" ? "Бот не настроен: адрес и секрет — в настройках панели" : "Бот не ответил — возможно, он просыпается. Попробуйте через минуту";
  }
  nv.sending = false;
  for (const b of document.querySelectorAll("[data-nt=tg], [data-nt=tg-v]")) b.disabled = false;
  msg(out, { err, ms: err ? 7000 : cut ? 7000 : 3200 });
}

async function saveEdit(row) {
  const id = row.dataset.vid;
  const at = Number(row.dataset.at);
  const text = C.cleanText(row.querySelector(".nt-in")?.value);
  nv.editing = null;
  if (!text) return removeWithUndo(id, at); // стёрли весь текст — значит, удалить
  await mutate((s) => C.updateNote(s, id, at, text));
  rerender();
}

async function removeWithUndo(id, at) {
  if (nv.editing?.id === id && nv.editing.at === at) nv.editing = null;
  const r = await mutate((s) => C.removeNote(s, id, at));
  rerender();
  if (!r.note) return;
  nv.undo = { id, note: r.note, meta: r.meta };
  clearTimeout(nv.undoTimer);
  nv.undoTimer = setTimeout(() => (nv.undo = null), 9000);
  msg(`Заметка на ${C.fmtTime(r.note.t)} удалена`, { undo: true, ms: 9000 });
}

function rerender() {
  if (nv.on) renderBody();
  renderUnder();
}

document.addEventListener("click", async (e) => {
  const scope = e.target.closest("#notes, #w-notes, #nt-toast");
  if (!scope) return;
  // время, название, обложка — открыть видео с этой секунды (во встроенном плеере, если можно)
  const play = e.target.closest("a[data-nt-open]");
  if (play) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    const id = play.closest("[data-vid]")?.dataset.vid;
    const t = Number(play.dataset.t) || 0;
    if (scope.id === "w-notes" && watch.on && watch.id === id) {
      e.preventDefault();
      playerCmd("seekTo", [t, true]);
      return;
    }
    if (watchHere() && id) {
      e.preventDefault();
      if (!state.notesList?.some((x) => x.id === id)) state.notesList = [...(state.notesList || []), { id, ...withRec({ id, ...(nv.store[id] || {}) }) }];
      openWatch(id, "notes", t);
    }
    return; // иначе — ссылка: во вкладке (в боковой панели — в текущей, library.js)
  }
  const b = e.target.closest("[data-nt]");
  if (!b) return;
  const act = b.dataset.nt;
  const row = b.closest(".nt-row");
  const vid = b.closest("[data-vid]")?.dataset.vid || "";
  if (act === "edit" && row) {
    nv.editing = { id: row.dataset.vid, at: Number(row.dataset.at) };
    rerender();
  } else if (act === "cancel") {
    nv.editing = null;
    rerender();
  } else if (act === "save" && row) await saveEdit(row);
  else if (act === "del" && row) await removeWithUndo(row.dataset.vid, Number(row.dataset.at));
  else if (act === "undo") {
    const u = nv.undo;
    nv.undo = null;
    clearTimeout(nv.undoTimer);
    $("#nt-toast")?.classList.remove("show");
    if (u) await mutate((s) => C.restoreNote(s, u.id, u.note, u.meta));
    rerender();
  } else if (act === "copy") await copy("");
  else if (act === "copy-v") await copy(vid);
  else if (act === "tg") await sendTg("");
  else if (act === "tg-v") await sendTg(vid);
});

document.addEventListener("keydown", (e) => {
  const inp = e.target.closest?.(".nt-in");
  if (inp) {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      void saveEdit(inp.closest(".nt-row"));
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // Esc — отменить правку, а не закрыть плеер
      nv.editing = null;
      rerender();
    }
    return;
  }
  // N во встроенном плеере, когда фокус на странице, а не в плеере: передаём плееру
  // (notes.js во фрейме откроет поле заметки) и отдаём ему фокус
  if (!watch.on || !watch.frame || e.code !== "KeyN" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target?.tagName || "")) return;
  e.preventDefault();
  watch.frame.focus();
  watch.frame.contentWindow?.postMessage({ ytcsNote: "open" }, "https://www.youtube.com");
}, true);

// ---------- старт: library.js грузит модуль сразу после себя ----------
export async function init(fromHash) {
  await load();
  if (fromHash || location.hash === "#notes") void openNotes();
  // адрес — из события: библиотека на popstate успевает переписать его раньше hashchange
  window.addEventListener("hashchange", (e) => {
    let hash = "";
    try {
      hash = new URL(e.newURL).hash;
    } catch (err) {
      hash = location.hash;
    }
    if (hash === "#notes" && !nv.on) void openNotes();
  });
  renderUnder();
}
