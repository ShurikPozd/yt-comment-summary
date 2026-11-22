// «Моя библиотека»: «Разобрать завалы» — пересказ «о чём видео» рядом с текущим видео.
//
// Готовый пересказ (общий кеш tldr:<id> — его пишут и панель, и окно на обложках)
// показываем сразу. Нет — кнопка «Пересказать» (или Пробел): сам пересказ делает
// фон (порт "ytcs-tldr" → tldr-bg.js → tldr-core.js), здесь — только отрисовка.
// Лимиты Groq бесплатные и общие с ботом, поэтому сами ничего не запускаем, кроме
// одного: если вы уже пересказали текущее видео, следующее пересказываем заранее —
// по одному и только пока вы пользуетесь пересказами (ошибка лимита — остановка).

import { icon } from "../sidepanel/icons.js";
import { fmtTime } from "../sidepanel/insights.js";
import { TLDR_CACHE_PREFIX, pickEven } from "../tldr-core.js";
import { esc } from "./state.js";

const PORT = "ytcs-tldr";
const MAX_POINTS = 6;
const VID_RE = /^[A-Za-z0-9_-]{11}$/;

const cache = new Map(); // vid → пересказ | null (точно нет)
const jobs = new Map(); // vid → { state, phase, frac, about, points, kind, text, music, pre, retried }
const T = { vid: "", rec: null, next: null, wants: false, onOpen: null, linkFor: null };

const alive = () => {
  try {
    return Boolean(globalThis.chrome?.runtime?.id);
  } catch (e) {
    return false;
  }
};

// ---------- кеш ----------

/** Один запрос на всю очередь — дальше пересказы показываются без ожидания. */
export async function tldrPreload(ids) {
  const keys = ids.filter((id) => VID_RE.test(id) && !cache.has(id)).map((id) => TLDR_CACHE_PREFIX + id);
  if (!keys.length) return;
  let got = {};
  try {
    got = await chrome.storage.local.get(keys);
  } catch (e) {
    /* без кеша — покажем кнопку */
  }
  for (const k of keys) cache.set(k.slice(TLDR_CACHE_PREFIX.length), got[k] || null);
  if (T.vid) {
    paint();
    prefetch();
  }
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  for (const [k, v] of Object.entries(ch)) {
    if (!k.startsWith(TLDR_CACHE_PREFIX) || k === TLDR_CACHE_PREFIX + "index") continue;
    const vid = k.slice(TLDR_CACHE_PREFIX.length);
    cache.set(vid, v.newValue || null);
    if (vid === T.vid && !jobs.has(vid)) paint();
  }
});

// ---------- связь с фоном ----------

let port = null;

function getPort() {
  if (port) return port;
  if (!alive()) return null;
  try {
    port = chrome.runtime.connect({ name: PORT });
  } catch (e) {
    return null;
  }
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    // фон перезапустился посреди пересказа — один раз переспрашиваем (кеш или новая задача)
    for (const [vid, j] of jobs) {
      if (j.state !== "run") continue;
      if (!j.retried && alive()) {
        j.retried = true;
        send(vid, false);
      } else setJob(vid, { state: alive() ? "error" : "reload", kind: "ai", text: "Связь с расширением прервалась. Попробуйте ещё раз." });
    }
  });
  return port;
}

function send(vid, force) {
  const p = getPort();
  const r = vid === T.vid ? T.rec : vid === T.next?.id ? T.next : null;
  if (!p) return setJob(vid, { state: "reload" });
  try {
    p.postMessage({ type: "start", vid, title: r?.title || "", duration: r?.len || 0, force: Boolean(force) });
  } catch (e) {
    port = null;
    setJob(vid, { state: "reload" });
  }
}

function onPortMessage(msg) {
  const vid = msg?.vid;
  const j = jobs.get(vid);
  if (!j) return; // отменённое дописывается в кеш само
  if (msg.type === "progress") {
    Object.assign(j, { state: "run", phase: msg.phase, frac: msg.frac, about: msg.about || "", points: msg.points || [] });
    if (vid === T.vid) paintRun();
  } else if (msg.type === "done") {
    cache.set(vid, msg.data || null);
    jobs.delete(vid);
    if (vid === T.vid) {
      paint();
      prefetch();
    }
  } else if (msg.type === "nosubs") {
    setJob(vid, { state: "nosubs", music: Boolean(msg.music) });
    if (vid === T.vid) prefetch();
  } else if (msg.type === "error") {
    const text = msg.kind === "transcript" ? transcriptText(msg.text) : msg.text || "";
    // лимит Groq кончился — заранее больше ничего не пересказываем
    if (/лимит/i.test(text)) T.wants = false;
    if (j.pre && vid !== T.vid) {
      jobs.delete(vid); // заранее не вышло — покажем кнопку, когда дойдёте до видео
      return;
    }
    setJob(vid, { state: msg.kind === "setup" ? "setup" : "error", kind: msg.kind, text });
  }
}

