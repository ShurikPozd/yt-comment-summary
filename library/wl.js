// «Моя библиотека»: перенос «Смотреть позже» в очередь и его расчистка на YouTube.
//
// У YouTube в «Смотреть позже» предел 5000 видео, у нашей очереди его нет (и она
// умнее: место просмотра, подборка, галерея). Шаги:
//   1. «Перенести в очередь» — видео из каталога библиотеки (в порядке плейлиста)
//      встают в очередь; уже лежащие там не задваиваются.
//   2. «Очистить «Смотреть позже»» — отдельный шаг с подтверждением: убирает из
//      плейлиста на YouTube только то, что уже есть в очереди, пачками по 50 за
//      запрос. Перед этим список сохраняется — «Вернуть обратно» вернёт всё.

import { icon } from "../sidepanel/icons.js";
import { useCatalog } from "./catalog.js";
import { loadQueue, qmsg, renderQueueSide } from "./queue-view.js";
import { $, esc, nf, state, videosWord } from "./state.js";
import { kv } from "./store.js";
import { shrink } from "./sync-plan.js";
import { ago } from "./view-lib.js";
import { releaseTab, yt } from "./youtube.js";

const CHUNK = 50; // действий в одном запросе к YouTube
export const wl = { busy: "", done: 0, total: 0, error: "", confirm: false, backup: null };

chrome.storage.local.get("wlBackup").then(({ wlBackup }) => {
  wl.backup = wlBackup?.ids?.length ? wlBackup : null;
  if (state.view === "queue") renderQueueSide();
});

// видео «Смотреть позже» из каталога — в порядке плейлиста
export function wlVideos() {
  return (state.cat?.videos || [])
    .map((v) => ({ v, pos: v.in.find(([id]) => id === "WL")?.[1] }))
    .filter((x) => x.pos != null)
    .sort((a, b) => a.pos - b.pos)
    .map((x) => x.v);
}

export function wlCardHtml() {
  const list = wlVideos();
  if (!list.length && !wl.backup && !wl.busy) return "";
  const inQ = new Set(state.queue.map((x) => x.id));
  const notIn = list.filter((v) => !inQ.has(v.id)).length;
  const when = state.cat?.syncedAt ? `<small>По списку на ${esc(ago(state.cat.syncedAt))}. Обновить его — «Плейлисты» → «Обновить».</small>` : "";
  let body;
  if (wl.busy) {
    const pct = wl.total ? Math.round((wl.done / wl.total) * 100) : 0;
    body = `<div><b>${wl.busy}</b> ${nf.format(wl.done)} из ${nf.format(wl.total)}</div>
      <div class="wl-bar"><div style="width:${pct}%"></div></div>`;
  } else if (wl.confirm) {
    const n = list.filter((v) => inQ.has(v.id)).length;
    body = `<div><b>Убрать ${videosWord(n)} из «Смотреть позже» на YouTube?</b> В очереди они останутся. Список сохранится — можно будет вернуть.</div>
      <div class="row"><button type="button" class="primary" data-act="wl-clear-yes">${icon("check", { size: 16 })}Очистить</button>
      <button type="button" class="ghost" data-act="wl-cancel">Отмена</button></div>`;
  } else if (list.length && notIn) {
    body = `<div><b>«Смотреть позже»: ${videosWord(list.length)}</b>${notIn < list.length ? `, из них ${nf.format(notIn)} ещё не в очереди` : ""}. В очереди нет предела в 5000 и помнится, где вы остановились.</div>
      <div class="row"><button type="button" class="primary" data-act="wl-move">${icon("download", { size: 16 })}Перенести в очередь</button></div>${when}`;
  } else if (list.length) {
    body = `<div><b>Всё из «Смотреть позже» уже в очереди</b> (${videosWord(list.length)}). Можно расчистить его на YouTube — там предел 5000 видео.</div>
      <div class="row"><button type="button" class="ghost" data-act="wl-clear">${icon("close", { size: 16 })}Очистить «Смотреть позже»</button></div>${when}`;
  } else {
    body = `<div><b>«Смотреть позже» расчищен</b> — ${videosWord(wl.backup.ids.length)} ${esc(ago(wl.backup.at))} перенесены в очередь.</div>
      <div class="row"><button type="button" class="ghost" data-act="wl-restore" title="Вернуть эти видео обратно в «Смотреть позже» на YouTube">${icon("history", { size: 16 })}Вернуть обратно</button></div>`;
  }
  return `<div class="q-card q-wl" role="status">${body}${wl.error ? `<div class="wl-err">${esc(wl.error)}</div>` : ""}</div>`;
}

