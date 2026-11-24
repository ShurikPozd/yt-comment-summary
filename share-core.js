// «Ссылка» у сводки: общее ядро без chrome.* и DOM (его же гоняет tests/run.mjs).
// Сводка уходит в бот POST /api/share-summary (тот же секрет X-Sec-Token, что у
// /api/chat), бот отдаёт ссылку /sum/<id>/ — страницу, которую друг откроет в любом
// браузере без расширения. Отзыв — DELETE /api/share-summary/<id>.
// Соответствие «сводка → ссылка» хранится в chrome.storage.local под sumshare:<id видео>,
// чтобы повторное нажатие для той же сводки давало ту же ссылку.

export const SHARE_PATH = "/api/share-summary";
export const SHARE_KEY_PREFIX = "sumshare:";
export const SHARE_TIMEOUT_MS = 90000; // бот на Render может просыпаться ~50 с

const VID_RE = /^[A-Za-z0-9_-]{11}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const cut = (v, n) => String(v ?? "").trim().slice(0, n);

/** Тело запроса к боту. null — если сводки нет или id видео негодный. */
export function shareBody(s, meta, videoId) {
  const vid = String(videoId || "");
  if (!s || !VID_RE.test(vid) || !String(s.summary || "").trim()) return null;
  const sp = s.sentiment || {};
  return {
    videoId: vid,
    title: cut(meta?.title, 300),
    channel: cut(meta?.channelName || meta?.channel, 120),
    summary: cut(s.summary, 6000),
    topics: (s.topics || [])
      .filter((t) => t && t.name)
      .slice(0, 12)
      .map((t) => ({ name: cut(t.name, 80), count: Math.max(0, Math.floor(Number(t.count) || 0)) })),
    points: (s.points || []).filter((p) => typeof p === "string" && p.trim()).slice(0, 10).map((p) => cut(p, 500)),
    sentiment: {
      positive: Math.max(0, Number(sp.positive) || 0),
      neutral: Math.max(0, Number(sp.neutral) || 0),
      negative: Math.max(0, Number(sp.negative) || 0),
    },
    comments: (s.notable || [])
      .filter((c) => c && c.text)
      .slice(0, 6)
      .map((c) => ({ author: cut(c.author, 80), text: cut(c.text, 800), likes: Math.max(0, Math.floor(Number(c.likes) || 0)) })),
    commentCount: Math.max(0, Math.floor(Number(s.commentCount) || 0)),
    date: Number(s.updatedAt) || Date.now(),
  };
}

/** Запомненная ссылка годится, если это та же сводка (тот же updatedAt) того же бота. */
export function savedLink(saved, s, baseUrl) {
  if (!saved || typeof saved !== "object" || !s) return null;
  if (saved.at !== (Number(s.updatedAt) || 0) || saved.base !== String(baseUrl || "")) return null;
  return typeof saved.url === "string" && saved.url && ID_RE.test(String(saved.id || "")) ? saved : null;
}

/** Что запомнить после удачного ответа. */
export function linkRecord(r, s, baseUrl) {
  return { id: r.id, url: r.url, at: Number(s?.updatedAt) || 0, base: String(baseUrl || "") };
}

const fail = (kind, text) => ({ ok: false, kind, text });

function common(status, d) {
  if (status === -1) return fail("timeout", "Бот не ответил вовремя — попробуйте ещё раз через минуту");
  if (status === 0) return fail("network", "Бот недоступен — возможно, просыпается. Попробуйте через минуту");
  // старая версия бота: адреса /api/share-summary у неё нет
  if (status === 404 || status === 405) return fail("update", "Обновите бота: он пока не умеет делиться сводкой");
  if (status === 403) return fail("forbidden", "Бот не принял секрет — проверьте его в настройках панели");
  if (status === 503 && d.code === "no_owner") return fail("setup", "В боте не указан владелец (OWNER_ID)");
  if (status >= 500) return fail("error", "Сбой в боте — попробуйте ещё раз");
  return null;
}

/**
 * Ответ бота на создание → { ok: true, id, url, existed } или { ok: false, kind, text }.
 * status — HTTP-код (0 — сеть недоступна, -1 — таймаут), data — разобранный JSON или null.
 */
export function shareResult(status, data) {
  const d = data && typeof data === "object" ? data : {};
  if (status === 200 && d.ok && ID_RE.test(String(d.id || "")) && /^https?:\/\//.test(String(d.url || ""))) {
    return { ok: true, id: String(d.id), url: String(d.url), existed: Boolean(d.existed) };
  }
  if (status === 429) return fail("busy", "На сегодня ссылок хватит — бот даёт до 30 в сутки");
  if (status === 413) return fail("error", "Сводка слишком большая для ссылки");
  if (status === 400) return fail("error", "Бот не принял сводку — обновите её и попробуйте снова");
  if (status === 200) return fail("update", "Обновите бота: он пока не умеет делиться сводкой");
  return common(status, d) || fail("error", `Бот не дал ссылку (${status})`);
}

/** Ответ бота на отзыв → { ok: true } или { ok: false, kind, text }. */
export function revokeResult(status, data) {
  const d = data && typeof data === "object" ? data : {};
  if (status === 200 && d.ok) return { ok: true, revoked: Boolean(d.revoked) };
  return common(status, d) || fail("error", `Не получилось отозвать ссылку (${status})`);
}

export const NOT_SET_UP = { ok: false, kind: "setup", text: "Бот не настроен — укажите адрес и секрет в настройках панели" };
