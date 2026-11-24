// Безоконный Chrome с распакованным расширением и подменой сети — для сквозного теста.
// Брендовый Chrome (с версии 137) не грузит --load-extension, поэтому расширение
// ставится командой CDP Extensions.loadUnpacked: она доступна только по пайпу
// (--remote-debugging-pipe) и с флагом --enable-unsafe-extension-debugging.
// Вся сеть идёт через Fetch.requestPaused (страницы, фон расширения) и отвечается
// из route(); живого YouTube и бота тест не касается — всё, что не перехвачено,
// упирается в --host-resolver-rules (ни один адрес не разрешается).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_CHROME = {
  win32: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "/usr/bin/google-chrome",
};

export async function launch({ chrome = process.env.CHROME || DEFAULT_CHROME[process.platform], headless = !process.env.E2E_HEADFUL, log = () => {} } = {}) {
  // временный профиль — по абсолютному пути, удаляется после выхода
  const prof = resolve(mkdtempSync(join(tmpdir(), "ytcs-e2e-")));
  const args = [
    ...(headless ? ["--headless=new"] : []),
    // раннеры GitHub на Ubuntu 24.04 запрещают песочнице Chrome user namespaces (AppArmor)
    ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    `--user-data-dir=${prof}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-features=Translate,OptimizationHints,MediaRouter",
    // ни одно имя не разрешается: всё, что не подменено перехватом, падает, а не уходит в сеть
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--window-size=1400,1000",
    "about:blank",
  ];
  const proc = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  proc.stderr.on("data", () => {}); // не забивать буфер
  const out = proc.stdio[3];
  const inp = proc.stdio[4];
  let exited = false;
  proc.on("exit", () => (exited = true));

  let seq = 0;
  const pending = new Map();
  const handlers = new Set();
  let buf = Buffer.alloc(0);
  inp.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(0)) >= 0) {
      const msg = JSON.parse(buf.subarray(0, i).toString("utf8"));
      buf = buf.subarray(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const { ok, bad, method } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) bad(new Error(`${method}: ${msg.error.message}${msg.error.data ? " " + msg.error.data : ""}`));
        else ok(msg.result);
      } else if (msg.method) {
        for (const h of handlers) {
          try {
            h(msg);
          } catch (e) {
            log("обработчик упал: " + e.stack);
          }
        }
      }
    }
  });

  /** Команда CDP; sessionId — цель (страница, фон), без него — сам браузер. */
  function send(method, params = {}, sessionId) {
    if (exited) return Promise.reject(new Error(`Chrome закрылся (${method})`));
    const id = ++seq;
    return new Promise((ok, bad) => {
      pending.set(id, { ok, bad, method });
      out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try {
      await Promise.race([send("Browser.close"), sleep(3000)]);
    } catch {}
    try {
      proc.kill();
    } catch {}
    // профиль освобождается не сразу после выхода Chrome
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(prof, { recursive: true, force: true });
        break;
      } catch {
        await sleep(250);
      }
    }
  }

  const version = await Promise.race([send("Browser.getVersion"), sleep(20000).then(() => null)]);
  if (!version) {
    await close();
    throw new Error("Chrome не ответил по пайпу: " + chrome);
  }
  return { send, on: (h) => (handlers.add(h), () => handlers.delete(h)), close, version, proc };
}
