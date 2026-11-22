// «Моя библиотека»: общее состояние, константы и мелкие помощники.


// «Моя библиотека» — мгновенный поиск по всем видео во всех ваших плейлистах.
//
// Как устроено:
//   1. Каталог (плейлисты и видео в них) читается с YouTube от вашего имени —
//      через вкладку YouTube: туда подключается playlists-main.js, и запросы
//      уходят ровно так же, как у самого сайта. Нет открытой вкладки — страница
//      откроет фоновую (раздел «Плейлисты», без звука) и закроет после сбора.
//   2. Каталог хранится в этом браузере (IndexedDB расширения), никуда не уходит.
//   3. Поиск — search.js: опечатки, окончания, раскладка, без сети.


export const EV = "ytcs-pl:2"; // имя канала к playlists-main.js (версия протокола)
export const STALE = 12 * 3600 * 1000; // каталог старше — тихо обновляем при открытии
export const PAGE = 48; // карточек за раз (дальше — по прокрутке)
export const WORKERS = 3; // плейлистов читаем одновременно
export const SPECIAL = { WL: 0, LL: 1 }; // «Смотреть позже» и «Понравившиеся» — сверху

export const $ = (s) => document.querySelector(s);
// открыта внутри боковой панели (рамкой) — узкая раскладка, видео — в текущей вкладке
export const EMBED = new URLSearchParams(location.search).has("panel");
if (EMBED) document.body.classList.add("embed");
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const nf = new Intl.NumberFormat("ru-RU");
export const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};
export const videosWord = (n) => `${nf.format(n)} ${plural(n, "видео", "видео", "видео")}`;
export const plWord = (n) => `${nf.format(n)} ${plural(n, "плейлист", "плейлиста", "плейлистов")}`;
// «в 1 плейлисте», «в 14 плейлистах» — предложный падеж
export const inPlWord = (n) => `${nf.format(n)} ${plural(n, "плейлисте", "плейлистах", "плейлистах")}`;

export const SORTS = {
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

export const state = {
  view: "lib", // «lib» — плейлисты, «queue» — очередь
  watchHere: true, // открывать видео прямо в библиотеке (свой плеер), а не на YouTube
  queue: [], // [{ id, title, channel, len, short, addedAt }]
  qpos: {}, // { id: секунда }
  qopts: { removeWatched: true, autoNext: false, intercept: false, offerCount: 4, offerMode: "order" },
  qindex: null,
  qundo: null,
  tabsOpen: null,
  cat: null, // { syncedAt, fullAt, playlists: [{ id, title, privacy, count, thumb, head, upd, checked }], videos: [...], gone: [...] }
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
  progress: null, // { done, total, videos, changed, full } — пока идёт обновление
  syncNote: null, // { text, at } — итог последнего обновления для строки статуса
  error: "",
};
