// How a page looks, measured: at a phone's, a tablet's and a desktop's size, in light and in
// dark, nothing off the side, clipped, overlapping, too small to tap, unnamed or out of reach;
// and all its text readable against what is behind it in every theme the app has. Shared by
// the browser checks of the pages outside the app (checks/accounts/browser.mjs,
// checks/trips/browser.mjs).
//
//   const { layouts, readable } = looks({ t, shots });
//   await layouts(page, "what it is", "file-name");      // a still per size and scheme with --shots
//   await readable(page, "what it is");                   // each theme the app has

import path from "node:path";

// The narrowest phone still sold (an iPhone SE in its zoomed display), for the pages that hold it.
export const NARROW = { width: 320, height: 640, mobile: true };
export const PHONE = { width: 390, height: 844, mobile: true };
export const TABLET = { width: 820, height: 1180, mobile: true };
export const DESKTOP = { width: 1440, height: 900, mobile: false };
export const SIZES = [PHONE, TABLET, DESKTOP];
// Appearance's two looks besides System (Light; Dark, which is Void). The retired ones a phone may still have stored
// are read as these by each page's boot script (scripts/appearance_check.mjs).
export const THEMES = ["light", "void"];

export const HELPERS = `
  const shown = (el) => {
    if (el.closest("[hidden]")) return false;
    // A closed <details> keeps its content's boxes (::details-content) while showing none of it: not on the page to sweep.
    if (el.checkVisibility && !el.checkVisibility()) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const nameOf = (el) => (el.id ? "#" + el.id : el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).join(".") : ""))
    + (el.children.length === 0 && el.textContent.trim() ? ' "' + el.textContent.trim().slice(0, 28) + '"' : "");
  const everything = () => [...document.querySelector("main").querySelectorAll("*")].filter(shown);
`;

/** How the page is laid out right now: each list holds what is wrong, by name. */
export const LAYOUT = `(() => {
  ${HELPERS}
  const vw = document.documentElement.clientWidth;
  const out = { sideways: Math.max(0, document.documentElement.scrollWidth - vw), outside: [], clipped: [], small: [], overlapping: [], presses: [], unnamed: [], unreachable: [] };
  const all = everything();
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.left < -0.5 || r.right > vw + 0.5) out.outside.push(nameOf(el));
  }
  // With a modal dialog open, everything behind it is inert: only what is in the dialog can be
  // reached or tapped, so only that is held to it (the whole page is still held to its width).
  const modal = document.querySelector("dialog[open]");
  const controls = all.filter((el) => el.matches("button, a.btn, a.ds-button, input:not([type=hidden])") && (!modal || modal.contains(el)));
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    // What presses is the box, or the invisible area a control carries above and below it (a ::before, absolutely
    // placed: the kit's small button and the system's buttons are drawn under 44 and press at 44).
    const b = getComputedStyle(el, "::before");
    const area = b.content && b.content !== "none" && b.position === "absolute" ? Math.max(r.height, parseFloat(b.height) || 0) : r.height;
    if (area < 44 - 0.5) out.small.push(nameOf(el) + " is " + Math.round(area) + " high");
    const named = el.matches("input") ? (el.labels?.[0]?.textContent.trim() || el.getAttribute("aria-label")) : (el.getAttribute("aria-label") || el.textContent.trim());
    if (!named) out.unnamed.push(nameOf(el));
  }
  for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
    const a = controls[i].getBoundingClientRect(), b = controls[j].getBoundingClientRect();
    if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.overlapping.push(nameOf(controls[i]) + " over " + nameOf(controls[j]));
  }
  // No point is claimed by two controls' press areas: a control's band above and below it (its ::before, centred on it)
  // never reaches into a neighbour's, so a thumb between two lands on one of them, never on the wrong one. A control
  // inside another (a button in a row that is itself a link) is the other's own, not a neighbour.
  const pressOf = (el) => {
    const r = el.getBoundingClientRect(), b = getComputedStyle(el, "::before");
    const h = b.content && b.content !== "none" && b.position === "absolute" ? Math.max(r.height, parseFloat(b.height) || 0) : r.height;
    const mid = r.top + r.height / 2;
    return { left: r.left, right: r.right, top: mid - h / 2, bottom: mid + h / 2 };
  };
  const shownControls = controls.filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
  const presses = shownControls.map(pressOf);
  for (let i = 0; i < shownControls.length; i++) for (let j = i + 1; j < shownControls.length; j++) {
    if (shownControls[i].contains(shownControls[j]) || shownControls[j].contains(shownControls[i])) continue;
    const a = presses[i], b = presses[j];
    const sameBox = (x) => { const r = x.getBoundingClientRect(), q = pressOf(x); return q.top === r.top && q.bottom === r.bottom; };
    if (sameBox(shownControls[i]) && sameBox(shownControls[j])) continue;       // the boxes themselves: "overlapping" above
    if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.presses.push(nameOf(shownControls[i]) + " and " + nameOf(shownControls[j]) + " claim the same place");
  }
  for (const el of all.filter((el) => el.matches(".btn, .pill, label, h1, h2, .lg-msg, .ac-way-title, .ac-way-label, .banner"))) {
    // A heading there for a screen reader only (the system's .ds-visually-hidden: a 1 px box) is read whole, never seen.
    const r = el.getBoundingClientRect();
    if (r.width <= 1.5 && r.height <= 1.5) continue;
    if (getComputedStyle(el).display !== "inline" && el.scrollWidth > el.clientWidth + 1) out.clipped.push(nameOf(el));
  }
  // Everything can be brought fully into view.
  for (const el of controls) {
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    if (r.top < -0.5 || r.bottom > innerHeight + 0.5) out.unreachable.push(nameOf(el));
  }
  scrollTo(0, 0);
  for (const scroller of document.querySelectorAll(".lg-page")) scroller.scrollTop = 0;
  return out;
})()`;

