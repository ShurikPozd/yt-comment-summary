"use strict";

// «Только звук» — для подкастов и лекций: видео скрыто, вместо него крупно обложка
// (размытым фоном и по центру), название, канал и — если включены субтитры YouTube —
// текущая фраза. Плашка «Только звук · Показать видео».
//  - Пока видео скрыто, просим у плеера самое низкое качество (144p) — меньше трафика
//    и работы видеокарте; при выключении возвращаем ваше (audioonly-main.js).
//  - Включается пунктом «Только звук» в меню кнопки расширения или клавишей Shift+V;
//    держится в этой вкладке и на следующих видео, пока не выключите.
//  - «По каналам» (settings.audioOnlyChannels, по умолчанию вкл.): включили на видео
//    канала — его следующие видео сразу «только звук»; выключили — канал забыт.
//  - Реклама показывается как обычно; Shorts не трогаем. Полноэкранный режим, театр и
//    мини-плеер — обложка внутри #movie_player и подстраивается под его размер.
// Логика без DOM — audioonly-core.js.
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
  const core = globalThis.__ytcsAudioOnlyCore;
  if (!core || globalThis.__ytcsAudioOnly) return;
  const OUR_EMBED = location.pathname.startsWith("/embed/");

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };

  // ---------- Состояние ----------
  let memory = true; // settings.audioOnlyChannels
  let map = {}; // audioOnlyChannels
  let ready = false; // хранилище прочитано
  let on = false; // режим включён для открытого видео
  let why = ""; // "channel" | "tab" | ""
  let vid = null; // открытое видео (по плееру — и в мини-плеере)
  let info = null; // { videoId, title, author, channelId, live, quality, levels }
  let lowFor = null; // для какого видео уже попросили низкое качество
  let lowTries = 0;
  let sticky = readSticky(); // вы включили режим в этой вкладке
  // новое видео, а канал плеер ещё не назвал: «по каналам» не решаем, пока не узнаем (до 3 с)
  let chWait = { id: null, at: 0 };
  let dead = false; // расширение перезагружено — режим снят, этот экземпляр больше ничего не делает

  function readSticky() {
    try {
      return sessionStorage.getItem(core.tabKey) === "1";
    } catch (e) {
      return false;
    }
  }
  function writeSticky(v) {
    sticky = v;
    try {
      if (v) sessionStorage.setItem(core.tabKey, "1");
      else sessionStorage.removeItem(core.tabKey);
    } catch (e) {
      /* без sessionStorage режим просто не переживёт F5 */
    }
  }

  // ---------- Плеер ----------
  const player = () => document.getElementById("movie_player");
  const adShowing = () => Boolean(player()?.classList.contains("ad-showing"));

  // Где режим работает: страница видео, наш встроенный плеер и мини-плеер YouTube.
  // На ленте у превью при наведении свой плеер — его не трогаем; Shorts — тоже.
  function inContext() {
    const p = player();
    if (!p) return false;
    if (OUR_EMBED) return true;
    if (location.pathname.startsWith("/shorts")) return false;
    if (location.pathname === "/watch") return true;
    return Boolean(p.closest("ytd-miniplayer"));
  }

  // Вопрос миру страницы: ответ приходит синхронно, пока мы ещё в dispatchEvent
  function ask(q, a, detail) {
    let got = null;
    const onAns = (e) => {
      try {
        got = JSON.parse(e.detail);
      } catch (err) {
        got = null;
      }
    };
    document.addEventListener(a, onAns);
    document.dispatchEvent(new CustomEvent(q, detail == null ? undefined : { detail }));
    document.removeEventListener(a, onAns);
    return got;
  }
  const askInfo = () => ask("ytcs-ao:ask", "ytcs-ao:info");

  // ---------- Качество: 144p, пока видео скрыто ----------
  function lowQuality() {
    if (!on || !info || adShowing() || lowFor === vid || lowTries >= 4) return;
    const low = core.lowest(info.levels);
    if (!low) return; // плеер ещё не знает качеств — спросим на следующем шаге
    lowTries++;
    const r = ask("ytcs-ao:low", "ytcs-ao:done", low);
    if (r?.ok) lowFor = vid;
  }
  function restoreQuality() {
    lowFor = null;
    lowTries = 0;
    document.dispatchEvent(new CustomEvent("ytcs-ao:restore"));
  }

  // ---------- Хранилище ----------
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (alive()) void chrome.storage.local.set({ [core.storeKey]: map }).catch(() => {});
    }, 200);
  }

  // ---------- Включить / выключить ----------
  function setOn(next, reason) {
    const was = on;
    on = Boolean(next);
    why = on ? reason : "";
    if (was && !on) restoreQuality();
    if (!was && on) {
      lowFor = null;
      lowTries = 0;
    }
    render();
    lowQuality();
  }

  // Вы переключили режим (меню, клавиша, «Показать видео»)
  function userSet(next) {
    if (!inContext() || dead) return false;
    // видео сменилось, а решение ещё ждало канала — ваш выбор и есть решение
    if (ready && info?.videoId && info.videoId !== vid) {
      vid = info.videoId;
      lowFor = null;
      lowTries = 0;
      chWait.id = null;
    }
    const ch = info?.videoId === vid ? info.channelId : "";
    const name = info?.author || "";
    const r = core.toggle({ map, on: next, ch, name, memory });
    if (r.map !== map) {
      map = r.map;
      save();
    }
    writeSticky(r.sticky);
    setOn(next, next ? (memory && core.has(map, ch) ? "channel" : "tab") : "");
    if (r.forgotten && name) toast(`Для канала «${short(name)}» — снова с видео`);
    return true;
  }

  function toast(text) {
    try {
      globalThis.__ytcsPageToast?.(text, "ok", 3000);
    } catch (e) {
      /* без плашки — не страшно */
    }
  }

  // ---------- Каждые полсекунды: новое видео, реклама, качество ----------
  function tick() {
    if (dead) return;
    if (!alive()) return teardown();
    if (!inContext()) {
      render();
      return;
    }
    const i = askInfo();
    if (!i?.videoId) return render();
    const fresh = i.videoId !== vid;
    info = i;
    if (fresh && ready) {
      // Плеер отдаёт id нового видео раньше остального: channelId пуст. Если есть запомненные
      // каналы — ждём его (до 3 с), иначе канал с «только звуком» решили бы как незнакомый
      if (!i.channelId && memory && Object.keys(map).length) {
        if (chWait.id !== i.videoId) chWait = { id: i.videoId, at: Date.now() };
        if (Date.now() - chWait.at < 3000) {
          if (on) fill(); // пока ждём — обложка и название уже нового видео
          return render();
        }
      }
      chWait.id = null;
      vid = i.videoId;
      lowFor = null;
      lowTries = 0;
      const stored = core.has(map, i.channelId);
      if (stored && memory) {
        map = core.touch(map, i.channelId, i.author);
        save();
      }
      const p = core.plan({ sticky, memory, stored });
      setOn(p.on, p.why);
      fill();
      return;
    }
    if (fresh) return; // хранилище ещё не прочитано — решим, когда прочитаем
    if (on) {
      fill(); // название приходит не сразу (сначала только id)
      lowQuality();
    }
    render();
  }

  // ---------- Обложка поверх видео (shadow DOM) ----------
  // Внутри #movie_player сразу за слоем видео (у него z-index 10): обложка (11) накрывает
  // кадр, но остаётся под субтитрами, подсказками в конце видео, значком загрузки,
  // панелью управления и плашками расширения. Клики проходят насквозь — к плееру
  // (пауза по щелчку, двойной щелчок — полный экран); ловит их только плашка.
  const ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3.5" y="13" width="4.5" height="7" rx="2"/><rect x="16" y="13" width="4.5" height="7" rx="2"/></svg>';
  const CSS = `
    :host { all: initial; position: absolute; inset: 0; z-index: 11; display: block; overflow: hidden;
      pointer-events: none; container-type: size; contain: strict; background: #0f0f0f;
      font-family: "YouTube Noto", Roboto, Arial, sans-serif; color: #fff; -webkit-font-smoothing: antialiased; }
    :host([hidden]) { display: none !important; }
    .bg { position: absolute; inset: -12%; background: #1a1a1a center / cover no-repeat; background-image: var(--img, none);
      filter: blur(42px) saturate(1.5) brightness(.5); transform: translateZ(0); }
    .shade { position: absolute; inset: 0; background: radial-gradient(120% 90% at 50% 45%, rgba(0, 0, 0, .1), rgba(0, 0, 0, .6)); }
    /* равные поля сверху и снизу — сверху шапка плеера и плашки, снизу панель управления */
    /* --snap: колонка по центру встаёт на долю пикселя — сдвигаем её на целый (snap()) */
    .col { position: absolute; inset: 0; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center;
      transform: translateY(var(--snap, 0px));
      gap: clamp(8px, 2.6cqh, 26px); padding: clamp(40px, 11cqh, 132px) clamp(16px, 6cqw, 120px); text-align: center; }
    .pill { pointer-events: auto; display: flex; align-items: center; gap: .6em; max-width: 100%; box-sizing: border-box;
      padding: round(.3em, 2px) round(.3em, 2px) round(.3em, 2px) round(.9em, 2px); border-radius: 999px; background: rgba(20, 20, 22, .72);
      -webkit-backdrop-filter: blur(16px) saturate(1.5); backdrop-filter: blur(16px) saturate(1.5);
      box-shadow: 0 8px 30px rgba(0, 0, 0, .35), inset 0 0 0 1px rgba(255, 255, 255, .09);
      font-size: round(clamp(14px, 2.9cqh, 24px), 1px); font-weight: 500; line-height: 1.3; white-space: nowrap; }
    /* размеры — целыми пикселями, высоты кратны 4 px (на экранах 150 % и 200 % это целые
       точки экрана): кегль растёт с плеером, а подписи и значок не «плывут»;
       Roboto сидит в строке высоко — подписи на 1px ниже (замер tools/align) */
    .pill svg { flex: none; width: round(1.25em, 2px); height: round(1.25em, 2px); color: #ff6b85; }
    .pill .lbl { position: relative; top: 1px; line-height: round(1.3em, 2px); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .pill button { flex: none; height: round(2.1em, 4px); padding: 2px 1em 0; border: 0; border-radius: 999px; font: inherit; font-weight: 600;
      background: #ff3b5c; color: #fff; cursor: pointer; transition: background-color .12s ease; }
    .pill button:hover, .pill button:focus-visible { background: #e8002d; outline: none; }
    .pill button:focus-visible { box-shadow: 0 0 0 2px rgba(255, 255, 255, .85); }
    .cover { display: block; flex: none; height: clamp(64px, 30cqh, 420px); aspect-ratio: 16 / 9; max-width: 88cqw; object-fit: cover;
      border-radius: clamp(8px, 1.8cqh, 20px); background: rgba(255, 255, 255, .06);
      box-shadow: 0 18px 60px rgba(0, 0, 0, .55), 0 0 0 1px rgba(255, 255, 255, .08); }
    .cover[hidden] { display: none; }
    .meta { display: flex; flex-direction: column; align-items: center; gap: clamp(2px, .8cqh, 10px); max-width: min(100%, 34em); min-width: 0; }
    .title { margin: 0; font-size: clamp(16px, 4.3cqh, 46px); font-weight: 700; line-height: 1.22; letter-spacing: -.005em;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; text-wrap: balance; }
    .chan { font-size: clamp(13px, 2.9cqh, 28px); font-weight: 500; line-height: 1.3; color: rgba(255, 255, 255, .72);
      max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chan:empty, .title:empty { display: none; }
    /* текущая фраза субтитров: место под две строки держим, пока субтитры включены, —
       колонка не прыгает между фразами */
    .say { box-sizing: border-box; max-width: min(100%, 30em); min-height: calc(2 * 1.3em); margin: 0;
      font-size: clamp(17px, 5cqh, 54px); font-weight: 600; line-height: 1.3; color: #fff; text-wrap: balance;
      text-shadow: 0 2px 12px rgba(0, 0, 0, .6); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
    .say[hidden] { display: none; }
    /* невысокий плеер (мини-плеер, узкое окно): без обложки; совсем маленький — без канала */
    @container (max-height: 330px) { .cover { display: none; } .col { gap: 8px; padding-top: 44px; padding-bottom: 44px; } }
    @container (max-height: 200px) { .chan { display: none; } .title { -webkit-line-clamp: 1; } .say { min-height: 1.3em; -webkit-line-clamp: 1; } }
    /* узкий плеер: «для канала» убираем, «Только звук» остаётся (не голый значок) */
    .pill .ch[hidden] { display: none; }
    @container (max-width: 460px) { .pill .ch { display: none; } .pill { padding-left: round(.7em, 2px); gap: round(.45em, 2px); } }
    @media (prefers-reduced-motion: reduce) { .pill button { transition: none; } }`;

  const ui = { host: null, root: null, img: null, src: [], srcAt: 0, vid: null, phraseObs: null, capObs: null };
  const short = (s, n = 40) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

  function ensurePageStyle() {
    if (document.getElementById("ytcs-ao-style")) return;
    const s = document.createElement("style");
    s.id = "ytcs-ao-style";
    // кадр прячем только у основного видео и не на рекламе; субтитры YouTube — когда
    // их фраза у нас крупно (иначе было бы два одинаковых текста)
    s.textContent = `
      #movie_player.ytcs-ao:not(.ad-showing) video.html5-main-video { opacity: 0 !important; }
      #movie_player.ytcs-ao.ad-showing > #ytcs-audio-only { display: none !important; }
      #movie_player.ytcs-ao.ytcs-ao-say:not(.ad-showing) .ytp-caption-window-container { opacity: 0 !important; }`;
    (document.head || document.documentElement).appendChild(s);
  }

  function host() {
    const p = player();
    if (!p) return null;
    if (!ui.host) {
      const h = document.createElement("div");
      h.id = "ytcs-audio-only";
      h.hidden = true;
      const root = h.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${CSS}</style>
        <div class="bg"></div><div class="shade"></div>
        <div class="col">
          <div class="pill" role="status">${ICON}<span class="lbl">Только звук<span class="ch" hidden> для канала</span></span><button type="button" title="Показать видео — Shift+V">Показать видео</button></div>
          <img class="cover" alt="" referrerpolicy="no-referrer" decoding="async" hidden>
          <div class="meta"><p class="title"></p><div class="chan"></div></div>
          <p class="say" aria-live="off" hidden></p>
        </div>`;
      // плашка ловит свои щелчки сама: видео не встаёт на паузу, меню YouTube не открывается
      const pill = root.querySelector(".pill");
      for (const t of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "keydown", "wheel", "contextmenu"]) {
        pill.addEventListener(t, (e) => e.stopPropagation());
      }
      root.querySelector("button").addEventListener("click", () => userSet(false));
      ui.img = root.querySelector(".cover");
      ui.img.addEventListener("load", onCover);
      // размер плеера или содержимого колонки сменился — снова на целый пиксель
      ui.ro = new ResizeObserver(snap);
      ui.ro.observe(h);
      for (const el of root.querySelectorAll(".col > *")) ui.ro.observe(el);
      ui.img.addEventListener("error", nextCover);
      ui.host = h;
      ui.root = root;
    }
    // сразу за слоем видео: всё остальное у плеера рисуется поверх
    const box = p.querySelector(":scope > .html5-video-container");
    if (ui.host.parentElement !== p || (box && ui.host.previousElementSibling !== box)) {
      if (box) box.after(ui.host);
      else p.prepend(ui.host);
    }
    return ui.host;
  }

  // Колонка по центру по вертикали: при дробной середине плашка с кнопкой встала бы на
  // долю пикселя и подписи «поплыли» бы — ставим колонку на целую точку экрана (центр ±1 px)
  function snap() {
    if (!ui.root || ui.host?.hidden) return;
    const col = ui.root.querySelector(".col");
    const pill = ui.root.querySelector(".pill");
    const was = parseFloat(col.style.getPropertyValue("--snap")) || 0;
    const top = pill.getBoundingClientRect().top - ui.host.getBoundingClientRect().top - was;
    // кратно 2 px — целые точки экрана и на 150 %, и на 200 %
    const d = Math.round((Math.round(top / 2) * 2 - top) * 100) / 100;
    if (d !== was) col.style.setProperty("--snap", `${d}px`);
  }

  // ---------- Обложка: maxres → sd → hq (серая заглушка YouTube — «нет такой») ----------
  function setCover(id) {
    if (ui.vid === id) return;
    ui.vid = id;
    ui.src = core.covers(id);
    ui.root.querySelector(".bg").style.removeProperty("--img");
    ui.img.hidden = true;
    nextCover();
  }
  function nextCover() {
    const u = ui.src.shift();
    if (!u) return;
    ui.img.src = u;
  }
  function onCover() {
    if (core.isStubImage(ui.img.naturalWidth, ui.img.naturalHeight)) return nextCover();
    ui.img.hidden = false;
    ui.root.querySelector(".bg").style.setProperty("--img", `url("${ui.img.currentSrc || ui.img.src}")`);
  }

  // Название, канал, обложка, подпись плашки
  function fill() {
    if (!ui.host || !info) return;
    const r = ui.root;
    const title = r.querySelector(".title");
    const chan = r.querySelector(".chan");
    if (title.textContent !== (info.title || "")) title.textContent = info.title || "";
    if (chan.textContent !== (info.author || "")) chan.textContent = info.author || "";
    title.title = info.title || "";
    const forChannel = memory && core.has(map, info.channelId);
    r.querySelector(".ch").hidden = !forChannel;
    r.querySelector(".pill").setAttribute("aria-label", core.pillText(forChannel));
    r.querySelector(".pill").title = forChannel && info.author ? `Только звук для канала «${info.author}»` : "Видео скрыто, играет звук";
    setCover(info.videoId);
  }

  function render() {
    const p = player();
    const show = on && inContext() && Boolean(p);
    if (!show) {
      p?.classList.remove("ytcs-ao", "ytcs-ao-say");
      if (ui.host) ui.host.hidden = true;
      watchCaptions(false);
      return;
    }
    ensurePageStyle();
    if (!host()) return;
    p.classList.add("ytcs-ao");
    if (ui.host.hidden) {
      ui.host.hidden = false;
      fill();
    }
    watchCaptions(true);
  }

  // Расширение перезагрузили (или выключили): этот экземпляр больше не слышит ни клавиш, ни
  // меню — один раз снимаем режим целиком, иначе видео осталось бы скрытым и в 144p без
  // кнопки «Показать видео». Качество возвращает audioonly-main.js (мир страницы жив).
  function teardown() {
    if (dead) return;
    dead = true;
    on = false;
    why = "";
    watchCaptions(false);
    ui.ro?.disconnect();
    player()?.classList.remove("ytcs-ao", "ytcs-ao-say");
    ui.host?.remove();
    document.getElementById("ytcs-ao-style")?.remove();
    restoreQuality(); // audioonly-main.js сам знает, просили ли низкое качество
  }

  // ---------- Текущая фраза субтитров YouTube ----------
  // Берём текст из слоя субтитров плеера (что YouTube показывает сейчас). При «Двойных
  // субтитрах» у них своя плашка над панелью — поверх обложки; свою фразу тогда не дублируем.
  const capsOn = () => player()?.querySelector(".ytp-subtitles-button")?.getAttribute("aria-pressed") === "true";
  const dualOn = () => Boolean(player()?.classList.contains("ytcs-ds-on"));
  function readPhrase() {
    const c = player()?.querySelector(".ytp-caption-window-container");
    if (!c) return "";
    const lines = [...c.querySelectorAll(".caption-visual-line")].map((l) => l.textContent);
    return core.phrase(lines.length ? lines : [c.textContent]);
  }
  function syncPhrase() {
    if (!ui.root) return;
    const say = ui.root.querySelector(".say");
    const p = player();
    const want = on && capsOn() && !dualOn();
    say.hidden = !want;
    p?.classList.toggle("ytcs-ao-say", want);
    const text = want ? readPhrase() : "";
    if (say.textContent !== text) say.textContent = text;
  }
  function watchCaptions(active) {
    if (!active) {
      ui.phraseObs?.disconnect();
      ui.phraseObs = null;
      ui.capObs?.disconnect();
      ui.capObs = null;
      return;
    }
    const p = player();
    const c = p?.querySelector(".ytp-caption-window-container");
    if (c && (!ui.phraseObs || ui.phraseObs.target !== c)) {
      ui.phraseObs?.disconnect();
      ui.phraseObs = new MutationObserver(syncPhrase);
      ui.phraseObs.observe(c, { childList: true, subtree: true, characterData: true });
      ui.phraseObs.target = c;
    }
    // кнопка субтитров (вкл/выкл) и «Двойные субтитры» — по классу плеера
    const btn = p?.querySelector(".ytp-subtitles-button");
    if (!ui.capObs || ui.capObs.btn !== btn) {
      ui.capObs?.disconnect();
      ui.capObs = new MutationObserver(syncPhrase);
      if (btn) ui.capObs.observe(btn, { attributes: true, attributeFilter: ["aria-pressed"] });
      ui.capObs.observe(p, { attributes: true, attributeFilter: ["class"] });
      ui.capObs.btn = btn;
    }
    syncPhrase();
  }

  // ---------- Клавиша Shift+V ----------
  function typing(e) {
    const t = e.composedPath?.()[0] || e.target;
    return Boolean(t?.isContentEditable || /^(input|textarea|select)$/i.test(t?.tagName || ""));
  }
  document.addEventListener(
    "keydown",
    (e) => {
      if (!core.isToggleKey(e) || typing(e) || !alive() || !inContext() || !ready) return;
      e.preventDefault();
      e.stopPropagation();
      userSet(!on);
    },
    true
  );

  // ---------- «Показать видео» в новом встроенном плеере библиотеки ----------
  // Там слой управления #player-controls лежит поверх всего #movie_player, и нажатие на
  // кнопку плашки достаётся ему (пауза), а не кнопке. Обложка же должна остаться в плеере —
  // за ней панель, субтитры и значок загрузки. Поэтому ловим нажатие раньше всех (window,
  // перехват) и сверяем точку с местом кнопки: попали — «Показать видео», плееру не отдаём.
  if (OUR_EMBED) {
    const onButton = (e) => {
      if (!on || dead || !ui.root || ui.host?.hidden || adShowing() || !(e.target instanceof Element)) return false;
      // своё меню и плашки в слое над плеером — их нажатия не наши
      if (e.target.closest(".ytcs-menu, .ytcs-btn, #ytcs-embed-layer") || !e.target.closest("#player-controls, #movie_player")) return false;
      const r = ui.root.querySelector(".pill button")?.getBoundingClientRect();
      return Boolean(r?.width) && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick"]) {
      window.addEventListener(
        t,
        (e) => {
          if (!onButton(e)) return;
          e.preventDefault();
          e.stopPropagation();
          if (t === "click") userSet(false);
        },
        true
      );
    }
  }

  // ---------- Для меню кнопки расширения в плеере (content.js) ----------
  globalThis.__ytcsAudioOnly = {
    state: () => ({ on, why, available: inContext() && ready, channel: info?.author || "", forChannel: on && why === "channel" }),
    set: (v) => userSet(Boolean(v)),
    toggle: () => userSet(!on),
    // для проверок
    debug: () => ({ on, why, vid, sticky, memory, lowFor, lowTries, info, ready }),
  };

  // ---------- Подписки ----------
  window.addEventListener("yt-navigate-finish", tick);
  document.addEventListener("loadedmetadata", (e) => e.target instanceof HTMLVideoElement && tick(), true);
  setInterval(tick, 500);

  if (!alive()) return;
  chrome.storage.local
    .get(["settings", core.storeKey])
    .then((o) => {
      memory = o.settings?.audioOnlyChannels !== false;
      map = o[core.storeKey] && typeof o[core.storeKey] === "object" ? o[core.storeKey] : {};
      ready = true;
      tick();
    })
    .catch(() => {
      ready = true;
    });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) memory = changes.settings.newValue?.audioOnlyChannels !== false;
    if (changes[core.storeKey]) map = changes[core.storeKey].newValue || {};
    if (changes.settings || changes[core.storeKey]) fill();
  });
  tick();
})();
