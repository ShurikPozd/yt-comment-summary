// Резервная копия расширения: что в неё входит. Общая для «Моей библиотеки»
// (сохранить в файл) и фона (автокопия в Telegram раз в неделю, backup-bg.js).
//
// Очередь и где вы остановились, настройки очереди и расширения (БЕЗ секрета
// бота — settings.token вырезается), список плейлистов и видео в них (каталог).

import { kv } from "./library/store.js";

export const BACKUP_FORMAT = "ytcs-backup";

/** cat — каталог, если он уже в памяти (библиотека); иначе читаем из IndexedDB. */
export async function collectBackup(cat = null) {
  const local = await chrome.storage.local.get(["queue", "queuePos", "queueOpts", "settings", "plRecent", "libWatchHere", "libraryWhere", "wlBackup"]);
  const settings = { ...(local.settings || {}) };
  delete settings.token; // секрет бота — никогда в копию
  const c = cat || (await kv("catalog").catch(() => null));
  return {
    format: BACKUP_FORMAT,
    v: 1,
    at: Date.now(),
    extVersion: chrome.runtime.getManifest().version,
    queue: local.queue || [],
    queuePos: local.queuePos || {},
    queueOpts: local.queueOpts || null,
    settings,
    prefs: { plRecent: local.plRecent || [], libWatchHere: local.libWatchHere, libraryWhere: local.libraryWhere, wlBackup: local.wlBackup || null },
    catalog: c ? { syncedAt: c.syncedAt, playlists: c.playlists, videos: c.videos, gone: c.gone || [] } : null,
  };
}
