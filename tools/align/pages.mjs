// Страницы для замера центровки (tools/align/shot.mjs, check.sh).
//   url    — путь на сервере стендов (serve.py);
//   w, h   — ширина окна и высота (h — наибольшая: окно подгоняется под длину страницы);
//   wait   — выражение JS: страница готова;
//   act    — выражение JS после готовности (открыть окно, выбрать карточки…), можно async;
//   settle — сколько ждать после act, мс;
//   roots  — выражение JS: где искать элементы (по умолчанию вся страница);
//   extra  — дополнительные селекторы элементов с подписью (плашки, тосты).
const LIB = "/library/library.html?mem=1&queue=24";
const libReady = "document.querySelector('.card, .empty') && performance.now() > 1500";
const click = (sel) => `document.querySelector(${JSON.stringify(sel)})?.click()`;
// Ctrl+щелчок по двум карточкам — включается выбор и полоса «Выбрано: N»
const pickTwo = `(() => { const cs = [...document.querySelectorAll('#grid .card, #cont .card, #digest .card')].slice(0, 2);
  for (const c of cs) c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true, button: 0 })); return cs.length; })()`;
// открыть «Уборку очереди» и дождаться конца проверки (модуль грузится по нажатию)
const qtidyDone = `(async () => { ${click("[data-qt=open]")};
  for (let i = 0; i < 150; i++) { const b = document.getElementById("qtidy"); if (b?.querySelector(".qt-foot, .qt-clean") && !b.querySelector("[data-qt=stop]")) return i; await new Promise((r) => setTimeout(r, 100)); } return -1; })()`;
const shadow = (id) => `[document.getElementById(${JSON.stringify(id)})?.shadowRoot]`;
// шрифт YouTube (Roboto с Google Fonts) загружен — без сети стенды YouTube не откроются
const roboto = `[...document.fonts].some((f) => f.family.replace(/["']/g, "") === "Roboto" && f.status === "loaded")`;
const ytReady = roboto + " && document.querySelector('.ytcs-btn') && performance.now() > 1200";

// блок «Мягкий лимит» в панели: стенд панели без скриптов — подключаем модуль с заглушкой хранилища
const limitPanel = `(async () => { const L = await import("/limit-core.js");
  window.chrome = { storage: { local: { get: async () => ({ watchLimit: { on: true, min: 120 }, watchLimitDay: { day: L.limitDay(), sec: 6000 } }), set: async () => {} },
    onChanged: { addListener() {} } } };
  await import("/sidepanel/limit-settings.js"); await new Promise((r) => setTimeout(r, 200)); return document.querySelectorAll(".lim-chip").length; })()`;

