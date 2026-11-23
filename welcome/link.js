// Ссылка «Что умеет расширение» — в настройках боковой панели и кнопкой «?» в
// шапке «Моей библиотеки». Элементы с атрибутом data-welcome открывают страницу
// (уже открытая — переключаемся на неё). После крупного обновления (метка
// whatsNew от welcome-bg.js) у них точка «новое», а в панели — плашка сверху.
// В панели здесь же — переход в настройки по просьбе страницы (panelGoto).

const WELCOME_URL = chrome.runtime.getURL("welcome/welcome.html");
const KEY = "whatsNew";
const minor = (v) => String(v || "").split(".").slice(0, 2).join(".");

export async function openWelcome(hash = "") {
  const [open] = await chrome.tabs.query({ url: WELCOME_URL + "*" }).catch(() => []);
  if (open?.id) {
    await chrome.tabs.update(open.id, { active: true, ...(hash ? { url: WELCOME_URL + hash } : {}) }).catch(() => {});
    chrome.windows.update(open.windowId, { focused: true }).catch(() => {});
    return;
  }
  await chrome.tabs.create({ url: WELCOME_URL + hash }).catch(() => {});
}

function paint(wn) {
  const on = Boolean(wn?.to);
  for (const el of document.querySelectorAll("[data-welcome]")) {
    el.classList.toggle("has-new", on);
    const pill = el.querySelector(".wr-new");
    if (pill) pill.hidden = !on;
  }
  const strip = document.getElementById("whatsnew");
  if (!strip) return;
  strip.hidden = !on;
  if (!on) return;
  strip.innerHTML = `<span class="wn-dot" aria-hidden="true"></span>
    <span class="wn-text">Новая версия ${minor(wn.to)}</span>
    <button type="button" class="wn-open">Что нового</button>
    <button type="button" class="wn-close" title="Скрыть" aria-label="Скрыть">✕</button>`;
}

document.addEventListener("click", (e) => {
  const t = e.target;
  if (t.closest?.("#whatsnew .wn-open")) return void openWelcome("#news");
  if (t.closest?.("#whatsnew .wn-close")) return void chrome.storage.local.remove(KEY).catch(() => {});
  if (t.closest?.("[data-welcome]")) void openWelcome();
});

chrome.storage.local.get(KEY).then((r) => paint(r[KEY]), () => {});

// страница «Что умеет расширение» попросила открыть настройки панели
function gotoSettings(req) {
  if (!req || req.view !== "settings" || Date.now() - (req.at || 0) > 15000) return;
  void chrome.storage.session.remove("panelGoto").catch(() => {});
  const app = document.getElementById("app");
  const btn = document.getElementById("btn-open-settings");
  if (!app || !btn) return;
  // панель могла только что открыться: обработчики и возврат к прошлой вкладке
  // приходят позже — жмём, пока настройки не останутся на экране (до 5 с)
  let acted = false;
  const stop = () => (acted = true);
  document.addEventListener("pointerdown", stop, { once: true, capture: true });
  const until = Date.now() + 5000;
  (function tick() {
    if (acted) return;
    if (!app.classList.contains("on-settings")) btn.click();
    if (Date.now() < until) setTimeout(tick, 250);
    else document.removeEventListener("pointerdown", stop, true);
  })();
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && KEY in ch) paint(ch[KEY].newValue);
  if (area === "session" && ch.panelGoto?.newValue) gotoSettings(ch.panelGoto.newValue);
});
if (document.getElementById("btn-open-settings")) {
  chrome.storage.session.get("panelGoto").then((r) => gotoSettings(r.panelGoto), () => {});
}
