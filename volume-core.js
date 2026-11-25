"use strict";

// Громкость по каналам — общая логика без DOM: её используют volume.js (страница
// YouTube и встроенный плеер «Моей библиотеки»), настройки боковой панели и
// автопроверки (tests/run.mjs). Обычный скрипт, не модуль: всё лежит в
// globalThis.__ytcsVolumeCore.
//
// Громкость — целые проценты от 1 до 300: до 100 % это ползунок YouTube, выше —
// ползунок на 100 % и усиление звука (Web Audio, audio-graph.js) в p/100 раз.
//
// Хранение — chrome.storage.local:
//   channelVolumes      { "UC…": { v: 150, n: "Название канала", t: 1732300000000 } }
//                       v — громкость, n — название, t — когда меняли или открывали;
//   channelVolumeState  { normal: 80, ours: 150 | null }
//                       normal — ваша обычная громкость (на каналах без своей),
//                       ours — громкость, которую последней поставили для канала мы
//                       или вы: YouTube переносит её на следующее видео, и если у его
//                       канала своей нет — возвращаем обычную.
(() => {
  const storeKey = "channelVolumes";
  const stateKey = "channelVolumeState";
  const LIMIT = 400; // ~60 байт на канал — около 25 КБ в худшем случае
  const MIN = 1;
  const MAX = 300;
  const STEP = 10; // кнопки − / + в меню
  const WHEEL = 5; // колесо над громкостью плеера

  // Выравнивание громкости: тихое громче, громкое тише (DynamicsCompressorNode;
  // подъём тихих мест — встроенное в Chrome «выравнивающее» усиление компрессора)
  // (порог −24 дБ, 3:1 — тихое поднимается примерно на 10 дБ, самое громкое — на 6 дБ тише)
  const LEVELER = { threshold: -24, knee: 30, ratio: 3, attack: 0.005, release: 0.3 };

  const isChannelId = (id) => typeof id === "string" && /^UC[A-Za-z0-9_-]{22}$/.test(id);

  // Громкость к виду хранения: целые проценты в пределах 1…300; 0 и мусор — null
  function cleanVol(p) {
    const n = Number(p);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(Math.min(MAX, Math.max(MIN, n)));
  }

  // одна и та же громкость (ползунок YouTube бывает дробным: 47,6)
  const same = (a, b) => Math.abs(Number(a) - Number(b)) < 1.01;

  // 150 → «150 %» (неразрывный пробел — по правилам русского набора)
  function fmtVol(p) {
    const n = cleanVol(p);
    return n == null ? "" : `${n} %`;
  }

  // Громкость → ползунок YouTube (0…100) и усиление (1…3)
  function split(p) {
    const n = cleanVol(p);
    if (n == null) return { slider: 100, gain: 1 };
    return n > 100 ? { slider: 100, gain: n / 100 } : { slider: n, gain: 1 };
  }

  // Ползунок и усиление → громкость
  function total(slider, gain = 1) {
    const s = Number(slider);
    if (!Number.isFinite(s) || s <= 0) return null;
    return cleanVol(s * (Number(gain) > 1 ? Number(gain) : 1));
  }

  // Шаг кнопками − / + (по 10 %) или колесом (по 5 %); не ниже 5 % — «тише некуда»
  function step(p, dir, by = STEP) {
    const n = cleanVol(p) ?? 100;
    const next = Math.round((n + (dir > 0 ? by : -by)) / by) * by;
    return Math.min(MAX, Math.max(5, next));
  }

  // Запись для канала из хранилища — только целая и правильная
  function entryOf(map, id) {
    const e = map && isChannelId(id) ? map[id] : null;
    const v = cleanVol(e?.v);
    return v == null ? null : { v, n: String(e.n || ""), t: Number(e.t) || 0 };
  }

  // Запомнить громкость канала. Возвращает новый объект; сверх LIMIT
  // вытесняются каналы, которые дольше всех не открывали.
  function remember(map, id, vol, name, now = Date.now(), limit = LIMIT) {
    const v = cleanVol(vol);
    if (!isChannelId(id) || v == null) return { ...(map || {}) };
    const next = { ...(map || {}) };
    const prev = entryOf(next, id);
    next[id] = { v, n: String(name || prev?.n || "").trim().slice(0, 80), t: now };
    const ids = Object.keys(next);
    if (ids.length > limit) {
      ids
        .filter((k) => k !== id)
        .sort((a, b) => (Number(next[a]?.t) || 0) - (Number(next[b]?.t) || 0))
        .slice(0, ids.length - limit)
        .forEach((k) => delete next[k]);
    }
    return next;
  }

  function forget(map, id) {
    const next = { ...(map || {}) };
    delete next[id];
    return next;
  }

  // Отметить, что канал снова открывали (для вытеснения), не меняя громкость
  function touch(map, id, name, now = Date.now()) {
    const e = entryOf(map, id);
    if (!e) return map || {};
    return { ...map, [id]: { v: e.v, n: String(name || e.n || "").trim().slice(0, 80), t: now } };
  }

  // Громкость сейчас — та, что YouTube перенёс с видео канала: та же, или ползунок на
  // 100 %, если у канала было громче (после перезагрузки страницы усиления уже нет,
  // а ползунок YouTube запомнил 100)
  function carried(current, ours) {
    const cur = cleanVol(current);
    const o = cleanVol(ours);
    if (cur == null || o == null) return false;
    return same(cur, o) || (o > 100 && same(cur, 100));
  }

  // Состояние «обычная громкость / наша громкость» из хранилища — только правильное
  function cleanState(st) {
    return { normal: cleanVol(st?.normal), ours: cleanVol(st?.ours) };
  }

  // Что сделать с громкостью нового видео.
  //   enabled   — «Запоминать громкость по каналам»;
  //   stored    — запомненная громкость канала или null;
  //   current   — громкость сейчас (ползунок × наше усиление);
  //   normal    — ваша обычная громкость или null (ещё не знаем);
  //   ours      — громкость канала, которую YouTube перенёс с прошлого видео, или null;
  //   userChose — вы уже сами меняли громкость в этом видео;
  //   live      — прямой эфир.
  // Ответ: { vol, why: "channel" | "restore" } или null — ничего не трогать.
  function plan({ enabled, stored, current, normal, ours, userChose, live }) {
    if (!enabled || userChose || live) return null;
    const cur = cleanVol(current);
    if (cur == null) return null;
    const want = cleanVol(stored);
    if (want != null) return same(want, cur) ? null : { vol: want, why: "channel" };
    const n = cleanVol(normal);
    const o = cleanVol(ours);
    if (n != null && carried(cur, o) && !same(cur, n)) return { vol: n, why: "restore" };
    return null;
  }

  // Видео канала без своей громкости, которое мы не трогали: какая громкость теперь
  // «обычная». Если YouTube держит громкость, поставленную для канала, — это не ваша
  // обычная (её вернёт plan). Иначе громкость сейчас и есть обычная.
  function observe(state, current) {
    const st = cleanState(state);
    const cur = cleanVol(current);
    if (cur == null) return st;
    if (carried(cur, st.ours)) return st;
    return { normal: cur, ours: null };
  }

  // Список для настроек: сначала недавние
  function list(map) {
    return Object.keys(map || {})
      .map((id) => ({ id, ...entryOf(map, id) }))
      .filter((e) => e.v != null)
      .sort((a, b) => b.t - a.t);
  }

  globalThis.__ytcsVolumeCore = {
    storeKey,
    stateKey,
    LIMIT,
    minVol: MIN,
    maxVol: MAX,
    stepSize: STEP,
    wheel: WHEEL,
    leveler: LEVELER,
    isChannelId,
    cleanVol,
    same,
    fmtVol,
    split,
    total,
    step,
    entryOf,
    remember,
    forget,
    touch,
    cleanState,
    carried,
    plan,
    observe,
    list,
  };
})();
