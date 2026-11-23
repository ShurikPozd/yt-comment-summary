// «Моя библиотека»: «Подписки» — дайджест новых видео из ваших подписок.
//
// Как устроено:
//   - лента «Подписки» читается так же, как плейлисты: через вкладку YouTube
//     (операция subsFeed в playlists-main.js), только чтение — в аккаунте ничего
//     не меняется. Берём последнюю неделю, но не больше 300 видео;
//   - всё хранится в этом браузере (IndexedDB, store kv): лента — «digest:feed»,
//     что прочитано и скрыто — «digest:marks», настройки вида — «digest:prefs»;
//   - «новое» — то, чего вы ещё не отметили просмотренным («Всё просмотрено»),
//     не открыли, не поставили в очередь; число новых — на вкладке «Подписки»;
//   - обновляется по кнопке и само при открытии, если прошло больше 30 минут.
// Чистая логика (слияние, группы, «новое») — в digest-core.js, с автотестами.

import { icon } from "../sidepanel/icons.js";
import { DIGEST_STALE, MAX_PAGES, READ_MAX, chKey, channelsOf, enough, groupItems, isNew, isSoon, markAllRead, mergeFeed, newCount, norm, queueable, visible } from "./digest-core.js";
import { qmsg } from "./queue-view.js";
import { buildIndex, search } from "./search.js";
import { $, esc, nf, plural, setSearchHint, state, videosWord } from "./state.js";
import { kv } from "./store.js";
import { ago, fmtLen, mark } from "./view-lib.js";
import { openWatch, watchHere } from "./watch.js";
import { releaseTab, yt } from "./youtube.js";

// иконки только для этого раздела — в том же стиле, что общий набор
const svg = (body, size = 16) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const IC = {
  plus: (s) => svg('<path d="M12 5v14"/><path d="M5 12h14"/>', s),
  hide: (s) => svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1"/><path d="M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>', s),
  subs: (s) => svg('<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M7 3h10"/><path d="M10.5 10.5v5l4-2.5z"/>', s),
  done: (s) => svg('<path d="M3 12.5l4 4L15.5 8"/><path d="M11 16.5l1 0L21 8"/>', s),
};

export const dg = {
  ready: false,
  items: [], // [{ id, title, channel, channelId, avatar, len, views, ago, at, seenAt, short, live, upAt, upText }]
  at: 0, // когда обновляли
  marks: norm(null),
  prefs: { show: "new", group: "day", shorts: "shelf" },
  loading: false,
  progress: 0,
  error: "",
  ch: "", // показан только этот канал
  index: null,
  indexOf: null,
  qids: new Set(), // что уже в очереди
  // только что открытые / поставленные в очередь остаются среди «Новых» до смены
  // фильтра или «Всё просмотрено» — карточка не исчезает из-под руки
  sticky: new Set(),
};

const save = {
  marks: () =>
    kv("digest:marks", { read: [...dg.marks.read].slice(0, READ_MAX), readAt: dg.marks.readAt, hidden: [...dg.marks.hidden].slice(-READ_MAX), hiddenCh: dg.marks.hiddenCh }).catch(() => {}),
  prefs: () => kv("digest:prefs", dg.prefs).catch(() => {}),
  feed: () => kv("digest:feed", { at: dg.at, items: dg.items }).catch(() => {}),
};

const shown = () => state.view === "digest";

// ---------- данные ----------
async function load() {
  const [feed, marks, prefs, q] = await Promise.all([
    kv("digest:feed").catch(() => null),
    kv("digest:marks").catch(() => null),
    kv("digest:prefs").catch(() => null),
    chrome.storage.local.get("queue").catch(() => ({})),
  ]);
  dg.items = Array.isArray(feed?.items) ? feed.items : [];
  dg.at = Number(feed?.at) || 0;
  dg.marks = norm(marks);
  dg.prefs = { ...dg.prefs, ...(prefs || {}) };
  dg.qids = new Set((q.queue || []).map((x) => x.id));
  dg.ready = true;
  renderBadge();
  if (shown()) updateDigest();
  void autoRefresh();
}

