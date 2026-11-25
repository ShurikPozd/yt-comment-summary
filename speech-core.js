"use strict";

// «Поиск по речи» в открытом видео — логика без DOM. Её используют speech.js (окно
// поверх плеера на YouTube и во встроенном плеере «Моей библиотеки») и автопроверки
// (tests/run.mjs). Обычный скрипт, не модуль: всё лежит в globalThis.__ytcsSpeechCore.
// Слова, основы и ё/е — общие с поиском библиотеки (words-core.js, globalThis.__ytcsWords).
//
// Как ищет:
//   - регистр и ё/е не важны; каждое слово запроса — начало слова речи
//     («майнкр» найдёт «Майнкрафте»);
//   - простые русские окончания: «собака» найдёт «собаки», «собакой» (основа слова);
//   - несколько слов — сначала места, где они идут подряд (фраза может перейти
//     в следующую строку субтитров); нет таких — где все слова рядом (строка и следующая);
//   - одно место — одна строка субтитров; порядок — по времени.
(() => {
  if (globalThis.__ytcsSpeechCore) return;
  const W = globalThis.__ytcsWords;
  if (!W) return;

  const MIN_QUERY = 2; // букв в запросе — меньше не ищем (одна буква — почти каждое слово)
  const MAX_SNIPPET = 170; // знаков фразы в строке списка; длиннее — кусок вокруг найденного

  const int = (x) => (Number.isFinite(Number(x)) ? Math.floor(Number(x)) : NaN);

  // 75 → «1:15», 3725 → «1:02:05»
  function fmtTime(sec) {
    const s = Math.max(0, int(sec) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  // 1 место, 3 места, 11 мест
  function placesWord(n) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    const w = a > 10 && a < 20 ? "мест" : b === 1 ? "место" : b >= 2 && b <= 4 ? "места" : "мест";
    return `${n} ${w}`;
  }

  /**
   * Индекс по субтитрам: segments [{ t — секунда, text }] → строки и поток слов
   * { segs: [{ t, text }], toks: [{ w, s — основа, seg — номер строки, a, b — место в text }] }.
   */
  function buildIndex(segments) {
    const segs = [];
    for (const s of segments || []) {
      const text = String(s?.text || "")
        .replace(/\s+/g, " ")
        .trim();
      const t = Number(s?.t);
      if (text && Number.isFinite(t)) segs.push({ t: Math.max(0, t), text });
    }
    segs.sort((a, b) => a.t - b.t);
    const toks = [];
    const stems = new Map();
    segs.forEach((seg, i) => {
      for (const x of W.wordsAt(seg.text)) {
        let s = stems.get(x.w);
        if (s === undefined) stems.set(x.w, (s = W.stem(x.w)));
        toks.push({ w: x.w, s, seg: i, a: x.a, b: x.b });
      }
    });
    return { segs, toks };
  }

  // Слово запроса → проверка слова речи
  function matcher(q) {
    const qs = W.stem(q);
    return (tok) =>
      tok.w.startsWith(q) || // начало слова: «майнкр» → «майнкрафте»
      (q.length >= 4 && tok.s === qs) || // та же основа: «котов» → «кота»
      (qs.length >= 4 && qs !== q && tok.w.startsWith(qs)); // окончание другое: «собака» → «собаками»
  }

  /** Слова запроса (нормализованные); пусто — запрос слишком короткий. */
  function queryWords(query) {
    const words = W.tokens(query);
    // «a b» — одни однобуквенные слова нашли бы почти всё: нужно хоть одно слово от двух букв
    return words.join("").length >= MIN_QUERY && words.some((w) => w.length >= 2) ? words : [];
  }

  /**
   * Поиск. Возвращает null — запрос пустой или короче двух букв; иначе
   * { words, partial — фраза целиком не нашлась (показаны места, где все слова рядом),
   *   results: [{ t, seg, last — последняя строка места, marks: [номер слова в toks] }] } по времени.
   */
  function find(index, query) {
    const words = queryWords(query);
    if (!words.length || !index) return null;
    const ms = words.map(matcher);
    const { toks } = index;
    const results = [];
    const bySeg = new Map();
    const add = (marks) => {
      const seg = toks[marks[0]].seg;
      const last = toks[marks[marks.length - 1]].seg;
      const cur = bySeg.get(seg);
      if (cur) {
        for (const m of marks) if (!cur.marks.includes(m)) cur.marks.push(m);
        cur.last = Math.max(cur.last, last);
        return;
      }
      const r = { t: index.segs[seg].t, seg, last, marks: [...marks] };
      bySeg.set(seg, r);
      results.push(r);
    };
    // фраза: слова подряд (через границу строк тоже — речь не режется по строкам)
    for (let i = 0; i + ms.length <= toks.length; i++) {
      let k = 0;
      while (k < ms.length && ms[k](toks[i + k])) k++;
      if (k === ms.length) add(ms.map((_, j) => i + j));
    }
    let partial = false;
    if (!results.length && ms.length > 1) {
      // все слова в одной строке или в ней и следующей — в любом порядке
      partial = true;
      let start = 0;
      for (let seg = 0; seg < index.segs.length; seg++) {
        while (start < toks.length && toks[start].seg < seg) start++;
        const marks = [];
        let found = 0;
        const got = new Array(ms.length).fill(false);
        for (let i = start; i < toks.length && toks[i].seg <= seg + 1; i++) {
          let hit = false;
          ms.forEach((m, k) => {
            if (m(toks[i])) {
              hit = true;
              if (!got[k]) {
                got[k] = true;
                found++;
              }
            }
          });
          if (hit) marks.push(i);
        }
        // место начинается со строки, где есть хоть одно слово, и не повторяет прошлое место
        const prev = results[results.length - 1];
        if (found === ms.length && toks[marks[0]].seg === seg && !(prev && prev.last >= seg)) add(marks);
      }
    }
    results.sort((a, b) => a.t - b.t || a.seg - b.seg);
    return { words, partial, results };
  }

  /**
   * Текст места для списка: куски [{ t, hit }] — строки субтитров места (с первой
   * по last), найденные слова подсвечены; длинное — обрезано вокруг первого найденного
   * с «…» по краям (по границе слова).
   */
  function snippet(index, r, max = MAX_SNIPPET) {
    const { segs, toks } = index;
    let text = "";
    const hits = []; // [a, b] в склеенном тексте
    const offsets = new Map();
    for (let s = r.seg; s <= r.last; s++) {
      if (text) text += " ";
      offsets.set(s, text.length);
      text += segs[s].text;
    }
    for (const m of [...r.marks].sort((a, b) => a - b)) {
      const tok = toks[m];
      const off = offsets.get(tok.seg);
      if (off != null) hits.push([off + tok.a, off + tok.b]);
    }
    let from = 0;
    let to = text.length;
    if (text.length > max) {
      const first = hits[0] || [0, 0];
      from = Math.max(0, first[0] - Math.floor(max * 0.35));
      to = Math.min(text.length, from + max);
      from = Math.max(0, to - max);
      // по границе слова
      if (from > 0) {
        const sp = text.indexOf(" ", from);
        if (sp !== -1 && sp < first[0]) from = sp + 1;
      }
      if (to < text.length) {
        const sp = text.lastIndexOf(" ", to);
        const lastHit = hits.filter((h) => h[0] < to).pop();
        if (sp > from && (!lastHit || sp >= lastHit[1])) to = sp;
      }
    }
    const parts = [];
    if (from > 0) parts.push({ t: "…", hit: false });
    let pos = from;
    for (const [a, b] of hits) {
      if (b <= from || a >= to) continue;
      const aa = Math.max(a, from);
      const bb = Math.min(b, to);
      if (aa > pos) parts.push({ t: text.slice(pos, aa), hit: false });
      if (bb > aa) parts.push({ t: text.slice(aa, bb), hit: true });
      pos = Math.max(pos, bb);
    }
    if (pos < to) parts.push({ t: text.slice(pos, to), hit: false });
    if (to < text.length) parts.push({ t: "…", hit: false });
    return parts;
  }

  /** Какое место выбрать сразу: первое, что начинается не раньше now (с запасом 2 с). */
  function nearest(results, now) {
    if (!results?.length) return -1;
    const t = Number(now);
    if (!Number.isFinite(t)) return 0;
    const i = results.findIndex((r) => r.t >= t - 2);
    return i === -1 ? 0 : i;
  }

  globalThis.__ytcsSpeechCore = { MIN_QUERY, MAX_SNIPPET, fmtTime, placesWord, buildIndex, queryWords, find, snippet, nearest };
})();
