export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const clipText = (text, limit = 300) => {
  text = (text || "").trim();
  if (text.length <= limit) return text;
  const head = text.slice(0, limit + 1);
  const cut = head.lastIndexOf(" ");
  if (cut > limit / 2) return text.slice(0, cut).replace(/[.,;:!?]+$/, "") + "...";
  return text.slice(0, limit).replace(/[.,;:!?]+$/, "") + "...";
};

export const stripMarkdown = (text) => {
  text = String(text || "").trim();
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\*\*/g, "").replace(/__/g, "");
  // \x60 = обратная кавычка: литеральная ` в регулярке сбивает check-consts.mjs,
  // он принимает её за шаблонную строку и пропускает объявления ниже.
  text = text.replace(/\x60([^\x60]*)\x60/g, "$1");
  text = text.replace(/\*/g, "_");
  text = text.replace(/_/g, "");
  text = text.replace(/^\s*\[\d+\]\s*/gm, "");
  text = text.replace(/\n{2,}/g, "\n");
  return text.trim();
};

export const normalizeSummary = (text, limit = 300) => clipText(stripMarkdown(text), limit);

export function extractJson(raw) {
  raw = String(raw || "");
  let m = raw.match(/```[a-zA-Z]*\n?([\s\S]*?)```/);
  if (m) raw = m[1];
  m = raw.match(/\{.*\}/s);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

export const clean = (value) => {
  const s = String(value || "").trim();
  const cleaned = s
    .replace(/["'()[\]\\]/g, "")
    .replace(/^[\s.\-=:;,!?]+|[\s.\-=:;,!?]+$/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .trim();
  return cleaned;
};

export function sanitizeFilename(name, maxLen = 90) {
  let s = String(name || "thumbnail")
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/[. ]+$/g, "").slice(0, maxLen).replace(/[. ]+$/g, "");
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (reserved.test(s)) s = "_" + s;
  return s || "thumbnail";
}

export function parseChunkTopics(chunkData) {
  // {"topics":{"Тема":[индексы]}, "points":[...], "notable":[...], "sentiment":{...}}
  const topics = {};
  if (chunkData.topics && typeof chunkData.topics === "object") {
    for (const [name, ids] of Object.entries(chunkData.topics)) {
      const arr = Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isFinite(n)) : [];
      const nm = clean(name);
      if (nm && arr.length) topics[nm] = arr;
    }
  }
  const points = Array.isArray(chunkData.points)
    ? chunkData.points.map((p) => normalizeSummary(p, 200)).filter(Boolean)
    : [];
  const notable = Array.isArray(chunkData.notable)
    ? chunkData.notable.map(Number).filter((n) => Number.isFinite(n))
    : [];
  const sent = chunkData.sentiment || {};
  const sentiment = {
    positive: Number(sent.positive) || 0,
    neutral: Number(sent.neutral) || 0,
    negative: Number(sent.negative) || 0,
  };
  return { topics, points, notable, sentiment };
}

/**
 * Асинхронная сериализация вызовов (аналог _LLM_LOCK из бота): не даём
 * превысить rate-limits Groq параллельными запросами.
 */
export class SerialQueue {
  #tail = Promise.resolve();
  push(fn) {
    const run = this.#tail.then(fn, fn);
    this.#tail = run.then(() => {}, () => {});
    return run;
  }
}

/**
 * Ошибка лимитов токенов Groq. Сервер уже отретраил сам (3 попытки с паузами по
 * подсказке Groq), поэтому клиентский ретрай тут только добивает окно и
 * растягивает ожидание. Пробрасываем наружу: вызывающий код (sidepanel) сам
 * решает — ждать и повторять (OTPM) либо дробить (ITPM).
 */
function isTokenLimitErr(e) {
  return /429|413|tokens per minute|\bITPM\b|\bOTPM\b|Request too large|rate.?limit/i.test(
    String(e?.message || e)
  );
}

// Текст «Сервер недоступен» / «таймаут» sidepanel распознаёт и показывает
// дружелюбное сообщение — не менять формулировки без правки friendlyError().
const NETWORK_ERR_MSG =
  "Сервер недоступен (сеть): возможно Render спит (холодный старт ~50 с) или нет связи. Проверь «Проверить связь» и перепробуй.";
const TIMEOUT_ERR_MSG = "Сервер не ответил вовремя (таймаут). Попробуй ещё раз.";

// Сколько ждать следующую порцию стрима, прежде чем считать соединение зависшим.
const STREAM_IDLE_MS = 45000;

function proxyError(message, retryable) {
  const e = new Error(message);
  e.retryable = retryable;
  return e;
}

function friendlyLLMError(data) {
  let msg = "Модель не ответила (временный сбой на сервере). Попробуй ещё раз.";
  if (data?.detail) msg = `Модель не ответила: ${data.detail} Попробуй ещё раз.`;
  return msg;
}

async function errorFromResponse(resp) {
  const data = await resp.json().catch(() => ({}));
  switch (resp.status) {
    case 403:
      return proxyError("Отказано прокси (403): проверьте секрет / доступ к серверу.", false);
    case 400:
    case 413:
      return proxyError(data.error || `Прокси отклонил запрос (${resp.status}).`, false);
    case 502:
      return proxyError(friendlyLLMError(data), true);
    default:
      return proxyError(`Прокси ответил ${resp.status}`, resp.status >= 500);
  }
}

/** Приводит сетевые сбои и таймауты к понятным сообщениям; повторять стоит только их и 5xx. */
function normalizeError(e, timedOut) {
  if (timedOut || e?.name === "AbortError") return proxyError(TIMEOUT_ERR_MSG, true);
  if (/Failed to fetch|fetch failed|NetworkError|network error/i.test(String(e?.message || e))) {
    return proxyError(NETWORK_ERR_MSG, true);
  }
  if (typeof e?.retryable !== "boolean") e.retryable = false;
  return e;
}

export class GroqProxy {
  constructor({ baseUrl = "", token = "", model = "" } = {}) {
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    this.token = token;
    this.model = model;
    this.queue = new SerialQueue();
  }

  get configured() {
    return Boolean(this.baseUrl && this.token && this.model);
  }

  endpoint() {
    return `${this.baseUrl}/api/chat`;
  }

  _headers() {
    return { "Content-Type": "application/json", "X-Sec-Token": this.token };
  }

  /** Один вызов прокси. Возвращает строку content; при ошибке бросает. */
  chat(messages, { jsonMode = false, maxTokens = 800, temperature = 0.1, timeoutMs = 120000 } = {}) {
    return this._run(messages, { jsonMode, maxTokens, temperature, timeoutMs, stream: false });
  }

  /** Проверка настроек: тривиальный вызов. */
  async test() {
    const out = await this.chat(
      [{ role: "user", content: "Ответь одним словом: ok" }],
      { maxTokens: 6, timeoutMs: 40000 }
    );
    return Boolean(out && out.trim());
  }

  /**
   * Стриминговая версия chat(): сервер отдаёт SSE-события {"delta": "…"},
   * onDelta вызывается с накопленным текстом по мере поступления.
   * Возвращает полный текст; при ошибке бросает.
   */
  chatStream(messages, { jsonMode = false, maxTokens = 800, temperature = 0.1, timeoutMs = 150000 } = {}, onDelta) {
    return this._run(messages, { jsonMode, maxTokens, temperature, timeoutMs, stream: true, onDelta });
  }

  async _run(messages, opts) {
    if (!this.configured) throw new Error("Настройки прокси не заполнены (URL/секрет/модель).");
    return this.queue.push(async () => {
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const progress = { received: false };
        try {
          return await this._once(messages, opts, progress);
        } catch (e) {
          lastErr = e;
          // Лимиты токенов решает вызывающий код; 400/403 повтором не лечатся;
          // стрим, который уже показал часть текста, не перезапускаем с нуля.
          if (isTokenLimitErr(e) || !e.retryable || progress.received) throw e;
          if (attempt === 0) await sleep(3000);
        }
      }
      throw lastErr;
    });
  }

  /**
   * Один HTTP-запрос. Таймаут покрывает и чтение тела ответа: раньше он
   * снимался сразу после заголовков, и зависший стрим держал SerialQueue
   * (а с ней — все последующие запросы к модели) бесконечно.
   */
  async _once(messages, { jsonMode, maxTokens, temperature, timeoutMs, stream, onDelta }, progress) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => {
      timedOut = true;
      controller.abort();
    };
    const totalTimer = setTimeout(abort, timeoutMs);
    let idleTimer = null;
    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(abort, STREAM_IDLE_MS);
    };
    try {
      const resp = await fetch(this.endpoint(), {
        method: "POST",
        headers: this._headers(),
        signal: controller.signal,
        body: JSON.stringify({
          messages,
          model: this.model,
          json_mode: jsonMode,
          max_tokens: Math.max(1, Math.min(maxTokens, 2000)),
          temperature,
          ...(stream ? { stream: true } : {}),
        }),
      });
      if (!resp.ok) throw await errorFromResponse(resp);

      if (!stream) {
        const data = await resp.json();
        if (!data || typeof data.content !== "string") throw proxyError("Пустой ответ прокси.", true);
        return data.content;
      }

      bumpIdle();
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let full = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bumpIdle();
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, "").trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let evt;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          if (evt.error) throw proxyError(friendlyLLMError(evt), true);
          if (typeof evt.delta === "string") {
            full += evt.delta;
            progress.received = true;
            onDelta?.(full);
          }
        }
      }
      if (!full) throw proxyError("Пустой ответ прокси.", true);
      return full;
    } catch (e) {
      throw normalizeError(e, timedOut);
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
    }
  }
}
