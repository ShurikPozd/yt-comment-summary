"use strict";

(() => {
  const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  const INNERTUBE_API = `https://www.youtube.com/youtubei/v1/next?key=${INNERTUBE_KEY}`;
  const CLIENT_VERSION = "2.20260910.00.00";

  const K = {
    meta: (id) => `meta:${id}`,
    comments: (id) => `comments:${id}`,
    state: (id) => `collect:${id}`,
  };
  const DEFAULT_MAX = 120;

  let currentVideoId = null;
  let collector = null; // активный сборщик (для отмены)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function videoIdFromUrl() {
    const m = location.pathname.match(/^\/watch/) && new URLSearchParams(location.search).get("v");
    if (m) return m;
    const s = location.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{6,20})/);
    if (s) return s[1];
    return null;
  }

  function send(payload) {
    try {
      chrome.runtime.sendMessage(payload).catch(() => {});
    } catch (e) {
      /* ignore */
    }
  }

  async function sessionGet(keys) {
    try {
      return await chrome.storage.session.get(keys);
    } catch (e) {
      return await chrome.storage.local.get(keys);
    }
  }
  async function sessionSet(patch) {
    try {
      await chrome.storage.session.set(patch);
    } catch (e) {
      await chrome.storage.local.set(patch);
    }
  }

  // ---------------- Метаданные видео/канала из DOM ----------------

  function extractMeta() {
    const id = videoIdFromUrl();
    if (!id) return null;
    const titleEl =
      document.querySelector("ytd-watch-metadata h1 yt-formatted-string") ||
      document.querySelector("h1.title.style-scope") ||
      document.querySelector("ytd-reel-video-renderer h1 yt-formatted-string") ||
      document.querySelector("ytd-reel-video-renderer h1");
    const title = (titleEl?.textContent || document.title.replace(" - YouTube", "") || "").trim();

    const owner = document.querySelector("#owner") || document.querySelector("ytd-watch-metadata #owner");
    const nameEl =
      owner?.querySelector("ytd-channel-name a") ||
      document.querySelector("ytd-channel-name a") ||
      document.querySelector("ytd-reel-video-renderer ytd-channel-name a") ||
      document.querySelector("#channel-name a") ||
      document.querySelector("#channel-name");
    const channelName = (nameEl?.textContent || "").trim();
    const channelUrl = (nameEl?.getAttribute("href") || "").trim() || null;

    const subsEl =
      owner?.querySelector("yt-formatted-string#owner-sub-count") ||
      document.querySelector("#owner-sub-count");
    const channelSubs = (subsEl?.textContent || "").trim();

    const avatarEl =
      owner?.querySelector("ytd-video-owner-renderer #img") ||
      owner?.querySelector("yt-avatar img") ||
      document.querySelector("#owner yt-avatar img") ||
      document.querySelector("ytd-reel-video-renderer yt-avatar img") ||
      document.querySelector("yt-avatar img");
    const channelAvatar = (avatarEl?.getAttribute("src") || "").split("=")[0] || null;

    const thumbs = {
      maxres: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
      sd: `https://i.ytimg.com/vi/${id}/sddefault.jpg`,
      hq: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };

    return {
      videoId: id,
      title,
      channelName,
      channelUrl,
      channelSubs,
      channelAvatar,
      thumbs,
      pageUrl: location.href.split("&")[0],
      collectedAt: Date.now(),
    };
  }

  async function storeMeta(meta) {
    if (!meta) return;
    await sessionSet({ [K.meta(meta.videoId)]: meta });
    send({ type: "yt:meta", meta });
  }

  // ---------------- InnerTube ----------------

  function baseContext() {
    return {
      client: {
        clientName: "WEB",
        clientVersion: CLIENT_VERSION,
        androidSdkVersion: 0,
        hl: (navigator.language || "ru-RU").replace("-", "_"),
        gl: "US",
        deviceMake: "",
        userAgent: navigator.userAgent,
        osName: "Windows",
        platform: "DESKTOP",
      },
    };
  }

  function walk(root, visit, depth, maxDepth) {
    if (depth > maxDepth || root == null) return;
    if (typeof root !== "object") return;
    if (Array.isArray(root)) {
      for (const item of root) walk(item, visit, depth + 1, maxDepth);
      return;
    }
    if (visit(root)) return;
    for (const k of Object.keys(root)) {
      const v = root[k];
      walk(v, visit, depth + 1, maxDepth);
    }
  }

  function findThreadNodes(data) {
    const out = [];
    walk(
      data,
      (o) => {
        if (o.commentThreadRenderer) {
          out.push(o);
          return true;
        }
        return false;
      },
      0,
      8
    );
    return out;
  }

  // Токен секции комментариев из engagement-панели первого ответа /next
  function commentSectionToken(data) {
    const panels = data.engagementPanels || [];
    for (const panel of panels) {
      const pr = panel?.engagementPanelSectionListRenderer;
      if (!pr) continue;
      if (pr.targetId && !String(pr.targetId).toLowerCase().includes("comment")) continue;
      const contents = pr.content?.sectionListRenderer?.contents;
      if (!Array.isArray(contents)) continue;
      for (const item of contents) {
        for (const sub of item?.itemSectionRenderer?.contents || []) {
          const tok = sub?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
          if (tok) return tok;
        }
      }
    }
    return null;
  }

  // Токен следующей страницы (новая схема: continuationItems; старая: nextContinuationData)
  function findNextToken(data) {
    let token = null;
    walk(
      data,
      (o) => {
        if (Array.isArray(o.continuationItems)) {
          for (const it of o.continuationItems) {
            const tok = it?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
            if (tok) token = tok;
          }
        }
        const nd = o.nextContinuationData;
        if (nd && nd.continuation) token = nd.continuation;
        return false;
      },
      0,
      12
    );
    return token;
  }

  // Карта сущностей комментариев из frameworkUpdates.entityBatchUpdate
  function buildEntityMap(data) {
    const map = new Map();
    const muts = data?.frameworkUpdates?.entityBatchUpdate?.mutations;
    if (Array.isArray(muts)) {
      for (const m of muts) {
        const cep = m?.payload?.commentEntityPayload;
        if (!cep || !cep.properties) continue;
        if (cep.key) map.set(cep.key, cep);
        if (cep.properties.commentId) map.set(cep.properties.commentId, cep);
      }
    }
    return map;
  }

  function parseLikes(str) {
    if (!str) return 0;
    const s = String(str).replace(/[\s\u00a0]/g, "").replace(",", ".").toLowerCase();
    const m = s.match(/([\d.]+)(тыс|млн|k|m|b|т)?/);
    if (!m) return 0;
    let n = parseFloat(m[1]);
    const suf = m[2] || "";
    if (["тыс", "k", "т"].includes(suf)) n *= 1000;
    else if (["млн", "m", "b"].includes(suf)) n *= 1e6;
    return Math.round(n) || 0;
  }

  function parseThread(thread, videoId) {
    const c = thread.commentRenderer;
    if (!c || !c.commentId) return null;
    let text = "";
    if (Array.isArray(c.contentText?.runs)) {
      text = c.contentText.runs.map((r) => r.text || "").join("");
    } else if (c.contentText?.simpleText) {
      text = c.contentText.simpleText;
    }
    if (!text.trim()) return null;
    let time = "";
    if (Array.isArray(c.publishedTimeText?.runs)) {
      time = c.publishedTimeText.runs.map((r) => r.text || "").join("");
    } else if (c.publishedTimeText?.simpleText) {
      time = c.publishedTimeText.simpleText;
    }
    return {
      id: c.commentId,
      author: (c.authorText?.simpleText || c.author?.simpleText || "?").trim(),
      avatar: c.authorThumbnail?.thumbnails?.[0]?.url || null,
      text,
      time: time.trim(),
      likes: c.likeCount || 0,
      likesLabel: c.likeCount ? String(c.likeCount) : "",
      link: `https://www.youtube.com/watch?v=${videoId}&lc=${c.commentId}`,
    };
  }

  function parseThreadV2(entity, videoId) {
    const p = entity?.properties || {};
    const content = p.content?.content || "";
    if (!content.trim()) return null;
    const likesLabel = entity.toolbar?.likeCountLiked || entity.toolbar?.likeCountNotliked || "";
    return {
      id: p.commentId || null,
      author: (entity.author?.displayName || "").trim() || "?",
      avatar: entity.author?.avatarThumbnailUrl || null,
      text: content,
      time: (p.publishedTime || "").trim(),
      likes: parseLikes(likesLabel),
      likesLabel,
      link: p.commentId ? `https://www.youtube.com/watch?v=${videoId}&lc=${p.commentId}` : null,
    };
  }

  async function innerTubePost(payload) {
    const resp = await fetch(INNERTUBE_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-YouTube-Client-Name": "1",
        "X-YouTube-Client-Version": CLIENT_VERSION,
      },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    if (resp.status === 403 || resp.status === 429) {
      throw new Error("innerTubeBlocked:" + resp.status);
    }
    if (!resp.ok) throw new Error("innerTube:" + resp.status);
    return resp.json();
  }

  // Просит мост (main world) вернуть streamingData текущего видео со страницы.
  // Там уже есть poToken/сигнатуры, выданные реальному плееру — это самым
  // надёжный и легальный способ получить рабочие URL форматов.
  function getPageFormatsFor(videoId, timeoutMs = 3000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMsg);
        clearTimeout(timer);
        resolve(val);
      };
      const onMsg = (e) => {
        if (e.source !== window || !e.data) return;
        if (e.data.type !== "ytc:streams") return;
        const sd = e.data.data;
        const list = sd ? (sd.formats || []).concat(sd.adaptiveFormats || []) : [];
        finish(list);
      };
      const timer = setTimeout(() => finish([]), timeoutMs);
      window.addEventListener("message", onMsg);
      window.postMessage({ type: "ytc:get-streams", videoId }, "*");
    });
  }

  async function fetchPlayerStream(videoId, quality) {
    // 1) Прямой путь: форматы уже лежат в playerResponse открытой страницы.
    const pageFormats = await getPageFormatsFor(videoId);
    if (pageFormats.length) {
      const stream = pickStream(pageFormats, quality);
      if (stream?.url) return stream.url;
    }

    // 2) Fallback клиенты Innertube (WEB/ANDROID/TVHTML5) — обход без poToken.
    const clients = [
      {
        clientName: "WEB",
        clientVersion: CLIENT_VERSION,
        osName: "Windows",
        platform: "DESKTOP",
      },
      {
        clientName: "ANDROID",
        clientVersion: "19.09.37",
        androidSdkVersion: 30,
        osName: "Android",
        platform: "MOBILE",
        osVersion: "14",
      },
      {
        clientName: "TVHTML5",
        clientVersion: "7.20241029.00.00",
        osName: "",
        platform: "TV",
      },
    ];

    let lastErr = "noFormats";
    for (const c of clients) {
      try {
        const payload = {
          context: { client: { hl: (navigator.language || "ru-RU").replace("-", "_"), gl: "US", ...c } },
          videoId,
        };
        const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-YouTube-Client-Name": c.clientName,
            "X-YouTube-Client-Version": c.clientVersion,
          },
          credentials: "include",
          body: JSON.stringify(payload),
        });
        if (!resp.ok) throw new Error("player:" + resp.status);
        const data = await resp.json();
        const formats = (data.streamingData?.formats || []).concat(data.streamingData?.adaptiveFormats || []);
        if (!formats.length) throw new Error("noFormats");
        const stream = pickStream(formats, quality);
        if (!stream?.url) throw new Error("noStream");
        return stream.url;
      } catch (e) {
        lastErr = String(e?.message || e);
      }
    }
    throw new Error(lastErr);

    function heightOf(f) {
      return Number(f.height) || 0;
    }
  }

  // Выбирает лучший поток под качество: предпочитает аудио-совмещённый (mp4).
  function pickStream(formats, quality) {
    const want = quality === "best" ? 999999 : Number(quality) || 999999;
    const withAudio = formats
      .filter((f) => f.url && f.mimeType && f.mimeType.includes("audio"))
      .sort((a, b) => heightOf(b) - heightOf(a));
    const any = formats
      .filter((f) => f.url && f.mimeType && f.mimeType.includes("mp4"))
      .sort((a, b) => heightOf(b) - heightOf(a));
    const pool = withAudio.length ? withAudio : any;
    if (!pool.length) return null;
    return pool.find((f) => heightOf(f) <= want) || pool[pool.length - 1];

    function heightOf(f) {
      return Number(f.height) || 0;
    }
  }

  async function collectViaInnerTube(videoId, limit, onBatch) {
    const out = [];
    const seen = new Set();

    // Шаг 1: получить токен секции комментариев с watch-страницы
    let token = null;
    {
      const page = await innerTubePost({ context: baseContext(), videoId });
      token = commentSectionToken(page);
    }
    if (!token) throw new Error("innerTubeNoCommentsSection");

    // Шаг 2+: листать комментарии по continuation
    while (out.length < limit && token) {
      if (collector?.cancelled) throw new Error("cancelled");
      const data = await innerTubePost({ context: baseContext(), continuation: token });
      const entities = buildEntityMap(data);

      for (const node of findThreadNodes(data)) {
        if (out.length >= limit) break;
        const ctr = node.commentThreadRenderer;
        const commentKey = ctr?.commentViewModel?.commentViewModel?.commentKey;
        const entity = commentKey ? entities.get(commentKey) || entities.get(decodeBase64Url(commentKey)) : null;

        let parsed = null;
        if (entity) {
          parsed = parseThreadV2(entity, videoId);
        } else if (ctr?.commentRenderer) {
          parsed = parseThread({ commentRenderer: ctr.commentRenderer }, videoId);
        }
        if (!parsed || !parsed.text.trim() || seen.has(parsed.id)) continue;
        seen.add(parsed.id);
        out.push(parsed);
      }

      token = findNextToken(data);
      if (!token) break;
      onBatch?.(out.length);
      await sleep(350);
    }
    return out;
  }

  function decodeBase64Url(s) {
    try {
      const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch (e) {
      return s;
    }
  }

  // ---------------- DOM fallback ----------------

  function readDomComment(root) {
    const textEl = root.querySelector("#content-text");
    const text = (textEl?.textContent || "").trim();
    if (!text) return null;
    const authorEl = root.querySelector("#author-text");
    const author = (authorEl?.textContent || "?").trim();
    const img = root.querySelector("#author-thumbnail img, yt-img-shadow img");
    const avatar = (img?.getAttribute("src") || "").split("=")[0] || null;
    const likesEl = root.querySelector("#vote-count-middle");
    const likes = parseInt((likesEl?.textContent || "0").replace(/\s+/g, ""), 10) || 0;
    const timeEl = root.querySelector("#published-time-text");
    const id = root.querySelector("#comment, yt-comment-view-model")?.getAttribute("comment-id");
    return {
      id: id || `dom${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
      author,
      avatar,
      text,
      time: (timeEl?.textContent || "").trim(),
      likes,
      link: id ? `https://www.youtube.com/watch?v=${videoIdFromUrl()}&lc=${id}` : null,
    };
  }

  async function collectViaDom(videoId, limit, onBatch) {
    const out = [];
    document.querySelector("#comments")?.scrollIntoView();
    for (let i = 0; i < 60 && out.length < limit; i++) {
      if (collector?.cancelled) throw new Error("cancelled");
      const nodes = document.querySelectorAll("ytd-comment-renderer, ytd-comment-view-model");
      for (const n of nodes) {
        if (out.length >= limit) break;
        const parsed = readDomComment(n);
        if (parsed && !out.some((c) => c.id === parsed.id)) {
          out.push(parsed);
        }
      }
      const expandMore = document.querySelector("ytd-button-renderer#more-replies");
      expandMore?.click();
      const cont = document.querySelector("ytd-continuation-item-renderer");
      cont?.querySelector("tp-yt-paper-button, button")?.click();
      onBatch?.(out.length);
      await sleep(800);
    }
    return out;
  }

  // ---------------- Оркестрация сбора ----------------

  async function runCollection(videoId, force) {
    if (!videoId) return;
    const stateKey = K.state(videoId);
    const { [stateKey]: prev } = await sessionGet([stateKey]);
    if (!force && prev && (prev.status === "done" || prev.status === "loading")) return;

    const settings = (await chrome.storage.local.get("settings")).settings || {};
    const max = Math.min(Math.max(parseInt(settings.maxComments, 10) || DEFAULT_MAX, 10), 2000);
    const mode = settings.collectMode || "auto";

    collector = { cancelled: false };
    await sessionSet({ [stateKey]: { status: "loading", fetched: 0, max, error: null } });
    send({ type: "yt:progress", videoId, status: "loading", fetched: 0, max });

    let comments = [];
    const onBatch = async (n) => {
      await sessionSet({
        [stateKey]: { status: "loading", fetched: n, max, error: null },
        [K.comments(videoId)]: comments,
      });
      send({ type: "yt:progress", videoId, status: "loading", fetched: n, max });
    };

    try {
      if (mode === "innerTube" || mode === "auto") {
        try {
          comments = await collectViaInnerTube(videoId, max, onBatch);
        } catch (e) {
          if (String(e.message).startsWith("innerTubeBlocked") && mode === "auto") {
            comments = await collectViaDom(videoId, max, onBatch);
          } else {
            throw e;
          }
        }
      } else {
        comments = await collectViaDom(videoId, max, onBatch);
      }
      comments = comments.slice(0, max);
      await sessionSet({
        [stateKey]: { status: "done", fetched: comments.length, max, error: null },
        [K.comments(videoId)]: comments,
      });
      send({ type: "yt:progress", videoId, status: "done", fetched: comments.length, max: comments.length });
      send({ type: "yt:ready", videoId, count: comments.length });
    } catch (e) {
      const msg = String(e.message || e);
      if (msg === "cancelled") {
        await sessionSet({ [stateKey]: { status: "idle", fetched: 0, max, error: null } });
      } else {
        await sessionSet({ [stateKey]: { status: "error", fetched: comments.length, max, error: msg } });
      }
      send({ type: "yt:progress", videoId, status: "error", fetched: comments.length, max, error: msg });
    }
  }

  async function handlePage({ forceCollect = false } = {}) {
    const id = videoIdFromUrl();
    if (!id) {
      currentVideoId = null;
      send({ type: "yt:away" });
      return;
    }
    if (id === currentVideoId && !forceCollect) return;
    currentVideoId = id;

    // светимся на новом видео
    const meta = extractMeta();
    await storeMeta(meta);
    const { [K.state(id)]: st } = await sessionGet([K.state(id)]);
    if (st?.status === "done") {
      send({ type: "yt:progress", videoId: id, status: "done", fetched: st.fetched, max: st.fetched });
    } else {
      void runCollection(id, forceCollect);
    }
  }

  // ---------------- Сообщения ----------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "yt:meta-query": {
        const id = videoIdFromUrl();
        if (!id) {
          sendResponse({ type: "yt:meta-query:reply", videoId: null });
          return;
        }
        const meta = extractMeta();
        void sessionGet([K.state(id)]).then((obj) =>
          sendResponse({
            type: "yt:meta-query:reply",
            videoId: id,
            meta,
            state: obj[K.state(id)],
          })
        );
        return true; // async
      }
      case "yt:start-collect":
        currentVideoId = videoIdFromUrl();
        void runCollection(currentVideoId, true);
        sendResponse({ ok: true });
        return false;
      case "yt:cancel-collect":
        if (collector) collector.cancelled = true;
        sendResponse({ ok: true });
        return false;
      case "yt:rerun-meta": {
        const id = videoIdFromUrl();
        if (!id) break;
        const meta = extractMeta();
        void storeMeta(meta);
        sendResponse({ ok: true, meta });
        return false;
      }
      case "yt:player-stream": {
        void fetchPlayerStream(msg.videoId, msg.quality || "720")
          .then((streamUrl) => sendResponse({ ok: Boolean(streamUrl), streamUrl: streamUrl || "" }))
          .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
        return true; // async
      }
      default:
        break;
    }
    return undefined;
  });

  // SPA-навигация YouTube
  window.addEventListener("yt-navigate-finish", () => handlePage());
  window.addEventListener("popstate", () => handlePage());
  const _pushState = history.pushState.bind(history);
  history.pushState = (...args) => {
    _pushState(...args);
    setTimeout(() => handlePage(), 60);
  };

  handlePage();
})();