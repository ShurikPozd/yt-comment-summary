// «Моя библиотека»: своё меню по правому щелчку на карточке видео — в «Очереди»,
// «Плейлистах», «Подписках» и «Продолжить смотреть».
// Пункты зависят от раздела; все действия — уже существующие: те же, что у кнопок
// на карточке, полосы выбора нескольких видео (multi.js → runSel) и кнопок на
// обложке («Превью», «О чём видео» — video-actions.js). Своих механизмов здесь нет.
//   - Shift+правый щелчок, щелчок по полю ввода или по выделенному тексту — обычное
//     меню браузера;
//   - закрывается по Esc, щелчку мимо, прокрутке, смене размера окна;
//   - стрелки ↑/↓, Home/End — по пунктам, Enter/пробел — выбрать;
//   - не вылезает за край окна (открывается влево/вверх, если справа/снизу тесно);
//   - выбрано несколько видео и щёлкнули по одному из них — действия над выбранными.

import { icon } from "../sidepanel/icons.js";
import { infoFor } from "./cover-actions.js";
import { toast } from "./digest.js";
import { IC, actions as selActions, clear as clearSel, picked, runSel, sel } from "./multi.js";
import { qUrl } from "./queue-view.js";
import { esc, state, videosWord } from "./state.js";
import { fmtLen } from "./view-lib.js";

const CARDS = "#grid .card, #cont .card, #digest .card";
const svg = (body) =>
  `<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const ICON = {
  play: () => icon("play", { size: 18 }),
  tab: () => icon("external", { size: 18 }),
  preview: () => icon("eye", { size: 18 }),
  // как у кнопки «О чём видео» на обложке (video-actions.js)
  tldr: () => svg('<g transform="translate(-.75 1.95)"><path d="M4 6.5h9"/><path d="M4 11.5h12"/><path d="M4 16.5h8"/><path d="M18.5 3.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/></g>'),
  link: () => icon("link", { size: 18 }),
  time: () => icon("clock", { size: 18 }),
  channel: () => svg('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
  copy: () => icon("copy", { size: 18 }),
  unpick: () => icon("close", { size: 18 }),
  top: () => IC.top(18),
  bottom: () => IC.bottom(18),
  save: () => IC.save(18),
  queue: () => IC.queue(18),
  remove: () => IC.remove(18),
  minus: () => IC.minus(18),
  hide: () => IC.hide(18),
};

const idOf = (card) => card?.dataset.qid || card?.dataset.vid || card?.dataset.did || "";
const sectionOf = (card) => (card.dataset.qid ? "queue" : card.dataset.did ? "digest" : "lib");
const watchUrl = (id, short) => (short ? `https://www.youtube.com/shorts/${encodeURIComponent(id)}` : `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`);
const isShort = (id) =>
  Boolean(state.queue.find((x) => x.id === id)?.short || state.cat?.videos.find((x) => x.id === id)?.short || state.digestById?.get(id)?.short);

// канал видео: в каталоге плейлистов и в дайджесте есть его id; в очереди — только
// название, тогда ищем канал по названию на YouTube
function channelUrl(id, name) {
  const cid = state.cat?.videos.find((x) => x.id === id)?.channelId || state.digestById?.get(id)?.channelId || "";
  if (/^UC[\w-]{22}$/.test(cid)) return `https://www.youtube.com/channel/${cid}`;
  return name ? `https://www.youtube.com/results?search_query=${encodeURIComponent(name)}&sp=EgIQAg%253D%253D` : "";
}

async function copy(text, done) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // запасной путь: страница без фокуса или старый браузер
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(ta);
    ta.select();
    try {
      ok = document.execCommand("copy");
    } catch {}
    ta.remove();
  }
  toast(ok ? done : "Не получилось скопировать — браузер не дал доступ к буферу обмена");
}

function openTab(url) {
  if (chrome.tabs?.create) void chrome.tabs.create({ url, active: true }).catch(() => window.open(url, "_blank", "noopener"));
  else window.open(url, "_blank", "noopener");
}

// «Смотреть» — тот же щелчок по названию, что и мышью: свой плеер, вкладка очереди
// или YouTube (как настроено). ytcsMenu — чтобы режим выбора (multi.js) не перехватил щелчок.
function play(card) {
  const a = card.querySelector("a.title") || card.querySelector("a.thumb");
  if (!a) return;
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window });
  ev.ytcsMenu = true;
  a.dispatchEvent(ev);
}

