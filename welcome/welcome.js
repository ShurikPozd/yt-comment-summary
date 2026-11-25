// «Что умеет расширение»: все возможности по разделам, клавиши и «Что нового».
// Открывается сама при установке (welcome-bg.js), по ссылке в настройках панели
// и кнопкой «?» в шапке «Моей библиотеки». После крупного обновления фон ставит
// метку whatsNew (значок «NEW») — здесь она показывается и снимается.

import { openPanel } from "../panel-window.js";
import { icon } from "../sidepanel/icons.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Иконки, которых нет в общем наборе панели, — в том же стиле: 24×24, обводка 2
const EXTRA = {
  gauge: '<path d="M4.5 18.5a9 9 0 1 1 15 0"/><path d="M12 14l4.5-5"/><circle cx="12" cy="14" r="1.2" fill="currentColor"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
  shield: '<path d="M12 3l8 3v6c0 4.6-3.4 8.3-8 9-4.6-.7-8-4.4-8-9V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  send: '<path d="M21 3L10.5 13.5"/><path d="M21 3l-6.5 18-4-7.5L3 9.5z"/>',
  queue: '<path d="M4 6h12"/><path d="M4 11h12"/><path d="M4 16h6"/><path d="M14.5 14v7l5.5-3.5z" fill="currentColor"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 21h4"/>',
  chart: '<path d="M4 20h16"/><path d="M7 16v-5"/><path d="M12 16V6"/><path d="M17 16v-8"/>',
  bookmark: '<path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/><path d="M12 7.5v5"/><path d="M9.5 10h5"/>',
  omni: '<rect x="2.5" y="6" width="19" height="12" rx="6"/><circle cx="9" cy="12" r="2.4"/><path d="M11 14l2 2"/><path d="M15 12h3"/>',
  covers: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M10 9v4.5l4-2.25z" fill="currentColor"/><path d="M7 20.5h10"/>',
  key: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
};
const svg = (name, size = 22) =>
  EXTRA[name]
    ? `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${EXTRA[name]}</svg>`
    : icon(name, { size });

// ---------- клавиши плашками ----------
// «Alt+Shift+Y» → плашки Alt + Shift + Y; «клик» — словом, не плашкой;
// «Shift+←|→» — Shift + ← / → (варианты последней клавиши)
const WORDS = new Set(["клик", "колесо"]);
const plate = (k) => (WORDS.has(k) ? `<span class="kword">${esc(k)}</span>` : `<kbd class="key">${esc(k)}</kbd>`);
function keys(combo) {
  return combo
    .split(/\s*\+\s*/)
    .map((k) => (k.length > 1 && k.includes("|") ? k.split("|").map(plate).join('<span class="or">/</span>') : plate(k)))
    .join('<span class="plus">+</span>');
}
// несколько вариантов: «]» или «[» — через «/»
const keysAny = (list) => list.map(keys).join('<span class="or">/</span>');

