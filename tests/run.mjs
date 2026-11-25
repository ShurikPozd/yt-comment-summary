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
import { linkRecord, revokeResult, savedLink, shareBody, shareResult } from "../share-core.js";
import * as ST from "../stats-core.js";
import * as LM from "../limit-core.js";
import { queueLeft, weeklyReport } from "../report-core.js";
import { MAX, WEEK, channelsOf, dayKey, dayLabel, enough, groupItems, markAllRead, mergeFeed, newCount, queueable, visible } from "../library/digest-core.js";
import { MODULES, createLoader } from "../lazy-bg.js";
import { moveIds, rangeIds, restoreAt, snapshot } from "../library/multi-core.js";
import { moveBefore, moveSteps, undoSteps } from "../queue-core.js";
import * as QT from "../library/queue-tidy-core.js";
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

// ---------- громкость по каналам (volume-core.js) ----------
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("../volume-core.js", import.meta.url), "utf8"), ctx);
  const C = ctx.__ytcsVolumeCore;
  const A = "UC" + "a".repeat(22);
  const B = "UC" + "b".repeat(22);
  ok(C.fmtVol(150) === "150 %" && C.fmtVol(99.6) === "100 %" && C.fmtVol(0) === "", "громкость по-русски: 150 % с неразрывным пробелом");
  ok(C.cleanVol(450) === 300 && C.cleanVol(0.4) === 1 && C.cleanVol(0) === null && C.cleanVol("x") === null && C.cleanVol(-5) === null, "громкость в пределах 1…300, ноль не запоминаем");
  ok(JSON.stringify(C.split(150)) === JSON.stringify({ slider: 100, gain: 1.5 }) && JSON.stringify(C.split(40)) === JSON.stringify({ slider: 40, gain: 1 }), "выше 100 % — ползунок 100 и усиление");
  ok(C.split(300).gain === 3 && C.split(100).gain === 1 && C.total(100, 1.5) === 150 && C.total(47.6, 1) === 48 && C.total(0, 2) === null, "ползунок × усиление");
  ok(C.step(100, 1) === 110 && C.step(105, -1) === 100 && C.step(300, 1) === 300 && C.step(10, -1) === 5 && C.step(5, -1) === 5 && C.step(48, 1, 5) === 55, "шаг − / + и колесо, тише 5 % — некуда");
  let m = C.remember({}, A, 150, "  Подкаст  ", 10);
  ok(m[A].v === 150 && m[A].n === "Подкаст" && m[A].t === 10, "запомнить громкость канала");
  ok(Object.keys(C.remember(m, "@handle", 50, "x")).length === 1 && Object.keys(C.remember(m, B, 0, "x")).length === 1, "без id канала и без громкости не запоминаем");
  ok(C.remember(m, A, 60, "", 20)[A].n === "Подкаст" && !(A in C.forget(m, A)) && A in m, "пустое название не затирает прежнее; забыть — исходный объект цел");
  let big = {};
  for (let i = 0; i < 5; i++) big = C.remember(big, "UC" + String(i).repeat(22), 120, "c" + i, i, 3);
  ok(Object.keys(big).length === 3 && !("UC" + "0".repeat(22) in big), "больше предела — вытесняются самые старые");
  big = C.touch(big, "UC" + "2".repeat(22), "", 100);
  big = C.remember(big, B, 70, "b", 101, 3);
  ok("UC" + "2".repeat(22) in big && !("UC" + "3".repeat(22) in big), "открытый недавно канал не вытесняется");
  ok(C.entryOf({ [A]: { v: "abc" } }, A) === null && C.entryOf({ [A]: { v: 70 } }, A).v === 70, "битая запись не читается");
  ok(JSON.stringify(C.list({ [A]: { v: 150, n: "a", t: 1 }, [B]: { v: 40, n: "b", t: 5 } }).map((e) => e.id)) === JSON.stringify([B, A]), "список: сначала недавние");
  const base = { enabled: true, stored: null, current: 80, normal: 80, ours: null, userChose: false, live: false };
  const P = (o) => JSON.stringify(C.plan({ ...base, ...o }));
  ok(P({ stored: 150 }) === JSON.stringify({ vol: 150, why: "channel" }), "у канала 150 % — ставим");
  ok(P({ stored: 150, current: 150 }) === "null" && P({ stored: 80, current: 80.4 }) === "null", "уже так — ничего не делаем");
  ok(P({ stored: 150, userChose: true }) === "null" && P({ stored: 150, live: true }) === "null" && P({ stored: 150, enabled: false }) === "null", "ваш выбор, эфир, выключено — не трогаем");
  ok(P({ current: 150, ours: 150 }) === JSON.stringify({ vol: 80, why: "restore" }), "громкость прошлого канала не переезжает — ваша обычная");
  ok(P({ current: 60, ours: 150 }) === "null" && P({ current: 60, ours: null }) === "null", "громкость сменили не мы — не трогаем");
  ok(P({ current: 150, ours: 150, normal: null }) === "null", "обычная ещё неизвестна — не гадаем");
  ok(P({ current: 100, ours: 150 }) === JSON.stringify({ vol: 80, why: "restore" }), "после перезагрузки: ползунок 100 от канала 150 % — тоже вернуть обычную");
  ok(P({ current: 100, ours: 60 }) === "null" && C.carried(100, 150) && !C.carried(100, 90) && !C.carried(null, 150), "ползунок 100 — «перенесено», только если у канала было громче 100 %");
  ok(JSON.stringify(C.observe({ normal: 80, ours: 150 }, 150)) === JSON.stringify({ normal: 80, ours: 150 }), "перенесённая громкость канала — не обычная");
  ok(JSON.stringify(C.observe({ normal: 80, ours: 150 }, 60)) === JSON.stringify({ normal: 60, ours: null }), "громкость сменили вне каналов — это новая обычная");
  ok(JSON.stringify(C.cleanState({ normal: "x", ours: 900 })) === JSON.stringify({ normal: null, ours: 300 }), "состояние из хранилища — только правильное");
}

// ---------- громкость по каналам на странице (volume.js с заглушкой плеера) ----------
{
  const A = "UC" + "a".repeat(22);
  const B = "UC" + "b".repeat(22);
  const C2 = "UC" + "c".repeat(22);
  const docL = {};
  const intervals = [];
  let timeouts = [];
  let now = 1_000_000;
  const store = { settings: {}, channelVolumes: { [A]: { v: 150, n: "Тихий подкаст", t: 1 } } };
  const sets = [];
  const wants = [];
  const fakeEl = () => {
    const cls = new Set();
    const el = {
      style: {},
      title: "",
      hidden: false,
      textContent: "",
      innerHTML: "",
      parentElement: null,
      scrollWidth: 0,
      clientWidth: 0,
      offsetHeight: 0,
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) },
      addEventListener() {},
      appendChild(ch) {
        ch.parentElement = el;
      },
      attachShadow: () => el,
      querySelector: () => fakeEl(),
      getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0 }),
    };
    return el;
  };
  class HTMLVideoElement {}
  const video = new HTMLVideoElement();
  const player = Object.assign(fakeEl(), { ad: false, querySelector: (sel) => (sel.includes("video") ? video : fakeEl()) });
  player.classList = { contains: (c) => c === "ad-showing" && player.ad };
  // ползунок YouTube и ответы мира страницы
  const yt = { volume: 80, muted: false, info: { videoId: "aaaaaaaaaaa", channelId: A, name: "Тихий подкаст", live: false } };
  const ctx = {
    console,
    JSON,
    Math,
    Number,
    Object,
    String,
    Set,
    Map,
    Promise,
    URLSearchParams,
    HTMLVideoElement,
    location: { pathname: "/watch", search: "?v=aaaaaaaaaaa" },
    setInterval: (fn, ms) => (intervals.push({ fn, ms }), intervals.length),
    clearInterval() {},
    setTimeout: (fn, ms) => (timeouts.push({ fn, at: now + ms }), timeouts.length),
    clearTimeout() {},
    Date: { now: () => now },
    CustomEvent: class {
      constructor(type, o) {
        this.type = type;
        this.detail = o?.detail;
      }
    },
    document: {
      getElementById: (id) => (id === "movie_player" ? player : null),
      querySelector: () => null,
      createElement: () => fakeEl(),
      addEventListener: (ev, fn) => (docL[ev] ||= []).push(fn),
      removeEventListener: (ev, fn) => (docL[ev] = (docL[ev] || []).filter((f) => f !== fn)),
      dispatchEvent: (e) => (docL[e.type] || []).slice().forEach((f) => f(e)),
    },
    window: { addEventListener() {} },
    chrome: {
      runtime: { id: "ext" },
      storage: {
        local: {
          get: async (k) => Object.fromEntries([].concat(k).filter((x) => x in store).map((x) => [x, structuredClone(store[x])])),
          set: async (o) => Object.assign(store, structuredClone(o)),
        },
        onChanged: { addListener() {} },
      },
    },
  };
  ctx.window.top = ctx.window;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  const fire = (type, detail, target) => ctx.document.dispatchEvent(Object.assign(new ctx.CustomEvent(type, { detail }), target ? { target } : {}));
  ctx.document.addEventListener("ytcs-speed:ask", () => fire("ytcs-speed:info", JSON.stringify(yt.info)));
  ctx.document.addEventListener("ytcs-vol:ask", () => fire("ytcs-vol:info", JSON.stringify({ volume: yt.volume, muted: yt.muted })));
  // setVolume у YouTube: ползунок меняется, <video> сообщает volumechange
  ctx.document.addEventListener("ytcs-vol:set", (e) => {
    sets.push(Number(e.detail));
    yt.volume = Number(e.detail);
    fire("volumechange", null, video);
  });
  ctx.__ytcsAudio = { want: (v, o) => (wants.push(o), "ok") };
  vm.runInContext(readFileSync(new URL("../volume-core.js", import.meta.url), "utf8"), ctx);
  vm.runInContext(readFileSync(new URL("../volume.js", import.meta.url), "utf8"), ctx);
  await new Promise((r) => setTimeout(r, 0)); // хранилище прочитано
  const wait = (ms) => {
    now += ms;
    const due = timeouts.filter((t) => t.at <= now);
    timeouts = timeouts.filter((t) => t.at > now);
    due.forEach((t) => t.fn());
  };
  const tick = () => intervals.find((t) => t.ms === 500).fn();
  const open = (id, info) => {
    ctx.location.search = "?v=" + id;
    yt.info = { videoId: id, ...info };
    tick();
  };
  const gain = () => wants[wants.length - 1]?.gain;
  const V = ctx.__ytcsVolume;
  tick();
  ok(sets.at(-1) === 100 && gain() === 1.5 && V.vol() === 150, "канал с 150 %: ползунок 100 и усиление 1,5");
  wait(400);
  ok(store.channelVolumeState?.normal === 80 && store.channelVolumeState?.ours === 150, "обычная громкость (80 %) запомнена до нашей смены");
  open("bbbbbbbbbbb", { channelId: B, name: "Музыка", live: false });
  ok(sets.at(-1) === 80 && gain() === 1 && V.vol() === 80, "канал без своей громкости — снова ваши 80 %, без усиления");
  // вы тянете ползунок YouTube
  ctx.document.dispatchEvent({ type: "pointerdown", target: { closest: (sel) => (sel.includes("ytp-volume-area") ? {} : null) } });
  yt.volume = 50;
  fire("volumechange", null, video);
  ctx.document.dispatchEvent({ type: "pointerup", target: {} });
  wait(500);
  ok(store.channelVolumes?.[B]?.v === undefined, "запись — не сразу (пауза, пока тянете)");
  wait(900);
  wait(400); // запись в хранилище — с паузой 0,3 с
  ok(store.channelVolumes?.[B]?.v === 50 && store.channelVolumes[B].n === "Музыка", "ваша громкость 50 % запомнена для канала");
  open("ccccccccccc", { channelId: C2, name: "Лекции", live: false });
  ok(sets.at(-1) === 80, "следующий канал без громкости — снова 80 %, а не 50 %");
  // кнопка + в меню расширения: 80 → 90 → … → 120 — усиление
  for (let i = 0; i < 4; i++) V.step(1);
  ok(V.vol() === 120 && sets.at(-1) === 100 && Math.abs(gain() - 1.2) < 1e-9, "кнопка + выше 100 % — усиление 1,2");
  wait(1000);
  wait(400);
  ok(store.channelVolumes?.[C2]?.v === 120, "громкость из меню тоже запоминается для канала");
  open("ddddddddddd", { channelId: C2, name: "Лекции", live: false });
  ok(V.vol() === 120 && Math.abs(gain() - 1.2) < 1e-9, "другое видео того же канала — 120 %");
  // эфир: громкость не трогаем, но усиление не переносим
  const n0 = sets.length;
  open("eeeeeeeeeee", { channelId: A, name: "Тихий подкаст", live: true });
  ok(sets.length === n0 && gain() === 1, "эфир: ползунок не трогаем, усиление снято");
  // реклама: граф без усиления и выравнивания
  open("fffffffffff", { channelId: A, name: "Тихий подкаст", live: false });
  ok(gain() === 1.5, "снова канал 150 %");
  player.ad = true;
  tick();
  ok(gain() === 1 && wants.at(-1).level === false, "реклама — без усиления");
  player.ad = false;
  tick();
  ok(gain() === 1.5, "после рекламы — снова 150 %");
  // «Сбросить» — канал забыт, ваша обычная громкость
  await V.reset();
  wait(400);
  ok(!(A in store.channelVolumes) && sets.at(-1) === 80 && gain() === 1, "«Сбросить»: канал забыт, снова 80 %");
}

