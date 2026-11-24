import {
  GroqProxy,
  extractJson,
  clean,
  sanitizeFilename,
  sleep,
  normalizeSummary,
  createPacer,
  retryAfterMs,
  isOutputLimitError,
  isInputLimitError,
  isSizeLimitError,
  isRateLimitError,
} from "../groq.js";
import {
  CHUNK_ANALYZE_SYSTEM,
  chunkUser,
  FINAL_SYSTEM,
  finalUser,
  SEARCH_SYSTEM,
  searchUser,
  ASK_SYSTEM,
  askUser,
} from "../prompts.js";
import {
  splitTimecodes,
  timecodesOf,
  fmtTime,
  isQuestion,
  topWords,
  topMoments,
  commentStats,
  pickForBudget,
  mergeTopics,
  dedupeTexts,
  newSince,
} from "./insights.js";
import { DEFAULTS } from "../config.js";
import { icon, hydrateIcons } from "./icons.js";
import { renderSummaryCard } from "./card.js";
import { initSelfCheckUI } from "./selfcheck-ui.js";
import { initVideoTldr, renderVideoTldr } from "./video-tldr.js";

hydrateIcons();

const LOCAL_CONFIG =
  (typeof window !== "undefined" && window.__EXT_LOCAL_CONFIG__) || {};

const $ = (id) => document.getElementById(id);

// Ряды, которые листаются вбок (вкладки, чипы фильтров): колесо мыши листает
// их влево-вправо — как в «Моей библиотеке».
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
      if (el.scrollLeft !== before) e.preventDefault();
      return;
    }
  },
  { passive: false }
);

// Страница с видео на YouTube. Раньше регулярка требовала обязательный префикс
// www./m. и знала только /watch и /shorts — из-за этого валидная вкладка могла
// не найтись и панель молча показывала «видео не найдено».
const YT_VIDEO_RE = /^https:\/\/([a-z0-9-]+\.)*youtube\.com\/(watch|shorts|live)(\/|[?#]|$)/i;
// Наша «Моя библиотека» со встроенным плеером (…/library.html#w=ID) — тоже
// вкладка с видео: скрипты расширения работают в её плеере, как на YouTube.
const LIBRARY_PAGE = chrome.runtime.getURL("library/library.html");
const isVideoUrl = (url) => YT_VIDEO_RE.test(url || "") || (String(url || "").startsWith(LIBRARY_PAGE) && /[#&]w=[A-Za-z0-9_-]{11}/.test(url));

/* =======================================================================
   Диагностика: ставится СИНХРОННО, до любого await и до main().
   Смысл: если в шапке видно «vX.Y.Z» (версия из manifest.json) — модуль загрузился и мы внутри кода.
   Если шапки нет вовсе — браузер отдаёт старый/битый файл, и версии здесь ни при чём.
   Любая необработанная ошибка тоже рисуется в панель, а не теряется в консоли.
   ======================================================================= */
function renderDiag(text) {
  const out = $("diag-out");
  if (!out) return;
  out.classList.remove("hidden");
  out.textContent = text;
}

(async function markVersion() {
  try {
    const b = $("ver-badge");
    if (b) b.textContent = "v" + chrome.runtime.getManifest().version;
  } catch (e) {
    /* ignore */
  }
})();

async function collectDiagnostics() {
  const lines = [];
  const stamp = new Date().toLocaleTimeString();
  if (LAST_RAW_ERROR) {
    lines.push("последняя ошибка (сырой текст):");
    lines.push(LAST_RAW_ERROR.slice(0, 900));
    lines.push("");
  }
  let ver = "?";
  try {
    ver = chrome.runtime.getManifest().version;
  } catch (e) {
    lines.push("!! getManifest не работает: " + e.message);
  }
  lines.push(`версия расширения: ${ver}`);
  lines.push(`время: ${stamp}`);
  lines.push(`chrome.runtime.id: ${chrome.runtime.id || "нет"}`);
  lines.push("");

  let wins = [];
  try {
    wins = await chrome.windows.getAll({ populate: true });
    lines.push(`окна (${wins.length}):`);
    for (const w of wins) {
      const active = (w.tabs || []).find((t) => t.active);
      lines.push(
        `  #${w.id} тип=${w.type} фокус=${w.focused} вкладок=${(w.tabs || []).length}` +
          ` активная="${active ? active.url : "—"}"`
      );
    }
  } catch (e) {
    lines.push("!! windows.getAll: " + e.message);
  }

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
    lines.push("");
    lines.push(`вкладки (${tabs.length}):`);
    for (const t of tabs) {
      const u = t.url || "(url недоступен)";
      lines.push(`  #${t.id} w=${t.windowId} ${t.active ? "АКТ" : "   "} ${u.slice(0, 90)}`);
    }
  } catch (e) {
    lines.push("!! tabs.query: " + e.message);
  }

  lines.push("");
  const found = await findActiveVideoTab();
  lines.push(`findActiveVideoTab() -> ${found ? `#${found.id} ${found.url}` : "null"}`);
  lines.push(`YT-регексп: /^https:\\/\\/(www|m)\\.youtube\\.com\\/(watch|shorts)/`);
  lines.push("");

  if (found?.id) {
    try {
      const r = await chrome.tabs.sendMessage(found.id, { type: "yt:meta-query" });
      lines.push(`sendMessage -> ${JSON.stringify(r).slice(0, 300)}`);
    } catch (e) {
      lines.push("!! sendMessage не прошёл: " + e.message);
      lines.push("   (контент-скрипт мёртв — нужно F5 на вкладке видео)");
    }
  } else {
    lines.push("sendMessage -> пропущен: вкладка не найдена");
  }
  return lines.join("\n");
}

function bindDiagnostics() {
  $("btn-diag")?.addEventListener("click", async () => {
    // Повторное нажатие закрывает панель: renderDiag() всегда только открывал,
    // поэтому кнопка выглядела залипшей.
    const out = $("diag-out");
    if (out && !out.classList.contains("hidden")) {
      out.classList.add("hidden");
      out.textContent = "";
      return;
    }
    renderDiag("собираю диагностику…");
    try {
      renderDiag(await collectDiagnostics());
    } catch (e) {
      renderDiag("диагностика упала: " + (e?.message || e));
    }
  });
  $("btn-refresh-tab")?.addEventListener("click", async () => {
    await refreshFromActiveTab();
  });
}
bindDiagnostics();

window.addEventListener("error", (e) => {
  showFatal("Необработанная ошибка в панели.", e.message + " @ " + (e.filename || "") + ":" + e.lineno);
});
window.addEventListener("unhandledrejection", (e) => {
  showFatal("Ошибка в панели (promise).", e.reason?.message || String(e.reason));
});
// Анализ пачками. Лимиты Groq free на qwen/qwen3.8-27b (одна учётка на бота и расширение):
//   ITPM ~7000 входных токенов/мин, OTPM 1000 ВЫХОДНЫХ токенов/мин.
// OTPM жёстче: любой запрос с max_tokens > 1000 отклоняется целиком (429), поэтому
// max_tokens держим заметно ниже лимита, а выходные токены тоже учитываем в паузах.
// Вход части без учёта промпта. Крупнее часть — меньше раз повторяется
// системный промпт; 2400 + промпт укладываются в ~3 тыс., по 2 части в минуту.
const CHUNK_MAX_TOKENS = 2400;
const CHUNK_MAX_OUTPUT_TOKENS = 800; // < OTPM 1000, с запасом
const ITPM_BUDGET_PER_MIN = 6000; // < ~7000, с запасом: ключ общий с ботом
const OTPM_BUDGET_PER_MIN = 900; // фактический выход всех запросов за минуту
// минимальный перерыв между запросами — Groq не любит ОЧЕНЬ частые мелкие вызовы
const MIN_REQUEST_GAP_MS = 1500;

// грубая оценка «токенов» комментария для нарезки (1 токен ≈ 3 символа-ru,
// с запасом; лучше переоценить — меньше риска 413)
function tokensOf(text) {
  const t = String(text || "");
  return Math.ceil(t.length / 3);
}

// Сколько комментариев максимум отдаём ИИ за один анализ (самые залайканные).
const ANALYZE_MAX = 200;

// Индексы комментариев для анализа: все, если их немного; иначе самые
// залайканные, но в исходном порядке (так соседние по ветке остаются рядом).
function analysisPool(comments, max = ANALYZE_MAX) {
  const idx = comments.map((_, i) => i);
  if (idx.length <= max) return idx;
  return idx
    .sort((a, b) => (comments[b].likes || 0) - (comments[a].likes || 0) || a - b)
    .slice(0, max)
    .sort((a, b) => a - b);
}

function buildChunks(comments) {
  const chunks = [];
  let cur = [];
  let curTokens = 0;
  for (const c of comments) {
    // текст режется до 300 символов в chunkUser(); + «№|» и перевод строки
    const t = tokensOf(String(c.text || "").slice(0, 300)) + 4;
    if (cur.length && curTokens + t > CHUNK_MAX_TOKENS) {
      chunks.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(c);
    curTokens += t;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// Скользящий бюджет входных (ITPM) и выходных (OTPM) токенов — общий для анализа
// комментариев и «О видео» (логика — createPacer в groq.js).
const pacer = createPacer({
  itpm: ITPM_BUDGET_PER_MIN,
  otpm: OTPM_BUDGET_PER_MIN,
  gapMs: MIN_REQUEST_GAP_MS,
  maxOut: CHUNK_MAX_OUTPUT_TOKENS,
});
const paceRequest = (estIn, estOut = CHUNK_MAX_OUTPUT_TOKENS, onWait = null) => pacer.pace(estIn, estOut, onWait);
const settleOutput = (slot, text) => pacer.settle(slot, text);

function waitNote(prefix, el = $) {
  return (sec) => {
    el("summary-placeholder").textContent = `${prefix} Жду окно бесплатного лимита Groq: ~${sec} с…`;
  };
}

// После 429 по OTPM окно уже занято — отмечаем его в бюджете (см. createPacer).
const pushBudgetAfterOutputError = (waitMs) => pacer.pushAfterOutputError(waitMs);

// прикидка входных токенов запроса: системный промпт + юзер + накладные (roles/json)
function estimateRequestTokens(sysText, userText) {
  return tokensOf(sysText) + tokensOf(userText) + 120;
}

// Виды ошибок лимитов Groq (retryAfterMs, isOutputLimitError, isInputLimitError,
// isSizeLimitError, isRateLimitError) — в groq.js, общие с фоном.
function errorText(e) {
  return String(e?.message || e || "");
}

// Прежнее имя оставлено для совместимости: теперь это «любой лимит/429».
function isItpmError(e) {
  return isRateLimitError(e);
}

function isItpmOrServerError(e) {
  return isRateLimitError(e) || /Модель не ответила|502|таймаут|timeout/i.test(errorText(e));
}

let expandedTopic = null;

const state = {
  videoId: null,
  meta: null,
  comments: [],
  summary: null,
  activeTopic: null,
  // фильтр вкладки «Все»: all | popular | replies | questions | timecodes
  commentFilter: "all",
  commentQuery: "",
  commentLimit: 60,
  settings: null,
  analyzing: false,
};

const COMMENTS_PAGE = 60;

// Таймкоды дальше конца видео — скорее «10:30 утра», чем момент ролика.
// Расчёты обзора и моментов — один раз на набор комментариев: массив
// state.comments всегда заменяется целиком, поэтому ключ — сам массив.
const calcCache = new WeakMap();
function cached(name, fn) {
  let m = calcCache.get(state.comments);
  if (!m) calcCache.set(state.comments, (m = new Map()));
  const key = `${name}|${maxSec()}`;
  if (!m.has(key)) m.set(key, fn());
  return m.get(key);
}

// все моменты (до 40, по убыванию значимости); срезы — для обзора и экспорта
function allMoments() {
  return cached("moments", () => topMoments(state.comments, { maxSec: maxSec(), limit: 40 }));
}

function maxSec() {
  const d = Number(state.meta?.duration);
  return Number.isFinite(d) && d > 0 ? d + 2 : Infinity;
}

const proxy = new GroqProxy();

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Подсветка ищется по исходному тексту, а экранируется каждый кусок отдельно.
// Раньше регулярка шла по уже экранированному тексту, и запрос вроде «amp»
// или «quot» попадал внутрь &amp; / &quot; и ломал разметку.
// Слова запроса → регулярки. Слово от 4 букв ищется по основе: «лимба» находит
// и «лимбу», «лимбой», «крутой» — «крутые»; ё и е не различаются.
function queryParts(query) {
  const ee = (s) => s.replace(/[её]/g, "[её]");
  return String(query || "")
    .trim()
    .slice(0, 80)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      if (/^[а-яёa-z]{4,}$/.test(w)) {
        const stem = w.replace(/[аяоеёыиуюьйъ]{1,2}$/, "");
        if (stem.length >= 3 && stem !== w) return "(?<![а-яёa-z])" + ee(stem) + "[а-яёa-z]{0,4}";
      }
      return ee(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    });
}

// все слова запроса встречаются в тексте (в любом порядке и форме);
// parts — результат queryParts, регулярки собираются один раз на запрос
const partsRe = new WeakMap();
function matchesQuery(text, parts) {
  let res = partsRe.get(parts);
  if (!res) partsRe.set(parts, (res = parts.map((p) => new RegExp(p, "i"))));
  const t = String(text || "");
  return res.every((re) => re.test(t));
}

function hl(text, query) {
  const words = queryParts(query);
  if (!words.length) return esc(text);
  const re = new RegExp("(" + words.join("|") + ")", "gi");
  return String(text ?? "")
    .split(re)
    .map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)))
    .join("");
}

// Текст комментария: таймкоды становятся кнопками перемотки, остальное —
// экранированный текст с подсветкой запроса.
function richText(text, query) {
  return splitTimecodes(text, maxSec())
    .map((p) =>
      typeof p === "string"
        ? hl(p, query)
        : `<button class="tc" data-t="${p.t}" title="Перемотать видео на ${esc(p.label)}">${esc(p.label)}</button>`
    )
    .join("");
}

// Единая карточка комментария (раньше было 4 копии разметки с расхождениями).
function commentCard(c, { query = "", compact = false, reply = false } = {}) {
  const likes = Number(c.likes) || 0;
  // Кнопка ответов — только если YouTube дал токен ветки (ответы грузятся по клику).
  // В компактных карточках (сводка, моменты) ответы не раскрываем — там
  // важна краткость; ветки — во «Все», «Темах» и «Поиске».
  const canReplies = !reply && !compact && c.replies > 0 && c.replyToken && c.id;
  const repliesUi =
    canReplies
      ? `<div class="c-replies">
          <button class="reply-toggle" data-cid="${esc(c.id)}">${icon("reply", { size: 13 })}<span>Ответы · ${fmtNum(c.replies)}</span></button>
          <div class="collapse"><div class="collapse-inner"></div></div>
        </div>`
      : "";
  return `<article class="comment-card${compact ? " compact" : ""}${reply ? " reply" : ""}"${c.id ? ` data-cid="${esc(c.id)}"` : ""}>
    ${
      compact
        ? ""
        : `<span class="avatar-wrap" data-letter="${esc((c.author || "?").replace(/^@/, "").charAt(0).toUpperCase())}">${
            c.avatar ? `<img class="avatar" src="${esc(c.avatar)}" alt="" loading="lazy" />` : ""
          }</span>`
    }
    <div class="c-body">
      <div class="c-meta">
        <span class="c-author" title="${esc(c.author)}">${esc(c.author)}</span>
        ${c.isCreator ? '<span class="badge" title="Комментарий автора канала">автор</span>' : ""}
        ${state.newIds?.has(c.id) ? '<span class="badge badge-new" title="Появился после прошлой сводки">новый</span>' : ""}
        ${c.time ? `<span class="c-time">${esc(c.time)}</span>` : ""}
        ${likes ? `<span class="c-stat" title="Лайки">${icon("heart", { size: 12 })}${fmtNum(likes)}</span>` : ""}
        ${c.replies && !canReplies ? `<span class="c-stat" title="Ответов в ветке">${icon("reply", { size: 12 })}${fmtNum(c.replies)}</span>` : ""}
        ${c.hearted ? `<span class="c-heart" title="Автору канала понравилось">${icon("heart", { size: 12 })}</span>` : ""}
        ${c.link ? `<a class="c-link" href="${esc(c.link)}" target="_blank" rel="noreferrer" title="Открыть комментарий на YouTube" aria-label="Открыть на YouTube">${icon("external", { size: 13 })}</a>` : ""}
      </div>
      <div class="c-text${compact ? "" : " clamp"}">${richText(c.text, query)}</div>
      ${compact ? "" : '<button class="more-text" hidden>Показать полностью</button>'}
      ${repliesUi}
    </div>
  </article>`;
}

// Длинные комментарии свёрнуты до 6 строк (CSS). Кнопку «Показать полностью»
// показываем только там, где текст реально не влез — меряем после отрисовки,
// а не по числу символов (в узкой панели и 250 символов — это 9 строк).
let clampTimer = null;
function fitClamps() {
  clearTimeout(clampTimer);
  clampTimer = setTimeout(() => {
    for (const el of document.querySelectorAll("#content .c-text.clamp:not([data-fit])")) {
      if (!el.offsetParent) continue; // в скрытой вкладке — посчитаем, когда откроют
      el.dataset.fit = "1";
      const btn = el.nextElementSibling;
      // найденное слово спрятано под обрезкой — раскрываем текст целиком,
      // иначе непонятно, почему комментарий попал в результаты
      const mark = el.querySelector("mark");
      const hiddenHit = mark && mark.getBoundingClientRect().bottom > el.getBoundingClientRect().bottom + 2;
      if (el.scrollHeight > el.clientHeight + 2 && !hiddenHit) {
        if (btn?.classList.contains("more-text")) btn.hidden = false;
      } else {
        el.classList.remove("clamp");
      }
    }
  }, 0);
}
new MutationObserver(fitClamps).observe(document.getElementById("content"), { childList: true, subtree: true });

// ---------------- Сервер: пробуждение заранее ----------------
// Бесплатный Render засыпает после ~15 минут простоя, и первый запрос ждёт
// до минуты. Будим сервер тихим запросом к /healthz сразу при открытии
// панели — пока человек смотрит обзор, сервер успевает проснуться.
const server = { status: "unknown", slow: false, checkedAt: 0 };

async function wakeServer() {
  const base = String(state.settings?.baseUrl || "").replace(/\/+$/, "");
  if (!base || !proxy.configured) return renderServerHint();
  if (server.status === "waking") return;
  if (server.status === "ok" && Date.now() - server.checkedAt < 5 * 60 * 1000) return;
  server.status = "waking";
  server.slow = false;
  const slowTimer = setTimeout(() => {
    if (server.status !== "waking") return;
    server.slow = true;
    renderServerHint();
  }, 2500);
  const ctrl = new AbortController();
  const abortTimer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const r = await fetch(`${base}/healthz`, { cache: "no-store", signal: ctrl.signal });
    server.status = r.ok ? "ok" : "down";
  } catch (e) {
    server.status = "down";
  } finally {
    clearTimeout(slowTimer);
    clearTimeout(abortTimer);
  }
  const wasSlow = server.slow;
  server.slow = false;
  server.checkedAt = Date.now();
  renderServerHint(wasSlow);
}

function renderServerHint(justWoke = false) {
  const el = $("server-hint");
  if (!el) return;
  let html = "";
  let cls = "";
  if (!proxy.configured) {
    html = "";
  } else if (server.status === "waking" && server.slow) {
    html = `<span class="dot pulse"></span>Сервер просыпается после простоя — обычно до минуты. Обзор ниже уже готов.`;
  } else if (server.status === "ok" && justWoke) {
    html = `${icon("check", { size: 13 })}Сервер готов`;
    cls = "ok";
  } else if (server.status === "down") {
    html = `Сервер не отвечает. Проверьте адрес в настройках или попробуйте позже.`;
    cls = "err";
  }
  el.className = `server-hint ${cls}`.trim();
  el.innerHTML = html;
  el.classList.toggle("hidden", !html);
  // «Сервер готов» — короткое подтверждение, потом тихо исчезает
  clearTimeout(renderServerHint.timer);
  if (cls === "ok") {
    renderServerHint.timer = setTimeout(() => {
      el.classList.add("fade-out");
      setTimeout(() => el.classList.add("hidden"), 300);
    }, 4000);
  }
}

// ---------------- Ответы в ветках ----------------
// Грузятся по клику через контент-скрипт вкладки с видео (те же запросы, что
// делает сам YouTube при «Показать ответы»), кэшируются на время сессии.
const repliesCache = new Map(); // cid -> { items, next }

function commentById(cid) {
  return state.comments.find((c) => c.id === cid) || null;
}

async function fetchRepliesPage(token) {
  const tab = await findActiveVideoTab();
  if (!tab?.id) throw new Error("не нашёл вкладку с видео");
  const r = await chrome.tabs.sendMessage(tab.id, { type: "yt:replies", token });
  if (!r?.ok) throw new Error(r?.error || "YouTube не отдал ответы");
  return { items: r.replies || [], next: r.next || null };
}

function repliesHtml(cid) {
  const entry = repliesCache.get(cid);
  if (!entry) return "";
  const list = entry.items.length
    ? entry.items.map((c) => commentCard(c, { reply: true })).join("")
    : '<div class="hint">Ответов не нашлось — возможно, их скрыли.</div>';
  const more = entry.next
    ? `<button class="more-replies" data-cid="${esc(cid)}">${icon("chevron", { size: 13 })}<span>Ещё ответы</span></button>`
    : "";
  return `<div class="replies-list">${list}${more}</div>`;
}

async function toggleReplies(btn) {
  const box = btn.closest(".c-replies");
  const cid = btn.dataset.cid;
  const label = btn.querySelector("span");
  const c = commentById(cid);
  const idle = `Ответы · ${fmtNum(c?.replies || 0)}`;
  if (box.classList.contains("open")) {
    box.classList.remove("open");
    label.textContent = idle;
    return;
  }
  const inner = box.querySelector(".collapse-inner");
  if (!inner.dataset.filled) {
    if (!repliesCache.has(cid)) {
      if (!c?.replyToken) return;
      btn.classList.add("loading");
      label.textContent = "Загружаю ответы…";
      try {
        repliesCache.set(cid, await fetchRepliesPage(c.replyToken));
      } catch (e) {
        label.textContent = idle;
        showToast("Не удалось загрузить ответы: " + (e.message || e));
        return;
      } finally {
        btn.classList.remove("loading");
      }
    }
    inner.innerHTML = repliesHtml(cid);
    inner.dataset.filled = "1";
  }
  // принудительный пересчёт раскладки: переход стартует от нулевой высоты плавно
  // (rAF не годится — в фоновой панели он не срабатывает, и ветка не открывалась)
  void box.offsetHeight;
  box.classList.add("open");
  label.textContent = "Скрыть ответы";
}

async function loadMoreReplies(btn) {
  const cid = btn.dataset.cid;
  const entry = repliesCache.get(cid);
  if (!entry?.next) return;
  btn.disabled = true;
  btn.querySelector("span").textContent = "Загружаю…";
  try {
    const page = await fetchRepliesPage(entry.next);
    entry.items.push(...page.items);
    entry.next = page.next;
    const inner = btn.closest(".collapse-inner");
    inner.innerHTML = repliesHtml(cid);
  } catch (e) {
    btn.disabled = false;
    btn.querySelector("span").textContent = "Ещё ответы";
    showToast("Не удалось загрузить ответы: " + (e.message || e));
  }
}

// CSP расширений (MV3) запрещает inline-обработчики вроде onerror="…" в разметке,
// поэтому битые аватарки прячем одним перехватчиком: error не всплывает,
// но ловится на фазе захвата.
document.addEventListener(
  "error",
  (e) => {
    const t = e.target;
    if (t instanceof HTMLImageElement && t.classList.contains("avatar")) t.style.visibility = "hidden";
  },
  true
);

// 950 → «950», 1240 → «1 240», 22000 → «22 тыс.», 163900 → «164 тыс.», 2100000 → «2,1 млн»
function fmtNum(n) {
  n = Number(n) || 0;
  const short = (v, unit) => `${(v >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toLocaleString("ru-RU")} ${unit}`;
  if (n >= 1e6) return short(n / 1e6, "млн");
  if (n >= 1e4) return short(n / 1e3, "тыс.");
  return n.toLocaleString("ru-RU");
}

let LAST_RAW_ERROR = "";

function friendlyError(e) {
  const s = errorText(e);
  LAST_RAW_ERROR = s;
  // Порядок важен: сначала выходной лимит — он самый частый, а раньше его
  // подменяли текстом про входные токены.
  if (isOutputLimitError(e)) {
    const wait = retryAfterMs(e, 0);
    const tail = wait ? ` Groq велит подождать ~${Math.round(wait / 1000)} с.` : "";
    return `Groq не принял запрос: превышен лимит ВЫХОДНЫХ токенов (OTPM на free-тарифе — ~1000 ток/мин на всю учётку, бот и расширение делят один ключ).${tail} Расширение подождёт и попробует снова; можно и просто запустить анализ ещё раз.`;
  }
  if (isSizeLimitError(e)) {
    return "Запрос не влезает в контекст модели — это НЕ лимит токенов в минуту, ждать нечего. Уменьшите «Максимум комментариев» в настройках или запустите анализ на меньшем объёме.";
  }
  if (isInputLimitError(e)) {
    return "Groq не принял запрос: превышен лимит ВХОДНЫХ токенов (ITPM на free-тарифе, ~7000 ток/мин на всю учётку — бот и расширение делят один ключ). Расширение ждёт окно и режет комментарии на части автоматически — просто запустите анализ ещё раз.";
  }
  if (/Модель не ответила/.test(s)) {
    return "Модель Groq не ответила (временный сбой или лимит). Запустите анализ ещё раз — обычно со второй попытки проходит.";
  }
  if (/таймаут|timeout|Сервер недоступен|Failed to fetch|fetch failed/i.test(s)) {
    return "Не удалось связаться с сервером: возможно, Render спит (холодный старт ~50 сек) или нет связи с интернетом. Нажмите «Проверить связь» в настройках и попробуйте ещё раз.";
  }
  if (/403|Отказано прокси|forbidden/i.test(s)) {
    return "Прокси-сервер отклонил запрос: проверьте правильность URL, секрета и то, что сервер обновлён (Render деплоит из GitHub автоматически).";
  }
  if (/400|413/.test(s)) {
    return "Запрос слишком большой или отклонён прокси: попробуйте уменьшить «Максимум комментариев» в настройках.";
  }
  return s || "Неизвестная ошибка";
}

// ---------------- Настройки ----------------

async function loadSettings() {
  const obj = await chrome.storage.local.get("settings");
  state.settings = Object.assign(
    {
      baseUrl: LOCAL_CONFIG.baseUrl || DEFAULTS.baseUrl,
      token: LOCAL_CONFIG.token || "",
      model: LOCAL_CONFIG.model || DEFAULTS.model,
      maxComments: DEFAULTS.maxComments,
      lang: DEFAULTS.lang,
      collectMode: DEFAULTS.collectMode,
      thumbTemplate: DEFAULTS.thumbTemplate,
      theme: "auto", // как в системе
    },
    obj.settings || {}
  );
  // пустое поле не отменяет секрет и адрес из local-config.js (как в фоне — bot-settings.js)
  if (!state.settings.token) state.settings.token = LOCAL_CONFIG.token || "";
  if (!state.settings.baseUrl) state.settings.baseUrl = LOCAL_CONFIG.baseUrl || DEFAULTS.baseUrl;
  applyTheme();
}

// при теме «как в системе» следим за переключением темы ОС на лету
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if ((state.settings?.theme || "auto") === "auto") applyTheme();
});

