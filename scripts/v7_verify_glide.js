#!/usr/bin/env node
/* V7 item 1 + 2 — the day-pill glide and the return from an event, driven by REAL TOUCH.
 *
 * Item 1: scroll #view with Input.synthesizeScrollGesture (gestureSourceType "touch") until the
 * scroll-spy changes the lit day, screencast the strip at compositor rate, and measure INK
 * inside the destination pill's own on-screen box on every frame the ring's WAAPI player is
 * alive. Visible, not hit-testable.
 * Item 2: real tap on a real card, real history.back(), counting image loads, <img> creations,
 * strip scrollLeft travel, ring animation frames and which pill is lit.
 */
const H = require("./v5_verify.js");
const { ev, waitFor, tap, cookie, check, note, results, sleep, decodePNG, ORIGIN, HOST } = H;
const fs = require("fs"), path = require("path");
const OUT = path.join(H.REPO, "build", "v7-verify");
const THEME = process.env.THEME || "dark";

function lum(im, x, y) { const o = (y * im.w + x) * im.ch; return 0.2126 * im.data[o] + 0.7152 * im.data[o + 1] + 0.0722 * im.data[o + 2]; }
// Ink = pixels inside the box whose luminance is far from the box's MODAL luminance (its fill).
// A label that is painted gives a few hundred; a box swept clean gives ~0.
function ink(im, r, dpr) {
  const x0 = Math.max(0, Math.round((r.x + 3) * dpr)), y0 = Math.max(0, Math.round((r.y + 3) * dpr));
  const x1 = Math.min(im.w, Math.round((r.x + r.w - 3) * dpr)), y1 = Math.min(im.h, Math.round((r.y + r.h - 3) * dpr));
  if (x1 <= x0 || y1 <= y0) return { n: 0, px: 0 };
  const hist = new Float64Array(256); const vals = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const L = lum(im, x, y); vals.push(L); hist[Math.min(255, Math.round(L))]++; }
  let mode = 0, best = -1;
  for (let i = 0; i < 256; i++) if (hist[i] > best) { best = hist[i]; mode = i; }
  let n = 0; for (const L of vals) if (Math.abs(L - mode) > 30) n++;
  return { n, px: vals.length, mode };
}
function crop(im, r, dpr) {          // ASCII luminance picture so a human can look at it
  const x0 = Math.max(0, Math.round(r.x * dpr)), y0 = Math.max(0, Math.round(r.y * dpr));
  const x1 = Math.min(im.w, Math.round((r.x + r.w) * dpr)), y1 = Math.min(im.h, Math.round((r.y + r.h) * dpr));
  const ramp = " .:-=+*#%@"; const rows = [];
  for (let y = y0; y < y1; y += 2) {
    let s = "";
    for (let x = x0; x < x1; x++) s += ramp[Math.min(9, Math.max(0, Math.floor(lum(im, x, y) / 25.6)))];
    rows.push(s);
  }
  return rows.join("\n");
}

