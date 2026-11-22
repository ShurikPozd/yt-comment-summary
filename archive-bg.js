// Фон «В архив Telegram»: страница (кнопки на обложках, меню плеера, библиотека)
// просит {type:"archive:save", info:{videoId, title, channel, len}} — фон берёт адрес
// бота и секрет (как у /api/chat), пересказ «О чём видео» из кеша, если он уже есть,
// и шлёт POST /api/save-video. Ответ — итог archiveResult() (archive-core.js).
// К итогу добавлен text — готовая подпись для плашки (контент-скриптам модули не подключить).
// {type:"archive:ready"} → {ok} — настроен ли бот (без секрета кнопку не показываем).

import { serverSettings } from "./bot-settings.js";
import { loadTldr } from "./tldr-core.js";
import { ARCHIVE_PATH, ARCHIVE_MARK_PREFIX, ARCHIVE_TIMEOUT_MS, NOT_SET_UP, archiveBody, archiveMessage, archiveResult, tldrPlain } from "./archive-core.js";

const inflight = new Map(); // videoId → Promise: двойной щелчок не шлёт видео дважды

async function botConfig() {
  const s = await serverSettings();
  const baseUrl = String(s.baseUrl || "").replace(/\/+$/, "");
  return { baseUrl, token: String(s.token || "") };
}

// Видео с ленты, у которого не знаем названия (пункт правого клика по ссылке) — из oEmbed.
async function fillMeta(info) {
  if (info.title) return info;
  try {
    const u = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${info.videoId}`)}`;
    const r = await fetch(u);
    if (r.ok) {
      const j = await r.json();
      return { ...info, title: j.title || "", channel: info.channel || j.author_name || "" };
    }
  } catch (e) {
    /* без названия — бот подпишет «Видео YouTube» */
  }
  return info;
}

export async function saveVideo(info) {
  const res = await send(info);
  return { ...res, text: archiveMessage(res) };
}

async function send(info) {
  const { baseUrl, token } = await botConfig();
  if (!baseUrl || !token) return NOT_SET_UP;
  const vid = String(info?.videoId || "");
  if (inflight.has(vid)) return inflight.get(vid);
  const job = (async () => {
    const full = await fillMeta({ ...info });
    const body = archiveBody(full, tldrPlain(await loadTldr(vid)));
    if (!body) return { ok: false, kind: "error", text: "Не понял, какое это видео" };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ARCHIVE_TIMEOUT_MS);
    let status = 0;
    let data = null;
    try {
      const r = await fetch(baseUrl + ARCHIVE_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sec-Token": token },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      status = r.status;
      data = await r.json().catch(() => null);
    } catch (e) {
      status = ac.signal.aborted ? -1 : 0;
    } finally {
      clearTimeout(timer);
    }
    const res = archiveResult(status, data);
    if (res.ok) {
      try {
        await chrome.storage.local.set({ [ARCHIVE_MARK_PREFIX + vid]: { cat: res.category, at: Date.now() } });
      } catch (e) {
        /* отметка «уже в архиве» — только для подсказки на кнопке */
      }
    }
    return res;
  })();
  inflight.set(vid, job);
  try {
    return await job;
  } finally {
    inflight.delete(vid);
  }
}

const OWN_PAGE = (sender) => String(sender?.url || "").startsWith(chrome.runtime.getURL(""));

// (globalThis.chrome?. — модуль проверяют и в node, без браузера)
globalThis.chrome?.runtime?.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "archive:save" && msg?.type !== "archive:ready") return;
  if (!(sender.tab || OWN_PAGE(sender))) return;
  if (msg.type === "archive:ready") {
    botConfig()
      .then(({ baseUrl, token }) => sendResponse({ ok: Boolean(baseUrl && token) }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  saveVideo(msg.info || {})
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, kind: "error", text: `Не получилось: ${String(e?.message || e)}` }));
  return true;
});
