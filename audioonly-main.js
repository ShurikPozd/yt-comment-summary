// «Только звук» — помощник в мире страницы (world: MAIN). Только здесь виден API
// плеера YouTube: название, канал и id открытого видео (в том числе в мини-плеере),
// список качеств и setPlaybackQualityRange — им просим самое низкое качество (144p),
// пока видео скрыто, и возвращаем ваше при выключении.
// Сам ничего не решает и не хранит: отвечает audioonly.js (изолированный мир).
//
// Тонкость: setPlaybackQualityRange сохраняет выбор в localStorage ("yt-player-quality") —
// как если бы вы выбрали 144p в ⚙ сами, и тогда 144p досталось бы всем вкладкам и
// следующим визитам. Поэтому сразу после вызова кладём туда прежнее значение: низкое
// качество остаётся только у этого плеера в памяти.
//
// "ytcs-ao:ask" → синхронно "ytcs-ao:info" (JSON в detail);
// "ytcs-ao:low" (detail — качество, "tiny"; выбирает audioonly-core.js) — ответ "ytcs-ao:done" ({ ok, q });
// "ytcs-ao:restore" — вернуть качество, которое было до "ytcs-ao:low".
(() => {
  if (window.__ytcsAudioOnlyMain) return;
  // встроенный плеер — только внутри страницы расширения («Моя библиотека»)
  if (location.pathname.startsWith("/embed/")) {
    if (!String(location.ancestorOrigins?.[0] || "").startsWith("chrome-extension://")) return;
  } else if (window.top !== window) {
    return;
  }
  window.__ytcsAudioOnlyMain = true;

  const LS_KEY = "yt-player-quality";
  const player = () => document.getElementById("movie_player");
  let saved = null; // { pref } — ваше качество до режима

  const reply = (type, data) => document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(data) }));

  document.addEventListener("ytcs-ao:ask", () => {
    let info = null;
    try {
      const p = player();
      const d = p?.getVideoData?.() || {};
      const vd = p?.getPlayerResponse?.()?.videoDetails || {};
      const id = d.video_id || vd.videoId || "";
      if (id) {
        info = {
          videoId: id,
          title: d.title || (vd.videoId === id ? vd.title : "") || "",
          author: d.author || (vd.videoId === id ? vd.author : "") || "",
          channelId: vd.videoId === id ? vd.channelId || "" : "",
          live: Boolean(d.isLive || (vd.videoId === id && vd.isLive)),
          quality: p.getPlaybackQuality?.() || "",
          levels: p.getAvailableQualityLevels?.() || [],
        };
      }
    } catch (e) {
      info = null;
    }
    reply("ytcs-ao:info", info);
  });

  // кладём в localStorage то, что там было (или убираем, если не было)
  function putBack(raw) {
    try {
      if (raw == null) localStorage.removeItem(LS_KEY);
      else localStorage.setItem(LS_KEY, raw);
    } catch (e) {
      /* хранилище недоступно — YouTube и так его не читает */
    }
  }
  function readRaw() {
    try {
      return localStorage.getItem(LS_KEY);
    } catch (e) {
      return null;
    }
  }

  document.addEventListener("ytcs-ao:low", (e) => {
    let res = { ok: false, q: "" };
    try {
      const p = player();
      const levels = p?.getAvailableQualityLevels?.() || [];
      const low = String(e.detail || "");
      if (p?.setPlaybackQualityRange && low && low !== "auto" && levels.includes(low)) {
        const raw = readRaw();
        if (!saved) {
          // ваше качество: «авто» или выбранное в ⚙ (из списка этого видео)
          const pref = String(p.getPreferredQuality?.() || "auto");
          saved = { pref: levels.includes(pref) ? pref : "auto" };
        }
        if (p.getPlaybackQuality?.() !== low || p.getPreferredQuality?.() !== low) p.setPlaybackQualityRange(low, low);
        putBack(raw);
        res = { ok: true, q: low };
      }
    } catch (e) {
      res = { ok: false, q: "" };
    }
    reply("ytcs-ao:done", res);
  });

  document.addEventListener("ytcs-ao:restore", () => {
    if (!saved) return;
    const { pref } = saved;
    saved = null;
    try {
      const p = player();
      const raw = readRaw();
      p?.setPlaybackQualityRange?.(pref, pref);
      putBack(raw);
    } catch (e) {
      /* плеер ушёл — на следующем видео YouTube и так возьмёт ваше качество */
    }
  });
})();
