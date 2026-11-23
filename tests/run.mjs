// Автопроверки без браузера: node tests/run.mjs
//   - поиск «Моей библиотеки» (опечатки, основы слов, раскладка, исключения, подсветка);
//   - разбор ответов YouTube в playlists-main.js на маленьких образцах — по одному на
//     каждый формат, который YouTube уже успел поменять (старый и новый вид видео,
//     Shorts плиткой, токены продолжения в разных местах, шапка плейлиста);
//   - быстрое обновление библиотеки: что изменилось в плейлисте (library/sync-plan.js);
//   - подсказки адресной строки «yt …» (omnibox-core.js): XML, выбор, подсветка, очередь.
//   - «В архив Telegram»: тело запроса к боту, разбор ответов, фон с поддельным chrome/fetch.
//   - статистика просмотра (stats-core.js): прибавки по дням и каналам, вытеснение, итоги.
// Запускается из check-syntax.sh перед коммитом.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildIndex, search, highlight, stem, swapLayout, tokens } from "../library/search.js";
import { parseTldr, pickEven, runTldr, splitParts } from "../tldr-core.js";
import { createPacer, isOutputLimitError, isSizeLimitError, retryAfterMs } from "../groq.js";
import { countOf, dayOf, fullDue, listsOf, readPlaylist, sameList, splice, syncSummary, updDay } from "../library/sync-plan.js";
import { buildData, describe, escapeXml, fingerprint, parseInput, suggest, videoIdOf, videoUrl } from "../omnibox-core.js";
import { archiveBody, archiveMessage, archiveResult, fmtLen, tldrPlain } from "../archive-core.js";
import * as ST from "../stats-core.js";
import { MAX, WEEK, channelsOf, dayKey, dayLabel, enough, groupItems, markAllRead, mergeFeed, newCount, queueable, visible } from "../library/digest-core.js";
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

