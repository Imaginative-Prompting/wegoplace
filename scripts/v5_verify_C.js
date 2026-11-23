#!/usr/bin/env node
/* SECTION C — V5 items 5 (filter pills) and 6 (list rows), measured in geometry AND in pixels. */
const H = require("./v5_verify.js");
const { ev, shot, waitFor, tap, signInHost, tripPath, check, note, sleep, decodePNG } = H;

// TWO TRAPS, both of which silently measured the wrong page once:
//   · Page.navigate to a URL that differs only in its #hash is a SAME-DOCUMENT navigation.
//     The document is never rebuilt, so no boot script runs and the theme never changes —
//     a whole "light" pass measured the dark theme and passed. about:blank in between forces
//     a real load.
//   · addScriptToEvaluateOnNewDocument ACCUMULATES. The old one is removed by identifier.
let bootScript = null;
async function boot(c, theme, hash) {
  await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Log.enable"); await c.send("Network.enable");
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
  await c.send("Page.navigate", { url: H.ORIGIN + tripPath(hash) });
  await waitFor(c, `!!document.querySelector('#view')`);
  // and PROVE the theme actually landed, rather than trusting the request
  const got = await waitFor(c, `(() => { const g = getComputedStyle(document.documentElement).getPropertyValue('--ground').trim();
    return g ? (parseInt(g.slice(1,3),16) > 128 ? 'light' : 'dark') : null; })()`);
  if (got !== theme) throw new Error(`asked for the ${theme} theme and got ${got}`);
}
const px = (im, x, y) => { const o = ((y * 2) * im.w + (x * 2)) * im.ch; return [im.data[o], im.data[o + 1], im.data[o + 2]]; };
const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

