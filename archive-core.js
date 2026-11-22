// «В архив Telegram»: общее ядро без chrome.* и DOM (его же гоняет tests/run.mjs).
// Видео (ссылка, название, канал, длительность и, если уже есть, пересказ «О чём
// видео») уходит в личный бот-архив @SaveandSort_bot: POST /api/save-video с тем же
// секретом X-Sec-Token, что у /api/chat. Бот кладёт его в архив как обычный пост
// (категорию выбирает ИИ) и пишет в Telegram «Сохранено в «…»».
// Запрос делает фон (archive-bg.js); кнопки и плашки — video-actions.js и content.js.

export const ARCHIVE_PATH = "/api/save-video";
export const ARCHIVE_MARK_PREFIX = "tgarch:"; // tgarch:<id> → { cat, at } — уже в архиве
export const ARCHIVE_TIMEOUT_MS = 90000; // бот на Render может просыпаться ~50 с

const VID_RE = /^[A-Za-z0-9_-]{11}$/;
const TLDR_MAX = 3000; // бот всё равно обрежет до стольких

const two = (n) => String(n).padStart(2, "0");
export function fmtLen(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

/** Пересказ из кеша tldr:<id> ({about, points:[{t, x}]}) — обычным текстом для поста. */
export function tldrPlain(e) {
  if (!e || typeof e !== "object") return "";
  const out = [];
  if (e.about) out.push(String(e.about).trim());
  const pts = Array.isArray(e.points) ? e.points.filter((p) => p && p.x) : [];
  if (pts.length) {
    if (out.length) out.push("");
    for (const p of pts) out.push(`${fmtLen(p.t)} — ${String(p.x).trim()}`);
  }
  const s = out.join("\n").trim();
  return s.length > TLDR_MAX ? s.slice(0, TLDR_MAX - 1).trimEnd() + "…" : s;
}

/** Тело запроса к боту. null — если id видео негодный. */
export function archiveBody(info, tldr = "") {
  const videoId = String(info?.videoId || "");
  if (!VID_RE.test(videoId)) return null;
  const len = Math.max(0, Math.floor(Number(info?.len) || 0));
  return {
    videoId,
    title: String(info?.title || "").trim().slice(0, 300),
    channel: String(info?.channel || "").trim().slice(0, 120),
    len,
    tldr: String(tldr || "").slice(0, TLDR_MAX),
  };
}

/**
 * Ответ бота → итог для интерфейса.
 *   { ok: true, status: "saved" | "exists", category, queued }
 *   { ok: false, kind, text } — kind: setup | update | forbidden | busy | offline | network | timeout | error
 * status — HTTP-код (0 — сеть недоступна, -1 — таймаут), data — разобранный JSON или null.
 */
export function archiveResult(status, data) {
  const d = data && typeof data === "object" ? data : {};
  if (status === 200 && d.ok && (d.status === "saved" || d.status === "exists")) {
    return { ok: true, status: d.status, category: String(d.category || "Видео"), queued: Boolean(d.queued) };
  }
  const fail = (kind, text) => ({ ok: false, kind, text });
  if (status === -1) return fail("timeout", "Бот не ответил вовремя — проверьте чат с ботом, видео могло сохраниться");
  if (status === 0) return fail("network", "Бот недоступен — возможно, просыпается. Попробуйте через минуту");
  // старая версия бота: адреса /api/save-video у неё нет
  if (status === 404 || status === 405) return fail("update", "Обновите бота: он пока не умеет сохранять видео");
  if (status === 403) return fail("forbidden", "Бот не принял секрет — проверьте его в настройках панели");
  if (status === 429) return fail("busy", "Слишком много видео подряд — попробуйте через несколько минут");
  if (status === 503 && d.code === "tg_offline") return fail("offline", "Бот сейчас не на связи с Telegram — попробуйте позже");
  if (status === 503 && d.code === "no_owner") return fail("setup", "В боте не указан владелец архива (OWNER_ID)");
  if (status === 502 && d.code === "tg_send") return fail("offline", "Бот не смог написать в Telegram — попробуйте позже");
  if (status >= 500) return fail("error", "Сбой в боте — попробуйте ещё раз");
  return fail("error", `Бот не принял видео (${status})`);
}

/** Текст плашки по итогу. */
export function archiveMessage(r) {
  if (!r) return "Не получилось сохранить в архив";
  if (!r.ok) return r.text;
  if (r.status === "exists") return `Уже в архиве — «${r.category}»`;
  if (r.queued) return `Сохранено в «${r.category}» — папку бот уточнит позже`;
  return `Сохранено в «${r.category}»`;
}

export const NOT_SET_UP = { ok: false, kind: "setup", text: "Бот не настроен — укажите секрет в настройках панели" };
