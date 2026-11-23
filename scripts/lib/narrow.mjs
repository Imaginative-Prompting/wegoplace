/* Small and sideways phones, measured the one way narrow_check and narrow_public_check both judge a screen by.
 *
 *   PHONES          320 x 568 (a status bar 20 above), 360 x 780, 844 x 390 on its side (the notch 47 at each
 *                   side, the home bar 21 below), 667 x 375 on its side (a smaller phone, no notch: narrower than
 *                   768, it has the rail too), 768 x 1024 (a tablet, its status bar 24 above, its home bar 20
 *                   below).
 *   setPhone()      the size and the safe areas, through Chrome's own override (env() can't be set from a script
 *                   or a stylesheet); readInsets() says what the page itself reads, so a check can refuse to judge
 *                   when the emulation isn't honest.
 *   judge()         one screen: nothing scrolls sideways (the page, or a box in it that scrolls up and down, as
 *                   a sheet's body or a page's column does); nothing read or tapped runs off the side (what a
 *                   row made to scroll sideways holds is its own); no words cut (past the box that clips them or
 *                   scrolls up and down, or clipped without an ellipsis, or a chip's symbol or words past the chip's
 *                   own edge); on its side no words and no control's
 *                   symbol under the notch (a row's ground may run there); nothing held to the screen (in nothing
 *                   that scrolls up and down: a bar, a rail, a sheet's foot) past its top or its foot, or under the
 *                   status bar or the home bar; no control under another or under a bar (two held to the screen
 *                   never overlap, and every control a person can see takes a tap at its middle, or can be scrolled
 *                   out from under what lies there; words, under what is held there, the same); controls met in
 *                   the order they are seen. The map's surface and Photos' board are other checks'.
 */
export const PHONES = [
  { w: 320, h: 568, insets: { top: 20, right: 0, bottom: 0, left: 0 }, name: "320" },
  { w: 360, h: 780, insets: { top: 0, right: 0, bottom: 0, left: 0 }, name: "360" },
  { w: 844, h: 390, insets: { top: 0, right: 47, bottom: 21, left: 47 }, name: "844x390 on its side" },
  { w: 667, h: 375, insets: { top: 0, right: 0, bottom: 0, left: 0 }, name: "667x375 on its side" },
  { w: 768, h: 1024, insets: { top: 24, right: 0, bottom: 20, left: 0 }, name: "768" },
];

export async function setPhone(cdp, S, ph) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: ph.w, height: ph.h, deviceScaleFactor: 2, mobile: true }, S);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: ph.insets }, S);
}

export const READ_INSETS = `JSON.stringify((() => { const d = document.createElement("div");
  d.style.cssText = "position:fixed;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.append(d); const s = getComputedStyle(d); const r = [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(parseFloat);
  d.remove(); return r; })())`;

