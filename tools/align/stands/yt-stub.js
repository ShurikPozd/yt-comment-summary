// Стенд «страница YouTube»: заглушка chrome.* для контент-скриптов, вымышленные
// ответы «главного мира» (clip-main.js, playlists-main.js) и помощники для замера:
//   __stand.preview() — окно превью, __stand.clip() — окно клипа,
//   __stand.playlists() — «Сохранить в плейлисты», __stand.menu() — меню кнопки в плеере,
//   __stand.toast() — плашка плеера, __stand.plToast() — плашка плейлистов на странице,
//   __stand.speech(запрос, вид) — «Поиск по речи» с вымышленными субтитрами.
// Адрес с &resume=1 — ролик открыт заново с нуля, а место сохранено: плашка
// «Вы остановились на 2:30 · Продолжить» (resume.js). С &sleep=fade — видео «играет» за 8 с
// до конца: таймер сна «в конце видео» сразу даёт плашку затухания с кнопкой (sleep.js).
// С &volume=1 у канала видео запомнена громкость 150 % — плашка «Громкость 150 % для
// канала «…» · Сбросить» (volume.js); __stand.playerPane() — экран меню «Плеер ›».
// С &frame=1 — «Снимок кадра» (frame-shot.js), __stand.frame() — как Shift+S, __stand.videoPane() —
// экран меню «Видео и превью ›».
// С &dual=1 — «Двойные субтитры» (dualsubs.js) с одной строкой (перевод не пришёл),
// с &dual=2 — оригинал и перевод; ответы плеера и timedtext — вымышленные.
// С &intro=1 у канала отмечено вступление до 0:42 — ролик с начала, плашка «Вступление
// пропущено · Вернуть» (intro.js); с &intro=offer вы уже дважды перематывали вступление
// канала в других видео — __stand.introSeek() перематывает и здесь: «Пропускать вступление
// канала — до 0:41? · Пропускать · Не надо».
// С &audio=1 — «Только звук» (audioonly.js): обложка вместо видео, плашка «Только звук для
// канала · Показать видео»; с &audio=2 — ещё и включённые субтитры с текущей фразой.
// __stand.ab(83, 101) — повтор отрезка 1:23–1:41 (abloop.js), __stand.abMenu() — меню с «Повтор отрезка».
(() => {
  const listeners = [];
  const msgListeners = [];
  const q = new URLSearchParams(location.search);
  const store = { settings: {}, plRecent: ["PL19", "PL2", "PL9"] };
  const CH = "UC" + "m".repeat(22);
  if (q.get("volume")) store.channelVolumes = { [CH]: { v: 150, n: "Уютный Майнкрафт", t: Date.now() } };
  // &notes=1 — заметки с таймкодами к этому видео (точки на полосе, notes.js)
  if (q.get("notes")) store.tcNotes = { dQw4w9WgXcQ: { title: "Стенд", channel: "Канал", len: 213, at: 3, items: [{ t: 18, text: "Вступление: о чём ролик", at: 1 }, { t: 95, text: "Главная мысль — без неё дальше не понять", at: 2 }, { t: 176, text: "Итог и ссылки в описании", at: 3 }] } };
  if (q.get("intro") === "1") store.channelIntros = { [CH]: { e: 42, n: "Уютный Майнкрафт", t: Date.now() } };
  if (q.get("intro") === "offer") store.introHints = { [CH]: { s: [{ v: "aaaaaaaaaaa", to: 41, at: 1 }, { v: "bbbbbbbbbbb", to: 44, at: 2 }], no: 0 } };
  if (q.get("resume")) store.resumeLong = { dQw4w9WgXcQ: { t: 150, d: 213, at: Date.now() - 3600000 } };
  const stub = {
    runtime: {
      id: "stand",
      getURL: (u) => "/" + u,
      getManifest: () => ({ version: "0.0.0", name: "стенд" }),
      sendMessage: async (m) => (m?.type === "ui:preview-info" ? null : { ok: true }),
      onMessage: { addListener: (f) => msgListeners.push(f) },
    },
    storage: {
      local: {
        get: async (k) => {
          const keys = k == null ? Object.keys(store) : Array.isArray(k) ? k : typeof k === "string" ? [k] : Object.keys(k);
          return Object.fromEntries(keys.filter((x) => x in store).map((x) => [x, structuredClone(store[x])]));
        },
        set: async (o) => {
          const ch = {};
          for (const [k, v] of Object.entries(o)) ch[k] = { oldValue: store[k], newValue: structuredClone(v) };
          Object.assign(store, structuredClone(o));
          listeners.forEach((f) => f(ch, "local"));
        },
        remove: async () => {},
      },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener: (f) => listeners.push(f), removeListener() {} },
    },
  };
  window.chrome = stub;

  // у макетного <video> нет файла — длительность и время задаём сами
  const mv = document.querySelector("#movie_player video");
  Object.defineProperty(mv, "duration", { configurable: true, get: () => 213 });
  let ct = q.get("resume") || q.get("intro") ? 0 : q.get("sleep") ? 205 : 61.4;
  Object.defineProperty(mv, "currentTime", { configurable: true, get: () => ct, set: (v) => (ct = v) });
  Object.defineProperty(mv, "readyState", { configurable: true, get: () => 4 });
  if (q.get("sleep") || q.get("volume") || q.get("intro")) mv.classList.add("html5-main-video");
  if (q.get("sleep")) {
    Object.defineProperty(mv, "paused", { configurable: true, get: () => false });
  }
  // «Снимок кадра» (frame-shot.js): &frame=1 — кадр 1280×720, буфер обмена принимает;
  // &frame=nocopy — буфер отказал (плашка длиннее, с «Сохранить»); &frame=wait — кадр не загружен
  if (q.get("frame")) {
    const fw = q.get("frame") === "wait" ? 0 : 1280;
    Object.defineProperty(mv, "videoWidth", { configurable: true, get: () => fw });
    Object.defineProperty(mv, "videoHeight", { configurable: true, get: () => (fw ? 720 : 0) });
    const deny = q.get("frame") === "nocopy";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write: async () => { if (deny) throw new DOMException("нет фокуса", "NotAllowedError"); } } });
  }

  // «Двойные субтитры»: список дорожек от «главного мира» (dualsubs-main.js) и json3
  if (q.get("dual")) {
    store.settings.dualSubs = true;
    const ev = (s, d, t) => ({ tStartMs: s, dDurationMs: d, segs: [{ utf8: t }] });
    const orig = { events: [ev(60000, 4000, "Hello, this is a cozy wooden house")] };
    const tr = { events: q.get("dual") === "2" ? [ev(60000, 4000, "Привет, это уютный деревянный дом")] : [] };
    const info = { vid: "dQw4w9WgXcQ", tracks: [{ lang: "en", kind: "", tr: true }], defaultIndex: 0, audioLang: "", url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&pot=STAND", live: false };
    document.addEventListener("ytcs-ds:ask", () => document.dispatchEvent(new CustomEvent("ytcs-ds:info", { detail: JSON.stringify(info) })));
    const realFetch = window.fetch.bind(window);
    window.fetch = async (u, o) => {
      const url = String(u);
      if (!url.includes("/api/timedtext")) return realFetch(u, o);
      return new Response(JSON.stringify(new URL(url).searchParams.get("tlang") ? tr : orig), { headers: { "Content-Type": "application/json" } });
    };
  }

  const TITLE = "Как построить уютный дом в Майнкрафте — полный гайд для новичков";
  // clip-main.js: «info» — название, длина, качества
  document.addEventListener("ytcs-clip", (e) => {
    const r = JSON.parse(e.detail);
    const post = (m) => window.postMessage({ __ytcsClip: r.id, ...m }, "*");
    if (r.op === "info") post({ type: "info", ok: true, title: TITLE, duration: 213, currentTime: 61.4, levels: ["hd1080", "hd720", "large"], live: false, ad: false });
  });
  // speed-main.js и volume-main.js: канал видео и громкость ползунка YouTube
  let ytVolume = 80;
  const answer = (type, data) => document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(data) }));
  document.addEventListener("ytcs-speed:ask", () => answer("ytcs-speed:info", { videoId: "dQw4w9WgXcQ", channelId: CH, name: "Уютный Майнкрафт", live: false }));
  document.addEventListener("ytcs-vol:ask", () => answer("ytcs-vol:info", { volume: ytVolume, muted: false }));
  document.addEventListener("ytcs-vol:set", (e) => (ytVolume = Number(e.detail)));
  // audioonly-main.js: название, канал и качества видео; «Только звук» у канала запомнен
  if (q.get("audio")) {
    store.audioOnlyChannels = { [CH]: { n: "Уютный Майнкрафт", t: Date.now() } };
    document.addEventListener("ytcs-ao:ask", () =>
      answer("ytcs-ao:info", { videoId: "dQw4w9WgXcQ", title: TITLE, author: "Уютный Майнкрафт", channelId: CH, live: false, quality: "hd720", levels: ["hd1080", "hd720", "large", "medium", "small", "tiny", "auto"] })
    );
    document.addEventListener("ytcs-ao:low", () => answer("ytcs-ao:done", { ok: true, q: "tiny" }));
    if (q.get("audio") === "2") {
      // субтитры YouTube включены — в слое субтитров текущая фраза
      const mp = document.getElementById("movie_player");
      const cap = document.createElement("div");
      cap.className = "ytp-caption-window-container";
      cap.innerHTML = '<div class="caption-window"><span class="caption-visual-line"><span class="ytp-caption-segment">Сегодня поговорим о том, как утеплить</span></span><span class="caption-visual-line"><span class="ytp-caption-segment">деревянный дом до первых морозов</span></span></div>';
      mp.appendChild(cap);
      document.querySelector(".ytp-subtitles-button")?.setAttribute("aria-pressed", "true");
    }
  }
  // playlists-main.js: вымышленные плейлисты
  const names = ["Музыка в дорогу", "Смотреть позже", "Танцы", "Кулинария: быстро", "Котики", "Подкасты", "Ремонт своими руками", "Английский", "Лучшие клипы 2026", "Смешное", "Обзоры техники", "Путешествия", "Спорт: тренировки", "Мультфильмы", "Лекции", "Игры", "Стендап", "Фильмы: трейлеры", "Музыка для работы", "Шортсы: танцы"];
  const pls = names.map((t, i) => ({ id: "PL" + i, title: t, privacy: i % 5 === 0 ? "PUBLIC" : i % 7 === 0 ? "UNLISTED" : "PRIVATE", contains: i === 2 || i === 19 }));
  document.addEventListener("ytcs-pl:2", (e) => {
    const r = JSON.parse(e.detail);
    const reply = (data) => setTimeout(() => window.postMessage({ __ytcsPl: r.id, ok: true, data }, "*"), 50);
    if (r.op === "list") reply(pls.map((p) => ({ ...p })));
    else if (r.op === "library") reply(pls.map((p, i) => ({ id: p.id, thumb: "", updated: i < 3 ? "Обновлено сегодня" : "Обновлено " + (i + 1) + " дн. назад" })));
    else reply(true);
  });

  // картинки превью: вместо i.ytimg.com — холст нужного размера (стенд без сети к YouTube)
  const sizes = { maxresdefault: [1280, 720], sddefault: [640, 480], hqdefault: [480, 360] };
  const pic = (w, h) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    const gr = g.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, "#5b6fa8");
    gr.addColorStop(1, "#1d2440");
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
    return c.toDataURL("image/png");
  };
  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    get() {
      return src.get.call(this);
    },
    set(v) {
      const m = /^https:\/\/i\.ytimg\.com\/vi\/[\w-]{11}\/(\w+)\.jpg$/.exec(String(v));
      src.set.call(this, m && sizes[m[1]] ? pic(...sizes[m[1]]) : v);
    },
  });

  // &ctx=1 — своё меню правого щелчка (ctxmenu.js): карточки справа (как рекомендации), описание
  // с таймкодом этого видео и ссылкой на другое; кнопки обложек (video-actions.js) и скорость
  // (speed.js) — только здесь, чтобы не менять другие стенды. &light=1 — светлая тема YouTube.
  if (q.get("light")) document.documentElement.removeAttribute("dark");
  if (q.get("ctx")) {
    window.__ytcsVideoActionsStand = true;
    document.title = TITLE + " - YouTube";
    document.body.classList.add("ctx");
    store.queue = [{ id: "vid00000003", title: "Первое в очереди" }, { id: "vid00000002", title: "Второе в очереди" }];
    const cards = [
      ["vid00000001", "Деревянный дом за 10 минут: быстрый гайд", "Уютный Майнкрафт", "10:42"],
      ["vid00000002", "Сад и огород у дома — всё, что нужно знать", "Садовник", "18:05"],
      ["vid00000003", "Подвал, который никто не найдёт", "Строитель", "7:31"],
    ];
    const side = document.createElement("div");
    side.id = "secondary";
    side.innerHTML = cards
      .map(([id, t, ch, len]) => `<yt-lockup-view-model><a href="https://www.youtube.com/watch?v=${id}" class="thumb"><yt-thumbnail-view-model><badge-shape class="yt-badge-shape__text" hidden>${len}</badge-shape></yt-thumbnail-view-model></a>
        <div><h3><a href="https://www.youtube.com/watch?v=${id}">${t}</a></h3><div class="meta yt-content-metadata-view-model__metadata-row"><a href="/@${id}">${ch}</a></div></div>
        <button class="more" aria-label="Ещё">⋮</button></yt-lockup-view-model>`)
      .join("");
    const desc = document.createElement("div");
    desc.id = "description";
    desc.innerHTML = `Строим дом с нуля. <a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=754s">12:34</a> — крыша, <a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=95s">1:35</a> — окна.
      Продолжение: <a href="https://www.youtube.com/watch?v=vid00000001">youtube.com/watch?v=vid00000001</a>`;
    document.getElementById("movie_player").after(side, desc);
    // вошли в аккаунт (кнопка аватара в шапке) — YouTube предлагает «Не интересует»
    document.body.insertAdjacentHTML("afterbegin", '<ytd-masthead hidden><button id="avatar-btn" aria-label="Аккаунт"></button></ytd-masthead>');
    for (const src of ["/video-actions.js", "/speed-core.js", "/speed.js"]) {
      const sc = document.createElement("script");
      sc.src = src;
      sc.async = false;
      document.body.append(sc);
    }
  }

  const fire = (msg) => msgListeners.forEach((f) => f(msg, {}, () => {}));
  window.__stand = {
    preview: () =>
      fire({ type: "yt:preview", title: TITLE, name: "Дом в Майнкрафте.jpg", urls: ["maxresdefault", "sddefault", "hqdefault"].map((q) => `https://i.ytimg.com/vi/dQw4w9WgXcQ/${q}.jpg`) }),
    clip: () => globalThis.__ytcsClip?.open(),
    playlists: () => globalThis.__ytcsPlaylists?.open({ videoId: "dQw4w9WgXcQ", title: TITLE }),
    menu: () => document.querySelector(".ytcs-btn")?.click(),
    // «Снимок кадра»: как клавиша Shift+S
    frame: () => globalThis.__ytcsFrameShot?.shoot(),
    // меню, экран «Видео и превью ›» (клип, снимок кадра, превью)
    videoPane: async () => {
      document.querySelector(".ytcs-btn")?.click();
      await new Promise((r) => setTimeout(r, 300));
      document.querySelector('.ytcs-menu [data-pane-open="video"]')?.click();
    },
    // меню, экран «Плеер ›» (переключатели, «Сбросить громкость канала»)
    playerPane: async () => {
      document.querySelector(".ytcs-btn")?.click();
      await new Promise((r) => setTimeout(r, 300));
      document.querySelector('.ytcs-menu [data-pane-open="player"]')?.click();
    },
    // вы сами перематываете вступление (щелчок по полосе): 0:00 → 0:43 (intro.js)
    introSeek: () => {
      document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      mv.currentTime = 43;
      mv.dispatchEvent(new Event("seeking"));
    },
    // поле заметки поверх плеера и подсказка у точки на полосе (notes.js)
    note: () => globalThis.__ytcsNotes?.open(),
    // повтор отрезка (abloop.js): отрезок 1:23–1:41 или только начало; меню с раскрытым «Повтор отрезка»
    ab: (a, b) => globalThis.__ytcsAb?.set(a, b),
    abMenu: async () => {
      globalThis.__ytcsAb?.set(83, null);
      document.querySelector(".ytcs-btn")?.click();
      await new Promise((r) => setTimeout(r, 300));
      document.querySelector('.ytcs-menu [data-act="ab"]')?.click();
    },
    noteTip: () => document.getElementById("ytcs-note-marks")?.shadowRoot.querySelectorAll(".d")[1]?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, composed: true })),
    // своё меню правого щелчка (ctxmenu.js) у элемента: el — селектор или элемент, dx/dy — от левого верхнего угла
    ctx: (el, dx = 24, dy = 24) => {
      const t = typeof el === "string" ? document.querySelector(el) : el;
      if (!t) return 0;
      const r = t.getBoundingClientRect();
      t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, button: 2, clientX: r.left + dx, clientY: r.top + dy }));
      return document.getElementById("ytcs-ctxmenu")?.shadowRoot.querySelectorAll(".it").length || 0;
    },
    // «Поиск по речи» (speech.js): окно с найденным; kind — "none" (нет субтитров) или "error"
    speech: async (q = "дом", kind = "") => {
      const lines = [[4, "Привет! Сегодня строим уютный дом в Майнкрафте"], [37, "Сначала фундамент: дом без него долго не простоит"],
        [95, "Окна ставим так, чтобы в доме было светло весь день, а свет падал на стол"], [148, "Крыша — самое долгое, но и самое красивое"],
        [212, "Вот и готов наш дом. Подписывайтесь, дальше будет сад!"]];
      globalThis.__ytcsGetTranscript = async () => {
        if (kind === "error") throw new Error("transcript:network стенд");
        return { segments: kind === "none" ? [] : lines.map(([t, text]) => ({ t, text })), chapters: [] };
      };
      globalThis.__ytcsSpeech?.open();
      const inp = document.getElementById("ytcs-speech")?.shadowRoot.querySelector("input");
      if (inp && !kind) {
        inp.value = q;
        inp.dispatchEvent(new Event("input"));
      }
    },
    toast: () => stub.storage.local.set({ settings: { ...store.settings, focusMode: true } }),
    // плашка плейлистов на странице: «быстрое сохранение» в последний плейлист
    plToast: () => globalThis.__ytcsPlaylists?.quickSave(),
  };
})();
