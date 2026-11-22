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

  // Много видео одним запросом (пачку собирает вызывающий: YouTube принимает
  // несколько действий в одном edit_playlist — проверено, добавление и удаление)
  async function editMany(playlistId, videoIds, add) {
    const ids = (videoIds || []).filter((x) => /^[A-Za-z0-9_-]{11}$/.test(x)).slice(0, 100);
    if (!ids.length) return 0;
    const actions = ids.map((v) => (add ? { action: "ACTION_ADD_VIDEO", addedVideoId: v } : { action: "ACTION_REMOVE_VIDEO_BY_VIDEO_ID", removedVideoId: v }));
    const j = await post("browse/edit_playlist", { playlistId, actions });
    if (j?.status && j.status !== "STATUS_SUCCEEDED") throw Object.assign(new Error(j.status), { code: "edit" });
    return ids.length;
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
    return { items, next };
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

  // Обложки и «обновлено…» со страницы «Плейлисты» вашей библиотеки
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
          out.push({ id: l.contentId, thumb, updated: lines.find((x) => /обновлен|updated/i.test(x)) || "" });
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

  const ops = {
    list: (r) => list(r.videoIds),
    edit: (r) => edit(r.playlistId, r.videoId, r.add),
    editMany: (r) => editMany(r.playlistId, r.videoIds, r.add),
    create: (r) => create(r.title, r.privacy, r.videoIds),
    library: () => library(),
    playlists: () => playlists(),
    page: (r) => page(r.playlistId, r.token || null, Number(r.from) || 0),
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
