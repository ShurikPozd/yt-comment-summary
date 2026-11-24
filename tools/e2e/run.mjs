// Сквозной тест расширения в настоящем Chrome на снимках страниц YouTube.
//   node tools/e2e/run.mjs        (или bash tools/e2e/run.sh)
// Безоконный Chrome с временным профилем ставит расширение из этой папки
// (Extensions.loadUnpacked), все запросы к www.youtube.com, i.ytimg.com, боту сводок
// и Groq отвечаются из site.mjs (снимки в fixtures/) — живой YouTube не трогаем,
// капч не бывает, личных данных нет. Контент-скрипты из manifest.json срабатывают
// как на настоящем сайте: адрес страницы тот же — https://www.youtube.com/…
// Проверяется: кнопка в плеере и её меню; сбор комментариев через youtubei;
// кнопки на обложках (video-actions.js, select.js) на /watch и на главной;
// добавление в очередь; «с того же места после обновления» (resume.js);
// сводка в боковой панели доходит до запроса к ИИ (ответ — заглушка).
// Переменные окружения:
//   CHROME     — путь к Chrome (по умолчанию стандартный путь в Windows/Linux/macOS);
//   E2E_OUT    — папка для снимков экрана при сбое (для артефактов CI);
//   E2E_HEADFUL=1 — с окном (посмотреть глазами);
//   E2E_EXT    — папка расширения (по умолчанию корень репозитория).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./cdp.mjs";
import { VIDEO, route } from "./site.mjs";

const ROOT = resolve(process.env.E2E_EXT || join(dirname(fileURLToPath(import.meta.url)), "../..")).replace(/\\/g, "/");
const OUT = process.env.E2E_OUT || "";
const T0 = Date.now();
const since = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(5) + " с";

const log = { ai: [], innertube: [], foreign: new Set() };
let passed = 0;
let failed = 0;

const b = await launch();
console.log(`== сквозной тест: ${b.version.product}, расширение из ${ROOT}`);
let finished = false;
const bail = async (code) => {
  if (finished) return;
  finished = true;
  await b.close();
  process.exit(code);
};
process.on("SIGINT", () => void bail(130));
// общий предохранитель: что бы ни зависло — через 4 минуты выходим
setTimeout(() => {
  console.log("FAIL тест завис — прерываю");
  void bail(1);
}, 240000).unref();

// ---------- сети нет: каждая цель (вкладка, фон расширения) идёт через перехват ----------
const sessions = new Map(); // sessionId → targetInfo
const errors = []; // исключения в коде расширения на страницах
b.on(async (m) => {
  if (m.method === "Target.attachedToTarget") {
    const { sessionId, targetInfo, waitingForDebugger } = m.params;
    sessions.set(sessionId, targetInfo);
    try {
      if (["page", "service_worker", "worker", "iframe", "shared_worker"].includes(targetInfo.type)) {
        await b.send("Fetch.enable", { patterns: [{ urlPattern: "http*" }] }, sessionId);
        if (targetInfo.type === "page" || targetInfo.type === "iframe") {
          await b.send("Runtime.enable", {}, sessionId);
          await b.send("Page.enable", {}, sessionId);
        }
      }
    } catch {}
    if (waitingForDebugger) b.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
  } else if (m.method === "Target.detachedFromTarget") {
    sessions.delete(m.params.sessionId);
  } else if (m.method === "Fetch.requestPaused") {
    const { requestId, request } = m.params;
    const sid = m.sessionId;
    let res = null;
    try {
      res = route({ url: request.url, method: request.method, headers: request.headers, postData: request.postData }, log);
    } catch (e) {
      console.log("  ! ошибка в site.mjs: " + e.stack);
    }
    if (!res) {
      log.foreign.add(request.url.slice(0, 120));
      b.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sid).catch(() => {});
      return;
    }
    b.send(
      "Fetch.fulfillRequest",
      {
        requestId,
        responseCode: res.status,
        responseHeaders: Object.entries({ "cache-control": "no-store", ...res.headers }).map(([name, value]) => ({ name, value: String(value) })),
        body: res.body.toString("base64"),
      },
      sid
    ).catch(() => {});
  } else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    const where = d.url || d.stackTrace?.callFrames?.[0]?.url || "";
    if (where.startsWith("chrome-extension://")) errors.push(`${where.split("/").slice(3).join("/")}:${d.lineNumber + 1} ${d.exception?.description?.split("\n")[0] || d.text}`);
  }
});
await b.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

