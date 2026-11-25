// «Моя библиотека», раздел «Плейлисты»: выбор плейлиста одной кнопкой-списком
// «Плейлист: Все ▾» — в узком окне и в боковой панели (вместо ленты плашек, уезжающей
// вбок, и отдельного поля «Найти плейлист»). В широком окне слева остаётся колонка
// плейлистов — там всё видно сразу.
// Внутри: поиск по названиям, у каждого число видео (пока идёт поиск — сколько найдено
// в нём), «Все плейлисты», «Смотреть позже» и «Понравившиеся» сверху; внизу —
// «Порядок в плейлистах» и «Резервная копия» (их кнопки были в конце ленты).
// Клавиши: ↑/↓ — по списку, Enter — выбрать, Esc — закрыть.

import { icon } from "../sidepanel/icons.js";
import { setPl } from "./library.js";
import { $, SPECIAL, esc, nf, state } from "./state.js";

const btn = $("#pl-pick");
const pop = $("#pl-pop");
let rows = []; // [{ id, title, n }] — что сейчас в списке
let act = 0; // подсвеченная строка

const countOf = (p) => (state.perPl ? state.perPl.get(p.id) || 0 : p.count || 0);

// подпись кнопки: «Плейлист: Все» / «Плейлист: Смешное (Shorts)» (сколько видео — в строке над видео)
export function renderPick() {
  if (!state.cat) return;
  const p = state.pl ? state.plById.get(state.pl) : null;
  btn.querySelector(".pl-pick-v").textContent = p ? p.title : "Все";
  btn.title = p ? `Плейлист «${p.title}» — выбрать другой` : "Выбрать плейлист";
  if (!pop.hidden) renderList();
}

function listFor(q) {
  const all = [...state.plById.values()].sort((a, b) => a.rank - b.rank);
  const items = q ? all.filter((p) => p.title.toLowerCase().includes(q)) : all;
  const special = items.filter((p) => p.id in SPECIAL);
  const rest = items.filter((p) => !(p.id in SPECIAL));
  // идёт поиск — плейлисты, где что-то нашлось, выше
  if (state.perPl) rest.sort((a, b) => (state.perPl.get(b.id) || 0) - (state.perPl.get(a.id) || 0) || a.rank - b.rank);
  const total = state.q.trim() && state.meta?.results ? state.meta.results.length : state.cat.videos.length;
  return { head: q ? [] : [{ id: "", title: "Все плейлисты", n: total }], special, rest };
}

function rowHtml(r, i) {
  const ic = r.id === "" ? "library" : r.id === "LL" ? "heart" : r.id === "WL" ? "clock" : "";
  const on = (state.pl || "") === r.id;
  const dim = state.perPl && r.id && !r.n;
  return `<button type="button" role="option" id="pp-${i}" class="pp-row${on ? " on" : ""}${i === act ? " act" : ""}${dim ? " dim" : ""}" data-i="${i}" aria-selected="${on}" tabindex="-1">
    <span class="pp-ic${ic ? ` ic-${ic}` : ""}">${ic ? icon(ic, { size: 16 }) : ""}</span><span class="pp-name">${esc(r.title)}</span><span class="pp-n">${nf.format(r.n)}</span>${
      on ? `<span class="pp-check">${icon("check", { size: 16 })}</span>` : ""
    }</button>`;
}

function renderList() {
  const input = pop.querySelector(".pp-q");
  const q = (input?.value || "").trim().toLowerCase();
  const { head, special, rest } = listFor(q);
  rows = [...head, ...special.map((p) => ({ id: p.id, title: p.title, n: countOf(p) })), ...rest.map((p) => ({ id: p.id, title: p.title, n: countOf(p) }))];
  act = Math.min(act, Math.max(0, rows.length - 1));
  let i = 0;
  let html = [...head, ...special].map(() => rowHtml(rows[i], i++)).join("");
  if (rest.length) html += `<div class="pp-sep" role="presentation">Плейлисты · ${nf.format(rest.length)}</div>` + rest.map(() => rowHtml(rows[i], i++)).join("");
  if (!rows.length) html = `<div class="pp-none">Плейлист не найден</div>`;
  const list = pop.querySelector(".pp-list");
  list.innerHTML = html;
  input?.setAttribute("aria-activedescendant", rows.length ? `pp-${act}` : "");
}

function setAct(i) {
  if (!rows.length) return;
  act = (i + rows.length) % rows.length;
  for (const r of pop.querySelectorAll(".pp-row")) r.classList.toggle("act", Number(r.dataset.i) === act);
  pop.querySelector(".pp-q").setAttribute("aria-activedescendant", `pp-${act}`);
  pop.querySelector(`#pp-${act}`)?.scrollIntoView({ block: "nearest" });
}

function pick(i) {
  const r = rows[i];
  if (!r) return;
  close();
  if ((state.pl || "") !== r.id) setPl(r.id);
  window.scrollTo({ top: 0 });
}

export function open() {
  if (!state.cat || !pop.hidden) return;
  pop.innerHTML = `<label class="pp-search">${icon("search", { size: 16 })}<input class="pp-q" type="search" autocomplete="off" spellcheck="false" placeholder="Найти плейлист" aria-label="Найти плейлист" role="combobox" aria-expanded="true" aria-controls="pp-list" /></label>
    <div class="pp-list" id="pp-list" role="listbox" aria-label="Плейлисты"></div>
    <div class="pp-foot">
      <button type="button" class="ghost" data-td="open" title="Удалённые видео, повторы, видео во многих плейлистах">${icon("settings", { size: 16 })}Порядок в плейлистах</button>
      <button type="button" class="ghost" data-bk="open" title="Очередь, настройки и список плейлистов — в файл и обратно">${icon("file", { size: 16 })}Резервная копия</button>
    </div>`;
  pop.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  rows = [];
  act = 0;
  renderList();
  act = Math.max(0, rows.findIndex((r) => r.id === (state.pl || "")));
  setAct(act);
  pop.querySelector(".pp-q").focus({ preventScroll: true });
  addEventListener("pointerdown", onDown, true);
  addEventListener("keydown", onKey, true);
}

export function close(refocus = false) {
  if (pop.hidden) return;
  pop.hidden = true;
  btn.setAttribute("aria-expanded", "false");
  removeEventListener("pointerdown", onDown, true);
  removeEventListener("keydown", onKey, true);
  if (refocus) btn.focus({ preventScroll: true });
}

function onDown(e) {
  if (!(e.target instanceof Node) || !(pop.contains(e.target) || btn.contains(e.target))) close();
}

function onKey(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    close(true);
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    setAct(act + (e.key === "ArrowDown" ? 1 : -1));
  } else if (e.key === "Enter" && pop.contains(e.target) && !e.target.closest(".pp-foot")) {
    e.preventDefault();
    pick(act);
  } else if (e.key === "Tab") close();
}

btn.addEventListener("click", () => (pop.hidden ? open() : close()));
pop.addEventListener("input", (e) => {
  if (!e.target.closest(".pp-q")) return;
  act = 0;
  renderList();
});
pop.addEventListener("click", (e) => {
  const r = e.target.closest(".pp-row");
  if (r) return pick(Number(r.dataset.i));
  if (e.target.closest(".pp-foot button")) close(); // «Порядок…» и «Резервная копия» открывают свои окна сами
});
pop.addEventListener("pointermove", (e) => {
  const r = e.target.closest(".pp-row");
  if (r && Number(r.dataset.i) !== act) setAct(Number(r.dataset.i));
});
document.addEventListener("click", (e) => {
  if (e.target.closest(".views [data-view]")) close();
});
