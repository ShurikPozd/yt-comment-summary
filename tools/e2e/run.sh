#!/usr/bin/env bash
# Сквозной тест расширения в безоконном Chrome на снимках страниц YouTube.
#   bash tools/e2e/run.sh
# Подробно — tools/e2e/README.md. Нужны node 22+ и Chrome (путь — переменная CHROME).
set -u
cd "$(dirname "$0")"
exec node run.mjs "$@"
