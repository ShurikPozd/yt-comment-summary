// Блок «Проверка» в настройках и плашка о неполадках сверху панели.
// Проверки делает фон (../selfcheck.js через background.js), ход и итог —
// в storage.local; здесь только кнопка, отрисовка и переключатель автопроверки.

import { CHECKS, SELFCHECK_KEY, SELFCHECK_AUTO_KEY, failuresOf } from "../selfcheck.js";
import { icon } from "./icons.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const titleOf = (id) => CHECKS.find((c) => c.id === id)?.title || id;
// фон мог уснуть посреди проверки — такой «идущий» отчёт считаем прерванным
const STALE_RUN = 3 * 60 * 1000;

const MARK = {
  ok: () => icon("check", { size: 14 }),
  fail: () => icon("close", { size: 14 }),
  warn: () => "!",
  skip: () => "–",
  run: () => "",
};

function when(at) {
  const d = new Date(at);
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const day = (x) => new Date(x).toDateString();
  if (day(at) === day(Date.now())) return `сегодня в ${time}`;
  if (day(at) === day(Date.now() - 864e5)) return `вчера в ${time}`;
  return `${d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })} в ${time}`;
}

function normalize(report) {
  if (!report?.items) return null;
  if (report.running && Date.now() - report.at > STALE_RUN) {
    return {
      ...report,
      running: false,
      items: report.items.map((x) => (x.status === "run" ? { ...x, status: "skip", text: "Проверка прервалась — нажмите кнопку ещё раз." } : x)),
    };
  }
  return report;
}

function verdict(report) {
  const bad = failuresOf(report).length;
  const warn = report.items.filter((x) => x.status === "warn").length;
  if (bad) return { cls: "fail", text: `сломалось ${bad} из ${report.items.length}` };
  if (warn) return { cls: "warn", text: "работает, есть замечания" };
  return { cls: "ok", text: "всё работает" };
}

export function initSelfCheckUI({ getServer, openSettings }) {
  const btn = $("btn-selfcheck");
  const list = $("selfcheck-list");
  const whenEl = $("selfcheck-when");
  const alertEl = $("selfcheck-alert");
  const autoEl = $("set-selfcheck-auto");
  if (!btn || !list) return;
  let report = null;
  let tick = null;

  function renderButton() {
    const running = Boolean(report?.running);
    btn.disabled = running;
    clearInterval(tick);
    if (!running) {
      btn.textContent = report ? "Проверить ещё раз" : "Проверить, всё ли работает";
      return;
    }
    const upd = () => (btn.textContent = `Проверяем… ${Math.max(0, Math.round((Date.now() - report.at) / 1000))} с`);
    upd();
    tick = setInterval(upd, 1000);
  }

  function render() {
    renderButton();
    if (!report) {
      list.innerHTML = "";
      whenEl.textContent = "ещё не проверялось";
      whenEl.className = "sc-when";
      alertEl.classList.add("hidden");
      return;
    }
    const v = report.running ? { cls: "run", text: "идёт проверка" } : verdict(report);
    whenEl.textContent = report.running ? v.text : `${when(report.at)}${report.auto ? " (сама)" : ""} · ${v.text}`;
    whenEl.className = `sc-when ${v.cls}`;
    list.innerHTML = report.items
      .map(
        (x) => `<li class="sc-item ${esc(x.status)}">
          <span class="sc-mark" aria-hidden="true">${MARK[x.status]?.() ?? ""}</span>
          <div class="sc-body">
            <div class="sc-title">${esc(titleOf(x.id))}</div>
            ${x.text ? `<div class="sc-text">${esc(x.text)}</div>` : ""}
            ${x.hint && x.status !== "ok" ? `<div class="sc-hint">${esc(x.hint)}</div>` : ""}
          </div>
        </li>`
      )
      .join("");
    // плашка сверху панели — пока поломка не ушла
    const bad = report.running ? [] : failuresOf(report);
    alertEl.classList.toggle("hidden", !bad.length);
    if (bad.length) {
      alertEl.innerHTML = `<span class="sc-alert-mark" aria-hidden="true">!</span>
        <span class="sc-alert-text">Сломалось: ${esc(bad.map((x) => titleOf(x.id)).join(", "))}</span>
        <button class="link-btn" type="button">Подробнее</button>`;
    }
  }

  alertEl.addEventListener("click", (e) => {
    if (!e.target.closest("button")) return;
    openSettings();
    requestAnimationFrame(() => $("selfcheck-block").scrollIntoView({ block: "start", behavior: "smooth" }));
  });

  btn.addEventListener("click", async () => {
    if (report?.running) return;
    report = { at: Date.now(), running: true, items: CHECKS.map((c) => ({ id: c.id, status: "run", text: "Проверяем…" })) };
    render();
    const r = await chrome.runtime.sendMessage({ type: "selfcheck:run", server: getServer() }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (r?.ok) report = normalize(r.report);
    else {
      report = { at: Date.now(), running: false, items: CHECKS.map((c) => ({ id: c.id, status: "skip", text: "Не проверялось." })) };
      report.items[0] = { id: CHECKS[0].id, status: "fail", text: `Проверка не запустилась: ${String(r?.error || "фон не ответил").slice(0, 100)}.`, hint: "Перезагрузите расширение на chrome://extensions и повторите." };
    }
    render();
  });

  autoEl?.addEventListener("change", () => void chrome.storage.local.set({ [SELFCHECK_AUTO_KEY]: autoEl.checked }));

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch[SELFCHECK_KEY]) {
      report = normalize(ch[SELFCHECK_KEY].newValue);
      render();
    }
    if (ch[SELFCHECK_AUTO_KEY] && autoEl) autoEl.checked = ch[SELFCHECK_AUTO_KEY].newValue !== false;
  });

  chrome.storage.local.get([SELFCHECK_KEY, SELFCHECK_AUTO_KEY]).then((got) => {
    report = normalize(got[SELFCHECK_KEY]);
    if (autoEl) autoEl.checked = got[SELFCHECK_AUTO_KEY] !== false;
    render();
  });
}