// у фона текст под вкладку YouTube («обновите страницу») — здесь он не к месту
function transcriptText(s) {
  return /не ответил/.test(s || "")
    ? "YouTube не ответил — проверьте интернет и попробуйте ещё раз."
    : "YouTube не отдал субтитры этого видео. Попробуйте ещё раз чуть позже.";
}

function setJob(vid, patch) {
  const j = jobs.get(vid) || {};
  jobs.set(vid, Object.assign(j, patch));
  if (vid === T.vid) paint();
}

function start(vid, { force = false, pre = false } = {}) {
  if (!VID_RE.test(vid)) return;
  if (jobs.get(vid)?.state === "run") return;
  jobs.set(vid, { state: "run", phase: "Загружаю субтитры…", frac: 0.04, about: "", points: [], pre, retried: false });
  if (vid === T.vid) paint();
  send(vid, force);
}

function cancel(vid) {
  if (!jobs.has(vid)) return;
  jobs.delete(vid);
  try {
    port?.postMessage({ type: "cancel", vid });
  } catch (e) {
    /* фон и так остановится */
  }
  if (vid === T.vid) paint();
}

// Заранее — только следующее видео, только если текущее уже пересказано по вашей
// просьбе (или было готово, пока вы ими пользуетесь), и не больше одного сразу.
function prefetch() {
  const n = T.next;
  if (!T.wants || !n || !cache.has(T.vid) || !cache.get(T.vid)) return;
  if (cache.get(n.id) || !cache.has(n.id) || jobs.has(n.id)) return;
  for (const j of jobs.values()) if (j.state === "run") return;
  start(n.id, { pre: true });
}

// ---------- отрисовка ----------

const skeleton = '<div class="tt-skel"><i></i><i></i><i></i></div>';

function fmtDate(ts) {
  try {
    return new Date(ts).toLocaleString("ru-RU", { day: "numeric", month: "long" });
  } catch (e) {
    return "";
  }
}

function pointsHtml(points) {
  if (!points.length) return "";
  const longest = Math.max(...points.map((p) => fmtTime(p.t).length));
  const ext = T.linkFor ? "" : ' target="_blank" rel="noopener"';
  return `<div class="tt-sub">Главное <span>нажмите — смотреть с этого места</span></div>
    <div class="tt-pts" style="--tc-w: calc(2.4rem + ${longest}ch)">${points
      .map(
        (p) => `<a class="tt-row" href="https://www.youtube.com/watch?v=${esc(T.vid)}&t=${Math.floor(p.t)}s"${ext} data-tt-t="${Math.floor(p.t)}" title="Смотреть с ${fmtTime(p.t)}">
          <span class="tt-tc">${icon("play", { size: 12 })}${fmtTime(p.t)}</span><span class="tt-tx">${esc(p.x)}</span></a>`
      )
      .join("")}</div>`;
}

function emptyHtml(ic, title, text, btn = "") {
  return `<div class="tt-empty"><div class="tt-ic">${icon(ic, { size: 24 })}</div><b>${esc(title)}</b><p>${text}</p>${btn}</div>`;
}

const goBtn = (label) =>
  `<button type="button" class="primary tt-go" data-tt="go">${icon("subtitles", { size: 18 })}${esc(label)}<kbd class="key">Пробел</kbd></button>`;

function head(right = "") {
  return `<div class="tt-head"><span class="tt-kicker">${icon("subtitles", { size: 16 })}О чём видео</span>${right}</div>`;
}

/** Разметка панели — пустая рамка; содержимое рисует paint() после вставки. */
export function tldrPanelHtml() {
  return `<section class="t-tldr" id="t-tldr" aria-label="О чём видео" aria-live="polite"><div class="tt-in"></div></section>`;
}

function paint() {
  const box = document.querySelector("#t-tldr .tt-in");
  if (!box || !T.vid) return;
  const vid = T.vid;
  const j = jobs.get(vid);
  const d = cache.get(vid);
  let html;
  if (j?.state === "run") {
    html = `${head(`<button type="button" class="tt-mini" data-tt="cancel" title="Остановить пересказ">${icon("close", { size: 14 })}Отменить</button>`)}
      <div class="tt-body live"><div class="tt-phase"></div><div class="tt-bar"><i></i></div>
        <p class="tt-about"></p><div class="tt-skw">${skeleton}</div><div class="tt-lp"></div></div>`;
    box.innerHTML = html;
    box.dataset.state = "run";
    return paintRun();
  }
  if (j?.state === "nosubs") {
    html = emptyHtml(
      "subtitles",
      "У этого видео нет субтитров",
      j.music
        ? "В субтитрах только пометки вроде «[музыка]» — речи, которую можно пересказать, в видео нет."
        : "Пересказ строится по субтитрам, а у этого видео их нет — ни авторских, ни автоматических."
    );
  } else if (j?.state === "setup") {
    html = emptyHtml(
      "settings",
      "Подключите сервер с ИИ",
      "Для пересказа нужен адрес сервера и секрет: откройте боковую панель расширения (<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Y</kbd>) → «Настройки»."
    );
  } else if (j?.state === "reload") {
    html = emptyHtml("refresh", "Расширение обновилось", "Обновите эту страницу (F5) — и пересказ заработает.");
  } else if (j?.state === "error") {
    const title = j.kind === "transcript" ? "Не получилось загрузить субтитры" : "Не получилось пересказать видео";
    html = emptyHtml("close", title, esc(j.text || "Попробуйте ещё раз."), goBtn("Попробовать ещё раз"));
  } else if (d) {
    const pts = pickEven(d.points || [], MAX_POINTS);
    const note = [`Пересказ по субтитрам от ${fmtDate(d.updatedAt)}`, d.trimmed ? "видео длинное — по сокращённой расшифровке" : ""].filter(Boolean).join(" · ");
    html = `${head(`<button type="button" class="tt-mini" data-tt="redo" title="Пересказать заново (потратит бесплатный лимит Groq)">${icon("refresh", { size: 14 })}Заново</button>`)}
      <div class="tt-body"><p class="tt-about">${esc(d.about || "")}</p>${pointsHtml(pts)}<div class="tt-note">${esc(note)}</div></div>`;
  } else if (!cache.has(vid)) {
    html = `${head()}<div class="tt-body">${skeleton}</div>`;
  } else {
    html = emptyHtml(
      "subtitles",
      "Коротко о видео",
      "ИИ прочитает субтитры и расскажет суть в паре предложений и главное с таймкодами — чтобы решить, не открывая видео. Бесплатно, обычно до минуты.",
      goBtn("Пересказать")
    );
  }
  box.innerHTML = html;
  box.scrollTop = 0;
  box.dataset.state = j?.state || (d ? "done" : cache.has(vid) ? "cta" : "load");
  fade(box);
}

