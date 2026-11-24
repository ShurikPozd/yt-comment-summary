// «Моя библиотека»: резервная копия — в файл и обратно.
//
// В файл (JSON) попадает: очередь и где вы остановились, настройки очереди и
// расширения (БЕЗ секрета бота — `settings.token` вырезается), список плейлистов
// и видео в них (каталог библиотеки). Восстановление: очередь — заменить или
// добавить к своей; каталог — сразу для поиска, без сбора с YouTube; настройки —
// по желанию. Сами плейлисты на YouTube файл не меняет.

import { collectBackup } from "../backup-core.js";
import { icon } from "../sidepanel/icons.js";
import { useCatalog } from "./catalog.js";
import { loadQueue, qmsg, renderQueueSide } from "./queue-view.js";
import { $, esc, inPlWord, nf, state, videosWord } from "./state.js";
import { kv } from "./store.js";
import { ago } from "./view-lib.js";

const FORMAT = "ytcs-backup";
const AUTO_KEY = "autoBackup"; // backup-bg.js: { on, at, err, tried, size }
export const bk = { open: false, msg: "", err: "", file: null };

// что в копии — общее с автокопией в Telegram (backup-core.js)
const collect = () => collectBackup(state.cat);

async function exportFile() {
  const data = await collect();
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const a = document.createElement("a");
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  a.href = URL.createObjectURL(blob);
  a.download = `youtube-библиотека-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  bk.err = "";
  bk.msg = `Сохранено: очередь — ${videosWord(data.queue.length)}${data.catalog ? `, плейлисты — ${nf.format(data.catalog.playlists.length)} (${videosWord(data.catalog.videos.length)})` : ""}. Секрет бота в файл не попал.`;
  render();
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

async function pickFile(file) {
  bk.msg = bk.err = "";
  try {
    const data = JSON.parse(await readFile(file));
    if (data?.format !== FORMAT || !Array.isArray(data.queue)) throw new Error("bad");
    bk.file = data;
  } catch (e) {
    bk.file = null;
    bk.err = "Это не файл резервной копии библиотеки.";
  }
  render();
}

async function restore(mode) {
  const d = bk.file;
  if (!d) return;
  const items = d.queue
    .filter((x) => /^[A-Za-z0-9_-]{11}$/.test(x?.id || ""))
    .map((x) => ({ id: x.id, title: x.title, channel: x.channel, len: x.len, short: x.short, t: d.queuePos?.[x.id] || 0 }));
  if (mode === "replace" && state.queue.length) await qmsg({ type: "queue:remove", ids: state.queue.map((x) => x.id) });
  const r = await qmsg({ type: "queue:add", items });
  if ($("#bk-opts")?.checked) {
    // настройки — свои, секрет бота оставляем тот, что уже есть
    const cur = (await chrome.storage.local.get("settings")).settings || {};
    await chrome.storage.local.set({ settings: { ...cur, ...(d.settings || {}), token: cur.token } });
    if (d.queueOpts) await qmsg({ type: "queue:opts", patch: d.queueOpts });
    const p = d.prefs || {};
    const patch = {};
    if (Array.isArray(p.plRecent)) patch.plRecent = p.plRecent;
    if (typeof p.libWatchHere === "boolean") patch.libWatchHere = p.libWatchHere;
    if (p.libraryWhere === "tab" || p.libraryWhere === "panel") patch.libraryWhere = p.libraryWhere;
    await chrome.storage.local.set(patch);
  }
  let catMsg = "";
  if (d.catalog?.videos?.length && (!state.cat || d.catalog.syncedAt > state.cat.syncedAt)) {
    const cat = { v: 1, ...d.catalog };
    await kv("catalog", cat);
    useCatalog(cat, { keep: true });
    catMsg = `, плейлисты — ${nf.format(cat.playlists.length)} по списку на ${ago(cat.syncedAt)}`;
  }
  await loadQueue();
  if (state.view === "queue") renderQueueSide();
  bk.file = null;
  bk.msg = `Восстановлено: в очередь — ${videosWord(r?.added?.length ?? items.length)} ${mode === "replace" ? "(очередь заменена)" : "(добавлено к вашей)"}${catMsg}.`;
  render();
}

function html() {
  const d = bk.file;
  const preview = d
    ? `<div class="bk-file">
        <div><b>Файл от ${esc(new Date(d.at).toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" }))}</b></div>
        <div>Очередь — ${videosWord(d.queue.length)}${d.catalog ? ` · плейлисты — ${nf.format(d.catalog.playlists.length)} (${videosWord(d.catalog.videos.length)})` : ""}</div>
        <label class="bk-check"><input type="checkbox" id="bk-opts" checked /> Восстановить и настройки (секрет бота не трогается)</label>
        <div class="row">
          <button type="button" class="primary" data-bk="add">${icon("download", { size: 16 })}Добавить к очереди</button>
          <button type="button" class="ghost" data-bk="replace">Заменить очередь</button>
          <button type="button" class="ghost" data-bk="cancel">Отмена</button>
        </div>
      </div>`
    : "";
  return `<section class="tidy bk" aria-label="Резервная копия">
    <div class="td-top"><b>Резервная копия</b><button type="button" class="ghost" data-bk="close">${icon("close", { size: 16 })}Закрыть</button></div>
    <div class="td-grid">
      <div class="td-sec">
        <div class="td-h"><b>Сохранить в файл</b><span>Очередь и где вы остановились, настройки, список плейлистов — ${state.cat ? `${nf.format(state.cat.videos.length)} видео в ${inPlWord(state.cat.playlists.length)}` : "ещё не собран"}. Без секрета бота.</span></div>
        <button type="button" class="primary" data-bk="export">${icon("file", { size: 16 })}Сохранить копию</button>
      </div>
      <div class="td-sec">
        <div class="td-h"><b>Восстановить из файла</b><span>На новом браузере или если что-то потерялось. Плейлисты на YouTube файл не меняет.</span></div>
        ${preview || `<label class="ghost bk-pick">${icon("history", { size: 16 })}Выбрать файл…<input type="file" accept=".json,application/json" data-bk-file hidden /></label>`}
      </div>
      <div class="td-sec bk-tg">
        <div class="td-h"><b>Копия в Telegram</b><span>${autoLine()}</span></div>
        <div class="row">
          <button type="button" class="ghost" data-bk="tg" ${bk.sending ? "disabled" : ""}>${icon("send", { size: 16 })}${bk.sending ? "Отправляю…" : "Отправить сейчас"}</button>
          <label class="bk-check"><input type="checkbox" data-bk-auto ${bk.auto?.on === false ? "" : "checked"} /> Раз в неделю сама</label>
        </div>
      </div>
    </div>
    ${bk.msg ? `<div class="td-msg ok">${esc(bk.msg)}</div>` : ""}${bk.err ? `<div class="td-msg wl-err">${esc(bk.err)}</div>` : ""}
  </section>`;
}

// «Копия в Telegram»: когда была последняя, что не так
function autoLine() {
  const a = bk.auto || {};
  const last = a.at ? `Последняя — ${ago(a.at)}${a.size ? ` (${Math.max(1, Math.round(a.size / 1024))} КБ)` : ""}.` : "Ещё не отправлялась.";
  const err = a.err ? ` Не получилось: ${a.err}` : "";
  return `Файл с той же копией — в ваш чат с ботом, раз в неделю или по кнопке. ${last}${err}`;
}

async function loadAuto() {
  bk.auto = (await chrome.storage.local.get(AUTO_KEY))[AUTO_KEY] || {};
}

async function sendNow() {
  bk.sending = true;
  bk.msg = bk.err = "";
  render();
  const r = await chrome.runtime.sendMessage({ type: "backup:send" }).catch((e) => ({ err: String(e?.message || e) }));
  bk.sending = false;
  await loadAuto();
  if (r?.err) bk.err = `Копия не отправилась: ${r.err}`;
  else bk.msg = "Копия отправлена — файл в вашем чате с ботом.";
  render();
}

function render() {
  const box = $("#backup");
  if (!box) return;
  box.hidden = !bk.open;
  box.innerHTML = bk.open ? html() : "";
}

export function toggleBackup(on = !bk.open) {
  bk.open = on;
  bk.msg = bk.err = "";
  bk.file = null;
  render();
  if (on) void loadAuto().then(render);
  if (on) $("#backup")?.scrollIntoView({ block: "start", behavior: "smooth" });
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-bk]")?.dataset.bk;
  if (!a) return;
  if (a === "open") toggleBackup(true);
  else if (a === "close") toggleBackup(false);
  else if (a === "export") void exportFile();
  else if (a === "tg") void sendNow();
  else if (a === "cancel") {
    bk.file = null;
    render();
  } else if (a === "add" || a === "replace") void restore(a);
});
document.addEventListener("change", (e) => {
  if (e.target.matches?.("[data-bk-auto]")) {
    void chrome.runtime.sendMessage({ type: "backup:toggle", on: e.target.checked }).then(loadAuto).then(render);
    return;
  }
  if (e.target.matches?.("[data-bk-file]") && e.target.files?.[0]) void pickFile(e.target.files[0]);
});
