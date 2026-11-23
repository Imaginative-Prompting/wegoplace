#!/usr/bin/env node
/* The floating + never covers a list's last row: Places' list and Split's feed scrolled all the way
 * down, at 320, 390 (a phone's safe area) and 1440, as the made-up trip's host, the phone near a
 * place so Places' rows carry their distance. The last row, and its end (the distance, the
 * amount), clear the button by 8 px or more (the room every screen with a + keeps at its foot:
 * styles.css --fab-room, set by router.js's body[data-fab]). 15 Nov: Places' last row sat 34 px
 * under it at 320 and 390, its distance covered.
 *
 *   node scripts/gate.mjs --only fab_clear_check
 *
 * PLANTED (red when put in by hand): styles.css without body[data-fab]'s --fab-room.
 */
import { BASE, appSettled, boot, evalIn, signInAs, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { TRIP, HOST } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}

for (const [w, h, ins] of [[320, 640, false], [390, 844, true], [1440, 900, false]]) {
  const b = await boot({ vw: w, vh: h, dsf: 1 });
  const { cdp, S } = b;
  try {
    if (ins) await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 1000 }, S);
    await signInAs(cdp, S, HOST.id);
    await cdp.send("Browser.grantPermissions", { origin: BASE, permissions: ["geolocation"] }).catch(() => {});
    await cdp.send("Emulation.setGeolocationOverride", { latitude: -12.118, longitude: -76.94, accuracy: 15 }, S);
    for (const [name, hash, rows, end] of [["places", "#/places", "#view .pl-row", ".pl-far"], ["split", "#/split", "#view .sp-row", ".sp-mine"]]) {
      await cdp.send("Page.navigate", { url: `${BASE}/t/${TRIP}/${hash}` }, S);
      await appSettled(cdp, S);
      await waitFor(cdp, S, `document.querySelectorAll(${JSON.stringify(rows)}).length > 3 && document.querySelector(".fab") ? 1 : 0`, { label: name, timeout: 30000 });
      await sleep(800);
      // From 768 Places and Split have no floating + (their add is named in their heads): nothing to
      // clear, and it is checked that none is drawn.
      if (w >= 768) {
        const sel = name === "places" ? "#view .pl-headadd" : "#view .head-add";
        // Split's head is on the design system: its + is the white button's icon, its words "Add a purchase".
        const want = name === "places" ? "+ Add a place" : "Add a purchase";
        const n = JSON.parse(await evalIn(cdp, S, `JSON.stringify({ fab: getComputedStyle(document.querySelector(".fab")).display, add: ((document.querySelector(${JSON.stringify(sel)}) || {}).textContent || "").trim(), icon: !!document.querySelector(${JSON.stringify(sel + " svg")}) })`));
        check(`${w}: ${name === "places" ? "Places" : "Split"} has no floating + over its list; its add is named in its head`, n.fab === "none" && n.add === want && (name === "places" || n.icon), JSON.stringify(n));
        continue;
      }
      const r = JSON.parse(await evalIn(cdp, S, `(async () => { const v = document.getElementById("view"); v.scrollTop = v.scrollHeight; await new Promise((r) => setTimeout(r, 600));
        const all = [...document.querySelectorAll(${JSON.stringify(rows)})]; const last = all.at(-1); const f = document.querySelector(".fab").getBoundingClientRect();
        const lr = last.getBoundingClientRect(); const e = last.querySelector(${JSON.stringify(end)}); const er = e ? e.getBoundingClientRect() : null;
        const over = (a) => a && !(a.right <= f.left || a.left >= f.right || a.bottom <= f.top || a.top >= f.bottom);
        return JSON.stringify({ rows: all.length, fab: [Math.round(f.left), Math.round(f.top), Math.round(f.right), Math.round(f.bottom)], last: [Math.round(lr.left), Math.round(lr.top), Math.round(lr.right), Math.round(lr.bottom)],
          end: e ? e.textContent.trim() : null, rowUnder: over(lr), endUnder: over(er), gap: Math.round(f.top - lr.bottom) }); })()`));
      check(`${w}: ${name === "places" ? "Places' list" : "Split's feed"} scrolled to its end: the last row and its end (${r.end}) clear the +`, !r.rowUnder && !r.endUnder && r.gap >= 8, JSON.stringify(r));
    }
  } finally { await b.done(); }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);
