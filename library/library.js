// «Моя библиотека» — мгновенный поиск по всем видео во всех ваших плейлистах.
//
// Как устроено:
//   1. Каталог (плейлисты и видео в них) читается с YouTube от вашего имени —
//      через вкладку YouTube: туда подключается playlists-main.js, и запросы
//      уходят ровно так же, как у самого сайта. Нет открытой вкладки — страница
//      откроет фоновую (раздел «Плейлисты», без звука) и закроет после сбора.
//   2. Каталог хранится в этом браузере (IndexedDB расширения), никуда не уходит.
//   3. Поиск — search.js: опечатки, окончания, раскладка, без сети.

import { icon } from "../sidepanel/icons.js";
import { buildIndex, search, highlight } from "./search.js";

const EV = "ytcs-pl:2"; // имя канала к playlists-main.js (версия протокола)
const STALE = 12 * 3600 * 1000; // каталог старше — тихо обновляем при открытии
const PAGE = 48; // карточек за раз (дальше — по прокрутке)
const WORKERS = 3; // плейлистов читаем одновременно
const SPECIAL = { WL: 0, LL: 1 }; // «Смотреть позже» и «Понравившиеся» — сверху

const $ = (s) => document.querySelector(s);
// открыта внутри боковой панели (рамкой) — узкая раскладка, видео — в текущей вкладке
const EMBED = new URLSearchParams(location.search).has("panel");
if (EMBED) document.body.classList.add("embed");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nf = new Intl.NumberFormat("ru-RU");
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};
const videosWord = (n) => `${nf.format(n)} ${plural(n, "видео", "видео", "видео")}`;
const plWord = (n) => `${nf.format(n)} ${plural(n, "плейлист", "плейлиста", "плейлистов")}`;
// «в 1 плейлисте», «в 14 плейлистах» — предложный падеж
const inPlWord = (n) => `${nf.format(n)} ${plural(n, "плейлисте", "плейлистах", "плейлистах")}`;

const SORTS = {
  lib: [
    ["auto", "Сначала лучшие совпадения"],
    ["order", "Как в плейлистах"],
    ["long", "Сначала длинные"],
    ["short", "Сначала короткие"],
    ["channel", "По каналу (А–Я)"],
  ],
  queue: [
    ["auto", "Как в очереди"],
    ["new", "Сначала новые"],
    ["old", "Сначала старые"],
    ["started", "Сначала начатые"],
    ["short", "Сначала короткие"],
    ["long", "Сначала длинные"],
  ],
};

const state = {
  view: "lib", // «lib» — плейлисты, «queue» — очередь
  watchHere: true, // открывать видео прямо в библиотеке (свой плеер), а не на YouTube
  queue: [], // [{ id, title, channel, len, short, addedAt }]
  qpos: {}, // { id: секунда }
  qopts: { removeWatched: true, autoNext: false, intercept: false, offerCount: 4, offerMode: "order" },
  qindex: null,
  qundo: null,
  tabsOpen: null,
  cat: null, // { syncedAt, playlists: [{ id, title, privacy, count, thumb }], videos: [...] }
  index: null,
  plById: new Map(),
  q: "",
  pl: "",
  dur: "",
  sort: "auto",
  plQ: "",
  list: [], // [{ d, hits }] — текущий результат
  shown: 0,
  syncing: false,
  progress: null,
  error: "",
};

