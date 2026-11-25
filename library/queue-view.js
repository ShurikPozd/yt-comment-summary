// «Моя библиотека»: раздел «Очередь».

import { icon } from "../sidepanel/icons.js";
import { saveHash } from "./library.js";
import { buildIndex, search } from "./search.js";
import { $, esc, nf, plural, setSearchHint, state, videosWord } from "./state.js";
import { ago, durOk, fmtLen, mark, more, update } from "./view-lib.js";
import { openWatch, refreshWatchSide, watch, watchHere } from "./watch.js";
import { wlCardHtml } from "./wl.js";

// «Разобрать завалы» (triage.js, с ним пересказы, ИИ и подсказки — ~100 КБ) —
// грузим по первому нажатию кнопки, а не при каждом открытии библиотеки
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-act=triage]")) void import("./triage.js").then((m) => m.openTriage());
  // «Уборка очереди» (queue-tidy.js) — тоже по первому нажатию
  if (e.target.closest("[data-qt=open]")) void import("./queue-tidy.js").then((m) => m.openQTidy());
});

// ---------- очередь «посмотреть потом» ----------
export const qmsg = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

export async function loadQueue() {
  const r = await chrome.storage.local.get(["queue", "queuePos", "queueOpts", "queueUndo"]).catch(() => ({}));
  state.queue = Array.isArray(r.queue) ? r.queue : [];
  state.qpos = r.queuePos || {};
  state.qopts = { ...state.qopts, ...(r.queueOpts || {}) };
  state.qundo = r.queueUndo || null;
  state.qindex = buildIndex(state.queue.map((x) => ({ title: x.title, channel: x.channel })));
  $("#q-badge").textContent = state.queue.length ? nf.format(state.queue.length) : "";
}

chrome.storage.onChanged.addListener(async (ch, area) => {
  if (area !== "local" || !(ch.queue || ch.queuePos || ch.queueOpts || ch.queueUndo)) return;
  if (ch.queuePos && !(ch.queue || ch.queueOpts || ch.queueUndo)) {
    // пока где-то смотрят видео, место пишется каждые 5 секунд — обновляем только
    // полоски «досмотрено», не трогая открытые списки и фокус
    state.qpos = ch.queuePos.newValue || {};
    if (state.view === "queue") patchProgress();
    return;
  }
  await loadQueue();
  if (state.view === "queue") update({ keep: true });
  if (watch.on && watch.source === "queue") refreshWatchSide();
});

export function patchProgress() {
  for (const card of document.querySelectorAll("#grid .card[data-qid]")) {
    const r = state.queue.find((x) => x.id === card.dataset.qid);
    if (!r?.len) continue;
    const t = state.qpos[r.id] || 0;
    const pct = t > 5 ? Math.min(100, Math.round((t / r.len) * 100)) : 0;
    let bar = card.querySelector(".prog i");
    if (pct && !bar) {
      card.querySelector(".thumb").insertAdjacentHTML("beforeend", '<span class="prog"><i></i></span>');
      bar = card.querySelector(".prog i");
    }
    if (bar) bar.style.width = `${pct}%`;
  }
}

export const qLeft = (r) => Math.max(0, (r.len || 0) - (state.qpos[r.id] || 0));
// «3 мин», «1 ч 20 мин», от 3 часов — коротко «≈ 10 ч»
export const fmtHours = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h >= 3) return `≈ ${nf.format(Math.round(s / 3600))} ч`;
  return h ? `${h} ч${m ? ` ${m} мин` : ""}` : `${Math.max(1, m)} мин`;
};

