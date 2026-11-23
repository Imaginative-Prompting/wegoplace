#!/usr/bin/env node
/* What a second stranger's walk through the whole app found, held: by real presses in real Chrome, on a server of
 * its own (an empty database, removed afterwards). Made-up people: a host, and a guest who joins by name.
 *
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> --label <what> -- node scripts/stranger_fixes_check.mjs [--shots <dir>]
 *
 * Chrome needs the Bash sandbox disabled; the launcher (scripts/lib/browser.mjs) starts it.
 *
 * WHAT IT PROVES
 *   1. The trip's people page on a desktop (1440): a guest's name keeps its width beside their buttons (it was
 *      squeezed to a letter a line).
 *   2. A guest's held line, on a desktop, sits above the chat's box, not over it and its send button.
 *   3. Adding a passkey says the place is kept, and claims no "any phone" (the passkey is on one device).
 *   4. On a phone (390), an empty board says what the Feed says ("No photos yet", and Add photos), on the board.
 *  4b. During a first upload, on the board: the upload's own row in view, or the empty words (never bare ground).
 *   5. Two files picked: the new memory's sheet shows its whole title beside the upload button.
 *   6. The board has a named way to save or share it, opening the drawer with "Create a share link".
 *   7. A guest on a desktop is told their place is on "this browser", never "this phone" (the held line, Your trips,
 *      signing out); a guest on a phone still hears "this phone" (the control).
 *   8. A signed-out first screen says what WeGoPlace is, under the wordmark.
 *   9. Photos' head add, from 768, says the action in the page's word: "+ Add photos".
 *  10. Privacy and Terms: the line above each title is the home link alone (it read as a breadcrumb naming the other
 *      page); each names the other in a sentence at its foot.
 *
 * PLANTED: STRANGER_PLANT=1 serves the files these fixes touched as they were before them (BEFORE, read from git):
 * every one of 1–10 goes red; the control in 7 and 4b stay green (4b holds what was already so: no fix rode on it).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { startServer, ROOT } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { openChrome } from "../checks/lib/chrome.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";
import { pickPhotos } from "./lib/photo_picker.mjs";

const argv = process.argv.slice(2);
const shotsAt = (() => { const i = argv.indexOf("--shots"); return i < 0 ? null : path.resolve(argv[i + 1]); })();
if (shotsAt) fs.mkdirSync(shotsAt, { recursive: true });
const PLANT = !!process.env.STRANGER_PLANT;
// The commit before these fixes: the files the plant serves.
const BEFORE = "1a88773";
const FILES = ["public/css/trips.css", "public/styles.css", "public/js/auth.js", "public/js/memories.js", "public/css/memories.css", "public/css/collage.css",
  "public/js/guest.js", "public/js/account.js", "public/js/trips.js", "public/js/join.js", "public/css/account.css", "public/trips.html", "public/join.html", "public/login.html",
  "public/privacy.html", "public/terms.html"];
const PLANTED = PLANT ? Object.fromEntries(FILES.map((f) => [f.replace(/^public/, ""), execFileSync("git", ["show", `${BEFORE}:${f}`], { cwd: ROOT, encoding: "utf8" })])) : null;
// A page's address, as the file the plant serves for it.
const fileOf = (pathname) => pathname === "/trips" ? "/trips.html" : /^\/join\//.test(pathname) ? "/join.html" : pathname === "/login" ? "/login.html" : pathname === "/privacy" ? "/privacy.html" : pathname === "/terms" ? "/terms.html" : pathname;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date(Date.now() + d * 86400e3));

async function plantOld(page) {
  if (!PLANTED) return;
  page.on((m) => {
    if (m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    const key = fileOf(new URL(request.url).pathname);
    const body = PLANTED[key];
    if (!body) { page.send("Fetch.continueRequest", { requestId }).catch(() => {}); return; }
    const type = key.endsWith(".css") ? "text/css" : key.endsWith(".html") ? "text/html" : "text/javascript";
    page.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: `${type}; charset=utf-8` }, { name: "Cache-Control", value: "no-store" }],
      body: Buffer.from(body).toString("base64") }).catch(() => {});
  });
  await page.send("Fetch.enable", { patterns: [...Object.keys(PLANTED).filter((p) => !p.endsWith(".html")).map((p) => ({ urlPattern: `*${p}*` })),
    { urlPattern: "*/trips" }, { urlPattern: "*/join/*" }, { urlPattern: "*/login" }, { urlPattern: "*/privacy" }, { urlPattern: "*/terms" }] });
}
// A still waits for the page to settle, but not forever: a page mid-upload on a slow connection never does.
const shot = async (page, name) => {
  if (!shotsAt) return;
  const file = path.join(shotsAt, `${name}.png`);
  try { await page.shot(file); } catch {
    const { data } = await page.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
  }
};
// A desktop's own screen (headless Chrome's is 800 by 600, whatever the window): what placeWord() reads.
const desktop = async (page) => { await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 }); return page; };