// ---------- хранилище (IndexedDB расширения) ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("ytcs-library", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kv(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", value === undefined ? "readonly" : "readwrite");
    const st = tx.objectStore("kv");
    const r = value === undefined ? st.get(key) : st.put(value, key);
    tx.oncomplete = () => resolve(value === undefined ? r.result : true);
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- связь с YouTube ----------
// Выполняется В СТРАНИЦЕ YouTube (world: MAIN): шлёт запрос playlists-main.js
// и ждёт ответ. Функция самодостаточная — Chrome копирует её текст во вкладку.
function bridgeCall(ev, op, args) {
  return new Promise((resolve) => {
    const id = `lib${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      resolve({ ok: false, error: "noreply" });
    }, 45000);
    function onMsg(e) {
      if (e.source !== window || e.data?.__ytcsPl !== id) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      resolve(e.data);
    }
    window.addEventListener("message", onMsg);
    document.dispatchEvent(new CustomEvent(ev, { detail: JSON.stringify({ ...args, op, id }) }));
  });
}

let ytTab = null; // { id, temp }

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["playlists-main.js"] });
    return true;
  } catch (e) {
    return false;
  }
}

function waitLoaded(tabId, ms = 25000) {
  return new Promise((resolve) => {
    const done = (ok) => {
      chrome.tabs.onUpdated.removeListener(onUpd);
      clearTimeout(timer);
      resolve(ok);
    };
    const onUpd = (id, info) => id === tabId && info.status === "complete" && done(true);
    const timer = setTimeout(() => done(false), ms);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((t) => t.status === "complete" && done(true), () => done(false));
  });
}

let tabPending = null;
function getTab() {
  // три сборщика спрашивают вкладку одновременно — открываем (или ищем) её один раз
  return (tabPending ||= findTab().finally(() => (tabPending = null)));
}
async function findTab() {
  if (ytTab) {
    const t = await chrome.tabs.get(ytTab.id).catch(() => null);
    if (t && !t.discarded && /^https:\/\/www\.youtube\.com\//.test(t.url || "")) return ytTab;
    ytTab = null;
  }
  const tabs = await chrome.tabs.query({ url: ["https://www.youtube.com/*"] });
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const t of tabs) {
    if (t.discarded || t.status !== "complete") continue;
    if (await inject(t.id)) return (ytTab = { id: t.id, temp: false });
  }
  // своей вкладки YouTube нет — откроем фоновую: раздел «Плейлисты», там ничего не играет
  const t = await chrome.tabs.create({ url: "https://www.youtube.com/feed/playlists", active: false });
  ytTab = { id: t.id, temp: true };
  chrome.tabs.update(t.id, { muted: true }).catch(() => {});
  await waitLoaded(t.id);
  if (!(await inject(t.id))) throw Object.assign(new Error("tab"), { code: "tab" });
  return ytTab;
}

async function releaseTab() {
  if (ytTab?.temp) await chrome.tabs.remove(ytTab.id).catch(() => {});
  ytTab = null;
}

async function yt(op, args = {}) {
  for (let attempt = 0; ; attempt++) {
    const tab = await getTab();
    let res;
    try {
      [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: bridgeCall, args: [EV, op, args] });
    } catch (e) {
      ytTab = null; // вкладку закрыли или увели со страницы — возьмём другую
      if (attempt < 2) continue;
      throw Object.assign(new Error(String(e?.message || e)), { code: "tab" });
    }
    const r = res?.result;
    if (r?.ok) return r.data;
    // настройки YouTube в только что открытой вкладке ещё не готовы — подождём;
    // нет ответа — вкладку перезагрузили, скрипт пропал: подключимся заново
    if ((r?.error === "noconfig" || r?.error === "noreply") && attempt < 2) {
      if (r?.error === "noreply" && ytTab?.id === tab.id) await inject(tab.id);
      await new Promise((ok) => setTimeout(ok, 1500));
      continue;
    }
    throw Object.assign(new Error(r?.message || r?.error || "fail"), { code: r?.error || "fail" });
  }
}

// ---------- сбор каталога ----------
const ERRORS = {
  loggedout: "Войдите в аккаунт YouTube в этом браузере — и нажмите «Повторить».",
  denied: "YouTube не принял запрос. Обновите любую вкладку YouTube (F5) и повторите.",
  tab: "Не получилось подключиться к вкладке YouTube. Откройте youtube.com и повторите.",
  noreply: "YouTube не ответил. Обновите вкладку YouTube (F5) и повторите.",
  fail: "Не получилось прочитать плейлисты. Повторите чуть позже.",
};

async function sync() {
  if (state.syncing) return;
  state.syncing = true;
  state.error = "";
  state.progress = { done: 0, total: 0, videos: 0 };
  renderSync();
  if (!state.cat) renderEmpty();
  try {
    const pls = await yt("playlists");
    if (!pls.some((p) => p.id === "LL")) pls.push({ id: "LL", title: "Понравившиеся", privacy: "PRIVATE" });
    const thumbs = new Map();
    await yt("library")
      .then((lib) => lib.forEach((x) => x.thumb && thumbs.set(x.id, x.thumb)))
      .catch(() => {});
    state.progress.total = pls.length;
    renderSync();

    const videos = new Map();
    const queue = pls.slice();
    let fatal = null;
    const worker = async () => {
      while (queue.length && !fatal) {
        const p = queue.shift();
        let token = null;
        let n = 0;
        try {
          for (let page = 0; page < 300; page++) {
            const r = await yt("page", { playlistId: p.id, token, from: n });
            for (const v of r.items) {
              if (!v.id) continue;
              n++;
              let rec = videos.get(v.id);
              if (!rec) {
                // удалённые и скрытые («[Удалённое видео]») — без канала и длительности
                if (!v.channel && !v.short && /^\[.*\]$/.test(v.title)) continue;
                videos.set(v.id, (rec = { id: v.id, title: v.title, channel: v.channel, channelId: v.channelId, len: v.len, short: Boolean(v.short), info: v.info, in: [] }));
                state.progress.videos++;
              }
              rec.in.push([p.id, v.pos]);
            }
            token = r.next;
            if (!token) break;
          }
        } catch (e) {
          if (["loggedout", "denied", "tab"].includes(e.code)) fatal = e;
          p.failed = true;
        }
        p.count = n;
        p.thumb = thumbs.get(p.id) || "";
        state.progress.done++;
        renderSync();
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    if (fatal) throw fatal;
    // не прочитался плейлист — берём его видео из прошлого каталога, а не теряем из поиска
    const prev = state.cat;
    for (const p of pls.filter((x) => x.failed && prev)) {
      const old = prev.playlists.find((x) => x.id === p.id);
      if (old) p.count = old.count;
      for (const v of prev.videos) {
        const mine = v.in.filter(([id]) => id === p.id);
        if (!mine.length) continue;
        let rec = videos.get(v.id);
        if (!rec) videos.set(v.id, (rec = { ...v, in: [] }));
        rec.in.push(...mine);
      }
    }

    const cat = {
      v: 1,
      syncedAt: Date.now(),
      playlists: pls.filter((p) => !(p.id === "LL" && p.failed && !p.count)).map(({ id, title, privacy, count, thumb, failed }) => ({ id, title, privacy, count, thumb, failed: Boolean(failed) })),
      videos: [...videos.values()],
    };
    await kv("catalog", cat);
    useCatalog(cat, { keep: Boolean(state.cat) }); // обновили в фоне — не сбиваем прокрутку
  } catch (e) {
    state.error = ERRORS[e.code] || ERRORS.fail;
  } finally {
    state.syncing = false;
    state.progress = null;
    await releaseTab();
    renderSync();
    if (!state.cat) renderEmpty();
  }
}

// ---------- каталог → индекс ----------
function useCatalog(cat, { keep = false } = {}) {
  state.cat = cat;
  state.plById = new Map(cat.playlists.map((p, i) => [p.id, { ...p, rank: SPECIAL[p.id] ?? i + 2 }]));
  if (state.pl && !state.plById.has(state.pl)) state.pl = "";
  const docs = cat.videos.map((v) => ({
    title: v.title,
    channel: v.channel,
    playlists: v.in.map(([id]) => state.plById.get(id)?.title || ""),
  }));
  state.index = buildIndex(docs);
  // порядок «как в плейлистах»: по первому плейлисту (их порядок — как у YouTube), затем по месту в нём
  state.order = cat.videos.map((v, d) => {
    let best = Infinity;
    for (const [id, pos] of v.in) best = Math.min(best, (state.plById.get(id)?.rank ?? 999) * 100000 + pos);
    return { d, key: best };
  });
  state.order.sort((a, b) => a.key - b.key);
  $("#q").placeholder = `Поиск по ${videosWord(cat.videos.length)} в ${inPlWord(cat.playlists.length)}`;
  update({ keep });
}

// ---------- поиск и фильтры ----------
function durOk(v, dur) {
  if (!dur) return true;
  if (v.short) return dur.startsWith("0-"); // Shorts — в «Shorts и до 1 мин»
  const [a, b] = dur.split("-");
  return v.len >= Number(a) && (b === "" || v.len < Number(b));
}

function inPl(v, pl) {
  return v.in.some(([id]) => id === pl);
}

function compute() {
  const vids = state.cat.videos;
  const allowBase = (d) => durOk(vids[d], state.dur);
  const allow = state.pl ? (d) => allowBase(d) && inPl(vids[d], state.pl) : allowBase;
  let list;
  let meta = { partial: false, swapped: null };
  let perPl = null;
  if (state.q.trim()) {
    // счётчики у плейлистов слева — сколько найдено в каждом (без фильтра по плейлисту)
    const wide = search(state.index, state.q, allowBase);
    meta = wide;
    if (wide.results) {
      perPl = new Map();
      for (const r of wide.results) for (const [id] of vids[r.d].in) perPl.set(id, (perPl.get(id) || 0) + 1);
    }
    list = (wide.results || []).filter((r) => !state.pl || inPl(vids[r.d], state.pl));
  } else {
    list = state.order.filter(({ d }) => allow(d)).map(({ d }) => ({ d, hits: null }));
  }
  const pos = (d) => {
    const v = vids[d];
    if (state.pl) return v.in.find(([id]) => id === state.pl)?.[1] ?? 0;
    return 0;
  };
  const sort = state.sort;
  if (sort === "order" || (sort === "auto" && !state.q.trim())) {
    if (state.pl) list.sort((a, b) => pos(a.d) - pos(b.d));
    else if (state.q.trim()) {
      const rank = new Map(state.order.map((o, i) => [o.d, i]));
      list.sort((a, b) => rank.get(a.d) - rank.get(b.d));
    }
  } else if (sort === "long") list.sort((a, b) => vids[b.d].len - vids[a.d].len);
  else if (sort === "short") list.sort((a, b) => vids[a.d].len - vids[b.d].len);
  else if (sort === "channel") list.sort((a, b) => vids[a.d].channel.localeCompare(vids[b.d].channel, "ru"));
  return { list, meta, perPl };
}

function update({ keep = false } = {}) {
  if (state.view === "queue") return updateQueue({ keep });
  if (!state.cat) {
    state.list = [];
    state.shown = 0;
    $("#grid").textContent = "";
    return renderEmpty();
  }
  const { list, meta, perPl } = compute();
  const was = state.shown;
  const y = window.scrollY;
  state.list = list;
  state.meta = meta;
  state.perPl = perPl;
  state.shown = 0;
  $("#grid").textContent = "";
  renderSide();
  renderSummary();
  if (keep) {
    // перерисовать столько же карточек и вернуть прокрутку на место
    while (state.shown < Math.min(was, list.length)) more();
    window.scrollTo({ top: y });
  } else {
    window.scrollTo({ top: 0 });
    more();
  }
  saveHash();
}

// ---------- отрисовка ----------
const fmtLen = (s) => {
  if (!s) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};
const mark = (text, hits) =>
  highlight(text, hits)
    .map((p) => (p.hit ? `<mark>${esc(p.t)}</mark>` : esc(p.t)))
    .join("");

function cardHtml({ d, hits }) {
  const v = state.cat.videos[d];
  const list = state.pl && inPl(v, state.pl) ? `&list=${encodeURIComponent(state.pl)}` : "";
  const href = v.short ? `https://www.youtube.com/shorts/${encodeURIComponent(v.id)}` : `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}${list}`;
  const pls = v.in.map(([id]) => state.plById.get(id)).filter(Boolean);
  pls.sort((a, b) => (a.id === state.pl) - (b.id === state.pl) || a.rank - b.rank);
  const shown = pls.slice(0, 3);
  const rest = pls.length - shown.length;
  const info = (v.info || "").replace(/\s*•\s*/g, " · "); // у YouTube то «•», то «·»
  const sub = [v.channel || (v.short ? "Shorts" : ""), info].filter(Boolean).join(" · ");
  return `<article class="card" data-vid="${esc(v.id)}">
    <a class="thumb" href="${href}" target="_blank" rel="noreferrer" tabindex="-1" aria-label="${esc(v.title)}">
      <img loading="lazy" decoding="async" alt="" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg" />
      ${v.len ? `<span class="dur">${fmtLen(v.len)}</span>` : v.short ? `<span class="dur">Shorts</span>` : ""}
    </a>
    <a class="title" href="${href}" target="_blank" rel="noreferrer" title="${esc(v.title)}">${hits ? mark(v.title, hits) : esc(v.title)}</a>
    <div class="sub" title="${esc(sub)}">${v.channel ? (hits ? mark(v.channel, hits) : esc(v.channel)) : v.short ? "Shorts" : ""}${info ? `${v.channel || v.short ? " · " : ""}${esc(info)}` : ""}</div>
    <div class="pls">${shown
      .map((p) => `<button type="button" class="chip" data-pl="${esc(p.id)}" title="Показать плейлист «${esc(p.title)}»">${hits ? mark(p.title, hits) : esc(p.title)}</button>`)
      .join("")}${rest > 0 ? `<button type="button" class="chip more-pl" data-more="${d}" title="${esc(pls.slice(3).map((p) => p.title).join(", "))}">+${rest}</button>` : ""}</div>
  </article>`;
}

function more() {
  const grid = $("#grid");
  const next = state.list.slice(state.shown, state.shown + PAGE);
  if (!next.length) return;
  grid.insertAdjacentHTML("beforeend", next.map(state.view === "queue" ? qCardHtml : cardHtml).join(""));
  state.shown += next.length;
}

function renderSummary() {
  const el = $("#summary");
  const empty = $("#empty");
  const n = state.list.length;
  const pl = state.pl ? state.plById.get(state.pl) : null;
  const where = pl ? ` в «${esc(pl.title)}»` : "";
  if (!n) {
    el.innerHTML = "";
    empty.hidden = false;
    const filtered = state.pl || state.dur;
    empty.innerHTML = `<div class="empty-box">
      <div class="empty-icon">${icon("search", { size: 28 })}</div>
      <div class="empty-title">${state.q.trim() ? "Ничего не нашлось" : "Здесь пусто"}</div>
      <div class="empty-text">${
        state.q.trim()
          ? `По запросу «${esc(state.q.trim())}»${where} нет видео${filtered ? " — попробуйте убрать фильтры" : ". Попробуйте другие слова или часть названия"}.`
          : "Под выбранные фильтры не подходит ни одно видео."
      }</div>
      ${filtered ? `<button type="button" class="ghost" data-act="reset">Сбросить фильтры</button>` : ""}
    </div>`;
    return;
  }
  empty.hidden = true;
  let text = state.q.trim() ? `Найдено <b>${videosWord(n)}</b>${where}` : `<b>${videosWord(n)}</b>${where}`;
  if (state.meta?.swapped) text += ` · <span class="swap">запрос понят как «${esc(state.meta.swapped)}»</span>`;
  if (state.meta?.partial) text += ` · <span class="swap">точных совпадений нет — показаны похожие</span>`;
  el.innerHTML = text;
}

function renderSide() {
  const box = $("#pl-list");
  const all = [...state.plById.values()].sort((a, b) => a.rank - b.rank);
  const q = state.plQ.trim().toLowerCase();
  const items = q ? all.filter((p) => p.title.toLowerCase().includes(q)) : all;
  const per = state.perPl;
  const totalHits = state.q.trim() && state.meta?.results ? state.meta.results.length : null;
  const count = (p) => (per ? per.get(p.id) || 0 : p.count || 0);
  const row = (p) => {
    const c = count(p);
    const safe = /^https:\/\/i\d?\.ytimg\.com\/[^'"()\s\\]+$/.test(p.thumb || "") ? p.thumb : "";
    const thumb = safe ? `style="background-image:url('${safe}')"` : "";
    return `<button type="button" class="pl" data-pl="${esc(p.id)}" aria-current="${state.pl === p.id}" ${per && !c ? 'style="opacity:.45"' : ""}>
      <span class="pl-thumb" ${thumb}>${p.thumb ? "" : icon(p.id === "LL" ? "heart" : p.id === "WL" ? "clock" : "library", { size: 18 })}</span>
      <span class="pl-name" title="${esc(p.title)}">${esc(p.title)}</span>
      <span class="pl-count">${nf.format(c)}</span>
    </button>`;
  };
  const allCount = totalHits ?? state.cat.videos.length;
  let html = q
    ? ""
    : `<button type="button" class="pl" data-pl="" aria-current="${!state.pl}">
      <span class="pl-thumb">${icon("library", { size: 18 })}</span>
      <span class="pl-name">Все плейлисты</span>
      <span class="pl-count">${nf.format(allCount)}</span>
    </button>`;
  const special = items.filter((p) => p.id in SPECIAL);
  const rest = items.filter((p) => !(p.id in SPECIAL));
  // идёт поиск — плейлисты, где что-то нашлось, поднимаются наверх
  if (per) rest.sort((a, b) => (per.get(b.id) || 0) - (per.get(a.id) || 0) || a.rank - b.rank);
  html += special.map(row).join("");
  if (rest.length) html += `<div class="pl-sep">Плейлисты · ${nf.format(rest.length)}</div>` + rest.map(row).join("");
  if (!items.length) html += `<div class="pl-sep">Плейлист не найден</div>`;
  box.innerHTML = html;
}

const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  return `${d} ${plural(d, "день", "дня", "дней")} назад`;
};

function renderSync() {
  const btn = $("#sync");
  const text = $("#sync-text");
  const bar = $("#progress");
  btn.disabled = state.syncing;
  btn.classList.toggle("spin", state.syncing);
  const p = state.progress;
  if (state.syncing && p) {
    text.textContent = p.total ? `Читаю плейлисты: ${p.done} из ${p.total} · ${videosWord(p.videos)}` : "Подключаюсь к YouTube…";
    bar.hidden = false;
    bar.firstElementChild.style.width = `${p.total ? Math.round((p.done / p.total) * 100) : 4}%`;
  } else {
    bar.hidden = true;
    text.textContent = state.error ? "Не обновилось" : state.cat ? `Обновлено ${ago(state.cat.syncedAt)}` : "";
    text.title = state.error || "";
  }
  if (!state.cat && state.view !== "queue") renderEmpty();
}

function renderEmpty() {
  const empty = $("#empty");
  if (state.cat || state.view === "queue") return;
  empty.hidden = false;
  $("#summary").textContent = "";
  const p = state.progress;
  if (state.error) {
    empty.innerHTML = `<div class="empty-box">
      <div class="empty-icon">${icon("library", { size: 28 })}</div>
      <div class="empty-title">Не получилось собрать плейлисты</div>
      <div class="empty-text">${esc(state.error)}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">
        <button type="button" class="primary" data-act="sync">Повторить</button>
        <button type="button" class="ghost" data-act="open-yt">Открыть YouTube</button>
      </div>
    </div>`;
    return;
  }
  const pct = p?.total ? Math.round((p.done / p.total) * 100) : 3;
  empty.innerHTML = `<div class="empty-box">
    <div class="empty-icon">${icon("library", { size: 28 })}</div>
    <div class="empty-title">Собираю ваши плейлисты</div>
    <div class="empty-text">Один раз прочитаю все плейлисты аккаунта — дальше поиск мгновенный. Список хранится только в этом браузере.</div>
    <div class="bar"><div style="width:${pct}%"></div></div>
    <div class="empty-text">${p?.total ? `${p.done} из ${plWord(p.total)} · ${videosWord(p.videos)}` : "Подключаюсь к YouTube…"}</div>
  </div>`;
}

// ---------- адрес страницы: #q=…&pl=… (можно добавить в закладки) ----------
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  state.q = h.get("q") || "";
  state.pl = h.get("pl") || "";
  setView(h.get("v") === "queue" ? "queue" : "lib", { silent: true });
  if (Number(h.get("collected"))) state.justCollected = Number(h.get("collected")); // пришли сюда после «Собрать вкладки»
  $("#q").value = state.q;
}
function saveHash() {
  const h = new URLSearchParams();
  if (state.view === "queue") h.set("v", "queue");
  if (state.q.trim()) h.set("q", state.q.trim());
  if (state.pl && state.view === "lib") h.set("pl", state.pl);
  const s = h.toString();
  history.replaceState(null, "", location.pathname + location.search + (s ? `#${s}` : ""));
}

// ---------- очередь «посмотреть потом» ----------
const qmsg = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

async function loadQueue() {
  const r = await chrome.storage.local.get(["queue", "queuePos", "queueOpts", "queueUndo"]).catch(() => ({}));
  state.queue = Array.isArray(r.queue) ? r.queue : [];
  state.qpos = r.queuePos || {};
  state.qopts = { ...state.qopts, ...(r.queueOpts || {}) };
  state.qundo = r.queueUndo || null;
  state.qindex = buildIndex(state.queue.map((x) => ({ title: x.title, channel: x.channel })));
  $("#q-badge").textContent = state.queue.length ? nf.format(state.queue.length) : "";
}

chrome.storage.onChanged.addListener(async (ch, area) => {
  if (area !== "local" || !(ch.queue || ch.queuePos || ch.queueOpts || ch.queueUndo)) return;
  if (ch.queuePos && !(ch.queue || ch.queueOpts || ch.queueUndo)) {
    // пока где-то смотрят видео, место пишется каждые 5 секунд — обновляем только
    // полоски «досмотрено», не трогая открытые списки и фокус
    state.qpos = ch.queuePos.newValue || {};
    if (state.view === "queue") patchProgress();
    return;
  }
  await loadQueue();
  if (state.view === "queue") update({ keep: true });
  if (watch.on && watch.source === "queue") refreshWatchSide();
});

function patchProgress() {
  for (const card of document.querySelectorAll("#grid .card[data-qid]")) {
    const r = state.queue.find((x) => x.id === card.dataset.qid);
    if (!r?.len) continue;
    const t = state.qpos[r.id] || 0;
    const pct = t > 5 ? Math.min(100, Math.round((t / r.len) * 100)) : 0;
    let bar = card.querySelector(".prog i");
    if (pct && !bar) {
      card.querySelector(".thumb").insertAdjacentHTML("beforeend", '<span class="prog"><i></i></span>');
      bar = card.querySelector(".prog i");
    }
    if (bar) bar.style.width = `${pct}%`;
  }
}

const qLeft = (r) => Math.max(0, (r.len || 0) - (state.qpos[r.id] || 0));
// «3 мин», «1 ч 20 мин», от 3 часов — коротко «≈ 10 ч»
const fmtHours = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h >= 3) return `≈ ${nf.format(Math.round(s / 3600))} ч`;
  return h ? `${h} ч${m ? ` ${m} мин` : ""}` : `${Math.max(1, m)} мин`;
};