// ---------- «Дайджест подписок»: лента FEsubscriptions (playlists-main.js) ----------
// Образцы — настоящие куски ответов YouTube (поиск, вкладки канала: videoRenderer,
// lockupViewModel, shortsLockupViewModel) без тяжёлых полей, собранные в форму ленты
// «Подписки»: сетка с полкой Shorts, продолжение, вид «Список» с полками по дням.
{
  const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
  const agoV = (id, t) => ({ videoRenderer: { videoId: id, title: run(t), publishedTimeText: { simpleText: t } } });
  const agoPage = { contents: [agoV("ago00000001", "Трансляция закончилась 2 дня назад"), agoV("ago00000002", "Streamed 5 hours ago"), agoV("ago00000003", "1 неделю назад"), agoV("ago00000004", "45 минут назад"), agoV("ago00000005", "Премьера состоялась 1 час назад"), agoV("ago00000006", "вчера")] };
  const feed = { "": fx("subs-grid.json"), "SUBS-T1": fx("subs-cont.json"), "SUBS-LIST": fx("subs-list.json"), AGO: agoPage };
  let asked = null;
  const callF = loadMain((url, body) => {
    asked = body;
    return feed[body.continuation || ""] || {};
  });
  const t0 = Date.now();
  const p1 = await callF("subsFeed");
  const it = p1.data?.items || [];
  const byId = (id) => it.find((x) => x.id === id);
  ok(p1.ok && asked.browseId === "FEsubscriptions" && !asked.continuation, "дайджест: первая страница — FEsubscriptions");
  ok(p1.data.next === "SUBS-T1", "дайджест: токен продолжения");
  ok(!it.some((x) => /^NOISE/.test(x.id)), "дайджест: видео из шапки и боковых панелей не берём");
  ok(it.filter((x) => x.id === "FYyZgMNo3H4").length === 1, "дайджест: повтор в ленте — один раз");
  const v = byId("FYyZgMNo3H4");
  ok(v && v.title.length > 5 && v.channel === "Вкусные идеи от Натали" && /^UC[\w-]{22}$/.test(v.channelId) && v.len === 217, "videoRenderer: название, канал, id канала, длительность");
  ok(v && v.ago === "3 года назад" && /просмотр/.test(v.views) && /^https:\/\/yt\d?\.ggpht\.com\//.test(v.avatar), "videoRenderer: когда, просмотры, аватар");
  ok(v && Math.abs(t0 - v.at - 3 * 31536e6) < 60000, "videoRenderer: «3 года назад» → время");
  const lv = byId("rFZHOHl-L8A");
  ok(lv?.live && lv.channel === "Lofi Girl" && !lv.short, "videoRenderer: прямой эфир");
  const l = byId("q6fgVVmdpgY");
  ok(l && l.channel === "MrBeast" && l.channelId === "UCX6OQ3DkcsbYNE6H8uQQuVA" && l.len === 2038 && l.ago === "8 дней назад" && /просмотр/.test(l.views), "lockupViewModel: строки подписи узнаются по смыслу");
  ok(l && l.avatar.startsWith("https://yt3.ggpht.com/") && Math.abs(t0 - l.at - 8 * 864e5) < 60000, "lockupViewModel: аватар и время");
  ok(byId("LIVExLIVE01")?.live && byId("LIVExLIVE01").channel === "MrBeast" && byId("LIVExLIVE01").len === 0, "lockupViewModel: эфир (значок, «смотрят» — не канал)");
  ok(/Премьера/.test(byId("UPCOMING001")?.upText || "") && byId("UPCOMING001").channel === "MrBeast" && !byId("UPCOMING001").at, "lockupViewModel: премьера");
  ok(byId("UPCOMING002")?.upAt === 1795600000000 && !byId("UPCOMING002").len, "videoRenderer: запланированный эфир");
  const shorts = it.filter((x) => x.short);
  ok(shorts.length === 3 && shorts[0].id === "dnbLdUyozKM" && shorts[0].title.length > 3, "полка Shorts (shortsLockupViewModel)");
  ok(it.findIndex((x) => x.short) > it.findIndex((x) => x.id === "UPCOMING002"), "дайджест: порядок ленты сохраняется");

  const p2 = await callF("subsFeed", { token: "SUBS-T1" });
  ok(p2.ok && asked.continuation === "SUBS-T1" && p2.data.items.length === 3 && p2.data.next === "SUBS-T2", "дайджест: продолжение (appendContinuationItemsAction, continuationItemViewModel)");
  ok(p2.data.items[0].channel === "MrBeast" && p2.data.items[0].ago === "3 недели назад", "дайджест: lockup в продолжении");

  const p3 = await callF("subsFeed", { token: "SUBS-LIST" });
  const reel = p3.data.items.find((x) => x.id === "REELold0001");
  ok(p3.data.items.length === 3 && p3.data.next === "SUBS-LIST2" && reel?.short && reel.title === "Старая плитка", "вид «Список»: полки по дням + старая плитка Shorts");
  const ag = (await callF("subsFeed", { token: "AGO" })).data.items.map((x) => (x.at ? Math.round((Date.now() - x.at) / 6e4) : 0));
  ok(JSON.stringify(ag) === JSON.stringify([2880, 300, 10080, 45, 60, 0]), "«когда»: эфиры, премьеры, английский, неделя; непонятное — без времени");
  const bad = await callF("subsFeed", { token: "нет такого" });
  ok(bad.ok && bad.data.items.length === 0 && bad.data.next === null, "пустой ответ — пусто, без ошибки");
}

// ---------- «Дайджест подписок»: слияние, «новое», группы (library/digest-core.js) ----------
{
  const now = new Date(2026, 10, 23, 15, 0).getTime(); // понедельник, 15:00
  const H = 36e5;
  const V = (id, o = {}) => ({ id, title: "Видео " + id, channel: "Канал А", channelId: "UCaaaaaaaaaaaaaaaaaaaaaa", len: 300, at: now - H, ...o });
  const old = [V("old00000001", { at: now - 30 * H, seenAt: now - 29 * H }), V("old00000002", { at: now - 8 * 24 * H, seenAt: now - 8 * 24 * H }), V("keep0000001", { at: now - 2 * 24 * H, seenAt: now - 47 * H })];
  const fresh = [V("new00000001", { at: now - 2 * H }), V("old00000001", { at: now - 24 * H }), V("short000001", { short: true, at: 0, channel: "", channelId: "" }), V("live0000001", { live: true, at: 0 }), V("soon0000001", { upText: "Премьера: завтра", at: 0 })];
  const mg = mergeFeed(old, fresh, now);
  const ids = mg.map((x) => x.id);
  ok(!ids.includes("old00000002"), "дайджест: старше недели — убираем");
  ok(ids.includes("keep0000001"), "дайджест: пропавшее из ленты, но свежее — держим");
  ok(mg.find((x) => x.id === "old00000001").at === now - 30 * H && mg.find((x) => x.id === "old00000001").seenAt === now - 29 * H, "дайджест: у знакомого видео — первое (точное) время");
  ok(mg.find((x) => x.id === "new00000001").seenAt === now && mg.find((x) => x.id === "short000001").seenAt === now, "дайджест: когда впервые увидели");
  ok(ids.indexOf("new00000001") < ids.indexOf("old00000001") && ids.indexOf("old00000001") < ids.indexOf("keep0000001"), "дайджест: новые сверху");
  ok(mergeFeed([], Array.from({ length: 400 }, (_, i) => V(`m${String(i).padStart(10, "0")}`, { at: now - i * 60e3 })), now).length === MAX, "дайджест: не больше 300 видео");
  ok(!enough([V("a0000000001")], now) && enough([V("a0000000001", { at: now - WEEK - H })], now) && !enough([V("s0000000001", { short: true, at: now - WEEK - H })], now), "дайджест: страниц хватит, когда дошли до недели (Shorts не в счёт)");

  const marks = { read: ["old00000001"], hidden: ["keep0000001"], hiddenCh: [] };
  ok(newCount(mg, marks, {}) === 4 && newCount(mg, marks, { shorts: "hide" }) === 3, "дайджест: число новых (прочитанное, скрытое и Shorts по настройке — не в счёт)");
  const other = V("othr0000001", { channel: "Канал Б", channelId: "UCbbbbbbbbbbbbbbbbbbbbbb", at: now - 3 * H });
  const all = [...mg, other];
  ok(visible(all, { hiddenCh: [{ id: "UCbbbbbbbbbbbbbbbbbbbbbb", name: "Канал Б" }] }, {}).every((x) => x.id !== "othr0000001"), "дайджест: скрытый канал не показываем");
  ok(visible(all, {}, {}, { ch: "UCbbbbbbbbbbbbbbbbbbbbbb" }).map((x) => x.id).join() === "othr0000001", "дайджест: только выбранный канал");
  const rd = markAllRead(marks, all, now);
  ok(newCount(all, rd, {}) === 0 && rd.readAt === now && rd.hidden.has("keep0000001"), "дайджест: «Всё просмотрено»");

  const gd = groupItems(visible(all, {}, {}), "day", {}, now);
  ok(gd.map((g) => g.kind).join() === "day,day,day,shorts", "по дням: дни, Shorts — полкой внизу");
  ok(gd[0].items[0].live && gd[0].items[1].upText && !gd[0].items[2].live, "по дням: эфир и премьера — в начале «Сегодня»");
  ok(gd[0].title === "Сегодня" && gd[1].title === "Вчера" && gd[2].title === "Суббота, 21 ноября", "по дням: подписи дней");
  ok(dayLabel(dayKey(new Date(2026, 0, 5).getTime()), now) === "Понедельник, 5 января", "по дням: дата с днём недели");
  const gc = groupItems(visible(all, {}, {}), "channel", { read: ["othr0000001"] }, now);
  ok(gc.length === 3 && gc[0].title === "Канал А" && gc[1].title === "Канал Б" && gc[2].kind === "shorts", "по каналам: где больше нового — выше; Shorts без канала — полкой");
  ok(gc[0].items.some((x) => x.upText) && gc[0].items.some((x) => x.live), "по каналам: эфиры и премьеры — у своего канала");
  const chs = channelsOf(visible(all, {}, {}), { read: ["othr0000001"] });
  ok(chs.length === 2 && chs[0].name === "Канал А" && chs[0].fresh === 5 && chs[1].fresh === 0, "каналы слева: сколько нового");
  ok(queueable(gc[0].items).every((x) => !x.live && !x.upText) && queueable(gc[0].items)[0].id === "keep0000001", "«Все видео канала — в очередь»: без эфиров и премьер, старые первыми");
}

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

// ---------- «В архив Telegram» (archive-core.js, archive-bg.js) ----------
{
  const e = { title: "ПК", about: "Автор собирает компьютер.", points: [{ t: 10, x: "Корпус" }, { t: 3725, x: "Итог" }] };
  ok(tldrPlain(e) === "Автор собирает компьютер.\n\n0:10 — Корпус\n1:02:05 — Итог", "пересказ текстом для поста");
  ok(tldrPlain(null) === "" && tldrPlain({ about: "x".repeat(5000) }).length === 3000, "пересказ: нет кеша / слишком длинный");
  ok(fmtLen(59) === "0:59" && fmtLen(3600) === "1:00:00", "длительность м:сс / ч:мм:сс");
  const b = archiveBody({ videoId: "dQw4w9WgXcQ", title: "  Т  ", channel: "К".repeat(200), len: 61.7 }, "о чём");
  ok(b && b.title === "Т" && b.channel.length === 120 && b.len === 61 && b.tldr === "о чём", "тело запроса к боту");
  ok(archiveBody({ videoId: "bad" }) === null && archiveBody({ videoId: "dQw4w9WgXcQ/.." }) === null, "негодный id видео не уходит");
  const saved = archiveResult(200, { ok: true, status: "saved", category: "Музыка", queued: false });
  ok(saved.ok && archiveMessage(saved) === "Сохранено в «Музыка»", "сохранено — в какую папку");
  ok(archiveMessage(archiveResult(200, { ok: true, status: "exists", category: "Игры" })) === "Уже в архиве — «Игры»", "уже в архиве");
  ok(/уточнит позже/.test(archiveMessage(archiveResult(200, { ok: true, status: "saved", category: "Видео", queued: true }))), "ИИ лежит — папку уточнит позже");
  ok(archiveResult(404, null).kind === "update" && /Обновите бота/.test(archiveResult(404, null).text), "старый бот без адреса — «Обновите бота»");
  ok(archiveResult(405, null).kind === "update", "старый бот: 405 — тоже «Обновите бота»");
  ok(archiveResult(403, { error: "forbidden" }).kind === "forbidden" && archiveResult(429, {}).kind === "busy", "секрет и лимит");
  ok(archiveResult(503, { code: "tg_offline" }).kind === "offline" && archiveResult(0, null).kind === "network" && archiveResult(-1, null).kind === "timeout", "бот не на связи / сеть / таймаут");
  ok(archiveResult(500, {}).kind === "error" && archiveResult(200, { error: "x" }).ok === false, "сбой бота и странный ответ");

  // фон: поддельные chrome.* и fetch
  const store = { "tldr:dQw4w9WgXcQ": e, settings: { baseUrl: "https://bot.example/", token: "test-token" } };
  const listeners = [];
  globalThis.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://abc/${p}`,
      onConnect: { addListener() {} },
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
    storage: {
      local: {
        get: async (k) => (k === null ? { ...store } : typeof k === "string" ? (k in store ? { [k]: store[k] } : {}) : {}),
        set: async (o) => Object.assign(store, o),
      },
    },
  };
  const realFetch = globalThis.fetch;
  const sent = [];
  let reply = { status: 200, body: { ok: true, status: "saved", category: "Железо", queued: false } };
  globalThis.fetch = async (url, opt = {}) => {
    if (String(url).endsWith("local-config.js")) return { ok: false };
    sent.push({ url: String(url), opt });
    await new Promise((r) => setTimeout(r, 5));
    return { status: reply.status, ok: reply.status === 200, json: async () => reply.body };
  };
  const bg = await import("../archive-bg.js");
  const info = { videoId: "dQw4w9WgXcQ", title: "Сборка ПК", channel: "Мастер", len: 754 };
  const [r1, r2] = await Promise.all([bg.saveVideo(info), bg.saveVideo(info)]);
  const req = sent[0];
  const body = JSON.parse(req.opt.body);
  ok(sent.length === 1 && r1.ok && r2.ok, "двойной щелчок — один запрос к боту");
  ok(req.url === "https://bot.example/api/save-video" && req.opt.headers["X-Sec-Token"] === "test-token" && req.opt.method === "POST", "адрес и секрет — как у /api/chat");
  ok(body.title === "Сборка ПК" && body.len === 754 && body.tldr.includes("0:10 — Корпус"), "в бот уходит и готовый пересказ");
  ok(r1.text === "Сохранено в «Железо»" && store["tgarch:dQw4w9WgXcQ"]?.cat === "Железо", "итог и отметка «уже в архиве»");
  reply = { status: 404, body: null };
  const r3 = await bg.saveVideo({ videoId: "aaaaaaaaaaa", title: "x" });
  ok(!r3.ok && /Обновите бота/.test(r3.text) && !store["tgarch:aaaaaaaaaaa"], "старый бот — понятный текст, без отметки");
  const ready = await new Promise((res) => listeners.some((fn) => fn({ type: "archive:ready" }, { tab: { id: 1 } }, res) === true));
  ok(ready.ok === true, "кнопка видна, когда бот настроен");
  store.settings = { baseUrl: "https://bot.example", token: "" };
  const r4 = await bg.saveVideo(info);
  ok(!r4.ok && r4.kind === "setup" && /не настроен/.test(r4.text), "без секрета — подсказка про настройки");
  const before = sent.length;
  const silent = listeners.map((fn) => fn({ type: "archive:save", info }, { url: "https://evil.example/" }, () => {}));
  ok(silent.every((x) => x !== true) && sent.length === before, "чужая страница фон не просит");
  globalThis.fetch = realFetch;
  delete globalThis.chrome;
}

