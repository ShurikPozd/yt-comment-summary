// «Что умеет расширение» (welcome/welcome.html) — фоновая часть.
// • Установка — страница открывается сама, один раз.
// • Крупное обновление (сменилась минорная версия: 0.26 → 0.27) — без новой
//   вкладки: метка whatsNew в storage.local, «NEW» на значке, плашка в панели и
//   точка у кнопки «?» в библиотеке. Страница при открытии метку снимает.
// • Мелкие версии (0.26.1 → 0.26.2) и авто-перезапуск при разработке
//   (devAutoReload в background.js) ничего не показывают.

export const WELCOME_PATH = "welcome/welcome.html";
export const WHATS_NEW_KEY = "whatsNew"; // { from: "0.26.1", to: "0.27.0", at }
const NEW_TEXT = "NEW";
const title = () => chrome.runtime.getManifest().action?.default_title || "Сводка комментариев YouTube";
const minor = (v) => String(v || "").split(".").slice(0, 2).join(".");

/** Значок: «NEW», пока метка не снята. «!» самопроверки важнее — его не трогаем. */
export async function paintWhatsNew() {
  const cur = await chrome.action.getBadgeText({}).catch(() => "");
  if (cur === "!") return;
  const { [WHATS_NEW_KEY]: wn } = await chrome.storage.local.get(WHATS_NEW_KEY);
  if (wn?.to) {
    await chrome.action.setBadgeText({ text: NEW_TEXT }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ color: "#e8002d" }).catch(() => {});
    await chrome.action.setBadgeTextColor?.({ color: "#ffffff" })?.catch(() => {});
    await chrome.action.setTitle({ title: `${title()} — обновилось до ${minor(wn.to)}: что нового — в панели` }).catch(() => {});
  } else if (cur === NEW_TEXT) {
    await chrome.action.setBadgeText({ text: "" }).catch(() => {});
    await chrome.action.setTitle({ title: title() }).catch(() => {});
  }
}

// в Node (check-exports.mjs) chrome нет — только экспорт
globalThis.chrome?.runtime?.onInstalled?.addListener(async ({ reason, previousVersion }) => {
  const ver = chrome.runtime.getManifest().version;
  if (reason === "install") {
    let cur = null;
    try {
      [cur] = (await chrome.tabs.query({ active: true, lastFocusedWindow: true })) || [];
    } catch (e) {
      cur = null; // нет активной вкладки — откроем в конце
    }
    const at = cur ? { index: cur.index + 1, windowId: cur.windowId } : {};
    await chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PATH), ...at }).catch(() => {});
    return;
  }
  if (reason !== "update" || !previousVersion || minor(previousVersion) === minor(ver)) return;
  // несколько обновлений подряд, а страницу ещё не открывали — «новое» считаем от самой старой версии
  const { [WHATS_NEW_KEY]: old } = await chrome.storage.local.get(WHATS_NEW_KEY);
  await chrome.storage.local.set({ [WHATS_NEW_KEY]: { from: old?.from || previousVersion, to: ver, at: Date.now() } });
  await paintWhatsNew();
});

// метку сняли (открыли страницу или закрыли плашку в панели) — значок гаснет
globalThis.chrome?.storage?.onChanged?.addListener((ch, area) => {
  if (area === "local" && WHATS_NEW_KEY in ch) void paintWhatsNew();
});