// ---------- с того же места после обновления (resume-core.js) ----------
{
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(new URL("../resume-core.js", import.meta.url), "utf8"), ctx);
  const R = ctx.__ytcsResumeCore;
  const now = 1795500000000;
  const rec = R.pack({ id: "dQw4w9WgXcQ", t: 612.345, d: 1800.04, now });
  ok(rec.t === 612.3 && rec.d === 1800 && rec.at === now, "запись: секунда и длина с точностью 0,1 с");
  ok(R.pack({ id: "x", t: 5, d: Infinity, now }) === null && R.pack({ id: "", t: 5, d: 60, now }) === null && R.pack({ id: "x", t: NaN, d: 60, now }) === null, "эфир, пустое — не пишем");
  ok(JSON.stringify(R.unpack(JSON.stringify(rec))) === JSON.stringify(rec) && R.unpack("{oops") === null && R.unpack(null) === null && R.unpack('{"id":1}') === null, "чтение: своё — да, мусор — нет");
  const P = (o) => R.plan(rec, { id: "dQw4w9WgXcQ", nav: "reload", now: now + 60000, ...o });
  ok(P({}) === 612.3, "после F5 — то же место");
  ok(P({ nav: "back_forward" }) === 612.3, "после «Назад» и восстановления вкладок — тоже");
  ok(P({ nav: "navigate" }) === null, "обычный переход по ссылке — как решит YouTube (и метка &t=)");
  ok(P({ id: "jNQXAC9IVRw" }) === null, "другое видео — не трогаем");
  ok(P({ now: now + R.TTL_MS + 1 }) === null && P({ now: now - 1000 }) === null, "старая запись (или часы ушли назад) — не наша");
  ok(R.plan({ ...rec, t: 3 }, { id: rec.id, nav: "reload", now }) === null, "первые секунды — не о чем жалеть");
  ok(R.plan({ ...rec, t: 1797 }, { id: rec.id, nav: "reload", now }) === null, "у самого конца — досмотрено");
  ok(R.plan(null, { id: rec.id, nav: "reload", now }) === null, "записи нет — ничего");
  ok(R.sameVideo(rec, 1800.3) && !R.sameVideo(rec, 15) && !R.sameVideo(rec, NaN), "реклама (другая длина) и незагруженное — ждём сам ролик");
  ok(R.needSeek(612.3, 590) && !R.needSeek(612.3, 611) && !R.needSeek(612.3, NaN), "откат на 20 с — возвращаем, мелочь — нет");
  // надолго (chrome.storage.local)
  const day = 24 * 3600 * 1000;
  let m = R.put({}, { id: "a", t: 600, d: 1800, at: now }, now);
  ok(m.a && m.a.t === 600, "место запомнено");
  ok(R.put(m, { id: "a", t: 1790, d: 1800, at: now + 1 }, now + 1).a === undefined, "досмотрели (титры) — забыли");
  ok(R.put(m, { id: "a", t: 12, d: 1800, at: now + 1 }, now + 1).a.t === 600, "открыл и закрыл в первые полминуты — прежнее место цело");
  ok(R.put(m, null, now + R.LONG_TTL_MS + 1).a === undefined, "старше двух месяцев — забыто");
  const big = {};
  for (let i = 0; i < R.LONG_MAX + 5; i++) big["v" + i] = { t: 100, d: 900, at: now - (R.LONG_MAX + 5 - i) * 1000 };
  const cut = R.put(big, { id: "new", t: 100, d: 900, at: now }, now);
  ok(Object.keys(cut).length === R.LONG_MAX && cut.new && !cut.v0 && cut["v" + (R.LONG_MAX + 4)], "не больше 400 роликов — самые давние уходят");
  ok(R.put({ x: { t: "?" }, y: null }, null, now).x === undefined, "мусор в хранилище отбрасывается");
  const L = (o) => R.longTarget(m, { id: "a", now: now + day, urlT: false, ...o });
  ok(L({})?.t === 600, "открыли снова — место есть");
  ok(L({ urlT: true }) === null, "метка &t= в адресе — выбор явный, не трогаем");
  ok(L({ id: "b" }) === null && R.longTarget(null, { id: "a", now }) === null, "чужое видео и пусто — ничего");
  ok(R.longAction(600, 600.5) === "none" && R.longAction(600, 900) === "none", "уже там или дальше (досмотрели на телефоне) — ничего");
  ok(R.longAction(600, 580) === "seek" && R.longAction(600, 520) === "seek", "YouTube поставил на 20–80 с раньше — догоняем молча");
  ok(R.longAction(600, 0) === "offer" && R.longAction(600, 3) === "offer" && R.longAction(600, 300) === "offer", "с нуля или далеко позади — спрашиваем плашкой");
  ok(R.clock(754) === "12:34" && R.clock(3723) === "1:02:03" && R.clock(59.9) === "0:59", "время на плашке");
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

