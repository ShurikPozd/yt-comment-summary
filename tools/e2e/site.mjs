// Подменённая сеть сквозного теста: что отвечать на каждый запрос браузера.
// Страницы YouTube собираются из снимков fixtures/*-flexy.html / *-browse.html —
// настоящая разметка youtube.com, снятая в обычном браузере и обезличенная
// (тексты → «Текст N», ссылки и id видео → вымышленные, без картинок, стилей,
// скриптов и атрибутов с данными). Ответы youtubei — fixtures/next-*.json.
// Бот сводок (onrender.com) и Groq — заглушка, запросы к ним записываются.
import { readFileSync } from "node:fs";

const FX = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const PLAYER_JS = readFileSync(new URL("./player.js", import.meta.url));

export const VIDEO = { id: "e2eVideo001", title: "Тестовое видео: как утеплить дом", channel: "Тестовый канал", duration: 300 };
// версия клиента со снятой страницы — content.js берёт её из ytcfg
const CLIENT_VERSION = "2.20261123.08.00";

// Без стилей YouTube у элементов снимка нет размеров — минимум, чтобы плеер и
// обложки были видны и на них можно было навести мышь.
const CSS = `
html, body { margin: 0; background: #0f0f0f; color: #f1f1f1; font: 14px Roboto, Arial, sans-serif; }
ytd-app, ytd-page-manager, ytd-browse, ytd-watch-flexy, yt-lockup-view-model, ytd-rich-item-renderer, ytd-rich-grid-renderer,
ytd-rich-section-renderer, ytd-item-section-renderer, ytd-watch-next-secondary-results-renderer, ytd-watch-metadata,
yt-thumbnail-view-model, ytd-player, ytd-comments, ytd-reel-shelf-renderer, ytm-shorts-lockup-view-model,
ytm-shorts-lockup-view-model-v2, ytd-rich-shelf-renderer { display: block; }
#masthead-container { height: 56px; }
ytd-watch-flexy #full-bleed-container, ytd-watch-flexy #cinematics-container, ytd-watch-flexy #panels-full-bleed-container,
.player-container-background, ytd-watch-flexy [class*="skeleton"] { display: none; }
ytd-watch-metadata h1 { font-size: 20px; margin: 12px 0 4px; }
ytd-watch-flexy #columns { display: flex; gap: 24px; padding: 0 24px; }
ytd-watch-flexy #primary { flex: 1; min-width: 0; }
ytd-watch-flexy #secondary { width: 400px; }
#player-container, #ytd-player, #container.ytd-player { position: relative; }
#movie_player { position: relative; width: 854px; height: 480px; background: #000; overflow: hidden; }
#movie_player .html5-video-container, #movie_player video { position: absolute; inset: 0; width: 100%; height: 100%; }
#movie_player .ytp-chrome-bottom { position: absolute; left: 12px; right: 12px; bottom: 0; height: 48px; z-index: 50; }
#movie_player .ytp-chrome-controls { display: flex; justify-content: space-between; height: 48px; }
#movie_player .ytp-left-controls, #movie_player .ytp-right-controls,
#movie_player .ytp-right-controls-left, #movie_player .ytp-right-controls-right { display: flex; align-items: center; }
#movie_player .ytp-button { width: 40px; height: 40px; border: 0; background: none; color: #fff; padding: 0; }
#movie_player .ytp-popup, #movie_player .ytp-tooltip, #movie_player .ytp-overlay, #movie_player .ytp-spinner,
#movie_player .ytp-autonav-endscreen-countdown-overlay, #movie_player .html5-endscreen, #movie_player .ytp-ce-element,
#movie_player [class*="ytp-suggested"], #movie_player .ytp-storyboard-framepreview, #movie_player .ytp-cued-thumbnail-overlay { display: none; }
#movie_player .ytcs-menu.open { display: block; }
a { color: inherit; }
yt-lockup-view-model { width: 400px; margin: 8px 0; }
ytd-rich-grid-renderer #contents { display: flex; flex-wrap: wrap; gap: 16px; padding: 16px; }
ytd-rich-item-renderer { width: 360px; }
ytd-rich-item-renderer yt-lockup-view-model { width: 360px; }
yt-thumbnail-view-model, a#thumbnail, .ytLockupViewModelContentImage { display: block; position: relative; width: 100%; aspect-ratio: 16 / 9; background: linear-gradient(135deg, #3a4a6b, #1b2233); border-radius: 8px; }
.ytLockupViewModelHorizontal { display: flex; gap: 8px; }
.ytLockupViewModelHorizontal > .ytLockupViewModelContentImage { width: 168px; flex: none; }
ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2 { width: 200px; }
.shortsLockupViewModelHostThumbnailContainer, [class*='ThumbnailContainer'] { display: block; position: relative; aspect-ratio: 9 / 16; width: 200px; background: #333; }
img { display: block; width: 100%; height: 100%; object-fit: cover; }
[hidden] { display: none !important; }
`;

