// Service worker: открытие боковой панели и контекстное меню.
import { sanitizeFilename } from "./groq.js";

// Старые версии при переполнении session складывали кэш комментариев в
// local, где его никто не читал и не удалял. Убираем один раз при запуске.
async function cleanupLocalCache() {
  try {
    const all = await chrome.storage.local.get(null);
    const junk = Object.keys(all).filter((k) => /^(comments|collect|meta|summary):/.test(k));
    if (junk.length) await chrome.storage.local.remove(junk);
  } catch (e) {
    /* не критично */
  }
}

// Встроенный плеер YouTube на странице расширения: Chrome не шлёт Referer со
// страниц расширений, и YouTube отвечает «Ошибка 153». Правило ставит Referer
// только запросам к youtube.com/embed и только с наших страниц.
async function setupEmbedReferer() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [
        {
          id: 1,
          priority: 1,
          action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "set", value: `https://${chrome.runtime.id}.chromiumapp.org/` }] },
          condition: { urlFilter: "||youtube.com/embed/", resourceTypes: ["sub_frame"], initiatorDomains: [chrome.runtime.id] },
        },
      ],
    });
  } catch (e) {
    console.warn("embed referer:", e);
  }
}

function setup() {
  void cleanupLocalCache();
  void setupEmbedReferer();
  chrome.storage.session
    .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
    .catch((e) => console.error("setAccessLevel:", e));
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error("sidePanel behavior:", e));
  void buildMenus();
}

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

// Доступ контент-скрипта к storage.session нужен с первой секунды жизни
// воркера, а не только после установки/старта браузера: иначе запись падала
// в запасной storage.local, которого панель не видит.
chrome.storage.session
  .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
  .catch((e) => console.error("setAccessLevel:", e));

// ---------------- Контекстное меню ----------------
// Системное меню Chrome: внешний вид задаёт браузер, поэтому красоту делаем
// структурой — группа под иконкой расширения, галочки у переключателей,
// короткие подписи и разделители между смысловыми блоками.
// Два места: правый клик на YouTube (страница, ссылка на видео, видео) и
// правый клик по иконке расширения.

const YT_PAGES = ["https://www.youtube.com/*", "https://m.youtube.com/*"];
const PAGE_CTX = ["page", "link", "video", "image", "frame"];

const TOGGLES = [
  ["noAutoplay", "Не запускать видео автоматически"],
  ["hideProgress", "Скрыть полосу прогресса и длительность"],
];

async function readSettings() {
  return (await chrome.storage.local.get("settings")).settings || {};
}