export function computeQueue() {
  const items = state.queue;
  const allow = (d) => durOk(items[d], state.dur);
  let list;
  let meta = { partial: false, swapped: null };
  const q = state.q.trim();
  if (q) {
    meta = search(state.qindex, state.q, allow);
    list = meta.results || [];
  } else list = items.map((_, d) => ({ d, hits: null })).filter((x) => allow(x.d));
  const by = (f) => list.sort((a, b) => f(items[a.d], items[b.d]) || a.d - b.d);
  const sort = state.sort;
  if (sort === "auto" && q) {
    /* по совпадению — как отдал поиск */
  } else if (sort === "auto") list.sort((a, b) => a.d - b.d);
  else if (sort === "new") by((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  else if (sort === "old") by((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  else if (sort === "started") by((a, b) => Number((state.qpos[b.id] || 0) > 5) - Number((state.qpos[a.id] || 0) > 5));
  else if (sort === "short") by((a, b) => (qLeft(a) || 1e9) - (qLeft(b) || 1e9));
  else if (sort === "long") by((a, b) => qLeft(b) - qLeft(a));
  return { list, meta };
}

// «Продолжить смотреть» — начатые видео крупно над очередью (без поиска и фильтров)
export function renderContinue(list) {
  const box = $("#cont");
  const plain = !state.q.trim() && !state.dur && state.sort === "auto";
  const started = plain ? list.filter(({ d }) => (state.qpos[state.queue[d].id] || 0) > 5).slice(0, 3) : [];
  box.hidden = !started.length;
  box.innerHTML = started.length
    ? `<div class="cont-h">Продолжить смотреть</div><div class="cont-g${started.length === 1 ? " solo" : ""}" style="--n:${started.length}">${started.map((x) => qCardHtml(x).replace('class="card"', 'class="card big"')).join("")}</div>`
    : "";
  return new Set(started.map((x) => x.d));
}

export function updateQueue({ keep = false } = {}) {
  const computed = computeQueue();
  const shownBig = renderContinue(computed.list);
  // крупные «продолжить» в общей сетке не повторяем
  const list = shownBig.size ? computed.list.filter((x) => !shownBig.has(x.d)) : computed.list;
  const meta = computed.meta;
  const was = state.shown;
  const y = window.scrollY;
  state.list = list;
  state.meta = meta;
  state.qFound = computed.list; // всё подходящее, вместе с «Продолжить смотреть», — для строки над видео
  state.shown = 0;
  $("#grid").textContent = "";
  renderQueueSide();
  renderQueueSummary();
  if (keep) {
    while (state.shown < Math.min(was, list.length)) more();
    window.scrollTo({ top: y });
  } else {
    window.scrollTo({ top: 0 });
    more();
  }
  setSearchHint($("#q"), state.queue.length ? `Поиск в очереди: ${videosWord(state.queue.length)}` : "", "Поиск в очереди", "Поиск");
  $("#q-play").disabled = !list.length;
  // очередь пуста — без кнопки «Смотреть», порядка и фильтров длины: выбирать не из чего
  document.body.classList.toggle("q-none", !state.queue.length);
  saveHash();
}

export function qUrl(r) {
  const t = state.qpos[r.id] || 0;
  return r.short ? `https://www.youtube.com/shorts/${encodeURIComponent(r.id)}` : `https://www.youtube.com/watch?v=${encodeURIComponent(r.id)}${t > 5 ? `&t=${t}s` : ""}`;
}

export function qCardHtml({ d, hits }) {
  const r = state.queue[d];
  const t = state.qpos[r.id] || 0;
  const pct = r.len && t > 5 ? Math.min(100, Math.round((t / r.len) * 100)) : 0;
  const href = qUrl(r);
  const when = r.addedAt ? `добавлено ${ago(r.addedAt)}` : "";
  const dur = r.len ? (t > 5 ? `осталось ${fmtHours(qLeft(r))}` : "") : "";
  const sub = [r.channel || (r.short ? "Shorts" : ""), dur, when].filter(Boolean);
  const title = r.title || "Видео без названия";
  return `<article class="card" data-qid="${esc(r.id)}">
    <a class="thumb" href="${href}" data-play="${esc(r.id)}" tabindex="-1" aria-label="${esc(title)}">
      <img loading="lazy" decoding="async" alt="" src="https://i.ytimg.com/vi/${esc(r.id)}/mqdefault.jpg" />
      ${r.len ? `<span class="dur">${fmtLen(r.len)}</span>` : r.short ? `<span class="dur">Shorts</span>` : ""}
      ${pct ? `<span class="prog"><i style="width:${pct}%"></i></span>` : ""}
    </a>
    <a class="title" href="${href}" data-play="${esc(r.id)}" title="${esc(title)}">${hits ? mark(title, hits) : esc(title)}</a>
    <div class="sub" title="${esc(sub.join(" · "))}">${sub.map((x, i) => (i === 0 && hits && r.channel ? mark(x, hits) : esc(x))).join(" · ")}</div>
    <div class="pls">
      ${d > 0 ? `<button type="button" class="chip act" data-qtop="${esc(r.id)}" title="Поставить первым в очереди">${icon("chevron", { size: 14 }).replace("<svg", '<svg style="transform:rotate(-90deg)"')}Наверх</button>` : ""}
      <button type="button" class="chip act" data-qdel="${esc(r.id)}" title="Убрать из очереди">${icon("close", { size: 14 })}Убрать</button>
    </div>
  </article>`;
}

export function renderQueueSummary() {
  // в очереди итог — в строке над видео (#q-bar, рядом с «Порядком»), а не между блоками
  $("#summary").innerHTML = "";
  const el = $("#q-count");
  const empty = $("#empty");
  const found = state.qFound || state.list;
  const n = found.length;
  if (!n) {
    el.innerHTML = state.queue.length ? `<b>Нет подходящих видео</b>` : "";
    empty.hidden = false;
    const q = state.q.trim();
    empty.innerHTML = state.queue.length
      ? `<div class="empty-box">
          <div class="empty-icon">${icon("search", { size: 28 })}</div>
          <div class="empty-title">Ничего не нашлось</div>
          <div class="empty-text">${q ? `В очереди нет видео по запросу «${esc(q)}».` : "Под выбранную длину не подходит ни одно видео."}</div>
          ${state.dur ? `<button type="button" class="ghost" data-act="reset">Сбросить фильтры</button>` : ""}
        </div>`
      : `<div class="empty-box">
          <div class="empty-icon">${icon("clock", { size: 28 })}</div>
          <div class="empty-title">Очередь пуста</div>
          <div class="empty-text">Сюда попадают видео «на потом» — вместо десятков открытых вкладок. Нажмите «Собрать вкладки»: все открытые видео YouTube перейдут в очередь вместе с местом, где вы остановились, а вкладки закроются.</div>
          <button type="button" class="primary" data-act="collect">${icon("download", { size: 16 })}Собрать вкладки${state.tabsOpen ? ` · ${nf.format(state.tabsOpen)}` : ""}</button>
        </div>`;
    return;
  }
  empty.hidden = true;
  // осталось смотреть — у показанных (с фильтром длины — только у них)
  const left = found.reduce((a, { d }) => a + qLeft(state.queue[d]), 0);
  let text = `<span class="q-n">${state.q.trim() ? "Найдено " : ""}<b>${videosWord(n)}</b></span>`;
  if (left) text += `<span class="q-left"> · <span class="q-left-w">осталось </span>${fmtHours(left)}</span>`;
  if (state.meta?.swapped) text += `<span class="swap">запрос понят как «${esc(state.meta.swapped)}»</span>`;
  if (state.meta?.partial) text += `<span class="swap">точных совпадений нет — показаны похожие</span>`;
  el.innerHTML = text;
}

export function renderQueueSide() {
  const q = state.queue;
  const leftAll = q.reduce((a, r) => a + qLeft(r), 0);
  const started = q.filter((r) => (state.qpos[r.id] || 0) > 5).length;
  const shorts = q.filter((r) => r.short || (r.len && r.len <= 61)).length;
  const undo = state.qundo && Date.now() - state.qundo.at < 24 * 3600 * 1000 && state.qundo.tabs?.length ? state.qundo : null;
  const fresh = undo && (state.justCollected || Date.now() - undo.at < 2 * 60 * 1000);
  const sw = (key, title, hint) => `<label class="switch"><span>${title}<small>${hint}</small></span><input type="checkbox" data-opt="${key}" ${state.qopts[key] ? "checked" : ""} /></label>`;
  $("#q-side").innerHTML = `
    ${wlCardHtml()}
    ${
      undo
        ? `<div class="q-card q-undo" role="status">
        <div><b>${fresh ? "Собрано" : "Последний сбор"}: ${videosWord(undo.tabs.length)}</b>${fresh ? " — вкладки закрыты, место в каждом видео запомнено." : ` · ${ago(undo.at)}`}</div>
        <div class="row"><button type="button" class="ghost" data-act="restore" title="Открыть эти вкладки снова и убрать их из очереди">${icon("history", { size: 16 })}Вернуть вкладки</button></div>
      </div>`
        : ""
    }
    ${q.length ? `<div class="q-card q-stats">
      <div><div class="q-num">${nf.format(q.length)}</div><div class="q-lbl">${plural(q.length, "видео", "видео", "видео")} в очереди</div></div>
      <div><div class="q-num">${leftAll ? fmtHours(leftAll) : "—"}</div><div class="q-lbl">осталось смотреть</div></div>
      <div><div class="q-num">${nf.format(started)}</div><div class="q-lbl">начато</div></div>
      <div><div class="q-num">${nf.format(shorts)}</div><div class="q-lbl">Shorts и до 1 мин</div></div>
    </div>` : ""}
    ${q.length > 1 ? `<button type="button" class="ghost q-triage" data-act="triage" title="Видео по одному, крупно: ← убрать, → оставить, ↑ наверх">${icon("library", { size: 16 })}Разобрать завалы · ${nf.format(q.length)}</button>` : ""}
    ${q.length ? `<button type="button" class="ghost q-triage" data-qt="open" title="Недоступные, дубли, почти досмотренное и давно лежащее — найти и убрать разом">${icon("sparkles", { size: 16 })}Уборка очереди</button>` : ""}
    <details class="q-card q-set" ${state.qSetOpen ?? !narrow() ? "open" : ""}>
      <summary class="q-h">Как работает очередь</summary>
      ${sw("removeWatched", "Убирать досмотренное", "Досмотрели до конца — видео само уходит из очереди")}
      ${sw("autoNext", "Следующее — само", "После конца видео сразу открывать следующее. Выключено — показать подборку")}
      ${sw("intercept", "Средний клик — в очередь", "Средний клик или Ctrl+клик по видео на YouTube кладёт его в очередь, а не в новую вкладку")}
      <label class="switch"><span>Смотреть прямо здесь<small>Видео из библиотеки и очереди открываются в своём лёгком плеере, а не на странице YouTube</small></span><input type="checkbox" data-local="libWatchHere" ${state.watchHere ? "checked" : ""} /></label>
      <div class="q-offer">
        <span>В конце видео предлагать<small>Подборка из очереди поверх плеера. «Похожие» — тот же канал или похожие названия</small></span>
        <div class="q-offer-row">
          <select data-qsel="offerCount" aria-label="Сколько видео предлагать">${[2, 4, 6]
            .map((n) => `<option value="${n}" ${Number(state.qopts.offerCount) === n ? "selected" : ""}>${n} видео</option>`)
            .join("")}</select>
          <select data-qsel="offerMode" aria-label="Какие видео предлагать">${[
            ["order", "по порядку"],
            ["shuffle", "вперемешку"],
            ["short", "сначала короткие"],
            ["started", "сначала начатые"],
            ["similar", "похожие"],
          ]
            .map(([v, l]) => `<option value="${v}" ${state.qopts.offerMode === v ? "selected" : ""}>${l}</option>`)
            .join("")}</select>
        </div>
      </div>
    </details>
    <div class="q-card keys">
      <div class="q-h" style="grid-column:1/-1;margin:0">Клавиши на странице видео</div>
      <kbd>]</kbd><span>следующее в очереди</span>
      <kbd>[</kbd><span>предыдущее</span>
      <kbd>Shift + ]</kbd><span>досмотрел — убрать и дальше</span>
    </div>
    <button type="button" class="ghost q-triage" data-bk="open" title="Очередь, настройки и список плейлистов — в файл и обратно">${icon("file", { size: 16 })}Резервная копия</button>
    ${q.length ? `<button type="button" class="ghost danger" data-act="qclear">${icon("close", { size: 16 })}Очистить очередь</button>` : ""}`;
}

export const narrow = () => matchMedia("(max-width: 640px)").matches;
document.addEventListener(
  "toggle",
  (e) => {
    if (e.target.classList?.contains("q-set")) state.qSetOpen = e.target.open; // помним, раскрыты ли настройки
  },
  true
);

export function onQueueGridClick(e) {
  const top = e.target.closest("[data-qtop]");
  if (top) return void qmsg({ type: "queue:top", id: top.dataset.qtop });
  const del = e.target.closest("[data-qdel]");
  if (del) {
    del.closest(".card")?.style.setProperty("opacity", ".4");
    return void qmsg({ type: "queue:remove", ids: [del.dataset.qdel], why: "drop" });
  }
  const play = e.target.closest("[data-play]");
  // обычный клик — в одной вкладке очереди; Ctrl/средний клик — как обычная ссылка
  if (play && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
    e.preventDefault();
    if (watchHere()) openWatch(play.dataset.play, "queue");
    else void qmsg({ type: "queue:play", id: play.dataset.play });
  }
}

export async function refreshTabsCount() {
  const r = await qmsg({ type: "queue:count" });
  state.tabsOpen = r?.ok ? r.n : null;
  const n = state.tabsOpen;
  $("#tabs-text").textContent = n == null ? "" : n ? `Открыто ${videosWord(n)} во вкладках` : "Вкладок с видео нет";
  $("#collect").disabled = !n;
}

export async function collect() {
  const btn = $("#collect");
  btn.disabled = true;
  btn.classList.add("spin");
  const r = await qmsg({ type: "queue:collect" });
  btn.classList.remove("spin");
  if (r?.ok) state.justCollected = r.collected;
  await loadQueue();
  await refreshTabsCount();
  if (state.view === "queue") update();
}

export let clearArmed = 0;
document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-act]");
  const act = a?.dataset.act;
  if (act === "collect") return void collect();
  if (act === "restore") {
    a.disabled = true;
    await qmsg({ type: "queue:restore" });
    state.justCollected = 0;
    await refreshTabsCount();
    return;
  }
  if (act === "qclear") {
    // второй щелчок в течение 4 секунд — подтверждение
    if (Date.now() - clearArmed > 4000) {
      clearArmed = Date.now();
      a.innerHTML = `${icon("close", { size: 16 })}Точно очистить? ${videosWord(state.queue.length)}`;
      setTimeout(() => state.view === "queue" && Date.now() - clearArmed >= 4000 && renderQueueSide(), 4100);
      return;
    }
    clearArmed = 0;
    await qmsg({ type: "queue:remove", ids: state.queue.map((x) => x.id) });
  }
});
document.addEventListener("change", (e) => {
  const opt = e.target.closest("[data-opt]");
  if (opt) void qmsg({ type: "queue:opts", patch: { [opt.dataset.opt]: opt.checked } });
  const loc = e.target.closest("[data-local]");
  if (loc) {
    state.watchHere = loc.checked;
    void chrome.storage.local.set({ [loc.dataset.local]: loc.checked });
  }
  const sel = e.target.closest("[data-qsel]");
  if (sel) void qmsg({ type: "queue:opts", patch: { [sel.dataset.qsel]: sel.dataset.qsel === "offerCount" ? Number(sel.value) : sel.value } });
});
$("#collect").addEventListener("click", () => void collect());
$("#q-play").addEventListener("click", () => {
  const first = state.list[0];
  if (!first) return;
  if (watchHere()) openWatch(state.queue[first.d].id, "queue");
  else void qmsg({ type: "queue:play", id: state.queue[first.d].id });
});
