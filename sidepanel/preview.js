import { sanitizeFilename } from "../groq.js";
import { hydrateIcons } from "./icons.js";

hydrateIcons();

const params = new URLSearchParams(location.search);
const urls = (params.get("urls") || "")
  .split(",")
  .map((u) => u.trim())
  .filter((u) => /^https:\/\/i\.ytimg\.com\/vi\/[A-Za-z0-9_-]{11}\/\w+\.jpg$/.test(u)); // только превью YouTube
const title = params.get("title") || "";
// Имя файла приходит из панели — уже по шаблону из настроек.
const fileName = params.get("name") || sanitizeFilename((title || "thumbnail") + " (превью)") + ".jpg";
if (title) document.title = "Превью — " + title;

const $ = (id) => document.getElementById(id);
const img = $("pv-image");
const errBox = $("pv-error");

const LABELS = { maxresdefault: "Макс.", sddefault: "SD", hqdefault: "HQ" };
const escAttr = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const labelOf = (u) => LABELS[(u.match(/\/(\w+)\.jpg/) || [])[1]] || "—";

// Какие качества реально есть: maxres у части видео отсутствует, и YouTube
// отдаёт вместо него серую заглушку 120×90 (с 404). Такие пропускаем.
const available = new Map(); // url -> {w, h}
let current = null;

function probe(url) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im.naturalWidth > 120 ? { w: im.naturalWidth, h: im.naturalHeight } : null);
    im.onerror = () => resolve(null);
    im.src = url;
  });
}

let toastTimer = null;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

function renderQuality() {
  const box = $("pv-quality");
  box.innerHTML = urls
    .filter((u) => available.has(u))
    .map((u) => {
      const { w, h } = available.get(u);
      return `<button class="chip${u === current ? " active" : ""}" data-url="${escAttr(u)}" role="radio" aria-checked="${u === current}" title="${w}×${h}">${escAttr(labelOf(u))}</button>`;
    })
    .join("");
}

function show(url) {
  current = url;
  const { w, h } = available.get(url);
  img.src = url;
  img.style.display = "";
  errBox.classList.add("hidden");
  $("pv-meta").textContent = `${w}×${h} · ${fileName}`;
  renderQuality();
}

async function init() {
  $("pv-title").textContent = title;
  $("pv-title").title = title;
  const results = await Promise.all(urls.map(probe));
  results.forEach((r, i) => r && available.set(urls[i], r));
  const best = urls.find((u) => available.has(u));
  if (!best) {
    img.style.display = "none";
    errBox.classList.remove("hidden");
    $("pv-meta").textContent = "";
    return;
  }
  show(best);
}

async function currentBlob() {
  const resp = await fetch(current);
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.blob();
}

async function download() {
  if (!current) return;
  try {
    const blob = await currentBlob();
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
    await chrome.downloads.download({ url: dataUrl, filename: fileName, conflictAction: "uniquify", saveAs: false });
    toast("Скачано: " + fileName);
  } catch (e) {
    toast("Не удалось скачать: " + (e.message || e));
  }
}

// Буфер обмена принимает только PNG — перерисовываем JPEG через canvas.
async function copyImage() {
  if (!current) return;
  try {
    const bitmap = await createImageBitmap(await currentBlob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const png = await canvas.convertToBlob({ type: "image/png" });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    toast("Картинка скопирована в буфер");
  } catch (e) {
    toast("Не удалось скопировать: " + (e.message || e));
  }
}

function close() {
  if (window.history.length > 1) window.history.back();
  else window.close();
}

$("pv-quality").addEventListener("click", (e) => {
  const b = e.target.closest("[data-url]");
  if (b) show(b.dataset.url);
});
$("pv-download").addEventListener("click", download);
$("pv-copy").addEventListener("click", copyImage);
$("pv-back").addEventListener("click", close);
$("pv-retry").addEventListener("click", init);
img.addEventListener("dblclick", () => current && window.open(current, "_blank", "noopener"));

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "escape") close();
  else if (k === "d" || k === "в") download();
  else if (k === "c" || k === "с") copyImage();
});

init();