async function boot(c, theme) {
  await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable");
  await c.send("Network.setBypassServiceWorker", { bypass: true });
  await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await c.send("Page.addScriptToEvaluateOnNewDocument", { source: "try{localStorage.setItem('wgp.theme', " + JSON.stringify(theme) + ");}catch{}" });
  await c.send("Network.setCookie", { name: "s2", value: cookie(), domain: HOST, path: "/" });
  await c.send("Page.navigate", { url: ORIGIN + "/t/demo-2027/#/" });
  await waitFor(c, "document.querySelectorAll('.ag-pill').length > 3");
  await sleep(1200);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const c = await H.launch();
  try {
    await boot(c, THEME);
    const dpr = 2;

    // ───────────────────────── ITEM 1: the glide, fired by a real touch scroll ────────────
    console.log("\n== ITEM 1 — glide by REAL TOUCH SCROLL (" + THEME + ") ==");
    await ev(c, `(() => {
      window.__g = [];
      const strip = document.querySelector('.ag-strip');
      const loop = () => {
        const here = document.querySelector('.ag-pill-here');
        const ring = document.querySelector('.ag-ring');
        const anims = ring ? ring.getAnimations().filter(a => a.playState === 'running') : [];
        if (here) { const b = here.getBoundingClientRect();
          window.__g.push({ t: performance.now(), key: here.dataset.jump,
            r: { x: b.x, y: b.y, w: b.width, h: b.height }, anim: anims.length,
            sl: strip ? strip.scrollLeft : -1 }); }
        window.__gr = requestAnimationFrame(loop);
      };
      loop(); return true; })()`);

    const frames = [];
    c.on("Page.screencastFrame", async (p) => {
      frames.push({ ts: p.metadata.timestamp, data: p.data });
      try { await c.send("Page.screencastFrameAck", { sessionId: p.sessionId }); } catch { /* raced */ }
    });
    const bridge = await ev(c, "({ pnow: performance.now(), epoch: Date.now()/1000 })");
    await c.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });

    const before = await ev(c, "document.querySelector('.ag-pill-here').dataset.jump");
    let after = before, swipes = 0;
    while (after === before && swipes < 8) {
      await c.send("Input.synthesizeScrollGesture", {
        x: 195, y: 560, xDistance: 0, yDistance: -520, gestureSourceType: "touch",
        speed: 900, preventFling: true,
      });
      swipes++;
      await sleep(420);
      after = await ev(c, "document.querySelector('.ag-pill-here').dataset.jump");
    }
    await sleep(500);
    await c.send("Page.stopScreencast");
    const log = await ev(c, "(cancelAnimationFrame(window.__gr), window.__g)");

    check("real touch scroll changed the lit day", after !== before, before + " -> " + after + " in " + swipes + " swipe(s)");
    const animFrames = log.filter((e) => e.anim > 0);
    check("the ring actually glided during that scroll", animFrames.length > 0, animFrames.length + " rAF frames with a running player");

    const shots = [];
    for (const f of frames) {
      const pnow = (f.ts - bridge.epoch) * 1000 + bridge.pnow;
      let best = null, bd = 1e9;
      for (const e of log) { const d = Math.abs(e.t - pnow); if (d < bd) { bd = d; best = e; } }
      if (best && bd < 22) shots.push({ pnow, e: best, data: f.data });
    }
    const inFlight = shots.filter((s) => s.e.anim > 0 && s.e.key === after);
    const atRest = shots.filter((s) => s.e.anim === 0 && s.e.key === after);
    note("screencast " + frames.length + " frames, matched " + shots.length + "; in-flight on destination " + inFlight.length + ", at rest " + atRest.length);

    let worst = null, restInk = 0;
    for (const s of atRest) { const im = decodePNG(Buffer.from(s.data, "base64")); const i = ink(im, s.e.r, dpr); restInk = Math.max(restInk, i.n); }
    for (const s of inFlight) {
      const im = decodePNG(Buffer.from(s.data, "base64"));
      const i = ink(im, s.e.r, dpr);
      if (!worst || i.n < worst.n) worst = { n: i.n, im, r: s.e.r, t: s.pnow, data: s.data };
    }
    if (inFlight.length && restInk) {
      const ratio = worst.n / restInk;
      note("worst in-flight ink " + worst.n + " / at-rest " + restInk + " = " + ratio.toFixed(3));
      fs.writeFileSync(path.join(OUT, "glide-worst-" + THEME + ".txt"), crop(worst.im, worst.r, dpr));
      fs.writeFileSync(path.join(OUT, "glide-worst-" + THEME + ".png"), Buffer.from(worst.data, "base64"));
      check("destination date VISIBLE in every in-flight frame (ink >= 50% of rest)", ratio >= 0.5,
        "ratio " + ratio.toFixed(3) + ", " + inFlight.length + " in-flight frames");
    } else {
      check("could sample in-flight frames of the destination pill", false, "inFlight=" + inFlight.length + " restInk=" + restInk);
    }
    const ringBg = await ev(c, `(() => { const r = document.querySelector('.ag-ring'); if (!r) return null;
      const cs = getComputedStyle(r); return { bg: cs.backgroundColor, bi: cs.backgroundImage, bw: cs.borderTopWidth }; })()`);
    check("travelling ring carries NO opaque fill", !!ringBg && /rgba\(0, 0, 0, 0\)|transparent/.test(ringBg.bg) && ringBg.bi === "none",
      JSON.stringify(ringBg));
    const hereBg = await ev(c, `(() => { const p = document.querySelector('.ag-pill-here'); const cs = getComputedStyle(p);
      return { bg: cs.backgroundColor, clip: cs.backgroundClip, col: cs.color, w: getComputedStyle(p.querySelector('.ag-pill-num')).fontWeight }; })()`);
    check("selected pill paints its OWN fill (state does not depend on the ring)",
      !!hereBg && !/rgba\(0, 0, 0, 0\)/.test(hereBg.bg) && hereBg.clip === "padding-box", JSON.stringify(hereBg));

    // ───────────────────────── ITEM 2: open an event, press back ─────────────────────────
    console.log("\n== ITEM 2 — real tap into an event, real back (" + THEME + ") ==");
    let imgLoads = 0;
    c.on("Network.requestWillBeSent", (p) => { if (/\/img\/|\.(jpg|jpeg|png|webp|avif)(\?|$)/i.test(p.request.url)) imgLoads++; });

    const card = await ev(c, `(() => { const a = [...document.querySelectorAll('a[href^="#/e/"]')]
        .find(x => { const b = x.getBoundingClientRect(); return b.top > 120 && b.bottom < 780 && b.height > 40; });
      if (!a) return null; const b = a.getBoundingClientRect();
      return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2), href: a.getAttribute('href') }; })()`);
    if (!card) { check("found a real event card to tap", false, "none in view"); }
    else {
      const dayBefore = await ev(c, "document.querySelector('.ag-pill-here').dataset.jump");
      const stripBefore = await ev(c, "document.querySelector('.ag-strip').scrollLeft");
      const topBefore = await ev(c, "document.getElementById('view').scrollTop");
      // IDENTITY, not "a node was added": brand every agenda <img> that exists NOW. An
      // unbranded one in the agenda after the return is a genuinely new element with no
      // decoded bytes; a re-attached subtree brings its old, branded, already-decoded images.
      const branded = await ev(c, `(() => { const n = document.querySelectorAll('#view img');
        n.forEach(i => i.dataset.v7 = '1'); return n.length; })()`);
      note("branded " + branded + " agenda <img> elements before leaving");
      await tap(c, card.x, card.y);
      await waitFor(c, "location.hash.startsWith('#/e/')");
      await sleep(900);
      const hash = await ev(c, "location.hash");
      check("real tap opened the event", hash.startsWith("#/e/"), hash + " (target " + card.href + ")");

      imgLoads = 0;
      await ev(c, "(() => { window.__back = []; return true; })()");
      const rframes = [];
      c.off("Page.screencastFrame");
      c.on("Page.screencastFrame", async (p) => {
        rframes.push({ ts: p.metadata.timestamp, data: p.data });
        try { await c.send("Page.screencastFrameAck", { sessionId: p.sessionId }); } catch { /* raced */ }
      });
      await c.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
      const t0 = Date.now();
      await ev(c, `(() => { const st = performance.now(); const loop = () => {
          const h = document.querySelector('.ag-pill-here');
          const r = document.querySelector('.ag-ring'); const s = document.querySelector('.ag-strip');
          if (h) window.__back.push({ k: h.dataset.jump, sl: s ? s.scrollLeft : -1,
            a: r ? r.getAnimations().filter(x => x.playState === 'running').length : 0 });
          if (performance.now() - st < 1500) requestAnimationFrame(loop); };
        loop(); return true; })()`);
      await ev(c, "history.back()");
      await sleep(1700);
      await c.send("Page.stopScreencast");
      const back = await ev(c, "window.__back");
      const created = await ev(c, "document.querySelectorAll('#view img:not([data-v7])').length");
      const survived = await ev(c, "document.querySelectorAll('#view img[data-v7]').length");
      note("after the return: " + survived + " branded images survived, " + created + " new ones");
      // DO THE PHOTOGRAPHS BLANK? Texture = mean |neighbour difference| over the list body.
      // A blank card has none. Measured on real compositor frames, not on the DOM.
      const tex = [];
      for (const f of rframes) {
        const im = decodePNG(Buffer.from(f.data, "base64"));
        let s = 0, n = 0;
        for (let y = 300 * dpr; y < Math.min(im.h - 1, 800 * dpr); y += 4)
          for (let x = 12 * dpr; x < Math.min(im.w - 1, 378 * dpr); x += 4) { s += Math.abs(lum(im, x, y) - lum(im, x + 2, y)); n++; }
        tex.push(n ? s / n : 0);
      }
      const settled = tex.length ? tex[tex.length - 1] : 0;
      const minTex = tex.length ? Math.min(...tex) : 0;
      const lowFrames = tex.filter((t) => settled && t < settled * 0.5).length;
      note("return texture: " + tex.length + " frames, settled " + settled.toFixed(1) + ", min " +
        minTex.toFixed(1) + " (" + (settled ? (100 * minTex / settled).toFixed(0) : "?") + "% of settled), " + lowFrames + " frames below half");
      check("photographs never blank during the return", tex.length > 3 && lowFrames === 0,
        lowFrames + "/" + tex.length + " frames below half texture");
      const keys = [...new Set(back.map((b) => b.k))];
      const sls = back.map((b) => b.sl).filter((v) => v >= 0);
      const ringFrames = back.filter((b) => b.a > 0).length;
      const topAfter = await ev(c, "document.getElementById('view').scrollTop");
      note("return took " + (Date.now() - t0) + "ms, " + back.length + " sampled frames");
      check("ZERO image network loads on the return", imgLoads === 0, imgLoads + " image requests");
      check("ZERO new <img> elements in the agenda after the return", created === 0, created + " new, " + survived + " survived");
      check("strip did NOT move on the return", sls.length ? (Math.max(...sls) - Math.min(...sls)) < 1 : false,
        "scrollLeft range " + (sls.length ? (Math.max(...sls) - Math.min(...sls)).toFixed(1) : "n/a") + "px (was " + stripBefore + ")");
      check("no ring glide on the return", ringFrames === 0, ringFrames + " frames with a running player");
      check("lit day never rewound", keys.length === 1 && keys[0] === dayBefore, "saw " + JSON.stringify(keys) + ", expected " + dayBefore);
      check("vertical position restored", Math.abs(topAfter - topBefore) < 8, topBefore + " -> " + topAfter);
    }

    const k0 = await ev(c, "document.querySelector('.ag-pill-here').dataset.jump");
    await ev(c, `(() => { window.__a2 = 0; const r = () => { const g = document.querySelector('.ag-ring');
      if (g && g.getAnimations().some(a => a.playState === 'running')) window.__a2++; requestAnimationFrame(r); }; r(); return true; })()`);
    await c.send("Input.synthesizeScrollGesture", { x: 195, y: 560, xDistance: 0, yDistance: -700, gestureSourceType: "touch", speed: 900, preventFling: true });
    await sleep(700);
    const k1 = await ev(c, "document.querySelector('.ag-pill-here').dataset.jump");
    const a2 = await ev(c, "window.__a2");
    check("after a return, a real scroll still changes the day AND still glides", k1 !== k0 && a2 > 0, k0 + " -> " + k1 + ", " + a2 + " animated frames");

    console.log("\n" + results.filter((r) => r.ok).length + "/" + results.length + " passed");
    for (const r of results) if (!r.ok) console.log("   FAILED: " + r.name + " — " + r.detail);
    process.exitCode = results.every((r) => r.ok) ? 0 : 1;
  } finally { await c.kill(); }
})().catch((e) => { console.error("FATAL", e); process.exitCode = 2; });
