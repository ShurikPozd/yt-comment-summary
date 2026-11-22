// Поиск по «Моей библиотеке» из адресной строки — чистая часть (без chrome.*),
// её проверяет tests/run.mjs. Привязка к Chrome — omnibox.js.
//   yt <запрос>  — видео из плейлистов и очереди (тот же поиск, что в библиотеке);
//   yt q         — открыть очередь;  yt ?  — какие есть команды;  yt  — открыть библиотеку.

import { buildIndex, highlight, search } from "./library/search.js";

export const LIMIT = 8; // столько видео помещается в выпадающий список
const TITLE_MAX = 110;
const QUEUE_PL = "Очередь";

// Описание подсказки — XML (<match>, <dim>, <url>): неэкранированный «<» или «&»
// в названии видео ломает весь список, а управляющие символы XML не допускает вовсе.
export function escapeXml(s) {
  return String(s ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const cut = (s, max) => {
  const t = String(s || "").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
};

// Кусок текста с подсветкой найденных слов
export function marked(text, hits) {
  return highlight(text, hits)
    .map((p) => (p.hit ? `<match>${escapeXml(p.t)}</match>` : escapeXml(p.t)))
    .join("");
}

export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// Что набрано после «yt »: команда или запрос
export function parseInput(text) {
  const t = String(text || "").trim();
  if (!t) return { kind: "empty" };
  if (t === "?" || t === ",") return { kind: "help" }; // «,» — «?» в русской раскладке без Shift
  if (/^(q|й)$/i.test(t)) return { kind: "queue" };
  const id = videoIdOf(t);
  if (id) return { kind: "video", id };
  return { kind: "search", q: t };
}

// id видео из ссылки YouTube (в том числе из «content» нашей подсказки)
export function videoIdOf(text) {
  const t = String(text || "").trim();
  const m =
    /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)([\w-]{11})(?![\w-])/.exec(t) ||
    /^(?:https?:\/\/)?youtu\.be\/([\w-]{11})(?![\w-])/.exec(t);
  return m ? m[1] : "";
}

// Каталог библиотеки + очередь → документы для поиска и сведения для подсказок.
//   cat   — { playlists: [{ id, title }], videos: [{ id, title, channel, len, short, in: [[pid, pos, setId]] }] }
//   queue — [{ id, title, channel, len, short }],  pos — { id: секунда }
export function buildData(cat, queue = [], pos = {}) {
  const plTitle = new Map((cat?.playlists || []).map((p) => [p.id, p.title]));
  const qIds = new Set((queue || []).map((x) => x.id));
  const metas = [];
  const byId = new Map();
  for (const v of cat?.videos || []) {
    if (!v?.id || byId.has(v.id)) continue;
    const pls = [...new Set((v.in || []).map(([pid]) => plTitle.get(pid)).filter(Boolean))];
    const m = { id: v.id, title: v.title || "", channel: v.channel || "", len: v.len || 0, short: Boolean(v.short), pls, queued: qIds.has(v.id), at: 0 };
    byId.set(v.id, m);
    metas.push(m);
  }
  for (const x of queue || []) {
    if (!x?.id) continue;
    let m = byId.get(x.id);
    if (!m) {
      m = { id: x.id, title: x.title || x.id, channel: x.channel || "", len: x.len || 0, short: Boolean(x.short), pls: [], queued: true, at: 0 };
      byId.set(x.id, m);
      metas.push(m);
    }
    m.at = Number(pos?.[x.id]) || 0;
  }
  // «Очередь» — как плейлист: по слову «очередь» находятся видео из неё
  const docs = metas.map((m) => ({ title: m.title, channel: m.channel, playlists: m.queued ? [...m.pls, QUEUE_PL] : m.pls }));
  return { metas, byId, index: buildIndex(docs), queueIds: [...qIds] };
}

// Отпечаток каталога и очереди: поменялся — индекс строится заново.
// Библиотека правит каталог и без смены syncedAt («Порядок в плейлистах»,
// «Смотреть позже» → очередь), поэтому считаем и записи о плейлистах.
export function fingerprint(cat, queue = []) {
  let links = 0;
  for (const v of cat?.videos || []) links += v.in?.length || 0;
  const q = (queue || []).map((x) => x.id).join(",");
  return `${cat?.syncedAt || 0}|${cat?.videos?.length || 0}|${links}|${cat?.playlists?.length || 0}|${q}`;
}

// Ссылка на видео; из очереди — с места, где остановились (как в queuePlay)
export function videoUrl(m) {
  if (m.short) return `https://www.youtube.com/shorts/${m.id}`;
  return `https://www.youtube.com/watch?v=${m.id}${m.queued && m.at > 5 ? `&t=${Math.floor(m.at)}s` : ""}`;
}

// Одна строка выпадающего списка
export function describe(m, hits) {
  const title = marked(cut(m.title, TITLE_MAX), hits);
  const extra = [];
  if (m.channel) extra.push(marked(cut(m.channel, 40), hits));
  if (m.pls.length) extra.push(marked(cut(m.pls[0], 40), hits) + (m.pls.length > 1 ? ` +${m.pls.length - 1}` : ""));
  if (m.queued) extra.push(m.at > 5 && !m.short ? `в очереди, с ${fmtTime(m.at)}` : "в очереди");
  else if (m.short) extra.push("Shorts");
  else if (m.len) extra.push(fmtTime(m.len));
  return `${title}${extra.length ? ` <dim>— ${extra.join(" · ")}</dim>` : ""}`;
}

const content = (m) => `https://www.youtube.com/watch?v=${m.id}`;

// Подсказки на набранный текст: { head — первая строка (что сделает Enter), items — видео }
//   data — из buildData или null (каталог ещё не собран и очередь пуста)
export function suggest(data, text, limit = LIMIT) {
  const inp = parseInput(text);
  const none = !data?.metas.length;
  if (inp.kind === "help") {
    return {
      head: "Команды: <match>yt запрос</match> — поиск по плейлистам и очереди · <match>yt q</match> — очередь · <match>yt</match> и Enter — «Моя библиотека»",
      items: [],
    };
  }
  if (inp.kind === "queue") {
    const n = data?.queueIds.length || 0;
    return { head: `Открыть очередь <dim>— ${n ? videosWord(n) : "пока пусто"}</dim>`, items: queueTop(data, limit) };
  }
  if (inp.kind === "empty") {
    return { head: "Открыть «Мою библиотеку» <dim>— или наберите запрос · q — очередь · ? — команды</dim>", items: queueTop(data, Math.min(limit, 5)) };
  }
  if (inp.kind === "video") {
    const m = data?.byId.get(inp.id);
    return { head: m ? `Открыть: ${describe(m, null)}` : `Открыть видео <url>${escapeXml(inp.id)}</url>`, items: [] };
  }
  const q = inp.q;
  if (none) return { head: `Искать «<match>${escapeXml(cut(q, 80))}</match>» в «Моей библиотеке» <dim>— список плейлистов ещё не собран: Enter откроет библиотеку</dim>`, items: [] };
  const r = search(data.index, q);
  const res = r.results || [];
  // при равном счёте — сначала то, что в очереди
  const ranked = res.map((x, i) => ({ x, i })).sort((a, b) => b.x.score - a.x.score || data.metas[b.x.d].queued - data.metas[a.x.d].queued || a.i - b.i);
  const items = ranked.slice(0, limit).map(({ x }) => {
    const m = data.metas[x.d];
    return { content: content(m), description: describe(m, x.hits), id: m.id };
  });
  const found = !res.length ? "ничего не нашлось" : r.partial ? `${videosWord(res.length)}, частично` : `найдено ${videosWord(res.length)}`;
  const typed = r.swapped ? `, набрано «${escapeXml(cut(q, 40))}»` : "";
  return { head: `Искать «<match>${escapeXml(cut(r.swapped || q, 80))}</match>» в «Моей библиотеке» <dim>— ${found}${typed}</dim>`, items };
}

function queueTop(data, n) {
  if (!data) return [];
  return data.queueIds.slice(0, n).map((id) => {
    const m = data.byId.get(id);
    return { content: content(m), description: describe(m, null), id };
  });
}

export const videosWord = (n) => `${Number(n).toLocaleString("ru-RU")} видео`; // «видео» не склоняется
