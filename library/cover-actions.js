// «Моя библиотека»: на обложках карточек — «Превью» и «О чём видео», как на YouTube.
// Кнопки и окна рисует общий модуль ../video-actions.js (подключён в library.html
// обычным скриптом); здесь — только привязка к карточкам, которые появляются при
// прокрутке, поиске и смене вида.

import { state } from "./state.js";

const VA = () => globalThis.__ytcsVideoActions;

function infoFor(card) {
  const qid = card.dataset.qid;
  const vid = card.dataset.vid;
  if (qid) {
    const r = state.queue?.find((x) => x.id === qid);
    return { videoId: qid, title: r?.title || "", channel: r?.channel || "", len: r?.len || 0 };
  }
  const v = vid && state.cat?.videos.find((x) => x.id === vid);
  return { videoId: vid, title: v?.title || "", channel: v?.channel || "", len: v?.len || 0 };
}

function bind(root) {
  const va = VA();
  if (!va) return;
  for (const th of root.querySelectorAll(".card .thumb:not([data-va])")) {
    const card = th.closest(".card");
    if (!card || !(card.dataset.qid || card.dataset.vid)) continue;
    th.dataset.va = "1";
    va.attach(th, { getInfo: () => infoFor(card), card });
  }
}

for (const sel of ["#grid", "#cont"]) {
  const el = document.querySelector(sel);
  if (!el) continue;
  bind(el);
  new MutationObserver(() => bind(el)).observe(el, { childList: true, subtree: true });
}
