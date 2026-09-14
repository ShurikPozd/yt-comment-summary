"use strict";

// Мост в "основной мир" страницы YouTube (world: MAIN).
// Изолированный content script не видит глобальные переменные страницы,
// поэтому playerResponse (где поток содержит poToken/сигнатуры) запрашивается
// отсюда через postMessage — так мы получаем формат, который реально играет у пользователя.
(() => {
  const REQ = "ytc:get-streams";
  const RES = "ytc:streams";

  let cache = null;

  function getVisitorData() {
    try {
      if (window.ytcfg && typeof window.ytcfg.get === "function") {
        const vd = window.ytcfg.get("VISITOR_DATA");
        if (typeof vd === "string" && vd.length > 20) return vd;
      }
    } catch (e) {}
    try {
      // Резерв: берём из данных плеера игрока (то же самое значение, что у страницы).
    } catch (e) {}
    return null;
  }

  function getPlayerResponse() {
    try {
      if (window.ytInitialPlayerResponse?.streamingData) {
        return window.ytInitialPlayerResponse;
      }
    } catch (e) {}
    try {
      const mp = document.querySelector("#movie_player");
      if (mp && typeof mp.getPlayerResponse === "function") {
        const pr = mp.getPlayerResponse();
        if (pr?.streamingData) return pr;
      }
    } catch (e) {}
    return null;
  }

  function refresh() {
    const pr = getPlayerResponse();
    cache = pr
      ? {
          videoId: pr.videoDetails?.videoId || null,
          data: pr.streamingData || null,
          visitorData: getVisitorData(),
        }
      : null;
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type !== REQ) return;
    refresh();
    const sameVideo = cache && cache.videoId === e.data.videoId;
    window.postMessage(
      { type: RES, ok: Boolean(sameVideo), data: sameVideo ? cache.data : null, visitorData: cache?.visitorData || null },
      "*"
    );
  });

  // Обновляем кэш после навигации YouTube (SPA).
  window.addEventListener("yt-navigate-finish", () => setTimeout(refresh, 400));
  setInterval(refresh, 4000);
})();