function applyTheme() {
  const t = state.settings?.theme || "auto";
  let dark = true;
  if (t === "light") dark = false;
  else if (t === "auto") dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  // тема и на <html>: при изменении ширины панели Chrome заливает новые
  // полосы фоном корневого элемента — он должен совпадать с фоном панели
  document.documentElement.dataset.theme = document.body.dataset.theme = dark ? "dark" : "light";
  // для theme-boot.js: следующее открытие панели сразу в нужной теме
  try {
    localStorage.setItem("ytcs:theme", dark ? "dark" : "light");
  } catch (e) {
    /* не критично */
  }
}

function fillSettingsFields() {
  $("set-base-url").value = state.settings.baseUrl || DEFAULTS.baseUrl;
  $("set-token").value = state.settings.token || "";
  $("set-model").value = state.settings.model || DEFAULTS.model;
  $("set-max").value = state.settings.maxComments;
  $("set-lang").value = state.settings.lang || "ru";
  $("set-theme").value = state.settings.theme || "auto";
  $("set-mode").value = state.settings.collectMode || "auto";
  $("set-thumb-template").value = state.settings.thumbTemplate || "";
  $("set-order").value = state.settings.commentOrder === "new" ? "new" : "top";
  $("set-no-autoplay").checked = Boolean(state.settings.noAutoplay);
  $("set-hide-progress").checked = Boolean(state.settings.hideProgress);
  $("quick-max").value = state.settings.maxComments;
}

function readSettingsFromFields() {
  state.settings.baseUrl = normalizeBaseUrl($("set-base-url").value) || DEFAULTS.baseUrl;
  // пока в поле печатают, его не переписываем (иначе курсор прыгнет); приведём к виду при уходе из поля
  if (document.activeElement !== $("set-base-url")) $("set-base-url").value = state.settings.baseUrl;
  state.settings.token = $("set-token").value.trim();
  state.settings.model = $("set-model").value.trim() || DEFAULTS.model;
  state.settings.maxComments = Math.min(2000, Math.max(10, parseInt($("set-max").value, 10) || DEFAULTS.maxComments));
  state.settings.lang = $("set-lang").value;
  state.settings.theme = $("set-theme").value;
  state.settings.collectMode = $("set-mode").value;
  state.settings.thumbTemplate = $("set-thumb-template").value.trim() || "{title} - {channel}";
  state.settings.commentOrder = $("set-order").value;
  state.settings.noAutoplay = $("set-no-autoplay").checked;
  state.settings.hideProgress = $("set-hide-progress").checked;
  $("quick-max").value = state.settings.maxComments;
}

// Адрес сервера: без схемы — https://, без хвоста /api/chat и слэшей.
function normalizeBaseUrl(raw) {
  let url = String(raw || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  url = url.replace(/\/+(api\/chat\/?)?$/i, "");
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? url : "";
  } catch (e) {
    return "";
  }
}

// Расширению разрешены только адреса из host_permissions манифеста.
function serverAllowed(url) {
  try {
    const u = new URL(url);
    return /(^|\.)onrender\.com$/i.test(u.hostname) || (u.hostname === "localhost" && u.port === "8080");
  } catch (e) {
    return false;
  }
}

let autoTimer = 0;
let savedTimer = 0;
function scheduleAutoSave(delay = 600) {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    autoTimer = 0;
    void saveSettings(true);
  }, delay);
}
function flushAutoSave() {
  if (!autoTimer) return;
  clearTimeout(autoTimer);
  autoTimer = 0;
  void saveSettings(true);
}

async function saveSettings(showFeedback = true) {
  readSettingsFromFields();
  applyTheme();
  await chrome.storage.local.set({ settings: state.settings });
  const serverChanged = proxy.baseUrl !== state.settings.baseUrl || proxy.token !== state.settings.token;
  proxy.baseUrl = state.settings.baseUrl;
  proxy.token = state.settings.token;
  proxy.model = state.settings.model;
  if (serverChanged) {
    // будим сервер, только если сменился адрес или пароль, а не на каждое сохранение
    server.checkedAt = 0;
    if (server.status !== "waking") server.status = "unknown";
    void wakeServer();
  }
  if (showFeedback) {
    const el = $("settings-status");
    clearTimeout(savedTimer);
    if (!serverAllowed(state.settings.baseUrl)) {
      el.textContent = "Адрес не разрешён: нужен *.onrender.com";
      el.className = "settings-saved err";
      return;
    }
    el.textContent = "Сохранено";
    el.className = "settings-saved ok";
    savedTimer = setTimeout(() => {
      el.textContent = "Сохраняется автоматически";
      el.className = "settings-saved";
    }, 1800);
  }
}

// ---------------- Загрузка состояния ----------------

const ORDER_KEY = "svc:order";
// Запись в session с вытеснением старых видео при переполнении квоты (10 МБ):
// комментарии всех просмотренных видео накапливаются, пока браузер открыт,
// поэтому при Resource::kQuotaBytes удаляем кэш совсем старых видео (кроме активного).
async function safeSessionSet(patch, { keepVideoId = null } = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await chrome.storage.session.set(patch);
      return;
    } catch (e) {
      if (!/quota|QuotaBytes/i.test(String(e?.message || e))) throw e;
      let order;
      try {
        const o = await chrome.storage.session.get(ORDER_KEY);
        order = Array.isArray(o[ORDER_KEY]) ? o[ORDER_KEY].slice() : [];
      } catch (er) {
        order = [];
      }
      const victims = order.filter((v) => v !== keepVideoId);
      if (!victims.length) {
        try {
          const all = await chrome.storage.session.get(null);
          const stale = Object.keys(all)
            .filter((k) => /^(comments|collect|meta):/i.test(k))
            .filter((k) => !keepVideoId || !k.endsWith(":" + keepVideoId));
          if (stale.length) await chrome.storage.session.remove(stale);
        } catch (er) {
          /* partial */
        }
        break;
      }
      const victim = victims[victims.length - 1];
      const keys = ["comments:", "collect:", "meta:", "summary:"].map((p) => p + victim);
      try {
        await chrome.storage.session.remove(keys);
        order = order.filter((v) => v !== victim);
        await chrome.storage.session.set({ [ORDER_KEY]: order.slice(0, 30) });
      } catch (er) {
        break;
      }
    }
  }
}
// ---------------- История сводок (storage.local, переживает перезапуск) ----------------
// storage.session живёт до закрытия браузера; сводка — самое дорогое по токенам
// Groq, поэтому готовые сводки храним в local и показываем сразу при повторном
// открытии видео. Темы ссылаются на комментарии по их id, а не по индексу:
// после пересбора порядок комментариев может отличаться.
const HIST_PREFIX = "hist:";
const HIST_INDEX = "hist:index";
const HIST_MAX = 60;

// Темы в сохранённой сводке ссылаются на комментарии по id, а не по номеру:
// после пересбора порядок комментариев меняется (и в сессии, и в истории).
// индексы → id комментариев и обратно (для хранения: набор мог пересобраться)
const SENT_KINDS = ["positive", "neutral", "negative"];

function packSummary(summary, comments) {
  const sentimentCids = summary.sentimentCids || {};
  if (summary.sentimentIds) {
    for (const k of SENT_KINDS) sentimentCids[k] = (summary.sentimentIds[k] || []).map((i) => comments[i]?.id).filter(Boolean);
  }
  const { sentimentIds, ...rest } = summary;
  return {
    ...rest,
    sentimentCids,
    topics: (summary.topics || []).map((t) => ({
      name: t.name,
      count: t.count,
      cids: t.cids || (t.ids || []).map((i) => comments[i]?.id).filter(Boolean),
    })),
  };
}

function unpackSummary(entry, comments) {
  if (!entry) return null;
  const pos = new Map(comments.map((c, i) => [c.id, i]));
  const sentimentIds = {};
  for (const k of SENT_KINDS) {
    sentimentIds[k] = (entry.sentimentCids?.[k] || []).map((id) => pos.get(id)).filter((i) => i !== undefined);
  }
  return {
    ...entry,
    sentimentIds,
    // сводка из версии, которая ещё не отмечала примеры по тональности
    sentimentLegacy: !entry.sentimentCids,
    topics: (entry.topics || []).map((t) => ({
      name: t.name,
      count: t.count,
      ids: t.cids ? t.cids.map((id) => pos.get(id)).filter((i) => i !== undefined) : t.ids || [],
    })),
  };
}

