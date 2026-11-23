"use strict";

// Статистика просмотра — сбор на youtube.com и во встроенном плеере «Моей
// библиотеки». Считает только реальное воспроизведение:
//  - видео играет (не пауза, не конец, не перемотка) и не реклама YouTube;
//  - вкладка на виду или из неё идёт звук (фоновая музыка — тоже просмотр);
//  - время — по движению самого видео, делённому на скорость: перемотки и
//    пропуски вставок сюда не попадают, сон компьютера — тоже.
// Скорость быстрее 1× экономит время: смотрели t секунд на 1,5× — сэкономили
// t × 0,5. Пропуск рекламных вставок (sponsor.js) и тишины сообщают событием
// "ytcs-stats:saved" на document ({ kind: "sponsor" | "silence", sec }).
// Shorts — отдельно. Канал — у плеера (speed-main.js, событие ytcs-speed:ask).
// Раз в ~15 с прибавка уходит в фон (stats-bg.js) — тот складывает по дням.
// Выключатель — settings.watchStats (по умолчанию вкл.).
(() => {
  // Встроенный плеер (youtube.com/embed) — только внутри нашей «Моей библиотеки»
  if (location.pathname.startsWith("/embed/")) {
    let ours = false;
    try {
      ours = location.ancestorOrigins?.[0] === `chrome-extension://${chrome.runtime.id}`;
    } catch (e) {
      ours = false;
    }
    if (!ours) return;
  } else if (window.top !== window) {
    return; // прочие фреймы YouTube (чат трансляции и т. п.) — не наше
  }
  if (globalThis.__ytcsStats) return;
  globalThis.__ytcsStats = true;
  const OUR_EMBED = location.pathname.startsWith("/embed/");
  const FLUSH_MS = 15000;

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };

  let enabled = true;

  // ---------- Что сейчас открыто ----------
  function pageNow() {
    const p = location.pathname;
    if (p === "/watch") return { id: new URLSearchParams(location.search).get("v"), short: false };
    if (p.startsWith("/shorts/")) return { id: p.split("/")[2] || null, short: true };
    if (p.startsWith("/live/")) return { id: p.split("/")[2] || null, short: false };
    if (OUR_EMBED) return { id: p.match(/^\/embed\/([A-Za-z0-9_-]{11})/)?.[1] || null, short: false };
    return { id: null, short: false }; // лента, поиск, канал — превью на обложках не считаем
  }

  function videoEl(short) {
    if (short) {
      return (
        document.querySelector("#shorts-player video") ||
        document.querySelector("ytd-reel-video-renderer[is-active] video") ||
        null
      );
    }
    return document.querySelector("#movie_player video.html5-main-video") || document.querySelector("video.html5-main-video");
  }
  const playerOf = (v) => v?.closest(".html5-video-player");

  // ---------- Канал ----------
  function askInfo() {
    let info = null;
    const on = (e) => {
      try {
        info = JSON.parse(e.detail);
      } catch (err) {
        info = null;
      }
    };
    document.addEventListener("ytcs-speed:info", on);
    document.dispatchEvent(new CustomEvent("ytcs-speed:ask"));
    document.removeEventListener("ytcs-speed:info", on);
    return info;
  }
  const idFromHref = (href) => String(href || "").match(/\/channel\/(UC[A-Za-z0-9_-]{22})/)?.[1] || "";
  // запасной путь — со страницы: плеер не ответил (у встроенного плеера API беднее)
  function channelFromDom(short) {
    const a = short
      ? document.querySelector("ytd-reel-video-renderer[is-active] ytd-channel-name a, ytd-reel-video-renderer[is-active] .ytReelChannelBarViewModelChannelName a")
      : OUR_EMBED
        ? document.querySelector(".ytp-title-channel-name a, a.ytp-title-channel-name, .ytp-title-expanded-title a")
        : document.querySelector("ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a");
    const name = (a?.textContent || a?.getAttribute("aria-label") || "").trim();
    return name ? { id: idFromHref(a.href), name } : null;
  }

  const chanCache = new Map(); // id видео → { id, name }
  function channelOf(vid, short) {
    if (chanCache.has(vid)) return chanCache.get(vid);
    const info = askInfo();
    let ch = null;
    if (info && info.videoId === vid && (info.channelId || info.name)) ch = { id: info.channelId || "", name: String(info.name || "").trim() };
    else ch = channelFromDom(short);
    if (ch) chanCache.set(vid, ch);
    return ch;
  }

  // ---------- Подсчёт ----------
  const blank = () => ({ w: 0, s: 0, sp: 0, sb: 0, si: 0, n: 0, fin: 0, ch: new Map() });
  let pend = blank();
  const watchedSec = new Map(); // id видео → секунд за этот заход (для «смотрели» и «досмотрено»)
  const counted = new Set(); // уже посчитаны как «смотрели дольше 30 с»
  const finished = new Set(); // уже посчитаны как досмотренные
  let last = null; // { vid, el, ct, at }

  function tick() {
    if (!enabled || !alive()) return void (last = null);
    const { id, short } = pageNow();
    const v = id ? videoEl(short) : null;
    const now = performance.now();
    const playing = v && !v.paused && !v.ended && !v.seeking && v.readyState >= 2;
    const heard = v && !v.muted && v.volume > 0;
    const ad = playerOf(v)?.classList.contains("ad-showing");
    if (!playing || ad || (document.visibilityState !== "visible" && !heard)) return void (last = null);
    const ct = v.currentTime;
    const rate = v.playbackRate || 1;
    if (last && last.vid === id && last.el === v) {
      const wall = (now - last.at) / 1000;
      const moved = ct - last.ct;
      // движение видео, похожее на обычное воспроизведение (без перемоток и пропусков)
      if (moved > 0 && wall > 0 && moved <= wall * rate * 1.5 + 1.5) {
        const real = Math.min(moved / rate, wall + 0.5);
        add(id, short, real, rate, v);
      }
    }
    last = { vid: id, el: v, ct, at: now };
  }

  function add(id, short, real, rate, v) {
    if (short) pend.s += real;
    else pend.w += real;
    if (rate > 1.01) pend.sp += real * (rate - 1);
    const ch = channelOf(id, short);
    if (ch && !short) {
      const key = ch.id || `n:${ch.name}`;
      const e = pend.ch.get(key) || { id: ch.id, name: ch.name, sec: 0 };
      e.sec += real;
      pend.ch.set(key, e);
    }
    const sec = (watchedSec.get(id) || 0) + real;
    watchedSec.set(id, sec);
    if (short) return;
    if (sec >= 30 && !counted.has(id)) {
      counted.add(id);
      pend.n++;
    }
    // досмотрено: дошли до последних 10% и смотрели хотя бы треть видео (или 30 с)
    const d = v.duration;
    if (Number.isFinite(d) && d > 0 && v.currentTime >= d * 0.9 && sec >= Math.min(30, d * 0.33) && !finished.has(id)) {
      finished.add(id);
      pend.fin++;
    }
  }

  // пропуск рекламной вставки или тишины — сколько секунд реального времени сэкономлено
  document.addEventListener("ytcs-stats:saved", (e) => {
    let d = null;
    try {
      d = JSON.parse(e.detail);
    } catch (err) {
      d = null;
    }
    const sec = Number(d?.sec);
    if (!enabled || !Number.isFinite(sec) || Math.abs(sec) > 86400) return;
    if (d.kind === "sponsor") pend.sb += sec;
    else if (d.kind === "silence") pend.si += sec;
  });

  // ---------- Отправка в фон ----------
  function flush() {
    if (!alive()) return;
    const p = pend;
    pend = blank();
    const delta = {};
    for (const f of ["w", "s", "sp", "sb", "si"]) if (p[f] > 0.5) delta[f] = Math.round(p[f] * 10) / 10;
    for (const f of ["n", "fin"]) if (p[f] > 0) delta[f] = p[f];
    const chans = [...p.ch.values()].filter((c) => c.sec >= 0.5);
    // недостающие доли секунды не теряем — дождутся следующей отправки
    for (const f of ["w", "s", "sp", "sb", "si"]) if (!delta[f] && p[f] !== 0) pend[f] += p[f];
    const msgs = [];
    if (chans.length) msgs.push({ ...delta, ch: chans[0] });
    else if (Object.keys(delta).length) msgs.push(delta);
    for (const c of chans.slice(1)) msgs.push({ ch: c });
    for (const m of msgs) {
      try {
        void chrome.runtime.sendMessage({ type: "stats:add", delta: m }).catch(() => {});
      } catch (e) {
        /* расширение обновили — эта вкладка больше не пишет */
      }
    }
  }

  setInterval(tick, 1000);
  setInterval(flush, FLUSH_MS);
  document.addEventListener("visibilitychange", () => {
    tick();
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", () => {
    tick();
    flush();
  });
  // переход на другое видео: дочитываем прошлое и начинаем счёт заново
  document.addEventListener("yt-navigate-start", () => {
    tick();
    last = null;
  });

  // ---------- Настройка ----------
  try {
    chrome.storage.local
      .get("settings")
      .then(({ settings }) => (enabled = settings?.watchStats !== false))
      .catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings) {
        enabled = changes.settings.newValue?.watchStats !== false;
        if (!enabled) pend = blank();
      }
    });
  } catch (e) {
    /* нет доступа к хранилищу — считаем по умолчанию */
  }
})();
