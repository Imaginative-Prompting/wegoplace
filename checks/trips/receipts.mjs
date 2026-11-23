// A purchase's receipt, in a browser, with two people (model §17; public/js/receipts.js).
//
//   node checks/trips/receipts.mjs [--port <port>] [--shots <folder>] [--scheme dark] [--width 320]
//
// On a server of its own. A receipt is drawn by code (a made-up café's bill, tall and narrow
// like a real one) and photographed at a phone camera's size. One person adds purchases in Split
// at a phone's width and picks the receipt for them; the other opens them. It holds:
//   - the picture is made to the receipt's size on the phone (its long side 1600 px, under
//     600 KB, a JPEG, the right way up) and reaches the server with the purchase;
//   - with no signal the purchase saves, its row says its receipt is waiting, and the receipt
//     is sent by itself once the signal is back, with nothing tapped;
//   - the other person sees it on the purchase and opens it, and can't add or change one;
//   - a receipt the server refuses stays on the phone, its row and its drawer say so and why,
//     and removing it leaves nothing waiting;
//   - removing a stored receipt removes it from the server; deleting a purchase whose receipt
//     waits sends nothing;
//   - no page has an error.
// Everyone and everything in it is made up.

import fs from "node:fs";
import path from "node:path";
import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";
import { PICTURE_LIMITS } from "../../public/js/shared/limits.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8795);
const shots = flag("--shots");
const scheme = flag("--scheme") ?? "light";
// The phones' width: 390 (an iPhone's), or 320 (the narrowest the app is drawn for).
const WIDTH = Number(flag("--width") ?? 390);
if (![320, 390].includes(WIDTH)) { console.error("--width 320 or 390"); process.exit(2); }
if (shots) fs.mkdirSync(shots, { recursive: true });
const t = new Report("a purchase's receipt");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMIT = PICTURE_LIMITS.receipt;

