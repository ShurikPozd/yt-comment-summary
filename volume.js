"use strict";

// Громкость по каналам: расширение запоминает громкость, которую вы выбрали в
// видео канала (ползунок YouTube, стрелки ↑ / ↓, колесо над громкостью плеера,
// кнопки − / + в меню расширения), и само ставит её в следующих видео канала:
// тихий подкаст — 150 %, громкая музыка — 40 %.
//  - до 100 % — ползунок YouTube; громче — ползунок на 100 % и усиление звука
//    через общий аудиограф (audio-graph.js), до 300 %;
//  - канал узнаём по id (UC…) у мира страницы (speed-main.js), громкость ползунка —
//    у volume-main.js;
//  - у канала громкость не запомнена, а плеер держит громкость прошлого канала
//    (YouTube переносит её сам) — возвращаем вашу обычную громкость;
//  - ваш выбор в текущем видео не перебиваем; рекламу, эфиры и Shorts не трогаем;
//  - «Выравнивать громкость» (settings.volumeLeveler, выкл.): тихие места громче,
//    громкие тише — компрессор в том же графе.
// Плашка поверх плеера: «Громкость 150 % для канала «…» · Сбросить».
// Настройки — settings.channelVolume (по умолчанию вкл.) и settings.volumeLeveler;
// громкости — chrome.storage.local.channelVolumes (см. volume-core.js).
(() => {
  // Встроенный плеер (youtube.com/embed) — только внутри нашей «Моей библиотеки»
  if (location.pathname.startsWith("/embed/")) {
    let ours = false;
    try {
      ours = location.ancestorOrigins?.[0] === `chrome-extension://${chrome.runtime.id}`;
    } catch (e) {
      ours = false;
    }
    if (!ours) return;
  } else if (window.top !== window) {
    return; // прочие фреймы YouTube (чат трансляции и т. п.) — не наше
  }
  const core = globalThis.__ytcsVolumeCore;
  if (!core || globalThis.__ytcsVolume) return;
  const OUR_EMBED = location.pathname.startsWith("/embed/");
  const audio = () => globalThis.__ytcsAudio;

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };

  // ---------- Состояние ----------
  let enabled = true; // settings.channelVolume
  let level = false; // settings.volumeLeveler
  let map = {}; // channelVolumes
  let ready = false; // хранилище прочитано
  // обычная громкость и перенесённая громкость канала; у встроенного плеера библиотеки
  // своё хранилище YouTube (своя громкость) — и состояние своё
  const STATE_KEY = core.stateKey + (OUR_EMBED ? "Embed" : "");
  let vstate = { normal: null, ours: null };
  let vid = null; // открытое видео
  let gainNow = 1; // усиление, которое нужно основному видео (1 — без усиления)
  let lastSlider = null; // последняя увиденная громкость ползунка
  let cur = fresh(null);
  function fresh(id) {
    return { id, channelId: "", name: "", live: false, known: false, done: false, userChose: false, pending: null, target: null, appliedAt: 0, reapply: 0 };
  }

  // ---------- Плеер ----------
  const player = () => document.getElementById("movie_player");
  // только плеер видео (#movie_player): у Shorts свой плеер — его не трогаем
  const mainVideo = () => player()?.querySelector("video.html5-main-video") || null;
  const adShowing = () => Boolean(player()?.classList.contains("ad-showing"));
  const isMain = (e) => e.target instanceof HTMLVideoElement && e.target === mainVideo();

  function videoIdNow() {
    if (location.pathname === "/watch") return new URLSearchParams(location.search).get("v");
    if (OUR_EMBED) return location.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})/)?.[1] || null;
    return null; // Shorts и прочие страницы — не трогаем
  }

  // Вопрос миру страницы: ответ приходит синхронно, пока мы ещё в dispatchEvent
  function ask(q, a) {
    let got = null;
    const on = (e) => {
      try {
        got = JSON.parse(e.detail);
      } catch (err) {
        got = null;
      }
    };
    document.addEventListener(a, on);
    document.dispatchEvent(new CustomEvent(q));
    document.removeEventListener(a, on);
    return got;
  }
  const askInfo = () => ask("ytcs-speed:ask", "ytcs-speed:info"); // канал, эфир (speed-main.js)
  const askVol = () => ask("ytcs-vol:ask", "ytcs-vol:info"); // { volume, muted } (volume-main.js)

  // Громкость сейчас: ползунок × наше усиление
  function totalNow() {
    const s = askVol()?.volume;
    return s == null ? null : core.total(s, gainNow);
  }

  // Усиление и выравнивание — в общий граф (на рекламе — как есть, без них)
  let audioState = "ok";
  function syncAudio() {
    const v = mainVideo();
    const a = audio();
    if (!v || !a || !videoIdNow()) return; // Shorts и прочие страницы — звук как есть
    audioState = adShowing() ? a.want(v, { gain: 1, level: false }) : a.want(v, { gain: gainNow, level });
  }

  // Ставим громкость: ползунок — через плеер (YouTube покажет и запомнит её),
  // выше 100 % — усиление. Свою смену потом не считаем вашей.
  let self = { slider: null, at: 0 };
  function applyVol(p) {
    const { slider, gain } = core.split(p);
    self = { slider, at: Date.now() };
    gainNow = gain;
    const s = askVol()?.volume;
    if (s == null || !core.same(s, slider)) document.dispatchEvent(new CustomEvent("ytcs-vol:set", { detail: String(slider) }));
    lastSlider = slider;
    syncAudio();
  }

  // ---------- Хранилище ----------
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (alive()) void chrome.storage.local.set({ [core.storeKey]: map }).catch(() => {});
    }, 300);
  }
  let stateTimer = 0;
  function saveState() {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
      if (alive()) void chrome.storage.local.set({ [STATE_KEY]: { ...vstate } }).catch(() => {});
    }, 300);
  }

  // ---------- Новое видео: поставить громкость канала ----------
  function onNavigate() {
    const id = videoIdNow();
    if (id === vid) return;
    vid = id;
    cur = fresh(id);
    hideNotice();
  }

  function tick() {
    if (!alive()) return;
    onNavigate();
    syncAudio();
    if (!vid || !ready) return;
    const v = mainVideo();
    if (!v || adShowing()) return;
    if (!cur.known) {
      const info = askInfo();
      if (!info || info.videoId !== vid) return; // плеер ещё на прошлом видео
      cur.known = true;
      cur.channelId = core.isChannelId(info.channelId) ? info.channelId : "";
      cur.name = String(info.name || "").trim();
      cur.live = Boolean(info.live);
      // вы успели поменять громкость, пока канал был неизвестен, — запоминаем
      if (cur.pending != null) {
        const p = cur.pending;
        cur.pending = null;
        rememberChoice(p);
      }
    }
    if (cur.done) return;
    const vi = askVol();
    if (!vi) return; // плеер ещё не готов
    cur.done = true;
    if (lastSlider == null) lastSlider = vi.volume;
    // Выключено, эфир, видео без канала: громкость не трогаем, но наше усиление
    // с прошлого видео не переносим (громкость канала 150 % не «переезжает»)
    if (!enabled || cur.userChose || cur.live || !cur.channelId) {
      // (ползунок остаётся на 100 — по нему следующее видео узнает перенесённую громкость канала)
      if (gainNow > 1 && !cur.userChose) {
        gainNow = 1;
        syncAudio();
      }
      return;
    }
    const entry = core.entryOf(map, cur.channelId);
    if (entry) {
      map = core.touch(map, cur.channelId, cur.name);
      save();
    }
    const current = core.total(vi.volume, gainNow);
    const step = core.plan({ enabled, stored: entry?.v, current, normal: vstate.normal, ours: vstate.ours, userChose: cur.userChose, live: cur.live });
    if (!step) {
      if (entry) {
        cur.target = entry.v;
        if (vstate.ours !== entry.v) {
          vstate.ours = entry.v;
          saveState();
        }
      } else {
        const next = core.observe(vstate, current); // громкость сейчас — ваша обычная
        if (next.normal !== vstate.normal || next.ours !== vstate.ours) {
          vstate = next;
          saveState();
        }
      }
      return;
    }
    // громкость до нашей смены — ваша обычная (если это не перенесённая громкость канала)
    if (step.why === "channel") vstate = { ...core.observe(vstate, current) };
    cur.target = step.vol;
    cur.appliedAt = Date.now();
    applyVol(step.vol);
    vstate.ours = step.why === "channel" ? step.vol : null;
    saveState();
    if (step.why === "channel") showNotice("applied");
  }

  // ---------- Ваш выбор громкости ----------
  // Сменой «от вас» считаем ту, что пришла во время или сразу после щелчка по
  // громкости плеера или нажатия ↑ / ↓. Остальные (сам YouTube, затухание таймера
  // сна, «без звука») не запоминаем.
  const VOL_UI = ".ytp-volume-area, .ytp-volume-panel, .ytp-volume-slider, .ytp-mute-button";
  let inputAt = 0;
  let dragging = false;
  document.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target;
      if (t?.closest?.(".ytcs-btn")) hideNotice(); // открываете меню расширения — плашка не мешает
      if (t?.closest?.(VOL_UI)) {
        inputAt = Date.now();
        dragging = true;
      }
    },
    true
  );
  for (const t of ["pointerup", "pointercancel"]) {
    document.addEventListener(
      t,
      () => {
        if (dragging) inputAt = Date.now();
        dragging = false;
      },
      true
    );
  }
  function typing(e) {
    const t = e.composedPath?.()[0] || e.target;
    return Boolean(t?.isContentEditable || /^(input|textarea|select)$/i.test(t?.tagName || ""));
  }
  document.addEventListener(
    "keydown",
    (e) => {
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !typing(e)) inputAt = Date.now();
      else if (e.target?.closest?.(VOL_UI) && /^Arrow/.test(e.key)) inputAt = Date.now(); // ползунок в фокусе
    },
    true
  );
  // Колесо над громкостью плеера: ±5 %, выше 100 % — усиление (до 300 %)
  document.addEventListener(
    "wheel",
    (e) => {
      if (!e.target?.closest?.(VOL_UI) || !e.target.closest("#movie_player") || e.ctrlKey || !e.deltaY) return;
      const v = mainVideo();
      if (!v || adShowing() || !alive()) return;
      const now = totalNow();
      if (now == null) return;
      e.preventDefault(); // страница не прокручивается
      e.stopPropagation();
      userVol(core.step(now, e.deltaY < 0 ? 1 : -1, core.wheel));
    },
    { capture: true, passive: false }
  );

  // Громкость, выбранная вами кнопками − / + в меню расширения или колесом:
  // ставим и считаем вашим выбором — для канала она запомнится, как с ползунка
  function userVol(p) {
    const n = core.cleanVol(p);
    if (n == null || !mainVideo()) return;
    inputAt = Date.now();
    applyVol(n);
    cur.userChose = true;
    cur.target = null;
    showNotice("vol");
    if (cur.live || !enabled) return;
    if (!cur.known) cur.pending = n;
    else rememberChoice(n);
  }

  document.addEventListener(
    "volumechange",
    (e) => {
      if (!isMain(e) || !alive() || !vid) return;
      const vi = askVol();
      if (!vi) return;
      const s = vi.volume;
      const now = Date.now();
      if (self.slider != null && core.same(s, self.slider) && now - self.at < 2500) return; // наша же смена
      if (lastSlider != null && core.same(s, lastSlider)) return; // «без звука», затухание, громкость самого YouTube
      lastSlider = s;
      if ((!dragging && now - inputAt > 1500) || adShowing()) {
        // Сразу после нашей смены YouTube иногда возвращает свою громкость — ставим ещё раз
        const t = cur.target;
        if (enabled && t != null && !cur.userChose && now - cur.appliedAt < 8000 && cur.reapply < 2 && !core.same(core.total(s, gainNow), t) && !adShowing()) {
          cur.reapply++;
          applyVol(t);
        }
        return;
      }
      // вы двигаете ползунок — громкость ровно та, что на нём (без нашего усиления)
      gainNow = 1;
      syncAudio();
      cur.userChose = true;
      cur.target = null;
      if (cur.live || !enabled) return;
      if (!cur.known) cur.pending = s;
      else rememberChoice(s);
    },
    true
  );

  // Запомнить вашу громкость для канала (с паузой: ползунок тянут, ↑ жмут несколько раз)
  let chooseTimer = 0;
  let undo = null; // что было до вашей смены — для «Отменить»
  function rememberChoice(p) {
    if (cur.live || !enabled) return;
    const n = core.cleanVol(p);
    if (n == null) return;
    clearTimeout(chooseTimer);
    const ch = cur.channelId;
    const name = cur.name;
    const id = cur.id;
    chooseTimer = setTimeout(() => {
      if (cur.id !== id) return;
      // видео без канала: это просто ваша обычная громкость
      if (!ch) {
        vstate = { normal: n, ours: null };
        saveState();
        return;
      }
      const prev = core.entryOf(map, ch);
      vstate.ours = n;
      saveState();
      if (prev && core.same(prev.v, n)) return;
      undo = { ch, prev };
      map = core.remember(map, ch, n, name);
      save();
      showNotice("saved");
    }, 900);
  }

  // «Сбросить»: канал забыт, громкость — ваша обычная
  async function reset() {
    const ch = cur.channelId;
    if (!ch) return false;
    map = core.forget(map, ch);
    save();
    const n = vstate.normal ?? 100;
    cur.target = n;
    cur.appliedAt = Date.now();
    cur.reapply = 0;
    applyVol(n);
    vstate.ours = null;
    saveState();
    showNotice("reset");
    return true;
  }

  // «Отменить»: канал громкость не запоминает (у него снова прежняя или никакой), а
  // сама громкость остаётся — только для этого видео: следующее видео канала без своей
  // громкости снова пойдёт с вашей обычной (YouTube не запоминает громкость, поставленную
  // расширением, поэтому «обычной» её не делаем — после перезагрузки она бы потерялась)
  function undoChoice() {
    if (!undo) return;
    map = undo.prev ? { ...map, [undo.ch]: undo.prev } : core.forget(map, undo.ch);
    const t = totalNow();
    if (t != null) {
      vstate.ours = t; // не «переедет» на следующее видео
      saveState();
    }
    undo = null;
    save();
    showNotice("undone");
  }

  // ---------- Плашка поверх плеера (shadow DOM) ----------
  // Стиль — как у плашки скорости по каналам (speed.js) и прочих плашек расширения
  // в плеере: тёмная «таблетка» сверху по центру. Если там уже есть плашка скорости,
  // «Вы остановились…» или таймера сна — встаём под неё.
  const ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path d="M18.2 6.6a7.6 7.6 0 0 1 0 10.8"/></svg>';
  const NOTICE_CSS = `
    :host { all: initial; position: absolute; top: 16px; left: 16px; right: 16px; z-index: 81;
      display: flex; justify-content: center; pointer-events: none; transition: top .2s ease; }
    .n { display: flex; align-items: center; gap: 10px; min-width: 0; max-width: 100%; box-sizing: border-box; padding: 7px 7px 7px 16px;
      border-radius: 999px; background: rgba(28, 28, 30, .9);
      -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6);
      box-shadow: 0 8px 30px rgba(0, 0, 0, .4), inset 0 0 0 1px rgba(255, 255, 255, .07);
      color: #f1f1f1; font: 500 16px/1.3 "YouTube Noto", Roboto, Arial, sans-serif;
      opacity: 0; transform: translateY(-8px) scale(.97); transform-origin: 50% 0;
      transition: opacity .18s ease, transform .26s cubic-bezier(.22, 1, .36, 1); }
    .n.show { opacity: 1; transform: none; pointer-events: auto; }
    .n.plain { padding-right: 18px; min-height: 34px; }
    svg { flex: none; width: 20px; height: 20px; color: #ff6b85; }
    .txt { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    b, .nm { white-space: nowrap; }
    b { font-weight: 700; font-variant-numeric: tabular-nums; }
    /* узкий плеер: текст не обрезается, а переносится — «таблетка» становится карточкой */
    .n.wrap { border-radius: 18px; padding-top: 8px; padding-bottom: 8px; }
    .n.wrap .txt { white-space: normal; overflow: visible; }
    button { flex: none; height: 34px; padding: 2px 16px 0; border: 0; border-radius: 999px; font: inherit; font-weight: 600;
      background: rgba(255, 255, 255, .14); color: #fff; cursor: pointer; transition: background-color .12s ease; }
    button:hover, button:focus-visible { background: rgba(255, 255, 255, .24); outline: none; }
    button:active { background: rgba(255, 255, 255, .3); }
    button[hidden] { display: none; }
    /* большие экраны (2K/4K) — плашка крупнее, как остальные плашки расширения */
    @media (min-width: 1600px) { .n { zoom: 1.15; } }
    @media (min-width: 2200px) { .n { zoom: 1.35; } }
    @media (prefers-reduced-motion: reduce) { :host, .n, button { transition: none; } }`;

  const notice = { host: null, root: null, kind: "", timer: 0, hover: false, place: 0 };

  // Длинное название — короче, чтобы плашка не закрывала плеер
  const short = (s, n = 36) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function noticeHost() {
    const p = player();
    if (!p) return null;
    if (!notice.host) {
      const host = document.createElement("div");
      host.id = "ytcs-volume-notice";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${NOTICE_CSS}</style>
        <div class="n" role="status" aria-live="polite">${ICON}<span class="txt"></span><button type="button"></button></div>`;
      // клики по плашке не должны ставить видео на паузу
      for (const t of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "keydown", "wheel"]) {
        host.addEventListener(t, (e) => e.stopPropagation());
      }
      root.querySelector("button").addEventListener("click", () => {
        if (notice.kind === "applied") void reset();
        else if (notice.kind === "saved") undoChoice();
        else hideNotice();
      });
      const box = root.querySelector(".n");
      box.addEventListener("mouseenter", () => {
        notice.hover = true;
        clearTimeout(notice.timer);
      });
      box.addEventListener("mouseleave", () => {
        notice.hover = false;
        armHide(2500);
      });
      notice.host = host;
      notice.root = root;
    }
    // в новом встроенном плеере — слой над его панелью управления (content.js), иначе «Вернуть»/«Сбросить» не нажать
    const into = globalThis.__ytcsPlayerLayer?.(p) || p;
    if (notice.host.parentElement !== into) into.appendChild(notice.host);
    return notice.host;
  }

  // Под другими плашками сверху плеера (скорость по каналам, «Вы остановились…», таймер сна)
  const OTHERS = ["ytcs-speed-notice", "ytcs-resume-offer", "ytcs-sleep-notice"];
  function place() {
    const host = notice.host;
    const p = host?.parentElement;
    if (!p) return;
    const top = p.getBoundingClientRect().top;
    let below = 0;
    for (const id of OTHERS) {
      const h = document.getElementById(id);
      const box = h?.parentElement === p ? h.shadowRoot?.querySelector(".show") : null;
      if (!box) continue;
      const r = box.getBoundingClientRect();
      if (r.height) below = Math.max(below, r.bottom - top);
    }
    const want = below ? `${Math.round(below + 8)}px` : "";
    if (host.style.top !== want) host.style.top = want;
  }

  function armHide(ms) {
    clearTimeout(notice.timer);
    if (!notice.hover) notice.timer = setTimeout(hideNotice, ms);
  }

  function showNotice(kind) {
    if (!noticeHost()) return;
    const r = notice.root;
    const name = cur.name ? `«${short(cur.name)}»` : "";
    // короткое название при переносе строк не разрываем
    const nm = name.length <= 26 ? `<span class="nm">${esc(name)}</span>` : esc(name);
    const stored = core.entryOf(map, cur.channelId)?.v;
    const vol = core.fmtVol(kind === "saved" || kind === "undone" ? stored : (cur.target ?? totalNow()));
    const txt = r.querySelector(".txt");
    const btn = r.querySelector("button");
    const text = {
      applied: [`Громкость <b>${vol}</b> для канала ${nm}`, "Сбросить"],
      saved: [`Запомнено: <b>${vol}</b> для канала ${nm}`, "Отменить"],
      reset: [`Громкость канала ${nm} сброшена — <b>${vol}</b>`, ""],
      undone: [stored ? `Для канала ${nm} снова <b>${vol}</b>` : `Громкость канала ${nm} не запомнена`, ""],
      vol: [`Громкость <b>${core.fmtVol(totalNow())}</b>`, ""],
    }[kind];
    txt.innerHTML = text[0];
    btn.textContent = text[1];
    btn.hidden = !text[1];
    notice.kind = kind;
    const box = r.querySelector(".n");
    box.classList.toggle("plain", !text[1]);
    box.classList.remove("wrap");
    if (txt.scrollWidth > txt.clientWidth + 1) box.classList.add("wrap");
    box.title = cur.name && cur.name.length > 36 ? cur.name : "";
    // «Громкость 150 %» при каждом шаге колеса — без мигания, просто новое число
    const again = kind === "vol" && box.classList.contains("show") && notice.shown === "vol";
    if (!again) {
      box.classList.remove("show");
      void box.offsetHeight; // перезапуск появления
    }
    box.classList.add("show");
    notice.shown = kind;
    place();
    clearInterval(notice.place);
    notice.place = setInterval(place, 250); // другая плашка появилась или ушла — подвинуться
    armHide(text[1] ? 6000 : 2500);
  }

  function hideNotice() {
    clearTimeout(notice.timer);
    clearInterval(notice.place);
    notice.root?.querySelector(".n")?.classList.remove("show");
    notice.kind = "";
    notice.shown = "";
    notice.hover = false;
  }

  // ---------- Для меню кнопки расширения в плеере (content.js) ----------
  globalThis.__ytcsVolume = {
    // запомненная громкость канала открытого видео — или null
    current() {
      if (!enabled || !cur.known || !cur.channelId) return null;
      const e = core.entryOf(map, cur.channelId);
      return e ? { channelId: cur.channelId, name: cur.name, vol: e.v, label: core.fmtVol(e.v), normal: core.fmtVol(vstate.normal ?? 100) } : null;
    },
    reset,
    // громкость открытого видео (ползунок × усиление) и шаг − / + (меню расширения)
    vol: () => totalNow() ?? 100,
    label: () => core.fmtVol(totalNow() ?? 100),
    step(dir) {
      const now = totalNow();
      if (now == null) return;
      userVol(core.step(now, dir));
    },
    // для проверок: усиление и состояние графа
    debug: () => ({ gainNow, audioState, vstate: { ...vstate }, cur: { ...cur }, graph: audio()?.status?.(mainVideo()) }),
  };

  // ---------- Подписки ----------
  // События <video> не всплывают, но ловятся на перехвате (capture) на document
  for (const t of ["loadedmetadata", "playing", "durationchange"]) {
    document.addEventListener(t, (e) => isMain(e) && tick(), true);
  }
  window.addEventListener("yt-navigate-finish", tick);
  window.addEventListener("popstate", tick);
  // после рекламы YouTube может вернуть свою громкость — ставим запомненную снова
  let adWas = false;
  setInterval(() => {
    if (!alive()) return;
    const ad = adShowing();
    if (adWas && !ad && enabled && cur.target != null && !cur.userChose) {
      const now = totalNow();
      if (now != null && !core.same(now, cur.target)) {
        cur.appliedAt = Date.now();
        applyVol(cur.target);
      }
    }
    adWas = ad;
    tick();
  }, 500);

  if (!alive()) return;
  chrome.storage.local
    .get(["settings", core.storeKey, STATE_KEY])
    .then((o) => {
      enabled = o.settings?.channelVolume !== false;
      level = o.settings?.volumeLeveler === true;
      map = o[core.storeKey] && typeof o[core.storeKey] === "object" ? o[core.storeKey] : {};
      vstate = core.cleanState(o[STATE_KEY]);
      ready = true;
      tick();
    })
    .catch(() => {
      ready = true;
    });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) {
      const s = changes.settings.newValue;
      const was = enabled;
      enabled = s?.channelVolume !== false;
      level = s?.volumeLeveler === true;
      if (!enabled) hideNotice();
      // выключили — усиление больше не держим, громкость — как на ползунке
      if (was && !enabled && gainNow > 1) gainNow = 1;
      syncAudio();
    }
    if (changes[core.storeKey]) map = changes[core.storeKey].newValue || {};
    // другая вкладка поменяла обычную громкость
    if (changes[STATE_KEY]) vstate = core.cleanState(changes[STATE_KEY].newValue);
  });
  tick();
})();
