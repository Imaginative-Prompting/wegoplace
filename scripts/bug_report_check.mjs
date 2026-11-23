#!/usr/bin/env node
/* REPORT A BUG, in a browser on the gate's made-up trip as its host (js/report-form.js; src/bug-reports.js keeps it).
 *
 *   node scripts/gate.mjs --only bug_report_check
 *
 * It holds:
 *   1. MORE › REPORT A BUG opens a sheet: what happened, Add a screenshot, and "Sent with it": Screen (the screen before
 *      More, by name), Version (the page's own build, meta wgp-build, the one sw.js names), Device, Recent errors on this device,
 *      Screenshot, Account (Yours). Send.
 *   2. WHAT GOES IS WHAT IT SHOWS: the request carries text, context and (only when added) the screenshot, nothing else;
 *      context is exactly screen, version, device, installed, recentErrors, each the value its row shows; the screen is
 *      the route's pattern. Planted on the page first: the trip's address with a query, private words in its storage, a
 *      junk error fingerprint beside a real one. None of it is sent: no trip id, no trip name, no person's name.
 *   3. SENT FOR REAL from More: kept with the host's account; the sheet says so in words.
 *   4. THE SCREENSHOT IS REDRAWN on the device: a JPEG carrying GPS in its EXIF and a PNG carrying a tEXt chunk, each
 *      added and sent; the bytes the server KEPT (read back from the sender's own address) carry neither.
 *   5. /report, SIGNED OUT'S PAGE, linked from the sign-in page: the same form, Account None; sent without the session
 *      cookie even from this signed-in browser, so it is kept with no account.
 *   6. WITH NO OFFLINE COPY (no worker, no caches: a first visit, a private window), the Version row on /report and in
 *      More's sheet is still the page's own build (meta wgp-build, equal to sw.js VERSION).
 *   7. NO PAGE ERRORS. Every report it made is removed by its id, its screenshot queued for the drain.
 *
 * PLANTED (BUG_PLANT=<name>; each serves one file changed, never writes one):
 *   leak      report-form.js sends the page's whole address as the screen (no cleaning on the device): 2 red (2: the
 *             trip's id leaves the device; the server still cleans it, so 3 holds: the device is held on its own).
 *   cookie    report-form.js sends /report's report with the session cookie: 2 red (5: sent with it, kept with an account).
 *   raw       report-form.js sends the picked file as it is, not redrawn: 2 red (4: the tEXt and the GPS kept).
 *   nometa    report-form.js never reads the page's build (only the offline copy's): 2 red (6: "Not known" with none).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { BASE, boot, evalIn, waitFor, sleep, appSettled } from "./lib/standalone_cdp.mjs";
import { tripPath, TRIP, TRIP_NAME, HOST, d1 } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const PLANT = process.env.BUG_PLANT || "";
const PLANTS = { leak: "js/report-form.js", cookie: "js/report-form.js", raw: "js/report-form.js", nometa: "js/report-form.js" };
if (PLANT && !PLANTS[PLANT]) throw new Error(`BUG_PLANT is one of ${Object.keys(PLANTS).join(", ")}`);
const PLANTED = PLANT ? (() => {
  const src = read(`public/${PLANTS[PLANT]}`);
  const t = PLANT === "leak" ? src.replace("  return cleanContext({ screen: String(screenAddress ?? \"\"),", "  return Object.assign(cleanContext({ screen: \"\",").replace("recentErrors: recentGroups() });\n}", "recentErrors: recentGroups() }), { screen: String(screenAddress ?? \"\") });\n}")
    : PLANT === "cookie" ? src.replace('credentials: withAccount ? "same-origin" : "omit"', 'credentials: "same-origin"')
    : PLANT === "nometa" ? src.replace(`const built = document.querySelector('meta[name="wgp-build"]')?.getAttribute("content") ?? "";`, 'const built = "";')
    : src.replace("      screenshot = await redrawScreenshot(picked);", "      screenshot = picked;");
  if (t === src) throw new Error(`the ${PLANT} plant didn't take`);
  return t;
})() : null;
// BUG_SHOTS=<dir>: stills of the sheet and of /report, light and dark, to look at (written there, nothing else).
const SHOTS = process.env.BUG_SHOTS || "";
const VERSION = (read("public/sw.js").match(/^const VERSION = "(v\d+)";/m) || [])[1];
const MEDIA = "wegoplace-media";

// ── the planted pictures ──
const crcOf = (buf) => { const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(buf) >>> 0); return c; };
const pngChunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "latin1"), data]); return Buffer.concat([len, td, crcOf(td)]); };
function pngWithText(width, height, words) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;     // 8-bit RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = y * (width * 3 + 1) + 1 + x * 3; raw[i] = (x * 9) & 255; raw[i + 1] = (y * 7) & 255; raw[i + 2] = 140; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr),
    pngChunk("tEXt", Buffer.from(`Comment\0${words}`, "latin1")), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}
/** A JPEG (made by the browser, below) with an EXIF block carrying a GPS position and words, put in after its SOI. */
function withGpsExif(jpeg, words) {
  // TIFF, big-endian: IFD0 with ImageDescription (ASCII) and GPSInfo; the GPS IFD with GPSLatitudeRef "N" and GPSLatitude.
  const desc = Buffer.from(`${words}\0`, "latin1");
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const entry = (tag, type, count, value) => Buffer.concat([u16(tag), u16(type), u32(count), value]);
  const ifd0At = 8, ifd0Size = 2 + 2 * 12 + 4;
  const descAt = ifd0At + ifd0Size;
  const gpsAt = descAt + desc.length + (desc.length % 2);
  const gpsSize = 2 + 2 * 12 + 4;
  const latAt = gpsAt + gpsSize;
  const tiff = Buffer.concat([
    Buffer.from("MM\0*", "latin1"), u32(ifd0At),
    u16(2), entry(0x010e, 2, desc.length, u32(descAt)), entry(0x8825, 4, 1, u32(gpsAt)), u32(0),
    desc, Buffer.alloc(desc.length % 2),
    u16(2), entry(0x0001, 2, 2, Buffer.from("N\0\0\0", "latin1")), entry(0x0002, 5, 3, u32(latAt)), u32(0),
    u32(52), u32(1), u32(22), u32(1), u32(3036), u32(100),
  ]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u16(body.length + 2), body]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

const b = await boot({ vw: 390, vh: 844, dsf: 2, reduceMotion: true });
const { cdp, S } = b;
const J = async (e) => JSON.parse(await evalIn(cdp, S, e));
const ev = (e) => evalIn(cdp, S, e);
if (PLANTED) {
  cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }],
    body: Buffer.from(PLANTED).toString("base64") }, S).catch(() => {}); });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*/${PLANTS[PLANT]}*` }] }, S);
  console.log(`PLANTED: ${PLANT} (${PLANTS[PLANT]})`);
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-bug-report-"));
const made = [];   // the reports this check made, by id
const SHEET = `document.querySelector(".sh-root[data-open='1'] .rb-form")`;
const MORE = `document.querySelector("#view .st-more #st-report")`;
const PRIVATE = "Planted Private Words";
// Every request to /api/bug-reports, as the page sends it: its credentials, its fields, the context, the screenshot's size.
const SPY = `(() => { if (window.__bugSpy) return 1; window.__bugSpy = []; const real = window.fetch;
  window.fetch = function (url, opts) {
    if (String(url).includes("/api/bug-reports") && opts && opts.body instanceof FormData) {
      const f = opts.body, shot = f.get("screenshot");
      window.__bugSpy.push({ credentials: opts.credentials, keys: [...f.keys()], text: f.get("text"), context: JSON.parse(f.get("context")),
        shot: shot ? { size: shot.size, type: shot.type } : null, raw: [...f.entries()].map(([k, v]) => typeof v === "string" ? v : "").join("\\n") });
    }
    return real.apply(this, arguments);
  }; return 1; })()`;
const ROWS = `Object.fromEntries([...document.querySelectorAll(".rb-form [data-along]")].map((r) => [r.dataset.along, r.querySelector(".rb-value").textContent.trim()]))`;
const rowsShown = `JSON.stringify(${ROWS})`;
async function setFile(file) {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true }, S);
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".sh-root[data-open='1'] [data-rb-file], .rp-page [data-rb-file]" }, S);
  await cdp.send("DOM.setFileInputFiles", { nodeId, files: [file] }, S);
}
async function stills(name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"]) {
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: "reduce" }] }, S);
    await sleep(400);
    await b.shot(path.join(SHOTS, `${name}-${scheme}.png`));
  }
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, S);
}
// A report this check sent, by its own words (never "the newest").
const rowSaying = async (text) => d1(`SELECT * FROM bug_reports WHERE text = '${text.replace(/'/g, "''")}'`)[0];
async function sendNow(label) {
  const n = await J(`JSON.stringify(window.__bugSpy.length)`);
  await ev(`(document.querySelector(".rb-form .rb-send").click(), 1)`);
  await waitFor(cdp, S, `document.querySelector(".rb-form .rb-status").dataset.mood ? 1 : 0`, { label, timeout: 15000 }).catch(() => {});
  const said = await J(`JSON.stringify({ mood: document.querySelector(".rb-form .rb-status").dataset.mood, words: document.querySelector(".rb-form .rb-status").textContent })`);
  const sent = await J(`JSON.stringify(window.__bugSpy.slice(${n}))`);
  return { said, sent: sent[0] ?? null };
}

