"use strict";

// «Двойные субтитры» — общая логика без DOM: её используют dualsubs.js (страница
// YouTube), настройки панели (список языков) и автопроверки (tests/run.mjs).
// Обычный скрипт, не модуль: всё лежит в globalThis.__ytcsDualCore.
//
// Откуда берутся строки (проверено на живом YouTube, ноябрь 2026):
//  - timedtext по baseUrl из captionTracks без PO-токена отдаёт пустой ответ;
//  - плеер YouTube сам запрашивает дорожку с токеном (&pot=…), когда включены
//    субтитры. Этот адрес годится для любой дорожки того же видео: меняем lang,
//    kind и tlang (автоперевод YouTube) — и берём оригинал и перевод в fmt=json3;
//  - у ручной дорожки перевод приходит теми же событиями (время совпадает),
//    у автоматической — своей нарезкой по словам, поэтому строки сводим по
//    пересечению во времени (pairCues).
(() => {
  // Популярные языки перевода: [код tlang, название]. Русский — по умолчанию.
  const LANGS = [
    ["ru", "Русский"],
    ["en", "Английский"],
    ["uk", "Украинский"],
    ["be", "Белорусский"],
    ["kk", "Казахский"],
    ["de", "Немецкий"],
    ["fr", "Французский"],
    ["es", "Испанский"],
    ["it", "Итальянский"],
    ["pt", "Португальский"],
    ["pl", "Польский"],
    ["cs", "Чешский"],
    ["tr", "Турецкий"],
    ["ar", "Арабский"],
    ["hi", "Хинди"],
    ["zh-Hans", "Китайский"],
    ["ja", "Японский"],
    ["ko", "Корейский"],
  ];
  const DEFAULT_LANG = "ru";

  // Служебные пометки: «[Music]», «[музыка]», «♪♪♪» — читать нечего.
  const NOISE_RE = /^[\s♪♫]*(\[[^\]]{1,30}\]|\([^)]{1,30}\))?[\s♪♫]*$/;

  /** Язык перевода из настроек: известный код или русский. */
  function langOf(v) {
    return LANGS.some(([c]) => c === v) ? v : DEFAULT_LANG;
  }

  /** «en-US» → «en», «zh-Hans» → «zh»; для сравнения «тот же язык». */
  function baseLang(code) {
    return String(code || "")
      .toLowerCase()
      .split(/[-_]/)[0];
  }

  /**
   * Что показывать: дорожка-оригинал и откуда взять перевод.
   * info — то, что отдаёт dualsubs-main.js: { tracks: [{lang, kind, vss, tr}],
   *   defaultIndex — дорожка по умолчанию для исходной звуковой дорожки,
   *   audioLang — язык исходного звука (только у видео с несколькими звуковыми
   *   дорожками, например с автодубляжом) }.
   * Ответ: { src: {lang, kind}, tr: {lang, kind, tlang} } или { skip: причина }:
   *   "none" — субтитров нет, "same" — видео уже на языке перевода,
   *   "notr" — перевести нельзя.
   */
  function pickTracks(info, target) {
    const tracks = (info?.tracks || []).filter((t) => t && t.lang);
    if (!tracks.length) return { skip: "none" };
    const want = baseLang(target);
    const asr = tracks.filter((t) => t.kind === "asr");
    const def = tracks[info.defaultIndex] || null;
    // язык речи: исходный звук → единственная автоматическая дорожка → по умолчанию
    let spoken = info.audioLang ? baseLang(info.audioLang) : "";
    if (!spoken && asr.length === 1) spoken = baseLang(asr[0].lang);
    if (!spoken && def && def.kind !== "asr") spoken = baseLang(def.lang);
    if (!spoken) spoken = baseLang((def || tracks[0]).lang);
    const sameSpoken = (t) => baseLang(t.lang) === spoken;
    const src = tracks.find((t) => t.kind !== "asr" && sameSpoken(t)) || tracks.find((t) => t.kind === "asr" && sameSpoken(t)) || def || tracks[0];
    if (baseLang(src.lang) === want || spoken === want) return { skip: "same" };
    // ручная дорожка на нужном языке лучше автоперевода (автоматическая — это
    // распознанный автодубляж, она про другой звук)
    const own = tracks.find((t) => t.kind !== "asr" && baseLang(t.lang) === want);
    const pick = (t) => ({ lang: t.lang, kind: t.kind === "asr" ? "asr" : "" });
    if (own) return { src: pick(src), tr: { ...pick(own), tlang: "" } };
    if (src.tr === false) return { skip: "notr" };
    return { src: pick(src), tr: { ...pick(src), tlang: target } };
  }

  /** Адрес плеера (с токеном) → адрес нужной дорожки в json3. */
  function trackUrl(captured, { lang, kind = "", tlang = "" }) {
    let u;
    try {
      u = new URL(captured, "https://www.youtube.com");
    } catch (e) {
      return "";
    }
    if (!/\/api\/timedtext$/.test(u.pathname)) return "";
    for (const k of ["lang", "kind", "tlang", "name", "fmt"]) u.searchParams.delete(k);
    u.searchParams.set("lang", lang);
    if (kind) u.searchParams.set("kind", kind);
    if (tlang) u.searchParams.set("tlang", tlang);
    u.searchParams.set("fmt", "json3");
    return u.href;
  }

  /** id видео из адреса timedtext (или ""). */
  function urlVideo(url) {
    try {
      const u = new URL(url, "https://www.youtube.com");
      return /\/api\/timedtext$/.test(u.pathname) ? u.searchParams.get("v") || "" : "";
    } catch (e) {
      return "";
    }
  }

  /** Текст события: куски склеены, переносы — пробелом. Точку в начале не трогаем:
   *  в автопереводе она — конец прошлой фразы (см. joinParts). */
  function glue(segs) {
    return (segs || [])
      .map((s) => String(s?.utf8 ?? ""))
      .join("")
      .replace(/[\s\u200b]+/g, " ")
      .trim();
  }

  /** Строка для показа: без знаков препинания в самом начале. */
  function clean(text) {
    return String(text || "")
      .replace(/^[\s.,;:!?…]+(?=\S)/, "")
      .trim();
  }

  /** Куски перевода подряд: «потемнела» + «. Мы вернулись» → «потемнела. Мы вернулись». */
  function joinParts(parts) {
    return clean(parts.join(" ").replace(/\s+([.,;:!?…])/g, "$1"));
  }

  /**
   * json3 → реплики [{s, e, text}] в мс, по времени, без пустых и служебных.
   * Автоматические строки «наезжают» друг на друга (два ряда бегущей строки) —
   * каждую показываем до начала следующей.
   */
  function parseJson3(json) {
    const out = [];
    for (const ev of json?.events || []) {
      if (!ev || !Array.isArray(ev.segs) || ev.aAppend) continue;
      const s = Number(ev.tStartMs);
      const d = Number(ev.dDurationMs);
      if (!Number.isFinite(s) || !(d > 0)) continue;
      const text = glue(ev.segs);
      if (!clean(text) || NOISE_RE.test(clean(text))) continue;
      out.push({ s, e: s + d, text });
    }
    out.sort((a, b) => a.s - b.s);
    // одинаковое начало — одна реплика (склеиваем)
    const merged = [];
    for (const c of out) {
      const last = merged[merged.length - 1];
      if (last && last.s === c.s) {
        if (!last.text.includes(c.text)) last.text += " " + c.text;
        last.e = Math.max(last.e, c.e);
      } else merged.push({ ...c });
    }
    for (let i = 0; i < merged.length - 1; i++) merged[i].e = Math.min(merged[i].e, merged[i + 1].s);
    return merged;
  }

  const overlap = (a, b) => Math.max(0, Math.min(a.e, b.e) - Math.max(a.s, b.s));

  /**
   * Сводим оригинал с переводом: каждая строка перевода — к той реплике
   * оригинала, с которой больше всего совпадает по времени (нарезки могут не
   * совпадать — тогда к реплике приклеится несколько кусков). Реплике без
   * своего куска — перевод, который звучит в её середине.
   * Ответ: [{s, e, text, tr}].
   */
  function pairCues(orig, trans) {
    const res = (orig || []).map((c) => ({ s: c.s, e: c.e, text: clean(c.text), tr: "" }));
    const parts = res.map(() => []);
    const tr = trans || [];
    let i0 = 0;
    for (const t of tr) {
      while (i0 < res.length && res[i0].e <= t.s) i0++;
      let best = -1;
      let bestOv = 0;
      for (let i = i0; i < res.length && res[i].s < t.e; i++) {
        const ov = overlap(res[i], t);
        if (ov > bestOv) {
          bestOv = ov;
          best = i;
        }
      }
      if (best >= 0) parts[best].push(t.text);
    }
    for (let i = 0; i < res.length; i++) {
      if (parts[i].length) res[i].tr = joinParts(parts[i]);
      else {
        const mid = (res[i].s + res[i].e) / 2;
        res[i].tr = clean(tr[indexAt(tr, mid)]?.text);
      }
    }
    return res;
  }

  /** Номер реплики, которая идёт в момент ms (или -1). Двоичный поиск. */
  function indexAt(cues, ms) {
    let lo = 0;
    let hi = (cues?.length || 0) - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].s <= ms) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found >= 0 && ms < cues[found].e ? found : -1;
  }

  /** Слова строки для показа: [{w, sp}] — слово и пробел после него. */
  function words(text) {
    return String(text || "")
      .split(/(\s+)/)
      .reduce((acc, part, i) => {
        if (i % 2 === 0) {
          if (part) acc.push({ w: part, sp: "" });
        } else if (acc.length) acc[acc.length - 1].sp = " ";
        return acc;
      }, []);
  }

  /** Кегль строки оригинала по высоте плеера: крупно, но без перебора (мини-плеер — 14 px). */
  function fontPx(playerH) {
    const h = Number(playerH) || 0;
    return Math.round(Math.min(40, Math.max(14, h * 0.042)));
  }

  globalThis.__ytcsDualCore = { LANGS, DEFAULT_LANG, NOISE_RE, langOf, baseLang, pickTracks, trackUrl, urlVideo, glue, clean, joinParts, parseJson3, pairCues, indexAt, words, fontPx };
})();
