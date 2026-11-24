// Снимки стендов для замера центровки.
//   node tools/align/shot.mjs <папка> <dpr[,dpr…]> [ключ…]
// Для каждой страницы из pages.mjs (или только названных) и каждого масштаба:
// открывает её в безоконном Chrome, ждёт готовности, выполняет действие (открыть
// окно и т. п.), подгоняет высоту окна под страницу, вызывает __textAudit
// (audit.js) и сохраняет <ключ>@<dpr>.png (снимок окна) и <ключ>@<dpr>.json
// (рамки элементов, заглавных и значков). Пиксели меряет pixan.py.
// Переменные окружения:
//   ALIGN_PORT — порт сервера стендов (serve.py), по умолчанию 8777;
//   ALIGN_CSS  — файл CSS, который добавить на страницу и в открытые тени (для opt.py);
//   CHROME     — путь к chrome.exe;
//   ALIGN_PEEK — выражение JS: выполнить перед замером и напечатать (для отладки стендов).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PAGES } from "./pages.mjs";

const [outDir, dprArg = "1.5,2", ...keys] = process.argv.slice(2);
if (!outDir) {
  console.error("node shot.mjs <папка> <dpr[,dpr…]> [ключ…]");
  process.exit(2);
}
const ORIGIN = `http://127.0.0.1:${process.env.ALIGN_PORT || 8777}`;
const CSS = process.env.ALIGN_CSS ? readFileSync(process.env.ALIGN_CSS, "utf8") : "";
const DPRS = dprArg.split(",").map(Number);
const pages = keys.length ? PAGES.filter((p) => keys.includes(p.key)) : PAGES;
const unknown = keys.filter((k) => !PAGES.some((p) => p.key === k));
if (unknown.length) {
  console.error("нет таких страниц:", unknown.join(", "), "\nесть:", PAGES.map((p) => p.key).join(", "));
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

// безоконный Chrome со своим временным профилем (абсолютный путь)
const prof = resolve(mkdtempSync(join(tmpdir(), "ytcs-align-")));
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(
  process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-prefers-reduced-motion", "--mute-audio", "--no-first-run",
    "--no-default-browser-check", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "about:blank"],
  { stdio: "ignore" }
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    chrome.kill();
  } catch {}
  // профиль освобождается не сразу после выхода Chrome
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(prof, { recursive: true, force: true });
      break;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}
process.on("exit", cleanup);

let ws;
for (let i = 0; i < 75 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === "page");
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {}
  if (!ws) await sleep(200);
}
if (!ws) {
  console.error("Chrome не запустился");
  process.exit(3);
}
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
let pageErrors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails.exception?.description?.split("\n")[0] || m.params.exceptionDetails.text);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") pageErrors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
async function evalJs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
}
async function until(expr, ms) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    try {
      if (await evalJs(`Boolean(${expr})`)) return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

await send("Page.enable");
await send("Runtime.enable");
const MAX_DEV_PX = 16000; // больше снимок не помещается в текстуру
let failed = 0;
for (const dpr of DPRS) {
  for (const p of pages) {
    const tag = `${p.key}@${dpr}`;
    const maxH = Math.min(p.h || 2000, Math.floor(MAX_DEV_PX / dpr));
    await send("Emulation.setDeviceMetricsOverride", { width: p.w, height: Math.min(maxH, 1200), deviceScaleFactor: dpr, mobile: false });
    await send("Page.navigate", { url: "about:blank" });
    await sleep(100);
    pageErrors = [];
    await send("Page.navigate", { url: ORIGIN + p.url });
    const why = () => (pageErrors.length ? "\n  ошибки страницы: " + [...new Set(pageErrors)].slice(0, 5).join("\n  ") : "");
    if (!(await until(p.wait, 20000))) {
      console.error(`${tag}: страница не дождалась готовности (${p.wait})${why()}`);
      failed++;
      continue;
    }
    try {
      if (p.act) await evalJs(p.act);
    } catch (e) {
      console.error(`${tag}: действие упало: ${e.message}${why()}`);
      failed++;
      continue;
    }
    await sleep(p.settle ?? 700);
    // окно — по длине страницы (не больше maxH): всё, что ниже, тоже попадает в снимок
    const docH = await evalJs("Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)");
    const H = Math.max(600, Math.min(maxH, Math.ceil(docH)));
    await send("Emulation.setDeviceMetricsOverride", { width: p.w, height: H, deviceScaleFactor: dpr, mobile: false });
    await evalJs("scrollTo(0, 0)");
    await sleep(300);
    await evalJs("document.fonts.ready.then(() => 1)");
    const setup = `new Promise((ok, bad) => {
      const css = ${JSON.stringify(CSS)};
      if (css) {
        const put = (r) => { const st = document.createElement('style'); st.textContent = css; (r.head || r).append(st); };
        put(document);
        for (const el of document.querySelectorAll('*')) if (el.shadowRoot) put(el.shadowRoot);
      }
      if (window.__textAudit) return ok(1);
      const s = document.createElement('script');
      s.src = '/tools/align/audit.js';
      s.onload = () => ok(1);
      s.onerror = () => bad(new Error('audit.js не загрузился'));
      document.head.append(s);
    })`;
    if (process.env.ALIGN_PEEK) console.log(tag, JSON.stringify(await evalJs(process.env.ALIGN_PEEK).catch((e) => e.message)));
    try {
      await evalJs(setup);
      if (CSS) await sleep(200);
      const pairs = await evalJs(`window.__textAudit(${p.roots || "[document]"}, ${JSON.stringify(p.extra || "")})`);
      if (!pairs?.length) console.error(`${tag}: не нашлось ни одной подписи${why()}`);
      const shot = await send("Page.captureScreenshot", { format: "png" });
      if (!shot.result?.data) throw new Error("снимок не получился");
      writeFileSync(join(outDir, tag + ".png"), Buffer.from(shot.result.data, "base64"));
      writeFileSync(join(outDir, tag + ".json"), JSON.stringify({ key: p.key, dpr, w: p.w, h: H, pairs: pairs || [] }));
    } catch (e) {
      console.error(`${tag}: ${e.message}`);
      failed++;
    }
  }
}
ws.close();
cleanup();
process.exit(failed ? 1 : 0);
