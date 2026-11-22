// «Моя библиотека»: раздел «Плейлисты» — поиск, фильтры, карточки, колонка плейлистов.

import { icon } from "../sidepanel/icons.js";
import { sync } from "./catalog.js";
import { saveHash } from "./library.js";
import { qCardHtml, updateQueue } from "./queue-view.js";
import { highlight, search } from "./search.js";
import { $, PAGE, SPECIAL, esc, nf, plWord, plural, state, videosWord } from "./state.js";
import { watch } from "./watch.js";
import { yt } from "./youtube.js";
import "./tidy.js";
import { embedQuery, sem, semanticScores } from "./semantic.js";
import "./sem-ui.js";
import "./backup.js";

// ---------- поиск и фильтры ----------
export function durOk(v, dur) {
  if (!dur) return true;
  if (v.short) return dur.startsWith("0-"); // Shorts — в «Shorts и до 1 мин»
  const [a, b] = dur.split("-");
  return v.len >= Number(a) && (b === "" || v.len < Number(b));
}

export function inPl(v, pl) {
  return v.in.some(([id]) => id === pl);
}

export function compute() {
  const vids = state.cat.videos;
  const allowBase = (d) => durOk(vids[d], state.dur);
  const allow = state.pl ? (d) => allowBase(d) && inPl(vids[d], state.pl) : allowBase;
  let list;
  let meta = { partial: false, swapped: null };
  let perPl = null;
  if (state.q.trim()) {
    // счётчики у плейлистов слева — сколько найдено в каждом (без фильтра по плейлисту)
    const wide = search(state.index, state.q, allowBase);
    meta = wide;
    // по смыслу: к совпадениям по словам добавляем близкие по теме
    const sc = sem.on && sem.status === "ready" ? semanticScores(state.q, allowBase) : null;
    if (sem.on && sem.status === "ready" && !sc) void embedQuery(state.q).then(() => update({ keep: true }));
    if (sc) {
      const lex = new Map((wide.results || []).filter(() => !wide.partial).map((r) => [r.d, r]));
      const all = new Set([...sc.keys(), ...lex.keys()]);
      wide.results = [...all]
        .map((d) => ({ d, hits: lex.get(d)?.hits || null, score: (sc.get(d) || 0) + (lex.has(d) ? 0.3 : 0) }))
        .sort((a, b) => b.score - a.score);
      wide.partial = false;
      wide.swapped = lex.size ? wide.swapped : null;
      meta = { ...wide, semantic: true };
    }
    if (wide.results) {
      perPl = new Map();
      for (const r of wide.results) for (const [id] of vids[r.d].in) perPl.set(id, (perPl.get(id) || 0) + 1);
    }
    list = (wide.results || []).filter((r) => !state.pl || inPl(vids[r.d], state.pl));
  } else {
    list = state.order.filter(({ d }) => allow(d)).map(({ d }) => ({ d, hits: null }));
  }
  const pos = (d) => {
    const v = vids[d];
    if (state.pl) return v.in.find(([id]) => id === state.pl)?.[1] ?? 0;
    return 0;
  };
  const sort = state.sort;
  if (sort === "order" || (sort === "auto" && !state.q.trim())) {
    if (state.pl) list.sort((a, b) => pos(a.d) - pos(b.d));
    else if (state.q.trim()) {
      const rank = new Map(state.order.map((o, i) => [o.d, i]));
      list.sort((a, b) => rank.get(a.d) - rank.get(b.d));
    }
  } else if (sort === "long") list.sort((a, b) => vids[b.d].len - vids[a.d].len);
  else if (sort === "short") list.sort((a, b) => vids[a.d].len - vids[b.d].len);
  else if (sort === "channel") list.sort((a, b) => vids[a.d].channel.localeCompare(vids[b.d].channel, "ru"));
  return { list, meta, perPl };
}

