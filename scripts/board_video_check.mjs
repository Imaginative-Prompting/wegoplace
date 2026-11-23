#!/usr/bin/env node
/* The in-app board's videos play in place: a video print loops its trimmed seconds, muted, and
 * stops under an open memory and where the phone asks for less.
 *
 *   node scripts/gate.mjs --who <session> --only board_video     (the gate's own server, its made-up trip)
 *
 * It brings its own memories, made before the browser starts and removed when it ends however it
 * ends: three photos (scripts/lib/seed_memories.mjs) and one video, a ten-second clip made here
 * with ffmpeg (a test pattern with its own clock, nothing filmed), trimmed to 3.0–5.5 s through
 * the framing route a person's trim goes through.
 *
 * WHAT IT PROVES, on the board at 390 by real taps
 *   1. The video print has a <video> of its own inside its box, muted, playing, painted (the
 *      poster's play disc gone), and for six seconds every reading of its clock is inside the
 *      trim, it moves, and it goes back to the trim's start at least once.
 *   2. Its print tapped opens the memory, and nothing on the board plays under it; closed, the
 *      print plays again.
 *   3. Reduced motion: after a reload nothing on the board plays by itself, and the play disc
 *      shows. The same when the phone says it saves data (navigator.connection.saveData).
 *
 *   1b. Its play disc fades out over about 200 ms once the clip's first frame shows, rather than vanishing in one frame,
 *       and on every frame of the fade it is on top of the clip at its centre (what a person sees, by hit-testing).
 *   1c. The board behind the Feed: none of its videos plays; back on the board, the print plays again.
 *   2b. With the memory still open, the app hidden and shown again: nothing on the board plays under it.
 *   3c. Data saver turned on while the board plays: it stops; turned off: it plays again.
 *
 * PLANTED: BOARDVIDEO_PLANT=fixes serves memories.js as it was before 17 Nov's two fixes: 2b and 3c red.
 * BOARDVIDEO_PLANT=order serves collage.css without the disc's z-index (the clip over the fade): 1b red.
 * BOARDVIDEO_PLANT=1 serves memories.js as it was before the board had its videos
 * (the board mounted with no `video:`): 1 and 2 go red, 3 stays green.
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, REPO, appSettled, boot, evalIn, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { makeApi, seedMemories } from "./lib/seed_memories.mjs";
import { tripApi, tripPath } from "./lib/gate_trip.mjs";

// BOARDVIDEO_PLANT=1: memories.js before the board had videos (1 and 2 red). BOARDVIDEO_PLANT=fixes: memories.js
// before 17 Nov's two fixes (one pause flag; data saver read once): 2b and 3c red. BOARDVIDEO_PLANT=disc: collage.css
// before the disc faded (it vanished in one frame): 1b red.
const PLANT = !!process.env.BOARDVIDEO_PLANT;
const PLANT_FIXES = process.env.BOARDVIDEO_PLANT === "fixes";
const PLANT_DISC = process.env.BOARDVIDEO_PLANT === "disc";
// BOARDVIDEO_PLANT=hidden: today's collage.js without the line that lets the videos go when the board is hidden: 1c red.
const PLANT_HIDDEN = process.env.BOARDVIDEO_PLANT === "hidden";
// BOARDVIDEO_PLANT=order: today's collage.css without the disc's z-index (the clip paints over the fading disc): 1b red.
const PLANT_ORDER = process.env.BOARDVIDEO_PLANT === "order";
// The commit whose memories.js mounted the board with no video pool: the file the plant serves.
const BEFORE = PLANT_FIXES ? "f5c5627" : "a4af15f";
const TRIM = { start: 3.0, end: 5.5 };
const SLACK = 0.25;      // seconds either side of the trim a reading may land (a seek lands on a frame)
const PART = 8 * 1024 * 1024;

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
};
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const J = async (c, S, e) => JSON.parse(await evalIn(c, S, `Promise.resolve(${e}).then((v) => JSON.stringify(v))`));

// ── the clip ────────────────────────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-board-video-"));
const clip = path.join(dir, "clip.mp4"), poster = path.join(dir, "clip.jpg");
execSync(`ffmpeg -v error -y -f lavfi -i "testsrc2=size=640x360:rate=30:duration=10" -c:v libx264 -preset ultrafast -pix_fmt yuv420p `
  + `-g 15 -keyint_min 15 -sc_threshold 0 -movflags +faststart ${JSON.stringify(clip)}`);
execSync(`ffmpeg -v error -y -ss 3 -i ${JSON.stringify(clip)} -frames:v 1 -vf scale=480:-2 -q:v 4 ${JSON.stringify(poster)}`);
const clipBytes = fs.readFileSync(clip), posterBytes = new Uint8Array(fs.readFileSync(poster));
fs.rmSync(dir, { recursive: true, force: true });

const api = await makeApi();
const photos = await seedMemories(3);
let videoMemory = null;
const keys = [];
async function upload(buf, name, mime, kind) {
  const beg = await api(tripApi("/media/begin"), { method: "POST", body: { name, mime, bytes: buf.length, kind } });
  if (beg.status !== 201) throw new Error("media/begin: " + beg.text);
  const { key, uploadId, parts } = beg.json;
  const etags = [];
  for (let n = 1; n <= parts; n++) {
    const r = await api(`${tripApi("/media/part")}?key=${encodeURIComponent(key)}&id=${encodeURIComponent(uploadId)}&n=${n}`,
      { method: "POST", body: buf.subarray((n - 1) * PART, Math.min(n * PART, buf.length)) });
    if (r.status !== 200) throw new Error(`media/part ${n}: ` + r.text);
    etags.push({ n, etag: r.json.etag });
  }
  const fin = await api(tripApi("/media/finish"), { method: "POST", body: { key, id: uploadId, parts: etags } });
  if (fin.status !== 200) throw new Error("media/finish: " + fin.text);
  keys.push(key);
  return key;
}
async function cleanup() {
  if (videoMemory) { try { await api(tripApi(`/memories/${videoMemory}`), { method: "DELETE" }); } catch { /* gone */ } videoMemory = null; }
  while (keys.length) { const k = keys.pop(); try { await api(`${tripApi("/media/object")}?key=${encodeURIComponent(k)}`, { method: "DELETE" }); } catch { /* gone */ } }
  await photos.cleanup();
}