async function wlMove() {
  const items = wlVideos().map((v) => ({ id: v.id, title: v.title, channel: v.channel, len: v.len, short: v.short }));
  wl.error = "";
  const r = await qmsg({ type: "queue:add", items });
  if (!r?.ok) wl.error = "Не получилось добавить в очередь — обновите страницу библиотеки.";
  await loadQueue();
  renderQueueSide();
}

// пачками: действие «добавить/убрать» для многих видео одним запросом
async function editMany(ids, add, label) {
  wl.busy = label;
  wl.done = 0;
  wl.total = ids.length;
  wl.error = "";
  renderQueueSide();
  const done = [];
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      await yt("editMany", { playlistId: "WL", videoIds: part, add });
      done.push(...part);
      wl.done = done.length;
      renderQueueSide();
    }
  } catch (e) {
    wl.error = add
      ? `Вернулось ${nf.format(done.length)} из ${nf.format(ids.length)}: ${e.message || "YouTube не ответил"}. Можно повторить.`
      : `Убрано ${nf.format(done.length)} из ${nf.format(ids.length)}: ${e.message || "YouTube не ответил"}. Можно повторить.`;
  } finally {
    wl.busy = "";
    await releaseTab();
  }
  return done;
}

async function wlClear() {
  wl.confirm = false;
  const inQ = new Set(state.queue.map((x) => x.id));
  const ids = wlVideos()
    .map((v) => v.id)
    .filter((id) => inQ.has(id)); // убираем только то, что уже в очереди
  if (!ids.length) return renderQueueSide();
  // сначала — сохранить список (для «Вернуть обратно»), потом убирать
  const prev = wl.backup?.ids || [];
  wl.backup = { at: Date.now(), ids: [...new Set([...prev, ...ids])] };
  await chrome.storage.local.set({ wlBackup: wl.backup });
  const removed = new Set(await editMany(ids, false, "Убираю из «Смотреть позже»…"));
  // каталог: этих видео в «Смотреть позже» больше нет
  if (removed.size && state.cat) {
    let n = 0;
    for (const v of state.cat.videos)
      if (removed.has(v.id)) {
        const was = v.in.length;
        v.in = v.in.filter(([id]) => id !== "WL");
        n += was - v.in.length;
      }
    shrink(state.cat.playlists.find((p) => p.id === "WL"), n);
    await kv("catalog", state.cat);
    useCatalog(state.cat, { keep: true });
  }
  renderQueueSide();
}

async function wlRestore() {
  if (!wl.backup?.ids?.length) return;
  const back = await editMany(wl.backup.ids, true, "Возвращаю в «Смотреть позже»…");
  if (back.length === wl.backup.ids.length) {
    wl.backup = null;
    await chrome.storage.local.remove("wlBackup");
    wl.error = "Вернул. Чтобы библиотека увидела их снова — «Плейлисты» → «Обновить».";
  } else {
    wl.backup = { ...wl.backup, ids: wl.backup.ids.filter((id) => !back.includes(id)) };
    await chrome.storage.local.set({ wlBackup: wl.backup });
  }
  renderQueueSide();
}

document.addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act?.startsWith("wl-") || wl.busy) return;
  if (act === "wl-move") void wlMove();
  else if (act === "wl-clear") {
    wl.confirm = true;
    renderQueueSide();
  } else if (act === "wl-cancel") {
    wl.confirm = false;
    renderQueueSide();
  } else if (act === "wl-clear-yes") void wlClear();
  else if (act === "wl-restore") void wlRestore();
});