// длинный пересказ листается внутри панели — снизу затухание, пока есть что листать
function fade(box) {
  box.parentElement.classList.toggle("tt-more", box.scrollHeight - box.scrollTop - box.clientHeight > 4);
}

document.addEventListener("scroll", (e) => e.target?.classList?.contains("tt-in") && fade(e.target), true);
window.addEventListener("resize", () => {
  const box = document.querySelector("#t-tldr .tt-in");
  if (box) fade(box);
});

// во время работы обновляем только изменившееся — без мигания и сброса прокрутки
function paintRun() {
  const box = document.querySelector("#t-tldr .tt-in");
  const j = jobs.get(T.vid);
  if (!box || !j) return;
  const ph = box.querySelector(".tt-phase");
  if (!ph) return paint();
  ph.textContent = j.phase || "Пишу пересказ…";
  box.querySelector(".tt-bar i").style.width = `${Math.round((j.frac || 0) * 100)}%`;
  const about = box.querySelector(".tt-about");
  if (about.textContent !== j.about) about.textContent = j.about || "";
  box.querySelector(".tt-skw").innerHTML = j.about ? "" : skeleton;
  const pts = pickEven(j.points || [], MAX_POINTS);
  const key = pts.map((p) => `${p.t}|${p.x}`).join("\n");
  const lp = box.querySelector(".tt-lp");
  if (lp.dataset.key !== key) {
    lp.dataset.key = key;
    lp.innerHTML = pointsHtml(pts);
  }
  fade(box);
}

// ---------- подключение к «Разобрать завалы» ----------

/**
 * Показать пересказ для текущего видео (после каждой отрисовки разбора).
 * linkFor(vid, t) — открыть видео с места t у себя (плеер библиотеки); null — ссылкой на YouTube.
 */
export function tldrShow(rec, next, { linkFor = null } = {}) {
  T.rec = rec;
  T.vid = rec?.id || "";
  T.next = next || null;
  T.linkFor = linkFor;
  if (T.vid && !cache.has(T.vid)) void tldrPreload([T.vid, next?.id].filter(Boolean));
  paint();
  prefetch();
}

/** Закончили разбор: заранее начатое и никем не виденное — отменяем, лимиты дороже. */
export function tldrStop() {
  for (const [vid, j] of jobs) if (j.pre && j.state === "run") cancel(vid);
  for (const [vid, j] of jobs) if (j.state !== "run") jobs.delete(vid);
  T.vid = "";
  T.rec = T.next = null;
  T.wants = false;
}

/** Пробел: пересказать текущее, если ещё нет. */
export function tldrKey() {
  const st = document.querySelector("#t-tldr .tt-in")?.dataset.state;
  if (st === "cta" || st === "error") {
    T.wants = true;
    start(T.vid, { force: st === "error" });
    return true;
  }
  return false;
}

document.addEventListener("click", (e) => {
  const panel = e.target.closest?.("#t-tldr");
  if (!panel || !T.vid) return;
  const row = e.target.closest("a[data-tt-t]");
  if (row) {
    if (T.linkFor && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
      e.preventDefault();
      T.linkFor(T.vid, Number(row.dataset.ttT));
    }
    return;
  }
  const act = e.target.closest("[data-tt]")?.dataset.tt;
  if (act === "go") {
    T.wants = true;
    start(T.vid, { force: jobs.get(T.vid)?.state === "error" });
  } else if (act === "redo") {
    T.wants = true;
    start(T.vid, { force: true });
  } else if (act === "cancel") {
    T.wants = false;
    cancel(T.vid);
  }
});
