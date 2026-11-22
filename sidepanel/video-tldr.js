// Вкладка «О видео»: краткий пересказ самого видео по его субтитрам.
//
// Расшифровку отдаёт контент-скрипт вкладки (yt:transcript, см. transcript.js
// и content.js); если он не отвечает (вкладку открыли до обновления
// расширения) — тот же запрос делаем прямо из панели.
// Пересказ — через бота (GroqProxy) с общим с анализом комментариев
// бюджетом лимитов Groq: короткая расшифровка — один запрос, длинная —
// конспекты частей (map) и итог по ним (reduce). Итог — обычный текст:
// абзац «о чём видео» и строки «м:сс — пункт», показываются по мере написания.
// Готовый пересказ кешируется по videoId в chrome.storage.local.

import { extractJson, sleep } from "../groq.js";
import {
  TLDR_PART_SYSTEM,
  tldrPartUser,
  TLDR_DIRECT_SYSTEM,
  TLDR_FINAL_SYSTEM,
  tldrDirectUser,
  tldrFinalUser,
} from "../prompts.js";
import { fmtTime } from "./insights.js";
import { icon } from "./icons.js";

const CACHE_PREFIX = "tldr:";
const CACHE_INDEX = "tldr:index";
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
const tokensOf = (s) => {
  const t = String(s || "");
  const cyr = (t.match(/[Ѐ-ӿ]/g) || []).length;
  return Math.ceil(cyr / 3 + (t.length - cyr) / 4);
};
const estimateTokens = (sys, user) => tokensOf(sys) + tokensOf(user) + 120;

let D = null; // зависимости из sidepanel.js (initVideoTldr)
const runs = new Map(); // videoId → { ac, phase, frac, live, startedAt }
const errors = new Map(); // videoId → { kind, text }
let viewVid = null;
let entry = null; // пересказ из кеша для viewVid
let loadSeq = 0;

const $ = (id) => document.getElementById(id);