function computeQueue() {
  const items = state.queue;
  const allow = (d) => durOk(items[d], state.dur);
  let list;
  let meta = { partial: false, swapped: null };
  const q = state.q.trim();
  if (q) {
    meta = search(state.qindex, state.q, allow);
    list = meta.results || [];
  } else list = items.map((_, d) => ({ d, hits: null })).filter((x) => allow(x.d));
  const by = (f) => list.sort((a, b) => f(items[a.d], items[b.d]) || a.d - b.d);
  const sort = state.sort;
  if (sort === "auto" && q) {
    /* по совпадению — как отдал поиск */
  } else if (sort === "auto") list.sort((a, b) => a.d - b.d);
  else if (sort === "new") by((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  else if (sort === "old") by((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  else if (sort === "started") by((a, b) => Number((state.qpos[b.id] || 0) > 5) - Number((state.qpos[a.id] || 0) > 5));
  else if (sort === "short") by((a, b) => (qLeft(a) || 1e9) - (qLeft(b) || 1e9));
  else if (sort === "long") by((a, b) => qLeft(b) - qLeft(a));
  return { list, meta };
}

// «Продолжить смотреть» — начатые видео крупно над очередью (без поиска и фильтров)
function renderContinue(list) {
  const box = $("#cont");
  const plain = !state.q.trim() && !state.dur && state.sort === "auto";
  const started = plain ? list.filter(({ d }) => (state.qpos[state.queue[d].id] || 0) > 5).slice(0, 3) : [];
  box.hidden = !started.length;
  box.innerHTML = started.length
    ? `<div class="cont-h">Продолжить смотреть</div><div class="cont-g${started.length === 1 ? " solo" : ""}" style="--n:${started.length}">${started.map((x) => qCardHtml(x).replace('class="card"', 'class="card big"')).join("")}</div>`
    : "";
  return new Set(started.map((x) => x.d));
}

function updateQueue({ keep = false } = {}) {
  const computed = computeQueue();
  const shownBig = renderContinue(computed.list);
  // крупные «продолжить» в общей сетке не повторяем
  const list = shownBig.size ? computed.list.filter((x) => !shownBig.has(x.d)) : computed.list;
  const meta = computed.meta;
  const was = state.shown;
  const y = window.scrollY;
  state.list = list;
  state.meta = meta;
  state.shown = 0;
  $("#grid").textContent = "";
  renderQueueSide();
  renderQueueSummary();
  if (keep) {
    while (state.shown < Math.min(was, list.length)) more();
    window.scrollTo({ top: y });
  } else {
    window.scrollTo({ top: 0 });
    more();
  }
  $("#q").placeholder = state.queue.length ? `Поиск в очереди: ${videosWord(state.queue.length)}` : "Поиск в очереди";
  $("#q-play").disabled = !list.length;
  saveHash();
}

function qUrl(r) {
  const t = state.qpos[r.id] || 0;
  return r.short ? `https://www.youtube.com/shorts/${encodeURIComponent(r.id)}` : `https://www.youtube.com/watch?v=${encodeURIComponent(r.id)}${t > 5 ? `&t=${t}s` : ""}`;
}

function qCardHtml({ d, hits }) {
  const r = state.queue[d];
  const t = state.qpos[r.id] || 0;
  const pct = r.len && t > 5 ? Math.min(100, Math.round((t / r.len) * 100)) : 0;
  const href = qUrl(r);
  const when = r.addedAt ? `добавлено ${ago(r.addedAt)}` : "";
  const dur = r.len ? (t > 5 ? `осталось ${fmtHours(qLeft(r))}` : "") : "";
  const sub = [r.channel || (r.short ? "Shorts" : ""), dur, when].filter(Boolean);
  const title = r.title || "Видео без названия";
  return `<article class="card" data-qid="${esc(r.id)}">
    <a class="thumb" href="${href}" data-play="${esc(r.id)}" tabindex="-1" aria-label="${esc(title)}">
      <img loading="lazy" decoding="async" alt="" src="https://i.ytimg.com/vi/${esc(r.id)}/mqdefault.jpg" />
      ${r.len ? `<span class="dur">${fmtLen(r.len)}</span>` : r.short ? `<span class="dur">Shorts</span>` : ""}
      ${pct ? `<span class="prog"><i style="width:${pct}%"></i></span>` : ""}
    </a>
    <a class="title" href="${href}" data-play="${esc(r.id)}" title="${esc(title)}">${hits ? mark(title, hits) : esc(title)}</a>
    <div class="sub" title="${esc(sub.join(" · "))}">${sub.map((x, i) => (i === 0 && hits && r.channel ? mark(x, hits) : esc(x))).join(" · ")}</div>
    <div class="pls">
      ${d > 0 ? `<button type="button" class="chip act" data-qtop="${esc(r.id)}" title="Поставить первым в очереди">${icon("chevron", { size: 14 }).replace("<svg", '<svg style="transform:rotate(-90deg)"')}Наверх</button>` : ""}
      <button type="button" class="chip act" data-qdel="${esc(r.id)}" title="Убрать из очереди">${icon("close", { size: 14 })}Убрать</button>
    </div>
  </article>`;
}

function renderQueueSummary() {
  const el = $("#summary");
  const empty = $("#empty");
  const n = state.list.length;
  if (!n) {
    el.innerHTML = "";
    empty.hidden = false;
    const q = state.q.trim();
    empty.innerHTML = state.queue.length
      ? `<div class="empty-box">
          <div class="empty-icon">${icon("search", { size: 28 })}</div>
          <div class="empty-title">Ничего не нашлось</div>
          <div class="empty-text">${q ? `В очереди нет видео по запросу «${esc(q)}».` : "Под выбранную длину не подходит ни одно видео."}</div>
          ${state.dur ? `<button type="button" class="ghost" data-act="reset">Сбросить фильтры</button>` : ""}
        </div>`
      : `<div class="empty-box">
          <div class="empty-icon">${icon("clock", { size: 28 })}</div>
          <div class="empty-title">Очередь пуста</div>
          <div class="empty-text">Сюда попадают видео «на потом» — вместо десятков открытых вкладок. Нажмите «Собрать вкладки»: все открытые видео YouTube перейдут в очередь вместе с местом, где вы остановились, а вкладки закроются.</div>
          <button type="button" class="primary" data-act="collect">${icon("download", { size: 16 })}Собрать вкладки${state.tabsOpen ? ` · ${nf.format(state.tabsOpen)}` : ""}</button>
        </div>`;
    return;
  }
  empty.hidden = true;
  const leftAll = state.queue.reduce((a, r) => a + qLeft(r), 0);
  let text = state.q.trim() ? `Найдено <b>${videosWord(n)}</b> в очереди` : `<b>${videosWord(n)}</b> в очереди${leftAll ? ` · осталось смотреть ${fmtHours(leftAll)}` : ""}`;
  if (state.meta?.swapped) text += ` · <span class="swap">запрос понят как «${esc(state.meta.swapped)}»</span>`;
  if (state.meta?.partial) text += ` · <span class="swap">точных совпадений нет — показаны похожие</span>`;
  el.innerHTML = text;
}

function renderQueueSide() {
  const q = state.queue;
  const leftAll = q.reduce((a, r) => a + qLeft(r), 0);
  const started = q.filter((r) => (state.qpos[r.id] || 0) > 5).length;
  const shorts = q.filter((r) => r.short || (r.len && r.len <= 61)).length;
  const undo = state.qundo && Date.now() - state.qundo.at < 24 * 3600 * 1000 && state.qundo.tabs?.length ? state.qundo : null;
  const fresh = undo && (state.justCollected || Date.now() - undo.at < 2 * 60 * 1000);
  const sw = (key, title, hint) => `<label class="switch"><span>${title}<small>${hint}</small></span><input type="checkbox" data-opt="${key}" ${state.qopts[key] ? "checked" : ""} /></label>`;
  $("#q-side").innerHTML = `
    ${
      undo
        ? `<div class="q-card q-undo" role="status">
        <div><b>${fresh ? "Собрано" : "Последний сбор"}: ${videosWord(undo.tabs.length)}</b>${fresh ? " — вкладки закрыты, место в каждом видео запомнено." : ` · ${ago(undo.at)}`}</div>
        <div class="row"><button type="button" class="ghost" data-act="restore" title="Открыть эти вкладки снова и убрать их из очереди">${icon("history", { size: 16 })}Вернуть вкладки</button></div>
      </div>`
        : ""
    }
    ${q.length ? `<div class="q-card q-stats">
      <div><div class="q-num">${nf.format(q.length)}</div><div class="q-lbl">${plural(q.length, "видео", "видео", "видео")} в очереди</div></div>
      <div><div class="q-num">${leftAll ? fmtHours(leftAll) : "—"}</div><div class="q-lbl">осталось смотреть</div></div>
      <div><div class="q-num">${nf.format(started)}</div><div class="q-lbl">начато</div></div>
      <div><div class="q-num">${nf.format(shorts)}</div><div class="q-lbl">Shorts и до 1 мин</div></div>
    </div>` : ""}
    <details class="q-card q-set" ${state.qSetOpen ?? !narrow() ? "open" : ""}>
      <summary class="q-h">Как работает очередь</summary>
      ${sw("removeWatched", "Убирать досмотренное", "Досмотрели до конца — видео само уходит из очереди")}
      ${sw("autoNext", "Следующее — само", "После конца видео сразу открывать следующее. Выключено — показать подборку")}
      ${sw("intercept", "Средний клик — в очередь", "Средний клик или Ctrl+клик по видео на YouTube кладёт его в очередь, а не в новую вкладку")}
      <label class="switch"><span>Смотреть прямо здесь<small>Видео из библиотеки и очереди открываются в своём лёгком плеере, а не на странице YouTube</small></span><input type="checkbox" data-local="libWatchHere" ${state.watchHere ? "checked" : ""} /></label>
      <div class="q-offer">
        <span>В конце видео предлагать<small>Подборка из очереди поверх плеера. «Похожие» — тот же канал или похожие названия</small></span>
        <div class="q-offer-row">
          <select data-qsel="offerCount" aria-label="Сколько видео предлагать">${[2, 4, 6]
            .map((n) => `<option value="${n}" ${Number(state.qopts.offerCount) === n ? "selected" : ""}>${n} видео</option>`)
            .join("")}</select>
          <select data-qsel="offerMode" aria-label="Какие видео предлагать">${[
            ["order", "по порядку"],
            ["shuffle", "вперемешку"],
            ["short", "сначала короткие"],
            ["started", "сначала начатые"],
            ["similar", "похожие"],
          ]
            .map(([v, l]) => `<option value="${v}" ${state.qopts.offerMode === v ? "selected" : ""}>${l}</option>`)
            .join("")}</select>
        </div>
      </div>
    </details>
    <div class="q-card keys">
      <div class="q-h" style="grid-column:1/-1;margin:0">Клавиши на странице видео</div>
      <kbd>]</kbd><span>следующее в очереди</span>
      <kbd>[</kbd><span>предыдущее</span>
      <kbd>Shift + ]</kbd><span>досмотрел — убрать и дальше</span>
    </div>
    ${q.length ? `<button type="button" class="ghost danger" data-act="qclear">${icon("close", { size: 16 })}Очистить очередь</button>` : ""}`;
}

const narrow = () => matchMedia("(max-width: 640px)").matches;
document.addEventListener(
  "toggle",
  (e) => {
    if (e.target.classList?.contains("q-set")) state.qSetOpen = e.target.open; // помним, раскрыты ли настройки
  },
  true
);

function onQueueGridClick(e) {
  const top = e.target.closest("[data-qtop]");
  if (top) return void qmsg({ type: "queue:top", id: top.dataset.qtop });
  const del = e.target.closest("[data-qdel]");
  if (del) {
    del.closest(".card")?.style.setProperty("opacity", ".4");
    return void qmsg({ type: "queue:remove", ids: [del.dataset.qdel] });
  }
  const play = e.target.closest("[data-play]");
  // обычный клик — в одной вкладке очереди; Ctrl/средний клик — как обычная ссылка
  if (play && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
    e.preventDefault();
    if (watchHere()) openWatch(play.dataset.play, "queue");
    else void qmsg({ type: "queue:play", id: play.dataset.play });
  }
}

async function refreshTabsCount() {
  const r = await qmsg({ type: "queue:count" });
  state.tabsOpen = r?.ok ? r.n : null;
  const n = state.tabsOpen;
  $("#tabs-text").textContent = n == null ? "" : n ? `Открыто ${videosWord(n)} во вкладках` : "Вкладок с видео нет";
  $("#collect").disabled = !n;
}

async function collect() {
  const btn = $("#collect");
  btn.disabled = true;
  btn.classList.add("spin");
  const r = await qmsg({ type: "queue:collect" });
  btn.classList.remove("spin");
  if (r?.ok) state.justCollected = r.collected;
  await loadQueue();
  await refreshTabsCount();
  if (state.view === "queue") update();
}

let clearArmed = 0;
document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-act]");
  const act = a?.dataset.act;
  if (act === "collect") return void collect();
  if (act === "restore") {
    a.disabled = true;
    await qmsg({ type: "queue:restore" });
    state.justCollected = 0;
    await refreshTabsCount();
    return;
  }
  if (act === "qclear") {
    // второй щелчок в течение 4 секунд — подтверждение
    if (Date.now() - clearArmed > 4000) {
      clearArmed = Date.now();
      a.innerHTML = `${icon("close", { size: 16 })}Точно очистить? ${videosWord(state.queue.length)}`;
      setTimeout(() => state.view === "queue" && Date.now() - clearArmed >= 4000 && renderQueueSide(), 4100);
      return;
    }
    clearArmed = 0;
    await qmsg({ type: "queue:remove", ids: state.queue.map((x) => x.id) });
  }
});
document.addEventListener("change", (e) => {
  const opt = e.target.closest("[data-opt]");
  if (opt) void qmsg({ type: "queue:opts", patch: { [opt.dataset.opt]: opt.checked } });
  const loc = e.target.closest("[data-local]");
  if (loc) {
    state.watchHere = loc.checked;
    void chrome.storage.local.set({ [loc.dataset.local]: loc.checked });
  }
  const sel = e.target.closest("[data-qsel]");
  if (sel) void qmsg({ type: "queue:opts", patch: { [sel.dataset.qsel]: sel.dataset.qsel === "offerCount" ? Number(sel.value) : sel.value } });
});
$("#collect").addEventListener("click", () => void collect());
$("#q-play").addEventListener("click", () => {
  const first = state.list[0];
  if (!first) return;
  if (watchHere()) openWatch(state.queue[first.d].id, "queue");
  else void qmsg({ type: "queue:play", id: state.queue[first.d].id });
});

// ---------- просмотр прямо в библиотеке («свой клиент») ----------
// Встроенный плеер YouTube вместо тяжёлой страницы сайта: большой плеер,
// под ним — кнопки очереди, справа — галерея «Дальше». Управление и место
// просмотра — по протоколу встроенного плеера (postMessage), без чужих скриптов.
// Чтобы YouTube пустил плеер на страницу расширения, background.js ставит
// правило: запросам к youtube.com/embed с наших страниц — заголовок Referer.
const watch = { on: false, id: "", source: "", t: 0, len: 0, frame: null, heard: false, saved: -1, ended: false };

function watchHere() {
  return state.watchHere && !EMBED; // в узкой боковой панели плеер негде показать
}

function watchList() {
  // что показывать в «Дальше»: очередь (по её порядку) или текущий список результатов
  if (watch.source === "queue") return state.queue;
  return state.list.map(({ d }) => state.cat?.videos[d]).filter(Boolean);
}

function watchRec(id = watch.id) {
  return (watch.source === "queue" ? state.queue : state.cat?.videos || []).find((x) => x.id === id) || watch.rec || null;
}

function openWatch(id, source) {
  const rec = (source === "queue" ? state.queue : state.cat?.videos || []).find((x) => x.id === id);
  if (!rec) return;
  saveWatchPos();
  Object.assign(watch, { on: true, id, source, rec, t: source === "queue" ? state.qpos[id] || 0 : 0, len: rec.len || 0, heard: false, saved: -1, ended: false });
  document.body.dataset.watch = "1";
  $("#watch").hidden = false;
  renderWatch();
  window.scrollTo({ top: 0 });
  history.replaceState(null, "", location.pathname + location.search + `#${new URLSearchParams({ ...(state.view === "queue" ? { v: "queue" } : {}), w: id })}`);
}

function closeWatch() {
  if (!watch.on) return;
  saveWatchPos();
  watch.on = false;
  watch.frame = null;
  delete document.body.dataset.watch;
  $("#watch").hidden = true;
  $("#watch").innerHTML = "";
  saveHash();
}

function renderWatch() {
  const r = watchRec();
  if (!r) return closeWatch();
  const list = watchList();
  const i = list.findIndex((x) => x.id === watch.id);
  const next = list.filter((x) => x.id !== watch.id);
  const upNext = i >= 0 ? [...list.slice(i + 1), ...list.slice(0, i)] : next;
  const isQ = watch.source === "queue" && state.queue.some((x) => x.id === r.id);
  const start = Math.floor(watch.t > 5 ? watch.t : 0);
  const src = `https://www.youtube.com/embed/${encodeURIComponent(r.id)}?enablejsapi=1&autoplay=1&rel=0&playsinline=1&iv_load_policy=3${start ? `&start=${start}` : ""}`;
  const sub = [r.channel, r.len ? fmtLen(r.len) : r.short ? "Shorts" : "", watch.source === "queue" ? `${i + 1} из ${list.length} в очереди` : ""].filter(Boolean);
  $("#watch").innerHTML = `
    <div class="w-main">
      <div class="w-player">
        <iframe id="w-frame" title="${esc(r.title)}" src="${src}" allow="autoplay; fullscreen; picture-in-picture; encrypted-media; clipboard-write" allowfullscreen></iframe>
        <div class="w-over" hidden></div>
      </div>
      <div class="w-info">
        <h1 class="w-title">${esc(r.title || "Видео")}</h1>
        <div class="w-sub">${sub.map(esc).join(" · ")}</div>
        <div class="w-acts">
          <button type="button" class="ghost" data-w="back" title="Вернуться к списку — Esc">${icon("chevron", { size: 16 }).replace("<svg", '<svg style="transform:rotate(180deg)"')}К списку</button>
          ${isQ ? `<button type="button" class="primary" data-w="done" title="Убрать из очереди и дальше — Shift+]">${icon("check", { size: 16 })}Досмотрел</button>` : ""}
          ${upNext.length ? `<button type="button" class="ghost" data-w="next" title="Следующее — ]">Дальше${icon("chevron", { size: 16 })}</button>` : ""}
          <button type="button" class="ghost" data-w="yt" title="Открыть это видео на YouTube">${icon("external", { size: 16 })}На YouTube</button>
        </div>
      </div>
    </div>
    ${watchSideHtml(upNext)}`;
  watch.frame = $("#w-frame");
  watch.frame.addEventListener("load", listenPlayer);
}

function watchSideHtml(upNext) {
  return `<aside class="w-next" aria-label="Дальше">
      <div class="w-h">${watch.source === "queue" ? "Дальше в очереди" : "Дальше в списке"}<span>${nf.format(upNext.length)}</span></div>
      <div class="w-list">${upNext
        .slice(0, 60)
        .map((x) => {
          const p = watch.source === "queue" ? state.qpos[x.id] || 0 : 0;
          const pct = x.len && p > 5 ? Math.min(100, Math.round((p / x.len) * 100)) : 0;
          return `<button type="button" class="w-item" data-wgo="${esc(x.id)}" title="${esc(x.title)}">
            <span class="w-th"><img loading="lazy" alt="" src="https://i.ytimg.com/vi/${esc(x.id)}/mqdefault.jpg" />${x.len ? `<span class="dur">${fmtLen(x.len)}</span>` : ""}${pct ? `<span class="prog"><i style="width:${pct}%"></i></span>` : ""}</span>
            <span class="w-it"><b>${esc(x.title || "Видео")}</b><span>${esc(x.channel || (x.short ? "Shorts" : ""))}</span></span>
          </button>`;
        })
        .join("")}</div>
    </aside>`;
}

// очередь поменялась (убрали, добавили) — обновить «Дальше», плеер не трогаем
function refreshWatchSide() {
  if (!watch.on) return;
  const list = watchList();
  const i = list.findIndex((x) => x.id === watch.id);
  const upNext = i >= 0 ? [...list.slice(i + 1), ...list.slice(0, i)] : list.filter((x) => x.id !== watch.id);
  const side = $("#watch .w-next");
  if (side) side.outerHTML = watchSideHtml(upNext);
}

// встроенный плеер начинает присылать состояние, когда его «слушают»
function listenPlayer() {
  let n = 0;
  const frame = watch.frame;
  const tick = () => {
    if (!frame?.isConnected || watch.heard || ++n > 30) return;
    frame.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), "*");
    setTimeout(tick, 400);
  };
  tick();
}