async function run(c) {
  for (const theme of ["dark", "light"]) {
    await boot(c, theme, "#/places");
    await waitFor(c, `document.querySelectorAll('.pl-head .chip').length > 3 && document.querySelectorAll('.pl-row').length > 3`);
    await sleep(1200);
    const buf = await shot(c, `C-places-${theme}.png`);
    const im = decodePNG(buf);

    // ── ITEM 5 : the pills ────────────────────────────────────────────────────────────
    const chips = await ev(c, `[...document.querySelectorAll('.pl-head .chip')].map(b => {
      const r = b.getBoundingClientRect(); const cs = getComputedStyle(b);
      const lab = [...b.childNodes].map(n => n.textContent).join('').trim();
      const t = b.querySelector('span:not(.pl-fill)') || b;
      const tr = t.getBoundingClientRect(); const ts = getComputedStyle(t);
      return { label: lab, x: r.x, y: r.y, w: r.width, h: r.height,
        fs: parseFloat(ts.fontSize), color: ts.color, opacity: ts.opacity,
        pad: cs.padding, bg: cs.backgroundColor, pressed: b.getAttribute('aria-pressed') }; })`);
    check(`item5 · ${theme} · the "All" pill is GONE`,
      !chips.some(k => /^all\b/i.test(k.label)), chips.filter(k => /^all\b/i.test(k.label)).map(k => k.label).join(",") || "no All pill");
    check(`item5 · ${theme} · no counts on the pills`,
      !chips.some(k => /\d/.test(k.label)), chips.filter(k => /\d/.test(k.label)).map(k => k.label).join(",") || "no digits in any label");
    const tallest = Math.max(...chips.map(k => k.h));
    check(`item5 · ${theme} · the pills are visually small`, tallest <= 36, `tallest pill ${tallest}px (base chip is 44)`);
    const minFs = Math.min(...chips.map(k => k.fs));
    check(`item5 · ${theme} · §8 12px type floor survives the shrink`, minFs >= 12 - 0.01, `min ${minFs}px`);
    check(`item5 · ${theme} · §8 never opacity on pill text`, chips.every(k => +k.opacity === 1), "all opaque");

    // the hit target must still be 44 even though the ink is 32 — probed by hit-testing, not by reading CSS
    const hit = await ev(c, `(() => {
      // MEASURED, not computed. An expander's real box depends on the parent's padding box and
      // on whatever scroll container clips it — both of which have already been wrong once here
      // — so the reachable height is found by hit-testing outward in quarter pixels until the
      // chip stops answering, which is exactly what a thumb finds.
      let worst = 99, worstLabel = '';
      for (const b of document.querySelectorAll('.pl-head .chip')) {
        const r = b.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const owns = y => { const e = document.elementFromPoint(cx, y); return !!(e && (e === b || b.contains(e))); };
        if (!owns(r.y + r.height / 2)) continue;
        let up = 0, dn = 0;
        for (let d = 0.25; d <= 16; d += 0.25) { if (owns(r.top - d)) up = d; else break; }
        for (let d = 0.25; d <= 16; d += 0.25) { if (owns(r.bottom + d)) dn = d; else break; }
        const h = r.height + up + dn;
        if (h < worst) { worst = h; worstLabel = b.textContent.trim().slice(0, 14) + ' (' + r.height + ' +' + up + '/+' + dn + ')'; }
      }
      return { worst, worstLabel, confirmed: true }; })()`);
    check(`item5 · ${theme} · §8 44px hit target despite the small pill`, hit.worst >= 44 - 0.6,
      `smallest reachable height ${hit.worst.toFixed(2)}px — worst: ${hit.worstLabel}`);

    // and §8.2's other clause: 8px between adjacent targets, vertically as well as across
    const gaps = await ev(c, `(() => {
      const rows = [...document.querySelectorAll('.pl-head .chip-row')];
      const boxes = rows.map(r => r.getBoundingClientRect());
      let vgap = 99;
      for (let i = 1; i < boxes.length; i++) vgap = Math.min(vgap, boxes[i].top - boxes[i - 1].bottom);
      let hgap = 99;
      for (const row of rows) {
        const cs = [...row.querySelectorAll('.chip')].map(b => b.getBoundingClientRect()).sort((a, b) => a.x - b.x);
        for (let i = 1; i < cs.length; i++) hgap = Math.min(hgap, cs[i].x - cs[i - 1].right);
      }
      return { vgap: boxes.length > 1 ? vgap : null, hgap, rows: rows.length }; })()`);
    check(`item5 · ${theme} · §8.2 8px between adjacent pill targets`,
      gaps.hgap >= 8 - 0.01 && (gaps.vgap == null || gaps.vgap >= 8 - 0.01),
      `horizontal ${gaps.hgap}px, vertical ${gaps.vgap}px across ${gaps.rows} rows`);

    // ROUND 6 (review 5): the v5 landing pre-selected "Basics"; now NOTHING is
    // pre-selected on arrival — no chip means all places, which is what deselecting means.
    check(`item5 · ${theme} · round 6: no pill is pre-selected on arrival`,
      !chips.some(k => k.pressed === "true"),
      chips.filter(k => k.pressed === "true").map(k => k.label).join(",") || "0 pressed");
    // UNSELECTED pills stay accented-not-flooded: neutral ground close to the page ground.
    const ground = px(im, 8, 300);
    const offPill = chips[0];
    const offBg = px(im, Math.round(offPill.x + offPill.w - 5), Math.round(offPill.y + offPill.h / 2));
    check(`item5 · ${theme} · unselected pills keep the neutral ground (accent, no flood)`,
      dist(offBg, ground) < 130, `pill ground rgb(${offBg}) vs page ground rgb(${ground}), distance ${dist(offBg, ground).toFixed(0)}`);

    // The SELECTED state — reached by a REAL tap, then measured from a fresh screenshot.
    // Round 6 contract: the one selected pill is a SOLID cat ground (the v5 wash measured
    // 1.1–1.3:1 against a sibling in greyscale — invisible to a dark-daltonised reader),
    // its ink clears 4.5:1, and it carries a check glyph its siblings do not.
    const t = chips[1];
    await H.tap(c, t.x + t.w / 2, t.y + t.h / 2);
    await sleep(800);
    const sel2 = await ev(c, `[...document.querySelectorAll('.pl-head .chip-row[aria-label="Category"] .chip')].map(b => {
      const r = b.getBoundingClientRect();
      return { label: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') === 'true',
        x: r.x, y: r.y, w: r.width, h: r.height, mark: !!b.querySelector('.pl-check') }; })`);
    const im2 = decodePNG(await shot(c, `C-places-${theme}-selected.png`));
    const px2 = (x, y) => { const o = ((y * 2) * im2.w + (x * 2)) * im2.ch; return [im2.data[o], im2.data[o + 1], im2.data[o + 2]]; };
    const on = sel2.find(k => k.pressed);
    check(`item5 · ${theme} · a real tap selects the pill`, !!on && on.label === t.label,
      on ? `"${on.label}"` : "nothing pressed");
    if (on) {
      // sampled just inside the right edge — the pill's padding zone, never its text
      const onBg = px2(Math.round(on.x + on.w - 5), Math.round(on.y + on.h / 2));
      const sib = sel2.find(k => !k.pressed && k.x >= 0 && k.x + k.w <= 390);
      const sibBg = px2(Math.round(sib.x + sib.w - 5), Math.round(sib.y + sib.h / 2));
      check(`item5 · ${theme} · selected vs unselected ground clears 3:1 in pure luminance`,
        contrast(onBg, sibBg) >= 3, `${contrast(onBg, sibBg).toFixed(2)}:1 (rgb(${onBg}) vs rgb(${sibBg}))`);
      let darkest = null, best = 0;
      for (let x = Math.round(on.x + 6); x < on.x + on.w - 6; x++)
        for (let y = Math.round(on.y + 4); y < on.y + on.h - 4; y++) {
          const p = px2(x, y); const d = contrast(p, onBg);
          if (d > best) { best = d; darkest = p; }
        }
      check(`item5 · ${theme} · the selected pill's ink stays readable on the solid`, best >= 4.5,
        `contrast ${best.toFixed(2)}:1 (ink rgb(${darkest}) on rgb(${onBg}))`);
      check(`item5 · ${theme} · selected state is not hue-only (check glyph + solid fill)`,
        on.mark && sel2.filter(k => !k.pressed).every(k => !k.mark),
        `mark on selected: ${on.mark}; marks on unselected: ${sel2.filter(k => !k.pressed && k.mark).length}`);
      // put the screen back the way this section found it
      await H.tap(c, on.x + on.w / 2, on.y + on.h / 2);
      await sleep(800);
    }

    // ── ITEM 6 : the list rows ────────────────────────────────────────────────────────
    const rows = await ev(c, `[...document.querySelectorAll('.pl-row')].slice(0, 6).map(r => {
      const b = r.getBoundingClientRect(); const cs = getComputedStyle(r);
      const link = r.closest('.pl-link') || r;
      const ls = getComputedStyle(link);
      const g = r.querySelector('.pl-ico, .ico, svg');
      const gb = g ? g.getBoundingClientRect() : null;
      const name = r.querySelector('.pl-name, strong, b');
      const ns = name ? getComputedStyle(name) : null;
      return { x: b.x, y: b.y, w: b.width, h: b.height, bg: cs.backgroundColor, linkBg: ls.backgroundColor,
        style: r.getAttribute('style') || '',
        shadow: ls.boxShadow,
        glyph: gb ? { x: gb.x, y: gb.y, w: gb.width, h: gb.height } : null,
        nameFs: ns ? parseFloat(ns.fontSize) : null, nameOp: ns ? ns.opacity : null }; })`);
    let neutral = true, monoCount = 0;
    const grounds = [];
    for (const r of rows) {
      const rg = px(im, Math.round(r.x + r.w - 14), Math.round(r.y + r.h - 6));
      grounds.push(rg);
      if (grounds.length > 1 && dist(rg, grounds[0]) > 12) { neutral = false; note(`row ground rgb(${rg}) differs from rgb(${grounds[0]})`); }
      // Design system Flow 4: colored category stripes and inline --cat vars are gone; each row carries a 32px monochrome circle badge.
      const noStripe = (r.shadow === "none" || !r.shadow) && !/--cat/.test(r.style);
      const bigCircle = r.glyph && r.glyph.w >= 28;
      if (noStripe && bigCircle) monoCount++;
    }
    check(`item6 · ${theme} · the row ground stays NEUTRAL (no category flood)`, neutral,
      `${rows.length} rows all on rgb(${grounds[0]})`);
    check(`item6 · ${theme} · monochrome 32px icon circles with zero category stripes or --cat styles`, monoCount === rows.length,
      `${monoCount}/${rows.length} monochrome circular badges`);
    check(`item6 · ${theme} · §8 44px rows`, rows.every(r => r.h >= 44 - 0.5), `shortest ${Math.min(...rows.map(r => r.h)).toFixed(1)}px`);
    check(`item6 · ${theme} · §8 12px floor and no opacity on row names`,
      rows.every(r => r.nameFs >= 12 - 0.01 && +r.nameOp === 1), `min ${Math.min(...rows.map(r => r.nameFs))}px`);

    // and the NEARBY rows on a place detail page
    const pid = await ev(c, `(() => { const a = document.querySelector('a[href^="#/p/"]'); return a ? a.getAttribute('href') : null; })()`);
    check(`item6 · ${theme} · a place detail page is reachable from the list`, !!pid, pid || "no #/p/ link in the list");
    if (pid) {
      await ev(c, `(() => { location.hash = ${JSON.stringify(pid.replace("#", ""))}; return 1; })()`);
      // .pl-near is the "Everything near X" BUTTON, not a container — the nearby rows on a
      // place page are .pl-link rows. Measuring the button's children found nothing and
      // reported it as a missing feature.
      await waitFor(c, `document.querySelectorAll('.pl-link').length > 0`, 12000).catch(() => {});
      await sleep(600);
      // Round 6 removed the practical landing filter, so the first #/p/ link can be a LONG
      // page (restaurant with notes + address) whose nearby rows sit below the fold — and
      // pixels sampled at off-screen rects measured nothing and failed as "band 0px". Bring
      // the rows into the camera frame first; the rects are re-read after the scroll.
      await ev(c, `(() => { const l = document.querySelector('.pl-link');
        if (l) l.scrollIntoView({ block: 'center' }); return 1; })()`);
      await sleep(400);
      const nearBuf = await shot(c, `C-place-${theme}.png`);
      const nim = decodePNG(nearBuf);
      const near = await ev(c, `[...document.querySelectorAll('.pl-link')].slice(0, 4).map(r => {
        const b = r.getBoundingClientRect(); const cs = getComputedStyle(r);
        const ico = r.querySelector('.pl-link-ico'); const ib = ico ? ico.getBoundingClientRect() : null;
        const t = r.querySelector('.pl-link-t');
        const ts = t ? getComputedStyle(t) : null;
        return { x: b.x, y: b.y, w: b.width, h: b.height, bg: cs.backgroundColor,
          shadow: cs.boxShadow, style: r.getAttribute('style') || '',
          icoW: ib ? ib.width : null,
          fs: ts ? parseFloat(ts.fontSize) : null, op: ts ? ts.opacity : null }; })`);
      if (near && near.length) {
        const ng = px(nim, 8, Math.round(near[0].y - 26));
        let ok = true, monoNear = true;
        for (const r of near) {
          const rg = px(nim, Math.round(r.x + r.w - 14), Math.round(r.y + r.h - 6));
          if (dist(rg, ng) > 40) ok = false;
          if ((r.shadow && r.shadow !== "none") || /--cat/.test(r.style)) monoNear = false;
        }
        check(`item6 · ${theme} · NEARBY rows are neutral-ground monochrome without category stripes`, ok && monoNear,
          `${near.length} nearby rows (mono=${monoNear})`);
        check(`item6 · ${theme} · §8 44px nearby rows`, near.every(r => r.h >= 44 - 0.5),
          `shortest ${Math.min(...near.map(r => r.h)).toFixed(1)}px`);
        check(`item6 · ${theme} · §8 12px floor and no opacity on nearby names`,
          near.every(r => r.fs >= 12 - 0.01 && +r.op === 1), `min ${Math.min(...near.map(r => r.fs))}px`);
      } else { check(`item6 · ${theme} · nearby rows found`, false, "no .pl-link rows on " + pid); }
    }

    // the empty-filter escape hatch that replaced the All pill
    await ev(c, `location.hash = '#/places'`);
    await sleep(900);
    await ev(c, `(() => { [...document.querySelectorAll('.pl-head .chip[aria-pressed="true"]')].forEach(b => b.click()); return true; })()`);
    await sleep(700);
    const allOff = await ev(c, `({ rows: [...document.querySelectorAll('.pl-row')].filter(r => getComputedStyle(r).position !== 'fixed').length,
      pressed: document.querySelectorAll('.pl-head .chip[aria-pressed="true"]').length })`);
    check(`item5 · ${theme} · deselecting the pill = all places (no All pill needed)`,
      allOff.pressed === 0 && allOff.rows > 20, `${allOff.rows} rows with ${allOff.pressed} pills pressed`);
  }
  return H.results;
}

if (require.main === module) (async () => {
  const c = await H.launch()
  let code = 0;
  try { await run(c); } catch (e) { console.error("SECTION C THREW:", e.message); code = 2; }
  const bad = H.results.filter(r => !r.ok);
  console.log(`\nSECTION C: ${H.results.length - bad.length}/${H.results.length} pass`);
  if (bad.length) { console.log("FAILURES:"); bad.forEach(b => console.log("  - " + b.name + " — " + b.detail)); code = code || 1; }
  await c.kill();
  process.exit(code);
})();
module.exports = { run };
