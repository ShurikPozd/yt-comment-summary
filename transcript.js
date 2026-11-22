"use strict";

// Расшифровка (субтитры) видео YouTube — без DOM и без PO-токена.
// Общий код: подключается контент-скриптом (страница видео и встроенный плеер
// библиотеки) и боковой панелью (запасной путь, если контент-скрипт вкладки
// устарел после обновления расширения). Только fetch и разбор JSON.
//
// Как это устроено (проверено на живом YouTube, ноябрь 2026):
//  - timedtext по baseUrl из captionTracks без PO-токена отдаёт пустой ответ;
//  - старый youtubei/v1/get_transcript отвечает 400 FAILED_PRECONDITION;
//  - панель «Расшифровка видео» самого YouTube теперь грузится через
//    youtubei/v1/get_panel (panelId PAmodern_transcript_view) — работает без
//    входа и без токенов, отдаёт всю расшифровку разом (2,5 ч — один ответ)
//    и главы автора. Параметр панели — protobuf {149: {1: videoId, 3: 2}}.
//  - Дорожку выбирает язык интерфейса hl: есть ручные субтитры на языке hl —
//    отдаст их (в т.ч. перевод), иначе — исходную дорожку видео (ручную, а
//    без неё автоматическую). Поэтому спрашиваем с редким языком: так
//    получаем субтитры на языке самого видео.
(() => {
  if (globalThis.__ytcsTranscript) return;

  const PANEL_ID = "PAmodern_transcript_view";
  const ORIGINAL_HL = "zu"; // редкий язык интерфейса → исходная дорожка видео
  const FALLBACK_VERSION = "2.20260910.00.00";

  function panelParams(videoId) {
    const id = String(videoId || "");
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error("bad videoId");
    const bytes = [0xaa, 0x09, 0x0f, 0x0a, 0x0b, ...[...id].map((c) => c.charCodeAt(0)), 0x18, 0x02];
    return btoa(String.fromCharCode(...bytes));
  }

  // «1:02:03» / «12:05» → секунды
  function hmsToSec(s) {
    const parts = String(s || "")
      .trim()
      .split(":")
      .map((x) => Number(x));
    if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
    return parts.reduce((a, n) => a * 60 + n, 0);
  }

  // Служебные пометки автосубтитров: «[музыка]», «[Music]», «♪♪♪» — смысла не несут,
  // а токены лимита съедают.
  const NOISE_RE = /^[\s♪♫]*(\[[^\]]{1,30}\]|\([^)]{1,30}\))?[\s♪♫]*$/;

  /** Разбор ответа get_panel: сегменты {t, text} по времени и главы {t, title}. */
  function parsePanel(json) {
    const segments = [];
    const chapters = [];
    const seen = new Set();
    const walk = (o, depth) => {
      if (!o || typeof o !== "object" || depth > 40) return;
      const m = o.macroMarkersPanelItemViewModel;
      if (m) {
        const start = m.onTap?.innertubeCommand?.watchEndpoint?.startTimeSeconds;
        const item = m.item || {};
        if (item.timelineChapterViewModel) {
          const title = String(item.timelineChapterViewModel.title || "").trim();
          if (title) chapters.push({ t: Number(start) || 0, title });
        }
        const tl = item.timelineItemViewModel;
        if (tl) {
          const texts = [];
          let t = Number.isFinite(Number(start)) ? Number(start) : null;
          for (const c of tl.contentItems || []) {
            const seg = c.transcriptSegmentViewModel;
            if (!seg) continue;
            const text = String(seg.simpleText || "").replace(/\s+/g, " ").trim();
            if (text) texts.push(text);
            if (t == null) t = hmsToSec(seg.timestamp);
          }
          if (t == null) t = hmsToSec(tl.timestamp);
          const text = texts.join(" ");
          const key = `${t}|${text}`;
          if (text && t != null && !seen.has(key)) {
            seen.add(key);
            segments.push({ t, text });
          }
        }
      }
      for (const k in o) {
        const v = o[k];
        if (v && typeof v === "object") walk(v, depth + 1);
      }
    };
    walk(json, 0);
    segments.sort((a, b) => a.t - b.t);
    chapters.sort((a, b) => a.t - b.t);
    return { segments, chapters };
  }

  async function postJson(url, body, { timeoutMs = 20000, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onCancel = () => controller.abort();
    signal?.addEventListener("abort", onCancel, { once: true });
    try {
      const resp = await fetch(url, {
        method: "POST",
        // без куки: панель расшифровки отдаётся и без входа, а запрос из
        // встроенного плеера и из панели расширения иначе стал бы сторонним
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        const e = new Error(`transcript:${resp.status}${data?.error?.status ? ":" + data.error.status : ""}`);
        e.status = resp.status;
        throw e;
      }
      return data;
    } catch (e) {
      if (e?.name === "AbortError") throw new Error(signal?.aborted ? "cancelled" : "transcript:timeout");
      if (/^transcript:/.test(String(e?.message))) throw e;
      throw new Error("transcript:network " + String(e?.message || e));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCancel);
    }
  }

  async function viaPanel(videoId, hl, opts) {
    const data = await postJson(
      "https://www.youtube.com/youtubei/v1/get_panel?prettyPrint=false",
      {
        context: { client: { clientName: "WEB", clientVersion: opts.clientVersion || FALLBACK_VERSION, hl } },
        panelId: PANEL_ID,
        params: panelParams(videoId),
      },
      opts
    );
    return parsePanel(data);
  }

  /**
   * Расшифровка видео: { segments: [{t, text}], chapters: [{t, title}], source }.
   * Пустой segments — у видео нет субтитров (ни ручных, ни автоматических).
   * Бросает при сетевой ошибке / отказе YouTube.
   */
  async function fetchTranscript(videoId, opts = {}) {
    let r = await viaPanel(videoId, ORIGINAL_HL, opts);
    // на всякий случай второй заход с обычным языком интерфейса
    if (!r.segments.length) r = await viaPanel(videoId, opts.hl || "ru", opts);
    const segments = r.segments.filter((s) => !NOISE_RE.test(s.text));
    return { segments, chapters: r.chapters, source: "panel", noiseOnly: Boolean(r.segments.length && !segments.length) };
  }

  globalThis.__ytcsTranscript = { fetchTranscript, parsePanel, panelParams, hmsToSec, NOISE_RE };
})();