// ---------- скорость по каналам (speed-core.js) ----------
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("../speed-core.js", import.meta.url), "utf8"), ctx);
  const C = ctx.__ytcsSpeedCore;
  const A = "UC" + "a".repeat(22);
  const B = "UC" + "b".repeat(22);
  ok(C.isChannelId(A) && !C.isChannelId("@lectures") && !C.isChannelId("UCshort"), "id канала — UC и 22 символа");
  ok(C.fmtRate(1.5) === "1,5×" && C.fmtRate(1.25) === "1,25×" && C.fmtRate(2) === "2×" && C.fmtRate(1) === "1×", "скорость по-русски: 1,5×");
  ok(C.cleanRate(1.2500001) === 1.25 && C.cleanRate(9) === 4 && C.cleanRate(0.1) === 0.25 && C.cleanRate("x") === null && C.cleanRate(0) === null, "скорость в пределах плеера");
  let m = C.remember({}, A, 1.5, "  Лекции  ", 10);
  ok(m[A].r === 1.5 && m[A].n === "Лекции" && m[A].t === 10, "запомнить скорость канала");
  ok(Object.keys(C.remember(m, "@handle", 2, "x")).length === 1 && Object.keys(C.remember(m, B, NaN, "x")).length === 1, "без id канала и без скорости не запоминаем");
  ok(C.remember(m, A, 2, "", 20)[A].n === "Лекции", "пустое название не затирает прежнее");
  ok(!(A in C.forget(m, A)) && A in m, "забыть канал, исходный объект цел");
  // ограничение размера: вытесняются давно не открытые
  let big = {};
  for (let i = 0; i < 5; i++) big = C.remember(big, "UC" + String(i).repeat(22), 1.5, "c" + i, i, 3);
  ok(Object.keys(big).length === 3 && !("UC" + "0".repeat(22) in big) && "UC" + "4".repeat(22) in big, "больше предела — вытесняются самые старые");
  big = C.touch(big, "UC" + "2".repeat(22), "", 100);
  big = C.remember(big, B, 2, "b", 101, 3);
  ok("UC" + "2".repeat(22) in big && !("UC" + "3".repeat(22) in big), "открытый недавно канал не вытесняется");
  ok(C.entryOf({ [A]: { r: "abc" } }, A) === null && C.entryOf({ [A]: { r: 1.5 } }, A).r === 1.5, "битая запись не читается");
  ok(JSON.stringify(C.list({ [A]: { r: 1.5, n: "a", t: 1 }, [B]: { r: 2, n: "b", t: 5 } }).map((e) => e.id)) === JSON.stringify([B, A]), "список: сначала недавние");
  // что делать с новым видео
  const base = { enabled: true, stored: null, current: 1, carried: null, userChose: false, live: false };
  const P = (o) => JSON.stringify(C.plan({ ...base, ...o }));
  ok(P({ stored: 1.5 }) === JSON.stringify({ rate: 1.5, why: "channel" }), "у канала 1,5× — ставим");
  ok(P({ stored: 1.5, current: 1.5 }) === "null", "уже 1,5× — ничего не делаем и не показываем");
  ok(P({ stored: 1.5, userChose: true }) === "null", "ваш выбор в этом видео не перебиваем");
  ok(P({ stored: 1.5, live: true }) === "null", "прямой эфир не трогаем");
  ok(P({ stored: 1.5, enabled: false }) === "null", "выключено — ничего не делаем");
  ok(P({ current: 1.5, carried: 1.5 }) === JSON.stringify({ rate: 1, why: "restore" }), "скорость лекций не переносится на канал без скорости");
  ok(P({ current: 1.25, carried: null }) === "null", "обычную скорость YouTube не трогаем");
  ok(P({ current: 1.25, carried: 1.5 }) === "null", "скорость сменилась не нами — не трогаем");
  ok(P({ stored: 1, current: 1.5, carried: 1.5 }) === JSON.stringify({ rate: 1, why: "channel" }), "музыка 1× после лекций 1,5×");
}