// What a screen shows past its edges. Read in the page; every box in CSS pixels of the layout viewport.
export const MEASURE = (ins) => `(() => {
  const W = document.documentElement.clientWidth, H = document.documentElement.clientHeight, ins = ${JSON.stringify(ins)};
  const SKIP = ".mp-surface, .cg-stage, .cg-board";
  // Hidden, or there for a screen reader only (a 1 px box, clipped to nothing). checkVisibility() also knows what the
  // browser keeps but doesn't draw: what a closed <details> holds still has a box, under whatever is drawn there.
  const shown = (n) => { if (n.checkVisibility && !n.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    for (let e = n; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0 || e.inert || e.hidden) return false;
    if (cs.clipPath.startsWith("inset(50%") || /rect\\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\\)/.test(cs.clip)) return false;
    const q = e.getBoundingClientRect(); if (q.width <= 1.5 && q.height <= 1.5 && cs.overflow !== "visible") return false; } return true; };
  // A box made to scroll sideways: a row of chips or days (a flex row that doesn't wrap), a box that scrolls
  // sideways only, or preformatted text. CSS computes overflow-x to auto on a box that scrolls up and down
  // (overflow-y: auto with overflow-x left visible), so overflow-x alone would take every sheet's body and
  // every page column for one, and nothing inside them would be judged.
  const sideways = (e) => { const cs = getComputedStyle(e);
    if (!/(auto|scroll)/.test(cs.overflowX)) return false;
    if (/(hidden|clip)/.test(cs.overflowY) || e.tagName === "PRE") return true;
    return /flex/.test(cs.display) && !/column/.test(cs.flexDirection) && cs.flexWrap === "nowrap"; };
  // Any other box that doesn't let its content out at the sides: one that clips, or one that scrolls up and down.
  const clips = (e) => { const cs = getComputedStyle(e); return /(hidden|clip)/.test(cs.overflowX) || (/(auto|scroll)/.test(cs.overflowX) && !sideways(e)); };
  const upDown = (e) => { const cs = getComputedStyle(e); return /(auto|scroll)/.test(cs.overflowX) && !sideways(e); };
  const name = (n) => n.tagName.toLowerCase() + (typeof n.className === "string" && n.className.trim() ? "." + n.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
  const said = (n) => (n.innerText || n.getAttribute("aria-label") || n.value || n.placeholder || "").replace(/\\s+/g, " ").trim().slice(0, 50);
  const ownText = (n) => [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
  const control = (n) => n.matches("a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=link], [tabindex]:not([tabindex='-1'])");
  // Held to the screen: inside nothing that scrolls up and down (whatever it does at the sides: a page's column clips
  // there), and either the page doesn't scroll or the box is fixed to the screen (a sticky head is held only while
  // stuck, and one further down the page isn't yet).
  // A page that scrolls is one meant to (its body and root let it): an app whose body is overflow: hidden scrolls only
  // inside its column, and its own fault (a rail past the foot) makes the root a few pixels taller without making it
  // a page to scroll.
  const meantToScroll = (e) => !/(hidden|clip)/.test(getComputedStyle(e).overflowY);
  const pageScrolls = meantToScroll(document.body) && meantToScroll(document.documentElement) && document.scrollingElement.scrollHeight > H + 0.5;
  const held = (n) => { for (let a = n.parentElement; a && a !== document.documentElement; a = a.parentElement) if (/(auto|scroll)/.test(getComputedStyle(a).overflowY)) return false;
    if (!pageScrolls) return true;
    for (let e = n; e && e !== document.documentElement; e = e.parentElement) if (getComputedStyle(e).position === "fixed") return true;
    return false; };
  const off = [], cut = [], notch = [], inner = [], foot = [], words = [];
  for (const n of document.querySelectorAll("body *")) {
    if (n.closest(SKIP) || n.closest("svg") && n.tagName !== "svg") continue;
    // A box that scrolls up and down must not also scroll sideways: what is wider than it is cut at its side.
    if (upDown(n) && n.scrollWidth > n.clientWidth + 1 && shown(n)) inner.push({ el: name(n), over: n.scrollWidth - n.clientWidth, said: said(n).slice(0, 30) });
    if (!(ownText(n) || control(n))) continue;
    const r = n.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || !shown(n)) continue;
    // The visible part: inside every clipping ancestor up to a scroller (a scroller's content is its own).
    let L = r.left, R = r.right, inScroller = false, clipper = null;
    for (let a = n.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      if (sideways(a)) { inScroller = a; break; }
      if (clips(a)) { const c = a.getBoundingClientRect(); if (r.left < c.left - 0.5 || r.right > c.right + 0.5) clipper = clipper || a; L = Math.max(L, c.left); R = Math.min(R, c.right); }
    }
    if (inScroller) { const c = inScroller.getBoundingClientRect(); if (c.right > W + 0.5 || c.left < -0.5) off.push({ el: name(inScroller), box: [Math.round(c.left), Math.round(c.right)], said: said(inScroller) }); continue; }
    if (R > W + 0.5 || L < -0.5) off.push({ el: name(n), box: [Math.round(r.left), Math.round(r.right)], said: said(n) });
    else if (clipper && R > L) cut.push({ el: name(n), box: [Math.round(r.left), Math.round(r.right)], by: name(clipper), said: said(n) });
    const cs = getComputedStyle(n);
    // (A box that scrolls up and down is reported above, as scrolling sideways, not again here.)
    if (clips(n) && !upDown(n) && n.scrollWidth > n.clientWidth + 1 && cs.textOverflow !== "ellipsis" && ownText(n)) cut.push({ el: name(n), over: n.scrollWidth - n.clientWidth, said: said(n) });
    if (R > L) {
      // What is drawn: the words' own boxes and a control's symbols, not a row's ground.
      let lo = Infinity, hi = -Infinity, top = Infinity, bot = -Infinity;
      const take = (q) => { lo = Math.min(lo, q.left); hi = Math.max(hi, q.right); top = Math.min(top, q.top); bot = Math.max(bot, q.bottom); };
      const rg = document.createRange();
      for (const c of n.childNodes) if (c.nodeType === 3 && c.textContent.trim()) { rg.selectNodeContents(c); for (const q of rg.getClientRects()) take(q); }
      if (control(n)) for (const g of n.querySelectorAll("svg, img")) { const q = g.getBoundingClientRect(); if (q.width >= 1 && shown(g)) take(q); }
      if ((ins.left || ins.right) && hi > lo && (lo < ins.left - 0.5 || hi > W - ins.right + 0.5)) notch.push({ el: name(n), box: [Math.round(lo), Math.round(hi)], said: said(n) });
      // (A bar slid wholly off the screen, as the tab bar does while a list scrolls down, is put away, not past the foot.)
      if (bot > top && bot > 0 && top < H && (top < ins.top - 0.5 || bot > H - ins.bottom + 0.5) && held(n)) foot.push({ el: name(n), box: [Math.round(top), Math.round(bot)], said: said(n) });
      if (!control(n) && ownText(n) && hi > lo && bot > top) words.push({ n, v: { L: Math.max(lo, 0), R: Math.min(hi, W), T: Math.max(top, 0), B: Math.min(bot, H) } });
    }
  }
  // Every control a person can see, and the part of it they can see: inside every box that clips or scrolls, and the
  // screen. A sheet or a dialog lies over the page by design, so what it covers is not judged.
  const seen = (n) => { const r = n.getBoundingClientRect(); let L = r.left, R = r.right, T = r.top, B = r.bottom;
    for (let a = n.parentElement; a && a !== document.documentElement; a = a.parentElement) { const cs = getComputedStyle(a);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") { const c = a.getBoundingClientRect(); L = Math.max(L, c.left); R = Math.min(R, c.right); T = Math.max(T, c.top); B = Math.min(B, c.bottom); } }
    L = Math.max(L, 0); R = Math.min(R, W); T = Math.max(T, 0); B = Math.min(B, H);
    return R - L >= 4 && B - T >= 4 ? { L, R, T, B } : null; };
  const MODAL = '[aria-modal="true"], dialog[open], .sh-root[data-open="1"]';
  const controls = [...document.querySelectorAll("body *")].filter((n) => control(n) && !n.closest(SKIP) && !n.closest("svg") && shown(n))
    .map((n) => ({ n, v: seen(n) })).filter((x) => x.v);
  // A page that is an ordinary document (Your account, a trip's people, the legal pages) scrolls the document itself:
  // its scroller is the page's, so a Back held at its foot is one the page scrolls out from under (21 Nov, page-back.js).
  const scrollerOf = (n) => { for (let a = n.parentElement; a && a !== document.documentElement; a = a.parentElement)
    if (/(auto|scroll)/.test(getComputedStyle(a).overflowY) && a.scrollHeight > a.clientHeight + 1) return a;
    const d = document.scrollingElement; return d && d.scrollHeight > d.clientHeight + 1 && getComputedStyle(document.body).overflowY !== "hidden" ? d : null; };
  const R4 = (v) => [v.L, v.T, v.R, v.B].map(Math.round);
  const over = [];
  // Two held to the screen (a bar's, the rail's) that overlap lie one on the other however the page is scrolled.
  const pinned = controls.filter((x) => held(x.n));
  for (let i = 0; i < pinned.length; i++) for (let j = i + 1; j < pinned.length; j++) {
    const a = pinned[i], b = pinned[j];
    if (a.n.contains(b.n) || b.n.contains(a.n)) continue;
    // One whose box holds the other's whole is a surface with a control floating on it (a board's zoom buttons).
    const inside = (p, q) => q.L >= p.L - 0.5 && q.R <= p.R + 0.5 && q.T >= p.T - 0.5 && q.B <= p.B + 0.5;
    if (inside(a.v, b.v) || inside(b.v, a.v)) continue;
    const w = Math.min(a.v.R, b.v.R) - Math.max(a.v.L, b.v.L), h = Math.min(a.v.B, b.v.B) - Math.max(a.v.T, b.v.T);
    if (w > 2 && h > 2) over.push({ el: name(a.n) + " and " + name(b.n), box: [Math.round(w), Math.round(h)], said: said(a.n) + " / " + said(b.n) });
  }
  // A tap at a control's middle reaches it, unless what lies there is held to the screen and the control's own scroller
  // can still bring it out from under (a list's last row under the floating +, with room to scroll past it). Words the
  // same, but only under what is held to the screen (a bar, the +): a row's amount under the + is read nowhere else.
  for (const { n, v, isWords } of [...controls, ...words.filter((w) => w.v.R - w.v.L >= 4 && w.v.B - w.v.T >= 4).map((w) => ({ ...w, isWords: true }))]) {
    const x = (v.L + v.R) / 2, y = (v.T + v.B) / 2, hit = document.elementFromPoint(x, y);
    // A box that takes no pointer at all (pointer-events: none: a hint drawn over a board, a disabled look) is never
    // what a tap reaches, so a tap at its middle says nothing about it.
    if (getComputedStyle(n).pointerEvents === "none") continue;
    // What lies at the middle is the control, or something in it. An ancestor there means one of its own boxes or
    // overlays (a card's ::after) is drawn over the control.
    if (!hit || n.contains(hit)) continue;
    // Words sit inside what holds them (a link's, a sheet's box): for words the box they are in is no cover.
    if (isWords && hit.contains(n)) continue;
    // A link that wraps onto a second line has a box whose middle can fall between its two pieces: tap its first piece.
    if (hit.contains(n) && n.getClientRects().length > 1) { const q = n.getClientRects()[0], h2 = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); if (h2 && n.contains(h2)) continue; }
    if (hit.closest(MODAL) && hit.closest(MODAL) !== n.closest(MODAL)) continue;
    let top = hit; while (top.parentElement && top.parentElement !== document.body && !top.parentElement.contains(n)) top = top.parentElement;
    // Held to the screen: outside the control's scroller and held there, or fixed to the screen wherever it stands in
    // the page (a floating + kept inside the page's column). A fixed box that holds the control too (a sheet's root)
    // moves with it, so it is no cover: what covers is inside it (a foot stuck to the bottom of the sheet's body).
    let pin = null; for (let e = hit; e && e !== document.body; e = e.parentElement) if (getComputedStyle(e).position === "fixed" && !e.contains(n)) { pin = e; break; }
    const sc = scrollerOf(n);
    // A head stuck at the top of the scroller (a day's or a section's) covers what scrolls up under it by design: the
    // scroller brings it out again the other way, as from under a bar.
    let stuck = null; if (sc) for (let e = hit; e && e !== sc; e = e.parentElement) if (getComputedStyle(e).position === "sticky") { stuck = e; break; }
    const cover = pin || stuck || top, c = cover.getBoundingClientRect();
    if (isWords && !(pin || stuck || held(top))) continue;
    if (sc && (pin || stuck || (!sc.contains(top) && held(top)))) {
      // Which way out: a bar in the screen's lower half is at its foot (scroll the control up past it), one in the
      // upper half at its head.
      const r = n.getBoundingClientRect(), atFoot = (c.top + c.bottom) / 2 > H / 2, need = atFoot ? r.bottom - c.top + 1 : c.bottom - r.top + 1;
      const room = atFoot ? sc.scrollHeight - sc.clientHeight - sc.scrollTop : sc.scrollTop;
      if (room >= need) continue;
    }
    over.push({ el: (isWords ? "words " : "") + name(n) + " under " + name(cover), box: R4(v), said: said(n) });
  }
  // Met in the order they are seen: a row or a column of controls laid out reversed, or reordered with order:, is met
  // by the keyboard and read out the other way round from the way the eye reads it.
  const order = [];
  for (const e of document.querySelectorAll("body *")) {
    if (e.closest(SKIP) || e.closest("svg")) continue;
    const cs = getComputedStyle(e); if (!/(flex|grid)/.test(cs.display)) continue;
    const kids = [...e.children].filter((k) => shown(k) && (control(k) || k.querySelector("a[href], button, input:not([type=hidden]), select, textarea")));
    if (kids.length < 2 || !shown(e)) continue;
    if (/reverse/.test(cs.flexDirection) || kids.some((k) => getComputedStyle(k).order !== "0")) order.push({ el: name(e), box: R4(seen(e) || { L: 0, T: 0, R: 0, B: 0 }), said: kids.map((k) => said(k).slice(0, 16)).join(" / ") });
  }
  // A CHIP KEEPS ITS SYMBOL AND WORDS INSIDE ITSELF (20 Nov, seen on an iPhone: a kind's symbol and name ran out of its
  // chip): a chip squeezed under what it holds lets it run past its edge, clipped by nothing.
  for (const c of document.querySelectorAll(".chip, .ds-chip")) {
    if (c.closest(SKIP) || !shown(c) || /(auto|scroll)/.test(getComputedStyle(c).overflowX)) continue;
    const r = c.getBoundingClientRect();
    for (const k of c.querySelectorAll("*")) {
      if (k.closest("svg") && k.tagName !== "svg" || !shown(k) || /(absolute|fixed)/.test(getComputedStyle(k).position)) continue;
      const q = k.getBoundingClientRect();
      if (q.width < 1) continue;
      const over = Math.max(q.right - r.right, r.left - q.left);
      if (over > 0.5) { cut.push({ el: name(c), over: Math.round(over), said: said(c) + " (" + k.tagName.toLowerCase() + " past its edge)" }); break; }
    }
  }
  const once = (list) => { const seen = new Set(); return list.filter((x) => { const k = x.el + x.box + x.said; if (seen.has(k)) return false; seen.add(k); return true; }); };
  return { W, H, foot: once(foot), over: once(over), order: once(order), sideways: document.scrollingElement.scrollWidth > W + 0.5 ? document.scrollingElement.scrollWidth : 0, inner: once(inner), off: once(off), cut: once(cut), notch: once(notch) };
})()`;

