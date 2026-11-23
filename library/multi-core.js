// Выбор нескольких видео в «Моей библиотеке» — чистая логика без DOM
// (её же зовёт background.js для пакетных «Наверх» / «В конец» / «Вернуть»).

// Shift+щелчок: всё от прошлого выбранного (anchor) до этого включительно, в порядке
// на экране. Прошлого нет (или он пропал из списка) — только это видео.
export function rangeIds(order, anchor, target) {
  const b = order.indexOf(target);
  if (b < 0) return [];
  const a = anchor == null ? -1 : order.indexOf(anchor);
  if (a < 0) return [target];
  return a <= b ? order.slice(a, b + 1) : order.slice(b, a + 1);
}

// Выбранные — первыми («top») или последними («bottom»), в их нынешнем порядке
// в очереди; остальные не двигаются относительно друг друга.
export function moveIds(queue, ids, where = "top") {
  const pick = new Set(ids);
  const moved = queue.filter((x) => pick.has(x.id));
  if (!moved.length) return queue.slice();
  const rest = queue.filter((x) => !pick.has(x.id));
  return where === "bottom" ? rest.concat(moved) : moved.concat(rest);
}

// «Вернуть» после «Убрать»: каждое видео — на прежнее место (at — номер в очереди
// до удаления). Ставим по возрастанию at — тогда номера совпадают с прежними.
// Уже вернувшееся в очередь второй раз не добавляем.
export function restoreAt(queue, items) {
  const out = queue.slice();
  const have = new Set(out.map((x) => x.id));
  const list = items.filter((it) => it?.rec?.id && !have.has(it.rec.id)).sort((a, b) => (a.at ?? 1e9) - (b.at ?? 1e9));
  for (const { rec, at } of list) {
    if (have.has(rec.id)) continue;
    const i = Number.isInteger(at) && at >= 0 ? Math.min(at, out.length) : out.length;
    out.splice(i, 0, rec);
    have.add(rec.id);
  }
  return out;
}

// Где каждое из выбранных стоит в очереди сейчас — для «Вернуть»
export function snapshot(queue, ids, pos = {}) {
  const pick = new Set(ids);
  const out = [];
  queue.forEach((rec, at) => {
    if (pick.has(rec.id)) out.push({ rec: { ...rec }, at, t: pos[rec.id] || 0 });
  });
  return out;
}
