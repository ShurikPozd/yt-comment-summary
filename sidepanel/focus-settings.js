// Блок «Без отвлечений» в настройках панели. Отдельный модуль: сам читает и
// пишет chrome.storage.local.settings (focusMode и focus*), sidepanel.js только
// подхватывает изменения, чтобы его «Сохранить» не вернуло старые значения.
// Что и как прячется на странице — focus.js; список пунктов и значения по
// умолчанию — те же, что там.

// [ключ, название, пояснение, по умолчанию]
const PARTS = [
  ["focusShorts", "Shorts", "Полки и плитки Shorts на главной, в подписках и в поиске, вкладка Shorts в меню слева.", true],
  ["focusRelated", "Рекомендации справа", "Вместо них — карточка с кнопками «Очередь» и «Моя библиотека». Панель очереди остаётся на месте.", true],
  ["focusEndscreen", "Заставки и карточки поверх видео", "Сетка видео и обратный отсчёт в конце, «Ещё видео» на паузе. Чужая рекомендация сама не откроется; плейлисты идут как обычно.", true],
  ["focusComments", "Комментарии под видео", "Сводка комментариев в этой панели работает как прежде.", false],
  ["focusCounts", "Счётчики", "Просмотры, лайки, подписчики и число комментариев — чтобы выбирать по теме, а не по цифрам.", false],
  ["focusHome", "Главная лента целиком", "Вместо неё — поиск и кнопки «Очередь», «Моя библиотека», «Подписки» по центру. Самый строгий вариант.", false],
];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function render() {
  const box = $("focus-opts");
  if (!box || box.childElementCount) return;
  box.innerHTML = PARTS.map(
    ([key, title, hint]) => `
      <label class="switch-row">
        <span class="sw-text">
          <span class="sw-title">${esc(title)}</span>
          <span class="hint">${esc(hint)}</span>
        </span>
        <input type="checkbox" class="switch" data-focus="${key}" />
      </label>`
  ).join("");
}

function fill(settings) {
  const s = settings || {};
  const on = Boolean(s.focusMode);
  const sw = $("set-focus");
  if (sw) sw.checked = on;
  $("focus-opts")?.classList.toggle("off", !on);
  for (const [key, , , def] of PARTS) {
    const input = document.querySelector(`#focus-opts input[data-focus="${key}"]`);
    if (input) input.checked = s[key] === undefined ? def : Boolean(s[key]);
  }
}

async function patch(fn) {
  const s = (await chrome.storage.local.get("settings")).settings || {};
  fn(s);
  await chrome.storage.local.set({ settings: s }); // все вкладки YouTube подхватят сразу
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
  if (!$("focus-opts") || !$("set-focus")) return;
  render();
  chrome.storage.local.get("settings").then((o) => fill(o.settings));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) fill(changes.settings.newValue);
  });
  $("set-focus").addEventListener("change", (e) => {
    const on = e.target.checked;
    $("focus-opts").classList.toggle("off", !on);
    void patch((s) => (s.focusMode = on));
    toast(on ? "Режим без отвлечений включён" : "Режим без отвлечений выключен");
  });
  $("focus-opts").addEventListener("change", (e) => {
    const key = e.target.closest("input[data-focus]")?.dataset.focus;
    if (!key) return;
    const checked = e.target.checked;
    void patch((s) => {
      s[key] = checked;
    });
  });
}

init();
