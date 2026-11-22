// «Моя библиотека»: кнопка «По смыслу» и панель её состояния (знакомство, загрузка, чтение названий).

import { icon } from "../sidepanel/icons.js";
import { ensureIndex, onSem, sem, setSemantic } from "./semantic.js";
import { $, esc, nf, state, videosWord } from "./state.js";
import { update } from "./view-lib.js";

let intro = false; // показать знакомство перед первым включением

function render() {
  const btn = $("#sem-btn");
  const box = $("#sem-info");
  if (!btn || !box) return;
  btn.setAttribute("aria-pressed", String(sem.on));
  btn.classList.toggle("busy", sem.on && (sem.status === "loading" || sem.status === "indexing"));
  let html = "";
  if (intro && !sem.on) {
    html = `<section class="tidy"><div class="td-top"><b>${icon("sparkles", { size: 18 })} Поиск по смыслу</b><button type="button" class="ghost" data-sem="close">${icon("close", { size: 16 })}Закрыть</button></div>
      <div class="sem-text">Ищет видео по теме, даже без общих слов в названии: «что приготовить утром» найдёт «Шакшука на завтрак», «learn english» — «Present Simple». Работает на этом компьютере, бесплатно: один раз скачается модель (около 120 МБ, дальше — из кеша) и прочитает названия ваших видео${state.cat ? ` — ${videosWord(state.cat.videos.length)}, это несколько минут` : ""}. Названия никуда не отправляются.</div>
      <div class="sem-row"><button type="button" class="primary" data-sem="on">${icon("sparkles", { size: 16 })}Включить</button><button type="button" class="ghost" data-sem="close">Не сейчас</button></div></section>`;
  } else if (sem.on && (sem.status === "loading" || sem.status === "indexing")) {
    const loading = sem.status === "loading";
    const pct = loading ? sem.dl : sem.total ? Math.round((sem.done / sem.total) * 100) : 0;
    html = `<section class="tidy"><div class="td-top"><b>${icon("sparkles", { size: 18 })} ${loading ? "Загружаю модель" : "Читаю названия видео"}</b><span class="sync-text">${loading ? `${pct}%` : `${nf.format(sem.done)} из ${nf.format(sem.total)}`}</span></div>
      <div class="wl-bar"><div style="width:${pct}%"></div></div>
      <div class="sem-text">${loading ? "Один раз — дальше модель берётся из кеша браузера." : "Обычный поиск работает и сейчас; «по смыслу» включится, когда названия будут прочитаны. Можно закрыть вкладку — продолжит с того же места."}</div></section>`;
  } else if (sem.on && sem.status === "error") {
    html = `<section class="tidy"><div class="td-top"><b>Поиск по смыслу не запустился</b><button type="button" class="ghost" data-sem="retry">${icon("refresh", { size: 16 })}Повторить</button></div>
      <div class="sem-text wl-err">${esc(sem.error)}</div></section>`;
  }
  box.innerHTML = html;
  box.hidden = !html;
}

onSem(() => {
  render();
  if (sem.status === "ready" && state.q.trim()) update({ keep: true });
});

document.addEventListener("click", (e) => {
  if (e.target.closest("#sem-btn")) {
    if (sem.on) {
      void setSemantic(false).then(() => update({ keep: true }));
    } else if (sem.status === "ready") {
      void setSemantic(true).then(() => update({ keep: true }));
    } else {
      intro = !intro;
      render();
    }
    return;
  }
  const a = e.target.closest("[data-sem]")?.dataset.sem;
  if (!a) return;
  if (a === "close") {
    intro = false;
    render();
  } else if (a === "on") {
    intro = false;
    void setSemantic(true);
  } else if (a === "retry") void ensureIndex();
});

// иконка в кнопке рисуется общим кодом library.js; состояние — после загрузки настроек
setTimeout(render, 0);
