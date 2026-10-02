import {
  GroqProxy,
  extractJson,
  clean,
  sanitizeFilename,
  sleep,
} from "../groq.js";
import {
  CHUNK_ANALYZE_SYSTEM,
  chunkUser,
  FINAL_SYSTEM,
  finalUser,
  SEARCH_SYSTEM,
  searchUser,
} from "../prompts.js";
import { DEFAULTS } from "../config.js";

const LOCAL_CONFIG =
  (typeof window !== "undefined" && window.__EXT_LOCAL_CONFIG__) || {};

const $ = (id) => document.getElementById(id);
// Анализ пачками. Лимиты Groq free на qwen/qwen3.8-27b (одна учётка на бота и расширение):
//   ITPM ~7000 входных токенов/мин, OTPM 1000 ВЫХОДНЫХ токенов/мин.
// OTPM жёстче: любой запрос с max_tokens > 1000 отклоняется целиком (429), поэтому
// max_tokens держим заметно ниже лимита, а выходные токены тоже учитываем в паузах.
const CHUNK_MAX_TOKENS = 1800;
const CHUNK_MAX_OUTPUT_TOKENS = 800; // < OTPM 1000, с запасом
const OTPM_BUDGET_PER_MIN = 900; // фактический выход всех запросов за минуту
// минимальный перерыв между запросами — Groq не любит ОЧЕНЬ частые мелкие вызовы
const MIN_REQUEST_GAP_MS = 1500;

// грубая оценка «токенов» комментария для нарезки (1 токен ≈ 3 символа-ru,
// с запасом; лучше переоценить — меньше риска 413)
function tokensOf(text) {
  const t = String(text || "");
  return Math.ceil(t.length / 3);
}

function buildChunks(comments) {
  const chunks = [];
  let cur = [];
  let curTokens = 0;
  for (const c of comments) {
    const t = tokensOf(c.text) + 12; // + на инфраструктуру JSON
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

async function paceRequest(estIn, estOut = CHUNK_MAX_OUTPUT_TOKENS) {
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
      _budgetLogIn.push({ t: now, n: estIn });
      _budgetLogOut.push({ t: now, n: outEst });
      _lastRequestAt = now;
      return;
    }
    const wait1 = _budgetLogIn.length ? Math.max(0, _budgetLogIn[0].t + 60000 - now) : 0;
    const wait2 = _budgetLogOut.length ? Math.max(0, _budgetLogOut[0].t + 60000 - now) : 0;
    const waitMs = Math.max(1500, wait1, wait2, MIN_REQUEST_GAP_MS - (now - _lastRequestAt));
    await sleep(Math.min(waitMs, 60000));
  }
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
  return /413|ITPM|input tokens per minute|Request too large|reduce your message size|context length|maximum context/i.test(s);
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
  popularSort: false,
  settings: null,
  analyzing: false,
};

const proxy = new GroqProxy();

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function hl(text, query) {
  const safe = esc(text);
  const q = (query || "").trim().slice(0, 80);
  if (!q) return safe;
  const re = new RegExp("(" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").split(/\s+/).join("|") + ")", "gi");
  return safe.replace(re, "<mark>$1</mark>");
}

function fmtNum(n) {
  n = n || 0;
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "К";
  return String(n);
}

