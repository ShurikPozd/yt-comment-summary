"use strict";

// Пропуск вступлений по каналам — общая логика без DOM: её используют intro.js
// (страница YouTube и встроенный плеер «Моей библиотеки») и автопроверки
// (tests/run.mjs). Обычный скрипт, не модуль: всё лежит в globalThis.__ytcsIntroCore.
//
// Хранение — chrome.storage.local:
//   channelIntros  { "UC…": { e: 42.5, n: "Название канала", t: 1732300000000 } }
//                  e — где кончается вступление (секунды), n — название,
//                  t — когда отмечали или пропускали;
//   introHints     { "UC…": { s: [{ v: "videoId", to: 41.2, at }], no: 0 } }
//                  s — куда вы сами перематывали в первые ~60 с (по одному месту на
//                  видео), no — когда отказались запоминать (больше не предлагаем).
(() => {
  const storeKey = "channelIntros";
  const hintsKey = "introHints";
  const LIMIT = 400; // ~60 байт на канал
  const HINT_LIMIT = 150; // каналов с наблюдениями
  const HINTS_PER = 4; // мест на канал
  const MIN_END = 3; // вступление короче 3 с — не вступление
  const MAX_END = 300; // и не длиннее 5 минут
  const EARLY = 60; // «в первые ~60 с»
  const NEAR = 5; // «одно и то же место» — ±5 с
  const START = 5; // видео начато с начала: не дальше 5 с

  const isChannelId = (id) => typeof id === "string" && /^UC[A-Za-z0-9_-]{22}$/.test(id);
  const isVideoId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id);

  // Конец вступления к виду хранения: секунды с точностью 0,1 в пределах 3…300; иначе null
  function cleanEnd(s) {
    const n = Number(s);
    if (!Number.isFinite(n) || n < MIN_END || n > MAX_END) return null;
    return Math.round(n * 10) / 10;
  }

  // 42.5 → «0:42», 75 → «1:15»
  function clock(s) {
    const n = Math.max(0, Math.floor(Number(s) || 0));
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
  }

  // ---------- запомненные вступления ----------
  function entryOf(map, id) {
    const e = map && isChannelId(id) ? map[id] : null;
    const end = cleanEnd(e?.e);
    return end == null ? null : { e: end, n: String(e.n || ""), t: Number(e.t) || 0 };
  }

  // сверх предела вытесняются каналы, которые дольше всех не открывали
  function trim(map, limit) {
    const ids = Object.keys(map);
    if (ids.length <= limit) return map;
    const keep = ids.sort((a, b) => (Number(map[b]?.t) || 0) - (Number(map[a]?.t) || 0)).slice(0, limit);
    return Object.fromEntries(keep.map((id) => [id, map[id]]));
  }

  function remember(map, id, end, name, now = Date.now(), limit = LIMIT) {
    const e = cleanEnd(end);
    if (!isChannelId(id) || e == null) return map || {};
    const prev = (map || {})[id];
    const n = String(name || "").trim() || String(prev?.n || "");
    return trim({ ...(map || {}), [id]: { e, n, t: now } }, limit);
  }

  function forget(map, id) {
    if (!map || !(id in map)) return map || {};
    const next = { ...map };
    delete next[id];
    return next;
  }

  // канал открыт снова — не вытесняется
  function touch(map, id, name, now = Date.now()) {
    const e = entryOf(map, id);
    if (!e) return map || {};
    return { ...map, [id]: { e: e.e, n: String(name || "").trim() || e.n, t: now } };
  }

  // для настроек: [{ id, e, n, t }] — сначала недавние
  function list(map) {
    return Object.keys(map || {})
      .map((id) => ({ id, ...entryOf(map, id) }))
      .filter((x) => x.e != null)
      .sort((a, b) => b.t - a.t);
  }

  // ---------- пропускать ли сейчас ----------
  // o: { enabled, end, current, duration, live, urlT, resume, ad }
  // → { to } — перемотать к концу вступления, или null — не трогать
  function plan(o) {
    const end = cleanEnd(o?.end);
    if (!o || !o.enabled || end == null || o.live || o.urlT || o.resume || o.ad) return null;
    const cur = Number(o.current);
    const d = Number(o.duration);
    if (!Number.isFinite(cur) || cur < 0) return null;
    if (cur > START || cur >= end - 1) return null; // видео начато не с начала или уже дальше
    // видео должно быть заметно длиннее вступления (иначе это короткий ролик канала)
    if (!Number.isFinite(d) || d <= 0 || d < end + 30) return null;
    return { to: end };
  }

  // ---------- сами перематываете вступление ----------
  // Ваша перемотка вперёд в первые ~60 с: из начала (from) куда-то дальше (to).
  function isIntroSeek(from, to) {
    const a = Number(from);
    const b = Number(to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return a >= 0 && a <= EARLY && b - a >= 3 && cleanEnd(b) != null && b <= EARLY + 120;
  }

  function hintOf(hints, id) {
    const h = hints && isChannelId(id) ? hints[id] : null;
    const s = Array.isArray(h?.s) ? h.s.filter((x) => isVideoId(x?.v) && cleanEnd(x?.to) != null) : [];
    return { s, no: Number(h?.no) || 0 };
  }

  // Запомнить место перемотки: одно на видео (последнее), не больше HINTS_PER на канал
  function observe(hints, id, videoId, to, now = Date.now(), limit = HINT_LIMIT) {
    const t = cleanEnd(to);
    if (!isChannelId(id) || !isVideoId(videoId) || t == null) return hints || {};
    const h = hintOf(hints, id);
    const s = h.s.filter((x) => x.v !== videoId);
    s.push({ v: videoId, to: t, at: now });
    const next = { ...(hints || {}), [id]: { s: s.slice(-HINTS_PER), no: h.no } };
    const ids = Object.keys(next);
    if (ids.length <= limit) return next;
    const last = (k) => Math.max(0, ...hintOf(next, k).s.map((x) => Number(x.at) || 0), hintOf(next, k).no);
    return Object.fromEntries(ids.sort((a, b) => last(b) - last(a)).slice(0, limit).map((k) => [k, next[k]]));
  }

  // Предложить запомнить: в 2+ разных видео канала перемотали на одно место (±5 с).
  // Возвращает конец вступления (самое раннее место из совпавших) или null.
  function suggest(hints, id) {
    const h = hintOf(hints, id);
    if (h.no) return null;
    const s = h.s;
    let best = null;
    for (let i = 0; i < s.length; i++) {
      const near = s.filter((x) => Math.abs(x.to - s[i].to) <= NEAR);
      const vids = new Set(near.map((x) => x.v));
      if (vids.size < 2) continue;
      const end = Math.min(...near.map((x) => x.to));
      if (best == null || vids.size > best.n || (vids.size === best.n && end < best.end)) best = { n: vids.size, end };
    }
    return best ? cleanEnd(best.end) : null;
  }

  // «Не надо»: больше не предлагать для канала (места забываем)
  function decline(hints, id, now = Date.now()) {
    if (!isChannelId(id)) return hints || {};
    return { ...(hints || {}), [id]: { s: [], no: now } };
  }

  // Запомнили или сбросили вступление — наблюдения канала больше не нужны
  function clearHints(hints, id) {
    return forget(hints, id);
  }

  globalThis.__ytcsIntroCore = {
    storeKey,
    hintsKey,
    LIMIT,
    startLimit: START, // видео начато «с начала» — не дальше стольких секунд
    early: EARLY,
    isChannelId,
    cleanEnd,
    clock,
    entryOf,
    remember,
    forget,
    touch,
    list,
    plan,
    isIntroSeek,
    observe,
    suggest,
    decline,
    clearHints,
  };
})();
