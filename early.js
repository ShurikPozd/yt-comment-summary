// Режимы плеера, которым важно успеть до старта видео. Скрипт запускается в
// самом начале загрузки страницы (document_start), раньше плеера YouTube:
//  - «не запускать видео автоматически» (замена AutoplayStopper) — раньше
//    взвод срабатывал после перехода, и видео успевало проиграть ~секунду;
//  - «скрыть полосу прогресса» — стиль ставится до отрисовки плеера, без мелькания.
// Остальное (кнопка в плеере, меню, сбор комментариев) — в content.js; оба
// скрипта живут в одном изолированном мире и общаются через globalThis.__ytcs.
(() => {
  if (globalThis.__ytcs) return;

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
  const HIDE_PROGRESS_CSS = `
    .ytp-progress-bar-container,
    .ytp-time-separator,
    .ytp-time-duration,
    .ytp-bound-time-right { display: none !important; }`;

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
  const isWatch = () => location.pathname === "/watch";
  const videoId = () => new URLSearchParams(location.search).get("v");
  const mainVideo = () => document.querySelector("#movie_player video, video.html5-main-video");
  let gestureAt = 0;
  let allowedId = null;
  let navigating = false;
  const recentGesture = () => Date.now() - gestureAt < 1500;

  window.addEventListener(
    "pointerdown",
    (e) => {
      // клики по нашей кнопке и меню в плеере — не «запуск видео»
      if (e.isTrusted && e.target.closest?.("#movie_player, ytd-player") && !e.target.closest(".ytcs-btn, .ytcs-menu")) {
        gestureAt = Date.now();
      }
    },
    true
  );
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.isTrusted) return;
      if (e.target.closest?.("input, textarea, [contenteditable='true'], [contenteditable='']")) return;
      if ([" ", "k", "K", "л", "Л", "MediaPlayPause", "MediaPlay"].includes(e.key)) gestureAt = Date.now();
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
        allowedId = videoId(); // это вы нажали play
        return;
      }
      if (!navigating && allowedId && allowedId === videoId()) return;
      v.pause();
    },
    true
  );

  // Переход начался (клик по другому видео, автопереход) — до загрузки нового
  // видео снимаем разрешение, иначе оно стартует, пока адрес ещё старый.
  window.addEventListener("yt-navigate-start", () => {
    navigating = true;
    // нажатие play относилось к прошлому видео — новому его не передаём
    allowedId = null;
    gestureAt = 0;
  });
  window.addEventListener("yt-navigate-finish", () => {
    navigating = false;
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
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    checkPlaying();
  }, 500);

  // ---------- Настройки ----------
  function readPrefs(settings) {
    prefs.noAutoplay = Boolean(settings?.noAutoplay);
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
  };
})();
