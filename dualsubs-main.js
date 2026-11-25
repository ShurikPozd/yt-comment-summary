// «Двойные субтитры» — помощник в мире страницы (world: MAIN). Только здесь
// виден API плеера YouTube: список дорожек субтитров и включение субтитров.
// Сам ничего не показывает и не решает: отвечает dualsubs.js (изолированный мир).
//
// Зачем включать субтитры плеера: timedtext без PO-токена пустой, а токен
// делает сам плеер, когда запрашивает дорожку. Ловим адрес этого запроса
// (PerformanceObserver — без подмены fetch/XHR), а включённые нами субтитры
// сразу выключаем обратно — как было у вас.
//
// "ytcs-ds:ask" → синхронно "ytcs-ds:info" (JSON в detail);
// "ytcs-ds:prime" (detail {lang, kind}) — включить дорожку, чтобы плеер её запросил;
// "ytcs-ds:restore" — вернуть субтитры плеера, как было до prime;
// "ytcs-ds:url" (от нас) — плеер запросил субтитры, detail — адрес.
(() => {
  if (window.__ytcsDualMain || window.top !== window) return;
  window.__ytcsDualMain = true;

  const player = () => document.getElementById("movie_player");
  const urls = new Map(); // id видео → последний адрес timedtext с токеном
  let saved = null; // { vid, track } — субтитры плеера до нашего prime

  const videoOf = (u) => {
    try {
      const x = new URL(u);
      return x.pathname === "/api/timedtext" && x.searchParams.has("pot") ? x.searchParams.get("v") || "" : "";
    } catch (e) {
      return "";
    }
  };
  const remember = (name) => {
    const vid = videoOf(name);
    if (!vid) return;
    urls.delete(vid);
    urls.set(vid, name);
    if (urls.size > 20) urls.delete(urls.keys().next().value);
    document.dispatchEvent(new CustomEvent("ytcs-ds:url", { detail: name }));
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name.includes("/api/timedtext")) remember(e.name);
    }).observe({ type: "resource", buffered: true });
  } catch (e) {
    /* без наблюдателя — dualsubs.js тихо ничего не покажет */
  }

  const curTrack = (p) => {
    try {
      return p.getOption("captions", "track") || {};
    } catch (e) {
      return {};
    }
  };

  document.addEventListener("ytcs-ds:ask", () => {
    let info = null;
    try {
      const p = player();
      const resp = p?.getPlayerResponse?.();
      const vid = p?.getVideoData?.()?.video_id || resp?.videoDetails?.videoId || "";
      if (vid && resp?.videoDetails?.videoId === vid) {
        const r = resp.captions?.playerCaptionsTracklistRenderer || {};
        const audio = (r.audioTracks || [])[r.defaultAudioTrackIndex || 0] || {};
        // язык исходного звука — у видео с несколькими звуковыми дорожками (автодубляж)
        const orig = (resp.streamingData?.adaptiveFormats || []).find((f) => f.audioTrack?.audioIsDefault)?.audioTrack;
        info = {
          vid,
          tracks: (r.captionTracks || []).map((t) => ({ lang: t.languageCode || "", kind: t.kind || "", vss: t.vssId || "", tr: t.isTranslatable !== false })),
          defaultIndex: Number.isInteger(audio.defaultCaptionTrackIndex) ? audio.defaultCaptionTrackIndex : 0,
          audioLang: orig?.id ? String(orig.id).split(".")[0] : "",
          url: urls.get(vid) || "",
          live: Boolean(resp.videoDetails?.isLive),
        };
      }
    } catch (e) {
      info = null;
    }
    document.dispatchEvent(new CustomEvent("ytcs-ds:info", { detail: JSON.stringify(info) }));
  });

  document.addEventListener("ytcs-ds:prime", (e) => {
    try {
      const want = JSON.parse(e.detail || "{}");
      const p = player();
      const vid = p?.getVideoData?.()?.video_id;
      if (!p || !vid || !want.lang) return;
      if (!saved || saved.vid !== vid) saved = { vid, track: { ...curTrack(p) } };
      p.loadModule?.("captions");
      const cur = curTrack(p);
      if (cur.languageCode === want.lang && (cur.kind || "") === (want.kind || "") && !cur.translationLanguage) {
        p.setOption("captions", "reload", true); // та же дорожка уже загружена — пусть запросит снова
      } else {
        p.setOption("captions", "track", want.kind ? { languageCode: want.lang, kind: want.kind } : { languageCode: want.lang });
      }
    } catch (err) {
      /* плеер не готов — dualsubs.js попробует позже */
    }
  });

  document.addEventListener("ytcs-ds:restore", () => {
    const s = saved;
    saved = null;
    if (!s) return;
    try {
      const p = player();
      if (!p || p.getVideoData?.()?.video_id !== s.vid) return;
      if (s.track?.languageCode) {
        p.setOption("captions", "track", s.track);
      } else {
        p.setOption("captions", "track", {});
        p.unloadModule?.("captions"); // субтитры были выключены — выключаем (и запомненное YouTube «выкл.» тоже)
      }
    } catch (err) {
      /* не вышло — останутся включёнными, но спрятаны нашей плашкой */
    }
  });
})();