// ---------- возможности ----------
// foot: { go, label } — кнопка «Попробовать»; { where } — где найти; { keys } — сочетание
const CARDS = [
  // На YouTube
  {
    g: "youtube",
    ic: "gauge",
    t: "Плеер под вас",
    d: "Видео не запускается само, полосу прогресса можно спрятать. Скорость запоминается для каждого канала и поднимается выше 2× — до 4×.",
    foot: { go: "settings", label: "Настройки плеера" },
  },
  {
    g: "youtube",
    ic: "moon",
    t: "Тишина и таймер сна",
    d: "Паузы в лекциях и подкастах проходят в 2,5 раза быстрее, а речь — с вашей скоростью. Таймер сна плавно приглушит звук и поставит паузу.",
    foot: { where: "меню в плеере: «Таймер сна» и «Плеер ›»" },
  },
  {
    g: "youtube",
    ic: "shield",
    t: "Без рекламы и отвлечений",
    d: "Рекламные вставки внутри роликов пропускаются сами. «Без отвлечений» прячет Shorts, рекомендации и заставки в конце видео.",
    foot: { go: "settings", label: "Выбрать, что прятать" },
  },
  {
    g: "youtube",
    ic: "clip",
    t: "Клипы из видео",
    d: "Выберите отрезок — получите MP4 или M4A за несколько секунд, без перекодирования. Telegram и мессенджеры открывают его без YouTube.",
    foot: { where: "меню в плеере: «Видео и превью ›»" },
  },
  {
    g: "youtube",
    ic: "covers",
    t: "Пересказ и превью на обложках",
    d: "Наведите на любую обложку: «О чём видео» — пересказ по субтитрам с таймкодами, «Превью» — обложка крупно, скачать или скопировать.",
    foot: { where: "кнопки в углу обложки" },
  },
  {
    g: "youtube",
    ic: "send",
    t: "Архив Telegram",
    d: "Отправьте видео в свой бот-архив: ссылка, обложка и готовый пересказ. Папку подберёт ИИ, одно и то же видео дважды не сохранится.",
    foot: { where: "самолётик на обложке, «Сохранить ›» в меню" },
  },
  // Панель
  {
    g: "panel",
    ic: "chat",
    t: "Сводка комментариев",
    d: "ИИ-сводка обсуждения: настроение зрителей, главные темы и мнения. Скопировать можно текстом или картинкой — для Telegram.",
    foot: { keys: "Alt+Shift+Y", cmd: "_execute_action" },
  },
  {
    g: "panel",
    ic: "subtitles",
    t: "О видео",
    d: "Пересказ самого ролика по субтитрам: о чём он и 5–8 главных пунктов с таймкодами — клик перематывает видео.",
    foot: { where: "вкладка «О видео» в панели" },
  },
  {
    g: "panel",
    ic: "search",
    t: "Моменты и поиск",
    d: "Места видео, о которых пишут зрители, — точками на шкале. Поиск по тексту, по смыслу и вопрос к комментариям: «о чём спорят?».",
    foot: { where: "вкладки «Моменты» и «Поиск»" },
  },
  // Моя библиотека
  {
    g: "library",
    ic: "library",
    t: "Поиск по всем плейлистам",
    d: "Все видео из всех плейлистов, включая «Смотреть позже». Понимает опечатки и другую раскладку, ищет по смыслу и по словам в субтитрах.",
    foot: { go: "lib", label: "Открыть библиотеку" },
  },
  {
    g: "library",
    ic: "queue",
    t: "Очередь вместо вкладок",
    d: "«Собрать вкладки» уносит все видео в один список — с местом, где вы остановились. «Разобрать завалы» — решения по одному видео клавишами.",
    foot: { go: "queue", label: "Открыть очередь" },
  },
  {
    g: "library",
    ic: "bell",
    t: "Подписки",
    d: "Короткий дайджест вместо бесконечной ленты: что вышло на ваших каналах с прошлого раза — по дням или по каналам.",
    foot: { go: "digest", label: "Открыть подписки" },
  },
  {
    g: "library",
    ic: "chart",
    t: "Статистика",
    d: "Сколько вы смотрите, каких каналов больше всего и сколько времени сэкономили скорость, пропуск рекламы и тишины.",
    foot: { go: "stats", label: "Открыть статистику" },
  },
  {
    g: "library",
    ic: "omni",
    t: "Поиск из адресной строки",
    d: "Наберите в адресной строке yt, пробел и запрос — подсказки из ваших плейлистов и очереди появятся сразу.",
    foot: { keys: "yt+Пробел" },
  },
  {
    g: "library",
    ic: "bookmark",
    t: "Сохранить в плейлисты",
    d: "Своё окно вместо стандартного: сразу в несколько плейлистов, с поиском и созданием нового. В ленте можно отметить несколько видео.",
    foot: { keys: "Alt+Shift+S", cmd: "save-to-playlists" },
  },
];