async function buildMenus() {
  await chrome.contextMenus.removeAll();
  const s = await readSettings();
  // выделили текст где угодно — сразу искать его в своих плейлистах
  chrome.contextMenus.create({ id: `${libraryWhere === "panel" ? "librarypanel" : "library"}@selection`, title: "Найти «%s» в моих плейлистах", contexts: ["selection"] });
  // Для правого клика по иконке Chrome ограничивает меню 6 пунктами верхнего
  // уровня — укладываемся.
  for (const [where, contexts, extra] of [
    ["page", PAGE_CTX, { documentUrlPatterns: YT_PAGES }],
    ["action", ["action"], {}],
  ]) {
    for (const [key, title] of TOGGLES) {
      chrome.contextMenus.create({ id: `${key}@${where}`, title, type: "checkbox", checked: Boolean(s[key]), contexts, ...extra });
    }
    chrome.contextMenus.create({ id: `sep1@${where}`, type: "separator", contexts, ...extra });
    chrome.contextMenus.create({ id: `panel@${where}`, title: "Сводка комментариев — открыть панель", contexts, ...extra });
    chrome.contextMenus.create({ id: `clip@${where}`, title: "Вырезать клип из видео", contexts, ...extra });
    // у иконки Chrome уже 6 пунктов (предел) — плейлисты только в меню страницы и по Alt+Shift+S
    if (where === "page") {
      chrome.contextMenus.create({ id: `playlists@${where}`, title: "Сохранить в плейлисты…", contexts, ...extra });
      chrome.contextMenus.create({ id: `${libraryWhere === "panel" ? "librarypanel" : "library"}@${where}`, title: "Моя библиотека — поиск по плейлистам", contexts, ...extra });
    }
    // У иконки Chrome — не больше 6 пунктов верхнего уровня: превью там в подменю.
    if (where === "action") {
      chrome.contextMenus.create({ id: `thumb@${where}`, title: "Превью видео", contexts, ...extra });
      chrome.contextMenus.create({ id: `preview@${where}`, parentId: `thumb@${where}`, title: "Открыть превью", contexts, ...extra });
      chrome.contextMenus.create({ id: `download@${where}`, parentId: `thumb@${where}`, title: "Скачать превью", contexts, ...extra });
    } else {
      chrome.contextMenus.create({ id: `preview@${where}`, title: "Открыть превью видео", contexts, ...extra });
      chrome.contextMenus.create({ id: `download@${where}`, title: "Скачать превью", contexts, ...extra });
    }
  }
  // Очередь «посмотреть потом»
  const WATCH_PAGES = ["https://www.youtube.com/watch*", "https://www.youtube.com/shorts/*"];
  const VIDEO_LINKS = ["https://www.youtube.com/watch*", "https://www.youtube.com/shorts/*", "https://youtu.be/*", "https://m.youtube.com/watch*"];
  chrome.contextMenus.create({ id: "sepq@page", type: "separator", contexts: ["page", "video"], documentUrlPatterns: YT_PAGES });
  chrome.contextMenus.create({ id: "defer@page", title: "Отложить видео в очередь", contexts: ["page", "video"], documentUrlPatterns: WATCH_PAGES });
  chrome.contextMenus.create({ id: "queueadd@link", title: "Добавить в очередь", contexts: ["link"], targetUrlPatterns: VIDEO_LINKS });
  chrome.contextMenus.create({ id: "collect@page", title: "Собрать вкладки YouTube в очередь", contexts: ["page", "video"], documentUrlPatterns: YT_PAGES });
}

// Галочки следуют за настройками, где бы их ни поменяли (панель или меню).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const s = changes.settings.newValue || {};
  for (const [key] of TOGGLES) {
    for (const where of ["page", "action"]) {
      chrome.contextMenus.update(`${key}@${where}`, { checked: Boolean(s[key]) }).catch(() => {});
    }
  }
});

// id видео: из ссылки, по которой щёлкнули (превью в ленте), иначе из вкладки.
function videoIdFrom(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)youtube\.com$|^youtu\.be$/.test(u.hostname)) return null;
    let id = null;
    if (u.hostname === "youtu.be") id = u.pathname.slice(1, 12);
    else if (u.pathname === "/watch") id = u.searchParams.get("v");
    else id = (u.pathname.match(/^\/(shorts|live|embed)\/([A-Za-z0-9_-]{11})/) || [])[2];
    // id ролика YouTube — ровно 11 символов [A-Za-z0-9_-]; всё остальное отбрасываем
    return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
  } catch (e) {
    return null;
  }
}

const thumbUrls = (id) => [
  `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
  `https://i.ytimg.com/vi/${id}/sddefault.jpg`,
  `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
];

// Лучшее реально доступное качество (у части видео нет maxres — YouTube
// отвечает 404 с серой заглушкой).
async function bestThumb(id) {
  for (const url of thumbUrls(id)) {
    try {
      const r = await fetch(url, { method: "HEAD" });
      if (r.ok) return url;
    } catch (e) {
      /* следующее качество */
    }
  }
  return null;
}

// Название и канал: у открытого видео — из контент-скрипта, иначе из заголовка вкладки.
async function videoMeta(tab, id) {
  const current = videoIdFrom(tab?.url || "") === id;
  if (current && tab?.id) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: "yt:meta-query" });
      if (r?.meta?.title) return { title: r.meta.title, channel: r.meta.channelName || "" };
    } catch (e) {
      /* контент-скрипт недоступен */
    }
    return { title: String(tab.title || "").replace(/\s*-\s*YouTube\s*$/, ""), channel: "" };
  }
  // Видео из ленты/рекомендаций: название и канал отдаёт открытый oEmbed YouTube.
  try {
    const r = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`
    );
    if (r.ok) {
      const j = await r.json();
      return { title: j.title || "", channel: j.author_name || "" };
    }
  } catch (e) {
    /* без названия — имя файла будет по id */
  }
  return { title: "", channel: "" };
}

