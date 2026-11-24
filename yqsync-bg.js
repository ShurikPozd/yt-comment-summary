// Очередь «Смотреть позже» на телефоне — двусторонняя синхронизация с ботом (/api/yq-sync).
//
// Туда: после каждого изменения очереди (queue / queuePos в chrome.storage.local) фон тихо
// отправляет боту выжимку очереди (yqsync-core.js) — не чаще раза в 10 минут, одноразовым
// будильником. Полная копия (/api/backup) для этого больше не нужна.
// Обратно: в ответе бот отдаёт отметки «Досмотрел» / «Убрать» со страницы /yq. Фон убирает
// эти видео из очереди тем же qRemove, что и кнопки расширения (why "done" / "drop" — для
// статистики), и сразу подтверждает их (acks), чтобы бот их стёр. Пока открыт YouTube (или
// страница расширения), фон спрашивает отметки раз в 5 минут.
// Без адреса бота или секрета — молча ничего не делаем.

import { serverSettings } from "./bot-settings.js";
import { hashOf, planMarks, queuePayload } from "./yqsync-core.js";

export const YQ_SYNC_KEY = "yqSync"; // { hash, at, count (последняя отправленная очередь), acks, err, tried }
const ALARM = "ytcs-yqsync"; // одноразовый: отправить изменения
const POLL = "ytcs-yqpoll"; // раз в 5 минут: отметки с телефона, пока открыт YouTube
const EVERY = 10 * 60 * 1000;
const FIRST_DELAY = 60 * 1000;
const TIMEOUT = 60 * 1000; // бот на бесплатном Render просыпается до ~50 с

let removeFn = null;
let running = null;
let alarmUntil = 0; // будильник уже стоит до этого времени — не дёргаем chrome.alarms на каждую секунду просмотра

/** background.js отдаёт сюда qRemove (ids, why) — единственный, кто пишет очередь. */
export function initYqSync({ remove }) {
  removeFn = remove;
}

async function readState() {
  return (await chrome.storage.local.get(YQ_SYNC_KEY))[YQ_SYNC_KEY] || {};
}

/** Очередь изменилась: поставить отправку через минуту, но не раньше чем через 10 минут после прошлой. */
export async function scheduleSync() {
  const now = Date.now();
  if (alarmUntil > now) return;
  const st = await readState();
  const when = Math.max(now + FIRST_DELAY, (Number(st.at) || 0) + EVERY);
  const cur = await chrome.alarms.get(ALARM).catch(() => null);
  if (cur && cur.scheduledTime <= when) {
    alarmUntil = cur.scheduledTime;
    return;
  }
  await chrome.alarms.create(ALARM, { when }).catch(() => {});
  alarmUntil = when;
}

async function post(s, body) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const r = await fetch(`${s.baseUrl.replace(/\/+$/, "")}/api/yq-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sec-Token": s.token },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 404) throw new Error("Бот ещё не умеет — обновите бота");
    if (!r.ok || !d.ok) throw new Error(d.error || `Бот ответил ${r.status}`);
    return d;
  } finally {
    clearTimeout(t);
  }
}

/** Один обмен с ботом. force — отправить изменённую очередь, даже если 10 минут ещё не прошло;
 *  resend — отправить очередь, даже если она не менялась (бот её потерял). */
async function exchange({ force = false, resend = false, depth = 0 } = {}) {
  const s = await serverSettings();
  if (!s.baseUrl || !s.token) return { skip: "setup" };
  const st = await readState();
  const { queue = [], queuePos = {} } = await chrome.storage.local.get(["queue", "queuePos"]);
  const items = queuePayload(queue, queuePos);
  const hash = hashOf(JSON.stringify(items));
  const now = Date.now();
  const changed = hash !== st.hash;
  const send = resend || (changed && (force || now - (Number(st.at) || 0) >= EVERY - 5000));
  const acks = Array.isArray(st.acks) ? st.acks : [];
  const body = {
    rev: send ? hash : st.hash || "",
    ver: chrome.runtime.getManifest?.().version || "",
    ...(acks.length ? { acks } : {}),
    ...(send ? { items } : {}),
  };
  let d;
  try {
    d = await post(s, body);
  } catch (e) {
    const err = e?.name === "AbortError" ? "Бот не ответил за 60 с (просыпается?)" : String(e?.message || e);
    await chrome.storage.local.set({ [YQ_SYNC_KEY]: { ...st, err, tried: now } });
    if (changed) {
      // повтор — через 10 минут (или раньше, когда спросит будильник «открыт YouTube»)
      await chrome.alarms.create(ALARM, { when: now + EVERY }).catch(() => {});
      alarmUntil = now + EVERY;
    }
    return { err };
  }
  const next = { ...st, err: "", tried: now, acks: [] };
  if (send) Object.assign(next, { hash, at: now, count: items.length });
  await chrome.storage.local.set({ [YQ_SYNC_KEY]: next });
  if (changed && !send) await scheduleSync(); // изменения есть, но рано — отправит будильник
  let applied = 0;
  if (Array.isArray(d.marks) && d.marks.length && removeFn) {
    const { queue: q2 = [] } = await chrome.storage.local.get("queue");
    const plan = planMarks(q2, d.marks);
    if (plan.done.length) await removeFn(plan.done, "done");
    if (plan.drop.length) await removeFn(plan.drop, "drop");
    applied = plan.done.length + plan.drop.length;
    await chrome.storage.local.set({ [YQ_SYNC_KEY]: { ...next, acks: plan.acks } });
  }
  // отметки применены — сразу подтвердить их и отправить новую очередь;
  // бот потерял очередь (восстановлен из старой копии) — прислать её сейчас же
  const hadMarks = Array.isArray(d.marks) && d.marks.length > 0;
  if (depth < 1 && (hadMarks || (d.want && !send))) {
    return exchange({ force: true, resend: Boolean(d.want && !send), depth: depth + 1 });
  }
  return { ok: true, sent: send, applied };
}

/** Обмен с ботом; два одновременных вызова — один запрос (изменения, случившиеся во время
 *  запроса, сами поставят будильник через storage.onChanged). */
export function syncNow(opts = {}) {
  if (running) return running;
  running = exchange(opts)
    .catch((e) => ({ err: String(e?.message || e) }))
    .finally(() => (running = null));
  return running;
}

async function youtubeOpen() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const own = chrome.runtime.getURL("");
  return tabs.some((t) => /^https:\/\/(www|m)\.youtube\.com\//.test(t.url || "") || (t.url || "").startsWith(own));
}

export async function setupYqSync() {
  if (!(await chrome.alarms.get(POLL).catch(() => null))) {
    await chrome.alarms.create(POLL, { delayInMinutes: 5, periodInMinutes: 5 }).catch(() => {});
  }
  await scheduleSync(); // при запуске браузера — одна сверка с ботом (и первая отправка после обновления)
}

// обработчики — сразу при загрузке фона (так MV3 будит его по будильнику);
// вне расширения (проверки в Node) chrome нет — тогда ничего не вешаем
if (globalThis.chrome?.alarms && globalThis.chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && (ch.queue || ch.queuePos)) void scheduleSync();
  });
  chrome.alarms.onAlarm.addListener(async (a) => {
    if (a.name === ALARM) {
      alarmUntil = 0;
      void syncNow();
    } else if (a.name === POLL && (await youtubeOpen())) void syncNow();
  });
}
