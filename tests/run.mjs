// Автопроверки без браузера: node tests/run.mjs
//   - поиск «Моей библиотеки» (опечатки, основы слов, раскладка, исключения, подсветка);
//   - разбор ответов YouTube в playlists-main.js на маленьких образцах — по одному на
//     каждый формат, который YouTube уже успел поменять (старый и новый вид видео,
//     Shorts плиткой, токены продолжения в разных местах).
// Запускается из check-syntax.sh перед коммитом.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildIndex, search, highlight, stem, swapLayout } from "../library/search.js";
import { parseTldr, pickEven, runTldr, splitParts } from "../tldr-core.js";
import { createPacer, isOutputLimitError, isSizeLimitError, retryAfterMs } from "../groq.js";

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

console.log(`автопроверки: ${passed} прошло${failed ? `, ${failed} не прошло` : ""}`);
process.exit(failed ? 1 : 0);
