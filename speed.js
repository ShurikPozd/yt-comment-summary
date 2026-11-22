"use strict";

// Скорость по каналам: расширение запоминает скорость, которую вы выбрали в
// видео канала (меню YouTube или Shift+> / Shift+<), и само ставит её, когда
// вы открываете другое видео этого канала: лекции — 1,5×, музыка — 1×.
//  - канал узнаём по id (UC…), а не по названию: его сообщает плеер
//    (speed-main.js, мир страницы);
//  - ваш выбор в текущем видео не перебиваем; прямые эфиры и рекламу не трогаем;
//  - у канала скорость не запомнена, а плеер держит перенесённую с прошлого
//    видео (YouTube переносит её сам) — возвращаем обычную 1×;
//  - Shorts не трогаем: у них свой плеер и своя привычная скорость, а скорость
//    лекций канала там обычно не нужна.
// Плашка поверх плеера: «Скорость 1,5× для канала «…» · Сбросить».
// Настройка — settings.channelSpeed (по умолчанию вкл.), скорости —
// chrome.storage.local.channelSpeeds (см. speed-core.js).
(() => {
  // Встроенный плеер (youtube.com/embed) — только внутри нашей «Моей библиотеки»;
  // встроенные видео на чужих сайтах расширение не трогает.
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
  const core = globalThis.__ytcsSpeedCore;
  if (!core || globalThis.__ytcsSpeed) return;
  const OUR_EMBED = location.pathname.startsWith("/embed/");

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };

  // ---------- Состояние ----------
  let enabled = true; // settings.channelSpeed
  let map = {}; // channelSpeeds
  let ready = false; // хранилище прочитано
  let vid = null; // открытое видео
  let carried = null; // скорость прошлого видео этой вкладки (её YouTube перенесёт)
  // по текущему видео: канал, ваш ли выбор, что поставили мы
  let cur = fresh(null);
  function fresh(id) {
    return { id, channelId: "", name: "", live: false, known: false, done: false, userChose: false, pending: null, target: null, appliedAt: 0, reapply: 0 };
  }

  // ---------- Плеер ----------
  const player = () => document.getElementById("movie_player");
  const mainVideo = () => player()?.querySelector("video.html5-main-video") || document.querySelector("video.html5-main-video");
  const adShowing = () => Boolean(player()?.classList.contains("ad-showing"));
  const isMain = (e) => e.target instanceof HTMLVideoElement && e.target.classList.contains("html5-main-video");

  function videoIdNow() {
    if (location.pathname === "/watch") return new URLSearchParams(location.search).get("v");
    if (OUR_EMBED) return location.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})/)?.[1] || null;
    return null; // Shorts и прочие страницы — без скорости по каналам
  }

  // Канал текущего видео — спрашиваем мир страницы (ответ приходит синхронно)
  function askInfo() {
    let info = null;
    const on = (e) => {
      try {
        info = JSON.parse(e.detail);
      } catch (err) {
        info = null;
      }
    };
    document.addEventListener("ytcs-speed:info", on);
    document.dispatchEvent(new CustomEvent("ytcs-speed:ask"));
    document.removeEventListener("ytcs-speed:info", on);
    return info;
  }

  // Ставим скорость: через плеер (меню YouTube покажет её), а если плеер не
  // принял — прямо элементу <video>. Свою смену потом не считаем вашей.
  let self = { rate: null, at: 0 };
  function setRate(rate) {
    const v = mainVideo();
    if (!v) return;
    self = { rate, at: Date.now() };
    document.dispatchEvent(new CustomEvent("ytcs-speed:set", { detail: String(rate) }));
    if (!core.same(v.playbackRate, rate)) v.playbackRate = rate;
  }

  // ---------- Хранилище ----------
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (alive()) void chrome.storage.local.set({ [core.storeKey]: map }).catch(() => {});
    }, 300);
  }

  // ---------- Новое видео: поставить скорость канала ----------
  function onNavigate() {
    const id = videoIdNow();
    if (id === vid) return;
    // Уходим с видео: его скорость YouTube перенесёт на следующее. Помним её,
    // только если её поставили мы или вы, — иначе это обычная скорость
    // YouTube, и её не трогаем. Эфир цепочку не рвёт.
    const v = mainVideo();
    if (vid && v && !cur.live) {
      if (cur.userChose || cur.target != null) carried = v.playbackRate;
      else if (carried != null && !core.same(v.playbackRate, carried)) carried = null;
    }
    vid = id;
    cur = fresh(id);
    hideNotice();
  }

  function tick() {
    if (!alive()) return;
    onNavigate();
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
      // вы успели поменять скорость, пока канал был неизвестен, — запоминаем
      if (cur.pending != null) {
        const r = cur.pending;
        cur.pending = null;
        rememberChoice(r);
      }
    }
    if (cur.done || !enabled) return;
    cur.done = true;
    if (!cur.channelId || cur.live) return;
    const entry = core.entryOf(map, cur.channelId);
    if (entry) {
      map = core.touch(map, cur.channelId, cur.name);
      save();
    }
    const step = core.plan({ enabled, stored: entry?.r, current: v.playbackRate, carried, userChose: cur.userChose, live: cur.live });
    if (!step) {
      if (entry && core.same(entry.r, v.playbackRate)) cur.target = entry.r;
      return;
    }
    cur.target = step.rate;
    cur.appliedAt = Date.now();
    setRate(step.rate);
    if (step.why === "channel") showNotice("applied");
  }

  // ---------- Ваш выбор скорости ----------
  // Сменой «от вас» считаем ту, что пришла сразу после щелчка в меню плеера или
  // Shift+> / Shift+<. Остальные — сам YouTube (новое видео, реклама) или
  // «удерживайте для 2×» — не запоминаем.
  let inputAt = 0;
  let holding = false;
  const MENU = ".ytp-settings-menu, .ytp-popup, .ytp-panel, [class*='ytp-speed'], [class*='ytp-variable-speed']";
  document.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target;
      if (t?.closest?.(".ytcs-btn")) hideNotice(); // открываете меню расширения — плашка не мешает
      if (t?.closest?.(MENU)) inputAt = Date.now();
      else if (t?.closest?.("#movie_player") && !t.closest(".ytp-chrome-bottom, .ytp-chrome-top")) holding = true;
    },
    true
  );
  document.addEventListener("click", (e) => e.target?.closest?.(MENU) && (inputAt = Date.now()), true);
  for (const t of ["pointerup", "pointercancel"]) document.addEventListener(t, () => (holding = false), true);
  document.addEventListener(
    "keydown",
    (e) => {
      const speedKey = e.key === ">" || e.key === "<" || (e.shiftKey && (e.code === "Period" || e.code === "Comma"));
      // в меню скорости стрелками и Enter
      if (speedKey || (e.target?.closest?.(MENU) && /^(Enter| |Arrow)/.test(e.key))) inputAt = Date.now();
    },
    true
  );

  document.addEventListener(
    "ratechange",
    (e) => {
      if (!isMain(e) || !alive()) return;
      const rate = e.target.playbackRate;
      const now = Date.now();
      if (self.rate != null && core.same(rate, self.rate) && now - self.at < 2500) return; // наша же смена
      if (now - inputAt > 1500 || adShowing()) {
        // Сразу после нашей смены YouTube иногда возвращает свою скорость —
        // ставим ещё раз (но не во время «удерживайте для 2×»)
        const t = cur.target;
        if (enabled && t != null && !cur.userChose && !holding && now - cur.appliedAt < 8000 && cur.reapply < 2 && !core.same(rate, t) && !adShowing()) {
          cur.reapply++;
          setRate(t);
        }
        return;
      }
      cur.userChose = true;
      cur.target = null;
      if (cur.live || !enabled) return;
      if (!cur.known) cur.pending = rate;
      else rememberChoice(rate);
    },
    true
  );

  // Запомнить вашу скорость для канала (с паузой: Shift+> часто жмут несколько раз)
  let chooseTimer = 0;
  let undo = null; // что было до вашей смены — для «Отменить»
  function rememberChoice(rate) {
    if (!cur.channelId || cur.live || !enabled) return;
    const r = core.cleanRate(rate);
    if (r == null) return;
    clearTimeout(chooseTimer);
    const ch = cur.channelId;
    const name = cur.name;
    chooseTimer = setTimeout(() => {
      if (cur.channelId !== ch) return;
      const prev = core.entryOf(map, ch);
      if (prev && core.same(prev.r, r)) return;
      undo = { ch, prev };
      map = core.remember(map, ch, r, name);
      save();
      showNotice("saved");
    }, 900);
  }

  async function reset() {
    const ch = cur.channelId;
    if (!ch) return false;
    map = core.forget(map, ch);
    save();
    cur.target = 1;
    cur.appliedAt = Date.now();
    cur.reapply = 0;
    carried = null;
    setRate(1);
    showNotice("reset");
    return true;
  }

  function undoChoice() {
    if (!undo) return;
    map = undo.prev ? { ...map, [undo.ch]: undo.prev } : core.forget(map, undo.ch);
    undo = null;
    save();
    showNotice("undone");
  }

  // ---------- Плашка поверх плеера (shadow DOM) ----------
  // Стиль — как у плашек расширения в плеере (.ytcs-toast в content.js и
  // «Пропущено: …» в sponsor.js): тёмная «таблетка» сверху по центру плеера.
  const ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.2 18.5a9 9 0 1 1 15.6 0"/><path d="M12 14.5l4.2-4.6"/><circle cx="12" cy="14.5" r="1.4"/><path d="M12 6.2v1.6M6.3 9l1.2 1M17.7 9l-1.2 1" opacity=".6"/></svg>';
  const NOTICE_CSS = `
    :host { all: initial; position: absolute; top: 16px; left: 16px; right: 16px; z-index: 81;
      display: flex; justify-content: center; pointer-events: none; }
    .n { display: flex; align-items: center; gap: 10px; min-width: 0; max-width: 100%; box-sizing: border-box; padding: 6px 6px 6px 14px;
      border-radius: 999px; background: rgba(28, 28, 30, .86);
      -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6);
      box-shadow: 0 8px 30px rgba(0, 0, 0, .4), inset 0 0 0 1px rgba(255, 255, 255, .07);
      color: #f1f1f1; font: 500 15px/1.3 "YouTube Noto", Roboto, Arial, sans-serif;
      opacity: 0; transform: translateY(-8px) scale(.97); transform-origin: 50% 0;
      transition: opacity .18s ease, transform .26s cubic-bezier(.22, 1, .36, 1); }
    .n.show { opacity: 1; transform: none; pointer-events: auto; }
    .n.plain { padding-right: 18px; min-height: 34px; }
    svg { flex: none; width: 20px; height: 20px; color: #ff6b85; }
    .txt { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      position: relative; top: -.06em; }
    b, .nm { white-space: nowrap; }
    b { font-weight: 700; }
    /* узкий плеер: текст не обрезается, а переносится — «таблетка» становится карточкой */
    .n.wrap { border-radius: 18px; padding-top: 8px; padding-bottom: 8px; }
    .n.wrap .txt { white-space: normal; overflow: visible; top: 0; }
    button { flex: none; height: 34px; padding: 0 16px 1px; border: 0; border-radius: 999px; font: inherit; font-weight: 600;
      background: rgba(255, 255, 255, .14); color: #fff; cursor: pointer; transition: background-color .12s ease; }
    button:hover, button:focus-visible { background: rgba(255, 255, 255, .24); outline: none; }
    button:active { background: rgba(255, 255, 255, .3); }
    button[hidden] { display: none; }
    @media (prefers-reduced-motion: reduce) { .n, button { transition: none; } }`;

  const notice = { host: null, root: null, kind: "", timer: 0, hover: false };

  // Длинное название — короче, чтобы плашка не закрывала плеер
  const short = (s, n = 36) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

  function noticeHost() {
    const p = player();
    if (!p) return null;
    if (!notice.host) {
      const host = document.createElement("div");
      host.id = "ytcs-speed-notice";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${NOTICE_CSS}</style>
        <div class="n" role="status" aria-live="polite">${ICON}<span class="txt"></span><button type="button"></button></div>`;
      // клики по плашке не должны ставить видео на паузу
      for (const t of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "keydown"]) {
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
    if (notice.host.parentElement !== p) p.appendChild(notice.host);
    return notice.host;
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
    const stored = core.entryOf(map, cur.channelId)?.r;
    const rate = core.fmtRate(kind === "saved" || kind === "undone" ? stored : (cur.target ?? mainVideo()?.playbackRate));
    const txt = r.querySelector(".txt");
    const btn = r.querySelector("button");
    const text = {
      applied: [`Скорость <b>${rate}</b> для канала ${nm}`, "Сбросить"],
      saved: [`Запомнено: <b>${rate}</b> для канала ${nm}`, "Отменить"],
      reset: [`Скорость канала ${nm} сброшена — <b>1×</b>`, ""],
      undone: [stored ? `Для канала ${nm} снова <b>${rate}</b>` : `Скорость канала ${nm} не запомнена`, ""],
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
    box.classList.remove("show");
    void box.offsetHeight; // перезапуск появления
    box.classList.add("show");
    armHide(text[1] ? 6000 : 2500);
  }

  function hideNotice() {
    clearTimeout(notice.timer);
    notice.root?.querySelector(".n")?.classList.remove("show");
    notice.kind = "";
    notice.hover = false;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ---------- Для меню кнопки расширения в плеере (content.js) ----------
  globalThis.__ytcsSpeed = {
    // запомненная скорость канала открытого видео — или null
    current() {
      if (!enabled || !cur.known || !cur.channelId) return null;
      const e = core.entryOf(map, cur.channelId);
      return e ? { channelId: cur.channelId, name: cur.name, rate: e.r, label: core.fmtRate(e.r) } : null;
    },
    reset,
  };

  // ---------- Подписки ----------
  // События <video> не всплывают, но ловятся на перехвате (capture) на document
  for (const t of ["loadedmetadata", "playing", "durationchange"]) {
    document.addEventListener(t, (e) => isMain(e) && tick(), true);
  }
  window.addEventListener("yt-navigate-finish", tick);
  window.addEventListener("popstate", tick);
  // после рекламы YouTube может вернуть свою скорость — ставим запомненную снова
  let adWas = false;
  setInterval(() => {
    if (!alive()) return;
    const ad = adShowing();
    if (adWas && !ad && enabled && cur.target != null && !cur.userChose) {
      const v = mainVideo();
      if (v && !core.same(v.playbackRate, cur.target)) {
        cur.appliedAt = Date.now();
        setRate(cur.target);
      }
    }
    adWas = ad;
    tick();
  }, 500);

  if (!alive()) return;
  chrome.storage.local
    .get(["settings", core.storeKey])
    .then((o) => {
      enabled = o.settings?.channelSpeed !== false;
      map = o[core.storeKey] && typeof o[core.storeKey] === "object" ? o[core.storeKey] : {};
      ready = true;
      tick();
    })
    .catch(() => {
      ready = true;
    });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) {
      enabled = changes.settings.newValue?.channelSpeed !== false;
      if (!enabled) hideNotice();
    }
    if (changes[core.storeKey]) map = changes[core.storeKey].newValue || {};
  });
  tick();
})();