// ---------- клавиши на страницах ----------
// По 6 строк в карточке — ряды карточек одной высоты, без пустот
const LOCAL_KEYS = [
  {
    t: "На YouTube",
    rows: [
      [["]", "["], "Вперёд / назад по очереди"],
      [["Shift+]"], "Досмотрел — убрать и дальше"],
      [["Shift+>"], "Быстрее, выше 2× — до 4×"],
      [["Shift+<"], "Медленнее"],
      [["Shift+C"], "Двойные субтитры"],
      [["Shift+I"], "Вступление до сюда — дальше канал пропускает его сам"],
      [["Shift+клик"], "Выбрать видео в ленте подряд"],
    ],
  },
  {
    t: "Разобрать завалы",
    rows: [
      [["←"], "Убрать из очереди"],
      [["→"], "Оставить"],
      [["↑"], "Первым в очереди"],
      [["Enter"], "Смотреть сейчас"],
      [["Пробел"], "О чём видео"],
      [["Ctrl+Z"], "Отменить последнее"],
    ],
  },
  {
    t: "Окно клипа",
    rows: [
      [["I"], "Начало — по кадру предпросмотра"],
      [["O"], "Конец — по кадру предпросмотра"],
      [["Пробел"], "Посмотреть отрезок"],
      [["←|→"], "Сдвинуть ручку на 1 с"],
      [["Shift+←|→"], "Сдвинуть ручку на 5 с"],
      [["Esc"], "Закрыть окно"],
    ],
  },
  {
    t: "Моя библиотека",
    rows: [
      [["/", "Ctrl+K"], "Поиск"],
      [["Esc"], "Из плеера — к списку"],
      [["]"], "Следующее видео"],
      [["["], "Предыдущее видео"],
      [["Shift+]"], "Досмотрел — дальше"],
      [["Shift+клик"], "«Обновить» — перечитать всё"],
    ],
  },
  {
    t: "Адресная строка",
    rows: [
      [["yt+Пробел"], "Искать в своих плейлистах"],
      [["Enter"], "Открыть видео или библиотеку"],
      [["Alt+Enter"], "В новой вкладке"],
      [["Shift+Alt+Enter"], "В фоновой вкладке"],
      [["yt+Пробел+q"], "Открыть очередь"],
      [["yt+Пробел+?"], "Список команд"],
    ],
  },
  {
    t: "Панель и превью",
    rows: [
      [["1", "6"], "Вкладки панели по порядку", "…"],
      [["/"], "Поиск по комментариям"],
      [["Esc"], "Выйти из поля ввода"],
      [["←|→"], "Превью: качество"],
      [["D"], "Превью: скачать"],
      [["C"], "Превью: скопировать"],
    ],
  },
];

// короткие подписи команд из manifest.json (там — длинные описания для chrome://extensions)
const CMD_LABELS = {
  _execute_action: "Открыть панель",
  "toggle-no-autoplay": "Не запускать видео само",
  "toggle-hide-progress": "Скрыть полосу прогресса",
  "save-to-playlists": "Сохранить в плейлисты",
  "save-to-last-playlist": "В последний плейлист",
  "toggle-queue-mode": "Режим очереди на ленте",
  "open-library": "Моя библиотека",
  "collect-tabs": "Собрать вкладки в очередь",
  "defer-video": "Отложить видео в очередь",
  "toggle-focus": "Без отвлечений",
  "sleep-timer": "Таймер сна",
};

