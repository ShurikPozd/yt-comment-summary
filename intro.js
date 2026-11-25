"use strict";

// Пропуск вступлений по каналам: отметьте в видео канала «вступление до сюда»
// (пункт в меню кнопки расширения в плеере или Shift+I) — и в следующих видео канала
// вступление пропустится само, поверх плеера — «Вступление пропущено · Вернуть».
//  - Сами перематываете вступление: если в первые ~60 с перемотали вперёд на одно и
//    то же место (±5 с) в 2+ видео канала — плашка предложит запомнить.
//  - Канал узнаём по id (UC…) у мира страницы (speed-main.js), как громкость по каналам.
//  - Не трогаем: рекламу, эфиры, Shorts, ссылки с меткой времени (&t=, во встроенном
//    плеере — start=), ролик, которому «С того же места» (resume.js) возвращает место,
//    и ролик, который YouTube сам начал не с начала (по своей истории просмотра).
// Настройка — settings.introSkip (по умолчанию вкл.); вступления —
// chrome.storage.local.channelIntros, наблюдения — introHints (см. intro-core.js).
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
  const core = globalThis.__ytcsIntroCore;
  if (!core || globalThis.__ytcsIntro) return;
  const OUR_EMBED = location.pathname.startsWith("/embed/");

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };

  // ---------- Состояние ----------
  // При переходе внутри YouTube элемент <video> тот же, и сначала в нём ещё прежний
  // ролик. Новый — когда после начала перехода (или сброса источника) пришли его метаданные.
  let navAt = 0;
  let emptiedAt = 0;
  let metaAt = 0;
  const loaded = (v) => v.first || metaAt > v.boundary;
  let enabled = true; // settings.introSkip
  let map = {}; // channelIntros
  let hints = {}; // introHints
  let ready = false; // хранилище прочитано
  let vid = null;
  let firstVisit = true;
  let cur = fresh(null);
  function fresh(id) {
    const first = firstVisit;
    if (id) firstVisit = false;
    return { id, first, boundary: Math.max(navAt, emptiedAt), startedAt: Date.now(), known: false, channelId: "", name: "", live: false, decided: false, skipped: null, end: null, guardUntil: 0, reapplied: 0, offered: false };
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
  // ссылка с меткой времени — выбор явный, вступление не пропускаем
  function urlHasT() {
    const q = new URLSearchParams(location.search);
    if (q.has("t") || /(^|[#&])t=/.test(location.hash.slice(1))) return true;
    return OUR_EMBED && Number(q.get("start")) > 0;
  }
  // «С того же места» возвращает место этому ролику? (true / false / null — ещё не знает)
  function resumeBusy(id) {
    const r = globalThis.__ytcsResume;
    if (OUR_EMBED || typeof r?.busy !== "function") return false;
    try {
      return r.busy(id);
    } catch (e) {
      return false;
    }
  }

  // Вопрос миру страницы: ответ приходит синхронно, пока мы ещё в dispatchEvent
  function askInfo() {
    let got = null;
    const on = (e) => {
      try {
        got = JSON.parse(e.detail);
      } catch (err) {
        got = null;
      }
    };
    document.addEventListener("ytcs-speed:info", on);
    document.dispatchEvent(new CustomEvent("ytcs-speed:ask"));
    document.removeEventListener("ytcs-speed:info", on);
    return got;
  }

  // ---------- Хранилище ----------
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (alive()) void chrome.storage.local.set({ [core.storeKey]: map }).catch(() => {});
    }, 300);
  }
  let hintsTimer = 0;
  function saveHints() {
    clearTimeout(hintsTimer);
    hintsTimer = setTimeout(() => {
      if (alive()) void chrome.storage.local.set({ [core.hintsKey]: hints }).catch(() => {});
    }, 300);
  }

  // ---------- Новое видео: пропустить вступление ----------
  function onNavigate() {
    const id = videoIdNow();
    if (id === vid) return;
    vid = id;
    cur = fresh(id);
    lastT = 0;
    clearTimeout(seekTimer);
    hideNotice();
  }

  // своя перемотка: куда и когда (её «seeking» — не ваша перемотка)
  let ourSeek = null;
  function seek(el, t) {
    ourSeek = { t, at: Date.now() };
    el.currentTime = t;
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
    }
    if (cur.decided) return;
    const entry = core.entryOf(map, cur.channelId);
    if (!enabled || !entry || cur.live || urlHasT()) {
      cur.decided = true;
      return;
    }
    if (!loaded(cur) || v.readyState < 1 || !(v.duration > 0)) return; // ролик ещё не загрузился
    // место YouTube по своей истории видно, когда кадр уже есть (или пару секунд спустя)
    if (v.readyState < 2 && Date.now() - cur.startedAt < 3000) return;
    const rb = resumeBusy(vid);
    if (rb === null && Date.now() - cur.startedAt < 6000) return; // «С того же места» ещё не разобрал ролик
    if (rb) {
      cur.decided = true;
      return;
    }
    cur.decided = true;
    const step = core.plan({ enabled, end: entry.e, current: v.currentTime, duration: v.duration, live: cur.live, urlT: false, resume: false, ad: false });
    if (!step) return;
    map = core.touch(map, cur.channelId, cur.name);
    save();
    cur.skipped = v.currentTime;
    cur.end = step.to;
    cur.guardUntil = Date.now() + 4000;
    seek(v, step.to);
    showNotice("skipped");
  }

  // ---------- Ваша перемотка ----------
  let userAt = 0;
  let lastT = 0; // время видео до перемотки
  let seekTimer = 0;
  const gesture = () => {
    userAt = Date.now();
  };
  document.addEventListener("pointerdown", gesture, true);
  document.addEventListener("keydown", gesture, true);

  document.addEventListener(
    "timeupdate",
    (e) => {
      if (!isMain(e) || adShowing()) return;
      const t = e.target.currentTime;
      if (!e.target.seeking) lastT = t;
      if (!cur.decided) tick();
    },
    true
  );
  document.addEventListener(
    "seeking",
    (e) => {
      if (!isMain(e)) return;
      const el = e.target;
      const from = lastT;
      const to = el.currentTime;
      if (ourSeek && Math.abs(to - ourSeek.t) < 0.5 && Date.now() - ourSeek.at < 2000) {
        ourSeek = null;
        lastT = to;
        return;
      }
      lastT = to;
      if (adShowing() || !vid || cur.id !== vid) return;
      if (Date.now() - userAt > 1500) {
        // YouTube сразу после нас вернул начало (своё место по истории) — пропускаем ещё раз
        if (cur.end != null && Date.now() < cur.guardUntil && cur.reapplied < 1 && to < cur.end - 1 && to <= core.startLimit) {
          cur.reapplied += 1;
          setTimeout(() => mainVideo() === el && seek(el, cur.end), 0);
        }
        return;
      }
      cur.guardUntil = 0; // перематываете сами — больше не вмешиваемся
      noteSeek(from, to);
    },
    true
  );

  // Перемотали вперёд в первые ~60 с: запомнить место; в 2+ видео канала одно место —
  // предложить пропускать. Серия нажатий (L, L, L) — одно место: ждём, пока закончите.
  function noteSeek(from, to) {
    if (!enabled || !cur.known || !cur.channelId || cur.live || cur.skipped != null) return;
    if (core.entryOf(map, cur.channelId)) return; // вступление уже отмечено
    clearTimeout(seekTimer);
    if (!core.isIntroSeek(from, to)) return; // не вперёд из начала — серия не про вступление
    const id = cur.id;
    const ch = cur.channelId;
    seekTimer = setTimeout(() => {
      const v = mainVideo();
      if (cur.id !== id || !v || adShowing()) return;
      const at = v.currentTime;
      if (!core.isIntroSeek(0, at)) return;
      hints = core.observe(hints, ch, id, at);
      saveHints();
      const end = core.suggest(hints, ch);
      if (end != null && !cur.offered) {
        cur.offered = true;
        cur.offer = end;
        showNotice("offer");
      }
    }, 1500);
  }

  // ---------- Действия (меню, клавиша, плашка) ----------
  let undo = null; // что было до отметки — для «Отменить»

  function setEnabledOn() {
    if (enabled || !alive()) return;
    enabled = true;
    chrome.storage.local
      .get("settings")
      .then(({ settings }) => chrome.storage.local.set({ settings: { ...(settings || {}), introSkip: true } }))
      .catch(() => {});
  }

  // запомнить конец вступления канала (и больше не спрашивать про него)
  function rememberEnd(end, kind) {
    const ch = cur.channelId;
    const prev = core.entryOf(map, ch);
    undo = { ch, prev, hints: hints[ch] };
    map = core.remember(map, ch, end, cur.name);
    hints = core.clearHints(hints, ch);
    save();
    saveHints();
    setEnabledOn();
    cur.decided = true;
    showNotice(kind);
  }

  // «Вступление до сюда» — нынешнее место видео
  function mark() {
    const v = mainVideo();
    if (!v || !vid || adShowing()) return false;
    if (!cur.known) tick();
    if (cur.live) return showNotice("live"), false;
    if (!cur.channelId) return showNotice("nochannel"), false;
    const end = core.cleanEnd(v.currentTime);
    if (end == null) return showNotice("range"), false;
    rememberEnd(end, "marked");
    return true;
  }

  // «Сбросить вступление канала»
  function reset() {
    const ch = cur.channelId;
    if (!ch || !core.entryOf(map, ch)) return false;
    undo = null;
    map = core.forget(map, ch);
    hints = core.clearHints(hints, ch);
    save();
    saveHints();
    showNotice("reset");
    return true;
  }

  function undoMark() {
    if (!undo) return;
    const { ch, prev } = undo;
    map = prev ? { ...map, [ch]: prev } : core.forget(map, ch);
    if (undo.hints) hints = { ...hints, [ch]: undo.hints };
    undo = null;
    save();
    saveHints();
    showNotice("undone");
  }

  // «Вернуть»: к месту до пропуска, в этом видео больше не пропускаем
  function back() {
    const v = mainVideo();
    if (!v || cur.skipped == null) return;
    cur.guardUntil = 0;
    cur.end = null;
    seek(v, cur.skipped);
    hideNotice();
  }

  function decline() {
    if (cur.channelId) {
      hints = core.decline(hints, cur.channelId);
      saveHints();
    }
    hideNotice();
  }

  // ---------- Плашка поверх плеера (shadow DOM) ----------
  // Стиль — как у плашек скорости и громкости по каналам (speed.js, volume.js): тёмная
  // «таблетка» сверху по центру. Если там уже есть другая плашка расширения — встаём под неё.
  const ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 6.5v11l7-5.5z"/><path d="M12 6.5v11l7-5.5z"/><path d="M20 6v12"/></svg>';
  const NOTICE_CSS = `
    :host { all: initial; position: absolute; top: 16px; left: 16px; right: 16px; z-index: 80;
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
    .btns { flex: none; display: flex; gap: 6px; }
    /* узкий плеер: текст не обрезается, а переносится — «таблетка» становится карточкой */
    .n.wrap { border-radius: 18px; padding-top: 8px; padding-bottom: 8px; }
    .n.wrap .txt { white-space: normal; overflow: visible; }
    button { flex: none; height: 34px; padding: 2px 16px 0; border: 0; border-radius: 999px; font: inherit; font-weight: 600;
      background: rgba(255, 255, 255, .14); color: #fff; cursor: pointer; transition: background-color .12s ease; }
    button:hover, button:focus-visible { background: rgba(255, 255, 255, .24); outline: none; }
    button:active { background: rgba(255, 255, 255, .3); }
    button.go { background: #e8002d; }
    button.go:hover, button.go:focus-visible { background: #ff3b5c; }
    button.go:active { background: #c70027; }
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
      host.id = "ytcs-intro-notice";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${NOTICE_CSS}</style>
        <div class="n" role="status" aria-live="polite">${ICON}<span class="txt"></span><span class="btns"><button type="button" class="a"></button><button type="button" class="b"></button></span></div>`;
      // клики по плашке не должны ставить видео на паузу
      for (const t of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "keydown", "wheel"]) {
        host.addEventListener(t, (e) => e.stopPropagation());
      }
      root.querySelector(".a").addEventListener("click", () => {
        const k = notice.kind;
        if (k === "skipped") back();
        else if (k === "marked") undoMark();
        else if (k === "offer") {
          if (cur.offer != null && cur.channelId) rememberEnd(cur.offer, "saved");
        } else hideNotice();
      });
      root.querySelector(".b").addEventListener("click", () => (notice.kind === "offer" ? decline() : hideNotice()));
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
    // в новом встроенном плеере — слой над его панелью управления (content.js), иначе кнопки не нажимаются
    const into = globalThis.__ytcsPlayerLayer?.(p) || p;
    if (notice.host.parentElement !== into) into.appendChild(notice.host);
    return notice.host;
  }

  // Под другими плашками сверху плеера (скорость и громкость по каналам, «Вы остановились…», таймер сна,
  // лимит просмотра) — во встроенном плеере все они в одном слое с этой. Повтора отрезка здесь нет:
  // он сам встаёт под эту плашку (abloop.js), а взаимные «под тобой» толкали бы обе вниз без конца
  const OTHERS = ["ytcs-speed-notice", "ytcs-volume-notice", "ytcs-resume-offer", "ytcs-sleep-notice", "ytcs-limit-notice"];
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
    // встроенный плеер библиотеки: шапку с названием (#player-controls) не закрываем — встаём ниже
    if (OUR_EMBED) {
      const hr = document.querySelector("#player-controls .player-controls-top")?.getBoundingClientRect();
      if (hr?.height && hr.bottom > top) below = Math.max(below, hr.bottom - top);
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
    const end = core.entryOf(map, cur.channelId)?.e;
    const at = (s) => `<b>${core.clock(s)}</b>`;
    // [текст, кнопка 1, кнопка 2, кнопка 1 — главная (красная)]
    const text = {
      skipped: ["Вступление пропущено", "Вернуть", "", false],
      marked: [`Вступление канала ${nm} — до ${at(end)}`, "Отменить", "", false],
      saved: [`Вступление канала ${nm} будет пропускаться — до ${at(end)}`, "", "", false],
      offer: [`Пропускать вступление канала — до ${at(cur.offer)}?`, "Пропускать", "Не надо", true],
      reset: [`Вступление канала ${nm} сброшено`, "", "", false],
      undone: [end ? `Вступление канала ${nm} — снова до ${at(end)}` : `Вступление канала ${nm} не запомнено`, "", "", false],
      live: ["В прямых эфирах вступления не пропускаются", "", "", false],
      nochannel: ["Не удалось узнать канал видео", "", "", false],
      range: ["Отметьте конец вступления — от 0:03 до 5:00", "", "", false],
    }[kind];
    const txt = r.querySelector(".txt");
    const a = r.querySelector(".a");
    const b = r.querySelector(".b");
    txt.innerHTML = text[0];
    a.textContent = text[1];
    a.hidden = !text[1];
    a.classList.toggle("go", text[3]);
    b.textContent = text[2];
    b.hidden = !text[2];
    notice.kind = kind;
    const box = r.querySelector(".n");
    box.classList.toggle("plain", !text[1]);
    box.classList.remove("wrap");
    if (txt.scrollWidth > txt.clientWidth + 1) box.classList.add("wrap");
    box.title = cur.name && cur.name.length > 36 ? cur.name : "";
    box.classList.remove("show");
    void box.offsetHeight; // перезапуск появления
    box.classList.add("show");
    place();
    clearInterval(notice.place);
    notice.place = setInterval(place, 250); // другая плашка появилась или ушла — подвинуться
    armHide(kind === "offer" ? 12000 : text[1] ? 6000 : 2800);
  }

  function hideNotice() {
    clearTimeout(notice.timer);
    clearInterval(notice.place);
    notice.root?.querySelector(".n")?.classList.remove("show");
    notice.kind = "";
    notice.hover = false;
  }

  // открываете меню расширения — плашка не мешает
  for (const t of ["pointerdown", "click"]) document.addEventListener(t, (e) => e.target?.closest?.(".ytcs-btn") && hideNotice(), true);

  // ---------- Shift+I — «вступление до сюда» (по коду клавиши: на любой раскладке) ----------
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code !== "KeyI" || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.repeat || e.isComposing) return;
      const t = e.composedPath?.()[0] || e.target;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return; // печатаете — не мешаем
      // на рекламе (и пока видео нет) отметить нельзя — клавишу не глотаем, пусть достаётся YouTube
      if (!vid || !mainVideo() || adShowing() || !alive()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      mark(); // прочие отказы (эфир, канал не узнан, не то место) mark() показывает плашкой
    },
    true
  );

  // ---------- Для меню кнопки расширения в плеере (content.js) ----------
  globalThis.__ytcsIntro = {
    // вступление канала открытого видео — или null
    current() {
      if (!cur.known || !cur.channelId) return null;
      const e = core.entryOf(map, cur.channelId);
      return e ? { channelId: cur.channelId, name: cur.name, end: e.e, label: core.clock(e.e) } : null;
    },
    // можно ли отметить сейчас: { ok, label } — место видео («0:42»)
    here() {
      const v = mainVideo();
      if (!v || !vid || adShowing() || cur.live) return { ok: false, label: "" };
      return { ok: true, label: core.clock(v.currentTime) };
    },
    mark,
    reset,
    // для стендов центровки: показать плашку (tools/align)
    show: (kind) => showNotice(kind),
    // для проверок
    debug: () => ({ enabled, cur: { ...cur }, map: { ...map }, hints: { ...hints }, kind: notice.kind }),
  };

  // ---------- Подписки ----------
  // События <video> не всплывают, но ловятся на перехвате (capture) на document
  for (const t of ["loadedmetadata", "durationchange"]) {
    document.addEventListener(
      t,
      (e) => {
        if (!isMain(e)) return;
        metaAt = Date.now();
        tick();
      },
      true
    );
  }
  for (const t of ["canplay", "playing"]) document.addEventListener(t, (e) => isMain(e) && tick(), true);
  document.addEventListener("emptied", (e) => isMain(e) && (emptiedAt = Date.now()), true);
  document.addEventListener("yt-navigate-start", () => {
    navAt = Date.now();
  });
  window.addEventListener("yt-navigate-finish", tick);
  window.addEventListener("popstate", tick);
  setInterval(tick, 500);

  if (!alive()) return;
  chrome.storage.local
    .get(["settings", core.storeKey, core.hintsKey])
    .then((o) => {
      enabled = o.settings?.introSkip !== false;
      map = o[core.storeKey] && typeof o[core.storeKey] === "object" ? o[core.storeKey] : {};
      hints = o[core.hintsKey] && typeof o[core.hintsKey] === "object" ? o[core.hintsKey] : {};
      ready = true;
      tick();
    })
    .catch(() => {
      ready = true;
    });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) {
      enabled = changes.settings.newValue?.introSkip !== false;
      if (!enabled && notice.kind === "offer") hideNotice();
    }
    if (changes[core.storeKey]) map = changes[core.storeKey].newValue || {};
    if (changes[core.hintsKey]) hints = changes[core.hintsKey].newValue || {};
  });
  tick();
})();