/**
 * Every piece of text against what is behind it, as WCAG counts contrast: at least 4.5 to 1,
 * or 3 to 1 for large text (24px, or 18.66px bold). A control that is switched off is left out.
 * Returns the lowest ratio seen and whatever falls short.
 */
export const CONTRAST = `(() => {
  ${HELPERS}
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ink = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (color) => {
    ink.clearRect(0, 0, 1, 1); ink.fillStyle = color; ink.fillRect(0, 0, 1, 1);
    const d = ink.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]));
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const behind = (el) => {
    const chain = [];
    for (let n = el; n; n = n.parentElement) chain.unshift(n);
    let c = [255, 255, 255];
    for (const n of chain) c = over(rgba(getComputedStyle(n).backgroundColor), c);
    return c;
  };
  let lowest = 99;
  const short = new Map();
  for (const el of everything()) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (el.closest("[disabled]")) continue;
    const cs = getComputedStyle(el);
    const bg = behind(el);
    const fg = over(rgba(cs.color), bg);
    const a = lum(fg), b = lum(bg);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    lowest = Math.min(lowest, ratio);
    if (ratio < need) short.set(nameOf(el), ratio.toFixed(2) + " (needs " + need + ")");
  }
  return { lowest: Number(lowest.toFixed(2)), short: [...short].map(([k, v]) => k + " " + v) };
})()`;

export const empty = (o) => Object.entries(o).filter(([, v]) => (Array.isArray(v) ? v.length : v)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("; ") : v}`).join(" | ");

/** The two measurements, reporting to `t`, with stills in `shots` when it is given. */
export function looks({ t, shots }) {
/**
 * The layout of the page as it stands, at each size (the three, unless `sizes` says), in light
 * and in dark. `extra` is an expression the page answers with a list of what else is wrong
 * there (a page's own measurements), held in the same line.
 */
async function layouts(page, what, file, { sizes = SIZES, extra = null } = {}) {
  const was = { width: page.width };
  for (const size of sizes) {
    await page.size(size);
    for (const scheme of ["light", "dark"]) {
      await page.scheme(scheme);
      await page.rest();
      const found = await page.eval(LAYOUT);
      if (extra) found.also = await page.eval(extra);
      t.ok(`${what}, ${size.width} wide, ${scheme}: nothing off the side, clipped, overlapping, too small to tap, pressing where another does, unnamed or out of reach`, empty(found) === "", empty(found));
      if (shots && file) await page.shot(path.join(shots, `${file}-${size.width}-${scheme}.png`));
    }
  }
  await page.scheme("light");
  await page.size([NARROW, ...SIZES].find((s) => s.width === was.width) ?? PHONE);
}

async function readable(page, what) {
  await page.eval(`(() => { const s = document.createElement("style"); s.id = "check-still"; s.textContent = "*, *::before, *::after { transition: none !important; }"; document.head.append(s); })()`);
  // A frame between the two, or the browser sees no change at all and tells the page nothing.
  const repaint = async () => {
    await page.scheme("dark");
    await page.settle();
    await page.scheme("light");
    await page.settle();
  };
  const short = [];
  let lowest = 99;
  const families = [];
  for (const theme of THEMES) {
    await page.eval(`document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)})`);
    await repaint();
    families.push(await page.eval(`document.documentElement.getAttribute("data-lum")`));
    const found = await page.eval(CONTRAST);
    lowest = Math.min(lowest, found.lowest);
    for (const line of found.short) short.push(`${theme}: ${line}`);
  }
  await page.eval(`(() => { const r = document.documentElement; r.removeAttribute("data-theme"); document.getElementById("check-still")?.remove(); })()`);
  await repaint();
  t.same(`${what}: the page's own script takes each theme for light or dark as the app does`, families, ["light", "dark"]);
  t.ok(`${what}: all text is readable against what is behind it in ${THEMES.length} themes (lowest ${lowest} to 1)`,
    short.length === 0, `${short.length} short: ${short.join(" || ")}`);
}

  return { layouts, readable };
}
