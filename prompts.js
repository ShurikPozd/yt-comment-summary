export const LANG_LABELS = {
  ru: "русский",
  en: "english",
};

export const CHUNK_ANALYZE_SYSTEM = `Ты анализируешь комментарии к YouTube-видео. Тебе дадут список комментариев с текстом и № строки (начиная с 0).

Верни ТОЛЬКО валидный JSON в формате:
{"topics":{"Название темы":[№,"№"...]},"points":["...","..."],"notable":[№,...],"sentiment":{"positive":N,"neutral":N,"negative":N}}

Правила:
- topics: 2-5 тем, которые РЕАЛЬНО обсуждают комментаторы. Каждый отнесённый комментарий принадлежит ровно одной теме. Комментарии, не подходящие ни к одной теме, не включай. Название темы короткое (2-4 слова), на языке комментариев.
- topics собираются по СМЫСЛУ: общая тема отдельно от тональности («хвалят игру» и «игра лагает» — разные темы, если имеют смысл по отдельности).
- points: 2-5 ключевых мнений/наблюдений, характерных для этого куска обсуждения.
- notable: № 1-3 самых ярких/забавных/эмоциональных/спорных комментариев.
- sentiment: сколько из данных комментариев позитивные / нейтральные / негативные. Сумма обязана равняться числу комментариев в списке. Ссылки, спам, чистое «👍» — нейтральные.
- № — только числа из данного списка. Без пояснений, без markdown.`;

export function chunkUser(comments) {
  const lines = comments
    .map(
      (c, i) =>
        `${i}|${(c.author || "?").slice(0, 24)}|${(c.text || "").slice(0, 500).replace(/\s+/g, " ")}`
    )
    .join("\n");
  return `Комментариев: ${comments.length}\n\n${lines}`;
}

export const FINAL_SYSTEM = `Ты делаешь итоговую сводку обсуждения под YouTube-видео по результатам анализа кусками.

Тебе дадут: темы с количеством комментариев, ключевые мнения, тональность (positive/neutral/negative в сумме по всем комментариям), и несколько самых ярких комментариев с их текстами.

Верни ТОЛЬКО текст сводки — сплошной абзац, БЕЗ JSON-обёртки, без markdown, без списков, без эмодзи, на языке выходного формата (до 380 символов): о чём в основном пишут, радуются/спорят/жалуются, главный вывод.`;

export function finalUser({ topics, points, sentiment, notableComments, lang }) {
  const topicLines = Object.entries(topics)
    .map(([name, n]) => `- ${name}: ${n}`)
    .join("\n") || "- (тем не выделено)";
  const pointsText = points.map((p) => `- ${p}`).join("\n") || "- (нет)";
  const notableText =
    notableComments.map((c, i) => `${i + 1}. «${(c.text || "").slice(0, 220)}»`).join("\n") ||
    "- (нет)";
  return `Выходной язык: ${LANG_LABELS[lang] || "русский"}

Темы:
${topicLines}

Ключевые мнения:
${pointsText}

Тональность: positive=${sentiment.positive}, neutral=${sentiment.neutral}, negative=${sentiment.negative} (всего ${sentiment.positive + sentiment.neutral + sentiment.negative})

Яркие комментарии:
${notableText}`;
}

export const SEARCH_SYSTEM = `Ты фильтруешь комментарии YouTube по запросу пользователя.
Тебе дадут запрос и список комментариев вида [{"id":число,"t":"текст"},...].

Верни ТОЛЬКО JSON: {"ids":[числа],"why":"короткое пояснение на языке запроса (max 120 символов)"}

Правила:
- Выбирай комментарии, реально релевантные запросу ПО СМЫСЛУ (не только точное совпадение слов): синонимы, близкие мнения, примеры.
- Не более 15 ids. Если релевантных нет — ids пустой.
- ids — только числа из списка.`;

export function searchUser(query, comments) {
  const list = comments
    .slice(0, 400)
    .map((c, i) => `{"id":${i},"t":${JSON.stringify((c.text || "").slice(0, 160))}}`)
    .join(",");
  return `Запрос пользователя: ${query}\n\nКомментарии: [${list}]`;
}

export const TOPIC_FILTER_SYSTEM = `Ты классифицируешь комментарии по теме.
Тебе дадут тему и список комментариев вида [{"id":число,"t":"текст"},...].

Верни ТОЛЬКО JSON: {"ids":[числа]} — номера комментариев, которые относятся к теме ПО СМЫСЛУ.
Не более 40 ids. Если ни один не подходит — пустой список.`;

export function topicFilterUser(topic, comments) {
  const list = comments
    .slice(0, 300)
    .map((c, i) => `{"id":${i},"t":${JSON.stringify((c.text || "").slice(0, 160))}}`)
    .join(",");
  return `Тема: ${topic}\n\nКомментарии: [${list}]`;
}