function playerCmd(func, args = []) {
  watch.frame?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
}

window.addEventListener("message", (e) => {
  if (!watch.on || !watch.frame || e.source !== watch.frame.contentWindow) return;
  let d = e.data;
  try {
    if (typeof d === "string") d = JSON.parse(d);
  } catch (err) {
    return;
  }
  watch.heard = true;
  const info = d?.info;
  if (d?.event === "infoDelivery" && info) {
    if (typeof info.currentTime === "number") watch.t = info.currentTime;
    if (info.duration > 0) watch.len = info.duration;
    if (info.playerState === 0) onWatchEnded();
  } else if (d?.event === "onStateChange" && info === 0) onWatchEnded();
  else if (d?.event === "onError") showWatchError(Number(info));
});

function saveWatchPos() {
  if (!watch.on || watch.source !== "queue" || !(watch.t > 0)) return;
  const t = Math.floor(watch.t);
  if (Math.abs(t - watch.saved) < 4) return;
  watch.saved = t;
  void qmsg({ type: "queue:pos", id: watch.id, t, len: watch.len });
}
setInterval(saveWatchPos, 5000);
window.addEventListener("pagehide", saveWatchPos);

function watchGo(step) {
  const list = watchList();
  const i = list.findIndex((x) => x.id === watch.id);
  const to = list[i + step] || (step > 0 ? list.find((x) => x.id !== watch.id) : null);
  if (to) openWatch(to.id, watch.source);
}

