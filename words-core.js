"use strict";

// Слова для поиска — общая логика без DOM: нормализация (регистр, ё/е, диакритика),
// разбиение на слова, основа слова (русский — Портер/Snowball, английский — простые
// окончания) и подсветка найденного в исходном тексте.
// Её используют поиск «Моей библиотеки» (library/search.js — по названиям, по
// субтитрам), «Поиск по речи» в плеере (speech-core.js) и автопроверки (tests/run.mjs).
// Обычный скрипт, не модуль: контент-скрипты модулями не бывают — всё лежит в
// globalThis.__ytcsWords (модули подключают файл ради этого: import "../words-core.js").
(() => {
  if (globalThis.__ytcsWords) return;

  // Один символ → нормализованный (строчная, ё→е, без ударений и диакритики)
  const normCache = new Map();
  function normChar(c) {
    let n = normCache.get(c);
    if (n !== undefined) return n;
    n = c.toLowerCase();
    if (n === "ё") n = "е";
    // «й» оставляем как есть (NFKD разобрал бы её на «и» и значок)
    else if (n !== "й") n = n.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    normCache.set(c, n);
    return n;
  }

  function norm(s) {
    let out = "";
    for (const c of String(s || "")) out += normChar(c);
    return out;
  }

  const WORD = /[\p{L}\p{N}]+/gu;
  const tokens = (s) => norm(s).match(WORD) || [];

  // Слова текста с местом в исходной строке: [{ w — нормализованное, a, b — начало и конец в src }]
  function wordsAt(text) {
    const src = String(text || "");
    let normed = "";
    const map = []; // позиция в normed → позиция в src
    let i = 0;
    for (const c of src) {
      const n = normChar(c);
      for (let k = 0; k < n.length; k++) map.push(i);
      normed += n;
      i += c.length;
    }
    map.push(src.length);
    const out = [];
    for (const m of normed.matchAll(WORD)) out.push({ w: m[0], a: map[m.index], b: map[m.index + m[0].length] });
    return out;
  }

  // Основа слова — чтобы «котики» нашли «котик» и «котов», а «cooking» — «cook».
  // Русский — алгоритм Портера (Snowball), английский — простое отсечение окончаний.
  const RV = /^(.*?[аеиоуыэюя])(.*)$/;
  const PERFECTIVE = /((ив|ивши|ившись|ыв|ывши|ывшись)|((?<=[ая])(в|вши|вшись)))$/;
  const REFLEXIVE = /(с[яь])$/;
  const ADJECTIVE = /(ее|ие|ые|ое|ими|ыми|ей|ий|ый|ой|ем|им|ым|ом|его|ого|ему|ому|их|ых|ую|юю|ая|яя|ою|ею)$/;
  const PARTICIPLE = /((ивш|ывш|ующ)|((?<=[ая])(ем|нн|вш|ющ|щ)))$/;
  const VERB = /((ила|ыла|ена|ейте|уйте|ите|или|ыли|ей|уй|ил|ыл|им|ым|ен|ило|ыло|ено|ят|ует|уют|ит|ыт|ены|ить|ыть|ишь|ую|ю)|((?<=[ая])(ла|на|ете|йте|ли|й|л|ем|н|ло|но|ет|ют|ны|ть|ешь|нно)))$/;
  const NOUN = /(а|ев|ов|ие|ье|е|иями|ями|ами|еи|ии|и|ией|ей|ой|ий|й|иям|ям|ием|ем|ам|ом|о|у|ах|иях|ях|ы|ь|ию|ью|ю|ия|ья|я)$/;
  const DERIVATIONAL = /[^аеиоуыэюя][аеиоуыэюя]+[^аеиоуыэюя]+[аеиоуыэюя].*ость?$/;

  function stem(word) {
    if (word.length < 4) return word;
    if (/^[a-z]+$/.test(word)) {
      if (/ies$/.test(word)) return word.slice(0, -3) + "y";
      const w = word.replace(/(ing|ed|es|s)$/, (m, _e, i) => (m === "s" && /s$/.test(word.slice(0, i)) ? m : ""));
      return w.length >= 3 ? w : word;
    }
    const m = RV.exec(word);
    if (!m || !/^[а-яе]+$/.test(word)) return word;
    const pre = m[1];
    let rv = m[2];
    let t = rv.replace(PERFECTIVE, "");
    if (t === rv) {
      rv = rv.replace(REFLEXIVE, "");
      t = rv.replace(ADJECTIVE, "");
      if (t !== rv) rv = t.replace(PARTICIPLE, "");
      else {
        t = rv.replace(VERB, "");
        rv = t === rv ? rv.replace(NOUN, "") : t;
      }
    } else rv = t;
    rv = rv.replace(/и$/, "");
    if (DERIVATIONAL.test(rv)) rv = rv.replace(/ость?$/, "");
    t = rv.replace(/ь$/, "");
    rv = t !== rv ? t : rv.replace(/ейше?$/, "").replace(/нн$/, "н");
    return pre + rv;
  }

  // Подсветка: куски исходного текста [{ t, hit }] по совпавшим словам (hits — Set нормализованных)
  function highlight(text, hits) {
    const src = String(text || "");
    if (!hits?.size) return [{ t: src, hit: false }];
    const out = [];
    let last = 0;
    for (const { w, a, b } of wordsAt(src)) {
      if (!hits.has(w)) continue;
      if (a > last) out.push({ t: src.slice(last, a), hit: false });
      out.push({ t: src.slice(a, b), hit: true });
      last = b;
    }
    if (last < src.length) out.push({ t: src.slice(last), hit: false });
    return out;
  }

  globalThis.__ytcsWords = { normChar, norm, tokens, wordsAt, stem, highlight, WORD };
})();
