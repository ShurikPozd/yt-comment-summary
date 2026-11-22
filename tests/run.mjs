// Автопроверки без браузера: node tests/run.mjs
//   - поиск «Моей библиотеки» (опечатки, основы слов, раскладка, исключения, подсветка);
//   - разбор ответов YouTube в playlists-main.js на маленьких образцах — по одному на
//     каждый формат, который YouTube уже успел поменять (старый и новый вид видео,
//     Shorts плиткой, токены продолжения в разных местах, шапка плейлиста);
//   - быстрое обновление библиотеки: что изменилось в плейлисте (library/sync-plan.js);
//   - подсказки адресной строки «yt …» (omnibox-core.js): XML, выбор, подсветка, очередь.
// Запускается из check-syntax.sh перед коммитом.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildIndex, search, highlight, stem, swapLayout, tokens } from "../library/search.js";
import { parseTldr, pickEven, runTldr, splitParts } from "../tldr-core.js";
import { createPacer, isOutputLimitError, isSizeLimitError, retryAfterMs } from "../groq.js";
import { countOf, dayOf, fullDue, listsOf, readPlaylist, sameList, splice, syncSummary, updDay } from "../library/sync-plan.js";
import { buildData, describe, escapeXml, fingerprint, parseInput, suggest, videoIdOf, videoUrl } from "../omnibox-core.js";
import { SHIFT, addDoc, chunkSegments, createIndex, decodeBlocks, encodeBlocks, pack, searchSubs, snippet, unpack, words } from "../library/subs-core.js";

let failed = 0;
let passed = 0;
function ok(cond, name) {
  if (cond) passed++;
  else {
    failed++;
    console.log("FAIL", name);
  }
}

// ---------- поиск ----------
const docs = [
  { title: "Котики спят на подоконнике", channel: "Мур" },
  { title: "НАРКОТИКИ VS СБЕРБАНК", channel: "x" },
  { title: "Как построить дом в Майнкрафте", channel: "Blocks", playlists: ["Майнкрафт: постройки"] },
  { title: "Easy cooking for kids", channel: "Chef" },
  { title: "Привет, мир", channel: "a" },
  { title: "Музыка remix", channel: "a" },
  { title: "Музыка спокойная", channel: "a", playlists: ["Для работы"] },
  { title: "Который час", channel: "b" },
];
const ix = buildIndex(docs);
const titles = (q) => (search(ix, q).results || []).map((r) => docs[r.d].title);
ok(stem("котики") === "котик" && stem("cooking") === "cook" && stem("майнкрафте") === "майнкрафт", "основы слов");
ok(swapLayout("ghbdtn") === "привет", "раскладка: буквы");
ok(titles("котики")[0] === "Котики спят на подоконнике" && !titles("котики").includes("НАРКОТИКИ VS СБЕРБАНК"), "котики — не «наркотики»");
ok(titles("майнкрафр")[0] === "Как построить дом в Майнкрафте", "опечатка");
ok(titles("постройка майнкрафт")[0] === "Как построить дом в Майнкрафте", "родственные основы");
ok(titles("cook")[0] === "Easy cooking for kids", "английские окончания");
ok(search(ix, "ghbdtn").swapped === "привет" && titles("ghbdtn")[0] === "Привет, мир", "запрос не в той раскладке");
ok(JSON.stringify(titles("музыка -remix")) === JSON.stringify(["Музыка спокойная"]), "исключение -слово");
ok(titles("для работы")[0] === "Музыка спокойная", "поиск по названию плейлиста");
ok(search(ix, "   ").results === null, "пустой запрос");
const hl = highlight("Как построить дом в Майнкрафте", search(ix, "майнкрафт").results[0].hits);
ok(hl.some((p) => p.hit && p.t === "Майнкрафте"), "подсветка исходного слова");
ok(highlight("Ёлка ёжик", new Set(["елка"])).some((p) => p.hit && p.t === "Ёлка"), "подсветка с ё");

