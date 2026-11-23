// «Моя библиотека»: «Статистика» — сколько вы смотрели и сколько сэкономили.
//
// Данные собирает stats.js на youtube.com и во встроенном плеере библиотеки
// (реальное время воспроизведения, без пауз и рекламы), складывает фон
// (stats-bg.js) в chrome.storage.local.watchStats — только на этом компьютере.
// Здесь: плитки «Сегодня / 7 дней / 30 дней», столбики по дням (SVG, без
// библиотек; видео и Shorts — стопкой), топ каналов с долей, сэкономленное
// время (скорость, рекламные вставки, тишина), видео и очередь, выключатель
// сбора и «Очистить». Раздел открывается вкладкой «Статистика» в шапке и
// адресом #stats; поверх остальных разделов, как «Разобрать завалы».

import { icon } from "../sidepanel/icons.js";
import { STATS_KEY, cleanStats, dayStart, fmtDur, hasData, shiftDay, summarize, totals } from "../stats-core.js";
import { saveHash } from "./library.js";
import { $, esc, nf, plural, state } from "./state.js";
import { closeWatch } from "./watch.js";

// значок раздела — столбики (в общем наборе иконок такого нет)
const CHART_SVG = (size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 20h16"/><path d="M7 16v-4"/><path d="M12 16V6"/><path d="M17 16v-7"/></svg>`;

const RANGES = [
  [7, "7 дней"],
  [30, "30 дней"],
  [90, "90 дней"],
];
const MON = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MON_FULL = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

const sv = { on: false, range: 30, stats: null, silence: null, enabled: true, confirm: false, hover: -1, ro: null };
try {
  const r = Number(localStorage.getItem("ytcs:statsRange"));
  if (RANGES.some(([n]) => n === r)) sv.range = r;
} catch (e) {
  /* не критично */
}

// ---------- кнопка в шапке ----------
const tab = $("#st-tab");
tab.querySelector(".st-tab-ic").innerHTML = CHART_SVG(18);
// второй щелчок — назад к разделу, откуда пришли
tab.addEventListener("click", () => (sv.on ? closeStats() : openStats()));
// «Плейлисты» / «Очередь» — уйти из статистики
$(".views").addEventListener("click", (e) => {
  if (e.target.closest("[data-view]") && sv.on) closeStats();
});

function selectTabs() {
  for (const b of document.querySelectorAll(".views [data-view]")) b.setAttribute("aria-selected", String(!sv.on && b.dataset.view === state.view));
  tab.setAttribute("aria-pressed", String(sv.on));
}

export async function openStats() {
  closeWatch();
  sv.on = true;
  sv.confirm = false;
  document.body.dataset.stats = "1";
  $("#stats").hidden = false;
  selectTabs();
  document.title = "Статистика — Моя библиотека";
  history.replaceState(null, "", location.pathname + location.search + "#stats");
  await load();
  render();
  window.scrollTo(0, 0);
}

export function closeStats() {
  if (!sv.on) return;
  sv.on = false;
  delete document.body.dataset.stats;
  $("#stats").hidden = true;
  $("#stats").innerHTML = "";
  selectTabs();
  document.title = state.view === "queue" ? "Очередь — Моя библиотека" : "Моя библиотека — плейлисты YouTube";
  saveHash();
}

async function load() {
  const r = await chrome.storage.local.get([STATS_KEY, "settings", "silenceSaved"]).catch(() => ({}));
  sv.stats = cleanStats(r[STATS_KEY]);
  sv.enabled = r.settings?.watchStats !== false;
  sv.silence = r.silenceSaved || null;
}

// Пропуск тишины пишет и свой итог — chrome.storage.local.silenceSaved
// { sec, day, total, days: { "YYYY-MM-DD": сек } }. За дни, когда событий
// «ytcs-stats:saved» от него не было (статистика была выключена или ещё не
// стояла), берём оттуда.
function withSilence(sum) {
  const x = sv.silence;
  if (!x || typeof x !== "object") return sum;
  const days = x.days && typeof x.days === "object" ? { ...x.days } : {};
  if (typeof x.day === "string" && Number(x.sec) > 0) days[x.day] = Math.max(Number(days[x.day]) || 0, Number(x.sec));
  let add = 0;
  for (const [d, sec] of Object.entries(days)) if (d >= sum.from && d <= sum.to && !sv.stats.days[d]?.si && Number(sec) > 0) add += Number(sec);
  return add ? { ...sum, silence: sum.silence + add, saved: sum.saved + add } : sum;
}

chrome.storage.onChanged.addListener(async (ch, area) => {
  if (area !== "local" || !sv.on || !(ch[STATS_KEY] || ch.settings || ch.silenceSaved)) return;
  await load();
  render();
});

const statsHash = () => location.hash === "#stats" || new URLSearchParams(location.hash.slice(1)).get("v") === "stats";
window.addEventListener("hashchange", () => {
  if (statsHash()) void openStats();
  else if (sv.on) closeStats();
});

// ---------- подписи ----------
const dateOf = (key) => new Date(dayStart(key));
function dayLabel(key, today) {
  if (key === today) return "Сегодня";
  if (key === shiftDay(today, -1)) return "Вчера";
  const d = dateOf(key);
  return `${WD[d.getDay()]}, ${d.getDate()} ${MON_FULL[d.getMonth()]}`;
}
function rangeLabel(a, b) {
  const da = dateOf(a);
  const db = dateOf(b);
  if (a === b) return `${db.getDate()} ${MON_FULL[db.getMonth()]}`;
  if (da.getMonth() === db.getMonth()) return `${da.getDate()}–${db.getDate()} ${MON_FULL[db.getMonth()]}`;
  return `${da.getDate()} ${MON_FULL[da.getMonth()]} – ${db.getDate()} ${MON_FULL[db.getMonth()]}`;
}
const sinceText = (ts) => {
  const d = new Date(ts);
  const y = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${d.getDate()} ${MON_FULL[d.getMonth()]}${y}`;
};
const pct = (x) => {
  const p = x * 100;
  return p >= 10 || p === 0 ? `${Math.round(p)}%` : p >= 1 ? `${p.toFixed(1).replace(".", ",")}%` : "<1%";
};
// значение и единицы раздельно — число крупно, «ч» и «мин» мельче
function durHtml(sec) {
  return esc(fmtDur(sec)).replace(/(\d[\d\s ]*)/g, "<b>$1</b>");
}

// ---------- отрисовка ----------
function render() {
  if (!sv.on) return;
  const box = $("#stats");
  const st = sv.stats;
  if (!hasData(st)) {
    box.innerHTML = `<div class="st-wrap st-empty-wrap">${emptyHtml()}</div>`;
    return;
  }
  const now = Date.now();
  const t = totals(st, now);
  const sum = withSilence(summarize(st, sv.range, now));
  const week = summarize(st, 7, now);
  const month = summarize(st, 30, now);
  box.innerHTML = `<div class="st-wrap">
    <header class="st-head">
      <div class="st-ttl">
        <h1>Статистика просмотра</h1>
        <p>Считаем с ${sinceText(st.since)} — только время, когда видео играет. Данные хранятся только на этом компьютере.</p>
      </div>
    </header>
    ${sv.enabled ? "" : `<div class="st-off" role="status"><span>${icon("clock", { size: 18 })}Сбор статистики выключен — ниже то, что собрано раньше.</span><button type="button" class="ghost" data-st="enable">Включить</button></div>`}
    <section class="st-tiles" aria-label="Сколько вы смотрели">
      ${tileHtml("Сегодня", t.today, t.yesterday ? `вчера ${fmtDur(t.yesterday)}` : t.newToday ? "считаем с сегодняшнего дня" : "вчера не смотрели")}
      ${tileHtml("За 7 дней", t.week, `в среднем ${fmtDur(week.avg)} в день`)}
      ${tileHtml("За 30 дней", t.month, `в среднем ${fmtDur(month.avg)} в день`)}
    </section>
    <div class="st-bar">
      <h2>За последние ${esc(RANGES.find(([n]) => n === sv.range)[1])}</h2>
      <div class="st-range" role="radiogroup" aria-label="Период">${RANGES.map(([n, l]) => `<button type="button" role="radio" data-range="${n}" aria-checked="${n === sv.range}">${l}</button>`).join("")}</div>
    </div>
    <section class="st-card st-chart-card" aria-label="Время просмотра по ${sum.span > 31 ? "неделям" : "дням"}">
      <div class="st-card-h">
        <div>
          <h3>Время просмотра по ${sum.span > 31 ? "неделям" : "дням"}</h3>
          <p>${chartSub(sum)}</p>
        </div>
        ${sum.shorts > 0 ? `<div class="st-legend" aria-hidden="true"><span><i class="k-video"></i>Видео</span><span><i class="k-shorts"></i>Shorts</span></div>` : ""}
      </div>
      <div class="st-chart" id="st-chart"></div>
      ${tableHtml(sum)}
    </section>
    <div class="st-cols${sum.channels.length < 5 ? " few" : ""}">
      ${channelsHtml(sum)}
      <div class="st-side">
        ${savedHtml(sum)}
        ${videosHtml(sum)}
      </div>
    </div>
    ${settingsHtml()}
  </div>`;
  drawChart(sum);
}

function tileHtml(label, sec, sub) {
  return `<div class="st-tile"><div class="st-tile-l">${label}</div><div class="st-tile-v">${durHtml(sec)}</div><div class="st-tile-s">${esc(sub)}</div></div>`;
}

function chartSub(sum) {
  const parts = [`всего ${fmtDur(sum.watch)}`];
  if (sum.shorts > 0) parts.push(`из них Shorts ${fmtDur(sum.shorts)}`);
  parts.push(`смотрели ${nf.format(sum.activeDays)} ${plural(sum.activeDays, "день", "дня", "дней")} из ${nf.format(sum.days)}`);
  return esc(parts.join(" · "));
}

function emptyHtml() {
  return `<div class="empty-box st-empty">
      <div class="empty-icon">${CHART_SVG(30)}</div>
      <h1 class="empty-title">Статистика пока пустая</h1>
      <div class="empty-text">${
        sv.enabled
          ? "Смотрите видео на YouTube или прямо здесь, в библиотеке, — тут появятся время просмотра по дням, любимые каналы и сколько времени сэкономили скорость и пропуск рекламных вставок."
          : "Сбор статистики выключен. Включите — и тут появятся время просмотра по дням, любимые каналы и сэкономленное время."
      }</div>
      <div class="empty-text st-empty-note">Считается только время, когда видео играет, и только на этом компьютере.</div>
      ${sv.enabled ? "" : `<button type="button" class="primary" data-st="enable">Включить сбор статистики</button>`}
    </div>`;
}

function channelsHtml(sum) {
  const rows = sum.channels;
  const body = rows.length
    ? `<ol class="st-ch">${rows
        .map(
          (c) => `<li>
          <div class="st-ch-top"><span class="st-ch-name" title="${esc(c.name)}">${esc(c.name)}</span><span class="st-ch-val"><b>${esc(fmtDur(c.sec))}</b><span>${pct(c.share)}</span></span></div>
          <div class="st-meter" role="presentation"><i style="width:${Math.max(1.5, Math.min(100, c.share * 100)).toFixed(1)}%"></i></div>
        </li>`
        )
        .join("")}</ol>
      ${sum.other.count ? `<div class="st-ch-more">И ещё ${nf.format(sum.other.count)} ${plural(sum.other.count, "канал", "канала", "каналов")} — ${esc(fmtDur(sum.other.sec))}</div>` : ""}`
    : `<div class="st-none">${sum.video > 0 ? "Каналы этих видео плеер не сообщил." : "За этот период обычные видео не смотрели — только Shorts."}</div>`;
  return `<section class="st-card st-channels" aria-label="Каналы">
    <div class="st-card-h"><div><h3>Каналы</h3><p>Доля — от времени обычных видео, без Shorts</p></div></div>
    ${body}
  </section>`;
}

function savedHtml(sum) {
  const items = [
    ["Скорость быстрее 1×", sum.speed, "Смотрели на 1,25×, 1,5×, 2× — разница с обычной скоростью"],
    ["Пропуск рекламных вставок", sum.sponsor, "Реклама спонсоров, самореклама, просьбы подписаться — по SponsorBlock"],
  ];
  if (sum.silence > 0) items.push(["Пропуск тишины", sum.silence, "Паузы без звука в видео"]);
  const max = Math.max(1, ...items.map((x) => x[1]));
  const share = sum.watch > 0 ? sum.saved / (sum.watch + sum.saved) : 0;
  return `<section class="st-card st-saved" aria-label="Сэкономлено">
    <div class="st-card-h"><div><h3>Сэкономлено</h3><p>${sum.saved > 0 ? `без расширения смотрели бы на ${pct(share)} дольше` : "Пока нечего: скорость была обычной, вставок не попадалось"}</p></div></div>
    <div class="st-hero">${durHtml(sum.saved)}</div>
    <ul class="st-save">${items
      .map(
        ([l, v, hint]) => `<li title="${esc(hint)}">
        <div class="st-ch-top"><span>${l}</span><b>${esc(fmtDur(v))}</b></div>
        <div class="st-meter" role="presentation"><i style="width:${v > 0 ? Math.max(1.5, (v / max) * 100).toFixed(1) : 0}%"></i></div>
      </li>`
      )
      .join("")}</ul>
  </section>`;
}

function videosHtml(sum) {
  const cell = (n, l) => `<div><div class="st-num">${nf.format(n)}</div><div class="st-lbl">${l}</div></div>`;
  return `<section class="st-card st-videos" aria-label="Видео и очередь">
    <div class="st-card-h"><div><h3>Видео и очередь</h3></div></div>
    <div class="st-nums">
      ${cell(sum.n, "видео смотрели дольше 30&nbsp;секунд")}
      ${cell(sum.fin, "досмотрели до конца")}
      ${cell(sum.qd, "досмотрено из очереди")}
      ${cell(sum.qx, "убрано из очереди без просмотра")}
    </div>
  </section>`;
}

function settingsHtml() {
  return `<section class="st-card st-set" aria-label="Настройки статистики">
    <label class="switch"><span>Собирать статистику<small>Время просмотра, каналы и сэкономленное — только на этом компьютере, никуда не отправляется</small></span><input type="checkbox" data-st="toggle" ${sv.enabled ? "checked" : ""} /></label>
    <div class="st-clear">${
      sv.confirm
        ? `<span class="st-confirm">Удалить всю статистику? Это не отменить.</span><button type="button" class="ghost danger" data-st="clear-yes">${icon("close", { size: 16 })}Удалить</button><button type="button" class="ghost" data-st="clear-no">Отмена</button>`
        : `<button type="button" class="ghost danger" data-st="clear">${icon("close", { size: 16 })}Очистить статистику</button>`
    }</div>
  </section>`;
}

// скрытая таблица — те же числа для чтения с экрана
function tableHtml(sum) {
  return `<table class="st-sr"><caption>Время просмотра по ${sum.span > 31 ? "неделям" : "дням"}</caption><thead><tr><th>Период</th><th>Видео</th><th>Shorts</th></tr></thead><tbody>${sum.series
    .map((b) => `<tr><td>${esc(b.from === b.to ? dayLabel(b.to, sum.to) : rangeLabel(b.from, b.to))}</td><td>${esc(fmtDur(b.video))}</td><td>${esc(fmtDur(b.shorts))}</td></tr>`)
    .join("")}</tbody></table>`;
}

// ---------- столбики (SVG) ----------
// Шаги шкалы — круглые: минуты, потом часы
const STEPS = [60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 10800, 14400, 21600, 28800, 36000, 43200, 72000, 86400, 172800];
function niceStep(max, ticks) {
  for (const s of STEPS) if (max / s <= ticks) return s;
  return Math.ceil(max / ticks / 86400) * 86400;
}
const tickLabel = (sec) => (sec === 0 ? "0" : sec < 3600 ? `${Math.round(sec / 60)} мин` : `${String(Math.round((sec / 3600) * 10) / 10).replace(".", ",")} ч`);

function drawChart(sum) {
  const host = $("#st-chart");
  if (!host) return;
  sv.ro?.disconnect();
  sv.ro = new ResizeObserver(() => paint(host, sum));
  sv.ro.observe(host);
  paint(host, sum);
}

function paint(host, sum) {
  const W = Math.floor(host.clientWidth);
  if (!W) return;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const fs = Math.round(rem * 0.82);
  const H = Math.round(Math.min(Math.max(rem * 15, 200), 340));
  const series = sum.series;
  const max = Math.max(...series.map((b) => b.video + b.shorts), 0);
  const step = niceStep(Math.max(max, 1800), 4);
  const top = Math.max(step, Math.ceil(max / step) * step);
  // поля: слева — подписи шкалы (меряем самую длинную), снизу — даты
  const ctx = (paint.ctx ||= document.createElement("canvas").getContext("2d"));
  ctx.font = `${fs}px ${getComputedStyle(document.body).fontFamily}`;
  const ticks = [];
  for (let v = 0; v <= top + 1; v += step) ticks.push(v);
  const padL = Math.ceil(Math.max(...ticks.map((v) => ctx.measureText(tickLabel(v)).width))) + 12;
  const padR = 4;
  const padT = Math.round(fs * 0.8);
  const padB = Math.round(fs * 2.2);
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = series.length;
  const slot = plotW / n;
  const bw = Math.max(3, Math.min(Math.round(slot * 0.62), Math.round(rem * 1.75)));
  const y = (v) => padT + plotH - (v / top) * plotH;
  const r = Math.min(4, bw / 2);
  // столбик со скруглённым верхом и прямым низом
  const barPath = (x, y0, y1, round) => {
    const h = y1 - y0;
    if (h <= 0) return "";
    const rr = round ? Math.min(r, h) : 0;
    return `M${x},${y1}V${y0 + rr}${rr ? `Q${x},${y0} ${x + rr},${y0}` : ""}H${x + bw - rr}${rr ? `Q${x + bw},${y0} ${x + bw},${y0 + rr}` : ""}V${y1}Z`;
  };
  // подписи дат — сколько влезает, от сегодняшнего столбика назад
  const weekly = sum.span > 31;
  const fmtX = (b) => {
    const d = dateOf(weekly ? b.from : b.to);
    return n <= 7 ? `${WD[d.getDay()]} ${d.getDate()}` : `${d.getDate()} ${MON[d.getMonth()]}`;
  };
  const labW = Math.max(...series.map((b) => ctx.measureText(fmtX(b)).width)) + 14;
  const every = Math.max(1, Math.ceil(labW / slot));
  let grid = "";
  for (const v of ticks) {
    const yy = Math.round(y(v)) + 0.5;
    grid += `<line class="${v === 0 ? "base" : "grid"}" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/><text class="tick" x="${padL - 10}" y="${yy}" dy="0.34em" text-anchor="end">${tickLabel(v)}</text>`;
  }
  let bars = "";
  let labels = "";
  const marks = [];
  series.forEach((b, i) => {
    const x = Math.round(padL + slot * i + (slot - bw) / 2);
    const base = y(0);
    const yv = y(b.video);
    const yt = y(b.video + b.shorts);
    const gap = b.video > 0 && b.shorts > 0 ? 2 : 0; // просвет между видео и Shorts
    bars += `<g class="col${i === sv.hover ? " on" : ""}" data-i="${i}">
      <rect class="hit" x="${(padL + slot * i).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${plotH}"/>
      ${b.video > 0 ? `<path class="b-video" d="${barPath(x, yv, base, b.shorts <= 0)}"/>` : ""}
      ${b.shorts > 0 ? `<path class="b-shorts" d="${barPath(x, yt, yv - gap, true)}"/>` : ""}
    </g>`;
    marks.push({ i, b, c: x + bw / 2 });
  });
  // подписи — от сегодняшнего столбика назад: по центру столбика, но не за краем
  // графика и не вплотную к соседней (сдвинутая крайняя вытесняет соседку)
  let leftEdge = Infinity;
  for (const { i, b, c } of marks.reverse()) {
    if ((n - 1 - i) % every) continue;
    const half = ctx.measureText(fmtX(b)).width / 2 + (i === n - 1 ? 4 : 0);
    const cx = Math.max(padL + half, Math.min(W - half, c));
    if (cx + half > leftEdge - 10 || cx - half < 0) continue;
    leftEdge = cx - half;
    labels += `<text class="xl${i === n - 1 ? " now" : ""}" x="${cx.toFixed(1)}" y="${H - padB + fs * 1.5}" text-anchor="middle">${esc(fmtX(b))}</text>`;
  }
  host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="Время просмотра по ${weekly ? "неделям" : "дням"}: стрелки — по столбикам" style="font-size:${fs}px">
    ${grid}${bars}${labels}
  </svg><div class="st-tip" hidden></div>`;
  const svg = host.querySelector("svg");
  const tip = host.querySelector(".st-tip");
  const show = (i) => {
    sv.hover = i;
    for (const g of svg.querySelectorAll(".col")) g.classList.toggle("on", Number(g.dataset.i) === i);
    if (i < 0) return void (tip.hidden = true);
    const b = series[i];
    tip.replaceChildren();
    const h = document.createElement("div");
    h.className = "st-tip-h";
    h.textContent = weekly ? rangeLabel(b.from, b.to) : dayLabel(b.to, sum.to);
    const v = document.createElement("div");
    v.className = "st-tip-v";
    v.textContent = b.video + b.shorts > 0 ? fmtDur(b.video + b.shorts) : "не смотрели";
    tip.append(h, v);
    if (b.shorts > 0 && b.video > 0) {
      for (const [cls, label, val] of [["k-video", "Видео", b.video], ["k-shorts", "Shorts", b.shorts]]) {
        const row = document.createElement("div");
        row.className = "st-tip-row";
        const k = document.createElement("i");
        k.className = cls;
        const l = document.createElement("span");
        l.textContent = label;
        const val2 = document.createElement("b");
        val2.textContent = fmtDur(val);
        row.append(k, l, val2);
        tip.append(row);
      }
    }
    tip.hidden = false;
    // над столбиком, не вылезая за края графика
    const cx = padL + slot * i + slot / 2;
    const tw = tip.offsetWidth;
    const left = Math.max(0, Math.min(W - tw, cx - tw / 2));
    const barTop = y(b.video + b.shorts);
    const th = tip.offsetHeight;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(0, barTop - th - 10)}px`;
  };
  svg.addEventListener("pointermove", (e) => {
    const g = e.target.closest(".col");
    show(g ? Number(g.dataset.i) : -1);
  });
  svg.addEventListener("pointerleave", () => show(-1));
  svg.addEventListener("focus", () => show(sv.hover >= 0 ? sv.hover : n - 1));
  svg.addEventListener("blur", () => show(-1));
  svg.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const cur = sv.hover >= 0 ? sv.hover : n - 1;
    show(e.key === "Home" ? 0 : e.key === "End" ? n - 1 : Math.max(0, Math.min(n - 1, cur + (e.key === "ArrowLeft" ? -1 : 1))));
  });
  if (sv.hover >= n) sv.hover = -1;
  if (sv.hover >= 0 && document.activeElement === svg) show(sv.hover);
}

// ---------- действия ----------
$("#stats").addEventListener("click", async (e) => {
  const rb = e.target.closest("[data-range]");
  if (rb) {
    sv.range = Number(rb.dataset.range);
    sv.hover = -1;
    try {
      localStorage.setItem("ytcs:statsRange", String(sv.range));
    } catch (err) {
      /* не критично */
    }
    return render();
  }
  const a = e.target.closest("[data-st]")?.dataset.st;
  if (a === "enable") await setEnabled(true);
  else if (a === "clear") {
    sv.confirm = true;
    render();
    $("#stats [data-st='clear-no']")?.focus();
  } else if (a === "clear-no") {
    sv.confirm = false;
    render();
  } else if (a === "clear-yes") {
    sv.confirm = false;
    await chrome.storage.local.remove(STATS_KEY).catch(() => {});
    await load();
    render();
  }
});
$("#stats").addEventListener("change", (e) => {
  if (e.target.matches("[data-st='toggle']")) void setEnabled(e.target.checked);
});

async function setEnabled(on) {
  const { settings } = await chrome.storage.local.get("settings").catch(() => ({}));
  await chrome.storage.local.set({ settings: { ...(settings || {}), watchStats: on } }).catch(() => {});
  sv.enabled = on;
  render();
}

// ---------- старт: пришли по адресу #stats ----------
// #stats — и #v=stats (так открывают разделы библиотеки меню правого клика и боковая панель)
if (statsHash()) void openStats();
