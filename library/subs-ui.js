// «Моя библиотека»: кнопка «В субтитрах» и панель её состояния
// (знакомство, чтение субтитров, пауза, место на диске, удаление).
//
// Чтение субтитров тысяч видео идёт часами, поэтому кнопка не переключает сразу,
// а открывает панель: там «Включить», ход чтения, «Пауза», «Выключить», «Удалить прочитанное».

import { icon } from "../sidepanel/icons.js";
import { $, esc, nf, state, videosWord } from "./state.js";
import { PER_VIDEO, clearSubs, leftSec, loadStats, onSubs, onSubsResults, retryNow, setPaused, setSubs, subs } from "./subs.js";
import { update } from "./view-lib.js";

let open = false;
let clearArmed = 0; // «Удалить прочитанное» — второй щелчок в течение 4 с подтверждает

const mb = (bytes) => (bytes < 1024 * 1024 ? `${nf.format(Math.max(1, Math.round(bytes / 1024)))} КБ` : `${nf.format(Math.round((bytes / 1048576) * 10) / 10)} МБ`);
// «около 2 ч 40 мин», «около 15 мин», «меньше минуты»
export function aboutTime(sec) {
  if (sec < 60) return "меньше минуты";
  const m = Math.round(sec / 60);
  if (m < 60) return `около ${m} мин`;
  const h = Math.floor(m / 60);
  const r = Math.round((m % 60) / 10) * 10;
  return `около ${h} ч${r ? ` ${r} мин` : ""}`;
}
const clock = (ts) => new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

function head(title, busy) {
  return `<div class="td-top"><b>${icon("subtitles", { size: 20 })} ${title}</b><button type="button" class="ghost" data-subs="close">${icon("close", { size: 16 })}Закрыть</button></div>${busy || ""}`;
}

function progress() {
  const pct = subs.total ? Math.floor((subs.done / subs.total) * 100) : 0;
  return `<div class="subs-meta"><span>${nf.format(subs.done)} из ${videosWord(subs.total)}</span><span>${pct}%</span></div>
    <div class="wl-bar"><div style="width:${pct}%"></div></div>`;
}

function stored() {
  const { ok, bytes } = subs.stats;
  return ok ? ` Занимают ${mb(bytes)} в этом браузере и никуда не отправляются.` : "";
}