const stale = () => !dg.at || Date.now() - dg.at > DIGEST_STALE;

// Само: в разделе «Подписки» — всегда, когда устарело; в других разделах —
// только если вкладка YouTube уже открыта (чтобы ради числа на вкладке не
// открывать фоновую)
async function autoRefresh() {
  if (!dg.ready || dg.loading || !stale() || document.visibilityState === "hidden") return;
  if (!shown()) {
    const tabs = await chrome.tabs.query({ url: ["https://www.youtube.com/*"] }).catch(() => []);
    if (!tabs.some((t) => !t.discarded)) return;
  }
  void refreshDigest({ auto: true });
}
setInterval(autoRefresh, 5 * 60e3);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && autoRefresh());

const ERR = {
  loggedout: "Войдите в аккаунт YouTube в этом браузере — дайджест читает ленту ваших подписок.",
  denied: "YouTube не пустил к ленте подписок. Откройте YouTube и войдите заново.",
  tab: "Не получилось открыть YouTube в фоне. Откройте youtube.com и нажмите «Обновить».",
};

export async function refreshDigest({ auto = false } = {}) {
  if (dg.loading) return;
  dg.loading = true;
  dg.error = "";
  dg.progress = 0;
  renderStatus();
  if (shown() && !dg.items.length) updateDigest();
  try {
    const got = [];
    let token = null;
    for (let p = 0; p < MAX_PAGES; p++) {
      const r = await yt("subsFeed", token ? { token } : {});
      got.push(...(r?.items || []));
      dg.progress = got.length;
      renderStatus();
      if (!r?.next || enough(got)) break;
      token = r.next;
    }
    dg.items = mergeFeed(dg.items, got);
    dg.at = Date.now();
    dg.index = null;
    await save.feed();
  } catch (e) {
    dg.error = ERR[e?.code] || "YouTube не ответил. Попробуйте ещё раз чуть позже.";
    if (auto && dg.items.length) dg.error = ""; // тихое обновление не удалось — покажем, что есть
  } finally {
    dg.loading = false;
    if (!state.syncing) await releaseTab().catch(() => {});
    renderBadge();
    if (shown()) updateDigest({ keep: true });
    else renderStatus();
  }
}

// ---------- отметки ----------
function markRead(ids) {
  for (const id of ids) dg.sticky.add(id);
  let changed = false;
  for (const id of ids) if (!dg.marks.read.has(id)) (dg.marks.read.add(id), (changed = true));
  if (!changed) return;
  for (const id of ids) document.querySelectorAll(`#digest .card[data-did="${CSS.escape(id)}"]`).forEach((c) => c.classList.remove("is-new"));
  void save.marks();
  renderBadge();
  renderCounts();
}

export function newTotal() {
  return dg.ready ? newCount(dg.items, dg.marks, dg.prefs) : 0;
}

function renderBadge() {
  const n = newTotal();
  const b = $("#d-badge");
  if (b) b.textContent = n ? (n > 99 ? "99+" : nf.format(n)) : "";
}

// очередь поменялась (здесь или в другой вкладке) — обновить отметки «В очереди»
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.queue) return;
  dg.qids = new Set((ch.queue.newValue || []).map((x) => x.id));
  for (const b of document.querySelectorAll("#digest [data-dq]")) setQueued(b, dg.qids.has(b.dataset.dq));
});

function setQueued(btn, on) {
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
  btn.title = on ? "Уже в очереди — нажмите, чтобы убрать" : "Поставить в очередь «посмотреть потом»";
  btn.innerHTML = on ? `${icon("check", { size: 14 })}В очереди` : `${IC.plus(14)}В очередь`;
}

// ---------- что показывать ----------
function base() {
  return visible(dg.items, dg.marks, dg.prefs, { onlyNew: false });
}

