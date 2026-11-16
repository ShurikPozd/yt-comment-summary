import {
  GroqProxy,
  extractJson,
  clean,
  sanitizeFilename,
  sleep,
  normalizeSummary,
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
} from "./insights.js";
import { DEFAULTS } from "../config.js";

const LOCAL_CONFIG =
  (typeof window !== "undefined" && window.__EXT_LOCAL_CONFIG__) || {};

const $ = (id) => document.getElementById(id);

// Страница с видео на YouTube. Раньше регулярка требовала обязательный префикс
// www./m. и знала только /watch и /shorts — из-за этого валидная вкладка могла
// не найтись и панель молча показывала «видео не найдено».
const YT_VIDEO_RE = /^https:\/\/([a-z0-9-]+\.)*youtube\.com\/(watch|shorts|live)(\/|[?#]|$)/i;

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

// Скользящий бюджет: учитываем как входные (ITPM), так и выходные (OTPM) токены.
const _budgetLogIn = []; // { t: Date.now(), n: входные }
const _budgetLogOut = []; // { t: Date.now(), n: выходные }
let _lastRequestAt = 0;

// Резерв выходных токенов делается «с запасом» до ответа; после ответа меняем
// его на фактический размер (у бота reasoning_effort=none, скрытых токенов нет).
// Иначе следующие части ждали окно, которое на деле давно свободно.
// ~2.5 символа на токен — с запасом для кириллицы в JSON.
function settleOutput(slot, text) {
  if (slot) slot.n = Math.max(40, Math.ceil(String(text || "").length / 2.5));
}

// Через сколько мс в скользящем окне освободится место под need токенов.
function budgetFreeAt(log, used, need, budget, now) {
  if (used + need <= budget) return 0;
  let freed = 0;
  for (const x of log) {
    freed += x.n;
    if (used - freed + need <= budget) return Math.max(0, x.t + 60000 - now);
  }
  return log.length ? Math.max(0, log[log.length - 1].t + 60000 - now) : 0;
}

// onWait(сек) зовётся, когда приходится ждать окно лимита дольше пары секунд,
// чтобы пользователь видел причину паузы, а не «зависшую» панель.
async function paceRequest(estIn, estOut = CHUNK_MAX_OUTPUT_TOKENS, onWait = null) {
  const outEst = Math.min(estOut, CHUNK_MAX_OUTPUT_TOKENS);
  for (;;) {
    const now = Date.now();
    while (_budgetLogIn.length && now - _budgetLogIn[0].t >= 60000) _budgetLogIn.shift();
    while (_budgetLogOut.length && now - _budgetLogOut[0].t >= 60000) _budgetLogOut.shift();
    const usedIn = _budgetLogIn.reduce((a, x) => a + x.n, 0);
    const usedOut = _budgetLogOut.reduce((a, x) => a + x.n, 0);
    if (
      usedIn + estIn <= ITPM_BUDGET_PER_MIN &&
      usedOut + outEst <= OTPM_BUDGET_PER_MIN &&
      now - _lastRequestAt >= MIN_REQUEST_GAP_MS
    ) {
      const outSlot = { t: now, n: outEst };
      _budgetLogIn.push({ t: now, n: estIn });
      _budgetLogOut.push(outSlot);
      _lastRequestAt = now;
      return outSlot;
    }
    // Ждём не до выхода самой старой записи, а до момента, когда освободится
    // столько, сколько нужно этому запросу (иначе отсчёт прыгал «~5 с» → «~45 с»).
    const wait1 = budgetFreeAt(_budgetLogIn, usedIn, estIn, ITPM_BUDGET_PER_MIN, now);
    const wait2 = budgetFreeAt(_budgetLogOut, usedOut, outEst, OTPM_BUDGET_PER_MIN, now);
    const waitMs = Math.max(1500, wait1, wait2, MIN_REQUEST_GAP_MS - (now - _lastRequestAt));
    if (onWait && waitMs > 2500) onWait(Math.ceil(waitMs / 1000));
    // Спим короткими шагами, чтобы обратный отсчёт в панели тикал.
    await sleep(Math.min(waitMs, onWait ? 5000 : 60000));
  }
}

function waitNote(prefix) {
  return (sec) => {
    $("summary-placeholder").textContent = `${prefix} Жду окно бесплатного лимита Groq: ~${sec} с…`;
  };
}

// Когда Groq отвечает 429 по OTPM, окно уже занято — наш скользящий бюджет об
// этом ещё не знает и через 1.5 с двинул бы следующий запрос, гарантированно
// упёршись в тот же лимит. Записываем в бюджет «занятое» окно, чтобы paceRequest
// не спешил.
function pushBudgetAfterOutputError(waitMs) {
  const n = Math.max(CHUNK_MAX_OUTPUT_TOKENS, OTPM_BUDGET_PER_MIN);
  const t = Date.now();
  _budgetLogOut.push({ t: t - 60000 + waitMs, n });
  _lastRequestAt = t;
}

// прикидка входных токенов запроса: системный промпт + юзер + накладные (roles/json)
function estimateRequestTokens(sysText, userText) {
  return tokensOf(sysText) + tokensOf(userText) + 120;
}

// Groq различает лимиты токенов, и лечатся они по-разному:
//  - ITPM / «input tokens» / 413 — запрос велик, помогает ДРОБЛЕНИЕ порции;
//  - OTPM / «output tokens» — велик ответ, дробление входа НЕ помогает
//    (наоборот, добавляет запросов и усугубляет OTPM), помогает только пауза.
// Раньше один regex ловил и 413, и 429, и всегда звал это ITPM.
function errorText(e) {
  return String(e?.message || e || "");
}

// Сколько Groq велит ждать: «try again in 20.4s» / «try again in 1.5s».
function retryAfterMs(e, fallbackMs) {
  const m = errorText(e).match(/try again in\s*([\d.]+)\s*s/i);
  const fallback = fallbackMs || 6000;
  if (!m) return fallback;
  const sec = parseFloat(m[1]);
  if (!Number.isFinite(sec) || sec <= 0) return fallback;
  return Math.min(Math.max(2000, (sec + 1) * 1000), 120000);
}

function isOutputLimitError(e) {
  const s = errorText(e);
  return /OTPM|output tokens per minute|reduce max_tokens/i.test(s);
}

function isInputLimitError(e) {
  const s = errorText(e);
  if (isOutputLimitError(e)) return false;
  // \b вокруг ITPM обязателен: без него голое "ITPM" матчилось даже внутри
  // имён вида ITPM_BUDGET_PER_MIN, и любая обычная JS-ошибка про отсутствие
  // переменной превращалась в «превышен лимит входных токенов».
  return /\b413\b|\bITPM\b|input tokens per minute|Request too large|reduce your message size|context length|maximum context/i.test(s);
}

// Ошибка РАЗМЕРА запроса, а не минутного лимита: вход не влезает в контекст
// модели. Раньше эти ответы попадали в isInputLimitError и показывались как
// «превышен лимит ВХОДНЫХ токенов» — ждать минутное окно тут бесполезно,
// надо просто уменьшить порцию.
function isSizeLimitError(e) {
  const s = errorText(e);
  if (isOutputLimitError(e)) return false;
  return /context length|maximum context|Request too large|reduce your message size|\b413\b/i.test(s);
}

// Общий «Groq меня не пустил» без разбора вида лимита.
function isRateLimitError(e) {
  return /429|rate.?limit|tokens per minute|\bITPM\b|\bOTPM\b|Request too large/i.test(errorText(e));
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
  // фильтр вкладки «Все»: all | popular | questions | timecodes
  commentFilter: "all",
  commentQuery: "",
  commentLimit: 60,
  settings: null,
  analyzing: false,
};

const COMMENTS_PAGE = 60;

// Таймкоды дальше конца видео — скорее «10:30 утра», чем момент ролика.
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
function hl(text, query) {
  const q = (query || "").trim().slice(0, 80);
  if (!q) return esc(text);
  const words = q.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
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
function commentCard(c, { query = "", compact = false } = {}) {
  const likes = Number(c.likes) || 0;
  return `<article class="comment-card${compact ? " compact" : ""}">
    ${
      compact
        ? ""
        : `<span class="avatar-wrap" data-letter="${esc((c.author || "?").replace(/^@/, "").charAt(0).toUpperCase())}">${
            c.avatar ? `<img class="avatar" src="${esc(c.avatar)}" alt="" loading="lazy" />` : ""
          }</span>`
    }
    <div class="c-body">
      <div class="c-meta">
        <span class="c-author">${esc(c.author)}</span>
        ${c.time ? `<span class="c-time">${esc(c.time)}</span>` : ""}
        ${likes ? `<span class="c-likes" title="Лайки">♥ ${fmtNum(likes)}</span>` : ""}
        ${c.link ? `<a class="c-link" href="${esc(c.link)}" target="_blank" rel="noreferrer" title="Открыть комментарий на YouTube">↗</a>` : ""}
      </div>
      <div class="c-text">${richText(c.text, query)}</div>
    </div>
  </article>`;
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

function fmtNum(n) {
  n = n || 0;
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "К";
  return String(n);
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
    return `Groq не принял запрос: превышен лимит ВЫХОДНЫХ токенов (OTPM на free-тарифе — ~1000 ток/мин на всю учётку, бот и расширение делят один ключ).${tail} Расширение подождёт и попробует снова; можно просто нажать «Анализировать» ещё раз.`;
  }
  if (isSizeLimitError(e)) {
    return "Запрос не влезает в контекст модели — это НЕ лимит токенов в минуту, ждать нечего. Уменьши «Максимум комментариев» в настройках или запусти анализ на меньшем объёме.";
  }
  if (isInputLimitError(e)) {
    return "Groq не принял запрос: превышен лимит ВХОДНЫХ токенов (ITPM на free-тарифе, ~7000 ток/мин на всю учётку — бот и расширение делят один ключ). Расширение ждёт окно и режет комментарии на части автоматически; просто нажми «Анализировать» ещё раз.";
  }
  if (/Модель не ответила/.test(s)) {
    return "Модель Groq не ответила (временный сбой или лимит). Попробуй нажать «Анализировать» ещё раз — часто после ретрая всё проходит.";
  }
  if (/таймаут|timeout|Сервер недоступен|Failed to fetch|fetch failed/i.test(s)) {
    return "Не удалось связаться с сервером: возможно, Render спит (холодный старт ~50 сек) или нет связи с интернетом. Проверь «Проверить связь» и попробуй ещё раз.";
  }
  if (/403|Отказано прокси|forbidden/i.test(s)) {
    return "Прокси-сервер отклонил запрос: проверь правильность URL, секрета и то, что сервер обновлён (Render деплоит из GitHub автоматически).";
  }
  if (/400|413/.test(s)) {
    return "Запрос слишком большой или отклонён прокси: попробуй уменьшить «Максимум комментариев» в настройках.";
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
      theme: "dark",
    },
    obj.settings || {}
  );
  applyTheme();
}

function applyTheme() {
  const t = state.settings?.theme || "dark";
  let dark = true;
  if (t === "light") dark = false;
  else if (t === "auto") dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.body.dataset.theme = dark ? "dark" : "light";
}

function fillSettingsFields() {
  $("set-base-url").value = state.settings.baseUrl || DEFAULTS.baseUrl;
  $("set-token").value = state.settings.token || "";
  $("set-model").value = state.settings.model || DEFAULTS.model;
  $("set-max").value = state.settings.maxComments;
  $("set-lang").value = state.settings.lang || "ru";
  $("set-theme").value = state.settings.theme || "dark";
  $("set-mode").value = state.settings.collectMode || "auto";
  $("set-thumb-template").value = state.settings.thumbTemplate || "";
  $("quick-max").value = state.settings.maxComments;
}

function readSettingsFromFields() {
  state.settings.baseUrl = $("set-base-url").value.trim() || DEFAULTS.baseUrl;
  state.settings.token = $("set-token").value.trim();
  state.settings.model = $("set-model").value.trim() || DEFAULTS.model;
  state.settings.maxComments = Math.min(2000, Math.max(10, parseInt($("set-max").value, 10) || DEFAULTS.maxComments));
  state.settings.lang = $("set-lang").value;
  state.settings.theme = $("set-theme").value;
  state.settings.collectMode = $("set-mode").value;
  state.settings.thumbTemplate = $("set-thumb-template").value.trim() || "{title} - {channel}";
  $("quick-max").value = state.settings.maxComments;
}

async function saveSettings(showFeedback = true) {
  readSettingsFromFields();
  applyTheme();
  await chrome.storage.local.set({ settings: state.settings });
  proxy.baseUrl = state.settings.baseUrl;
  proxy.token = state.settings.token;
  proxy.model = state.settings.model;
  if (showFeedback) {
    const el = $("settings-status");
    el.textContent = "Сохранено ✓";
    el.className = "ok";
    setTimeout(() => (el.textContent = ""), 1800);
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

async function saveHistory(videoId, summary, comments, meta) {
  try {
    const entry = {
      ...summary,
      topics: (summary.topics || []).map((t) => ({
        name: t.name,
        count: t.count,
        cids: t.ids.map((i) => comments[i]?.id).filter(Boolean),
      })),
      commentCount: summary.commentCount || comments.length,
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
  const pos = new Map(comments.map((c, i) => [c.id, i]));
  return {
    ...entry,
    fromHistory: true,
    topics: (entry.topics || []).map((t) => {
      const ids = (t.cids || []).map((id) => pos.get(id)).filter((i) => i !== undefined);
      return { name: t.name, count: t.count, ids };
    }),
  };
}

async function clearHistory() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(HIST_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.filter((k) => k !== HIST_INDEX).length;
}

async function loadFor(videoId) {
  if (!videoId) return;
  const obj = await chrome.storage.session.get([
    `meta:${videoId}`,
    `comments:${videoId}`,
    `summary:${videoId}`,
    `collect:${videoId}`,
  ]);
  const switched = state.videoId !== videoId;
  state.videoId = videoId;
  state.meta = obj[`meta:${videoId}`] || state.meta || null;
  state.comments = obj[`comments:${videoId}`] || [];
  state.summary = obj[`summary:${videoId}`] || (await loadHistory(videoId, state.comments));
  if (switched) {
    state.activeTopic = null;
    state.commentLimit = COMMENTS_PAGE;
    expandedTopic = null;
    globalSearchResults = [];
  }
  renderHeader();
  renderBottomMatters();
  const st = obj[`collect:${videoId}`];
  updateCollectStatus(st?.status, st?.fetched, st?.max, st?.error || null);
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
  $("tabs").classList.remove("hidden");
  if (!state.videoId) return;
  $("btn-analyze").disabled = state.analyzing;
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
  avatar.onerror = () => (avatar.style.visibility = "hidden");
  const thumb = $("thumbnail");
  thumb.onerror = () => {
    if (thumb.src.includes("maxresdefault")) thumb.src = m.thumbs.sd || m.thumbs.hq;
    else if (thumb.src.includes("sddefault")) thumb.src = m.thumbs.hq;
  };
  if (m.thumbs?.maxres) thumb.src = m.thumbs.maxres;
  else if (m.thumbs?.sd) thumb.src = m.thumbs.sd;
  else if (m.thumbs?.hq) thumb.src = m.thumbs.hq;
}

function setProgress(id, frac) {
  const el = $(id);
  if (frac == null) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  el.firstElementChild.style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
}

function updateCollectStatus(status, fetched, max, error) {
  const el = $("collect-status");
  el.classList.toggle("err", status === "error");
  if (status === "loading") {
    el.textContent = `Собираю: ${fetched || 0} из ${max || "…"}`;
    setProgress("collect-progress", max ? (fetched || 0) / max : 0.05);
  } else if (status === "done") {
    el.textContent = `${fetched || 0} комментариев`;
    setProgress("collect-progress", null);
  } else if (status === "error") {
    el.textContent = humanCollectError(error);
    el.title = error || "";
    setProgress("collect-progress", null);
  } else {
    el.textContent = "";
    setProgress("collect-progress", null);
  }
}

// Технические коды ошибок сбора из content.js → понятный текст.
function humanCollectError(error) {
  const e = String(error || "");
  if (/innerTubeBlocked/.test(e)) return "YouTube временно не отдаёт комментарии — нажми 🔄 чуть позже";
  if (/innerTubeNoCommentsSection/.test(e)) return "Комментарии к видео отключены или не найдены";
  if (/innerTubeTimeout|innerTubeNetwork/.test(e)) return "Нет ответа от YouTube — проверь сеть и нажми 🔄";
  return "Не удалось собрать комментарии — нажми 🔄";
}

// ---------------- Вкладки ----------------

function setTab(name) {
  document.querySelectorAll(".tab[data-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $("view-" + name).classList.add("active");
  $("content").scrollTop = 0;
  if (name === "topics") renderTopics();
  if (name === "summary") {
    renderSummary();
    renderInsights();
  }
  if (name === "moments") renderMoments();
  if (name === "comments") renderComments();
  if (name === "search") renderSearchResults();
  if (name === "settings") fillSettingsFields();
}

// ---------------- Сводка ----------------

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
      showToast(`Сбор ещё идёт: ${st.fetched || 0}/${st.max || "…"}. Подожди, пока появится «✓».`);
    } else if (st?.status === "error") {
      showToast(`Сбор комментариев упал: ${st.error || "ошибка"}. Нажми 🔄, чтобы повторить.`);
    } else {
      showToast("Сначала собери комментарии — нажми 🔄 или открой видео заново.");
    }
    return;
  }
  state.analyzing = true;
  $("btn-analyze").disabled = true;
  $("btn-analyze").classList.add("busy");
  setTab("summary");
  $("summary-history").classList.add("hidden");
  $("summary-placeholder").classList.remove("hidden");
  $("summary-placeholder").textContent = "Готовлю комментарии…";
  setProgress("analyze-progress", 0.03);
  try {
    // Пул для ИИ: при большом сборе берём самые залайканные (в исходном
    // порядке) — иначе 2000 комментариев на бесплатном лимите это ~20 минут.
    // Обзор, моменты и поиск по тексту всё равно работают по всем.
    const pool = analysisPool(state.comments);
    const poolComments = pool.map((i) => state.comments[i]);
    const nodes = buildChunks(poolComments);
    if (!nodes.length) throw new Error("Нет комментариев для анализа.");

    let baseOffset = 0;
    let partLabel = "";
    const topicMap = {}; // name -> { ids: Set(globalIndices), n }
    const points = [];
    const notableIds = [];
    const sentiment = { positive: 0, neutral: 0, negative: 0 };
    const notableComments = [];
    // локальный № внутри части → индекс в state.comments
    const toGlobal = (localBase, id) => {
      const k = localBase + Number(id);
      return Number.isInteger(k) && k >= 0 && k < pool.length ? pool[k] : -1;
    };
    // Самые крупные темы на данный момент — подсказка следующим частям,
    // чтобы модель называла одну тему одинаково.
    const knownTopics = () =>
      Object.entries(topicMap)
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 10)
        .map(([name]) => name);

    const absorb = (data, localBase) => {
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
            const g = toGlobal(localBase, id);
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
          const g = toGlobal(localBase, id);
          if (g >= 0 && !notableIds.includes(g)) notableIds.push(g);
        }
      }
      const s = data.sentiment || {};
      sentiment.positive += Number(s.positive) || 0;
      sentiment.neutral += Number(s.neutral) || 0;
      sentiment.negative += Number(s.negative) || 0;
    };

    // Рекурсивно разбираем порцию комментариев: нормальный размер → 1 запрос;
    // при лимите ВХОДНЫХ токенов делим пополам (обе половины!), при лимите
    // ВЫХОДНЫХ — ждём окно и повторяем ту же порцию (дробление не помогает).
    // rateTries ограничивает повторы при OTPM, чтобы не уйти в бесконечный цикл:
    // depth тут не растёт, поэтому сторож дроблений его бы не поймал.
    // Возвращает true, если вся порция разобрана без ошибок.
    const processPortion = async (portion, localBase, depth, rateTries = 0) => {
      if (!portion.length) return true;
      if (!state.analyzing) return false;
      if (depth > 6) throw new Error("Слишком много дроблений (комментарии слишком большие или лимит исчерпан)");
      if (rateTries > 3) throw new Error("Groq держит лимит выходных токенов дольше 3 минут — сделай перерыв и нажми «Анализировать» ещё раз.");

      // оцениваем токены порции; если она уже мала для лимита, но всё равно
      // получили 429 — значит уперлись в общий бюджет бота+расширения: ждём окно.
      const userText = chunkUser(portion, knownTopics());
      const est = estimateRequestTokens(CHUNK_ANALYZE_SYSTEM, userText);
      // В OTPM Groq считает ФАКТИЧЕСКИ сгенерированные токены, а не max_tokens.
      // Компактный формат ответа — ~200 токенов на часть; резерв с запасом,
      // после ответа settleOutput() поправит его на факт.
      const estOut = 280;
      const slot = await paceRequest(est, estOut, waitNote(partLabel));
      try {
        const raw = await proxy.chat(
          [
            { role: "system", content: CHUNK_ANALYZE_SYSTEM },
            { role: "user", content: userText },
          ],
          { jsonMode: true, maxTokens: CHUNK_MAX_OUTPUT_TOKENS, timeoutMs: 150000 }
        );
        settleOutput(slot, raw);
        const data = extractJson(raw);
        if (!data) throw new Error("Модель вернула не JSON");
        absorb(data, localBase);
        return true;
      } catch (e) {
        // OTPM (лимит ВЫХОДНЫХ токенов) дроблением НЕ лечится: меньше входа —
        // не меньше выхода, а запросов станет больше и OTPM только усугубится.
        // Лечится паузой на минутное окно (Groq сам пишет, сколько ждать).
        if (isOutputLimitError(e)) {
          const waitMs = Math.max(30000, retryAfterMs(e, 30000));
          $("summary-placeholder").textContent =
            `Groq: лимит выходных токенов (OTPM) — жду окно ~${Math.round(waitMs / 1000)} с, затем повтор…`;
          // Сдвигаем и локальный бюджет, иначе paceRequest сразу повторит запрос.
          pushBudgetAfterOutputError(waitMs);
          await sleep(waitMs);
          // Повторяем ту же порцию (глубина не растёт — растёт счётчик rateTries).
          return processPortion(portion, localBase, depth, rateTries + 1);
        }
        // Настоящий лимит ВХОДНЫХ токенов (413/ITPM) — тут помогает дробление.
        if (isInputLimitError(e) && portion.length > 1) {
          $("summary-placeholder").textContent = `Лимит входных токенов Groq — дроблю и жду окно…`;
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
          $("summary-placeholder").textContent =
            `Groq: лимит входных токенов (ITPM) — жду ~${Math.round(waitMs / 1000)} с, затем повтор…`;
          await sleep(waitMs);
          return processPortion(portion, localBase, depth, rateTries + 1);
        }
        throw e;
      }
    };

    for (let ci = 0; ci < nodes.length; ci++) {
      if (!state.analyzing) return;
      partLabel = nodes.length > 1 ? `Часть ${ci + 1} из ${nodes.length}.` : "";
      $("summary-placeholder").textContent =
        nodes.length > 1 ? `Читаю комментарии: часть ${ci + 1} из ${nodes.length}…` : "Читаю комментарии…";
      setProgress("analyze-progress", (ci + 0.3) / (nodes.length + 1));
      await processPortion(nodes[ci], baseOffset, 0);
      baseOffset += nodes[ci].length;
    }
    setProgress("analyze-progress", nodes.length / (nodes.length + 1));

    const topics = mergeTopics(Object.entries(topicMap).map(([name, t]) => ({ name, ids: [...t.ids], n: t.n })))
      .map((t) => ({ name: t.name, count: t.n, ids: t.ids }))
      .slice(0, 12);

    // Яркие — по одному-два из каждой части; оставляем 6 самых залайканных.
    for (const g of notableIds
      .slice()
      .sort((a, b) => (state.comments[b].likes || 0) - (state.comments[a].likes || 0))
      .slice(0, 6)) {
      notableComments.push(state.comments[g]);
    }

    $("summary-placeholder").textContent = "Пишу итоговую сводку…";
    $("summary-text").innerHTML =
      '<div class="summary-title">Что говорят в комментариях</div><div class="skeleton"><i></i><i></i><i></i></div>';
    const liveSummary = $("summary-text");
    // Финальный запрос идёт сразу после чанков — OTPM ещё выбран, поэтому
    // заранее ждём место в окне под его выходные токены.
    const finIn = estimateRequestTokens(FINAL_SYSTEM, finalUser({ topics, points, sentiment, notableComments, lang: state.settings.lang }));
    // Сводка ≤380 символов ≈ 150–200 токенов: резервируем 350, а не max_tokens.
    const finSlot = await paceRequest(finIn, 350, waitNote("Осталась итоговая сводка."));
    $("summary-placeholder").textContent = "Пишу итоговую сводку…";
    let fin = "";
    // Финал обычно последний и самый «весомый» — именно он чаще всего упирается
    // в OTPM. На OTPM ждём окно и повторяем (дробление тут невозможно), на прочих
    // ошибках — одна попытка, дальше покажем пользователю текст.
    for (let finTry = 0; finTry <= 3; finTry++) {
      try {
        fin = await proxy.chatStream(
          [
            { role: "system", content: FINAL_SYSTEM },
            { role: "user", content: finalUser({ topics, points, sentiment, notableComments, lang: state.settings.lang }) },
          ],
          { jsonMode: false, maxTokens: 700, timeoutMs: 150000 },
          (full) => {
            liveSummary.innerHTML = '<div class="summary-title">Что говорят в комментариях</div>' + esc(full);
          }
        );
        break;
      } catch (fe) {
        if (isOutputLimitError(fe) && finTry < 3) {
          const waitMs = Math.max(30000, retryAfterMs(fe, 30000));
          $("summary-placeholder").textContent =
            `Groq: лимит выходных токенов на финальной сводке — жду ~${Math.round(waitMs / 1000)} с, затем повтор…`;
          pushBudgetAfterOutputError(waitMs);
          await sleep(waitMs);
          continue;
        }
        throw fe;
      }
    }
    settleOutput(finSlot, fin);
    const summary = clean(fin) || "Сводка не получена.";
    liveSummary.innerHTML = '<div class="summary-title">Что говорят в комментариях</div>' + esc(summary);

    state.summary = {
      summary,
      topics,
      points: dedupeTexts(points, 6),
      notable: notableComments,
      sentiment,
      updatedAt: Date.now(),
    };
    state.summary.commentCount = state.comments.length;
    state.summary.analyzed = pool.length;
    await safeSessionSet({ [`summary:${state.videoId}`]: state.summary }, { keepVideoId: state.videoId });
    void saveHistory(state.videoId, state.summary, state.comments, state.meta);
    $("summary-placeholder").textContent = "";
    // Снимаем флаг до отрисовки: renderSummary() во время анализа ничего не
    // рисует (бережёт живой прогресс), и без этого темы/тональность/мнения
    // не появлялись до следующего переключения вкладки.
    state.analyzing = false;
    renderSummary();
    renderTopics();
    setTab("summary");
  } catch (e) {
    const msg = friendlyError(e);
    $("summary-text").innerHTML = "";
    $("summary-placeholder").classList.remove("hidden");
    $("summary-placeholder").innerHTML = `<div class="error-box"><b>Не получилось проанализировать.</b><br>${esc(msg)}</div>`;
  } finally {
    state.analyzing = false;
    $("btn-analyze").disabled = false;
    $("btn-analyze").classList.remove("busy");
    setProgress("analyze-progress", null);
  }
}

function fmtDate(ts) {
  try {
    return new Date(ts).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return "";
  }
}

function renderSummary() {
  if (state.analyzing) return; // не затираем живой прогресс и стрим
  const s = state.summary;
  const ph = $("summary-placeholder");
  const hist = $("summary-history");
  if (s?.updatedAt) {
    const n =
      s.analyzed && s.analyzed < s.commentCount
        ? ` · по ${s.analyzed} самым залайканным из ${s.commentCount}`
        : s.commentCount
          ? ` · по ${s.commentCount} комментариям`
          : "";
    hist.textContent = s.fromHistory
      ? `Сохранённая сводка от ${fmtDate(s.updatedAt)}${n}. «Анализировать» — обновить.`
      : `Сводка от ${fmtDate(s.updatedAt)}${n}`;
    hist.classList.remove("hidden");
  } else {
    hist.classList.add("hidden");
  }
  if (!s) {
    ph.textContent = state.comments.length
      ? "Нажми «🧠 Анализировать» — ИИ прочитает комментарии и сделает сводку обсуждения."
      : "Комментарии ещё собираются — сводку можно будет сделать, когда сбор закончится.";
    ph.classList.remove("hidden");
    $("btn-copy-summary").classList.add("hidden");
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
  $("btn-export-summary").classList.remove("hidden");

  const chips = (s.topics || []).slice(0, 5);
  const chipWrap = $("summary-topics");
  if (chips.length) {
    chipWrap.classList.remove("hidden");
    chipWrap.innerHTML =
      '<span class="chips-label">Ключевые темы:</span>' +
      chips
        .map(
          (t) => `<button class="chip" data-topic="${esc(t.name)}">${esc(t.name)} <span class="count">${t.count}</span></button>`
        )
        .join("");
  } else {
    chipWrap.classList.add("hidden");
  }

  const total = Math.max(1, s.sentiment.positive + s.sentiment.neutral + s.sentiment.negative);
  const pct = (n) => (n ? Math.max(4, Math.round((n / total) * 100)) : 0);
  $("summary-sentiment").classList.remove("hidden");
  $("summary-sentiment").innerHTML = `
    <div class="sentiment-label">Настроение зрителей</div>
    <div class="sentiment-bar">
      <div style="display:flex;height:100%;min-width:0">
        ${pct(s.sentiment.positive) ? `<div class="sentiment-fill positive" style="width:${pct(s.sentiment.positive)}%" title="Положительные"></div>` : ""}
        ${pct(s.sentiment.neutral) ? `<div class="sentiment-fill neutral" style="width:${pct(s.sentiment.neutral)}%" title="Нейтральные"></div>` : ""}
        ${pct(s.sentiment.negative) ? `<div class="sentiment-fill negative" style="width:${pct(s.sentiment.negative)}%" title="Негативные"></div>` : ""}
      </div>
    </div>
    <div class="sentiment-legend">
      <span class="lg lg-pos">${s.sentiment.positive} положит.</span>
      <span class="lg lg-neu">${s.sentiment.neutral} нейтр.</span>
      <span class="lg lg-neg">${s.sentiment.negative} негатив.</span>
    </div>`;

  $("summary-text").innerHTML =
      '<div class="summary-title">Что говорят в комментариях</div>' + esc(s.summary || "");

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
  const st = commentStats(list, maxSec());
  const words = topWords(list, 14);
  const moments = topMoments(list, { maxSec: maxSec(), limit: 3 });
  const stat = (n, label, filter) =>
    `<button class="stat"${filter ? ` data-goto-filter="${filter}"` : " disabled"}><b>${fmtNum(n)}</b><span>${label}</span></button>`;
  box.innerHTML = `
    <div class="section-head"><span>Обзор</span><span class="hint">считается без ИИ</span></div>
    <div class="stats">
      ${stat(st.total, "комментариев", "all")}
      ${stat(st.likes, "лайков", "popular")}
      ${stat(st.questions, "вопросов", st.questions ? "questions" : "")}
      ${stat(st.withTime, "с таймкодами", st.withTime ? "timecodes" : "")}
    </div>
    ${
      words.length
        ? `<div class="subhead">О чём чаще пишут</div><div class="word-cloud">${words
            .map((w, i) => {
              const size = i < 3 ? "l" : i < 7 ? "m" : "s";
              return `<button class="word ${size}" data-word="${esc(w.word)}" title="${w.count} комментариев — показать">${esc(w.word)}<span>${w.count}</span></button>`;
            })
            .join("")}</div>`
        : ""
    }
    ${
      moments.length
        ? `<div class="subhead">Популярные моменты <button class="link-btn" data-goto="moments">все →</button></div>
           <div class="moment-chips">${moments
             .map((m) => `<button class="tc tc-big" data-t="${m.t}">${esc(m.label)}<span>${m.count}</span></button>`)
             .join("")}</div>`
        : ""
    }
    ${
      st.top && st.top.likes
        ? `<div class="subhead">Самый залайканный</div>${commentCard(st.top, { compact: true })}`
        : ""
    }`;
  box.classList.remove("hidden");
}

// ---------------- Моменты ----------------

function renderMoments() {
  const list = state.comments;
  const moments = list.length ? topMoments(list, { maxSec: maxSec(), limit: 40 }) : [];
  const badge = $("moments-badge");
  badge.textContent = moments.length ? String(moments.length) : "";
  badge.classList.toggle("hidden", !moments.length);
  $("moments-empty").classList.toggle("hidden", Boolean(moments.length));
  const line = $("moments-timeline");
  const wrap = $("moments-list");
  if (!moments.length) {
    line.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  // Полоса-таймлайн: где в видео сгущаются отсылки зрителей.
  const end = Number.isFinite(maxSec()) ? maxSec() : Math.max(...moments.map((m) => m.t)) * 1.05 + 1;
  const maxCount = Math.max(...moments.map((m) => m.count));
  line.innerHTML =
    '<div class="tl-track">' +
    moments
      .map((m) => {
        const left = Math.min(100, (m.t / end) * 100);
        const size = 8 + Math.round((m.count / maxCount) * 10);
        return `<button class="tl-dot" data-t="${m.t}" style="left:${left}%;width:${size}px;height:${size}px" title="${esc(m.label)} · ${m.count} комм."></button>`;
      })
      .join("") +
    `</div><div class="tl-scale"><span>0:00</span><span>${Number.isFinite(maxSec()) ? fmtTime(end - 2) : ""}</span></div>`;
  line.classList.remove("hidden");

  wrap.innerHTML = moments
    .map((m) => {
      const cs = m.idxs.map((i) => list[i]);
      const more = cs.length - 1;
      return `<div class="moment">
        <div class="moment-head">
          <button class="tc tc-big" data-t="${m.t}" title="Перемотать">▶ ${esc(m.label)}</button>
          <span class="moment-bar"><i style="width:${Math.round((m.count / maxCount) * 100)}%"></i></span>
          <span class="hint">${m.count} комм.${m.likes ? ` · ♥ ${fmtNum(m.likes)}` : ""}</span>
        </div>
        ${commentCard(cs[0], { compact: true })}
        ${
          more > 0
            ? `<details class="moment-more"><summary>ещё ${more}</summary>${cs
                .slice(1, 12)
                .map((c) => commentCard(c, { compact: true }))
                .join("")}</details>`
            : ""
        }
      </div>`;
    })
    .join("");
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
    showToast(`▶ ${fmtTime(t)}`);
  } catch (e) {
    showToast("Не получилось перемотать — открой вкладку с этим видео.");
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
  wrap.innerHTML = s.topics
    .map(
      (t, i) =>
        `<div class="topic-item" data-idx="${i}" data-name="${esc(t.name)}">
           <div class="topic-head">
             <span class="t-name">${esc(t.name)}</span>
             <span class="t-count">${t.count} <span class="t-caret">${t.name === expandedTopic ? "▾" : "▸"}</span></span>
           </div>
           <div class="topic-body${t.name === expandedTopic ? "" : " hidden"}">${t.name === expandedTopic ? topicCommentsHtml(t.name) : ""}</div>
         </div>`
    )
    .join("");
  // Переключаем только по заголовку: раньше клик по комментарию внутри
  // раскрытой темы (или по ссылке в нём) сворачивал тему обратно.
  wrap.querySelectorAll(".topic-item .topic-head").forEach((head) => {
    head.addEventListener("click", () => {
      const name = head.parentElement.dataset.name;
      expandedTopic = expandedTopic === name ? null : name;
      renderTopics();
    });
  });
}

// ---------------- Комментарии ----------------

function filteredComments() {
  let list = state.comments;
  const f = state.commentFilter;
  if (f === "questions") list = list.filter((c) => isQuestion(c.text));
  if (f === "timecodes") list = list.filter((c) => timecodesOf(c.text, maxSec()).length);
  const q = state.commentQuery.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (c) => (c.text || "").toLowerCase().includes(q) || (c.author || "").toLowerCase().includes(q)
    );
  }
  if (f === "popular") list = [...list].sort((a, b) => (b.likes || 0) - (a.likes || 0));
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
  const labels = { all: "", popular: " · по лайкам", questions: " · вопросы", timecodes: " · с таймкодами" };
  $("comments-count").textContent = state.comments.length
    ? `${list.length} из ${state.comments.length}${labels[state.commentFilter] || ""}`
    : "";
  document.querySelectorAll("#comments-chips .chip").forEach((b) => {
    b.classList.toggle("active", b.dataset.filter === state.commentFilter);
  });
  const more = $("btn-more-comments");
  if (!list.length) {
    wrap.innerHTML = `<div class="placeholder">${
      state.comments.length ? "Ничего не нашлось — смени фильтр." : "Комментариев пока нет."
    }</div>`;
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
      : `<div class="placeholder">${
          state.comments.length
            ? "По тексту — мгновенный поиск слова. По смыслу — ИИ найдёт близкие по смыслу комментарии. Вопрос — ИИ ответит, что думают зрители."
            : "Поиск заработает, когда соберутся комментарии."
        }</div>`;
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
  $("btn-search").disabled = true;
  try {
    if (mode === "text") {
      const needle = q.toLowerCase();
      const items = state.comments.filter((c) => (c.text || "").toLowerCase().includes(needle));
      globalSearchResults = {
        mode,
        query: q,
        items: items.slice(0, 100),
        info: items.length ? `Нашлось: ${items.length}${items.length > 100 ? " (показаны первые 100)" : ""}` : "Ничего не нашлось. Попробуй поиск по смыслу.",
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
      if (seq !== searchSeq) return; // пока ждали ответ, запустили новый поиск
      const data = extractJson(raw);
      const ids = [...new Set((Array.isArray(data?.ids) ? data.ids : []).map(Number).filter(Number.isFinite))];
      const items = ids.map((i) => subset[i]).filter(Boolean);
      const scope =
        subset.length < state.comments.length ? ` (ИИ смотрел ${subset.length} из ${state.comments.length} самых подходящих)` : "";
      globalSearchResults = ask
        ? {
            mode,
            query: q,
            answer: normalizeSummary(data?.answer || "", 700) || "Модель не дала ответа — попробуй переформулировать вопрос.",
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
    if (seq !== searchSeq) return;
    globalSearchResults = { mode, query: q, items: [], error: true, info: friendlyError(e) };
  } finally {
    if (seq === searchSeq) {
      $("btn-search").disabled = false;
      renderSearchResults();
    }
  }
}

// ---------------- Превью и канал ----------------

function openThumbTab() {
  const m = state.meta;
  if (!m?.thumbs) return;
  const urls = [m.thumbs.maxres, m.thumbs.sd, m.thumbs.hq].filter(Boolean).join(",");
  if (!urls) return;
  const page = chrome.runtime.getURL("sidepanel/preview.html");
  const qs = "?urls=" + encodeURIComponent(urls) + "&title=" + encodeURIComponent(m.title || "");
  chrome.tabs.create({ url: page + qs });
}

async function downloadThumb() {
  if (!state.meta) return;
  const m = state.meta;
  const url = m.thumbs?.maxres || m.thumbs?.sd || m.thumbs?.hq;
  if (!url) return;
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const dataUrl = await blobToDataURL(blob);
    const tpl = state.settings?.thumbTemplate || "{title} - {channel}";
    const title = sanitizeFilename(m.title || "video");
    const channel = sanitizeFilename(m.channelName || "channel");
    const name = tpl
      .replaceAll("{title}", title)
      .replaceAll("{channel}", channel)
      .replaceAll("{videoid}", m.videoId);
    const filename = sanitizeFilename(name) + ".jpg";
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

function onRuntimeMessage(msg) {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "yt:meta") {
    if (!state.videoId) {
      state.videoId = msg.meta.videoId;
      state.meta = msg.meta;
      renderBottomMatters();
    } else if (msg.meta.videoId === state.videoId) {
      state.meta = msg.meta;
    }
    renderHeader();
  } else if (msg.type === "yt:progress") {
    if (msg.videoId && state.videoId && msg.videoId !== state.videoId) return;
    updateCollectStatus(msg.status, msg.fetched, msg.max, msg.error || null);
  } else if (msg.type === "yt:ready") {
    if (msg.videoId && state.videoId && msg.videoId !== state.videoId) return;
    void loadFor(state.videoId);
  } else if (msg.type === "yt:away") {
    if (!state.videoId) return;
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
  const YT = YT_VIDEO_RE;
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

  // Сначала активная вкладка обычного окна — это то, что пользователь видит.
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

async function refreshFromActiveTab() {
  const tab = await findActiveVideoTab();
  if (!tab?.id || !YT_VIDEO_RE.test(tab.url || "")) {
    renderBottomMatters();
    const el = $("empty-state");
    const focusHint = tab?.url
      ? `<div class="hint">Активная вкладка: <b>${esc(tab.url)}</b><br>Нужен YouTube с открытым видео (watch/shorts).</div>`
      : `<div class="hint">Видео-вкладка не найдена. Открой страницу с видео на YouTube.</div>`;
    if (tab?.url && !/youtube\.com/i.test(tab.url)) {
      el.innerHTML = "Активная вкладка — не YouTube." + focusHint;
    } else if (tab?.url && !/\/watch|\/shorts/.test(tab.url)) {
      el.innerHTML = "Это YouTube, но без страницы видео (главная/лента)." + focusHint;
    } else {
      el.innerHTML = "Открой страницу с видео на YouTube, и комментарии появятся здесь." + focusHint;
    }
    return;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: "yt:meta-query" });
      if (reply?.videoId) {
        await loadFor(reply.videoId);
        if (reply.meta) {
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
  const el = $("empty-state");
  el.classList.remove("hidden");
  el.innerHTML =
    "Контент-скрипт не подключился к этой вкладке.<br>Перезагрузи страницу видео (F5), чтобы начать сбор комментариев." +
    `<div class="hint">Вкладка: <b>${esc(tab.url || "")}</b></div>` +
    '<button id="btn-reload-tab" class="primary" style="margin-top:10px">🔄 Перезагрузить вкладку</button>';
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
  $("btn-settings").addEventListener("click", () => {
    fillSettingsFields();
    setTab("settings");
  });
  $("btn-settings-back").addEventListener("click", () => setTab("summary"));
  $("btn-restart").addEventListener("click", async () => {
    if (!state.videoId) return;
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
        showToast("Перезагрузи страницу видео.");
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
    showToast(`Лимит сбора: ${v} комментариев. Нажми 🔄, чтобы собрать заново.`);
  });
  $("btn-analyze").addEventListener("click", () => {
    const quick = parseInt($("quick-max").value, 10);
    if (Number.isFinite(quick)) {
      state.settings.maxComments = Math.min(2000, Math.max(10, quick));
      $("set-max").value = state.settings.maxComments;
      void saveSettings(false).then(() => analyze());
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
      showToast("Сводка скопирована в буфер ✓");
    } catch (e) {
      showToast("Не удалось скопировать: " + (e.message || e));
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
    const moments = topMoments(state.comments, { maxSec: maxSec(), limit: 5 });
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
  $("btn-more-comments").addEventListener("click", () => {
    state.commentLimit += COMMENTS_PAGE;
    renderComments();
  });
  // Делегирование на всю панель: таймкоды (перемотка), переходы из «Обзора».
  $("content").addEventListener("click", (e) => {
    const tc = e.target.closest("[data-t]");
    if (tc) {
      e.preventDefault();
      void seekTo(Number(tc.dataset.t));
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
  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => {
      const ph = { text: "Слово или фраза…", ai: "Тема, о которой ищешь…", ask: "Например: что не понравилось зрителям?" };
      $("search-input").placeholder = ph[r.value] || "";
      $("btn-search").textContent = r.value === "ask" ? "Спросить" : "Найти";
    })
  );
  $("btn-clear-history").addEventListener("click", async () => {
    const n = await clearHistory();
    $("history-status").textContent = n ? `Удалено сводок: ${n}` : "История пуста";
    if (state.summary?.fromHistory) {
      state.summary = null;
      renderSummary();
      renderTopics();
    }
  });
  $("btn-search").addEventListener("click", runSearch);
  $("search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  $("btn-save-settings").addEventListener("click", () => saveSettings(true));
  $("btn-test").addEventListener("click", async () => {
    const el = $("test-result");
    el.textContent = "…";
    el.className = "";
    await saveSettings(false);
    try {
      const ok = await proxy.test();
      let diag = ok ? "Связь есть ✓" : "Ответ пустой";
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
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.status === "complete") refreshFromActiveTab();
  });
  window.addEventListener("focus", refreshFromActiveTab);
}

function showFatal(message, detail) {
  // Раньше любая ошибка инициализации уходила только в консоль, а панель
  // оставалась на статической заглушке — пользователь не понимал, что делать.
  const el = $("empty-state");
  if (el) {
    el.classList.remove("hidden");
    el.innerHTML =
      `<b>Панель не запустилась.</b><br>${esc(message)}` +
      (detail ? `<div class="hint">${esc(String(detail).slice(0, 300))}</div>` : "") +
      `<div class="hint">Обнови расширение на chrome://extensions и перезагрузи страницу видео (F5).</div>`;
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
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  await refreshFromActiveTab();
}

// Страховка: если init завис (например, на storage), панель не должна молчать
// вечной заглушкой — показываем, что истекло время.
const _initWatchdog = setTimeout(() => {
  const el = $("empty-state");
  if (state.videoId) return; // видео уже найдено — панель в работе, не мешаем
  if (el && !el.classList.contains("hidden") && el.textContent.includes("Открой страницу")) {
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