// ---------- таймер сна (sleep-core.js) ----------
{
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(new URL("../sleep-core.js", import.meta.url), "utf8"), ctx);
  const S = ctx.__ytcsSleepCore;
  const J = (o) => JSON.stringify(o);
  ok(J(S.make(30)) === J({ mode: "min", left: 1800000, preset: 30 }) && S.make("end").mode === "end", "выбор: 30 мин и «в конце видео»");
  ok(S.make(17).mode === "off" && S.make("off").mode === "off" && S.make("abc").mode === "off", "чужие варианты — выключено");
  // горячая клавиша по кругу
  const seq = [];
  let c = S.make("off");
  for (let i = 0; i < 8; i++) {
    c = S.next(c);
    seq.push(c.mode === "min" ? c.preset : c.mode);
  }
  ok(J(seq) === J([15, 30, 45, 60, 90, "end", "off", 15]), "клавиша: 15 → … → 90 → в конце → выкл.");
  ok(S.next({ mode: "min", left: 5000, preset: 0 }).mode === "end", "после «ещё 15 мин» клавиша ведёт к «в конце видео»");
  // время идёт по часам и только пока видео играет
  let t = S.make(15);
  t = S.advance(t, 60000, true);
  ok(t.left === 14 * 60000, "минута воспроизведения — минус минута");
  ok(S.advance(t, 60000, false).left === t.left, "на паузе таймер стоит");
  ok(S.advance(t, 5 * 3600000, true).left === t.left - S.MAX_GAP_MS, "компьютер спал — большой разрыв не считаем целиком");
  ok(S.advance(S.make(15), 20 * 60000, true).left === 15 * 60000 - S.MAX_GAP_MS && S.advance({ mode: "min", left: 1000, preset: 15 }, 5000, true).left === 0, "не уходит ниже нуля");
  ok(S.advance(S.make("end"), 60000, true).mode === "end", "«в конце видео» от часов не зависит");
  // «в конце видео»: остаток ролика по реальному времени, скорость учитывается
  const end = S.make("end");
  ok(S.remaining(end, { duration: 600, currentTime: 540, playbackRate: 1 }) === 60000, "конец через минуту при 1×");
  ok(S.remaining(end, { duration: 600, currentTime: 540, playbackRate: 2 }) === 30000, "при 2× — вдвое быстрее");
  ok(S.remaining(end, { duration: Infinity, currentTime: 50, playbackRate: 1 }) === null && S.remaining(end, { duration: NaN, currentTime: 0 }) === null, "эфир и незагруженное — неизвестно");
  ok(S.remaining(S.make(30), { duration: 10, currentTime: 9, playbackRate: 4 }) === 1800000, "минуты не зависят от видео и скорости");
  ok(S.remaining(S.make("off"), {}) === null, "выключено — нет остатка");
  // затухание: 1 до последних 20 с, дальше плавно к нулю
  ok(S.fadeFactor(60000) === 1 && S.fadeFactor(20000) === 1 && S.fadeFactor(null) === 1, "до затухания — полная громкость");
  ok(S.fadeFactor(10000) === 0.25 && S.fadeFactor(0) === 0 && S.fadeFactor(-5) === 0, "середина затухания — четверть, в конце — тишина");
  ok(S.fadeFactor(15000) > S.fadeFactor(10000) && S.fadeFactor(10000) > S.fadeFactor(5000), "громкость только убывает");
  ok(S.fadeFactor(2500, 5000) === 0.25, "короткое затухание, если до конца меньше 20 с");
  // подписи
  ok(S.fmtLeft(23 * 60000) === "23 мин" && S.fmtLeft(22 * 60000 + 1) === "23 мин" && S.fmtLeft(90 * 60000) === "90 мин", "минуты — вверх до целой");
  ok(S.fmtLeft(40000) === "40 с" && S.fmtLeft(38000) === "40 с" && S.fmtLeft(59000) === "1 мин" && S.fmtLeft(200) === "5 с", "меньше минуты — секунды по 5");
  ok(S.label(S.make(30), null) === "осталось 30 мин" && S.label(S.make("end"), 300000) === "в конце видео" && S.label(S.make("end"), 15000) === "осталось 15 с", "подпись в меню");
  ok(S.label(S.make("off"), null) === "", "выключено — без подписи");
  // переживает перезагрузку (автопереход очереди)
  const now = 1_700_000_000_000;
  const back = S.unpack(S.pack({ mode: "min", left: 754321, preset: 45 }, now), now + 3000);
  ok(J(back) === J({ mode: "min", left: 754321, preset: 45 }), "сохранить и восстановить таймер минут");
  ok(S.unpack(S.pack(S.make("end"), now), now).mode === "end", "сохранить «в конце видео»");
  ok(S.pack(S.make("off"), now) === null, "выключенный не сохраняется");
  ok(S.unpack(S.pack(S.make(15), now), now + 4 * 3600000).mode === "off", "давний таймер забывается");
  ok(S.unpack("{oops", now).mode === "off" && S.unpack(null, now).mode === "off" && S.unpack('{"m":"min","l":-5,"at":1}', 2).mode === "off", "битые данные — выключено");
}

