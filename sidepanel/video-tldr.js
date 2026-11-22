// Вкладка «О видео»: краткий пересказ самого видео по его субтитрам.
//
// Расшифровку отдаёт контент-скрипт вкладки (yt:transcript, см. transcript.js
// и content.js); если он не отвечает (вкладку открыли до обновления
// расширения) — тот же запрос делаем прямо из панели.
// Сам пересказ (map/reduce, стрим, кеш) — общее ядро tldr-core.js: им же
// пользуется окно «О чём видео» на ленте (hover-tldr.js через фон), кеш общий.
// Бюджет лимитов Groq — общий с анализом комментариев (pacer из sidepanel.js).

import { runTldr, parseTldr, loadTldr, tldrCopyText, cancelledError, TLDR_CACHE_PREFIX } from "../tldr-core.js";
import { fmtTime } from "./insights.js";
import { icon } from "./icons.js";

let D = null; // зависимости из sidepanel.js (initVideoTldr)
const runs = new Map(); // videoId → { ac, phase, frac, live, startedAt }
const errors = new Map(); // videoId → { kind, text }
let viewVid = null;
let entry = null; // пересказ из кеша для viewVid
let loadSeq = 0;

const $ = (id) => document.getElementById(id);

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ---------------- Расшифровка ----------------

async function getTranscript(vid, signal) {
  let tabErr = null;
  try {
    const tab = await D.findActiveVideoTab();
    if (tab?.id) {
      const r = await chrome.tabs.sendMessage(tab.id, { type: "yt:transcript", videoId: vid });
      if (r?.ok) return r;
      if (r?.error && r.error !== "other-video") tabErr = new Error(r.error);
    }
  } catch (e) {
    tabErr = e; // контент-скрипт не ответил — устарел или вкладка закрыта
  }
  if (signal.aborted) throw cancelledError();
  // запасной путь: тот же запрос к YouTube прямо из панели
  const api = globalThis.__ytcsTranscript;
  if (!api) throw tabErr || new Error("transcript:unavailable");
  return api.fetchTranscript(vid, { signal });
}

// ---------------- Запуск ----------------

async function summarize(vid) {
  if (runs.has(vid)) return;
  if (!D.proxy.configured) {
    D.showToast("Заполните настройки сервера с ИИ (адрес и секрет).");
    D.setTab("settings");
    return;
  }
  const st = D.getState();
  const meta = st.videoId === vid ? st.meta : null;
  const title = meta?.title || "";
  const run = { ac: new AbortController(), phase: "Загружаю субтитры видео…", frac: 0.04, live: "", startedAt: Date.now() };
  const signal = run.ac.signal;
  runs.set(vid, run);
  errors.delete(vid);
  const update = (patch) => {
    Object.assign(run, patch);
    if (viewVid === vid) paintRun(vid);
  };
  paint();
  try {
    const tr = await getTranscript(vid, signal);
    if (signal.aborted) return;
    const data = await runTldr({
      vid,
      transcript: tr,
      title,
      duration: Number(meta?.duration) || 0,
      lang: st.settings?.lang || "ru",
      proxy: D.proxy,
      pacer: D.pacer,
      signal,
      onUpdate: update,
    });
    if (signal.aborted) return;
    if (data.nosubs) {
      errors.set(vid, { kind: "nosubs", music: data.music });
      return;
    }
    if (viewVid === vid) entry = data;
    else D.showToast(`Пересказ «${title.length > 40 ? title.slice(0, 38) + "…" : title || "видео"}» готов`);
  } catch (e) {
    if (e?.cancelled || signal.aborted) return;
    const s = String(e?.message || e);
    if (/^transcript:/.test(s)) {
      errors.set(vid, { kind: "transcript", text: s });
    } else {
      errors.set(vid, { kind: "ai", text: D.friendlyError(e) });
    }
  } finally {
    if (runs.get(vid) === run) runs.delete(vid);
    if (viewVid === vid) paint();
  }
}

function cancel(vid) {
  const run = runs.get(vid);
  if (!run) return;
  run.ac.abort();
  runs.delete(vid);
  paint();
}

