// Стенд страницы YouTube (главный мир страницы): то, что на настоящем сайте делает
// сам YouTube, — минимально, чтобы контент-скрипты расширения работали как там.
//  - на /watch в плеер из снимка ставится настоящее медиа (тишина нужной длины,
//    её отдаёт тестовый сервер) и методы API плеера (#movie_player.getVideoData…);
//  - после перезагрузки, как настоящий YouTube, ставит видео на «своё место из
//    истории» — на 20 с раньше того, где смотрели (это и чинит resume.js);
//  - название, канал и подписи карточек — из параметров стенда (window.__e2e).
(() => {
  const cfg = window.__e2e || {};
  const ready = (fn) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn, { once: true }) : fn());
  ready(() => {
    const setText = (el, t) => el && (el.textContent = t);
    // карточки: заголовки и каналы — читаемые (в снимке обезличены «Текст N»)
    let n = 0;
    for (const card of document.querySelectorAll("yt-lockup-view-model, ytm-shorts-lockup-view-model")) {
      n++;
      const t = card.querySelector("h3 a, .yt-lockup-metadata-view-model__title, [class*='MetadataViewModelTitle'], h3");
      if (t) setText(t.querySelector("span") || t, `Карточка ${n}: тестовое видео`);
    }
    if (location.pathname !== "/watch") return;
    const id = new URLSearchParams(location.search).get("v");
    const flexy = document.querySelector("ytd-watch-flexy");
    flexy?.setAttribute("video-id", id);
    setText(document.querySelector("ytd-watch-metadata h1 yt-formatted-string") || document.querySelector("ytd-watch-metadata h1"), cfg.title);
    setText(document.querySelector("ytd-watch-metadata #channel-name a") || document.querySelector("ytd-watch-metadata #channel-name"), cfg.channel);
    document.title = `${cfg.title} - YouTube`;

    const player = document.getElementById("movie_player");
    const v = player?.querySelector("video");
    if (!v) return;
    const D = cfg.duration;
    v.muted = true;
    v.preload = "auto";
    v.src = `/e2e/media.wav?d=${D}`;
    // как YouTube: после перезагрузки — на своё место из истории (на 20 с раньше)
    let nav = "navigate";
    try {
      nav = performance.getEntriesByType("navigation")[0]?.type || nav;
    } catch {}
    const hist = Number(sessionStorage.getItem("e2e:ytHistory"));
    if (nav === "reload" && hist > 0) {
      v.addEventListener("loadedmetadata", () => (v.currentTime = Math.max(0, hist - 20)), { once: true });
    }
    // «история просмотра YouTube» — запоминаем, где смотрели
    v.addEventListener("timeupdate", () => v.currentTime > 1 && sessionStorage.setItem("e2e:ytHistory", String(Math.floor(v.currentTime))));
    const states = { ended: 0, playing: 1, paused: 2 };
    Object.assign(player, {
      getVideoData: () => ({ video_id: id, title: cfg.title, author: cfg.channel, isLive: false }),
      getCurrentTime: () => v.currentTime,
      getDuration: () => (Number.isFinite(v.duration) ? v.duration : D),
      seekTo: (t) => (v.currentTime = t),
      playVideo: () => v.play().catch(() => {}),
      pauseVideo: () => v.pause(),
      getPlayerState: () => (v.ended ? states.ended : v.paused ? states.paused : states.playing),
      getPlaybackRate: () => v.playbackRate,
      setPlaybackRate: (r) => (v.playbackRate = r),
      getAvailablePlaybackRates: () => [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
      getAvailableQualityLevels: () => ["hd1080", "hd720", "large", "medium"],
      getPreferredQuality: () => "auto",
      setPlaybackQualityRange: () => {},
      isMuted: () => v.muted,
      mute: () => (v.muted = true),
      unMute: () => {}, // стенд всегда без звука
      loadVideoById: () => {},
      getPlayerResponse: () => ({ videoDetails: { videoId: id, title: cfg.title, author: cfg.channel, lengthSeconds: String(D) }, playabilityStatus: { status: "OK" } }),
    });
    player.classList.add("html5-video-player", "paused-mode");
    v.addEventListener("play", () => player.classList.replace("paused-mode", "playing-mode"));
    v.addEventListener("pause", () => player.classList.replace("playing-mode", "paused-mode"));
  });
})();
