"use strict";

// Мост в "основной мир" страницы YouTube (world: MAIN).
// Изолированный content script не видит глобальные переменные страницы,
// поэтому playerResponse (где поток содержит poToken/сигнатуры) запрашивается
// отсюда через postMessage — так мы получаем формат, который реально играет у пользователя.
(() => {
  const REQ = "ytc:get-streams";
  const RES = "ytc:streams";
  const DL_REQ = "ytc:download";
  const DL_RES = "ytc:download:res";

  let cache = null;

  // Страница качает поток сама (MAIN world → Origin и куки страницы как у плеера).
  // Blob возвращается через postMessage (structured clone поддерживает Blob),
  // контент-скрипт сохраняет его через chrome.downloads. Работает только там,
  // где и DNR (googlevideo отдаёт видео по правильным заголовкам).
  window.addEventListener("message", async (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type !== DL_REQ) return;
    try {
      const resp = await fetch(e.data.url, { credentials: "include", referrer: "https://www.youtube.com/" });
      if (!resp.ok) {
        window.postMessage({ type: DL_RES, ok: false, error: "HTTP " + resp.status }, "*");
        return;
      }
      const blob = await resp.blob();
      window.postMessage({ type: DL_RES, ok: true, blob }, "*");
    } catch (err) {
      window.postMessage({ type: DL_RES, ok: false, error: String(err?.message || err) }, "*");
    }
  });

  function getVisitorData() {
    try {
      if (window.ytcfg && typeof window.ytcfg.get === "function") {
        const vd = window.ytcfg.get("VISITOR_DATA");
        if (typeof vd === "string" && vd.length > 20) return vd;
        // Новый YouTube кладёт visitorData в INNERTUBE_CONTEXT.
        const ctx = window.ytcfg.get("INNERTUBE_CONTEXT") || {};
        const vd2 = ctx?.client?.visitorData;
        if (typeof vd2 === "string" && vd2.length > 20) return vd2;
      }
    } catch (e) {}
    try {
      // Резерв: visitorData уже присутствует в контексте player response страницы.
      const pr = getPlayerResponse();
      const vd = pr?.context?.client?.visitorData;
      if (typeof vd === "string" && vd.length > 20) return vd;
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