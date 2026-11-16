// Локальная аналитика комментариев: всё здесь считается в браузере, без
// запросов к Groq. Бесплатный тариф делит лимиты токенов с ботом, поэтому
// всё, что можно посчитать без ИИ, считаем тут — мгновенно и даром.
// Модуль без chrome.* и DOM: его можно проверять в node.

// Таймкод в тексте: 1:23, 12:05, 1:02:33. Не цепляем куски длинных чисел
// и времени вида 1:23:45:67.
const TIMECODE_RE = /(?<![\d:])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?![\d:])/g;

/** Разбивает текст на куски: строки и таймкоды {t, label}. */
export function splitTimecodes(text, maxSec = Infinity) {
  const src = String(text ?? "");
  const out = [];
  let last = 0;
  for (const m of src.matchAll(TIMECODE_RE)) {
    const h = m[1] ? Number(m[1]) : 0;
    const min = Number(m[2]);
    const sec = Number(m[3]);
    if (sec > 59 || (m[1] && min > 59)) continue;
    const t = h * 3600 + min * 60 + sec;
    if (t > maxSec) continue;
    if (m.index > last) out.push(src.slice(last, m.index));
    out.push({ t, label: m[0] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

export function timecodesOf(text, maxSec = Infinity) {
  return splitTimecodes(text, maxSec)
    .filter((p) => typeof p === "object")
    .map((p) => p.t);
}

export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// \b в JS-регулярках понимает только латиницу, поэтому границу слова задаём явно.
const QUESTION_START =
  /^(как|почему|зачем|что|кто|где|когда|сколько|какой|какая|какие|каким|чем|откуда|куда|можно ли|а есть|подскажите|how|why|what|who|where|when|which|is there|does|can|could|anyone)(?=[\s,.!:;]|$)/i;

/** Вопрос зрителя: есть «?» (не внутри ссылки) или типичное начало вопроса. */
export function isQuestion(text) {
  const t = String(text || "").replace(/https?:\/\/\S+/g, "").trim();
  if (!t) return false;
  return /\?/.test(t) || QUESTION_START.test(t);
}

const STOP = new Set(
  (
    // ru
    "и в во не что он на я с со как а то все всё она так его но да ты к у же вы за бы по только ее её мне было вот от " +
    "меня еще ещё нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам " +
    "ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз " +
    "тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее " +
    "сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про " +
    "всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более " +
    "всегда конечно всю между это эта эти этот очень просто вообще который которые которая которое тоже типа короче " +
    "кстати блин вроде пока ещё уже будто тебе тобой мной нам вами ими своих свой своей свои свое своё весь вся всё " +
    "видео ролик ролика ролике автор автору канал канала спасибо " +
    "такую такая такие такое такого таких такой ради видел видела видели смотрел смотрела смотрю смотреть " +
    "момент момента моменте моменты году года лет всем сделайте сделать можно нужно надо хочу хочется " +
    "будет буду было есть знаю думаю кажется просто вообще реально лайк лайки ахах ахаха хаха " +
    "каждый каждая каждого люди людей ребята ребят парни парней человек интересно приятно почему зачем зачем-то когда-то кто-то что-то как-то своем своём самый самая самое самые всех всем всеми одна одно одни ещё " +
    // en
    "the a an and or but if then so to of in on at by for with from as is are was were be been being it its this that " +
    "these those i you he she we they me him her us them my your his our their what which who whom how why when where " +
    "not no yes do does did have has had just like get got can could would should will about all any more most very " +
    "really also too there here out up down over than into only own same some such video"
  ).split(/\s+/)
);

// Окончания для грубого стемминга (длинные раньше коротких).
const RU_ENDINGS = [
  "иями", "ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими", "ость", "ах", "ях", "ам", "ям",
  "ой", "ей", "ий", "ый", "ая", "яя", "ое", "ее", "ую", "юю", "ом", "ем", "ов", "ев", "ые", "ие",
  "а", "я", "о", "е", "ы", "и", "у", "ю", "ь",
];
const EN_ENDINGS = ["ing", "ed", "es", "s"];

function stem(w) {
  const endings = /[а-я]/.test(w) ? RU_ENDINGS : EN_ENDINGS;
  for (const e of endings) {
    if (w.endsWith(e) && w.length - e.length >= 3) return w.slice(0, -e.length);
  }
  return w;
}

/**
 * Частые слова обсуждения: считаем, в скольких комментариях встречается слово
 * (а не сколько раз всего — один флудер не должен перевесить). Грубый
 * стемминг, чтобы «игра/игры/игру» сложились вместе; показываем самую частую форму.
 */
export function topWords(comments, limit = 12) {
  const groups = new Map(); // key -> { count, forms: Map(form -> n) }
  for (const c of comments || []) {
    const words = String(c.text || "")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/ё/g, "е")
      .match(/[a-zа-я][a-zа-я'-]{2,}/g);
    if (!words) continue;
    const seen = new Set();
    for (const raw of words) {
      const w = raw.replace(/^[-']+|[-']+$/g, "");
      if (w.length < 3 || STOP.has(w)) continue;
      const key = stem(w);
      if (seen.has(key)) continue;
      seen.add(key);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { count: 0, forms: new Map() }));
      g.count++;
      g.forms.set(w, (g.forms.get(w) || 0) + 1);
    }
  }
  const minCount = comments.length >= 40 ? 3 : 2;
  return [...groups.values()]
    .filter((g) => g.count >= minCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((g) => ({
      word: [...g.forms.entries()].sort((a, b) => b[1] - a[1])[0][0],
      count: g.count,
    }));
}

/**
 * «Моменты» — места видео, на которые ссылаются зрители. Близкие таймкоды
 * склеиваем в кластер, пока соседи отстоят не дальше gapSec (а не режем по
 * фиксированной сетке: иначе 12:40 и 12:45 попадали в разные «корзины»).
 * Вес — число комментариев плюс немного за лайки, чтобы один залайканный
 * таймкод не тонул.
 */
export function topMoments(comments, { gapSec = 10, limit = 30, maxSec = Infinity } = {}) {
  const hits = []; // {t, idx}
  (comments || []).forEach((c, idx) => {
    for (const t of new Set(timecodesOf(c.text, maxSec))) hits.push({ t, idx });
  });
  hits.sort((a, b) => a.t - b.t);
  const clusters = [];
  let cur = null;
  for (const h of hits) {
    // Ограничиваем и общий размах кластера, чтобы цепочка «через каждые 10 с»
    // не склеила полвидео в один момент.
    if (!cur || h.t - cur.last > gapSec || h.t - cur.first > gapSec * 3) {
      cur = { first: h.t, last: h.t, times: new Map(), idxs: [], likes: 0 };
      clusters.push(cur);
    }
    cur.last = h.t;
    cur.times.set(h.t, (cur.times.get(h.t) || 0) + 1);
    if (!cur.idxs.includes(h.idx)) {
      cur.idxs.push(h.idx);
      cur.likes += Number(comments[h.idx].likes) || 0;
    }
  }
  return clusters
    .map((b) => {
      const t = [...b.times.entries()].sort((a, b2) => b2[1] - a[1] || a[0] - b2[0])[0][0];
      const idxs = b.idxs.sort((a, b2) => (comments[b2].likes || 0) - (comments[a].likes || 0));
      // Главное — сколько зрителей сослались на момент; лайки лишь разводят равные.
      return { t, label: fmtTime(t), count: idxs.length, likes: b.likes, idxs, score: idxs.length + 0.15 * Math.log10(1 + b.likes) };
    })
    .sort((a, b) => b.score - a.score || a.t - b.t)
    .slice(0, limit);
}

export function commentStats(comments, maxSec = Infinity) {
  const list = comments || [];
  let likes = 0;
  let questions = 0;
  let withTime = 0;
  let top = null;
  const authors = new Set();
  for (const c of list) {
    likes += Number(c.likes) || 0;
    if (isQuestion(c.text)) questions++;
    if (timecodesOf(c.text, maxSec).length) withTime++;
    if (!top || (c.likes || 0) > (top.likes || 0)) top = c;
    if (c.author) authors.add(c.author);
  }
  return { total: list.length, likes, questions, withTime, authors: authors.size, top };
}

// Оценка «токенов» для бюджета запроса — та же грубая мерка, что в анализе
// (≈3 символа на токен, с запасом).
const tok = (s) => Math.ceil(String(s || "").length / 3);

/**
 * Отбирает комментарии под бюджет токенов для ИИ-поиска и вопросов.
 * Раньше в запрос уходили первые 400 комментариев (~16–20 тыс. токенов),
 * а бесплатный Groq пропускает ~7 тыс. входных токенов в минуту на весь ключ —
 * на больших обсуждениях такой запрос просто не проходил. Теперь: сначала
 * комментарии со словами из запроса, потом самые залайканные, пока влезает.
 * Возвращает [{c, i}] — комментарий и его индекс в исходном списке.
 */
export function pickForBudget(comments, query, { maxTokens = 3500, perComment = 160 } = {}) {
  const terms = String(query || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .match(/[a-zа-я0-9]{3,}/g) || [];
  const stems = [...new Set(terms.filter((t) => !STOP.has(t)).map((t) => (t.length > 5 ? t.slice(0, 5) : t)))];
  const scored = (comments || []).map((c, i) => {
    const text = String(c.text || "").toLowerCase().replace(/ё/g, "е");
    const hits = stems.reduce((n, s) => n + (text.includes(s) ? 1 : 0), 0);
    return { c, i, score: hits * 10 + Math.log10(1 + (Number(c.likes) || 0)) };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const out = [];
  let used = 0;
  for (const s of scored) {
    const cost = tok(String(s.c.text || "").slice(0, perComment)) + 8;
    if (used + cost > maxTokens) continue;
    out.push(s);
    used += cost;
  }
  return out.map(({ c, i }) => ({ c, i }));
}

/**
 * Склейка похожих тем из разных частей анализа. Каждая часть комментариев
 * размечается отдельным запросом, и модель называет одну тему по-разному:
 * «Батарея» и «Автономность батареи». Раньше склеивались только точные
 * совпадения названий — получались дубли. Сравниваем основы слов (Жаккар ≥ 0.5),
 * название берём у самой крупной темы группы. Без запросов к ИИ.
 * На вход: [{name, ids:[...]}], на выход: то же, отсортировано по размеру.
 */
export function mergeTopics(list) {
  const toks = (name) =>
    new Set(
      (String(name).toLowerCase().replace(/ё/g, "е").match(/[a-zа-я0-9]{3,}/g) || [])
        .filter((w) => !STOP.has(w))
        .map(stem)
    );
  const groups = [];
  for (const t of [...list].sort((a, b) => b.ids.length - a.ids.length)) {
    const tk = toks(t.name);
    const g = tk.size
      ? groups.find((gr) => {
          let inter = 0;
          for (const w of tk) if (gr.tk.has(w)) inter++;
          return inter && inter / (gr.tk.size + tk.size - inter) >= 0.5;
        })
      : null;
    if (g) {
      for (const i of t.ids) g.ids.add(i);
    } else {
      groups.push({ name: t.name, tk, ids: new Set(t.ids) });
    }
  }
  return groups
    .map((g) => ({ name: g.name, ids: [...g.ids] }))
    .sort((a, b) => b.ids.length - a.ids.length);
}