// ---------- поиск по субтитрам (library/subs-core.js) ----------
{
  const segs = (list) => list.map(([t, text]) => ({ t, text }));
  const b1 = chunkSegments(segs([[0, "привет  друзья"], [3, "сегодня соберём"], [9, "компьютер"], [26, "сначала ставим"], [30, "блок питания"], [61, "потом видеокарту"]]));
  ok(b1.length === 3 && b1[0].t === 0 && b1[0].text === "привет друзья сегодня соберём компьютер" && b1[1].t === 26 && b1[2].t === 61, "субтитры режутся на блоки ~25 с");
  ok(chunkSegments(segs([[0, "  "], [1, "x"]])).length === 1 && chunkSegments([]).length === 0, "пустые кусочки пропускаются");
  const huge = chunkSegments(Array.from({ length: SHIFT * 2 }, (_, i) => ({ t: i * 30, text: "слово" })));
  ok(huge.length < SHIFT, "очень длинное видео — блоки крупнее, номер помещается");
  ok(JSON.stringify(decodeBlocks(encodeBlocks([{ t: 5, text: "a\tb\nc" }]))) === JSON.stringify([{ t: 5, text: "a b c" }]), "упаковка блоков: табуляции и переводы строк");
  const z = await pack(b1);
  ok(JSON.stringify(await unpack(z)) === JSON.stringify(b1) && z.byteLength < encodeBlocks(b1).length * 2, "сжатие и обратно");

  const ix = createIndex();
  addDoc(ix, "pc", b1);
  addDoc(ix, "cook", chunkSegments(segs([[0, "разбиваем яйца на сковороду"], [12, "добавляем помидоры и перец"], [40, "шакшука готова"], [70, "про блок рекламы"], [100, "питания хватит надолго"]])));
  addDoc(ix, "mc", chunkSegments(segs([[0, "строим дом в майнкрафте"], [30, "крыша из блоков и блокнот"]])));
  const ids = (q) => searchSubs(ix, q).results.map((r) => r.id);
  const first = (q) => searchSubs(ix, q).results[0];
  ok(first("блок питания")?.id === "pc" && first("блок питания").t === 26, "фраза в одном блоке — первой, со своим таймкодом");
  ok(ids("блок питания").join() === "pc,cook", "слова врозь в одном видео — ниже");
  ok(first("яйца помидоры")?.id === "cook" && first("яйца помидоры").t === 0, "слова в соседних блоках — таймкод первого");
  ok(first("видеокарта")?.id === "pc" && first("видеокарта").t === 61, "другая форма слова");
  ok(ids("майнкр").join() === "mc", "недописанное слово");
  ok(JSON.stringify(searchSubs(ix, "блок").terms) === JSON.stringify([["блок"]]) && JSON.stringify(searchSubs(ix, "блокн").terms) === JSON.stringify([["блокнот"]]), "дописанное слово не тянет похожие («блок» ≠ «блокнот»)");
  ok(ids("блок -реклама").join() === "pc,mc", "минус-слово исключает видео");
  ok(searchSubs(ix, "   ").results.length === 0 && searchSubs(ix, "квазар").results.length === 0, "пусто и не найдено");
  ok(first("блок питания").score > first("блок питания").score - 1 && first("блок питания").score <= 1, "оценка 0..1");
  addDoc(ix, "pc", chunkSegments(segs([[0, "обновлённое видео про корпус"]])));
  ok(!ids("видеокарта").includes("pc") && ids("корпус").join() === "pc", "видео перечитано — старые субтитры не ищутся");

  const long = chunkSegments(segs([[0, "раз два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать тринадцать четырнадцать пятнадцать шестнадцать"], [10, "семнадцать восемнадцать девятнадцать двадцать двадцать один двадцать два"], [20, "блок питания на 750 ватт хватит для видеокарты"], [26, "дальше охлаждение"]]));
  const r = searchSubs((() => { const x = createIndex(); addDoc(x, "a", long); return x; })(), "питания видеокарты");
  const sn = snippet(long, r.results[0].b, r.terms);
  ok(sn.text.startsWith("…") && sn.text.includes("блок питания на 750 ватт") && sn.hits.includes("питания") && sn.hits.includes("видеокарты"), "фрагмент вокруг найденного, слова для подсветки");
  ok(highlight(sn.text, new Set(sn.hits)).filter((p) => p.hit).length === 2, "подсветка фрагмента");
  const same = (t) => words(t).join() === tokens(t).filter((w) => w.length > 1).join();
  ok(["Ёлка и ЁЖИК, 100% OK!", "Café naïve — résumé", "Привет, мир: «блок» питания"].every(same), "быстрый разбор слов = обычному (ё, диакритика)");
}

