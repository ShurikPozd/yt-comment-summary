// «Моя библиотека»: сбор каталога плейлистов и построение поискового индекса.

import { buildIndex } from "./search.js";
import { $, SPECIAL, WORKERS, inPlWord, state, videosWord } from "./state.js";
import { kv } from "./store.js";
import { renderEmpty, renderSync, update } from "./view-lib.js";
import { releaseTab, yt } from "./youtube.js";

// ---------- сбор каталога ----------
export const ERRORS = {
  loggedout: "Войдите в аккаунт YouTube в этом браузере — и нажмите «Повторить».",
  denied: "YouTube не принял запрос. Обновите любую вкладку YouTube (F5) и повторите.",
  tab: "Не получилось подключиться к вкладке YouTube. Откройте youtube.com и повторите.",
  noreply: "YouTube не ответил. Обновите вкладку YouTube (F5) и повторите.",
  fail: "Не получилось прочитать плейлисты. Повторите чуть позже.",
};

export async function sync() {
  if (state.syncing) return;
  state.syncing = true;
  state.error = "";
  state.progress = { done: 0, total: 0, videos: 0 };
  renderSync();
  if (!state.cat) renderEmpty();
  try {
    const pls = await yt("playlists");
    if (!pls.some((p) => p.id === "LL")) pls.push({ id: "LL", title: "Понравившиеся", privacy: "PRIVATE" });
    const thumbs = new Map();
    await yt("library")
      .then((lib) => lib.forEach((x) => x.thumb && thumbs.set(x.id, x.thumb)))
      .catch(() => {});
    state.progress.total = pls.length;
    renderSync();

    const videos = new Map();
    const queue = pls.slice();
    let fatal = null;
    const worker = async () => {
      while (queue.length && !fatal) {
        const p = queue.shift();
        let token = null;
        let n = 0;
        try {
          for (let page = 0; page < 300; page++) {
            const r = await yt("page", { playlistId: p.id, token, from: n });
            for (const v of r.items) {
              if (!v.id) continue;
              n++;
              let rec = videos.get(v.id);
              if (!rec) {
                // удалённые и скрытые («[Удалённое видео]») — без канала и длительности
                if (!v.channel && !v.short && /^\[.*\]$/.test(v.title)) continue;
                videos.set(v.id, (rec = { id: v.id, title: v.title, channel: v.channel, channelId: v.channelId, len: v.len, short: Boolean(v.short), info: v.info, in: [] }));
                state.progress.videos++;
              }
              rec.in.push([p.id, v.pos]);
            }
            token = r.next;
            if (!token) break;
          }
        } catch (e) {
          if (["loggedout", "denied", "tab"].includes(e.code)) fatal = e;
          p.failed = true;
        }
        p.count = n;
        p.thumb = thumbs.get(p.id) || "";
        state.progress.done++;
        renderSync();
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    if (fatal) throw fatal;
    // не прочитался плейлист — берём его видео из прошлого каталога, а не теряем из поиска
    const prev = state.cat;
    for (const p of pls.filter((x) => x.failed && prev)) {
      const old = prev.playlists.find((x) => x.id === p.id);
      if (old) p.count = old.count;
      for (const v of prev.videos) {
        const mine = v.in.filter(([id]) => id === p.id);
        if (!mine.length) continue;
        let rec = videos.get(v.id);
        if (!rec) videos.set(v.id, (rec = { ...v, in: [] }));
        rec.in.push(...mine);
      }
    }

    const cat = {
      v: 1,
      syncedAt: Date.now(),
      playlists: pls.filter((p) => !(p.id === "LL" && p.failed && !p.count)).map(({ id, title, privacy, count, thumb, failed }) => ({ id, title, privacy, count, thumb, failed: Boolean(failed) })),
      videos: [...videos.values()],
    };
    await kv("catalog", cat);
    useCatalog(cat, { keep: Boolean(state.cat) }); // обновили в фоне — не сбиваем прокрутку
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
