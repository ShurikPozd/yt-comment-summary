"use strict";

// Мост в "основной мир" страницы YouTube (world: MAIN).
// Изолированный content script не видит глобальные переменные страницы,
// поэтому playerResponse (где поток содержит poToken/сигнатуры) запрашивается
// отсюда через postMessage — так мы получаем формат, который реально играет у пользователя.
(() => {
  const REQ = "ytc:get-streams";
  const RES = "ytc:streams";

  let cache = null;

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
    cache = pr ? { videoId: pr.videoDetails?.videoId || null, data: pr.streamingData || null } : null;
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type !== REQ) return;
    refresh();
    const payload = cache && cache.videoId === e.data.videoId ? cache.data : null;
    window.postMessage({ type: RES, ok: Boolean(payload), data: payload }, "*");
  });

  // Обновляем кэш после навигации YouTube (SPA).
  window.addEventListener("yt-navigate-finish", () => setTimeout(refresh, 400));
  setInterval(refresh, 4000);
})();