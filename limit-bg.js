// Мягкий лимит времени — фон. Слушает те же прибавки «stats:add», что и
// статистика (stats.js шлёт их раз в ~15 с из играющей вкладки), и складывает
// время за «день лимита» в chrome.storage.local.watchLimitDay (limit-core.js).
// Пересекли лимит — просим показать плашку ту самую вкладку и рамку, где сейчас
// играет видео (limit.js). Решение принимается здесь, по одному, — поэтому
// в нескольких вкладках плашка не дублируется. Плашка не показалась (вкладку
// закрыли, плеера нет) — напоминание не тратится, попробуем со следующей прибавкой.
// Без статистики (settings.watchStats === false) лимит не считает ничего.
import { LIMIT_CFG_KEY, LIMIT_DAY_KEY, addWatch, applyAction, cleanCfg, cleanDay, fmtSpent, markShown, shouldShow } from "./limit-core.js";
import { STATS_KEY, dayKey } from "./stats-core.js";

let chain = Promise.resolve();
const run = (fn) => (chain = chain.then(fn).catch(() => {}));

async function showIn(target, sec) {
  if (!target || !(target.tabId >= 0)) return false;
  try {
    // не ответили за 3 с (другой скрипт рамки взял сообщение и молчит) — не ждём, прибавки идут дальше
    const r = await Promise.race([
      chrome.tabs.sendMessage(target.tabId, { type: "limit:show", spent: fmtSpent(sec) }, { frameId: target.frameId || 0 }),
      new Promise((res) => setTimeout(() => res(null), 3000)),
    ]);
    return r?.ok === true;
  } catch (e) {
    return false; // вкладку закрыли или там нет нашего скрипта
  }
}

// Прибавить просмотренное; target — { tabId, frameId }, откуда пришла прибавка
export function limitAdd(sec, target = null, now = Date.now()) {
  return run(async () => {
    const r = await chrome.storage.local.get([LIMIT_CFG_KEY, LIMIT_DAY_KEY, "settings"]);
    if (r.settings?.watchStats === false) return;
    let seed = 0;
    if (!r[LIMIT_DAY_KEY]) {
      // первый раз: сколько уже насмотрено сегодня по статистике
      const d = (await chrome.storage.local.get(STATS_KEY))[STATS_KEY]?.days?.[dayKey(now)];
      seed = (Number(d?.w) || 0) + (Number(d?.s) || 0);
    }
    let rec = addWatch(r[LIMIT_DAY_KEY], sec, now, seed);
    const cfg = cleanCfg(r[LIMIT_CFG_KEY]);
    if (shouldShow(rec, cfg, now) && (await showIn(target, rec.sec))) rec = markShown(rec, cfg, now);
    await chrome.storage.local.set({ [LIMIT_DAY_KEY]: rec });
  });
}

// Кнопки плашки: "snooze" | "finish" | "close"
export function limitAct(act, now = Date.now()) {
  return run(async () => {
    const raw = (await chrome.storage.local.get(LIMIT_DAY_KEY))[LIMIT_DAY_KEY];
    await chrome.storage.local.set({ [LIMIT_DAY_KEY]: applyAction(cleanDay(raw, now), act, now) });
  });
}

// (без chrome — модуль импортирует проверка экспортов в Node)
globalThis.chrome?.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.type === "stats:add") {
    // отвечает stats-bg.js — здесь только считаем время (видео + Shorts)
    const sec = (Number(msg.delta?.w) || 0) + (Number(msg.delta?.s) || 0);
    if (sec > 0) void limitAdd(sec, sender.tab ? { tabId: sender.tab.id, frameId: sender.frameId } : null);
    return;
  }
  if (msg?.type === "limit:act") {
    void limitAct(msg.act).then(() => sendResponse({ ok: true }));
    return true;
  }
});