/** Reads one screen and records its checks. `page` evaluates an expression and returns its value; `shot`, when a
 *  check gives one (NARROW_SHOTS, through the stills queue only), saves the screen when any of its verdicts is red. */
export async function judge(page, check, ph, screen, shot) {
  const m = JSON.parse(await page(`JSON.stringify(${MEASURE(ph.insets)})`));
  if (shot && (m.sideways || m.inner.length || m.off.length || m.cut.length || m.notch.length || m.foot.length || m.over.length || m.order.length)) await shot(`${ph.name} ${screen}`);
  const list = (k) => m[k].map((x) => `${x.el} [${x.box || "+" + x.over}]${x.by ? " in " + x.by : ""} "${x.said}"`).join("; ");
  check(`${ph.name}, ${screen}: nothing scrolls sideways (the page, or a box in it that scrolls up and down)`, !m.sideways && m.inner.length === 0,
    [m.sideways ? `the page ${m.sideways} wide in ${m.W}` : "", list("inner")].filter(Boolean).join("; "));
  check(`${ph.name}, ${screen}: nothing runs off the side`, m.off.length === 0, list("off"));
  check(`${ph.name}, ${screen}: no words cut`, m.cut.length === 0, list("cut"));
  if (ph.insets.left || ph.insets.right) check(`${ph.name}, ${screen}: no words or control under the notch`, m.notch.length === 0, list("notch"));
  check(`${ph.name}, ${screen}: nothing held to the screen past its top or foot, or under the status bar or home bar`, m.foot.length === 0, list("foot"));
  check(`${ph.name}, ${screen}: no control under another or under a bar, and no words under a bar (each takes a tap at its middle, or scrolls out from under)`, m.over.length === 0, list("over"));
  check(`${ph.name}, ${screen}: controls met in the order they are seen (no reversed row or column of them, no order:)`, m.order.length === 0, list("order"));
}

/** Whether the page reads the safe areas it was given; records the check and says whether to go on. */
export async function insetsHonest(page, check, ph) {
  const read = JSON.parse(await page(READ_INSETS));
  const want = [ph.insets.top, ph.insets.right, ph.insets.bottom, ph.insets.left];
  const ok = JSON.stringify(read) === JSON.stringify(want);
  check(`${ph.name}: the page reads the safe areas given`, ok, `${read} (given ${want})`);
  return ok;
}