// ---------- что нового ----------
const NEWS = [
  {
    v: "0.27",
    t: "Компактное меню плеера",
    items: [
      "Сверху — частые действия, остальное — разделами «Сохранить», «Видео и превью», «Плеер».",
      "В меню правого клика — таймер сна и разделы библиотеки.",
      "Эта страница — «Что умеет расширение»: возможности, клавиши и что нового.",
    ],
  },
  {
    v: "0.26",
    t: "Подписки, статистика, тишина и сон",
    items: [
      "«Подписки» в библиотеке — дайджест новых видео с ваших каналов с прошлого раза.",
      "«Статистика» — сколько вы смотрите и сколько времени сэкономили.",
      "Пропуск тишины и таймер сна — в меню кнопки расширения в плеере.",
    ],
  },
  {
    v: "0.25",
    t: "Быстрее 2×",
    items: ["Скорость до 4×: Shift+> после 2× и строка «Скорость − +» в меню плеера.", "Меню плеера разложено по группам."],
  },
  { v: "0.24", t: "Без отвлечений", items: ["Одна кнопка прячет Shorts, рекомендации и заставки в конце; что прятать — в настройках панели."] },
  { v: "0.23", t: "Скорость по каналам", items: ["Скорость запоминается для каждого канала и сама включается в его следующих видео."] },
  { v: "0.22", t: "В архив Telegram", items: ["Видео — в личный бот-архив: ссылка, обложка и пересказ, папку подбирает ИИ."] },
  { v: "0.21", t: "Поиск из адресной строки", items: ["yt, пробел и запрос — подсказки из ваших плейлистов и очереди."] },
  { v: "0.20", t: "Поиск по субтитрам", items: ["Библиотека находит видео по тому, что в них говорят, и открывает с нужного места."] },
  {
    v: "0.19",
    t: "Быстрое «Обновить»",
    items: ["Библиотека перечитывает только изменившиеся плейлисты.", "В «Разобрать завалы» — пересказ «О чём видео» рядом с роликом."],
  },
  { v: "0.18", t: "«О чём видео» на обложках", items: ["Пересказ по субтитрам и превью — прямо с ленты, при наведении на обложку."] },
];
const NEWS_SHOWN = 5; // остальные — по кнопке «Более ранние версии»

const verNum = (v) => {
  const [a = 0, b = 0] = String(v || "").split(".").map(Number);
  return a * 1000 + b;
};

// ---------- отрисовка ----------
function footHtml(f, cmds) {
  if (f.go) return `<button type="button" class="try" data-go="${f.go}">${esc(f.label)}${icon("chevron", { size: 16 })}</button>`;
  if (f.keys) {
    const real = f.cmd ? cmds.get(f.cmd) : null;
    return `<span class="foot-keys">${keys(real?.shortcut || f.keys)}</span>`;
  }
  return `<span class="where">${icon("chevron", { size: 14 })}<span>${esc(f.where[0].toUpperCase() + f.where.slice(1))}</span></span>`;
}

function renderCards(cmds) {
  for (const box of document.querySelectorAll(".cards[data-group]")) {
    const list = CARDS.filter((c) => c.g === box.dataset.group);
    box.dataset.n = String(list.length);
    box.innerHTML = list
      .map(
        (c) => `<article class="card">
          <div class="card-top"><span class="card-ic">${svg(c.ic)}</span><h3>${esc(c.t)}</h3></div>
          <p>${esc(c.d)}</p>
          <div class="card-foot">${footHtml(c.foot, cmds)}</div>
        </article>`
      )
      .join("");
  }
}

function krow(label, keysHtml) {
  return `<div class="krow"><span class="klabel">${esc(label)}</span><span class="kkeys">${keysHtml}</span></div>`;
}

function renderKeys(cmds) {
  const order = Object.keys(CMD_LABELS);
  const rows = order
    .filter((name) => cmds.has(name))
    .map((name) => {
      const sc = cmds.get(name).shortcut;
      return krow(CMD_LABELS[name], sc ? keys(sc) : '<span class="key-none">не назначено</span>');
    });
  rows.push(
    `<div class="krow krow-btn"><button type="button" class="try" data-go="shortcuts">${svg("key", 18)}Назначить свои клавиши</button></div>`
  );
  $("#keys-global").innerHTML = rows.join("");
  $("#keys-local").innerHTML = LOCAL_KEYS.map(
    (k) => `<div class="kcard"><h3>${esc(k.t)}</h3><div class="klist">${k.rows
      .map(([combos, label, range]) => krow(label, range ? combos.map(keys).join(`<span class="or">${range}</span>`) : keysAny(combos)))
      .join("")}</div></div>`
  ).join("");
}

