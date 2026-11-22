// Набор иконок расширения: контурные 24×24, обводка 2, скруглённые концы,
// цвет — currentColor (работают в светлой и тёмной теме). Нарисованы для
// расширения, без внешних загрузок и сторонних лицензий.

const P = {
  // сводка — строки текста (нейтральный знак вместо «искр» ИИ)
  summary: '<path d="M4 6h16"/><path d="M4 11h16"/><path d="M4 16h11"/><path d="M4 21h7"/>',
  // ИИ-анализ (больше не используется в интерфейсе)
  sparkles:
    '<path d="M11 3l1.9 4.8L17.7 9.7l-4.8 1.9L11 16.4l-1.9-4.8L4.3 9.7l4.8-1.9z"/><path d="M18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  refresh:
    '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  download: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>',
  settings:
    '<path d="M4 7h9"/><path d="M19 7h1"/><circle cx="16" cy="7" r="2.5"/><path d="M4 17h2"/><path d="M12 17h8"/><circle cx="9" cy="17" r="2.5"/>',
  copy:
    '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
  file:
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11v6"/><path d="M9 14l3 3 3-3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  heart: '<path d="M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9z"/>',
  reply: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  // ножницы — «Вырезать клип»
  clip: '<circle cx="6" cy="7" r="2.6"/><circle cx="6" cy="17" r="2.6"/><path d="M8.2 8.4L20 17"/><path d="M8.2 15.6L20 7"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  // боковая панель — окно с полосой справа
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  // «Моя библиотека» — стопка плейлистов с кнопкой воспроизведения
  library: '<rect x="3" y="8" width="14" height="12" rx="2"/><path d="M7 4.5h11a2.5 2.5 0 0 1 2.5 2.5v9"/><path d="M8.5 11.5v5l4-2.5z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 8v4l3 2"/>',
  chat:
    '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 11h7"/><path d="M8.5 14.5h4"/>',
};

/** SVG-строка иконки. size — в px, cls — доп. класс. */
export function icon(name, { size = 16, cls = "" } = {}) {
  const body = P[name];
  if (!body) return "";
  return `<svg class="ic${cls ? " " + cls : ""}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Подставляет иконки в статическую разметку: <span data-icon="eye" data-size="14">. */
export function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = icon(el.dataset.icon, { size: Number(el.dataset.size) || 16 });
  });
}