// ---------------- Отрисовка ----------------

function emptyBlock(iconName, title, text, extra = "") {
  return `<div class="view-empty"><div class="empty-icon small">${icon(iconName, { size: 22 })}</div>
    <div class="empty-title">${D.esc(title)}</div><div class="empty-text">${D.esc(text)}</div>${extra}</div>`;
}

function pointRow(p) {
  return `<button class="moment-row tldr-row" data-tldr-t="${p.t}" title="Перемотать на ${fmtTime(p.t)}">
    <span class="tc tc-big">${icon("play", { size: 11 })}${fmtTime(p.t)}</span>
    <span class="tldr-row-text">${D.esc(p.x)}</span>
  </button>`;
}

function aboutCard(text, { live = false } = {}) {
  const body = text ? D.esc(text) : '<div class="skeleton"><i></i><i></i><i></i></div>';
  return `<div class="summary-text tldr-about${live ? " live" : ""}"><div class="summary-title">${icon("subtitles", { size: 14 })}О чём видео</div>${body}</div>`;
}

function pointsBlock(points) {
  if (!points.length) return "";
  // ширина под самый длинный таймкод: иконка, зазор и отступы ≈ 38px + цифры
  const longest = Math.max(...points.map((p) => fmtTime(p.t).length));
  return `<div class="subhead">Главное по ходу видео <span class="hint">нажмите — перемотка</span></div>
    <div class="tldr-points" style="--tc-w: calc(38px + ${longest}ch)">${points.map(pointRow).join("")}</div>`;
}

function fmtDate(ts) {
  try {
    return new Date(ts).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return "";
  }
}

function resultHtml(e) {
  const notes = [`Пересказ от ${fmtDate(e.updatedAt)} · по субтитрам видео`];
  if (e.trimmed) notes.push(`видео длинное — по сокращённой расшифровке (~${Math.round(e.trimmed * 100)}%)`);
  if (e.partsFailed) notes.push(`${e.partsFailed} ${plural(e.partsFailed, "часть не разобралась", "части не разобрались", "частей не разобрались")}`);
  return `<div class="history-note">${D.esc(notes.join(" · "))}</div>
    ${aboutCard(e.about || "")}
    ${pointsBlock(e.points || [])}
    <div class="summary-actions tldr-actions">
      <button class="ghost copy-btn" data-tldr="copy" title="Скопировать пересказ текстом">${icon("copy", { size: 14 })}Скопировать</button>
      <button class="ghost copy-btn" data-tldr="redo" title="Пересказать заново (потратит лимит Groq)">${icon("refresh", { size: 14 })}Пересказать заново</button>
    </div>`;
}

function runHtml(vid, run) {
  const parsed = parseTldr(run.live || "");
  return `<div class="tldr-run" data-run="${D.esc(vid)}">
      <div class="placeholder tldr-phase">${D.esc(run.phase)}</div>
      <div class="progress tldr-progress"><i style="width:${Math.round(run.frac * 100)}%"></i></div>
      <div class="analyze-actions tldr-cancel-row"><button class="link-btn" data-tldr="cancel">Отменить</button></div>
      <div class="tldr-live">${aboutCard(parsed.about, { live: true })}${pointsBlock(parsed.points)}</div>
    </div>`;
}

function errorHtml(err) {
  if (err.kind === "nosubs") {
    return emptyBlock(
      "subtitles",
      "У этого видео нет субтитров",
      err.music
        ? "В субтитрах только пометки вроде «[музыка]» — речи, которую можно пересказать, в видео нет."
        : "Пересказ строится по субтитрам, а у видео их нет — ни авторских, ни автоматических. Пересказать не из чего.",
      `<button class="ghost empty-cta wide" data-tldr="go">${icon("refresh", { size: 14 })}Проверить ещё раз</button>`
    );
  }
  const head = err.kind === "transcript" ? "Не получилось загрузить субтитры" : "Не получилось пересказать видео";
  const text =
    err.kind === "transcript"
      ? /timeout|network/.test(err.text)
        ? "YouTube не ответил — проверьте интернет и попробуйте ещё раз."
        : "YouTube не отдал субтитры. Обновите вкладку с видео (F5) и попробуйте ещё раз."
      : err.text;
  return `<div class="error-box"><b>${D.esc(head)}.</b><br>${D.esc(text)}</div>
    <button class="primary empty-cta wide" data-tldr="go">Попробовать ещё раз</button>`;
}

