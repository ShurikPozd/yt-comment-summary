"use strict";

// «Двойные субтитры»: в иностранном видео под строкой оригинала — перевод
// (по умолчанию на русский) одной плашкой поверх плеера.
//  - Перевод — автоперевод самого YouTube (timedtext &tlang=…), без ИИ и лимитов.
//    Адрес с PO-токеном берём у плеера (dualsubs-main.js), разбор и сведение
//    строк — dualsubs-core.js.
//  - Плашка внутри #movie_player: едет вместе с ним в полноэкранный режим, театр
//    и мини-плеер; стоит над полосой прогресса (и когда панель плеера скрыта —
//    не прыгает). Субтитры самого YouTube на это время прячутся.
//  - Наведение на плашку — пауза, ушли — видео идёт дальше; клик по слову —
//    пауза, которая не снимается уходом мыши.
//  - Видео уже на языке перевода, нет субтитров, эфир, ошибка сети — тихо ничего.
// Настройки: settings.dualSubs (вкл/выкл, по умолчанию выкл.), settings.dualSubsLang.
// Клавиша Shift+C на странице видео — вкл/выкл.
(() => {
  if (globalThis.__ytcsDual || window.top !== window || location.pathname.startsWith("/embed/")) return;
  const core = globalThis.__ytcsDualCore;
  if (!core) return;

  const TICK_MS = 1000;
  const DEFAULT_LANG = core.DEFAULT_LANG;
  const PRIME_WAIT_MS = 6000; // столько ждём запроса плеера, прежде чем попросить снова
  const PRIME_TRIES = 4;

  let enabled = false;
  let target = DEFAULT_LANG;
  let tick = 0;
  // st.state: "plan" → "url" (ждём адрес с токеном) → "load" → "ready" | "skip" | "fail"
  let st = null;
  const cache = new Map(); // `${vid}|${lang}` → [{s, e, text, tr}]

  const player = () => document.getElementById("movie_player");
  const video = () => player()?.querySelector("video.html5-main-video") || player()?.querySelector("video") || null;
  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };

  function ask() {
    let info = null;
    const on = (e) => {
      try {
        info = JSON.parse(e.detail);
      } catch (err) {
        info = null;
      }
    };
    document.addEventListener("ytcs-ds:info", on, { once: true });
    document.dispatchEvent(new CustomEvent("ytcs-ds:ask"));
    document.removeEventListener("ytcs-ds:info", on);
    return info;
  }
  const toMain = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail: detail == null ? "" : JSON.stringify(detail) }));

  // ---------- субтитры YouTube прячем, пока показываем свои ----------
  function ensurePageStyle() {
    if (document.getElementById("ytcs-ds-style")) return;
    const s = document.createElement("style");
    s.id = "ytcs-ds-style";
    s.textContent = `#movie_player.ytcs-ds-on .ytp-caption-window-container, #movie_player.ytcs-ds-prime .ytp-caption-window-container { display: none !important; }`;
    (document.head || document.documentElement).appendChild(s);
  }
  function mark(cls, on) {
    const p = player();
    if (on) ensurePageStyle();
    p?.classList.toggle(cls, Boolean(on));
  }

  // ---------- плашка ----------
  const CSS = `
    :host { all: initial; position: absolute; left: 0; right: 0; bottom: var(--lift, 72px); z-index: 58;
      display: flex; justify-content: center; box-sizing: border-box; pointer-events: none;
      transition: bottom .22s cubic-bezier(0, 0, .2, 1); }
    .box { pointer-events: auto; box-sizing: border-box; max-width: min(88%, 32em); display: flex; flex-direction: column;
      align-items: center; gap: .16em; padding: .34em .75em; border-radius: .5em;
      background: rgba(10, 10, 12, .8); box-shadow: 0 6px 24px rgba(0, 0, 0, .35);
      font: 500 var(--fs, 24px)/1.3 "YouTube Noto", Roboto, Arial, sans-serif; color: #fff;
      text-align: center; text-wrap: pretty; overflow-wrap: anywhere; cursor: default;
      -webkit-font-smoothing: antialiased; }
    .box[hidden] { display: none; }
    .o, .t { display: block; max-width: 100%; }
    .t { font-size: .8em; font-weight: 500; color: #ffb3c1; }
    .t:empty { display: none; }
    .w { border-radius: .22em; cursor: pointer; transition: background-color .12s ease; }
    .w:hover { background: rgba(255, 255, 255, .18); }
    .w.on { background: #e8002d; color: #fff; }
    @media (prefers-reduced-motion: reduce) { :host, .w { transition: none; } }`;

  const ui = { host: null, box: null, o: null, t: null, idx: -2, hover: false, hoverPaused: false, locked: false, ro: null, mo: null, raf: 0, lift: 0 };

  function ensureUi() {
    const p = player();
    if (!p) return null;
    if (!ui.host) {
      const host = document.createElement("div");
      host.id = "ytcs-dualsubs";
      const root = host.attachShadow({ mode: "open" });
      // без innerHTML: на YouTube включены Trusted Types
      const style = document.createElement("style");
      style.textContent = CSS;
      const el = (tag, cls) => Object.assign(document.createElement(tag), { className: cls });
      ui.box = el("div", "box");
      ui.box.hidden = true;
      ui.o = el("span", "o");
      ui.t = el("span", "t");
      ui.box.append(ui.o, ui.t);
      root.append(style, ui.box);
      ui.host = host;
      // клики по плашке не должны ставить видео на паузу/запускать и разворачивать на весь экран
      for (const t of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"]) host.addEventListener(t, (e) => e.stopPropagation());
      ui.box.addEventListener("mouseenter", () => {
        ui.hover = true;
        const v = video();
        if (v && !v.paused && !v.ended) {
          v.pause();
          ui.hoverPaused = true;
        }
      });
      ui.box.addEventListener("mouseleave", () => {
        ui.hover = false;
        const v = video();
        if (ui.hoverPaused && !ui.locked && v?.paused) v.play().catch(() => {});
        ui.hoverPaused = false;
        layout();
      });
      ui.box.addEventListener("click", (e) => {
        const w = e.composedPath().find((n) => n.classList?.contains("w"));
        const v = video();
        if (v && !v.paused) v.pause();
        ui.locked = true; // уход мыши видео не запустит — только вы (пробел, K, клик по плееру)
        ui.hoverPaused = false;
        for (const n of ui.box.querySelectorAll(".w.on")) n.classList.remove("on");
        w?.classList.add("on");
      });
    }
    if (ui.host.parentElement !== p) {
      p.appendChild(ui.host);
      ui.ro?.disconnect();
      ui.ro = new ResizeObserver(() => layout());
      ui.ro.observe(p);
      ui.mo?.disconnect();
      ui.mo = new MutationObserver(() => layout()); // панель плеера показалась/скрылась, реклама
      ui.mo.observe(p, { attributes: true, attributeFilter: ["class"] });
    }
    return ui.host;
  }

  function dropUi() {
    cancelAnimationFrame(ui.raf);
    ui.raf = 0;
    ui.ro?.disconnect();
    ui.mo?.disconnect();
    ui.ro = ui.mo = null;
    ui.host?.remove();
    ui.host = ui.box = ui.o = ui.t = null;
    ui.idx = -2;
    ui.hover = ui.hoverPaused = ui.locked = false;
  }

  // Где стоять: всегда над полосой прогресса и кнопками плеера — и когда панель
  // видна, и когда скрыта (скрытая панель YouTube всё равно ловит мышь, и плашка
  // под ней не наводилась бы; а прыжки вверх-вниз мешают читать). Сообщение о
  // пропуске рекламы (sponsor.js) — слева снизу: если мешает, поднимаемся над ним.
  // Пока мышь на плашке — не двигаемся.
  function layout() {
    const p = player();
    if (!ui.host || !p) return;
    const h = p.clientHeight || 0;
    ui.host.style.setProperty("--fs", core.fontPx(h) + "px");
    if (p.classList.contains("ad-showing")) ui.box.hidden = true;
    if (ui.hover) return;
    const pr = p.getBoundingClientRect();
    let lift = Math.max(12, Math.round(h * 0.04));
    let top = Infinity;
    for (const sel of [".ytp-progress-bar-container", ".ytp-chrome-bottom"]) {
      const r = p.querySelector(sel)?.getBoundingClientRect();
      if (r && r.height > 0 && r.top > pr.top) top = Math.min(top, r.top);
    }
    if (Number.isFinite(top)) lift = Math.max(lift, Math.round(pr.bottom - top + 10));
    const sb = document.getElementById("ytcs-sb-notice");
    const n = sb?.shadowRoot?.querySelector(".n.show");
    if (n && !ui.box.hidden) {
      const nr = n.getBoundingClientRect();
      const br = ui.box.getBoundingClientRect();
      if (nr.width && nr.right > br.left - 8 && nr.bottom > pr.bottom - lift - br.height - 8) lift = Math.round(pr.bottom - nr.top + 8);
    }
    if (lift !== ui.lift) {
      ui.lift = lift;
      ui.host.style.setProperty("--lift", lift + "px");
    }
  }

  function fill(el, text, lang) {
    el.textContent = "";
    el.lang = lang || "";
    for (const { w, sp } of core.words(text)) {
      const s = document.createElement("span");
      s.className = "w";
      s.textContent = w;
      el.append(s, sp);
    }
  }

  function render(force) {
    if (!ui.box || st?.state !== "ready") return;
    const v = video();
    const p = player();
    const ad = p?.classList.contains("ad-showing");
    const idx = v && !ad ? core.indexAt(st.cues, v.currentTime * 1000) : -1;
    if (idx === ui.idx && !force) return;
    if (ui.hover && idx === -1) return; // мышь на плашке — не убираем её из-под мыши
    ui.idx = idx;
    const c = st.cues[idx];
    if (!c) {
      ui.box.hidden = true;
      return;
    }
    fill(ui.o, c.text, st.plan.src.lang);
    fill(ui.t, c.tr, st.plan.tr.tlang || st.plan.tr.lang);
    ui.box.hidden = false;
    layout(); // высота плашки меняется со строкой — сверяем положение
  }

  function loop() {
    ui.raf = 0;
    render();
    const v = video();
    if (v && !v.paused && st?.state === "ready") ui.raf = requestAnimationFrame(loop);
  }
  const kick = () => {
    if (!ui.raf && st?.state === "ready") ui.raf = requestAnimationFrame(loop);
  };

  // события видео: перемотка, пауза, скорость — просто другое время
  let boundVideo = null;
  const onVideo = (e) => {
    if (e.type === "play") {
      ui.locked = false;
      for (const n of ui.box?.querySelectorAll(".w.on") || []) n.classList.remove("on");
    }
    render(e.type === "seeked");
    kick();
  };
  function bindVideo() {
    const v = video();
    if (v === boundVideo) return;
    for (const t of ["play", "playing", "pause", "seeked", "timeupdate", "ratechange"]) {
      boundVideo?.removeEventListener(t, onVideo);
      v?.addEventListener(t, onVideo);
    }
    boundVideo = v;
  }

  // ---------- загрузка ----------
  async function getJson(url) {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error("timedtext:" + r.status);
    const t = await r.text();
    if (!t.trim()) throw new Error("timedtext:empty");
    return JSON.parse(t);
  }

  async function load(s) {
    const key = `${s.vid}|${target}`;
    try {
      let cues = cache.get(key);
      if (!cues) {
        const orig = core.parseJson3(await getJson(core.trackUrl(s.url, s.plan.src)));
        if (!orig.length) throw new Error("empty");
        let trans = [];
        for (let i = 0; i < 2 && !trans.length; i++) {
          try {
            trans = core.parseJson3(await getJson(core.trackUrl(s.url, s.plan.tr)));
          } catch (e) {
            if (i === 0) await new Promise((r) => setTimeout(r, 2500));
          }
          if (st !== s) return;
        }
        cues = core.pairCues(orig, trans);
        cache.set(key, cues);
        if (cache.size > 8) cache.delete(cache.keys().next().value);
      }
      if (st !== s) return;
      s.cues = cues;
      s.state = "ready";
      mark("ytcs-ds-on", true);
      ensureUi();
      layout();
      render(true);
      kick();
    } catch (e) {
      if (st === s) s.state = "fail"; // тихо: без субтитров видео смотрится как обычно
    } finally {
      if (s.primed) {
        s.primed = false;
        toMain("ytcs-ds:restore");
      }
      if (st === s) mark("ytcs-ds-prime", false);
    }
  }

  function reset() {
    if (st?.primed) toMain("ytcs-ds:restore");
    st = null;
    mark("ytcs-ds-on", false);
    mark("ytcs-ds-prime", false);
    if (ui.box) {
      ui.box.hidden = true;
      ui.idx = -2;
    }
  }

  function step() {
    if (!enabled) return;
    const info = ask();
    bindVideo();
    if (!info?.vid) return;
    if (!st || st.vid !== info.vid || st.lang !== target) {
      reset();
      st = { vid: info.vid, lang: target, state: "plan", plan: null, url: "", cues: null, primed: false, tries: 0, primedAt: 0 };
    }
    const s = st;
    if (s.state === "plan") {
      if (info.live) {
        s.state = "skip";
        return;
      }
      const plan = core.pickTracks(info, target);
      // список дорожек приходит с данными плеера; пусто в первые секунды — подождём
      if (plan.skip === "none" && ++s.tries < 5) return;
      s.tries = 0;
      if (plan.skip) {
        s.state = "skip";
        return;
      }
      s.plan = plan;
      s.state = cache.has(`${s.vid}|${target}`) ? "load" : "url";
      if (s.state === "load") void load(s);
    }
    if (s.state === "url") {
      if (info.url) {
        s.url = info.url;
        s.state = "load";
        void load(s);
        return;
      }
      // плеер запрашивает субтитры, только когда видео идёт (или готово идти)
      const v = video();
      if (!v || v.readyState < 2) return;
      if (s.primedAt && Date.now() - s.primedAt < PRIME_WAIT_MS) return;
      if (s.tries >= PRIME_TRIES) {
        s.state = "fail";
        if (s.primed) toMain("ytcs-ds:restore");
        s.primed = false;
        mark("ytcs-ds-prime", false);
        return;
      }
      s.tries++;
      s.primed = true;
      s.primedAt = Date.now();
      mark("ytcs-ds-prime", true);
      toMain("ytcs-ds:prime", { lang: s.plan.src.lang, kind: s.plan.src.kind });
    }
    if (s.state === "ready") {
      ensureUi();
      layout();
      render();
    }
  }

  function setEnabled(on, lang) {
    const nextLang = core.langOf(lang);
    const changed = on !== enabled || nextLang !== target;
    enabled = on;
    target = nextLang;
    if (!changed) return;
    clearInterval(tick);
    tick = 0;
    reset();
    if (!enabled) {
      dropUi();
      return;
    }
    tick = setInterval(() => {
      if (!alive()) {
        clearInterval(tick);
        reset();
        dropUi();
        return;
      }
      step();
    }, TICK_MS);
    step();
  }

  // плеер запросил субтитры — не ждём следующего такта
  document.addEventListener("ytcs-ds:url", () => {
    if (enabled && st?.state === "url") step();
  });
  window.addEventListener("yt-navigate-finish", () => enabled && setTimeout(step, 300));

  // Shift+C — вкл/выкл (на любой раскладке: по коду клавиши). Обычная C у YouTube —
  // его субтитры; Shift+C до него не доходит.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code !== "KeyC" || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      const t = e.composedPath()[0];
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return; // печатаете — не мешаем
      if (!player() || !alive()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      chrome.storage.local
        .get("settings")
        .then(({ settings }) => {
          const s = settings || {};
          s.dualSubs = !s.dualSubs;
          return chrome.storage.local.set({ settings: s }); // плашку «включены/выключены» покажет content.js
        })
        .catch(() => {});
    },
    true
  );

  chrome.storage.local
    .get("settings")
    .then((o) => setEnabled(Boolean(o.settings?.dualSubs), o.settings?.dualSubsLang))
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) setEnabled(Boolean(changes.settings.newValue?.dualSubs), changes.settings.newValue?.dualSubsLang);
  });

  globalThis.__ytcsDual = {
    status: () => ({ enabled, target, state: st?.state || "off", vid: st?.vid || "", cues: st?.cues?.length || 0, plan: st?.plan || null }),
  };
})();