// ---------- разбор ответов YouTube (playlists-main.js) ----------
// Скрипт живёт в мире страницы и общается событиями; запускаем его в песочнице
// с поддельными document/window/fetch и отвечаем образцами вместо YouTube.
function loadMain(responder) {
  const listeners = {};
  const posted = [];
  const ctx = {
    console,
    window: {},
    document: {
      cookie: "SAPISID=abc",
      addEventListener: (ev, fn) => (listeners[ev] = fn),
    },
    location: { origin: "https://www.youtube.com" },
    crypto: globalThis.crypto,
    TextEncoder,
    URL,
    fetch: async (url, opts) => {
      const body = JSON.parse(opts.body);
      const json = responder(url, body);
      return { ok: true, status: 200, json: async () => json };
    },
    CustomEvent: class {},
  };
  ctx.window = ctx;
  ctx.window.ytcfg = { get: (k) => ({ INNERTUBE_CONTEXT: { client: {} }, SESSION_INDEX: 0 })[k] };
  ctx.window.postMessage = (m) => posted.push(m);
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("../playlists-main.js", import.meta.url), "utf8"), ctx);
  const ev = Object.keys(listeners).find((k) => k.startsWith("ytcs-pl"));
  return (op, args = {}) =>
    new Promise((resolve) => {
      const id = "t" + Math.random();
      listeners[ev]({ detail: JSON.stringify({ ...args, op, id }) });
      const wait = () => {
        const m = posted.find((x) => x.__ytcsPl === id);
        if (m) resolve(m);
        else setTimeout(wait, 5);
      };
      wait();
    });
}

const run = (r) => ({ runs: [{ text: r }] });
const renderer = (id, n) => ({
  playlistVideoRenderer: {
    videoId: id,
    title: run("Видео " + n),
    shortBylineText: { runs: [{ text: "Канал", navigationEndpoint: { browseEndpoint: { browseId: "UCxxxxxxxxxxxxxxxxxxxxxx" } } }] },
    lengthSeconds: "125",
    videoInfo: run("1 тыс. • 2 дня назад"),
    setVideoId: "S" + n,
    index: { simpleText: String(n) },
  },
});
const lockup = (id) => ({
  lockupViewModel: {
    contentId: id,
    contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
    contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: "1:02:03" } }] } }] } },
    metadata: {
      lockupMetadataViewModel: {
        title: { content: "Новый формат" },
        metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: "Автор" } }] }, { metadataParts: [{ text: { content: "5 млн" } }, { text: { content: "год назад" } }] }] } },
      },
    },
  },
});
const shorts = (id) => ({
  shortsLockupViewModel: {
    onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: id } } },
    overlayMetadata: { primaryText: { content: "Шортс" }, secondaryText: { content: "1,3 млн просмотров" } },
  },
});
// токены продолжения — во всех местах, где YouTube их уже держал
const contOld = { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "T-OLD" } } } };
const contExec = { continuationItemRenderer: { continuationEndpoint: { commandExecutorCommand: { commands: [{}, { continuationCommand: { token: "T-EXEC" } }] } } } };
const contVM = { continuationItemViewModel: { continuationCommand: { innertubeCommand: { continuationCommand: { token: "T-VM" } } } } };

const pages = {
  "VLWL": { contents: [renderer("aaaaaaaaaaa", 1), renderer("bbbbbbbbbbb", 2), contExec] },
  "T-EXEC": { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [renderer("ccccccccccc", 3), contOld] } }] },
  "T-OLD": { contents: [renderer("ddddddddddd", 4)] },
  "VLLL": { contents: [lockup("eeeeeeeeeee"), contVM] },
  "T-VM": { contents: [lockup("fffffffffff")] },
  "VLPLshorts": { contents: [shorts("ggggggggggg"), shorts("hhhhhhhhhhh")] },
};
const call = loadMain((url, body) => {
  if (url.includes("get_add_to_playlist"))
    return { contents: [{ addToPlaylistRenderer: { playlists: [{ playlistAddToOptionRenderer: { playlistId: "PL1", title: { simpleText: "Мой" }, privacy: "PRIVATE", containsSelectedVideos: "NONE" } }] } }] };
  return pages[body.browseId || body.continuation] || {};
});

