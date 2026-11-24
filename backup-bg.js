// Автокопия в Telegram: раз в неделю фон собирает резервную копию (backup-core.js),
// сжимает gzip и отдаёт боту (/api/backup) — тот кладёт файл в чат с владельцем.
// Упадёт браузер или компьютер — очередь, настройки и каталог останутся в Telegram.
//
// Будильник раз в 6 часов смотрит, не пора ли (прошла неделя с последней удачной
// копии). Без бота или без секрета — молча ждём. Выключается в окне «Резервная копия».

import { collectBackup } from "./backup-core.js";
import { serverSettings } from "./bot-settings.js";

export const AUTO_BACKUP_KEY = "autoBackup"; // { on, at (последняя удачная), err, tried, size }
const ALARM = "ytcs-autobackup";
const EVERY = 7 * 24 * 3600 * 1000;
const RETRY = 6 * 3600 * 1000; // после сбоя — не чаще раза в 6 часов

let running = null;

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Собрать и отправить. manual — по кнопке (сразу, без проверки «неделя прошла»). */
export function sendBackup({ manual = false } = {}) {
  if (running) return running;
  running = (async () => {
    const { [AUTO_BACKUP_KEY]: st0 = {} } = await chrome.storage.local.get(AUTO_BACKUP_KEY);
    const st = { on: st0.on !== false, at: st0.at || 0, err: "", tried: Date.now(), size: st0.size || 0 };
    try {
      const s = await serverSettings();
      if (!s.baseUrl || !s.token) throw new Error("Бот не настроен: нужен адрес и секрет в настройках панели");
      const data = await collectBackup();
      const body = await gzip(JSON.stringify(data));
      const q = new URLSearchParams({
        ver: data.extVersion,
        queue: String(data.queue.length),
        ...(data.catalog ? { playlists: String(data.catalog.playlists.length), videos: String(data.catalog.videos.length) } : {}),
        ...(manual ? { manual: "1" } : {}),
      });
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 90000);
      let r;
      try {
        r = await fetch(`${s.baseUrl.replace(/\/+$/, "")}/api/backup?${q}`, {
          method: "POST",
          headers: { "Content-Type": "application/gzip", "X-Sec-Token": s.token },
          body,
          signal: ac.signal,
        });
      } finally {
        clearTimeout(t);
      }
      const d = await r.json().catch(() => ({}));
      if (r.status === 404) throw new Error("Бот ещё не умеет принимать копии — обновите бота");
      if (!r.ok || !d.ok) throw new Error(d.error || `Бот ответил ${r.status}`);
      st.at = Date.now();
      st.size = body.length;
    } catch (e) {
      st.err = e?.name === "AbortError" ? "Бот не ответил за 90 с (просыпается?) — попробую позже" : String(e?.message || e);
    }
    await chrome.storage.local.set({ [AUTO_BACKUP_KEY]: st });
    return st;
  })().finally(() => (running = null));
  return running;
}

async function due() {
  const { [AUTO_BACKUP_KEY]: st = {} } = await chrome.storage.local.get(AUTO_BACKUP_KEY);
  if (st.on === false) return false;
  const now = Date.now();
  if (st.at && now - st.at < EVERY) return false;
  if (st.err && st.tried && now - st.tried < RETRY) return false;
  // на свежей установке без очереди и каталога слать нечего
  const { queue } = await chrome.storage.local.get("queue");
  return Boolean(st.at || (Array.isArray(queue) && queue.length));
}

export async function setupAutoBackup() {
  if (!(await chrome.alarms.get(ALARM).catch(() => null))) {
    await chrome.alarms.create(ALARM, { delayInMinutes: 15, periodInMinutes: 360 }).catch(() => {});
  }
}

// обработчики — сразу при загрузке фона (так MV3 будит его по будильнику и сообщению);
// вне расширения (проверки в Node) chrome нет — тогда ничего не вешаем
if (globalThis.chrome?.alarms && globalThis.chrome?.runtime?.onMessage) {
  chrome.alarms.onAlarm.addListener(async (a) => {
    if (a.name !== ALARM) return;
    if (await due()) void sendBackup();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "backup:send") {
      sendBackup({ manual: true }).then(sendResponse, (e) => sendResponse({ err: String(e?.message || e) }));
      return true;
    }
    if (msg?.type === "backup:toggle") {
      chrome.storage.local
        .get(AUTO_BACKUP_KEY)
        .then(({ [AUTO_BACKUP_KEY]: st = {} }) => chrome.storage.local.set({ [AUTO_BACKUP_KEY]: { ...st, on: Boolean(msg.on) } }))
        .then(() => sendResponse({ ok: true }));
      return true;
    }
  });
}