async function saveHistory(videoId, summary, comments, meta) {
  try {
    const entry = {
      ...packSummary(summary, comments),
      commentCount: summary.commentCount || comments.length,
      // id собранных комментариев — чтобы в следующий раз показать новые
      seenIds: comments.slice(0, 1000).map((c) => c.id).filter(Boolean),
      title: meta?.title || "",
      savedAt: Date.now(),
    };
    const idx = (await chrome.storage.local.get(HIST_INDEX))[HIST_INDEX] || [];
    const next = [videoId, ...idx.filter((v) => v !== videoId)];
    const evicted = next.slice(HIST_MAX);
    await chrome.storage.local.set({ [HIST_PREFIX + videoId]: entry, [HIST_INDEX]: next.slice(0, HIST_MAX) });
    if (evicted.length) await chrome.storage.local.remove(evicted.map((v) => HIST_PREFIX + v));
  } catch (e) {
    console.warn("history save:", e);
  }
}

async function loadHistory(videoId, comments) {
  let entry;
  try {
    entry = (await chrome.storage.local.get(HIST_PREFIX + videoId))[HIST_PREFIX + videoId];
  } catch (e) {
    return null;
  }
  if (!entry) return null;
  return { ...unpackSummary(entry, comments), fromHistory: true };
}

// Список «Недавние сводки» в настройках: клик открывает видео, а панель
// сразу покажет сохранённую сводку.
async function renderHistoryList() {
  const box = $("history-list");
  let entries = [];
  try {
    const idx = (await chrome.storage.local.get(HIST_INDEX))[HIST_INDEX] || [];
    const all = await chrome.storage.local.get(idx.map((v) => HIST_PREFIX + v));
    entries = idx.map((v) => ({ id: v, ...(all[HIST_PREFIX + v] || {}) })).filter((e) => e.summary);
  } catch (e) {
    /* нет доступа к хранилищу — просто пустой список */
  }
  if (!entries.length) {
    box.innerHTML = '<div class="hint">Пока пусто — сводки появятся здесь после анализа.</div>';
    return;
  }
  box.innerHTML = entries
    .map(
      (e) => `<a class="history-item${e.id === state.videoId ? " current" : ""}" href="https://www.youtube.com/watch?v=${esc(e.id)}" target="_blank" rel="noreferrer">
        <img src="https://i.ytimg.com/vi/${esc(e.id)}/default.jpg" alt="" loading="lazy" />
        <span class="hi-body">
          <span class="hi-title">${esc(e.title || (e.id === state.videoId && state.meta?.title) || `Видео ${e.id}`)}</span>
          <span class="hint">${fmtDate(e.updatedAt || e.savedAt)}${e.commentCount ? ` · ${fmtNum(e.commentCount)} комм.` : ""}</span>
        </span>
      </a>`
    )
    .join("");
}

async function clearHistory() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(HIST_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.filter((k) => k !== HIST_INDEX).length;
}

// Номер вызова loadFor: если пока ждали хранилище, начали грузить другое
// видео, старый вызов тихо выходит и не пишет своё в панель.
let loadSeq = 0;

async function loadFor(videoId) {
  if (!videoId) return;
  const seq = ++loadSeq;
  const obj = await chrome.storage.session.get([
    `meta:${videoId}`,
    `comments:${videoId}`,
    `summary:${videoId}`,
    `collect:${videoId}`,
  ]);
  if (seq !== loadSeq) return;
  const switched = state.videoId !== videoId;
  // Открыли другое видео посреди анализа — анализ прошлого прерываем
  // (его сводка, если успеет, всё равно сохранится в историю своего видео).
  if (switched && state.analyzing) detachAnalysis();
  state.videoId = videoId;
  state.meta = obj[`meta:${videoId}`] || (switched ? null : state.meta);
  state.comments = obj[`comments:${videoId}`] || [];
  const comments = state.comments;
  const summary = unpackSummary(obj[`summary:${videoId}`], comments) || (await loadHistory(videoId, comments));
  if (seq !== loadSeq) return;
  state.summary = summary;
  state.newIds = state.summary?.fromHistory
    ? newSince(state.comments, state.summary.seenIds, state.summary.updatedAt || state.summary.savedAt)
    : new Set();
  if (!state.newIds.size && state.commentFilter === "new") state.commentFilter = "all";
  if (switched) {
    state.activeTopic = null;
    state.commentLimit = COMMENTS_PAGE;
    state.momentsAll = false;
    sentimentOpen = null;
    expandedTopic = null;
    globalSearchResults = [];
  }
  renderHeader();
  renderBottomMatters();
  if (switched) void renderVideoTldr();
  const st = obj[`collect:${videoId}`];
  updateCollectStatus(st?.status, st?.fetched, st?.max, st?.error || null, st?.stopped);
  // loadFor зовётся и на каждый фокус панели: перерисовываем, только если
  // данные реально изменились — иначе анимации проигрывались заново, а
  // раскрытые блоки схлопывались от простого клика по окну.
  const sig = [
    videoId,
    state.comments.length,
    state.comments[0]?.id,
    state.comments[state.comments.length - 1]?.id,
    state.summary?.updatedAt,
    state.meta?.duration,
  ].join("|");
  if (sig === lastRenderSig && !switched) return;
  lastRenderSig = sig;
  renderAll();
}

let lastRenderSig = "";

function renderAll() {
  renderSummary();
  renderInsights();
  renderMoments();
  renderTopics();
  renderComments();
  renderSearchResults();
}

function renderBottomMatters() {
  $("empty-state").classList.toggle("hidden", Boolean(state.videoId));
  $("empty-actions").classList.toggle("hidden", Boolean(state.videoId));
  $("video-header").classList.toggle("hidden", !state.videoId);
  $("collect-bar").classList.toggle("hidden", !state.videoId);
  $("status-row").classList.toggle("hidden", !state.videoId);
  $("tabs").classList.remove("hidden");
  // Без видео остаются только настройки (вкладки данных прячет CSS по этому классу).
  $("app").classList.toggle("no-video", !state.videoId);
  requestAnimationFrame(moveTabInk);
  if (!state.videoId) return;
  $("btn-analyze").disabled = state.analyzing || state.collect?.status === "loading";
}

