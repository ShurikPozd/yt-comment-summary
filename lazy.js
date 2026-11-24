// Подгрузка редких окон по требованию — сторона страницы (верхняя рамка YouTube).
// Клип (clip.js + clip-main.js), «Сохранить в плейлисты» (playlists.js +
// playlists-main.js) и превью (thumb-preview.js) не грузятся с каждой страницей:
// их вставляет фон (lazy-bg.js), когда окно понадобилось, — десятки миллисекунд.
//
// API: globalThis.__ytcsLazy.load(name) → Promise<boolean> — модуль готов
//        (name: "clip" | "playlists" | "preview"); повторный вызов — мгновенно;
//      .lastPlaylist() → { id, title } | null — последний плейлист из окна
//        (для пункта «Сохранить в «…»» в меню плеера, без загрузки окна).
// На Shorts окно плейлистов подгружается само: его кнопка «Сохранить» стоит в
// колонке кнопок ролика (playlists.js).
(() => {
  if (globalThis.__ytcsLazy?.alive?.()) return;

  const GLOBALS = { clip: "__ytcsClip", playlists: "__ytcsPlaylists", preview: "__ytcsPreview" };
  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };

  const inflight = new Map();
  function load(name) {
    const g = GLOBALS[name];
    if (!g) return Promise.resolve(false);
    if (globalThis[g]) return Promise.resolve(true);
    if (!alive()) return Promise.resolve(false);
    let p = inflight.get(name);
    if (!p) {
      p = chrome.runtime
        .sendMessage({ type: "mod:load", name })
        .then(
          (r) => Boolean(r?.ok && globalThis[g]),
          () => false
        )
        .finally(() => inflight.delete(name));
      inflight.set(name, p);
    }
    return p;
  }

  // как last() в playlists.js: plRecent[0] и его название из plNames
  async function lastPlaylist() {
    if (!alive()) return null;
    try {
      const { plRecent, plNames } = await chrome.storage.local.get(["plRecent", "plNames"]);
      const id = Array.isArray(plRecent) ? plRecent[0] : null;
      return id ? { id, title: plNames?.[id] || "" } : null;
    } catch (e) {
      return null;
    }
  }

  // Shorts: кнопка «Сохранить» — из playlists.js. Переходы на YouTube без
  // перезагрузки — ловим смену адреса (Navigation API, early.js; без него —
  // проверка адреса раз в секунду); не вышло — повтор через секунду, после 3 неудач — хватит.
  const onHrefChange = globalThis.__ytcs?.onHrefChange;
  let shortsFails = 0;
  let shortsBusy = false;
  async function shortsCheck() {
    if (shortsBusy || globalThis.__ytcsPlaylists || shortsFails >= 3 || !location.pathname.startsWith("/shorts/") || !alive()) return;
    shortsBusy = true;
    const ok = await load("playlists");
    shortsBusy = false;
    if (!ok) shortsFails++;
    if (!ok && onHrefChange && shortsFails < 3) setTimeout(shortsCheck, 1000); // при опросе повторит он сам
  }
  if (onHrefChange) onHrefChange(shortsCheck, 1000);
  else setInterval(shortsCheck, 1000);
  void shortsCheck();

  globalThis.__ytcsLazy = { load, lastPlaylist, alive };
})();
