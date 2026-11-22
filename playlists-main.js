// Плейлисты: запросы к YouTube от вашего имени — те же внутренние команды,
// которыми пользуется сам сайт («сохранить в плейлист», «новый плейлист»).
// Скрипт живёт в мире страницы (world: MAIN): только здесь виден ytcfg с
// настройками клиента и вашего аккаунта (в том числе канала-бренда), а
// запросы уходят ровно так же, как у самого YouTube.
// Управление — событие "ytcs-pl" на document (JSON в detail), ответы —
// window.postMessage({ __ytcsPl: id, ok, data | error }).
(() => {
  if (window.__ytcsPlMain) return;
  window.__ytcsPlMain = true;

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

  // Новый плейлист сразу с этим видео
  async function create(title, privacy, videoIds) {
    const j = await post("playlist/create", { title, privacyStatus: privacy || "PRIVATE", videoIds });
    if (!j?.playlistId) throw Object.assign(new Error("create failed"), { code: "create" });
    return { id: j.playlistId };
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
        if (o.continuationItemRenderer) next ||= o.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || null;
        for (const k in o) walk(o[k]);
      })(j);
      j = next ? await post("browse", { continuation: next }) : null;
    }
    return out;
  }

  const ops = {
    list: (r) => list(r.videoIds),
    edit: (r) => edit(r.playlistId, r.videoId, r.add),
    create: (r) => create(r.title, r.privacy, r.videoIds),
    library: () => library(),
  };

  document.addEventListener("ytcs-pl", (e) => {
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