// ---------- подгрузка окон по требованию (lazy-bg.js) ----------
{
  // поддельный chrome.scripting: у каждой рамки свои «миры» (vm-контексты);
  // функции выполняются по тексту — как в Chrome, файлы «создают» глобальный объект модуля
  const GLOBAL_OF = {};
  for (const m of Object.values(MODULES)) for (const f of m.files) GLOBAL_OF[f] = m.global;
  const frames = new Map();
  const frame = (tabId, fid) => {
    const k = `${tabId}:${fid}`;
    if (!frames.has(k)) frames.set(k, { iso: vm.createContext({}), main: vm.createContext({}), files: [] });
    return frames.get(k);
  };
  const calls = [];
  let failNext = 0;
  let brokenFile = null;
  const scripting = {
    async executeScript({ target, world, files, func, args = [] }) {
      calls.push({ world: world || "ISOLATED", files: files || null, func: func?.name || null });
      await new Promise((r) => setTimeout(r, 2));
      if (failNext > 0) {
        failNext--;
        throw new Error("Cannot access contents of the page");
      }
      const f = frame(target.tabId, target.frameIds[0]);
      const ctx = world === "MAIN" ? f.main : f.iso;
      if (func) {
        ctx.__args = args;
        return [{ frameId: target.frameIds[0], result: vm.runInContext(`globalThis.globalThis = globalThis; (${func.toString()})(...__args)`, ctx) }];
      }
      for (const file of files) {
        f.files.push(`${world || "ISOLATED"}:${file}`);
        if (world === "MAIN") ctx[`main:${file}`] = true;
        else if (file !== brokenFile && GLOBAL_OF[file] && !ctx[GLOBAL_OF[file]])
          ctx[GLOBAL_OF[file]] = {
            closed: 0,
            close() {
              this.closed++;
            },
          };
      }
      return [{ frameId: target.frameIds[0], result: undefined }];
    },
  };
  const mkSession = () => {
    const data = {};
    return { data, get: async (k) => (k in data ? { [k]: data[k] } : {}), set: async (o) => Object.assign(data, o) };
  };
  const session = mkSession();
  const L = createLoader({ scripting, session });

  let r = await L.ensureModule(1, 0, "clip");
  ok(r.ok && !r.cached && frame(1, 0).iso.__ytcsClip, "подгрузка: клип вставлен");
  ok(JSON.stringify(frame(1, 0).files) === JSON.stringify(["MAIN:clip-main.js", "ISOLATED:clip.js"]), "подгрузка: сначала мир страницы, потом окно");
  calls.length = 0;
  r = await L.ensureModule(1, 0, "clip");
  ok(r.ok && r.cached && calls.length === 1 && calls[0].func === "probeModule", "подгрузка: повторно не вставляется (одна проверка)");

  const [a, b, c] = await Promise.all([L.ensureModule(1, 0, "playlists"), L.ensureModule(1, 0, "playlists"), L.ensureModule(1, 0, "playlists")]);
  ok(a.ok && b.ok && c.ok && frame(1, 0).files.filter((x) => x.endsWith(":playlists.js")).length === 1, "подгрузка: одновременные запросы — одна вставка");
  ok(frame(1, 0).main["main:playlists-main.js"] === true, "подгрузка: playlists-main.js — в мире страницы");

  await L.ensureModule(1, 0, "preview");
  ok(!frame(1, 0).files.some((x) => x.startsWith("MAIN:thumb")) && frame(1, 0).iso.__ytcsPreview, "подгрузка: превью — без мира страницы");

  await L.ensureModule(1, 3, "clip");
  ok(frame(1, 3).iso.__ytcsClip && frame(1, 0).files.filter((x) => x.endsWith(":clip.js")).length === 1, "подгрузка: каждая рамка — своя");

  // фон перезапустился (токен в storage.session тот же) — не вставляем заново
  const L2 = createLoader({ scripting, session });
  r = await L2.ensureModule(1, 0, "clip");
  ok(r.ok && r.cached, "подгрузка: перезапуск фона не вставляет повторно");

  // обновление расширения: Chrome очистил storage.session — новый токен, старая копия закрывается
  const old = frame(1, 0).iso.__ytcsClip;
  const L3 = createLoader({ scripting, session: mkSession() });
  r = await L3.ensureModule(1, 0, "clip");
  ok(r.ok && !r.cached && old.closed === 1 && frame(1, 0).iso.__ytcsClip !== old, "подгрузка: после обновления — вставляется заново, старая копия закрыта");
  ok(frame(1, 0).files.filter((x) => x.endsWith(":clip.js")).length === 2, "подгрузка: после обновления — файл вставлен ещё раз");

  // ошибка вставки (страница не YouTube, вкладку закрыли) — понятный ответ, следующий раз пробуем снова
  failNext = 1;
  r = await L.ensureModule(2, 0, "clip");
  ok(!r.ok && r.error === "inject" && /Cannot access/.test(r.message), "подгрузка: ошибка вставки — ok:false");
  r = await L.ensureModule(2, 0, "clip");
  ok(r.ok, "подгрузка: после ошибки — повторная попытка проходит");

  brokenFile = "thumb-preview.js";
  r = await L.ensureModule(3, 0, "preview");
  ok(!r.ok && r.error === "init", "подгрузка: файл не создал окно — init");
  brokenFile = null;
  ok((await L.ensureModule(1, 0, "nope")).error === "unknown" && (await L.ensureModule(undefined, 0, "clip")).error === "notab", "подгрузка: неизвестный модуль и нет вкладки");
  ok(typeof session.data.ytcsModToken === "string" && session.data.ytcsModToken.length > 6, "подгрузка: токен в storage.session");
}
{
  // сторона страницы (lazy.js): один запрос к фону на модуль, готовый — мгновенно, «последний плейлист»
  const sent = [];
  const ctx = vm.createContext({
    location: { pathname: "/watch" },
    setInterval: () => 0,
    chrome: {
      runtime: {
        id: "ext",
        sendMessage: async (m) => {
          sent.push(m);
          await new Promise((r) => setTimeout(r, 5));
          if (m.name === "clip") ctx.__ytcsClip = { open() {} };
          return { ok: m.name === "clip" };
        },
      },
      storage: { local: { get: async () => ({ plRecent: ["PL1", "PL2"], plNames: { PL1: "Музыка" } }) } },
    },
  });
  ctx.globalThis = ctx;
  const LAZY_SRC = readFileSync(new URL("../lazy.js", import.meta.url), "utf8");
  vm.runInContext(LAZY_SRC, ctx);
  const lz = ctx.__ytcsLazy;
  const [x, y] = await Promise.all([lz.load("clip"), lz.load("clip")]);
  ok(x === true && y === true && sent.length === 1 && sent[0].type === "mod:load", "lazy.js: два нажатия — один запрос к фону");
  ok((await lz.load("clip")) === true && sent.length === 1, "lazy.js: готовый модуль — без запроса");
  ok((await lz.load("preview")) === false, "lazy.js: фон не смог — false (плашку покажет вызвавший)");
  ok((await lz.load("bogus")) === false && sent.length === 2, "lazy.js: неизвестное имя — без запроса");
  const lp = await lz.lastPlaylist();
  ok(lp?.id === "PL1" && lp.title === "Музыка", "lazy.js: последний плейлист без загрузки окна");

  // Shorts: окно плейлистов (кнопка «Сохранить» в колонке ролика) подгружается само
  const sent2 = [];
  let tick = null;
  const ctx2 = vm.createContext({
    location: { pathname: "/shorts/abc" },
    setInterval: (f) => (tick = f),
    chrome: { runtime: { id: "e", sendMessage: async (m) => (sent2.push(m), { ok: false }) } },
  });
  ctx2.globalThis = ctx2;
  vm.runInContext(LAZY_SRC, ctx2);
  await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 6; i++) {
    await tick();
    await new Promise((r) => setTimeout(r, 2));
  }
  ok(sent2.length === 3 && sent2.every((m) => m.name === "playlists"), "lazy.js: на Shorts плейлисты грузятся сами, после 3 неудач — хватит");
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

// ---------- перестановка в колонке очереди (queue-core.js) ----------
{
  const q = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
  const ids = (list) => list.map((x) => x.id).join("");
  ok(ids(moveBefore(q, ["e"], "b")) === "aebcdf", "очередь: перетащили вверх — перед «b»");
  ok(ids(moveBefore(q, ["b"], "e")) === "acdbef", "очередь: перетащили вниз — перед «e»");
  ok(ids(moveBefore(q, ["b"], null)) === "acdefb", "очередь: before = null — в конец");
  ok(ids(moveBefore(q, ["e", "b"], "a")) === "beacdf", "очередь: группа — в порядке очереди, не выбора");
  ok(ids(moveBefore(q, ["b", "c"], "b")) === "abcdef", "очередь: перед собой — без изменений");
  ok(ids(moveBefore(q, ["b", "d"], "c")) === "abdcef", "очередь: before среди непереносимых между выбранными");
  ok(ids(moveBefore(q, ["c", "d"], "c")) === "abcdef", "очередь: before — первый из выбранных → перед следующим за ними");
  ok(ids(moveBefore(q, ["e", "f"], "e")) === "abcdef", "очередь: выбранные в конце, before — среди них → в конец, как были");
  ok(ids(moveBefore(q, ["b"], "zz")) === "abcdef", "очередь: before пропал — ничего не двигаем");
  ok(ids(moveBefore(q, ["zz"], "a")) === "abcdef", "очередь: переносимого нет — порядок прежний");
  ok(moveBefore(q, ["e"], "b").length === 6 && ids(q) === "abcdef", "очередь: исходный список не меняется, длина та же");
  // «Наверх» в колонке — перед первым после текущего («a» — текущее)
  ok(ids(moveBefore(q, ["d", "f"], "b")) === "adfbce", "очередь: «Наверх» — сразу после текущего");
  for (const [sel, before] of [[["e"], "b"], [["b", "e"], null], [["a", "c", "f"], "d"], [["d", "f"], "b"], [["b"], "e"]]) {
    const moved = moveBefore(q, sel, before);
    ok(ids(moveSteps(moved, undoSteps(q, sel))) === "abcdef", `очередь: «Вернуть» после ${sel.join("")} → ${before} — как было`);
  }
  ok(ids(moveSteps(q, [{ ids: ["a"], before: null }, { ids: ["f"], before: "b" }])) === "fbcdea", "очередь: несколько шагов подряд");
}

// ---------- выбор нескольких видео в библиотеке (library/multi-core.js) ----------
{
  const order = ["a", "b", "c", "d", "e", "f"];
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  ok(eq(rangeIds(order, "b", "e"), ["b", "c", "d", "e"]), "выбор: Shift — диапазон вниз");
  ok(eq(rangeIds(order, "e", "b"), ["b", "c", "d", "e"]), "выбор: Shift — диапазон вверх, в порядке на экране");
  ok(eq(rangeIds(order, null, "c"), ["c"]), "выбор: Shift без прошлого — одно видео");
  ok(eq(rangeIds(order, "zz", "c"), ["c"]), "выбор: прошлое пропало из списка — одно видео");
  ok(eq(rangeIds(order, "c", "nope"), []), "выбор: щелчок мимо списка — ничего");
  ok(eq(rangeIds(order, "d", "d"), ["d"]), "выбор: Shift по тому же — само видео");

  const q = order.map((id) => ({ id }));
  const ids = (list) => list.map((x) => x.id).join("");
  ok(ids(moveIds(q, ["e", "b", "d"], "top")) === "bdeacf", "выбор: «Наверх» — выбранные первыми в их порядке в очереди, не в порядке выбора");
  ok(ids(moveIds(q, ["a", "c"], "bottom")) === "bdefac", "выбор: «В конец» — выбранные последними, остальные не двигаются");
  ok(ids(moveIds(q, ["x"], "top")) === "abcdef", "выбор: нет в очереди — порядок прежний");
  ok(ids(moveIds(q, ["a", "b"], "top")) === "abcdef", "выбор: уже наверху — без изменений");

  const pos = { b: 120, e: 3 };
  const snap = snapshot(q, ["e", "b"], pos);
  ok(eq(snap.map((x) => [x.rec.id, x.at, x.t]), [["b", 1, 120], ["e", 4, 3]]), "выбор: снимок — места и где остановились, в порядке очереди");
  const left = q.filter((x) => x.id !== "b" && x.id !== "e");
  ok(ids(restoreAt(left, snap)) === "abcdef", "выбор: «Вернуть» — каждое на прежнее место");
  ok(ids(restoreAt(left, snap.slice().reverse())) === "abcdef", "выбор: «Вернуть» — порядок в списке не важен");
  ok(ids(restoreAt(left.slice(0, 2), snap)) === "abce", "выбор: очередь укоротилась — встают на прежние места или в конец");
  ok(ids(restoreAt([...left, { id: "b" }], snap)) === "acdfeb", "выбор: уже вернувшееся не задваивается");
}

