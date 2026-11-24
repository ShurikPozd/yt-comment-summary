// Очередь на телефоне (страница бота /yq) — чистая логика без chrome.*, проверяется в node.
// Фон (yqsync-bg.js) отправляет боту лёгкую выжимку очереди и применяет отметки
// «Досмотрел» / «Убрать», поставленные на телефоне.

export const YQ_MAX = 2000; // столько видео с начала очереди принимает бот

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Выжимка очереди для бота: то же, что бот берёт из полной копии, плюс added (секунды). */
export function queuePayload(queue, pos = {}) {
  const out = [];
  for (const r of Array.isArray(queue) ? queue : []) {
    if (!ID_RE.test(r?.id || "")) continue;
    const p = Math.floor(Number(pos?.[r.id]) || 0);
    out.push({
      id: r.id,
      title: String(r.title || "").slice(0, 300),
      channel: String(r.channel || "").slice(0, 120),
      len: Math.max(0, Math.round(Number(r.len) || 0)),
      short: Boolean(r.short),
      pos: p > 5 ? p : 0,
      added: Math.floor((Number(r.addedAt) || 0) / 1000),
    });
    if (out.length >= YQ_MAX) break;
  }
  return out;
}

/** Короткий отпечаток выжимки: изменилась ли очередь с прошлой отправки (FNV-1a, 32 бита). */
export function hashOf(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16).padStart(8, "0")}-${s.length.toString(36)}`;
}

/**
 * Что сделать с отметками с телефона. marks — [{ id, act: "done"|"drop", at (секунды по часам бота) }].
 * Видео убираем, только если его добавили в очередь не позже отметки: «Убрать» на телефоне,
 * а потом видео заново добавили на компьютере — оно остаётся. Подтверждаем (acks) все отметки,
 * и применённые, и устаревшие, — бот их сотрёт.
 */
export function planMarks(queue, marks) {
  const byId = new Map((Array.isArray(queue) ? queue : []).map((x) => [x.id, x]));
  const plan = { done: [], drop: [], acks: [] };
  const seen = new Set();
  for (const m of Array.isArray(marks) ? marks : []) {
    if (!ID_RE.test(m?.id || "") || !["done", "drop"].includes(m.act)) continue;
    const at = Math.floor(Number(m.at) || 0);
    plan.acks.push({ id: m.id, at });
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const rec = byId.get(m.id);
    // как у бота: отметка в ту же секунду, что добавление, или позже — значит, про это добавление
    if (rec && (Number(rec.addedAt) || 0) < (at + 1) * 1000) plan[m.act].push(m.id);
  }
  return plan;
}
