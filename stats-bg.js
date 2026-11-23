// Статистика просмотра — фон. Вкладки YouTube (stats.js) раз в ~15 с присылают
// прибавку «stats:add»; очередь (background.js) — досмотрено / убрано. Здесь
// всё складывается по одному, без гонок между вкладками, в
// chrome.storage.local.watchStats (формат — stats-core.js). Ничего не уходит
// с компьютера. Выключатель — settings.watchStats (по умолчанию вкл.).
import { STATS_KEY, addDelta, cleanStats, prune } from "./stats-core.js";

let chain = Promise.resolve();
let lastPrune = 0;

async function enabled() {
  const { settings } = await chrome.storage.local.get("settings").catch(() => ({}));
  return settings?.watchStats !== false;
}

// Прибавить к статистике (последовательно — запись за записью)
export function statsAdd(delta) {
  chain = chain
    .then(async () => {
      if (!(await enabled())) return;
      const now = Date.now();
      const raw = (await chrome.storage.local.get(STATS_KEY))[STATS_KEY];
      const stats = addDelta(cleanStats(raw, now), delta, now);
      if (now - lastPrune > 3600 * 1000) {
        prune(stats, now);
        lastPrune = now;
      }
      await chrome.storage.local.set({ [STATS_KEY]: stats });
    })
    .catch(() => {});
  return chain;
}

// (без chrome — модуль импортирует проверка экспортов в Node)
globalThis.chrome?.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "stats:add") return;
  // прибавки — только от наших контент-скриптов и страниц расширения
  if (sender.id !== chrome.runtime.id) return;
  void statsAdd(msg.delta).then(() => sendResponse({ ok: true }));
  return true;
});
