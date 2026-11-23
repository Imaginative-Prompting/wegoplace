#!/usr/bin/env node
/* Focused probe: after a real tap into an event and a real history.back(), does the agenda
 * still WORK? Real touch scrolls only. Prints scrollTop, the lit pill and the day boundaries
 * so a failure can be told apart from "that scroll did not cross a boundary".
 */
const H = require("./v5_verify.js");
const { ev, waitFor, tap, signInHost, tripPath, note, sleep, ORIGIN } = H;

async function boot(c) {
  await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable");
  await c.send("Network.setBypassServiceWorker", { bypass: true });
  await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await signInHost(c);
  await c.send("Page.navigate", { url: ORIGIN + tripPath("#/") });
  await waitFor(c, "document.querySelectorAll('.ag-pill').length > 3");
  await sleep(1200);
}
const scroll = (c, d) => c.send("Input.synthesizeScrollGesture",
  { x: 195, y: 560, xDistance: 0, yDistance: -d, gestureSourceType: "touch", speed: 900, preventFling: true });

const state = (c) => ev(c, `(() => ({
  top: document.getElementById('view').scrollTop,
  max: document.getElementById('view').scrollHeight,
  here: (document.querySelector('.ag-pill-here')||{}).dataset?.jump || null,
  days: [...document.querySelectorAll('.ag-day')].map(d => ({ k: d.dataset.day,
    top: Math.round(d.getBoundingClientRect().top) })),
  scrollListeners: window.__sc === undefined ? null : window.__sc,
}))()`);

(async () => {
  const c = await H.launch();
  try {
    await boot(c);
    // count scroll events the page itself receives (a dead listener still gets these; this is
    // only to prove the scroller moved)
    await ev(c, `(() => { window.__sc = 0; document.getElementById('view')
      .addEventListener('scroll', () => { window.__sc++; }, { passive: true }); return true; })()`);

    console.log("— FRESH MOUNT —");
    let s = await state(c); console.log("  top=" + s.top + " here=" + s.here);
    await scroll(c, 700); await sleep(600);
    s = await state(c); console.log("  after scroll: top=" + s.top + " here=" + s.here + " scrollEvents=" + s.scrollListeners);
    await scroll(c, 700); await sleep(600);
    s = await state(c); console.log("  after scroll: top=" + s.top + " here=" + s.here + " scrollEvents=" + s.scrollListeners);

    const card = await ev(c, `(() => { const a = [...document.querySelectorAll('a.ag-card[href^="#/e/"]')]
      .find(x => { const b = x.getBoundingClientRect(); return b.top > 150 && b.bottom < 760 && b.height > 40; });
      if (!a) return null; const b = a.getBoundingClientRect();
      return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2), href: a.getAttribute('href') }; })()`);
    console.log("— TAP " + JSON.stringify(card) + " —");
    await tap(c, card.x, card.y);
    await waitFor(c, "location.hash.startsWith('#/e/')");
    await sleep(900);
    console.log("— BACK —");
    await ev(c, "history.back()");
    await sleep(1400);
    await ev(c, `(() => { window.__sc = 0; document.getElementById('view')
      .addEventListener('scroll', () => { window.__sc++; }, { passive: true }); return true; })()`);
    s = await state(c); console.log("  landed: top=" + s.top + " here=" + s.here);
    console.log("  day tops: " + JSON.stringify(s.days.slice(0, 6)));
    for (let i = 0; i < 4; i++) {
      await scroll(c, 700); await sleep(600);
      s = await state(c);
      console.log("  scroll " + (i + 1) + ": top=" + s.top + " here=" + s.here + " scrollEvents=" + s.scrollListeners);
    }
    // is the agenda's OWN scroll listener alive? ask the app: does the spy re-light on a
    // programmatic scroll too (a different, weaker question — printed for contrast only)
    const probe = await ev(c, `(() => { const v = document.getElementById('view');
      const before = (document.querySelector('.ag-pill-here')||{}).dataset?.jump;
      v.scrollTop = v.scrollTop + 1200;
      return new Promise(r => setTimeout(() => r({ before,
        after: (document.querySelector('.ag-pill-here')||{}).dataset?.jump,
        top: v.scrollTop }), 400)); })()`);
    console.log("  programmatic scroll probe: " + JSON.stringify(probe));
  } finally { await c.kill(); }
})().catch((e) => { console.error("FATAL", e); process.exitCode = 2; });