export function update({ keep = false } = {}) {
  if (state.view === "queue") return updateQueue({ keep });
  if (!state.cat) {
    state.list = [];
    state.shown = 0;
    $("#grid").textContent = "";
    return renderEmpty();
  }
  const { list, meta, perPl } = compute();
  const was = state.shown;
  const y = window.scrollY;
  state.list = list;
  state.meta = meta;
  state.perPl = perPl;
  state.shown = 0;
  $("#grid").textContent = "";
  renderSide();
  renderSummary();
  if (keep) {
    // перерисовать столько же карточек и вернуть прокрутку на место
    while (state.shown < Math.min(was, list.length)) more();
    window.scrollTo({ top: y });
  } else {
    window.scrollTo({ top: 0 });
    more();
  }
  saveHash();
}

// ---------- отрисовка ----------
export const fmtLen = (s) => {
  if (!s) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};
export const mark = (text, hits) =>
  highlight(text, hits)
    .map((p) => (p.hit ? `<mark>${esc(p.t)}</mark>` : esc(p.t)))
    .join("");

export function cardHtml({ d, hits }) {
  const v = state.cat.videos[d];
  const list = state.pl && inPl(v, state.pl) ? `&list=${encodeURIComponent(state.pl)}` : "";
  const href = v.short ? `https://www.youtube.com/shorts/${encodeURIComponent(v.id)}` : `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}${list}`;
  const pls = v.in.map(([id]) => state.plById.get(id)).filter(Boolean);
  pls.sort((a, b) => (a.id === state.pl) - (b.id === state.pl) || a.rank - b.rank);
  const shown = pls.slice(0, 3);
  const rest = pls.length - shown.length;
  const info = (v.info || "").replace(/\s*•\s*/g, " · "); // у YouTube то «•», то «·»
  const sub = [v.channel || (v.short ? "Shorts" : ""), info].filter(Boolean).join(" · ");
  return `<article class="card" data-vid="${esc(v.id)}">
    <a class="thumb" href="${href}" target="_blank" rel="noreferrer" tabindex="-1" aria-label="${esc(v.title)}">
      <img loading="lazy" decoding="async" alt="" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg" />
      ${v.len ? `<span class="dur">${fmtLen(v.len)}</span>` : v.short ? `<span class="dur">Shorts</span>` : ""}
    </a>
    <a class="title" href="${href}" target="_blank" rel="noreferrer" title="${esc(v.title)}">${hits ? mark(v.title, hits) : esc(v.title)}</a>
    <div class="sub" title="${esc(sub)}">${v.channel ? (hits ? mark(v.channel, hits) : esc(v.channel)) : v.short ? "Shorts" : ""}${info ? `${v.channel || v.short ? " · " : ""}${esc(info)}` : ""}</div>
    <div class="pls">${shown
      .map((p) => `<button type="button" class="chip" data-pl="${esc(p.id)}" title="Показать плейлист «${esc(p.title)}»">${hits ? mark(p.title, hits) : esc(p.title)}</button>`)
      .join("")}${rest > 0 ? `<button type="button" class="chip more-pl" data-more="${d}" title="${esc(pls.slice(3).map((p) => p.title).join(", "))}">+${rest}</button>` : ""}</div>
  </article>`;
}

export function more() {
  const grid = $("#grid");
  const next = state.list.slice(state.shown, state.shown + PAGE);
  if (!next.length) return;
  grid.insertAdjacentHTML("beforeend", next.map(state.view === "queue" ? qCardHtml : cardHtml).join(""));
  state.shown += next.length;
}