// ---------- помощники ----------
async function evalIn(sid, expr) {
  const r = await b.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
async function until(sid, expr, ms = 10000) {
  let last;
  for (const t = Date.now(); Date.now() - t < ms; ) {
    try {
      last = await evalIn(sid, expr);
      if (last) return last;
    } catch {}
    await sleep(150);
  }
  return last;
}
const sessionOf = (pred) => [...sessions].find(([, t]) => pred(t))?.[0];
async function waitSession(pred, ms = 10000) {
  for (const t = Date.now(); Date.now() - t < ms; ) {
    const s = sessionOf(pred);
    if (s) return s;
    await sleep(100);
  }
  return null;
}
// центр элемента (expr — выражение JS, дающее элемент, можно в тени)
async function centerOf(sid, expr) {
  return evalIn(sid, `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView?.({ block: "center" }); const r = el.getBoundingClientRect();
    return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
}
async function mouse(sid, type, { x, y }) {
  await b.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "mouse" }, sid);
}
async function hover(sid, expr) {
  const c = await centerOf(sid, expr);
  if (!c) throw new Error("нет элемента или он без размеров: " + expr);
  await mouse(sid, "mouseMoved", { x: c.x - 3, y: c.y - 3 });
  await mouse(sid, "mouseMoved", c);
  return c;
}
async function click(sid, expr) {
  const c = await hover(sid, expr);
  await mouse(sid, "mousePressed", c);
  await mouse(sid, "mouseReleased", c);
}
async function shot(sid, name) {
  if (!OUT || !sid) return;
  try {
    mkdirSync(OUT, { recursive: true });
    const { data } = await b.send("Page.captureScreenshot", { format: "png" }, sid);
    writeFileSync(join(OUT, name + ".png"), Buffer.from(data, "base64"));
  } catch {}
}
let shotSid = null; // какую вкладку снимать при сбое
async function step(name, fn) {
  const t = Date.now();
  try {
    const note = await fn();
    passed++;
    console.log(`OK   ${name}${note ? " — " + note : ""} (${((Date.now() - t) / 1000).toFixed(1)} с)`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
    await shot(shotSid, "fail-" + name.replace(/[^\wа-яё-]+/gi, "_").slice(0, 60));
  }
}
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
async function openTab(url, { newWindow = false } = {}) {
  const before = new Set(sessions.keys());
  const { targetId } = await b.send("Target.createTarget", { url: "about:blank", newWindow });
  const sid = await waitSession((t) => t.targetId === targetId);
  must(sid && !before.has(sid), "вкладка не открылась");
  await b.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await b.send("Page.navigate", { url }, sid);
  return { sid, targetId };
}

// ---------- расширение ----------
let EXT = "";
let sw = null;
const swEval = (expr) => evalIn(sw, expr);
await step("расширение загружено", async () => {
  const { id } = await b.send("Extensions.loadUnpacked", { path: ROOT });
  EXT = id;
  sw = await waitSession((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${id}/`), 15000);
  must(sw, "фон расширения (service worker) не запустился");
  await until(sw, "typeof chrome !== 'undefined' && Boolean(chrome.storage)", 5000);
  // бот сводок «настроен» — секрет вымышленный, запросы к нему отвечает заглушка
  await swEval(`chrome.storage.local.get("settings").then(({ settings }) => chrome.storage.local.set({ settings: { ...(settings || {}),
    baseUrl: "https://e2e-bot.onrender.com", token: "e2e-token", model: "e2e-model" } }))`);
  const v = await swEval("chrome.runtime.getManifest().version");
  return `id ${id}, версия ${v}`;
});
if (!sw) await bail(1);

// ---------- страница видео ----------
const watchUrl = `https://www.youtube.com/watch?v=${VIDEO.id}`;
const watch = await openTab(watchUrl);
const W = watch.sid;
shotSid = W;

await step("кнопка расширения в плеере", async () => {
  const ok = await until(W, "document.querySelector('#movie_player .ytp-right-controls .ytcs-btn')", 15000);
  must(ok, "кнопки .ytcs-btn в #movie_player нет — контент-скрипт не встал или не нашёл .ytp-settings-button");
  const ver = await evalIn(W, "document.querySelector('.ytcs-btn').dataset.ytcsVersion");
  return `версия на странице ${ver}`;
});

