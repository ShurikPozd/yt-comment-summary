// Автостоп «у источника»: скрипт работает в мире самой страницы (world: MAIN)
// с самого начала загрузки и не даёт плееру YouTube вообще начать
// воспроизведение без вашего действия — play() отклоняется так же, как его
// отклоняет сам браузер при запрете автозапуска (NotAllowedError), и плеер
// показывает кнопку play. Пауза по событию «play» (early.js) пропускала
// первые доли секунды. Настройки и «разрешено» приходят от early.js
// событиями на document (чтения chrome.storage в этом мире нет).
(() => {
  if (window.__ytcsMainPlay) return;
  window.__ytcsMainPlay = true;

  let on = false;
  try {
    on = Boolean(JSON.parse(localStorage.getItem("ytcs:player-prefs") || "{}").noAutoplay);
  } catch (e) {
    /* без кеша — ждём событие от early.js */
  }

  let gestureAt = 0;
  let allowedId = null;
  let navigating = false;
  const videoId = () => new URLSearchParams(location.search).get("v");
  const recentGesture = () => Date.now() - gestureAt < 1500;

  document.addEventListener("ytcs-prefs", (e) => {
    try {
      on = Boolean(JSON.parse(e.detail).noAutoplay);
    } catch (err) {
      /* не наше событие */
    }
  });
  // клик по таймкоду в панели — разрешаем текущее видео
  document.addEventListener("ytcs-allow", () => {
    gestureAt = Date.now();
    allowedId = videoId();
  });

  window.addEventListener(
    "pointerdown",
    (e) => {
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
  window.addEventListener("yt-navigate-start", () => {
    navigating = true;
    allowedId = null;
    gestureAt = 0;
  });
  window.addEventListener("yt-navigate-finish", () => {
    navigating = false;
  });

  const isMainVideo = (el) =>
    el instanceof HTMLVideoElement && (el.classList.contains("html5-main-video") || Boolean(el.closest?.("#movie_player, ytd-player")));

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function play(...args) {
    if (on && location.pathname === "/watch" && isMainVideo(this)) {
      if (recentGesture()) {
        allowedId = videoId(); // это вы нажали play
      } else if (navigating || !allowedId || allowedId !== videoId()) {
        return Promise.reject(new DOMException("Автозапуск отключён расширением", "NotAllowedError"));
      }
    }
    return origPlay.apply(this, args);
  };
})();