function page(fragment, { title = "YouTube" } = {}) {
  const ytcfg = { INNERTUBE_API_KEY: "e2e-test-key", INNERTUBE_CLIENT_VERSION: CLIENT_VERSION, INNERTUBE_CLIENT_NAME: "WEB", LOGGED_IN: true, HL: "ru", GL: "RU" };
  return `<!doctype html>
<html lang="ru-RU" dark system-icons typography>
<head>
<meta charset="utf-8">
<title>${title}</title>
<script>var ytcfg = { d: () => window.yt && yt.config_ || {}, set: (o) => Object.assign((window.yt = window.yt || {}).config_ = (window.yt.config_ || {}), o) };
ytcfg.set(${JSON.stringify(ytcfg)});
window.__e2e = ${JSON.stringify(VIDEO)};</script>
<script src="/e2e/player.js"></script>
<style>${CSS}</style>
</head>
<body>
<ytd-app>
<div id="masthead-container"><ytd-masthead id="masthead"></ytd-masthead></div>
<div id="content"><ytd-page-manager id="page-manager">${fragment}</ytd-page-manager></div>
</ytd-app>
</body>
</html>`;
}

/** Тишина WAV на d секунд (8 кГц, 8 бит, моно) — настоящее медиа для <video>. */
function wav(d) {
  const rate = 8000;
  const n = rate * d;
  const b = Buffer.alloc(44 + n, 0x80);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // моно
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36);
  b.writeUInt32LE(n, 40);
  return b;
}
const wavCache = new Map();

// обложка i.ytimg.com — серый PNG 1×1
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const json = (o, status = 200) => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: Buffer.from(JSON.stringify(o)) });
const text = (s, type, status = 200) => ({ status, headers: { "content-type": type }, body: Buffer.from(s) });

/**
 * Ответ на запрос или null — «чужой» запрос (тест его отклонит и запишет).
 * log — журнал запросов к ИИ: { url, body }.
 */
export function route({ url, method, headers = {}, postData = "" }, log) {
  const u = new URL(url);
  const host = u.hostname;
  if (host === "www.youtube.com") {
    const p = u.pathname;
    if (p === "/watch") return text(page(FX("watch-flexy.html"), { title: `${VIDEO.title} - YouTube` }), "text/html; charset=utf-8");
    if (p === "/") return text(page(FX("home-browse.html")), "text/html; charset=utf-8");
    if (p === "/e2e/player.js") return { status: 200, headers: { "content-type": "text/javascript; charset=utf-8" }, body: PLAYER_JS };
    if (p === "/e2e/media.wav") {
      const d = Math.min(3600, Math.max(1, Number(u.searchParams.get("d")) || 60));
      if (!wavCache.has(d)) wavCache.set(d, wav(d));
      const all = wavCache.get(d);
      const range = /bytes=(\d+)-(\d*)/.exec(headers.Range || headers.range || "");
      if (!range) return { status: 200, headers: { "content-type": "audio/wav", "accept-ranges": "bytes" }, body: all };
      const a = Number(range[1]);
      const z = range[2] ? Math.min(Number(range[2]), all.length - 1) : all.length - 1;
      return {
        status: 206,
        headers: { "content-type": "audio/wav", "accept-ranges": "bytes", "content-range": `bytes ${a}-${z}/${all.length}` },
        body: all.subarray(a, z + 1),
      };
    }
    if (p === "/youtubei/v1/next" && method === "POST") {
      let req = {};
      try {
        req = JSON.parse(postData || "{}");
      } catch {}
      log.innertube.push(req.continuation || req.videoId || "?");
      if (req.continuation === "E2E_COMMENTS" || req.continuation === "E2E_TOP" || req.continuation === "E2E_NEW") return text(FX("next-comments.json"), "application/json");
      if (req.videoId) return text(FX("next-video.json"), "application/json");
      return json({ responseContext: {} });
    }
    if (p.startsWith("/youtubei/")) return json({ responseContext: {} });
    if (p === "/oembed") return json({ title: VIDEO.title, author_name: VIDEO.channel, thumbnail_url: "" });
    if (p === "/favicon.ico" || p.startsWith("/s/")) return text("", "text/plain", 404);
    return null;
  }
  if (host === "i.ytimg.com" || host.endsWith(".ggpht.com")) return { status: 200, headers: { "content-type": "image/png" }, body: PNG };
  if (host.endsWith(".onrender.com") || host === "api.groq.com" || host === "localhost") {
    if (u.pathname === "/api/chat") {
      log.ai.push({ url, body: postData });
      // поток как у бота: дельты и [DONE]
      const evt = (o) => `data: ${JSON.stringify(o)}\n\n`;
      return text(evt({ delta: '{"summary":"Заглушка сквозного теста."}' }) + "data: [DONE]\n\n", "text/event-stream");
    }
    log.ai.push({ url, body: postData });
    return json({});
  }
  if (host === "sponsor.ajay.app") return text("[]", "application/json", 404);
  if (host === "fonts.googleapis.com" || host === "fonts.gstatic.com") return text("", "text/css", 404);
  return null;
}