function renderHeader() {
  const m = state.meta;
  if (!m) return;
  $("video-title").textContent = m.title || "";
  $("channel-name").textContent = m.channelName || "—";
  $("channel-subs").textContent = m.channelSubs || "";
  const cu = m.channelUrl || "";
  $("channel-name").href = cu
    ? /^https?:\/\//i.test(cu)
      ? cu
      : "https://www.youtube.com" + cu
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(m.channelName || "")}`;
  const avatar = $("channel-avatar");
  avatar.src = m.channelAvatar || "";
  avatar.hidden = !m.channelAvatar; // без аватарки не оставляем пустое место
  avatar.onerror = () => (avatar.style.visibility = "hidden");
  const thumb = $("thumbnail");
  const nextThumb = () => {
    if (thumb.src.includes("maxresdefault")) thumb.src = m.thumbs.sd || m.thumbs.hq;
    else if (thumb.src.includes("sddefault")) thumb.src = m.thumbs.hq;
  };
  thumb.onerror = nextThumb;
  // Нет maxres → YouTube отдаёт серую заглушку 120×90 как «успешную» картинку.
  thumb.onload = () => {
    if (thumb.naturalWidth <= 120) nextThumb();
  };
  if (m.thumbs?.maxres) thumb.src = m.thumbs.maxres;
  else if (m.thumbs?.sd) thumb.src = m.thumbs.sd;
  else if (m.thumbs?.hq) thumb.src = m.thumbs.hq;
}

// Индикатор активной вкладки плавно переезжает под нужную кнопку.
function moveTabInk() {
  const ink = document.querySelector(".tab-ink");
  const active = document.querySelector(".tab.active");
  if (!ink || !active || !active.offsetWidth) {
    if (ink) ink.style.opacity = "0";
    return;
  }
  // вкладки растянуты на всю ширину — полоска по ширине надписи, а не кнопки
  const range = document.createRange();
  range.selectNodeContents(active);
  const box = range.getBoundingClientRect();
  const bar = active.parentElement;
  const left = box.left - bar.getBoundingClientRect().left + bar.scrollLeft;
  ink.style.opacity = "1";
  ink.style.width = `${Math.round(box.width)}px`;
  ink.style.transform = `translateX(${Math.round(left)}px)`;
}
// при изменении ширины панели полоска едет вместе с вкладками, без запаздывания
let inkResizeTimer = 0;
window.addEventListener("resize", () => {
  const ink = document.querySelector(".tab-ink");
  if (ink) ink.style.transition = "none";
  moveTabInk();
  clearTimeout(inkResizeTimer);
  inkResizeTimer = setTimeout(() => ink && (ink.style.transition = ""), 150);
});

function setProgress(id, frac) {
  const el = $(id);
  if (frac == null) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  el.firstElementChild.style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
}

function updateCollectStatus(status, fetched, max, error, stopped = null) {
  state.collect = { status, fetched, max, error, stopped };
  const el = $("collect-status");
  el.classList.toggle("err", status === "error");
  if (status === "loading") {
    el.textContent = `Собираю: ${fetched || 0} из ${max || "…"}`;
    setProgress("collect-progress", max ? (fetched || 0) / max : 0.05);
  } else if (status === "done") {
    // max — лимит, с которым собирали. Если лимит с тех пор поменяли, подсказываем
    // пересобрать (иначе «лимит 120» рядом с «собрано 300» сбивает с толку).
    const lim = Number(state.settings?.maxComments) || 0;
    const used = Number(max) || 0;
    const changed = lim && used && lim !== used && (lim < (fetched || 0) || (fetched || 0) >= used);
    // сбор прервался (сбой страницы или отмена), но собранное сохранено
    const note = stopped
      ? `${stopped === "cancelled" ? "сбор остановлен" : "сбор прервался"} — <button class="link-btn" data-restart>собрать заново</button>`
      : changed
        ? `лимит изменён — <button class="link-btn" data-restart>соберите заново</button>`
        : "";
    el.innerHTML =
      `${icon("check", { size: 13 })} Собрано ${fetched || 0}${stopped && max ? ` из ${max}` : ""}` +
      (note ? ` <span class="status-note"><span class="sep">· </span>${note}</span>` : "");
    el.querySelector("[data-restart]")?.addEventListener("click", () => $("btn-restart").click());
    el.title = `Собрано комментариев: ${fetched || 0}`;
    setProgress("collect-progress", null);
  } else if (status === "error") {
    el.textContent = humanCollectError(error);
    el.title = error || "";
    setProgress("collect-progress", null);
  } else {
    el.textContent = "";
    setProgress("collect-progress", null);
  }
  renderAnalyzeLabel();
  // пустые вкладки зависят от статуса сбора (идёт / ошибка / комментариев нет)
  if (!state.comments.length && state.videoId) {
    renderSummary();
    renderComments();
    renderSearchResults();
  }
}

// Технические коды ошибок сбора из content.js → понятный текст.
function humanCollectError(error) {
  const e = String(error || "");
  if (/innerTubeBlocked/.test(e)) return "YouTube временно не отдаёт комментарии — попробуйте «Собрать заново» чуть позже";
  if (/innerTubeNoCommentsSection/.test(e)) return "Комментарии к видео отключены или не найдены";
  if (/innerTubeTimeout|innerTubeNetwork/.test(e)) return "Нет ответа от YouTube — проверьте сеть и нажмите «Собрать заново»";
  return "Не удалось собрать комментарии — нажмите «Собрать заново»";
}

// ---------------- Вкладки ----------------

const TAB_ORDER = ["summary", "video", "moments", "topics", "search", "comments", "settings"];
let currentTab = "summary";

function setTab(name) {
  // направление перехода для анимации: правее → въезд справа, левее → слева
  const dir = Math.sign(TAB_ORDER.indexOf(name) - TAB_ORDER.indexOf(currentTab));
  document.documentElement.style.setProperty("--dir", String(dir));
  document.documentElement.style.setProperty("--dir-abs", String(Math.abs(dir)));
  currentTab = name;
  document.querySelectorAll(".tab[data-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
    b.setAttribute("aria-selected", String(b.dataset.tab === name));
    b.tabIndex = b.dataset.tab === name || (name === "settings" && b.dataset.tab === "summary") ? 0 : -1;
  });
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $("view-" + name).classList.add("active");
  $("app").classList.toggle("on-settings", name === "settings");
  fitClamps();
  $("btn-settings").classList.toggle("active", name === "settings");
  moveTabInk();
  $("content").scrollTop = 0;
  document.scrollingElement.scrollTop = 0; // в низком окне прокручивается вся панель
  if (name === "topics") renderTopics();
  if (name === "summary") {
    renderSummary();
    renderInsights();
  }
  if (name === "moments") renderMoments();
  if (name === "video") void renderVideoTldr();
  if (name === "comments") renderComments();
  if (name === "search") renderSearchResults();
  if (name === "settings") {
    fillSettingsFields();
    void renderHistoryList();
  } else {
    // запоминаем вкладку: при следующем открытии панели вернёмся на неё
    void chrome.storage.local.set({ "ui:tab": name }).catch(() => {});
  }
}

// ---------------- Сводка ----------------

// Каждый запуск анализа получает номер. Смена видео или «Собрать заново»
// увеличивают счётчик — старый запуск видит это и тихо сворачивается, а его
// результат (если успел) уходит в историю своего видео, а не текущего.
let analyzeRun = 0;

function resetAnalyzeUi() {
  state.analyzing = false;
  $("btn-cancel-analyze").classList.add("hidden");
  $("btn-analyze").disabled = state.collect?.status === "loading";
  $("btn-analyze").classList.remove("busy");
  setProgress("analyze-progress", null);
  $("summary-placeholder").textContent = "";
  $("summary-text").innerHTML = "";
}

// Явная отмена («Отменить анализ», «Собрать заново»): запуск останавливается,
// результат НЕ сохраняется.
// Сетевая отмена текущего анализа: запрос к серверу обрывается сразу, а не
// дорабатывает впустую (и не держит очередь для следующего запуска).
let analyzeAbort = null;

function cancelAnalysis(reason) {
  if (!state.analyzing) return;
  analyzeAbort?.abort();
  analyzeRun++;
  resetAnalyzeUi();
  if (reason) showToast(reason);
}

// Ушли на другое видео посреди анализа: анализ продолжает работать в фоне для
// своего видео (видео и комментарии в нём зафиксированы) и сохраняет сводку в
// историю, а панель сразу свободна для нового видео. Новый запуск анализа
// остановит фоновый (лимит Groq общий).
const detachedRuns = new Set();
// Анализ, ушедший в фон при смене видео: видно и можно отменить.
let bgRun = null; // { run, title }

function renderBgRun() {
  const el = $("bg-run");
  if (!bgRun) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const t = bgRun.title.length > 40 ? bgRun.title.slice(0, 38).replace(/\s+\S*$/, "") + "…" : bgRun.title;
  el.innerHTML = `<span class="dot pulse"></span><span class="bg-run-text" title="Сводка «${esc(bgRun.title)}» пишется в фоне">В фоне пишется сводка «${esc(t)}»</span><button class="link-btn" data-bg-cancel>Отменить</button>`;
  el.classList.remove("hidden");
}

function cancelBgRun() {
  if (!bgRun) return;
  if (bgRun.run === analyzeRun) {
    analyzeAbort?.abort();
    analyzeRun++;
  }
  bgRun = null;
  renderBgRun();
  showToast("Фоновая сводка отменена");
}

function detachAnalysis() {
  if (!state.analyzing) return;
  detachedRuns.add(analyzeRun);
  bgRun = { run: analyzeRun, title: state.meta?.title || "прошлого видео" };
  renderBgRun();
  resetAnalyzeUi();
  showToast("Сводка прошлого видео допишется в фоне и сохранится в историю");
}

async function analyze() {
  if (state.analyzing) return;
  if (!proxy.configured) {
    showToast("Заполни настройки прокси (URL, секрет, модель).");
    setTab("settings");
    return;
  }
  if (!state.comments.length) {
    // Разберёмся по живому статусу сбора: идёт ли он, упал ли, или готов без комментов.
    const stKey = state.videoId ? `collect:${state.videoId}` : null;
    let st = null;
    if (stKey) {
      try {
        st = (await chrome.storage.session.get([stKey]))[stKey] || null;
      } catch (e) {
        /* ignore */
      }
    }
    if (st?.status === "loading") {
      showToast(`Сбор ещё идёт: ${st.fetched || 0}/${st.max || "…"}. Анализ можно будет запустить, когда он закончится.`);
    } else if (st?.status === "error") {
      showToast(`${humanCollectError(st.error)}.`);
    } else {
      showToast("Сначала соберите комментарии — нажмите «Собрать заново» или откройте видео ещё раз.");
    }
    return;
  }
  state.analyzing = true;
  $("btn-cancel-analyze").classList.remove("hidden");
  // новый запуск останавливает и фоновый (лимит Groq общий)
  analyzeAbort?.abort();
  const ac = (analyzeAbort = new AbortController());
  const run = ++analyzeRun;
  const live = () => run === analyzeRun;
  // анализируем именно это видео и этот набор комментариев, что бы ни случилось с панелью
  const vid = state.videoId;
  const comments = state.comments;
  const meta0 = state.meta;
  const lang = state.settings.lang;
  // На экране ли этот анализ (не отменён, не ушёл в фон, то же видео)? Если нет —
  // записи в интерфейс уходят в отсоединённый элемент и никому не мешают.
  const onScreen = () => live() && !detachedRuns.has(run) && state.videoId === vid;
  const sink = document.createElement("div");
  const uiEl = (id) => (onScreen() ? $(id) : sink);
  const uiProgress = (f) => {
    if (onScreen()) setProgress("analyze-progress", f);
  };
  $("btn-analyze").disabled = true;
  $("btn-analyze").classList.add("busy");
  setTab("summary");
  $("summary-history").classList.add("hidden");
  $("summary-cta").classList.add("hidden");
  uiEl("summary-placeholder").classList.remove("hidden");
  uiEl("summary-placeholder").textContent = "Готовлю комментарии…";
  uiProgress(0.03);
  try {
    // Пул для ИИ: при большом сборе берём самые залайканные (в исходном
    // порядке) — иначе 2000 комментариев на бесплатном лимите это ~20 минут.
    // Обзор, моменты и поиск по тексту всё равно работают по всем.
    const pool = analysisPool(comments);
    const poolComments = pool.map((i) => comments[i]);
    const nodes = buildChunks(poolComments);
    if (!nodes.length) throw new Error("Нет комментариев для анализа.");

    let baseOffset = 0;
    let partLabel = "";
    const topicMap = {}; // name -> { ids: Set(globalIndices), n }
    const points = [];
    const notableIds = [];
    const sentiment = { positive: 0, neutral: 0, negative: 0 };
    const sentimentIds = { positive: [], neutral: [], negative: [] };
    const notableComments = [];
    // локальный № внутри части → индекс в comments; номер за пределами своей
    // части отбрасываем (иначе модель «дотягивалась» до соседней части)
    const toGlobal = (localBase, id, len) => {
      const n = Number(id);
      if (!Number.isInteger(n) || n < 0 || n >= len) return -1;
      const k = localBase + n;
      return k < pool.length ? pool[k] : -1;
    };
    // Самые крупные темы на данный момент — подсказка следующим частям,
    // чтобы модель называла одну тему одинаково.
    const knownTopics = () =>
      Object.entries(topicMap)
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 10)
        .map(([name]) => name);

    const absorb = (data, localBase, len) => {
      if (!data) return;
      if (data.topics && typeof data.topics === "object") {
        for (const [name, val] of Object.entries(data.topics)) {
          const nm = clean(name);
          // новый формат {n, ids}; старый — просто массив номеров
          const ids = Array.isArray(val) ? val : Array.isArray(val?.ids) ? val.ids : null;
          if (!nm || !ids) continue;
          const t = (topicMap[nm] ||= { ids: new Set(), n: 0 });
          let added = 0;
          for (const id of ids) {
            const g = toGlobal(localBase, id, len);
            if (g >= 0 && !t.ids.has(g)) {
              t.ids.add(g);
              added++;
            }
          }
          t.n += Math.max(Number(val?.n) || 0, added);
        }
      }
      if (Array.isArray(data.points)) {
        for (const p of data.points) {
          const pg = clean(p);
          if (pg) points.push(pg.slice(0, 160));
        }
      }
      if (Array.isArray(data.notable)) {
        for (const id of data.notable) {
          const g = toGlobal(localBase, id, len);
          if (g >= 0 && !notableIds.includes(g)) notableIds.push(g);
        }
      }
      const s = data.sentiment || {};
      sentiment.positive += Number(s.positive) || 0;
      sentiment.neutral += Number(s.neutral) || 0;
      sentiment.negative += Number(s.negative) || 0;
      // примеры по тональности — для клика по цветной полосе
      const ex = data.ex || {};
      for (const [key, kind] of [["p", "positive"], ["u", "neutral"], ["n", "negative"]]) {
        if (!Array.isArray(ex[key])) continue;
        for (const id of ex[key].slice(0, 4)) {
          const g = toGlobal(localBase, id, len);
          if (g >= 0 && !sentimentIds[kind].includes(g)) sentimentIds[kind].push(g);
        }
      }
    };

    // Рекурсивно разбираем порцию комментариев: нормальный размер → 1 запрос;
    // при лимите ВХОДНЫХ токенов делим пополам (обе половины!), при лимите
    // ВЫХОДНЫХ — ждём окно и повторяем ту же порцию (дробление не помогает).
    // rateTries ограничивает повторы при OTPM, чтобы не уйти в бесконечный цикл:
    // depth тут не растёт, поэтому сторож дроблений его бы не поймал.
    // Возвращает true, если вся порция разобрана без ошибок.
    const processPortion = async (portion, localBase, depth, rateTries = 0) => {
      if (!portion.length) return true;
      if (!live()) return false;
      if (depth > 6) throw new Error("Слишком много дроблений (комментарии слишком большие или лимит исчерпан)");
      if (rateTries > 3) throw new Error("Groq держит лимит выходных токенов дольше 3 минут — сделайте перерыв и запустите анализ ещё раз.");

      // оцениваем токены порции; если она уже мала для лимита, но всё равно
      // получили 429 — значит уперлись в общий бюджет бота+расширения: ждём окно.
      const userText = chunkUser(portion, knownTopics());
      const est = estimateRequestTokens(CHUNK_ANALYZE_SYSTEM, userText);
      // В OTPM Groq считает ФАКТИЧЕСКИ сгенерированные токены, а не max_tokens.
      // Компактный формат ответа — ~200 токенов на часть; резерв с запасом,
      // после ответа settleOutput() поправит его на факт.
      const estOut = 280;
      const slot = await paceRequest(est, estOut, waitNote(partLabel, uiEl));
      if (!live()) return false; // отменили, пока ждали окно лимита
      try {
        const raw = await proxy.chat(
          [
            { role: "system", content: CHUNK_ANALYZE_SYSTEM },
            { role: "user", content: userText },
          ],
          // сервер сам ждёт окно Groq (до 3 попыток с паузами) — даём ему время
          { jsonMode: true, maxTokens: CHUNK_MAX_OUTPUT_TOKENS, timeoutMs: 330000, signal: ac.signal }
        );
        settleOutput(slot, raw);
        const data = extractJson(raw);
        if (!data) throw new Error("Модель вернула не JSON");
        absorb(data, localBase, portion.length);
        return true;
      } catch (e) {
        // OTPM (лимит ВЫХОДНЫХ токенов) дроблением НЕ лечится: меньше входа —
        // не меньше выхода, а запросов станет больше и OTPM только усугубится.
        // Лечится паузой на минутное окно (Groq сам пишет, сколько ждать).
        if (isOutputLimitError(e)) {
          const waitMs = Math.max(30000, retryAfterMs(e, 30000));
          uiEl("summary-placeholder").textContent =
            `Groq: лимит выходных токенов (OTPM) — жду окно ~${Math.round(waitMs / 1000)} с, затем повтор…`;
          // Сдвигаем и локальный бюджет, иначе paceRequest сразу повторит запрос.
          pushBudgetAfterOutputError(waitMs);
          await sleep(waitMs);
          // Повторяем ту же порцию (глубина не растёт — растёт счётчик rateTries).
          return processPortion(portion, localBase, depth, rateTries + 1);
        }
        // Настоящий лимит ВХОДНЫХ токенов (413/ITPM) — тут помогает дробление.
        if (isInputLimitError(e) && portion.length > 1) {
          uiEl("summary-placeholder").textContent = `Лимит входных токенов Groq — дроблю и жду окно…`;
          await sleep(2000);
          const half = Math.ceil(portion.length / 2);
          const okFirst = await processPortion(portion.slice(0, half), localBase, depth + 1);
          const okSecond = await processPortion(portion.slice(half), localBase + half, depth + 1);
          return okFirst && okSecond;
        }
        // Не влезает по размеру даже одиночная порция: ждать минутное окно тут
        // нечего, надо уменьшать объём — показываем честный текст ошибки.
        if (isSizeLimitError(e)) {
          throw e;
        }
        // Портция уже мала, а входной лимит всё равно упёрся: занят общий
        // ITPM-бюджет (бот + расширение). Ждём окно и пробуем ту же порцию.
        if (isInputLimitError(e)) {
          const waitMs = Math.max(60000, retryAfterMs(e, 60000));
          uiEl("summary-placeholder").textContent =
            `Groq: лимит входных токенов (ITPM) — жду ~${Math.round(waitMs / 1000)} с, затем повтор…`;
          await sleep(waitMs);
          return processPortion(portion, localBase, depth, rateTries + 1);
        }
        // Прочий 429 (лимит запросов в минуту, иная формулировка Groq) — тоже
        // ждём окно, а не выбрасываем всё уже разобранное.
        if (isRateLimitError(e) && rateTries < 3) {
          const waitMs = Math.max(20000, retryAfterMs(e, 30000));
          uiEl("summary-placeholder").textContent = `Groq: лимит запросов — жду ~${Math.round(waitMs / 1000)} с, затем повтор…`;
          await sleep(waitMs);
          return processPortion(portion, localBase, depth, rateTries + 1);
        }
        throw e;
      }
    };

    // Сбой одной части (сервер, лимит, кривой ответ) не перечёркивает остальные:
    // сводка строится по разобранным частям, и панель честно пишет, сколько их.
    let partsFailed = 0;
    let lastPartError = null;
    for (let ci = 0; ci < nodes.length; ci++) {
      if (!live()) return;
      partLabel = nodes.length > 1 ? `Часть ${ci + 1} из ${nodes.length}.` : "";
      uiEl("summary-placeholder").textContent =
        nodes.length > 1 ? `Читаю комментарии: часть ${ci + 1} из ${nodes.length}…` : "Читаю комментарии…";
      uiProgress((ci + 0.3) / (nodes.length + 1));
      try {
        await processPortion(nodes[ci], baseOffset, 0);
      } catch (pe) {
        if (pe?.cancelled || !live()) return;
        // размер не лечится следующими частями — дальше пробовать бессмысленно
        if (isSizeLimitError(pe) || nodes.length === 1) throw pe;
        partsFailed++;
        lastPartError = pe;
        // не warn: сбой части обработан (панель покажет «разобрано N из M частей») и не должен
        // попадать в «Ошибки» на chrome://extensions
        console.info("часть анализа не удалась:", pe?.message || pe);
      }
      baseOffset += nodes[ci].length;
    }
    if (!live()) return;
    if (partsFailed === nodes.length) throw lastPartError;
    uiProgress(nodes.length / (nodes.length + 1));

    const topics = mergeTopics(Object.entries(topicMap).map(([name, t]) => ({ name, ids: [...t.ids], n: t.n })))
      .map((t) => ({ name: t.name, count: t.n, ids: t.ids }))
      .slice(0, 12);

    // Яркие — по одному-два из каждой части; оставляем 6 самых залайканных.
    for (const g of notableIds
      .slice()
      .sort((a, b) => (comments[b].likes || 0) - (comments[a].likes || 0))
      .slice(0, 6)) {
      notableComments.push(comments[g]);
    }

    uiEl("summary-placeholder").textContent = "Пишу итоговую сводку…";
    uiEl("summary-text").innerHTML =
      `<div class="summary-title">${icon("summary", { size: 14 })}Что говорят в комментариях</div><div class="skeleton"><i></i><i></i><i></i></div>`;
    const liveSummary = uiEl("summary-text");
    // Финальный запрос идёт сразу после чанков — OTPM ещё выбран, поэтому
    // заранее ждём место в окне под его выходные токены.
    if (!live()) return;
    const finIn = estimateRequestTokens(FINAL_SYSTEM, finalUser({ topics, points, sentiment, notableComments, lang }));
    // Сводка ≤380 символов ≈ 150–200 токенов: резервируем 350, а не max_tokens.
    const finSlot = await paceRequest(finIn, 350, waitNote("Осталась итоговая сводка.", uiEl));
    if (!live()) return;
    uiEl("summary-placeholder").textContent = "Пишу итоговую сводку…";
    let fin = "";
    // Финал обычно последний и самый «весомый» — именно он чаще всего упирается
    // в OTPM. На OTPM ждём окно и повторяем (дробление тут невозможно), на прочих
    // ошибках — одна попытка, дальше покажем пользователю текст.
    for (let finTry = 0; finTry <= 3; finTry++) {
      if (!live()) return;
      try {
        fin = await proxy.chatStream(
          [
            { role: "system", content: FINAL_SYSTEM },
            { role: "user", content: finalUser({ topics, points, sentiment, notableComments, lang }) },
          ],
          { jsonMode: false, maxTokens: 700, timeoutMs: 330000, signal: ac.signal },
          (full) => {
            if (!live()) return;
            uiEl("summary-text").innerHTML = `<div class="summary-title">${icon("summary", { size: 14 })}Что говорят в комментариях</div>` + esc(tidySummary(full));
          }
        );
        break;
      } catch (fe) {
        if (isOutputLimitError(fe) && finTry < 3) {
          const waitMs = Math.max(30000, retryAfterMs(fe, 30000));
          uiEl("summary-placeholder").textContent =
            `Groq: лимит выходных токенов на финальной сводке — жду ~${Math.round(waitMs / 1000)} с, затем повтор…`;
          pushBudgetAfterOutputError(waitMs);
          await sleep(waitMs);
          continue;
        }
        if (isRateLimitError(fe) && finTry < 3) {
          const waitMs = Math.max(20000, retryAfterMs(fe, 30000));
          uiEl("summary-placeholder").textContent = `Groq: лимит запросов — жду ~${Math.round(waitMs / 1000)} с, затем повтор…`;
          await sleep(waitMs);
          continue;
        }
        throw fe;
      }
    }
    settleOutput(finSlot, fin);
    const summary = tidySummary(fin) || "Сводка не получена.";
    // по каждой тональности — до 12 примеров, сначала самые залайканные
    const byLikes = (a, b) => (comments[b]?.likes || 0) - (comments[a]?.likes || 0);
    for (const k of Object.keys(sentimentIds)) sentimentIds[k] = sentimentIds[k].sort(byLikes).slice(0, 12);
    const result = {
      summary,
      topics,
      sentimentIds,
      points: dedupeTexts(points, 6),
      notable: notableComments,
      sentiment,
      updatedAt: Date.now(),
      commentCount: comments.length,
      analyzed: pool.length,
      ...(partsFailed ? { parts: { failed: partsFailed, total: nodes.length } } : {}),
    };
    // Явно отменённый запуск не сохраняем; ушедший в фон — сохраняем для СВОЕГО видео.
    if (!live()) return;
    await safeSessionSet({ [`summary:${vid}`]: packSummary(result, comments) }, { keepVideoId: vid });
    void saveHistory(vid, result, comments, meta0);
    if (!onScreen()) {
      const full = meta0?.title || "прошлого видео";
      const t = full.length > 48 ? full.slice(0, 46).replace(/\s+\S*$/, "") + "…" : full;
      showToast(`Сводка «${t}» готова — она в «Недавних сводках»`);
      // вернулись на то видео, пока сводка дописывалась в фоне, — сразу покажем её
      if (state.videoId === vid && !state.analyzing) {
        lastRenderSig = "";
        void loadFor(vid);
      }
      return;
    }
    uiEl("summary-text").innerHTML = `<div class="summary-title">${icon("summary", { size: 14 })}Что говорят в комментариях</div>` + esc(summary);
    // позиции тем и ярких — по набору, который анализировали; если за это
    // время комментарии пересобрались, переносим их по id
    state.summary = state.comments === comments ? result : unpackSummary(packSummary(result, comments), state.comments);
    state.newIds = new Set();
    if (state.commentFilter === "new") state.commentFilter = "all";
    uiEl("summary-placeholder").textContent = "";
    // Снимаем флаг до отрисовки: renderSummary() во время анализа ничего не
    // рисует (бережёт живой прогресс), и без этого темы/тональность/мнения
    // не появлялись до следующего переключения вкладки.
    state.analyzing = false;
    renderSummary();
    renderTopics();
    setTab("summary");
  } catch (e) {
    if (!onScreen()) return; // анализ отменён или в фоне — ошибку не показываем
    const msg = friendlyError(e);
    if (state.summary) {
      // «Обновить сводку» не удалось — прежняя сводка остаётся целиком
      state.analyzing = false;
      renderSummary();
      renderTopics();
      uiEl("summary-placeholder").classList.remove("hidden");
      uiEl("summary-placeholder").innerHTML = `<div class="error-box"><b>Не получилось обновить сводку</b> — ниже прежняя.<br>${esc(msg)}</div>`;
    } else {
      uiEl("summary-text").innerHTML = "";
      uiEl("summary-placeholder").classList.remove("hidden");
      uiEl("summary-placeholder").innerHTML = `<div class="error-box"><b>Не получилось проанализировать.</b><br>${esc(msg)}</div>`;
    }
  } finally {
    if (bgRun?.run === run) {
      bgRun = null;
      renderBgRun();
    }
    if (onScreen()) {
      state.analyzing = false;
      $("btn-cancel-analyze").classList.add("hidden");
      $("btn-analyze").disabled = state.collect?.status === "loading";
      $("btn-analyze").classList.remove("busy");
      uiProgress(null);
    }
  }
}

// Лёгкая чистка итоговой сводки: только markdown и обёртка в кавычки целиком.
// Один и тот же вид во время стрима и после — текст не «прыгает» в конце.
function tidySummary(text) {
  return normalizeSummary(String(text || ""), 2000)
    .replace(/^\s*["«„](.*)["»“]\s*$/s, "$1")
    .trim();
}

// какая доля настроения раскрыта (positive | neutral | negative | null)
let sentimentOpen = null;

function sentimentExamplesHtml(s, kind) {
  const list = (s.sentimentIds?.[kind] || []).map((i) => state.comments[i]).filter(Boolean);
  const label = { positive: "Позитивные", neutral: "Нейтральные", negative: "Негативные" }[kind];
  if (!list.length) {
    const why = s.sentimentLegacy
      ? "Примеры появятся после «Обновить сводку»: эта сводка сделана до того, как расширение научилось их отмечать."
      : "Примеров нет: ИИ не отметил их для этой доли или они не попали в текущий сбор.";
    return `<div class="sent-examples"><div class="hint">${why}</div></div>`;
  }
  return `<div class="sent-examples"><div class="hint">${label} — примеры, которые отметил ИИ</div>${list
    .map((c) => commentCard(c, { compact: true }))
    .join("")}</div>`;
}

function toggleSentiment(kind) {
  const s = state.summary;
  if (!s) return;
  sentimentOpen = sentimentOpen === kind ? null : kind;
  const box = $("summary-sentiment");
  box.querySelectorAll(".sent-seg").forEach((b) => {
    const on = b.dataset.sent === sentimentOpen;
    b.classList.toggle("open", on);
    b.setAttribute("aria-expanded", String(on));
  });
  const col = box.querySelector(".sent-collapse");
  if (sentimentOpen) col.querySelector(".collapse-inner").innerHTML = sentimentExamplesHtml(s, sentimentOpen);
  col.classList.toggle("open", Boolean(sentimentOpen));
}

// plural(5, "комментарий", "комментария", "комментариев") → «комментариев»
function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function fmtDate(ts) {
  try {
    return new Date(ts).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return "";
  }
}

function renderAnalyzeLabel() {
  const b = $("btn-analyze");
  // Идёт сбор — анализировать ещё нечего: кнопка сама говорит, что происходит,
  // вместо подсказки по нажатию.
  const collecting = state.collect?.status === "loading" && !state.analyzing;
  const label = collecting ? "Собираю комментарии…" : state.summary ? "Обновить сводку" : "Анализировать";
  const was = b.classList.contains("collecting");
  b.classList.toggle("collecting", collecting);
  if (collecting) b.disabled = true;
  else if (was) b.disabled = state.analyzing; // сбор закончился — снова можно
  $("btn-topics-analyze")?.classList.toggle("hidden", collecting);
  if (b.dataset.label === label) return;
  b.dataset.label = label;
  b.textContent = label;
}

function renderSummary() {
  renderAnalyzeLabel();
  if (state.analyzing) return; // не затираем живой прогресс и стрим
  const s = state.summary;
  const ph = $("summary-placeholder");
  const hist = $("summary-history");
  if (s?.updatedAt) {
    const n =
      s.analyzed && s.analyzed < s.commentCount
        ? ` · по ${s.analyzed} самым залайканным из ${s.commentCount}`
        : s.commentCount
          ? ` · по ${s.commentCount} ${plural(s.commentCount, "комментарию", "комментариям", "комментариям")}`
          : "";
    const nNew = s.fromHistory ? state.newIds?.size || 0 : 0;
    hist.innerHTML = s.fromHistory
      ? `Сохранённая сводка от ${esc(fmtDate(s.updatedAt))}${esc(n)}. «Обновить сводку» — пересчитать.` +
        (nNew ? ` <button class="link-btn new-link" data-goto-filter="new">${nNew} ${plural(nNew, "новый комментарий", "новых комментария", "новых комментариев")} с тех пор →</button>` : "")
      : `Сводка от ${esc(fmtDate(s.updatedAt))}${esc(n)}`;
    if (s.parts?.failed) {
      hist.innerHTML += ` <span class="status-note">· ${s.parts.failed} из ${s.parts.total} ${plural(s.parts.total, "части", "частей", "частей")} не ${s.parts.failed === 1 ? "разобралась" : "разобрались"} — сводка по остальным</span>`;
    }
    hist.classList.remove("hidden");
  } else {
    hist.classList.add("hidden");
  }
  $("summary-cta").classList.toggle("hidden", Boolean(s) || !state.comments.length);
  // Сервер не настроен — карточка объясняет, что делать, вместо ошибки по клику.
  const needSetup = !proxy.configured;
  $("summary-cta").querySelector(".cta-title").textContent = needSetup ? "Подключите сервер с ИИ" : "Сводка обсуждения от ИИ";
  $("summary-cta").querySelector(".cta-text").textContent = needSetup
    ? "Для сводки нужен адрес сервера и секрет. Обзор, моменты и поиск по тексту работают и без этого."
    : "Темы, настроение зрителей, главные мнения и яркие комментарии. Бесплатно, обычно около минуты.";
  $("btn-cta-settings").classList.toggle("hidden", !needSetup);
  renderServerHint();
  if (!s) {
    // Есть комментарии — показываем карточку-приглашение; идёт сбор — короткую строку.
    // идёт сбор — такой же пустой экран, как на других вкладках (иконка, заголовок, пояснение)
    ph.innerHTML = state.comments.length
      ? ""
      : noCommentsEmpty("Собираю комментарии", "Сводку можно будет сделать, когда сбор закончится — прогресс виден над вкладками.");
    ph.classList.toggle("hidden", Boolean(state.comments.length));
    $("btn-copy-summary").classList.add("hidden");
    $("btn-image-summary").classList.add("hidden");
    $("btn-export-summary").classList.add("hidden");
    $("summary-topics").classList.add("hidden");
    $("summary-sentiment").classList.add("hidden");
    $("summary-text").textContent = "";
    $("summary-points").innerHTML = "";
    $("summary-notable").innerHTML = "";
    return;
  }
  ph.textContent = "";
  ph.classList.add("hidden");
  $("btn-copy-summary").classList.remove("hidden");
  $("btn-image-summary").classList.remove("hidden");
  $("btn-export-summary").classList.remove("hidden");

  const chips = (s.topics || []).slice(0, 5);
  const chipWrap = $("summary-topics");
  if (chips.length) {
    chipWrap.classList.remove("hidden");
    chipWrap.innerHTML =
      '<span class="chips-label">Главные темы</span>' +
      chips
        .map(
          (t) => `<button class="chip" data-topic="${esc(t.name)}">${esc(t.name)} <span class="count">${t.count}</span></button>`
        )
        .join("");
  } else {
    chipWrap.classList.add("hidden");
  }

  const sp = s.sentiment || {};
  const total = (sp.positive || 0) + (sp.neutral || 0) + (sp.negative || 0);
  const box = $("summary-sentiment");
  if (total) {
    const parts = [
      ["positive", sp.positive || 0, "позитив"],
      ["neutral", sp.neutral || 0, "нейтрально"],
      ["negative", sp.negative || 0, "негатив"],
    ];
    const pct = (n) => Math.round((n / total) * 100);
    box.classList.remove("hidden");
    // Каждая доля — кнопка: полоса и подпись под ней; клик раскрывает
    // примеры комментариев этой тональности (их отмечает ИИ при анализе).
    const ids = s.sentimentIds || {};
    box.innerHTML = `
      <div class="subhead">Настроение зрителей <span class="hint">нажмите на полосу — примеры</span></div>
      <div class="sentiment-row">${parts
        .filter(([, n]) => n)
        .map(([k, n, label]) => {
          const open = sentimentOpen === k;
          return `<button class="sent-seg ${k}${open ? " open" : ""}" style="flex:${n} 1 0" data-sent="${k}" aria-expanded="${open}" title="${label}: ${n} из ${total} — показать примеры"><i></i><span><b>${pct(n)}%</b> ${label}</span></button>`;
        })
        .join("")}</div>
      <div class="collapse sent-collapse${sentimentOpen ? " open" : ""}"><div class="collapse-inner">${sentimentOpen ? sentimentExamplesHtml(s, sentimentOpen) : ""}</div></div>`;
  } else {
    box.classList.add("hidden");
  }

  $("summary-text").innerHTML =
      `<div class="summary-title">${icon("summary", { size: 14 })}Что говорят в комментариях</div>` + esc(s.summary || "");

  $("summary-points").innerHTML = "";
  if (s.points?.length) {
    $("summary-points").innerHTML =
      '<div class="subhead">Ключевые мнения</div><ol class="points">' +
      s.points.map((p) => `<li>${esc(p)}</li>`).join("") +
      "</ol>";
  }

  $("summary-notable").innerHTML = "";
  if (s.notable?.length) {
    $("summary-notable").innerHTML =
      '<div class="subhead">Яркие комментарии</div>' + s.notable.map((c) => commentCard(c, { compact: true })).join("");
  }
}

// ---------------- Обзор без ИИ ----------------
// Считается локально сразу после сбора — даёт пользу ещё до «Анализировать»
// и не тратит лимиты Groq.

function renderInsights() {
  const box = $("insights");
  const list = state.comments;
  if (!list.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  const st = cached("stats", () => commentStats(list, maxSec()));
  const words = cached("words", () => topWords(list, 14));
  const moments = allMoments().slice(0, 3);
  // ветка с наибольшим числом ответов (не считая комментария автора канала —
  // он обычно закреплён и собирает ответы по другой причине)
  const hot = list.reduce(
    (best, c) => (!c.isCreator && (c.replies || 0) > (best?.replies || 0) ? c : best),
    null
  );
  const stat = (n, label, filter) =>
    `<button class="stat"${filter ? ` data-goto-filter="${filter}"` : " disabled"}><b data-n="${n}">${fmtNum(n)}</b><span>${label}</span></button>`;
  box.innerHTML = `
    <div class="section-head"><span>Обзор</span><span class="hint">считается без ИИ</span></div>
    <div class="stats">
      ${stat(st.total, plural(st.total, "комментарий", "комментария", "комментариев"), "all")}
      ${stat(st.likes, st.likes >= 1000 ? "лайков" : plural(st.likes, "лайк", "лайка", "лайков"), "popular")}
      ${stat(st.questions, plural(st.questions, "вопрос", "вопроса", "вопросов"), st.questions ? "questions" : "")}
      ${stat(st.withTime, "с таймкодами", st.withTime ? "timecodes" : "")}
    </div>
    ${
      words.length
        ? `<div class="subhead">О чём чаще пишут</div><div class="word-cloud">${words
            .map((w, i) => {
              const size = i < 3 ? "l" : i < 7 ? "m" : "s";
              return `<button class="word ${size}" data-word="${esc(w.word)}" title="${w.count} ${plural(w.count, "комментарий", "комментария", "комментариев")} — показать">${esc(w.word)}<span>${w.count}</span></button>`;
            })
            .join("")}</div>`
        : ""
    }
    ${
      moments.length
        ? `<div class="subhead">Популярные моменты <button class="link-btn" data-goto="moments">все →</button></div>
           <div class="moment-rows">${moments.map((m) => momentRow(m, list)).join("")}</div>`
        : ""
    }
    ${
      st.top && st.top.likes
        ? `<div class="subhead">Самый залайканный</div>${commentCard(st.top, { compact: true })}`
        : ""
    }
    ${
      hot && hot !== st.top
        ? `<div class="subhead">Самая жаркая ветка <button class="link-btn" data-goto-filter="replies">все обсуждаемые →</button></div>${commentCard(hot, { compact: true })}`
        : ""
    }`;
  box.classList.remove("hidden");
  countUp(box.querySelectorAll(".stat b[data-n]"));
}

// Строка популярного момента в обзоре: таймкод, сколько зрителей на него
// ссылаются и начало самого залайканного комментария. Клик — перемотка
// и переход к этому моменту на вкладке «Моменты».
function momentRow(m, list) {
  const n = `${m.count} ${plural(m.count, "комментарий", "комментария", "комментариев")}`;
  // цитата — из первого комментария, где кроме таймкода есть текст
  // (бывает комментарий из одного «0:42»)
  let quote = "";
  for (const i of m.idxs) {
    quote = list[i] ? stripTimecodes(list[i].text) : "";
    if (quote) break;
  }
  return `<button class="moment-row" data-t="${m.t}" data-moment="${m.t}" title="Перемотать и показать комментарии">
    <span class="tc tc-big">${icon("play", { size: 11 })}${esc(m.label)}</span>
    <span class="moment-row-text"><b>${n}</b>${quote ? `<span>${esc(quote)}</span>` : ""}</span>
  </button>`;
}

// Текст комментария без самих таймкодов в начале — для коротких цитат.
function stripTimecodes(text) {
  return String(text || "")
    .replace(/^(\s*\d{1,2}(:\d{2}){1,2}[\s.,;:–—-]*)+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Числа в обзоре плавно «досчитываются» от нуля — один раз на новые данные.
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
function countUp(nodes, ms = 550) {
  if (prefersReducedMotion.matches) return;
  const items = [...nodes].map((el) => ({ el, n: Number(el.dataset.n) || 0 })).filter((x) => x.n > 1);
  if (!items.length) return;
  const t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const tick = (now) => {
    // метка кадра бывает чуть раньше t0 — без нижней границы число на миг уходит в минус
    const k = ease(Math.min(1, Math.max(0, (now - t0) / ms)));
    for (const { el, n } of items) el.textContent = fmtNum(Math.round(n * k));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------------- Моменты ----------------

function renderMoments() {
  const list = state.comments;
  const moments = list.length ? allMoments() : [];
  const badge = $("moments-badge");
  // в счётчике — моменты, которые видны в списке по умолчанию (от двух комментариев)
  const nMulti = moments.filter((m) => m.count > 1).length;
  badge.textContent = moments.length ? String(nMulti >= 3 ? nMulti : moments.length) : "";
  badge.classList.toggle("hidden", !moments.length);
  $("moments-empty").classList.toggle("hidden", Boolean(moments.length));
  const line = $("moments-timeline");
  const wrap = $("moments-list");
  const tools = $("moments-tools");
  const allBtn = $("btn-moments-all");
  if (!moments.length) {
    line.classList.add("hidden");
    tools.classList.add("hidden");
    allBtn.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  // Полоса-таймлайн: где в видео сгущаются отсылки зрителей. Размер точки —
  // сколько зрителей сослались на момент. Колесо мыши приближает.
  const known = Number.isFinite(maxSec());
  const end = known ? maxSec() : Math.max(...moments.map((m) => m.t)) * 1.05 + 1;
  const maxCount = Math.max(...moments.map((m) => m.count));
  if (tl.vid !== state.videoId) Object.assign(tl, { vid: state.videoId, z: 1, s: 0 });
  Object.assign(tl, { end, dur: known ? end - 2 : null, step: 0 });
  tl.moments = new Map(moments.map((m) => [String(m.t), m]));
  line.innerHTML =
    '<div class="tl-view"><div class="tl-track">' +
    moments
      .map((m) => {
        const left = Math.min(100, (m.t / end) * 100);
        const size = 8 + Math.round((m.count / maxCount) * 8);
        const n = `${m.count} ${plural(m.count, "комментарий", "комментария", "комментариев")}`;
        return `<button class="tl-dot" tabindex="-1" data-t="${m.t}" data-moment="${m.t}" aria-label="${esc(m.label)}, ${n}" style="left:${left}%;width:${size}px;height:${size}px;z-index:${m.count}"></button>`;
      })
      .join("") +
    '</div></div><div class="tl-scale"><span class="tl-from"></span><span class="tl-mid"></span><span class="tl-to"></span></div><div class="tl-pop" aria-hidden="true"></div>';
  bindTimeline(line);
  applyZoom(false);
  line.classList.remove("hidden");

  // Список: по ходу видео или по обсуждаемости. Моменты, на которые сослался
  // один зритель, — шум: прячем под кнопку, если есть из чего выбирать.
  const sortBy = state.momentsSort || "time";
  tools.classList.remove("hidden");
  document.querySelectorAll("#moments-sort .chip").forEach((b) => {
    const on = b.dataset.sort === sortBy;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  const multi = moments.filter((m) => m.count > 1);
  const singles = moments.length - multi.length;
  const hideSingles = !state.momentsAll && multi.length >= 3 && singles > 0;
  const shown = (hideSingles ? multi : moments.slice()).sort((a, b) =>
    sortBy === "time" ? a.t - b.t : b.score - a.score || a.t - b.t
  );
  allBtn.classList.toggle("hidden", !hideSingles);
  badge.textContent = String(shown.length); // счётчик = сколько моментов в списке
  if (hideSingles)
    allBtn.textContent = `Ещё ${singles} ${plural(singles, "момент", "момента", "моментов")} с одним комментарием`;

  wrap.classList.toggle("long-video", moments.some((m) => m.label.length > 5));
  wrap.innerHTML = shown
    .map((m) => {
      const cs = m.idxs.map((i) => list[i]);
      const more = cs.length - 1;
      const pos = Math.min(100, (m.t / end) * 100).toFixed(2);
      const n = `${m.count} ${plural(m.count, "комментарий", "комментария", "комментариев")}`;
      return `<div class="moment" data-moment="${m.t}">
        <div class="moment-head">
          <button class="tc tc-big" data-t="${m.t}" title="Перемотать">${icon("play", { size: 11 })}${esc(m.label)}</button>
          <button class="moment-line" data-t="${m.t}" style="--at:${pos}%" title="${esc(m.label)}${known ? ` из ${esc(fmtTime(end - 2))}` : ""} — перемотать" aria-label="Перемотать на ${esc(m.label)}"><i></i><b></b></button>
          <span class="hint">${n}</span>
          <button class="mclip icon-btn" data-clip="${m.t}" title="Вырезать клип вокруг ${esc(m.label)} (−5 с … +20 с)" aria-label="Вырезать клип вокруг ${esc(m.label)}">${icon("clip", { size: 15 })}</button>
        </div>
        ${commentCard(cs[0], { compact: true })}
        ${
          more > 0
            ? `<div class="collapse"><div class="collapse-inner" data-idx="${m.idxs.slice(1).join(",")}"></div></div>
               <button class="more-toggle" data-more="${more}"><span>${moreLabel(more)}</span>${icon("chevron", { size: 13 })}</button>`
            : ""
        }
      </div>`;
    })
    .join("");
}


// ---------------- Масштабируемый таймлайн ----------------
// z — масштаб (1 = всё видео), s — начало видимого окна (доля длины видео).
// Ширина полосы и её сдвиг анимируются CSS одной кривой, поэтому точка под
// курсором стоит на месте, пока полоса растягивается.
const tl = { vid: null, z: 1, s: 0, end: 1, dur: null, step: 0, moments: new Map() };
const TL_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

function tlParts() {
  const line = $("moments-timeline");
  const view = line.querySelector(".tl-view");
  return { line, view, track: view?.querySelector(".tl-track") };
}

function tlWidth(view) {
  return Math.max(1, view.clientWidth - 16); // поля .tl-view по 8px
}

function tlMaxZoom() {
  // самое близкое — окно секунд в 20, но не больше ×60
  return Math.max(1, Math.min(60, tl.end / 20));
}

function fmtZoom(z) {
  return z < 10 ? z.toFixed(1).replace(".", ",") : String(Math.round(z));
}

function applyZoom(animate = true) {
  const { line, view, track } = tlParts();
  if (!view || !track) return;
  tl.z = Math.min(Math.max(1, tl.z), tlMaxZoom());
  tl.s = Math.min(Math.max(0, tl.s), 1 - 1 / tl.z);
  const instant = !animate || prefersReducedMotion.matches;
  if (instant) track.style.transition = "none";
  track.style.width = `${tl.z * 100}%`;
  track.style.transform = `translateX(${-tl.s * tl.z * tlWidth(view)}px)`;
  if (instant) {
    void track.offsetWidth;
    track.style.transition = "";
  }
  const zoomed = tl.z > 1.01;
  view.classList.toggle("zoomed", zoomed);
  // засечки времени: шаг такой, чтобы в окне было до 6 делений
  const step = zoomed ? TL_STEPS.find((st) => tl.end / tl.z / st <= 6) || 3600 : 0;
  if (step !== tl.step) {
    tl.step = step;
    track.querySelectorAll(".tl-tick").forEach((t) => t.remove());
    if (step) {
      let html = "";
      for (let t = step; t < tl.end - 1; t += step) html += `<i class="tl-tick" data-l="${fmtTime(t)}" style="left:${(t / tl.end) * 100}%"></i>`;
      track.insertAdjacentHTML("afterbegin", html);
    }
  }
  // подписи: границы видимого окна и масштаб
  const from = tl.s * tl.end;
  const to = (tl.s + 1 / tl.z) * tl.end;
  line.querySelector(".tl-from").textContent = fmtTime(Math.round(from));
  line.querySelector(".tl-to").textContent =
    zoomed || tl.dur != null ? fmtTime(Math.round(tl.dur != null ? Math.min(tl.dur, to) : to)) : "";
  let mid = line.querySelector(".tl-mid");
  const tag = zoomed ? "BUTTON" : "SPAN";
  if (mid.tagName !== tag) {
    const el = document.createElement(tag.toLowerCase());
    el.className = "tl-mid";
    if (zoomed) el.title = "Показать всё видео (или двойной клик по полосе)";
    mid.replaceWith(el);
    mid = el;
  }
  mid.textContent = zoomed ? `×${fmtZoom(tl.z)} · показать всё` : "колесо мыши — приблизить";
}

function resetZoom() {
  tl.z = 1;
  tl.s = 0;
  applyZoom(true);
}

function zoomAt(factor, clientX) {
  const { view } = tlParts();
  if (!view) return;
  const r = view.getBoundingClientRect();
  const c = Math.min(1, Math.max(0, (clientX - r.left - 8) / tlWidth(view)));
  const f = tl.s + c / tl.z; // доля видео под курсором — она останется под курсором
  tl.z = Math.min(Math.max(1, tl.z * factor), tlMaxZoom());
  tl.s = f - c / tl.z;
  applyZoom(true);
}

function bindTimeline(line) {
  const view = line.querySelector(".tl-view");
  // Колесо: вверх — приблизить, вниз — отдалить. Горизонтальная прокрутка
  // (тачпад, Shift+колесо) — сдвиг. На полном масштабе «вниз» отдаём странице.
  view.addEventListener(
    "wheel",
    (e) => {
      // Ctrl+колесо / щипок на тачпаде — масштаб таймлайна, а не всей панели
      if (e.ctrlKey) e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : 1;
      const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
      if (Math.abs(dx) > Math.abs(e.deltaY * unit) || (e.shiftKey && dx)) {
        const s = Math.min(Math.max(0, tl.s + dx / (tlWidth(view) * tl.z)), 1 - 1 / tl.z);
        if (Math.abs(s - tl.s) < 1e-6) return; // сдвигать некуда — прокрутка уходит панели
        e.preventDefault();
        tl.s = s;
        applyZoom(false);
        hideTimelinePop(true);
        return;
      }
      const factor = Math.exp(-e.deltaY * unit * 0.0025);
      const z = Math.min(Math.max(1, tl.z * factor), tlMaxZoom());
      if (Math.abs(z - tl.z) < 1e-3) return; // масштаб у предела — не мешаем прокрутке панели
      e.preventDefault();
      zoomAt(factor, e.clientX);
      hideTimelinePop(true);
    },
    { passive: false }
  );
  // перетаскивание приближенной полосы
  let drag = null;
  let swallowClick = false;
  view.addEventListener("pointerdown", (e) => {
    swallowClick = false;
    if (e.button !== 0 || tl.z <= 1.01) return;
    drag = { x: e.clientX, s: tl.s, moved: false, id: e.pointerId };
  });
  view.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      view.setPointerCapture(e.pointerId);
      view.classList.add("panning");
      hideTimelinePop(true);
    }
    tl.s = drag.s - dx / (tlWidth(view) * tl.z);
    applyZoom(false);
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.moved) {
      view.classList.remove("panning");
      swallowClick = true; // клик после перетаскивания не перематывает видео
    }
    drag = null;
  };
  view.addEventListener("pointerup", endDrag);
  view.addEventListener("pointercancel", endDrag);
  view.addEventListener(
    "click",
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true
  );
  view.addEventListener("click", () => hideTimelinePop(true));
  view.addEventListener("dblclick", (e) => {
    if (!e.target.closest(".tl-dot")) resetZoom();
  });
  line.querySelector(".tl-scale").addEventListener("click", (e) => {
    if (e.target.closest("button.tl-mid")) resetZoom();
  });
  // карточка комментария при наведении / фокусе на точке
  const show = (e) => {
    const dot = e.target.closest?.(".tl-dot");
    if (dot && !view.classList.contains("panning")) showTimelinePop(dot);
  };
  view.addEventListener("pointerover", show);
  view.addEventListener("focusin", (e) => {
    const dot = e.target.closest?.(".tl-dot");
    if (!dot) return;
    // точка за краем приближенного окна — подвозим её в центр
    const f = Number(dot.dataset.t) / tl.end;
    if (tl.z > 1.01 && (f < tl.s || f > tl.s + 1 / tl.z)) {
      tl.s = f - 0.5 / tl.z;
      applyZoom(true);
      setTimeout(() => showTimelinePop(dot), 240);
    } else show(e);
  });
  // С клавиатуры точки — одна остановка Tab, дальше стрелками по времени
  view.addEventListener("keydown", (e) => {
    swallowClick = false;
    const dot = e.target.closest?.(".tl-dot");
    if (!dot || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const dots = [...view.querySelectorAll(".tl-dot")].sort((a, b) => a.dataset.t - b.dataset.t);
    const i = dots.indexOf(dot);
    const j = e.key === "Home" ? 0 : e.key === "End" ? dots.length - 1 : i + (e.key === "ArrowRight" ? 1 : -1);
    const next = dots[Math.min(Math.max(0, j), dots.length - 1)];
    dot.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  });
  // первая по времени точка — точка входа с клавиатуры
  const first = [...view.querySelectorAll(".tl-dot")].sort((a, b) => a.dataset.t - b.dataset.t)[0];
  if (first) first.tabIndex = 0;
  tlResize.disconnect();
  tlResize.observe(view);
  view.addEventListener("pointerout", (e) => {
    if (e.target.closest?.(".tl-dot") && !e.relatedTarget?.closest?.(".tl-dot")) hideTimelinePop();
  });
  view.addEventListener("focusout", () => hideTimelinePop());
}

let popHideTimer = 0;
function showTimelinePop(dot) {
  clearTimeout(popHideTimer);
  const { line } = tlParts();
  const pop = line.querySelector(".tl-pop");
  const m = tl.moments.get(dot.dataset.t);
  if (!pop || !m) return;
  line.querySelectorAll(".tl-dot.hot").forEach((d) => d.classList.remove("hot"));
  dot.classList.add("hot");
  const c = state.comments[m.idxs[0]];
  const n = `${m.count} ${plural(m.count, "комментарий", "комментария", "комментариев")}`;
  const likes = c?.likes ? ` · ${fmtNum(c.likes)} ${plural(c.likes, "лайк", "лайка", "лайков")}` : "";
  const text = c ? stripTimecodes(c.text) || String(c.text || "") : "";
  pop.innerHTML =
    `<div class="tl-pop-head"><span class="tc">${esc(m.label)}</span><span>${n}${likes}</span></div>` +
    (c ? `<div class="tl-pop-author">${esc(c.author || "")}</div><div class="tl-pop-text">${esc(text)}</div>` : "") +
    `<div class="tl-pop-foot">Клик — перемотать${m.count > 1 ? " и открыть все" : " и открыть"}</div>`;
  // по центру под точкой, но в пределах карточки таймлайна
  const box = line.getBoundingClientRect();
  const d = dot.getBoundingClientRect();
  const w = pop.offsetWidth;
  const cx = d.left + d.width / 2 - box.left;
  const left = Math.min(Math.max(4, cx - w / 2), box.width - w - 4);
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.round(d.bottom - box.top + 8)}px`;
  pop.style.setProperty("--ox", `${Math.round(cx - left)}px`);
  pop.classList.add("show");
}