async function thumbFileName(tab, id) {
  const s = await readSettings();
  const { title, channel } = await videoMeta(tab, id);
  const tpl = s.thumbTemplate || "{title} - {channel}";
  const name = tpl
    .replaceAll("{title}", sanitizeFilename(title || id))
    .replaceAll("{channel}", sanitizeFilename(channel || "YouTube"))
    .replaceAll("{videoid}", id);
  return { file: sanitizeFilename(name) + ".jpg", title };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const [action] = String(info.menuItemId).split("@");

  if (TOGGLES.some(([key]) => key === action)) {
    const s = await readSettings();
    s[action] = Boolean(info.checked);
    await chrome.storage.local.set({ settings: s }); // контент-скрипт и панель подхватят сами
    return;
  }

  if (action === "library" || action === "librarypanel") {
    void openLibrary(info.selectionText || "", tab, "", { where: action === "librarypanel" ? "panel" : "tab" });
    return;
  }

  if (action === "defer") {
    if (tab?.id) {
      const r = await chrome.tabs.sendMessage(tab.id, { type: "yt:defer" }).catch(() => null);
      if (!r?.ok) chrome.tabs.sendMessage(tab.id, { type: "yt:toast", text: "Обновите страницу видео (F5)" }).catch(() => {});
    }
    return;
  }

  if (action === "queueadd") {
    const id = videoIdFrom(info.linkUrl || "");
    if (!id) return;
    const r = await qAdd([{ id, short: /\/shorts\//.test(info.linkUrl || "") }]);
    if (tab?.id) {
      const text = r.added.length ? `Добавлено в очередь · всего ${r.total}` : `Уже в очереди · всего ${r.total}`;
      chrome.tabs.sendMessage(tab.id, { type: "yt:toast", text }).catch(() => {});
    }
    return;
  }

  if (action === "collect") {
    await openLibrary("", tab || null, "queue");
    await collectTabs(tab?.id ?? null); // вкладка, где щёлкнули, остаётся; библиотека увидит сбор сама
    return;
  }

  if (action === "playlists") {
    // по превью в ленте — тот ролик, иначе видео страницы
    const vid = videoIdFrom(info.linkUrl || "") || videoIdFrom(tab?.url || "");
    if (tab?.id) {
      const r = await chrome.tabs.sendMessage(tab.id, { type: "yt:playlists", videoId: vid }).catch(() => null);
      if (!r?.ok) chrome.tabs.sendMessage(tab.id, { type: "yt:toast", text: "Обновите страницу (F5)" }).catch(() => {});
    }
    return;
  }

  if (action === "clip") {
    if (tab?.id) {
      const r = await chrome.tabs.sendMessage(tab.id, { type: "yt:clip" }).catch(() => null);
      if (!r?.ok) chrome.tabs.sendMessage(tab.id, { type: "yt:toast", text: "Обновите страницу видео (F5)" }).catch(() => {});
    }
    return;
  }

  if (action === "panel") {
    // sidePanel.open разрешён только в ответ на действие пользователя — клик
    // по пункту меню им и является; вызываем сразу, без await до него.
    chrome.sidePanel.open({ tabId: tab.id }).catch((e) => console.error("sidePanel.open:", e));
    return;
  }

  const id = videoIdFrom(info.linkUrl || "") || videoIdFrom(tab?.url || "");
  if (!id) {
    // правый клик не по видео — подсказываем на странице, а не молчим
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "yt:toast", text: "Это не видео — щёлкните по ролику или его превью" }).catch(() => {});
    return;
  }
  if (action === "preview") await openPreview(tab, id);
  if (action === "download") await downloadThumb(tab, id);
});

