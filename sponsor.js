"use strict";

// Пропуск рекламных вставок по открытой базе сообщества SponsorBlock
// (sponsor.ajay.app, данные — CC BY-NC-SA 4.0). Сегменты запрашивает фон
// (background.js, «sb:segments») — приватно, по префиксу хеша id видео.
//  - сегменты категорий в режиме «пропускать» перескакиваем сами и показываем
//    поверх плеера «Пропущено: … · Вернуть»;
//  - «только на полосе» — цветная отметка на полосе прогресса и, когда видео
//    доходит до сегмента, предложение «Пропустить»;
//  - «не трогать» — сегмент как будто не размечен.
// Настройки — chrome.storage.local.settings: sponsorSkip (по умолчанию вкл.)
// и sponsorCats { категория: "skip" | "show" | "off" }.
(() => {
  // Встроенный плеер (youtube.com/embed) — только внутри нашей «Моей библиотеки»;
  // встроенные видео на чужих сайтах расширение не трогает.
  if (location.pathname.startsWith("/embed/")) {
    let ours = false;
    try {
      ours = location.ancestorOrigins?.[0] === `chrome-extension://${chrome.runtime.id}`;
    } catch (e) {
      ours = false;
    }
    if (!ours) return;
  } else if (window.top !== window) {
    return; // прочие фреймы YouTube (чат трансляции и т. п.) — не наше
  }
  if (globalThis.__ytcsSponsor) return;
  globalThis.__ytcsSponsor = {};
  const OUR_EMBED = location.pathname.startsWith("/embed/");

  // Цвета — как в самом SponsorBlock: привычны тем, кто им пользовался.
  const CATS = {
    sponsor: { name: "Реклама спонсора", color: "#00d400", def: "skip" },
    selfpromo: { name: "Самореклама", color: "#ffff00", def: "skip" },
    interaction: { name: "Просьба подписаться", color: "#cc00ff", def: "skip" },
    intro: { name: "Заставка", color: "#00ffff", def: "show" },
    outro: { name: "Титры", color: "#0202ed", def: "show" },
    preview: { name: "Повтор", color: "#008fd6", def: "show" },
    music_offtopic: { name: "Не по теме", color: "#ff9900", def: "show" },
    filler: { name: "Заполнитель", color: "#7300ff", def: "show" },
  };
  const MODES = ["skip", "show", "off"];

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  };

  // ---------- Настройки ----------
  const prefs = { ready: false, on: true, hideProgress: false, cats: {} };
  function readPrefs(s) {
    prefs.ready = true;
    prefs.on = s?.sponsorSkip !== false;
    prefs.hideProgress = Boolean(s?.hideProgress);
    for (const c of Object.keys(CATS)) {
      const v = s?.sponsorCats?.[c];
      prefs.cats[c] = MODES.includes(v) ? v : CATS[c].def;
    }
    for (const s2 of segs) s2.mode = prefs.cats[s2.cat];
    if (prefs.on) void load();
    else hideNotice();
    renderMarks();
    check();
  }

  // ---------- Сегменты текущего видео ----------
  let vid = null; // id открытого видео
  let loadedFor = null; // для какого видео уже спросили базу
  let segs = []; // { cat, start, end, uuid, dur, mode }
  const reverted = new Set(); // «Вернуть»: не пропускать до конца просмотра этого видео
  const offered = new Set(); // «только на полосе»: уже предложили пропустить

  function videoIdNow() {
    if (location.pathname === "/watch") return new URLSearchParams(location.search).get("v");
    if (OUR_EMBED) return location.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})/)?.[1] || null;
    return null; // Shorts и прочие страницы — без пропуска
  }

  function onNavigate() {
    const id = videoIdNow();
    if (id === vid) return;
    vid = id;
    loadedFor = null;
    segs = [];
    reverted.clear();
    offered.clear();
    hideNotice();
    renderMarks();
    void load();
  }

  async function load() {
    const id = vid;
    if (!id || !prefs.ready || !prefs.on || loadedFor === id || !alive()) return;
    loadedFor = id;
    let r = null;
    try {
      r = await chrome.runtime.sendMessage({ type: "sb:segments", videoId: id });
    } catch (e) {
      r = null;
    }
    if (vid !== id) return;
    if (!r?.ok) {
      loadedFor = null; // сбой сети — попробуем при следующей проверке
      return;
    }
    segs = (r.segments || []).map((s) => ({ ...s, mode: prefs.cats[s.cat] || "off" })).sort((a, b) => a.start - b.start);
    renderMarks();
    check();
  }

  // ---------- Видео ----------
  const player = () => document.querySelector("#movie_player");
  const mainVideo = () => document.querySelector("#movie_player video.html5-main-video") || document.querySelector("video.html5-main-video");
  const adShowing = () => Boolean(player()?.classList.contains("ad-showing"));

  // Разметка сделана для другой длительности (видео перезалили или обрезали,
  // или сразу после перехода <video> ещё от прошлого ролика) — не трогаем.
  const fits = (s, d) => !(s.dur > 0 && Number.isFinite(d) && d > 0 && Math.abs(d - s.dur) > 5);

  // Конец цепочки пропускаемых сегментов, идущих встык или внахлёст.
  function chainEnd(first) {
    let end = first.end;
    const ids = [first.uuid];
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of segs) {
        if (s.mode !== "skip" || reverted.has(s.uuid) || ids.includes(s.uuid)) continue;
        if (s.start <= end + 0.3 && s.end > end) {
          end = s.end;
          ids.push(s.uuid);
          grew = true;
        }
      }
    }
    return { end, ids };
  }

  let timer = 0;
  function check() {
    clearTimeout(timer);
    if (!prefs.on || !segs.length) return;
    const v = mainVideo();
    if (!v || adShowing() || v.seeking) return;
    const t = v.currentTime;
    const d = v.duration;
    for (const s of segs) {
      if (t < s.start - 1) offered.delete(s.uuid); // перемотали назад — предложим снова
    }
    if (!v.paused) {
      for (const s of segs) {
        if (s.mode !== "skip" || reverted.has(s.uuid) || !fits(s, d)) continue;
        if (t >= s.start - 0.05 && t < s.end - 0.25) return skip(v, s);
      }
      for (const s of segs) {
        if (s.mode !== "show" || offered.has(s.uuid) || !fits(s, d)) continue;
        if (t >= s.start && t < s.end - 1) {
          offered.add(s.uuid);
          showNotice("offer", s);
          break;
        }
      }
      // ближайший сегмент начнётся раньше следующего timeupdate (~250 мс) —
      // ставим точный таймер, чтобы не проиграть начало вставки
      let next = Infinity;
      for (const s of segs) {
        if (s.mode === "skip" && !reverted.has(s.uuid) && s.start > t && fits(s, d)) next = Math.min(next, s.start);
      }
      if (next - t < 1.2) timer = setTimeout(check, Math.max(0, ((next - t) / (v.playbackRate || 1)) * 1000 - 20));
    }
    // ушли из сегмента, о котором предлагали, — убираем предложение
    if (notice.kind === "offer" && notice.seg && (t < notice.seg.start || t >= notice.seg.end)) hideNotice();
  }

  function skip(v, s) {
    const { end, ids } = chainEnd(s);
    const d = v.duration;
    const from = v.currentTime;
    v.currentTime = Number.isFinite(d) && end >= d - 0.3 ? d : end;
    showNotice("skipped", s, ids);
    notice.saved = savedStat(v, from);
  }

  // Статистика просмотра (stats.js): сколько секунд реального времени сэкономил
  // пропуск — при текущей скорости. «Вернуть» отдаёт их обратно.
  function savedStat(v, from) {
    const sec = (v.currentTime - from) / (v.playbackRate || 1);
    if (!(sec > 0)) return 0;
    document.dispatchEvent(new CustomEvent("ytcs-stats:saved", { detail: JSON.stringify({ kind: "sponsor", sec }) }));
    return sec;
  }

  // ---------- Сообщение поверх плеера (shadow DOM) ----------
  const NOTICE_CSS = `
    :host { all: initial; position: absolute; left: 12px; bottom: var(--lift, 76px); z-index: 61;
      max-width: calc(100% - 24px); pointer-events: none;
      transition: bottom .25s cubic-bezier(0, 0, .2, 1); }
    :host-context(.ytp-autohide) { bottom: 16px; }
    .n { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 6px 6px 6px 16px;
      border-radius: 999px; background: rgba(28, 28, 30, .86);
      -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6);
      box-shadow: 0 8px 30px rgba(0, 0, 0, .4), inset 0 0 0 1px rgba(255, 255, 255, .07);
      color: #f1f1f1; font: 500 15px/1.3 "YouTube Noto", Roboto, Arial, sans-serif;
      opacity: 0; transform: translateY(8px) scale(.97); transform-origin: 0 100%;
      transition: opacity .18s ease, transform .26s cubic-bezier(.22, 1, .36, 1); }
    .n.show { opacity: 1; transform: none; pointer-events: auto; }
    .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; box-shadow: 0 0 0 2px rgba(255, 255, 255, .14); }
    .txt { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
    button { flex: none; height: 34px; border: 0; border-radius: 999px; font: inherit; cursor: pointer;
      transition: background-color .12s ease; }
    .act { padding: 0 16px 1px; background: rgba(255, 255, 255, .14); color: #fff; font-weight: 600; }
    .act:hover, .act:focus-visible { background: rgba(255, 255, 255, .24); outline: none; }
    .act:active { background: rgba(255, 255, 255, .3); }
    .x { width: 34px; padding: 0; margin-left: -6px; background: none; color: rgba(255, 255, 255, .6);
      display: grid; place-items: center; }
    .x:hover, .x:focus-visible { background: rgba(255, 255, 255, .1); color: #fff; outline: none; }
    .x svg { width: 16px; height: 16px; }
    @media (prefers-reduced-motion: reduce) { :host, .n, button { transition: none; } }`;

  const notice = { host: null, root: null, kind: "", seg: null, ids: [], timer: 0, hover: false, saved: 0 };

  function noticeHost() {
    const p = player();
    if (!p) return null;
    if (!notice.host) {
      const host = document.createElement("div");
      host.id = "ytcs-sb-notice";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${NOTICE_CSS}</style>
        <div class="n" role="status" aria-live="polite">
          <span class="dot"></span><span class="txt"></span>
          <button class="act" type="button"></button>
          <button class="x" type="button" aria-label="Скрыть" title="Скрыть"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>`;
      // клики по сообщению не должны ставить видео на паузу и снимать полноэкранный режим
      for (const t of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "keydown"]) {
        host.addEventListener(t, (e) => e.stopPropagation());
      }
      root.querySelector(".act").addEventListener("click", onAct);
      root.querySelector(".x").addEventListener("click", hideNotice);
      const box = root.querySelector(".n");
      box.addEventListener("mouseenter", () => {
        notice.hover = true;
        clearTimeout(notice.timer);
      });
      box.addEventListener("mouseleave", () => {
        notice.hover = false;
        armHide(3000);
      });
      notice.host = host;
      notice.root = root;
    }
    if (notice.host.parentElement !== p) p.appendChild(notice.host);
    return notice.host;
  }

  // Высота над панелью управления: у плеера разные размеры (обычный,
  // кинорежим, полный экран), поэтому меряем, а не угадываем.
  function liftFor(p) {
    const pr = p.getBoundingClientRect();
    let top = Infinity;
    for (const sel of [".ytp-progress-bar-container", ".ytp-chrome-bottom"]) {
      const r = p.querySelector(sel)?.getBoundingClientRect();
      if (r && r.height > 0) top = Math.min(top, r.top);
    }
    return Number.isFinite(top) ? Math.max(16, Math.round(pr.bottom - top + 12)) : 76;
  }

  function armHide(ms) {
    clearTimeout(notice.timer);
    if (!notice.hover) notice.timer = setTimeout(hideNotice, ms);
  }

  function showNotice(kind, seg, ids = []) {
    const host = noticeHost();
    if (!host) return;
    const p = player();
    host.style.setProperty("--lift", liftFor(p) + "px");
    const name = CATS[seg.cat]?.name || "Вставка";
    const r = notice.root;
    r.querySelector(".dot").style.background = CATS[seg.cat]?.color || "#fff";
    r.querySelector(".txt").textContent = kind === "skipped" ? `Пропущено: ${name.toLowerCase()}` : `Сейчас: ${name.toLowerCase()}`;
    r.querySelector(".act").textContent = kind === "skipped" ? "Вернуть" : "Пропустить";
    notice.kind = kind;
    notice.seg = seg;
    notice.ids = ids;
    const box = r.querySelector(".n");
    box.classList.remove("show");
    void box.offsetHeight; // перезапуск появления
    box.classList.add("show");
    armHide(kind === "skipped" ? 6000 : 8000);
  }

  function hideNotice() {
    clearTimeout(notice.timer);
    notice.root?.querySelector(".n")?.classList.remove("show");
    notice.kind = "";
    notice.seg = null;
    notice.hover = false;
  }

  function onAct() {
    const v = mainVideo();
    const s = notice.seg;
    if (!v || !s) return hideNotice();
    if (notice.kind === "skipped") {
      if (notice.saved > 0) document.dispatchEvent(new CustomEvent("ytcs-stats:saved", { detail: JSON.stringify({ kind: "sponsor", sec: -notice.saved }) }));
      notice.saved = 0;
      // вернуться к началу вставки и больше её не пропускать
      for (const id of notice.ids.length ? notice.ids : [s.uuid]) reverted.add(id);
      v.currentTime = Math.max(0, s.start);
      hideNotice();
      renderMarks();
      return;
    }
    // предложение «Пропустить» для сегмента «только на полосе»
    const d = v.duration;
    const from = v.currentTime;
    v.currentTime = Number.isFinite(d) && s.end >= d - 0.3 ? d : s.end;
    savedStat(v, from);
    hideNotice();
  }

  // ---------- Отметки на полосе прогресса ----------
  // Слой как у родных «маркеров» YouTube (.ytp-timed-markers-container):
  // над полосой, под ползунком; тоньше в покое и толще при наведении.
  const MARKS_CSS = `
    :host { all: initial; position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 40;
      pointer-events: none; transform: scaleY(.667);
      transition: transform .2s cubic-bezier(.05, 0, 0, 1); }
    :host-context(.ytp-progress-bar-hover) { transform: none; }
    .s { position: absolute; top: 0; height: 100%; min-width: 2px; opacity: .9; }
    .s.rev { opacity: .45; }
    @media (prefers-reduced-motion: reduce) { :host { transition: none; } }`;
  let marks = null;

  function renderMarks() {
    const bar = document.querySelector("#movie_player .ytp-progress-bar");
    const v = mainVideo();
    const d = v && !adShowing() ? v.duration : NaN;
    const show = prefs.on && !prefs.hideProgress && bar && segs.length && Number.isFinite(d) && d > 0;
    if (!show) {
      marks?.remove();
      return;
    }
    if (!marks) {
      marks = document.createElement("div");
      marks.id = "ytcs-sb-marks";
      marks.attachShadow({ mode: "open" });
    }
    if (marks.parentElement !== bar) bar.appendChild(marks);
    const html = segs
      .filter((s) => s.mode !== "off" && fits(s, d))
      .map((s) => {
        const l = Math.max(0, Math.min(100, (s.start / d) * 100));
        const w = Math.max(0, Math.min(100 - l, ((s.end - s.start) / d) * 100));
        return `<div class="s${reverted.has(s.uuid) ? " rev" : ""}" style="left:${l.toFixed(3)}%;width:${w.toFixed(3)}%;background:${CATS[s.cat]?.color || "#fff"}"></div>`;
      })
      .join("");
    const next = `<style>${MARKS_CSS}</style>${html}`;
    if (marks.shadowRoot.innerHTML !== next) marks.shadowRoot.innerHTML = next;
  }

  // ---------- Подписки ----------
  // События <video> не всплывают, но ловятся на перехвате (capture) на document —
  // так не важно, что YouTube подменяет элемент при переходах.
  const isMain = (e) => e.target instanceof HTMLVideoElement && e.target.classList.contains("html5-main-video");
  for (const t of ["timeupdate", "playing", "seeked", "ratechange"]) {
    document.addEventListener(t, (e) => isMain(e) && check(), true);
  }
  document.addEventListener("pause", (e) => isMain(e) && clearTimeout(timer), true);
  for (const t of ["loadedmetadata", "durationchange"]) {
    document.addEventListener(
      t,
      (e) => {
        if (!isMain(e)) return;
        onNavigate();
        renderMarks();
      },
      true
    );
  }

  window.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("popstate", onNavigate);
  // Переходы без yt-navigate-finish, перерисованная полоса прогресса и
  // повтор запроса после сбоя сети — раз в секунду, это дёшево.
  setInterval(() => {
    if (!alive()) return;
    onNavigate();
    if (prefs.on && vid && loadedFor !== vid) void load();
    if (segs.length && (!marks || !marks.isConnected)) renderMarks();
  }, 1000);

  if (!alive()) return;
  chrome.storage.local
    .get("settings")
    .then((o) => readPrefs(o.settings))
    .catch(() => readPrefs(null));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) readPrefs(changes.settings.newValue);
  });
  onNavigate();
})();