// ---------- пропуск тишины (silence-core.js) ----------
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("../silence-core.js", import.meta.url), "utf8"), ctx);
  const S = ctx.__ytcsSilenceCore;
  // Синтетическая «речь»: слоги 5/с от −20 до −32 дБ, через каждые 0,6 с провал между
  // словами 100 мс (−45 дБ); паузы — шум комнаты около −60 дБ. Кадр — 20 мс видео.
  const DT = 20;
  function run(parts, det = S.createDetector()) {
    let t = 0;
    const silentAt = [];
    let n = 0;
    for (const [kind, ms, lvl] of parts) {
      for (let i = 0; i < ms; i += DT, t += DT) {
        let db;
        if (kind === "speech") db = i % 600 >= 500 ? -45 : -20 - 12 * (0.5 + 0.5 * Math.cos((2 * Math.PI * 5 * i) / 1000));
        else if (kind === "music") db = -14 - 8 * Math.abs(Math.sin(i / 170)); // громко без провалов
        else db = (lvl ?? -60) + ((n++ * 7919) % 20) / 10; // шум ±1 дБ
        if (det.push(db, DT)) silentAt.push(t);
      }
    }
    return { det, segs: segments(silentAt) };
  }
  const segments = (ts) => {
    const out = [];
    for (const t of ts) {
      const last = out[out.length - 1];
      if (last && t - last[1] <= DT) last[1] = t;
      else out.push([t, t]);
    }
    return out;
  };
  const inside = (seg, a, b) => seg[0] >= a && seg[1] < b;

  ok(S.levelDb(new Float32Array(1024)) === -90 && Math.abs(S.levelDb(new Float32Array(1024).fill(0.1)) + 20) < 0.01, "уровень кадра в дБ");

  // речь 3 с, пауза 0,8 с, речь 2 с, пауза 0,2 с, речь 2 с, пауза 1,5 с, речь 1 с
  let r = run([["speech", 3000], ["pause", 800], ["speech", 2000], ["pause", 200], ["speech", 2000], ["pause", 1500], ["speech", 1000]]);
  ok(r.segs.length === 2, "две паузы ускоряются, короткая (0,2 с) — нет");
  ok(r.segs[1] && r.segs[1][0] - 8000 >= 230 && r.segs[1][0] - 8000 <= 300, "ускорение — через 250 мс тишины");
  ok(r.segs[1] && r.segs[1][1] === 9480, "речь вернулась — скорость сразу обычная");
  ok(r.segs.every((g) => inside(g, 3000, 3800) || inside(g, 8000, 9500)), "речь не ускоряется");
  ok(r.det.ready() && r.det.state().floor < -55 && r.det.state().speech > -24, "порог под громкость ролика");

  // провалы между словами (100 мс) — никогда
  r = run([["speech", 20000]]);
  ok(r.segs.length === 0, "сплошная речь с провалами между словами — без ускорения");

  // тихая запись (на 20 дБ тише) — порог сдвигается следом
  {
    const det = S.createDetector();
    let t = 0;
    const silent = [];
    const parts = [["s", 4000], ["p", 1000], ["s", 3000], ["p", 1000], ["s", 1000]];
    for (const [k, ms] of parts) {
      for (let i = 0; i < ms; i += DT, t += DT) {
        const db = k === "s" ? (i % 600 >= 500 ? -65 : -40 - 12 * (0.5 + 0.5 * Math.cos((2 * Math.PI * 5 * i) / 1000))) : -80 + (i % 3);
        if (det.push(db, DT)) silent.push(t);
      }
    }
    const segs = segments(silent);
    ok(segs.length === 2 && inside(segs[1], 8000, 9000), "тихая запись: паузы тоже находятся");
  }

  // музыка: громко без пауз — ничего; шумная запись (речь лишь на 10 дБ громче шума) — ничего
  r = run([["music", 30000]]);
  ok(r.segs.length === 0, "музыка без пауз — без ускорения");
  {
    const det = S.createDetector();
    let hit = 0;
    for (let t = 0; t < 20000; t += DT) {
      const phrase = t % 3000 < 2200;
      if (det.push(phrase ? -20 - (t % 200) / 40 : -30 + (t % 3), DT)) hit++;
    }
    ok(hit === 0, "шумная запись (мало разницы с речью) — не трогаем");
  }

  // цифровая тишина в начале ролика не считается паузой: ещё не слышали речи
  r = run([["pause", 2000, -90], ["speech", 1000], ["pause", 600]]);
  ok(r.segs.length === 0, "начало ролика: пока не разогрелись — не ускоряем");

  // перемотка: незаконченная пауза начинается заново
  {
    const det = S.createDetector();
    run([["speech", 4000]], det);
    for (let i = 0; i < 200; i += DT) det.push(-60, DT);
    det.interrupt();
    let first = -1;
    for (let i = 0; i < 400; i += DT) if (det.push(-60, DT) && first < 0) first = i;
    ok(first >= 230, "после перемотки 250 мс тишины считаются заново");
  }

  // на реальных отсчётах: гармоники с огибающей слогов и пауза с тихим шумом
  {
    const det = S.createDetector();
    const SR = 48000;
    const N = 1024;
    const frame = new Float32Array(N);
    let pos = 0;
    let seed = 3;
    const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 0.002;
    const silent = [];
    const plan = [["s", 4], ["p", 1], ["s", 2], ["p", 0.15], ["s", 2]];
    let t0 = 0;
    for (const [k, sec] of plan) {
      const end = t0 + sec;
      for (; pos / SR < end; pos += 960) {
        for (let i = 0; i < N; i++) {
          const t = (pos + i) / SR;
          const syl = 0.5 - 0.5 * Math.cos(2 * Math.PI * 5 * t);
          let x = 0;
          for (let h = 1; h <= 6; h++) x += Math.sin(2 * Math.PI * 140 * h * t) / h;
          frame[i] = k === "s" ? 0.18 * x * syl + noise() : noise();
        }
        if (det.push(S.levelDb(frame), 20)) silent.push(Math.round((pos / SR) * 1000));
      }
      t0 = end;
    }
    const segs = segments(silent.map((x) => Math.round(x / DT) * DT));
    ok(segs.length === 1 && segs[0][0] >= 4200 && segs[0][1] < 5050, "по отсчётам звука: секундная пауза — да, 150 мс — нет");
  }

  ok(S.boostRate(1) === 2.5 && S.boostRate(1.5) === 3.75 && S.boostRate(2) === 4 && S.boostRate(1.25) === 3.25, "скорость паузы: в 2,5 раза, до 4×");
  ok(S.boostRate(3.5) === null && S.boostRate(4) === null && S.boostRate(0) === null && S.boostRate("x") === null, "вы и так на 3,5× — не ускоряем");
  ok(Math.abs(S.savedSec(1, 2.5, 1) - 1.5) < 1e-9 && S.savedSec(1, 1, 1) === 0, "сэкономлено: секунда на 2,5× = 1,5 с");
  ok(S.fmtSaved(40) === "40 с" && S.fmtSaved(185) === "3 мин" && S.fmtSaved(3900) === "1 ч 5 мин" && S.fmtSaved(7200) === "2 ч", "сэкономлено по-русски");
  let saved = S.addSaved(null, 12.34, "2026-11-22");
  saved = S.addSaved(saved, 10, "2026-11-23");
  ok(saved.sec === 10 && saved.day === "2026-11-23" && saved.total === 22.3 && saved.days["2026-11-22"] === 12.3, "итог: sec — за день, total — всего, по дням");
  ok(S.addSaved(saved, 5, "2026-11-23").sec === 15 && S.addSaved(saved, 5, "2026-11-24").sec === 5, "с новым днём sec — с нуля");
  ok(S.todaySaved(saved, "2026-11-23") === 10 && S.todaySaved(saved, "2026-11-24") === 0 && S.todaySaved(null) === 0, "за сегодня — со сменой дня");
  let many = null;
  for (let d = 1; d <= 100; d++) many = S.addSaved(many, 1, `2026-${String(1 + Math.floor(d / 28)).padStart(2, "0")}-${String(1 + (d % 28)).padStart(2, "0")}`);
  ok(Object.keys(many.days).length === 90 && many.total === 100, "по дням — последние 90 дней, итог целиком");
}