function renderNews(from) {
  const fresh = (n) => from && verNum(n.v) > verNum(from);
  const item = (n, i) => `<li class="nitem${i >= NEWS_SHOWN ? " old" : ""}"${i >= NEWS_SHOWN ? " hidden" : ""}>
      <span class="nv">${esc(n.v)}</span>
      <div class="nbody">
        <h3>${esc(n.t)}${fresh(n) ? '<span class="nnew">Новое</span>' : ""}</h3>
        <ul>${n.items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      </div>
    </li>`;
  $("#news-list").innerHTML = NEWS.map(item).join("");
  if (NEWS.length > NEWS_SHOWN) {
    $("#news-list").insertAdjacentHTML(
      "afterend",
      `<div class="news-more"><button type="button" class="try" id="news-more">Более ранние версии${icon("chevron", { size: 16 })}</button></div>`
    );
  }
}

// ---------- данные из chrome.* (на стенде их может не быть) ----------
async function readCommands() {
  const map = new Map();
  try {
    for (const c of await chrome.commands.getAll()) map.set(c.name, { shortcut: c.shortcut || "" });
  } catch {
    // без chrome.commands — сочетания по умолчанию из manifest.json
    const m = chrome?.runtime?.getManifest?.() || {};
    for (const [name, c] of Object.entries(m.commands || {})) map.set(name, { shortcut: c.suggested_key?.default || "" });
  }
  return map;
}

let windowId = null; // для chrome.sidePanel.open — узнаём заранее: в обработчике клика ждать нельзя
chrome?.windows?.getCurrent?.().then((w) => (windowId = w.id), () => {});

function go(where) {
  if (where === "settings") {
    // панель открывается только по действию пользователя — вызываем сразу, без await перед ним
    if (windowId != null) void openPanel({ windowId });
    void chrome.storage.session.set({ panelGoto: { view: "settings", at: Date.now() } }).catch(() => {});
  } else if (where === "shortcuts") {
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  } else if (where === "stats") {
    void chrome.tabs.create({ url: chrome.runtime.getURL("library/library.html#stats") });
  } else {
    void chrome.runtime.sendMessage({ type: "lib:open", view: where === "lib" ? "" : where, forceTab: true }).catch(() => {});
  }
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-go]");
  if (b) return go(b.dataset.go);
  if (e.target.closest("#news-more")) {
    for (const li of document.querySelectorAll(".nitem.old")) li.hidden = false;
    e.target.closest(".news-more").remove();
  }
});

async function start() {
  const ver = chrome?.runtime?.getManifest?.().version || "";
  $("#foot-ver").textContent = `Сводка комментариев YouTube${ver ? ` · версия ${ver}` : ""}`;
  // крупное обновление: что изменилось с вашей прошлой версии
  let from = "";
  try {
    const { whatsNew } = await chrome.storage.local.get("whatsNew");
    if (whatsNew?.from && verNum(whatsNew.from) < verNum(ver)) from = whatsNew.from;
  } catch {
    /* на стенде без хранилища — без отметок */
  }
  const cmds = await readCommands();
  renderCards(cmds);
  renderKeys(cmds);
  renderNews(from);
  if (from) {
    const box = $("#hero-update");
    box.innerHTML = `<span class="hu-dot"></span><span>Расширение обновилось: ${esc(from.split(".").slice(0, 2).join("."))} → ${esc(
      ver.split(".").slice(0, 2).join(".")
    )}</span><a href="#news">Что нового</a>`;
    box.hidden = false;
    // метку видели — значок «NEW» и точки в панели и библиотеке гаснут
    void chrome.storage.local.remove("whatsNew").catch(() => {});
  }
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
}
void start();
