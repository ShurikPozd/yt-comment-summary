// Режимы плеера, которым важно успеть до старта видео. Скрипт запускается в
// самом начале загрузки страницы (document_start), раньше плеера YouTube:
//  - «не запускать видео автоматически» (замена AutoplayStopper) — раньше
//    взвод срабатывал после перехода, и видео успевало проиграть ~секунду;
//  - «скрыть полосу прогресса» — стиль ставится до отрисовки плеера, без мелькания.
// Остальное (кнопка в плеере, меню, сбор комментариев) — в content.js; оба
// скрипта живут в одном изолированном мире и общаются через globalThis.__ytcs.
(() => {
  if (globalThis.__ytcs) return;

  // Встроенный плеер (youtube.com/embed) — только внутри нашей «Моей библиотеки»;
  // встроенные видео на чужих сайтах расширение не трогает.
  if (location.pathname.startsWith("/embed/")) {
    let ours = false;
    try {
      ours = location.ancestorOrigins?.[0] === `chrome-extension://${chrome.runtime.id}`;
    } catch (e) {
      ours = false;
    }
    if (!ours) return;
  }

  const CACHE_KEY = "ytcs:player-prefs"; // копия настроек для синхронного старта
  const prefs = { noAutoplay: false, hideProgress: false };
  try {
    Object.assign(prefs, JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"));
  } catch (e) {
    /* нет кеша — дождёмся chrome.storage */
  }

  // ---------- Полоса прогресса ----------
  // Классы проверены на живом YouTube: полоса — .ytp-progress-bar-container,
  // «/ 1:58:54» — .ytp-time-separator + .ytp-time-duration. Текущее время остаётся.
  // Новый встроенный плеер (библиотека, ноябрь 2026): полоса — yt-progress-bar в слое
  // #player-controls, «/ 0:19» — .ytwPlayerTimeDisplayTimeDelimiter + …TimeDuration.
  const HIDE_PROGRESS_CSS = `
    .ytp-progress-bar-container,
    .ytp-time-separator,
    .ytp-time-duration,
    .ytp-bound-time-right,
    #player-controls yt-progress-bar,
    .ytwPlayerTimeDisplayTimeDelimiter,
    .ytwPlayerTimeDisplayTimeDuration { display: none !important; }`;

  function applyHideProgress() {
    let el = document.getElementById("ytcs-hide-progress");
    if (prefs.hideProgress) {
      if (!el) {
        el = document.createElement("style");
        el.id = "ytcs-hide-progress";
        el.textContent = HIDE_PROGRESS_CSS;
        (document.head || document.documentElement).appendChild(el);
      }
    } else {
      el?.remove();
    }
  }
  applyHideProgress();

  // ---------- Автозапуск ----------
  // Запуск основного плеера без вашего действия ставится на паузу. Действие —
  // клик по самому плееру, клавиша play/pause или клик по таймкоду в панели.
  // Видео, которое вы запустили сами, дальше играет свободно; переход к
  // другому видео (клик по превью, автопереход в конце) снова его запрещает.
  let navTo = null; // куда ведёт текущий переход (сообщает early-main.js)
  // во время перехода адрес ещё старый — решаем по странице, куда идём
  const isWatch = () => {
    if (navigating && navTo) {
      try {
        return new URL(navTo, location.origin).pathname === "/watch";
      } catch (e) {
        /* как по текущему адресу */
      }
    }
    return location.pathname === "/watch";
  };
  const videoId = () => new URLSearchParams(location.search).get("v");
  // видео, к которому относится play(): при известной цели перехода — её, при
  // неизвестной во время перехода — никакое (блокируем)
  const targetVideo = () => {
    if (!navigating) return videoId();
    try {
      return navTo ? new URL(navTo, location.origin).searchParams.get("v") : null;
    } catch (e) {
      return null;
    }
  };
  const mainVideo = () => document.querySelector("#movie_player video, video.html5-main-video");
  let gestureAt = 0;
  let allowedId = null;
  let navigating = false;
  const recentGesture = () => Date.now() - gestureAt < 1500;

  // клик по таймкоду в описании или комментариях YouTube — тоже просьба играть
  const isTimecodeLink = (el) => {
    const a = el.closest?.("a[href]");
    return Boolean(a && /[?&#]t=\d/.test(a.getAttribute("href") || ""));
  };
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (!e.isTrusted || !e.target.closest) return;
      // клики по нашей кнопке и меню в плеере — не «запуск видео»
      if (e.target.closest(".ytcs-btn, .ytcs-menu, #ytcs-clip, #ytcs-preview")) return;
      if (e.target.closest("#movie_player, ytd-player") || isTimecodeLink(e.target)) gestureAt = Date.now();
    },
    true
  );
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.isTrusted) return;
      if (e.target.closest?.("input, textarea, [contenteditable='true'], [contenteditable='']")) return;
      if ([" ", "k", "K", "л", "Л", "MediaPlayPause", "MediaPlay"].includes(e.key)) gestureAt = Date.now();
      // Enter по кнопке play в плеере (навигация с клавиатуры)
      else if (e.key === "Enter" && e.target.closest?.("#movie_player, ytd-player")) gestureAt = Date.now();
    },
    true
  );

  // медиаклавиша (через MediaSession, см. early-main.js) — тоже ваше действие
  document.addEventListener("ytcs-gesture", () => {
    gestureAt = Date.now();
  });

  // play не всплывает, но проходит фазу захвата — ловим на document.
  document.addEventListener(
    "play",
    (e) => {
      const v = e.target;
      if (!prefs.noAutoplay || !isWatch()) return;
      if (!(v instanceof HTMLVideoElement) || !v.closest("#movie_player, ytd-player")) return;
      if (recentGesture()) {
        allowedId = location.pathname === "/watch" ? videoId() : allowedId; // это вы нажали play
        return;
      }
      if (allowedId && allowedId === targetVideo()) return;
      v.pause();
    },
    true
  );

  // Переход начался (клик по другому видео, автопереход) — до загрузки нового
  // видео снимаем разрешение, иначе оно стартует, пока адрес ещё старый.
  window.addEventListener("yt-navigate-start", () => {
    navigating = true;
    gestureAt = 0;
  });
  // Цель перехода присылает early-main.js (детали события видны только в мире
  // страницы). Разрешение снимаем лишь при переходе к другому видео: уход на
  // главную с мини-плеером и разворачивание обратно — то же видео.
  document.addEventListener("ytcs-nav", (e) => {
    navigating = true;
    navTo = typeof e.detail === "string" && e.detail ? e.detail : null;
    let toVideo = null;
    try {
      toVideo = navTo ? new URL(navTo, location.origin).searchParams.get("v") : null;
    } catch (err) {
      /* без цели — как раньше */
    }
    if (!navTo || (toVideo && toVideo !== allowedId)) allowedId = null;
  });
  window.addEventListener("yt-navigate-finish", () => {
    navigating = false;
    navTo = null;
    checkPlaying();
  });

  // Видео уже играет без разрешения (скрипт загрузился позже плеера, адрес
  // сменился без событий YouTube) — останавливаем.
  function checkPlaying() {
    if (!prefs.noAutoplay || !isWatch() || recentGesture()) return;
    const v = mainVideo();
    if (v && !v.paused && allowedId !== videoId()) v.pause();
  }

  let lastHref = location.href;
  const hrefCheck = () => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    checkPlaying();
  };
  onHrefChange(hrefCheck, 500);

  // Смена адреса страницы (pushState/replaceState YouTube, «назад»): Navigation API
  // сообщает о ней и изолированному миру — без опроса раз в полсекунды на каждой
  // вкладке. Нет API — по-старому, проверка адреса по таймеру. Проверяем с той же
  // задержкой, что была у опроса в среднем: YouTube успевает дорисовать страницу.
  function onHrefChange(fn, ms) {
    const nav = globalThis.navigation;
    if (!nav?.addEventListener) return void setInterval(fn, ms);
    let t = 0;
    nav.addEventListener("currententrychange", () => {
      clearTimeout(t);
      t = setTimeout(fn, ms / 2);
    });
  }

  // ---------- Настройки ----------
  function readPrefs(settings) {
    const was = prefs.noAutoplay;
    prefs.noAutoplay = Boolean(settings?.noAutoplay);
    // включили посреди просмотра — играющее видео запустили вы, его не трогаем
    if (prefs.noAutoplay && !was) {
      const v = mainVideo();
      if (v && !v.paused) allowedId = videoId();
    }
    prefs.hideProgress = Boolean(settings?.hideProgress);
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(prefs));
    } catch (e) {
      /* без кеша просто чуть позже */
    }
    // early-main.js (мир страницы) отклоняет play() — сообщаем ему настройки
    document.dispatchEvent(new CustomEvent("ytcs-prefs", { detail: JSON.stringify(prefs) }));
    applyHideProgress();
  }
  chrome.storage.local
    .get("settings")
    .then((o) => {
      readPrefs(o.settings);
      checkPlaying();
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) readPrefs(changes.settings.newValue);
  });

  globalThis.__ytcs = {
    // клик по таймкоду в панели — действие пользователя: можно играть
    allowPlay() {
      gestureAt = Date.now();
      allowedId = videoId();
      document.dispatchEvent(new CustomEvent("ytcs-allow"));
    },
    applyHideProgress,
    onHrefChange, // общий для content.js и lazy.js (тот же изолированный мир)
  };
})();
