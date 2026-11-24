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
  "Сервер недоступен (сеть): возможно Render спит (холодный старт ~50 с) или нет связи. Нажмите «Проверить связь» в настройках и попробуйте ещё раз.";
const TIMEOUT_ERR_MSG = "Сервер не ответил вовремя (таймаут). Попробуйте ещё раз.";
const CANCELLED_MSG = "Запрос отменён";
const CUT_MSG = "Ответ сервера оборвался на середине. Запустите ещё раз.";

// Сколько ждать следующую порцию стрима, прежде чем считать соединение
// зависшим. Сервер между своими попытками к Groq молчит до ~90 с — меньший
// порог обрывал живой запрос.
const STREAM_IDLE_MS = 120000;

function proxyError(message, retryable) {
  const e = new Error(message);
  e.retryable = retryable;
  return e;
}

function friendlyLLMError(data) {
  let msg = "Модель не ответила (временный сбой на сервере). Попробуйте ещё раз.";
  if (data?.detail) msg = `Модель не ответила: ${data.detail} Попробуйте ещё раз.`;
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
function normalizeError(e, timedOut, cancelled) {
  if (cancelled) {
    const c = proxyError(CANCELLED_MSG, false);
    c.cancelled = true;
    return c;
  }
  // Таймаут НЕ повторяем сами: сервер мог ещё работать над запросом (он ждёт
  // окно лимита Groq), и повтор удвоил бы расход токенов и вызвал новые 429.
  if (timedOut || e?.name === "AbortError") return proxyError(TIMEOUT_ERR_MSG, false);
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
  chat(messages, { jsonMode = false, maxTokens = 800, temperature = 0.1, timeoutMs = 120000, signal } = {}) {
    return this._run(messages, { jsonMode, maxTokens, temperature, timeoutMs, stream: false, signal });
  }

  /**
   * Запас бесплатного ИИ на сегодня (сервер /api/limits): {main, fallback, cloudflare},
   * у моделей — {model, left, limit, synced}. null — сервер старый или недоступен
   * (тогда просто ничего не показываем и не мешаем анализу).
   */
  async limits({ timeoutMs = 5000 } = {}) {
    if (!this.configured) return null;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(`${this.baseUrl}/api/limits?model=${encodeURIComponent(this.model)}`, {
        headers: { "X-Sec-Token": this.token },
        signal: ac.signal,
      });
      if (!r.ok) return null;
      const d = await r.json();
      return d && d.main ? d : null;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(t);
    }
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
  chatStream(messages, { jsonMode = false, maxTokens = 800, temperature = 0.1, timeoutMs = 150000, signal } = {}, onDelta) {
    return this._run(messages, { jsonMode, maxTokens, temperature, timeoutMs, stream: true, onDelta, signal });
  }

  async _run(messages, opts) {
    if (!this.configured) throw new Error("Настройки прокси не заполнены (URL/секрет/модель).");
    return this.queue.push(async () => {
      // запрос отменённого анализа, дождавшийся своей очереди, не отправляем
      if (opts.signal?.aborted) throw normalizeError(null, false, true);
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
  async _once(messages, { jsonMode, maxTokens, temperature, timeoutMs, stream, onDelta, signal }, progress) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => {
      timedOut = true;
      controller.abort();
    };
    // отмена снаружи (анализ отменили) обрывает и сам запрос
    const onCancel = () => controller.abort();
    signal?.addEventListener("abort", onCancel, { once: true });
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
      let finished = false;
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
          if (payload === "[DONE]") finished = true;
          if (payload === "[DONE]") finished = true;
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
      // сервер всегда завершает поток меткой [DONE]; без неё ответ обрезан
      if (!finished) throw proxyError(CUT_MSG, false);
      return full;
    } catch (e) {
      throw normalizeError(e, timedOut, Boolean(signal?.aborted));
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onCancel);
    }
  }
}

// ---------------- Лимиты бесплатного Groq: виды ошибок и бюджет ----------------
// Общие для панели (анализ комментариев, «О видео») и фона (пересказ из
// всплывающего окна на ленте).
//
// Groq различает лимиты токенов, и лечатся они по-разному:
//  - ITPM / «input tokens» / 413 — запрос велик, помогает ДРОБЛЕНИЕ порции;
//  - OTPM / «output tokens» — велик ответ, дробление входа НЕ помогает
//    (наоборот, добавляет запросов и усугубляет OTPM), помогает только пауза.
const limitText = (e) => String(e?.message || e || "");

/** Сколько Groq велит ждать: «try again in 20.4s» / «try again in 1.5s». */
export function retryAfterMs(e, fallbackMs) {
  const m = limitText(e).match(/try again in\s*([\d.]+)\s*s/i);
  const fallback = fallbackMs || 6000;
  if (!m) return fallback;
  const sec = parseFloat(m[1]);
  if (!Number.isFinite(sec) || sec <= 0) return fallback;
  return Math.min(Math.max(2000, (sec + 1) * 1000), 120000);
}

export function isOutputLimitError(e) {
  return /OTPM|output tokens per minute|reduce max_tokens/i.test(limitText(e));
}

export function isInputLimitError(e) {
  if (isOutputLimitError(e)) return false;
  // \b вокруг ITPM обязателен: без него голое "ITPM" матчилось даже внутри
  // имён вида ITPM_BUDGET_PER_MIN, и любая обычная JS-ошибка про отсутствие
  // переменной превращалась в «превышен лимит входных токенов».
  return /\b413\b|\bITPM\b|input tokens per minute|Request too large|reduce your message size|context length|maximum context/i.test(limitText(e));
}

// Ошибка РАЗМЕРА запроса, а не минутного лимита: вход не влезает в контекст
// модели — ждать минутное окно бесполезно, надо уменьшить порцию.
export function isSizeLimitError(e) {
  if (isOutputLimitError(e)) return false;
  return /context length|maximum context|Request too large|reduce your message size|\b413\b/i.test(limitText(e));
}

/** Общий «Groq меня не пустил» без разбора вида лимита. */
export function isRateLimitError(e) {
  return /429|rate.?limit|tokens per minute|\bITPM\b|\bOTPM\b|Request too large/i.test(limitText(e));
}

/**
 * Скользящий минутный бюджет: учитываем и входные (ITPM), и выходные (OTPM) токены.
 * pace() ждёт, пока запрос влезет в окно, и возвращает «слот» выходных токенов;
 * settle() после ответа меняет резерв на фактический размер;
 * pushAfterOutputError() отмечает окно занятым после 429 по OTPM.
 */
export function createPacer({ itpm = 6000, otpm = 900, gapMs = 1500, maxOut = 800 } = {}) {
  const logIn = []; // { t: Date.now(), n: входные }
  const logOut = []; // { t: Date.now(), n: выходные }
  let lastAt = 0;

  // Журнал держим отсортированным и чистим по времени: запись после ошибки
  // OTPM добавляется «задним числом», и чистка с начала её пропускала.
  const prune = (log, now) => {
    for (let i = log.length - 1; i >= 0; i--) if (now - log[i].t >= 60000) log.splice(i, 1);
    log.sort((a, b) => a.t - b.t);
  };
  // Через сколько мс в скользящем окне освободится место под need токенов.
  const freeAt = (log, used, need, budget, now) => {
    if (used + need <= budget) return 0;
    let freed = 0;
    for (const x of log) {
      freed += x.n;
      if (used - freed + need <= budget) return Math.max(0, x.t + 60000 - now);
    }
    return log.length ? Math.max(0, log[log.length - 1].t + 60000 - now) : 0;
  };

  return {
    // onWait(сек) зовётся, когда приходится ждать окно дольше пары секунд —
    // чтобы пользователь видел причину паузы, а не «зависание».
    async pace(estIn, estOut = maxOut, onWait = null) {
      const outEst = Math.min(estOut, maxOut);
      for (;;) {
        const now = Date.now();
        prune(logIn, now);
        prune(logOut, now);
        const usedIn = logIn.reduce((a, x) => a + x.n, 0);
        const usedOut = logOut.reduce((a, x) => a + x.n, 0);
        if (usedIn + estIn <= itpm && usedOut + outEst <= otpm && now - lastAt >= gapMs) {
          const slot = { t: now, n: outEst };
          logIn.push({ t: now, n: estIn });
          logOut.push(slot);
          lastAt = now;
          return slot;
        }
        // ждём, пока освободится столько, сколько нужно именно этому запросу
        const w1 = freeAt(logIn, usedIn, estIn, itpm, now);
        const w2 = freeAt(logOut, usedOut, outEst, otpm, now);
        const waitMs = Math.max(1500, w1, w2, gapMs - (now - lastAt));
        if (onWait && waitMs > 2500) onWait(Math.ceil(waitMs / 1000));
        // короткими шагами, чтобы обратный отсчёт тикал
        await sleep(Math.min(waitMs, onWait ? 5000 : 60000));
      }
    },
    // Резерв делается «с запасом» до ответа; после — меняем на факт
    // (у бота reasoning_effort=none, скрытых токенов нет). ~2.5 символа на токен.
    settle(slot, text) {
      if (slot) slot.n = Math.max(40, Math.ceil(String(text || "").length / 2.5));
    },
    // После 429 по OTPM окно уже занято — без отметки бюджет через 1.5 с
    // двинул бы следующий запрос и упёрся в тот же лимит.
    pushAfterOutputError(waitMs) {
      const t = Date.now();
      logOut.push({ t: t - 60000 + waitMs, n: Math.max(maxOut, otpm) });
      lastAt = t;
    },
  };
}