function hideTimelinePop(now = false) {
  clearTimeout(popHideTimer);
  const hide = () => {
    const { line } = tlParts();
    line.querySelector(".tl-pop")?.classList.remove("show");
    line.querySelectorAll(".tl-dot.hot").forEach((d) => d.classList.remove("hot"));
  };
  if (now) hide();
  else popHideTimer = setTimeout(hide, 80);
}

// Сдвиг полосы — в пикселях от ширины окна. Ширина меняется при изменении
// панели и при показе вкладки (скрытая вкладка имеет ширину 0) — пересчитываем.
const tlResize = new ResizeObserver(() => {
  if (tl.z > 1.01) applyZoom(false);
});

// Прокрутка с ease-out за ~400 мс. Своя, а не behavior:"smooth": та в
// фоновой/неактивной панели может не сдвинуться вовсе — здесь же по таймеру
// всё равно докручиваем до места.
let scrollAnim = 0;
function smoothScroll(box, target) {
  // Предел прокрутки считаем на каждом кадре: список под целью может как раз
  // раскрываться (анимация высоты) — заранее посчитанный предел был бы мал.
  const cap = () => Math.min(target, box.scrollHeight - box.clientHeight);
  const from = box.scrollTop;
  const dist = target - from;
  const run = ++scrollAnim;
  let done = false;
  const finish = () => {
    done = true;
    box.style.scrollBehavior = "";
    box.removeEventListener("wheel", cancel);
    box.removeEventListener("touchstart", cancel);
  };
  // пользователь сам крутит — не тянем его обратно
  const cancel = () => {
    if (run === scrollAnim) scrollAnim++;
    finish();
  };
  const jump = () => {
    box.style.scrollBehavior = "auto";
    box.scrollTop = cap();
    finish();
  };
  if (prefersReducedMotion.matches || Math.abs(dist) < 4) return jump();
  box.addEventListener("wheel", cancel, { passive: true });
  box.addEventListener("touchstart", cancel, { passive: true });
  const ms = Math.min(520, 260 + Math.abs(dist) / 8);
  const t0 = performance.now();
  box.style.scrollBehavior = "auto";
  const tick = (now) => {
    if (run !== scrollAnim || done) return;
    const k = Math.min(1, Math.max(0, (now - t0) / ms));
    box.scrollTop = Math.min(cap(), from + dist * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(tick);
    else finish();
  };
  requestAnimationFrame(tick);
  // запасной ход: если кадры не идут (панель в фоне), всё равно докрутить
  setTimeout(() => {
    if (run !== scrollAnim || done) return;
    jump();
  }, ms + 150);
}

// Показать момент в списке: плавно докрутить, подсветить и (по желанию)
// раскрыть остальные комментарии к нему.
function revealMoment(t, { expand = false } = {}) {
  const find = () => document.querySelector(`#moments-list .moment[data-moment="${CSS.escape(String(t))}"]`);
  let el = find();
  if (!el && !state.momentsAll) {
    // момент с одним комментарием спрятан — показываем все
    state.momentsAll = true;
    renderMoments();
    el = find();
  }
  if (!el) return;
  if (expand && !el.classList.contains("open")) el.querySelector(".more-toggle")?.click();
  // обычно прокручивается список; в совсем низком окне — вся панель (CSS)
  const list = $("content");
  const box = getComputedStyle(list).overflowY === "visible" ? document.scrollingElement : list;
  const boxTop = box === list ? list.getBoundingClientRect().top : 0;
  const top = el.getBoundingClientRect().top - boxTop + box.scrollTop;
  smoothScroll(box, Math.max(0, top - 72));
  el.classList.remove("flash");
  void el.offsetWidth; // перезапуск анимации при повторном клике
  el.classList.add("flash");
  el.addEventListener("animationend", () => el.classList.remove("flash"), { once: true });
}

// «Ещё 2 комментария» — подпись кнопки раскрытия момента
function moreLabel(n) {
  return `Ещё ${n} ${plural(n, "комментарий", "комментария", "комментариев")}`;
}

// Клип вокруг момента: окно «Вырезать клип» открывается на странице видео
// с отрезком от 5 с до момента до 20 с после — там можно подвинуть края.
async function openClip(t) {
  const tab = await findActiveVideoTab();
  if (!tab?.id) {
    showToast("Не нашёл вкладку с видео.");
    return;
  }
  const dur = Number(state.meta?.duration) || Infinity;
  const start = Math.max(0, t - 5);
  const end = Math.min(dur, t + 20);
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: "yt:clip", start, end, videoId: state.videoId });
    if (!r?.ok) throw new Error("no clip");
    showToast(`Окно клипа открыто на странице видео · ${fmtTime(start)}–${fmtTime(end)}`);
  } catch (e) {
    showToast("Не получилось открыть клип — откройте вкладку с этим видео и обновите её (F5).");
  }
}