async function watchDone() {
  if (watch.source !== "queue") return watchGo(1);
  const list = watchList();
  const i = list.findIndex((x) => x.id === watch.id);
  const after = list[i + 1] || list.find((x) => x.id !== watch.id);
  const id = watch.id;
  watch.t = 0; // досмотрено — место не храним
  await qmsg({ type: "queue:remove", ids: [id] });
  await loadQueue();
  if (after) openWatch(after.id, "queue");
  else closeWatch();
}

// подборка «что дальше» — как на YouTube: сколько и какие — из настроек очереди
function watchPick() {
  const n = [2, 4, 6].includes(Number(state.qopts.offerCount)) ? Number(state.qopts.offerCount) : 4;
  const list = watchList();
  const i = list.findIndex((x) => x.id === watch.id);
  let out = i >= 0 ? [...list.slice(i + 1), ...list.slice(0, i)] : list.filter((x) => x.id !== watch.id);
  const mode = state.qopts.offerMode;
  const cur = watchRec();
  if (mode === "shuffle") out = out.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  else if (mode === "short") out = out.slice().sort((a, b) => (qLeft(a) || 1e9) - (qLeft(b) || 1e9));
  else if (mode === "started") out = out.slice().sort((a, b) => Number((state.qpos[b.id] || 0) > 5) - Number((state.qpos[a.id] || 0) > 5));
  else if (mode === "similar" && cur) {
    const words = (t) => new Set(String(t || "").toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []);
    const w = words(cur.title);
    const score = (r) => (r.channel && r.channel === cur.channel ? 3 : 0) + [...words(r.title)].filter((x) => w.has(x)).length;
    out = out.map((r, k) => ({ r, s: score(r), k })).sort((a, b) => b.s - a.s || a.k - b.k).map((x) => x.r);
  }
  return out.slice(0, n);
}