// The made-up bill. Drawn as a page and photographed at three device pixels per CSS pixel: a
// 600 × 1500 page becomes an 1800 × 4500 picture, about what a phone's camera hands over.
const BILL = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:#e9e4da}
  .bill{width:520px;margin:30px auto;padding:34px 30px 60px;background:#fffdf7;color:#222;
    font:20px/1.5 "Courier New",monospace;box-shadow:0 2px 12px rgba(0,0,0,.18)}
  h1{font-size:28px;text-align:center;margin:0 0 4px;letter-spacing:.06em}
  .c{text-align:center;margin:0}
  .r{display:flex;justify-content:space-between}
  hr{border:0;border-top:2px dashed #888;margin:16px 0}
  .t{font-weight:700;font-size:24px}
</style><div class="bill">
  <h1>CAFÉ LUMEN</h1><p class="c">12 Harbour Steps</p><p class="c">Table 7 · 4 guests</p><hr>
  ${[["Soup of the day", "6.50"], ["Grilled fish", "18.00"], ["Pasta al limone", "14.50"], ["Green salad", "7.00"],
     ["Bread basket", "3.50"], ["Sparkling water", "4.00"], ["Lemonade x2", "7.00"], ["Espresso x3", "7.50"],
     ["Almond cake", "6.00"], ["Fruit plate", "5.50"]].map(([a, b]) => `<div class="r"><span>${a}</span><span>${b}</span></div>`).join("")}
  <hr><div class="r"><span>Subtotal</span><span>79.50</span></div><div class="r"><span>Service 10%</span><span>7.95</span></div>
  <div class="r t"><span>TOTAL EUR</span><span>87.45</span></div><hr>
  <div class="r"><span>Card</span><span>87.45</span></div><p class="c">Thank you, see you soon</p>
  ${"<p class=c>&nbsp;</p>".repeat(6)}
</div>
<canvas id="grain" style="position:fixed;inset:0;width:100%;height:100%;pointer-events:none;mix-blend-mode:multiply;opacity:.5"></canvas>
<script>
  // A camera's grain over the paper and the table: a photo, not a flat drawing.
  const c = document.getElementById("grain"); c.width = 1800; c.height = 4500;
  const g = c.getContext("2d"), d = g.createImageData(1800, 4500);
  let x = 7; for (let i = 0; i < d.data.length; i += 4) { x = (x * 1103515245 + 12345) & 0x7fffffff; const v = 200 + (x % 56); d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
  g.putImageData(d, 0, 0);
</script>`;

let server, chrome, code = 1;
const pages = [];
try {
  server = await startServer({ name: "receipts", port });
  await server.start();
  const { origin } = server;
  const mira = new Person(origin, "Mira Receipt");
  const ned = new Person(origin, "Ned Receipt");
  for (const p of [mira, ned]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}'s account`);
  const made = await mira.post("/api/trips", { name: "A receipt trip", default_tz: "Europe/Lisbon", currencies: ["EUR"] });
  if (made.status !== 201) throw new CheckError(`couldn't make a trip: ${made.status} ${made.text}`);
  const trip = made.json.trip;
  const link = await mira.post(`/api/trips/${trip.id}/links`, { uses: 1 });
  const joined = await ned.post(`/api/join/${link.json?.link?.code}`);
  if (joined.status !== 200) throw new CheckError(`couldn't join: ${joined.status} ${joined.text}`);

  chrome = await openChrome();
  const phone = async (person) => {
    const page = await chrome.page({ width: WIDTH, height: WIDTH === 320 ? 640 : 844, mobile: true, passkeys: false });
    pages.push(page);
    await page.scheme(scheme);
    await page.setCookie(origin, "wgp_session", person.jar.cookies.get("wgp_session"));
    await page.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(person.user.id), sameSite: "Lax" });
    return page;
  };
  const shot = async (page, name) => {
    if (!shots) return;
    await sleep(400);
    // Two frames drawn first, and a blank capture taken again (headless Chrome sometimes hands back
    // only the page's ground after a change, the page itself drawn: check:chat-agenda, 15 Nov).
    let png = null;
    for (let tries = 0; tries < 4 && !(png?.length > 20000); tries++) {
      await page.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
      png = Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64");
      if (png.length <= 20000) await sleep(500);
    }
    if (png.length <= 20000) throw new CheckError(`the still ${name} came out blank four times`);
    fs.writeFileSync(path.join(shots, `${name}-${WIDTH}-${scheme}.png`), png);
  };

  // ── the bill, photographed ──────────────────────────────────────────────────────────────
  const cam = await chrome.page({ width: 600, height: 1500, passkeys: false });
  await cam.send("Emulation.setDeviceMetricsOverride", { width: 600, height: 1500, deviceScaleFactor: 3, mobile: false });
  await cam.goto(`data:text/html;base64,${Buffer.from(BILL).toString("base64")}`);
  await sleep(300);
  const billFile = path.join(server.work, "bill.png");
  fs.writeFileSync(billFile, Buffer.from((await cam.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const billSize = (() => { const b = fs.readFileSync(billFile); return [b.readUInt32BE(16), b.readUInt32BE(20), b.length]; })();
  t.same("the made-up bill is a phone camera's size: 1800 × 4500, several MB", [billSize[0], billSize[1], billSize[2] > 2 * LIMIT.bytes], [1800, 4500, true]);
  console.log(`        the bill: ${billSize[0]} × ${billSize[1]}, ${(billSize[2] / 1048576).toFixed(1)} MB`);

  // ── Mira adds a purchase with its receipt ───────────────────────────────────────────────
  t.part("With signal: the receipt goes with the purchase");
  const m = await phone(mira);
  await m.goto(`${origin}/t/${trip.id}/#/split`);
  await m.until(`!!document.querySelector(".fab")`, "Split's add button", 20000);
  const tripRows = async () => (await mira.get(`/api/trips/${trip.id}`)).json.purchases;

  /** Opens Add a purchase, types the amount and what it was, and picks `file` as its receipt. */
  async function addWith(amount, what, file) {
    await calm(m);
    await m.click(".fab");
    await m.until(`!!document.querySelector(${JSON.stringify(inOpen(".sp-amtin"))})`, "the add drawer");
    await m.type(inOpen(".sp-amtin"), amount);
    await m.type(inOpen('[data-f="description"]'), what);
    if (file) await pick(file);
  }
  async function pick(file) {
    await m.until(`!!document.querySelector(${JSON.stringify(inOpen('[data-act="rcpt-add"]'))})`, "Add the receipt");
    const { result } = await m.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(inOpen(".sp-rcpt-file"))})` });
    await m.send("DOM.setFileInputFiles", { files: [file], objectId: result.objectId });
    await m.until(`!!document.querySelector(".sp-rcpt-thumb img") && document.querySelector(".sp-rcpt-thumb img").complete && document.querySelector(".sp-rcpt-thumb img").naturalWidth > 0`, "the receipt's picture in the drawer", 20000);
  }
  // The sheet that is open: a closed one stays in the page while it slides away, with its own
  // buttons, so every action is aimed at the open one, and the next step waits for the closed
  // one to be gone.
  const OPEN = '.sh-root[data-open="1"]';
  const inOpen = (sel) => `${OPEN} ${sel}`;
  const calm = (page) => page.until(`!document.querySelector(".sh-root")`, "the sheet to close and leave", 15000);
  // A tap where the button IS: scrolled into view, and only once it has stopped moving (a sheet
  // grows to its tall height when something below its fold is brought up, and a tap aimed while
  // it moves lands where the button was).
  async function tap(page, sel) {
    await page.until(`!!document.querySelector(${JSON.stringify(sel)})`, sel);
    await page.eval(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: "center" })`);
    let last = "";
    for (let i = 0; i < 60; i++) {
      const r = await page.eval(`JSON.stringify(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect())`);
      if (r === last) break;
      last = r;
      await sleep(80);
    }
    await page.click(sel);
  }
  // A tap that has to open something: tapped again (up to three times) when it hasn't within 5 s,
  // as a person would: on a loaded machine a feed can repaint after the row stopped moving, and
  // the click lands on the row being replaced (the other person's read view, 15 Nov, 1 in 5).
  async function tapTo(page, sel, opened, what) {
    for (let i = 0; i < 3; i++) {
      await tap(page, sel);
      if (await page.until(opened, what, 5000).then(() => true, () => false)) return true;
    }
    return false;
  }
  const words = (sel) => m.eval(`(document.querySelector(${JSON.stringify(inOpen(sel))}) || {}).textContent || ""`);

  await addWith("87.45", "Dinner", billFile);
  t.ok("picked, the drawer shows the picture and says it is kept with the purchase", /Kept with the purchase/.test(await words(".sp-rcpt-state")), await words(".sp-rcpt-state"));
  await shot(m, "1-drawer-with-receipt");
  await tap(m, inOpen('[data-act="save"]'));
  let rows = [];
  for (let i = 0; i < 100; i++) { rows = await tripRows(); if (rows[0]?.receipt) break; await sleep(200); }
  const r1 = rows.find((p) => p.description === "Dinner");
  t.ok("the purchase and its receipt are on the server", !!r1?.receipt, JSON.stringify(r1?.receipt ?? null));
  t.same("made on the phone: the long side 1600, the right way up (taller than wide), a JPEG under 600 KB",
    [r1?.receipt?.height, r1?.receipt?.width, r1?.receipt?.mime, (r1?.receipt?.bytes ?? Infinity) <= LIMIT.bytes], [LIMIT.px, 640, "image/jpeg", true]);
  const bytes = await mira.get(r1.receipt.url);
  t.ok("its file answers to the trip's members", bytes.status === 200, String(bytes.status));
  await m.until(`!!document.querySelector('.sp-row[data-id="${r1.id}"] .sp-rc[data-state="stored"]')`, "the row's receipt mark", 15000).catch(() => {});
  t.ok("its row carries the receipt mark", await m.eval(`!!document.querySelector('.sp-row[data-id="${r1.id}"] .sp-rc[data-state="stored"]')`));

  // ── no signal ───────────────────────────────────────────────────────────────────────────
  t.part("With no signal: the purchase saves, the receipt waits, and goes by itself");
  const offline = (on) => m.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await offline(true);
  await addWith("12.00", "Taxi", billFile);
  await tap(m, inOpen('[data-act="save"]'));
  const taxiId = await m.until(`(() => { const r = [...document.querySelectorAll(".sp-row")].find((x) => /Taxi/.test(x.textContent)); return r ? r.dataset.id : 0; })()`, "the Taxi row");
  await m.until(`/receipt waiting/.test(document.querySelector('.sp-row[data-id="${taxiId}"]').textContent)`, "the row to say its receipt waits").catch(() => {});
  t.ok("its row says the receipt is waiting", /receipt waiting/.test(await m.eval(`document.querySelector('.sp-row[data-id="${taxiId}"]').textContent`)));
  const held = await m.eval(`import("/js/receipts.js").then((r) => JSON.stringify(r.receiptsState()))`);
  t.ok("the picture is held on the phone, not sent", JSON.parse(held).held.some((h) => h.id === taxiId && h.op === "put" && h.bytes > 0 && h.bytes <= LIMIT.bytes), held);
  await shot(m, "2-feed-receipt-waiting");
  t.ok("nothing of it is on the server yet", !(await tripRows()).some((p) => p.id === taxiId));
  await offline(false);
  let taxi = null;
  for (let i = 0; i < 150; i++) { taxi = (await tripRows()).find((p) => p.id === taxiId); if (taxi?.receipt) break; await sleep(200); }
  t.ok("the signal back, the purchase and then its receipt reach the server, nothing tapped", !!taxi?.receipt, JSON.stringify(taxi?.receipt ?? null));
  await m.until(`!!document.querySelector('.sp-row[data-id="${taxiId}"] .sp-rc[data-state="stored"]')`, "the row's mark to say stored", 15000).catch(() => {});
  t.ok("and its row no longer says waiting", !/receipt waiting/.test(await m.eval(`document.querySelector('.sp-row[data-id="${taxiId}"]').textContent`)));

  // ── the other person ────────────────────────────────────────────────────────────────────
  t.part("The other person sees it, and opens it");
  const n = await phone(ned);
  await n.goto(`${origin}/t/${trip.id}/#/split`);
  await n.until(`!!document.querySelector('.sp-row[data-id="${r1.id}"]')`, "Mira's purchase on Ned's phone", 20000);
  t.ok("Ned's feed shows the receipt mark on Mira's purchase", await n.eval(`!!document.querySelector('.sp-row[data-id="${r1.id}"] .sp-rc[data-state="stored"]')`));
  await tapTo(n, `.sp-row[data-id="${r1.id}"]`, `!!document.querySelector(".sp-read")`, "Ned's read view of the purchase");
  await n.until(`!!document.querySelector('.sp-read [data-act="rcpt-view"] img') && document.querySelector('.sp-read [data-act="rcpt-view"] img').naturalWidth > 0`, "the receipt in the read view", 15000).catch(() => {});
  t.ok("the read view shows the receipt", await n.eval(`(document.querySelector('.sp-read [data-act="rcpt-view"] img') || {}).naturalWidth > 0`));
  t.ok("and offers no way to add or change one", await n.eval(`!document.querySelector('[data-act="rcpt-add"], [data-act="rcpt-remove"], .sp-rcpt-file')`));
  // tap(), not click(): the read view is a sheet still rising when its receipt first shows, and
  // a click aimed while it moves lands where the picture was (1 run in 7 under load, 15 Nov).
  await tap(n, '.sp-read [data-act="rcpt-view"]');
  await n.until(`!!document.querySelector(".sp-rcpt-view img") && document.querySelector(".sp-rcpt-view img").naturalWidth > 0`, "the receipt opened", 15000).catch(() => {});
  t.same("tapped, it opens full width at its own size", await n.eval(`(() => { const i = document.querySelector(".sp-rcpt-view img"); return i ? [i.naturalWidth, i.naturalHeight] : null; })()`), [640, 1600]);
  await shot(n, "3-receipt-opened");

  // ── refused ─────────────────────────────────────────────────────────────────────────────
  t.part("Refused: it stays, and says why");
  const REASON = "A receipt is at most 1600 px on its long side and 600 KB.";
  await m.send("Fetch.enable", { patterns: [{ urlPattern: "*/pictures/purchase/*", requestStage: "Request" }] });
  let refusedPuts = 0;
  const offFetch = m.on(async (msg) => {
    if (msg.method !== "Fetch.requestPaused") return;
    const { requestId, request } = msg.params;
    if (request.method === "PUT") {
      refusedPuts++;
      await m.send("Fetch.fulfillRequest", { requestId, responseCode: 413, responseHeaders: [{ name: "Content-Type", value: "application/json" }],
        body: Buffer.from(JSON.stringify({ error: "too big", reason: REASON })).toString("base64") }).catch(() => {});
    } else await m.send("Fetch.continueRequest", { requestId }).catch(() => {});
  });
  await addWith("30.00", "Market", billFile);
  await tap(m, inOpen('[data-act="save"]'));
  const marketId = await m.until(`(() => { const r = [...document.querySelectorAll(".sp-row")].find((x) => /Market/.test(x.textContent)); return r ? r.dataset.id : 0; })()`, "the Market row");
  await m.until(`/receipt not sent/.test(document.querySelector('.sp-row[data-id="${marketId}"]').textContent)`, "the row to say not sent", 20000).catch(() => {});
  t.ok("its row says the receipt was not sent", /receipt not sent/.test(await m.eval(`document.querySelector('.sp-row[data-id="${marketId}"]').textContent`)), `${refusedPuts} refused`);
  await shot(m, "4-feed-receipt-refused");
  // No strings of facts joined by dots: a row's second line is who paid on the left (and the
  // receipt's words, with its glyph) and your share on the right. The receipt's words stay whole:
  // at 320 they may take a line of their own, never break inside.
  const lines = JSON.parse(await m.eval(`JSON.stringify([...document.querySelectorAll(".sp-row")].map((r) => {
    const rc = r.querySelector(".sp-rc span");
    return { row: r.dataset.id, dots: /·/.test(r.textContent),
      whole: !rc || rc.getClientRects().length === 1, words: rc ? rc.textContent : "" };
  }))`));
  t.ok("no row joins facts with dots, and a receipt's words are never broken across lines",
    lines.length > 0 && lines.every((x) => !x.dots && x.whole), JSON.stringify(lines));
  await calm(m);
  await tap(m, `.sp-row[data-id="${marketId}"]`);   // a row of a feed that may still be moving
  await m.until(`!!document.querySelector(${JSON.stringify(inOpen(".sp-rcpt-state"))})`, "the drawer's receipt");
  // A 413 means this phone's own making fell short (it makes the picture to the size the server
  // takes): the drawer says so, the server's limit after it, and what to try.
  const why = await words(".sp-rcpt-state");
  t.ok("its drawer says why: still too big after the phone made it smaller, the server's limit, and what to try",
    /^Still too big after this phone made it smaller/.test(why) && why.includes(`(${REASON.replace(/\.$/, "").replace(/^A /, "a ")})`) && /Try another picture\.$/.test(why), why);
  await shot(m, "5-drawer-receipt-refused");
  await tap(m, inOpen('[data-act="rcpt-remove"]'));
  await tap(m, inOpen('[data-act="save"]'));
  await m.until(`!/receipt not sent/.test(document.querySelector('.sp-row[data-id="${marketId}"]').textContent)`, "the mark to go").catch(() => {});
  const after = JSON.parse(await m.eval(`import("/js/receipts.js").then((r) => JSON.stringify(r.receiptsState()))`));
  t.ok("removed, nothing of it waits on the phone and its row has no mark", !after.held.some((h) => h.id === marketId) &&
    !(await m.eval(`!!document.querySelector('.sp-row[data-id="${marketId}"] .sp-rc')`)), JSON.stringify(after));
  offFetch();
  await m.send("Fetch.disable");

  // ── removing and deleting ───────────────────────────────────────────────────────────────
  t.part("Removing a stored receipt, and deleting a purchase whose receipt waits");
  await calm(m);
  await tap(m, `.sp-row[data-id="${r1.id}"]`);   // a row of a feed that may still be moving
  await m.until(`!!document.querySelector(${JSON.stringify(inOpen('[data-act="rcpt-remove"]'))})`, "the stored receipt in the drawer");
  await tap(m, inOpen('[data-act="rcpt-remove"]'));
  await shot(m, "6-after-remove");
  t.ok("✕ shows the receipt gone before saving", await m.eval(`!!document.querySelector(${JSON.stringify(inOpen('[data-act="rcpt-add"]'))}) && !document.querySelector(${JSON.stringify(inOpen(".sp-rcpt-thumb"))})`));
  await tap(m, inOpen('[data-act="save"]'));
  let gone = null;
  for (let i = 0; i < 100; i++) { gone = (await tripRows()).find((p) => p.id === r1.id); if (gone && !gone.receipt) break; await sleep(200); }
  t.ok("saved, the receipt is gone from the server", gone && gone.receipt === null, JSON.stringify(gone?.receipt));
  t.same("and its file's row with it (only the taxi's receipt is stored)", server.sql(`SELECT count(*) AS n FROM media_objects WHERE trip_id = '${trip.id}' AND role = 'receipt'`)[0].n, 1);

  await offline(true);
  await addWith("5.00", "Ice cream", billFile);
  await tap(m, inOpen('[data-act="save"]'));
  const iceId = await m.until(`(() => { const r = [...document.querySelectorAll(".sp-row")].find((x) => /Ice cream/.test(x.textContent)); return r ? r.dataset.id : 0; })()`, "the Ice cream row");
  await calm(m);
  await tap(m, `.sp-row[data-id="${iceId}"]`);   // a row of a feed that may still be moving
  await m.until(`!!document.querySelector(${JSON.stringify(inOpen('[data-act="del"]'))})`, "Delete");
  await tap(m, inOpen('[data-act="del"]'));
  await tap(m, inOpen('[data-act="del"]'));
  await m.until(`!document.querySelector('.sp-row[data-id="${iceId}"]')`, "the row to go");
  const iceHeld = JSON.parse(await m.eval(`import("/js/receipts.js").then((r) => JSON.stringify(r.receiptsState()))`));
  t.ok("deleted with no signal, its receipt no longer waits", !iceHeld.held.some((h) => h.id === iceId), JSON.stringify(iceHeld));
  await offline(false);
  await sleep(4000);
  t.same("and nothing of it reaches the server", [(await tripRows()).some((p) => p.id === iceId), server.sql(`SELECT count(*) AS n FROM media_objects WHERE trip_id = '${trip.id}' AND role = 'receipt'`)[0].n], [false, 1]);

  t.part("Any picture made on the phone, not only a receipt (picture-wait.js: the place's photo, the cover)");
  // The store wgp-client's photo controls build on: the same making, the same waiting, any target.
  const placed = await mira.call("PUT", `/api/trips/${trip.id}/places`, { places: [{ id: "pl-pier", name: "Café by the pier", kind: "food", subkind: "cafe", why: "Breakfast." }] });
  if (placed.status !== 200) throw new CheckError(`couldn't make the place: ${placed.status} ${placed.text}`);
  // A phone photo, drawn: 3000 × 2000, larger than a picture is kept.
  const photo = `(async () => { const c = document.createElement("canvas"); c.width = 3000; c.height = 2000; const g = c.getContext("2d");
    const grd = g.createLinearGradient(0, 0, 3000, 2000); grd.addColorStop(0, "#2b6c8f"); grd.addColorStop(1, "#e8c27a"); g.fillStyle = grd; g.fillRect(0, 0, 3000, 2000);
    const b = await new Promise((r) => c.toBlob(r, "image/png")); return new File([b], "pier.png", { type: "image/png" }); })()`;
  const held1 = JSON.parse(await m.eval(`(async () => { const { store } = await import("/js/store.js"); await store.refresh();
    const w = await import("/js/picture-wait.js"); const file = await ${photo};
    const out = await w.holdPicture({ trip: store.tripId(), kind: "place", id: "pl-pier" }, file); return JSON.stringify(out); })()`));
  const kept = server.sql(`SELECT width, height, bytes, role FROM pictures WHERE trip_id = '${trip.id}' AND target_kind = 'place' AND target_id = 'pl-pier'`)[0] ?? null;
  t.same("a place's photo, with signal: sent at once, made to a picture's size on the phone", [held1.status, kept && Math.max(kept.width, kept.height), kept && kept.bytes <= PICTURE_LIMITS.picture.bytes, kept?.role],
    ["sent", PICTURE_LIMITS.picture.px, true, "picture"]);
  await offline(true);
  const held2 = JSON.parse(await m.eval(`(async () => { const { store } = await import("/js/store.js"); const w = await import("/js/picture-wait.js");
    const t = { trip: store.tripId(), kind: "cover" }; const out = await w.holdPicture(t, await ${photo}); return JSON.stringify([out, w.waitingFor(t) && w.waitingFor(t).state]); })()`));
  t.same("the cover, with no signal: kept on the phone, waiting", held2, [{ status: "waiting" }, "waiting"]);
  await offline(false);
  await m.until(`import("/js/picture-wait.js").then((w) => w.sendWaiting()).then((n) => n === 0)`, "the cover to go", 20000).catch(() => {});
  t.same("  and sent by itself once there is signal", [JSON.parse(await m.eval(`import("/js/picture-wait.js").then((w) => JSON.stringify(w.pictureWaitState().held.map((h) => h.key)))`)),
    server.sql(`SELECT count(*) AS n FROM pictures WHERE trip_id = '${trip.id}' AND target_kind = 'cover'`)[0].n], [[], 1]);
  const notPicture = JSON.parse(await m.eval(`(async () => { const { store } = await import("/js/store.js"); const w = await import("/js/picture-wait.js");
    return JSON.stringify(await w.holdPicture({ trip: store.tripId(), kind: "event", id: "nope" }, new File(["hello"], "notes.txt", { type: "text/plain" }))); })()`));
  t.same("a file that isn't a picture: refused in words, nothing kept", notPicture, { status: "refused", reason: "That isn't a picture." });
  // A place's photo held in the app with no signal, then the trip's own page opened with signal
  // (no store there): the photo stays, and goes from the app once it's back. Proved on the server:
  // every upload is a new stored object (pictures.r2_key), so the place's row says which one it has.
  // The trip's own page is a second tab beside the app (the same phone's database), with signal
  // while the app's tab has none: leaving the app instead would not do, because a page being left
  // gets its signal back before it is gone (the browser lifts the emulated "offline" as the
  // navigation starts), and the app rightly sent the photo on its way out.
  const pierKey = () => server.sql(`SELECT r2_key FROM pictures WHERE trip_id = '${trip.id}' AND target_kind = 'place' AND target_id = 'pl-pier'`)[0]?.r2_key ?? null;
  const before = pierKey();
  await m.goto(`${origin}/t/${trip.id}/#/split`);
  await m.until(`location.pathname === ${JSON.stringify(`/t/${trip.id}/`)} && document.readyState === "complete" && !!document.querySelector("#view")`, "the app", 20000);
  await offline(true);
  const heldOffline = JSON.parse(await m.eval(`(async () => { const { store } = await import("/js/store.js"); const w = await import("/js/picture-wait.js"); w.start(store);
    return JSON.stringify(await w.holdPicture({ trip: store.tripId(), kind: "place", id: "pl-pier" }, await ${photo})); })()`));
  const own = await chrome.tabBeside(m, { width: WIDTH, height: 844, mobile: true });
  await own.goto(`${origin}/trips/${trip.id}`);
  await own.until(`location.pathname === ${JSON.stringify(`/trips/${trip.id}`)} && document.readyState === "complete"`, "the trip's own page", 20000);
  await own.eval(`import("/js/picture-wait.js").then(async (w) => { await w.startForTrip(${JSON.stringify(trip.id)}); await w.sendWaiting(); return 1; })`);
  const stillHeld = JSON.parse(await own.eval(`import("/js/picture-wait.js").then((w) => JSON.stringify(w.pictureWaitState().held.map((h) => h.key)))`));
  t.same("a place's photo held in the app with no signal: the trip's own page (no store) leaves it waiting, and sends nothing",
    [heldOffline.status, stillHeld, pierKey() === before], ["waiting", ["place:pl-pier"], true]);
  await own.close();
  await offline(false);
  // Sent by the app by itself, with nothing pressed: the place's stored picture is a new one, and
  // the phone no longer holds it.
  for (const until = Date.now() + 30000; pierKey() === before && Date.now() < until; ) await sleep(250);
  await m.until(`import("/js/picture-wait.js").then((w) => w.waitingCount() === 0 && w.pictureWaitState().trip !== null)`, "the phone's list emptied", 10000).catch(() => {});
  const sentFromApp = JSON.parse(await m.eval(`import("/js/picture-wait.js").then((w) => JSON.stringify(w.pictureWaitState().held.map((h) => h.key)))`));
  t.same("  and the app sends it once it's back (a new picture on the server; nothing left waiting)", [pierKey() !== before, sentFromApp], [true, []]);
  // The trip's own page has no trip store (trip-people.html, where the cover is changed): the cover alone.
  await m.goto(`${origin}/trips/${trip.id}`);
  await m.until(`location.pathname === ${JSON.stringify(`/trips/${trip.id}`)} && document.readyState === "complete"`, "the trip's own page", 20000);
  const fromPage = JSON.parse(await m.eval(`(async () => { const w = await import("/js/picture-wait.js"); await w.startForTrip(${JSON.stringify(trip.id)});
    const sent = await w.holdPicture({ trip: ${JSON.stringify(trip.id)}, kind: "cover" }, await ${photo});
    let refusedPlace = null; try { await w.holdPicture({ trip: ${JSON.stringify(trip.id)}, kind: "place", id: "pl-pier" }, await ${photo}); } catch (e) { refusedPlace = e.message; }
    return JSON.stringify([sent, refusedPlace]); })()`));
  t.same("from the trip's own page (no store): the cover sent; a place's picture asks for the trip's store", [fromPage[0], /holds the cover only/.test(fromPage[1] ?? "")], [{ status: "sent" }, true]);

  t.ok("no page has an error", m.errors.length === 0 && n.errors.length === 0, JSON.stringify([...m.errors, ...n.errors].slice(0, 4)));
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  for (const p of pages) if (p.errors.length) console.error("  page errors:", JSON.stringify(p.errors.slice(0, 5)));
  t.end();
  code = 2;
} finally {
  await chrome?.close();
  await server?.stop();
}
process.exit(code);
