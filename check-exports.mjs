// Проверка: все ли имена, которые импортируют panel/content, реально экспортируются.
// Именно так проявился баг с потерянным `export class GroqProxy`.
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] || ".";
const files = ["sidepanel/sidepanel.js", "content.js", "background.js"].filter((f) =>
  fs.existsSync(path.join(root, f))
);

const imported = new Map(); // module -> Set(names)
const importRe = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
for (const f of files) {
  const src = fs.readFileSync(path.join(root, f), "utf8");
  let m;
  while ((m = importRe.exec(src))) {
    const names = m[1]
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    const spec = m[2];
    const resolved = path.resolve(path.dirname(path.join(root, f)), spec);
    if (!imported.has(resolved)) imported.set(resolved, new Set());
    for (const n of names) imported.get(resolved).add(n);
  }
}

const exportedOf = new Map();
for (const spec of imported.keys()) {
  const p = path.resolve(root, spec);
  let mod;
  try {
    mod = await import("file://" + p);
  } catch (e) {
    console.log(`FAIL  ${spec} не импортируется: ${e.message}`);
    exportedOf.set(spec, new Set());
    continue;
  }
  exportedOf.set(spec, new Set(Object.keys(mod)));
}

let bad = 0;
for (const [spec, names] of imported) {
  const have = exportedOf.get(spec) || new Set();
  for (const n of names) {
    if (!have.has(n)) {
      console.log(`FAIL  ${spec} не экспортирует "${n}"`);
      bad++;
    }
  }
}
if (bad === 0) console.log("все импортируемые имена экспортируются");
process.exit(bad ? 1 : 0);