let b = null;
let code = 1;
try {
  const key = await upload(clipBytes, "clip.mp4", "video/mp4", "video");
  const th = await api(`${tripApi("/media/thumb")}?for=${encodeURIComponent(key)}&mime=image/jpeg`, { method: "POST", body: posterBytes });
  if (th.status !== 200 && th.status !== 201) throw new Error("media/thumb: " + th.text);
  if (th.json?.key) keys.push(th.json.key);
  const made = await api(tripApi("/memories"), { method: "POST",
    body: { caption: "The test pattern at the pass", tags: ["standalone verify"], media: [{ key, thumb_key: th.json.key, kind: "video", w: 640, h: 360, duration: 10 }] } });
  if (made.status !== 201) throw new Error("memories POST: " + made.text);
  videoMemory = made.json.memory.id;
  const mediaId = made.json.memory.media[0].id;
  const trimmed = await api(tripApi(`/memories/${videoMemory}`), { method: "PATCH", body: { framing: { [mediaId]: { trim_start_s: TRIM.start, trim_end_s: TRIM.end } } } });
  check(`setup: a ten-second video memory trimmed to ${TRIM.start}–${TRIM.end} s, beside three photos`, trimmed.status === 200, `${trimmed.status} ${trimmed.text.slice(0, 120)}`);
  const itemSel = `.cg-item[data-id="${videoMemory}:${mediaId}"]`;

  b = await boot({ vw: 390, vh: 844, reduceMotion: false });
  const { cdp, S } = b;
  await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });
  // The disc's fade, recorded from the first frame a print is marked live: its opacity on every frame for half a second,
  // and whether it is what's on top at its own centre (what a person sees): hit-testing follows the paint order, so for
  // the recording the disc and the clip are made hit-testable (they take no taps in the app), and put back after.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    window.__discFade = null;
    new MutationObserver((list) => {
      for (const m of list) {
        const el = m.target;
        if (window.__discFade || el.dataset.live !== "1") continue;
        const disc = el.querySelector(".cg-play") || el.closest(".cg-item")?.querySelector(".cg-play");
        if (!disc) continue;
        const seen = window.__discFade = [];
        const t0 = performance.now();
        const hit = document.createElement("style");
        hit.textContent = ".cg-play, .cg-play *, .cgv-v { pointer-events: auto !important; }";
        document.head.append(hit);
        const f = () => { const cs = getComputedStyle(disc); const r = disc.getBoundingClientRect();
          const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          seen.push({ t: Math.round(performance.now() - t0), o: Math.round(parseFloat(cs.opacity) * 100) / 100, v: cs.visibility, d: cs.display,
            top: at ? (disc.contains(at) ? "disc" : at.tagName === "VIDEO" ? "video" : at.className || at.tagName) : null });
          if (performance.now() - t0 < 500) requestAnimationFrame(f); else hit.remove(); };
        f();
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-live"] });
  })()` }, S);
  if (PLANT) {
    const [file, type] = PLANT_DISC || PLANT_ORDER ? ["public/css/collage.css", "text/css"] : PLANT_HIDDEN ? ["public/js/collage.js", "text/javascript"] : ["public/js/memories.js", "text/javascript"];
    const old = PLANT_ORDER
      ? (() => { const s = execFileSync("cat", [file], { cwd: REPO, encoding: "utf8" }); const t = s.replace(/^  z-index: 1; .*\n/m, ""); if (t === s) throw new Error("the plant changed nothing"); return t; })()
      : PLANT_HIDDEN
      ? execFileSync("cat", [file], { cwd: REPO, encoding: "utf8" }).replace(/^      if \(opts\.video && opts\.video\.update\) \{ try \{ opts\.video\.update\(\[\]\); \}.*\n/m, "")
      : execFileSync("git", ["show", `${PLANT_DISC ? "f5c5627" : BEFORE}:${file}`], { cwd: REPO, encoding: "utf8" });
    cdp.on((m) => {
      if (m.sessionId !== S || m.method !== "Fetch.requestPaused") return;
      cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: `${type}; charset=utf-8` }, { name: "Cache-Control", value: "no-store" }],
        body: Buffer.from(old).toString("base64") }, S).catch(() => {});
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: PLANT_DISC || PLANT_ORDER ? "*/css/collage.css*" : PLANT_HIDDEN ? "*/js/collage.js*" : "*/js/memories.js*" }] }, S);
  }
  const tap = async (sel) => {
    const p = await J(cdp, S, `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null;
      const r = n.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) throw new Error("nothing to tap: " + sel);
    const pt = [{ x: p.x, y: p.y, radiusX: 6, radiusY: 6, force: 1, id: 1 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt }, S);
    await sleep(60);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, S);
    await sleep(600);
  };
  const openBoard = async () => {
    // A fresh document each time (a query of its own): the same address with only its # changed is the
    // same page, and the board mounted under the last setting would go on as it was.
    await cdp.send("Page.navigate", { url: `${BASE}${tripPath(`?board=${Date.now()}#/memories`)}` }, S);
    await appSettled(cdp, S);
    await waitFor(cdp, S, `document.querySelector('.me-viewbtn[data-view="collage"]') ? 1 : 0`, { label: "the view toggle" });
    await tap('.me-viewbtn[data-view="collage"]');
    await waitFor(cdp, S, `document.querySelector(${JSON.stringify(itemSel)}) ? 1 : 0`, { label: "the video print on the board" });
    // The print near the middle, where the board gives its decoders first.
    await evalIn(cdp, S, `(() => { const n = document.querySelector(${JSON.stringify(itemSel)}); n && n.scrollIntoView({ block: "center" }); return 1; })()`);
    await sleep(1200);
  };
  // What the board's videos are doing: the print's own, and every other on the board.
  const READ = `(() => { const box = document.querySelector(${JSON.stringify(itemSel)}); const v = box && box.querySelector("video");
    const disc = box && box.querySelector(".cg-play"); const all = [...document.querySelectorAll(".cg-item video")];
    return { has: !!v, t: v ? Math.round(v.currentTime * 1000) / 1000 : null, paused: v ? v.paused : null, muted: v ? v.muted : null,
      live: box ? box.dataset.live === "1" || !!box.querySelector('[data-live="1"]') : false,
      disc: !!disc && disc.getClientRects().length > 0 && (() => { const cs = getComputedStyle(disc); return cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0.05; })(),
      playing: all.filter((x) => !x.paused).length }; })()`;

  // ── 1. it plays its trim ────────────────────────────────────────────────────────────────
  section("1. the video print plays its trimmed seconds, in a loop");
  await openBoard();
  // Playing, painted (live) and its disc faded: the disc goes once the clip's first frame shows, over 200 ms.
  const first = await waitFor(cdp, S, `(() => { const r = ${READ}; return r.has && !r.paused && r.t > 0 && r.live && !r.disc ? 1 : 0; })()`, { label: "the print playing", timeout: 15000 }).then(() => true, () => false);
  const at = await J(cdp, S, READ);
  // 1b. The disc fades as the clip's first frame shows: not gone in one frame.
  await sleep(600);
  const fade = await J(cdp, S, `window.__discFade`);
  const mid = (fade || []).filter((f) => f.o > 0.05 && f.o < 0.95);
  const between = mid.length;
  const covered = mid.filter((f) => f.top !== "disc");
  const last = fade && fade[fade.length - 1];
  check("1b. its play disc fades out as the clip starts (frames between shown and gone), on top of the clip on every one of them, and ends gone",
    between >= 2 && covered.length === 0 && !!last && last.o === 0 && last.v === "hidden",
    JSON.stringify({ frames: fade && fade.length, between, covered: covered.length, firstCovered: covered[0] || null, first: fade && fade.slice(0, 4), last }));
  check("the print has its own <video>, muted and playing, and the play disc is gone", first && at.has && at.muted === true && at.paused === false && !at.disc, JSON.stringify(at));
  const samples = [];
  for (let i = 0; i < 60; i++) { samples.push((await J(cdp, S, READ)).t); await sleep(100); }
  const seen = samples.filter((t) => t !== null);
  const inside = seen.every((t) => t >= TRIM.start - SLACK && t <= TRIM.end + SLACK);
  const wraps = seen.slice(1).filter((t, i) => seen[i] - t > 1).length;
  const span = seen.length ? Math.max(...seen) - Math.min(...seen) : 0;
  check(`for six seconds every reading is inside ${TRIM.start}–${TRIM.end} s`, seen.length >= 50 && inside,
    `${seen.length} readings, ${Math.min(...seen)}–${Math.max(...seen)} s`);
  check("  it moves, and goes back to the start at least once", span > 1.5 && wraps >= 1, `span ${span.toFixed(2)} s, ${wraps} wrap(s)`);

  // 1c. The board hidden behind the Feed: its videos stop (nothing decodes in a stage no one sees), and play again on return.
  if (at.has) {
    await tap('.me-viewbtn[data-view="feed"]');
    await waitFor(cdp, S, `(() => { const r = document.querySelector(".cg-root"); return r && r.offsetWidth === 0 ? 1 : 0; })()`, { label: "the board hidden", timeout: 5000 }).catch(() => null);
    await sleep(400);
    const behind = await J(cdp, S, `({ playing: [...document.querySelectorAll(".cg-item video")].filter((v) => !v.paused).length, videos: document.querySelectorAll(".cg-item video").length,
      board: (() => { const r = document.querySelector(".cg-root"); return r ? [r.offsetWidth, r.offsetHeight] : null; })() })`);
    check("1c. the board behind the Feed: none of its videos plays", behind.playing === 0, JSON.stringify(behind));
    await tap('.me-viewbtn[data-view="collage"]');
    const again = await waitFor(cdp, S, `(() => { const r = ${READ}; return r.has && !r.paused ? 1 : 0; })()`, { label: "playing again", timeout: 8000 }).then(() => true, () => false);
    check("   back on the board, the print plays again", again, JSON.stringify(await J(cdp, S, READ)));
  }

  // ── 2. under an open memory ─────────────────────────────────────────────────────────────
  section("2. an open memory over the board");
  if (at.has) {
    await tap(itemSel);
    await waitFor(cdp, S, `document.querySelector(".me-view") ? 1 : 0`, { label: "the memory open" }).catch(() => null);
    await sleep(800);
    const under = await J(cdp, S, READ);
    check("its print tapped opens the memory, and nothing on the board plays under it", !!(await evalIn(cdp, S, `document.querySelector(".me-view") ? 1 : 0`)) && under.playing === 0, JSON.stringify(under));
    // 2b. The app left and come back to (the phone locked and opened, another app and back) with the memory
    // still open over the board: the board's videos stay paused under it.
    await evalIn(cdp, S, `(() => {
      Object.defineProperty(Document.prototype, "visibilityState", { get: () => window.__vis || "visible", configurable: true });
      window.__vis = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
      return 1; })()`);
    await sleep(600);
    await evalIn(cdp, S, `(window.__vis = "visible", document.dispatchEvent(new Event("visibilitychange")), 1)`);
    await sleep(1500);
    const back = await J(cdp, S, READ);
    check("  the app hidden and shown again with the memory still open: nothing on the board plays under it", back.playing === 0, JSON.stringify(back));
    await evalIn(cdp, S, `(() => { const c = document.querySelector(".me-vclose"); c && c.click(); return 1; })()`);
    await waitFor(cdp, S, `document.querySelector(".me-view") ? 0 : 1`, { label: "the memory closed" }).catch(() => null);
    const again = await waitFor(cdp, S, `(() => { const r = ${READ}; return r.has && !r.paused ? 1 : 0; })()`, { label: "the print playing again", timeout: 8000 }).then(() => true, () => false);
    check("  closed, the print plays again", again, JSON.stringify(await J(cdp, S, READ)));
  } else {
    check("its print tapped opens the memory, and nothing on the board plays under it", false, "no video on the board to begin with");
  }

  // ── 3. where the phone asks for less ────────────────────────────────────────────────────
  section("3. reduced motion, and a phone saving data");
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, S);
  await openBoard();
  await sleep(2500);
  const still = await J(cdp, S, READ);
  check("reduced motion: nothing on the board plays by itself, and the play disc shows", still.playing === 0 && still.disc, JSON.stringify(still));
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] }, S);
  // A phone saving data, as Chrome says one is (navigator.connection.saveData true).
  await cdp.send("Emulation.setDataSaverOverride", { dataSaverEnabled: true }, S);
  await openBoard();
  await sleep(2500);
  const saved = await J(cdp, S, READ);
  const says = await evalIn(cdp, S, `navigator.connection ? navigator.connection.saveData : "none"`);
  check("saving data: nothing on the board plays by itself, and the play disc shows", says === true && saved.playing === 0 && saved.disc, JSON.stringify({ saveData: says, ...saved }));
  await cdp.send("Emulation.setDataSaverOverride", {}, S);

  // 3c. Data saver turned on while the board plays, then off: read when it changes, not only when the board opens.
  await openBoard();
  await waitFor(cdp, S, `(() => { const r = ${READ}; return r.playing > 0 ? 1 : 0; })()`, { label: "the print playing", timeout: 15000 }).catch(() => null);
  const before = await J(cdp, S, READ);
  // Chrome's switch, and the change the phone announces with it (dispatched too, in case the switch alone doesn't).
  await cdp.send("Emulation.setDataSaverOverride", { dataSaverEnabled: true }, S);
  await evalIn(cdp, S, `(navigator.connection && navigator.connection.dispatchEvent(new Event("change")), 1)`);
  await sleep(1500);
  const on = await J(cdp, S, READ);
  check("data saver turned on while the board plays: it stops, the print let go to its poster and its play disc", before.playing > 0 && on.playing === 0 && !on.has && on.disc,
    JSON.stringify({ before: before.playing, on }));
  await cdp.send("Emulation.setDataSaverOverride", {}, S);
  await evalIn(cdp, S, `(navigator.connection && navigator.connection.dispatchEvent(new Event("change")), 1)`);
  const off = await waitFor(cdp, S, `(() => { const r = ${READ}; return r.playing > 0 ? 1 : 0; })()`, { label: "playing again", timeout: 8000 }).then(() => true, () => false);
  check("  and turned off again: it plays again", off, JSON.stringify(await J(cdp, S, READ)));

  const errors = b.pageErrors || [];
  console.log(`\n${pass} passed, ${fail} failed${PLANT ? ` (PLANTED: ${PLANT_DISC ? "collage.css before the disc's fade" : PLANT_ORDER ? "collage.css with the clip over the disc" : PLANT_HIDDEN ? "collage.js without letting the videos go when hidden" : PLANT_FIXES ? "memories.js from before the two fixes" : "memories.js from before the board's videos"})` : ""}`);
  if (fail) console.log(`failed: ${failures.join(" | ")}`);
  if (errors.length) console.log(`page errors: ${JSON.stringify(errors).slice(0, 600)}`);
  code = fail ? 1 : 0;
} catch (e) {
  console.log(`\nSTOPPED: ${e?.stack || e}\n${pass} passed, ${fail} failed before it stopped`);
  code = 1;
} finally {
  if (b) { try { await b.done(); } catch { /* gone */ } }
  await cleanup().catch(() => {});
}
process.exit(code);
