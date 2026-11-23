#!/usr/bin/env node
/* Does the agenda's photography blank on the way back? Screencast the real return, measure
 * texture per frame, and WRITE THE FRAMES OUT so a human can look at the worst ones instead
 * of trusting a number. */
const H = require("./v5_verify.js");
const { ev, waitFor, tap, signInHost, tripPath, sleep, decodePNG, ORIGIN } = H;
const fs = require("fs"), path = require("path");
const OUT = path.join(H.REPO, "build", "v7-verify", "flash");

function lum(im, x, y) { const o = (y * im.w + x) * im.ch; return 0.2126 * im.data[o] + 0.7152 * im.data[o + 1] + 0.0722 * im.data[o + 2]; }

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  const c = await H.launch();
  try {
    await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable");
    await c.send("Network.setBypassServiceWorker", { bypass: true });
    await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await signInHost(c);
    await c.send("Page.navigate", { url: ORIGIN + tripPath("#/") });
    await waitFor(c, "document.querySelectorAll('.ag-pill').length > 3");
    await sleep(1200);
    await c.send("Input.synthesizeScrollGesture", { x: 195, y: 560, xDistance: 0, yDistance: -1400, gestureSourceType: "touch", speed: 900, preventFling: true });
    await sleep(900);
    const card = await ev(c, `(() => { const a = [...document.querySelectorAll('a.ag-card[href^="#/e/"]')]
      .find(x => { const b = x.getBoundingClientRect(); return b.top > 150 && b.bottom < 760 && b.height > 40; });
      const b = a.getBoundingClientRect();
      return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2), href: a.getAttribute('href') }; })()`);
    await tap(c, card.x, card.y);
    await waitFor(c, "location.hash.startsWith('#/e/')");
    await sleep(1000);

    const frames = [];
    c.on("Page.screencastFrame", async (p) => {
      frames.push({ ts: p.metadata.timestamp, data: p.data });
      try { await c.send("Page.screencastFrameAck", { sessionId: p.sessionId }); } catch { /* raced */ }
    });
    await c.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    // A screencast is recording once it has handed over a frame, not once it is asked for. On
    // a busy machine that first frame has been measured 4.6 s after the start (software
    // rendering at 2x while something else holds the cores): going back before it records
    // nothing of the return. So: its first frame, then the return, then frames after it.
    const frameBy = async (count, within, what) => {
      const until = Date.now() + within;
      while (frames.length < count && Date.now() < until) await sleep(50);
      if (frames.length < count) throw new Error(`the screencast handed over no frame ${what} in ${within / 1000} s: nothing of the return can be judged. Run it again when the machine is quieter.`);
    };
    await frameBy(1, 30000, "after it was started");
    const before = frames.length;
    const t0 = Date.now();
    await ev(c, "history.back()");
    await sleep(2000);
    await frameBy(before + 1, 20000, "after the return");
    await c.send("Page.stopScreencast");
    // What is judged: the last frame before the return, and every frame after it.
    frames.splice(0, before - 1);

    const dpr = 2;
    const rows = [];
    frames.forEach((f, i) => {
      const im = decodePNG(Buffer.from(f.data, "base64"));
      let s = 0, n = 0;
      for (let y = 300 * dpr; y < Math.min(im.h - 1, 800 * dpr); y += 4)
        for (let x = 12 * dpr; x < Math.min(im.w - 1, 378 * dpr); x += 4) { s += Math.abs(lum(im, x, y) - lum(im, x + 2, y)); n++; }
      rows.push({ i, ms: Math.round(f.ts * 1000 - t0), tex: n ? s / n : 0, data: f.data });
    });
    const settled = rows.length ? rows[rows.length - 1].tex : 0;
    for (const r of rows) {
      const pct = settled ? 100 * r.tex / settled : 0;
      console.log(String(r.i).padStart(3) + "  t+" + String(r.ms).padStart(5) + "ms  tex " + r.tex.toFixed(1).padStart(6) + "  " + pct.toFixed(0).padStart(3) + "%");
      if (pct < 60) fs.writeFileSync(path.join(OUT, "low-" + String(r.i).padStart(3, "0") + "-" + Math.round(pct) + "pct.png"), Buffer.from(r.data, "base64"));
    }
    fs.writeFileSync(path.join(OUT, "settled.png"), Buffer.from(rows[rows.length - 1].data, "base64"));
    console.log("settled " + settled.toFixed(1) + "; wrote low frames to " + OUT);
  } finally { await c.kill(); }
})().catch((e) => { console.error("FATAL", e); process.exitCode = 2; });