function hmsToSec(s) {
  const parts = String(s || "")
    .trim()
    .split(":")
    .map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((a, n) => a * 60 + n, 0);
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ---------------- Кеш ----------------

async function loadCache(vid) {
  try {
    const k = CACHE_PREFIX + vid;
    return (await chrome.storage.local.get(k))[k] || null;
  } catch (e) {
    return null;
  }
}

async function saveCache(vid, data) {
  try {
    const idx = (await chrome.storage.local.get(CACHE_INDEX))[CACHE_INDEX] || [];
    const next = [vid, ...idx.filter((x) => x !== vid)];
    const drop = next.splice(CACHE_MAX);
    await chrome.storage.local.set({ [CACHE_PREFIX + vid]: data, [CACHE_INDEX]: next });
    if (drop.length) await chrome.storage.local.remove(drop.map((x) => CACHE_PREFIX + x));
  } catch (e) {
    console.warn("пересказ не сохранился в кеш:", e);
  }
}

// ---------------- Расшифровка ----------------

async function getTranscript(vid, signal) {
  let tabErr = null;
  try {
    const tab = await D.findActiveVideoTab();
    if (tab?.id) {
      const r = await chrome.tabs.sendMessage(tab.id, { type: "yt:transcript", videoId: vid });
      if (r?.ok) return r;
      if (r?.error && r.error !== "other-video") tabErr = new Error(r.error);
    }
  } catch (e) {
    tabErr = e; // контент-скрипт не ответил — устарел или вкладка закрыта
  }
  if (signal.aborted) throw cancelledError();
  // запасной путь: тот же запрос к YouTube прямо из панели
  const api = globalThis.__ytcsTranscript;
  if (!api) throw tabErr || new Error("transcript:unavailable");
  return api.fetchTranscript(vid, { signal });
}

function buildBlocks(segments) {
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

function splitParts(lines) {
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

// ---------------- Запросы к модели ----------------

function cancelledError() {
  const e = new Error("Запрос отменён");
  e.cancelled = true;
  return e;
}

// Один запрос с ожиданием окна лимита и повтором на 429 (как у анализа комментариев).
async function ask(messages, { estIn, estOut, maxTokens, stream = false, onDelta, signal, note }) {
  for (let tries = 0; ; tries++) {
    const slot = await D.paceRequest(estIn, estOut, (sec) => note(`Жду окно бесплатного лимита Groq: ~${sec} с…`));
    if (signal.aborted) throw cancelledError();
    try {
      const out = stream
        ? await D.proxy.chatStream(messages, { maxTokens, timeoutMs: 330000, signal }, onDelta)
        : await D.proxy.chat(messages, { jsonMode: true, maxTokens, timeoutMs: 330000, signal });
      D.settleOutput(slot, out);
      return out;
    } catch (e) {
      if (e?.cancelled || signal.aborted) throw cancelledError();
      if (tries >= 3 || D.isSizeLimitError(e)) throw e;
      if (D.isOutputLimitError(e)) {
        const w = Math.max(30000, D.retryAfterMs(e, 30000));
        note(`Groq: лимит выходных токенов — жду ~${Math.round(w / 1000)} с и повторю…`);
        D.pushBudgetAfterOutputError(w);
        await sleep(w);
        continue;
      }
      if (D.isRateLimitError(e)) {
        const w = Math.max(20000, D.retryAfterMs(e, 30000));
        note(`Groq: лимит запросов — жду ~${Math.round(w / 1000)} с и повторю…`);
        await sleep(w);
        continue;
      }
      throw e;
    }
  }
}

async function summarize(vid) {
  if (runs.has(vid)) return;
  if (!D.proxy.configured) {
    D.showToast("Заполните настройки сервера с ИИ (адрес и секрет).");
    D.setTab("settings");
    return;
  }
  const st = D.getState();
  const meta = st.videoId === vid ? st.meta : null;
  const title = meta?.title || "";
  const duration = Number(meta?.duration) || 0;
  const lang = st.settings?.lang || "ru";
  const run = { ac: new AbortController(), phase: "Загружаю субтитры видео…", frac: 0.04, live: "", startedAt: Date.now() };
  const signal = run.ac.signal;
  runs.set(vid, run);
  errors.delete(vid);
  const update = (patch) => {
    Object.assign(run, patch);
    if (viewVid === vid) paintRun(vid);
  };
  // подпись этапа («Часть 2 из 4.») остаётся и в тексте ожидания лимита
  let stage = "";
  const note = (text) => update({ phase: stage ? `${stage} ${text}` : text });
  paint();
  try {
    const tr = await getTranscript(vid, signal);
    if (signal.aborted) return;
    const segments = tr?.segments || [];
    if (!segments.length) {
      errors.set(vid, { kind: "nosubs", music: Boolean(tr?.noiseOnly) });
      return;
    }
    let blocks = buildBlocks(segments);
    const full = blocks.map(blockLine).join("\n");
    const fullTokens = tokensOf(full);
    let ratio = 1;
    if (fullTokens > TOTAL_MAX_TOKENS) {
      ratio = TOTAL_MAX_TOKENS / fullTokens;
      blocks = thinBlocks(blocks, ratio);
    }
    const lines = blocks.map(blockLine);
    const chapters = chaptersText(tr.chapters);
    const durGuess = duration || segments[segments.length - 1].t;
    const tokens = tokensOf(lines.join("\n"));
    let text = "";
    const onDelta = (full) => update({ live: full });

    if (tokens <= DIRECT_MAX_TOKENS) {
      update({ phase: "Пишу пересказ…", frac: 0.35 });
      const user = tldrDirectUser({ lines: lines.join("\n"), lang, title, duration: fmtTime(durGuess), chapters });
      text = await ask(
        [
          { role: "system", content: TLDR_DIRECT_SYSTEM },
          { role: "user", content: user },
        ],
        { estIn: estimateTokens(TLDR_DIRECT_SYSTEM, user), estOut: FINAL_OUT_TOKENS, maxTokens: 900, stream: true, onDelta, signal, note }
      );
    } else {
      const parts = splitParts(lines);
      const digests = [];
      let failed = 0;
      let lastErr = null;
      for (let i = 0; i < parts.length; i++) {
        if (signal.aborted) return;
        const from = parts[i][0].match(/^\[([\d:]+)\]/)?.[1] || "0:00";
        stage = `Часть ${i + 1} из ${parts.length}.`;
        update({ phase: `Читаю субтитры: часть ${i + 1} из ${parts.length}…`, frac: 0.06 + (0.74 * i) / parts.length });
        const user = tldrPartUser({ lines: parts[i].join("\n"), part: i + 1, total: parts.length, lang, title });
        try {
          const raw = await ask(
            [
              { role: "system", content: TLDR_PART_SYSTEM },
              { role: "user", content: user },
            ],
            { estIn: estimateTokens(TLDR_PART_SYSTEM, user), estOut: PART_OUT_TOKENS, maxTokens: 700, signal, note }
          );
          const data = extractJson(raw);
          if (!data) throw new Error("Модель вернула не JSON");
          const p = (Array.isArray(data.p) ? data.p : [])
            .map((x) => ({ t: String(x?.t || "").trim(), x: String(x?.x || "").trim() }))
            .filter((x) => hmsToSec(x.t) != null && x.x)
            .slice(0, 5);
          digests.push({ from, s: String(data.s || "").trim(), p });
        } catch (e) {
          if (e?.cancelled || signal.aborted) return;
          if (D.isSizeLimitError(e)) throw e;
          failed++;
          lastErr = e;
          console.warn("часть пересказа не удалась:", e);
        }
      }
      if (!digests.length) throw lastErr || new Error("Не удалось разобрать субтитры");
      if (signal.aborted) return;
      run.failed = failed;
      stage = "Остался итог.";
      update({ phase: "Пишу пересказ…", frac: 0.85 });
      const user = tldrFinalUser({ parts: digests, lang, title, duration: fmtTime(durGuess), chapters });
      text = await ask(
        [
          { role: "system", content: TLDR_FINAL_SYSTEM },
          { role: "user", content: user },
        ],
        { estIn: estimateTokens(TLDR_FINAL_SYSTEM, user), estOut: FINAL_OUT_TOKENS, maxTokens: 900, stream: true, onDelta, signal, note }
      );
    }
    if (signal.aborted) return;
    const parsed = parseTldr(text, durGuess);
    if (!parsed.about && !parsed.points.length) throw new Error("Модель вернула пустой пересказ");
    const data = {
      about: parsed.about,
      points: parsed.points,
      title,
      lang,
      updatedAt: Date.now(),
      source: tr.source || "panel",
      segments: segments.length,
      trimmed: ratio < 1 ? Math.round(ratio * 100) / 100 : 0,
      partsFailed: run.failed || 0,
      tookMs: Date.now() - run.startedAt,
    };
    await saveCache(vid, data);
    if (viewVid === vid) entry = data;
    else D.showToast(`Пересказ «${title.length > 40 ? title.slice(0, 38) + "…" : title || "видео"}» готов`);
  } catch (e) {
    if (e?.cancelled || signal.aborted) return;
    const s = String(e?.message || e);
    if (/^transcript:/.test(s)) {
      errors.set(vid, { kind: "transcript", text: s });
    } else {
      errors.set(vid, { kind: "ai", text: D.friendlyError(e) });
    }
  } finally {
    if (runs.get(vid) === run) runs.delete(vid);
    if (viewVid === vid) paint();
  }
}

function cancel(vid) {
  const run = runs.get(vid);
  if (!run) return;
  run.ac.abort();
  runs.delete(vid);
  paint();
}

// ---------------- Отрисовка ----------------

function emptyBlock(iconName, title, text, extra = "") {
  return `<div class="view-empty"><div class="empty-icon small">${icon(iconName, { size: 22 })}</div>
    <div class="empty-title">${D.esc(title)}</div><div class="empty-text">${D.esc(text)}</div>${extra}</div>`;
}

function pointRow(p) {
  return `<button class="moment-row tldr-row" data-tldr-t="${p.t}" title="Перемотать на ${fmtTime(p.t)}">
    <span class="tc tc-big">${icon("play", { size: 11 })}${fmtTime(p.t)}</span>
    <span class="tldr-row-text">${D.esc(p.x)}</span>
  </button>`;
}

function aboutCard(text, { live = false } = {}) {
  const body = text ? D.esc(text) : '<div class="skeleton"><i></i><i></i><i></i></div>';
  return `<div class="summary-text tldr-about${live ? " live" : ""}"><div class="summary-title">${icon("subtitles", { size: 14 })}О чём видео</div>${body}</div>`;
}

function pointsBlock(points) {
  if (!points.length) return "";
  // ширина под самый длинный таймкод: иконка, зазор и отступы ≈ 38px + цифры
  const longest = Math.max(...points.map((p) => fmtTime(p.t).length));
  return `<div class="subhead">Главное по ходу видео <span class="hint">нажмите — перемотка</span></div>
    <div class="tldr-points" style="--tc-w: calc(38px + ${longest}ch)">${points.map(pointRow).join("")}</div>`;
}

function fmtDate(ts) {
  try {
    return new Date(ts).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return "";
  }
}

function resultHtml(e) {
  const notes = [`Пересказ от ${fmtDate(e.updatedAt)} · по субтитрам видео`];
  if (e.trimmed) notes.push(`видео длинное — по сокращённой расшифровке (~${Math.round(e.trimmed * 100)}%)`);
  if (e.partsFailed) notes.push(`${e.partsFailed} ${plural(e.partsFailed, "часть не разобралась", "части не разобрались", "частей не разобрались")}`);
  return `<div class="history-note">${D.esc(notes.join(" · "))}</div>
    ${aboutCard(e.about || "")}
    ${pointsBlock(e.points || [])}
    <div class="summary-actions tldr-actions">
      <button class="ghost copy-btn" data-tldr="copy" title="Скопировать пересказ текстом">${icon("copy", { size: 14 })}Скопировать</button>
      <button class="ghost copy-btn" data-tldr="redo" title="Пересказать заново (потратит лимит Groq)">${icon("refresh", { size: 14 })}Пересказать заново</button>
    </div>`;
}

function runHtml(vid, run) {
  const parsed = parseTldr(run.live || "");
  return `<div class="tldr-run" data-run="${D.esc(vid)}">
      <div class="placeholder tldr-phase">${D.esc(run.phase)}</div>
      <div class="progress tldr-progress"><i style="width:${Math.round(run.frac * 100)}%"></i></div>
      <div class="analyze-actions tldr-cancel-row"><button class="link-btn" data-tldr="cancel">Отменить</button></div>
      <div class="tldr-live">${aboutCard(parsed.about, { live: true })}${pointsBlock(parsed.points)}</div>
    </div>`;
}

function errorHtml(err) {
  if (err.kind === "nosubs") {
    return emptyBlock(
      "subtitles",
      "У этого видео нет субтитров",
      err.music
        ? "В субтитрах только пометки вроде «[музыка]» — речи, которую можно пересказать, в видео нет."
        : "Пересказ строится по субтитрам, а у видео их нет — ни авторских, ни автоматических. Пересказать не из чего.",
      `<button class="ghost empty-cta wide" data-tldr="go">${icon("refresh", { size: 14 })}Проверить ещё раз</button>`
    );
  }
  const head = err.kind === "transcript" ? "Не получилось загрузить субтитры" : "Не получилось пересказать видео";
  const text =
    err.kind === "transcript"
      ? /timeout|network/.test(err.text)
        ? "YouTube не ответил — проверьте интернет и попробуйте ещё раз."
        : "YouTube не отдал субтитры. Обновите вкладку с видео (F5) и попробуйте ещё раз."
      : err.text;
  return `<div class="error-box"><b>${D.esc(head)}.</b><br>${D.esc(text)}</div>
    <button class="primary empty-cta wide" data-tldr="go">Попробовать ещё раз</button>`;
}

function ctaHtml() {
  if (!D.proxy.configured) {
    return emptyBlock(
      "subtitles",
      "Подключите сервер с ИИ",
      "Для пересказа нужен адрес сервера и секрет — они в настройках.",
      `<button class="primary empty-cta wide" data-tldr="settings">Открыть настройки</button>`
    );
  }
  return emptyBlock(
    "subtitles",
    "О чём это видео",
    "ИИ прочитает субтитры и коротко перескажет: суть в нескольких предложениях и главные пункты с таймкодами. Бесплатно; длинные видео — несколько минут.",
    `<button class="primary empty-cta wide" data-tldr="go">Пересказать видео</button>`
  );
}

function paint() {
  const box = $("tldr");
  if (!box || !viewVid) return;
  const run = runs.get(viewVid);
  let html;
  if (run) html = runHtml(viewVid, run);
  else if (errors.has(viewVid)) {
    // «Пересказать заново» не удалось — прежний пересказ остаётся под ошибкой
    const err = errors.get(viewVid);
    html = errorHtml(err) + (entry && err.kind !== "nosubs" ? `<div class="tldr-prev">${resultHtml(entry)}</div>` : "");
  } else if (entry) html = resultHtml(entry);
  else html = ctaHtml();
  box.innerHTML = html;
}

// Во время работы обновляем только изменившиеся части — без мигания и сброса анимаций.
function paintRun(vid) {
  const box = $("tldr");
  const run = runs.get(vid);
  const root = box?.querySelector(".tldr-run");
  if (!run || !root || root.dataset.run !== vid) return paint();
  root.querySelector(".tldr-phase").textContent = run.phase;
  root.querySelector(".tldr-progress i").style.width = `${Math.round(run.frac * 100)}%`;
  if (run.live) {
    const parsed = parseTldr(run.live);
    root.querySelector(".tldr-live").innerHTML = aboutCard(parsed.about, { live: true }) + pointsBlock(parsed.points);
  }
}

function copyText(e) {
  const out = [`О чём видео${e.title ? ` «${e.title}»` : ""}`, "", e.about || ""];
  if (e.points?.length) {
    out.push("", "Главное:");
    for (const p of e.points) out.push(`${fmtTime(p.t)} — ${p.x}`);
  }
  if (viewVid) out.push("", `https://youtu.be/${viewVid}`);
  return out.join("\n").trim();
}

// ---------------- Подключение к панели ----------------

/** Вызывается при показе вкладки и при смене видео. */
export async function renderVideoTldr() {
  if (!D) return;
  const vid = D.getState().videoId;
  if (!vid) return;
  if (vid !== viewVid) {
    const seq = ++loadSeq;
    viewVid = vid;
    entry = null;
    paint(); // сразу пустая карточка, без пересказа прошлого видео
    const e = await loadCache(vid);
    if (seq !== loadSeq || viewVid !== vid) return;
    entry = e;
  }
  paint();
}

export function initVideoTldr(deps) {
  D = deps;
  const box = $("tldr");
  if (!box) return;
  box.addEventListener("click", async (ev) => {
    const row = ev.target.closest("[data-tldr-t]");
    if (row) {
      D.seekTo(Number(row.dataset.tldrT));
      return;
    }
    const act = ev.target.closest("[data-tldr]")?.dataset.tldr;
    if (!act || !viewVid) return;
    if (act === "go") void summarize(viewVid);
    else if (act === "redo") void summarize(viewVid);
    else if (act === "cancel") cancel(viewVid);
    else if (act === "settings") D.setTab("settings");
    else if (act === "copy" && entry) {
      try {
        await navigator.clipboard.writeText(copyText(entry));
        D.showToast("Пересказ скопирован");
      } catch (e) {
        D.showToast("Не получилось скопировать");
      }
    }
  });
}
