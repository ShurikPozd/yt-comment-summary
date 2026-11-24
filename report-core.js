// «Отчёт недели» — текст для Telegram из статистики просмотра и очереди.
// Без DOM и chrome.*: им пользуются фон (backup-bg.js — раз в неделю вместе с
// автокопией) и автопроверки (tests/run.mjs).

import { fmtDur, hasData, summarize } from "./stats-core.js";

const nf = new Intl.NumberFormat("ru-RU");
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};
const videos = (n) => `${nf.format(n)} ${plural(n, "видео", "видео", "видео")}`;

/** Сколько ещё смотреть в очереди (с учётом того, где остановились), секунд */
export function queueLeft(queue = [], pos = {}) {
  let s = 0;
  for (const r of queue) s += Math.max(0, (Number(r?.len) || 0) - (Number(pos?.[r?.id]) || 0));
  return s;
}

/**
 * Текст отчёта за последние 7 дней или null, если показать нечего
 * (статистика пуста и очередь пуста).
 */
export function weeklyReport({ stats, queue = [], queuePos = {}, now = Date.now() } = {}) {
  const lines = [];
  const has = stats && hasData(stats);
  const sm = has ? summarize(stats, 7, now, { top: 3 }) : null;
  lines.push("📊 Неделя на YouTube");
  if (sm && sm.watch >= 60) {
    const shorts = sm.shorts >= 60 ? ` (из них Shorts — ${fmtDur(sm.shorts)})` : "";
    lines.push(`🎬 Смотрели: ${fmtDur(sm.watch)}${shorts}, в среднем ${fmtDur(sm.avg)} в день`);
    if (sm.n) lines.push(`   ${videos(sm.n)}, до конца — ${nf.format(sm.fin)}`);
    if (sm.saved >= 60) {
      const parts = [];
      if (sm.speed >= 30) parts.push(`скорость — ${fmtDur(sm.speed)}`);
      if (sm.sponsor >= 30) parts.push(`пропуск рекламы — ${fmtDur(sm.sponsor)}`);
      if (sm.silence >= 30) parts.push(`пропуск тишины — ${fmtDur(sm.silence)}`);
      lines.push(`⚡ Сэкономили: ${fmtDur(sm.saved)}${parts.length ? ` (${parts.join(", ")})` : ""}`);
    }
    if (sm.channels.length) lines.push(`📺 Чаще всего: ${sm.channels.map((c) => `${c.name} — ${fmtDur(c.sec)}`).join(", ")}`);
  } else if (has) {
    lines.push("🎬 На этой неделе почти не смотрели");
  }
  const q = Array.isArray(queue) ? queue.length : 0;
  if (q || (sm && (sm.qd || sm.qx))) {
    const left = queueLeft(queue, queuePos);
    const moves = sm && (sm.qd || sm.qx) ? ` · за неделю досмотрено ${nf.format(sm.qd)}, убрано ${nf.format(sm.qx)}` : "";
    lines.push(`📥 Очередь: ${videos(q)}${left >= 60 ? ` (≈ ${fmtDur(left, { short: true })})` : ""}${moves}`);
  }
  return lines.length > 1 ? lines.join("\n") : null;
}