// ---------- статистика просмотра (stats-core.js) ----------
{
  const NOW = new Date(2026, 10, 23, 15, 0).getTime(); // 23 ноября 2026, 15:00 по местному
  const A = "UC" + "a".repeat(22);
  const B = "UC" + "b".repeat(22);
  ok(ST.dayKey(NOW) === "2026-11-23" && ST.shiftDay("2026-03-01", -1) === "2026-02-28" && ST.shiftDay("2026-12-31", 1) === "2027-01-01", "ключи дней");
  ok(ST.shiftDay("2026-03-30", -1) === "2026-03-29" && ST.shiftDay("2026-10-26", -1) === "2026-10-25", "дни через переход на летнее время");
  let st = ST.emptyStats(NOW);
  ST.addDelta(st, { w: 600, sp: 200, n: 1, ch: { id: A, name: "Лекции", sec: 600 } }, NOW);
  ST.addDelta(st, { w: 300, s: 120, sb: 45, ch: { id: A, name: "Лекции", sec: 300 } }, NOW);
  ST.addDelta(st, { w: 1200, day: "2026-11-20", ch: { id: B, name: "Музыка", sec: 1200 } }, NOW);
  const d = st.days["2026-11-23"];
  ok(d.w === 900 && d.s === 120 && d.sp === 200 && d.sb === 45 && d.n === 1, "прибавки складываются по дню");
  ok(st.ch[A].a === 900 && st.ch[A].d["2026-11-23"] === 900 && st.ch[A].n === "Лекции", "канал копит время по дням");
  // отрицательное — только для счётчиков очереди и не ниже нуля
  ST.addDelta(st, { w: -500, qd: 1 }, NOW);
  ST.addDelta(st, { qd: -1 }, NOW);
  ST.addDelta(st, { qd: -1, qx: 2 }, NOW);
  ok(d.w === 900 && !d.qd && d.qx === 2, "минус только у очереди и не ниже нуля");
  ST.addDelta(st, { w: 1e9 }, NOW);
  ok(d.w === 900 + 86400, "мусорная прибавка обрезана до суток");
  d.w = 900;
  // канал по названию, потом с id — сливается
  ST.addDelta(st, { w: 60, ch: { id: "", name: "Без id", sec: 60 } }, NOW);
  ok(st.ch["n:Без id"]?.a === 60, "канал без id — по названию");
  const C = "UC" + "c".repeat(22);
  ST.addDelta(st, { w: 40, ch: { id: C, name: "Без id", sec: 40 } }, NOW);
  ok(!st.ch["n:Без id"] && st.ch[C].a === 100 && st.ch[C].d["2026-11-23"] === 100, "название → id: время переносится");
  // итоги
  const sum = ST.summarize(st, 7, NOW);
  ok(sum.series.length === 7 && sum.series[6].key === "2026-11-23" && sum.series[3].key === "2026-11-20", "7 столбиков по дням, последний — сегодня");
  ok(sum.series[6].video === 1000 && sum.series[6].shorts === 120 && sum.series[3].video === 1200, "столбики: видео и Shorts отдельно");
  ok(sum.watch === 2320 && sum.shorts === 120 && sum.speed === 200 && sum.sponsor === 45 && sum.saved === 245 && sum.qx === 2, "итоги за 7 дней");
  ok(sum.channels[0].key === B && sum.channels[1].key === A && Math.abs(sum.channels[0].share - 1200 / 2200) < 1e-9, "топ каналов с долей от обычных видео");
  const s1 = ST.summarize(st, 1, NOW);
  ok(s1.watch === 1120 && s1.channels[0].key === A && s1.series.length === 1, "итоги за сегодня");
  const s90 = ST.summarize(st, 90, NOW);
  ok(s90.series.length === 13 && s90.series[12].to === "2026-11-23" && s90.series[12].from === "2026-11-17" && s90.series[0].from === s90.from, "90 дней — по неделям, первая неделя не раньше начала");
  ok(s90.series.reduce((a, x) => a + x.video + x.shorts, 0) === s90.watch, "недели складываются в итог");
  const tt = ST.totals(st, NOW);
  ok(tt.today === 1120 && tt.week === 2320 && tt.month === 2320, "сегодня / неделя / месяц");
  ok(ST.summarize(st, 2, new Date(2026, 10, 25, 9).getTime()).watch === 0, "через два дня — за 2 дня пусто");
  {
    const fresh = ST.emptyStats(new Date(2026, 10, 22, 10).getTime()); // начали считать вчера
    ST.addDelta(fresh, { w: 1200 }, NOW);
    const f30 = ST.summarize(fresh, 30, NOW);
    ok(f30.days === 2 && f30.avg === 600 && ST.summarize({ ...fresh, since: NOW - 90 * 86400000 }, 30, NOW).days === 30, "среднее — за дни, что собирали, а не за весь период");
    ok(ST.totals(fresh, NOW).newToday === false && ST.totals(ST.emptyStats(NOW), NOW).newToday === true, "считаем с сегодняшнего дня");
  }
  // хранение: старое уходит, лишние каналы вытесняются
  st.days["2025-01-01"] = { w: 10 };
  st.ch[A].d["2026-06-01"] = 50;
  ST.prune(st, NOW, 2);
  ok(!st.days["2025-01-01"] && !st.ch[A].d["2026-06-01"] && st.ch[A].d["2026-11-23"] === 900, "дни старше срока убраны");
  ok(Object.keys(st.ch).length === 2 && !st.ch[C], "каналов сверх предела — вытеснены наименее смотренные");
  // чтение из хранилища
  const back = ST.cleanStats(JSON.parse(JSON.stringify(st)), NOW);
  const canon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, Object.entries(o[k]).sort()]));
  ok(canon(back.days) === canon(st.days) && back.ch[A].a === st.ch[A].a, "запись и чтение без потерь");
  const junk = ST.cleanStats({ days: { bad: { w: 1 }, "2026-11-23": { w: "x", s: -5, n: 2 } }, ch: { "": {}, [A]: { d: { "2026-11-23": "abc" } } } }, NOW);
  ok(JSON.stringify(junk.days) === JSON.stringify({ "2026-11-23": { n: 2 } }) && junk.ch[A].a === 0 && !junk.ch[""], "битые данные отброшены");
  ok(!ST.hasData(ST.emptyStats()) && ST.hasData(st), "есть ли данные");
  ok(ST.fmtDur(0) === "0 мин" && ST.fmtDur(35) === "35 с" && ST.fmtDur(720) === "12 мин" && ST.fmtDur(3900) === "1 ч 05 мин" && ST.fmtDur(7200) === "2 ч" && ST.fmtDur(460800) === "128 ч", "длительность по-человечески");
  ok(ST.channelKey(A, "x") === A && ST.channelKey("bad", " Канал ") === "n:Канал" && ST.channelKey("", "") === "", "ключ канала");
}