// ---------- пункты меню ----------
// [ключ значка, подпись, действие, { danger }] или "-" — разделитель
function singleItems(card) {
  const id = idOf(card);
  const where = sectionOf(card);
  const info = infoFor(card);
  const qi = state.queue.findIndex((x) => x.id === id);
  const inQ = qi >= 0;
  const t = Math.floor(state.qpos[id] || 0);
  const short = isShort(id);
  const plain = watchUrl(id, short);
  const items = [
    ["play", t > 5 && !short ? `Смотреть с ${fmtLen(t)}` : "Смотреть", () => play(card)],
    [
      "tab",
      "Открыть в новой вкладке",
      () => {
        // «Подписки»: открытое в новой вкладке считается прочитанным (как средний щелчок)
        if (where === "digest") card.querySelector("a.title")?.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
        openTab(inQ ? qUrl(state.queue[qi]) : plain);
      },
    ],
    "-",
  ];
  if (inQ) {
    if (qi > 0) items.push(["top", "Наверх очереди", () => runSel("top", [id])]);
    if (where === "queue" && qi < state.queue.length - 1) items.push(["bottom", "В конец очереди", () => runSel("bottom", [id])]);
    items.push(["remove", "Убрать из очереди", () => runSel("qdel", [id]), { danger: true }]);
  } else items.push(["queue", "В очередь", () => runSel(where === "digest" ? "dq" : "queue", [id])]);
  items.push(["save", "Сохранить в плейлист", () => runSel("save", [id])]);
  const p = where === "lib" && state.pl && state.pl !== "LL" ? state.plById.get(state.pl) : null;
  if (p) items.push(["minus", `Убрать из «${p.title}»`, () => runSel("pldel", [id]), { danger: true }]);
  const va = globalThis.__ytcsVideoActions;
  if (va) {
    items.push("-");
    items.push(["preview", "Превью обложки", () => va.openPreview(info)]);
    items.push(["tldr", "О чём видео", () => va.openTldr(card.querySelector(".thumb") || card, info, { card })]);
  }
  items.push("-");
  items.push(["link", "Копировать ссылку", () => copy(plain, "Ссылка скопирована")]);
  if (t > 5 && !short) items.push(["time", `Ссылка с ${fmtLen(t)}`, () => copy(`${plain}&t=${t}s`, `Ссылка с ${fmtLen(t)} скопирована`)]);
  const ch = channelUrl(id, info.channel);
  if (ch) items.push(["channel", info.channel ? `Канал «${info.channel}»` : "Открыть канал", () => openTab(ch)]);
  if (where === "digest") {
    items.push("-");
    items.push(["hide", "Не интересно", () => runSel("dhide", [id]), { danger: true }]);
  }
  return { head: info.title || "Видео", items };
}

// выбрано несколько видео — те же действия, что в полосе «Выбрано: N»
function multiItems() {
  const ids = picked();
  const KEY = { top: "top", bottom: "bottom", save: "save", qdel: "remove", queue: "queue", pldel: "minus", dq: "queue", dhide: "hide" };
  const DANGER = new Set(["qdel", "pldel", "dhide"]);
  // в меню подписи полнее, чем на кнопках полосы: «Наверх» → «Наверх очереди»
  const LABEL = { top: "Наверх очереди", bottom: "В конец очереди", save: "Сохранить в плейлисты", qdel: "Убрать из очереди" };
  const items = selActions().map(([act, , label]) => [KEY[act] || "queue", LABEL[act] || label, () => runSel(act, ids, { fromSel: true }), { danger: DANGER.has(act) }]);
  items.push("-");
  items.push(["copy", "Копировать ссылки", () => copy(ids.map((id) => watchUrl(id, isShort(id))).join("\n"), `Скопировано ссылок: ${ids.length}`)]);
  items.push(["unpick", "Снять выбор", () => clearSel()]);
  return { head: `Выбрано: ${videosWord(ids.length)}`, items };
}

// ---------- меню ----------
let menu = null;
let back = null; // куда вернуть фокус по Esc
let acts = [];
let at = null; // { x, y, w } — где открыли и ширина окна в тот момент

function itemsEls() {
  return [...menu.querySelectorAll(".ctx-item:not(:disabled)")];
}

function render({ head, items }) {
  // разделители — только между группами (не в начале, не в конце, не подряд)
  const list = items.filter((x, i, a) => x !== "-" || (i > 0 && i < a.length - 1 && a[i - 1] !== "-"));
  acts = [];
  menu.innerHTML =
    `<div class="ctx-head" title="${esc(head)}">${esc(head)}</div>` +
    list
      .map((x) => {
        if (x === "-") return `<div class="ctx-sep" role="separator"></div>`;
        const [ic, label, run, o = {}] = x;
        acts.push(run);
        return `<button type="button" role="menuitem" class="ctx-item${o.danger ? " danger" : ""}" data-i="${acts.length - 1}" tabindex="-1">${ICON[ic]?.() || ""}<span class="lbl">${esc(label)}</span></button>`;
      })
      .join("");
}