await step("меню кнопки открывается", async () => {
  await click(W, "document.querySelector('#movie_player .ytcs-btn')");
  const n = await until(
    W,
    `(() => { const m = document.querySelector('#movie_player .ytcs-menu.open'); if (!m) return 0;
      return [...m.querySelectorAll('.ytcs-item')].filter((i) => !i.hidden && i.getBoundingClientRect().height > 0).length; })()`,
    5000
  );
  must(n >= 3, `меню не открылось или пусто (видимых пунктов: ${n || 0})`);
  await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, W);
  await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, W);
  const closed = await until(W, "!document.querySelector('#movie_player .ytcs-menu.open')", 3000);
  must(closed, "меню не закрылось по Esc");
  return `пунктов: ${n}`;
});

await step("комментарии собираются через youtubei", async () => {
  const st = await until(
    sw,
    `chrome.storage.session.get(["collect:${VIDEO.id}", "comments:${VIDEO.id}"]).then((o) => { const s = o["collect:${VIDEO.id}"];
      return s && s.status !== "loading" ? { status: s.status, fetched: s.fetched, error: s.error, first: o["comments:${VIDEO.id}"]?.[0] } : null; })`,
    15000
  );
  must(st, `сбор не закончился (запросы youtubei: ${log.innertube.join(", ") || "нет"})`);
  must(st.status === "done" && st.fetched === 6, `сбор: ${JSON.stringify(st)}`);
  must(st.first?.author === "@zritel1" && st.first?.hearted === true && st.first?.likes === 42, "первый комментарий разобран не так: " + JSON.stringify(st.first));
  return `${st.fetched} комм., запросы: ${log.innertube.join(" → ")}`;
});

const lockupThumb = (i) => `document.querySelectorAll('#secondary yt-lockup-view-model yt-thumbnail-view-model')[${i}]`;
const vaButtons = `(() => { const r = document.getElementById('ytcs-tldr')?.shadowRoot; if (!r) return 0;
  return [...r.querySelectorAll('[data-va]')].filter((x) => x.getBoundingClientRect().width > 0).map((x) => x.dataset.va).join(','); })()`;
const selHov = "document.getElementById('ytcs-select')?.shadowRoot?.querySelector('.hov.show')";

await step("кнопки на обложках рекомендаций (/watch)", async () => {
  await hover(W, lockupThumb(0));
  const va = await until(W, vaButtons, 5000);
  must(va, "при наведении на обложку нет кнопок video-actions.js (#ytcs-tldr)");
  const sel = await until(W, `Boolean(${selHov})`, 3000);
  must(sel, "при наведении на обложку нет кружка выбора select.js (#ytcs-select .hov)");
  return `кнопки: ${va}`;
});

await step("добавление в очередь (выбор → «В очередь»)", async () => {
  await swEval(`chrome.storage.local.set({ queue: [] })`);
  await hover(W, lockupThumb(0));
  await until(W, `Boolean(${selHov})`, 3000);
  await click(W, selHov);
  const bar = await until(W, "(() => { const b = document.getElementById('ytcs-select')?.shadowRoot?.querySelector('.bar'); return b && !b.hidden; })()", 3000);
  must(bar, "после выбора карточки не появилась полоса «Выбрано»");
  await click(W, "document.getElementById('ytcs-select').shadowRoot.querySelector('.bar [data-act=queue]')");
  const q = await until(sw, `chrome.storage.local.get("queue").then(({ queue }) => (queue || []).length ? queue : null)`, 5000);
  must(q?.length === 1, "очередь пуста после «В очередь»");
  must(q[0].id === "vid00000002", `в очереди не то видео: ${JSON.stringify(q[0])}`);
  return `в очереди: ${q[0].id}, «${q[0].title || "без названия"}»`;
});