// Превью — поверх страницы YouTube (окно рисует content.js). Если вкладка не
// отвечает (страницу открыли до установки расширения) — отдельная вкладка.
async function openPreview(tab, id) {
  const { file, title } = await thumbFileName(tab, id);
  const payload = { urls: thumbUrls(id), title: title || id, name: file };
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: "yt:preview", ...payload });
    if (r?.ok) return;
  } catch (e) {
    /* контент-скрипта нет — ниже вкладка */
  }
  const qs = new URLSearchParams({ urls: payload.urls.join(","), title: payload.title, name: file });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`sidepanel/preview.html?${qs}`), index: (tab?.index ?? 0) + 1 });
}

// Окно превью на странице: скачать выбранное качество / отдать картинку для
// копирования (у фона есть доступ к i.ytimg.com, у страницы YouTube — нет).
const THUMB_URL_RE = /^https:\/\/i\.ytimg\.com\/vi\/[A-Za-z0-9_-]{11}\/\w+\.jpg$/;
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "ui:thumb" || !sender.tab || !THUMB_URL_RE.test(String(msg.url || ""))) return;
  if (msg.op === "download") {
    const name = /\.jpg$/i.test(String(msg.name || "")) ? String(msg.name) : "thumbnail.jpg";
    chrome.downloads
      .download({ url: msg.url, filename: name, conflictAction: "uniquify", saveAs: false })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.op === "data") {
    fetch(msg.url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("HTTP " + r.status))))
      .then((buf) => {
        const bytes = new Uint8Array(buf);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        sendResponse({ ok: true, dataUrl: "data:image/jpeg;base64," + btoa(bin) });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});

async function downloadThumb(tab, id) {
  const url = await bestThumb(id);
  if (!url) return false;
  const { file } = await thumbFileName(tab, id);
  await chrome.downloads.download({ url, filename: file, conflictAction: "uniquify", saveAs: false });
  return true;
}

// Клипы: библиотеку склейки вставляем во вкладку по первому клипу — в тот же
// изолированный мир, где работает clip.js.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "clip:lib" || !sender.tab?.id) return;
  chrome.scripting
    .executeScript({ target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] }, files: ["vendor/mediabunny.js"] })
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

// «Моя библиотека» — одна вкладка на всё, и всегда справа от той, где вы
// сейчас: уже открыта где-то далеко — переезжает сюда (а не вы листаете к ней).
// q — запрос поиска, view — раздел («queue» — очередь), extra — прочие параметры.
const LIBRARY_URL = chrome.runtime.getURL("library/library.html");
// Где открывать: «tab» — вкладка справа от текущей, «panel» — боковая панель.
// Держим в памяти: открыть панель Chrome разрешает только сразу в ответ на
// действие пользователя, без ожидания хранилища.
let libraryWhere = "tab";
chrome.storage.local.get("libraryWhere").then((r) => (libraryWhere = r.libraryWhere === "panel" ? "panel" : "tab"));
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.libraryWhere) return;
  libraryWhere = ch.libraryWhere.newValue === "panel" ? "panel" : "tab";
  void buildMenus(); // пункт правого клика несёт выбор в себе — пересобираем
});

