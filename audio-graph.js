"use strict";

// Общий аудиограф плеера YouTube: громче 100 % и «Выравнивать громкость».
//
// createMediaElementSource можно вызвать у <video> только один раз, и после этого
// звук идёт уже не прямо в динамики, а через Web Audio. Поэтому граф — один на
// элемент и один на всё расширение: громкость по каналам (volume.js) и все, кому
// звук понадобится потом, берут его здесь, а не создают свой.
//   <video> → вход (GainNode 1×) → [выравнивание: DynamicsCompressorNode] → усиление (GainNode)
//           → [ограничитель пиков, если громче 100 %] → динамики
//  - Громкость и «без звука» самого <video> (ползунок YouTube, затухание таймера сна
//    sleep.js) действуют и после перенаправления: Chrome применяет их до графа.
//  - «Пропуск тишины» (silence.js) слушает копию звука (video.captureStream) — она
//    работает и после перенаправления и от графа не зависит. Если кому-то нужен
//    звук без копии — tap(video) отдаёт вход графа (до усиления).
//  - Граф строится, только когда он нужен (громче 100 % или выравнивание), и только
//    когда AudioContext уже запущен: на остановленном контексте видео замолчало бы.
//    Без щелчка по странице Chrome контекст не запускает — запускаем при первом
//    щелчке или клавише, а до тех пор звук идёт как обычно (100 %).
//  - Только для видео из MediaSource (blob:, так YouTube отдаёт все ролики): звук
//    чужого адреса без CORS граф превратил бы в тишину.
// Обычный скрипт: всё лежит в globalThis.__ytcsAudio (общий мир контент-скриптов).
(() => {
  if (globalThis.__ytcsAudio) return;
  const core = globalThis.__ytcsVolumeCore;
  const LEVELER = core?.leveler || { threshold: -24, knee: 30, ratio: 3, attack: 0.005, release: 0.3 };
  // ограничитель пиков — только когда громче 100 %: усиленный звук не «хрипит» на громких местах
  const LIMITER = { threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.1 };

  let ctx = null;
  const graphs = new WeakMap(); // <video> → { src, pre, comp, gain, lim, level, limited, g }

  function context() {
    if (ctx) return ctx;
    try {
      ctx = new AudioContext({ latencyHint: "interactive" }); // меньше задержка — звук не отстаёт от губ
      // контекст остановился (например, система забрала звук) — пробуем запустить снова
      ctx.addEventListener("statechange", () => ctx.state === "suspended" && void ctx.resume().catch(() => {}));
    } catch (e) {
      ctx = null;
    }
    return ctx;
  }

  // Без щелчка по странице контекст стоит — запускаем при первом же щелчке или клавише
  for (const t of ["pointerdown", "keydown"]) {
    document.addEventListener(t, () => ctx && ctx.state !== "running" && void ctx.resume().catch(() => {}), true);
  }

  function wire(g) {
    for (const n of [g.pre, g.comp, g.gain, g.lim]) {
      try {
        n.disconnect();
      } catch (e) {
        /* ещё не подключён */
      }
    }
    if (g.level) {
      g.pre.connect(g.comp);
      g.comp.connect(g.gain);
    } else {
      g.pre.connect(g.gain);
    }
    if (g.limited) {
      g.gain.connect(g.lim);
      g.lim.connect(ctx.destination);
    } else {
      g.gain.connect(ctx.destination);
    }
  }

  function build(v) {
    const c = ctx;
    try {
      const src = c.createMediaElementSource(v);
      const pre = c.createGain();
      const comp = c.createDynamicsCompressor();
      for (const [k, val] of Object.entries(LEVELER)) comp[k].value = val;
      const gain = c.createGain();
      const lim = c.createDynamicsCompressor();
      for (const [k, val] of Object.entries(LIMITER)) lim[k].value = val;
      src.connect(pre);
      const g = { src, pre, comp, gain, lim, level: false, limited: false, g: 1 };
      wire(g);
      graphs.set(v, g);
      return g;
    } catch (e) {
      return null; // элемент уже подключён к чужому графу и т. п. — без усиления
    }
  }

  const fromMse = (v) => /^blob:/.test(v.currentSrc || v.src || "");

  // Нужное усиление (1…3) и выравнивание для <video>.
  // Ответ: "ok" — так и звучит; "wait" — контекст ждёт щелчка по странице или
  // у видео ещё нет звука (попробуйте ещё раз позже); "none" — нельзя (звук чужого адреса).
  function want(v, { gain = 1, level = false } = {}) {
    if (!v) return "none";
    const k = Math.min(3, Math.max(1, Number(gain) || 1));
    let g = graphs.get(v);
    if (!g) {
      if (k <= 1.001 && !level) return "ok"; // ничего не нужно — звук не трогаем
      const c = context();
      if (!c) return "none";
      if (c.state !== "running") {
        void c.resume().catch(() => {});
        return "wait";
      }
      if (!v.currentSrc && !v.src) return "wait";
      if (!fromMse(v)) return "none";
      g = build(v);
      if (!g) return "none";
    }
    if (Math.abs(g.g - k) > 0.001) {
      g.g = k;
      // плавно (~50 мс): без щелчка в динамиках
      g.gain.gain.cancelScheduledValues(ctx.currentTime);
      g.gain.gain.setTargetAtTime(k, ctx.currentTime, 0.015);
    }
    if (g.level !== Boolean(level) || g.limited !== k > 1.001) {
      g.level = Boolean(level);
      g.limited = k > 1.001;
      wire(g);
    }
    return ctx.state === "running" ? "ok" : "wait";
  }

  globalThis.__ytcsAudio = {
    want,
    // граф уже есть у этого видео
    has: (v) => graphs.has(v),
    // вход графа (до выравнивания и усиления) — для анализа звука без копии
    tap: (v) => (graphs.has(v) ? { ctx, node: graphs.get(v).pre } : null),
    // что сейчас: { built, gain, level, state }
    status(v) {
      const g = v && graphs.get(v);
      return { built: Boolean(g), gain: g ? g.g : 1, level: Boolean(g?.level), state: ctx?.state || "none" };
    },
    // выход графа (после усиления) — для автопроверок: громкость на выходе
    out: (v) => (graphs.has(v) ? { ctx, node: graphs.get(v).gain } : null),
  };
})();
