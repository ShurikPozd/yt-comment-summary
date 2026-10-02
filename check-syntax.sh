#!/usr/bin/env bash
# Проверка синтаксиса ES-модулей расширения.
# ВАЖНО: `node --check file.js` в этом проекте БЕСПОЛЯЗЕН - без "type":"module"
# в package.json Node парсит .js как CommonJS и пропускает настоящие ошибки ESM
# (лишняя скобка в sidepanel.js держала панель мёртвой и не показывалась).
# Копируем в .mjs - это принудительно включает разбор как модуль.
set -u
cd "$(dirname "$0")"
echo "== синтаксис ES-модулей =="
node check-exports.mjs . && echo "= экспорты на месте ="
echo "== константы верхнего регистра =="
cstmp=$(mktemp)
cfail=0
for f in sidepanel/sidepanel.js groq.js prompts.js config.js; do
  [ -f "$f" ] || continue
  if out=$(node check-consts.mjs "$f") && ! printf '%s' "$out" | grep -q 'НЕ ОБЪЯВЛЕНЫ'; then
    echo "OK   $f"
  else
    echo "FAIL $f"
    printf '%s\n' "$out"
    cfail=1
  fi
done
rm -f "$cstmp"
echo "== разбор как ESM =="
tmp=".syntaxcheck.mjs"
err=$(mktemp)
fail=0
for f in sidepanel/sidepanel.js groq.js prompts.js config.js content.js background.js; do
  [ -f "$f" ] || continue
  cp "$f" "$tmp"
  if node --check "$tmp" 2>"$err"; then
    echo "OK   $f"
  else
    echo "FAIL $f"
    sed -n '1,10p' "$err"
    fail=1
  fi
done
rm -f "$tmp" "$err"
if [ "$fail" -eq 0 ] && [ "$cfail" -eq 0 ]; then
  echo "всё чисто: модули разбираются как ESM, необъявленных констант нет"
  exit 0
fi
exit 1