async function seekTo(t) {
  const tab = await findActiveVideoTab();
  if (!tab?.id) {
    showToast("Не нашёл вкладку с видео.");
    return;
  }
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: "yt:seek", t, videoId: state.videoId });
    if (!r?.ok) throw new Error("no video");
    showToast(`Перемотано на ${fmtTime(t)}`);
  } catch (e) {
    showToast("Не получилось перемотать — откройте вкладку с этим видео.");
  }
}

// ---------------- Темы ----------------

function topicCommentsHtml(name) {
  const s = state.summary;
  if (!s) return "";
  const topic = s.topics.find((t) => t.name === name);
  if (!topic) return "";
  const ids = new Set(topic.ids);
  const list = state.comments
    .filter((c, i) => ids.has(i))
    .sort((a, b) => (b.likes || 0) - (a.likes || 0))
    .slice(0, 20);
  if (!list.length) {
    return `<div class="placeholder">${
      state.summary?.fromHistory ? "Комментарии этой темы не попали в текущий сбор." : "Комментарии по теме не найдены."
    }</div>`;
  }
  const note =
    topic.count > list.length
      ? `<div class="hint topic-note">Самые характерные ${list.length} из ~${topic.count} — ИИ отмечает примеры, а не каждый комментарий темы.</div>`
      : "";
  return note + list.map((c) => commentCard(c)).join("");
}

function expandTopicInline(name) {
  expandedTopic = name;
  renderTopics();
}

function renderTopics() {
  const wrap = $("topics-list");
  const empty = $("topics-empty");
  const s = state.summary;
  if (!s?.topics?.length) {
    empty.classList.remove("hidden");
    wrap.innerHTML = "";
    return;
  }
  empty.classList.add("hidden");
  const maxCount = Math.max(1, ...s.topics.map((t) => t.count || 0));
  wrap.innerHTML = s.topics
    .map((t, i) => {
      const open = t.name === expandedTopic;
      return `<div class="topic-item${open ? " open" : ""}" data-idx="${i}" data-name="${esc(t.name)}">
           <button class="topic-head" aria-expanded="${open}">
             <span class="t-main">
               <span class="t-name">${esc(t.name)}</span>
               <span class="t-bar"><i style="width:${Math.round(((t.count || 0) / maxCount) * 100)}%"></i></span>
             </span>
             <span class="t-count">${t.count}</span>
             <span class="t-caret">${icon("chevron", { size: 14 })}</span>
           </button>
           <div class="collapse"><div class="collapse-inner"${open ? ' data-filled="1"' : ""}>${open ? topicCommentsHtml(t.name) : ""}</div></div>
         </div>`;
    })
    .join("");
  // Переключаем только по заголовку: раньше клик по комментарию внутри
  // раскрытой темы (или по ссылке в нём) сворачивал тему обратно. Список не
  // перерисовывается — меняется класс, и высота раскрывается плавно.
  wrap.querySelectorAll(".topic-item .topic-head").forEach((head) => {
    head.addEventListener("click", () => toggleTopic(head.parentElement));
  });
}

function toggleTopic(item) {
  const willOpen = !item.classList.contains("open");
  item.parentElement.querySelectorAll(".topic-item.open").forEach((o) => {
    if (o === item) return;
    o.classList.remove("open");
    o.querySelector(".topic-head").setAttribute("aria-expanded", "false");
  });
  if (willOpen) {
    const inner = item.querySelector(".collapse-inner");
    if (!inner.dataset.filled) {
      inner.innerHTML = topicCommentsHtml(item.dataset.name);
      inner.dataset.filled = "1";
    }
  }
  item.classList.toggle("open", willOpen);
  item.querySelector(".topic-head").setAttribute("aria-expanded", String(willOpen));
  expandedTopic = willOpen ? item.dataset.name : null;
}

// ---------------- Комментарии ----------------

function filteredComments() {
  let list = state.comments;
  const f = state.commentFilter;
  if (f === "new") list = list.filter((c) => state.newIds?.has(c.id));
  if (f === "questions") list = list.filter((c) => isQuestion(c.text));
  if (f === "timecodes") list = list.filter((c) => timecodesOf(c.text, maxSec()).length);
  const q = state.commentQuery.trim().toLowerCase();
  if (q) {
    const parts = queryParts(q);
    list = list.filter((c) => matchesQuery(c.text, parts) || (c.author || "").toLowerCase().includes(q));
  }
  if (f === "popular") list = [...list].sort((a, b) => (b.likes || 0) - (a.likes || 0));
  if (f === "replies") list = list.filter((c) => c.replies > 0).sort((a, b) => b.replies - a.replies);
  return list;
}

function setCommentFilter(filter, query = null) {
  state.commentFilter = filter;
  if (query !== null) {
    state.commentQuery = query;
    $("comments-filter").value = query;
  }
  state.commentLimit = COMMENTS_PAGE;
  renderComments();
}

