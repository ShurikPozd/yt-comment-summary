window.__errs = []; addEventListener("error", (e) => __errs.push(String(e.message || e.error))); addEventListener("unhandledrejection", (e) => __errs.push("rej: " + String(e.reason?.stack || e.reason).slice(0, 300)));
// Заглушка chrome.* для стенда «Моей библиотеки»: вымышленный каталог,
// задержки как у YouTube, обложки рисуются на холсте.
(() => {
  const qp = new URLSearchParams(location.search);
  if (qp.get("fresh")) indexedDB.deleteDatabase("ytcs-library");
  // ?mem=1 — база в памяти: безоконный Chrome с виртуальным временем не ждёт IndexedDB
  if (qp.get("mem")) {
    const store = new Map();
    const later = (f) => setTimeout(f, 0);
    const fakeDb = {
      createObjectStore() {},
      transaction() {
        const tx = {
          objectStore: () => ({
            get(k) {
              const r = { result: undefined };
              later(() => {
                r.result = store.get(k);
                tx.oncomplete?.();
              });
              return r;
            },
            put(v, k) {
              store.set(k, structuredClone(v));
              later(() => tx.oncomplete?.());
              return {};
            },
          }),
        };
        return tx;
      },
    };
    Object.defineProperty(window, "indexedDB", {
      value: {
        open() {
          const r = { result: fakeDb };
          later(() => r.onsuccess?.());
          return r;
        },
        deleteDatabase() {},
      },
    });
  }
  const PL = [
    ["WL", "Смотреть позже"], ["LL", "Понравившиеся"],
    ["P1", "Майнкрафт: постройки"], ["P2", "Кулинария на каждый день"], ["P3", "Котики и собаки"],
    ["P4", "Музыка в дорогу"], ["P5", "Английский с нуля"], ["P6", "Ремонт своими руками"],
    ["P7", "Путешествия"], ["P8", "Лекции по истории"], ["P9", "Гитара: разборы песен"],
    ["P10", "Программирование"], ["P11", "Фотография"], ["P12", "Смешное (Shorts)"],
  ];
  const CH = {
    P1: ["Блок за блоком", "CraftLab", "Пиксельный дом"], P2: ["Кухня за 15 минут", "Simple Cooking", "Мама готовит"],
    P3: ["Хвостатые", "Daily Cats", "Пёс Барон"], P4: ["Road Tunes", "Ночной эфир", "LoFi Station"],
    P5: ["English Easy", "Говорим по-английски", "Phrasal Daily"], P6: ["Мастер на час", "DIY Garage", "Ремонт без боли"],
    P7: ["Вокруг света", "Travel Notes", "Рюкзак и карта"], P8: ["Лекторий", "History Talks", "Архив времени"],
    P9: ["Гитара просто", "Аккорды и бой", "Fingerstyle Lab"], P10: ["Код с нуля", "Dev Notes", "JS по-простому"],
    P11: ["Свет и кадр", "Photo Walks", "Объектив"], P12: ["Смешные моменты", "LOL Daily", "Котопёс"],
  };
  const T = {
    P1: ["Как построить уютный дом в Майнкрафте", "Майнкрафт: современная вилла за 20 минут", "Ферма железа — самая простая схема", "Средневековый замок: постройка шаг за шагом", "Minecraft: 10 идей для выживания", "Подводная база в майнкрафте", "Красивый мост через реку", "Деревенский рынок — постройка для сервера", "Автоматическая ферма тыкв", "Японский домик с садом"],
    P2: ["Сырники как в кафе — простой рецепт", "Паста карбонара за 15 минут", "Борщ, который получается всегда", "Easy cooking: овсянка на неделю", "Пельмени домашние — рецепт теста", "Шакшука на завтрак", "Курица в духовке с картошкой", "Блины на молоке тонкие", "Рамен дома — простой рецепт", "Салат за 5 минут"],
    P3: ["Котики, которые не умеют прыгать", "Кот впервые видит снег", "Собака учит щенка плавать", "Самые ленивые коты недели", "Котёнок и робот-пылесос", "Пёс охраняет кота", "Cats vs cucumbers — compilation", "Кошка открывает двери сама"],
    P4: ["Музыка в дорогу — 2 часа без рекламы", "Ночная трасса: синтвейв", "LoFi для работы и учёбы", "Акустика у костра", "Летний плейлист 2026", "Спокойная музыка для поездки", "Рок-хиты для дороги", "Джаз на вечер"],
    P5: ["Английский с нуля: урок 1 — алфавит", "Present Simple за 10 минут", "100 фраз для путешествий", "Phrasal verbs, которые нужны каждый день", "Как перестать бояться говорить", "Английский по сериалам", "Неправильные глаголы — легко запомнить", "Small talk: как поддержать разговор"],
    P6: ["Как поклеить обои ровно", "Ремонт ванной своими руками", "Ламинат: укладка без ошибок", "Как починить капающий кран", "Покраска стен — секреты мастера", "Полка своими руками из досок", "Розетка: замена за 5 минут", "Шумоизоляция квартиры"],
    P7: ["Грузия за 7 дней: маршрут", "Байкал зимой — что посмотреть", "Стамбул: куда сходить бесплатно", "Путешествие по Алтаю на машине", "Япония: первые впечатления", "Как собрать рюкзак в поход", "Карелия: водопады и озёра", "Дешёвые перелёты — как искать"],
    P8: ["Древний Рим за 20 минут", "Как жили викинги", "История письменности", "Средневековые замки: правда и мифы", "Великие географические открытия", "Египетские пирамиды — как строили", "История шахмат", "Как появились деньги"],
    P9: ["Разбор песни на гитаре: простые аккорды", "Бой шестёрка — как играть", "Fingerstyle для начинающих", "Баррэ без боли", "Пять песен на трёх аккордах", "Как настроить гитару по слуху", "Перебор восьмёрка", "Соло для начинающих"],
    P10: ["JavaScript с нуля: переменные", "Git за 15 минут", "Как работает интернет", "Python: первая программа", "CSS Grid — понятно и наглядно", "Async/await простыми словами", "Расширение для Chrome за вечер", "Алгоритмы: бинарный поиск"],
    P11: ["Как снимать на телефон красиво", "Портрет при окне — свет", "Ночная съёмка города", "Композиция: правило третей", "Обработка фото за 5 минут", "Пейзаж на рассвете", "Какой объектив купить первым", "Уличная фотография: советы"],
    P12: ["Кот против коробки", "Когда пятница", "Собака и мяч", "Неудачный прыжок", "Ожидание и реальность", "Попугай поёт", "Утро понедельника", "Танцующий робот"],
  };
  const vids = [];
  const by = {};
  let seq = 7;
  const rnd = (n) => {
    seq = (seq * 9301 + 49297) % 233280;
    return Math.floor((seq / 233280) * n);
  };
  for (const [pid] of PL.slice(2)) {
    by[pid] = [];
    for (const t of T[pid]) {
      const id = ("v" + pid + "_" + by[pid].length).padEnd(11, "x").slice(0, 11);
      const short = pid === "P12";
      const v = { id, title: t, channel: short ? "" : CH[pid][rnd(3)], channelId: "", len: short ? 0 : 60 + rnd(3200), short, info: `${1 + rnd(900)} тыс. • ${1 + rnd(11)} мес. назад`, setId: "", pos: by[pid].length + 1, hue: rnd(360) };
      by[pid].push(v);
      vids.push(v);
    }
  }
  by.WL = vids.filter((_, i) => i % 3 === 0).slice(0, 40);
  // для «Порядка в плейлистах»: повтор с номером записи и удалённое видео
  by.P1 = by.P1.map((v, i) => ({ ...v, setId: "S" + i }));
  by.P1.push({ ...by.P1[0], setId: "S-dup" }, { ...by.P1[2], setId: "S-dup2" });
  by.P2.push({ id: "gonexxxxxxx", title: "[Удалённое видео]", channel: "", len: 0, setId: "S-gone" });
  by.LL = vids.filter((_, i) => i % 4 === 1).slice(0, 30);
  const byId = new Map(vids.map((v) => [v.id, v]));
  const delay = Number(qp.get("delay") || 120);
  const reply = (data) => new Promise((r) => setTimeout(() => r({ ok: true, data }), delay));
  async function bridge(op, a) {
    if (qp.get("fail") && op === "playlists") return { ok: false, error: qp.get("fail") };
    if (op === "playlists") return reply(PL.filter(([id]) => id !== "LL").map(([id, title]) => ({ id, title, privacy: "PRIVATE" })));
    if (op === "library") return reply([]);
    if (op === "editMany") return reply(a.videoIds.length);
    if (op === "removeItems") return reply(a.items.length);
    if (op === "page") {
      const all = by[a.playlistId] || [];
      const from = a.token ? Number(a.token) : 0;
      const items = all.slice(from, from + 6).map((v, i) => ({ ...v, pos: from + i + 1 }));
      return reply({ items, next: from + 6 < all.length ? String(from + 6) : null });
    }
    return { ok: false, error: "fail" };
  }
  // хранилище и очередь (как в background.js, упрощённо)
  const local = {};
  const listeners = [];
  const setLocal = (obj) => {
    const ch = {};
    for (const [k, v] of Object.entries(obj)) {
      ch[k] = { oldValue: local[k], newValue: v };
      local[k] = structuredClone(v);
    }
    listeners.forEach((f) => f(ch, "local"));
  };
  // &limit=1 — «Статистика» с карточкой «Мягкий лимит»: включён, 2 ч, сегодня 1 ч 40 мин
  // (&limit=over — 2 ч 15 мин, &limit=off — выключен); заодно немного статистики за 30 дней
  if (qp.get("limit")) {
    const pad = (n) => String(n).padStart(2, "0");
    const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const now = new Date();
    const lday = key(now.getHours() < 4 ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12) : now);
    const days = {};
    for (let i = 0; i < 30; i++) days[key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12))] = { w: 1800 + ((i * 2654) % 6000), s: i % 3 ? 300 : 0, sp: 400, n: 4, fin: 2 };
    local.watchStats = { v: 1, since: Date.now() - 31 * 864e5, days, ch: { UCaaaaaaaaaaaaaaaaaaaaaa: { n: "Уютный дом", t: Date.now(), a: 40000, d: { [key(now)]: 3000 } } } };
    local.watchLimit = { on: qp.get("limit") !== "off", min: 120 };
    local.watchLimitDay = { day: lday, sec: qp.get("limit") === "over" ? 8100 : 6000, lim: 0, next: null, done: false };
    if (qp.get("nostats")) local.settings = { ...(local.settings || {}), watchStats: false };
  }
  if (qp.get("queue")) {
    const pick = vids.filter((_, i) => i % 3 === 1).slice(0, Number(qp.get("queue")) || 24);
    local.queue = pick.map((v, i) => ({ id: v.id, title: v.title, channel: v.channel, len: v.len, short: v.short, addedAt: Date.now() - i * 3600e3 * 7 }));
    local.queuePos = Object.fromEntries(pick.filter((_, i) => i % 4 === 0).map((v) => [v.id, Math.floor(v.len * 0.4)]));
    // для «Уборки очереди»: залежалось (больше 60 дней, не начато; №20 — старое, но начато),
    // почти досмотрено (95%), два недоступных (удалённое и приватное — ответы oEmbed ниже) и дубль
    const DAY = 24 * 3600e3;
    [[19, 74], [20, 96], [21, 88], [22, 117], [23, 143]].forEach(([i, d]) => local.queue[i] && (local.queue[i].addedAt = Date.now() - d * DAY));
    if (pick[5]) local.queuePos[pick[5].id] = Math.floor(pick[5].len * 0.95);
    if (local.queue.length > 12) {
      local.queue.splice(3, 0, { id: "xGoneDel001", title: "Обзор нового телефона — честная распаковка", channel: "Tech Today", len: 912, short: false, addedAt: Date.now() - 30 * 3600e3 });
      local.queue.splice(11, 0, { id: "xPrivate002", title: "Стрим: собираем ПК с подписчиками", channel: "Железный цех", len: 7420, short: false, addedAt: Date.now() - 80 * 3600e3 });
      local.queue.push({ ...local.queue[2] });
    }
    if (qp.get("real")) Object.assign(local.queue[0], { id: "jNQXAC9IVRw", title: "Me at the zoo", channel: "jawed", len: 19 });
    if (qp.get("undo")) local.queueUndo = { at: Date.now() - 60e3, added: [], tabs: pick.slice(0, 18).map((v) => ({ url: "https://www.youtube.com/watch?v=" + v.id })) };
  }
  // ?notes=1 — заметки с таймкодами (раздел «Заметки», notes-view.js); &tg=1 — бот настроен
  if (qp.get("notes")) {
    const NOTES = [
      [by.P2[0], ["Творог — 9 %, отжать через марлю, иначе сырники расплывутся", "Мука только в конце, 2 ложки на 400 г", "Жарить под крышкой 3 минуты с каждой стороны", "Подавать со сметаной и вареньем"], [42, 118, 305, 512]],
      [by.P10[1], ["git switch -c — новая ветка одной командой", "rebase против merge: когда что", "Отменить последний коммит, но оставить правки: git reset --soft HEAD~1"], [65, 401, 733]],
      [by.P7[0], ["Тбилиси → Мцхета на маршрутке, 1 час", "Сигнахи: смотровая площадка на закате"], [134, 1022]],
      [by.P5[1], ["Present Simple — привычки и расписания, не «сейчас»"], [77]],
    ];
    local.tcNotes = {};
    NOTES.forEach(([v, texts, ts], k) => {
      local.tcNotes[v.id] = { title: v.title, channel: v.channel, len: v.len, at: Date.now() - k * 3600e3, items: texts.map((text, i) => ({ t: Math.min(ts[i], v.len - 5), text, at: Date.now() - k * 3600e3 - (texts.length - i) * 60e3 })) };
    });
  }
  if (qp.get("tg")) local.settings = { ...(local.settings || {}), baseUrl: "https://bot.example", token: "stand" };
  async function onMsg(msg) {
    const q = local.queue || [];
    if (msg.type === "queue:count") return { ok: true, n: Number(qp.get("tabs") || 37) };
    if (msg.type === "queue:add") {
      const have = new Set(q.map((x) => x.id));
      const add = msg.items.filter((x) => !have.has(x.id)).map((x) => ({ ...x, addedAt: Date.now() }));
      setLocal({ queue: [...q, ...add] });
      return { ok: true, added: add.map((x) => x.id), total: q.length + add.length };
    }
    if (msg.type === "queue:remove") {
      const pos = { ...(local.queuePos || {}) };
      for (const id of msg.ids) delete pos[id];
      setLocal({ queue: q.filter((x) => !msg.ids.includes(x.id)), queuePos: pos });
      return { ok: true };
    }
    if (msg.type === "queue:put") {
      // как restoreAt в background.js: каждое — на прежнее место, по возрастанию места
      const out = q.slice();
      const pos = { ...(local.queuePos || {}) };
      const items = msg.items.filter((it) => !out.some((x) => x.id === it.rec.id)).sort((a, b) => a.at - b.at);
      for (const it of items) {
        out.splice(Math.min(it.at, out.length), 0, it.rec);
        if (it.t > 5) pos[it.rec.id] = it.t;
      }
      setLocal({ queue: out, queuePos: pos });
      return { ok: true, back: items.length, total: out.length };
    }
    if (msg.type === "queue:top") {
      const i = q.findIndex((x) => x.id === msg.id);
      if (i > 0) q.unshift(...q.splice(i, 1));
      setLocal({ queue: q });
      return { ok: true };
    }
    if (msg.type === "queue:opts") {
      setLocal({ queueOpts: { ...(local.queueOpts || {}), ...msg.patch } });
      return { ok: true };
    }
    if (msg.type === "queue:collect") {
      const extra = vids.filter((_, i) => i % 5 === 2).slice(0, 12).filter((v) => !q.some((x) => x.id === v.id));
      setLocal({ queue: [...q, ...extra.map((v) => ({ id: v.id, title: v.title, channel: v.channel, len: v.len, addedAt: Date.now() }))], queueUndo: { at: Date.now(), added: extra.map((v) => v.id), tabs: extra.map((v) => ({ url: v.id })) } });
      return { ok: true, collected: extra.length };
    }
    return { ok: true };
  }
  window.chrome = {
    runtime: { getURL: (p) => "/" + p, getManifest: () => ({ version: "0.0.0-стенд" }), sendMessage: async (m) => onMsg(m) },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, structuredClone(local[k])])),
        set: async (o) => setLocal(o),
      },
      onChanged: { addListener: (f) => listeners.push(f) },
    },
    scripting: { executeScript: async ({ args, files }) => (files ? [{}] : [{ result: await bridge(args[1], args[2]) }]) },
    tabs: {
      query: async () => [{ id: 1, status: "complete", url: "https://www.youtube.com/", lastAccessed: 1 }],
      get: async () => ({ id: 1, status: "complete", url: "https://www.youtube.com/" }),
      create: async () => ({ id: 1 }),
      update: async () => ({}),
      remove: async () => {},
      onUpdated: { addListener() {}, removeListener() {} },
    },
  };
  // проверка доступности («Уборка очереди»): oEmbed и страница видео без сети.
  // xGoneDel001 — удалено (404), xPrivate002 — приватное (401, на странице LOGIN_REQUIRED)
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    const oembed = u.includes("youtube.com/oembed");
    if (!oembed && !/youtube\.com\/watch\?v=/.test(u)) return realFetch(url, opts);
    const id = u.match(/[?&]v=([\w-]{11})/)?.[1] || "";
    await new Promise((r) => setTimeout(r, Number(qp.get("odelay") || 60)));
    if (opts.signal?.aborted) throw new DOMException("Отменено", "AbortError");
    if (oembed) {
      const st = id === "xGoneDel001" ? 404 : id === "xPrivate002" ? 401 : 200;
      return new Response(st === 200 ? JSON.stringify({ title: byId.get(id)?.title || "", author_name: "" }) : "Not Found", { status: st });
    }
    const st = id === "xPrivate002" ? '"LOGIN_REQUIRED","reason":"This video is private"' : '"OK"';
    return new Response(`<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":${st}}};</script>`, { status: 200 });
  };
  // обложки: градиент с подписью вместо i.ytimg.com
  const cache = new Map();
  function thumb(id) {
    if (cache.has(id)) return cache.get(id);
    // удалённое и приватное — серая заглушка, как у YouTube
    if (/^x(Gone|Priv)/.test(id)) {
      const c = document.createElement("canvas");
      c.width = 320;
      c.height = 180;
      const g = c.getContext("2d");
      g.fillStyle = "#3b3b40";
      g.fillRect(0, 0, 320, 180);
      const url = c.toDataURL("image/png");
      cache.set(id, url);
      return url;
    }
    const v = byId.get(id) || { hue: 200, title: "" };
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 180;
    const g = c.getContext("2d");
    const gr = g.createLinearGradient(0, 0, 320, 180);
    gr.addColorStop(0, `hsl(${v.hue} 55% 42%)`);
    gr.addColorStop(1, `hsl(${(v.hue + 50) % 360} 60% 22%)`);
    g.fillStyle = gr;
    g.fillRect(0, 0, 320, 180);
    g.fillStyle = "rgba(255,255,255,.12)";
    g.beginPath();
    g.arc(250, 40, 90, 0, 7);
    g.fill();
    g.fillStyle = "#fff";
    g.font = "700 22px Segoe UI, sans-serif";
    const lines = [];
    let line = "";
    for (const w of (v.title || "").split(" ")) {
      if (line && g.measureText(line + w).width > 280) {
        lines.push(line);
        line = "";
      }
      line += w + " ";
    }
    lines.push(line);
    lines.slice(0, 2).forEach((l, i) => g.fillText(l.trim(), 18, 132 + i * 26 - (lines.length > 1 ? 26 : 0)));
    const url = c.toDataURL("image/jpeg", 0.85);
    cache.set(id, url);
    return url;
  }
  new MutationObserver(() => {
    for (const img of document.querySelectorAll('img[src*="i.ytimg.com/vi/"]')) img.src = thumb(img.src.split("/vi/")[1].split("/")[0]);
  }).observe(document, { subtree: true, childList: true });
  if (qp.get("theme")) localStorage.setItem("ytcs:theme", qp.get("theme"));
})();
globalThis.__ytcsVideoActionsStand = true;
