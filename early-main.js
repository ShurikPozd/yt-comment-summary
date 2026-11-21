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
  let navTo = null; // куда ведёт текущий переход (URL), если YouTube его сообщил
  const videoId = () => new URLSearchParams(location.search).get("v");
  const recentGesture = () => Date.now() - gestureAt < 1500;
  const mainVideo = () =>
    [...document.querySelectorAll("video.html5-main-video, #movie_player video")].find((v) => v.getClientRects().length) || null;
  // Страница, к которой относится play(): во время перехода адрес ещё старый,
  // а играть собирается уже новая страница (Shorts, другое видео).
  const targetUrl = () => {
    if (navigating && navTo) {
      try {
        return new URL(navTo, location.origin);
      } catch (e) {
        /* неизвестный формат — по текущему адресу */
      }
    }
    return new URL(location.href); // у самого location нет searchParams
  };

  document.addEventListener("ytcs-prefs", (e) => {
    try {
      const was = on;
      on = Boolean(JSON.parse(e.detail).noAutoplay);
      // включили посреди просмотра — уже играющее видео не трогаем: его
      // запустили вы, и play() после рекламы или смены качества не отклоняем
      const v = on && !was ? mainVideo() : null;
      if (v && !v.paused) allowedId = videoId();
    } catch (err) {
      /* не наше событие */
    }
  });
  // клик по таймкоду в панели — разрешаем текущее видео
  document.addEventListener("ytcs-allow", () => {
    gestureAt = Date.now();
    allowedId = videoId();
  });

  // клик по таймкоду в описании или комментариях YouTube — тоже просьба играть
  const isTimecodeLink = (el) => {
    const a = el.closest?.("a[href]");
    return Boolean(a && /[?&#]t=\d/.test(a.getAttribute("href") || ""));
  };
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (!e.isTrusted || !e.target.closest) return;
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
  window.addEventListener("yt-navigate-start", (e) => {
    navigating = true;
    gestureAt = 0;
    const d = e.detail || {};
    navTo = d.url || d.endpoint?.commandMetadata?.webCommandMetadata?.url || null;
    let toVideo = null;
    try {
      toVideo = navTo ? new URL(navTo, location.origin).searchParams.get("v") : null;
    } catch (err) {
      /* без цели — как раньше */
    }
    // Разрешение снимаем только при переходе к другому видео: уход на главную
    // с мини-плеером и разворачивание его обратно — то же видео, не трогаем.
    if (!navTo || (toVideo && toVideo !== allowedId)) allowedId = null;
    // early.js (изолированный мир) деталей события не видит — передаём строкой
    document.dispatchEvent(new CustomEvent("ytcs-nav", { detail: navTo || "" }));
  });
  window.addEventListener("yt-navigate-finish", () => {
    navigating = false;
    navTo = null;
  });

  // Медиаклавиши (наушники, клавиатура, кнопки Chrome) приходят не событием
  // клавиатуры, а через MediaSession: YouTube регистрирует свой обработчик
  // «play». Оборачиваем его — нажатие медиаклавиши считается вашим действием.
  const markGesture = () => {
    gestureAt = Date.now();
    document.dispatchEvent(new CustomEvent("ytcs-gesture")); // early.js тоже должен знать
  };
  try {
    const ms = navigator.mediaSession;
    if (ms && typeof ms.setActionHandler === "function") {
      const origSet = ms.setActionHandler.bind(ms);
      let pageSetPlay = false;
      ms.setActionHandler = (action, handler) => {
        if (action === "play") pageSetPlay = true;
        if (action === "play" && typeof handler === "function") {
          return origSet(action, function (...args) {
            markGesture();
            return handler.apply(this, args);
          });
        }
        return origSet(action, handler);
      };
      // Если YouTube свой «play» не задал, браузер запускает видео сам, в
      // обход play() — и запасная пауза его тут же остановила бы. Ставим свой:
      // нажатие засчитываем и запускаем основное видео.
      window.addEventListener("load", () =>
        setTimeout(() => {
          if (pageSetPlay) return;
          origSet("play", () => {
            markGesture();
            mainVideo()?.play(); // видимое видео, а не скрытый плеер другой страницы
          });
        }, 3000)
      );
    }
  } catch (e) {
    /* без MediaSession — медиаклавиши как раньше */
  }

  const isMainVideo = (el) =>
    el instanceof HTMLVideoElement && (el.classList.contains("html5-main-video") || Boolean(el.closest?.("#movie_player, ytd-player")));

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function play(...args) {
    if (on && targetUrl().pathname === "/watch" && isMainVideo(this)) {
      if (recentGesture()) {
        allowedId = targetUrl().searchParams.get("v"); // это вы нажали play
      } else if ((navigating && !navTo) || !allowedId || allowedId !== targetUrl().searchParams.get("v")) {
        // во время перехода сравниваем с видео, к которому идём (мини-плеер
        // разворачивается в то же видео); цель неизвестна — блокируем
        return Promise.reject(new DOMException("Автозапуск отключён расширением", "NotAllowedError"));
      }
    }
    return origPlay.apply(this, args);
  };
})();
