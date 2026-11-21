// Превращает ESM-сборку Mediabunny (npm: mediabunny/dist/bundles/mediabunny.min.mjs)
// в обычный скрипт для chrome.scripting.executeScript: та же библиотека, но вместо
// `export {...}` — globalThis.__ytcsMediabunny. Запуск:
//   node vendor/build-mediabunny.mjs путь/к/mediabunny.min.mjs
import fs from "node:fs";
const [src] = process.argv.slice(2);
const code = fs.readFileSync(src, "utf8");
const m = code.match(/export\{([^}]*)\};?\s*$/);
if (!m || /\bimport\s*[({*]|import\.meta/.test(code)) throw new Error("неожиданный формат сборки");
const pairs = m[1].split(",").map((s) => {
  const [local, name] = s.trim().split(/\s+as\s+/);
  return `${JSON.stringify(name || local)}:${local}`;
});
const head = code.slice(0, code.indexOf("*/") + 2); // лицензионный заголовок MPL-2.0
const body = code.slice(head.length, m.index);
const out = `${head}\n// Собрано vendor/build-mediabunny.mjs из mediabunny.min.mjs (без изменений кода).\n(()=>{"use strict";if(globalThis.__ytcsMediabunny)return;${body}\nglobalThis.__ytcsMediabunny={${pairs.join(",")}};})();\n`;
fs.writeFileSync(new URL("./mediabunny.js", import.meta.url), out);
console.log("ok", pairs.length, "exports,", out.length, "bytes");