// ---------- «Ссылка» на сводку (share-core.js) ----------
{
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const s = {
    summary: "Хвалят подачу.",
    topics: [{ name: "Подача", count: 12.7 }, { name: "" }, ...Array.from({ length: 20 }, (_, i) => ({ name: "т" + i, count: i }))],
    points: ["Понятно", "", 5],
    sentiment: { positive: 6, neutral: 3, negative: 1 },
    notable: Array.from({ length: 9 }, (_, i) => ({ author: "@a" + i, text: "к" + i, likes: i * 10, id: "x" + i, avatar: "https://yt3/x.jpg" })),
    commentCount: 1234,
    updatedAt: 1764000000000,
  };
  const b = shareBody(s, { title: "  Видео ", channelName: "Канал" }, "dQw4w9WgXcQ");
  ok(b && b.videoId === "dQw4w9WgXcQ" && b.title === "Видео" && b.channel === "Канал" && b.date === 1764000000000, "ссылка: тело — видео, название, канал, дата");
  ok(b.topics.length === 12 && b.topics[0].count === 12 && b.points.length === 1, "ссылка: темы до 12 с числами, пустые мнения выкинуты");
  ok(b.comments.length === 6 && eq(Object.keys(b.comments[0]).sort(), ["author", "likes", "text"]), "ссылка: до 6 ярких, без аватарок и id");
  ok(b.sentiment.positive === 6 && b.commentCount === 1234, "ссылка: настроение и число комментариев");
  ok(shareBody(s, {}, "bad") === null && shareBody({ summary: " " }, {}, "dQw4w9WgXcQ") === null && shareBody(null, {}, "dQw4w9WgXcQ") === null, "ссылка: без сводки или с негодным id — не отправляем");

  const r = shareResult(200, { ok: true, id: "AbCdEfGhIjKl", url: "https://bot.example/sum/AbCdEfGhIjKl/", existed: false });
  ok(r.ok && r.url.endsWith("/sum/AbCdEfGhIjKl/"), "ссылка: удачный ответ бота");
  const rec = linkRecord(r, s, "https://bot.example");
  ok(savedLink(rec, s, "https://bot.example")?.url === r.url, "ссылка: та же сводка — та же ссылка");
  ok(savedLink(rec, { ...s, updatedAt: s.updatedAt + 1 }, "https://bot.example") === null, "ссылка: сводку обновили — новая ссылка");
  ok(savedLink(rec, s, "https://other.example") === null && savedLink(null, s, "x") === null, "ссылка: другой бот или нет записи — новая ссылка");
  ok(shareResult(404, null).kind === "update" && /Обновите бота/.test(shareResult(405, null).text), "ссылка: старый бот — «Обновите бота»");
  ok(shareResult(200, { content: "x" }).kind === "update", "ссылка: странный ответ 200 — тоже старый бот");
  ok(shareResult(0, null).kind === "network" && shareResult(-1, null).kind === "timeout" && shareResult(403, {}).kind === "forbidden", "ссылка: сеть, таймаут, секрет");
  ok(shareResult(429, { code: "rate" }).kind === "busy" && shareResult(503, { code: "no_owner" }).kind === "setup" && shareResult(500, {}).kind === "error", "ссылка: лимит, владелец, сбой");
  ok(shareResult(200, { ok: true, id: "../x", url: "javascript:alert(1)" }).ok === false, "ссылка: негодный id/адрес не принимаем");
  ok(revokeResult(200, { ok: true, revoked: true }).ok && revokeResult(404, null).kind === "update" && revokeResult(0, null).kind === "network", "ссылка: отзыв");
}

// ---------- отчёт недели (report-core.js) ----------
{
  const now = new Date(2026, 10, 24, 12).getTime();
  const st = ST.emptyStats(now - 30 * 86400000);
  ST.addDelta(st, { w: 3 * 3600, s: 1200, sp: 900, sb: 300, si: 60, n: 9, fin: 4, qd: 2, qx: 5, ch: { id: "UC1", name: "Канал А", sec: 7200 } }, now - 86400000);
  ST.addDelta(st, { w: 1800, n: 2, ch: { id: "UC2", name: "Канал Б", sec: 1800 } }, now);
  const q = [{ id: "a", len: 600 }, { id: "b", len: 1200 }];
  const t = weeklyReport({ stats: st, queue: q, queuePos: { b: 600 }, now });
  ok(t && t.startsWith("📊 Неделя на YouTube"), "отчёт: заголовок");
  ok(/Смотрели: 3 ч 50 мин \(из них Shorts — 20 мин\)/.test(t), "отчёт: сколько смотрели и Shorts");
  ok(/Сэкономили: 21 мин \(скорость — 15 мин, пропуск рекламы — 5 мин, пропуск тишины — 1 мин\)/.test(t), "отчёт: экономия по видам");
  ok(/Чаще всего: Канал А — 2 ч, Канал Б — 30 мин/.test(t), "отчёт: каналы");
  ok(/Очередь: 2 видео \(≈ 20 мин\) · за неделю досмотрено 2, убрано 5/.test(t), "отчёт: очередь и движение");
  ok(queueLeft(q, { b: 600 }) === 1200 && queueLeft([{ id: "x" }]) === 0, "отчёт: остаток очереди");
  ok(weeklyReport({ stats: ST.emptyStats(now), queue: [], now }) === null && weeklyReport({}) === null, "отчёт: показать нечего — null");
  ok(/Очередь: 1 видео/.test(weeklyReport({ stats: null, queue: [{ id: "z", len: 30 }], now })), "отчёт: без статистики — только очередь");
}

