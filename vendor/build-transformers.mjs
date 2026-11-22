// Собирает vendor/transformers/ — библиотеку Transformers.js и движок ONNX Runtime
// для поиска по смыслу в «Моей библиотеке» (модели работают прямо в браузере).
//
//   npm install @huggingface/transformers@4.3.2   (в любой временной папке)
//   node vendor/build-transformers.mjs <путь к node_modules>
//
// Берём готовую сборку transformers.min.js (всё в одном файле, без внешних
// импортов) и движок ort-wasm-simd-threaded.asyncify.* (WebAssembly) — их
// библиотека иначе тянула бы с CDN, а расширению нельзя исполнять чужой код.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const nm = process.argv[2];
if (!nm) {
  console.error("укажите путь к node_modules");
  process.exit(1);
}
const out = new URL("./transformers/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
mkdirSync(out, { recursive: true });
const tf = join(nm, "@huggingface/transformers");
const ort = join(nm, "onnxruntime-web");
const want = JSON.parse(readFileSync(join(tf, "package.json"), "utf8")).dependencies["onnxruntime-web"];
const have = JSON.parse(readFileSync(join(ort, "package.json"), "utf8")).version;
if (want !== have) throw new Error(`версии не совпадают: нужен onnxruntime-web ${want}, а есть ${have}`);
for (const [from, to] of [
  [join(tf, "dist/transformers.min.js"), "transformers.min.js"],
  // вариант движка «asyncify»: работает и на процессоре, и на WebGPU (jsep с этой
  // сборкой библиотеки на WebGPU не запускается — проверено)
  [join(ort, "dist/ort-wasm-simd-threaded.asyncify.mjs"), "ort-wasm-simd-threaded.asyncify.mjs"],
  [join(ort, "dist/ort-wasm-simd-threaded.asyncify.wasm"), "ort-wasm-simd-threaded.asyncify.wasm"],
  [join(tf, "LICENSE"), "transformers.LICENSE"],
]) {
  copyFileSync(from, join(out, to));
  console.log("ok", to);
}

// у onnxruntime-web в npm нет файла лицензии — пишем стандартный текст MIT (лицензия проекта)
const ortLicense = join(ort, "LICENSE");
if (existsSync(ortLicense)) copyFileSync(ortLicense, join(out, "onnxruntime.LICENSE"));
else
  writeFileSync(
    join(out, "onnxruntime.LICENSE"),
    `ONNX Runtime Web ${have} — https://github.com/microsoft/onnxruntime
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
  );
console.log("ok onnxruntime.LICENSE");
