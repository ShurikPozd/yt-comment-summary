// Настройки пропуска рекламных вставок (SponsorBlock) в блоке «Плеер YouTube».
// Отдельный модуль: сам читает и пишет chrome.storage.local.settings
// (sponsorSkip, sponsorCats) — sidepanel.js только подхватывает изменения,
// чтобы его «Сохранить» не вернуло старые значения. Список категорий и
// значения по умолчанию — как в sponsor.js.

const CATS = [
  ["sponsor", "Реклама спонсора", "#00d400", "skip"],
  ["selfpromo", "Самореклама", "#ffff00", "skip"],
  ["interaction", "Просьба подписаться", "#cc00ff", "skip"],
  ["intro", "Заставка", "#00ffff", "show"],
  ["outro", "Титры", "#0202ed", "show"],
  ["preview", "Повтор", "#008fd6", "show"],
  ["music_offtopic", "Не по теме", "#ff9900", "show"],
  ["filler", "Заполнитель", "#7300ff", "show"],
];
// значение, заголовок столбца, подпись для чтения с экрана и подсказки
const MODES = [
  ["skip", "Пропуск", "Пропускать само"],
  ["show", "Отметка", "Только отметка на полосе прогресса"],
  ["off", "Нет", "Не трогать"],
];

const $ = (id) => document.getElementById(id);

function render() {
  const box = $("sb-cats");
  if (!box || box.childElementCount) return;
  // таблица: строка — вид вставки, столбцы — что с ним делать
  const head = `<div class="sb-head" aria-hidden="true"><span></span>${MODES.map(([, label]) => `<span>${label}</span>`).join("")}</div>`;
  const rows = CATS.map(
    ([id, name, color]) => `
      <div class="sb-row" role="radiogroup" aria-label="${name}">
        <span class="sb-name"><i class="sb-dot" style="--c:${color}"></i>${name}</span>
        ${MODES.map(([m, , title]) => `<label title="${name}: ${title.toLowerCase()}"><input type="radio" name="sb-${id}" value="${m}" aria-label="${title}" /><i class="sb-radio"></i></label>`).join("")}
      </div>`
  ).join("");
  box.innerHTML = head + rows;
}

function fill(settings) {
  const on = settings?.sponsorSkip !== false;
  const sw = $("set-sponsor");
  if (sw) sw.checked = on;
  $("sb-cats")?.classList.toggle("off", !on);
  for (const [id, , , def] of CATS) {
    const v = settings?.sponsorCats?.[id];
    const mode = MODES.some(([m]) => m === v) ? v : def;
    const input = document.querySelector(`input[name="sb-${id}"][value="${mode}"]`);
    if (input) input.checked = true;
  }
}

async function patch(fn) {
  const s = (await chrome.storage.local.get("settings")).settings || {};
  fn(s);
  await chrome.storage.local.set({ settings: s }); // страница YouTube подхватит сразу
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
  if (!$("sb-cats") || !$("set-sponsor")) return;
  render();
  chrome.storage.local.get("settings").then((o) => fill(o.settings));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) fill(changes.settings.newValue);
  });
  $("set-sponsor").addEventListener("change", (e) => {
    const on = e.target.checked;
    $("sb-cats").classList.toggle("off", !on);
    void patch((s) => (s.sponsorSkip = on));
    toast(on ? "Рекламные вставки будут пропускаться" : "Рекламные вставки больше не пропускаются");
  });
  $("sb-cats").addEventListener("change", (e) => {
    const input = e.target.closest('input[type="radio"]');
    if (!input) return;
    const id = input.name.replace(/^sb-/, "");
    void patch((s) => {
      s.sponsorCats = { ...(s.sponsorCats || {}), [id]: input.value };
    });
  });
}

init();