// ---------- «Уборка очереди» (library/queue-tidy-core.js) ----------
{
  const D = 24 * 3600 * 1000;
  const now = 1_800_000_000_000;
  const v = (id, o = {}) => ({ id, title: "Видео " + id, channel: "к", len: 600, addedAt: now - D, ...o });
  const queue = [
    v("aaaaaaaaaaa"), // свежее, не начато — не мусор
    v("bbbbbbbbbbb", { addedAt: now - 90 * D }), // залежалось
    v("ccccccccccc", { addedAt: now - 90 * D }), // старое, но начато — не залежалось
    v("ddddddddddd"), // почти досмотрено
    v("eeeeeeeeeee", { addedAt: now - 120 * D }), // удалено (и старое — группа одна: недоступные)
    v("fffffffffff"), // дубль
    v("ggggggggggg", { len: 0 }), // длина неизвестна — «почти досмотрено» не считаем
    v("fffffffffff"),
    v("hhhhhhhhhhh", { addedAt: now - 59 * D }), // 59 дней — ещё не залежалось
    v("iiiiiiiiiii", { addedAt: now - 61 * D }), // 61 день, место 3 с — не начато
  ];
  const pos = { ccccccccccc: 60, ddddddddddd: 560, ggggggggggg: 500, iiiiiiiiiii: 3 };
  const avail = { eeeeeeeeeee: "gone", aaaaaaaaaaa: "ok" };
  const g = QT.groupQueue(queue, pos, { now, avail });
  const ids = (l) => l.map((x) => x.id).join(",");
  ok(ids(g.gone) === "eeeeeeeeeee" && g.gone[0].note === "удалено", "уборка: недоступные — по проверке");
  ok(ids(g.dups) === "fffffffffff" && g.dups[0].n === 1 && g.dups[0].d === 5 && g.dups[0].note === "ещё 1 копия", "уборка: дубль — одна запись на видео, первая копия");
  ok(ids(g.almost) === "ddddddddddd" && g.almost[0].pct === 93, "уборка: почти досмотрено — больше 90%");
  ok(ids(g.stale) === "bbbbbbbbbbb,iiiiiiiiiii" && g.stale[0].days === 90, "уборка: залежалось — больше 60 дней и не начато (место < 5 с)");
  const all = [...g.gone, ...g.dups, ...g.almost, ...g.stale].map((x) => x.id);
  ok(all.length === new Set(all).size, "уборка: у каждого видео одна группа");
  ok(QT.groupQueue([v("xxxxxxxxxxx", { addedAt: 0 })], {}, { now }).stale.length === 0, "уборка: без даты добавления — не залежалось");
  ok(QT.groupQueue(queue, pos, { now, avail: { ddddddddddd: "private" } }).gone[0]?.note === "приватное", "уборка: недоступное важнее «почти досмотрено»");
  ok(QT.groupQueue([v("x1xxxxxxxxx"), v("x1xxxxxxxxx"), v("x1xxxxxxxxx")], {}, { now }).dups[0].note === "ещё 2 копии", "уборка: число копий");

  const picked = QT.defaultPicked(g);
  ok(picked.has("eeeeeeeeeee") && picked.has("fffffffffff") && picked.has("ddddddddddd") && !picked.has("bbbbbbbbbbb"), "уборка: по умолчанию всё, кроме залежавшегося");
  ok(QT.groupState(g.stale, picked) === "none" && QT.groupState(g.gone, picked) === "all", "уборка: состояние галочки группы");
  ok(QT.groupState(g.stale, new Set(["bbbbbbbbbbb"])) === "some", "уборка: группа отмечена частично");

  picked.add("bbbbbbbbbbb");
  const plan = QT.removalPlan(queue, pos, g, picked);
  ok(plan.drop.join(",") === "bbbbbbbbbbb,eeeeeeeeeee,fffffffffff" && plan.done.join(",") === "ddddddddddd", "уборка: что убрать — по порядку очереди, досмотренное отдельно");
  ok(plan.keep.length === 1 && plan.keep[0].at === 2 && plan.keep[0].rec.id === "fffffffffff", "уборка: первая копия дубля возвращается на место");
  ok(plan.undo.done.length === 1 && plan.undo.done[0].t === 560 && plan.undo.drop.map((x) => x.at).join(",") === "1,3" && plan.undo.done[0].at === 3, "уборка: «Вернуть» — прежние места и место просмотра");
  ok(plan.count === 4, "уборка: число отмеченных видео");
  // после «Убрать» (все копии) + «вернуть первую копию» дубль остаётся один
  const removedIds = new Set([...plan.drop, ...plan.done]);
  const after = restoreAt(queue.filter((x) => !removedIds.has(x.id)), plan.keep);
  ok(after.filter((x) => x.id === "fffffffffff").length === 1 && after.findIndex((x) => x.id === "fffffffffff") === 2, "уборка: дубль — одна копия, на месте первой");
  // «Вернуть» — всё на места (копию дубля второй раз не добавляем)
  const back = restoreAt(restoreAt(after, plan.undo.drop), plan.undo.done);
  ok(back.map((x) => x.id).join() === queue.filter((x, i) => i !== 7).map((x) => x.id).join(), "уборка: «Вернуть» — очередь как была, без лишней копии");

  // ответы oEmbed и страницы видео
  ok(QT.oembedVerdict(200) === "ok" && QT.oembedVerdict(404) === "gone" && QT.oembedVerdict(401) === "check" && QT.oembedVerdict(403) === "check", "уборка: oEmbed — есть, удалено, проверить страницей");
  ok(QT.oembedVerdict(429) === "retry" && QT.oembedVerdict(0) === "retry" && QT.oembedVerdict(503) === "retry", "уборка: oEmbed — лимит и сбой не считаем недоступностью");
  const pl = (st, reason = "") => `var ytInitialPlayerResponse = {"responseContext":{},"playabilityStatus":{"status":"${st}","reason":"${reason}","messages":["x"]}};`;
  ok(QT.playability(pl("OK")) === "ok" && QT.playability(pl("ERROR", "Video unavailable")) === "gone" && QT.playability(pl("UNPLAYABLE", "Not available in your country")) === "blocked", "уборка: страница — есть, удалено, заблокировано");
  ok(QT.playability(pl("LOGIN_REQUIRED", "This video is private")) === "private" && QT.playability(pl("LOGIN_REQUIRED", "Войдите, чтобы подтвердить возраст")) === "ok", "уборка: приватное — да, «подтвердите возраст» — нет");
  ok(QT.playability(pl("LOGIN_REQUIRED", "Sign in to confirm your age")) === "ok" && QT.playability(pl("AGE_CHECK_REQUIRED")) === "ok", "уборка: возрастные ограничения — смотреть можно");
  ok(QT.playability("<html>капча</html>") === null && QT.playability("") === null, "уборка: не разобрали страницу — не знаем");

  // кеш проверок
  const cache = { aaaaaaaaaaa: { s: "ok", at: now - D }, bbbbbbbbbbb: { s: "ok", at: now - 10 * D }, ccccccccccc: { s: "gone", at: now } };
  ok(QT.needCheck(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd", "ddddddddddd"], cache, now).join() === "bbbbbbbbbbb,ddddddddddd", "уборка: перепроверяем старое и новое, без повторов");
  ok(QT.availOf(cache).ccccccccccc === "gone" && Object.keys(QT.pruneCache(cache, ["ccccccccccc"])).join() === "ccccccccccc", "уборка: кеш — вердикты и чистка");

  // темп проверок: не чаще perSec в секунду, не больше parallel сразу, отмена
  const t0 = Date.now();
  const hit = [];
  let inFlight = 0;
  let maxFlight = 0;
  const okAll = await QT.paced(
    ["1", "2", "3", "4", "5", "6"],
    async (id) => {
      inFlight++;
      maxFlight = Math.max(maxFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return id === "3" ? "gone" : "ok";
    },
    { perSec: 50, parallel: 2, onDone: (id, v2) => hit.push(id + v2) }
  );
  const took = Date.now() - t0;
  ok(okAll && hit.length === 6 && hit.includes("3gone") && maxFlight <= 2, "уборка: проверки — все, не больше двух сразу");
  ok(took >= 5 * 20 - 5, "уборка: проверки — не чаще 50 в секунду");
  const ac = new AbortController();
  const got = [];
  const fin = await QT.paced(
    ["a", "b", "c", "d", "e"],
    async (id) => {
      if (id === "b") ac.abort();
      return "ok";
    },
    { perSec: 1000, parallel: 1, signal: ac.signal, onDone: (id) => got.push(id) }
  );
  ok(fin === false && got.join() === "a", "уборка: «Остановить» — дальше не проверяем");
  const errs = [];
  await QT.paced(
    ["a", "b"],
    async (id) => {
      if (id === "a") throw new Error("сеть");
      return "ok";
    },
    { perSec: 1000, onDone: (id, v2) => errs.push(`${id}:${v2}`) }
  );
  ok(errs.sort().join() === "a:null,b:ok", "уборка: сбой запроса — «не знаем», не недоступно");
}

// ---------- очередь на телефоне: синхронизация с ботом (yqsync-core.js, yqsync-bg.js) ----------
{
  const Y = await import("../yqsync-core.js");
  const q = [
    { id: "dQw4w9WgXcQ", title: "Т".repeat(400), channel: "К", len: 213.4, addedAt: 1795000000999 },
    { id: "bad", title: "плохой" },
    { id: "jNQXAC9IVRw", title: "Zoo", short: true, addedAt: 1795000500000 },
  ];
  const pl = Y.queuePayload(q, { dQw4w9WgXcQ: 100.7, jNQXAC9IVRw: 3 });
  ok(pl.length === 2 && pl[0].title.length === 300 && pl[0].len === 213 && pl[0].pos === 100 && pl[0].added === 1795000000, "выжимка очереди: поля, длины, секунды");
  ok(pl[1].pos === 0 && pl[1].short === true && Y.queuePayload(Array(2100).fill(q[0])).length === Y.YQ_MAX, "выжимка: меньше 5 с — не начато; не больше 2000");
  ok(Y.hashOf("abc") === Y.hashOf("abc") && Y.hashOf("abc") !== Y.hashOf("abd"), "отпечаток очереди");
  const plan = Y.planMarks(q, [
    { id: "dQw4w9WgXcQ", act: "done", at: 1795000100 },
    { id: "jNQXAC9IVRw", act: "drop", at: 1795000100 }, // видео добавили позже отметки — остаётся
    { id: "9bZkp7q19f0", act: "drop", at: 1795000100 }, // в очереди уже нет — просто подтвердить
    { id: "../x", act: "drop", at: 1 },
    { id: "kJQP7kiw5Fk", act: "nuke", at: 1 },
  ]);
  ok(plan.done.join() === "dQw4w9WgXcQ" && plan.drop.length === 0, "отметки: убираем только то, что добавлено не позже отметки");
  ok(plan.acks.map((a) => a.id).join() === "dQw4w9WgXcQ,jNQXAC9IVRw,9bZkp7q19f0", "отметки: подтверждаем и применённые, и устаревшие");
  ok(Y.planMarks([{ id: "jNQXAC9IVRw", addedAt: 1795000100500 }], [{ id: "jNQXAC9IVRw", act: "drop", at: 1795000100 }]).drop.length === 1, "отметка в ту же секунду, что добавление — как у бота, убираем");

  // фон: поддельные chrome.* и бот
  const store = { settings: { baseUrl: "https://bot.example/", token: "test-token" }, queue: q.filter((x) => x.id !== "bad"), queuePos: {} };
  const alarms = new Map();
  const changed = [];
  const alarmFns = [];
  globalThis.chrome = {
    runtime: { getURL: (p2) => `chrome-extension://abc/${p2}`, getManifest: () => ({ version: "9.9.9" }) },
    storage: {
      local: {
        get: async (k) => {
          const keys = k === null ? Object.keys(store) : Array.isArray(k) ? k : [k];
          return Object.fromEntries(keys.filter((x) => x in store).map((x) => [x, structuredClone(store[x])]));
        },
        set: async (o) => Object.assign(store, structuredClone(o)),
      },
      onChanged: { addListener: (fn) => changed.push(fn) },
    },
    alarms: {
      get: async (n) => alarms.get(n) || null,
      create: async (n, o) => void alarms.set(n, { name: n, scheduledTime: o.when ?? Date.now() + (o.delayInMinutes || 0) * 60000, ...o }),
      onAlarm: { addListener: (fn) => alarmFns.push(fn) },
    },
    tabs: { query: async () => [{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }] },
  };
  const realFetch = globalThis.fetch;
  const sent = [];
  const bot = { rev: "", marks: [], status: 200, want: null };
  globalThis.fetch = async (url, opt = {}) => {
    if (String(url).endsWith("local-config.js")) return { ok: false };
    const body = JSON.parse(opt.body);
    sent.push({ url: String(url), opt, body });
    if (bot.status !== 200) return { status: bot.status, ok: false, json: async () => ({ error: "сбой" }) };
    for (const a of body.acks || []) bot.marks = bot.marks.filter((m) => !(m.id === a.id && m.at <= a.at));
    if (body.items) bot.rev = body.rev;
    const want = bot.want ?? (Boolean(body.rev) && bot.rev !== body.rev);
    bot.want = null;
    return { status: 200, ok: true, json: async () => ({ ok: true, marks: bot.marks, want }) };
  };
  const removed = [];
  const bg = await import("../yqsync-bg.js?t=" + Date.now());
  bg.initYqSync({
    remove: async (ids, why) => {
      removed.push(`${ids.join("+")}:${why}`);
      store.queue = store.queue.filter((x) => !ids.includes(x.id));
    },
  });
  const t0 = Date.now();
  changed.forEach((fn) => fn({ queue: { newValue: [] } }, "local"));
  await new Promise((r) => setTimeout(r, 20));
  ok(alarms.get("ytcs-yqsync")?.scheduledTime >= t0 + 59000, "изменение очереди — отправка будильником через минуту");
  let r = await bg.syncNow();
  ok(r.ok && r.sent && sent.length === 1 && sent[0].url === "https://bot.example/api/yq-sync", "первая отправка — сразу вся очередь");
  ok(sent[0].opt.headers["X-Sec-Token"] === "test-token" && sent[0].body.items.length === 2 && sent[0].body.ver === "9.9.9", "секрет как у /api/backup, версия расширения");
  store.queuePos = { dQw4w9WgXcQ: 150 };
  alarms.delete("ytcs-yqsync"); // одноразовый будильник после срабатывания исчезает
  alarmFns.forEach((fn) => fn({ name: "ytcs-yqsync" })); // сработал будильник «через минуту»
  r = await bg.syncNow();
  ok(!r.sent && !sent[1].body.items && sent[1].body.rev === sent[0].body.rev, "через минуту — только спросить отметки, очередь подождёт 10 минут");
  ok(store.yqSync.hash === sent[0].body.rev && alarms.get("ytcs-yqsync").scheduledTime >= store.yqSync.at + 599000, "изменения ждут будильника через 10 минут");
  bot.marks = [{ id: "dQw4w9WgXcQ", act: "done", at: Math.floor(Date.now() / 1000) }, { id: "jNQXAC9IVRw", act: "drop", at: 1795000000 }];
  const n0 = sent.length;
  r = await bg.syncNow();
  ok(removed.join() === "dQw4w9WgXcQ:done", "«Досмотрел» с телефона — убрано из очереди как досмотренное");
  ok(store.queue.map((x) => x.id).join() === "jNQXAC9IVRw", "видео, добавленное позже отметки «Убрать», осталось");
  const follow = sent[sent.length - 1].body;
  ok(sent.length === n0 + 2 && follow.acks.length === 2 && follow.items.length === 1, "сразу подтверждение отметок и новая очередь");
  ok(bot.marks.length === 0 && store.yqSync.acks.length === 0, "бот стёр отметки, подтверждать больше нечего");
  bot.want = true;
  const n1 = sent.length;
  await bg.syncNow();
  ok(sent.length === n1 + 2 && sent[n1 + 1].body.items?.length === 1, "бот потерял очередь — присылаем её сразу");
  bot.status = 500;
  store.queue = [];
  r = await bg.syncNow({ force: true });
  ok(r.err && store.yqSync.err && alarms.get("ytcs-yqsync").scheduledTime >= Date.now() + 590000, "бот не ответил — ошибка запомнена, повтор через 10 минут");
  bot.status = 200;
  store.settings = { baseUrl: "https://bot.example", token: "" };
  const n2 = sent.length;
  r = await bg.syncNow();
  ok(r.skip === "setup" && sent.length === n2, "без секрета — к боту не ходим");
  alarms.delete("ytcs-yqpoll");
  await bg.setupYqSync();
  ok(alarms.get("ytcs-yqpoll")?.periodInMinutes === 5 && alarms.has("ytcs-yqsync"), "будильники: раз в 5 минут отметки, при запуске — сверка");
  globalThis.fetch = realFetch;
  delete globalThis.chrome;
}

// ---------- мягкий лимит времени (limit-core.js, limit-bg.js) ----------
{
  const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime(); // ноябрь 2026, местное время
  ok(LM.limitDay(at(25, 10)) === "2026-11-25" && LM.limitDay(at(26, 2, 30)) === "2026-11-25" && LM.limitDay(at(26, 4)) === "2026-11-26", "лимит: новый день — в 4 утра");
  ok(LM.limitDay(new Date(2026, 0, 1, 1).getTime()) === "2025-12-31" && LM.limitDay(new Date(2026, 2, 1, 3, 59).getTime()) === "2026-02-28", "лимит: ночь после смены месяца и года — ещё прошлый день");
  ok(LM.cleanCfg(null).on === false && LM.cleanCfg(null).min === 120 && LM.cleanCfg({ on: true, min: 45 }).min === 120 && LM.cleanCfg({ on: true, min: 90 }).min === 90, "лимит: настройка — выключено сразу, 2 ч, чужие значения отбрасываются");
  ok(LM.PRESETS.map(LM.fmtLimit).join("|") === "30 мин|1 ч|1,5 ч|2 ч|3 ч|4 ч", "лимит: подписи вариантов");
  ok(LM.fmtSpent(7199) === "1 ч 59 мин" && LM.fmtSpent(7230) === "2 ч" && LM.fmtSpent(6000) === "1 ч 40 мин" && LM.fmtSpent(59) === "0 мин" && LM.fmtSpent(8100) === "2 ч 15 мин", "лимит: просмотренное — вниз до минуты");
  ok(LM.fmtLeft(30) === "1 мин" && LM.fmtLeft(1200) === "20 мин" && LM.fmtLeft(3900) === "1 ч 05 мин", "лимит: остаток — вверх до минуты");
  const on = { on: true, min: 60 };
  const t = at(25, 20);
  let rec = LM.addWatch(null, 0, t);
  ok(rec.day === "2026-11-25" && rec.sec === 0 && !rec.done, "лимит: новая запись дня");
  rec = LM.addWatch(rec, 3590, t);
  ok(!LM.shouldShow(rec, on, t), "лимит: до порога — не показываем");
  ok(!LM.shouldShow(LM.addWatch(rec, 20, t), { on: false, min: 60 }, t), "лимит: выключен — не показываем");
  rec = LM.addWatch(rec, 15, t);
  ok(LM.shouldShow(rec, on, t), "лимит: пересекли — показываем");
  rec = LM.markShown(rec, on, t);
  ok(!LM.shouldShow(LM.addWatch(rec, 3000, t), on, t), "лимит: показали — больше не показываем (не на каждом видео)");
  rec = LM.applyAction(rec, "snooze", t);
  ok(rec.next === rec.sec + 900 && !LM.shouldShow(LM.addWatch(rec, 890, t), on, t), "лимит: «Ещё 15 мин» — 15 минут тихо");
  rec = LM.addWatch(rec, 910, t);
  ok(LM.shouldShow(rec, on, t), "лимит: через 15 минут просмотра — снова");
  rec = LM.applyAction(LM.markShown(rec, on, t), "close", t);
  ok(!LM.shouldShow(LM.addWatch(rec, 5000, t), on, t), "лимит: «Закрыть» — на сегодня всё");
  ok(LM.shouldShow(LM.addWatch(rec, 5000, t), { on: true, min: 120 }, t), "лимит: поменяли лимит — напомним под новое значение");
  const next = at(26, 4, 1);
  ok(LM.cleanDay(rec, next).sec === 0 && !LM.shouldShow(rec, on, next), "лимит: в 4 утра — новый день с нуля");
  ok(LM.addWatch(null, 10, t, 1800).sec === 1810 && LM.addWatch({ day: "2026-11-24", sec: 9 }, 10, t, 1800).sec === 10, "лимит: первый запуск — с тем, что уже насмотрено сегодня; вчерашняя запись — с нуля");
  ok(LM.cleanDay({ day: "2026-11-25", sec: "x", next: -5, lim: 7 }, t).sec === 0 && LM.cleanDay({ day: "2026-11-25", sec: 1e9 }, t).sec === 86400, "лимит: битая запись — к правильному виду");
  const pr = LM.progress({ day: "2026-11-25", sec: 6000 }, { on: true, min: 120 }, t);
  ok(Math.abs(pr.frac - 6000 / 7200) < 1e-9 && !pr.over && pr.left === 1200, "лимит: полоска «1 ч 40 мин из 2 ч»");

  // фон: прибавки из вкладок, плашка — только в ту вкладку и только раз
  const store = { settings: {}, watchLimit: { on: true, min: 30 } };
  let listener = null;
  const shown = [];
  let tabOk = true;
  globalThis.chrome = {
    runtime: { id: "ext", onMessage: { addListener: (f) => (listener = f) } },
    tabs: { sendMessage: async (tabId, msg, opt) => (shown.push({ tabId, msg, frameId: opt?.frameId }), { ok: tabOk }) },
    storage: { local: { get: async (k) => Object.fromEntries([].concat(k).filter((x) => x in store).map((x) => [x, structuredClone(store[x])])), set: async (o) => Object.assign(store, structuredClone(o)) } },
  };
  const bg = await import("../limit-bg.js?t=" + Date.now());
  const send = (sec, tab = 7, frameId = 0) => listener({ type: "stats:add", delta: { w: sec } }, { id: "ext", tab: { id: tab }, frameId }, () => {});
  for (let i = 0; i < 10; i++) send(170, 7);
  await bg.limitAdd(0);
  ok(store.watchLimitDay?.sec === 1700 && shown.length === 0, "фон лимита: прибавки складываются, до порога тихо");
  send(60, 7);
  send(60, 9, 3); // пересекли лимит в рамке плеера библиотеки (вкладка 9, рамка 3)
  send(60, 7);
  await bg.limitAdd(0);
  ok(shown.length === 1 && shown[0].tabId === 9 && shown[0].frameId === 3 && shown[0].msg.spent === "30 мин", "фон лимита: плашка — один раз, той вкладке и рамке, что играла");
  ok(store.watchLimitDay.done === true && store.watchLimitDay.lim === 30, "фон лимита: показали — отмечено");
  let reply = null;
  listener({ type: "limit:act", act: "snooze" }, { id: "ext" }, (r) => (reply = r));
  await bg.limitAdd(0);
  ok(reply?.ok && store.watchLimitDay.next === store.watchLimitDay.sec + 900, "фон лимита: «Ещё 15 мин» с плашки");
  tabOk = false;
  for (let i = 0; i < 6; i++) send(170, 7);
  await bg.limitAdd(0);
  ok(shown.length >= 2 && store.watchLimitDay.done === false, "фон лимита: плашка не показалась — напоминание не тратится");
  tabOk = true;
  send(15, 7);
  await bg.limitAdd(0);
  ok(store.watchLimitDay.done === true && shown.at(-1).tabId === 7, "фон лимита: со следующей прибавкой — показали");
  listener({ type: "stats:add", delta: { w: 999 } }, { id: "чужое", tab: { id: 1 } }, () => {});
  const before = store.watchLimitDay.sec;
  store.settings = { watchStats: false };
  send(100, 7);
  await bg.limitAdd(0);
  ok(store.watchLimitDay.sec === before, "фон лимита: чужие сообщения и выключенная статистика — не считаем");
  delete store.watchLimitDay;
  store.settings = {};
  store.watchStats = { v: 1, since: 1, days: { [ST.dayKey()]: { w: 600, s: 60 } }, ch: {} };
  await bg.limitAdd(10);
  ok(store.watchLimitDay.sec === 670, "фон лимита: первый запуск — подхватывает «сегодня» из статистики");
  delete globalThis.chrome;
}

// ---------- двойные субтитры (dualsubs-core.js) ----------
{
  const ctx = vm.createContext({ URL });
  vm.runInContext(readFileSync(new URL("../dualsubs-core.js", import.meta.url), "utf8"), ctx);
  const D = ctx.__ytcsDualCore;
  const J = (x) => JSON.stringify(x);
  ok(D.langOf("de") === "de" && D.langOf("xx") === "ru" && D.langOf(undefined) === "ru", "язык перевода: известный — он, иначе русский");
  ok(D.baseLang("en-US") === "en" && D.baseLang("zh-Hans") === "zh" && D.baseLang("") === "", "основа языка");
  // выбор дорожек — на тех видах списка, что отдаёт YouTube
  const man = { tracks: [{ lang: "en", kind: "", tr: true }, { lang: "en", kind: "asr", tr: true }, { lang: "es-419", kind: "", tr: true }], defaultIndex: 0 };
  ok(J(D.pickTracks(man, "ru")) === J({ src: { lang: "en", kind: "" }, tr: { lang: "en", kind: "", tlang: "ru" } }), "ручные + автоматические: оригинал — ручная, перевод — автоперевод YouTube");
  ok(J(D.pickTracks({ tracks: [{ lang: "en", kind: "asr", tr: true }], defaultIndex: 0 }, "ru")) === J({ src: { lang: "en", kind: "asr" }, tr: { lang: "en", kind: "asr", tlang: "ru" } }), "только автоматические — они и переводятся");
  ok(D.pickTracks({ tracks: [{ lang: "ru", kind: "asr", tr: true }], defaultIndex: 0 }, "ru").skip === "same", "видео уже по-русски — ничего не делаем");
  ok(D.pickTracks({ tracks: [{ lang: "en-GB", kind: "", tr: true }], defaultIndex: 0 }, "en").skip === "same", "en-GB при переводе на английский — тоже тот же язык");
  ok(D.pickTracks({ tracks: [], defaultIndex: 0 }, "ru").skip === "none" && D.pickTracks(null, "ru").skip === "none", "нет субтитров — тихо ничего");
  ok(D.pickTracks({ tracks: [{ lang: "en", kind: "", tr: false }], defaultIndex: 0 }, "ru").skip === "notr", "перевод запрещён — ничего");
  const own = { tracks: [{ lang: "en", kind: "", tr: true }, { lang: "ru", kind: "", tr: true }, { lang: "en", kind: "asr", tr: true }], defaultIndex: 1 };
  ok(J(D.pickTracks(own, "ru")) === J({ src: { lang: "en", kind: "" }, tr: { lang: "ru", kind: "", tlang: "" } }), "есть ручной русский — берём его, а не автоперевод; оригинал — по языку речи");
  // автодубляж: автоматические дорожки на 20 языках, язык речи — по исходному звуку
  const dub = { tracks: ["en", "ar", "ru", "de"].map((l) => ({ lang: l, kind: "asr", tr: true })), defaultIndex: 0, audioLang: "en-US" };
  ok(J(D.pickTracks(dub, "ru")) === J({ src: { lang: "en", kind: "asr" }, tr: { lang: "en", kind: "asr", tlang: "ru" } }), "автодубляж: оригинал по исходному звуку, распознанный дубляж не берём");
  ok(J(D.pickTracks({ ...dub, audioLang: "" }, "de")) === J({ src: { lang: "en", kind: "asr" }, tr: { lang: "en", kind: "asr", tlang: "de" } }), "автодубляж без языка звука — дорожка по умолчанию");
  // адрес дорожки из адреса плеера: токен остаётся, язык и формат — наши
  const cap = "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&ei=x&lang=en&kind=asr&name=foo&potc=1&pot=TOKEN%3D&fmt=srv3&c=WEB";
  const tu = new URL(D.trackUrl(cap, { lang: "en", kind: "", tlang: "ru" }));
  ok(tu.searchParams.get("pot") === "TOKEN=" && tu.searchParams.get("lang") === "en" && !tu.searchParams.has("kind") && !tu.searchParams.has("name") && tu.searchParams.get("tlang") === "ru" && tu.searchParams.get("fmt") === "json3" && tu.searchParams.get("c") === "WEB", "адрес перевода: токен плеера, tlang, json3");
  const tu2 = new URL(D.trackUrl(cap.replace("&kind=asr", ""), { lang: "en", kind: "asr" }));
  ok(tu2.searchParams.get("kind") === "asr" && !tu2.searchParams.has("tlang"), "адрес оригинала: автоматическая дорожка без перевода");
  ok(D.trackUrl("https://www.youtube.com/watch?v=x", { lang: "en" }) === "" && D.trackUrl("::", { lang: "en" }) === "", "чужой адрес — пусто");
  ok(D.urlVideo(cap) === "dQw4w9WgXcQ" && D.urlVideo("https://www.youtube.com/api/stats?v=x") === "", "id видео из адреса субтитров");
  // разбор json3: ручная дорожка (как у YouTube: пустое событие, перенос строки внутри)
  const manJ = { events: [{ tStartMs: 0, dDurationMs: 45200, id: 1, wpWinPosId: 1 }, { tStartMs: 45200, dDurationMs: 1880, segs: [{ utf8: "" }] }, { tStartMs: 47320, dDurationMs: 3800, segs: [{ utf8: "Never gonna run around\nand desert you" }] }, { tStartMs: 51480, dDurationMs: 2000, segs: [{ utf8: "[Music]" }] }, { tStartMs: 53600, dDurationMs: 1920, segs: [{ utf8: "Never gonna say goodbye" }] }] };
  const mc = D.parseJson3(manJ);
  ok(J(mc) === J([{ s: 47320, e: 51120, text: "Never gonna run around and desert you" }, { s: 53600, e: 55520, text: "Never gonna say goodbye" }]), "json3: пустые, служебные и окна без текста отброшены, перенос — пробел");
  // автоматическая по словам: tOffsetMs, строки-переносы aAppend, наезд друг на друга
  const asrJ = { events: [{ tStartMs: 29119, dDurationMs: 5241, wWinId: 1, segs: [{ utf8: "думаю" }] }, { tStartMs: 30269, dDurationMs: 4091, wWinId: 1, aAppend: 1, segs: [{ utf8: "\n" }] }, { tStartMs: 30279, dDurationMs: 9280, wWinId: 1, segs: [{ utf8: ".  " }, { utf8: "От ", tOffsetMs: 485 }, { utf8: "любого ", tOffsetMs: 970 }, { utf8: "парня", tOffsetMs: 1455 }] }, { tStartMs: 34360, dDurationMs: 8760, wWinId: 1, segs: [{ utf8: "Я " }, { utf8: "хочу", tOffsetMs: 542 }] }] };
  const ac = D.parseJson3(asrJ);
  ok(J(ac.map((c) => c.text)) === J(["думаю", ". От любого парня", "Я хочу"]), "json3 по словам: слова склеены, точка в начале — от прошлой фразы, не теряем");
  ok(J(D.pairCues([{ s: 29000, e: 44000, text: ". So" }], ac).map((c) => [c.text, c.tr])) === J([["So", "думаю. От любого парня Я хочу"]]), "склейка: точка прилипает к прошлому куску, в начале строки — убрана");
  ok(D.joinParts(["потемнела", ". Мы вернулись", ", ребята"]) === "потемнела. Мы вернулись, ребята" && D.clean("…, да") === "да" && D.clean("") === "", "склейка кусков и чистка начала");
  ok(ac[0].e === 30279 && ac[1].e === 34360 && ac[2].e === 43120, "наезжающие строки — каждая до начала следующей");
  ok(J(D.parseJson3({ events: [{ tStartMs: 10, dDurationMs: 5, segs: [{ utf8: "a" }] }, { tStartMs: 10, dDurationMs: 9, segs: [{ utf8: "b" }] }] })) === J([{ s: 10, e: 19, text: "a b" }]), "одно начало — одна реплика");
  ok(J(D.parseJson3(null)) === "[]" && J(D.parseJson3({ events: [{ tStartMs: "x", dDurationMs: 1, segs: [{ utf8: "a" }] }] })) === "[]", "пустой и битый ответ — без ошибок");
  // сведение: ручная — один к одному, автоматическая — по пересечению
  const tr1 = D.parseJson3({ events: [{ tStartMs: 47320, dDurationMs: 3800, segs: [{ utf8: "Никогда не брошу" }] }, { tStartMs: 53600, dDurationMs: 1920, segs: [{ utf8: "Никогда не попрощаюсь" }] }] });
  ok(J(D.pairCues(mc, tr1).map((c) => c.tr)) === J(["Никогда не брошу", "Никогда не попрощаюсь"]), "ручная: перевод к своей реплике");
  const o2 = [{ s: 0, e: 6000, text: "one two three four" }, { s: 6000, e: 12000, text: "five six" }, { s: 12000, e: 20000, text: "seven" }];
  const t2 = [{ s: 0, e: 2500, text: "раз" }, { s: 2500, e: 5800, text: "два три" }, { s: 5800, e: 11000, text: "пять" }, { s: 14000, e: 30000, text: "семь" }];
  ok(J(D.pairCues(o2, t2).map((c) => c.tr)) === J(["раз два три", "пять", "семь"]), "автоматическая: куски перевода собраны к реплике по пересечению");
  const t3 = [{ s: 0, e: 20000, text: "всё сразу" }];
  ok(J(D.pairCues(o2, t3).map((c) => c.tr)) === J(["всё сразу", "всё сразу", "всё сразу"]), "длинный кусок перевода — у каждой реплики, что под него попала");
  ok(J(D.pairCues(o2, []).map((c) => c.tr)) === J(["", "", ""]) && J(D.pairCues([], t2)) === "[]", "перевода нет — пустые строки, оригинала нет — пусто");
  // выбор строки по времени (перемотка, скорость — просто другое время)
  ok(D.indexAt(mc, 47320) === 0 && D.indexAt(mc, 51119) === 0 && D.indexAt(mc, 51120) === -1 && D.indexAt(mc, 54000) === 1 && D.indexAt(mc, 10) === -1 && D.indexAt(mc, 99999) === -1 && D.indexAt([], 5) === -1, "строка по времени: границы, промежутки, до и после");
  ok(J(D.words(" Never  gonna\tgive ")) === J([{ w: "Never", sp: " " }, { w: "gonna", sp: " " }, { w: "give", sp: " " }]) && J(D.words("")) === "[]", "слова строки");
  ok(D.fontPx(225) === 14 && D.fontPx(720) === 30 && D.fontPx(2160) === 40 && D.fontPx(NaN) === 14, "кегль по высоте плеера: мини-плеер, обычный, 4К");
  ok(D.LANGS[0][0] === "ru" && D.LANGS.every(([c, n]) => c && n) && new Set(D.LANGS.map(([c]) => c)).size === D.LANGS.length, "список языков: русский первым, без повторов");
}

// ---------- заметки с таймкодами (notes-core.js) ----------
{
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(new URL("../notes-core.js", import.meta.url), "utf8"), ctx);
  const N = ctx.__ytcsNotesCore;
  const J = (o) => JSON.stringify(o);
  const A = "dQw4w9WgXcQ";
  const B = "jNQXAC9IVRw";
  ok(N.fmtTime(0) === "0:00" && N.fmtTime(75.9) === "1:15" && N.fmtTime(3725) === "1:02:05" && N.fmtTime(-3) === "0:00", "время: 0:00, 1:15, 1:02:05");
  ok(N.cleanText("  два\n\tслова \u0000 ") === "два слова" && N.cleanText("x".repeat(900)).length === N.MAX_TEXT, "текст: одна строка, до 500 знаков");
  let r = N.addNote({}, A, { t: 754.6, text: "  важная мысль ", at: 1000 }, { title: "Рик", channel: "Канал", len: 213 });
  let s = r.store;
  ok(r.note && J(r.note) === J({ t: 754, text: "важная мысль", at: 1000 }) && s[A].title === "Рик" && s[A].len === 213, "заметка: целая секунда, текст без пробелов, название и канал");
  s = N.addNote(s, A, { t: 10, text: "раньше", at: 1000 }).store;
  ok(J(s[A].items.map((x) => x.t)) === J([10, 754]) && s[A].items[0].at === 1001, "по порядку в видео; одинаковое время записи — разведено");
  ok(s[A].title === "Рик", "без названия — прежнее остаётся");
  ok(N.addNote(s, A, { t: 5, text: "   " }).note === null && N.addNote(s, "плохой id", { t: 5, text: "x" }).why === "id", "пустая заметка и чужой id не сохраняются");
  const upd = N.updateNote(s, A, 1000, "новый текст");
  ok(upd.note?.text === "новый текст" && s[A].items[1].text === "важная мысль", "правка — новое хранилище, старое не тронуто");
  ok(N.updateNote(s, A, 1000, "  ").note === null && N.updateNote(s, A, 42, "x").note === null, "правка: пустой текст и чужая заметка — без изменений");
  s = upd.store;
  const rm = N.removeNote(s, A, 1001);
  ok(rm.note?.text === "раньше" && rm.store[A].items.length === 1, "удаление одной из двух");
  const back = N.restoreNote(rm.store, A, rm.note, rm.meta);
  ok(J(back.store[A].items) === J(s[A].items), "«Вернуть» — та же заметка на том же месте");
  const rm2 = N.removeNote(N.removeNote(s, A, 1001).store, A, 1000);
  ok(!(A in rm2.store) && rm2.meta.title === "Рик", "удалили последнюю — видео пропало из заметок, название помним для «Вернуть»");
  ok(N.restoreNote(rm2.store, A, rm2.note, rm2.meta).store[A]?.title === "Рик", "«Вернуть» последнюю — видео с названием вернулось");
  // чистка того, что пришло из файла или чужой версии
  const dirty = { [A]: { title: "Рик", items: [{ t: 5, text: "ok", at: 3 }, { t: -1, text: "x", at: 4 }, { t: 7, text: "", at: 5 }, "мусор"] }, bad: { items: [{ t: 1, text: "x" }] }, [B]: { items: [] } };
  const cl = N.cleanStore(dirty);
  ok(J(Object.keys(cl)) === J([A]) && cl[A].items.length === 1 && cl[A].channel === "" && cl[A].at === 3, "чистка: чужие id, пустые списки и битые заметки отброшены");
  ok(J(N.cleanStore(null)) === "{}" && J(N.cleanStore([1, 2])) === "{}", "чистка: не объект — пусто");
  // объединение (восстановление из резервной копии)
  const mine = N.addNote({}, A, { t: 1, text: "моя", at: 10 }, { title: "Рик" }).store;
  let theirs = N.addNote({}, A, { t: 1, text: "моя", at: 10 }).store;
  theirs = N.addNote(theirs, A, { t: 2, text: "из файла", at: 20 }).store;
  theirs = N.addNote(theirs, B, { t: 3, text: "другое видео", at: 30 }, { title: "Первое видео" }).store;
  const mg = N.mergeStores(mine, theirs);
  ok(mg.added === 2 && mg.store[A].items.length === 2 && mg.store[B].title === "Первое видео" && mg.store[A].title === "Рик", "из копии добавлены только новые заметки");
  ok(N.mergeStores(mg.store, theirs).added === 0, "повторное восстановление ничего не удваивает");
  // список и поиск
  const vs = N.videos(mg.store);
  ok(vs.length === 2 && vs.every((v) => v.id && v.items.length) && J(N.count(mg.store)) === J({ videos: 2, notes: 3 }), "список видео и счёт: 2 видео, 3 заметки");
  ok(N.search(mg.store, "ФАЙЛА").length === 1 && N.search(mg.store, "файла")[0].items.length === 1 && N.search(mg.store, "файла")[0].total === 2, "поиск по тексту без учёта регистра; total — все заметки видео");
  ok(N.search(mg.store, "рик").length === 1 && N.search(mg.store, "рик")[0].items.length === 2, "поиск по названию — все заметки видео");
  ok(N.search(mg.store, "моя файла").length === 0 && N.search(mg.store, "  ").length === 2, "все слова должны найтись; пустой запрос — всё");
  const yo = N.addNote({}, A, { t: 0, text: "Ёлка", at: 1 }).store;
  ok(N.search(yo, "елка").length === 1 && N.search(yo, "0:00").length === 1, "ё = е; ищется и время «0:00»");
  // текст для «Копировать все» и Telegram
  ok(N.noteLink(A, 754) === `https://youtu.be/${A}?t=754` && N.noteLink(A, 0) === `https://youtu.be/${A}` && N.watchUrl(A, 61) === `https://www.youtube.com/watch?v=${A}&t=61s`, "ссылки с секундой");
  const one = N.search(mg.store, "рик");
  const txt = N.exportText(one);
  ok(txt === `Рик\nhttps://youtu.be/${A}\n0:01 — моя — https://youtu.be/${A}?t=1\n0:02 — из файла — https://youtu.be/${A}?t=2`, "текст: название, ссылка, заметки «0:01 — текст — ссылка»");
  ok(N.exportText(vs).split("\n\n").length === 2, "видео — через пустую строку");
  ok(N.tgText(one).cut === 0 && N.tgText(one).text === txt, "короткое — в Telegram целиком");
  let big = {};
  for (let i = 0; i < 60; i++) big = N.addNote(big, i < 30 ? A : B, { t: i * 10, text: "длинная заметка ".repeat(8) + i, at: 100 + i }, { title: i < 30 ? "Рик" : "Первое видео" }).store;
  const tg = N.tgText(N.videos(big));
  ok(tg.text.length <= N.TG_MAX && tg.cut > 0 && tg.cut < 60 && tg.text.includes(`и ещё ${N.notesWord(tg.cut)}`), "длинное — обрезано по целой заметке, сказано, сколько не вошло");
  const kept = (tg.text.match(/ — https:\/\/youtu\.be\/[\w-]{11}(\?t=\d+)?$/gm) || []).length;
  ok(kept + tg.cut === 60, "вошедшие + не вошедшие = все заметки");
  ok(N.notesWord(1) === "1 заметка" && N.notesWord(3) === "3 заметки" && N.notesWord(11) === "11 заметок" && N.notesWord(21) === "21 заметка", "склонение «заметка»");
  const nm = N.addNote({}, A, { t: 1, text: "x", at: 5 }).store;
  ok(N.setMeta(nm, A, { title: "Из библиотеки", channel: "К", len: 99 }).store[A].title === "Из библиотеки" && N.setMeta(nm, A, {}).store === nm && N.setMeta(nm, B, { title: "y" }).store === nm, "название из библиотеки — подставляется; без изменений — то же хранилище");
  // предел на видео
  let full = {};
  for (let i = 0; i < N.MAX_NOTES; i++) full = N.addNote(full, A, { t: i, text: "x", at: i + 1 }).store;
  ok(N.addNote(full, A, { t: 1, text: "лишняя" }).why === "full", "больше 300 заметок у видео — нельзя");
}

console.log(`автопроверки: ${passed} прошло${failed ? `, ${failed} не прошло` : ""}`);
process.exit(failed ? 1 : 0);