function searched(list) {
  const q = state.q.trim();
  if (!q) return { list, meta: null };
  if (dg.indexOf !== dg.items) {
    dg.indexOf = dg.items;
    dg.index = buildIndex(dg.items.map((x) => ({ title: x.title, channel: x.channel })));
  }
  const allow = new Set(list.map((x) => x.id));
  const meta = search(dg.index, q, (d) => allow.has(dg.items[d].id));
  const hits = new Map((meta.results || []).map((r) => [dg.items[r.d].id, r.hits]));
  return { list: list.filter((x) => hits.has(x.id)), meta, hits };
}

export function updateDigest({ keep = false } = {}) {
  const box = $("#digest");
  setSearchHint($("#q"), dg.items.length ? `Поиск в подписках: ${videosWord(base().length)}` : "", "Поиск в подписках", "Поиск");
  renderStatus();
  if (!dg.ready) {
    box.innerHTML = "";
    return;
  }
  // ленты ещё нет (первая загрузка, ошибка) — без колонки с нулями и фильтров
  document.body.classList.toggle("d-none", !dg.items.length);
  const all = base();
  const m = dg.marks;
  if (dg.ch && !all.some((x) => chKey(x) === dg.ch)) dg.ch = "";
  const onlyNew = dg.prefs.show === "new";
  const scope = visible(dg.items, m, dg.prefs, { ch: dg.ch, onlyNew: false }).filter((x) => !onlyNew || isNew(x, m) || dg.sticky.has(x.id));
  const { list, meta, hits } = searched(scope);
  const groups = groupItems(list, dg.ch ? "day" : dg.prefs.group, m);
  state.digestList = groups.flatMap((g) => g.items);
  state.digestById = new Map(dg.items.map((x) => [x.id, x]));
  renderFilters();
  renderSide(all);
  const y = window.scrollY;
  box.innerHTML = summaryHtml(all, list, meta) + (list.length ? groups.map((g) => groupHtml(g, hits)).join("") : emptyHtml(all)) + hiddenHtml();
  if (keep) window.scrollTo({ top: y });
  if (stale() && !dg.loading && !dg.error) void autoRefresh();
}

