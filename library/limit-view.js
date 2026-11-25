// «Статистика» → карточка «Мягкий лимит»: полоска «Сегодня 1 ч 40 мин из 2 ч»
// и сама настройка (выключатель и сколько в день). Логика лимита — limit-core.js,
// подсчёт и напоминания — фон (limit-bg.js), плашка над видео — limit.js.
// stats-view.js оставляет в разметке пустое место #st-limit и после каждой
// отрисовки зовёт mountLimit() — карточка заполняется из уже прочитанного,
// без мигания; свои изменения хранилища она отслеживает сама.

import { LIMIT_CFG_KEY, LIMIT_DAY_KEY, PRESETS, cleanCfg, cleanDay, fmtLeft, fmtLimit, fmtSpent, limitDay, progress } from "../limit-core.js";
import { STATS_KEY, dayKey } from "../stats-core.js";
import { icon } from "../sidepanel/icons.js";
import { esc } from "./state.js";

const lv = { cfg: cleanCfg(null), day: null, seed: 0, stats: true, loaded: false };

export async function loadLimit() {
  const r = await chrome.storage.local.get([LIMIT_CFG_KEY, LIMIT_DAY_KEY, "settings", STATS_KEY]).catch(() => ({}));
  lv.cfg = cleanCfg(r[LIMIT_CFG_KEY]);
  lv.day = r[LIMIT_DAY_KEY] || null;
  lv.stats = r.settings?.watchStats !== false;
  // лимит ещё ни разу не считал (только что обновили расширение) — берём «сегодня» из статистики
  const d = r[STATS_KEY]?.days?.[dayKey()];
  lv.seed = lv.day ? 0 : (Number(d?.w) || 0) + (Number(d?.s) || 0);
  lv.loaded = true;
}

function cardHtml() {
  const { cfg, stats } = lv;
  const day = lv.day || (lv.seed ? { day: limitDay(), sec: lv.seed } : null);
  const p = progress(cleanDay(day), cfg);
  const pct = Math.max(p.sec > 0 ? 1.5 : 0, p.frac * 100).toFixed(1);
  const sub = p.over ? `больше на ${fmtLeft(p.sec - p.limit)}` : `осталось ${fmtLeft(p.left)}`;
  const body = !cfg.on
    ? ""
    : !stats
      ? `<div class="st-lim-warn" role="status"><span>${icon("clock", { size: 18 })}Лимит считает время по статистике просмотра, а она выключена — напоминаний не будет.</span><button type="button" class="ghost" data-lim="stats-on">Включить статистику</button></div>`
      : `<div class="st-lim-now${p.over ? " over" : ""}">
          <div class="st-lim-row"><span class="st-lim-txt">Сегодня <b>${esc(fmtSpent(p.sec))}</b> из <b>${esc(fmtLimit(cfg.min))}</b></span><span class="st-lim-left">${esc(sub)}</span></div>
          <div class="st-meter st-lim-meter" role="progressbar" aria-label="Сегодня из лимита" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p.frac * 100)}"><i style="width:${pct}%"></i></div>
        </div>`;
  // широко: полоска слева, «В день» справа; узко — друг под другом
  const opts = cfg.on
    ? `<div class="st-lim-body">
        ${body}
        <div class="st-lim-opts">
          <span class="st-lim-l" id="st-lim-l">В день</span>
          <div class="st-range st-lim-range" role="radiogroup" aria-labelledby="st-lim-l">${PRESETS.map((m) => `<button type="button" role="radio" data-lim-min="${m}" aria-checked="${m === cfg.min}">${esc(fmtLimit(m))}</button>`).join("")}</div>
        </div>
      </div>
      <p class="st-lim-note">Новый день для лимита — в 4 утра: то, что смотрели после полуночи, считается к вечеру.</p>`
    : "";
  return `<section class="st-card st-limit${cfg.on ? " on" : ""}" aria-label="Мягкий лимит времени">
    <label class="switch"><span>Мягкий лимит времени<small>Напомню плашкой над видео, когда за день на YouTube посмотрите больше заданного. Просмотр ничем не блокируется.</small></span><input type="checkbox" data-lim="toggle" ${cfg.on ? "checked" : ""} /></label>
    ${opts}
  </section>`;
}

export function mountLimit() {
  const slot = document.getElementById("st-limit");
  if (!slot) return;
  if (!lv.loaded) return void loadLimit().then(mountLimit);
  // нажатая кнопка или выключатель после перерисовки остаётся в фокусе
  const a = slot.contains(document.activeElement) ? document.activeElement : null;
  const keep = a?.dataset.limMin ? `[data-lim-min="${a.dataset.limMin}"]` : a?.dataset.lim ? `[data-lim="${a.dataset.lim}"]` : "";
  slot.innerHTML = cardHtml();
  if (keep) slot.querySelector(keep)?.focus();
}

async function saveCfg(patch) {
  lv.cfg = { ...lv.cfg, ...patch };
  mountLimit();
  await chrome.storage.local.set({ [LIMIT_CFG_KEY]: lv.cfg }).catch(() => {});
}

document.getElementById("stats")?.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-lim-min]");
  if (b) return void saveCfg({ min: Number(b.dataset.limMin) });
  if (e.target.closest("[data-lim='stats-on']")) {
    const { settings } = await chrome.storage.local.get("settings").catch(() => ({}));
    await chrome.storage.local.set({ settings: { ...(settings || {}), watchStats: true } }).catch(() => {});
  }
});
document.getElementById("stats")?.addEventListener("change", (e) => {
  if (e.target.matches("[data-lim='toggle']")) void saveCfg({ on: e.target.checked });
});

chrome.storage.onChanged.addListener(async (ch, area) => {
  if (area !== "local" || !(ch[LIMIT_CFG_KEY] || ch[LIMIT_DAY_KEY] || ch.settings)) return;
  await loadLimit();
  mountLimit();
});

// после 4 утра — новый день: полоска обнуляется, даже если ничего не смотрели
setInterval(() => {
  if (lv.day && lv.day.day !== limitDay() && document.getElementById("st-limit")) mountLimit();
}, 60000);
