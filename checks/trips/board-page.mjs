// A shared board's page, in a browser: which size of each picture it asks for (migration 0026).
//
//   node checks/trips/board-page.mjs [--port <port>] [--shots <folder>]
//
// On a server of its own: a memory with a photograph and its thumbnail, a board shared from it
// with two prints of that photograph, one sent naming its media (so it keeps the thumbnail) and
// one sent without (as every board before this was). The board's page is opened at a phone's
// width in Chrome for Testing, zoomed out as it opens, and every picture it asks for is written
// down. It holds:
//   - the print with a thumbnail is drawn from /i/<n>/thumb, and its original isn't fetched;
//   - the print without one is drawn from its original, and no size it hasn't got is asked for;
//   - nothing the page asks for answers 404, and the page has no error;
//   - a third print, sent as an app that doesn't know a picture's size sends it (w=0, h=0), opened: the lightbox
//     says "3 / 3 · 1600×1200", the size read from the file itself;
//   - a clip on a board (a test pattern ffmpeg makes here, its index at the end), seeked to 7.5 s in the page: it can
//     be sought across its whole length and the frame shown is 7.5 s's (the clip answers ranges; check:share-board
//     holds each answer);
//   - a board kept with its share (migration 0041: a band of wall round it), zoomed all the way in at that width and
//     panned as far as it goes each way: half the screen is still board (src/share-page.js panLimit);
//   - the hint says a pinch on a phone's screen and on a touch tablet, and the keyboard's scroll too on a desktop;
//   - on a notched phone on its side (844×390, insets 47 at each side, 21 below) and upright (390×844, 47 above, 34
//     below), given to the page as Chrome's safe-area insets: the zoom tools, the wordmark and the lightbox's ×, ‹, ›
//     and count all sit inside the safe area.
// PLANTED: BOARDPAGE_PLANT=clamp serves the page with its camera allowed the whole band of wall at any zoom (the
// rule before): panned across at full zoom, the screen is all wall, and that part goes red. BOARDPAGE_PLANT=safe
// serves it with the left, right and top safe areas left out of those positions (the rules before): both phones go red.
// Everyone and everything in it is made up.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";
import { scene } from "../lib/images.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8795);
const shots = flag("--shots");
if (shots) fs.mkdirSync(shots, { recursive: true });
const t = new Report("a shared board's page: the sizes it asks for");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A plant: the page at `pattern` reaches this browser page through `edit` (the server's own copy is untouched). */
async function plant(page, pattern, edit) {
  await page.send("Fetch.enable", { patterns: [{ urlPattern: pattern, requestStage: "Response" }] });
  page.on(async (m) => {
    if (m.method !== "Fetch.requestPaused") return;
    const got = await page.send("Fetch.getResponseBody", { requestId: m.params.requestId });
    const body = edit(got.base64Encoded ? Buffer.from(got.body, "base64").toString("utf8") : got.body);
    await page.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: m.params.responseHeaders, body: Buffer.from(body).toString("base64") });
  });
}