async function openLibrary(q = "", from = null, view = "", extra = {}) {
  // where — от того, кто просит (меню плеера, правый клик знают выбор сами); иначе — из памяти
  const where = extra.where || libraryWhere;
  if (where === "panel" && !extra.forceTab) {
    // сначала — открыть панель (пока действие пользователя «свежее»), потом сказать ей, что показать
    const target = from?.id ? { tabId: from.id } : from?.windowId ? { windowId: from.windowId } : null;
    const opened = target ? await chrome.sidePanel.open(target).then(() => true, () => false) : false;
    if (opened) {
      await chrome.storage.session.set({ panelLibrary: { at: Date.now(), q: q.trim().slice(0, 200), view } });
      return;
    }
  }
  delete extra.forceTab;
  delete extra.where;
  const h = new URLSearchParams();
  if (view) h.set("v", view);
  if (q.trim()) h.set("q", q.trim().slice(0, 200));
  for (const [k, v] of Object.entries(extra)) h.set(k, String(v));
  const url = LIBRARY_URL + (String(h) ? `#${h}` : "");
  const here = from?.id ? from : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  const [open] = await chrome.tabs.query({ url: LIBRARY_URL + "*" });
  if (open?.id) {
    if (here && here.id !== open.id) {
      // переносим к активной вкладке (и в её окно), затем показываем
      const index = open.windowId === here.windowId && open.index < here.index ? here.index : here.index + 1;
      await chrome.tabs.move(open.id, { windowId: here.windowId, index }).catch(() => {});
    }
    await chrome.tabs.update(open.id, { active: true, ...(String(h) ? { url } : {}) });
    if (here?.windowId) chrome.windows.update(here.windowId, { focused: true }).catch(() => {});
    return;
  }
  await chrome.tabs.create({ url, ...(here ? { index: here.index + 1, windowId: here.windowId } : {}) });
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "lib:open") return;
  openLibrary(String(msg.q || ""), sender.tab || null, String(msg.view || ""), { forceTab: Boolean(msg.forceTab), where: msg.where === "panel" ? "panel" : msg.where === "tab" ? "tab" : "" })
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

// ---------------- Очередь «посмотреть потом» ----------------
// Вместо сотен вкладок — список в этом браузере: видео, где вы остановились,
// и одна вкладка для просмотра. Пишет в очередь только этот скрипт (по
// сообщениям), по одному изменению за раз — вкладки не затирают друг друга.
//   queue     — [{ id, title, channel, len, short, addedAt }] в порядке просмотра
//   queuePos  — { id: секунда, на которой остановились }
//   queueOpts — настройки (см. Q_DEFAULTS)
//   queueUndo — последние собранные вкладки (для «Вернуть вкладки»)
const Q_DEFAULTS = { removeWatched: true, autoNext: false, intercept: false, offerCount: 4, offerMode: "order" };
const OFFER_MODES = ["order", "shuffle", "short", "started", "similar"];
const Q_MAX = 5000;
let qChain = Promise.resolve();
const qSerial = (fn) => (qChain = qChain.then(fn, fn));
const cleanTitle = (t) =>
  String(t || "")
    .replace(/^\(\d+\)\s*/, "")
    .replace(/\s*[-–]\s*YouTube$/, "")
    .trim();

async function qLoad() {
  const r = await chrome.storage.local.get(["queue", "queuePos"]);
  return { queue: Array.isArray(r.queue) ? r.queue : [], pos: r.queuePos || {} };
}

function qAdd(items, at = -1) {
  return qSerial(async () => {
    const { queue, pos } = await qLoad();
    const byId = new Map(queue.map((x) => [x.id, x]));
    const added = [];
    for (const it of items) {
      if (!/^[A-Za-z0-9_-]{11}$/.test(it?.id || "")) continue;
      const cur = byId.get(it.id);
      if (cur) {
        // уже в очереди — дополняем то, чего не знали
        for (const k of ["title", "channel", "len"]) if (!cur[k] && it[k]) cur[k] = it[k];
      } else {
        const rec = {
          id: it.id,
          title: String(it.title || "").slice(0, 300),
          channel: String(it.channel || "").slice(0, 120),
          len: Math.round(Number(it.len) || 0),
          short: Boolean(it.short),
          addedAt: Date.now(),
        };
        // at — вернуть на прежнее место («Вернуть» после «Досмотрел»), иначе в конец
        if (at >= 0 && at <= queue.length) queue.splice(at + added.length, 0, rec);
        else queue.push(rec);
        byId.set(it.id, rec);
        added.push(it.id);
      }
      if (Number(it.t) > 5) pos[it.id] = Math.floor(it.t);
    }
    const kept = queue.slice(-Q_MAX);
    await chrome.storage.local.set({ queue: kept, queuePos: pos });
    const noTitle = kept.filter((x) => !x.title && added.includes(x.id)).map((x) => x.id);
    if (noTitle.length) setTimeout(() => void qFillMeta(noTitle), 0);
    return { added, total: kept.length };
  });
}

