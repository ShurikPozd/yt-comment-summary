// Адрес бота и секрет для фона — как loadSettings() в панели: сохранённые
// настройки поверх local-config.js и дефолтов. Общий для пересказа на ленте
// (tldr-bg.js) и «В архив Telegram» (archive-bg.js). chrome.* — только внутри
// функций: модуль импортируется и в node (check-exports.mjs, tests/run.mjs).

import { DEFAULTS } from "./config.js";

// Секрет бота может жить только в local-config.js (не в git): классический
// скрипт для страниц расширения, фону его не подключить — читаем как текст.
let localCfg = null;
async function localConfig() {
  if (localCfg) return localCfg;
  localCfg = {};
  try {
    const r = await fetch(chrome.runtime.getURL("local-config.js"));
    if (r.ok) {
      const src = (await r.text()).replace(/^\s*\/\/.*$/gm, "");
      for (const key of ["token", "baseUrl", "model"]) {
        const m = src.match(new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]*)["'\`]`));
        if (m) localCfg[key] = m[1];
      }
    }
  } catch (e) {
    /* файла нет — секрет в настройках панели */
  }
  return localCfg;
}

// Как loadSettings() в панели: сохранённые настройки поверх local-config и дефолтов.
export async function serverSettings() {
  const lc = await localConfig();
  let saved = {};
  try {
    saved = (await chrome.storage.local.get("settings")).settings || {};
  } catch (e) {
    /* пусто */
  }
  const s = Object.assign(
    { baseUrl: lc.baseUrl || DEFAULTS.baseUrl, token: lc.token || "", model: lc.model || DEFAULTS.model, lang: DEFAULTS.lang },
    saved
  );
  // пустое поле в настройках панели не отменяет секрет и адрес из local-config.js —
  // иначе «В архив Telegram» и «О чём видео» считали бы бота ненастроенным
  if (!s.token) s.token = lc.token || "";
  if (!s.baseUrl) s.baseUrl = lc.baseUrl || DEFAULTS.baseUrl;
  return s;
}