async function onWatchEnded() {
  if (watch.ended) return;
  watch.ended = true;
  const id = watch.id;
  const items = watchPick();
  if (watch.source === "queue" && state.qopts.removeWatched) {
    watch.t = 0;
    await qmsg({ type: "queue:remove", ids: [id] });
    await loadQueue();
  }
  if (state.qopts.autoNext && items[0]) return openWatch(items[0].id, watch.source);
  showWatchOffer(items);
}

function showWatchOffer(items) {
  const over = $("#watch .w-over");
  if (!over) return;
  if (!items.length) {
    over.innerHTML = `<div class="w-msg"><b>${watch.source === "queue" ? "Очередь досмотрена" : "Это было последнее"}</b><button type="button" class="ghost" data-w="back">К списку</button></div>`;
    over.hidden = false;
    return;
  }
  over.innerHTML = `<div class="w-offer">
      <div class="w-oh"><b>Что посмотреть дальше</b><button type="button" class="ghost" data-w="close-over">Не сейчас</button></div>
      <div class="w-og" style="--n:${Math.min(items.length, items.length === 4 ? 4 : 3)}">${items
        .map(
          (x) => `<button type="button" class="w-oc" data-wgo="${esc(x.id)}" title="${esc(x.title)}">
            <span class="w-th"><img alt="" src="https://i.ytimg.com/vi/${esc(x.id)}/mqdefault.jpg" />${x.len ? `<span class="dur">${fmtLen(x.len)}</span>` : ""}</span>
            <b>${esc(x.title || "Видео")}</b><span>${esc(x.channel || "")}</span>
          </button>`
        )
        .join("")}</div>
    </div>`;
  over.hidden = false;
}

