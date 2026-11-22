// Самопроверка: «Проверить, всё ли работает».
//
// YouTube то и дело меняет внутренние форматы ответов, и функции ломаются
// тихо: токен продолжения переезжает в другое поле, видео приходят новым
// видом плитки и т. п. Проверка за 10–20 секунд прогоняет основные запросы
// и говорит по каждому пункту: работает / что сломалось / что делать.
// Только чтение — в аккаунте ничего не меняется.
//
// Запускает фоновый скрипт (background.js): по кнопке в настройках панели и
// раз в сутки сам (если включено). Ход и итог пишутся в storage.local
// (SELFCHECK_KEY) — панель просто перерисовывает их.

import { GroqProxy } from "./groq.js";

export const SELFCHECK_KEY = "selfcheck"; // последний отчёт
export const SELFCHECK_AUTO_KEY = "selfcheckAuto"; // автопроверка раз в сутки (по умолчанию — да)
export const SELFCHECK_ALARM = "selfcheck";
export const AUTO_EVERY = 23 * 3600 * 1000; // «раз в сутки» с запасом на неточность будильника

// Популярное видео с комментариями — на нём проверяем сбор
const PROBE_VIDEO = "dQw4w9WgXcQ";
const EV = "ytcs-pl:2"; // канал к playlists-main.js (как в library/library.js)

// Пункты проверки — в этом порядке в списке
export const CHECKS = [
  { id: "bot", title: "Сервер сводок (ИИ)" },
  { id: "comments", title: "Сбор комментариев" },
  { id: "playlists", title: "Плейлисты и «Смотреть позже»" },
  { id: "thumbs", title: "Обложки видео" },
  { id: "embed", title: "Плеер в «Моей библиотеке»" },
];

// status: run — идёт; ok — работает; warn — работает не всё или нужно ваше
// действие; fail — сломалось; skip — не проверялось
const item = (id, status, text = "", hint = "") => ({ id, status, text, hint });

const withTimeout = (p, ms, code = "timeout") =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(code), { code })), ms))]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => String(e?.message || e || "ошибка");
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  return `${n} ${a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many}`;
};

/** Есть ли в отчёте поломки (для значка «!»). */
export const failuresOf = (report) => (report?.items || []).filter((x) => x.status === "fail");

// ---------------- вкладка YouTube ----------------
// Запросы к YouTube идут из настоящей вкладки — с вашими куками и настройками
// клиента, ровно как у самого сайта. Своей нет — по кнопке откроем фоновую
// (раздел «Плейлисты», ничего не играет, без звука) и закроем после проверки.

function waitLoaded(tabId, ms = 25000) {
  return new Promise((resolve) => {
    const done = (ok) => {
      chrome.tabs.onUpdated.removeListener(onUpd);
      clearTimeout(timer);
      resolve(ok);
    };
    const onUpd = (id, info) => id === tabId && info.status === "complete" && done(true);
    const timer = setTimeout(() => done(false), ms);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((t) => t.status === "complete" && done(true), () => done(false));
  });
}

