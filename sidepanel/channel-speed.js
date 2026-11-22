// «Скорость по каналам» в блоке «Плеер YouTube»: переключатель и список
// каналов с запомненной скоростью (кнопка «убрать» у каждого).
// Отдельный модуль: сам читает и пишет chrome.storage.local — settings.channelSpeed
// и channelSpeeds (формат и вспомогательные функции — ../speed-core.js).
// sidepanel.js только подхватывает settings.channelSpeed, чтобы его
// «Сохранить» не вернуло старое значение.

const core = globalThis.__ytcsSpeedCore;
const $ = (id) => document.getElementById(id);
const SHOW = 6; // сколько каналов видно, пока не нажали «Показать все»

let map = {};
let all = false;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const X_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';

function render() {
  const box = $("cs-list");
  if (!box) return;
  const items = core.list(map);
  if (!items.length) {
    box.innerHTML = `<p class="cs-empty">Каналов пока нет. Поменяйте скорость в любом видео — канал появится здесь.</p>`;
    return;
  }
  const shown = all ? items : items.slice(0, SHOW);
  const rows = shown
    .map(
      (e) => `
      <li class="cs-row">
        <a class="cs-name" href="https://www.youtube.com/channel/${esc(e.id)}" target="_blank" rel="noopener" title="Открыть канал «${esc(e.n || e.id)}»">${esc(e.n || e.id)}</a>
        <span class="cs-rate">${esc(core.fmtRate(e.r))}</span>
        <button type="button" class="cs-del" data-id="${esc(e.id)}" title="Убрать «${esc(e.n || e.id)}» — снова обычная скорость" aria-label="Убрать канал «${esc(e.n || e.id)}»">${X_ICON}</button>
      </li>`
    )
    .join("");
  const more =
    items.length > SHOW
      ? `<button type="button" class="ghost cs-more">${all ? "Свернуть" : `Показать все (${items.length})`}</button>`
      : "";
  box.innerHTML = `<div class="cs-head"><span>Запомненные каналы</span><span class="cs-count">${items.length}</span></div><ul>${rows}</ul>${more}`;
}

function fill(settings) {
  const on = settings?.channelSpeed !== false;
  const sw = $("set-channel-speed");
  if (sw) sw.checked = on;
  $("cs-list")?.classList.toggle("off", !on);
}

let toastTimer = 0;
function toast(text) {
  const el = $("toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function init() {
  if (!core || !$("cs-list") || !$("set-channel-speed")) return;
  chrome.storage.local.get(["settings", core.storeKey]).then((o) => {
    fill(o.settings);
    map = o[core.storeKey] || {};
    render();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) fill(changes.settings.newValue);
    if (changes[core.storeKey]) {
      map = changes[core.storeKey].newValue || {};
      render();
    }
  });
  $("set-channel-speed").addEventListener("change", async (e) => {
    const on = e.target.checked;
    $("cs-list").classList.toggle("off", !on);
    const s = (await chrome.storage.local.get("settings")).settings || {};
    s.channelSpeed = on;
    await chrome.storage.local.set({ settings: s }); // страница YouTube подхватит сразу
    toast(on ? "Скорость будет запоминаться для каждого канала" : "Скорость больше не запоминается по каналам");
  });
  $("cs-list").addEventListener("click", async (e) => {
    if (e.target.closest(".cs-more")) {
      all = !all;
      render();
      return;
    }
    const del = e.target.closest(".cs-del");
    if (!del) return;
    const name = core.entryOf(map, del.dataset.id)?.n;
    map = core.forget(map, del.dataset.id);
    render();
    await chrome.storage.local.set({ [core.storeKey]: map });
    toast(name ? `«${name}» — снова обычная скорость` : "Канал убран");
  });
}

init();
