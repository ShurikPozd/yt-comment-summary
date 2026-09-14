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
  text = text.replace(/`([^`]*)`/g, "$1");
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

  /**
   * Один вызов прокси. Возвращает строку content; при ошибке бросает.
   */
  chat(messages, { jsonMode = false, maxTokens = 800, temperature = 0.1, timeoutMs = 120000 } = {}) {
    if (!this.configured) throw new Error("Настройки прокси не заполнены (URL/секрет/модель).");
    return this.queue.push(async () => {
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          let resp;
          try {
            resp = await fetch(this.endpoint(), {
              method: "POST",
              headers: this._headers(),
              signal: controller.signal,
              body: JSON.stringify({
                messages,
                model: this.model,
                json_mode: jsonMode,
                max_tokens: Math.max(1, Math.min(maxTokens, 2000)),
                temperature,
              }),
            });
          } finally {
            clearTimeout(timer);
          }
          if (resp.status === 403) {
            throw new Error("Отказано прокси (403): проверьте секрет / доступ к серверу.");
          }
          if (resp.status === 400 || resp.status === 413) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.error || "Прокси отклонил запрос (" + resp.status + ").");
          }
          if (resp.status === 502) {
            const data = await resp.json().catch(() => ({}));
            const reason = data.detail ? ` (${data.detail})` : "";
            throw new Error((data.error || "LLM не ответил (502)") + reason);
          }
          if (!resp.ok) throw new Error("Прокси ответил " + resp.status);
          const data = await resp.json();
          if (!data || typeof data.content !== "string") throw new Error("Пустой ответ прокси.");
          return data.content;
        } catch (e) {
          lastErr = /Failed to fetch|fetch failed/i.test(String(e?.message || e))
            ? new Error(
                "Сервер недоступен (сеть): возможно Render спит (холодный старт ~50 с) или нет связи. Проверь «Проверить связь» и перепробуй."
              )
            : e;
          await sleep(3000 * (attempt + 1));
        }
      }
      throw lastErr;
    });
  }

  /** Проверка настроек: тривиальный вызов. */
  async test() {
    const out = await this.chat(
      [{ role: "user", content: "Ответь одним словом: ok" }],
      { maxTokens: 6, timeoutMs: 40000 }
    );
    return Boolean(out && out.trim());
  }
}