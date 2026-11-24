// Замер центровки подписей: вставляется в страницу стенда (tools/align/shot.mjs).
// window.__textAudit(roots?, extraSel?) → [{ el, text, er, cr, sr, multi }]
//   el    — короткое имя элемента (tag#id.class1.class2.class3) — по нему белый список;
//   er    — рамка элемента (кнопка, вкладка, плашка), css px от левого верхнего угла окна;
//   bw    — толщина рамки сверху и снизу: середину считаем внутри неё (у клавиш-плашек
//           толстая нижняя рамка — «лицо» клавиши над ней);
//   cr    — рамка первой заглавной буквы или цифры подписи;
//   sr    — рамка значка (svg) сбоку от подписи, если он есть;
//   multi — подпись или содержимое в несколько строк (по середине не сравниваем).
// Сами пиксели меряет tools/align/pixan.py по снимку страницы.
(function () {
  const SEL = [
    "button", "[role=tab]", "[role=button]", "[role=menuitem]", "[role=checkbox]", "[role=radio]",
    ".chip", "a[class]", "label[class]", "summary", ".badge", ".pill", "kbd", ".key", ".search-modes label",
  ].join(", ");
  // заглавная без выносов: у «Д», «Ц», «Щ», «Q», «J» ножки ниже строки — центр по ним
  // выходит ниже на ~1 px, и ровная подпись «падала» бы в тесте; «Й», «Ё» — с надстрочным
  const CAP = /[A-ZА-ЯЁ0-9]/;
  const CAP_OK = /[A-IK-PR-ZА-ГЕЖ-ИК-ХЧШЪ-Я0-9]/;

  // родитель с переходом через границу тени
  const up = (n) => n.parentElement || n.getRootNode?.().host || null;
  const rectOf = (b) => [b.left, b.top, b.right, b.bottom];
  const name = (el) =>
    el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.classList.length ? "." + [...el.classList].slice(0, 3).join(".") : "");

  // рамка видна целиком: не обрезана прокруткой предков и окном
  function inside(r) {
    return (c) => r[0] >= c[0] - 0.5 && r[1] >= c[1] - 0.5 && r[2] <= c[2] + 0.5 && r[3] <= c[3] + 0.5;
  }
  function unclipped(el, r) {
    const ok = inside(r);
    if (!ok([0, 0, innerWidth, innerHeight])) return false;
    for (let a = up(el); a && a !== document.documentElement; a = up(a)) {
      const cs = getComputedStyle(a);
      if ((cs.overflowX !== "visible" || cs.overflowY !== "visible") && !ok(rectOf(a.getBoundingClientRect()))) return false;
    }
    return true;
  }
  // не накрыт ли элемент чем-то другим (липкая шапка, окно поверх страницы)
  function contains(a, b) {
    for (let n = b; n; n = up(n)) if (n === a) return true;
    return false;
  }
  function onTop(el, r) {
    if (getComputedStyle(el).pointerEvents === "none") return true;
    const x = (r[0] + r[2]) / 2, y = (r[1] + r[3]) / 2;
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const d = hit.shadowRoot.elementFromPoint(x, y);
      if (!d || d === hit) break;
      hit = d;
    }
    return !hit || contains(el, hit) || contains(hit, el);
  }
  // первая подпись: текстовый узел с заглавной/цифрой, не внутри вложенной кнопки
  function firstText(el, sel) {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!CAP_OK.test(n.textContent)) continue;
      const p = n.parentElement;
      if (p !== el && p.closest(sel) !== el) continue;
      if (p.closest("svg")) continue;
      if (!p.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      return n;
    }
    return null;
  }
  // всё видимое содержимое в одну строку?
  function oneLine(el) {
    const tops = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.textContent.trim() || n.parentElement.closest("svg")) continue;
      const rg = document.createRange();
      rg.selectNodeContents(n);
      for (const b of rg.getClientRects()) if (b.width > 0.5) tops.push(b.top + b.height / 2);
    }
    return !tops.length || Math.max(...tops) - Math.min(...tops) < 4;
  }
  // значок сбоку от заглавной — ближайший по горизонтали
  function iconBeside(el, c) {
    let best = null, bd = Infinity;
    for (const s of el.querySelectorAll("svg")) {
      if (s.parentElement.closest("svg")) continue;
      const b = s.getBoundingClientRect();
      if (b.width < 7 || b.height < 7) continue;
      if (!s.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const side = b.right <= c.left + 2 || b.left >= c.right - 2;
      const overlap = Math.min(b.bottom, c.bottom) - Math.max(b.top, c.top);
      if (!side || overlap <= 0) continue;
      const d = b.right <= c.left + 2 ? c.left - b.right : b.left - c.right;
      if (d < bd) (bd = d), (best = b);
    }
    return best && bd < 40 ? rectOf(best) : null;
  }

  window.__textAudit = (roots = [document], extraSel = "") => {
    const sel = extraSel ? SEL + ", " + extraSel : SEL;
    const out = [];
    const seen = new Set();
    const walk = (r) => {
      for (const el of r.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot);
      for (const el of r.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);
        const b = el.getBoundingClientRect();
        if (b.width < 8 || b.height < 12 || b.height > 64) continue;
        if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const tn = firstText(el, sel);
        if (!tn) continue;
        const i0 = tn.textContent.search(CAP_OK);
        const r1 = document.createRange();
        r1.setStart(tn, i0);
        r1.setEnd(tn, i0 + 1);
        const c = r1.getBoundingClientRect();
        if (c.width < 1) continue;
        const er = rectOf(b);
        if (!unclipped(el, er) || !onTop(el, rectOf(c))) continue;
        const cs = getComputedStyle(el);
        const bw = [parseFloat(cs.borderTopWidth) || 0, parseFloat(cs.borderBottomWidth) || 0];
        out.push({ el: name(el), text: el.textContent.trim().replace(/\s+/g, " ").slice(0, 32), er, bw, cr: rectOf(c), sr: iconBeside(el, c), multi: !oneLine(el) });
      }
    };
    for (const r of roots) if (r) walk(r);
    return out;
  };
})();