const wl1 = await call("page", { playlistId: "WL" });
ok(wl1.ok && wl1.data.items.length === 2 && wl1.data.next === "T-EXEC", "старый формат + токен в commandExecutorCommand");
ok(wl1.data.items[0].title === "Видео 1" && wl1.data.items[0].channel === "Канал" && wl1.data.items[0].len === 125 && wl1.data.items[0].setId === "S1", "поля старого формата");
const wl2 = await call("page", { playlistId: "WL", token: "T-EXEC", from: 2 });
ok(wl2.data.items[0].id === "ccccccccccc" && wl2.data.next === "T-OLD", "продолжение + токен прямо в continuationEndpoint");
const ll = await call("page", { playlistId: "LL" });
ok(ll.data.items[0].title === "Новый формат" && ll.data.items[0].len === 3723 && ll.data.items[0].channel === "Автор" && ll.data.next === "T-VM", "lockupViewModel + continuationItemViewModel");
const sh = await call("page", { playlistId: "PLshorts" });
ok(sh.data.items.length === 2 && sh.data.items[0].short && sh.data.items[0].title === "Шортс", "Shorts плиткой (shortsLockupViewModel)");
const pls = await call("playlists");
ok(pls.ok && pls.data[0].id === "PL1" && pls.data[0].title === "Мой" && !("contains" in pls.data[0]), "список плейлистов");

let sentActions = null;
const call2 = loadMain((url, body) => {
  if (url.includes("edit_playlist")) {
    sentActions = body.actions;
    return { status: "STATUS_SUCCEEDED" };
  }
  return {};
});
const em = await call2("editMany", { playlistId: "WL", videoIds: ["aaaaaaaaaaa", "bbbbbbbbbbb", "плохой id"], add: false });
ok(em.ok && em.data === 2 && sentActions.length === 2 && sentActions[0].action === "ACTION_REMOVE_VIDEO_BY_VIDEO_ID", "много видео одним запросом (плохие id отброшены)");

const em2 = await call2("editMany", { playlistId: "PL1", add: ["aaaaaaaaaaa"], remove: ["bbbbbbbbbbb", "плохой"] });
ok(em2.ok && em2.data === 2 && sentActions[0].action === "ACTION_ADD_VIDEO" && sentActions[1].removedVideoId === "bbbbbbbbbbb", "много видео: вызов из окна плейлистов (add[] / remove[])");
const ri = await call2("removeItems", { playlistId: "PL1", items: [{ setId: "ABCDEF123456" }, { videoId: "aaaaaaaaaaa" }, { setId: "плохо" }] });
ok(ri.ok && ri.data === 2 && sentActions[0].action === "ACTION_REMOVE_VIDEO" && sentActions[0].setVideoId === "ABCDEF123456" && sentActions[1].removedVideoId === "aaaaaaaaaaa", "убрать конкретные записи (повторы) и все копии");


// ---------- шапка плейлиста и число видео (playlists-main.js) ----------
{
  const headOld = {
    header: {
      playlistHeaderRenderer: {
        numVideosText: { runs: [{ text: "5 000" }, { text: " видео" }] },
        viewCountText: { simpleText: "0 просмотров" },
        byline: [{ playlistBylineRenderer: { text: { runs: [{ text: "5 000" }, { text: " видео" }] } } }, { playlistBylineRenderer: { text: { runs: [{ text: "Обновлено вчера" }] } } }],
      },
    },
    contents: [renderer("aaaaaaaaaaa", 1), contOld],
  };
  const headNew = {
    header: { pageHeaderRenderer: { content: { pageHeaderViewModel: { metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: "Плейлист" } }, { text: { content: "46 видео" } }, { text: { content: "6 просмотров" } }] }] } } } } } },
    sidebar: { playlistSidebarRenderer: { items: [{ playlistSidebarPrimaryInfoRenderer: { stats: [{ runs: [{ text: "Обновлено 3 дня назад" }] }] } }] } },
    contents: [renderer("bbbbbbbbbbb", 1)],
  };
  const libPage = {
    contents: [
      { lockupViewModel: { contentId: "PL1", contentImage: { collectionThumbnailViewModel: { primaryThumbnail: { thumbnailViewModel: { overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { text: "683 видео" } }] } }] } } } }, metadata: { lockupMetadataViewModel: { metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: "Обновлено сегодня" } }] }] } } } } } },
    ],
  };
  const callH = loadMain((url, body) => ({ VLWL: headOld, VLPLnew: headNew, FEplaylist_aggregation: libPage })[body.browseId] || pages[body.continuation] || {});
  const h1 = await callH("page", { playlistId: "WL" });
  ok(h1.data.head?.count === 5000 && h1.data.head.updated === "Обновлено вчера", "шапка старого вида: «5 000 видео», «Обновлено вчера»");
  const h2 = await callH("page", { playlistId: "PLnew" });
  ok(h2.data.head?.count === 46 && h2.data.head.updated === "Обновлено 3 дня назад", "шапка нового вида: число в metadataParts, «Обновлено» в sidebar");
  const h3 = await callH("page", { playlistId: "WL", token: "T-OLD", from: 1 });
  ok(!("head" in h3.data), "у продолжения шапки нет");
  const lb = await callH("library");
  ok(lb.data[0].count === 683 && lb.data[0].updated === "Обновлено сегодня", "страница «Плейлисты»: число видео на обложке");
}

