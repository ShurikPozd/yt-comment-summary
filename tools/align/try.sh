#!/usr/bin/env bash
# Примерить правку CSS, не меняя файлы: CSS добавляется на страницу и в открытые тени окон.
#   bash tools/align/try.sh <файл.css|-> "<regex для --show>" ключ…
# Сервер стендов должен быть запущен: python tools/align/serve.py 8777
set -u
cd "$(dirname "$0")"
css="$1"; show="$2"; shift 2
OUT="$(mktemp -d)"
pages=$(IFS=,; echo "$*")
if [ "$css" = "-" ]; then css=""; else css="$(cd "$(dirname "$css")" && pwd)/$(basename "$css")"; fi
ALIGN_CSS="$css" node shot.mjs "$OUT" "${ALIGN_DPRS:-1.5,2}" "$@"
PYTHONIOENCODING=utf-8 python check.py "$OUT" --dprs "${ALIGN_DPRS:-1.5,2}" --pages "$pages" --show "$show" | grep -v "^НЕТ\|^центровка\|^  ~\|^      причина"
rm -rf "$OUT"
