"use strict";

(() => {
  // Встроенный плеер (youtube.com/embed) — только внутри нашей «Моей библиотеки»;
  // встроенные видео на чужих сайтах расширение не трогает.
  if (location.pathname.startsWith("/embed/")) {
    let ours = false;
    try {
      ours = location.ancestorOrigins?.[0] === `chrome-extension://${chrome.runtime.id}`;
    } catch (e) {
      ours = false;
    }
    if (!ours) return;
  }
  // встроенный плеер в «Моей библиотеке» — работаем как на странице видео
  const OUR_EMBED = location.pathname.startsWith("/embed/");

  // Запасные значения: настоящие берём из ytcfg страницы (см. innerTubeConfig),
  // иначе после очередного обновления YouTube сбор через API тихо сломается.
  const FALLBACK_INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  const FALLBACK_CLIENT_VERSION = "2.20260910.00.00";
  let ytcfgCache = null;

  // Контент-скрипт живёт в изолированном мире и не видит window.ytcfg,
  // но inline-скрипты страницы с ytcfg.set({...}) лежат в DOM — читаем оттуда.
  function innerTubeConfig() {
    if (ytcfgCache) return ytcfgCache;
    let key = null;
    let version = null;
    for (const s of document.scripts) {
      const t = s.textContent;
      if (!t || !t.includes("INNERTUBE_")) continue;
      key ||= t.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1] || null;
      version ||= t.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1] || null;
      if (key && version) break;
    }
    const cfg = { key: key || FALLBACK_INNERTUBE_KEY, version: version || FALLBACK_CLIENT_VERSION };
    if (key && version) ytcfgCache = cfg; // кэшируем только найденное, иначе попробуем снова позже
    return cfg;
  }

  const K = {
    meta: (id) => `meta:${id}`,
    comments: (id) => `comments:${id}`,
    state: (id) => `collect:${id}`,
  };
  const DEFAULT_MAX = 120;

  let currentVideoId = null;
  let collector = null; // активный сборщик (для отмены); { videoId, cancelled }
  let collectGen = 0; // поколение сбора: растёт при смене видео/рестарте

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function videoIdFromUrl() {
    const m = location.pathname.match(/^\/watch/) && new URLSearchParams(location.search).get("v");
    if (m) return m;
    const e = OUR_EMBED && location.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})/);
    if (e) return e[1];
    const s = location.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{6,20})/);
    if (s) return s[1];
    return null;
  }

  // Расширение обновили или отключили — этот экземпляр скрипта осиротел: любой
  // вызов chrome.* бросает «Extension context invalidated». Тихо ничего не
  // делаем; после F5 страница получит свежую версию.
  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };

  function send(payload) {
    if (!alive()) return;
    try {
      chrome.runtime.sendMessage(payload).catch(() => {});
    } catch (e) {
      /* ignore */
    }
  }

  async function sessionGet(keys) {
    if (!alive()) return {};
    try {
      return await chrome.storage.session.get(keys);
    } catch (e) {
      try {
        return await chrome.storage.local.get(keys);
      } catch (e2) {
        return {};
      }
    }
  }

  // ------ Вытеснение кэша при переполнении session (10 МБ) ------
  // Комментарии каждого просмотренного видео лежат в session до закрытия
  // браузера; при листании списков квота легко выбивается (Resource::kQuotaBytes
  // quota exceeded). Храним порядок недавних видео (svc:order) и при запросе
  // записываем в начало; при нехватке места удаляем самые старые видео целиком.
  const ORDER_KEY = "svc:order";
  const VIDEO_PREFIXES = ["comments:", "collect:", "meta:", "summary:"];

  async function getSessionOrder() {
    try {
      const o = await chrome.storage.session.get(ORDER_KEY);
      return Array.isArray(o[ORDER_KEY]) ? o[ORDER_KEY] : [];
    } catch (e) {
      return [];
    }
  }
  async function setSessionOrder(order) {
    try {
      await chrome.storage.session.set({ [ORDER_KEY]: order.slice(0, 30) });
    } catch (e) {
      /* не критично */
    }
  }
  async function touchVideoOrder(id) {
    try {
      const o = await getSessionOrder();
      const i = o.indexOf(id);
      if (i >= 0) o.splice(i, 1);
      o.unshift(id);
      await setSessionOrder(o);
    } catch (e) {
      /* не критично */
    }
  }
  async function evictVideoFromSession(id) {
    try {
      await chrome.storage.session.remove(VIDEO_PREFIXES.map((p) => p + id));
    } catch (e) {
      /* partial */
    }
    try {
      const o = await getSessionOrder();
      const i = o.indexOf(id);
      if (i >= 0) {
        o.splice(i, 1);
        await setSessionOrder(o);
      }
    } catch (e) {
      /* не критично */
    }
  }

  async function sessionSet(patch) {
    for (let attempt = 0; attempt < 12; attempt++) {
      if (!alive()) return;
      try {
        await chrome.storage.session.set(patch);
        return;
      } catch (e) {
        const em = String(e?.message || e);
        // не квота — повтором не лечится; в local не пишем: панель читает
        // только session, а local никто бы не чистил
        if (!/quota|QuotaBytes/i.test(em)) {
          console.warn("session.set:", em);
          return;
        }
        // квота session: выбиваем самое старое видео
        const order = await getSessionOrder();
        if (order.length) {
          // await обязателен: без него повтор записи шёл раньше, чем место
          // освобождалось, и все 12 попыток сгорали впустую.
          await evictVideoFromSession(order[order.length - 1]);
          continue;
        }
        // порядок пуст/не сохранился — удаляем все чужие кэши субэкстрейнов (comments/collect/meta),
        // но НЕ summary и НЕ svc:order, чтобы не потерять накопленные сводки без нужды.
        try {
          const all = await chrome.storage.session.get(null);
          const stale = Object.keys(all).filter((k) => /^(comments|collect|meta):/i.test(k));
          if (stale.length) {
            await chrome.storage.session.remove(stale);
            continue; // место освободили — пробуем записать снова
          }
        } catch (e2) {
          /* partial */
        }
        break;
      }
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
    // во встроенном плеере название и канал — в его шапке
    const embedTitle = OUR_EMBED ? document.querySelector(".ytp-title-link, .ytp-title-text a")?.textContent : "";
    const title = (titleEl?.textContent || embedTitle || document.title.replace(" - YouTube", "") || "").trim();

    const owner = document.querySelector("#owner") || document.querySelector("ytd-watch-metadata #owner");
    const nameEl =
      owner?.querySelector("ytd-channel-name a") ||
      document.querySelector("ytd-channel-name a") ||
      document.querySelector("ytd-reel-video-renderer ytd-channel-name a") ||
      document.querySelector("#channel-name a") ||
      document.querySelector("#channel-name");

    const linkEl = nameEl?.tagName === "A" ? nameEl : (nameEl?.querySelector("a") || nameEl);
    const embedChannel = OUR_EMBED ? document.querySelector(".ytp-title-channel-name, .ytp-title-expanded-title a")?.textContent : "";
    const channelName = (linkEl?.textContent || nameEl?.textContent || embedChannel || "").trim();
    let channelUrl = (linkEl?.getAttribute("href") || "").trim() || null;
    if (channelUrl && !/^(https?:\/\/|\/)/i.test(channelUrl)) channelUrl = "/" + channelUrl;

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

    // Длительность нужна, чтобы отсеять «таймкоды» за концом видео. При
    // SPA-навигации плеер какое-то время держит прошлое видео, поэтому берём
    // её, только если плеер уже переключён на текущий id.
    const playerId = OUR_EMBED ? id : document.querySelector("ytd-watch-flexy")?.getAttribute("video-id");
    const dur = playerId === id ? document.querySelector("video")?.duration : NaN;

    return {
      videoId: id,
      duration: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : null,
      title,
      channelName,
      channelUrl,
      channelSubs,
      channelAvatar,
      thumbs,
      pageUrl: OUR_EMBED ? `https://www.youtube.com/watch?v=${id}` : location.href.split("&")[0],
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
        clientVersion: innerTubeConfig().version,
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
        // Состояние тулбара (сердечко от автора) — отдельная сущность,
        // на неё ссылается properties.toolbarStateKey комментария.
        const st = m?.payload?.engagementToolbarStateEntityPayload;
        if (st?.key) map.set("state:" + st.key, st);
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
    else if (["млн", "m"].includes(suf)) n *= 1e6;
    else if (suf === "b") n *= 1e9;
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
      replies: Number(c.replyCount) || 0,
      isCreator: Boolean(c.authorIsChannelOwner),
      hearted: Boolean(c.actionButtons?.commentActionButtonsRenderer?.creatorHeart?.creatorHeartRenderer?.isHearted),
      link: `https://www.youtube.com/watch?v=${videoId}&lc=${c.commentId}`,
    };
  }

  function parseThreadV2(entity, videoId, entities) {
    const p = entity?.properties || {};
    const content = p.content?.content || "";
    if (!content.trim()) return null;
    // Notliked — счётчик без нашего собственного лайка (Liked = +1, если зритель лайкнул сам).
    // ?? а не ||: у комментария без лайков «Notliked» — пустая строка, а
    // «Liked» = лайки + ваш, то есть «1»
    const likesLabel = entity.toolbar?.likeCountNotliked ?? entity.toolbar?.likeCountLiked ?? "";
    const state = p.toolbarStateKey && entities ? entities.get("state:" + p.toolbarStateKey) : null;
    return {
      id: p.commentId || null,
      author: (entity.author?.displayName || "").trim() || "?",
      avatar: entity.author?.avatarThumbnailUrl || null,
      text: content,
      time: (p.publishedTime || "").trim(),
      likes: parseLikes(likesLabel),
      likesLabel,
      // всё это приходит в том же ответе YouTube — бесплатно
      replies: parseLikes(entity.toolbar?.replyCount),
      isCreator: Boolean(entity.author?.isCreator),
      hearted: state?.heartState === "TOOLBAR_HEART_STATE_HEARTED",
      link: p.commentId ? `https://www.youtube.com/watch?v=${videoId}&lc=${p.commentId}` : null,
    };
  }

  async function innerTubePost(payload, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const cfg = innerTubeConfig();
    let resp;
    try {
      resp = await fetch(`https://www.youtube.com/youtubei/v1/next?key=${cfg.key}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-YouTube-Client-Name": "1",
          "X-YouTube-Client-Version": cfg.version,
        },
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify(payload),
      });
    } catch (e) {
      if (e?.name === "AbortError") throw new Error("innerTubeTimeout");
      throw new Error("innerTubeNetwork:" + String(e?.message || e));
    } finally {
      clearTimeout(timer);
    }
    if (resp.status === 403 || resp.status === 429) {
      throw new Error("innerTubeBlocked:" + resp.status);
    }
    if (!resp.ok) throw new Error("innerTube:" + resp.status);
    return resp.json();
  }

  // Токен сортировки «Новые» из меню заголовка панели комментариев
  // (проверено на живом YouTube: engagementPanelTitleHeaderRenderer.menu.
  // sortFilterSubMenuRenderer.subMenuItems[1] — «Новые», [0] — «Сначала популярные»).
  function newestSortToken(data) {
    for (const panel of data.engagementPanels || []) {
      const items =
        panel?.engagementPanelSectionListRenderer?.header?.engagementPanelTitleHeaderRenderer?.menu
          ?.sortFilterSubMenuRenderer?.subMenuItems;
      const tok = Array.isArray(items) ? items[1]?.serviceEndpoint?.continuationCommand?.token : null;
      if (tok) return tok;
    }
    return null;
  }

  async function collectViaInnerTube(videoId, limit, onBatch, mine, order = "top") {
    const out = [];
    const seen = new Set();

    // Шаг 1: получить токен секции комментариев с watch-страницы
    let token = null;
    {
      if (collector !== mine || collector?.cancelled) throw new Error("cancelled");
      const page = await innerTubePost({ context: baseContext(), videoId });
      // «Сначала новые» — стартуем с токена сортировки; если его нет — как обычно
      token = (order === "new" && newestSortToken(page)) || commentSectionToken(page);
    }
    if (!token) throw new Error("innerTubeNoCommentsSection");

    // Шаг 2+: листать комментарии по continuation
    let emptyPages = 0;
    while (out.length < limit && token) {
      if (collector !== mine || collector?.cancelled) throw new Error("cancelled");
      const data = await innerTubePost({ context: baseContext(), continuation: token });
      const entities = buildEntityMap(data);
      const before = out.length;

      for (const node of findThreadNodes(data)) {
        if (out.length >= limit) break;
        const ctr = node.commentThreadRenderer;
        const commentKey = ctr?.commentViewModel?.commentViewModel?.commentKey;
        const entity = commentKey ? entities.get(commentKey) || entities.get(decodeBase64Url(commentKey)) : null;

        let parsed = null;
        if (entity) {
          parsed = parseThreadV2(entity, videoId, entities);
        } else if (ctr?.commentRenderer) {
          parsed = parseThread({ commentRenderer: ctr.commentRenderer }, videoId);
        }
        if (!parsed || !parsed.text.trim() || seen.has(parsed.id)) continue;
        // Токен ветки ответов: панель подгрузит их по клику «Ответы (N)».
        const replyToken = (ctr?.replies?.commentRepliesRenderer?.contents || []).find(
          (x) => x?.continuationItemRenderer
        )?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
        if (replyToken) parsed.replyToken = replyToken;
        seen.add(parsed.id);
        out.push(parsed);
      }

      token = findNextToken(data);
      if (out.length === before) {
        emptyPages++;
        // YouTube перестал отдавать новые комментарии (контент закончился или
        // ответ сменил схему) — не листаем дальше вхолостую.
        if (emptyPages >= 3) break;
      } else {
        emptyPages = 0;
      }
      if (!token) break;
      onBatch?.(out);
      await sleep(350);
    }
    return out;
  }

  // Порция ответов в ветке (обычно по 10) и токен следующей порции.
  // Формат проверен на живом YouTube: ответы — commentViewModel.commentKey,
  // «Другие ответы» — continuationItemRenderer.button…continuationCommand.
  async function fetchReplies(token) {
    const videoId = videoIdFromUrl();
    const data = await innerTubePost({ context: baseContext(), continuation: token });
    const entities = buildEntityMap(data);
    const replies = [];
    let next = null;
    walk(
      data,
      (o) => {
        const key = o.commentViewModel?.commentKey || o.commentViewModel?.commentViewModel?.commentKey;
        if (key) {
          const e = entities.get(key) || entities.get(decodeBase64Url(key));
          const parsed = e ? parseThreadV2(e, videoId, entities) : null;
          if (parsed) replies.push(parsed);
          return true;
        }
        const ci = o.continuationItemRenderer;
        const tok =
          ci?.button?.buttonRenderer?.command?.continuationCommand?.token ||
          ci?.continuationEndpoint?.continuationCommand?.token;
        if (tok) next = tok;
        return false;
      },
      0,
      14
    );
    return { replies, next };
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
    const likes = parseLikes(likesEl?.textContent || "0");
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

  async function collectViaDom(videoId, limit, onBatch, mine) {
    const out = [];
    // Ключ дедупликации: настоящий comment-id, а без него — автор+текст.
    // Раньше без comment-id каждому проходу доставался новый случайный id,
    // и одни и те же комментарии добавлялись снова, пока не набирался лимит.
    const seen = new Set();
    const tab = location.pathname.startsWith("/shorts");
    let stagnant = 0;
    for (let i = 0; i < 60 && out.length < limit; i++) {
      if (collector !== mine || collector?.cancelled) throw new Error("cancelled");
      const before = out.length;
      const nodes = document.querySelectorAll("ytd-comment-renderer, ytd-comment-view-model");
      for (const n of nodes) {
        if (out.length >= limit) break;
        const parsed = readDomComment(n);
        if (!parsed) continue;
        const key = parsed.link ? parsed.id : `${parsed.author}\u0000${parsed.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(parsed);
      }
      if (!tab) {
        // На обычном видео (не шортсах) — доскроллить к комментариям, чтобы
        // YouTube их подмонтировал, и кликнуть «показать ещё».
        document.querySelector("#comments")?.scrollIntoView();
        document.querySelector("ytd-button-renderer#more-replies")?.click();
        const cont = document.querySelector(
          "ytd-continuation-item-renderer ytd-button-renderer"
        );
        cont?.querySelector("tp-yt-paper-button, button")?.click();
      }
      onBatch?.(out);
      if (out.length === before) {
        stagnant++;
        // Ничего нового за несколько проходов — контент-скриптом уже всё собрано
        // или комментарии монтируются лениво; не крутим цикл впустую.
        if (stagnant >= 4) break;
      } else {
        stagnant = 0;
      }
      await sleep(800);
    }
    return out;
  }

  // ---------------- Оркестрация сбора ----------------

  async function runCollection(videoId, force) {
    if (!videoId) return;
    // Стартуем «поколение» сбора до любых await: если за время чтения хранилища
    // придёт навигация на другое видео или новый рановер без force — оба
    // увидели чужой collector и старый не должен сам себя перезапускать.
    const gen = ++collectGen;
    const stateKey = K.state(videoId);
    const { [stateKey]: prev } = await sessionGet([stateKey]);
    if (!force && prev) {
      if (prev.status === "done") return;
      // «loading», зависшее от предыдущего процесса (страница перезагружена,
      // сборщик умер, но статус остался) — перезапускаем.
      if (prev.status === "loading" && collector && collector.videoId === videoId && !collector.cancelled) {
        return;
      }
    }

    const settings = (await chrome.storage.local.get("settings")).settings || {};
    const max = Math.min(Math.max(parseInt(settings.maxComments, 10) || DEFAULT_MAX, 10), 2000);
    const mode = settings.collectMode || "auto";
    const order = settings.commentOrder === "new" ? "new" : "top";

    // Другой сбор уже запущен после нас (новая навигация/force) — отступаем.
    if (collector && collector.gen > gen) return;

    collector = { gen, videoId, cancelled: false };
    await sessionSet({ [stateKey]: { status: "loading", fetched: 0, max, error: null } });
    send({ type: "yt:progress", videoId, status: "loading", fetched: 0, max });

    let comments = [];
    const mine = collector;
    // Собранное по ходу: при сбое или отмене посреди сбора сохраняем его, а не
    // теряем (раньше 1500 из 2000 при обрыве превращались в 0). base — то, что
    // успел собрать InnerTube до перехода на сбор со страницы.
    let base = [];
    let partial = [];
    let savedAt = 0;
    const merge = (a, b) => {
      const seen = new Set(a.map((c) => c.id));
      return a.concat(b.filter((c) => !seen.has(c.id)));
    };
    const onBatch = async (list) => {
      if (collector !== mine) return;
      partial = merge(base, list || []).slice(0, max);
      // сами комментарии пишем не чаще раза в 2 с — это сотни КБ
      const patch = { [stateKey]: { status: "loading", fetched: partial.length, max, error: null } };
      if (Date.now() - savedAt > 2000) {
        patch[K.comments(videoId)] = partial;
        savedAt = Date.now();
      }
      await sessionSet(patch);
      send({ type: "yt:progress", videoId, status: "loading", fetched: partial.length, max });
    };
    // сбор прерван, но что-то собрано — это «готово, частично»
    const keepPartial = async (reason) => {
      const list = partial.slice(0, max);
      await sessionSet({
        [stateKey]: { status: "done", fetched: list.length, max, error: null, stopped: reason },
        [K.comments(videoId)]: list,
      });
      send({ type: "yt:progress", videoId, status: "done", fetched: list.length, max, stopped: reason });
      send({ type: "yt:ready", videoId, count: list.length });
    };

    try {
      if (mode === "innerTube" || mode === "auto") {
        try {
          comments = await collectViaInnerTube(videoId, max, onBatch, mine, order);
          if (mode === "auto" && !comments.length) {
            // InnerTube технически ответил, но комментарии не разобрались —
            // добираем из DOM, пока не набрали лимит.
            const rest = max - comments.length;
            if (rest > 0) {
              comments = comments.concat(await collectViaDom(videoId, rest, onBatch, mine));
            }
          }
        } catch (e) {
          const em = String(e.message);
          const fallback =
            mode === "auto" &&
            (em.startsWith("innerTubeBlocked") ||
              em.startsWith("innerTubeNoCommentsSection") ||
              em.startsWith("innerTubeTimeout"));
          if (fallback) {
            // начатое InnerTube не выбрасываем — добираем со страницы до лимита
            base = partial.slice();
            const rest = max - base.length;
            comments = rest > 0 ? merge(base, await collectViaDom(videoId, rest, onBatch, mine)) : base;
          } else {
            throw e;
          }
        }
      } else {
        comments = await collectViaDom(videoId, max, onBatch, mine);
      }
      comments = comments.slice(0, max);
      await sessionSet({
        [stateKey]: { status: "done", fetched: comments.length, max, error: null },
        [K.comments(videoId)]: comments,
      });
      // max — лимит, с которым собирали (панель сравнивает его с текущим лимитом)
      send({ type: "yt:progress", videoId, status: "done", fetched: comments.length, max });
      send({ type: "yt:ready", videoId, count: comments.length });
    } catch (e) {
      const msg = String(e.message || e);
      if (msg === "cancelled") {
        // Нас вытеснил новый сбор (перезапуск/другое видео) — он сам ведёт статус.
        // Раньше здесь писалось «idle» поверх его «loading» и рассылалась ложная ошибка.
        if (collector !== mine) return;
        if (partial.length) return keepPartial("cancelled");
        await sessionSet({ [stateKey]: { status: "idle", fetched: 0, max, error: null } });
        send({ type: "yt:progress", videoId, status: "idle", fetched: 0, max });
        return;
      }
      if (partial.length && collector === mine) return keepPartial("error");
      await sessionSet({ [stateKey]: { status: "error", fetched: comments.length, max, error: msg } });
      send({ type: "yt:progress", videoId, status: "error", fetched: comments.length, max, error: msg });
    }
  }

  async function handlePage({ forceCollect = false } = {}) {
    if (!alive()) return;
    const id = videoIdFromUrl();
    if (!id) {
      currentVideoId = null;
      // ушли с видео — сбор (скролл и клики по странице) останавливаем
      collectGen++;
      if (collector && !collector.cancelled) collector.cancelled = true;
      send({ type: "yt:away" });
      return;
    }
    if (id === currentVideoId && !forceCollect) return;
    // Ушли на другое видео — гасим активный сбор предыдущего, иначе его цикл
    // продолжит крутиться в фоне и дёргать DOM (клики/скролл в шортсах).
    collectGen++;
    if (collector && collector.videoId !== id && !collector.cancelled) {
      collector.cancelled = true;
    }
    currentVideoId = id;
    void touchVideoOrder(id);

    // светимся на новом видео
    const meta = extractMeta();
    await storeMeta(meta);
    // Сразу после загрузки/перехода YouTube ещё не дорисовал шапку: название и
    // канал бывают пустыми (проверено на живой странице). Дочитываем позже.
    // Перечитываем всегда: даже «полные» данные сразу после перехода бывают
    // от прошлого видео (длительность у <video> ещё старая).
    {
      for (const delay of [1500, 4000]) {
        setTimeout(() => {
          if (currentVideoId !== id) return;
          const again = extractMeta();
          if (again && (again.channelName !== meta?.channelName || again.title !== meta?.title || again.duration !== meta?.duration)) {
            void storeMeta(again);
          }
        }, delay);
      }
    }
    const { [K.state(id)]: st } = await sessionGet([K.state(id)]);
    if (st?.status === "done") {
      send({ type: "yt:progress", videoId: id, status: "done", fetched: st.fetched, max: st.max });
      void touchVideoOrder(id);
    } else {
      void runCollection(id, forceCollect);
    }
  }

  // ---------------- Плеер: без автозапуска и без полосы прогресса ----------------
  // Замена устаревшим AutoplayStopper и ToggleVideoProgressBars. Оба режима
  // включаются в настройках панели и применяются сразу, без перезагрузки.
  const playerPrefs = { noAutoplay: false, hideProgress: false, sponsorSkip: true };

  // Стиль скрытия полосы ставит early.js (document_start) — до отрисовки плеера.
  const applyHideProgress = () => globalThis.__ytcs?.applyHideProgress?.();

  function readPlayerPrefs(settings, { announce = false } = {}) {
    const before = { ...playerPrefs };
    playerPrefs.noAutoplay = Boolean(settings?.noAutoplay);
    playerPrefs.hideProgress = Boolean(settings?.hideProgress);
    playerPrefs.sponsorSkip = settings?.sponsorSkip !== false; // пропуск вставок — sponsor.js, по умолчанию вкл.
    applyHideProgress();
    syncMenuToggles(); // меню в плеере следует за настройками из панели
    // Переключили из панели, системного меню или горячей клавишей — короткая
    // плашка на странице подтверждает, что сработало (в открытом меню плеера
    // и так виден переключатель — там не дублируем).
    if (announce && !uiMenu?.classList.contains("open")) {
      if (before.noAutoplay !== playerPrefs.noAutoplay) {
        showPageToast(playerPrefs.noAutoplay ? "Видео не будут запускаться сами" : "Автозапуск видео — как обычно", UI_ICONS.pause);
      } else if (before.hideProgress !== playerPrefs.hideProgress) {
        showPageToast(playerPrefs.hideProgress ? "Полоса прогресса скрыта" : "Полоса прогресса видна", UI_ICONS.bar);
      } else if (before.sponsorSkip !== playerPrefs.sponsorSkip) {
        showPageToast(playerPrefs.sponsorSkip ? "Рекламные вставки будут пропускаться" : "Рекламные вставки — как обычно", UI_ICONS.skip);
      }
    }
  }

  chrome.storage.local
    .get("settings")
    .then((o) => {
      readPlayerPrefs(o.settings);
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) readPlayerPrefs(changes.settings.newValue, { announce: true });
  });

  // Блокировка автозапуска — в early.js: он грузится раньше плеера и успевает
  // остановить видео до первого кадра.
  const isWatchPage = () => location.pathname === "/watch" || OUR_EMBED;

  // ---------------- Кнопка и меню в плеере YouTube ----------------
  // Своё меню в стиле плеера (системное контекстное меню Chrome не
  // стилизуется). Кнопка встаёт рядом с шестерёнкой настроек и наследует
  // классы плеера — размеры и поведение как у родных кнопок.
  const UI_CSS = `
    .ytcs-btn svg { width: 24px; height: 24px; display: block; margin: auto; }
    .ytcs-btn { opacity: .92; }
    .ytcs-btn:hover { opacity: 1; }
    .ytcs-menu {
      position: absolute; right: 12px; bottom: 64px; z-index: 75;
      width: 300px; max-width: calc(100% - 24px); padding: 8px 0;
      background: rgba(28, 28, 30, .86);
      -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6);
      border-radius: 14px; box-shadow: 0 12px 40px rgba(0, 0, 0, .45), inset 0 0 0 1px rgba(255, 255, 255, .06);
      color: #f1f1f1; font: 500 14px/1.3 "YouTube Noto", Roboto, Arial, sans-serif;
      opacity: 0; transform: translateY(6px) scale(.97); transform-origin: 100% 100%;
      pointer-events: none; visibility: hidden;
      transition: opacity .16s ease, transform .22s cubic-bezier(.22, 1, .36, 1), visibility 0s linear .22s;
    }
    /* закрытое меню невидимо и для клавиатуры (visibility) — после анимации исчезновения */
    .ytcs-menu.open { opacity: 1; transform: none; pointer-events: auto; visibility: visible; transition-delay: 0s; }
    .ytcs-head { display: flex; align-items: center; gap: 8px; padding: 6px 16px 10px; font-size: 12px; font-weight: 600;
      letter-spacing: .02em; color: rgba(255, 255, 255, .6); }
    .ytcs-head svg { width: 16px; height: 16px; color: #ff4e6a; }
    .ytcs-item { display: flex; align-items: center; gap: 14px; width: 100%; min-height: 40px; padding: 0 16px;
      background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer;
      transition: background-color .12s ease; }
    .ytcs-item:hover, .ytcs-item:focus-visible { background: rgba(255, 255, 255, .1); outline: none; }
    .ytcs-item:active { background: rgba(255, 255, 255, .16); }
    .ytcs-item > svg { flex: none; width: 20px; height: 20px; opacity: .9; }
    .ytcs-item .ytcs-label { flex: 1; min-width: 0; position: relative; top: -.075em; } /* оптическая центровка */
    .ytcs-sep { height: 1px; margin: 6px 0; background: rgba(255, 255, 255, .1); }
    .ytcs-switch { position: relative; flex: none; width: 34px; height: 20px; border-radius: 999px;
      background: rgba(255, 255, 255, .25); transition: background-color .2s ease; }
    .ytcs-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
      background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .35); transition: transform .22s cubic-bezier(.22, 1, .36, 1); }
    .ytcs-item[aria-checked="true"] .ytcs-switch { background: #ff3b5c; }
    .ytcs-item[aria-checked="true"] .ytcs-switch::after { transform: translateX(14px); }
    .ytcs-note { padding: 4px 16px 6px; font-size: 12px; font-weight: 400; color: rgba(255, 255, 255, .55); min-height: 0; }
    .ytcs-note:empty { display: none; }
    .ytcs-toast { position: absolute; top: 16px; left: 50%; z-index: 80; display: flex; align-items: center; gap: 10px;
      padding: 10px 18px 11px 14px; border-radius: 999px; background: rgba(28, 28, 30, .86);
      -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6);
      box-shadow: 0 8px 30px rgba(0, 0, 0, .4), inset 0 0 0 1px rgba(255, 255, 255, .06);
      color: #f1f1f1; font: 500 14px/1.3 "YouTube Noto", Roboto, Arial, sans-serif; white-space: nowrap;
      opacity: 0; transform: translate(-50%, -8px) scale(.97); pointer-events: none;
      transition: opacity .18s ease, transform .26s cubic-bezier(.22, 1, .36, 1); }
    .ytcs-toast.page { position: fixed; top: 72px; z-index: 9999; }
    .ytcs-toast.show { opacity: 1; transform: translate(-50%, 0) scale(1); }
    .ytcs-toast svg { width: 18px; height: 18px; flex: none; color: #ff6b85; }
    @media (prefers-reduced-motion: reduce) { .ytcs-menu, .ytcs-switch, .ytcs-switch::after, .ytcs-toast { transition: none; } }`;

  const SVG = (paths) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const UI_ICONS = {
    // знак расширения: облачко-комментарий с «play» — сплошная заливка, как у
    // остальных кнопок плеера YouTube
    brand: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M7 4.5h10a4 4 0 0 1 4 4V13a4 4 0 0 1-4 4h-5.6l-4.3 3.2a.6.6 0 0 1-.96-.48V17H7a4 4 0 0 1-4-4V8.5a4 4 0 0 1 4-4Zm3.4 3.9v5.2c0 .4.43.64.77.43l4.15-2.6a.5.5 0 0 0 0-.86l-4.15-2.6a.5.5 0 0 0-.77.43Z"/></svg>`,
    panel: SVG('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="M17.5 8.5h1M17.5 11.5h1"/>'),
    eye: SVG('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    download: SVG('<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>'),
    pause: SVG('<rect x="5" y="4" width="4.5" height="16" rx="1.2"/><rect x="14.5" y="4" width="4.5" height="16" rx="1.2"/>'),
    bar: SVG('<path d="M3 12h18"/><path d="M3 7h2M3 17h2M19 7h2M19 17h2" opacity=".5"/><path d="M4 4l16 16"/>'),
    // закладка с плюсом — «Сохранить в плейлисты»
    save: SVG('<path d="M6 4h12v16l-6-4-6 4z"/><path d="M12 8v5"/><path d="M9.5 10.5h5"/>'),
    // часы со стрелкой вниз — «Отложить в очередь»
    defer: SVG('<path d="M20 12a8 8 0 1 1-8-8"/><path d="M12 8v4l2.5 1.5"/><path d="M19 4v5h-5"/>'),
    // стопка плейлистов — «Моя библиотека»
    library: SVG('<rect x="3" y="8" width="14" height="12" rx="2"/><path d="M7 4.5h11a2.5 2.5 0 0 1 2.5 2.5v9"/><path d="M8.5 11.5v5l4-2.5z"/>'),
    // «перескок» через вставку — «Пропускать рекламные вставки»
    skip: SVG('<path d="M3 19h3M18 19h3"/><path d="M8.5 19h7" stroke-dasharray="1 2.5" opacity=".6"/><path d="M4.5 15.5c1.8-6.5 13.2-6.5 15 0"/><path d="M19.5 11.5v4h-4"/>'),
    // ножницы — «Вырезать клип»
    clip: SVG('<circle cx="6" cy="7" r="2.6"/><circle cx="6" cy="17" r="2.6"/><path d="M8.2 8.4L20 17"/><path d="M8.2 15.6L20 7"/>'),
  };

  let uiMenu = null;

  function ensureUiStyle() {
    if (document.getElementById("ytcs-ui")) return;
    const st = document.createElement("style");
    st.id = "ytcs-ui";
    st.textContent = UI_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function buildMenu(player) {
    const m = document.createElement("div");
    m.className = "ytcs-menu";
    m.setAttribute("role", "menu");
    m.innerHTML = `
      <div class="ytcs-head">${UI_ICONS.brand}Сводка комментариев</div>
      <button class="ytcs-item" role="menuitem" data-act="panel">${UI_ICONS.panel}<span class="ytcs-label">Открыть сводку и комментарии</span></button>
      <button class="ytcs-item" role="menuitem" data-act="playlists">${UI_ICONS.save}<span class="ytcs-label">Сохранить в плейлисты</span></button>
      <button class="ytcs-item" role="menuitem" data-act="defer">${UI_ICONS.defer}<span class="ytcs-label">Отложить в очередь</span></button>
      <button class="ytcs-item" role="menuitem" data-act="library">${UI_ICONS.library}<span class="ytcs-label">Моя библиотека</span></button>
      <button class="ytcs-item" role="menuitem" data-act="clip">${UI_ICONS.clip}<span class="ytcs-label">Вырезать клип</span></button>
      <button class="ytcs-item" role="menuitem" data-act="preview">${UI_ICONS.eye}<span class="ytcs-label">Превью видео</span></button>
      <button class="ytcs-item" role="menuitem" data-act="download">${UI_ICONS.download}<span class="ytcs-label">Скачать превью</span></button>
      <div class="ytcs-sep"></div>
      <button class="ytcs-item" role="menuitemcheckbox" data-toggle="noAutoplay">${UI_ICONS.pause}<span class="ytcs-label">Не запускать видео само</span><span class="ytcs-switch"></span></button>
      <button class="ytcs-item" role="menuitemcheckbox" data-toggle="hideProgress">${UI_ICONS.bar}<span class="ytcs-label">Скрыть полосу прогресса</span><span class="ytcs-switch"></span></button>
      <button class="ytcs-item" role="menuitemcheckbox" data-toggle="sponsorSkip">${UI_ICONS.skip}<span class="ytcs-label">Пропускать рекламные вставки</span><span class="ytcs-switch"></span></button>
      <div class="ytcs-note" aria-live="polite"></div>`;
    // клики внутри меню не должны ставить видео на паузу/воспроизведение
    for (const t of ["click", "mousedown", "pointerdown", "dblclick"]) m.addEventListener(t, (e) => e.stopPropagation());
    m.addEventListener("click", onMenuClick);
    player.appendChild(m);
    // во встроенном плеере библиотеки: «отложить» закрыло бы саму библиотеку,
    // а окна плейлистов и клипа там пока не работают
    if (OUR_EMBED) for (const act of ["defer", "library", "playlists", "clip"]) m.querySelector(`[data-act="${act}"]`)?.remove();
    return m;
  }

  function syncMenuToggles() {
    if (!uiMenu) return;
    uiMenu.querySelectorAll("[data-toggle]").forEach((b) => {
      b.setAttribute("aria-checked", String(Boolean(playerPrefs[b.dataset.toggle])));
    });
  }

  function setNote(text) {
    const n = uiMenu?.querySelector(".ytcs-note");
    if (n) n.textContent = text || "";
  }

  function openMenu(open) {
    if (!uiMenu) return;
    syncMenuToggles();
    setNote("");
    // закрываем, а фокус был внутри меню — возвращаем его на нашу кнопку,
    // иначе следующий Enter сработал бы на невидимом пункте
    if (!open && uiMenu.contains(document.activeElement)) {
      document.querySelector("#movie_player .ytcs-btn")?.focus({ preventScroll: true });
    }
    uiMenu.classList.toggle("open", open);
    document.querySelector(".ytcs-btn")?.setAttribute("aria-expanded", String(open));
    if (open) uiMenu.querySelector(".ytcs-item")?.focus({ preventScroll: true });
  }

  async function onMenuClick(e) {
    const item = e.target.closest(".ytcs-item");
    if (!item) return;
    if (!alive()) return setNote("Расширение обновилось — обновите страницу (F5).");
    const key = item.dataset.toggle;
    if (key) {
      const s = (await chrome.storage.local.get("settings")).settings || {};
      s[key] = !playerPrefs[key];
      playerPrefs[key] = s[key];
      syncMenuToggles();
      await chrome.storage.local.set({ settings: s }); // панель и системное меню подхватят
      return;
    }
    const act = item.dataset.act;
    // отложить — в очередь с местом, где остановились, и закрыть вкладку
    if (act === "defer") {
      openMenu(false);
      if (!globalThis.__ytcsQueue?.defer) setNote("Обновите страницу видео (F5).");
      else void globalThis.__ytcsQueue.defer();
      return;
    }
    // библиотека — отдельная вкладка расширения
    if (act === "library") {
      openMenu(false);
      if (!alive()) return setNote("Обновите страницу видео (F5).");
      chrome.storage.local
        .get("libraryWhere")
        .then(({ libraryWhere }) => chrome.runtime.sendMessage({ type: "lib:open", where: libraryWhere === "panel" ? "panel" : "tab" }))
        .catch(() => setNote("Обновите страницу видео (F5)."));
      return;
    }
    // плейлисты — окно рисует playlists.js здесь же, на странице
    if (act === "playlists") {
      openMenu(false);
      if (!globalThis.__ytcsPlaylists?.open) setNote("Обновите страницу видео (F5).");
      else void globalThis.__ytcsPlaylists.open();
      return;
    }
    // клип — окно рисует clip.js здесь же, на странице
    if (act === "clip") {
      openMenu(false);
      if (!globalThis.__ytcsClip?.open) setNote("Обновите страницу видео (F5).");
      else void globalThis.__ytcsClip.open();
      return;
    }
    let r = null;
    try {
      r = await chrome.runtime.sendMessage({ type: "ui:action", action: act });
    } catch (err) {
      r = { ok: false };
    }
    if (act === "panel" && !r?.ok) {
      setNote("Откройте панель кнопкой расширения на панели Chrome.");
      return;
    }
    if (act === "download") setNote(r?.ok ? "Превью сохранено в загрузки." : "Не получилось скачать превью.");
    else openMenu(false);
  }

  // Плашка-подтверждение в стиле плеера: в плеере — сверху по центру,
  // вне просмотра — вверху страницы.
  let toastTimer = null;
  function showPageToast(text, iconSvg = "") {
    ensureUiStyle();
    let t = document.getElementById("ytcs-toast");
    const host = (isWatchPage() && document.querySelector("#movie_player")) || document.body;
    if (!t) {
      t = document.createElement("div");
      t.id = "ytcs-toast";
      t.setAttribute("role", "status");
    }
    if (t.parentElement !== host) host.appendChild(t);
    t.className = "ytcs-toast" + (host === document.body ? " page" : "");
    t.innerHTML = `${iconSvg}<span></span>`;
    t.querySelector("span").textContent = text;
    void t.offsetHeight; // перезапуск появления
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }

  // ---------------- Превью поверх страницы ----------------
  // Вместо отдельной вкладки — просмотр прямо на YouTube: затемнение,
  // картинка, выбор качества, «Скачать» и «Копировать». Своя тень (shadow DOM),
  // чтобы стили YouTube не влияли на окно и наоборот.
  const PV_URL_RE = /^https:\/\/i\.ytimg\.com\/vi\/[A-Za-z0-9_-]{11}\/\w+\.jpg$/;
  const PV_LABELS = { maxresdefault: "Макс.", sddefault: "SD", hqdefault: "HQ" };
  const PV_CSS = `
    :host { all: initial; }
    .wrap { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center;
      font: 500 14px/1.35 Roboto, "YouTube Sans", "Segoe UI", system-ui, sans-serif; color: #f1f1f1; }
    .bg { position: absolute; inset: 0; background: rgba(8, 8, 10, .72);
      -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
      opacity: 0; transition: opacity .2s ease-out; }
    .dlg { position: relative; display: flex; flex-direction: column; gap: 12px;
      max-width: min(94vw, 1320px); max-height: 94vh;
      opacity: 0; transform: scale(.96); transition: opacity .18s ease-out, transform .26s cubic-bezier(.23, 1, .32, 1); }
    .wrap.open .bg { opacity: 1; }
    .wrap.open .dlg { opacity: 1; transform: none; }
    .top { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
      font-size: 15px; font-weight: 600; }
    button { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center;
      justify-content: center; gap: 6px; height: 36px; padding: 0 14px 1px; border-radius: 10px;
      font: inherit; font-weight: 600; color: #f1f1f1; background: rgba(255, 255, 255, .1);
      transition: background-color .14s ease, transform .1s ease-out; white-space: nowrap; }
    button:hover { background: rgba(255, 255, 255, .18); }
    button:active { transform: scale(.97); }
    button:focus-visible { outline: 2px solid rgba(255, 255, 255, .7); outline-offset: 2px; }
    button svg { width: 18px; height: 18px; flex: none; }
    .x { width: 36px; padding: 0; border-radius: 50%; }
    .pri { background: #ff3b5c; color: #fff; }
    .pri:hover { background: #ff2149; }
    .stage { position: relative; display: grid; place-items: center; min-width: min(80vw, 480px); min-height: 220px; }
    img { display: block; max-width: min(94vw, 1320px); max-height: calc(94vh - 120px); width: auto; height: auto;
      border-radius: 12px; box-shadow: 0 20px 60px rgba(0, 0, 0, .55); background: #111; }
    .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .q { display: flex; gap: 4px; padding: 3px; border-radius: 12px; background: rgba(255, 255, 255, .08); }
    .q button { height: 30px; padding: 0 12px 1px; border-radius: 9px; background: none; color: #bdbdc4; font-size: 13px; }
    .q button:hover { color: #fff; background: none; }
    .q button[aria-pressed="true"] { background: rgba(255, 255, 255, .16); color: #fff; }
    .meta { flex: 1; min-width: 120px; color: #a6a6ad; font-size: 13px; font-variant-numeric: tabular-nums;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .acts { display: flex; gap: 8px; margin-left: auto; }
    .msg { position: absolute; left: 50%; bottom: 16px; padding: 9px 16px 10px; border-radius: 999px;
      background: rgba(28, 28, 30, .92); box-shadow: 0 8px 24px rgba(0, 0, 0, .4); font-size: 13px;
      transform: translate(-50%, 8px); opacity: 0; pointer-events: none;
      transition: opacity .16s ease-out, transform .22s cubic-bezier(.23, 1, .32, 1); }
    .msg.show { opacity: 1; transform: translate(-50%, 0); }
    .err { padding: 40px 24px; color: #bdbdc4; text-align: center; }
    .spin { width: 28px; height: 28px; border-radius: 50%; border: 3px solid rgba(255, 255, 255, .15);
      border-top-color: #fff; animation: spin .7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .bg, .dlg, .msg { transition: none; } }
  `;
  const PV_ICON = {
    close: SVG('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
    download: UI_ICONS.download,
    copy: SVG('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>'),
  };
  let pv = null; // { host, root, wrap, urls, title, name, current, sizes, prevFocus }

  function pvToast(text, ms = 2000) {
    if (!pv) return;
    const m = pv.root.querySelector(".msg");
    m.textContent = text;
    m.classList.add("show");
    clearTimeout(pv.msgTimer);
    pv.msgTimer = setTimeout(() => m.classList.remove("show"), ms);
  }

  function pvProbe(url) {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im.naturalWidth > 120 ? { w: im.naturalWidth, h: im.naturalHeight } : null);
      im.onerror = () => resolve(null);
      im.src = url;
    });
  }

  function pvShow(url) {
    if (!pv || !pv.sizes.has(url)) return;
    pv.current = url;
    const { w, h } = pv.sizes.get(url);
    const stage = pv.root.querySelector(".stage");
    stage.innerHTML = "";
    const img = document.createElement("img");
    img.alt = pv.title;
    img.src = url;
    stage.appendChild(img);
    pv.root.querySelector(".meta").textContent = `${w}×${h} · ${pv.name}`;
    pv.root.querySelectorAll(".q button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.url === url)));
  }

  async function pvDownload() {
    if (!pv?.current) return;
    try {
      const r = await chrome.runtime.sendMessage({ type: "ui:thumb", op: "download", url: pv.current, name: pv.name });
      pvToast(r?.ok ? "Сохранено в загрузки" : "Не получилось скачать");
    } catch (e) {
      pvToast("Не получилось скачать — обновите страницу");
    }
  }

  // Буфер обмена принимает PNG. Картинку берёт фон (у него есть доступ к
  // i.ytimg.com), а промис внутри ClipboardItem сохраняет «жест» пользователя.
  function pvCopy() {
    if (!pv?.current) return;
    const url = pv.current;
    pvToast("Копирую…", 15000); // фон качает картинку 1–3 с — сразу показываем, что идёт работа
    const png = (async () => {
      const r = await chrome.runtime.sendMessage({ type: "ui:thumb", op: "data", url });
      if (!r?.ok) throw new Error("no data");
      const im = new Image();
      im.src = r.dataUrl;
      await im.decode();
      const c = document.createElement("canvas");
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      c.getContext("2d").drawImage(im, 0, 0);
      return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("png"))), "image/png"));
    })();
    navigator.clipboard
      .write([new ClipboardItem({ "image/png": png })])
      .then(() => pvToast("Картинка скопирована"))
      .catch(() => pvToast("Не получилось скопировать"));
  }

  function closePreviewOverlay() {
    if (!pv) return;
    const cur = pv;
    pv = null;
    cur.wrap.classList.remove("open");
    cur.wrap.style.pointerEvents = "none"; // во время исчезновения клики не проходят
    window.removeEventListener("keydown", pvKeys, true);
    setTimeout(() => cur.host.remove(), 220);
    // фокус — туда, откуда открыли; если это пункт уже закрытого меню — на плеер
    const back =
      cur.prevFocus?.isConnected && !cur.prevFocus.closest?.(".ytcs-menu") ? cur.prevFocus : document.querySelector("#movie_player");
    back?.focus?.({ preventScroll: true });
  }

  // Tab не выпускает фокус из окна (иначе буквы D/C срабатывали бы при вводе
  // в поиске YouTube).
  function pvTrapTab(e) {
    const items = [...pv.root.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
    if (!items.length) return;
    const i = items.indexOf(pv.root.activeElement);
    const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i < 0 || i === items.length - 1 ? 0 : i + 1;
    e.preventDefault();
    items[next].focus();
  }

  // Пока окно открыто, клавиши YouTube (пробел, K, F, стрелки…) не срабатывают,
  // а страница под окном не прокручивается.
  const PV_BLOCK = new Set([" ", "spacebar", "pageup", "pagedown", "arrowup", "arrowdown", "home", "end", "escape"]);
  function pvKeys(e) {
    if (!pv) return;
    const k = String(e.key || "").toLowerCase();
    e.stopImmediatePropagation();
    if (k === "tab") return pvTrapTab(e);
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (PV_BLOCK.has(k)) e.preventDefault();
    if (e.repeat) return; // зажатая D не качает файл десятки раз
    if (k === "escape") {
      e.preventDefault();
      closePreviewOverlay();
    } else if (k === "d" || k === "в") pvDownload();
    else if (k === "c" || k === "с") pvCopy();
    else if (k === "arrowleft" || k === "arrowright") {
      const list = pv.urls.filter((u) => pv.sizes.has(u));
      const i = list.indexOf(pv.current) + (k === "arrowright" ? 1 : -1);
      if (list[i]) pvShow(list[i]);
    }
  }

  async function openPreviewOverlay({ urls, title, name }) {
    urls = (Array.isArray(urls) ? urls : []).filter((u) => PV_URL_RE.test(u));
    if (!urls.length) return false;
    closePreviewOverlay();
    const host = document.createElement("div");
    host.id = "ytcs-preview";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${PV_CSS}</style>
      <div class="wrap">
        <div class="bg"></div>
        <div class="dlg" role="dialog" aria-modal="true" aria-label="Превью видео">
          <div class="top"><div class="title"></div><button class="x" aria-label="Закрыть (Esc)" title="Закрыть (Esc)">${PV_ICON.close}</button></div>
          <div class="stage"><div class="spin"></div></div>
          <div class="bar">
            <div class="q" role="group" aria-label="Качество"></div>
            <div class="meta"></div>
            <div class="acts">
              <button data-a="copy" title="Копировать картинку (C)">${PV_ICON.copy}Копировать</button>
              <button data-a="download" class="pri" title="Скачать (D)">${PV_ICON.download}Скачать</button>
            </div>
          </div>
          <div class="msg" role="status"></div>
        </div>
      </div>`;
    // в полноэкранном режиме виден только полноэкранный элемент — окно внутрь него
    (document.fullscreenElement || document.documentElement).appendChild(host);
    const wrap = root.querySelector(".wrap");
    pv = { host, root, wrap, urls, title: String(title || ""), name: String(name || "thumbnail.jpg"), current: null, sizes: new Map(), prevFocus: document.activeElement };
    const mine = pv;
    root.querySelector(".title").textContent = pv.title;
    root.querySelector(".bg").addEventListener("click", closePreviewOverlay);
    root.querySelector(".x").addEventListener("click", closePreviewOverlay);
    root.querySelector('[data-a="download"]').addEventListener("click", pvDownload);
    root.querySelector('[data-a="copy"]').addEventListener("click", pvCopy);
    root.querySelector(".q").addEventListener("click", (e) => {
      const b = e.target.closest("[data-url]");
      if (b) pvShow(b.dataset.url);
    });
    wrap.addEventListener("wheel", (e) => e.preventDefault(), { passive: false }); // страница под окном не крутится
    window.addEventListener("keydown", pvKeys, true);
    void wrap.offsetWidth;
    wrap.classList.add("open");
    root.querySelector(".x").focus({ preventScroll: true });

    const results = await Promise.all(urls.map(pvProbe));
    if (pv !== mine) return true;
    results.forEach((r, i) => r && pv.sizes.set(urls[i], r));
    const q = root.querySelector(".q");
    q.innerHTML = urls
      .filter((u) => pv.sizes.has(u))
      .map((u) => {
        const { w, h } = pv.sizes.get(u);
        const label = PV_LABELS[(u.match(/\/(\w+)\.jpg$/) || [])[1]] || "—";
        return `<button data-url="${u}" aria-pressed="false" title="${w}×${h}">${label}</button>`;
      })
      .join("");
    const best = urls.find((u) => pv.sizes.has(u));
    if (best) pvShow(best);
    else root.querySelector(".stage").innerHTML = `<div class="err">Превью этого видео недоступно.</div>`;
    return true;
  }

  // уход на другое видео или выход из полноэкранного режима — окно закрываем
  window.addEventListener("yt-navigate-start", closePreviewOverlay);
  document.addEventListener("fullscreenchange", () => {
    if (pv && !pv.host.isConnected) pv = null;
    else if (pv && pv.host.parentElement !== (document.fullscreenElement || document.documentElement)) closePreviewOverlay();
  });

  function ensurePlayerButton() {
    if (!alive() || !isWatchPage()) return;
    const settingsBtn = document.querySelector("#movie_player .ytp-settings-button");
    const player = document.querySelector("#movie_player");
    if (!settingsBtn || !player) return;
    ensureUiStyle();
    if (!uiMenu || !player.contains(uiMenu)) uiMenu = buildMenu(player);
    if (document.querySelector("#movie_player .ytcs-btn")) return;
    const b = document.createElement("button");
    b.className = "ytp-button ytcs-btn";
    b.setAttribute("aria-label", "Сводка комментариев");
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
    b.title = "Сводка комментариев";
    b.innerHTML = UI_ICONS.brand;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      openMenu(!uiMenu.classList.contains("open"));
    });
    settingsBtn.parentElement.insertBefore(b, settingsBtn);
  }

  // закрытие по клику мимо и по Esc
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (uiMenu?.classList.contains("open") && !e.target.closest?.(".ytcs-menu, .ytcs-btn")) openMenu(false);
    },
    true
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && uiMenu?.classList.contains("open")) openMenu(false);
  });

  // Плеер YouTube перерисовывает панель управления — периодически проверяем,
  // что кнопка на месте (дёшево: один querySelector раз в 1.5 с).
  setInterval(ensurePlayerButton, 1500);

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
      case "yt:preview":
        sendResponse({ ok: true });
        void openPreviewOverlay(msg);
        return;
      case "yt:clip": {
        // из панели приходит отрезок вокруг момента — только для того же видео
        const other = msg.videoId && msg.videoId !== videoIdFromUrl();
        sendResponse({ ok: Boolean(globalThis.__ytcsClip) && isWatchPage() && !other });
        if (!isWatchPage()) showPageToast("Откройте видео, чтобы вырезать из него клип", UI_ICONS.clip);
        else if (!other) void globalThis.__ytcsClip?.open(Number.isFinite(msg.start) ? { start: msg.start, end: msg.end } : null);
        return;
      }
      case "yt:defer": {
        const ok = Boolean(globalThis.__ytcsQueue?.defer);
        sendResponse({ ok });
        if (ok) void globalThis.__ytcsQueue.defer();
        return;
      }
      case "yt:playlists": {
        // своё видео страницы или ролик, по превью которого щёлкнули правой кнопкой
        const ok = Boolean(globalThis.__ytcsPlaylists);
        sendResponse({ ok });
        if (ok) {
          void globalThis.__ytcsPlaylists.open({ videoId: msg.videoId || null, title: msg.title || "" }).then((opened) => {
            if (!opened) showPageToast("Откройте видео или щёлкните правой кнопкой по превью ролика", UI_ICONS.save);
          });
        }
        return;
      }
      case "yt:toast":
        showPageToast(String(msg.text || ""));
        sendResponse({ ok: true });
        return;
      case "yt:start-collect":
        currentVideoId = videoIdFromUrl();
        void runCollection(currentVideoId, true);
        sendResponse({ ok: true });
        return false;
      case "yt:cancel-collect":
        if (collector) collector.cancelled = true;
        sendResponse({ ok: true });
        return false;
      case "yt:replies": {
        if (!msg.token) {
          sendResponse({ ok: false, error: "no token" });
          return false;
        }
        fetchReplies(msg.token)
          .then((r) => sendResponse({ ok: true, ...r }))
          .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
        return true; // ответ асинхронный
      }
      case "yt:seek": {
        // Перемотка по таймкоду из комментария. DOM общий с страницей, так что
        // изолированный мир контент-скрипта может управлять <video> напрямую.
        const t = Number(msg.t);
        const video = document.querySelector("video.html5-main-video, #movie_player video, video");
        if (!video || !Number.isFinite(t) || msg.videoId !== videoIdFromUrl()) {
          sendResponse({ ok: false });
          return false;
        }
        video.currentTime = Math.max(0, t);
        // клик по таймкоду в панели — это действие пользователя: блокировщик
        // автозапуска не должен тут же ставить видео на паузу
        globalThis.__ytcs?.allowPlay?.();
        video.play?.().catch(() => {});
        window.scrollTo({ top: 0, behavior: "smooth" });
        sendResponse({ ok: true });
        return false;
      }
      case "yt:rerun-meta": {
        const id = videoIdFromUrl();
        if (!id) break;
        const meta = extractMeta();
        void storeMeta(meta);
        sendResponse({ ok: true, meta });
        return false;
      }
      default:
        break;
    }
    return undefined;
  });

  // SPA-навигация YouTube
  window.addEventListener("yt-navigate-finish", () => handlePage());
  window.addEventListener("popstate", () => handlePage());
  // Shorts и часть переходов YouTube меняют адрес без yt-navigate-finish —
  // дешёвая проверка адреса раз в 700 мс ловит и их (handlePage сам
  // игнорирует повтор того же видео).
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    void handlePage();
  }, 700);
  // Подменять history.pushState здесь бесполезно: контент-скрипт живёт в
  // изолированном мире, и вызовы pushState самой страницы этот код не видит.
  // Навигацию YouTube ловит yt-navigate-finish выше.

  handlePage();
})();