// ---------- быстрое обновление: что изменилось (library/sync-plan.js) ----------
{
  const DAY = 864e5;
  const NOW = new Date(2026, 10, 23, 15, 0).getTime();
  ok(countOf("5 000 видео") === 5000 && countOf("1,234 videos") === 1234 && countOf("0 просмотров") === null && countOf("Нет видео") === null, "число видео из текста");
  ok(updDay("Обновлено сегодня", NOW) === dayOf(NOW) && updDay("Обновлено вчера", NOW) === dayOf(NOW) - 1 && updDay("Обновлено 3 дня назад", NOW) === dayOf(NOW) - 3, "«Обновлено» относительное");
  ok(updDay("Обновлено 12 окт. 2026 г.", NOW) === dayOf(new Date(2026, 9, 12).getTime()) && updDay("Updated Oct 12, 2026", NOW) === dayOf(new Date(2026, 9, 12).getTime()) && updDay("5 000 видео", NOW) === null, "«Обновлено» датой");
  ok(fullDue(null) && fullDue({ fullAt: NOW - 25 * 3600e3 }, NOW) && !fullDue({ fullAt: NOW - 3600e3 }, NOW), "полное обновление — раз в сутки");

  // поддельный плейлист: страницы по 100, токен — смещение
  const mk = (i) => ({ id: `v${String(i).padStart(10, "0")}`, setId: `S${i}`, title: `Видео ${i}`, channel: "Канал", len: 60, pos: 0 });
  const range = (a, b) => Array.from({ length: b - a }, (_, i) => mk(a + i));
  const yt = (list, count = list.length, updated = "") => {
    const calls = { n: 0 };
    const page = async (token) => {
      calls.n++;
      const from = Number(token || 0);
      const items = list.slice(from, from + 100).map((v, i) => ({ ...v, pos: from + i + 1 }));
      return { items, next: from + 100 < list.length ? String(from + 100) : null, ...(token ? {} : { head: { count, updated } }) };
    };
    return { page, calls };
  };
  // прошлый каталог из списка (как его сохранил бы sync)
  const catOf = (list, pid = "PL", extra = {}) => ({
    playlists: [{ id: pid, head: list.length, checked: NOW - DAY / 2, ...extra }],
    videos: list.map((v, i) => ({ ...v, in: [[pid, i + 1, v.setId]] })),
    gone: [],
  });
  const keys = (r, fresh) => fresh.concat(r.reuse.map((e) => e.v?.id || e.g?.id));
  const go = async (list, cat, opt = {}) => {
    const { page, calls } = yt(list, opt.count, opt.updated);
    const fresh = [];
    const r = await readPlaylist({ page, old: cat.playlists[0], olds: listsOf(cat).get("PL"), full: opt.full, onItem: (v) => fresh.push(v.id), now: NOW });
    return { r, pages: calls.n, ids: keys(r, fresh) };
  };
  const base = range(0, 450);
  const ids = (l) => l.map((v) => v.id);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  let t = await go(base, catOf(base));
  ok(t.pages === 1 && !t.r.changed && t.r.count === 450 && same(t.ids, ids(base)), "ничего не менялось — одна страница");
  ok(t.r.reuse[0].pos === 101 && t.r.reuse.at(-1).pos === 450, "остаток из прошлого каталога — места по порядку");

  const liked = [...range(1000, 1003), ...base];
  t = await go(liked, catOf(base));
  ok(t.pages === 1 && t.r.changed && same(t.ids, ids(liked)), "новые сверху («Понравившиеся») — одна страница, склейка с прошлым");

  const watched = base.slice(5);
  t = await go(watched, catOf(base));
  ok(t.pages === 1 && t.r.changed && same(t.ids, ids(watched)), "убрали первые 5 («Смотреть позже») — одна страница");

  const deep = base.filter((_, i) => i !== 250);
  t = await go(deep, catOf(base));
  ok(t.pages === 3 && t.r.changed && same(t.ids, ids(deep)), "убрали видео в глубине — дочитали до него и склеили");

  const appended = [...base, ...range(2000, 2010)];
  t = await go(appended, catOf(base));
  ok(t.pages === 5 && t.r.changed && same(t.ids, ids(appended)), "добавили в конец — прочитан целиком");

  const swapped = [...base.slice(0, 300), mk(3000), ...base.slice(301)]; // в глубине: одно убрали, другое добавили — число то же
  t = await go(swapped, catOf(base), { updated: "Обновлено 3 дня назад" });
  ok(t.pages === 1 && !t.r.changed, "изменение в глубине без следов — не видно (для этого полное раз в сутки)");
  t = await go(swapped, catOf(base, "PL", { checked: NOW - 2 * DAY }), { updated: "Обновлено сегодня" });
  ok(t.pages === 5 && t.r.changed && same(t.ids, ids(swapped)), "«Обновлено сегодня» после прошлой проверки — перечитан целиком");

  const cap = range(0, 5000);
  const capNew = [...range(9000, 9002), ...cap.slice(0, 4998)];
  t = await go(capNew, catOf(cap), { count: 5000 });
  ok(t.pages === 1 && t.r.count === 5000 && same(t.ids, ids(capNew)), "предел 5 000: сверху два новых — два последних отрезаны");

  t = await go(base, catOf(base), { full: true });
  ok(t.pages === 5 && !t.r.changed && t.r.reuse.length === 0, "полное обновление — всё читается заново");
  t = await go(base, catOf(base, "PL", { head: null }));
  ok(t.pages === 5, "в прошлом каталоге нет числа видео (старый формат) — читается целиком");
  t = await go(base, catOf(base, "PL", { failed: true }));
  ok(t.pages === 5, "в прошлый раз плейлист не прочитался — читается целиком");
  const small = range(0, 40);
  t = await go([mk(500), ...small], catOf(small));
  ok(t.pages === 1 && t.r.changed && t.r.count === 41, "маленький плейлист (одна страница) — изменение видно");

  // удалённые видео (cat.gone) — тоже часть порядка
  const withGone = catOf(base);
  const g = withGone.videos.splice(120, 1)[0];
  withGone.gone.push({ pid: "PL", id: g.id, setId: g.setId, title: "[Удалённое видео]", pos: 121 });
  t = await go(base, withGone);
  ok(t.pages === 1 && !t.r.changed && t.r.reuse.some((e) => e.g && e.pos === 121), "удалённые из прошлого каталога остаются на своих местах");

  ok(sameList(["a", "b"], ["a", "b"]) && !sameList(["a"], ["a", "b"]), "сравнение списков");
  ok(splice(["x"], ["x"], 1, 1) === null, "склейка по слишком короткому куску — нет");
  ok(syncSummary({ changed: 3, added: 15, removed: 0 }) === "3 плейлиста изменились, +15 видео", "итог: изменились и прибавилось");
  ok(syncSummary({ changed: 21, added: 1500, removed: 2 }) === "21 плейлист изменился, +1 500 и −2 видео", "итог: прибавилось и убрано");
  ok(syncSummary({ changed: 0, added: 0, removed: 0 }) === "изменений нет", "итог без изменений");
}

