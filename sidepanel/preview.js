import { sanitizeFilename } from "../groq.js";

const params = new URLSearchParams(location.search);
const urls = (params.get("urls") || "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const title = params.get("title") || "";
if (title) document.title = "Превью — " + title;

const $ = (id) => document.getElementById(id);
const img = $("pv-image");
const bar = $("pv-bar");
const errBox = $("pv-error");

function setBackgroundMode(dark) {
  document.body.style.background = dark ? "#000" : "#181818";
}

let index = 0;
function showNext() {
  if (index >= urls.length) {
    img.style.display = "none";
    errBox.classList.remove("hidden");
    setBackgroundMode(true);
    return;
  }
  const url = urls[index];
  img.onload = () => {
    errBox.classList.add("hidden");
    img.style.display = "";
  };
  img.onerror = () => {
    index++;
    showNext();
  };
  img.src = url;
}

// Первым делом пытаемся показать максимальный размер картинки;
// затем красиво вписываем оставшиеся. Заодно пишем заголовок.
$("pv-title").textContent = title;
$("pv-title").title = title;

img.addEventListener("dblclick", () => {
  // двойной клик — открыть оригинал в новой вкладке целиком
  if (urls.length) window.open(urls[0], "_blank", "noopener");
});

$("pv-back").addEventListener("click", () => {
  if (window.history.length > 1) window.history.back();
  else window.close();
});

$("pv-retry").addEventListener("click", () => {
  index = 0;
  errBox.classList.add("hidden");
  img.style.display = "";
  showNext();
});

$("pv-download").addEventListener("click", async () => {
  const url = img.src || urls[0];
  if (!url) return;
  const final = sanitizeFilename((title || "thumbnail") + " (превью)") + ".jpg";
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
    await chrome.downloads.download({
      url: dataUrl,
      filename: final,
      conflictAction: "uniquify",
      saveAs: false,
    });
    $("pv-title").textContent = "Скачано ✓";
    setTimeout(() => ($("pv-title").textContent = title), 2000);
  } catch (e) {
    $("pv-download").textContent = "Ошибка";
    setTimeout(() => ($("pv-download").textContent = "⬇ Скачать"), 2000);
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && window.history.length > 1) window.history.back();
});

showNext();