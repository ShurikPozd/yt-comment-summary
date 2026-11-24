// Стенд «страница YouTube»: заглушка chrome.* для контент-скриптов, вымышленные
// ответы «главного мира» (clip-main.js, playlists-main.js) и помощники для замера:
//   __stand.preview() — окно превью, __stand.clip() — окно клипа,
//   __stand.playlists() — «Сохранить в плейлисты», __stand.menu() — меню кнопки в плеере,
//   __stand.toast() — плашка плеера, __stand.plToast() — плашка плейлистов на странице.
// Адрес с &resume=1 — ролик открыт заново с нуля, а место сохранено: плашка
// «Вы остановились на 2:30 · Продолжить» (resume.js). С &sleep=fade — видео «играет» за 8 с
// до конца: таймер сна «в конце видео» сразу даёт плашку затухания с кнопкой (sleep.js).
(() => {
  const listeners = [];
  const msgListeners = [];
  const q = new URLSearchParams(location.search);
  const store = { settings: {}, plRecent: ["PL19", "PL2", "PL9"] };
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
  let ct = q.get("resume") ? 0 : q.get("sleep") ? 205 : 61.4;
  Object.defineProperty(mv, "currentTime", { configurable: true, get: () => ct, set: (v) => (ct = v) });
  Object.defineProperty(mv, "readyState", { configurable: true, get: () => 4 });
  if (q.get("sleep")) {
    mv.classList.add("html5-main-video");
    Object.defineProperty(mv, "paused", { configurable: true, get: () => false });
  }

  const TITLE = "Как построить уютный дом в Майнкрафте — полный гайд для новичков";
  // clip-main.js: «info» — название, длина, качества
  document.addEventListener("ytcs-clip", (e) => {
    const r = JSON.parse(e.detail);
    const post = (m) => window.postMessage({ __ytcsClip: r.id, ...m }, "*");
    if (r.op === "info") post({ type: "info", ok: true, title: TITLE, duration: 213, currentTime: 61.4, levels: ["hd1080", "hd720", "large"], live: false, ad: false });
  });
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

  const fire = (msg) => msgListeners.forEach((f) => f(msg, {}, () => {}));
  window.__stand = {
    preview: () =>
      fire({ type: "yt:preview", title: TITLE, name: "Дом в Майнкрафте.jpg", urls: ["maxresdefault", "sddefault", "hqdefault"].map((q) => `https://i.ytimg.com/vi/dQw4w9WgXcQ/${q}.jpg`) }),
    clip: () => globalThis.__ytcsClip?.open(),
    playlists: () => globalThis.__ytcsPlaylists?.open({ videoId: "dQw4w9WgXcQ", title: TITLE }),
    menu: () => document.querySelector(".ytcs-btn")?.click(),
    toast: () => stub.storage.local.set({ settings: { ...store.settings, focusMode: true } }),
    // плашка плейлистов на странице: «быстрое сохранение» в последний плейлист
    plToast: () => globalThis.__ytcsPlaylists?.quickSave(),
  };
})();
