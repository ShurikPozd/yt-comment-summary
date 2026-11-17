// Сводка картинкой: PNG-карточка для отправки в мессенджер.
// Рисуется на canvas локально — без сервисов и запросов к ИИ.

// Карточку чаще всего смотрят в мессенджере на телефоне, где она ужимается
// до ~360 px. Поэтому логическая ширина небольшая (480), а шрифты крупные
// относительно неё; рисуем с запасом (×3 → 1440 px), чтобы было чётко.
// На телефоне основной текст выходит ~14 px, подписи — не меньше ~10 px.
const W = 480;
const PAD = 24;
const SCALE = 3;
// черновик с запасом по высоте; итог обрезается по содержимому. Текст сводки
// ограничен по строкам, так что за край черновика ничего не уходит.
const DRAFT_H = 3200;
const FONT = '"Segoe UI Variable Text", "Segoe UI", Roboto, system-ui, sans-serif';
const C = {
  bg: "#111113",
  card: "#1b1b1e",
  fg: "#f2f2f2",
  fg2: "#cfcfcf",
  muted: "#8e8e93",
  accent: "#ff3355",
  pos: "#34c47c",
  neu: "#8d8d8d",
  neg: "#ff5c61",
  chip: "#26262a",
};

// слово шире строки (ссылка, «ааааааа») режем на куски по ширине
function splitLong(ctx, word, maxWidth) {
  if (ctx.measureText(word).width <= maxWidth) return [word];
  const parts = [];
  let cur = "";
  for (const ch of word) {
    if (cur && ctx.measureText(cur + ch).width > maxWidth) {
      parts.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function wrap(ctx, text, maxWidth, maxLines = Infinity) {
  const words = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .flatMap((w) => splitLong(ctx, w, maxWidth));
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width <= maxWidth || !line) {
      line = test;
    } else {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(" ") !== lines.join(" ")) {
    // обрезаем последнюю строку многоточием
    let last = lines[maxLines - 1];
    while (last && ctx.measureText(last + "…").width > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = last.replace(/[\s,.;:]+$/, "") + "…";
  }
  return lines;
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

async function loadThumb(urls) {
  for (const url of urls) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const blob = await resp.blob();
      if (blob.size < 2000) continue; // серая заглушка YouTube
      return await createImageBitmap(blob);
    } catch (e) {
      /* следующее качество */
    }
  }
  return null;
}

/**
 * @param {object} s — сводка (summary, topics, sentiment, commentCount, analyzed)
 * @param {object} meta — метаданные видео (title, channelName, thumbs)
 * @returns {Promise<Blob>} PNG
 */
export async function renderSummaryCard(s, meta) {
  const scale = SCALE;
  const draft = document.createElement("canvas");
  draft.width = W * scale;
  draft.height = DRAFT_H * scale;
  const ctx = draft.getContext("2d");
  ctx.scale(scale, scale);
  ctx.textBaseline = "top";

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, DRAFT_H);
  let y = 0;
  const inner = W - PAD * 2;

  // Превью видео баннером
  const thumb = await loadThumb([meta?.thumbs?.maxres, meta?.thumbs?.sd, meta?.thumbs?.hq].filter(Boolean));
  if (thumb) {
    const bh = 180;
    const ratio = Math.max(W / thumb.width, bh / thumb.height);
    const sw = W / ratio;
    const sh = bh / ratio;
    ctx.drawImage(thumb, (thumb.width - sw) / 2, (thumb.height - sh) / 2, sw, sh, 0, 0, W, bh);
    // затемнение к низу, чтобы текст читался
    const g = ctx.createLinearGradient(0, bh * 0.35, 0, bh);
    g.addColorStop(0, "rgba(17,17,19,0)");
    g.addColorStop(1, C.bg);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, bh);
    y = bh - 52;
  } else {
    y = PAD;
  }

  // Метка
  ctx.fillStyle = C.accent;
  ctx.font = `700 14px ${FONT}`;
  ctx.fillText("ЧТО ГОВОРЯТ В КОММЕНТАРИЯХ", PAD, y);
  y += 26;

  // Название видео
  ctx.fillStyle = C.fg;
  ctx.font = `700 26px ${FONT}`;
  for (const line of wrap(ctx, meta?.title || "Видео на YouTube", inner, 3)) {
    ctx.fillText(line, PAD, y);
    y += 34;
  }
  y += 4;

  // Канал и объём
  const n = s.analyzed && s.analyzed < s.commentCount ? `${s.analyzed} из ${s.commentCount}` : s.commentCount;
  ctx.fillStyle = C.muted;
  ctx.font = `500 15px ${FONT}`;
  const nWord = plural(Number(s.commentCount) || 0, "комментарий", "комментария", "комментариев");
  ctx.fillText([meta?.channelName, n ? `${n} ${nWord}` : ""].filter(Boolean).join("  ·  "), PAD, y);
  y += 34;

  // Тональность
  const sp = s.sentiment || {};
  const total = (sp.positive || 0) + (sp.neutral || 0) + (sp.negative || 0);
  if (total) {
    const parts = [
      [sp.positive || 0, C.pos, "позитив"],
      [sp.neutral || 0, C.neu, "нейтрально"],
      [sp.negative || 0, C.neg, "негатив"],
    ];
    // Сегменты с зазором, как в панели; под каждым — подпись по центру:
    // «68%» крупно и слово под ним. Узкий сегмент получает минимум ширины,
    // чтобы подпись поместилась.
    const shown = parts.filter(([v]) => v > 0);
    const GAP = 4;
    const MIN = 70;
    const free = inner - GAP * (shown.length - 1);
    let widths = shown.map(([v]) => (v / total) * free);
    const small = widths.map((w) => w < MIN);
    const fixed = small.filter(Boolean).length * MIN;
    const restSum = widths.reduce((a, w, i) => a + (small[i] ? 0 : w), 0);
    widths = widths.map((w, i) => (small[i] ? MIN : (w / restSum) * (free - fixed)));
    let x = PAD;
    shown.forEach(([v, color, label], i) => {
      const w = widths[i];
      ctx.fillStyle = color;
      roundRect(ctx, x, y, w, 10, 5);
      ctx.fill();
      const cx = x + w / 2;
      ctx.textBaseline = "top";
      ctx.font = `700 18px ${FONT}`;
      ctx.fillStyle = C.fg;
      const pctTxt = `${Math.round((v / total) * 100)}%`;
      ctx.fillText(pctTxt, cx - ctx.measureText(pctTxt).width / 2, y + 20);
      ctx.font = `500 14px ${FONT}`;
      ctx.fillStyle = C.fg2;
      ctx.fillText(label, cx - ctx.measureText(label).width / 2, y + 43);
      x += w + GAP;
    });
    y += 76;
  }

  // Текст сводки на подложке
  ctx.font = `400 19px ${FONT}`;
  // Каждая строка — по центру своей полосы высотой LH, поля сверху и снизу
  // одинаковые (раньше снизу оставался лишний межстрочный интервал).
  const sumLines = wrap(ctx, s.summary || "", inner - 40, 14);
  const LH = 29;
  const PADV = 14;
  const boxH = sumLines.length * LH + PADV * 2;
  ctx.fillStyle = C.card;
  roundRect(ctx, PAD, y, inner, boxH, 16);
  ctx.fill();
  ctx.fillStyle = C.fg;
  ctx.textBaseline = "middle";
  sumLines.forEach((line, i) => ctx.fillText(line, PAD + 20, y + PADV + LH * i + LH / 2 + 1));
  ctx.textBaseline = "top";
  y += boxH + 26;

  // Темы чипами
  const topics = (s.topics || []).slice(0, 6);
  if (topics.length) {
    ctx.fillStyle = C.muted;
    ctx.font = `700 14px ${FONT}`;
    ctx.fillText("ГЛАВНЫЕ ТЕМЫ", PAD, y);
    y += 24;
    // Плашки раскладываем по строкам, затем растягиваем каждую строку на
    // всю ширину (свободное место делится поровну), текст — по центру.
    ctx.font = `500 16px ${FONT}`;
    const H = 36;
    const GAP = 8;
    const chips = topics.map((t) => {
      const count = t.count != null ? String(t.count) : "";
      // слишком длинное название темы — с многоточием, плашка не шире строки
      const label = wrap(ctx, String(t.name || ""), inner - 80, 1)[0] || "";
      const lw = ctx.measureText(label).width;
      const cw = count ? ctx.measureText(count).width : 0;
      return { label, count, lw, cw, w: lw + (count ? cw + 8 : 0) + 32 };
    });
    const rows = [];
    for (const c of chips) {
      const row = rows[rows.length - 1];
      const used = row ? row.reduce((a, r) => a + r.w, 0) + GAP * row.length : 0;
      if (!row || used + c.w > inner) rows.push([c]);
      else row.push(c);
    }
    ctx.textBaseline = "middle";
    for (const row of rows) {
      const extra = (inner - row.reduce((a, r) => a + r.w, 0) - GAP * (row.length - 1)) / row.length;
      let x = PAD;
      for (const c of row) {
        const w = c.w + Math.max(0, extra);
        ctx.fillStyle = C.chip;
        roundRect(ctx, x, y, w, H, H / 2);
        ctx.fill();
        const tw = c.lw + (c.count ? c.cw + 8 : 0);
        const tx = x + (w - tw) / 2;
        const cy = y + H / 2 + 1; // кириллица в Segoe сидит чуть выше середины
        ctx.fillStyle = C.fg;
        ctx.fillText(c.label, tx, cy);
        if (c.count) {
          ctx.fillStyle = C.muted;
          ctx.fillText(c.count, tx + c.lw + 8, cy);
        }
        x += w + GAP;
      }
      y += H + GAP;
    }
    ctx.textBaseline = "top";
    y -= GAP;
    y += 28;
  }

  // Ключевые мнения — нумерованным списком, до 4 пунктов
  const points = (s.points || []).filter(Boolean).slice(0, 4);
  if (points.length) {
    ctx.fillStyle = C.muted;
    ctx.font = `700 14px ${FONT}`;
    ctx.fillText("КЛЮЧЕВЫЕ МНЕНИЯ", PAD, y);
    y += 26;
    points.forEach((p, i) => {
      ctx.fillStyle = C.chip;
      ctx.beginPath();
      ctx.arc(PAD + 11, y + 12, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.fg2;
      ctx.font = `700 12px ${FONT}`;
      const num = String(i + 1);
      ctx.fillText(num, PAD + 11 - ctx.measureText(num).width / 2, y + 5);
      ctx.fillStyle = C.fg;
      ctx.font = `400 18px ${FONT}`;
      for (const line of wrap(ctx, p, inner - 34, 3)) {
        ctx.fillText(line, PAD + 34, y);
        y += 26;
      }
      y += 10;
    });
    y += 16;
  }

  // Подпись
  ctx.fillStyle = C.muted;
  ctx.font = `500 14px ${FONT}`;
  const date = new Date(s.updatedAt || Date.now()).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  ctx.fillText(`Сводка комментариев YouTube · ${date}`, PAD, y);
  y += 18 + PAD;

  // Обрезаем черновик до реальной высоты
  const out = document.createElement("canvas");
  out.width = W * scale;
  out.height = Math.ceil(Math.min(y, DRAFT_H) * scale);
  out.getContext("2d").drawImage(draft, 0, 0);
  return new Promise((resolve, reject) =>
    out.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas пуст"))), "image/png")
  );
}
