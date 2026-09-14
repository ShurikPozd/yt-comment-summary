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
const CHUNK_SIZE = 120;

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
  const s = String(e?.message || e);
  if (/Модель не ответила/.test(s)) {
    return "Модель Groq не ответила (временный сбой). Попробуй нажать «Анализировать» ещё раз — часто после ретрая всё проходит.";
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
  $("channel-name").href = m.channelUrl ? "https://www.youtube.com" + m.channelUrl : "#";
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
    showToast("Сначала собери комментарии — нажми 🔄 или открой видео заново.");
    return;
  }
  state.analyzing = true;
  $("btn-analyze").disabled = true;
  $("summary-placeholder").textContent = "Анализирую… (куски)";
  try {
    const nodes = [];
    for (let i = 0; i < state.comments.length; i += CHUNK_SIZE) {
      nodes.push(state.comments.slice(i, i + CHUNK_SIZE));
    }

    let baseOffset = 0;
    const topicMap = {}; // name -> Set(globalIndices)
    const points = [];
    const notableIds = [];
    const sentiment = { positive: 0, neutral: 0, negative: 0 };
    const notableComments = [];

    for (let ci = 0; ci < nodes.length; ci++) {
      if (!state.analyzing) return;
      $("summary-placeholder").textContent = `Анализирую кусок ${ci + 1} из ${nodes.length}…`;
      const chunk = nodes[ci];
      const user = chunkUser(chunk);
      const raw = await proxy.chat(
        [
          { role: "system", content: CHUNK_ANALYZE_SYSTEM },
          { role: "user", content: user },
        ],
        { jsonMode: true, maxTokens: 1600, timeoutMs: 150000 }
      );
      const data = extractJson(raw);
      if (data) {
        if (data.topics && typeof data.topics === "object") {
          for (const [name, ids] of Object.entries(data.topics)) {
            const nm = clean(name);
            if (!nm || !Array.isArray(ids)) continue;
            if (!topicMap[nm]) topicMap[nm] = new Set();
            for (const id of ids) {
              const g = baseOffset + Number(id);
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
            const g = baseOffset + Number(id);
            if (Number.isFinite(g) && g >= 0 && g < state.comments.length && !notableIds.includes(g)) {
              notableIds.push(g);
            }
          }
        }
        const s = data.sentiment || {};
        sentiment.positive += Number(s.positive) || 0;
        sentiment.neutral += Number(s.neutral) || 0;
        sentiment.negative += Number(s.negative) || 0;
      }
      baseOffset += chunk.length;
      await sleep(120);
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
    const fin = await proxy.chatStream(
      [
        { role: "system", content: FINAL_SYSTEM },
        { role: "user", content: finalUser({ topics, points, sentiment, notableComments, lang: state.settings.lang }) },
      ],
      { jsonMode: false, maxTokens: 700, timeoutMs: 150000 },
      (full) => {
        liveSummary.innerHTML = '<div class="summary-title">Что говорят в комментариях</div>' + esc(full);
      }
    );
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
    await chrome.storage.session.set({ [`summary:${state.videoId}`]: state.summary });
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

async function refreshFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/(www|m)\.youtube\.com\/(watch|shorts)/.test(tab.url || "")) {
    renderBottomMatters();
    return;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: "yt:meta-query" });
      if (reply?.videoId) {
        await loadFor(reply.videoId);
        if (reply.meta) {
          state.meta = reply.meta;
          await chrome.storage.session.set({ [`meta:${reply.videoId}`]: reply.meta });
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
  el.innerHTML =
    'Контент-скрипт не подключился к этой вкладке.<br>Перезагрузи страницу видео (F5), чтобы начать сбор комментариев.';
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
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
  $("btn-open-video").addEventListener("click", () => {
    if (state.meta) chrome.tabs.create({ url: state.meta.pageUrl });
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

main().catch((e) => console.error("sidepanel init:", e));