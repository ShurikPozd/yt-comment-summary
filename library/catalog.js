// «Моя библиотека»: сбор каталога плейлистов и построение поискового индекса.

import { buildIndex } from "./search.js";
import { $, SPECIAL, WORKERS, inPlWord, state, videosWord } from "./state.js";
import { kv } from "./store.js";
import { renderEmpty, renderSync, update } from "./view-lib.js";
import { fullDue, listsOf, readPlaylist, syncSummary } from "./sync-plan.js";
import { releaseTab, yt } from "./youtube.js";

// ---------- сбор каталога ----------
export const ERRORS = {
  loggedout: "Войдите в аккаунт YouTube в этом браузере — и нажмите «Повторить».",
  denied: "YouTube не принял запрос. Обновите любую вкладку YouTube (F5) и повторите.",
  tab: "Не получилось подключиться к вкладке YouTube. Откройте youtube.com и повторите.",
  noreply: "YouTube не ответил. Обновите вкладку YouTube (F5) и повторите.",
  fail: "Не получилось прочитать плейлисты. Повторите чуть позже.",
};

// Обновление каталога.
//   Быстрое (по умолчанию): у каждого плейлиста читаем первую страницу и сверяем
//   с прошлым разом (sync-plan.js) — неизменившиеся не перечитываем, «Смотреть
//   позже» на тысячи видео обходится одной страницей.
//   Полное ({ full: true }: Shift + «Обновить», а само — раз в сутки): всё заново.
export async function sync({ full = false } = {}) {
  if (state.syncing) return;
  const prev = state.cat;
  full = Boolean(full) || fullDue(prev);
  state.syncing = true;
  state.error = "";
  state.syncNote = null;
  state.progress = { done: 0, total: 0, videos: 0, changed: 0, full };
  renderSync();
  if (!state.cat) renderEmpty();
  try {
    const pls = await yt("playlists");
    if (!pls.some((p) => p.id === "LL")) pls.push({ id: "LL", title: "Понравившиеся", privacy: "PRIVATE" });
    const lib = new Map(); // обложки, число видео и «обновлено» со страницы «Плейлисты»
    await yt("library")
      .then((l) => l.forEach((x) => lib.set(x.id, x)))
      .catch(() => {});
    state.progress.total = pls.length;
    renderSync();

    const oldPl = new Map((prev?.playlists || []).map((p) => [p.id, p]));
    const oldLists = listsOf(prev);
    const videos = new Map();
    const gone = []; // удалённые и скрытые — для «Порядка в плейлистах»
    const take = (pid, v) => {
      let rec = videos.get(v.id);
      if (!rec) {
        // удалённые и скрытые («[Удалённое видео]») — без канала и длительности
        if (!v.channel && !v.short && /^\[.*\]$/.test(v.title)) {
          gone.push({ pid, id: v.id, setId: v.setId || "", title: v.title, pos: v.pos });
          return;
        }
        videos.set(v.id, (rec = { id: v.id, title: v.title, channel: v.channel, channelId: v.channelId, len: v.len, short: Boolean(v.short), info: v.info, in: [] }));
      }
      rec.in.push([pid, v.pos, v.setId || ""]); // номер записи — чтобы убрать именно её (повторы)
    };
    const seen = new Set(); // для счётчика «N видео» в прогрессе
    const queue = pls.slice();
    let fatal = null;
    const worker = async () => {
      while (queue.length && !fatal) {
        const p = queue.shift();
        const fresh = []; // в каталог — только если плейлист дочитался без ошибки
        try {
          const r = await readPlaylist({
            page: (token, from) => yt("page", { playlistId: p.id, token, from }),
            old: oldPl.get(p.id),
            olds: oldLists.get(p.id),
            full,
            lib: lib.get(p.id),
            onItem: (v) => {
              fresh.push(v);
              if (!seen.has(v.id)) state.progress.videos = seen.add(v.id).size;
            },
          });
          for (const v of fresh) take(p.id, v);
          Object.assign(p, { head: r.head, upd: r.upd, reuse: r.reuse, count: r.count, checked: Date.now(), changed: Boolean(prev) && r.changed });
          if (p.changed) state.progress.changed++;
        } catch (e) {
          if (["loggedout", "denied", "tab"].includes(e.code)) fatal = e;
          p.failed = true;
        }
        p.thumb = lib.get(p.id)?.thumb || oldPl.get(p.id)?.thumb || "";
        state.progress.done++;
        renderSync();
      }
    };
    await Promise.all(Array.from({ length: full ? WORKERS : WORKERS + 1 }, worker));
    if (fatal) throw fatal;
    // склеенные с прошлым плейлисты: остаток — из прошлого каталога. После чтения
    // всех, чтобы у видео остались свежие названия, если они попались в других плейлистах
    for (const p of pls) {
      for (const e of p.reuse || []) {
        if (e.g) {
          gone.push({ ...e.g, pos: e.pos });
          continue;
        }
        let rec = videos.get(e.v.id);
        if (!rec) videos.set(e.v.id, (rec = { ...e.v, in: [] }));
        rec.in.push([p.id, e.pos, e.setId]);
      }
    }
    // не прочитался плейлист — берём его видео из прошлого каталога, а не теряем из поиска
    for (const p of pls.filter((x) => x.failed && prev)) {
      const old = oldPl.get(p.id);
      if (old) Object.assign(p, { count: old.count, head: old.head, upd: old.upd, checked: old.checked });
      for (const e of oldLists.get(p.id) || []) {
        if (e.g) {
          gone.push(e.g);
          continue;
        }
        let rec = videos.get(e.v.id);
        if (!rec) videos.set(e.v.id, (rec = { ...e.v, in: [] }));
        rec.in.push([p.id, e.pos, e.setId]);
      }
    }

    const now = Date.now();
    const cat = {
      v: 1,
      syncedAt: now,
      fullAt: full ? now : prev?.fullAt || 0, // последнее полное перечитывание
      // head — сколько видео в плейлисте по словам YouTube, upd — его «Обновлено …»,
      // checked — когда сверяли: по ним быстрое обновление решает, что перечитывать
      playlists: pls
        .filter((p) => !(p.id === "LL" && p.failed && !p.count))
        .map(({ id, title, privacy, count, thumb, failed, head, upd, checked }) => ({ id, title, privacy, count: count || 0, thumb, failed: Boolean(failed), head: head ?? null, upd: upd || "", checked: checked || 0 })),
      videos: [...videos.values()],
      gone,
    };
    await kv("catalog", cat);
    if (prev) {
      const was = new Set(prev.videos.map((v) => v.id));
      const added = cat.videos.filter((v) => !was.has(v.id)).length;
      const removed = was.size - (cat.videos.length - added);
      state.syncNote = { text: syncSummary({ changed: pls.filter((p) => p.changed).length, added, removed }), full, at: now };
    }
    useCatalog(cat, { keep: Boolean(prev) }); // обновили в фоне — не сбиваем прокрутку
  } catch (e) {
    state.error = ERRORS[e.code] || ERRORS.fail;
  } finally {
    state.syncing = false;
    state.progress = null;
    await releaseTab();
    renderSync();
    if (!state.cat) renderEmpty();
  }
}

// ---------- каталог → индекс ----------
export function useCatalog(cat, { keep = false } = {}) {
  state.cat = cat;
  state.plById = new Map(cat.playlists.map((p, i) => [p.id, { ...p, rank: SPECIAL[p.id] ?? i + 2 }]));
  if (state.pl && !state.plById.has(state.pl)) state.pl = "";
  const docs = cat.videos.map((v) => ({
    title: v.title,
    channel: v.channel,
    playlists: v.in.map(([id]) => state.plById.get(id)?.title || ""),
  }));
  state.index = buildIndex(docs);
  // порядок «как в плейлистах»: по первому плейлисту (их порядок — как у YouTube), затем по месту в нём
  state.order = cat.videos.map((v, d) => {
    let best = Infinity;
    for (const [id, pos] of v.in) best = Math.min(best, (state.plById.get(id)?.rank ?? 999) * 100000 + pos);
    return { d, key: best };
  });
  state.order.sort((a, b) => a.key - b.key);
  $("#q").placeholder = `Поиск по ${videosWord(cat.videos.length)} в ${inPlWord(cat.playlists.length)}`;
  update({ keep });
}
