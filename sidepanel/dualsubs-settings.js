// «Двойные субтитры» в настройках панели: переключатель и язык перевода.
// Отдельный модуль: сам читает и пишет chrome.storage.local.settings
// (dualSubs, dualSubsLang), sidepanel.js только не затирает эти ключи.
// Список языков — dualsubs-core.js (подключён обычным скриптом перед модулями),
// показ на странице видео — dualsubs.js.

const $ = (id) => document.getElementById(id);

function core() {
  return globalThis.__ytcsDualCore || null;
}

const langs = () => core()?.["LANGS"] || []; // [код, название]

function render() {
  const sel = $("set-dualsubs-lang");
  if (!sel || sel.options.length) return;
  for (const [code, name] of langs()) sel.add(new Option(name, code));
}

function fill(settings) {
  const s = settings || {};
  const c = core();
  const sw = $("set-dualsubs");
  if (sw) sw.checked = Boolean(s.dualSubs);
  const sel = $("set-dualsubs-lang");
  if (sel && c) sel.value = c.langOf(s.dualSubsLang);
}

async function patch(fn) {
  const s = (await chrome.storage.local.get("settings")).settings || {};
  fn(s);
  await chrome.storage.local.set({ settings: s }); // вкладки YouTube подхватят сразу
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
  if (!$("set-dualsubs") || !$("set-dualsubs-lang") || !core()) return;
  render();
  chrome.storage.local.get("settings").then((o) => fill(o.settings));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) fill(changes.settings.newValue);
  });
  $("set-dualsubs").addEventListener("change", (e) => {
    const on = e.target.checked;
    void patch((s) => (s.dualSubs = on));
    toast(on ? "Двойные субтитры включены" : "Двойные субтитры выключены");
  });
  $("set-dualsubs-lang").addEventListener("change", (e) => {
    const lang = core().langOf(e.target.value);
    void patch((s) => (s.dualSubsLang = lang));
    toast("Язык перевода: " + (langs().find(([c]) => c === lang)?.[1] || lang).toLowerCase());
  });
}

init();