function panelHtml() {
  const left = Math.max(0, subs.total - subs.done);
  const read = subs.stats.ok + subs.stats.none;
  const armed = Date.now() - clearArmed < 4000;
  const del = read ? `<button type="button" class="ghost${armed ? " danger" : ""}" data-subs="clear">${icon("close", { size: 16 })}${armed ? `Точно удалить? ${mb(subs.stats.bytes)}` : "Удалить прочитанное"}</button>` : "";
  if (!subs.on) {
    const n = read ? left : subs.total;
    const est = !state.cat || !n ? "" : ` Для ${read ? "оставшихся " : "ваших "}${videosWord(n)} это ${aboutTime(n * PER_VIDEO.sec)} — пока открыта библиотека; закроете вкладку — продолжу с того же места. Займёт примерно ${mb(n * PER_VIDEO.kb * 1024)}.`;
    const how = read && !left ? "" : ` Для этого субтитры ваших видео один раз читаются с YouTube — по одному, с паузами, чтобы не перегружать его.${est} Shorts пропускаются.`;
    const have = !read ? "" : left ? `Уже прочитано ${nf.format(subs.done)} из ${videosWord(subs.total)}.${stored()}` : `Субтитры всех видео уже прочитаны — поиск заработает сразу.${stored()}`;
    return `<section class="tidy">${head("Поиск по субтитрам")}
      <div class="sem-text">Находит видео по тому, что в них говорят, и открывает с нужного места: «блок питания» найдёт сборку компьютера, где о нём рассказывают на 12-й минуте.${how}</div>
      ${have ? `<div class="sem-text">${have}</div>` : ""}
      <div class="sem-row"><button type="button" class="primary" data-subs="on">${icon("subtitles", { size: 16 })}${read && left ? "Включить и продолжить" : "Включить"}</button>${del}</div></section>`;
  }
  const off = `<button type="button" class="ghost" data-subs="off">Выключить</button>`;
  const all = subs.total && subs.done >= subs.total;
  const keep = " Поиск идёт по уже прочитанному.";
  if (!subs.ready || subs.status === "loading")
    return `<section class="tidy">${head("Загружаю прочитанные субтитры")}<div class="sem-text">Несколько секунд — дальше поиск по субтитрам работает вместе с обычным.</div></section>`;
  if (subs.status === "error")
    return `<section class="tidy">${head("Чтение субтитров остановилось")}<div class="sem-text wl-err">${esc(subs.error)}</div>
      <div class="sem-row"><button type="button" class="primary" data-subs="retry">${icon("refresh", { size: 16 })}Повторить</button>${off}</div></section>`;
  if (all)
    return `<section class="tidy">${head("Субтитры прочитаны")}
      <div class="sem-text">Ищу по субтитрам ${videosWord(subs.stats.ok)}${subs.stats.none ? `; у ${videosWord(subs.stats.none)} их нет` : ""}.${stored()} Новые видео дочитаются сами после «Обновить».</div>
      <div class="sem-row">${off}${del}</div></section>`;
  if (subs.paused)
    return `<section class="tidy">${head("Чтение субтитров на паузе")}${progress()}
      <div class="sem-text">Осталось ${aboutTime(leftSec())}.${keep}${stored()}</div>
      <div class="sem-row"><button type="button" class="primary" data-subs="resume">${icon("play", { size: 16 })}Продолжить</button>${off}</div></section>`;
  if (subs.status === "waiting")
    return `<section class="tidy">${head("YouTube просит не спешить")}${progress()}
      <div class="sem-text">Продолжу сам в ${clock(subs.waitUntil)}.${keep}</div>
      <div class="sem-row"><button type="button" class="ghost" data-subs="now">${icon("refresh", { size: 16 })}Повторить сейчас</button><button type="button" class="ghost" data-subs="pause">Пауза</button>${off}</div></section>`;
  if (subs.status === "other")
    return `<section class="tidy">${head("Субтитры читает другая вкладка")}${progress()}
      <div class="sem-text">Другая вкладка «Моей библиотеки» уже читает субтитры — здесь только поиск, чтобы не спрашивать YouTube дважды.${keep}</div>
      <div class="sem-row">${off}</div></section>`;
  return `<section class="tidy">${head("Читаю субтитры")}${progress()}
    <div class="sem-text">Обычный поиск работает и сейчас, найденное в субтитрах добавляется по мере чтения. Осталось ${aboutTime(leftSec())} — пока открыта библиотека; закроете вкладку — продолжу с того же места.${stored()}</div>
    <div class="sem-row"><button type="button" class="ghost" data-subs="pause">Пауза</button>${off}</div></section>`;
}

function render() {
  const btn = $("#subs-btn");
  const box = $("#subs-info");
  if (!btn || !box) return;
  btn.setAttribute("aria-pressed", String(subs.on));
  btn.setAttribute("aria-expanded", String(open));
  const reading = subs.on && !subs.paused && subs.total > subs.done && ["reading", "waiting"].includes(subs.status);
  const pct = subs.total ? Math.floor((subs.done / subs.total) * 100) : 0;
  const label = btn.querySelector(".subs-pct");
  const txt = reading ? `${pct}%` : "";
  if (label.textContent !== txt) label.textContent = txt;
  label.hidden = !txt;
  const html = open ? panelHtml() : "";
  if (box.innerHTML !== html) box.innerHTML = html;
  box.hidden = !html;
}

onSubs(render);
onSubsResults(() => {
  if (state.view === "lib" && state.q.trim()) update({ keep: true });
});

document.addEventListener("click", async (e) => {
  if (e.target.closest("#subs-btn")) {
    open = !open;
    if (open) void loadStats().then(render);
    render();
    return;
  }
  const a = e.target.closest("[data-subs]")?.dataset.subs;
  if (!a) return;
  if (a === "close") open = false;
  else if (a === "on") await setSubs(true);
  else if (a === "off") await setSubs(false);
  else if (a === "pause") await setPaused(true);
  else if (a === "resume" || a === "retry") {
    if (a === "retry") subs.status = "loading";
    await setPaused(false);
  } else if (a === "now") retryNow();
  else if (a === "clear") {
    if (Date.now() - clearArmed > 4000) {
      clearArmed = Date.now();
      setTimeout(render, 4100);
    } else {
      clearArmed = 0;
      await clearSubs();
    }
  }
  render();
  if (["on", "off", "clear"].includes(a) && state.q.trim()) update({ keep: true });
});

// иконка в кнопке рисуется общим кодом library.js; состояние — после загрузки настроек
setTimeout(render, 0);