// ---------- пересказ видео (tldr-core.js): общий для панели и окна на ленте ----------
{
  const p = parseTldr(["О чём видео: Автор собирает ПК.", "", "Главное:", "0:15 — Выбор корпуса", "- [1:02:03] Итог", "99:00 — за концом"].join("\n"), 3800);
  ok(p.about === "Автор собирает ПК." && p.points.length === 2 && p.points[1].t === 3723, "разбор пересказа: абзац, пункты, таймкод за концом отброшен");
  const ten = Array.from({ length: 8 }, (_, i) => ({ t: i * 10, x: String(i) }));
  const six = pickEven(ten, 6);
  ok(six.length === 6 && six[0].t === 0 && six[5].t === 70, "до шести пунктов равномерно: первый и последний остаются");
  ok(splitParts(Array.from({ length: 400 }, (_, i) => `[${i}:00] ` + "слово ".repeat(20))).length > 1, "длинная расшифровка режется на части");
  ok(isOutputLimitError("429 output tokens per minute") && isSizeLimitError("413 Request too large") && retryAfterMs("try again in 4.2s") === 5200, "виды ошибок лимитов Groq");

  const pacer = createPacer({ itpm: 100000, otpm: 100000, gapMs: 0, maxOut: 900 });
  const calls = [];
  const proxy = {
    chat: async (m) => (calls.push("part"), JSON.stringify({ s: "Часть про сборку.", p: [{ t: "0:10", x: "Корпус" }] })),
    chatStream: async (m, o, onDelta) => {
      calls.push("final");
      const full = ["Автор собирает компьютер.", "", "0:10 — Корпус", "1:00 — Итог"].join("\n");
      onDelta(full.slice(0, 10));
      onDelta(full);
      return full;
    },
  };
  const live = [];
  const ac = new AbortController();
  const short = { segments: [{ t: 0, text: "привет" }, { t: 10, text: "корпус" }, { t: 60, text: "итог" }], chapters: [] };
  const d1 = await runTldr({ transcript: short, title: "ПК", proxy, pacer, signal: ac.signal, onUpdate: (u) => u.live && live.push(u.live) });
  ok(d1.about === "Автор собирает компьютер." && d1.points.length === 2 && calls.join() === "final" && live.length === 2, "короткое видео — один запрос, текст по мере написания");
  calls.length = 0;
  const long = { segments: Array.from({ length: 600 }, (_, i) => ({ t: i * 20, text: "сборка компьютера своими руками ".repeat(6) })), chapters: [] };
  const d2 = await runTldr({ transcript: long, proxy, pacer, signal: ac.signal });
  ok(calls.filter((c) => c === "part").length > 1 && calls[calls.length - 1] === "final" && d2.points.length === 2, "длинное видео — части, потом итог");
  const d3 = await runTldr({ transcript: { segments: [], noiseOnly: true }, proxy, pacer, signal: ac.signal });
  ok(d3.nosubs && d3.music, "нет субтитров — пересказывать не из чего");
  const ac2 = new AbortController();
  ac2.abort();
  let cancelled = false;
  try {
    await runTldr({ transcript: long, proxy, pacer, signal: ac2.signal });
  } catch (e) {
    cancelled = Boolean(e.cancelled);
  }
  ok(cancelled, "отмена пересказа");
}

