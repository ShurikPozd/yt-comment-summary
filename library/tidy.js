// «Моя библиотека»: «Порядок в плейлистах» — удалённые видео, повторы, видео во многих плейлистах.
//
//   - Удалённые и скрытые («[Удалённое видео]», «[Скрытое видео]») — каталог
//     запоминает их отдельно (cat.gone); «Убрать» — из всех плейлистов разом.
//   - Повторы — одно видео дважды в одном плейлисте: убираются лишние копии
//     по внутреннему номеру записи (setVideoId), первая остаётся. Проверено
//     вживую: YouTube убирает ровно эту запись.
//   - Видео в 5+ плейлистах — просто список: щелчок показывает видео поиском.
// Всё через запросы пачками; каталог после этого правится на месте.

import { icon } from "../sidepanel/icons.js";
import { useCatalog } from "./catalog.js";
import { $, esc, inPlWord, nf, state, videosWord } from "./state.js";
import { kv } from "./store.js";
import { update } from "./view-lib.js";
import { releaseTab, yt } from "./youtube.js";

const MANY = 5; // «во многих плейлистах» — от стольких
const CHUNK = 50;
export const tidy = { open: false, busy: "", done: 0, total: 0, msg: "" };

const plTitle = (id) => state.plById.get(id)?.title || id;

export function tidyData() {
  const cat = state.cat;
  if (!cat) return { gone: [], dups: [], many: [] };
  const gone = cat.gone || [];
  const dups = [];
  const many = [];
  for (const v of cat.videos) {
    const byPl = new Map();
    for (const [pid, pos, setId] of v.in) {
      if (!byPl.has(pid)) byPl.set(pid, []);
      byPl.get(pid).push({ pos, setId });
    }
    for (const [pid, list] of byPl) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.pos - b.pos);
      // первую копию оставляем; без номера записи (новый формат) убрать точечно нельзя
      for (const extra of list.slice(1)) if (extra.setId) dups.push({ pid, id: v.id, title: v.title, setId: extra.setId });
    }
    const distinct = [...byPl.keys()].filter((id) => id !== "WL" && id !== "LL");
    if (distinct.length >= MANY) many.push({ v, n: distinct.length });
  }
  many.sort((a, b) => b.n - a.n);
  return { gone, dups, many };
}

export function tidyHtml() {
  if (!tidy.open || !state.cat) return "";
  const { gone, dups, many } = tidyData();
  const plsOf = (list) => new Set(list.map((x) => x.pid)).size;
  const sec = (title, text, body) => `<div class="td-sec"><div class="td-h"><b>${title}</b><span>${text}</span></div>${body}</div>`;
  const busy = tidy.busy
    ? `<div class="td-busy"><b>${esc(tidy.busy)}</b> ${nf.format(tidy.done)} из ${nf.format(tidy.total)}<div class="wl-bar"><div style="width:${tidy.total ? Math.round((tidy.done / tidy.total) * 100) : 0}%"></div></div></div>`
    : "";
  return `<section class="tidy" aria-label="Порядок в плейлистах">
    <div class="td-top"><b>Порядок в плейлистах</b><button type="button" class="ghost" data-td="close">${icon("close", { size: 16 })}Закрыть</button></div>
    ${busy}${tidy.msg ? `<div class="td-msg">${esc(tidy.msg)}</div>` : ""}
    <div class="td-grid">
    ${sec(
      "Удалённые и скрытые",
      gone.length ? `${videosWord(gone.length)} в ${inPlWord(plsOf(gone))}` : "нет",
      gone.length
        ? `<div class="td-list">${gone
            .slice(0, 8)
            .map((g) => `<div class="td-row"><span>${esc(g.title || "[Удалённое видео]")}</span><small>${esc(plTitle(g.pid))}</small></div>`)
            .join("")}${gone.length > 8 ? `<div class="td-more">и ещё ${nf.format(gone.length - 8)}</div>` : ""}</div>
          <button type="button" class="primary" data-td="gone" ${tidy.busy ? "disabled" : ""}>${icon("close", { size: 16 })}Убрать ${videosWord(gone.length)}</button>`
        : `<div class="td-ok">${icon("check", { size: 18 })}Всё на месте</div>`
    )}
    ${sec(
      "Повторы",
      dups.length ? `${nf.format(dups.length)} лишних копий в ${inPlWord(plsOf(dups))} · первые останутся` : "нет",
      dups.length
        ? `<div class="td-list">${dups
            .slice(0, 8)
            .map((d) => `<div class="td-row"><span>${esc(d.title)}</span><small>${esc(plTitle(d.pid))}</small></div>`)
            .join("")}${dups.length > 8 ? `<div class="td-more">и ещё ${nf.format(dups.length - 8)}</div>` : ""}</div>
          <button type="button" class="primary" data-td="dups" ${tidy.busy ? "disabled" : ""}>${icon("close", { size: 16 })}Убрать повторы</button>`
        : `<div class="td-ok">${icon("check", { size: 18 })}Повторов нет</div>`
    )}
    ${sec(
      `В ${MANY} и больше плейлистах`,
      many.length ? videosWord(many.length) : "нет",
      many.length
        ? `<div class="td-list">${many
            .slice(0, 12)
            .map(({ v, n }) => `<button type="button" class="td-row td-link" data-td-find="${esc(v.title)}"><span>${esc(v.title)}</span><small>${nf.format(n)} ${n % 10 >= 5 || n % 10 === 0 || (n % 100 > 10 && n % 100 < 20) ? "плейлистов" : "плейлиста"}</small></button>`)
            .join("")}</div>`
        : `<div class="td-ok">${icon("check", { size: 18 })}Таких нет</div>`
    )}
    </div>
    <div class="td-note">По списку на момент последнего обновления. Убранное нельзя вернуть одной кнопкой — YouTube этого не умеет; удалённые видео вернуть и так нельзя.</div>
  </section>`;
}