await step("с того же места после обновления (resume.js)", async () => {
  const ready = await until(W, "(() => { const v = document.querySelector('#movie_player video'); return v && v.readyState >= 1 && v.duration > 0 && v.duration; })()", 10000);
  must(ready, "медиа плеера стенда не загрузилось");
  const T = 123;
  await evalIn(W, `(() => { const v = document.querySelector('#movie_player video'); v.pause(); v.currentTime = ${T}; })()`);
  const saved = await until(W, `(() => { try { const r = JSON.parse(sessionStorage.getItem('ytcs:resume')); return r && Math.abs(r.t - ${T}) < 1 && r; } catch { return null; } })()`, 5000);
  must(saved, "место не записалось в sessionStorage (ytcs:resume)");
  await b.send("Page.reload", {}, W);
  await sleep(500);
  const back = await until(
    W,
    `(() => { const v = document.querySelector('#movie_player video'); return v && v.readyState >= 1 && Math.abs(v.currentTime - ${T}) < 1.5 && v.currentTime; })()`,
    10000
  );
  must(back, `после обновления видео не на ${T} с: ${await evalIn(W, "document.querySelector('#movie_player video')?.currentTime")}`);
  // YouTube (заглушка) откатывает на своё место из истории — resume.js должен вернуть
  await sleep(1500);
  const t = await evalIn(W, "document.querySelector('#movie_player video').currentTime");
  must(Math.abs(t - T) < 1.5, `видео откатилось на ${t.toFixed(1)} с`);
  return `было ${T} с, после F5 — ${t.toFixed(1)} с`;
});

// ---------- главная ----------
const home = await openTab("https://www.youtube.com/");
const H = home.sid;
shotSid = H;
await step("кнопки на обложках главной", async () => {
  const n = await until(H, "document.querySelectorAll('ytd-rich-grid-renderer ytd-rich-item-renderer yt-lockup-view-model').length", 8000);
  must(n >= 3, `в снимке главной нет карточек (${n})`);
  await sleep(600);
  await hover(H, "document.querySelector('ytd-rich-item-renderer yt-lockup-view-model yt-thumbnail-view-model')");
  const va = await until(H, vaButtons, 5000);
  must(va, "при наведении на обложку главной нет кнопок video-actions.js");
  const sel = await until(H, `Boolean(${selHov})`, 3000);
  must(sel, "на главной нет кружка выбора select.js");
  // Shorts на полке — тоже карточки
  const shorts = await evalIn(H, "document.querySelectorAll('ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2').length");
  return `карточек ${n}, Shorts ${shorts}, кнопки: ${va}`;
});

// ---------- сводка в боковой панели ----------
await step("сводка комментариев доходит до запроса к ИИ", async () => {
  // видео — активная вкладка своего окна, панель — отдельным окном (как на телефоне/в окне)
  await b.send("Target.activateTarget", { targetId: watch.targetId });
  const panel = await openTab(`chrome-extension://${EXT}/sidepanel/sidepanel.html`, { newWindow: true });
  shotSid = panel.sid;
  const P = panel.sid;
  const n = await until(P, "document.readyState === 'complete' && document.getElementById('btn-analyze') && performance.now() > 800", 10000);
  must(n, "панель не загрузилась");
  for (let i = 0; i < 20 && !log.ai.some((x) => x.url.endsWith("/api/chat")); i++) {
    await evalIn(P, "document.getElementById('btn-analyze').click()");
    await sleep(700);
  }
  const req = log.ai.find((x) => x.url.endsWith("/api/chat"));
  must(req, "панель не отправила запрос к боту (/api/chat)");
  const body = JSON.parse(req.body || "{}");
  const all = JSON.stringify(body.messages || []);
  must(all.includes("Наконец-то понятное объяснение"), "в запросе к ИИ нет собранных комментариев");
  must(body.model === "e2e-model", "в запросе не та модель: " + body.model);
  return `запрос к ${new URL(req.url).host}${new URL(req.url).pathname}, сообщений: ${body.messages?.length}, модель ${body.model}`;
});

// ---------- итог ----------
if (errors.length) {
  failed++;
  console.log("FAIL исключения в коде расширения на страницах:\n  " + [...new Set(errors)].slice(0, 10).join("\n  "));
}
if (log.foreign.size) console.log("  (отклонены чужие запросы: " + [...log.foreign].slice(0, 8).join(", ") + ")");
console.log(`${failed ? "ЕСТЬ ОШИБКИ" : "всё работает"}: пройдено ${passed}, не пройдено ${failed} — за ${since().trim()}`);
await bail(failed ? 1 : 0);
