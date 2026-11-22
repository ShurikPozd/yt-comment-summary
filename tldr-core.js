// Ядро пересказа видео по субтитрам — общее для вкладки «О видео» в боковой
// панели (sidepanel/video-tldr.js) и всплывающего окна «О чём видео» на ленте
// (video-actions.js → фон, tldr-bg.js).
//
// Без DOM: расшифровку (transcript.js) и клиент бота (GroqProxy) с бюджетом
// лимитов (createPacer) передаёт вызывающий. Короткая расшифровка — один
// запрос, длинная — конспекты частей (map) и итог по ним (reduce). Итог —
// обычный текст: абзац «о чём видео» и строки «м:сс — пункт»; onUpdate получает
// его по мере написания (стрим).
// Готовый пересказ кешируется по videoId в chrome.storage.local — кеш общий:
// пересказали в окне на ленте — в панели он уже готов, и наоборот.

import { extractJson, sleep, retryAfterMs, isOutputLimitError, isRateLimitError, isSizeLimitError } from "./groq.js";
import {
  TLDR_PART_SYSTEM,
  tldrPartUser,
  TLDR_DIRECT_SYSTEM,
  TLDR_FINAL_SYSTEM,
  tldrDirectUser,
  tldrFinalUser,
} from "./prompts.js";
import { fmtTime } from "./sidepanel/insights.js";

export const TLDR_CACHE_PREFIX = "tldr:";
export const TLDR_CACHE_INDEX = "tldr:index";
const CACHE_MAX = 60; // пересказов на этом компьютере (~2 КБ каждый)

// Бюджет (бесплатный Groq: ~6 тыс. входных токенов в минуту на весь ключ,
// 200 тыс. в сутки на модель — общий с ботом). 1 токен ≈ 3 символа, с запасом.
const BLOCK_SEC = 20; // строки субтитров склеиваем в блоки ~20 с с одним таймкодом
const DIRECT_MAX_TOKENS = 3600; // до стольких — сразу итог одним запросом
// вход одной части (без промпта): две части с промптом укладываются в минутный бюджет
const PART_MAX_TOKENS = 2500;
const TOTAL_MAX_TOKENS = 18000; // потолок расшифровки: ~4 мин лимита; длиннее — ужимаем
const PART_OUT_TOKENS = 260;
const FINAL_OUT_TOKENS = 650;

// кириллица ≈ 3 символа на токен, латиница и прочее ≈ 4 (с запасом)
export const tokensOf = (s) => {
  const t = String(s || "");
  const cyr = (t.match(/[Ѐ-ӿ]/g) || []).length;
  return Math.ceil(cyr / 3 + (t.length - cyr) / 4);
};
const estimateTokens = (sys, user) => tokensOf(sys) + tokensOf(user) + 120;

export function hmsToSec(s) {
  const parts = String(s || "")
    .trim()
    .split(":")
    .map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((a, n) => a * 60 + n, 0);
}

// ---------------- Кеш ----------------

export async function loadTldr(vid) {
  try {
    const k = TLDR_CACHE_PREFIX + vid;
    return (await chrome.storage.local.get(k))[k] || null;
  } catch (e) {
    return null;
  }
}

export async function saveTldr(vid, data) {
  try {
    const idx = (await chrome.storage.local.get(TLDR_CACHE_INDEX))[TLDR_CACHE_INDEX] || [];
    const next = [vid, ...idx.filter((x) => x !== vid)];
    const drop = next.splice(CACHE_MAX);
    await chrome.storage.local.set({ [TLDR_CACHE_PREFIX + vid]: data, [TLDR_CACHE_INDEX]: next });
    if (drop.length) await chrome.storage.local.remove(drop.map((x) => TLDR_CACHE_PREFIX + x));
  } catch (e) {
    console.warn("пересказ не сохранился в кеш:", e);
  }
}

// ---------------- Расшифровка → строки ----------------

