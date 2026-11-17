// Сводка картинкой: PNG-карточка для отправки в мессенджер.
// Рисуется на canvas локально — без сервисов и запросов к ИИ.

const W = 720; // ширина в CSS-пикселях; рисуем в 2× для чёткости
const PAD = 36;
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

function wrap(ctx, text, maxWidth, maxLines = Infinity) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ");
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
  const scale = 2;
  const draft = document.createElement("canvas");
  draft.width = W * scale;
  draft.height = 2400 * scale;
  const ctx = draft.getContext("2d");
  ctx.scale(scale, scale);
  ctx.textBaseline = "top";

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, 2400);
  let y = 0;
  const inner = W - PAD * 2;

  // Превью видео баннером
  const thumb = await loadThumb([meta?.thumbs?.maxres, meta?.thumbs?.sd, meta?.thumbs?.hq].filter(Boolean));
  if (thumb) {
    const bh = 260;
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
    y = bh - 70;
  } else {
    y = PAD;
  }

  // Метка
  ctx.fillStyle = C.accent;
  ctx.font = `700 13px ${FONT}`;
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
      [sp.positive || 0, C.pos, "положительные"],
      [sp.neutral || 0, C.neu, "нейтральные"],
      [sp.negative || 0, C.neg, "негативные"],
    ];
    let x = PAD;
    roundRect(ctx, PAD, y, inner, 10, 5);
    ctx.save();
    ctx.clip();
    for (const [v, color] of parts) {
      const w = (v / total) * inner;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, 10);
      x += w;
    }
    ctx.restore();
    y += 20;
    ctx.font = `500 14px ${FONT}`;
    x = PAD;
    for (const [v, color, label] of parts) {
      const txt = `${Math.round((v / total) * 100)}% ${label}`;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x + 4, y + 9, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.fg2;
      ctx.fillText(txt, x + 14, y + 1);
      x += 14 + ctx.measureText(txt).width + 22;
    }
    y += 40;
  }

  // Текст сводки на подложке
  ctx.font = `400 19px ${FONT}`;
  const sumLines = wrap(ctx, s.summary || "", inner - 40);
  const boxH = sumLines.length * 29 + 36;
  ctx.fillStyle = C.card;
  roundRect(ctx, PAD, y, inner, boxH, 16);
  ctx.fill();
  ctx.fillStyle = C.fg;
  let ty = y + 18;
  for (const line of sumLines) {
    ctx.fillText(line, PAD + 20, ty);
    ty += 29;
  }
  y += boxH + 26;

  // Темы чипами
  const topics = (s.topics || []).slice(0, 6);
  if (topics.length) {
    ctx.fillStyle = C.muted;
    ctx.font = `700 12px ${FONT}`;
    ctx.fillText("ГЛАВНЫЕ ТЕМЫ", PAD, y);
    y += 24;
    ctx.font = `500 15px ${FONT}`;
    let x = PAD;
    for (const t of topics) {
      const label = String(t.name || "");
      const count = t.count != null ? String(t.count) : "";
      const w = ctx.measureText(label).width + ctx.measureText(count).width + 36;
      if (x + w > W - PAD) {
        x = PAD;
        y += 42;
      }
      ctx.fillStyle = C.chip;
      roundRect(ctx, x, y, w, 32, 16);
      ctx.fill();
      ctx.fillStyle = C.fg;
      ctx.fillText(label, x + 14, y + 7);
      ctx.fillStyle = C.muted;
      ctx.fillText(count, x + 22 + ctx.measureText(label).width, y + 7);
      x += w + 8;
    }
    y += 32 + 28;
  }

  // Ключевые мнения — нумерованным списком, до 4 пунктов
  const points = (s.points || []).filter(Boolean).slice(0, 4);
  if (points.length) {
    ctx.fillStyle = C.muted;
    ctx.font = `700 12px ${FONT}`;
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
      ctx.font = `400 17px ${FONT}`;
      for (const line of wrap(ctx, p, inner - 36, 2)) {
        ctx.fillText(line, PAD + 34, y + 1);
        y += 25;
      }
      y += 10;
    });
    y += 16;
  }

  // Подпись
  ctx.fillStyle = C.muted;
  ctx.font = `500 13px ${FONT}`;
  const date = new Date(s.updatedAt || Date.now()).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  ctx.fillText(`Сводка комментариев YouTube · ${date}`, PAD, y);
  y += 18 + PAD;

  // Обрезаем черновик до реальной высоты
  const out = document.createElement("canvas");
  out.width = W * scale;
  out.height = Math.ceil(y * scale);
  out.getContext("2d").drawImage(draft, 0, 0);
  return new Promise((resolve, reject) =>
    out.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas пуст"))), "image/png")
  );
}