function place(x, y) {
  const M = 8;
  menu.style.left = "0px";
  menu.style.top = "0px";
  const r = menu.getBoundingClientRect();
  const W = document.documentElement.clientWidth;
  const H = innerHeight;
  let left = x + r.width + M > W ? x - r.width : x;
  let top = y + r.height + M > H ? y - r.height : y;
  left = Math.max(M, Math.min(left, W - r.width - M));
  top = Math.max(M, Math.min(top, H - r.height - M));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function ensure() {
  if (menu) return;
  menu = document.createElement("div");
  menu.id = "ctx-menu";
  menu.className = "ctx-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Действия с видео");
  menu.tabIndex = -1;
  menu.hidden = true;
  menu.addEventListener("click", (e) => {
    const b = e.target.closest(".ctx-item");
    if (!b) return;
    const run = acts[Number(b.dataset.i)];
    close(false);
    run?.();
  });
  // наведение и стрелки — одна подсветка (фокус)
  menu.addEventListener("pointermove", (e) => {
    const b = e.target.closest(".ctx-item");
    if (b && document.activeElement !== b) b.focus({ preventScroll: true });
  });
  menu.addEventListener("pointerleave", () => menu.contains(document.activeElement) && menu.focus({ preventScroll: true }));
  menu.addEventListener("contextmenu", (e) => e.preventDefault());
  document.body.append(menu);
}

export function openMenu(card, x, y, { keyboard = false } = {}) {
  ensure();
  const id = idOf(card);
  const multi = sel.ids.size > 1 && sel.ids.has(id);
  back = document.activeElement;
  render(multi ? multiItems() : singleItems(card));
  menu.hidden = false;
  menu.classList.toggle("multi", multi);
  place(x, y);
  at = { x, y, w: innerWidth };
  if (keyboard) itemsEls()[0]?.focus({ preventScroll: true });
  else menu.focus({ preventScroll: true });
  addEventListener("keydown", onKey, true);
  addEventListener("pointerdown", onDown, true);
  addEventListener("scroll", onScroll, true);
  addEventListener("wheel", onScroll, { capture: true, passive: true });
  addEventListener("resize", onResize);
  addEventListener("blur", onClose);
  addEventListener("hashchange", onClose);
}

export function close(restore = true) {
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  removeEventListener("keydown", onKey, true);
  removeEventListener("pointerdown", onDown, true);
  removeEventListener("scroll", onScroll, true);
  removeEventListener("wheel", onScroll, { capture: true });
  removeEventListener("resize", onResize);
  removeEventListener("blur", onClose);
  removeEventListener("hashchange", onClose);
  if (restore && back?.isConnected) back.focus?.({ preventScroll: true });
  back = null;
}

const onClose = () => close(false);
// окно стало уже или шире — карточки перестроились, меню больше не у своей карточки;
// поменялась только высота — меню остаётся, но не вылезает за край
function onResize() {
  if (!at || innerWidth !== at.w) return close(false);
  place(at.x, at.y);
}
// событие внутри меню (прокрутка длинного меню, щелчок по пункту) — не закрываем
const inside = (e) => e.target instanceof Node && menu.contains(e.target);
function onDown(e) {
  if (!inside(e)) close(false);
}
function onScroll(e) {
  if (!inside(e)) close(false);
}

function onKey(e) {
  // на окне в фазе перехвата — раньше, чем Esc снимет выбор (multi.js) или закроет плеер
  const items = itemsEls();
  const i = items.indexOf(document.activeElement);
  const go = (n) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    items[(n + items.length) % items.length]?.focus({ preventScroll: true });
  };
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  } else if (e.key === "ArrowDown") go(i + 1);
  else if (e.key === "ArrowUp") go(i < 0 ? items.length - 1 : i - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(items.length - 1);
  else if (e.key === "Tab") {
    e.preventDefault();
    close();
  } else if ((e.key === "Enter" || e.key === " ") && i < 0) {
    e.preventDefault(); // фокус на самом меню — Enter ничего не нажимает
  }
}

// ---------- правый щелчок ----------
function nativeWanted(e) {
  if (e.shiftKey) return true;
  const t = e.target;
  if (t.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return true;
  const s = getSelection();
  return Boolean(s && !s.isCollapsed && s.toString().trim() && s.containsNode(t, true));
}

document.addEventListener("contextmenu", (e) => {
  const card = e.target.closest?.(CARDS);
  if (!card || !idOf(card) || nativeWanted(e)) return void close(false);
  e.preventDefault();
  // клавиша меню / Shift+F10 — координат нет: открываем у карточки
  const keyboard = !e.clientX && !e.clientY;
  let { clientX: x, clientY: y } = e;
  if (keyboard) {
    const r = (document.activeElement && card.contains(document.activeElement) ? document.activeElement : card).getBoundingClientRect();
    x = r.left + 12;
    y = r.bottom - 4;
  }
  openMenu(card, x, y, { keyboard });
});