// ---------- статистика: счётчик на странице (stats.js) и фон (stats-bg.js) ----------
{
  // stats.js в песочнице: поддельные видео, плеер, часы и chrome.runtime
  const sent = [];
  const docL = {};
  const timers = [];
  let clock = 0;
  const player = { classList: { contains: (c) => c === "ad-showing" && player.ad } };
  const video = { paused: false, ended: false, seeking: false, readyState: 4, muted: false, volume: 1, currentTime: 0, duration: 600, playbackRate: 1, closest: () => player };
  const ctx = {
    console,
    JSON,
    Map,
    Set,
    Math,
    Number,
    URLSearchParams,
    location: { pathname: "/watch", search: "?v=abcdefghijk" },
    performance: { now: () => clock },
    setInterval: (fn, ms) => timers.push({ fn, ms }),
    CustomEvent: class {
      constructor(type, o) {
        this.type = type;
        this.detail = o?.detail;
      }
    },
    document: {
      visibilityState: "visible",
      querySelector: (sel) => (sel.includes("video") ? video : null),
      addEventListener: (ev, fn) => (docL[ev] ||= []).push(fn),
      removeEventListener: (ev, fn) => (docL[ev] = (docL[ev] || []).filter((f) => f !== fn)),
      dispatchEvent: (e) => (docL[e.type] || []).forEach((f) => f(e)),
    },
    window: { addEventListener() {} },
    chrome: {
      runtime: { id: "ext", sendMessage: (m) => (sent.push(m), Promise.resolve()) },
      storage: { local: { get: () => Promise.resolve({}) }, onChanged: { addListener() {} } },
    },
  };
  ctx.window.top = ctx.window;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // канал отвечает мир страницы (speed-main.js)
  ctx.document.addEventListener("ytcs-speed:ask", () =>
    ctx.document.dispatchEvent(new ctx.CustomEvent("ytcs-speed:info", { detail: JSON.stringify({ videoId: "abcdefghijk", channelId: "UC" + "z".repeat(22), name: "Канал" }) }))
  );
  vm.runInContext(readFileSync(new URL("../stats.js", import.meta.url), "utf8"), ctx);
  const tick = timers.find((t) => t.ms === 1000).fn;
  const flush = timers.find((t) => t.ms === 15000).fn;
  const step = (sec, moved = sec * video.playbackRate) => {
    clock += sec * 1000;
    video.currentTime += moved;
    tick();
  };
  tick();
  for (let i = 0; i < 10; i++) step(1); // 10 с на 1×
  video.playbackRate = 2;
  for (let i = 0; i < 10; i++) step(1); // 10 с на 2× — сэкономлено 10 с
  step(1, 120); // перемотка — не считается
  video.paused = true;
  step(5, 0); // пауза
  video.paused = false;
  player.ad = true;
  step(5); // реклама YouTube
  player.ad = false;
  ctx.document.visibilityState = "hidden";
  video.muted = true;
  step(5); // вкладка в фоне и без звука
  ctx.document.visibilityState = "visible";
  video.muted = false;
  ctx.document.dispatchEvent(new ctx.CustomEvent("ytcs-stats:saved", { detail: JSON.stringify({ kind: "sponsor", sec: 40 }) }));
  flush();
  const d = sent.find((m) => m.type === "stats:add")?.delta || {};
  ok(sent.length === 1 && Math.abs(d.w - 19) < 1.1 && Math.abs(d.sp - 9) < 1.1 && d.sb === 40, "время: только воспроизведение, перемотки/пауза/реклама/фон без звука — мимо");
  ok(d.ch?.id === "UC" + "z".repeat(22) && Math.abs(d.ch.sec - d.w) < 0.01 && d.n === undefined, "канал от плеера; «смотрели» — с 30 с, а не раньше");
  for (let i = 0; i < 15; i++) step(1);
  video.currentTime = 560;
  clock += 1000;
  tick();
  step(1);
  flush();
  const d2 = sent[1]?.delta || {};
  ok(d2.n === 1 && d2.fin === 1, "дольше 30 с — «смотрели», дошли до 90% — «досмотрено»");
  // Shorts — отдельно, без канала
  ctx.location.pathname = "/shorts/abcdefghijk";
  video.playbackRate = 1;
  tick();
  for (let i = 0; i < 5; i++) step(1);
  flush();
  const d3 = sent[2]?.delta || {};
  ok(d3.s > 3.9 && !d3.w && !d3.ch, "Shorts — своим счётом, без каналов");
}
{
  // фон: прибавки по очереди, выключатель уважается
  let store = { settings: {} };
  let listener = null;
  globalThis.chrome = {
    runtime: { id: "ext", onMessage: { addListener: (f) => (listener = f) } },
    storage: { local: { get: async (k) => Object.fromEntries([].concat(k).filter((x) => x in store).map((x) => [x, structuredClone(store[x])])), set: async (o) => Object.assign(store, structuredClone(o)) } },
  };
  const { statsAdd } = await import("../stats-bg.js?t=" + Date.now());
  await Promise.all([statsAdd({ w: 10 }), statsAdd({ w: 20, qd: 1 }), statsAdd({ qx: 2 })]);
  const today = ST.dayKey();
  ok(store.watchStats?.days?.[today]?.w === 30 && store.watchStats.days[today].qd === 1 && store.watchStats.days[today].qx === 2, "фон: прибавки складываются по очереди");
  let reply = null;
  listener({ type: "stats:add", delta: { w: 5 } }, { id: "чужое" }, (r) => (reply = r));
  await statsAdd({});
  ok(store.watchStats.days[today].w === 30 && reply === null, "фон: чужие сообщения не принимаются");
  store.settings = { watchStats: false };
  await statsAdd({ w: 100 });
  ok(store.watchStats.days[today].w === 30, "фон: сбор выключен — не пишем");
  delete globalThis.chrome;
}