function friendlyError(e) {
  const s = errorText(e);
  // Порядок важен: сначала выходной лимит — он самый частый, а раньше его
  // подменяли текстом про входные токены.
  if (isOutputLimitError(e)) {
    const wait = retryAfterMs(e, 0);
    const tail = wait ? ` Groq велит подождать ~${Math.round(wait / 1000)} с.` : "";
    return `Groq не принял запрос: превышен лимит ВЫХОДНЫХ токенов (OTPM на free-тарифе — ~1000 ток/мин на всю учётку, бот и расширение делят один ключ).${tail} Расширение подождёт и попробует снова; можно просто нажать «Анализировать» ещё раз.`;
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
async function loadFor(videoId) {
  if (!videoId) return;
  const obj = await chrome.storage.session.get([
    `meta:${videoId}`,
    `comments:${videoId}`,
    `summary:${videoId}`,
    `collect:${videoId}`,
  ]);
  state.videoId = videoId;
  state.meta = obj[`meta:${videoId}`] || null;
  state.comments = obj[`comments:${videoId}`] || [];
  state.summary = obj[`summary:${videoId}`] || null;
  renderHeader();
  renderBottomMatters();
  const st = obj[`collect:${videoId}`];
  updateCollectStatus(st?.status, st?.fetched, st?.max, st?.error || null);
  if (state.comments.length) {
    renderComments();
    renderTopics();
    renderSummary();
  } else {
    setTab("summary");
  }
}

function renderBottomMatters() {
  $("empty-state").classList.toggle("hidden", Boolean(state.videoId));
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

function updateCollectStatus(status, fetched, max, error) {
  const el = $("collect-status");
  if (status === "loading") {
    el.textContent = `сбор: ${fetched || 0}/${max || "…"}`;
  } else if (status === "done") {
    el.textContent = `✓ ${fetched || 0} комментариев`;
  } else if (status === "error") {
    el.textContent = `✗ ${error || "ошибка"}`;
  } else {
    el.textContent = "";
  }
}

// ---------------- Вкладки ----------------

function setTab(name) {
  document.querySelectorAll(".tab[data-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $("view-" + name).classList.add("active");
  if (name === "topics") renderTopics();
  if (name === "summary") renderSummary();
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
  $("summary-placeholder").textContent = "Анализирую… (куски)";
  try {
    const nodes = buildChunks(state.comments);
    if (!nodes.length) {
      $("current-summary-short").textContent = "Нет комментариев для анализа.";
    }

    let baseOffset = 0;
    const topicMap = {}; // name -> Set(globalIndices)
    const points = [];
    const notableIds = [];
    const sentiment = { positive: 0, neutral: 0, negative: 0 };
    const notableComments = [];

    const absorb = (data, localBase) => {
      if (!data) return;
      if (data.topics && typeof data.topics === "object") {
        for (const [name, ids] of Object.entries(data.topics)) {
          const nm = clean(name);
          if (!nm || !Array.isArray(ids)) continue;
          if (!topicMap[nm]) topicMap[nm] = new Set();
          for (const id of ids) {
            const g = localBase + Number(id);
            if (Number.isFinite(g) && g >= 0 && g < state.comments.length) topicMap[nm].add(g);
          }
        }
      }
      if (Array.isArray(data.points)) {
        for (const p of data.points) {
          const pg = clean(p);
          if (pg) points.push(pg.slice(0, 220));
        }
      }
      if (Array.isArray(data.notable)) {
        for (const id of data.notable) {
          const g = localBase + Number(id);
          if (Number.isFinite(g) && g >= 0 && g < state.comments.length && !notableIds.includes(g)) {
            notableIds.push(g);
          }
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
      const userText = chunkUser(portion);
      const est = estimateRequestTokens(CHUNK_ANALYZE_SYSTEM, userText);
      // В OTPM Groq считает ФАКТИЧЕСКИ сгенерированные токены (в логах бота это
      // ~400 токенов на чанк), а не запрошенный max_tokens. Поэтому резервируем
      // реалистичную оценку выхода: полный чанк ≈ 400 токенов → ~2 запроса/мин.
      const estOut = Math.min(500, 120 + Math.round(est * 0.15));
      await paceRequest(est, estOut);
      try {
        const raw = await proxy.chat(
          [
            { role: "system", content: CHUNK_ANALYZE_SYSTEM },
            { role: "user", content: chunkUser(portion) },
          ],
          { jsonMode: true, maxTokens: CHUNK_MAX_OUTPUT_TOKENS, timeoutMs: 150000 }
        );
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
      $("summary-placeholder").textContent = `Анализирую кусок ${ci + 1} из ${nodes.length}…`;
      await processPortion(nodes[ci], baseOffset, 0);
      baseOffset += nodes[ci].length;
    }

    const topics = Object.entries(topicMap)
      .map(([name, set]) => ({ name, count: set.size, ids: [...set] }))
      .sort((a, b) => b.ids.length - a.ids.length)
      .slice(0, 12);

    if (notableIds.length) {
      for (const g of notableIds.slice(0, 6)) notableComments.push(state.comments[g]);
    }

    $("summary-placeholder").textContent = "Собираю итоговую сводку…";
    $("summary-text").innerHTML = '<div class="summary-title">Что говорят в комментариях</div>';
    const liveSummary = $("summary-text");
    // Финальный запрос идёт сразу после чанков — OTPM ещё выбран, поэтому
    // заранее ждём место в окне под его выходные токены.
    const finIn = estimateRequestTokens(FINAL_SYSTEM, finalUser({ topics, points, sentiment, notableComments, lang: state.settings.lang }));
    await paceRequest(finIn, 700);
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
    const summary = clean(fin) || "Сводка не получена.";
    liveSummary.innerHTML = '<div class="summary-title">Что говорят в комментариях</div>' + esc(summary);

    state.summary = {
      summary,
      topics,
      points: points.slice(0, 8),
      notable: notableComments,
      sentiment,
      updatedAt: Date.now(),
    };
    await safeSessionSet({ [`summary:${state.videoId}`]: state.summary }, { keepVideoId: state.videoId });
    renderSummary();
    renderTopics();
    $("summary-placeholder").textContent = "";
    setTab("summary");
  } catch (e) {
    const msg = friendlyError(e);
    $("summary-placeholder").classList.remove("hidden");
    $("summary-placeholder").innerHTML = `<div class="error-box"><b>Не получилось проанализировать.</b><br>${esc(msg)}</div>`;
  } finally {
    state.analyzing = false;
    $("btn-analyze").disabled = false;
  }
}

function renderSummary() {
  const s = state.summary;
  const ph = $("summary-placeholder");
  if (!s) {
    ph.textContent = "Нажми «Анализировать», чтобы получить сводку обсуждения.";
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
      '<div class="subhead">Яркие комментарии</div>' +
      s.notable.map((c) => `<div class="comment-card"><div class="c-body"><div class="c-meta"><span class="c-author">${esc(c.author)}</span><span>· ${esc(c.time)}</span></div><div class="c-text">${esc(c.text)}</div></div></div>`).join("");
  }
}

// ---------------- Темы ----------------

function topicCommentsHtml(name) {
  const s = state.summary;
  if (!s) return "";
  const topic = s.topics.find((t) => t.name === name);
  if (!topic) return "";
  const ids = new Set(topic.ids);
  const list = state.comments.filter((c, i) => ids.has(i)).slice(0, 20);
  if (!list.length) return '<div class="placeholder">Комментарии по теме не найдены.</div>';
  return list
    .map(
      (c) => `<div class="comment-card">
        <img class="avatar" src="${esc(c.avatar || "")}" onerror="this.style.visibility='hidden'" alt="" loading="lazy" />
        <div class="c-body">
          <div class="c-meta">
            <span class="c-author">${esc(c.author)}</span>
            <span>${esc(c.time)}</span>
            <span>♥ ${fmtNum(c.likes)}</span>
            <span>${c.id ? `<a class="c-link" href="${esc(c.link)}" target="_blank" rel="noreferrer">открыть ↗</a>` : ""}</span>
          </div>
          <div class="c-text">${esc(c.text)}</div>
        </div>
      </div>`
    )
    .join("");
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
  wrap.querySelectorAll(".topic-item").forEach((el) => {
    el.addEventListener("click", () => {
      const name = el.dataset.name;
      const body = el.querySelector(".topic-body");
      const caret = el.querySelector(".t-caret");
      const wasOpen = expandedTopic === name;
      expandedTopic = wasOpen ? null : name;
      renderTopics();
    });
  });
}

// ---------------- Комментарии ----------------

function filteredComments() {
  let list = state.comments;
  if (state.activeTopic && state.summary) {
    const t = state.summary.topics.find((x) => x.name === state.activeTopic);
    if (t) {
      const ids = new Set(t.ids);
      list = list.filter((c, i) => ids.has(i));
    }
  }
  if (state.popularSort) {
    list = [...list].sort((a, b) => b.likes - a.likes);
  }
  return list;
}

function renderComments() {
  const wrap = $("comments-list");
  const list = filteredComments();
  $("comments-count").textContent = `${list.length}${state.activeTopic ? ` по теме «${state.activeTopic}»` : ""}`;
  $("chip-all").classList.toggle("active", !state.activeTopic);
  $("chip-popular").classList.toggle("active", state.popularSort);
  if (!list.length) {
    wrap.innerHTML = '<div class="placeholder">Комментариев пока нет.</div>';
    return;
  }
  wrap.innerHTML = list
    .map(
      (c) => `<div class="comment-card">
        <img class="avatar" src="${esc(c.avatar || "")}" onerror="this.style.visibility='hidden'" alt="" loading="lazy" />
        <div class="c-body">
          <div class="c-meta">
            <span class="c-author">${esc(c.author)}</span>
            <span>${esc(c.time)}</span>
            <span>♥ ${fmtNum(c.likes)}</span>
            <span>${c.id ? `<a class="c-link" href="${esc(c.link)}" target="_blank" rel="noreferrer">открыть ↗</a>` : ""}</span>
          </div>
          <div class="c-text">${esc(c.text)}</div>
        </div>
      </div>`
    )
    .join("");
}

// ---------------- Поиск ----------------

let globalSearchResults = [];

function renderSearchResults() {
  const wrap = $("search-results");
  const info = $("search-info");
  const items = (globalSearchResults && globalSearchResults.items) || [];
  if (!items.length) {
    wrap.innerHTML = '<div class="placeholder">Введи запрос и нажми «Найти».</div>';
    info.textContent = "";
    return;
  }
  const q = $("search-input").value.trim();
  info.textContent = globalSearchResults.info || "";
  wrap.innerHTML = items
    .map(
      (c) => `<div class="comment-card">
        <img class="avatar" src="${esc(c.avatar || "")}" onerror="this.style.visibility='hidden'" alt="" loading="lazy" />
        <div class="c-body">
          <div class="c-meta"><span class="c-author">${esc(c.author)}</span><span>${esc(c.time)}</span><span>♥ ${fmtNum(c.likes)}</span></div>
          <div class="c-text">${hl(c.text, q)}</div>
        </div>
      </div>`
    )
    .join("");
}

async function runSearch() {
  const q = $("search-input").value.trim();
  if (!q || !state.comments.length) return;
  const mode = document.querySelector('input[name="mode"]:checked').value;
  $("btn-search").disabled = true;
  try {
    if (mode === "text") {
      const needle = q.toLowerCase();
      const items = state.comments.filter((c) => (c.text || "").toLowerCase().includes(needle)).slice(0, 80);
      globalSearchResults = { items, info: `Найдено по тексту: ${items.length}` };
    } else {
      if (!proxy.configured) {
        showToast("Настрой прокси (URL, секрет, модель).");
        setTab("settings");
        globalSearchResults = [];
        renderSearchResults();
        return;
      }
      $("search-info").textContent = "Ищу по смыслу…";
      const slice = state.comments.slice(0, 400);
      const raw = await proxy.chat(
        [
          { role: "system", content: SEARCH_SYSTEM },
          { role: "user", content: searchUser(q, slice) },
        ],
        { jsonMode: true, maxTokens: 600, timeoutMs: 120000 }
      );
      const data = extractJson(raw);
      const ids = new Set((Array.isArray(data?.ids) ? data.ids : []).map(Number).filter(Number.isFinite));
      const items = slice.filter((_, i) => ids.has(i)).slice(0, 80);
      globalSearchResults = { items, info: `Найдено по смыслу: ${items.length}` + (data?.why ? ` — ${clean(data.why)}` : "") };
    }
  } catch (e) {
    globalSearchResults = { items: [], info: "Ошибка поиска: " + (e.message || e) };
  } finally {
    $("btn-search").disabled = false;
    renderSearchResults();
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

function showToast(text) {
  const el = $("collect-status");
  el.textContent = text;
  setTimeout(() => {
    if (el.textContent === text) el.textContent = "";
  }, 4000);
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
  }
}

// Ищем активную вкладку с видео YouTube. currentWindow НЕ годится: если side
// panel открыт в отдельном окне, «текущее окно» — это окно панели
// (chrome-extension://…), и видео не находится. Поэтому перебираем все обычные
// окна и берём активную вкладку с /watch|/shorts.
async function findActiveVideoTab() {
  const YT = /^https:\/\/(www|m)\.youtube\.com\/(watch|shorts)/;
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
  if (!tab?.id || !/^https:\/\/(www|m)\.youtube\.com\/(watch|shorts)/.test(tab.url || "")) {
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
    renderComments();
    renderSummary();
    renderTopics();
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
  $("chip-all").addEventListener("click", () => {
    state.activeTopic = null;
    renderComments();
  });
  $("chip-popular").addEventListener("click", () => {
    state.popularSort = true;
    state.activeTopic = null;
    renderComments();
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