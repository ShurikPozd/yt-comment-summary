// Перестановка в очереди — чистая логика без DOM. Её зовёт background.js на
// сообщение queue:move (перетаскивание в колонке очереди, «Наверх» / «В конец»
// в полосе выбора, «Вернуть»). Та же функция — копией в queue.js: колонка
// перерисовывается сразу, не дожидаясь записи.

// Видео ids — перед видео before (null — в конец очереди), в их нынешнем порядке;
// остальные не двигаются относительно друг друга. Если before само среди
// переносимых — встают перед ближайшим за ним непереносимым. before пропало из
// очереди — ничего не трогаем (лучше не двигать, чем поставить не туда).
export function moveBefore(queue, ids, before = null) {
  const pick = new Set(ids);
  const moved = queue.filter((x) => pick.has(x.id));
  if (!moved.length) return queue.slice();
  let target = null;
  if (before != null) {
    const at = queue.findIndex((x) => x.id === before);
    if (at < 0) return queue.slice();
    target = queue.slice(at).find((x) => !pick.has(x.id))?.id ?? null;
  }
  const rest = queue.filter((x) => !pick.has(x.id));
  const i = target == null ? rest.length : rest.findIndex((x) => x.id === target);
  return [...rest.slice(0, i), ...moved, ...rest.slice(i)];
}

// Несколько перестановок подряд (шаги { ids, before })
export function moveSteps(queue, steps) {
  let out = queue;
  for (const s of steps) out = moveBefore(out, s.ids, s.before);
  return out === queue ? queue.slice() : out;
}

// Шаги для «Вернуть»: queue — очередь ДО перестановки. Каждое перенесённое — перед
// своим прежним соседом справа; с конца, чтобы сосед уже стоял на месте.
export function undoSteps(queue, ids) {
  const pick = new Set(ids);
  const out = [];
  queue.forEach((x, i) => {
    if (pick.has(x.id)) out.push({ ids: [x.id], before: queue[i + 1]?.id ?? null });
  });
  return out.reverse();
}
