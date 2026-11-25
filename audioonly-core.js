"use strict";

// «Только звук» — общая логика без DOM: её используют audioonly.js (страница YouTube
// и встроенный плеер «Моей библиотеки») и автопроверки (tests/run.mjs). Обычный
// скрипт, не модуль: всё лежит в globalThis.__ytcsAudioOnlyCore.
//
// Режим включается тремя путями:
//   - вы сами (пункт меню, клавиша Shift+V) — режим держится во вкладке и на
//     следующих видео, пока не выключите (sessionStorage: переживает F5);
//   - «по каналам» (settings.audioOnlyChannels, по умолчанию вкл.): включили на видео
//     канала — канал запомнен, его следующие видео сразу «только звук»; выключили на
//     видео канала — канал забыт.
//
// Хранение — chrome.storage.local:
//   audioOnlyChannels   { "UC…": { n: "Название канала", t: 1732300000000 } }
//                       n — название, t — когда включали или открывали.
(() => {
  const storeKey = "audioOnlyChannels";
  const tabKey = "ytcsAudioOnly"; // sessionStorage вкладки: "1" — вы включили режим здесь
  const LIMIT = 300; // ~50 байт на канал — около 15 КБ в худшем случае

  const isChannelId = (id) => typeof id === "string" && /^UC[A-Za-z0-9_-]{22}$/.test(id);

  // Запись канала: только правильная (битая из хранилища не читается)
  function entryOf(map, id) {
    const e = isChannelId(id) && map && typeof map === "object" ? map[id] : null;
    return e && typeof e === "object" && Number.isFinite(Number(e.t)) ? e : null;
  }
  const has = (map, id) => Boolean(entryOf(map, id));

  // Сверх предела вытесняются давно не открытые каналы
  function trim(map, limit) {
    const ids = Object.keys(map);
    if (ids.length <= limit) return map;
    const keep = ids.sort((a, b) => (Number(map[b]?.t) || 0) - (Number(map[a]?.t) || 0)).slice(0, limit);
    return Object.fromEntries(keep.map((id) => [id, map[id]]));
  }

  // Запомнить канал. Возвращает новый объект (исходный не меняется)
  function remember(map, id, name, now = Date.now(), limit = LIMIT) {
    if (!isChannelId(id)) return map;
    const prev = entryOf(map, id);
    const n = String(name || "").trim() || prev?.n || "";
    return trim({ ...(map || {}), [id]: { n, t: now } }, limit);
  }

  function forget(map, id) {
    if (!map || !(id in map)) return map;
    const next = { ...map };
    delete next[id];
    return next;
  }

  // Канал открыли снова — свежее время (чтобы его не вытеснили)
  function touch(map, id, name, now = Date.now()) {
    const prev = entryOf(map, id);
    if (!prev) return map;
    return { ...map, [id]: { n: String(name || "").trim() || prev.n || "", t: now } };
  }

  // Новое видео: включать ли режим.
  //   sticky — вы включили режим в этой вкладке; memory — «по каналам» включено;
  //   stored — канал видео запомнен.
  // → { on, why }: why — "channel" (запомнен канал), "tab" (вы включили во вкладке) или "".
  function plan({ sticky = false, memory = true, stored = false } = {}) {
    if (memory && stored) return { on: true, why: "channel" };
    if (sticky) return { on: true, why: "tab" };
    return { on: false, why: "" };
  }

  // Вы переключили режим на видео канала ch: что станет со списком каналов и вкладкой.
  // → { map, sticky, remembered, forgotten }
  function toggle({ map, on, ch, name, memory = true, now = Date.now() }) {
    let next = map || {};
    let remembered = false;
    let forgotten = false;
    if (on && memory && isChannelId(ch)) {
      remembered = !has(next, ch);
      next = remember(next, ch, name, now);
    } else if (!on && has(next, ch)) {
      // выключили на видео запомненного канала — канал забыт (даже если «по каналам» уже выкл.)
      next = forget(next, ch);
      forgotten = true;
    }
    return { map: next, sticky: Boolean(on), remembered, forgotten };
  }

  // Самое низкое качество из списка плеера (["hd1080", …, "tiny", "auto"]) — или ""
  const ORDER = ["tiny", "small", "medium", "large", "hd720", "hd1080", "hd1440", "hd2160", "hd2880", "highres"];
  function lowest(levels) {
    const ok = (Array.isArray(levels) ? levels : []).filter((q) => ORDER.includes(q));
    if (!ok.length) return "";
    return ok.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0];
  }

  // Качество, которое вернуть при выключении: ваше предпочтение до режима
  // ("auto" или выбранное в ⚙). Мусор — "auto".
  function restoreQuality(pref) {
    return ORDER.includes(pref) ? pref : "auto";
  }

  // Клавиша вкл/выкл: Shift+V на любой раскладке (по коду клавиши), без Ctrl/Alt/⌘
  function isToggleKey(e) {
    return Boolean(e && e.code === "KeyV" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat && !e.isComposing);
  }

  // Строки субтитров YouTube → одна фраза: пробелы схлопнуты, переносы — пробелом
  function phrase(lines) {
    const arr = Array.isArray(lines) ? lines : [lines];
    return arr
      .map((s) => String(s ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ")
      .slice(0, 400);
  }

  // Картинки обложки: от крупной к мелкой. У maxresdefault бывает «нет такой» (серая
  // 120×90) — тогда следующая; hqdefault есть всегда (4:3 с полосами — режется по 16:9).
  function covers(id) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(String(id || ""))) return [];
    return ["maxresdefault", "sddefault", "hqdefault"].map((q) => `https://i.ytimg.com/vi/${id}/${q}.jpg`);
  }
  // «Нет такой картинки» у YouTube — заглушка 120×90
  const isStubImage = (w, h) => !(w > 120 && h > 90);

  // Подпись плашки: «Только звук» или «Только звук для канала»
  function pillText(forChannel) {
    return forChannel ? "Только звук для канала" : "Только звук";
  }

  globalThis.__ytcsAudioOnlyCore = {
    storeKey,
    tabKey,
    LIMIT,
    isChannelId,
    entryOf,
    has,
    remember,
    forget,
    touch,
    plan,
    toggle,
    lowest,
    restoreQuality,
    isToggleKey,
    phrase,
    covers,
    isStubImage,
    pillText,
  };
})();