// Рендерим порциями: 2000 карточек разом заметно подвешивали панель.
function renderComments() {
  const wrap = $("comments-list");
  const list = filteredComments();
  const labels = { all: "", new: " · новые с прошлой сводки", popular: " · по лайкам", replies: " · по числу ответов", questions: " · вопросы", timecodes: " · с таймкодами" };
  const newChip = document.querySelector('#comments-chips [data-filter="new"]');
  const nNew = state.newIds?.size || 0;
  newChip.classList.toggle("hidden", !nNew);
  newChip.textContent = `Новые · ${nNew}`;
  $("comments-count").textContent = state.comments.length
    ? `${list.length} из ${state.comments.length}${labels[state.commentFilter] || ""}`
    : "";
  document.querySelectorAll("#comments-chips .chip").forEach((b) => {
    b.classList.toggle("active", b.dataset.filter === state.commentFilter);
  });
  const more = $("btn-more-comments");
  if (!list.length) {
    wrap.innerHTML = state.comments.length
      ? `<div class="placeholder">Ничего не нашлось — смените фильтр или текст поиска.</div>`
      : noCommentsEmpty("Комментариев пока нет", "Они появятся здесь, когда закончится сбор.");
    more.classList.add("hidden");
    return;
  }
  const shown = list.slice(0, state.commentLimit);
  wrap.innerHTML = shown.map((c) => commentCard(c, { query: state.commentQuery })).join("");
  const rest = list.length - shown.length;
  more.textContent = `Показать ещё ${Math.min(rest, COMMENTS_PAGE)} (осталось ${rest})`;
  more.classList.toggle("hidden", rest <= 0);
}

// ---------------- Поиск ----------------

let globalSearchResults = [];

// Пояснение к режимам — три строки во всю ширину; по строке можно нажать
const MODE_HELP = `<div class="mode-help">${[
  ["text", "Текст", "Мгновенно найдёт слово или фразу"],
  ["ai", "Смысл (ИИ)", "Найдёт комментарии на ту же тему, даже другими словами"],
  ["ask", "Вопрос (ИИ)", "Ответит, что думают зрители"],
]
  .map(([v, t, d]) => `<button class="mode-help-row" data-mode="${v}"><b>${t}</b><span>${d}</span></button>`)
  .join("")}</div>`;

function renderSearchResults() {
  const wrap = $("search-results");
  const info = $("search-info");
  const answer = $("search-answer");
  const r = globalSearchResults || {};
  const items = r.items || [];
  if (r.answer) {
    answer.innerHTML = `<div class="answer-label">Ответ по комментариям</div>${esc(r.answer)}`;
    answer.classList.remove("hidden");
  } else {
    answer.classList.add("hidden");
  }
  info.textContent = r.info || "";
  info.classList.toggle("err", Boolean(r.error));
  if (!items.length) {
    wrap.innerHTML = r.info
      ? ""
      : state.comments.length
        ? MODE_HELP
        : noCommentsEmpty("Поиск заработает после сбора", "Когда комментарии соберутся, по ним можно будет искать и задавать вопросы.");
    return;
  }
  wrap.innerHTML = items.map((c) => commentCard(c, { query: r.mode === "text" ? r.query : "" })).join("");
}

let searchSeq = 0;

async function runSearch() {
  const q = $("search-input").value.trim();
  if (!q || !state.comments.length) return;
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const seq = ++searchSeq;
  const vid = state.videoId; // ответ ИИ показываем только для того же видео
  $("btn-search").disabled = true;
  try {
    if (mode === "text") {
      const parts = queryParts(q);
      const items = state.comments.filter((c) => matchesQuery(c.text, parts));
      globalSearchResults = {
        mode,
        query: q,
        items: items.slice(0, 100),
        info: items.length ? `Нашлось: ${items.length}${items.length > 100 ? " (показаны первые 100)" : ""}` : "Ничего не нашлось. Попробуйте поиск по смыслу.",
      };
    } else {
      if (!proxy.configured) {
        showToast("Заполни настройки сервера (URL, секрет, модель).");
        setTab("settings");
        return;
      }
      // Под бюджет бесплатного Groq: сначала комментарии со словами запроса,
      // затем самые залайканные — сколько влезет в ~3.5 тыс. токенов.
      const picked = pickForBudget(state.comments, q, { maxTokens: 3500 });
      const subset = picked.map((p) => p.c);
      const ask = mode === "ask";
      globalSearchResults = { mode, query: q, items: [], info: ask ? "Думаю над ответом…" : "Ищу по смыслу…" };
      renderSearchResults();
      const sys = ask ? ASK_SYSTEM : SEARCH_SYSTEM;
      const user = ask ? askUser(q, subset) : searchUser(q, subset);
      const slot = await paceRequest(estimateRequestTokens(sys, user), 300, (sec) => {
        $("search-info").textContent = `Жду окно бесплатного лимита Groq: ~${sec} с…`;
      });
      const raw = await proxy.chat(
        [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        { jsonMode: true, maxTokens: 500, timeoutMs: 120000 }
      );
      settleOutput(slot, raw);
      if (seq !== searchSeq || vid !== state.videoId) return; // новый поиск или другое видео
      const data = extractJson(raw);
      const ids = [...new Set((Array.isArray(data?.ids) ? data.ids : []).map(Number).filter(Number.isFinite))];
      const items = ids.map((i) => subset[i]).filter(Boolean);
      const scope =
        subset.length < state.comments.length ? ` (ИИ смотрел ${subset.length} из ${state.comments.length} самых подходящих)` : "";
      globalSearchResults = ask
        ? {
            mode,
            query: q,
            answer: normalizeSummary(data?.answer || "", 700) || "Модель не дала ответа — попробуйте переформулировать вопрос.",
            items,
            info: items.length ? `На чём основан ответ: ${items.length} комм.${scope}` : scope.trim(),
          }
        : {
            mode,
            query: q,
            items,
            info: (items.length ? `Нашлось по смыслу: ${items.length}` : "По смыслу ничего не нашлось") + (data?.why ? ` — ${clean(data.why)}` : "") + scope,
          };
    }
  } catch (e) {
    if (seq !== searchSeq || vid !== state.videoId) return;
    globalSearchResults = { mode, query: q, items: [], error: true, info: friendlyError(e) };
  } finally {
    if (seq === searchSeq) {
      $("btn-search").disabled = false;
      if (vid === state.videoId) renderSearchResults();
    }
  }
}

// ---------------- Превью и канал ----------------

// Имя файла превью по шаблону из настроек — одно для панели и страницы превью.
function thumbFilename(m) {
  const tpl = state.settings?.thumbTemplate || "{title} - {channel}";
  const name = tpl
    .replaceAll("{title}", sanitizeFilename(m.title || "video"))
    .replaceAll("{channel}", sanitizeFilename(m.channelName || "channel"))
    .replaceAll("{videoid}", m.videoId || "");
  return sanitizeFilename(name) + ".jpg";
}

function thumbUrls(m) {
  return [m?.thumbs?.maxres, m?.thumbs?.sd, m?.thumbs?.hq].filter(Boolean);
}

// Превью открывается поверх страницы видео; если вкладка не отвечает —
// отдельной вкладкой, как раньше.
async function openThumbTab() {
  const m = state.meta;
  const urls = thumbUrls(m);
  if (!urls.length) return;
  try {
    const tab = await findActiveVideoTab();
    if (tab?.id) {
      const r = await chrome.tabs.sendMessage(tab.id, { type: "yt:preview", urls, title: m.title || "", name: thumbFilename(m) });
      if (r?.ok) return;
    }
  } catch (e) {
    /* ниже — вкладка */
  }
  const page = chrome.runtime.getURL("sidepanel/preview.html");
  const qs = new URLSearchParams({ urls: urls.join(","), title: m.title || "", name: thumbFilename(m) });
  chrome.tabs.create({ url: `${page}?${qs}` });
}

// Лучшее доступное превью. У многих видео нет maxresdefault: YouTube отвечает
// 404, но с серой картинкой-заглушкой 120×90 — раньше её и скачивали.
async function fetchBestThumb(urls) {
  for (const url of urls) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const blob = await resp.blob();
      if (blob.size < 2000) continue; // заглушка
      return blob;
    } catch (e) {
      /* пробуем следующее качество */
    }
  }
  throw new Error("превью недоступно");
}

async function downloadThumb() {
  if (!state.meta) return;
  const m = state.meta;
  const urls = thumbUrls(m);
  if (!urls.length) return;
  try {
    const blob = await fetchBestThumb(urls);
    const dataUrl = await blobToDataURL(blob);
    const filename = thumbFilename(m);
    showToast(`Скачиваю превью: ${filename}`);
    await chrome.downloads.download({
      url: dataUrl,
      filename,
      conflictAction: "uniquify",
      saveAs: false,
    });
  } catch (e) {
    showToast("Не удалось скачать превью: " + (e.message || e));
  }
}

// Удалён функционал скачивания видео (SABR/403 в 2026 делает прямое скачивание
// невозможным без локального yt-dlp; серверный yt-dlp с Render не справляется
// из-за ботозащиты YouTube). Сохраняем только скачивание превью (downloadThumb).

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

// Всплывающее уведомление внизу панели. Раньше подсказки писались в строку
// статуса сбора и затирали её.
let toastTimer = null;
function showToast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), Math.min(7000, 2200 + text.length * 35));
}

// ---------------- События от контент-скрипта ----------------

function onRuntimeMessage(msg, sender) {
  if (!msg || typeof msg.type !== "string") return;
  if (!msg.type.startsWith("yt:")) return;
  if (sender?.tab?.id != null && state.tabId != null && sender.tab.id !== state.tabId) return;
  if (msg.type === "yt:meta") {
    // в той же вкладке открыли другое видео (переход внутри YouTube) — переключаемся
    if (state.videoId && msg.meta?.videoId && msg.meta.videoId !== state.videoId) {
      void loadFor(msg.meta.videoId);
      return;
    }
    if (!state.videoId) {
      // после ухода на главную открыли видео — полноценная загрузка, а не только шапка
      if (msg.meta?.videoId) void loadFor(msg.meta.videoId);
      return;
    } else if (msg.meta.videoId === state.videoId) {
      const durChanged = msg.meta.duration && msg.meta.duration !== state.meta?.duration;
      state.meta = msg.meta;
      // длительность фильтрует таймкоды и задаёт шкалу моментов
      if (durChanged) {
        renderInsights();
        renderMoments();
      }
    }
    renderHeader();
  } else if (msg.type === "yt:progress") {
    if (msg.videoId && state.videoId && msg.videoId !== state.videoId) return;
    updateCollectStatus(msg.status, msg.fetched, msg.max, msg.error || null, msg.stopped);
  } else if (msg.type === "yt:ready") {
    if (msg.videoId && state.videoId && msg.videoId !== state.videoId) return;
    void loadFor(state.videoId || msg.videoId);
  } else if (msg.type === "yt:away") {
    if (!state.videoId) return;
    detachAnalysis();
    state.videoId = null;
    state.meta = null;
    state.summary = null;
    state.comments = [];
    state.activeTopic = null;
    expandedTopic = null;
    globalSearchResults = [];
    renderBottomMatters();
    renderAll();
  }
}

// Ищем активную вкладку с видео YouTube. currentWindow НЕ годится: если side
// panel открыт в отдельном окне, «текущее окно» — это окно панели
// (chrome-extension://…), и видео не находится. Поэтому перебираем все обычные
// окна и берём активную вкладку с /watch|/shorts.
async function findActiveVideoTab() {
  const YT = { test: isVideoUrl };
  const pool = [];
  let wins = [];
  try {
    wins = await chrome.windows.getAll({ populate: true });
    for (const w of wins || []) for (const t of w.tabs || []) pool.push(t);
  } catch (e) {
    /* windows API недоступен — соберём вкладки иначе */
  }
  try {
    const all = await chrome.tabs.query({});
    for (const t of all || []) if (!pool.some((p) => p.id === t.id)) pool.push(t);
  } catch (e) {
    /* игнорируем */
  }

  // Сначала активная вкладка ТЕКУЩЕГО окна (где открыта панель), потом других.
  try {
    const cur = await chrome.windows.getCurrent();
    wins = [...(wins || [])].sort((a, b) => (b.id === cur?.id) - (a.id === cur?.id));
  } catch (e) {
    /* порядок как есть */
  }
  for (const w of wins || []) {
    const active = (w.tabs || []).find((t) => t.active);
    if (active && YT.test(active.url || "")) return active;
  }
  // Затем любая вкладка с видео: панель могли открыть, переключившись на другую
  // вкладку, или YouTube открыт в фоновой вкладке/окне. Раньше в этом случае
  // панель молча показывала заглушку «видео не найдено».
  const any = pool.filter((t) => YT.test(t.url || ""));
  if (any.length) {
    const activeFirst = any.find((t) => t.active);
    return activeFirst || any.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  }
  return pool.find((t) => t.active) || pool[0] || null;
}

// Нет комментариев: идёт сбор, сбор не удался или их у видео нет.
// loading — заголовок и текст для вкладки, пока сбор идёт.
function noCommentsEmpty(loadingTitle, loadingText) {
  const st = state.collect?.status;
  if (st === "error")
    return viewEmpty(
      "close",
      "Комментарии не собрались",
      "Причина написана над вкладками. Попробуйте собрать ещё раз.",
      `<button class="primary empty-cta wide" data-restart-collect>Собрать заново</button>`
    );
  if (st === "done" && !state.collect.fetched) return viewEmpty("chat", "Комментариев нет", "У этого видео нет комментариев или они отключены.");
  return viewEmpty("clock", loadingTitle, loadingText);
}

// Пустая вкладка: иконка в круге, заголовок, пояснение — как «Темы» и «Моменты».
function viewEmpty(iconName, title, text, extra = "") {
  return `<div class="view-empty"><div class="empty-icon small">${icon(iconName, { size: 22 })}</div>
    <div class="empty-title">${esc(title)}</div><div class="empty-text">${esc(text)}</div>${extra}</div>`;
}

// «Собрать заново» из пустой вкладки — та же кнопка, что ⟳ рядом с лимитом
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-restart-collect]")) $("btn-restart").click();
});

// Пустой экран: иконка в круге, заголовок, пояснение и, при нужде, кнопка.
function setEmptyState(iconName, title, text, extra = "") {
  $("empty-state").innerHTML = `
    <div class="empty-icon">${icon(iconName, { size: 28 })}</div>
    <div class="empty-title">${esc(title)}</div>
    <div class="empty-text">${esc(text)}</div>
    ${extra ? `<div class="empty-extra">${extra}</div>` : ""}`;
}

async function refreshFromActiveTab() {
  const tab = await findActiveVideoTab();
  // вкладка, за которой следит панель: сообщения от других вкладок YouTube
  // (канал в фоне, другое окно) не должны сбрасывать панель
  state.tabId = tab?.id ?? null;
  if (!tab?.id || !isVideoUrl(tab.url)) {
    renderBottomMatters();
    if (tab?.url && /youtube\.com/i.test(tab.url)) {
      setEmptyState("chat", "Откройте видео", "Это YouTube, но не страница видео. Откройте ролик или Shorts — комментарии соберутся сами.");
    } else {
      setEmptyState("chat", "Откройте видео на YouTube", "Комментарии соберутся автоматически, а здесь появятся обзор, моменты и сводка.");
    }
    return;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: "yt:meta-query" });
      if (reply?.videoId) {
        await loadFor(reply.videoId);
        if (reply.meta && state.videoId === reply.videoId) {
          state.meta = reply.meta;
          await safeSessionSet({ [`meta:${reply.videoId}`]: reply.meta }, { keepVideoId: reply.videoId });
          renderHeader();
        }
        return;
      }
    } catch (e) {
      // контент-скрипт ещё не инициализирован — пробуем ещё пару раз
      await sleep(700);
    }
  }
  // контент-скрипт так и не ответил: расширение установлено/обновлено после открытия вкладки
  renderBottomMatters();
  setEmptyState(
    "refresh",
    "Обновите страницу видео",
    "Расширение установлено или обновлено после того, как вкладка открылась. Перезагрузите её — сбор начнётся сам.",
    `<button id="btn-reload-tab" class="primary">${icon("refresh", { size: 14 })}Перезагрузить вкладку</button>`
  );
  $("empty-state").classList.remove("hidden");
  $("btn-reload-tab")?.addEventListener("click", async () => {
    try {
      await chrome.tabs.reload(tab.id);
    } catch (e) {
      /* ignore */
    }
  });
}

// ---------------- Инициализация ----------------