export function buildBlocks(segments) {
  const blocks = [];
  let cur = null;
  for (const s of segments) {
    if (!cur || s.t - cur.t >= BLOCK_SEC) {
      cur = { t: s.t, text: s.text };
      blocks.push(cur);
    } else {
      cur.text += " " + s.text;
    }
  }
  return blocks;
}

const blockLine = (b) => `[${fmtTime(b.t)}] ${b.text}`;

// Длинное видео не влезает в разумный бюджет — ужимаем равномерно: из каждого
// блока берём начало (доля ratio), так пересказ всё равно охватывает всё видео.
function thinBlocks(blocks, ratio) {
  return blocks.map((b) => {
    const words = b.text.split(" ");
    const keep = Math.max(4, Math.ceil(words.length * ratio));
    return { t: b.t, text: words.slice(0, keep).join(" ") + (keep < words.length ? " …" : "") };
  });
}

export function splitParts(lines) {
  const parts = [];
  let cur = [];
  let n = 0;
  for (const l of lines) {
    const t = tokensOf(l) + 1;
    if (cur.length && n + t > PART_MAX_TOKENS) {
      parts.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(l);
    n += t;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

function chaptersText(chapters) {
  return (chapters || [])
    .slice(0, 30)
    .map((c) => `${fmtTime(c.t)} — ${String(c.title).slice(0, 100)}`)
    .join("\n");
}

// ---------------- Разбор итога ----------------

const TC_LINE = /^\s*(?:[-•*·]\s*|\d{1,2}[.)]\s+)?\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(?:[—–\-:|]\s*)?(.+)$/;

export function parseTldr(text, durationSec = 0) {
  const about = [];
  const points = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.replace(/\*\*|__|`/g, "").trim();
    if (!line) continue;
    const m = line.match(TC_LINE);
    if (m) {
      const t = hmsToSec(m[1]);
      const x = m[2].trim();
      if (t != null && x && (!durationSec || t <= durationSec + 5)) points.push({ t, x });
      continue;
    }
    // заголовки вроде «Главное:» — не текст пересказа
    if (/^(главное|главные пункты|ключевые моменты|key points|main points)\s*:?$/i.test(line)) continue;
    if (!points.length) about.push(line);
  }
  return {
    about: about
      .join(" ")
      .replace(/^(о чём видео|кратко|пересказ)\s*:\s*/i, "")
      .trim(),
    points: points.sort((a, b) => a.t - b.t).slice(0, 8),
  };
}

/** Не больше max пунктов, равномерно по видео: первый и последний остаются. */
export function pickEven(points, max) {
  const list = points || [];
  if (list.length <= max) return list.slice();
  const out = [];
  for (let i = 0; i < max; i++) out.push(list[Math.round((i * (list.length - 1)) / (max - 1))]);
  return out;
}

/** Пересказ обычным текстом — для «Скопировать». */
export function tldrCopyText(e, vid) {
  const out = [`О чём видео${e.title ? ` «${e.title}»` : ""}`, "", e.about || ""];
  if (e.points?.length) {
    out.push("", "Главное:");
    for (const p of e.points) out.push(`${fmtTime(p.t)} — ${p.x}`);
  }
  if (vid) out.push("", `https://youtu.be/${vid}`);
  return out.join("\n").trim();
}

// ---------------- Запросы к модели ----------------

export function cancelledError() {
  const e = new Error("Запрос отменён");
  e.cancelled = true;
  return e;
}

// Один запрос с ожиданием окна лимита и повтором на 429 (как у анализа комментариев).
async function ask(messages, { proxy, pacer, estIn, estOut, maxTokens, stream = false, onDelta, signal, note }) {
  for (let tries = 0; ; tries++) {
    const slot = await pacer.pace(estIn, estOut, (sec) => note(`Жду окно бесплатного лимита Groq: ~${sec} с…`));
    if (signal.aborted) throw cancelledError();
    try {
      const out = stream
        ? await proxy.chatStream(messages, { maxTokens, timeoutMs: 330000, signal }, onDelta)
        : await proxy.chat(messages, { jsonMode: true, maxTokens, timeoutMs: 330000, signal });
      pacer.settle(slot, out);
      return out;
    } catch (e) {
      if (e?.cancelled || signal.aborted) throw cancelledError();
      if (tries >= 3 || isSizeLimitError(e)) throw e;
      if (isOutputLimitError(e)) {
        const w = Math.max(30000, retryAfterMs(e, 30000));
        note(`Groq: лимит выходных токенов — жду ~${Math.round(w / 1000)} с и повторю…`);
        pacer.pushAfterOutputError(w);
        await sleep(w);
        continue;
      }
      if (isRateLimitError(e)) {
        const w = Math.max(20000, retryAfterMs(e, 30000));
        note(`Groq: лимит запросов — жду ~${Math.round(w / 1000)} с и повторю…`);
        await sleep(w);
        continue;
      }
      throw e;
    }
  }
}

/**
 * Пересказ по готовой расшифровке ({segments, chapters, source, noiseOnly}).
 * onUpdate({ phase, frac, live }) — этап, доля готовности 0..1 и текст итога по мере написания.
 * Возвращает данные для кеша (их же и сохраняет) либо { nosubs: true, music } —
 * пересказать не из чего. Отмена через signal → ошибка с .cancelled.
 */
export async function runTldr({ vid, transcript, title = "", duration = 0, lang = "ru", proxy, pacer, signal, onUpdate = () => {} }) {
  const startedAt = Date.now();
  const segments = transcript?.segments || [];
  if (!segments.length) return { nosubs: true, music: Boolean(transcript?.noiseOnly) };
  // подпись этапа («Часть 2 из 4.») остаётся и в тексте ожидания лимита
  let stage = "";
  const note = (text) => onUpdate({ phase: stage ? `${stage} ${text}` : text });
  const base = { proxy, pacer, signal, note };

  let blocks = buildBlocks(segments);
  const fullTokens = tokensOf(blocks.map(blockLine).join("\n"));
  let ratio = 1;
  if (fullTokens > TOTAL_MAX_TOKENS) {
    ratio = TOTAL_MAX_TOKENS / fullTokens;
    blocks = thinBlocks(blocks, ratio);
  }
  const lines = blocks.map(blockLine);
  const chapters = chaptersText(transcript.chapters);
  const durGuess = Number(duration) || segments[segments.length - 1].t;
  const tokens = tokensOf(lines.join("\n"));
  const onDelta = (full) => onUpdate({ live: full });
  let failed = 0;
  let text = "";

  if (tokens <= DIRECT_MAX_TOKENS) {
    onUpdate({ phase: "Пишу пересказ…", frac: 0.35 });
    const user = tldrDirectUser({ lines: lines.join("\n"), lang, title, duration: fmtTime(durGuess), chapters });
    text = await ask(
      [
        { role: "system", content: TLDR_DIRECT_SYSTEM },
        { role: "user", content: user },
      ],
      { ...base, estIn: estimateTokens(TLDR_DIRECT_SYSTEM, user), estOut: FINAL_OUT_TOKENS, maxTokens: 900, stream: true, onDelta }
    );
  } else {
    const parts = splitParts(lines);
    const digests = [];
    let lastErr = null;
    for (let i = 0; i < parts.length; i++) {
      if (signal.aborted) throw cancelledError();
      const from = parts[i][0].match(/^\[([\d:]+)\]/)?.[1] || "0:00";
      stage = `Часть ${i + 1} из ${parts.length}.`;
      onUpdate({ phase: `Читаю субтитры: часть ${i + 1} из ${parts.length}…`, frac: 0.06 + (0.74 * i) / parts.length });
      const user = tldrPartUser({ lines: parts[i].join("\n"), part: i + 1, total: parts.length, lang, title });
      try {
        const raw = await ask(
          [
            { role: "system", content: TLDR_PART_SYSTEM },
            { role: "user", content: user },
          ],
          { ...base, estIn: estimateTokens(TLDR_PART_SYSTEM, user), estOut: PART_OUT_TOKENS, maxTokens: 700 }
        );
        const data = extractJson(raw);
        if (!data) throw new Error("Модель вернула не JSON");
        const p = (Array.isArray(data.p) ? data.p : [])
          .map((x) => ({ t: String(x?.t || "").trim(), x: String(x?.x || "").trim() }))
          .filter((x) => hmsToSec(x.t) != null && x.x)
          .slice(0, 5);
        digests.push({ from, s: String(data.s || "").trim(), p });
      } catch (e) {
        if (e?.cancelled || signal.aborted) throw cancelledError();
        if (isSizeLimitError(e)) throw e;
        failed++;
        lastErr = e;
        console.warn("часть пересказа не удалась:", e);
      }
    }
    if (!digests.length) throw lastErr || new Error("Не удалось разобрать субтитры");
    if (signal.aborted) throw cancelledError();
    stage = "Остался итог.";
    onUpdate({ phase: "Пишу пересказ…", frac: 0.85 });
    const user = tldrFinalUser({ parts: digests, lang, title, duration: fmtTime(durGuess), chapters });
    text = await ask(
      [
        { role: "system", content: TLDR_FINAL_SYSTEM },
        { role: "user", content: user },
      ],
      { ...base, estIn: estimateTokens(TLDR_FINAL_SYSTEM, user), estOut: FINAL_OUT_TOKENS, maxTokens: 900, stream: true, onDelta }
    );
  }
  if (signal.aborted) throw cancelledError();
  const parsed = parseTldr(text, durGuess);
  if (!parsed.about && !parsed.points.length) throw new Error("Модель вернула пустой пересказ");
  const data = {
    about: parsed.about,
    points: parsed.points,
    title,
    lang,
    updatedAt: Date.now(),
    source: transcript.source || "panel",
    segments: segments.length,
    trimmed: ratio < 1 ? Math.round(ratio * 100) / 100 : 0,
    partsFailed: failed,
    tookMs: Date.now() - startedAt,
  };
  if (vid) await saveTldr(vid, data);
  return data;
}

/** Короткое понятное сообщение об ошибке пересказа (для окна на ленте). */
export function tldrErrorText(e) {
  const s = String(e?.message || e || "");
  if (/^transcript:/.test(s)) {
    return /timeout|network/.test(s)
      ? "YouTube не ответил — проверьте интернет и попробуйте ещё раз."
      : "YouTube не отдал субтитры. Обновите страницу (F5) и попробуйте ещё раз.";
  }
  if (isOutputLimitError(e) || isRateLimitError(e)) {
    return "Бесплатный лимит Groq на эту минуту закончился (бот и расширение делят один ключ). Подождите минуту и попробуйте ещё раз.";
  }
  if (isSizeLimitError(e)) return "Расшифровка не влезла в запрос к модели. Попробуйте ещё раз — или откройте пересказ в боковой панели.";
  if (/Модель не ответила/.test(s)) return "Модель Groq не ответила (временный сбой). Попробуйте ещё раз — обычно со второй попытки проходит.";
  if (/таймаут|timeout|Сервер недоступен|Failed to fetch|fetch failed/i.test(s)) {
    return "Сервер с ИИ не ответил: возможно, Render просыпается (~50 с) или нет интернета. Попробуйте ещё раз через минуту.";
  }
  if (/403|Отказано прокси|forbidden/i.test(s)) return "Сервер с ИИ отклонил запрос: проверьте адрес и секрет в настройках боковой панели.";
  return s || "Неизвестная ошибка";
}