function showWatchError(code) {
  const over = $("#watch .w-over");
  if (!over) return;
  const why =
    code === 101 || code === 150
      ? "Автор запретил смотреть это видео на других страницах."
      : code === 153 || code === 152
        ? "YouTube не пустил плеер на эту страницу."
        : code === 100
          ? "Видео удалено или скрыто."
          : "Плеер YouTube не смог открыть видео.";
  over.innerHTML = `<div class="w-msg">
    <b>Здесь не получится</b><span>${why}</span>
    <div class="w-acts"><button type="button" class="primary" data-w="yt">${icon("external", { size: 16 })}Открыть на YouTube</button>
    ${watchList().length > 1 ? `<button type="button" class="ghost" data-w="next">Дальше${icon("chevron", { size: 16 })}</button>` : ""}</div>
  </div>`;
  over.hidden = false;
}

document.addEventListener("click", (e) => {
  if (!watch.on) return;
  const go = e.target.closest("[data-wgo]");
  if (go) return openWatch(go.dataset.wgo, watch.source);
  const a = e.target.closest("[data-w]")?.dataset.w;
  if (!a) return;
  if (a === "back") closeWatch();
  else if (a === "next") watchGo(1);
  else if (a === "done") void watchDone();
  else if (a === "close-over") $("#watch .w-over").hidden = true;
  else if (a === "yt") {
    saveWatchPos();
    playerCmd("pauseVideo");
    const r = watchRec();
    if (watch.source === "queue" && state.queue.some((x) => x.id === r?.id)) void qmsg({ type: "queue:play", id: r.id });
    else if (r) chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${encodeURIComponent(r.id)}${watch.t > 5 ? `&t=${Math.floor(watch.t)}s` : ""}` });
  }
});

document.addEventListener(
  "keydown",
  (e) => {
    if (!watch.on || e.ctrlKey || e.altKey || e.metaKey) return;
    const t = e.composedPath()[0];
    if (t && ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeWatch();
    } else if (e.code === "BracketRight") {
      e.preventDefault();
      if (e.shiftKey) void watchDone();
      else watchGo(1);
    } else if (e.code === "BracketLeft" && !e.shiftKey) {
      e.preventDefault();
      watchGo(-1);
    }
  },
  true
);

// открывать видео здесь (по умолчанию) или на YouTube — переключатель в настройках очереди
chrome.storage.local.get("libWatchHere").then(({ libWatchHere }) => {
  state.watchHere = libWatchHere !== false;
  if (state.view === "queue") renderQueueSide();
});

// ---------- переключение разделов ----------
function setView(v, { silent = false } = {}) {
  const changed = state.view !== v;
  if (changed && !silent) closeWatch();
  state.view = v;
  document.body.dataset.view = v;
  for (const b of document.querySelectorAll(".views [data-view]")) b.setAttribute("aria-selected", String(b.dataset.view === v));
  if (changed || !$("#sort").options.length) {
    $("#sort").innerHTML = SORTS[v].map(([val, label]) => `<option value="${val}">${label}</option>`).join("");
    state.sort = "auto";
    $("#sort").value = "auto";
  }
  document.title = v === "queue" ? "Очередь — Моя библиотека" : "Моя библиотека — плейлисты YouTube";
  if (v === "queue") void refreshTabsCount();
  if (silent) return;
  if (changed) {
    state.q = "";
    $("#q").value = "";
  }
  update();
  maybeSync();
}

function maybeSync() {
  // каталог плейлистов — только в разделе «Плейлисты»
  if (state.view !== "lib" || state.syncing) return;
  const c = state.cat || state.cached;
  if (!c?.videos || Date.now() - c.syncedAt > STALE) sync();
}

document.querySelector(".views").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (b) setView(b.dataset.view);
});
setInterval(() => state.view === "queue" && document.visibilityState === "visible" && refreshTabsCount(), 10000);

// ---------- события ----------
function setPl(id) {
  state.pl = state.pl === id && id ? "" : id;
  update();
}

let qTimer = 0;
$("#q").addEventListener("input", (e) => {
  closeWatch();
  state.q = e.target.value;
  clearTimeout(qTimer);
  qTimer = setTimeout(update, 70);
});
$("#q").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && e.target.value) {
    e.preventDefault();
    e.target.value = state.q = "";
    update();
  } else if (e.key === "Enter") {
    // Enter — открыть первое найденное (в очереди — в её вкладке)
    const first = $("#grid .title");
    if (first && state.q.trim()) first.click();
  }
});
$("#pl-q").addEventListener("input", (e) => {
  state.plQ = e.target.value;
  renderSide();
});
$("#pl-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pl]");
  if (b) setPl(b.dataset.pl);
});
$("#cont").addEventListener("click", onQueueGridClick);
$("#grid").addEventListener("click", (e) => {
  if (state.view === "queue") return onQueueGridClick(e);
  const link = e.target.closest("a.thumb, a.title");
  if (link && watchHere() && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
    e.preventDefault();
    return openWatch(link.closest(".card")?.dataset.vid, "lib");
  }
  const chip = e.target.closest(".chip[data-pl]");
  if (chip) return setPl(chip.dataset.pl);
  const more = e.target.closest(".chip[data-more]");
  if (more) {
    // показать все плейлисты этого видео
    const v = state.cat.videos[Number(more.dataset.more)];
    const box = more.parentElement;
    box.innerHTML = v.in
      .map(([id]) => state.plById.get(id))
      .filter(Boolean)
      .map((p) => `<button type="button" class="chip" data-pl="${esc(p.id)}">${esc(p.title)}</button>`)
      .join("");
  }
});
$("#dur").addEventListener("click", (e) => {
  const b = e.target.closest("[data-dur]");
  if (!b) return;
  state.dur = b.dataset.dur;
  for (const x of $("#dur").children) x.setAttribute("aria-checked", String(x === b));
  update();
});
$("#sort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  update();
});
$("#sync").addEventListener("click", () => sync());
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-act]");
  if (!a) return;
  if (a.dataset.act === "sync") sync();
  else if (a.dataset.act === "open-yt") chrome.tabs.create({ url: "https://www.youtube.com/" });
  else if (a.dataset.act === "reset") {
    state.pl = "";
    state.dur = "";
    for (const x of $("#dur").children) x.setAttribute("aria-checked", String(!x.dataset.dur));
    update();
  }
});
document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName || "");
  if (!typing && (e.key === "/" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k"))) {
    e.preventDefault();
    $("#q").focus();
    $("#q").select();
  }
});
window.addEventListener("hashchange", async () => {
  await loadQueue(); // сначала данные, потом раздел — иначе на миг дорисуется чужой список
  readHash();
  update();
  maybeSync();
});
new IntersectionObserver((entries) => entries.some((x) => x.isIntersecting) && more(), { rootMargin: "1200px" }).observe($("#more"));
setInterval(() => !state.syncing && state.cat && renderSync(), 60000);

// ---------- где открыта: в панели или во вкладке ----------
let myWindowId = null; // окно этой вкладки — узнаём заранее, чтобы открыть панель без ожидания
chrome.windows?.getCurrent().then((w) => (myWindowId = w.id)).catch(() => {});
function setupWhere() {
  const b = $("#where");
  b.title = b.ariaLabel = EMBED ? "Развернуть во вкладку (и открывать так дальше)" : "Открывать в боковой панели";
  b.innerHTML = icon(EMBED ? "external" : "panel", { size: 18 });
  b.addEventListener("click", async () => {
    void chrome.storage.local.set({ libraryWhere: EMBED ? "tab" : "panel" });
    if (EMBED) {
      await chrome.runtime.sendMessage({ type: "lib:open", forceTab: true, view: state.view === "queue" ? "queue" : "", q: state.q }).catch(() => {});
      parent.postMessage({ ytcsLib: "tab" }, location.origin);
    } else {
      // панель открывается только сразу в ответ на клик — без ожиданий до вызова
      const ok = await chrome.sidePanel.open({ windowId: myWindowId }).then(() => true, () => false);
      if (!ok) return; // не открылась — вкладку не закрываем
      await chrome.storage.session.set({ panelLibrary: { at: Date.now(), q: state.q, view: state.view === "queue" ? "queue" : "" } });
      window.close();
    }
  });
  $("#where-back").addEventListener("click", () => parent.postMessage({ ytcsLib: "back" }, location.origin));
}
if (EMBED) {
  // в панели видео открываем в текущей вкладке, рядом с панелью
  document.addEventListener("click", async (e) => {
    const a = e.target.closest("a[href^='https://www.youtube.com/']");
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0 || a.dataset.play) return;
    e.preventDefault();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.update(tab.id, { url: a.href });
    else chrome.tabs.create({ url: a.href });
  });
}
setupWhere();

// иконки из общего набора расширения
for (const el of document.querySelectorAll("[data-icon]")) el.innerHTML = icon(el.dataset.icon, { size: Number(el.dataset.size) || 16 });

// ---------- старт ----------
readHash();
await loadQueue();
const cached = await kv("catalog").catch(() => null);
if (cached?.videos) useCatalog(cached);
renderSync();
update();
// каталог обновляем сами, только когда смотрят плейлисты (а не очередь сразу после сбора вкладок)
state.cached = cached;
maybeSync();
const startW = new URLSearchParams(location.hash.slice(1)).get("w");
if (startW && !EMBED) openWatch(startW, state.view === "queue" ? "queue" : "lib");
$("#q").focus();
