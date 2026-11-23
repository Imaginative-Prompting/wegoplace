#!/usr/bin/env node
/* PLACES CHIPS — round 6: the default is no chip selected, not Basics selected,
 * and there needs to be a better indicator for which category chip is selected since it is
 * nearly impossible to tell that a chip is selected.
 *
 * The honest triggers: a real page load (default state) and a real touch tap on a chip
 * (Input.dispatchTouchEvent, the same event stream a thumb produces). No programmatic
 * .click(), no state injection.
 *
 * The honest measurement for "can a person tell" on a daltonized display: hue is
 * inadmissible. Every comparison here is done on LUMINANCE ONLY (the greyscale photograph
 * test) plus geometry (does the selected chip carry a mark the others do not). The shots are
 * also saved desaturated so a human can look at exactly what was measured.
 *
 *   node scripts/places_chips_check.js            (needs this lane's dev server, WGP_BASE)
 */
const H = require("./v5_verify.js");
const { ev, waitFor, tap, signInHost, tripPath, check, note, sleep, decodePNG } = H;
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SHOTS = path.join(H.REPO, "build", "places-chips");

let bootScript = null;
async function boot(c, theme) {
  await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable");
  // stale SW code is how the last round "verified" fixes that never ran
  await c.send("Network.setBypassServiceWorker", { bypass: true });
  await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  if (bootScript) await c.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: bootScript });
  bootScript = (await c.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try{localStorage.setItem('wgp.theme', ${JSON.stringify(theme)});}catch{}` })).identifier;
  await signInHost(c);
  await c.send("Page.navigate", { url: "about:blank" });
  await sleep(150);
  await c.send("Page.navigate", { url: H.ORIGIN + tripPath("#/places") });
  // A cold page under a loaded machine: the trip's whole state loads before Places draws (a 25 s wait gave up once, 21 Nov).
  await waitFor(c, `document.querySelectorAll('.pl-head .chip').length > 3 && document.querySelectorAll('.pl-row, .empty').length > 0`, 60000);
  const got = await waitFor(c, `(() => { const g = getComputedStyle(document.documentElement).getPropertyValue('--ground').trim();
    return g ? (parseInt(g.slice(1,3),16) > 128 ? 'light' : 'dark') : null; })()`);
  if (got !== theme) throw new Error(`asked for ${theme}, got ${got}`);
  await sleep(900);
}

// ── shots: full-colour clip of the chip rows, plus the same clip desaturated ──────────────
function greyPNG(im) {
  // Encode the decoded RGBA/RGB buffer back out as an 8-bit greyscale PNG (BT.709 luma —
  // the same weights the contrast measurements use, so the picture IS the measurement).
  const { w, h, ch, data } = im;
  const stride = w + 1;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * ch;
      raw[y * stride + 1 + x] = Math.round(0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]);
    }
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb) >>> 0);
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 8-bit greyscale
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let cc = n; for (let k = 0; k < 8; k++) cc = cc & 1 ? 0xedb88320 ^ (cc >>> 1) : cc >>> 1; CRC_T[n] = cc; }
  }
  let cc = -1;
  for (const b of buf) cc = CRC_T[(cc ^ b) & 255] ^ (cc >>> 8);
  return ~cc;
}
async function clipShot(c, name, clip) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const r = await c.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } });
  const buf = Buffer.from(r.data, "base64");
  fs.writeFileSync(path.join(SHOTS, name + ".png"), buf);
  const im = decodePNG(buf);
  fs.writeFileSync(path.join(SHOTS, name + "-grey.png"), greyPNG(im));
  return im;
}

const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

// The clip shot's device pixels per css px, DERIVED from the image rather than assumed:
// captureScreenshot's clip.scale COMPOUNDS with deviceScaleFactor (390css * 2 * 2 = 1560),
// and assuming 2 sampled the wrong quadrant of the image — every chip read as page ground
// and the first run of this script measured nothing. The image is the authority.
const sf = (im, clipW) => Math.round(im.w / clipW);

// Median interior ground of one chip inside a clip image (clip-relative rect, css px).
function chipGround(im, r, s) {
  const px = (x, y) => { const o = ((y * s) * im.w + (x * s)) * im.ch; return [im.data[o], im.data[o + 1], im.data[o + 2]]; };
  const ls = [];
  // sample a band across the chip's vertical middle, clear of the 2px edges
  for (let x = Math.round(r.x + 4); x < r.x + r.w - 4; x += 2) ls.push(px(x, Math.round(r.y + r.h / 2 + 6)));
  ls.sort((a, b) => lum(a) - lum(b));
  return ls[Math.floor(ls.length / 2)];
}

async function chipRects(c) {
  return ev(c, `[...document.querySelectorAll('.pl-head .chip-row[aria-label="Category"] .chip')].map(b => {
    const r = b.getBoundingClientRect();
    return { label: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') === 'true',
      x: r.x, y: r.y, w: r.width, h: r.height,
      hasMark: !!b.querySelector('.pl-check') }; })`);
}

async function run(c) {
  for (const theme of ["dark", "light"]) {
    await boot(c, theme);

    // ── 1 · DEFAULT: nothing selected ────────────────────────────────────────────────
    let chips = await chipRects(c);
    const pressed0 = chips.filter(k => k.pressed).map(k => k.label);
    check(`default · ${theme} · NO chip is pre-selected on arrival`, pressed0.length === 0,
      pressed0.length ? `pre-selected: ${pressed0.join(", ")}` : "0 pressed of " + chips.length);
    // and "nothing selected" must mean EVERYTHING, not an empty screen
    const rows0 = await ev(c, `document.querySelectorAll('.pl-row').length`);
    check(`default · ${theme} · empty selection shows the full list`, rows0 > 20, `${rows0} rows`);

    const head = await ev(c, `(() => { const r = document.querySelector('.pl-head').getBoundingClientRect();
      return { x: 0, y: Math.max(0, r.y), w: 390, h: Math.min(240, r.height + 8) }; })()`);
    const clip = { x: head.x, y: head.y, width: head.w, height: head.h };
    await clipShot(c, `chips-${theme}-default`, clip);

    // ── 2 · REAL TAP selects, and the state is legible WITHOUT hue ───────────────────
    // Tap the second visible category chip (not the first — its edge sits at the row's
    // bleed) with a real touch event at its centre.
    const target = chips[1];
    await tap(c, target.x + target.w / 2, target.y + target.h / 2);
    await sleep(700);          // sweep is 220ms; settle well past it
    chips = await chipRects(c);
    const on = chips.find(k => k.pressed);
    check(`tap · ${theme} · a real touch tap selects the chip`, !!on && on.label === target.label,
      on ? `"${on.label}" pressed` : "nothing pressed after tap");
    if (!on) continue;
    const im = await clipShot(c, `chips-${theme}-selected`, clip);

    // geometry: the selected chip carries a mark its siblings do not
    check(`tap · ${theme} · selected chip carries the check mark, siblings do not`,
      on.hasMark && chips.filter(k => !k.pressed).every(k => !k.hasMark),
      `mark on "${on.label}": ${on.hasMark}; marks on unselected: ${chips.filter(k => !k.pressed && k.hasMark).length}`);

    // pixels: greyscale-only separation between the selected chip's ground and every
    // unselected sibling's ground. 3:1 is the WCAG non-text floor; state carried by fill
    // density must clear it in pure luminance or it cannot be seen.
    const rel = (r) => ({ x: r.x - clip.x, y: r.y - clip.y, w: r.w, h: r.h });
    const S = sf(im, clip.width);
    const gOn = chipGround(im, rel(on), S);
    let worst = Infinity, worstLabel = "";
    for (const k of chips) {
      if (k.pressed || k.x < clip.x || k.x + k.w > clip.x + clip.width) continue;
      const cr = contrast(gOn, chipGround(im, rel(k), S));
      if (cr < worst) { worst = cr; worstLabel = k.label; }
    }
    check(`tap · ${theme} · selected ground vs unselected ground >= 3:1 in GREYSCALE`, worst >= 3,
      `worst ${worst.toFixed(2)}:1 (vs "${worstLabel}")`);

    // ink on the selected fill stays readable (>= 4.5:1 text minimum), measured in pixels
    const px = (x, y) => { const o = ((y * S) * im.w + (x * S)) * im.ch; return [im.data[o], im.data[o + 1], im.data[o + 2]]; };
    let best = 0;
    const or = rel(on);
    for (let x = Math.round(or.x + 4); x < or.x + or.w - 4; x++)
      for (let y = Math.round(or.y + 4); y < or.y + or.h - 4; y++) {
        const cr = contrast(px(x, y), gOn);
        if (cr > best) best = cr;
      }
    check(`tap · ${theme} · ink on the selected fill >= 4.5:1`, best >= 4.5, `${best.toFixed(2)}:1`);

    // §8: the tap target must still be 44px through the expander, chips visually small
    const tapH = await ev(c, `(() => { const b = document.querySelector('.pl-head .chip[aria-pressed="true"]');
      const cs = getComputedStyle(b, '::before'); return parseFloat(cs.height); })()`);
    check(`tap · ${theme} · §8 44px tap target survives`, tapH >= 44 - 0.5, `expander ${tapH}px`);
    const fs2 = await ev(c, `parseFloat(getComputedStyle(document.querySelector('.pl-head .chip .pl-cin')).fontSize)`);
    check(`tap · ${theme} · §8 12px font floor`, fs2 >= 12 - 0.01, `${fs2}px`);

    // ── 3 · REAL TAP deselects: back to everything ───────────────────────────────────
    const on2 = chips.find(k => k.pressed);
    await tap(c, on2.x + on2.w / 2, on2.y + on2.h / 2);
    await sleep(700);
    const after = await ev(c, `({ pressed: document.querySelectorAll('.pl-head .chip[aria-pressed="true"]').length,
      rows: [...document.querySelectorAll('.pl-row')].filter(r => getComputedStyle(r).position !== 'fixed').length })`);
    check(`tap · ${theme} · tapping again deselects back to all ${rows0} places`,
      after.pressed === 0 && after.rows === rows0, `${after.pressed} pressed, ${after.rows} rows`);
  }
  return H.results;
}

if (require.main === module) (async () => {
  const c = await H.launch();
  let code = 0;
  try { await run(c); } catch (e) { console.error("PLACES CHIPS THREW:", e.message); code = 2; }
  const bad = H.results.filter(r => !r.ok);
  console.log(`\nPLACES CHIPS: ${H.results.length - bad.length}/${H.results.length} pass  (shots in build/places-chips/)`);
  if (bad.length) { console.log("FAILURES:"); bad.forEach(b => console.log("  - " + b.name + " — " + b.detail)); code = code || 1; }
  await c.kill();
  process.exit(code);
})();
module.exports = { run };