// Made-up media: a photo and a 2 s clip, drawn by ffmpeg's test sources.
const media = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-stranger-"));
const PHOTO = path.join(media, "harbour.jpg"), CLIP = path.join(media, "tram.mp4");
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1200x900:rate=1", "-frames:v", "1", "-q:v", "4", PHOTO]);
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", CLIP]);

let code = 1;
let server = null;
try {
  const chrome = await openChrome();
  server = await startServer({ name: "stranger-fixes", port: await freeLoopbackPort() });
  ownServer(server.origin);
  await server.start();
  const { origin } = server;
  const host = new Person(origin, "Mara Voss");
  await host.signUp();
  const made = await host.post("/api/trips", { name: "Coast week", default_tz: "Europe/Lisbon", starts_on: day(-1), ends_on: day(4), currencies: ["EUR"] });
  const tripId = made.json?.trip?.id;
  const link = (await host.post(`/api/trips/${tripId}/links`, {})).json?.link;
  if (!tripId || !link) throw new Error(`setup: ${made.status} ${JSON.stringify(link)}`);

  // 8. a signed-out first screen says what this is
  const visitor = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
  await plantOld(visitor);
  await visitor.goto(`${origin}/`);
  await visitor.until(`location.pathname === "/login" && !document.getElementById("page").hasAttribute("data-wait") ? 1 : 0`, "the sign-in page", 20000);
  const what = await visitor.eval(`(() => { const n = document.getElementById("signin-what"); return n && n.getClientRects().length ? n.textContent.trim() : null; })()`);
  check("8. a signed-out first screen says what WeGoPlace is, under the wordmark", /^Plan a trip together/.test(what || ""), JSON.stringify(what));
  await shot(visitor, "8-signin-390");
  // 10. the two legal pages: the home link alone above the title, the other page named at the foot
  const legal = [];
  for (const [page, other] of [["privacy", "terms"], ["terms", "privacy"]]) {
    await visitor.goto(`${origin}/${page}`);
    await visitor.until(`document.querySelector("h1") ? 1 : 0`, `the ${page} page`, 15000);
    legal.push(await visitor.eval(`(() => { const h = document.querySelector("h1"); const links = [...document.querySelectorAll("a[href]")];
      const above = links.filter((a) => a.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING).map((a) => a.getAttribute("href"));
      const foot = links.filter((a) => a.getAttribute("href") === "/${other}" && (h.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)).map((a) => a.closest("p")?.textContent.trim());
      return { page: "${page}", above, foot }; })()`));
  }
  check("10. Privacy and Terms: the home link alone above each title, the other page named in a sentence at its foot",
    legal.every((l) => l.above.length === 1 && l.above[0] === "/" && l.foot.some((t) => /^(The terms of use are on their own page|How your data is kept is on the privacy page)\.$/.test(t || ""))), JSON.stringify(legal));
  await visitor.close();

  // ── a guest, on a desktop ────────────────────────────────────────────────────────────────
  const ana = await desktop(await chrome.page({ width: 1440, height: 900, mobile: false }));
  await plantOld(ana);
  await ana.goto(`${origin}/join/${link.code}`);
  await ana.until(`!document.getElementById("page").hasAttribute("data-wait") && !document.getElementById("as-visitor").hidden`, "the join page");
  await ana.type("#guest-name", "Ana Reyes");
  await ana.click("#btn-guest");
  await ana.until(`location.pathname === "/t/${tripId}/"`, "the trip", 20000);
  await ana.goto(`${origin}/t/${tripId}/#/chat`);
  await ana.until(`document.querySelector(".ch-input") && document.querySelector("#toast.toast-in, .toast.toast-in") ? 1 : 0`, "the chat, with the held line", 15000);
  await sleep(600);
  const over = await ana.eval(`(() => { const t = document.querySelector(".toast.toast-in").getBoundingClientRect(); const b = document.querySelector(".ch-box").getBoundingClientRect();
    return { toastBottom: Math.round(t.bottom), boxTop: Math.round(b.top), overlap: t.bottom > b.top + 0.5 && t.top < b.bottom && t.right > b.left && t.left < b.right }; })()`);
  check("2. a guest's held line, on a desktop, sits above the chat's box, not over it", !over.overlap, JSON.stringify(over));
  await shot(ana, "2-chat-1440");
  const deskHeld = await ana.eval(`[...document.querySelectorAll(".toast.toast-in .toast-kept, .toast.toast-in")].map((n) => n.textContent).join(" | ")`);
  await ana.goto(`${origin}/trips`);
  await ana.until(`document.getElementById("make-guest") && !document.getElementById("make-guest").hidden ? 1 : 0`, "Your trips, as a guest", 20000);
  const deskTrips = await ana.eval(`document.getElementById("make-guest").textContent.replace(/\\s+/g, " ").trim()`);
  await ana.goto(`${origin}/account`);
  await ana.until(`!document.getElementById("account").hidden`, "the account page", 20000);
  const deskOut = await ana.eval(`document.getElementById("out-words").textContent`);
  const deskSaid = [deskHeld, deskTrips, deskOut];
  check("7. a guest on a desktop: their place is on \"this browser\" (the held line, Your trips, signing out), never \"this phone\"",
    deskSaid.every((t) => /this browser/.test(t) && !/this phone/.test(t)), JSON.stringify(deskSaid));

  // 3. the guest keeps their place: a passkey on this device
  await ana.goto(`${origin}/account`);
  await ana.until(`!document.getElementById("account").hidden`, "the account page", 20000);
  await ana.click("#btn-add-passkey");
  const said = await ana.until(`(() => { const t = document.body.innerText.split("\\n").map((s) => s.trim()).filter((s) => /Passkey added/.test(s)); return t.length ? t : null; })()`, "the passkey's line", 20000).catch(() => null);
  check("3. adding a passkey says the place is kept, and claims no \"any phone\"", !!said && said.some((s) => /Your place is kept/.test(s)) && !said.some((s) => /any phone/.test(s)), JSON.stringify(said));
  await shot(ana, "3-passkey-1440");
  await ana.close();

  // ── the host, on a desktop: the people page ──────────────────────────────────────────────
  const hostDesk = await chrome.page({ width: 1440, height: 900, mobile: false, passkeys: false });
  await plantOld(hostDesk);
  await hostDesk.setCookie(origin, "wgp_session", host.jar.cookies.get("wgp_session"));
  // Ana is a guest no more (her passkey): make a second guest for the row with the rejoin button.
  const ben = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
  await ben.goto(`${origin}/join/${link.code}`);
  await ben.until(`!document.getElementById("page").hasAttribute("data-wait") && !document.getElementById("as-visitor").hidden`, "the join page");
  await ben.type("#guest-name", "Ben Ortiz");
  await ben.click("#btn-guest");
  await ben.until(`location.pathname === "/t/${tripId}/"`, "the trip", 20000);
  await ben.goto(`${origin}/account`);
  await ben.until(`!document.getElementById("account").hidden`, "the account page", 20000);
  const phoneOut = await ben.eval(`document.getElementById("out-words").textContent`);
  check("   a guest on a phone still hears \"this phone\" (the control)", /this phone/.test(phoneOut), phoneOut);
  await ben.close();
  await hostDesk.goto(`${origin}/trips/${tripId}`);
  await hostDesk.until(`!document.getElementById("page").hidden && document.querySelectorAll("#people .ac-way").length >= 3 ? 1 : 0`, "the people page", 20000);
  await sleep(500);
  const names = await hostDesk.eval(`[...document.querySelectorAll("#people .ac-way")].map((r) => { const l = r.querySelector(".ac-way-label"); const range = document.createRange(); range.selectNodeContents(l);
    const lines = [...range.getClientRects()].reduce((a, x) => a.some((y) => Math.abs(y - x.top) < 2) ? a : a.concat(x.top), []).length;
    return { name: l.textContent, width: Math.round(l.getBoundingClientRect().width), lines }; })`);
  check("1. the people page on a desktop: every name on one line, at its own width", names.length >= 3 && names.every((n) => n.lines === 1 && n.width > 40), JSON.stringify(names));
  await shot(hostDesk, "1-people-1440");
  await hostDesk.close();

  // ── the host, on a phone: the board ──────────────────────────────────────────────────────
  const phone = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
  await plantOld(phone);
  await phone.setCookie(origin, "wgp_session", host.jar.cookies.get("wgp_session"));
  await phone.goto(`${origin}/t/${tripId}/#/memories`);
  await phone.until(`document.querySelector('.me-viewbtn[data-view="collage"]') ? 1 : 0`, "the view toggle", 20000);
  await phone.click('.me-viewbtn[data-view="collage"]');
  await sleep(1500);
  const empty = await phone.eval(`(() => { const s = document.querySelector('.me-stage[data-stage="collage"]'); const box = s && s.querySelector(".me-altempty");
    const vis = (n) => !!n && n.getClientRects().length > 0 && getComputedStyle(n).visibility !== "hidden";
    const bd = s && s.querySelector(".cg-board"), a = box && box.getBoundingClientRect(), b = bd && bd.getBoundingClientRect();
    const inside = !!a && !!b && vis(bd) && a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
    return { words: box && vis(box) ? box.innerText.replace(/\\s+/g, " ").trim() : null, add: vis(box && box.querySelector(".me-emptyadd")), onBoard: inside }; })()`);
  check("4. an empty board says what the Feed says, with Add photos, on the board itself", !!empty.words && /No photos yet/.test(empty.words) && empty.add && empty.onBoard, JSON.stringify(empty));
  await shot(phone, "4-empty-board-390");

  // 5. two files picked: the sheet's title whole beside the upload button
  await phone.goto(`${origin}/t/${tripId}/#/memories`);
  await phone.until(`document.querySelector('.me-viewbtn[data-view="feed"]') ? 1 : 0`, "the page", 20000);
  await phone.click('.me-viewbtn[data-view="feed"]');
  await phone.until(`document.querySelector(".me-emptyadd") ? 1 : 0`, "the Feed's Add photos", 15000);
  // Add photos: the phone's picker first, answered with the two files, then its one sheet.
  await pickPhotos({ send: (m, p) => phone.send(m, p), on: (fn) => phone.on(fn), open: `document.querySelector(".me-emptyadd")`, files: [PHOTO, CLIP] });
  await phone.until(`document.querySelectorAll(".me-pickrow").length === 2 ? 1 : 0`, "two picked", 15000);
  await sleep(500);
  const head = await phone.eval(`(() => { const t = document.querySelector(".sh-root .sh-title"); const go = [...document.querySelectorAll(".sh-root .sh-head .btn")].find((b) => /^Upload/.test(b.textContent));
    return { title: t.textContent, whole: t.scrollWidth <= t.clientWidth + 1, scroll: t.scrollWidth, client: t.clientWidth, button: go && go.textContent }; })()`);
  check("5. two files picked: the new memory's sheet shows its whole title beside the upload button", head.whole, JSON.stringify(head));
  await shot(phone, "5-sheet-390");
  const upload = await phone.eval(`(() => { const go = [...document.querySelectorAll(".sh-root .sh-head .btn")].find((b) => /^Upload/.test(b.textContent)); go.dataset.go = "1"; return 1; })()`);
  // The upload slowed (a slow connection) so the board can be looked at while it runs.
  await phone.send("Network.enable");
  await phone.send("Network.emulateNetworkConditions", { offline: false, latency: 300, downloadThroughput: 40000, uploadThroughput: 40000 });
  if (upload) await phone.click('[data-go="1"]');
  await phone.until(`document.querySelector(".me-job") ? 1 : 0`, "the upload's job", 15000).catch(() => null);
  await phone.click('.me-viewbtn[data-view="collage"]');
  await sleep(1200);
  const during = await phone.eval(`(() => { const vis = (n) => !!n && n.getClientRects().length > 0 && getComputedStyle(n).visibility !== "hidden";
    const job = [...document.querySelectorAll(".me-job")].find(vis); const r = job && job.getBoundingClientRect();
    const box = document.querySelector('.me-stage[data-stage="collage"] .me-altempty');
    return { job: job ? job.innerText.replace(/\\s+/g, " ").trim() : null, inView: !!r && r.top >= 0 && r.bottom <= innerHeight, empty: vis(box) ? box.innerText.replace(/\\s+/g, " ").trim() : null }; })()`);
  check("4b. during a first upload, the board says something: the upload's own row in view, or the empty words",
    (!!during.job && /Uploading|Finishing|Waiting/.test(during.job) && during.inView) || !!during.empty, JSON.stringify(during));
  await shot(phone, "4b-board-uploading-390");
  await phone.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  // The upload's memory, read from the database (a read can meet the upload's own write: tried again a second later).
  const memories = () => { try { return server.sql(`SELECT COUNT(*) AS n FROM memories WHERE trip_id = '${tripId}'`)[0]?.n || 0; } catch { return 0; } };
  for (let i = 0; i < 60 && !memories(); i++) await sleep(1000);

  // 6. the board's named way to save or share it
  await phone.goto(`${origin}/t/${tripId}/#/memories`);
  await phone.until(`document.querySelector('.me-viewbtn[data-view="collage"]') ? 1 : 0`, "the view toggle", 20000);
  await phone.click('.me-viewbtn[data-view="collage"]');
  await phone.until(`document.querySelectorAll(".cg-item").length > 0 ? 1 : 0`, "the board with its memory", 30000).catch(() => null);
  await sleep(1200);
  const named = await phone.eval(`(() => { const b = [...document.querySelectorAll(".cg-look")].find((x) => /share/i.test(x.textContent) && x.getClientRects().length); if (!b) return null; b.dataset.share = "1"; return b.textContent.trim(); })()`);
  let drawer = null;
  if (named) {
    await phone.click('[data-share="1"]');
    drawer = await phone.until(`(() => { const b = document.querySelector(".sh-root .cg-sharelink"); return b && b.getClientRects().length ? b.textContent.trim() : null; })()`, "the drawer", 8000).catch(() => null);
  }
  check("6. the board has a named way to save or share it, opening the drawer with Create a share link", !!named && /Create a share link/.test(drawer || ""), JSON.stringify({ named, drawer }));
  await shot(phone, "6-share-390");
  await phone.close();

  // 9. Photos' head add at 1440, with a memory on the page
  const desk = await chrome.page({ width: 1440, height: 900, mobile: false, passkeys: false });
  await plantOld(desk);
  await desk.setCookie(origin, "wgp_session", host.jar.cookies.get("wgp_session"));
  await desk.goto(`${origin}/t/${tripId}/#/memories`);
  await desk.until(`document.querySelector('.me-viewbtn[data-view="feed"]') ? 1 : 0`, "the page", 20000);
  await desk.click('.me-viewbtn[data-view="feed"]');
  await desk.until(`document.querySelector(".me-card") ? 1 : 0`, "the memory", 20000).catch(() => null);
  const headAdd = await desk.eval(`(() => { const a = document.querySelector("#view .me-headadd"); return a && getComputedStyle(a).display !== "none" && !a.hidden ? a.textContent.trim() : null; })()`);
  check("9. Photos' head add says \"+ Add photos\"", headAdd === "+ Add photos", JSON.stringify(headAdd));
  await shot(desk, "9-photos-1440");
  await desk.close();

  await chrome.close();
  console.log(`\n${pass} passed, ${fail} failed${PLANT ? " (PLANTED: the files from before)" : ""}`);
  if (fail) console.log(`failed: ${failures.join(" | ")}`);
  code = fail ? 1 : 0;
} catch (e) {
  console.log(`\nSTOPPED: ${e?.stack || e}\n${pass} passed, ${fail} failed before it stopped`);
} finally {
  if (server) await server.stop().catch(() => {});
  fs.rmSync(media, { recursive: true, force: true });
}
process.exit(code);
