// Плейлисты: запросы к YouTube от вашего имени — те же внутренние команды,
// которыми пользуется сам сайт («сохранить в плейлист», «новый плейлист»).
// Скрипт живёт в мире страницы (world: MAIN): только здесь виден ytcfg с
// настройками клиента и вашего аккаунта (в том числе канала-бренда), а
// запросы уходят ровно так же, как у самого YouTube.
// Управление — событие "ytcs-pl:2" на document (JSON в detail), ответы —
// window.postMessage({ __ytcsPl: id, ok, data | error }).
// Номер в имени события — версия: после обновления расширения во вкладке
// остаётся старая копия скрипта, и она не должна отвечать на новые запросы
// (иначе, например, видео добавилось бы в плейлист дважды).
(() => {
  const EV = "ytcs-pl:2";
  if (window[`__ytcsPlMain:${EV}`]) return;
  window[`__ytcsPlMain:${EV}`] = true;

  const cfg = (k) => window.ytcfg?.get?.(k);
  const cookie = (name) => {
    const row = document.cookie.split("; ").find((c) => c.startsWith(name + "="));
    return row ? row.slice(name.length + 1) : "";
  };

  async function sha1(text) {
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Подпись запроса — как у веб-клиента YouTube: SAPISIDHASH от времени,
  // куки SAPISID и адреса сайта. Сама кука никуда не уходит, кроме YouTube.
  async function headers() {
    const sapisid = cookie("SAPISID") || cookie("__Secure-3PAPISID");
    if (!sapisid) throw Object.assign(new Error("loggedout"), { code: "loggedout" });
    const ts = Math.floor(Date.now() / 1000);
    const h = {
      "Content-Type": "application/json",
      Authorization: `SAPISIDHASH ${ts}_${await sha1(`${ts} ${sapisid} ${location.origin}`)}`,
      "X-Origin": location.origin,
      "X-Goog-AuthUser": String(cfg("SESSION_INDEX") ?? "0"),
      "X-Youtube-Client-Name": String(cfg("INNERTUBE_CONTEXT_CLIENT_NAME") ?? "1"),
      "X-Youtube-Client-Version": String(cfg("INNERTUBE_CLIENT_VERSION") || ""),
    };
    // Канал-бренд: DELEGATED_SESSION_ID, а если его нет — DATASYNC_ID вида
    // «pageId||userId». У обычного аккаунта он «userId||» (вторая часть пустая) —
    // тогда никакой страницы-бренда нет, заголовок не ставим.
    const [first, second] = String(cfg("DATASYNC_ID") || "").split("||");
    const page = cfg("DELEGATED_SESSION_ID") || (second ? first : "");
    if (page) h["X-Goog-PageId"] = String(page);
    return h;
  }

  // «Жетон свежести»: после изменения YouTube отвечает жетоном, и пока его
  // не предъявишь, список отдаётся из кеша — только что добавленное видео
  // выглядело бы «не сохранённым». Сайт делает так же.
  let jar = null;
  let jarUntil = 0;

  async function post(path, body) {
    const base = cfg("INNERTUBE_CONTEXT");
    if (!base) throw Object.assign(new Error("noconfig"), { code: "noconfig" });
    const context = { ...base };
    if (jar && Date.now() < jarUntil) context.request = { ...(base.request || {}), consistencyTokenJars: [jar] };
    const r = await fetch(`/youtubei/v1/${path}?prettyPrint=false`, {
      method: "POST",
      credentials: "include",
      headers: await headers(),
      body: JSON.stringify({ context, ...body }),
    });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error(`HTTP ${r.status}`), { code: "denied" });
      // причина словами от самого YouTube («плейлист заполнен» и т. п.)
      const why = await r.json().then((e) => String(e?.error?.message || ""), () => "");
      throw Object.assign(new Error(why || `HTTP ${r.status}`), { code: why ? "yt" : "http" });
    }
    const j = await r.json();
    const t = j?.responseContext?.consistencyTokenJar;
    if (t) {
      jar = t;
      jarUntil = Date.now() + (Number(t.expirationSeconds) || 600) * 1000;
    }
    return j;
  }

  const text = (t) => t?.simpleText ?? (t?.runs || []).map((x) => x.text).join("") ?? "";

  // Все ваши плейлисты и отметка «это видео уже там» (по каждому видео)
  async function list(videoIds) {
    const j = await post("playlist/get_add_to_playlist", { videoIds, excludeWatchLater: false });
    const rows = j?.contents?.[0]?.addToPlaylistRenderer?.playlists || [];
    return rows
      .map((r) => r.playlistAddToOptionRenderer)
      .filter((p) => p?.playlistId)
      .map((p) => ({
        id: p.playlistId,
        title: text(p.title),
        privacy: p.privacy || "PRIVATE", // PRIVATE | UNLISTED | PUBLIC
        contains: p.containsSelectedVideos === "ALL",
      }));
  }

  // Добавить / убрать видео (по одному плейлисту за запрос — так делает и сайт)
  async function edit(playlistId, videoId, add) {
    const action = add ? { action: "ACTION_ADD_VIDEO", addedVideoId: videoId } : { action: "ACTION_REMOVE_VIDEO_BY_VIDEO_ID", removedVideoId: videoId };
    const j = await post("browse/edit_playlist", { playlistId, actions: [action] });
    if (j?.status && j.status !== "STATUS_SUCCEEDED") throw Object.assign(new Error(j.status), { code: "edit" });
    return true;
  }

  // Много видео в один плейлист одним запросом: добавить add[], убрать remove[]
  // (YouTube принимает много действий в одном edit_playlist — проверено, добавление
  // и удаление). Пачки по ~50 режет вызывающий (playlists.js, library/wl.js).
  async function editMany(playlistId, add, remove) {
    const ok = (x) => /^[A-Za-z0-9_-]{11}$/.test(x);
    const actions = [
      ...(add || []).filter(ok).map((v) => ({ action: "ACTION_ADD_VIDEO", addedVideoId: v })),
      ...(remove || []).filter(ok).map((v) => ({ action: "ACTION_REMOVE_VIDEO_BY_VIDEO_ID", removedVideoId: v })),
    ].slice(0, 100);
    if (!actions.length) return 0;
    const j = await post("browse/edit_playlist", { playlistId, actions });
    if (j?.status && j.status !== "STATUS_SUCCEEDED") throw Object.assign(new Error(j.status), { code: "edit" });
    return actions.length;
  }

  // Убрать конкретные записи: по номеру записи (setVideoId — ровно эту копию)
  // или по id видео (все его копии в плейлисте). Для «Порядка в плейлистах».
  async function removeItems(playlistId, items) {
    const actions = (items || [])
      .slice(0, 100)
      .map((x) =>
        x?.setId && /^[\w-]{6,40}$/.test(x.setId)
          ? { action: "ACTION_REMOVE_VIDEO", setVideoId: x.setId }
          : /^[A-Za-z0-9_-]{11}$/.test(x?.videoId || "")
            ? { action: "ACTION_REMOVE_VIDEO_BY_VIDEO_ID", removedVideoId: x.videoId }
            : null
      )
      .filter(Boolean);
    if (!actions.length) return 0;
    const j = await post("browse/edit_playlist", { playlistId, actions });
    if (j?.status && j.status !== "STATUS_SUCCEEDED") throw Object.assign(new Error(j.status), { code: "edit" });
    return actions.length;
  }

  // Новый плейлист сразу с этим видео
  async function create(title, privacy, videoIds) {
    const j = await post("playlist/create", { title, privacyStatus: privacy || "PRIVATE", videoIds });
    if (!j?.playlistId) throw Object.assign(new Error("create failed"), { code: "create" });
    return { id: j.playlistId };
  }

  // ---------- каталог для «Моей библиотеки» ----------
  // Все плейлисты без привязки к видео. Пустой список видео YouTube отклоняет —
  // спрашиваем про любой ролик, отметка «уже там» здесь не нужна.
  async function playlists() {
    const rows = await list(["dQw4w9WgXcQ"]);
    return rows.map(({ id, title, privacy }) => ({ id, title, privacy }));
  }

  const SEC = (s) => String(s || "").split(":").reduce((a, x) => a * 60 + (Number(x) || 0), 0);

  // Видео в старом формате (playlistVideoRenderer) — «Смотреть позже» и плейлисты
  function fromRenderer(v, n) {
    const by = v.shortBylineText?.runs?.[0];
    return {
      short: Boolean(v.navigationEndpoint?.reelWatchEndpoint),
      id: v.videoId,
      title: text(v.title),
      channel: text(v.shortBylineText),
      channelId: by?.navigationEndpoint?.browseEndpoint?.browseId || "",
      len: Number(v.lengthSeconds) || SEC(text(v.lengthText)),
      info: text(v.videoInfo),
      setId: v.setVideoId || "",
      pos: Number(text(v.index)) || n,
    };
  }

  // Видео в новом формате (lockupViewModel) — так приходят «Понравившиеся»
  function fromLockup(l, n) {
    const meta = l.metadata?.lockupMetadataViewModel || {};
    const parts = (meta.metadata?.contentMetadataViewModel?.metadataRows || []).map((r) => (r.metadataParts || []).map((p) => p.text?.content || "").filter(Boolean));
    let badge = "";
    (function walk(o) {
      if (badge || !o || typeof o !== "object") return;
      if (typeof o.thumbnailBadgeViewModel?.text === "string") badge = o.thumbnailBadgeViewModel.text;
      else for (const k in o) walk(o[k]);
    })(l.contentImage);
    const s = JSON.stringify(meta);
    return {
      id: l.contentId,
      title: meta.title?.content || "",
      channel: parts[0]?.[0] || "",
      channelId: (s.match(/"browseId":"(UC[\w-]{22})"/) || [])[1] || "",
      len: /^\d+(:\d+)+$/.test(badge) ? SEC(badge) : 0,
      info: (parts[1] || []).join(" • "),
      setId: "",
      pos: n,
    };
  }

  // Shorts плиткой (shortsLockupViewModel) — плейлисты, где одни Shorts.
  // Канала и длительности в плитке нет.
  function fromShorts(s, n) {
    const id = s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId || (s.entityId || "").replace(/^shorts-shelf-item-/, "");
    return {
      id,
      title: s.overlayMetadata?.primaryText?.content || "",
      channel: "",
      channelId: "",
      len: 0,
      short: true,
      info: s.overlayMetadata?.secondaryText?.content || "",
      setId: "",
      pos: n,
    };
  }

  // Одна «страница» плейлиста (до 100 видео) и токен следующей
  async function page(playlistId, token, from = 0) {
    const j = token ? await post("browse", { continuation: token }) : await post("browse", { browseId: "VL" + playlistId });
    const items = [];
    let next = null;
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      if (o.playlistVideoRenderer?.videoId) return void items.push(fromRenderer(o.playlistVideoRenderer, from + items.length + 1));
      if (o.lockupViewModel?.contentId && /VIDEO/.test(o.lockupViewModel.contentType || "VIDEO")) return void items.push(fromLockup(o.lockupViewModel, from + items.length + 1));
      if (o.shortsLockupViewModel?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId) return void items.push(fromShorts(o.shortsLockupViewModel, from + items.length + 1));
      const cont = o.continuationItemRenderer || o.continuationItemViewModel;
      if (cont) {
        next ||= contToken(cont);
        return;
      }
      for (const k in o) walk(o[k]);
    })(j);
    return token ? { items, next } : { items, next, head: head(j) };
  }

  // «5 000 видео» → 5000 (числа без «видео» не берём: просмотры и т. п.)
  const COUNT = /^\s*([\d\s.,]+?)\s*(?:видео|videos?)\s*$/i;
  const countOf = (s) => {
    const d = (String(s || "").match(COUNT)?.[1] || "").replace(/\D/g, "");
    return d ? Number(d) : null;
  };

  // Шапка плейлиста на первой странице: сколько в нём видео и «Обновлено …».
  // Старый вид — playlistHeaderRenderer (numVideosText, byline), новый —
  // pageHeaderViewModel (metadataParts), а «Обновлено» тогда лежит в sidebar.
  function head(j) {
    let count = null;
    let updated = "";
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      const t = typeof o.content === "string" ? o.content : o.simpleText ?? (Array.isArray(o.runs) ? o.runs.map((x) => x.text || "").join("") : null);
      if (typeof t === "string") {
        if (count == null) count = countOf(t);
        if (!updated && /обновл|updated/i.test(t) && t.length < 80) updated = t;
      }
      for (const k in o) walk(o[k]);
    })({ h: j?.header, s: j?.sidebar });
    return { count, updated };
  }

  // Токен «загрузить ещё» внутри continuationItemRenderer (или нового
  // continuationItemViewModel). Он то лежит прямо в continuationEndpoint, то в
  // commandExecutorCommand.commands[], то в innertubeCommand — ищем в глубину.
  function contToken(node) {
    let token = null;
    (function walk(o) {
      if (token || !o || typeof o !== "object") return;
      if (typeof o.continuationCommand?.token === "string") {
        token = o.continuationCommand.token;
        return;
      }
      for (const k in o) walk(o[k]);
    })(node);
    return token;
  }

  // Обложки, число видео и «обновлено…» со страницы «Плейлисты» вашей библиотеки
  async function library() {
    const out = [];
    let j = await post("browse", { browseId: "FEplaylist_aggregation" });
    for (let page = 0; page < 10 && j; page++) {
      let next = null;
      (function walk(o) {
        if (!o || typeof o !== "object") return;
        if (o.lockupViewModel?.contentId) {
          const l = o.lockupViewModel;
          const s = JSON.stringify(l);
          const thumb = (s.match(/https:\/\/i\.ytimg\.com\/[^"]+?\.(?:jpg|webp)/) || [])[0] || "";
          const lines = [...s.matchAll(/"content":"([^"]{1,60})"/g)].map((m) => m[1]);
          let count = null; // «683 видео» на обложке
          (function badge(o) {
            if (count != null || !o || typeof o !== "object") return;
            if (typeof o.thumbnailBadgeViewModel?.text === "string") count = countOf(o.thumbnailBadgeViewModel.text);
            for (const k in o) badge(o[k]);
          })(l.contentImage);
          out.push({ id: l.contentId, thumb, count, updated: lines.find((x) => /обновлен|updated/i.test(x)) || "" });
          return;
        }
        const cont = o.continuationItemRenderer || o.continuationItemViewModel;
        if (cont) {
          next ||= contToken(cont);
          return;
        }
        for (const k in o) walk(o[k]);
      })(j);
      j = next ? await post("browse", { continuation: next }) : null;
    }
    return out;
  }

  // ---------- «Дайджест подписок» для «Моей библиотеки» ----------
  // Лента «Подписки» (FEsubscriptions) — только чтение, страница за страницей.
  // YouTube отдаёт видео то старым videoRenderer, то новым lockupViewModel,
  // Shorts — плитками shortsLockupViewModel / reelItemRenderer (полкой), в виде
  // «Список» — полками shelfRenderer по дням. Ищем всё это в глубину, где бы оно
  // ни лежало, и сводим к одному виду.

  // «3 часа назад», «Трансляция закончилась 2 дня назад», «5 hours ago»,
  // «Streamed 1 week ago» → сколько миллисекунд назад (null — не время)
  const UNIT = [
    [/^(?:сек|second)/, 1e3],
    [/^(?:мин|minute)/, 6e4],
    [/^(?:час|hour)/, 36e5],
    [/^(?:дн|ден|day)/, 864e5],
    [/^(?:недел|week)/, 6048e5],
    [/^(?:месяц|month)/, 2592e6],
    [/^(?:год|лет|year)/, 31536e6],
  ];
  function agoMs(s) {
    const m = String(s || "")
      .toLowerCase()
      .match(/(\d+)?\s*([a-zа-яё]+)\s+(?:назад|ago)/);
    if (!m) return null;
    const unit = UNIT.find(([re]) => re.test(m[2]));
    return unit ? (Number(m[1]) || 1) * unit[1] : null;
  }
  const isAgo = (s) => agoMs(s) != null;
  const isViews = (s) => /просмотр|зрител|смотрят|view|watching/i.test(String(s || ""));
  const isUpcoming = (s) => /премьер|запланир|начнётся|начнется|ожидается|scheduled|premieres|upcoming/i.test(String(s || ""));
  const isLive = (s) => /^(?:в эфире|live|live now|прямой эфир)$/i.test(String(s || "").trim());
  const avatarIn = (o) => (JSON.stringify(o || {}).match(/https:\/\/yt\d?\.(?:ggpht|googleusercontent)\.com\/[^"]+/) || [])[0] || "";
  const chanIn = (o) => (JSON.stringify(o || {}).match(/"browseId":"(UC[\w-]{22})"/) || [])[1] || "";

  function feedItem(base, when) {
    const ms = agoMs(base.ago);
    return { ...base, at: ms != null ? when - ms : 0 };
  }

  // старый вид: videoRenderer (сетка подписок, вид «Список», поиск)
  function feedRenderer(v, when) {
    const by = v.ownerText || v.shortBylineText || v.longBylineText;
    const overlays = v.thumbnailOverlays || [];
    const style = overlays.map((o) => o.thumbnailOverlayTimeStatusRenderer?.style || "").join(" ");
    const badges = (v.badges || []).map((b) => b.metadataBadgeRenderer?.style || "").join(" ");
    const lenText = text(v.lengthText) || overlays.map((o) => text(o.thumbnailOverlayTimeStatusRenderer?.text)).find((t) => /^\d+(:\d+)+$/.test(t)) || "";
    const up = Number(v.upcomingEventData?.startTime) || 0;
    return feedItem(
      {
        id: v.videoId,
        title: text(v.title),
        channel: text(by),
        channelId: by?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || chanIn(by),
        avatar: avatarIn(v.channelThumbnailSupportedRenderers || v.channelThumbnail),
        len: SEC(lenText),
        views: text(v.shortViewCountText) || text(v.viewCountText),
        ago: text(v.publishedTimeText),
        short: Boolean(v.navigationEndpoint?.reelWatchEndpoint) || /SHORTS/.test(style),
        live: /LIVE_NOW/.test(badges) || /\bLIVE\b/.test(style),
        upAt: up ? up * 1000 : 0,
      },
      when
    );
  }

  // новый вид: lockupViewModel. Строки подписи — [канал] и [просмотры, «когда»];
  // на странице канала строки с каналом нет — узнаём строки по смыслу, а не по месту.
  function feedLockup(l, when) {
    const meta = l.metadata?.lockupMetadataViewModel || {};
    const parts = (meta.metadata?.contentMetadataViewModel?.metadataRows || []).flatMap((r) => (r.metadataParts || []).map((p) => p.text?.content || "").filter(Boolean));
    const badges = [];
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      if (typeof o.thumbnailBadgeViewModel?.text === "string") badges.push(o.thumbnailBadgeViewModel);
      for (const k in o) walk(o[k]);
    })(l.contentImage);
    const lenB = badges.find((b) => /^\d+(:\d+)+$/.test(b.text));
    const live = badges.some((b) => /LIVE/.test(b.badgeStyle || "") || isLive(b.text));
    const up = parts.find(isUpcoming) || badges.map((b) => b.text).find(isUpcoming) || "";
    const ago = parts.find(isAgo) || "";
    const views = parts.find(isViews) || "";
    const channel = parts.find((p) => p !== ago && p !== views && p !== up) || "";
    const s = JSON.stringify(l.rendererContext || {}) + JSON.stringify(meta);
    return feedItem(
      {
        id: l.contentId,
        title: meta.title?.content || "",
        channel,
        channelId: chanIn(meta) || chanIn(l.rendererContext),
        avatar: avatarIn(meta.image),
        len: lenB ? SEC(lenB.text) : 0,
        views,
        ago,
        short: /SHORTS?\b/.test(l.contentType || "") || /reelWatchEndpoint/.test(s),
        live,
        upAt: 0,
        upText: up,
      },
      when
    );
  }

  // Shorts: плитка нового вида (shortsLockupViewModel) или старого (reelItemRenderer)
  function feedShort(o, when) {
    if (o.shortsLockupViewModel) {
      const s = fromShorts(o.shortsLockupViewModel, 0);
      return { id: s.id, title: s.title, channel: "", channelId: "", avatar: "", len: 0, views: s.info, ago: "", short: true, live: false, upAt: 0, at: 0 };
    }
    const r = o.reelItemRenderer;
    return { id: r.videoId, title: text(r.headline), channel: "", channelId: "", avatar: "", len: 0, views: text(r.viewCountText), ago: "", short: true, live: false, upAt: 0, at: 0 };
  }

  const VID = /^[A-Za-z0-9_-]{11}$/;
  const SKIP = new Set(["topbar", "header", "sidebar", "menu", "engagementPanels", "frameworkUpdates", "overlay"]);
  function feedParse(j, when = Date.now()) {
    const items = [];
    const seen = new Set();
    let next = null;
    const push = (it) => {
      if (!it || !VID.test(it.id || "") || seen.has(it.id)) return;
      seen.add(it.id);
      items.push(it);
    };
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      if (o.videoRenderer?.videoId) return void push(feedRenderer(o.videoRenderer, when));
      if (o.gridVideoRenderer?.videoId) return void push(feedRenderer(o.gridVideoRenderer, when));
      if (o.lockupViewModel?.contentId) {
        if (/VIDEO|SHORT/.test(o.lockupViewModel.contentType || "VIDEO")) push(feedLockup(o.lockupViewModel, when));
        return;
      }
      if (o.shortsLockupViewModel?.onTap || o.shortsLockupViewModel?.entityId) return void push(feedShort(o, when));
      if (o.reelItemRenderer?.videoId) return void push(feedShort(o, when));
      const cont = o.continuationItemRenderer || o.continuationItemViewModel;
      if (cont) {
        next ||= contToken(cont);
        return;
      }
      // меню, шапка и боковые панели — мимо (там бывают чужие видео)
      for (const k in o) if (!SKIP.has(k)) walk(o[k]);
    })(j);
    return { items, next };
  }

  async function subsFeed(token) {
    const j = token ? await post("browse", { continuation: token }) : await post("browse", { browseId: "FEsubscriptions" });
    return feedParse(j);
  }

  const ops = {
    list: (r) => list(r.videoIds),
    edit: (r) => edit(r.playlistId, r.videoId, r.add),
    // два вида вызова: { videoIds, add: true|false } (библиотека) и { add: [], remove: [] } (окно плейлистов)
    editMany: (r) =>
      Array.isArray(r.videoIds)
        ? editMany(r.playlistId, r.add ? r.videoIds : [], r.add ? [] : r.videoIds)
        : editMany(r.playlistId, Array.isArray(r.add) ? r.add : [], Array.isArray(r.remove) ? r.remove : []),
    removeItems: (r) => removeItems(r.playlistId, r.items),
    create: (r) => create(r.title, r.privacy, r.videoIds),
    library: () => library(),
    playlists: () => playlists(),
    page: (r) => page(r.playlistId, r.token || null, Number(r.from) || 0),
    subsFeed: (r) => subsFeed(typeof r.token === "string" ? r.token : null),
  };

  document.addEventListener(EV, (e) => {
    let req;
    try {
      req = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    const fn = ops[req?.op];
    if (!req?.id || !fn) return;
    Promise.resolve()
      .then(() => fn(req))
      .then((data) => window.postMessage({ __ytcsPl: req.id, ok: true, data }, location.origin))
      .catch((err) => window.postMessage({ __ytcsPl: req.id, ok: false, error: err?.code || "fail", message: String(err?.message || err) }, location.origin));
  });
})();