export function renderTidy() {
  const box = $("#tidy");
  if (!box) return;
  box.innerHTML = tidyHtml();
  box.hidden = !tidy.open;
}

// убрать записи из плейлистов: по номеру записи (точно эту) или по id видео (все его копии)
async function removeItems(items, label) {
  const byPl = new Map();
  for (const it of items) {
    if (!byPl.has(it.pid)) byPl.set(it.pid, []);
    byPl.get(it.pid).push(it);
  }
  tidy.busy = label;
  tidy.done = 0;
  tidy.total = items.length;
  tidy.msg = "";
  renderTidy();
  const done = [];
  try {
    for (const [pid, list] of byPl) {
      for (let i = 0; i < list.length; i += CHUNK) {
        const part = list.slice(i, i + CHUNK);
        await yt("removeItems", { playlistId: pid, items: part.map((x) => (x.setId ? { setId: x.setId } : { videoId: x.id })) });
        done.push(...part);
        tidy.done = done.length;
        renderTidy();
      }
    }
  } catch (e) {
    tidy.msg = `Убрано ${nf.format(done.length)} из ${nf.format(items.length)}: ${e.message || "YouTube не ответил"}. Можно повторить.`;
  } finally {
    tidy.busy = "";
    await releaseTab();
  }
  return done;
}

async function cleanGone() {
  const gone = state.cat.gone || [];
  const done = await removeItems(gone, "Убираю удалённые видео…");
  const key = (g) => `${g.pid}|${g.setId || g.id}`;
  const removed = new Set(done.map(key));
  state.cat.gone = gone.filter((g) => !removed.has(key(g)));
  for (const p of state.cat.playlists) p.count = Math.max(0, (p.count || 0) - done.filter((g) => g.pid === p.id).length);
  if (!tidy.msg) tidy.msg = `Готово: убрано ${videosWord(done.length)}.`;
  await saveCat();
}

async function cleanDups() {
  const { dups } = tidyData();
  const done = await removeItems(dups, "Убираю повторы…");
  const gone = new Set(done.map((d) => d.setId));
  for (const v of state.cat.videos) v.in = v.in.filter(([, , setId]) => !setId || !gone.has(setId));
  for (const p of state.cat.playlists) p.count = Math.max(0, (p.count || 0) - done.filter((d) => d.pid === p.id).length);
  if (!tidy.msg) tidy.msg = `Готово: убрано повторов — ${nf.format(done.length)}.`;
  await saveCat();
}

async function saveCat() {
  await kv("catalog", state.cat);
  useCatalog(state.cat, { keep: true });
  renderTidy();
}

export function toggleTidy(on = !tidy.open) {
  tidy.open = on;
  tidy.msg = "";
  renderTidy();
  if (on) $("#tidy")?.scrollIntoView({ block: "start", behavior: "smooth" });
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-td]")?.dataset.td;
  const find = e.target.closest("[data-td-find]")?.dataset.tdFind;
  if (find) {
    // показать это видео в библиотеке — поиском по названию
    $("#q").value = state.q = find;
    toggleTidy(false);
    return update();
  }
  if (!t || tidy.busy) return;
  if (t === "close") toggleTidy(false);
  else if (t === "open") toggleTidy(true);
  else if (t === "gone") void cleanGone();
  else if (t === "dups") void cleanDups();
});
