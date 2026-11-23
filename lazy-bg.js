// Подгрузка по требованию: редкие тяжёлые окна (клип, «Сохранить в плейлисты»,
// превью) не грузятся на каждой странице YouTube, а вставляются во вкладку из
// фона в момент, когда понадобились (chrome.scripting.executeScript, десятки мс).
//
// ensureModule(tabId, frameId, name) → { ok, error? }
//   - идемпотентно: уже вставленный модуль второй раз не вставляется (проверка —
//     глобальный объект модуля и метка «чьей» он копии);
//   - после обновления расширения метка другая (токен живёт в storage.session,
//     а его Chrome очищает при обновлении) — модуль вставляется заново, старая
//     копия закрывается и забывается;
//   - два одновременных запроса одного модуля в ту же рамку ждут одну вставку.
// Скрипты мира страницы (MAIN) вставляются первыми — как раньше по манифесту
// (document_start): у них свои флаги «уже есть», повторная вставка безвредна.

export const MODULES = {
  preview: { global: "__ytcsPreview", files: ["thumb-preview.js"] },
  playlists: { global: "__ytcsPlaylists", main: ["playlists-main.js"], files: ["playlists.js"] },
  clip: { global: "__ytcsClip", main: ["clip-main.js"], files: ["clip.js"] },
};
export const TOKEN_KEY = "ytcsModToken";

// Выполняются В РАМКЕ страницы (изолированный мир расширения) — самодостаточные.
export function probeModule(global, token) {
  const marks = (globalThis.__ytcsMods ||= {});
  if (globalThis[global] && marks[global] === token) return "ready";
  if (globalThis[global]) {
    // копия от прошлой версии расширения (рамку не перезагружали) — закрыть и забыть
    try {
      globalThis[global].close?.();
    } catch (e) {
      /* её контекст уже недействителен */
    }
    try {
      delete globalThis[global];
    } catch (e) {
      globalThis[global] = undefined;
    }
  }
  return "missing";
}
export function markModule(global, token) {
  if (!globalThis[global]) return false;
  (globalThis.__ytcsMods ||= {})[global] = token;
  return true;
}

export function createLoader({ scripting, session, modules = MODULES }) {
  let token = null;
  const inflight = new Map();

  async function getToken() {
    if (token) return token;
    try {
      const saved = (await session.get(TOKEN_KEY))[TOKEN_KEY];
      if (saved) return (token = saved);
    } catch (e) {
      /* без хранилища — токен на время жизни фона */
    }
    token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    try {
      await session.set({ [TOKEN_KEY]: token });
    } catch (e) {
      /* не страшно: в худшем случае модуль вставится повторно */
    }
    return token;
  }

  async function load(tabId, frameId, name) {
    const mod = modules[name];
    if (!mod) return { ok: false, error: "unknown" };
    const target = { tabId, frameIds: [frameId] };
    const tok = await getToken();
    try {
      const [probe] = await scripting.executeScript({ target, func: probeModule, args: [mod.global, tok], injectImmediately: true });
      if (probe?.result === "ready") return { ok: true, cached: true };
      if (mod.main?.length) await scripting.executeScript({ target, world: "MAIN", files: mod.main, injectImmediately: true });
      await scripting.executeScript({ target, files: mod.files, injectImmediately: true });
      const [mark] = await scripting.executeScript({ target, func: markModule, args: [mod.global, tok], injectImmediately: true });
      return mark?.result ? { ok: true } : { ok: false, error: "init" };
    } catch (e) {
      // вкладку закрыли, увели на другой сайт, страница расширения/служебная
      return { ok: false, error: "inject", message: String(e?.message || e) };
    }
  }

  function ensureModule(tabId, frameId, name) {
    if (!Number.isInteger(tabId) || tabId < 0) return Promise.resolve({ ok: false, error: "notab" });
    const fid = Number.isInteger(frameId) && frameId >= 0 ? frameId : 0;
    const key = `${tabId}:${fid}:${name}`;
    let p = inflight.get(key);
    if (!p) {
      p = load(tabId, fid, name).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  }

  return { ensureModule, getToken };
}