// ---------- отрисовка ----------
const watchUrl = (it) => (it.short ? `https://www.youtube.com/shorts/${encodeURIComponent(it.id)}` : `https://www.youtube.com/watch?v=${encodeURIComponent(it.id)}`);
const thumbUrl = (it) => `https://i.ytimg.com/vi/${encodeURIComponent(it.id)}/${it.short ? "oar2" : "mqdefault"}.jpg`;
const safeAvatar = (u) => (/^https:\/\/yt\d?\.(?:ggpht|googleusercontent)\.com\/[^'"()\s\\]+$/.test(u || "") ? u : "");
const fmtDate = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

function whenText(it) {
  if (it.live) return "сейчас в эфире";
  if (it.upAt) return `начнётся ${fmtDate.format(new Date(it.upAt)).replace(",", " в")}`;
  if (it.upText) return it.upText.replace(/^Премьера:\s*/i, "премьера ");
  if (it.ago) return it.ago;
  return it.seenAt ? `появилось ${ago(it.seenAt)}` : "";
}

function avatarHtml(url, name, cls = "d-ava") {
  const u = safeAvatar(url);
  const letter = esc((name || "?").trim().charAt(0).toUpperCase());
  return u ? `<span class="${cls}"><img loading="lazy" alt="" src="${esc(u)}" referrerpolicy="no-referrer" /></span>` : `<span class="${cls} none">${letter}</span>`;
}

function cardHtml(it, { inChannel = false, hits = null } = {}) {
  const href = watchUrl(it);
  const fresh = isNew(it, dg.marks);
  const inQ = dg.qids.has(it.id);
  const h = hits?.get(it.id) || null;
  const badge = it.live
    ? `<span class="dur d-live">В эфире</span>`
    : isSoon(it)
      ? `<span class="dur d-soon">Скоро</span>`
      : it.len
        ? `<span class="dur">${fmtLen(it.len)}</span>`
        : it.short
          ? `<span class="dur">Shorts</span>`
          : "";
  const parts = [it.views, whenText(it)].filter(Boolean);
  const ch = !inChannel && it.channel ? `<button type="button" class="d-ch" data-dch="${esc(chKey(it))}" title="Только видео канала «${esc(it.channel)}»">${h ? mark(it.channel, h) : esc(it.channel)}</button>` : "";
  const title = it.title || "Видео без названия";
  return `<article class="card d-card${fresh ? " is-new" : ""}${it.short ? " d-short" : ""}" data-did="${esc(it.id)}">
    <a class="thumb" href="${href}" target="_blank" rel="noreferrer" tabindex="-1" aria-label="${esc(title)}">
      <img loading="lazy" decoding="async" alt="" src="${thumbUrl(it)}" />
      <span class="d-new" aria-label="Новое">Новое</span>
      ${badge}
    </a>
    <a class="title" href="${href}" target="_blank" rel="noreferrer" title="${esc(title)}">${h ? mark(title, h) : esc(title)}</a>
    ${ch ? `<div class="sub d-chline">${ch}</div>` : ""}
    ${parts.length ? `<div class="sub d-meta">${esc(parts.join(" · "))}</div>` : ""}
    <div class="pls d-acts">
      <button type="button" class="chip act d-q${inQ ? " on" : ""}" data-dq="${esc(it.id)}" aria-pressed="${inQ}" title="${inQ ? "Уже в очереди — нажмите, чтобы убрать" : "Поставить в очередь «посмотреть потом»"}">${inQ ? `${icon("check", { size: 14 })}В очереди` : `${IC.plus(14)}В очередь`}</button>
      <button type="button" class="chip act" data-dhide="${esc(it.id)}" title="Скрыть это видео из дайджеста">${IC.hide(14)}Не интересно</button>
    </div>
  </article>`;
}

function groupHtml(g, hits) {
  const fresh = g.items.filter((x) => isNew(x, dg.marks)).length;
  const count = `${videosWord(g.items.length)}${fresh && dg.prefs.show !== "new" ? ` · ${nf.format(fresh)} ${plural(fresh, "новое", "новых", "новых")}` : ""}`;
  const isCh = g.kind === "channel";
  const canQ = queueable(g.items).filter((x) => !dg.qids.has(x.id)).length;
  const acts = isCh
    ? `<div class="d-gacts">
        <button type="button" class="ghost" data-dchq="${esc(g.channelId)}" ${canQ ? "" : "disabled"} title="Все видео канала из дайджеста — в очередь">${IC.plus(16)}Все в очередь${canQ ? ` · ${nf.format(canQ)}` : ""}</button>
        <button type="button" class="ghost" data-dchhide="${esc(g.channelId)}" title="Не показывать этот канал в дайджесте (вернуть можно в колонке слева)">${IC.hide(16)}Скрыть канал</button>
      </div>`
    : "";
  return `<section class="d-group d-${g.kind}" aria-label="${esc(g.title)}">
    <header class="d-gh">
      ${isCh ? avatarHtml(g.avatar, g.title, "d-ava big") : ""}
      <div class="d-gt">
        ${isCh ? `<h2><button type="button" class="d-ch" data-dch="${esc(g.channelId)}" title="Только этот канал">${esc(g.title)}</button></h2>` : `<h2>${esc(g.title)}</h2>`}
        <span class="d-gc">${count}</span>
      </div>
      ${acts}
    </header>
    <div class="grid d-grid${g.kind === "shorts" ? " d-sgrid" : ""}">${g.items.map((it) => cardHtml(it, { inChannel: isCh || Boolean(dg.ch), hits })).join("")}</div>
  </section>`;
}

function summaryHtml(all, list, meta) {
  const ch = dg.ch ? channelsOf(all, dg.marks).find((c) => c.id === dg.ch) : null;
  const q = state.q.trim();
  let text = "";
  if (ch) {
    const items = all.filter((x) => chKey(x) === dg.ch);
    const canQ = queueable(items).filter((x) => !dg.qids.has(x.id)).length;
    return `<div class="d-chead">
      ${avatarHtml(ch.avatar, ch.name, "d-ava big")}
      <div class="d-gt"><h2>${esc(ch.name)}</h2><span class="d-gc">${videosWord(ch.n)} за неделю${ch.fresh ? ` · ${nf.format(ch.fresh)} ${plural(ch.fresh, "новое", "новых", "новых")}` : ""}</span></div>
      <div class="d-gacts">
        <button type="button" class="ghost" data-dchq="${esc(ch.id)}" ${canQ ? "" : "disabled"}>${IC.plus(16)}Все в очередь${canQ ? ` · ${nf.format(canQ)}` : ""}</button>
        <button type="button" class="ghost" data-dchhide="${esc(ch.id)}">${IC.hide(16)}Скрыть канал</button>
        <button type="button" class="ghost" data-dch="">${icon("close", { size: 16 })}Все каналы</button>
      </div>
    </div>`;
  }
  if (!list.length) return "";
  if (q) text = `Найдено <b>${videosWord(list.length)}</b> в подписках`;
  else if (dg.prefs.show === "new") {
    const n = list.filter((x) => isNew(x, dg.marks)).length;
    text = n ? `<b>${nf.format(n)} ${plural(n, "новое видео", "новых видео", "новых видео")}</b> с прошлого раза` : `<b>Новые разобраны</b> · ниже — то, что вы только что открыли или поставили в очередь`;
  }
  else text = `<b>${videosWord(list.length)}</b> за неделю`;
  if (meta?.swapped) text += ` · <span class="swap">запрос понят как «${esc(meta.swapped)}»</span>`;
  if (meta?.partial) text += ` · <span class="swap">точных совпадений нет — показаны похожие</span>`;
  return `<div class="summary d-sum" role="status">${text}</div>`;
}

function emptyHtml(all) {
  const q = state.q.trim();
  const box = (ic, title, text, btns = "") =>
    `<div class="empty d-empty"><div class="empty-box"><div class="empty-icon">${ic}</div><div class="empty-title">${title}</div><div class="empty-text">${text}</div>${btns ? `<div class="d-ebtns">${btns}</div>` : ""}</div></div>`;
  if (!dg.items.length && dg.loading)
    return `<div class="empty d-empty"><div class="empty-box"><div class="empty-icon">${IC.subs(28)}</div><div class="empty-title">Читаю ленту подписок</div><div class="empty-text">Соберу новые видео ваших каналов за последнюю неделю. Список хранится только в этом браузере.</div><div class="bar"><div style="width:${Math.min(96, 6 + dg.progress / 3)}%"></div></div><div class="empty-text">${dg.progress ? `Найдено ${videosWord(dg.progress)}` : "Подключаюсь к YouTube…"}</div></div></div>`;
  if (!dg.items.length && dg.error)
    return box(IC.subs(28), "Не получилось прочитать подписки", esc(dg.error), `<button type="button" class="primary" data-dact="refresh">${icon("refresh", { size: 16 })}Повторить</button><button type="button" class="ghost" data-act="open-yt">${icon("external", { size: 16 })}Открыть YouTube</button>`);
  if (!dg.items.length)
    return box(IC.subs(28), "Новых видео в подписках нет", "За последнюю неделю ваши каналы ничего не выложили — или подписок пока нет.", `<button type="button" class="ghost" data-dact="refresh">${icon("refresh", { size: 16 })}Обновить</button>`);
  if (q) return box(icon("search", { size: 28 }), "Ничего не нашлось", `В подписках нет видео по запросу «${esc(q)}»${dg.prefs.show === "new" ? " среди новых" : ""}.`, dg.prefs.show === "new" ? `<button type="button" class="ghost" data-dshow="all">Искать во всей неделе</button>` : "");
  if (dg.prefs.show === "new")
    return box(icon("check", { size: 28 }), "Всё просмотрено", `Новых видео с прошлого раза нет. За неделю в подписках — ${videosWord(all.length)}.`, `<button type="button" class="ghost" data-dshow="all">Показать всю неделю</button>`);
  return box(IC.subs(28), "Здесь пусто", "Все видео недели скрыты.", "");
}

// скрытые каналы — внизу раздела, свёрнуто: вернуть любой
function hiddenHtml() {
  const hidden = dg.marks.hiddenCh;
  if (!hidden.length) return "";
  return `<details class="q-card q-set d-hidden">
    <summary class="q-h">Скрытые каналы · ${nf.format(hidden.length)}</summary>
    <div class="d-hlist">${hidden
      .map((c) => `<div class="d-hrow"><span class="d-hname" title="${esc(c.name)}">${esc(c.name)}</span><button type="button" class="chip act" data-dunhide="${esc(c.id)}">${icon("history", { size: 14 })}Вернуть</button></div>`)
      .join("")}</div>
  </details>`;
}

function renderCounts() {
  const all = base();
  const fresh = all.filter((x) => isNew(x, dg.marks)).length;
  const n1 = $("#d-show [data-dshow='new'] .n");
  const n2 = $("#d-show [data-dshow='all'] .n");
  if (n1) n1.textContent = nf.format(fresh);
  if (n2) n2.textContent = nf.format(all.length);
  const rd = $("#d-read");
  if (rd) rd.disabled = !fresh;
  const st = $("#d-side .d-stats");
  if (st) st.outerHTML = statsHtml(all);
}

function renderFilters() {
  for (const b of document.querySelectorAll("#d-show [data-dshow]")) b.setAttribute("aria-checked", String(b.dataset.dshow === dg.prefs.show));
  for (const b of document.querySelectorAll("#d-grp [data-dgrp]")) {
    b.setAttribute("aria-checked", String(b.dataset.dgrp === dg.prefs.group));
    b.disabled = Boolean(dg.ch);
  }
  $("#d-shorts").value = dg.prefs.shorts;
  renderCounts();
}

function statsHtml(all) {
  const fresh = all.filter((x) => isNew(x, dg.marks)).length;
  const chans = new Set(all.map(chKey).filter(Boolean)).size;
  return `<div class="q-card d-stats">
    <div class="q-stats">
      <div><div class="q-num">${nf.format(fresh)}</div><div class="q-lbl">${plural(fresh, "новое", "новых", "новых")}</div></div>
      <div><div class="q-num">${nf.format(all.length)}</div><div class="q-lbl">за неделю</div></div>
      <div><div class="q-num">${nf.format(chans)}</div><div class="q-lbl">${plural(chans, "канал", "канала", "каналов")}</div></div>
      <div><div class="q-num">${nf.format(all.filter((x) => dg.qids.has(x.id)).length)}</div><div class="q-lbl">в очереди</div></div>
    </div>
  </div>`;
}

function renderSide(all) {
  const chans = channelsOf(all, dg.marks);
  const row = (c) => `<button type="button" class="pl d-chrow" data-dch="${esc(c.id)}" aria-current="${dg.ch === c.id}">
      ${avatarHtml(c.avatar, c.name)}
      <span class="pl-name" title="${esc(c.name)}">${esc(c.name)}</span>
      <span class="pl-count${c.fresh ? " fresh" : ""}" title="${c.fresh ? `${nf.format(c.fresh)} ${plural(c.fresh, "новое", "новых", "новых")} из ${nf.format(c.n)}` : videosWord(c.n)}">${nf.format(c.fresh || c.n)}</span>
    </button>`;
  $("#d-side").innerHTML = `
    ${statsHtml(all)}
    <nav class="pl-list d-chlist" aria-label="Каналы">
      ${chans.length ? `<button type="button" class="pl d-chrow" data-dch="" aria-current="${!dg.ch}"><span class="d-ava none">${IC.subs(18)}</span><span class="pl-name">Все каналы</span><span class="pl-count">${nf.format(all.length)}</span></button><div class="pl-sep">Каналы · ${nf.format(chans.length)}</div>` : ""}
      ${chans.map(row).join("")}
    </nav>`;
}

function renderStatus() {
  const text = $("#d-sync-text");
  const btn = $("#d-sync");
  if (!text || !btn) return;
  btn.disabled = dg.loading;
  btn.classList.toggle("spin", dg.loading);
  let main = "";
  let sub = "";
  if (dg.loading) {
    main = "Читаю ленту подписок…";
    sub = dg.progress ? `найдено ${videosWord(dg.progress)}` : "подключаюсь к YouTube";
  } else if (dg.error) {
    main = "Не обновилось";
    sub = dg.error;
  } else if (dg.at) {
    main = `Обновлено ${ago(dg.at)}`;
    sub = "само — раз в 30 минут";
  }
  text.classList.toggle("two", Boolean(sub));
  text.innerHTML = main ? `<span class="st-main">${esc(main)}</span>${sub ? `<span class="st-sub">${esc(sub)}</span>` : ""}` : "";
  text.title = [main, sub].filter(Boolean).join(": ");
  const eb = $("#d-sync-embed");
  if (eb) {
    eb.disabled = dg.loading;
    eb.classList.toggle("spin", dg.loading);
    eb.title = text.title || "Обновить дайджест";
  }
}
setInterval(() => shown() && !dg.loading && renderStatus(), 60000);

// ---------- всплывающая строка с «Вернуть» ----------
let toastTimer = 0;
function toast(html, undo) {
  let el = $("#d-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "d-toast";
    el.className = "d-toast";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  el.innerHTML = `<span>${html}</span>${undo ? `<button type="button" class="ghost">${icon("history", { size: 16 })}Вернуть</button>` : ""}`;
  el.hidden = false;
  el.classList.add("show");
  clearTimeout(toastTimer);
  const hide = () => {
    el.classList.remove("show");
    el.hidden = true;
  };
  toastTimer = setTimeout(hide, 7000);
  el.querySelector("button")?.addEventListener("click", () => {
    hide();
    undo();
  });
}

// ---------- действия ----------
const rec = (id) => state.digestById?.get(id) || dg.items.find((x) => x.id === id);
const qItem = (it) => ({ id: it.id, title: it.title, channel: it.channel, len: it.len, short: Boolean(it.short) });
const chName = (id) => dg.items.find((x) => chKey(x) === id)?.channel || dg.marks.hiddenCh.find((c) => c.id === id)?.name || "канал";

async function toggleQueue(btn) {
  const it = rec(btn.dataset.dq);
  if (!it) return;
  const on = dg.qids.has(it.id);
  setQueued(btn, !on); // сразу, не дожидаясь фона
  if (on) {
    dg.qids.delete(it.id);
    await qmsg({ type: "queue:remove", ids: [it.id] });
  } else {
    dg.qids.add(it.id);
    markRead([it.id]);
    await qmsg({ type: "queue:add", items: [qItem(it)] });
  }
}

function hideVideo(id) {
  const it = rec(id);
  dg.marks.hidden.add(id);
  dg.marks.read.add(id);
  void save.marks();
  const card = document.querySelector(`#digest .card[data-did="${CSS.escape(id)}"]`);
  const after = () => {
    renderBadge();
    updateDigest({ keep: true });
  };
  if (card && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    card.classList.add("gone");
    setTimeout(after, 180);
  } else after();
  toast(`Скрыто: «${esc((it?.title || "видео").slice(0, 60))}»`, () => {
    dg.marks.hidden.delete(id);
    void save.marks();
    renderBadge();
    updateDigest({ keep: true });
  });
}

async function queueChannel(id) {
  const items = queueable(base().filter((x) => chKey(x) === id)).filter((x) => !dg.qids.has(x.id));
  if (!items.length) return;
  for (const x of items) dg.qids.add(x.id);
  markRead(items.map((x) => x.id));
  await qmsg({ type: "queue:add", items: items.map(qItem) });
  updateDigest({ keep: true });
  toast(`В очереди: ${videosWord(items.length)} канала «${esc(chName(id))}»`, async () => {
    for (const x of items) dg.qids.delete(x.id);
    await qmsg({ type: "queue:remove", ids: items.map((x) => x.id) });
    updateDigest({ keep: true });
  });
}

function hideChannel(id) {
  const name = chName(id);
  if (!dg.marks.hiddenCh.some((c) => c.id === id)) dg.marks.hiddenCh = [...dg.marks.hiddenCh, { id, name }];
  if (dg.ch === id) dg.ch = "";
  void save.marks();
  renderBadge();
  updateDigest({ keep: true });
  toast(`Канал «${esc(name)}» скрыт в дайджесте`, () => unhideChannel(id));
}

function unhideChannel(id) {
  dg.marks.hiddenCh = dg.marks.hiddenCh.filter((c) => c.id !== id);
  void save.marks();
  renderBadge();
  updateDigest({ keep: true });
}

function readAll() {
  const before = { read: new Set(dg.marks.read), readAt: dg.marks.readAt };
  const n = base().filter((x) => isNew(x, dg.marks)).length;
  if (!n) return;
  dg.marks = markAllRead(dg.marks, dg.items);
  dg.sticky.clear();
  void save.marks();
  renderBadge();
  updateDigest();
  window.scrollTo({ top: 0 });
  toast(`Отмечено просмотренным: ${videosWord(n)}`, () => {
    dg.marks = { ...dg.marks, ...before };
    void save.marks();
    renderBadge();
    updateDigest();
  });
}

function setChannel(id) {
  dg.ch = dg.ch === id ? "" : id;
  updateDigest();
  window.scrollTo({ top: 0 });
}

// клики внутри раздела: карточки, заголовки групп, колонка каналов, пустые состояния
function onClick(e) {
  const t = e.target;
  const q = t.closest("[data-dq]");
  if (q) return void toggleQueue(q);
  const hide = t.closest("[data-dhide]");
  if (hide) return hideVideo(hide.dataset.dhide);
  const chq = t.closest("[data-dchq]");
  if (chq) return void queueChannel(chq.dataset.dchq);
  const chh = t.closest("[data-dchhide]");
  if (chh) return hideChannel(chh.dataset.dchhide);
  const unh = t.closest("[data-dunhide]");
  if (unh) return unhideChannel(unh.dataset.dunhide);
  const ch = t.closest("[data-dch]");
  if (ch) return setChannel(ch.dataset.dch);
  const show = t.closest("[data-dshow]");
  if (show) return setPref("show", show.dataset.dshow);
  if (t.closest("[data-dact='refresh']")) return void refreshDigest();
  // открыть видео: в своём плеере (если можно) или на YouTube — и считать прочитанным
  const link = t.closest("a.thumb, a.title");
  const card = link?.closest(".card[data-did]");
  if (!card) return;
  const id = card.dataset.did;
  markRead([id]);
  if (watchHere() && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
    e.preventDefault();
    openWatch(id, "digest");
  }
}

function setPref(k, v) {
  if (dg.prefs[k] === v) return;
  dg.prefs[k] = v;
  dg.sticky.clear();
  void save.prefs();
  renderBadge();
  updateDigest();
  window.scrollTo({ top: 0 });
}

$("#digest").addEventListener("click", onClick);
// видео открыли в своём плеере (и «Дальше» по списку) — прочитано
document.addEventListener("ytcs-lib:watch", (e) => e.detail?.source === "digest" && markRead([e.detail.id]));
$("#digest").addEventListener("auxclick", (e) => {
  // средняя кнопка — открыли в новой вкладке: тоже «прочитано»
  const card = e.target.closest("a.thumb, a.title")?.closest(".card[data-did]");
  if (card && e.button === 1) markRead([card.dataset.did]);
});
$("#d-side").addEventListener("click", onClick);
$("#d-show").addEventListener("click", (e) => {
  const b = e.target.closest("[data-dshow]");
  if (b) setPref("show", b.dataset.dshow);
});
$("#d-grp").addEventListener("click", (e) => {
  const b = e.target.closest("[data-dgrp]");
  if (b && !b.disabled) setPref("group", b.dataset.dgrp);
});
$("#d-shorts").addEventListener("change", (e) => setPref("shorts", e.target.value));
$("#d-read").addEventListener("click", readAll);
$("#d-sync").addEventListener("click", () => refreshDigest());
$("#d-sync-embed")?.addEventListener("click", () => refreshDigest());
void load();