let server, chrome, code = 1;
try {
  server = await startServer({ name: "board-page", port });
  await server.start();
  const ann = new Person(server.origin, "Ann Board");
  await ann.signUp();
  const trip = (await ann.post("/api/trips", { name: "A board", default_tz: "Europe/Lisbon" })).json.trip;
  const T = `/api/trips/${trip.id}`;

  // A photograph and its thumbnail, uploaded as the app uploads them.
  const original = scene(1600, 1200, 30);
  const thumb = scene(480, 360, 30);
  const up = await ann.post(`${T}/media/begin`, { name: "harbour.png", mime: "image/png", bytes: original.length, kind: "photo" });
  const part = await ann.call("PUT", `${T}/media/part?key=${encodeURIComponent(up.json.key)}&id=${encodeURIComponent(up.json.uploadId)}&n=1`, original, { headers: { "Content-Type": "application/octet-stream" } });
  await ann.post(`${T}/media/finish`, { key: up.json.key, id: up.json.uploadId, parts: [{ n: 1, etag: part.json?.etag }] });
  const th = await ann.call("POST", `${T}/media/thumb?mime=image/png&for=${encodeURIComponent(up.json.key)}`, thumb, { headers: { "Content-Type": "image/png" } });
  const memory = await ann.post(`${T}/memories`, { id: "mem-harbour", caption: "The harbour", media: [{ key: up.json.key, thumb_key: th.json?.key, w: 1600, h: 1200 }] });
  const mediaId = server.sql("SELECT id FROM memory_media WHERE memory_id = 'mem-harbour'")[0]?.id;
  t.same("a memory with a photograph and its thumbnail", [up.status, th.status, memory.status, !!mediaId, server.sql("SELECT thumb_key FROM memory_media WHERE memory_id = 'mem-harbour'")[0]?.thumb_key === th.json?.key], [201, 201, 201, true, true]);

  // The board, two prints of it: one naming its media, one not.
  const board = await ann.call("POST", `${T}/collage/share?mime=image/png&w=1600&h=1200&title=Harbour`, scene(800, 600, 30), { headers: { "Content-Type": "image/png" } });
  const id = board.json?.share?.id;
  const print = (idx, fx, media) => ann.call("POST", `${T}/collage/share/${id}/item?idx=${idx}&kind=photo&mime=image/png&w=1600&h=1200&fx=${fx}&fy=0.25&fw=0.4&fh=0.4&rot=0&memory=mem-harbour${media ? `&media=${encodeURIComponent(mediaId)}` : ""}`, original, { headers: { "Content-Type": "image/png" } });
  const withThumb = await print(0, 0.05, true);
  const without = await print(1, 0.55, false);
  t.same("a board with two prints: one sent with its media id, one without", [board.status, withThumb.status, without.status], [201, 200, 200]);
  const unsized = await ann.call("POST", `${T}/collage/share/${id}/item?idx=2&kind=photo&mime=image/png&w=0&h=0&fx=0.3&fy=0.7&fw=0.2&fh=0.2&rot=0`, original, { headers: { "Content-Type": "image/png" } });

  // Its page, at a phone's width, as anyone with the link opens it.
  chrome = await openChrome();
  const page = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
  const asked = new Map();
  page.on((m) => {
    if (m.method === "Network.requestWillBeSent" && new URL(m.params.request.url).pathname.startsWith(`/s/${id}/i/`)) asked.set(m.params.requestId, { path: new URL(m.params.request.url).pathname, status: null });
    if (m.method === "Network.responseReceived" && asked.has(m.params.requestId)) asked.get(m.params.requestId).status = m.params.response.status;
  });
  await page.send("Page.navigate", { url: `${server.origin}/s/${id}` });
  await page.until(`document.querySelectorAll(".tile").length === 3`, "the board's prints", 20000);
  await sleep(4000);   // the page picks each tile's size and draws it
  if (shots) fs.writeFileSync(path.join(shots, "board-390.png"), Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const list = [...asked.values()];
  const paths = list.map((r) => r.path);
  const tiles = JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll(".tile")].map((x) => [x.dataset.thumb || "", x.dataset.lod || ""]))`));
  t.same("zoomed out, the print with a thumbnail is drawn from it, and its original isn't fetched",
    [paths.includes(`/s/${id}/i/0/thumb`), paths.includes(`/s/${id}/i/0`), tiles[0]], [true, false, ["1", "480"]]);
  t.same("the print without one is drawn from its original, and no size it hasn't got is asked for",
    [paths.includes(`/s/${id}/i/1`), paths.some((p) => p.startsWith(`/s/${id}/i/1/`)), tiles[1]], [true, false, ["", "original"]]);
  await page.click('.tile[data-i="2"]');
  const said = await page.until(`document.getElementById("lb").open && document.querySelector("#lb .cnt").textContent`, "the lightbox's count", 10000);
  t.same("a print sent without its size, opened: the lightbox says which of how many and its size, read from the file",
    [unsized.status, said.replace(/\s+/g, " ").trim()], [200, "3 / 3 · 1600×1200"]);
  t.ok("nothing the page asks for answers 404, and the page has no error", list.every((r) => r.status !== 404) && page.errors.length === 0,
    JSON.stringify({ asked: list, errors: page.errors.slice(0, 3) }));

  // A clip on a board, seeked as the board's page plays it: a test pattern made here by ffmpeg (nothing filmed), its
  // index at the end of the file as a phone's camera writes it, so the player has to ask for ranges to find it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-board-clip-"));
  try {
    const clipFile = path.join(dir, "clip.mp4");
    try {
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=12", "-c:v", "libx264", "-preset", "ultrafast",
        "-g", "30", "-pix_fmt", "yuv420p", clipFile], { stdio: ["ignore", "ignore", "inherit"] });
    } catch (e) { throw new CheckError(`ffmpeg could not make the clip (${e.code === "ENOENT" ? "ffmpeg is not installed" : e.message}); this part needs ffmpeg`); }
    const clipBytes = fs.readFileSync(clipFile);
    const cboard = await ann.call("POST", `${T}/collage/share?mime=image/png&w=1600&h=1200&title=Clip`, scene(800, 600, 30), { headers: { "Content-Type": "image/png" } });
    const cid = cboard.json?.share?.id;
    const cput = await ann.call("POST", `${T}/collage/share/${cid}/item?idx=0&kind=video&mime=video/mp4&w=640&h=360&fx=0.2&fy=0.2&fw=0.6&fh=0.6&rot=0`,
      clipBytes, { headers: { "Content-Type": "application/octet-stream" } });
    const cpage = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
    await cpage.send("Page.navigate", { url: `${server.origin}/s/${cid}` });
    await cpage.until(`document.querySelectorAll(".tile").length === 1`, "the clip's board", 20000);
    const seek = JSON.parse(await cpage.eval(`(async () => {
      // On screen, above the board: a video that isn't drawn presents no frame to read.
      const v = document.createElement("video"); v.muted = true; v.preload = "auto"; v.playsInline = true;
      v.style.cssText = "position:fixed;left:0;top:0;width:160px;height:90px;z-index:2147483647";
      v.src = ${JSON.stringify(`/s/${cid}/i/0`)}; document.body.append(v);
      const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(what)), ms))]);
      try {
        await within(new Promise((ok, no) => { v.onloadeddata = ok; v.onerror = () => no(new Error("error " + (v.error && v.error.code))); }), 15000, "no first frame in 15 s");
        const seekable = v.seekable.length ? v.seekable.end(v.seekable.length - 1) : 0;
        // The frame the seek presents, asked for before the seek so it can't be missed.
        const framed = new Promise((ok) => v.requestVideoFrameCallback((now, md) => ok(md.mediaTime)));
        v.currentTime = 7.5;
        await within(new Promise((ok) => { v.onseeked = ok; }), 15000, "no seeked in 15 s");
        const shown = await within(framed, 15000, "no frame in 15 s");
        return JSON.stringify({ duration: v.duration, seekable, currentTime: v.currentTime, mediaTime: shown });
      } catch (e) { return JSON.stringify({ failed: e.message, duration: v.duration, currentTime: v.currentTime }); } finally { v.remove(); }
    })()`));
    t.ok(`a clip on a shared board, seeked to 7.5 s in Chrome: it can be sought across its length and the frame shown is 7.5 s's (${JSON.stringify(seek)})`,
      cboard.status === 201 && cput.status === 200 && !seek.failed && Math.abs(seek.seekable - seek.duration) < 0.1 && Math.abs(seek.mediaTime - 7.5) < 0.05,
      JSON.stringify({ board: cboard.status, item: cput.status, bytes: clipBytes.length, ...seek }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // A board kept with its share: slate, 0.875 x 0.8333 of a 2048 x 1536 picture, a band of wall 6.25% across each side.
  const kept = await ann.call("POST", `${T}/collage/share?mime=image/png&w=2048&h=1536&title=Wall&bx=0.0625&by=0.0833&bw=0.875&bh=0.8333&bs=0.5&bg=slate`,
    scene(800, 600, 30), { headers: { "Content-Type": "image/png" } });
  const kid = kept.json?.share?.id;
  const kprint = await ann.call("POST", `${T}/collage/share/${kid}/item?idx=0&kind=photo&mime=image/png&w=1600&h=1200&fx=0.3&fy=0.3&fw=0.4&fh=0.4&rot=0`,
    original, { headers: { "Content-Type": "image/png" } });
  const wall = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
  if (process.env.BOARDPAGE_PLANT === "clamp") {
    await plant(wall, `*/s/${kid}`, (html) => html.replace(/var reach = [^;]+;/, "var reach = Infinity;"));
    console.log("  (PLANTED: the page's camera may reach the whole band of wall at any zoom)");
  }
  await wall.send("Page.navigate", { url: `${server.origin}/s/${kid}` });
  await wall.until(`document.querySelectorAll(".tile").length === 1 && document.querySelector(".board-edge")`, "the kept board", 20000);
  await sleep(500);
  if (shots) {
    // As it opens, fitted, by day and at Night (the lamp's pool, the board, its frame and shadow).
    for (const scheme of ["light", "dark"]) {
      await wall.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await sleep(600);
      fs.writeFileSync(path.join(shots, `board-kept-390-${scheme}.png`), Buffer.from((await wall.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    }
    await wall.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  }
  const wheel =(deltaX, deltaY, modifiers = 0) => wall.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 195, y: 422, deltaX, deltaY, modifiers });
  for (let i = 0; i < 12; i++) { await wheel(0, -400, 2); await sleep(30); }
  await sleep(300);
  const zoom = await wall.eval(`document.querySelector(".zoom-readout").textContent`);
  const SEEN = `JSON.stringify((() => { const v = document.getElementById("canvas").getBoundingClientRect(), e = document.querySelector(".board-edge").getBoundingClientRect();
    return [Math.max(0, Math.min(v.right, e.right) - Math.max(v.left, e.left)) / v.width, Math.max(0, Math.min(v.bottom, e.bottom) - Math.max(v.top, e.top)) / v.height]; })())`;
  const ends = [];
  for (const [dx, dy] of [[6000, 0], [-6000, 0], [0, 6000], [0, -6000], [6000, 6000], [-6000, -6000]]) {
    for (let i = 0; i < 4; i++) { await wheel(dx, dy); await sleep(30); }
    await sleep(300);
    ends.push(JSON.parse(await wall.eval(SEEN)).map((f) => +f.toFixed(3)));
  }
  if (shots) fs.writeFileSync(path.join(shots, "board-kept-390-zoomed-in.png"), Buffer.from((await wall.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  t.ok(`a kept board zoomed all the way in (${zoom}) at 390 and panned as far as it goes each way: half the screen is still board ${JSON.stringify(ends)}`,
    kept.status === 201 && kprint.status === 200 && zoom === "600%" && ends.every(([x, y]) => x >= 0.499 && y >= 0.499) && wall.errors.length === 0,
    JSON.stringify({ zoom, ends, errors: wall.errors.slice(0, 3) }));
  // The hint's words for the screen: a phone's (short side under 600, as the app's onPhone) and a touch tablet's are a
  // pinch; a desktop's add the keyboard's scroll.
  const hintOf = async (pg) => (await pg.eval(`document.querySelector(".canvas-hint").innerText`)).replace(/\s+/g, " ").trim();
  const onPhoneSays = await hintOf(wall);
  const desk = await chrome.page({ width: 1440, height: 900, mobile: false, passkeys: false });
  await desk.send("Page.navigate", { url: `${server.origin}/s/${kid}` });
  await desk.until(`document.querySelector(".canvas-hint") ? 1 : 0`, "the desktop's page", 20000);
  const onDeskSays = await hintOf(desk);
  const tablet = await chrome.page({ width: 1024, height: 1366, mobile: true, passkeys: false });
  await tablet.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await tablet.send("Page.navigate", { url: `${server.origin}/s/${kid}` });
  await tablet.until(`document.querySelector(".canvas-hint") ? 1 : 0`, "the tablet's page", 20000);
  const onTabletSays = await hintOf(tablet);
  const coarse = await tablet.eval(`matchMedia("(pointer:coarse)").matches`);
  t.same(`the hint's words: a phone's screen and a touch tablet's (pointer coarse: ${coarse}) a pinch; a desktop's the keyboard's too`,
    [onPhoneSays, onTabletSays, onDeskSays], ["Drag to move · pinch to zoom", "Drag to move · pinch to zoom", "Drag to move · pinch or ⌘/Ctrl-scroll to zoom"]);

  // The safe areas: a notched phone on its side (the notch's 47 px at each side, the home indicator's 21 below) and
  // upright (the status bar's 47 above, 34 below). The page draws under them (viewport-fit=cover); the zoom tools,
  // the wordmark and the lightbox's ×, ‹, › and count must each sit inside what's left.
  const PHONES = [
    { name: "on its side", width: 844, height: 390, insets: { top: 0, right: 47, bottom: 21, left: 47 } },
    { name: "upright", width: 390, height: 844, insets: { top: 47, right: 0, bottom: 34, left: 0 } },
  ];
  const EDGE = [".canvas-tools", ".mark", "#lb .x", "#lb .prev", "#lb .next", "#lb .cnt"];
  for (const phone of PHONES) {
    const p = await chrome.page({ width: phone.width, height: phone.height, mobile: true, passkeys: false });
    await p.send("Emulation.setSafeAreaInsetsOverride", { insets: phone.insets });
    if (process.env.BOARDPAGE_PLANT === "safe") await plant(p, `*/s/${id}`, (html) => html.replace(/max\((\d+px),env\(safe-area-inset-(?:top|right|left)\)\)/g, "$1"));
    await p.send("Page.navigate", { url: `${server.origin}/s/${id}` });
    await p.until(`document.querySelectorAll(".tile").length === 3 && document.querySelector(".mark svg")`, "the board and its wordmark", 20000);
    // Honest only if the page itself reads the insets given (env() can't be set from a script or a stylesheet).
    const read = await p.eval(`(() => { const d = document.createElement("div"); d.style.cssText = "position:fixed;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"; document.body.append(d); const s = getComputedStyle(d); const r = [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(parseFloat); d.remove(); return r; })()`);
    const want = [phone.insets.top, phone.insets.right, phone.insets.bottom, phone.insets.left];
    if (JSON.stringify(read) !== JSON.stringify(want)) throw new CheckError(`the page reads the safe areas as ${read}, not ${want}: the emulation isn't honest`);
    await p.click('.tile[data-i="0"]');
    await p.until(`document.getElementById("lb").open`, "the lightbox", 10000);
    await sleep(400);
    const boxes = await p.eval(`(${JSON.stringify(EDGE)}).map((sel) => [...document.querySelectorAll(sel)].filter((n) => n.getClientRects().length && getComputedStyle(n).visibility !== "hidden").map((n) => { const r = n.getBoundingClientRect(); return [sel, Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; })).flat()`);
    const safe = [phone.insets.left, phone.insets.top, phone.width - phone.insets.right, phone.height - phone.insets.bottom];
    const outside = boxes.filter(([, l, tp, r, b]) => l < safe[0] || tp < safe[1] || r > safe[2] || b > safe[3]);
    if (shots) fs.writeFileSync(path.join(shots, `board-safe-${phone.width}x${phone.height}.png`), Buffer.from((await p.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    t.ok(`${phone.name} (${phone.width}×${phone.height}, insets ${want.join("/")}): the zoom tools, the wordmark and the lightbox's controls are all inside the safe area`,
      boxes.length >= 6 && outside.length === 0, JSON.stringify({ safe, outside, seen: boxes.map((b) => b[0]) }));
  }
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await chrome?.close();
  await server?.stop();
}
process.exit(code);