// ---------- «Что умеет расширение»: когда открывать (welcome-bg.js) ----------
{
  const store = {};
  const tabs = [];
  const badge = { text: "" };
  let onInstalled = null;
  const changed = [];
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: "0.27.0", action: { default_title: "T" } }), getURL: (p) => "ext://" + p, onInstalled: { addListener: (f) => (onInstalled = f) } },
    storage: {
      local: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        set: async (o) => (Object.assign(store, o), changed.forEach((f) => f(Object.fromEntries(Object.keys(o).map((x) => [x, { newValue: o[x] }])), "local"))),
        remove: async (k) => (delete store[k], changed.forEach((f) => f({ [k]: {} }, "local"))),
      },
      onChanged: { addListener: (f) => changed.push(f) },
    },
    tabs: { create: async (o) => tabs.push(o.url) },
    action: {
      getBadgeText: async () => badge.text,
      setBadgeText: async (o) => (badge.text = o.text),
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
  };
  const { paintWhatsNew } = await import("../welcome-bg.js?t=" + Date.now());
  await onInstalled({ reason: "install" });
  ok(tabs.length === 1 && tabs[0] === "ext://welcome/welcome.html" && !store.whatsNew, "приветствие: при установке — страница, без метки");
  await onInstalled({ reason: "update", previousVersion: "0.27.0" });
  await onInstalled({ reason: "update", previousVersion: "0.27.1" });
  ok(tabs.length === 1 && !store.whatsNew && badge.text === "", "приветствие: перезапуск той же минорной версии — ничего");
  await onInstalled({ reason: "update", previousVersion: "0.25.3" });
  ok(tabs.length === 1 && store.whatsNew?.from === "0.25.3" && store.whatsNew.to === "0.27.0" && badge.text === "NEW", "приветствие: крупное обновление — без вкладки, метка и «NEW»");
  await onInstalled({ reason: "update", previousVersion: "0.26.0" });
  ok(store.whatsNew.from === "0.25.3", "приветствие: метку не смотрели — «новое» от самой старой версии");
  badge.text = "!";
  await paintWhatsNew();
  ok(badge.text === "!", "приветствие: «!» самопроверки важнее «NEW»");
  badge.text = "NEW";
  await chrome.storage.local.remove("whatsNew");
  await new Promise((r) => setTimeout(r, 0));
  ok(badge.text === "", "приветствие: метку сняли — значок гаснет");
  delete globalThis.chrome;
}

console.log(`автопроверки: ${passed} прошло${failed ? `, ${failed} не прошло` : ""}`);
process.exit(failed ? 1 : 0);