// ---------- адресная строка: «yt запрос» ----------
{
  // описание подсказки Chrome разбирает как XML: ошибка — и весь список пропадает
  const wellFormed = (x) => {
    const stack = [];
    const rest = x.replace(/<(\/?)(match|dim|url)>/g, (_, close, tag) => {
      if (!close) stack.push(tag);
      else if (stack.pop() !== tag) stack.push("!");
      return "";
    });
    return !stack.length && !/[<>]/.test(rest) && !/&(?!(amp|lt|gt|quot|apos);)/.test(rest) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(rest);
  };
  ok(escapeXml(`a<b>&"c'\u0001\n`) === "a&lt;b&gt;&amp;&quot;c&apos; ", "omnibox: экранирование XML");
  const cat = {
    syncedAt: 1,
    playlists: [
      { id: "WL", title: "Смотреть позже" },
      { id: "P1", title: "Майнкрафт <моды> & сборки" },
      { id: "P2", title: "Готовка" },
    ],
    videos: [
      { id: "aaaaaaaaaaa", title: "Как построить <дом> в Майнкрафте & не сойти с ума", channel: "Blocks & Co", len: 754, in: [["P1", 0, ""], ["WL", 3, ""]] },
      { id: "bbbbbbbbbbb", title: "Шакшука на завтрак", channel: "Кухня", len: 300, in: [["P2", 0, ""]] },
      { id: "ccccccccccc", title: "Майнкрафт: лучшие моды", channel: "Mods", short: true, in: [["P1", 1, ""]] },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `m${String(i).padStart(10, "0")}`, title: `Майнкрафт выживание ${i}`, channel: "x", len: 60, in: [["P1", i + 2, ""]] })),
    ],
  };
  const queue = [
    { id: "aaaaaaaaaaa", title: "Как построить дом", channel: "Blocks & Co" },
    { id: "qqqqqqqqqqq", title: "Привет из очереди <3", channel: "Q" },
  ];
  const data = buildData(cat, queue, { aaaaaaaaaaa: 125, qqqqqqqqqqq: 3 });
  ok(data.metas.length === 24 && data.byId.get("qqqqqqqqqqq").queued && data.byId.get("aaaaaaaaaaa").queued && !data.byId.get("bbbbbbbbbbb").queued, "omnibox: каталог + очередь, без повторов");

  const r = suggest(data, "майнкрафт");
  ok(r.items.length === 8, "omnibox: не больше 8 видео");
  ok(r.items.every((x) => wellFormed(x.description)) && wellFormed(r.head), "omnibox: описания — правильный XML");
  ok(new Set(r.items.map((x) => x.content)).size === r.items.length && r.items.every((x) => videoIdOf(x.content) === x.id), "omnibox: content уникален, Enter узнаёт видео");
  const eq = buildData({ syncedAt: 1, playlists: [], videos: ["ddddddddddd", "eeeeeeeeeee"].map((id) => ({ id, title: "Равный счёт", channel: "c", in: [] })) }, [{ id: "eeeeeeeeeee" }]);
  ok(suggest(eq, "равный").items[0].id === "eeeeeeeeeee", "omnibox: при равном счёте — сначала из очереди");
  const top = suggest(data, "построить майнкрафт").items[0].description;
  ok(top.includes("<match>Майнкрафте</match>") && top.includes("&lt;дом&gt;") && top.includes("&amp; не сойти"), "omnibox: подсветка и экранирование в названии");
  ok(top.includes("<dim>") && top.includes("Blocks &amp; Co") && top.includes("+1") && top.includes("в очереди, с 2:05"), "omnibox: канал, плейлист, место в очереди — приглушённо");
  ok(r.head.includes("<match>майнкрафт</match>") && r.head.includes("найдено 22 видео"), "omnibox: первая строка — искать в библиотеке, сколько нашлось");
  ok(suggest(data, "ifrie").head.includes("<match>шакшу</match>") && suggest(data, "ifrie").head.includes("набрано «ifrie»") && suggest(data, "ifrie").items[0]?.id === "bbbbbbbbbbb", "omnibox: другая раскладка");
  ok(suggest(data, "очередь").items.length === 2, "omnibox: слово «очередь» находит видео из очереди");
  ok(suggest(data, "<3 & ").items.every((x) => wellFormed(x.description)) && wellFormed(suggest(data, "<3 & ").head), "omnibox: запрос со спецсимволами");
  ok(suggest(data, "zzzzqqq").items.length === 0 && suggest(data, "zzzzqqq").head.includes("ничего не нашлось"), "omnibox: ничего не нашлось");
  ok(suggest(null, "котики").items.length === 0 && suggest(null, "котики").head.includes("ещё не собран"), "omnibox: каталога ещё нет");
  ok(suggest(data, "").items.map((x) => x.id).join() === "aaaaaaaaaaa,qqqqqqqqqqq" && suggest(data, "q").head.includes("2 видео"), "omnibox: пусто и «q» — очередь");
  ok(parseInput("?").kind === "help" && parseInput("й").kind === "queue" && parseInput("  ").kind === "empty" && parseInput("кот").q === "кот", "omnibox: команды");
  ok(videoIdOf("https://www.youtube.com/watch?list=x&v=bbbbbbbbbbb&t=3") === "bbbbbbbbbbb" && videoIdOf("youtu.be/bbbbbbbbbbb") === "bbbbbbbbbbb" && !videoIdOf("watch v=bbbbbbbbbbb"), "omnibox: id из ссылки");
  ok(
    videoUrl(data.byId.get("aaaaaaaaaaa")) === "https://www.youtube.com/watch?v=aaaaaaaaaaa&t=125s" &&
      videoUrl(data.byId.get("qqqqqqqqqqq")) === "https://www.youtube.com/watch?v=qqqqqqqqqqq" &&
      videoUrl(data.byId.get("bbbbbbbbbbb")) === "https://www.youtube.com/watch?v=bbbbbbbbbbb" &&
      videoUrl(data.byId.get("ccccccccccc")) === "https://www.youtube.com/shorts/ccccccccccc",
    "omnibox: ссылка — с места в очереди, Shorts отдельно"
  );
  ok(describe(data.byId.get("ccccccccccc"), null).includes("Shorts") && describe(data.byId.get("bbbbbbbbbbb"), null).includes("5:00"), "omnibox: длительность и Shorts");
  const fp = fingerprint(cat, queue);
  const cat2 = { ...cat, videos: cat.videos.map((v, i) => (i ? v : { ...v, in: v.in.slice(0, 1) })) };
  ok(fp === fingerprint(cat, queue) && fp !== fingerprint(cat2, queue) && fp !== fingerprint(cat, queue.slice(1)), "omnibox: отпечаток меняется вместе с каталогом и очередью");
}

console.log(`автопроверки: ${passed} прошло${failed ? `, ${failed} не прошло` : ""}`);
process.exit(failed ? 1 : 0);
