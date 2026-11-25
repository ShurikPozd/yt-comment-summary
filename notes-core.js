"use strict";

// Заметки с таймкодами — общая логика без DOM. Её используют notes.js (страница
// YouTube и встроенный плеер «Моей библиотеки»), раздел «Заметки» библиотеки
// (library/notes-view.js), резервная копия (library/backup.js) и автопроверки
// (tests/run.mjs). Обычный скрипт, не модуль: контент-скрипты модулями не бывают —
// всё лежит в globalThis.__ytcsNotesCore (модули подключают файл ради этого
// побочного действия: import "../notes-core.js").
//
// Хранение — chrome.storage.local, ключ tcNotes, по видео:
//   { [videoId]: { title, channel, len, at, items: [{ t, text, at }] } }
//   t    — секунда видео (целая), text — текст заметки (одна строка, до 500 знаков),
//   at   — когда заметку написали (мс); он же её «имя» для правки и удаления;
//   at у видео — когда заметки этого видео меняли в последний раз (порядок в разделе).
// Функции не меняют переданное хранилище — возвращают новое.
(() => {
  const KEY = "tcNotes";
  const MAX_TEXT = 500; // знаков в заметке
  const MAX_NOTES = 300; // заметок у одного видео
  const MAX_VIDEOS = 3000; // видео с заметками (больше — самые старые не попадут в копию)
  const TG_MAX = 3000; // столько знаков бот берёт в одно сообщение Telegram
  const ID_RE = /^[A-Za-z0-9_-]{11}$/;

  const int = (x) => (Number.isFinite(Number(x)) ? Math.floor(Number(x)) : NaN);

  // 75 → «1:15», 3725 → «1:02:05»
  function fmtTime(sec) {
    const s = Math.max(0, int(sec) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  // одна строка без управляющих символов и лишних пробелов
  function cleanText(s) {
    return String(s ?? "")
      .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TEXT)
      .trim();
  }
  const cleanMeta = (s, max = 300) => cleanText(s).slice(0, max);

  function cleanNote(n) {
    if (!n || typeof n !== "object") return null;
    const t = int(n.t);
    const at = int(n.at);
    const text = cleanText(n.text);
    if (!(t >= 0) || t > 360000 || !text) return null;
    return { t, text, at: at > 0 ? at : 1 };
  }

  const byTime = (a, b) => a.t - b.t || a.at - b.at;

  // заметки одного видео: без мусора и повторов «имени» at, по порядку в видео
  function cleanItems(items) {
    const seen = new Set();
    const out = [];
    for (const n of Array.isArray(items) ? items : []) {
      const c = cleanNote(n);
      if (!c) continue;
      while (seen.has(c.at)) c.at++;
      seen.add(c.at);
      out.push(c);
    }
    return out.sort(byTime).slice(0, MAX_NOTES);
  }

  function cleanVideo(v) {
    if (!v || typeof v !== "object") return null;
    const items = cleanItems(v.items);
    if (!items.length) return null;
    const len = int(v.len);
    const at = int(v.at);
    return {
      title: cleanMeta(v.title),
      channel: cleanMeta(v.channel, 120),
      len: len > 0 ? len : 0,
      at: at > 0 ? at : Math.max(...items.map((x) => x.at)),
      items,
    };
  }

  // всё хранилище: только настоящие id видео и непустые списки
  function cleanStore(s) {
    const out = {};
    if (!s || typeof s !== "object" || Array.isArray(s)) return out;
    const list = [];
    for (const [id, v] of Object.entries(s)) {
      if (!ID_RE.test(id)) continue;
      const c = cleanVideo(v);
      if (c) list.push([id, c]);
    }
    list.sort((a, b) => b[1].at - a[1].at);
    for (const [id, v] of list.slice(0, MAX_VIDEOS)) out[id] = v;
    return out;
  }

  // название и канал: новое непустое — поверх старого
  function withMeta(v, meta) {
    const title = cleanMeta(meta?.title);
    const channel = cleanMeta(meta?.channel, 120);
    const len = int(meta?.len);
    return { ...v, title: title || v.title || "", channel: channel || v.channel || "", len: len > 0 ? len : v.len || 0 };
  }

  /** Новая заметка. → { store, note } или { store, note: null, why: "empty" | "full" | "id" } */
  function addNote(store, id, { t, text, at = Date.now() } = {}, meta = {}) {
    if (!ID_RE.test(String(id || ""))) return { store, note: null, why: "id" };
    const note = cleanNote({ t: Math.max(0, int(t) || 0), text, at });
    if (!note) return { store, note: null, why: "empty" };
    const cur = store?.[id] || { title: "", channel: "", len: 0, at: 0, items: [] };
    if (cur.items.length >= MAX_NOTES) return { store, note: null, why: "full" };
    while (cur.items.some((x) => x.at === note.at)) note.at++;
    const v = withMeta({ ...cur, items: [...cur.items, note].sort(byTime), at: Math.max(note.at, Date.now()) }, meta);
    return { store: { ...store, [id]: v }, note };
  }

  /** Новый текст заметки (пустой — ничего не меняет: удалить — removeNote). */
  function updateNote(store, id, at, text) {
    const v = store?.[id];
    const i = v ? v.items.findIndex((x) => x.at === at) : -1;
    const clean = cleanText(text);
    if (i < 0 || !clean) return { store, note: null };
    if (v.items[i].text === clean) return { store, note: v.items[i] };
    const note = { ...v.items[i], text: clean };
    const items = v.items.slice();
    items[i] = note;
    return { store: { ...store, [id]: { ...v, items, at: Date.now() } }, note };
  }

  /** Удалить. → { store, note, meta } — note и meta нужны, чтобы «Вернуть». */
  function removeNote(store, id, at) {
    const v = store?.[id];
    const note = v?.items.find((x) => x.at === at);
    if (!note) return { store, note: null, meta: null };
    const meta = { title: v.title, channel: v.channel, len: v.len };
    const items = v.items.filter((x) => x !== note);
    const next = { ...store };
    if (items.length) next[id] = { ...v, items };
    else delete next[id];
    return { store: next, note, meta };
  }

  /** «Вернуть» удалённую: та же секунда, текст и at. */
  function restoreNote(store, id, note, meta = {}) {
    if (!note) return { store, note: null };
    const v = store?.[id];
    if (v?.items.some((x) => x.at === note.at)) return { store, note: v.items.find((x) => x.at === note.at) };
    return addNote(store, id, note, meta);
  }

  /** Подставить название, канал и длину, если их не было (видео открыли в библиотеке). */
  function setMeta(store, id, meta) {
    const v = store?.[id];
    if (!v) return { store };
    const next = withMeta(v, meta);
    if (next.title === v.title && next.channel === v.channel && next.len === v.len) return { store };
    return { store: { ...store, [id]: next } };
  }

  /** Два хранилища в одно (восстановление из резервной копии): заметки — объединение по at. */
  function mergeStores(a, b) {
    const A = cleanStore(a);
    const B = cleanStore(b);
    const out = { ...A };
    let added = 0;
    for (const [id, v] of Object.entries(B)) {
      const cur = out[id];
      if (!cur) {
        out[id] = v;
        added += v.items.length;
        continue;
      }
      const have = new Set(cur.items.map((x) => x.at));
      const more = v.items.filter((x) => !have.has(x.at));
      added += more.length;
      out[id] = withMeta({ ...cur, items: cleanItems([...cur.items, ...more]), at: Math.max(cur.at, v.at) }, cur.title ? {} : v);
    }
    return { store: cleanStore(out), added };
  }

  /** Список видео для показа: свежие изменения — первыми. */
  function videos(store) {
    return Object.entries(store || {})
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
  }

  function count(store) {
    const vs = Object.values(store || {});
    return { videos: vs.length, notes: vs.reduce((n, v) => n + (v.items?.length || 0), 0) };
  }

  const norm = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е");
  const words = (q) => norm(q).split(/\s+/).filter(Boolean);

  /**
   * Поиск: каждое слово запроса должно найтись в тексте заметки, названии или канале.
   * → видео (как videos()), у каждого items — только подошедшие заметки, total — всего у видео.
   */
  function search(store, q) {
    const ws = words(q);
    const all = videos(store);
    if (!ws.length) return all.map((v) => ({ ...v, total: v.items.length }));
    const out = [];
    for (const v of all) {
      const meta = norm(`${v.title} ${v.channel}`);
      const items = v.items.filter((n) => {
        const hay = `${norm(n.text)} ${meta} ${fmtTime(n.t)}`;
        return ws.every((w) => hay.includes(w));
      });
      if (items.length) out.push({ ...v, items, total: v.items.length });
    }
    return out;
  }

  const noteLink = (id, t) => `https://youtu.be/${id}${int(t) > 0 ? `?t=${int(t)}` : ""}`;
  const watchUrl = (id, t) => `https://www.youtube.com/watch?v=${id}${int(t) > 0 ? `&t=${int(t)}s` : ""}`;

  const plural = (n, one, few, many) => {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many;
  };
  const notesWord = (n) => `${n} ${plural(n, "заметка", "заметки", "заметок")}`;

  // текст одного видео: название — канал, ссылка, заметки строками «12:34 — текст — ссылка»
  function videoLines(v) {
    const head = [v.title || "Видео YouTube", v.channel].filter(Boolean).join(" — ");
    return [head, noteLink(v.id), ...v.items.map((n) => `${fmtTime(n.t)} — ${n.text} — ${noteLink(v.id, n.t)}`)];
  }

  /** «Копировать все»: видео через пустую строку. */
  function exportText(list) {
    return (list || []).map((v) => videoLines(v).join("\n")).join("\n\n");
  }

  /**
   * Для Telegram: одно сообщение не длиннее max. Не влезло — обрезаем по целой заметке
   * и дописываем, сколько не вошло. → { text, cut } (cut — сколько заметок не вошло).
   */
  function tgText(list, max = TG_MAX) {
    const total = (list || []).reduce((n, v) => n + v.items.length, 0);
    const full = exportText(list);
    if (full.length <= max) return { text: full, cut: 0 };
    const tail = (k) => (k > 0 ? `\n\n…и ещё ${notesWord(k)} — целиком в «Моей библиотеке» → «Заметки» → «Копировать все».` : "");
    let out = "";
    let used = 0;
    for (const v of list) {
      const lines = videoLines(v);
      let block = `${lines[0]}\n${lines[1]}`;
      let took = 0;
      for (const line of lines.slice(2)) {
        const cand = `${out ? `${out}\n\n` : ""}${block}\n${line}`;
        if (cand.length + tail(total - used - took - 1).length > max) break;
        block += `\n${line}`;
        took++;
      }
      if (took) {
        out = `${out ? `${out}\n\n` : ""}${block}`;
        used += took;
      }
      if (took < lines.length - 2) break;
    }
    const cut = total - used;
    return { text: out + tail(cut), cut };
  }

  globalThis.__ytcsNotesCore = {
    KEY,
    MAX_TEXT,
    MAX_NOTES,
    TG_MAX,
    ID_RE,
    fmtTime,
    cleanText,
    cleanStore,
    addNote,
    updateNote,
    removeNote,
    restoreNote,
    setMeta,
    mergeStores,
    videos,
    count,
    search,
    words,
    norm,
    noteLink,
    watchUrl,
    notesWord,
    exportText,
    tgText,
  };
})();
