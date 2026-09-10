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

const $ = (id) => document.getElementById(id);
const CHUNK_SIZE = 120;

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

// ---------------- Настройки ----------------

async function loadSettings() {
  const obj = await chrome.storage.local.get("settings");
  state.settings = Object.assign(
    {
      baseUrl: "",
      token: "",
      model: "qwen/qwen3.6-27b",
      maxComments: 300,
      lang: "ru",
      collectMode: "auto",
      thumbTemplate: "{title} - {channel}",
    },
    obj.settings || {}
  );
}

function fillSettingsFields() {
  $("set-base-url").value = state.settings.baseUrl || "";
  $("set-token").value = state.settings.token || "";
  $("set-model").value = state.settings.model || "";
  $("set-max").value = state.settings.maxComments;
  $("set-lang").value = state.settings.lang || "ru";
  $("set-mode").value = state.settings.collectMode || "auto";
  $("set-thumb-template").value = state.settings.thumbTemplate || "";
}

function readSettingsFromFields() {
  state.settings.baseUrl = $("set-base-url").value.trim();
  state.settings.token = $("set-token").value.trim();
  state.settings.model = $("set-model").value.trim() || "qwen/qwen3.6-27b";
  state.settings.maxComments = Math.min(2000, Math.max(10, parseInt($("set-max").value, 10) || 300));
  state.settings.lang = $("set-lang").value;
  state.settings.collectMode = $("set-mode").value;
  state.settings.thumbTemplate = $("set-thumb-template").value.trim() || "{title} - {channel}";
}

async function saveSettings(showFeedback = true) {
  readSettingsFromFields();
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
    const fin = await proxy.chat(
      [
        { role: "system", content: FINAL_SYSTEM },
        { role: "user", content: finalUser({ topics, points, sentiment, notableComments, lang: state.settings.lang }) },
      ],
      { jsonMode: true, maxTokens: 700, timeoutMs: 150000 }
    );
    const finJson = extractJson(fin);
    const summary = clean(finJson?.summary) || "Сводка не получена.";

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
    $("summary-placeholder").textContent = "Ошибка анализа: " + (e.message || e);
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
    $("summary-sentiment").classList.add("hidden");
    $("summary-text").textContent = "";
    $("summary-points").innerHTML = "";
    $("summary-notable").innerHTML = "";
    return;
  }
  ph.classList.add("hidden");

  const total = Math.max(1, s.sentiment.positive + s.sentiment.neutral + s.sentiment.negative);
  const pct = (n) => Math.round((n / total) * 100);
  $("summary-sentiment").classList.remove("hidden");
  $("summary-sentiment").innerHTML = `
    <div class="sentiment-label">Тональность: 👍 ${s.sentiment.positive} · 😐 ${s.sentiment.neutral} · 👎 ${s.sentiment.negative}</div>
    <div class="sentiment-bar">
      <div style="display:flex;height:100%">
        <div class="sentiment-fill positive" style="width:${pct(s.sentiment.positive)}%"></div>
        <div class="sentiment-fill neutral" style="width:${pct(s.sentiment.neutral)}%"></div>
        <div class="sentiment-fill negative" style="width:${pct(s.sentiment.negative)}%"></div>
      </div>
    </div>`;

  $("summary-text").textContent = s.summary || "";

  $("summary-points").innerHTML = "";
  if (s.points?.length) {
    $("summary-points").innerHTML =
      '<div class="subhead">Ключевые мнения</div><ul class="points">' +
      s.points.map((p) => `<li>${esc(p)}</li>`).join("") +
      "</ul>";
  }

  $("summary-notable").innerHTML = "";
  if (s.notable?.length) {
    $("summary-notable").innerHTML =
      '<div class="subhead">Яркие комментарии</div>' +
      s.notable.map((c) => `<div class="comment-card"><div class="c-body"><div class="c-meta"><span class="c-author">${esc(c.author)}</span><span>· ${esc(c.time)}</span></div><div class="c-text">${esc(c.text)}</div></div></div>`).join("");
  }
}

// ---------------- Темы ----------------

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
        `<div class="topic-item" data-idx="${i}"><span class="t-name">${esc(t.name)}</span><span class="t-count">${t.count}</span></div>`
    )
    .join("");
  wrap.querySelectorAll(".topic-item").forEach((el) => {
    el.addEventListener("click", () => {
      const t = state.summary.topics[Number(el.dataset.idx)];
      state.activeTopic = t.name;
      state.popularSort = false;
      renderComments();
      setTab("comments");
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
  if (!globalSearchResults.length) {
    wrap.innerHTML = '<div class="placeholder">Введи запрос и нажми «Найти».</div>';
    info.textContent = "";
    return;
  }
  const q = $("search-input").value.trim();
  info.textContent = globalSearchResults.info || "";
  wrap.innerHTML = globalSearchResults.items
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
    globalSearchResults = [];
    renderBottomMatters();
  }
}

async function refreshFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/(www|m)\.youtube\.com\/watch/.test(tab.url || "")) {
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
  $("btn-analyze").addEventListener("click", analyze);
  $("btn-restart").addEventListener("click", async () => {
    if (!state.videoId) return;
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
      el.textContent = ok ? "Связь есть ✓" : "Ответ пустой";
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