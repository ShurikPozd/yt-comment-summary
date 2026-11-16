// Service worker: открытие боковой панели и контекстное меню.
import { sanitizeFilename } from "./groq.js";

function setup() {
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
    chrome.contextMenus.create({ id: `preview@${where}`, title: "Открыть превью видео", contexts, ...extra });
    chrome.contextMenus.create({ id: `download@${where}`, title: "Скачать превью", contexts, ...extra });
  }
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

  if (action === "panel") {
    // sidePanel.open разрешён только в ответ на действие пользователя — клик
    // по пункту меню им и является; вызываем сразу, без await до него.
    chrome.sidePanel.open({ tabId: tab.id }).catch((e) => console.error("sidePanel.open:", e));
    return;
  }

  const id = videoIdFrom(info.linkUrl || "") || videoIdFrom(tab?.url || "");
  if (!id) return;
  if (action === "preview") await openPreview(tab, id);
  if (action === "download") await downloadThumb(tab, id);
});

async function openPreview(tab, id) {
  const { file, title } = await thumbFileName(tab, id);
  const qs = new URLSearchParams({ urls: thumbUrls(id).join(","), title: title || id, name: file });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`sidepanel/preview.html?${qs}`), index: (tab?.index ?? 0) + 1 });
}

async function downloadThumb(tab, id) {
  const url = await bestThumb(id);
  if (!url) return false;
  const { file } = await thumbFileName(tab, id);
  await chrome.downloads.download({ url, filename: file, conflictAction: "uniquify", saveAs: false });
  return true;
}

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
