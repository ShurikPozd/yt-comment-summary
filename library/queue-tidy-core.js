// «Уборка очереди» — чистая логика без DOM и сети (её проверяет tests/run.mjs).
//
// Группы мусора в очереди, у каждого видео — одна группа (первая подходящая):
//   gone   — недоступные: удалённые, приватные, заблокированные (по проверке avail);
//   dups   — одно видео дважды (через сообщения в фоне не бывает, но старые данные
//            и ручные правки хранилища — бывают): лишние копии, первая остаётся;
//   almost — почти досмотренное: место > 90% длины;
//   stale  — залежавшееся: добавлено больше 60 дней назад и не начато.
// По умолчанию отмечено всё, кроме залежавшегося — его решает пользователь.

export const STALE_DAYS = 60;
export const ALMOST = 0.9;
export const STARTED = 5; // секунд: меньше — «не начато»
export const GROUPS = ["gone", "dups", "almost", "stale"];
const DAY = 24 * 3600 * 1000;

// Проверка доступности: ответ oEmbed YouTube → вердикт.
//   200 — видео есть; 404 — удалено или не существует; 401/403 — приватное ИЛИ
//   автор запретил встраивание (тогда видео смотреть можно) — нужна вторая проверка
//   страницей видео; остальное (сеть, 429, 5xx) — не знаем, проверим в другой раз.
export function oembedVerdict(status) {
  if (status === 200) return "ok";
  if (status === 404 || status === 400) return "gone";
  if (status === 401 || status === 403) return "check";
  return "retry";
}

// Вторая проверка: состояние из страницы видео (ytInitialPlayerResponse.playabilityStatus).
//   OK, проверка возраста или «деликатное содержание» — смотреть можно;
//   ERROR — удалено / аккаунт закрыт; UNPLAYABLE — заблокировано (страна, правообладатель);
//   LOGIN_REQUIRED — приватное (но не «подтвердите возраст» — такое оставляем).
// Не нашли состояние — null: не знаем, видео не трогаем.
const AGE = /confirm your age|подтвердить(,| свой| ваш)? возраст|age[- ]restricted/i;
export function playability(html) {
  const s = String(html || "");
  const m = s.match(/"playabilityStatus":\{"status":"([A-Z_]+)"(.{0,600})/);
  if (!m) return null;
  const [, st, rest] = m;
  if (st === "OK" || st === "AGE_CHECK_REQUIRED" || st === "CONTENT_CHECK_REQUIRED" || st === "LIVE_STREAM_OFFLINE") return "ok";
  if (st === "ERROR") return "gone";
  if (st === "UNPLAYABLE") return "blocked";
  if (st === "LOGIN_REQUIRED") return AGE.test(rest) ? "ok" : "private";
  return null;
}

// Подписи к недоступным
export const GONE_NOTE = { gone: "удалено", private: "приватное", blocked: "заблокировано" };

// Найти группы. queue — [{ id, title, channel, len, addedAt }], pos — { id: секунды },
// avail — { id: "ok" | "gone" | "private" | "blocked" } (что известно о доступности).
// Возвращает { gone, dups, almost, stale } — списки { id, rec, d, note, pct?, days? }
// в порядке очереди (d — номер в очереди).
export function groupQueue(queue, pos = {}, { now = Date.now(), avail = {} } = {}) {
  const out = { gone: [], dups: [], almost: [], stale: [] };
  const first = new Map();
  const copies = new Map();
  queue.forEach((rec, d) => {
    if (!rec?.id) return;
    if (!first.has(rec.id)) first.set(rec.id, d);
    else copies.set(rec.id, (copies.get(rec.id) || 0) + 1);
  });
  const seen = new Set();
  queue.forEach((rec, d) => {
    const id = rec?.id;
    if (!id || seen.has(id)) return;
    seen.add(id);
    const a = avail[id];
    if (a && a !== "ok" && GONE_NOTE[a]) return void out.gone.push({ id, rec, d, note: GONE_NOTE[a], kind: a });
    if (copies.has(id)) {
      const n = copies.get(id);
      return void out.dups.push({ id, rec, d, n, note: `ещё ${n} ${copiesWord(n)}` });
    }
    const t = Number(pos[id]) || 0;
    if (rec.len > 0 && t > rec.len * ALMOST) {
      const pct = Math.min(100, Math.round((t / rec.len) * 100));
      return void out.almost.push({ id, rec, d, pct, note: `досмотрено на ${pct}%` });
    }
    const added = Number(rec.addedAt) || 0;
    if (added && t < STARTED && now - added > STALE_DAYS * DAY) {
      const days = Math.floor((now - added) / DAY);
      out.stale.push({ id, rec, d, days, note: "" });
    }
  });
  return out;
}

const copiesWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? "копия" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "копии" : "копий");

