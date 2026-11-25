// Громкость по каналам — помощник в мире страницы (world: MAIN). Только здесь
// виден API плеера YouTube: громкость ползунка (0…100) и setVolume — громкость,
// которую плеер покажет на ползунке и запомнит сам.
// Сам ничего не решает и не хранит: отвечает volume.js (изолированный мир).
// Вопрос — событие "ytcs-vol:ask" на document, ответ — "ytcs-vol:info"
// (JSON в detail, синхронно); "ytcs-vol:set" (detail — 0…100) ставит громкость.
// Канал и эфир volume.js узнаёт у speed-main.js ("ytcs-speed:ask").
(() => {
  if (window.__ytcsVolumeMain) return;
  // встроенный плеер — только внутри страницы расширения («Моя библиотека»)
  if (location.pathname.startsWith("/embed/")) {
    if (!String(location.ancestorOrigins?.[0] || "").startsWith("chrome-extension://")) return;
  } else if (window.top !== window) {
    return;
  }
  window.__ytcsVolumeMain = true;

  const player = () => document.getElementById("movie_player");

  document.addEventListener("ytcs-vol:ask", () => {
    let info = null;
    try {
      const p = player();
      const vol = Number(p?.getVolume?.());
      if (Number.isFinite(vol)) info = { volume: vol, muted: Boolean(p.isMuted?.()) };
    } catch (e) {
      info = null;
    }
    document.dispatchEvent(new CustomEvent("ytcs-vol:info", { detail: JSON.stringify(info) }));
  });

  document.addEventListener("ytcs-vol:set", (e) => {
    const vol = Number(e.detail);
    if (!Number.isFinite(vol) || vol < 0 || vol > 100) return;
    try {
      player()?.setVolume?.(Math.round(vol));
    } catch (err) {
      /* volume.js увидит, что не вышло, и попробует снова */
    }
  });
})();
