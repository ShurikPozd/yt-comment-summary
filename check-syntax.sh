#!/usr/bin/env bash
# Проверка синтаксиса ES-модулей расширения.
# ВАЖНО: `node --check file.js` в этом проекте БЕСПОЛЯЗЕН - без "type":"module"
# в package.json Node парсит .js как CommonJS и пропускает настоящие ошибки ESM
# (лишняя скобка в sidepanel.js держала панель мёртвой и не показывалась).
# Копируем в .mjs - это принудительно включает разбор как модуль.
# Флаг --align — ещё и автотест центровки подписей по пикселям (tools/align/check.sh:
# безоконный Chrome, ~3 мин). Отдельно: bash tools/align/check.sh
set -u
cd "$(dirname "$0")"
align=0
for a in "$@"; do [ "$a" = "--align" ] && align=1; done
echo "== синтаксис ES-модулей =="
efail=0
if node check-exports.mjs .; then echo "= экспорты на месте ="; else efail=1; fi
echo "== константы верхнего регистра =="
cstmp=$(mktemp)
cfail=0
for f in sidepanel/sidepanel.js sidepanel/insights.js sidepanel/icons.js sidepanel/card.js sidepanel/video-tldr.js sidepanel/selfcheck-ui.js selfcheck.js groq.js prompts.js config.js tldr-core.js tldr-bg.js library/library.js library/search.js library/state.js library/store.js library/youtube.js library/catalog.js library/view-lib.js library/queue-view.js library/watch.js library/wl.js library/triage.js library/triage-tldr.js library/tidy.js library/backup.js library/semantic.js library/sem-ui.js library/sem-worker.js library/cover-actions.js library/sync-plan.js library/subs.js library/subs-ui.js library/subs-core.js library/subs-worker.js omnibox-core.js omnibox.js bot-settings.js archive-core.js archive-bg.js sidepanel/channel-speed.js speed.js speed-core.js sleep.js sleep-core.js resume.js resume-core.js sidepanel/focus-settings.js silence.js silence-core.js library/stats-view.js stats-core.js stats-bg.js stats.js library/digest.js library/digest-core.js library/multi.js library/multi-core.js queue-core.js lazy.js lazy-bg.js welcome/welcome.js welcome/link.js welcome-bg.js panel-window.js share-core.js backup-core.js backup-bg.js yqsync-core.js yqsync-bg.js report-core.js library/queue-tidy.js library/queue-tidy-core.js notes-core.js library/notes-view.js; do
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
for f in sidepanel/sidepanel.js sidepanel/insights.js sidepanel/sponsor-settings.js sidepanel/preview.js sidepanel/icons.js sidepanel/card.js sidepanel/video-tldr.js sidepanel/selfcheck-ui.js selfcheck.js groq.js prompts.js config.js transcript.js tldr-core.js tldr-bg.js video-actions.js thumb-preview.js content.js early.js early-main.js clip.js clip-main.js sponsor.js playlists.js playlists-main.js queue.js select.js library/library.js library/search.js library/state.js library/store.js library/youtube.js library/catalog.js library/view-lib.js library/queue-view.js library/watch.js library/wl.js library/triage.js library/triage-tldr.js library/tidy.js library/backup.js library/semantic.js library/sem-ui.js library/sem-worker.js library/cover-actions.js library/sync-plan.js library/subs.js library/subs-ui.js library/subs-core.js library/subs-worker.js omnibox-core.js omnibox.js bot-settings.js archive-core.js archive-bg.js sidepanel/channel-speed.js speed.js speed-core.js sleep.js sleep-core.js resume.js resume-core.js speed-main.js sidepanel/focus-settings.js focus.js silence.js silence-core.js library/stats-view.js stats-core.js stats-bg.js stats.js library/digest.js library/digest-core.js library/multi.js library/multi-core.js queue-core.js lazy.js lazy-bg.js welcome/welcome.js welcome/link.js welcome-bg.js panel-window.js share-core.js backup-core.js backup-bg.js yqsync-core.js yqsync-bg.js report-core.js library/queue-tidy.js library/queue-tidy-core.js notes-core.js notes.js library/notes-view.js background.js; do
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
echo "== автопроверки (поиск, разбор ответов YouTube) =="
tfail=0
if out=$(node tests/run.mjs 2>&1); then echo "OK   $out"; else echo "FAIL tests/run.mjs"; printf '%s
' "$out"; tfail=1; fi
afail=0
if [ "$align" -eq 1 ]; then
  bash tools/align/check.sh || afail=1
fi
if [ "$efail" -eq 0 ] && [ "$fail" -eq 0 ] && [ "$cfail" -eq 0 ] && [ "$tfail" -eq 0 ] && [ "$afail" -eq 0 ]; then
  echo "всё чисто: модули разбираются как ESM, необъявленных констант нет$([ "$align" -eq 1 ] && echo ", подписи по центру")"
  exit 0
fi
exit 1