function ctaHtml() {
  if (!D.proxy.configured) {
    return emptyBlock(
      "subtitles",
      "Подключите сервер с ИИ",
      "Для пересказа нужен адрес сервера и секрет — они в настройках.",
      `<button class="primary empty-cta wide" data-tldr="settings">Открыть настройки</button>`
    );
  }
  return emptyBlock(
    "subtitles",
    "О чём это видео",
    "ИИ прочитает субтитры и коротко перескажет: суть в нескольких предложениях и главные пункты с таймкодами. Бесплатно; длинные видео — несколько минут.",
    `<button class="primary empty-cta wide" data-tldr="go">Пересказать видео</button>`
  );
}

function paint() {
  const box = $("tldr");
  if (!box || !viewVid) return;
  const run = runs.get(viewVid);
  let html;
  if (run) html = runHtml(viewVid, run);
  else if (errors.has(viewVid)) {
    // «Пересказать заново» не удалось — прежний пересказ остаётся под ошибкой
    const err = errors.get(viewVid);
    html = errorHtml(err) + (entry && err.kind !== "nosubs" ? `<div class="tldr-prev">${resultHtml(entry)}</div>` : "");
  } else if (entry) html = resultHtml(entry);
  else html = ctaHtml();
  box.innerHTML = html;
}

// Во время работы обновляем только изменившиеся части — без мигания и сброса анимаций.
function paintRun(vid) {
  const box = $("tldr");
  const run = runs.get(vid);
  const root = box?.querySelector(".tldr-run");
  if (!run || !root || root.dataset.run !== vid) return paint();
  root.querySelector(".tldr-phase").textContent = run.phase;
  root.querySelector(".tldr-progress i").style.width = `${Math.round(run.frac * 100)}%`;
  if (run.live) {
    const parsed = parseTldr(run.live);
    root.querySelector(".tldr-live").innerHTML = aboutCard(parsed.about, { live: true }) + pointsBlock(parsed.points);
  }
}

// ---------------- Подключение к панели ----------------

/** Вызывается при показе вкладки и при смене видео. */
export async function renderVideoTldr() {
  if (!D) return;
  const vid = D.getState().videoId;
  if (!vid) return;
  if (vid !== viewVid) {
    const seq = ++loadSeq;
    viewVid = vid;
    entry = null;
    paint(); // сразу пустая карточка, без пересказа прошлого видео
    const e = await loadTldr(vid);
    if (seq !== loadSeq || viewVid !== vid) return;
    entry = e;
  }
  paint();
}

export function initVideoTldr(deps) {
  D = deps;
  const box = $("tldr");
  if (!box) return;
  // пересказ, готовый в окне «О чём видео» на ленте (или в другой панели), —
  // сразу и здесь, без повторного запроса
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !viewVid || runs.has(viewVid)) return;
    const ch = changes[TLDR_CACHE_PREFIX + viewVid];
    if (!ch) return;
    entry = ch.newValue || null;
    if (entry) errors.delete(viewVid);
    paint();
  });
  box.addEventListener("click", async (ev) => {
    const row = ev.target.closest("[data-tldr-t]");
    if (row) {
      D.seekTo(Number(row.dataset.tldrT));
      return;
    }
    const act = ev.target.closest("[data-tldr]")?.dataset.tldr;
    if (!act || !viewVid) return;
    if (act === "go") void summarize(viewVid);
    else if (act === "redo") void summarize(viewVid);
    else if (act === "cancel") cancel(viewVid);
    else if (act === "settings") D.setTab("settings");
    else if (act === "copy" && entry) {
      try {
        await navigator.clipboard.writeText(tldrCopyText(entry, viewVid));
        D.showToast("Пересказ скопирован");
      } catch (e) {
        D.showToast("Не получилось скопировать");
      }
    }
  });
}
