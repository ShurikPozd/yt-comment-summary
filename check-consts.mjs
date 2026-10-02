import fs from "node:fs";

const path = process.argv[2];
let src = fs.readFileSync(path, "utf-8");

// Убираем комментарии и строковые литералы, чтобы не ловить шум.
src = src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/`(?:[^`\\]|\\.)*`/g, "``");

const declared = new Set();
for (const m of src.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
  declared.add(m[1]);
}
// Имена из import {...} из нескольких строк, иначе они looked бы необъявленными.
for (const m of src.matchAll(/\bimport\s*\{([\s\S]*?)\}\s*from/g)) {
  for (const part of m[1].split(",")) {
    const id = part.trim().split(/\s+as\s+/).pop().trim();
    if (id) declared.add(id);
  }
}

const KNOWN = new Set([
  "OTPM", "ITPM", "GET", "POST", "URL", "JSON", "OK",
]);

const seen = new Map();
for (const m of src.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
  if (declared.has(m[1]) || KNOWN.has(m[1])) continue;
  if (!seen.has(m[1])) seen.set(m[1], true);
}

if (seen.size === 0) {
  console.log("неопределённых констант не найдено");
} else {
  console.log("НЕ ОБЪЯВЛЕНЫ (возможные ReferenceError):");
  for (const name of seen.keys()) console.log("  -", name);
}