export function renderSummary() {
  const el = $("#summary");
  const empty = $("#empty");
  const n = state.list.length;
  const pl = state.pl ? state.plById.get(state.pl) : null;
  const where = pl ? ` в «${esc(pl.title)}»` : "";
  if (!n) {
    el.innerHTML = "";
    empty.hidden = false;
    const filtered = state.pl || state.dur;
    empty.innerHTML = `<div class="empty-box">
      <div class="empty-icon">${icon("search", { size: 28 })}</div>
      <div class="empty-title">${state.q.trim() ? "Ничего не нашлось" : "Здесь пусто"}</div>
      <div class="empty-text">${
        state.q.trim()
          ? `По запросу «${esc(state.q.trim())}»${where} нет видео${filtered ? " — попробуйте убрать фильтры" : ". Попробуйте другие слова или часть названия"}.`
          : "Под выбранные фильтры не подходит ни одно видео."
      }</div>
      ${filtered ? `<button type="button" class="ghost" data-act="reset">Сбросить фильтры</button>` : ""}
    </div>`;
    return;
  }
  empty.hidden = true;
  let text = state.q.trim() ? `Найдено <b>${videosWord(n)}</b>${where}` : `<b>${videosWord(n)}</b>${where}`;
  if (state.meta?.semantic) text += ` · <span class="swap">с похожими по смыслу</span>`;
  if (state.meta?.swapped) text += ` · <span class="swap">запрос понят как «${esc(state.meta.swapped)}»</span>`;
  if (state.meta?.partial) text += ` · <span class="swap">точных совпадений нет — показаны похожие</span>`;
  el.innerHTML = text;
}

export function renderSide() {
  const box = $("#pl-list");
  const all = [...state.plById.values()].sort((a, b) => a.rank - b.rank);
  const q = state.plQ.trim().toLowerCase();
  const items = q ? all.filter((p) => p.title.toLowerCase().includes(q)) : all;
  const per = state.perPl;
  const totalHits = state.q.trim() && state.meta?.results ? state.meta.results.length : null;
  const count = (p) => (per ? per.get(p.id) || 0 : p.count || 0);
  const row = (p) => {
    const c = count(p);
    const safe = /^https:\/\/i\d?\.ytimg\.com\/[^'"()\s\\]+$/.test(p.thumb || "") ? p.thumb : "";
    const thumb = safe ? `style="background-image:url('${safe}')"` : "";
    return `<button type="button" class="pl" data-pl="${esc(p.id)}" aria-current="${state.pl === p.id}" ${per && !c ? 'style="opacity:.45"' : ""}>
      <span class="pl-thumb" ${thumb}>${p.thumb ? "" : icon(p.id === "LL" ? "heart" : p.id === "WL" ? "clock" : "library", { size: 18 })}</span>
      <span class="pl-name" title="${esc(p.title)}">${esc(p.title)}</span>
      <span class="pl-count">${nf.format(c)}</span>
    </button>`;
  };
  const allCount = totalHits ?? state.cat.videos.length;
  let html = q
    ? ""
    : `<button type="button" class="pl" data-pl="" aria-current="${!state.pl}">
      <span class="pl-thumb">${icon("library", { size: 18 })}</span>
      <span class="pl-name">Все плейлисты</span>
      <span class="pl-count">${nf.format(allCount)}</span>
    </button>`;
  const special = items.filter((p) => p.id in SPECIAL);
  const rest = items.filter((p) => !(p.id in SPECIAL));
  // идёт поиск — плейлисты, где что-то нашлось, поднимаются наверх
  if (per) rest.sort((a, b) => (per.get(b.id) || 0) - (per.get(a.id) || 0) || a.rank - b.rank);
  html += special.map(row).join("");
  if (rest.length) html += `<div class="pl-sep">Плейлисты · ${nf.format(rest.length)}</div>` + rest.map(row).join("");
  if (!items.length) html += `<div class="pl-sep">Плейлист не найден</div>`;
  if (!q)
    html += `<button type="button" class="ghost td-open" data-td="open" title="Удалённые видео, повторы, видео во многих плейлистах">${icon("settings", { size: 16 })}Порядок в плейлистах</button>
      <button type="button" class="ghost td-open" data-bk="open" title="Очередь, настройки и список плейлистов — в файл и обратно">${icon("file", { size: 16 })}Резервная копия</button>`;
  box.innerHTML = html;
}

export const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  return `${d} ${plural(d, "день", "дня", "дней")} назад`;
};