// У видео без названия (добавлены по ссылке) — подтянуть название и канал
// из открытого oEmbed YouTube. Без ключей и входа, по несколько за раз.
async function qFillMeta(ids) {
  for (let i = 0; i < ids.length; i += 4) {
    const part = await Promise.all(
      ids.slice(i, i + 4).map((id) =>
        fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => (j ? { id, title: j.title || "", channel: j.author_name || "" } : null))
          .catch(() => null)
      )
    );
    const got = part.filter(Boolean);
    if (!got.length) continue;
    await qSerial(async () => {
      const { queue } = await qLoad();
      const byId = new Map(queue.map((x) => [x.id, x]));
      for (const m of got) {
        const rec = byId.get(m.id);
        if (!rec) continue;
        if (!rec.title) rec.title = m.title;
        if (!rec.channel) rec.channel = m.channel;
      }
      await chrome.storage.local.set({ queue });
    });
  }
}

function qRemove(ids) {
  const drop = new Set(ids);
  return qSerial(async () => {
    const { queue, pos } = await qLoad();
    for (const id of drop) delete pos[id];
    const left = queue.filter((x) => !drop.has(x.id));
    await chrome.storage.local.set({ queue: left, queuePos: pos });
    return { total: left.length };
  });
}

function qTop(id) {
  return qSerial(async () => {
    const { queue } = await qLoad();
    const i = queue.findIndex((x) => x.id === id);
    if (i > 0) queue.unshift(...queue.splice(i, 1));
    await chrome.storage.local.set({ queue });
    return { ok: true };
  });
}

function qPos(id, t, len) {
  return qSerial(async () => {
    const { queue, pos } = await qLoad();
    const rec = queue.find((x) => x.id === id);
    if (!rec) return { ok: false };
    // на последних секундах — «досмотрено»: в следующий раз с начала, а не с конца
    if (len > 0 && t >= len - Math.max(15, len * 0.03)) delete pos[id];
    else pos[id] = Math.floor(t);
    if (!rec.len && len > 0) {
      rec.len = Math.round(len);
      await chrome.storage.local.set({ queue, queuePos: pos });
    } else await chrome.storage.local.set({ queuePos: pos });
    return { ok: true };
  });
}

async function qOpts(patch = null) {
  if (patch) return qSerial(() => qOptsWrite(patch)); // два быстрых переключения не затирают друг друга
  return { ...Q_DEFAULTS, ...((await chrome.storage.local.get("queueOpts")).queueOpts || {}) };
}
async function qOptsWrite(patch) {
  const cur = { ...Q_DEFAULTS, ...((await chrome.storage.local.get("queueOpts")).queueOpts || {}) };
  const next = { ...cur };
  for (const k of ["removeWatched", "autoNext", "intercept"]) if (k in patch) next[k] = Boolean(patch[k]);
  if ([2, 4, 6].includes(Number(patch.offerCount))) next.offerCount = Number(patch.offerCount);
  if (OFFER_MODES.includes(patch.offerMode)) next.offerMode = patch.offerMode;
  await chrome.storage.local.set({ queueOpts: next });
  return next;
}

const VIDEO_TABS = ["https://www.youtube.com/watch*", "https://www.youtube.com/shorts/*", "https://m.youtube.com/watch*", "https://m.youtube.com/shorts/*"];

// Выполняется во вкладке с видео: где остановились, длина, название, канал
function readTabVideo() {
  const v = document.querySelector("#movie_player video") || document.querySelector("video");
  const title = document.querySelector("ytd-watch-metadata h1 yt-formatted-string, h1.ytd-watch-metadata, #title h1")?.textContent?.trim() || "";
  const channel = document.querySelector("ytd-watch-metadata #channel-name a, #owner #channel-name a, ytd-video-owner-renderer #channel-name a")?.textContent?.trim() || "";
  return { t: v ? v.currentTime : 0, len: v && Number.isFinite(v.duration) ? Math.round(v.duration) : 0, title, channel };
}

