// Поиск по «Моей библиотеке» из адресной строки Chrome: «yt», пробел (или Tab) и запрос.
// Подсказки — видео из плейлистов и очереди, Enter — открыть (с места, где остановились,
// если видео в очереди). Что и как показывать — omnibox-core.js; здесь только Chrome.
// Индекс строится лениво, держится в памяти service worker и перестраивается, когда
// поменялся каталог библиотеки или очередь (сверка отпечатка при каждом «yt »).

import { kv } from "./library/store.js";
import { buildData, fingerprint, parseInput, suggest, videoUrl } from "./omnibox-core.js";

// chrome.* — только внутри функций: check-exports.mjs импортирует модуль в Node
const libraryBase = () => chrome.runtime.getURL("library/library.html");
let cache = null; // { fp, data }
let loading = null;
let queueDirty = true;

async function load() {
  const [cat, st] = await Promise.all([kv("catalog").catch(() => null), chrome.storage.local.get(["queue", "queuePos"])]);
  const queue = Array.isArray(st.queue) ? st.queue : [];
  const fp = fingerprint(cat, queue);
  if (cache?.fp !== fp) cache = { fp, data: buildData(cat?.videos ? cat : null, queue, st.queuePos || {}) };
  else for (const m of cache.data.metas) if (m.queued) m.at = Number(st.queuePos?.[m.id]) || 0; // место в видео — без перестройки
  queueDirty = false;
  return cache.data;
}

// fresh — перечитать каталог (начало ввода: библиотека могла обновиться)
function getData(fresh = false) {
  if (!loading && (fresh || queueDirty || !cache)) {
    loading = load().finally(() => (loading = null));
  }
  return loading || Promise.resolve(cache?.data || null);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

const blank = (url) => !url || /^(chrome:\/\/(newtab|new-tab-page)\/?|about:blank|chrome-search:\/\/local-ntp)/.test(url);

function libraryUrl(q, view) {
  const h = new URLSearchParams();
  if (view) h.set("v", view);
  if (q) h.set("q", q.slice(0, 200));
  return libraryBase() + (String(h) ? `#${h}` : "");
}

export function setupOmnibox({ openLibrary }) {
  if (!chrome.omnibox) return;
  // очередь поменялась — при следующем вводе перечитаем
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && (ch.queue || ch.queuePos)) queueDirty = true;
  });

  async function openLib(q, view, disposition) {
    if (disposition === "newForegroundTab" || disposition === "newBackgroundTab") {
      await chrome.tabs.create({ url: libraryUrl(q, view), active: disposition === "newForegroundTab" });
      return;
    }
    const tab = await activeTab();
    // набирали в пустой новой вкладке и библиотека нигде не открыта — открываем прямо в ней
    if (tab?.id && blank(tab.url || tab.pendingUrl)) {
      const [open] = await chrome.tabs.query({ url: libraryBase() + "*" });
      if (!open) {
        await chrome.tabs.update(tab.id, { url: libraryUrl(q, view) });
        return;
      }
    }
    await openLibrary(q, tab, view); // уже открытая переедет к вам (или в боковую панель — как выбрано)
  }

  async function openVideo(id, disposition) {
    const data = await getData();
    const url = videoUrl(data?.byId.get(id) || { id });
    if (disposition === "newForegroundTab" || disposition === "newBackgroundTab") {
      await chrome.tabs.create({ url, active: disposition === "newForegroundTab" });
      return;
    }
    const tab = await activeTab();
    if (tab?.id) await chrome.tabs.update(tab.id, { url });
    else await chrome.tabs.create({ url });
  }

  chrome.omnibox.setDefaultSuggestion({ description: suggest(null, "").head });

  chrome.omnibox.onInputStarted.addListener(() => {
    void getData(true).catch(() => {});
  });

  chrome.omnibox.onInputChanged.addListener((text, show) => {
    getData()
      .catch(() => null)
      .then((data) => {
        const r = suggest(data, text);
        chrome.omnibox.setDefaultSuggestion({ description: r.head });
        show(r.items.map(({ content, description }) => ({ content, description })));
      })
      .catch(() => {});
  });

  chrome.omnibox.onInputEntered.addListener((text, disposition) => {
    const inp = parseInput(text);
    const run =
      inp.kind === "video"
        ? openVideo(inp.id, disposition)
        : inp.kind === "queue"
          ? openLib("", "queue", disposition)
          : openLib(inp.kind === "search" ? inp.q : "", "", disposition);
    run.catch(() => {});
  });

  // ввод бросили — вернуть первую строку к началу
  chrome.omnibox.onInputCancelled.addListener(() => {
    chrome.omnibox.setDefaultSuggestion({ description: suggest(null, "").head });
  });
}