export const NOTE_FOR = 10 * 60000; // итог обновления виден столько, потом — «Обновлено N мин назад»

export function renderSync() {
  const btn = $("#sync");
  const text = $("#sync-text");
  const bar = $("#progress");
  btn.disabled = state.syncing;
  btn.classList.toggle("spin", state.syncing);
  const cat = state.cat;
  btn.title = `Обновить изменившиеся плейлисты. Удерживайте Shift — перечитать все${cat?.fullAt ? ` (все перечитаны ${ago(cat.fullAt)})` : ""}`;
  const p = state.progress;
  // две строки: что происходит — и подробности под ней (на узком окне строка скрыта, остаётся полоса)
  let main = "";
  let sub = "";
  let tip = "";
  if (state.syncing && p) {
    if (!p.total) main = "Подключаюсь к YouTube…";
    else if (p.full) {
      main = `Читаю все плейлисты: ${p.done} из ${p.total}`;
      sub = videosWord(p.videos);
    } else {
      main = `Проверяю плейлисты: ${p.done} из ${p.total}`;
      sub = p.changed ? `${plural(p.changed, "изменился", "изменились", "изменились")} ${nf.format(p.changed)}` : "пока без изменений";
    }
    bar.hidden = false;
    bar.firstElementChild.style.width = `${p.total ? Math.round((p.done / p.total) * 100) : 4}%`;
  } else {
    bar.hidden = true;
    const note = state.syncNote && Date.now() - state.syncNote.at < NOTE_FOR ? state.syncNote : null;
    if (state.error) {
      main = "Не обновилось";
      tip = state.error;
    } else if (cat) {
      main = note?.full ? `Все плейлисты перечитаны ${ago(cat.syncedAt)}` : `Обновлено ${ago(cat.syncedAt)}`;
      sub = note?.text || "";
      if (cat.fullAt && !note?.full) tip = `Все плейлисты перечитаны ${ago(cat.fullAt)}`;
    }
  }
  text.classList.toggle("two", Boolean(sub));
  text.innerHTML = main ? `<span class="st-main">${esc(main)}</span>${sub ? `<span class="st-sub">${esc(sub)}</span>` : ""}` : "";
  text.title = [sub ? `${main}: ${sub}` : main, tip].filter(Boolean).join(". ");
  if (!state.cat && state.view !== "queue") renderEmpty();
}

export function renderEmpty() {
  const empty = $("#empty");
  if (state.cat || state.view === "queue") return;
  empty.hidden = false;
  $("#summary").textContent = "";
  const p = state.progress;
  if (state.error) {
    empty.innerHTML = `<div class="empty-box">
      <div class="empty-icon">${icon("library", { size: 28 })}</div>
      <div class="empty-title">Не получилось собрать плейлисты</div>
      <div class="empty-text">${esc(state.error)}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">
        <button type="button" class="primary" data-act="sync">Повторить</button>
        <button type="button" class="ghost" data-act="open-yt">Открыть YouTube</button>
      </div>
    </div>`;
    return;
  }
  const pct = p?.total ? Math.round((p.done / p.total) * 100) : 3;
  empty.innerHTML = `<div class="empty-box">
    <div class="empty-icon">${icon("library", { size: 28 })}</div>
    <div class="empty-title">Собираю ваши плейлисты</div>
    <div class="empty-text">Один раз прочитаю все плейлисты аккаунта — дальше поиск мгновенный. Список хранится только в этом браузере.</div>
    <div class="bar"><div style="width:${pct}%"></div></div>
    <div class="empty-text">${p?.total ? `${p.done} из ${plWord(p.total)} · ${videosWord(p.videos)}` : "Подключаюсь к YouTube…"}</div>
  </div>`;
}
