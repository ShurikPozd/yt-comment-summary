#!/usr/bin/env bash
# Автотест центровки подписей и значков по пикселям.
#   bash tools/align/check.sh [ключ…]
# Поднимает сервер стендов (serve.py, порт ALIGN_PORT, по умолчанию 8777), снимает
# страницы из pages.mjs в безоконном Chrome на масштабах ALIGN_DPRS (по умолчанию 1.5 и 2)
# и падает, если подпись дальше ±ALIGN_TH px (0.6) от середины кнопки или значок —
# от заглавной. Исключения — allow.txt. Нужны node, python с Pillow и numpy, Chrome
# и сеть (окна на YouTube рисуются шрифтом Roboto с Google Fonts).
set -u
cd "$(dirname "$0")"
PORT="${ALIGN_PORT:-8777}"
DPRS="${ALIGN_DPRS:-1.5,2}"
OUT="$(mktemp -d)"
python serve.py "$PORT" >/dev/null 2>&1 &
SRV=$!
cleanup() { kill "$SRV" 2>/dev/null; rm -rf "$OUT"; }
trap cleanup EXIT
for _ in $(seq 1 50); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/tools/align/audit.js" && break
  sleep 0.2
done
keys=("$@")
pages=$(node -e 'import("./pages.mjs").then(({ PAGES }) => { const want = process.argv.slice(1); console.log(PAGES.map((p) => p.key).filter((k) => !want.length || want.includes(k)).join(",")); })' -- "${keys[@]}")
echo "== центровка: $pages (масштабы $DPRS)"
ALIGN_PORT="$PORT" node shot.mjs "$OUT" "$DPRS" "${keys[@]}"
PYTHONIOENCODING=utf-8 python check.py "$OUT" --dprs "$DPRS" --th "${ALIGN_TH:-0.6}" --pages "$pages" ${ALIGN_JSON:+--json "$ALIGN_JSON"} ${ALIGN_ALL:+--all}