async function liveTabs() {
  const tabs = await chrome.tabs.query({ url: ["https://www.youtube.com/*"] });
  return tabs
    .filter((t) => !t.discarded && t.status === "complete" && !/\/embed\//.test(t.url || ""))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
}

function tabKeeper(allowTemp) {
  let temp = null;
  let pending = null;
  return {
    // свежая вкладка: content.js этой версии расширения отвечает в ней
    async temp() {
      if (!allowTemp) return null;
      pending ||= (async () => {
        const t = await chrome.tabs.create({ url: "https://www.youtube.com/feed/playlists", active: false });
        temp = t.id;
        chrome.tabs.update(t.id, { muted: true }).catch(() => {});
        await waitLoaded(t.id);
        await sleep(800); // контент-скрипты (document_idle) — чуть позже «complete»
        return t.id;
      })();
      return pending;
    },
    async close() {
      if (temp != null) await chrome.tabs.remove(temp).catch(() => {});
      temp = null;
    },
    get opened() {
      return temp != null;
    },
  };
}

// ---------------- 1. сервер сводок ----------------

function serverAllowed(url) {
  try {
    const u = new URL(url);
    return /(^|\.)onrender\.com$/i.test(u.hostname) || (u.hostname === "localhost" && u.port === "8080");
  } catch (e) {
    return false;
  }
}

async function checkBot(server, update) {
  const base = String(server?.baseUrl || "").replace(/\/+$/, "");
  if (!base) return item("bot", "fail", "Не указан адрес сервера.", "Впишите URL сервера в блоке «Сервер с ИИ» и нажмите «Сохранить».");
  if (!serverAllowed(base))
    return item("bot", "fail", "Этот адрес расширению не разрешён.", "Нужен адрес *.onrender.com или localhost:8080 — поправьте его в блоке «Сервер с ИИ».");
  if (!server.token) return item("bot", "warn", "Не задан секрет — сводки не заработают.", "Впишите секрет (EXT_SECRET) в блоке «Сервер с ИИ» и нажмите «Сохранить».");

  // Render усыпляет бесплатный сервер: первый запрос будит его до минуты
  const slow = setTimeout(() => update(item("bot", "run", "Будим сервер — бесплатный Render засыпает, это до минуты…")), 3000);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    let r;
    try {
      r = await fetch(`${base}/healthz`, { cache: "no-store", signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
    if (!r.ok) return item("bot", "fail", `Сервер ответил ошибкой ${r.status}.`, "Загляните в панель Render: сервис мог упасть или ещё разворачивается. Повторите проверку через пару минут.");
  } catch (e) {
    return item("bot", "fail", "Сервер не отвечает.", "Проверьте интернет и что сервис на Render запущен. Если он только что просыпался — повторите проверку.");
  } finally {
    clearTimeout(slow);
  }
  update(item("bot", "run", "Сервер проснулся, спрашиваем модель…"));
  const proxy = new GroqProxy({ baseUrl: base, token: server.token, model: server.model });
  try {
    const ok = await proxy.test();
    return ok
      ? item("bot", "ok", `Сервер и модель отвечают (${server.model || "модель по умолчанию"}).`)
      : item("bot", "fail", "Модель вернула пустой ответ.", "Обычно это временный сбой Groq — повторите через минуту.");
  } catch (e) {
    const m = errText(e);
    if (/403/.test(m)) return item("bot", "fail", "Сервер не принял секрет (403).", "Сверьте секрет в «Сервер с ИИ» с EXT_SECRET в настройках бота.");
    if (/429|rate.?limit|tokens per/i.test(m)) return item("bot", "warn", "Сервер работает, но лимит Groq сейчас исчерпан.", "Подождите минуту-другую — лимит бесплатный и восстанавливается сам.");
    return item("bot", "fail", m.slice(0, 160), "Повторите проверку; если повторяется — загляните в журнал сервиса на Render.");
  }
}

// ---------------- 2. сбор комментариев ----------------
// Разбор делает сам content.js (те же функции, что и при обычном сборе) —
// проверяем настоящий код, а не его копию.

async function askComments(tabId) {
  const r = await withTimeout(chrome.tabs.sendMessage(tabId, { type: "yt:selfcheck", videoId: PROBE_VIDEO }, { frameId: 0 }), 25000);
  if (!r || typeof r !== "object") throw Object.assign(new Error("noreply"), { code: "noreply" });
  return r;
}

async function checkComments(tabs) {
  let r = null;
  // своя вкладка может хранить content.js старой версии (открыта до обновления
  // расширения) — он не знает этой команды; тогда пробуем следующую / свежую
  for (const t of (await liveTabs()).slice(0, 3)) {
    r = await askComments(t.id).catch(() => null);
    if (r) break;
  }
  if (!r) {
    const id = await tabs.temp();
    if (id == null) return item("comments", "skip", "Нет открытой вкладки YouTube с новой версией расширения.", "Проверится по кнопке или когда откроете YouTube.");
    r = await askComments(id).catch((e) => ({ ok: false, error: e.code === "timeout" ? "timeout" : "noreply" }));
  }
  if (!r.ok) {
    const e = String(r.error || "");
    if (/innerTubeBlocked/.test(e)) return item("comments", "warn", "YouTube временно ограничил запросы.", "Подождите полчаса и повторите. Сбор со страницы (режим «Авто») продолжит работать.");
    if (/innerTubeNetwork|Failed to fetch/i.test(e)) return item("comments", "warn", "Нет связи с YouTube.", "Проверьте интернет и повторите проверку.");
    if (e === "timeout") return item("comments", "fail", "YouTube не ответил за 25 секунд.", "Обновите вкладку YouTube (F5) и повторите.");
    if (e === "noreply") return item("comments", "fail", "Вкладка YouTube не ответила.", "Обновите вкладку YouTube (F5) — или перезагрузите расширение на chrome://extensions.");
    return item("comments", "fail", `Запрос к YouTube не прошёл: ${e.slice(0, 100)}.`, "Сбор через API не работает; режим «Авто» перейдёт на чтение со страницы. Нужна правка content.js.");
  }
  if (!r.section)
    return item("comments", "fail", "YouTube не отдал раздел комментариев — изменился формат ответа.", "Сбор через API не работает; режим «Авто» читает комментарии со страницы (медленнее). Нужна правка commentSectionToken в content.js.");
  if (!r.threads)
    return item("comments", "fail", "Комментарии пришли в незнакомом формате.", "Сбор через API вернёт пусто; режим «Авто» перейдёт на чтение со страницы. Нужна правка findThreadNodes в content.js.");
  if (r.parsed < Math.ceil(r.threads * 0.8))
    return item("comments", "fail", `Разобрались не все комментарии: ${r.parsed} из ${r.threads}.`, "Поменялись поля комментария (текст или ключ сущности). Нужна правка parseThreadV2 в content.js.");
  const lost = [];
  if (r.withAuthor < r.parsed * 0.8) lost.push("авторы");
  if (r.withTime < r.parsed * 0.8) lost.push("даты");
  if (r.withLikes === 0 && r.parsed >= 10) lost.push("лайки");
  const base = `${plural(r.parsed, "комментарий", "комментария", "комментариев")} на первой странице`;
  if (lost.length) return item("comments", "warn", `${base}, но пустые поля: ${lost.join(", ")}.`, "Сводки работают, но сортировка и подписи будут неточными. Нужна правка parseThreadV2 в content.js.");
  if (!r.next) return item("comments", "warn", `${base}, но нет ссылки на следующую страницу.`, "Соберётся только первая порция (~20). Нужна правка findNextToken в content.js.");
  if (!r.cfgFromPage) return item("comments", "warn", `${base}, но настройки клиента не нашлись на странице.`, "Пока работают запасные значения, но после обновления YouTube могут перестать. Нужна правка innerTubeConfig в content.js.");
  return item("comments", "ok", `${base}: текст, авторы, даты и лайки на месте.`);
}

// ---------------- 3. плейлисты ----------------
// Тот же путь, что у «Моей библиотеки»: playlists-main.js в мире страницы,
// событие ytcs-pl:2. Только чтение: список плейлистов и первая страница.

// Выполняется В СТРАНИЦЕ YouTube (world: MAIN) — копия bridgeCall из library.js
function bridgeCall(ev, op, args) {
  return new Promise((resolve) => {
    const id = `sc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      resolve({ ok: false, error: "noreply" });
    }, 20000);
    function onMsg(e) {
      if (e.source !== window || e.data?.__ytcsPl !== id) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      resolve(e.data);
    }
    window.addEventListener("message", onMsg);
    document.dispatchEvent(new CustomEvent(ev, { detail: JSON.stringify({ ...args, op, id }) }));
  });
}

async function plCall(tabId, op, args = {}) {
  for (let attempt = 0; ; attempt++) {
    await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["playlists-main.js"] });
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: bridgeCall, args: [EV, op, args] });
    const r = res?.result;
    if (r?.ok) return r.data;
    if ((r?.error === "noconfig" || r?.error === "noreply") && attempt < 1) {
      await sleep(1500);
      continue;
    }
    throw Object.assign(new Error(r?.message || r?.error || "fail"), { code: r?.error || "fail" });
  }
}

// Видео разобралось целиком: id, название (у Shorts канала нет — это нормально)
const goodVideo = (v) => /^[\w-]{11}$/.test(v?.id || "") && Boolean(String(v.title || "").trim());

async function checkPlaylists(tabs, found) {
  let tabId = (await liveTabs())[0]?.id ?? null;
  if (tabId == null) tabId = await tabs.temp();
  if (tabId == null) return item("playlists", "skip", "Нет открытой вкладки YouTube.", "Проверится по кнопке или когда откроете YouTube.");
  try {
    const pls = await plCall(tabId, "playlists");
    if (!Array.isArray(pls) || !pls.length)
      return item("playlists", "fail", "YouTube вернул пустой список плейлистов.", "Изменился ответ get_add_to_playlist — нужна правка list() в playlists-main.js.");
    const notes = [];
    const parts = [plural(pls.length, "плейлист", "плейлиста", "плейлистов")];

    const wl = await plCall(tabId, "page", { playlistId: "WL" });
    const wlGood = (wl.items || []).filter(goodVideo);
    found.push(...wlGood.slice(0, 2).map((v) => v.id));
    if (wl.items?.length && wlGood.length < wl.items.length * 0.8)
      return item("playlists", "fail", `«Смотреть позже»: разобрались ${wlGood.length} видео из ${wl.items.length}.`, "Поменялся формат видео в плейлисте — нужна правка page() в playlists-main.js.");
    if (!wl.items?.length) notes.push("«Смотреть позже» пуст — разбор видео не проверить");
    else parts.push(`«Смотреть позже»: ${wl.items.length}${wl.next ? "+" : ""} видео`);
    // страница — до 100 видео; если их ровно столько, а продолжения нет — потерялся токен
    if (wl.items?.length >= 100 && !wl.next)
      return item("playlists", "fail", "«Смотреть позже»: нет ссылки на следующие 100 видео.", "В библиотеку попадут только первые 100. Изменилось место токена продолжения — нужна правка contToken() в playlists-main.js.");
    if (wl.next) {
      const more = await plCall(tabId, "page", { playlistId: "WL", token: wl.next, from: wl.items.length });
      if (!more.items?.length) return item("playlists", "fail", "«Смотреть позже»: следующая страница пришла пустой.", "Нужна правка page() / contToken() в playlists-main.js.");
    }

    // «Понравившиеся» приходят другим видом плитки (lockupViewModel) — проверяем отдельно
    const ll = await plCall(tabId, "page", { playlistId: "LL" }).catch(() => null);
    if (ll?.items?.length) {
      const llGood = ll.items.filter(goodVideo);
      if (llGood.length < ll.items.length * 0.8)
        return item("playlists", "fail", `«Понравившиеся»: разобрались ${llGood.length} видео из ${ll.items.length}.`, "Поменялся формат плитки видео — нужна правка fromLockup() в playlists-main.js.");
      parts.push(`«Понравившиеся»: ${ll.items.length}${ll.next ? "+" : ""}`);
      found.push(...llGood.slice(0, 1).map((v) => v.id));
    }
    const text = parts.join(" · ") + ".";
    return notes.length ? item("playlists", "warn", `${text} ${notes.join("; ")}.`, "Добавьте любое видео в «Смотреть позже» и повторите проверку.") : item("playlists", "ok", text);
  } catch (e) {
    const code = e.code || "";
    if (code === "loggedout") return item("playlists", "warn", "Вы не вошли в аккаунт YouTube.", "Войдите в YouTube в этом браузере — плейлисты и библиотека работают от вашего имени.");
    if (code === "denied") return item("playlists", "fail", "YouTube не принял запрос (нет доступа).", "Обновите вкладку YouTube (F5) и повторите. Если не помогло — изменилась подпись запроса в playlists-main.js.");
    if (code === "noconfig") return item("playlists", "fail", "На странице YouTube не нашлись настройки клиента (ytcfg).", "Обновите вкладку YouTube (F5) и повторите.");
    if (code === "noreply") return item("playlists", "fail", "Вкладка YouTube не ответила.", "Обновите вкладку YouTube (F5) и повторите.");
    if (/Cannot access|No tab|Frame/i.test(errText(e))) return item("playlists", "fail", "Не получилось подключиться к вкладке YouTube.", "Обновите вкладку YouTube (F5) и повторите.");
    return item("playlists", "fail", `Запрос не прошёл: ${errText(e).slice(0, 100)}.`, "Повторите проверку; если повторяется — нужна правка playlists-main.js.");
  }
}

// ---------------- 4. обложки ----------------

async function checkThumbs(ids) {
  const list = [...new Set([...ids, PROBE_VIDEO])].slice(0, 3);
  let ok = 0;
  let last = "";
  for (const id of list) {
    try {
      const r = await withTimeout(fetch(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`, { cache: "no-store" }), 10000);
      const type = r.headers.get("content-type") || "";
      const size = (await r.arrayBuffer()).byteLength;
      if (r.ok && /^image\//.test(type) && size > 1000) ok++;
      else last = `ответ ${r.status}, ${type || "без типа"}`;
    } catch (e) {
      last = e.code === "timeout" ? "не ответил за 10 с" : "нет связи";
    }
  }
  if (ok === list.length) return item("thumbs", "ok", `Обложки с i.ytimg.com открываются (${ok} из ${list.length}).`);
  if (ok) return item("thumbs", "warn", `Открылись ${ok} из ${list.length} обложек (${last}).`, "Скорее всего, у отдельных видео нет обложки этого размера — не страшно.");
  return item("thumbs", "fail", `Обложки не открываются: ${last}.`, "Проверьте интернет и блокировщики рекламы (они не должны резать i.ytimg.com).");
}

// ---------------- 5. встроенный плеер ----------------

function embedRuleOk(rules) {
  const r = rules.find((x) => x.id === 1);
  const h = r?.action?.requestHeaders?.find((x) => String(x.header).toLowerCase() === "referer");
  return Boolean(r && r.action?.type === "modifyHeaders" && h?.operation === "set" && h.value && /youtube\.com\/embed/.test(r.condition?.urlFilter || ""));
}

async function checkEmbed(repair) {
  try {
    if (embedRuleOk(await chrome.declarativeNetRequest.getDynamicRules())) return item("embed", "ok", "Правило для встроенного плеера на месте.");
    if (repair) {
      await repair();
      if (embedRuleOk(await chrome.declarativeNetRequest.getDynamicRules()))
        return item("embed", "warn", "Правило для плеера пропало — восстановили.", "Если в «Моей библиотеке» был «Ошибка 153» — обновите её вкладку.");
    }
    return item("embed", "fail", "Нет правила для встроенного плеера — в библиотеке будет «Ошибка 153».", "Перезагрузите расширение на chrome://extensions.");
  } catch (e) {
    return item("embed", "fail", `Не удалось прочитать правила: ${errText(e).slice(0, 80)}.`, "Перезагрузите расширение на chrome://extensions.");
  }
}

// ---------------- запуск ----------------

/**
 * Прогоняет все проверки параллельно. auto — тихая фоновая: сервер не будим,
 * новых вкладок не открываем. server — { baseUrl, token, model } (по кнопке
 * их передаёт панель: секрет может жить только в local-config.js).
 * onUpdate(report) — после каждого изменения пункта.
 */
export async function runSelfCheck({ auto = false, server = null, repairEmbed = null, onUpdate = () => {} } = {}) {
  const startedAt = Date.now();
  const report = {
    at: startedAt,
    auto,
    running: true,
    version: chrome.runtime.getManifest().version,
    items: CHECKS.map((c) => item(c.id, "run", "Проверяем…")),
  };
  const set = (it) => {
    report.items = report.items.map((x) => (x.id === it.id ? it : x));
    onUpdate(report);
  };
  onUpdate(report);
  const tabs = tabKeeper(!auto);
  const found = []; // id видео из плейлистов — для проверки обложек
  const guard = (id, p) =>
    p.then(set, (e) => set(item(id, "fail", `Проверка упала: ${errText(e).slice(0, 100)}.`, "Повторите проверку.")));
  try {
    await Promise.all([
      auto ? set(item("bot", "skip", "В автопроверке не будим сервер — проверяется по кнопке.")) : guard("bot", checkBot(server, set)),
      guard("comments", withTimeout(checkComments(tabs), 45000)),
      guard("playlists", withTimeout(checkPlaylists(tabs, found), 45000)).then(() => guard("thumbs", checkThumbs(found))),
      guard("embed", checkEmbed(repairEmbed)),
    ]);
  } finally {
    await tabs.close();
  }
  report.running = false;
  report.ms = Date.now() - startedAt;
  onUpdate(report);
  return report;
}
