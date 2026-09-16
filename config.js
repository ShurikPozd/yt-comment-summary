// Публичные дефолты расширения (без секретов).
// Секрет (EXT_SECRET) передаётся через gitignored local-config.js или настройки UI.
export const DEFAULTS = {
  baseUrl: "http://localhost:8080",
  model: "qwen/qwen3.8-27b",
  maxComments: 120,
  lang: "ru",
  collectMode: "auto",
  thumbTemplate: "{title} - {channel}",
};