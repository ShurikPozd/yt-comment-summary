// Блок «Мягкий лимит времени» в настройках панели. Отдельный модуль: сам читает
// и пишет chrome.storage.local.watchLimit ({ on, min }) — отдельный ключ, не
// settings, поэтому «Сохранить» панели его не затирает. Под выключателем — сколько
// в день и полоска «Сегодня 1 ч 40 мин из 2 ч». Логика — limit-core.js, подсчёт и
// напоминания — фон (limit-bg.js), плашка над видео — limit.js. То же самое есть в
// «Моей библиотеке» → «Статистика».

import { LIMIT_CFG_KEY, LIMIT_DAY_KEY, PRESETS, cleanCfg, cleanDay, fmtLeft, fmtLimit, fmtSpent, progress } from "../limit-core.js";

const $ = (id) => document.getElementById(id);
const lv = { cfg: cleanCfg(null), day: null, stats: true };

function render() {
  const box = $("lim-opts");
  const sw = $("set-limit");
  if (!box || !sw) return;
  const { cfg } = lv;
  sw.checked = cfg.on;
  box.hidden = !cfg.on;
  if (!cfg.on) return void box.replaceChildren();
  const p = progress(cleanDay(lv.day), cfg);
  const keep = box.contains(document.activeElement) ? document.activeElement.dataset.limMin || document.activeElement.dataset.lim : "";
  const chips = `<div class="lim-l" id="lim-l">Сколько в день</div>
    <div class="lim-chips" role="radiogroup" aria-labelledby="lim-l">${PRESETS.map(
      (m) => `<button type="button" role="radio" class="lim-chip" data-lim-min="${m}" aria-checked="${m === cfg.min}">${fmtLimit(m)}</button>`
    ).join("")}</div>`;
  // сначала — сколько уже сегодня, ниже — выбор (как в «Статистике» библиотеки)
  box.innerHTML = lv.stats
    ? `<div class="lim-now${p.over ? " over" : ""}">
        <div class="lim-row"><span class="lim-txt">Сегодня <b>${fmtSpent(p.sec)}</b> из <b>${fmtLimit(cfg.min)}</b></span><span class="lim-left">${p.over ? `больше на ${fmtLeft(p.sec - p.limit)}` : `осталось ${fmtLeft(p.left)}`}</span></div>
        <div class="lim-meter" role="progressbar" aria-label="Сегодня из лимита" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p.frac * 100)}"><i style="width:${Math.max(p.sec > 0 ? 1.5 : 0, p.frac * 100).toFixed(1)}%"></i></div>
      </div>${chips}`
    : `<div class="lim-warn" role="status"><span>Лимит считает время по статистике просмотра, а она выключена — напоминаний не будет.</span><button type="button" class="ghost" data-lim="stats-on">Включить статистику</button></div>${chips}`;
  if (keep) box.querySelector(`[data-lim-min="${keep}"], [data-lim="${keep}"]`)?.focus();
}

async function load() {
  const r = await chrome.storage.local.get([LIMIT_CFG_KEY, LIMIT_DAY_KEY, "settings"]).catch(() => ({}));
  lv.cfg = cleanCfg(r[LIMIT_CFG_KEY]);
  lv.day = r[LIMIT_DAY_KEY] || null;
  lv.stats = r.settings?.watchStats !== false;
  render();
}

async function save(patch) {
  lv.cfg = { ...lv.cfg, ...patch };
  render();
  await chrome.storage.local.set({ [LIMIT_CFG_KEY]: lv.cfg }).catch(() => {});
}

let toastTimer = 0;
function toast(text) {
  const el = $("toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function init() {
  if (!$("lim-opts") || !$("set-limit")) return;
  void load();
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && (ch[LIMIT_CFG_KEY] || ch[LIMIT_DAY_KEY] || ch.settings)) void load();
  });
  $("set-limit").addEventListener("change", (e) => {
    const on = e.target.checked;
    void save({ on });
    toast(on ? `Напомню, когда за день будет больше ${fmtLimit(lv.cfg.min)}` : "Мягкий лимит выключен");
  });
  $("lim-opts").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-lim-min]");
    if (b) return void save({ min: Number(b.dataset.limMin) });
    if (e.target.closest("[data-lim='stats-on']")) {
      const { settings } = await chrome.storage.local.get("settings").catch(() => ({}));
      await chrome.storage.local.set({ settings: { ...(settings || {}), watchStats: true } }).catch(() => {});
      toast("Статистика просмотра включена");
    }
  });
}

init();
