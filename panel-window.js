// Боковая панель там, где её нет.
// Chrome и Яндекс Браузер (проверено на 26.11) умеют chrome.sidePanel — тогда всё
// как раньше. В старых версиях Яндекс Браузера и в других браузерах на Chromium
// этого API может не быть: тогда та же панель (sidepanel/sidepanel.html) открывается
// узким окном у правого края. Панель сама находит вкладку с видео в любом окне
// (findActiveVideoTab в sidepanel.js), поэтому в окне работает так же.
// На верхнем уровне chrome.* не трогаем — модуль импортируется и в Node (проверки).

export const hasSidePanel = () => typeof globalThis.chrome?.sidePanel?.open === "function";

const PANEL_WIDTH = 440;
let panelWin = null;

export async function openPanelWindow() {
  const url = chrome.runtime.getURL("sidepanel/sidepanel.html");
  // уже открыто — просто показать
  const [open] = await chrome.tabs.query({ url }).catch(() => []);
  const winId = open?.windowId ?? panelWin;
  if (winId != null) {
    const ok = await chrome.windows.update(winId, { focused: true }).then(() => true, () => false);
    if (ok) return true;
    panelWin = null;
  }
  // у правого края текущего окна, во всю его высоту
  const place = {};
  const cur = await chrome.windows.getLastFocused().catch(() => null);
  if (cur?.width && cur.left != null) {
    place.left = Math.max(cur.left, cur.left + cur.width - PANEL_WIDTH);
    place.top = cur.top;
    place.height = cur.height;
  }
  const w = await chrome.windows.create({ url, type: "popup", width: PANEL_WIDTH, focused: true, ...place });
  panelWin = w?.id ?? null;
  return true;
}

// Открыть панель: настоящую боковую, а без неё — окном. target — { tabId } или { windowId }.
// sidePanel.open вызывается сразу (без await перед ним): Chrome открывает панель
// только в ответ на действие пользователя.
export function openPanel(target) {
  if (hasSidePanel()) return chrome.sidePanel.open(target).then(() => true, () => false);
  return openPanelWindow().catch(() => false);
}
