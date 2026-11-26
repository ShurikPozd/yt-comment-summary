"use strict";

// Своё меню по правому щелчку на YouTube — логика без DOM (globalThis.__ytcsCtxCore).
// Окно и события — ctxmenu.js; здесь только то, что проверяется автотестами (tests/run.mjs):
//   - parseLink(href, base) — ссылка на видео: id, Shorts, время (t=, start=, #t=), плейлист;
//   - parseT("1h2m3s") → 3723, fmtTime(754) → «12:34»;
//   - videoUrl(id, { short, t }) — ссылка «Копировать ссылку»;
//   - videoItems(ctx) / playerItems(ctx) — пункты меню карточки (ссылки) и плеера по состоянию;
//   - place(...) — куда встать меню: не за краем окна, на чётных пикселях (ровные подписи на 150 %);
//   - nav(key, i, n) — стрелки, Home/End по пунктам;
//   - nativeWanted(...) — когда оставить обычное меню браузера;
//   - linkTarget(link, …) — меню ссылки на видео в тексте (название, «это видео», подборки — нет);
//   - cardTime(id, clicked, main) — время для меню карточки (ссылка на момент внутри неё).
(() => {
  if (globalThis.__ytcsCtxCore) return;

  const ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const HOSTS = /^(www\.|m\.|music\.)?youtube\.com$|^youtu\.be$|^youtube-nocookie\.com$|^www\.youtube-nocookie\.com$/;

  // «754», «754s», «12m34s», «1h2m3s», «12:34» → секунды (не время — 0)
  function parseT(s) {
    const v = String(s ?? "").trim().toLowerCase();
    if (!v) return 0;
    if (/^\d+(\.\d+)?s?$/.test(v)) return Math.floor(parseFloat(v));
    if (/^\d+(:\d{1,2}){1,2}$/.test(v)) return v.split(":").reduce((a, x) => a * 60 + Number(x), 0);
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(v);
    if (!m || !(m[1] || m[2] || m[3])) return 0;
    return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  }

  function fmtTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  // ссылка на одно видео → { id, short, t, list } или null (каналы, плейлисты без видео, чужие сайты)
  function parseLink(href, base = "https://www.youtube.com/") {
    let u;
    try {
      u = new URL(String(href || ""), base);
    } catch (e) {
      return null;
    }
    if (!/^https?:$/.test(u.protocol) || !HOSTS.test(u.hostname)) return null;
    let id = "";
    let short = false;
    if (u.hostname === "youtu.be") id = u.pathname.slice(1).split("/")[0];
    else if (u.pathname === "/watch") id = u.searchParams.get("v") || "";
    else {
      const m = /^\/(shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname);
      if (m) {
        id = m[2];
        short = m[1] === "shorts";
      }
    }
    if (!ID_RE.test(id)) return null;
    const hashT = /(?:^#|&)t=([^&]+)/.exec(u.hash)?.[1];
    const t = parseT(u.searchParams.get("t") ?? u.searchParams.get("start") ?? hashT ?? "");
    return { id, short, t, list: u.searchParams.get("list") || "" };
  }

  function videoUrl(id, { short = false, t = 0 } = {}) {
    const s = Math.max(0, Math.floor(Number(t) || 0));
    if (short && !s) return `https://www.youtube.com/shorts/${id}`;
    return `https://www.youtube.com/watch?v=${id}${s ? `&t=${s}s` : ""}`;
  }

  // Пункт: { key, label, icon?, danger?, kind? } или "-" (разделитель).
  // Разделители — только между группами: не в начале, не в конце, не подряд.
  function tidy(list) {
    const out = [];
    for (const x of list) {
      if (!x) continue;
      if (x === "-" && (!out.length || out[out.length - 1] === "-")) continue;
      out.push(x);
    }
    while (out[out.length - 1] === "-") out.pop();
    return out;
  }

  // Очередь: в ней нет — «В очередь»; есть — «Наверх очереди» (если не первое) и «Убрать».
  function queueItems(q) {
    if (!q) return [];
    if (q.index < 0) return [{ key: "queue", label: "В очередь", icon: "queue" }];
    return [...(q.index > 0 ? [{ key: "qtop", label: "Наверх очереди", icon: "top" }] : []), { key: "qdel", label: "Убрать из очереди", icon: "remove", danger: true }];
  }

  /**
   * Меню карточки видео или ссылки на видео в тексте.
   * ctx: { short, t (время в ссылке), here (видео этой страницы), queue: { index } | null,
   *        channel: «название» | "", has: { playlists, preview, tldr, archive, notes, notInterested } }
   */
  function videoItems(ctx = {}) {
    const has = ctx.has || {};
    const t = Math.max(0, Math.floor(ctx.t || 0));
    const at = t ? fmtTime(t) : "";
    const items = [];
    if (ctx.here && t) {
      // таймкод этого же видео (описание, комментарии): перемотать или записать мысль к месту
      items.push({ key: "seek", label: `Перейти к ${at}`, icon: "time" });
      if (has.notes) items.push({ key: "note", label: "Заметка к этому месту", icon: "note" });
      items.push({ key: "tab", label: "Открыть в новой вкладке", icon: "tab" });
    } else {
      items.push({ key: "play", label: t && !ctx.short ? `Смотреть с ${at}` : "Смотреть", icon: "play" });
      items.push({ key: "tab", label: "Открыть в новой вкладке", icon: "tab" });
    }
    items.push("-", ...queueItems(ctx.queue));
    items.push("-");
    if (has.playlists) items.push({ key: "save", label: "Сохранить в плейлисты…", icon: "save" });
    if (has.preview) items.push({ key: "preview", label: "Превью обложки", icon: "preview" });
    if (has.tldr) items.push({ key: "tldr", label: "О чём видео", icon: "tldr" });
    if (has.archive) items.push({ key: "archive", label: "В архив Telegram", icon: "archive" });
    items.push("-");
    items.push({ key: "copy", label: "Копировать ссылку", icon: "link" });
    if (t && !ctx.short) items.push({ key: "copyT", label: `Ссылка с ${at}`, icon: "time" });
    if (ctx.channel) items.push({ key: "channel", label: `Канал «${ctx.channel}»`, icon: "channel" });
    if (has.notInterested) items.push("-", { key: "nope", label: "Не интересует", icon: "hide", danger: true });
    return tidy(items);
  }

  /**
   * Меню плеера (вместо меню самого плеера YouTube).
   * ctx: { t (сейчас, с), rate («1,25×»), ab: { a, b, active, aside } | null, queue: { index } | null,
   *        has: { frame, notes, ab, speed, speech }, native (есть меню YouTube) }
   */
  function playerItems(ctx = {}) {
    const has = ctx.has || {};
    const t = Math.max(0, Math.floor(ctx.t || 0));
    const items = [];
    if (has.frame) items.push({ key: "frame", label: "Снимок кадра", icon: "camera" });
    if (has.notes) items.push({ key: "note", label: `Заметка к ${fmtTime(t)}`, icon: "note" });
    if (has.ab) {
      const ab = ctx.ab || {};
      if (ab.active) items.push({ key: "abOff", label: `Снять повтор ${ab.aside || ""}`.trim(), icon: "loop", danger: true });
      else if (ab.a != null) {
        items.push({ key: "abB", label: "Конец повтора здесь (B)", icon: "loop" });
        items.push({ key: "abOff", label: `Снять начало ${fmtTime(ab.a)}`, icon: "close" });
      } else items.push({ key: "abA", label: "Повтор отрезка: начало (A)", icon: "loop" });
    }
    if (has.speed) items.push({ key: "speed", label: "Скорость", icon: "speed", kind: "rate", value: ctx.rate || "1×" });
    if (has.speech) items.push({ key: "speech", label: "Поиск по речи", icon: "speech" });
    items.push("-");
    items.push({ key: "copy", label: "Копировать ссылку", icon: "link" });
    if (t) items.push({ key: "copyT", label: `Ссылка с ${fmtTime(t)}`, icon: "time" });
    items.push("-", ...queueItems(ctx.queue));
    if (ctx.native) items.push("-", { key: "native", label: "Меню YouTube…", icon: "yt" });
    return tidy(items);
  }

  // Куда встать меню (x, y — где щёлкнули; w, h — размер меню; W, H — окно; M — отступ от края):
  // справа/снизу тесно — открывается влево/вверх, в любом случае не за краем; на чётных
  // пикселях — пункты встают на целые пиксели экрана и на 150 % (подписи не «плывут»).
  function place(x, y, w, h, W, H, M = 8) {
    let left = x + w + M > W ? x - w : x;
    let top = y + h + M > H ? y - h : y;
    left = Math.max(M, Math.min(left, W - w - M));
    top = Math.max(M, Math.min(top, H - h - M));
    const even = (v) => Math.max(0, Math.round(v / 2) * 2);
    return { left: even(left), top: even(top) };
  }

  // стрелки ↑/↓ — по кругу, Home/End — в начало/конец; другие клавиши — -1
  function nav(key, i, n) {
    if (!n) return -1;
    if (key === "ArrowDown") return i < 0 ? 0 : (i + 1) % n;
    if (key === "ArrowUp") return i < 0 ? n - 1 : (i - 1 + n) % n;
    if (key === "Home" || key === "PageUp") return 0;
    if (key === "End" || key === "PageDown") return n - 1;
    return -1;
  }

  // обычное меню браузера: Shift+щелчок мышью, поле ввода, выделенный текст под указателем
  // (клавиша меню и Shift+F10 — «с клавиатуры»: Shift там ради самого сочетания);
  // во весь экран развёрнут сам <video> — внутрь него своё меню не встанет (детей у <video> не рисуется)
  function nativeWanted({ shift = false, keyboard = false, editable = false, selected = false, videoFs = false } = {}) {
    return (shift && !keyboard) || editable || selected || videoFs;
  }

  /**
   * Ссылка на видео в тексте (описание, комментарии, заставки плеера) → данные меню или null.
   * link — parseLink(); cur — id видео этой страницы; hasVideo — плеер на месте;
   * inCard — ссылка внутри карточки, которая не видео (микс, плейлист, подборка): меню видео не даём.
   * Название — только у видео этой страницы; у чужого текст ссылки («1:23», «тут») — не название:
   * пусто, и фон сам подтянет настоящее (background.js, noTitle).
   */
  function linkTarget(link, { cur = "", hasVideo = false, inCard = false, pageTitle = "" } = {}) {
    if (!link || inCard) return null;
    const same = Boolean(cur) && link.id === cur;
    return { id: link.id, short: link.short, t: link.t, here: same && hasVideo, title: same ? pageTitle : "" };
  }

  /**
   * Время для меню карточки. Время в ссылке самой карточки — «продолжить с места» от YouTube:
   * меню — с начала, как щелчок. А щёлкнули по ссылке на момент того же видео внутри карточки
   * (главы в результатах поиска и т. п.) — её время.
   * id — видео карточки; clickedHref — ссылка под щелчком (или ""); mainHref — главная ссылка карточки.
   */
  function cardTime(id, clickedHref, mainHref) {
    const p = parseLink(clickedHref);
    if (!p || p.id !== id || !p.t) return 0;
    const m = parseLink(mainHref);
    if (m && m.id === id && m.t === p.t) return 0;
    return p.t;
  }

  globalThis.__ytcsCtxCore = { ID_RE, parseT, fmtTime, parseLink, videoUrl, tidy, queueItems, videoItems, playerItems, place, nav, nativeWanted, linkTarget, cardTime };
})();
