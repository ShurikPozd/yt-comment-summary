// Скорость по каналам — помощник в мире страницы (world: MAIN). Только здесь
// виден API плеера YouTube: id и название канала текущего видео, прямой ли это
// эфир, и setPlaybackRate — скорость, которую плеер показывает в своём меню.
// Сам ничего не решает и не хранит: отвечает speed.js (изолированный мир).
// Вопрос — событие "ytcs-speed:ask" на document, ответ — "ytcs-speed:info"
// (JSON в detail, синхронно, пока speed.js ещё в dispatchEvent);
// "ytcs-speed:set" (detail — скорость) ставит скорость через плеер.
(() => {
  if (window.__ytcsSpeedMain) return;
  // встроенный плеер — только внутри страницы расширения («Моя библиотека»)
  if (location.pathname.startsWith("/embed/")) {
    if (!String(location.ancestorOrigins?.[0] || "").startsWith("chrome-extension://")) return;
  } else if (window.top !== window) {
    return;
  }
  window.__ytcsSpeedMain = true;

  const player = () => document.getElementById("movie_player");

  document.addEventListener("ytcs-speed:ask", () => {
    let info = null;
    try {
      const resp = player()?.getPlayerResponse?.();
      const vd = resp?.videoDetails;
      if (vd?.videoId) {
        info = {
          videoId: vd.videoId,
          channelId: vd.channelId || "",
          name: vd.author || "",
          live: Boolean(vd.isLive || vd.isUpcoming || resp?.playabilityStatus?.liveStreamability),
        };
      }
    } catch (e) {
      info = null;
    }
    document.dispatchEvent(new CustomEvent("ytcs-speed:info", { detail: JSON.stringify(info) }));
  });

  document.addEventListener("ytcs-speed:set", (e) => {
    const rate = Number(e.detail);
    if (!Number.isFinite(rate) || rate <= 0) return;
    try {
      player()?.setPlaybackRate?.(rate);
    } catch (err) {
      /* speed.js проверит и поставит сам */
    }
  });
})();