export const PAGES = [
  // боковая панель — вся разметка сразу (все вкладки видны)
  { key: "panel", url: "/sidepanel/stand.html", w: 420, h: 7000, wait: "window.ok === 1" },
  // «Моя библиотека» (заглушка с вымышленным каталогом)
  { key: "lib", url: LIB + "#", w: 1200, h: 2000, wait: libReady },
  { key: "lib-queue", url: LIB + "#v=queue", w: 1200, h: 2000, wait: libReady },
  { key: "lib-digest", url: LIB + "#v=digest", w: 1200, h: 2000, wait: libReady },
  { key: "lib-stats", url: LIB + "#v=stats", w: 1200, h: 2000, wait: libReady + " && performance.now() > 2500" },
  // полоса выбора (multi.js) — в очереди и в плейлистах
  { key: "lib-sel-queue", url: LIB + "#v=queue", w: 1200, h: 1400, wait: libReady + " && document.querySelectorAll('#cont .card').length > 1", act: pickTwo, roots: "[document.getElementById('sel-bar')]" },
  // окна разбора очереди и резервной копии
  { key: "lib-triage", url: LIB + "#v=queue", w: 1200, h: 1400, wait: libReady, act: click("[data-act=triage]"), roots: "[document.getElementById('triage')]" },
  { key: "lib-backup", url: LIB + "#v=queue", w: 1200, h: 1400, wait: libReady, act: click("[data-bk=open]"), roots: "[document.getElementById('backup')]" },
  // «Уборка очереди»: ждём конца проверки доступности (подделка oEmbed в lib-stub.js, 5 запросов в секунду)
  { key: "lib-qtidy", url: LIB + "#v=queue", w: 1200, h: 2000, wait: libReady, act: qtidyDone, roots: "[document.getElementById('qtidy')]" },
  // она же, пока идёт проверка («Остановить»), в узком окне
  { key: "lib-qtidy-run", url: LIB.replace("?", "?odelay=600000&") + "#v=queue", w: 720, h: 2600, wait: libReady, act: click("[data-qt=open]"), settle: 1500, roots: "[document.getElementById('qtidy')]" },
  // приветственная страница «Что умеет расширение»
  { key: "welcome", url: "/welcome/welcome.html", w: 1200, h: 7000, wait: "document.querySelector('.cards .card, .cards article, .klist *') && performance.now() > 800" },
  // на широком экране корневой шрифт крупнее (clamp по ширине окна) — другие доли пикселя
  { key: "welcome-wide", url: "/welcome/welcome.html", w: 1920, h: 7000, wait: "document.querySelector('.cards .card, .cards article, .klist *') && performance.now() > 800" },
  // колонка очереди на странице YouTube и подборка «Что дальше» поверх плеера
  { key: "queue", url: "/watch?v=vid00000000&stand=queue", w: 1440, h: 1200, wait: roboto + " && document.getElementById('secondary-inner').childElementCount && performance.now() > 1200" },
  // окна расширения на странице YouTube
  { key: "yt-menu", url: "/watch?v=dQw4w9WgXcQ", w: 1280, h: 900, wait: ytReady, act: "__stand.menu()" },
  { key: "yt-toast", url: "/watch?v=dQw4w9WgXcQ", w: 1280, h: 900, wait: ytReady, act: "__stand.toast()", extra: ".ytcs-toast" },
  { key: "yt-preview", url: "/watch?v=dQw4w9WgXcQ", w: 1280, h: 900, wait: ytReady, act: "__stand.preview()", settle: 1200, roots: shadow("ytcs-preview") },
  { key: "yt-clip", url: "/watch?v=dQw4w9WgXcQ", w: 1280, h: 900, wait: ytReady, act: "__stand.clip()", settle: 1200, roots: shadow("ytcs-clip") },
  { key: "yt-pltoast", url: "/watch?v=dQw4w9WgXcQ", w: 1280, h: 900, wait: ytReady, act: "__stand.plToast()", settle: 900, extra: "#ytcs-pl-toast" },
  { key: "yt-playlists", url: "/watch?v=dQw4w9WgXcQ", w: 1280, h: 900, wait: ytReady, act: "__stand.playlists()", settle: 1200, roots: shadow("ytcs-playlists") },
  // плашки поверх плеера: «Вы остановились на 2:30 · Продолжить» и затухание таймера сна
  { key: "yt-resume", url: "/watch?v=dQw4w9WgXcQ&resume=1", w: 1280, h: 900, wait: ytReady + " && document.getElementById('ytcs-resume-offer')", settle: 700, roots: shadow("ytcs-resume-offer") },
  // мягкий лимит: плашка «Сегодня уже 2 ч на YouTube», карточка в «Статистике», блок в настройках панели
  { key: "yt-limit", url: "/watch?v=dQw4w9WgXcQ", w: 1280, h: 900, wait: ytReady, act: "__ytcsLimit.show('2 ч')", settle: 700, roots: shadow("ytcs-limit-notice") },
  { key: "yt-limit-narrow", url: "/watch?v=dQw4w9WgXcQ", w: 560, h: 900, wait: ytReady, act: "(document.getElementById('movie_player').style.width = '520px', __ytcsLimit.show('2 ч 15 мин'))", settle: 700, roots: shadow("ytcs-limit-notice") },
  { key: "lib-limit", url: LIB + "&limit=1#v=stats", w: 1200, h: 1400, wait: libReady + " && document.querySelector('#st-limit .st-limit')", roots: "[document.getElementById('st-limit')]" },
  { key: "lib-limit-narrow", url: LIB + "&limit=over#v=stats", w: 420, h: 1600, wait: libReady + " && document.querySelector('#st-limit .st-limit')", roots: "[document.getElementById('st-limit')]" },
  { key: "panel-limit", url: "/sidepanel/stand.html", w: 420, h: 7000, wait: "window.ok === 1", act: limitPanel, settle: 300, roots: "[document.querySelector('.lim-block')]" },
  { key: "yt-sleep", url: "/watch?v=dQw4w9WgXcQ&sleep=fade", w: 1280, h: 900, wait: ytReady, act: "__ytcsSleep.set('end')", settle: 900, roots: shadow("ytcs-sleep-notice") },
];