// Вкладки, которые соберёт «Собрать вкладки»: все с видео, кроме текущей и закреплённых
// keepId — вкладка, с которой попросили собрать (она остаётся); иначе — текущая
async function videoTabs(keepId = null) {
  const keep = keepId ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  return (await chrome.tabs.query({ url: VIDEO_TABS })).filter((t) => t.id !== keep && !t.pinned);
}

async function collectTabs(keepId = null) {
  const tabs = await videoTabs(keepId);
  const found = [];
  await Promise.all(
    tabs.map(async (tab) => {
      const id = videoIdFrom(tab.url || "");
      if (!id) return;
      let info = null;
      if (!tab.discarded && tab.status === "complete") {
        info = await Promise.race([
          chrome.scripting
            .executeScript({ target: { tabId: tab.id }, func: readTabVideo })
            .then((r) => r?.[0]?.result || null)
            .catch(() => null),
          new Promise((ok) => setTimeout(() => ok(null), 1500)),
        ]);
      }
      let urlT = 0;
      try {
        urlT = parseInt(new URL(tab.url).searchParams.get("t") || "0", 10) || 0;
      } catch (e) {
        /* без t */
      }
      found.push({
        tab,
        item: { id, title: info?.title || cleanTitle(tab.title), channel: info?.channel || "", len: info?.len || 0, short: /\/shorts\//.test(tab.url), t: info?.t || urlT },
      });
    })
  );
  // в очередь — в том порядке, в каком стояли вкладки
  found.sort((a, b) => a.tab.windowId - b.tab.windowId || a.tab.index - b.tab.index);
  const r = await qAdd(found.map((x) => x.item));
  await chrome.storage.local.set({
    queueUndo: { at: Date.now(), added: r.added, tabs: found.map(({ tab }) => ({ url: tab.url, windowId: tab.windowId, index: tab.index })) },
  });
  if (found.length) await chrome.tabs.remove(found.map((x) => x.tab.id)).catch(() => {});
  return { collected: found.length, added: r.added.length, total: r.total };
}

// «Вернуть вкладки»: открыть собранные обратно и убрать из очереди то, что добавил сбор
async function restoreTabs() {
  const { queueUndo } = await chrome.storage.local.get("queueUndo");
  if (!queueUndo?.tabs?.length) return { restored: 0 };
  const windows = new Set((await chrome.windows.getAll()).map((w) => w.id));
  for (const t of queueUndo.tabs) {
    const opts = { url: t.url, active: false };
    if (windows.has(t.windowId)) Object.assign(opts, { windowId: t.windowId, index: t.index });
    const tab = await chrome.tabs.create(opts).catch(() => null);
    // сотни вкладок разом подвесили бы компьютер — каждая загрузится, когда на неё переключитесь
    if (tab?.id) setTimeout(() => chrome.tabs.discard(tab.id).catch(() => {}), 300);
  }
  if (queueUndo.added?.length) await qRemove(queueUndo.added);
  await chrome.storage.local.remove("queueUndo");
  return { restored: queueUndo.tabs.length };
}

// Смотреть видео из очереди — всегда в одной и той же вкладке
async function queuePlay(id, from = null) {
  const { queue, pos } = await qLoad();
  const rec = queue.find((x) => x.id === id);
  if (!rec) return;
  const t = pos[id] || 0;
  const url = rec.short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}${t > 5 ? `&t=${t}s` : ""}`;
  const { queueTab } = await chrome.storage.session.get("queueTab");
  const tab = queueTab ? await chrome.tabs.get(queueTab).catch(() => null) : null;
  if (tab) {
    await chrome.tabs.update(tab.id, { url, active: true });
    chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return;
  }
  const here = from?.id ? from : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  const created = await chrome.tabs.create({ url, ...(here ? { index: here.index + 1, windowId: here.windowId } : {}) });
  await chrome.storage.session.set({ queueTab: created.id });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { queueTab } = await chrome.storage.session.get("queueTab");
  if (queueTab === tabId) await chrome.storage.session.remove("queueTab");
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (typeof msg?.type !== "string" || !msg.type.startsWith("queue:")) return;
  const tab = sender.tab || null;
  const run = {
    "queue:add": () => qAdd(Array.isArray(msg.items) ? msg.items : [], Number.isInteger(msg.at) ? msg.at : -1),
    "queue:remove": () => qRemove(Array.isArray(msg.ids) ? msg.ids.map(String) : []),
    "queue:top": () => qTop(String(msg.id || "")),
    "queue:pos": () => qPos(String(msg.id || ""), Number(msg.t) || 0, Number(msg.len) || 0),
    "queue:opts": () => qOpts(msg.patch && typeof msg.patch === "object" ? msg.patch : null).then((opts) => ({ opts })),
    "queue:collect": () => collectTabs(),
    "queue:restore": () => restoreTabs(),
    "queue:count": () => videoTabs().then((t) => ({ n: t.length })),
    "queue:play": () => queuePlay(String(msg.id || ""), tab).then(() => ({})),
    // «Отложить»: это видео — в очередь (с местом, где остановились) и закрыть его вкладку
    "queue:defer": async () => {
      const r = await qAdd([msg.item || {}]);
      if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
      return r;
    },
  }[msg.type];
  if (!run) return;
  run()
    .then((r) => sendResponse({ ok: true, ...(r || {}) }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

// Действия из нашей кнопки в плеере YouTube (меню рисует content.js).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "ui:action" || !sender.tab) return;
  const tab = sender.tab;
  if (msg.action === "panel") {
    // Клик по кнопке в плеере — действие пользователя; открываем сразу,
    // до любых await, иначе Chrome сочтёт вызов не связанным с кликом.
    chrome.sidePanel
      .open({ tabId: tab.id })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  const id = videoIdFrom(tab.url || "");
  if (!id) {
    sendResponse({ ok: false });
    return;
  }
  const run = msg.action === "preview" ? openPreview(tab, id).then(() => true) : downloadThumb(tab, id);
  run.then((ok) => sendResponse({ ok })).catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

// ---------------- Горячие клавиши ----------------
// Alt+Shift+Y открывает панель (_execute_action — Chrome делает это сам),
// Alt+Shift+K / Alt+Shift+H переключают режимы плеера. Поменять сочетания
// можно на chrome://extensions/shortcuts.
const COMMAND_TOGGLES = { "toggle-no-autoplay": "noAutoplay", "toggle-hide-progress": "hideProgress" };

chrome.commands.onCommand.addListener(async (command, cmdTab) => {
  if (command === "open-library") {
    // вкладку Chrome передаёт сам — без ожидания (панель открывается только «сразу»)
    void openLibrary("", cmdTab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]);
    return;
  }
  if (command === "collect-tabs") {
    await openLibrary("", cmdTab || null, "queue");
    await collectTabs(cmdTab?.id ?? null);
    return;
  }
  if (command === "defer-video") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && /^https:\/\/(www|m)\.youtube\.com\/(watch|shorts\/)/.test(tab.url || "")) chrome.tabs.sendMessage(tab.id, { type: "yt:defer" }).catch(() => {});
    return;
  }
  if (command === "save-to-playlists") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && /^https:\/\/(www|m)\.youtube\.com\//.test(tab.url || "")) {
      chrome.tabs.sendMessage(tab.id, { type: "yt:playlists" }).catch(() => {});
    }
    return;
  }
  const key = COMMAND_TOGGLES[command];
  if (!key) return;
  const s = await readSettings();
  s[key] = !s[key];
  // контент-скрипт увидит изменение и покажет плашку-подтверждение на странице
  await chrome.storage.local.set({ settings: s });
});