// Отмеченные по умолчанию: всё, кроме залежавшегося
export function defaultPicked(groups) {
  const out = new Set();
  for (const g of GROUPS) if (g !== "stale") for (const it of groups[g] || []) out.add(it.id);
  return out;
}

// Сколько отмечено в группе: "all" | "some" | "none"
export function groupState(list, picked) {
  const n = list.filter((it) => picked.has(it.id)).length;
  return !n ? "none" : n === list.length ? "all" : "some";
}

// Что отправить в фон, чтобы убрать отмеченное. Порядок сообщений:
//   1) queue:remove drop (why "drop") и done (why "" — почти досмотренное: смотрели ли
//      до конца, не знаем; «убрано без просмотра» было бы неправдой);
//   2) queue:put keep (undo "drop") — дубли: queue:remove убирает ВСЕ копии, первую
//      сразу ставим обратно на её место.
// «Вернуть»: queue:put undo.drop (undo "drop"), ПОТОМ queue:put undo.done.
// Места (at) посчитаны под этот порядок: restoreAt ставит по возрастанию at в
// список, где всё, что раньше, уже стоит, — поэтому в первом «Вернуть» номера без
// ещё не вернувшихся «досмотренных», а лишние копии дублей не возвращаются вовсе.
export function removalPlan(queue, pos, groups, picked) {
  const groupOf = new Map();
  for (const g of GROUPS) for (const it of groups[g] || []) if (picked.has(it.id)) groupOf.set(it.id, g);
  const drop = [];
  const done = [];
  const keep = [];
  const undo = { drop: [], done: [] };
  const seen = new Set();
  let kept = 0; // место в очереди сразу после «Убрать» (с вернувшимися первыми копиями)
  let fin = 0; // место в очереди после «Вернуть» (без лишних копий дублей)
  let doneBefore = 0; // «досмотренных» перед этим местом — они вернутся вторыми
  for (const rec of queue) {
    const id = rec?.id;
    const g = groupOf.get(id);
    const first = !seen.has(id);
    seen.add(id);
    if (!g) {
      kept++;
      fin++;
      continue;
    }
    if (!first) continue; // лишняя копия отмеченного — уходит насовсем
    const snap = (at) => ({ rec: { ...rec }, at, t: Number(pos[id]) || 0 });
    if (g === "dups") {
      drop.push(id);
      keep.push(snap(kept));
      kept++;
    } else if (g === "almost") {
      done.push(id);
      undo.done.push(snap(fin));
      doneBefore++;
    } else {
      drop.push(id);
      undo.drop.push(snap(fin - doneBefore));
    }
    fin++;
  }
  return { drop, done, keep, undo, count: groupOf.size };
}

// Очередь проверок доступности: не чаще perSec запросов в секунду, не больше
// parallel одновременно; signal — отмена. check(id, signal) → вердикт или null
// (не знаем). onDone(id, verdict) — после каждого. wait — для тестов (задержка).
export async function paced(ids, check, { perSec = 5, parallel = 3, signal, onDone = () => {}, wait } = {}) {
  const sleep = wait || ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  const gap = 1000 / perSec;
  let next = 0;
  let i = 0;
  const worker = async (slot) => {
    while (i < ids.length && !signal?.aborted) {
      const id = ids[i++];
      // свой «слот» времени: запросы расходятся на gap мс друг от друга
      const at = Math.max(next, Date.now());
      next = at + gap;
      const ms = at - Date.now();
      if (ms > 0) await sleep(ms);
      if (signal?.aborted) break;
      let v = null;
      try {
        v = await check(id, signal);
      } catch (e) {
        v = null;
      }
      if (signal?.aborted) break;
      onDone(id, v, slot);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, ids.length)) }, (_, k) => worker(k)));
  return !signal?.aborted;
}

// Кеш проверок: свежие (моложе ttl) — не перепроверяем
export const CHECK_TTL = 3 * DAY;
export function needCheck(ids, cache = {}, now = Date.now(), ttl = CHECK_TTL) {
  return [...new Set(ids)].filter((id) => !(cache[id] && now - (cache[id].at || 0) < ttl && cache[id].s));
}
export function availOf(cache = {}) {
  const out = {};
  for (const [id, c] of Object.entries(cache)) if (c?.s) out[id] = c.s;
  return out;
}
// Кеш — только для видео, что ещё в очереди (не копим вечно)
export function pruneCache(cache = {}, ids = []) {
  const keep = new Set(ids);
  const out = {};
  for (const [id, c] of Object.entries(cache)) if (keep.has(id)) out[id] = c;
  return out;
}