function bindEvents() {
  document.querySelectorAll(".tab[data-tab]").forEach((b) => {
    b.addEventListener("click", () => setTab(b.dataset.tab));
  });
  // Стрелки ← → / Home / End переключают вкладки, когда фокус на вкладке.
  $("tabs").addEventListener("keydown", (e) => {
    const tabs = [...document.querySelectorAll(".tab[data-tab]")];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (j === undefined) return;
    e.preventDefault();
    const t = tabs[(j + tabs.length) % tabs.length];
    setTab(t.dataset.tab);
    t.focus();
  });
  $("btn-settings").addEventListener("click", () => {
    fillSettingsFields();
    setTab("settings");
  });
  $("btn-settings-close").addEventListener("click", () => {
    flushAutoSave();
    setTab("summary");
  });
  async function openLibraryFromPanel() {
    const { libraryWhere } = await chrome.storage.local.get("libraryWhere");
    if (libraryWhere === "panel") return showLibraryPane({});
    await chrome.runtime.sendMessage({ type: "lib:open" }).catch(() => {});
    // библиотека — во всю вкладку; панель справа больше не нужна и не занимает место
    window.close();
  }
  $("btn-open-library").addEventListener("click", openLibraryFromPanel);
  $("btn-lib").addEventListener("click", openLibraryFromPanel);
  // библиотеку попросили показать здесь (меню плеера, правый клик, клавиша)
  chrome.storage.session.get("panelLibrary").then(({ panelLibrary }) => {
    if (panelLibrary && Date.now() - panelLibrary.at < 15000) showLibraryPane(panelLibrary);
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "session" && ch.panelLibrary?.newValue) showLibraryPane(ch.panelLibrary.newValue);
  });
  // из библиотеки: «Назад» — вернуться к сводке, «Во вкладку» — закрыть панель
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || !e.data?.ytcsLib) return;
    if (e.data.ytcsLib === "back") hideLibraryPane();
    if (e.data.ytcsLib === "tab") window.close();
  });
  function showLibraryPane({ q = "", view = "" } = {}) {
    const pane = $("lib-pane");
    const h = new URLSearchParams();
    if (view) h.set("v", view);
    if (q) h.set("q", q);
    const src = `../library/library.html?panel=1${String(h) ? `#${h}` : ""}`;
    let frame = pane.querySelector("iframe");
    if (!frame) {
      frame = document.createElement("iframe");
      frame.title = "Моя библиотека";
      frame.src = src;
      pane.appendChild(frame);
    } else if (String(h)) frame.contentWindow.location.hash = String(h);
    pane.hidden = false;
    chrome.storage.session.remove("panelLibrary").catch(() => {});
  }
  function hideLibraryPane() {
    $("lib-pane").hidden = true;
  }
  $("btn-open-settings").addEventListener("click", () => {
    fillSettingsFields();
    setTab("settings");
  });
  $("btn-restart").addEventListener("click", async () => {
    if (!state.videoId) return;
    cancelAnalysis("Анализ прерван: комментарии собираются заново.");
    const quick = parseInt($("quick-max").value, 10);
    if (Number.isFinite(quick)) {
      const v = Math.min(2000, Math.max(10, quick));
      state.settings.maxComments = v;
      $("set-max").value = v;
      $("quick-max").value = v;
      await saveSettings(false);
    }
    await chrome.storage.session.remove([`comments:${state.videoId}`, `summary:${state.videoId}`, `collect:${state.videoId}`]);
    state.comments = [];
    state.summary = null;
    state.commentLimit = COMMENTS_PAGE;
    renderAll();
    const tab = await findActiveVideoTab();
    if (tab?.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "yt:start-collect" });
      } catch (e) {
        showToast("Не получилось связаться со страницей — обновите вкладку с видео (F5).");
      }
    }
  });
  $("btn-download-thumb").addEventListener("click", downloadThumb);
  $("btn-view-thumb").addEventListener("click", openThumbTab);
  $("quick-max").addEventListener("change", async (e) => {
    let v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v)) v = DEFAULTS.maxComments;
    v = Math.min(2000, Math.max(10, v));
    e.target.value = v;
    state.settings.maxComments = v;
    $("set-max").value = v;
    await saveSettings(false);
    showToast(`Лимит сбора: ${v} комментариев. Нажмите «Собрать заново», чтобы применить.`);
    const c = state.collect || {};
    updateCollectStatus(c.status, c.fetched, c.max, c.error, c.stopped);
  });
  $("btn-analyze").addEventListener("click", () => {
    const quick = parseInt($("quick-max").value, 10);
    if (Number.isFinite(quick)) {
      state.settings.maxComments = Math.min(2000, Math.max(10, quick));
      $("set-max").value = state.settings.maxComments;
      // сохраняем только лимит — недосохранённые правки в настройках не трогаем
      void chrome.storage.local
        .set({ settings: { ...state.settings } })
        .catch(() => {})
        .then(() => analyze());
    } else {
      analyze();
    }
  });
  $("summary-topics").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip?.dataset.topic) return;
    expandTopicInline(chip.dataset.topic);
    setTab("topics");
  });
  $("btn-copy-summary").addEventListener("click", async () => {
    const s = state.summary;
    if (!s) return;
    const lines = [
      s.summary || "",
      "",
      "Темы:",
      ...(s.topics || []).map((t) => `• ${t.name} (${t.count})`),
      "",
      "Ключевые мнения:",
      ...(s.points || []).map((p, i) => `${i + 1}. ${p}`),
    ];
    if (s.notable?.length) {
      lines.push("", "Яркие комментарии:", ...s.notable.map((c) => `• ${c.author}: ${c.text}`));
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      showToast("Сводка скопирована текстом");
    } catch (e) {
      showToast("Не удалось скопировать: " + (e.message || e));
    }
  });
  // Сводка картинкой: PNG в буфер (вставить в Telegram — Ctrl+V); если буфер
  // недоступен — скачиваем файлом.
  $("btn-image-summary").addEventListener("click", async () => {
    const s = state.summary;
    if (!s) return;
    const btn = $("btn-image-summary");
    btn.disabled = true;
    let png;
    try {
      png = await renderSummaryCard(s, state.meta);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      showToast("Картинка со сводкой в буфере — вставьте в чат через Ctrl+V");
    } catch (e) {
      try {
        if (!png) throw e;
        const url = await blobToDataURL(png);
        const name = `${sanitizeFilename(state.meta?.title || state.videoId || "сводка")} — сводка.png`;
        await chrome.downloads.download({ url, filename: name, saveAs: false, conflictAction: "uniquify" });
        showToast("Буфер недоступен — картинка сохранена в загрузки");
      } catch (e2) {
        showToast("Не удалось сделать картинку: " + (e2.message || e2));
      }
    } finally {
      btn.disabled = false;
    }
  });
  $("btn-export-summary").addEventListener("click", async () => {
    const s = state.summary;
    if (!s) return;
    const m = state.meta || {};
    const lines = [
      `# Сводка: ${m.title || state.videoId || "видео"}`,
      "",
      s.summary || "",
      "",
      "## Темы",
      ...(s.topics || []).map((t) => `- ${t.name}: ${t.count}`),
      "",
      "## Ключевые мнения",
      ...(s.points || []).map((p, i) => `${i + 1}. ${p}`),
    ];
    if (s.notable?.length) {
      lines.push("", "## Яркие комментарии", ...s.notable.map((c) => `- ${c.author}: ${c.text}`));
    }
    const moments = allMoments().slice(0, 5);
    if (moments.length && state.videoId) {
      lines.push(
        "",
        "## Популярные моменты",
        ...moments.map((mo) => `- [${mo.label}](https://youtu.be/${state.videoId}?t=${mo.t}) — ${mo.count} комм.`)
      );
    }
    if (m.pageUrl) lines.push("", `Видео: ${m.pageUrl}`);
    const markdown = lines.join("\n");
    try {
      const blob = new Blob([markdown], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const filename = `${sanitizeFilename(m.title || state.videoId || "video")}.md`;
      await chrome.downloads.download({ url, filename, saveAs: true });
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      showToast("Не удалось сохранить: " + (e.message || e));
    }
  });
  $("comments-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip[data-filter]");
    if (chip) setCommentFilter(chip.dataset.filter);
  });
  let filterTimer = null;
  $("comments-filter").addEventListener("input", (e) => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      state.commentQuery = e.target.value;
      state.commentLimit = COMMENTS_PAGE;
      renderComments();
    }, 120);
  });
  $("bg-run").addEventListener("click", (e) => {
    if (e.target.closest("[data-bg-cancel]")) cancelBgRun();
  });
  $("btn-more-comments").addEventListener("click", () => {
    state.commentLimit += COMMENTS_PAGE;
    renderComments();
  });
  $("moments-sort").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sort]");
    if (!b || b.dataset.sort === state.momentsSort) return;
    state.momentsSort = b.dataset.sort;
    void chrome.storage.local.set({ "ui:momentsSort": state.momentsSort }).catch(() => {});
    renderMoments();
  });
  $("btn-moments-all").addEventListener("click", () => {
    state.momentsAll = true;
    renderMoments();
  });
  // Делегирование на всю панель: таймкоды (перемотка), переходы из «Обзора».
  $("content").addEventListener("click", (e) => {
    const mt = e.target.closest(".more-text");
    if (mt) {
      const txt = mt.previousElementSibling;
      const open = txt.classList.toggle("clamp") === false;
      mt.textContent = open ? "Свернуть" : "Показать полностью";
      return;
    }
    const seg = e.target.closest(".sent-seg");
    if (seg) {
      toggleSentiment(seg.dataset.sent);
      return;
    }
    const rt = e.target.closest(".reply-toggle");
    if (rt) {
      void toggleReplies(rt);
      return;
    }
    const mr = e.target.closest(".more-replies");
    if (mr) {
      void loadMoreReplies(mr);
      return;
    }
    const more = e.target.closest(".more-toggle");
    if (more) {
      const m = more.closest(".moment");
      // остальные комментарии момента рисуем только при первом раскрытии —
      // на тысячах комментариев вкладка открывается в разы быстрее
      const inner = m.querySelector(".collapse-inner[data-idx]");
      if (inner && !inner.dataset.filled) {
        inner.dataset.filled = "1";
        inner.innerHTML = inner.dataset.idx
          .split(",")
          .map((i) => state.comments[Number(i)])
          .filter(Boolean)
          .map((c) => commentCard(c, { compact: true }))
          .join("");
      }
      const open = m.classList.toggle("open");
      more.querySelector("span").textContent = open ? "Свернуть" : moreLabel(Number(more.dataset.more));
      return;
    }
    const clipBtn = e.target.closest("[data-clip]");
    if (clipBtn) {
      void openClip(Number(clipBtn.dataset.clip));
      return;
    }
    const tc = e.target.closest("[data-t]");
    if (tc) {
      e.preventDefault();
      void seekTo(Number(tc.dataset.t));
      // точка на общем таймлайне или строка в обзоре — ещё и к комментариям момента
      const mt = tc.dataset.moment;
      const inMoment = tc.closest(".moment");
      if (mt != null && !inMoment) {
        if (currentTab !== "moments") setTab("moments");
        revealMoment(mt, { expand: true });
      } else if (inMoment && tc.closest(".moment-head") && !inMoment.classList.contains("open")) {
        // таймкод момента — сразу показываем все его комментарии
        inMoment.querySelector(".more-toggle")?.click();
      }
      return;
    }
    const goto = e.target.closest("[data-goto]");
    if (goto) {
      setTab(goto.dataset.goto);
      return;
    }
    const gf = e.target.closest("[data-goto-filter]");
    if (gf) {
      setCommentFilter(gf.dataset.gotoFilter, "");
      setTab("comments");
      return;
    }
    const word = e.target.closest("[data-word]");
    if (word) {
      setCommentFilter("popular", word.dataset.word);
      setTab("comments");
    }
  });
  $("search-results").addEventListener("click", (e) => {
    const row = e.target.closest(".mode-help-row");
    if (!row) return;
    const r = document.querySelector(`input[name="mode"][value="${row.dataset.mode}"]`);
    r.checked = true;
    r.dispatchEvent(new Event("change"));
    $("search-input").focus();
  });
  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => {
      const ph = { text: "Слово или фраза…", ai: "Тема или мнение…", ask: "Свой вопрос — или выберите готовый ниже" };
      $("search-input").placeholder = ph[r.value] || "";
      $("btn-search").textContent = r.value === "ask" ? "Спросить" : "Найти";
      $("ask-suggest").classList.toggle("hidden", r.value !== "ask");
    })
  );
  $("btn-clear-history").addEventListener("click", async () => {
    const n = await clearHistory();
    $("history-status").textContent = n ? `Удалено сводок: ${n}` : "История пуста";
    void renderHistoryList();
    if (state.summary?.fromHistory) {
      state.summary = null;
      renderSummary();
      renderTopics();
    }
  });
  $("btn-search").addEventListener("click", runSearch);
  $("btn-cancel-analyze").addEventListener("click", () => {
    cancelAnalysis("Анализ отменён");
    renderSummary();
  });
  $("set-order").addEventListener("change", async () => {
    await saveSettings(false);
    showToast("Порядок сбора изменён — нажмите «Собрать заново», чтобы применить");
  });
  $("btn-topics-analyze").addEventListener("click", () => $("btn-analyze").click());
  // chrome:// нельзя открыть обычной ссылкой — открываем вкладкой через API
  $("btn-shortcuts").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
  $("btn-cta-settings").addEventListener("click", () => {
    fillSettingsFields();
    setTab("settings");
    $("set-base-url").focus();
  });
  $("ask-suggest").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ask]");
    if (!b) return;
    $("search-input").value = b.dataset.ask;
    document.querySelector('input[name="mode"][value="ask"]').checked = true;
    void runSearch();
  });
  // Переключатели плеера применяются сразу: контент-скрипт слушает storage.
  for (const [id, on, off] of [
    ["set-no-autoplay", "Видео больше не будут запускаться сами", "Автозапуск видео снова как обычно"],
    ["set-hide-progress", "Полоса прогресса и длительность скрыты", "Полоса прогресса снова видна"],
  ]) {
    $(id).addEventListener("change", async (e) => {
      await saveSettings(false);
      showToast(e.target.checked ? on : off);
    });
  }
  // Горячие клавиши: 1–5 — вкладки, / — поиск, Esc — убрать фокус из поля.
  // Не мешают вводу: в полях и с модификаторами не срабатывают.
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
    if (typing) {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    if (!state.videoId) return;
    const tabs = ["summary", "video", "moments", "topics", "search", "comments"];
    const n = Number(e.key);
    if (n >= 1 && n <= tabs.length) {
      setTab(tabs[n - 1]);
      e.preventDefault();
    } else if (e.key === "/" || e.key === ".") {
      setTab("search");
      $("search-input").focus();
      e.preventDefault();
    }
  });
  $("search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  // Кнопки «Сохранить» нет: списки и числа сохраняются сразу, текстовые поля — через
  // полсекунды после ввода (и при уходе из поля). Переключатели сохраняются своими обработчиками.
  for (const id of ["set-max", "set-lang", "set-theme", "set-mode", "set-thumb-template", "set-base-url", "set-token", "set-model"]) {
    const el = $(id);
    if (el.tagName === "INPUT") el.addEventListener("input", () => scheduleAutoSave());
    el.addEventListener("change", () => scheduleAutoSave(0));
  }
  addEventListener("pagehide", flushAutoSave);
  $("btn-test").addEventListener("click", async () => {
    const el = $("test-result");
    el.textContent = "…";
    el.className = "";
    await saveSettings(false);
    try {
      const ok = await proxy.test();
      let diag = ok ? "Связь есть" : "Ответ пустой";
      diag += ` | v${chrome.runtime.getManifest().version}`;
      diag += ` · модель ${state.settings.model || "?"}`;
      el.textContent = diag;
      el.className = ok ? "ok" : "err";
    } catch (e) {
      el.textContent = (e.message || "Ошибка");
      el.className = "err";
    }
  });
  chrome.tabs.onActivated.addListener(refreshFromActiveTab);
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (info.status === "complete") return void refreshFromActiveTab();
    // в библиотеке видео меняется без перезагрузки (меняется только #w=…)
    if (info.url && (id === state.tabId || String(info.url).startsWith(LIBRARY_PAGE))) {
      clearTimeout(state.libRefreshTimer);
      state.libRefreshTimer = setTimeout(refreshFromActiveTab, 900); // плееру нужно мгновение, чтобы загрузиться
    }
  });
  window.addEventListener("focus", refreshFromActiveTab);
  window.addEventListener("focus", () => void wakeServer());
}

function showFatal(message, detail) {
  // Раньше любая ошибка инициализации уходила только в консоль, а панель
  // оставалась на статической заглушке — пользователь не понимал, что делать.
  const el = $("empty-state");
  if (el) {
    el.classList.remove("hidden");
    setEmptyState(
      "close",
      "Панель не запустилась",
      `${message} Обновите расширение на chrome://extensions и перезагрузите страницу видео (F5).`,
      detail ? `<div class="hint">${esc(String(detail).slice(0, 300))}</div>` : ""
    );
  }
  console.error("sidepanel:", message, detail);
}

async function main() {
  await loadSettings();
  fillSettingsFields();
  proxy.baseUrl = state.settings.baseUrl;
  proxy.token = state.settings.token;
  proxy.model = state.settings.model;
  bindEvents();
  initSelfCheckUI({
    // секрет может жить только в local-config.js — фон его не видит, передаём
    getServer: () => ({ baseUrl: state.settings.baseUrl, token: state.settings.token, model: state.settings.model }),
    openSettings: () => {
      fillSettingsFields();
      setTab("settings");
    },
  });
  // «О видео»: пересказ по субтитрам — общий с анализом клиент и бюджет лимитов Groq
  initVideoTldr({
    proxy,
    getState: () => state,
    pacer,
    friendlyError,
    findActiveVideoTab,
    seekTo,
    showToast,
    setTab,
    esc,
  });
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  // Переключатели плеера могут поменять из контекстного меню — держим панель
  // в курсе, иначе следующее «Сохранить» вернуло бы старые значения.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings?.newValue) return;
    const nv = changes.settings.newValue;
    for (const key of ["noAutoplay", "hideProgress"]) state.settings[key] = Boolean(nv[key]);
    // пропуск рекламных вставок ведёт sponsor-settings.js — только не затираем
    for (const key of ["sponsorSkip", "sponsorCats"]) state.settings[key] = nv[key];
    state.settings.channelSpeed = nv.channelSpeed; // скорость по каналам — channel-speed.js
    // «Без отвлечений» ведёт focus-settings.js — тоже только не затираем
    for (const key of Object.keys(nv)) if (key.startsWith("focus")) state.settings[key] = nv[key];
    $("set-no-autoplay").checked = Boolean(nv.noAutoplay);
    $("set-hide-progress").checked = Boolean(nv.hideProgress);
  });
  void wakeServer();
  await refreshFromActiveTab();
  // Возвращаемся на вкладку, открытую в прошлый раз (кроме настроек).
  try {
    const ms = (await chrome.storage.local.get("ui:momentsSort"))["ui:momentsSort"];
    if (ms === "time" || ms === "top") state.momentsSort = ms;
    const saved = (await chrome.storage.local.get("ui:tab"))["ui:tab"];
    if (saved && saved !== "summary" && saved !== "settings" && $("view-" + saved)) setTab(saved);
  } catch (e) {
    /* не критично */
  }
}

// Страховка: если init завис (например, на storage), панель не должна молчать
// вечной заглушкой — показываем, что истекло время.
const _initWatchdog = setTimeout(() => {
  const el = $("empty-state");
  if (state.videoId) return; // видео уже найдено — панель в работе, не мешаем
  if (el && !el.classList.contains("hidden") && el.textContent.includes("Откройте видео")) {
    showFatal(
      "Панель не успела загрузиться за 6 секунд.",
      "Вероятнее всего, вкладка YouTube открыта до обновления расширения — её контент-скрипт устарел."
    );
  }
}, 6000);

main()
  .then(() => clearTimeout(_initWatchdog))
  .catch((e) => {
    clearTimeout(_initWatchdog);
    showFatal("Ошибка при запуске панели.", e?.message || e);
  });