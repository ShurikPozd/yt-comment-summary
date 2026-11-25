"use strict";

// Снимок кадра в плеере YouTube (и во встроенном плеере «Моей библиотеки»):
//  - клавиша Shift+S или «Снимок кадра» в меню кнопки расширения (раздел «Видео и превью»,
//    во встроенном плеере — первый экран меню);
//  - текущий кадр в том разрешении, в котором YouTube его сейчас показывает
//    (videoWidth × videoHeight у <video>), — в буфер обмена как PNG;
//  - плашка сверху по центру плеера: «Кадр 12:34 скопирован · Сохранить», «Сохранить» —
//    файл «Название видео — 12-34.png» в «Загрузки» (chrome.downloads через фон, как
//    «Скачать превью»);
//  - видео не готово, реклама, защищённое видео (DRM, «испорченный» canvas), буфер обмена
//    недоступен — понятная плашка, без падений.
// Чистая логика (время, имя файла, причина отказа) — globalThis.__ytcsFrameCore (её
// проверяют tests/run.mjs), DOM — ниже, globalThis.__ytcsFrameShot.
(() => {
  const core = (globalThis.__ytcsFrameCore ||= (() => {
    // 754 → «12:34», 3723 → «1:02:03»
    function clock(sec) {
      const s = Math.max(0, Math.floor(Number(sec) || 0));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = String(s % 60).padStart(2, "0");
      return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
    }
    // как sanitizeFilename (groq.js): без запрещённых в Windows знаков, «~» и невидимых символов,
    // без точек, пробелов и «~» в начале, точек и пробелов в конце
    function clean(name, max) {
      let s = String(name || "")
        .replace(/[<>:"/\\|?*~\u0000-\u001F\u007F]|\p{Cf}/gu, "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[.\s~]+/, "");
      s = s.replace(/[. ]+$/g, "").slice(0, max).replace(/[. ]+$/g, "");
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = "_" + s;
      return s;
    }
    // «Название видео — 12-34» (без .png): длинное название обрезаем, время остаётся всегда
    function fileStem(title, sec, id) {
      const t = clean(title, 100) || clean(id, 20) || "Кадр";
      return `${t} — ${clock(sec).replace(/:/g, "-")}`;
    }
    // почему кадр не снять (null — можно): по состоянию <video> и плеера
    function blocker(v) {
      if (!v) return "novideo";
      if (v.ad) return "ad";
      if (v.protected) return "drm";
      // на паузе сразу после открытия YouTube кадр не грузит вовсе — подскажем запустить
      if (!(v.width > 0 && v.height > 0) || (v.readyState ?? 0) < 2) return v.paused && !(v.readyState > 0) ? "paused" : "notready";
      return null;
    }
    // ошибка при снятии или копировании → что сказать
    function errorKind(e) {
      const n = String(e?.name || "");
      if (n === "SecurityError") return "tainted";
      if (n === "NotAllowedError") return "clipboard";
      if (n === "DataError" || n === "NotSupportedError") return "clipboard";
      return "fail";
    }
    return { clock, clean, fileStem, blocker, errorKind };
  })());

  if (typeof document === "undefined" || typeof location === "undefined") return; // автопроверки
  // встроенный плеер — только внутри нашей «Моей библиотеки»; прочие фреймы YouTube — не наше
  if (location.pathname.startsWith("/embed/")) {
    let ours = false;
    try {
      ours = location.ancestorOrigins?.[0] === `chrome-extension://${chrome.runtime.id}`;
    } catch (e) {
      ours = false;
    }
    if (!ours) return;
  } else if (window.top !== window) {
    return;
  }
  if (globalThis.__ytcsFrameShot) return;
  const OUR_EMBED = location.pathname.startsWith("/embed/");

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };

  // ---------- видео ----------
  const player = () => document.querySelector("#movie_player");
  const mainVideo = () => document.querySelector("#movie_player video.html5-main-video") || document.querySelector("video.html5-main-video") || document.querySelector("#movie_player video");
  function videoIdNow() {
    if (location.pathname === "/watch") return new URLSearchParams(location.search).get("v");
    if (OUR_EMBED) return location.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})/)?.[1] || null;
    // Shorts не снимаем: там другой плеер (#shorts-player), а mainVideo() ищет обычный
    return location.pathname.match(/^\/live\/([A-Za-z0-9_-]{11})/)?.[1] || null;
  }
  const txt = (sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, " ").trim() || "";
  // название — со страницы (у встроенного плеера — из его шапки)
  function videoTitle(id) {
    if (OUR_EMBED) return txt(".ytp-title-link");
    const flexy = document.querySelector("ytd-watch-flexy");
    if (flexy && flexy.getAttribute("video-id") !== id) return ""; // шапка ещё от прошлого видео
    return txt("ytd-watch-metadata h1") || document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, "");
  }

  // ---------- плашка поверх плеера (shadow DOM) — как у громкости и скорости по каналам ----------
  const ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.5-2h4.4l1.5 2h1.8A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.5" r="3.5"/></svg>';
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
    /* Roboto: заглавные выше середины строки — без кнопки подпись и значок на 1 px ниже (замер tools/align, yt-frame-wait) */
    .n.plain .txt, .n.plain svg { position: relative; top: 1px; }
    svg { flex: none; width: 20px; height: 20px; color: #ff6b85; }
    .txt { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    b { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
    /* узкий плеер: текст не обрезается, а переносится — «таблетка» становится карточкой */
    .n.wrap { border-radius: 18px; padding-top: 8px; padding-bottom: 8px; }
    .n.wrap .txt { white-space: normal; overflow: visible; }
    button { flex: none; height: 34px; padding: 2px 16px 0; border: 0; border-radius: 999px; font: inherit; font-weight: 600;
      background: #ff3b5c; color: #fff; cursor: pointer; transition: background-color .12s ease; }
    button:hover, button:focus-visible { background: #e8002d; outline: none; }
    button:active { background: #c90027; }
    button[hidden] { display: none; }
    /* большие экраны (2K/4K) — плашка крупнее, как остальные плашки расширения */
    @media (min-width: 1600px) { .n { zoom: 1.15; } }
    @media (min-width: 2200px) { .n { zoom: 1.35; } }
    @media (prefers-reduced-motion: reduce) { :host, .n, button { transition: none; } }`;

  const notice = { host: null, root: null, timer: 0, place: 0, hover: false, canSave: false };
  // seq — номер снимка: два быстрых Shift+S подряд — картинку принимаем только от последнего
  const shot = { blob: null, stem: "", fallback: "", t: 0, saving: false, seq: 0 };

  function noticeHost() {
    const p = player();
    if (!p) return null;
    if (!notice.host) {
      const host = document.createElement("div");
      host.id = "ytcs-frame-notice";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${NOTICE_CSS}</style>
        <div class="n" role="status" aria-live="polite">${ICON}<span class="txt"></span><button type="button" title="Сохранить PNG в «Загрузки»">Сохранить</button></div>`;
      // клики по плашке не должны ставить видео на паузу
      for (const t of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "keydown", "wheel"]) {
        host.addEventListener(t, (e) => e.stopPropagation());
      }
      root.querySelector("button").addEventListener("click", () => void save());
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
    // встроенный плеер библиотеки (2026): обложка «до запуска» и шапка с названием — слой
    // #player-controls поверх #movie_player, плашку в плеере под ним не видно и не нажать.
    // Кладём в слой над ним (content.js), на YouTube — прямо в плеер
    const into = globalThis.__ytcsPlayerLayer?.(p) || p;
    if (notice.host.parentElement !== into) into.appendChild(notice.host);
    return notice.host;
  }

  // под другими плашками сверху плеера (скорость и громкость по каналам, «Вы остановились…», таймер сна,
  // лимит просмотра, вступление канала, повтор отрезка)
  const OTHERS = ["ytcs-speed-notice", "ytcs-resume-offer", "ytcs-sleep-notice", "ytcs-volume-notice", "ytcs-limit-notice", "ytcs-intro-notice", "ytcs-abloop-notice"];
  function place() {
    const host = notice.host;
    const p = host?.isConnected ? host.parentElement : null; // плеер или слой над ним — той же величины
    if (!p) return;
    const top = p.getBoundingClientRect().top;
    let below = 0;
    for (const id of OTHERS) {
      const h = document.getElementById(id);
      const box = h?.parentElement === p ? h.shadowRoot?.querySelector(".show") : null; // чужие плашки — там же, где эта
      if (!box) continue;
      const r = box.getBoundingClientRect();
      if (r.height) below = Math.max(below, r.bottom - top);
    }
    // встроенный плеер библиотеки: шапку с названием (#player-controls) не закрываем — встаём ниже
    if (OUR_EMBED) {
      const r = document.querySelector("#player-controls .player-controls-top")?.getBoundingClientRect();
      if (r?.height && r.bottom > top) below = Math.max(below, r.bottom - top);
    }
    const want = below ? `${Math.round(below + 8)}px` : "";
    if (host.style.top !== want) host.style.top = want;
  }

  function armHide(ms) {
    clearTimeout(notice.timer);
    if (!notice.hover) notice.timer = setTimeout(hideNotice, ms);
  }
  function hideNotice() {
    clearTimeout(notice.timer);
    clearInterval(notice.place);
    notice.root?.querySelector(".n")?.classList.remove("show");
    notice.hover = false;
  }

  // html — только наш текст (время — числа), button — подпись кнопки или ""
  function show(html, button = "", ms = 0) {
    if (!noticeHost()) return;
    const r = notice.root;
    const box = r.querySelector(".n");
    const txt = r.querySelector(".txt");
    const btn = r.querySelector("button");
    txt.innerHTML = html;
    btn.textContent = button;
    btn.hidden = !button;
    btn.disabled = false;
    box.classList.toggle("plain", !button);
    box.classList.remove("wrap");
    if (txt.scrollWidth > txt.clientWidth + 1) box.classList.add("wrap");
    box.classList.remove("show");
    void box.offsetHeight; // перезапуск появления
    box.classList.add("show");
    place();
    clearInterval(notice.place);
    notice.place = setInterval(place, 250); // другая плашка появилась или ушла — подвинуться
    armHide(ms || (button ? 6000 : 3500));
  }

  // вспышка «щёлк» по плееру — понятно, что кадр снят (без анимаций в системе — без вспышки)
  function flash() {
    const p = player();
    if (!p || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let f = document.getElementById("ytcs-frame-flash");
    if (!f) {
      f = document.createElement("div");
      f.id = "ytcs-frame-flash";
      f.style.cssText = "position:absolute;inset:0;z-index:80;background:#fff;opacity:0;pointer-events:none";
    }
    if (f.parentElement !== p) p.appendChild(f);
    f.animate?.([{ opacity: 0.28 }, { opacity: 0 }], { duration: 320, easing: "ease-out" });
  }

  const MSG = {
    novideo: "Откройте видео — снимать пока нечего",
    ad: "Во время рекламы кадр не снимается",
    drm: "Это видео защищено — YouTube не даёт снять кадр",
    notready: "Кадр ещё не загрузился — попробуйте через секунду",
    paused: "Кадр ещё не загружен — запустите видео на миг и снимите снова",
    tainted: "Браузер не дал снять кадр: видео защищено",
    fail: "Не получилось снять кадр — попробуйте ещё раз",
    reload: "Расширение обновилось — обновите страницу (F5)",
    audio: "Сначала покажите видео — Shift+V",
  };

  // ---------- снимок ----------
  function capture(v) {
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext("2d", { alpha: false });
    ctx.drawImage(v, 0, 0, c.width, c.height);
    return new Promise((resolve, reject) => {
      try {
        // «испорченный» canvas (кадр с чужого адреса без CORS) — SecurityError прямо здесь
        c.toBlob((b) => (b ? resolve(b) : reject(Object.assign(new Error("empty"), { name: "fail" }))), "image/png");
      } catch (e) {
        reject(e);
      }
    });
  }

  /** Снять текущий кадр в буфер обмена (клавиша Shift+S, пункт меню). → false — видео нет. */
  function shoot() {
    const v = mainVideo();
    const id = videoIdNow();
    // «Только звук» (audioonly.js): картинка закрыта обложкой и качество снижено — снимать нечего
    if (v && player()?.classList.contains("ytcs-ao")) {
      show(MSG.audio);
      return true;
    }
    const why = core.blocker(
      v && {
        width: v.videoWidth,
        height: v.videoHeight,
        readyState: v.readyState,
        ad: Boolean(player()?.classList.contains("ad-showing")),
        protected: Boolean(v.mediaKeys),
        paused: v.paused,
      }
    );
    if (why) {
      show(MSG[why]);
      return why !== "novideo";
    }
    const t = v.currentTime || 0;
    const tc = core.clock(t);
    let blobP;
    try {
      blobP = capture(v);
    } catch (e) {
      show(MSG[core.errorKind(e) === "tainted" ? "tainted" : "fail"]);
      return true;
    }
    const seq = ++shot.seq;
    const last = () => seq === shot.seq; // пока картинка готовилась, сняли ещё раз — эта уже не нужна
    shot.blob = null;
    shot.t = t;
    shot.stem = core.fileStem(videoTitle(id), t, id);
    shot.fallback = core.fileStem("", t, id); // «id видео — 12-34»: если Chrome не примет имя из названия
    noticeHost();
    flash();
    // буфер обмена — сразу, пока нажатие «свежее» (иначе браузер не даст): обещание картинки
    let copied;
    try {
      copied = navigator.clipboard.write([new ClipboardItem({ "image/png": blobP })]);
    } catch (e) {
      copied = Promise.reject(e);
    }
    blobP.then(
      (b) => {
        if (!last()) return void copied.catch(() => {});
        shot.blob = b;
        copied.then(
          () => last() && show(`Кадр <b>${tc}</b> скопирован`, "Сохранить"),
          // не скопировалось (вкладка не в фокусе, запрет буфера) — кадр всё равно можно сохранить
          () => last() && show(`Кадр <b>${tc}</b> снят — скопировать не вышло`, "Сохранить", 8000)
        );
      },
      (e) => {
        copied.catch(() => {});
        if (last()) show(MSG[core.errorKind(e) === "tainted" ? "tainted" : "fail"]);
      }
    );
    return true;
  }

  const toDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });

  async function save() {
    if (!shot.blob || shot.saving) return;
    if (!alive()) return show(MSG.reload);
    shot.saving = true;
    const btn = notice.root?.querySelector("button");
    if (btn) btn.disabled = true;
    let r = null;
    try {
      r = await chrome.runtime.sendMessage({ type: "frame:save", dataUrl: await toDataUrl(shot.blob), stem: shot.stem, fallback: shot.fallback });
    } catch (e) {
      r = null;
    }
    shot.saving = false;
    if (r?.ok) show(`Кадр <b>${core.clock(shot.t)}</b> сохранён в «Загрузки»`);
    else show("Не получилось сохранить — попробуйте ещё раз", "Сохранить");
  }

  // ---------- клавиша Shift+S ----------
  function typing(e) {
    const el = e.composedPath?.()[0] || e.target;
    if (!(el instanceof Element)) return false;
    return Boolean(el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']")) || el.isContentEditable;
  }
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code !== "KeyS" || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.isComposing) return;
      if (typing(e) || !mainVideo() || !videoIdNow()) return;
      if (shoot()) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  globalThis.__ytcsFrameShot = { shoot, save, debug: () => ({ stem: shot.stem, t: shot.t, size: shot.blob?.size || 0 }) };
})();