try {
  await cdp.send("DOM.enable", {}, S);
  // The worker installed, so this device has its offline copy (the Version row reads its name).
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/split")}` }, S);
  await appSettled(cdp, S).catch(() => {});
  await waitFor(cdp, S, `navigator.serviceWorker.getRegistration().then((r) => (r && r.active ? 1 : 0))`, { label: "the worker installed", timeout: 30000 }).catch(() => {});
  await waitFor(cdp, S, `caches.keys().then((k) => (k.includes("wegoplace-shell-${VERSION}") ? 1 : 0))`, { label: "the offline copy", timeout: 30000 }).catch(() => {});

  section("1. More › Report a bug");
  // Planted first: the trip's address with a query, private words on the page's storage, a real fingerprint and junk.
  d1(`INSERT OR IGNORE INTO error_groups (fingerprint, source, kind, name, message, stack, place, version, browser, first_seen, last_seen, count)
    VALUES ('b0b0b0b0b0b0b0b0', 'client', 'error', 'TypeError', 'planted', '', '/t/:trip/#/split', '${VERSION}', 'x', 1, 1, 1)`);
  await ev(`(localStorage.setItem("wgp.errorGroups.v1", JSON.stringify(["b0b0b0b0b0b0b0b0", "not-a-fingerprint"])), localStorage.setItem("wgp.planted", ${JSON.stringify(PRIVATE)}), 1)`);
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("?from=planted#/split")}` }, S);
  await appSettled(cdp, S).catch(() => {});
  await waitFor(cdp, S, `document.querySelector("#view") && location.hash === "#/split" ? 1 : 0`, { label: "Split", timeout: 30000 });
  await sleep(500);
  await ev(`(location.hash = "#/settings", 1)`);
  await waitFor(cdp, S, `${MORE} ? 1 : 0`, { label: "More", timeout: 20000 });
  const row = await J(`JSON.stringify((() => { const r = ${MORE}, b = r.getBoundingClientRect(); return { title: r.querySelector(".ds-item-title").textContent.trim(), h: Math.round(b.height), group: r.closest(".st-list").previousElementSibling.textContent.trim() }; })())`);
  check("This app has a Report a bug row", row.title === "Report a bug" && row.group === "This app" && row.h >= 44, JSON.stringify(row));
  await ev(`(${MORE}.click(), 1)`);
  await waitFor(cdp, S, `${SHEET} && document.querySelectorAll(".rb-form [data-along]").length === 6 ? 1 : 0`, { label: "the sheet", timeout: 10000 }).catch(() => {});
  await ev(SPY);
  const sheet = await J(`JSON.stringify({ title: document.querySelector(".sh-root[data-open='1'] .sh-title").textContent.trim(), label: document.querySelector(".rb-form label[for='rb-text']").textContent.trim(),
    add: document.querySelector(".rb-form .rb-add")?.textContent.trim(), along: document.querySelector(".rb-form .rb-along").textContent.trim(), send: document.querySelector(".rb-form .rb-send").textContent.trim(),
    help: document.querySelector(".rb-form .rb-along-help").textContent.trim(), rows: ${ROWS} })`);
  check("a sheet titled Report a bug: what happened, Add a screenshot, Sent with it, Send", sheet.title === "Report a bug" && /^What happened\?/.test(sheet.label) && sheet.add === "Add a screenshot"
    && sheet.along === "Sent with it" && sheet.send === "Send" && /Nothing from your trips/.test(sheet.help), JSON.stringify(sheet));
  await stills("1-sheet");
  check("Screen: the screen before More, by its name", sheet.rows.screen === "Split", JSON.stringify(sheet.rows));
  check(`Version: the page's build (${VERSION})`, sheet.rows.version === VERSION, JSON.stringify(sheet.rows));
  check("Device, in words; Recent errors: the one real fingerprint, codes only; Screenshot none; Account yours",
    /Chrome \d+/.test(sheet.rows.device) && sheet.rows.errors === "1 (codes only)" && sheet.rows.screenshot === "None" && sheet.rows.account === "Yours", JSON.stringify(sheet.rows));

  section("2. What goes is what it shows");
  // Held at the server's door: the page's request read, then answered as the server would, nothing kept.
  await ev(`(document.querySelector("#rb-text").value = "Planted: the total doesn't update.", 1)`);
  await ev(`(() => { const real = window.fetch; window.fetch = function (url, opts) { if (String(url).includes("/api/bug-reports") && window.__hold) return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 201 })); return real.apply(this, arguments); }; window.__hold = true; return 1; })()`);
  await ev(SPY.replace("if (window.__bugSpy) return 1; window.__bugSpy = [];", "window.__bugSpy = window.__bugSpy || [];"));
  const held = await sendNow("the held send");
  const s = held.sent;
  const shown = sheet.rows;
  check("the request: text and context only (no screenshot added), sent with the account", s && s.keys.join() === "text,context" && s.credentials === "same-origin", JSON.stringify(s));
  check("context is exactly screen, version, device, installed, recentErrors", s && Object.keys(s.context).join() === "screen,version,device,installed,recentErrors", JSON.stringify(s?.context));
  check("each as its row shows it: the screen as the route's pattern, the version, the one real fingerprint", s && s.context.screen === "/t/:trip/#/split" && s.context.version === shown.version
    && JSON.stringify(s.context.recentErrors) === '["b0b0b0b0b0b0b0b0"]', JSON.stringify(s?.context));
  check("nothing planted leaves the device: no trip id, no trip name, no query, no private words, no person's name",
    s && ![TRIP, TRIP_NAME, "planted#", "from=planted", PRIVATE, HOST.name].some((w) => s.raw.includes(w) || JSON.stringify(s.context).includes(w)), s?.raw);
  check("the sheet says it went, in words", held.said.mood === "right" && /Sent/.test(held.said.words) && /^✓/.test(held.said.words), JSON.stringify(held.said));
  await ev(`(window.__hold = false, 1)`);

  section("3. Sent for real, from More");
  await ev(`(document.querySelector("#rb-text").value = "Planted: the split total lags after an edit.", 1)`);
  const real = await sendNow("the real send");
  const kept = await rowSaying("Planted: the split total lags after an edit.");
  if (kept?.text?.startsWith("Planted:")) made.push(kept.id);
  const host = await J(`fetch("/api/me").then((r) => r.json()).then((me) => JSON.stringify(me.id))`);
  check("kept with the host's account, the screen by its pattern, the version", kept?.text === "Planted: the split total lags after an edit." && kept.user_id === host && kept.screen === "/t/:trip/#/split" && kept.version === VERSION,
    JSON.stringify({ said: real.said, kept: kept && { ...kept, text: kept.text.slice(0, 40) } }));
  check("  and the sheet said so", real.said.mood === "right", JSON.stringify(real.said));

  section("4. The screenshot is redrawn on the device: what was in its file stays here");
  const pngFile = path.join(TMP, "planted-text.png");
  fs.writeFileSync(pngFile, pngWithText(48, 32, "PLANTED-TEXT-the-hotel-door-code"));
  // A real JPEG, from this browser, then given its EXIF with a GPS position.
  const jpegB64 = await ev(`(() => { const c = document.createElement("canvas"); c.width = 64; c.height = 48; const g = c.getContext("2d"); g.fillStyle = "#3a7"; g.fillRect(0, 0, 64, 48); g.fillStyle = "#f60"; g.fillRect(8, 8, 30, 20); return c.toDataURL("image/jpeg", 0.9).split(",")[1]; })()`);
  const jpegFile = path.join(TMP, "planted-gps.jpg");
  fs.writeFileSync(jpegFile, withGpsExif(Buffer.from(jpegB64, "base64"), "PLANTED-GPS-52.3676N"));
  const stored = {};
  for (const [name, file, marks] of [["png", pngFile, ["tEXt", "PLANTED-TEXT"]], ["jpeg", jpegFile, ["Exif", "PLANTED-GPS", "GPS"]]]) {
    check(`  (planted: the ${name} carries ${marks.slice(0, 2).join(" and ")} before it's added)`, marks.slice(0, 2).every((m) => fs.readFileSync(file).includes(Buffer.from(m, "latin1"))));
    await setFile(file);
    await waitFor(cdp, S, `document.querySelector(".rb-form .rb-shot-row") ? 1 : 0`, { label: `the ${name} added`, timeout: 10000 }).catch(() => {});
    const r = await J(rowsShown);
    if (name === "png") await stills("4-screenshot-added");
    check(`the ${name}: its row and its size shown before it goes`, /KB|MB/.test(r.screenshot ?? ""), JSON.stringify(r));
    await ev(`(document.querySelector("#rb-text").value = "Planted: a ${name} screenshot.", 1)`);
    const sent = await sendNow(`the ${name} send`);
    const k = await rowSaying(`Planted: a ${name} screenshot.`);
    if (k?.text === `Planted: a ${name} screenshot.`) made.push(k.id);
    const bytes = await ev(`fetch("/api/account/bug-reports/${k?.id}/screenshot").then((r) => r.arrayBuffer()).then((a) => { let s = ""; const v = new Uint8Array(a); for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i]); return btoa(s); })`);
    const back = Buffer.from(bytes ?? "", "base64");
    stored[name] = { type: k?.screenshot_type, size: back.length };
    check(`the ${name} was sent and kept (${k?.screenshot_type}, ${back.length} bytes)`, sent.said.mood === "right" && sent.sent?.shot && back.length > 0 && back.length === k.screenshot_size, JSON.stringify({ said: sent.said, shot: sent.sent?.shot, k: k && k.screenshot_type }));
    check(`  the kept bytes carry none of it (${marks.join(", ")})`, back.length > 0 && marks.every((m) => !back.includes(Buffer.from(m, "latin1"))), JSON.stringify(marks.filter((m) => back.includes(Buffer.from(m, "latin1")))));
  }
  check("  a PNG small enough stays a PNG (its words sharp); the photo goes as WebP", stored.png?.type === "image/png" && ["image/webp", "image/jpeg"].includes(stored.jpeg?.type), JSON.stringify(stored));
  await ev(`(document.querySelector(".sh-scrim") && document.querySelector(".sh-scrim").click(), 1)`);
  await sleep(500);

  section("5. /report, from the sign-in page: the same form, sent with no account");
  const loginLinks = await J(`fetch("/login").then((r) => r.text()).then((t) => JSON.stringify(/<a href="\\/report">Report a bug<\\/a>/.test(t)))`);
  check("the sign-in page links to Report a bug", loginLinks === true);
  await cdp.send("Page.navigate", { url: `${BASE}/report` }, S);
  await waitFor(cdp, S, `document.querySelectorAll(".rp-page .rb-form [data-along]").length === 6 ? 1 : 0`, { label: "/report", timeout: 20000 }).catch(() => {});
  await ev(SPY);
  await stills("5-report-page");
  const page = await J(`JSON.stringify({ h1: document.querySelector(".rp-page h1").textContent, rows: ${ROWS}, help: document.querySelector(".rb-form .rb-along-help").textContent })`);
  check("Report a bug, Account None, said to go without an account", page.h1 === "Report a bug" && page.rows.account === "None" && /without an account/.test(page.help) && page.rows.screen === "Report a bug", JSON.stringify(page));
  await ev(`(document.querySelector("#rb-text").value = "Planted: signed-out report from /report.", 1)`);
  const out = await sendNow("the /report send");
  const k5 = await rowSaying("Planted: signed-out report from /report.");
  if (k5?.text === "Planted: signed-out report from /report.") made.push(k5.id);
  check("sent without the session cookie (this browser is signed in)", out.sent?.credentials === "omit", JSON.stringify(out.sent && { credentials: out.sent.credentials }));
  check("  kept with no account, the screen /report", k5?.text === "Planted: signed-out report from /report." && k5.user_id === null && k5.screen === "/report", JSON.stringify(k5 && { user_id: k5.user_id, screen: k5.screen }));

  section("6. With no offline copy, the Version row is the page's own build");
  await cdp.send("Storage.clearDataForOrigin", { origin: BASE, storageTypes: "cache_storage,service_workers" }, S);
  await ev(`navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))).then(() => caches.keys()).then((k) => Promise.all(k.map((n) => caches.delete(n)))).then(() => 1)`);
  await cdp.send("Page.navigate", { url: `${BASE}/report` }, S);
  await waitFor(cdp, S, `document.querySelectorAll(".rp-page .rb-form [data-along]").length === 6 && document.querySelector('[data-along="version"] .rb-value').textContent ? 1 : 0`, { label: "/report, no worker", timeout: 20000 }).catch(() => {});
  const bare = await J(`(async () => JSON.stringify({ worker: !!navigator.serviceWorker.controller, shells: (await caches.keys()).filter((k) => k.startsWith("wegoplace-shell-")).length, version: document.querySelector('[data-along="version"] .rb-value')?.textContent ?? null }))()`);
  check(`/report with no worker and no offline copy: Version is the page's build (${VERSION})`, bare.version === VERSION && !bare.worker && bare.shells === 0, JSON.stringify(bare));
  await ev(`navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))).then(() => caches.keys()).then((k) => Promise.all(k.map((n) => caches.delete(n)))).then(() => 1)`);
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/settings")}` }, S);
  await appSettled(cdp, S).catch(() => {});
  await waitFor(cdp, S, `${MORE} ? 1 : 0`, { label: "More, no worker", timeout: 20000 }).catch(() => {});
  // The app's page installs its worker as it loads: its offline copy is taken away again, as a browser that dropped it.
  await ev(`caches.keys().then((k) => Promise.all(k.map((n) => caches.delete(n)))).then(() => 1)`);
  await ev(`(${MORE}.click(), 1)`);
  await waitFor(cdp, S, `${SHEET} && document.querySelector('.rb-form [data-along="version"] .rb-value')?.textContent ? 1 : 0`, { label: "the sheet, no worker", timeout: 10000 }).catch(() => {});
  const sheetBare = await J(`(async () => JSON.stringify({ worker: !!navigator.serviceWorker.controller, shells: (await caches.keys()).filter((k) => k.startsWith("wegoplace-shell-")).length, version: document.querySelector('.rb-form [data-along="version"] .rb-value')?.textContent ?? null }))()`);
  check(`More's sheet with its offline copy gone: Version is the page's build (${VERSION})`, sheetBare.version === VERSION && sheetBare.shells === 0, JSON.stringify(sheetBare));
  await ev(`(document.querySelector(".sh-scrim") && document.querySelector(".sh-scrim").click(), 1)`).catch(() => {});

  section("7. No page errors");
  check("nothing thrown", b.pageErrors.length === 0, b.pageErrors.join(" | ").slice(0, 400));
} catch (e) {
  fail++; failures.push(`stopped: ${e.message}`);
  console.log(`  FAIL  stopped: ${e.stack || e}`);
} finally {
  // Only what this check made, by id: its reports (their screenshots to the drain), the planted error group.
  const quietly = (sql) => { try { d1(sql); } catch (e) { console.log(`  (clean-up: ${e.message})`); } };
  if (made.length) {
    const ids = made.map((id) => `'${id}'`).join(", ");
    quietly(`INSERT OR IGNORE INTO files_to_delete (bucket, r2_key, upload_id, queued_at) SELECT 'media', screenshot_key, NULL, strftime('%s','now') FROM bug_reports WHERE id IN (${ids}) AND screenshot_key IS NOT NULL`);
    quietly(`DELETE FROM bug_reports WHERE id IN (${ids})`);
  }
  quietly("DELETE FROM error_groups WHERE fingerprint = 'b0b0b0b0b0b0b0b0'");
  await ev(`(localStorage.removeItem("wgp.planted"), localStorage.removeItem("wgp.errorGroups.v1"), 1)`).catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
  await b.done().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }
