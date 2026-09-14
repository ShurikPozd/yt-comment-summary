// Публичные дефолты расширения (без секретов).
// Секрет (EXT_SECRET) передаётся через gitignored local-config.js или настройки UI.
export const DEFAULTS = {
  baseUrl: "https://tg-saver-bot-cloud.onrender.com",
  model: "qwen/qwen3.6-27b",
  maxComments: 120,
  lang: "ru",
  collectMode: "auto",
  thumbTemplate: "{title} - {channel}",
};