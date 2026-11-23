#!/usr/bin/env node
// A clip on a shared board, in an iPhone Simulator's Safari: does it play, and does a seek land where it was asked?
// Off the gate (scripts/ios/README.md says what it needs). On the gate's server (WGP_BASE, WGP_GATE_CARD).
//
//   LAB_UDID=<a device of your own> IOS_AXE=<the AXe binary> WGP_BASE=… WGP_GATE_CARD=… node scripts/ios/clip_share.mjs <out folder>
//
// The trip's host shares a board with one clip on it (a test pattern ffmpeg makes here, 12 s, its index at the end
// of the file as a phone's camera writes it), through the routes. The phone is a friend's who has never opened the
// app: erased, no cookie, nothing installed. The board's link is opened in a Mobile Safari tab (no worker in control,
// none registered: checked), and the clip is played in a video element on the page: it reads whether the clip plays
// (its time moves), whether a seek to 7.5 s shows 7.5 s's frame, and the relay's record of what reached the server
// and how it was answered (206s, no whole-file 200). Against a server that answers the clip with the whole file (200,
// no Range), the Simulator's Safari still played it and the seek still landed: only the third check, the answers
// themselves, tells that server apart. The share is revoked by its id at the end; the device is erased first and shut
// down at the end, whatever happens.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "./phone.mjs";
import { scene } from "../../checks/lib/images.mjs";
import { makeApi } from "../lib/seed_memories.mjs";
import { ORIGIN, tripApi } from "../lib/gate_trip.mjs";
import { freeLoopbackPort } from "../lib/browser.mjs";

const out = path.resolve(process.argv[2] || "");
if (!process.argv[2]) { console.error("usage: node scripts/ios/clip_share.mjs <out folder>"); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 400) : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 800) : ""}`); }
};

// The clip: a test pattern with its own clock, nothing filmed.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-clip-"));
const clipFile = path.join(dir, "clip.mp4");
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=12", "-c:v", "libx264", "-preset", "ultrafast",
  "-g", "30", "-pix_fmt", "yuv420p", clipFile], { stdio: ["ignore", "ignore", "inherit"] });
const clip = fs.readFileSync(clipFile);
fs.rmSync(dir, { recursive: true, force: true });

const api = await makeApi();
let shareId = null;
let phone = null;
let code = 1;
// Whatever throws, even outside this file's awaits (the relay's own handlers), the device goes down.
const downNow = (why) => {
  console.log(`\nSTOPPED (${why})`);
  try { execSync(`/usr/bin/xcrun simctl shutdown ${process.env.LAB_UDID}`, { stdio: "ignore" }); } catch { /* already down */ }
  console.log(`  note  the device shut down at ${new Date().toTimeString().slice(0, 8)}`);
  process.exit(1);
};
process.on("uncaughtException", (e) => downNow(e?.stack || e));
process.on("unhandledRejection", (e) => downNow(e?.stack || e));
try {
  const board = await api(`${tripApi("/collage/share")}?mime=image/png&w=1600&h=1200&title=Clip`, { method: "POST", body: new Uint8Array(scene(800, 600, 30)) });
  if (board.status !== 201) throw new Error("collage/share: " + board.text);
  shareId = board.json.share.id;
  const item = await api(`${tripApi(`/collage/share/${shareId}/item`)}?idx=0&kind=video&mime=video/mp4&w=640&h=360&fx=0.2&fy=0.2&fw=0.6&fh=0.6&rot=0`,
    { method: "POST", body: new Uint8Array(clip) });
  if (item.status !== 200) throw new Error("collage/share item: " + item.text);
  check("setup: a board shared with one clip on it (12 s, its index at the end)", true, `${clip.length} bytes, /s/${shareId}`);

  const listen = await freeLoopbackPort();
  // A friend who has never opened the app: the device erased (connect() does), no cookie, nothing installed. The link
  // is opened in Mobile Safari as a link from a message opens; the relay's probe in the page answers the walk.
  phone = await connect({ listen, upstream: Number(new URL(ORIGIN).port), out, said: [], pageErrors: [] });
  const tab = await phone.openTab();
  const sharedAt = `http://localhost:${listen}/s/${shareId}`;
  execFileSync("/usr/bin/xcrun", ["simctl", "openurl", process.env.LAB_UDID, sharedAt], { stdio: "ignore" });
  await tab.wait(`location.pathname.startsWith("/s/") && document.querySelectorAll(".tile").length === 1 ? 1 : 0`, "the board's page in Safari", 90000);
  await tab.shot("clip-1-board-in-safari");
  const workers = JSON.parse(await tab.page(`(async () => {
    const regs = navigator.serviceWorker ? await Promise.race([navigator.serviceWorker.getRegistrations().then((rs) => rs.length), new Promise((ok) => setTimeout(() => ok("no answer in 5 s"), 5000))]) : 0;
    return JSON.stringify({ controller: !!(navigator.serviceWorker && navigator.serviceWorker.controller), registrations: regs, standalone: matchMedia("(display-mode: standalone)").matches });
  })()`));
  check("a friend's first visit: the board's page in a Safari tab, with no worker in control and none registered", !workers.controller && workers.registrations === 0 && !workers.standalone,
    JSON.stringify(workers));
  const clipPath = `/s/${shareId}/i/0`;
  // The clip in a video element on the page, drawn above the board: loaded, played, then sought. Three calls, each
  // well inside the relay's 30 s for one answer; the element and what was read stay on the page between them.
  // `as` names the run; the clip's address carries it so the two runs' requests can be told apart.
  const walk = async (as, shotName) => {
    const src = `${clipPath}?as=${as}`;
    const asked = tab.requests.length;
    const step = async (body) => JSON.parse(await tab.page(`(async () => {
      const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(what)), ms))]);
      const r = window.__clip || (window.__clip = { worker: !!(navigator.serviceWorker && navigator.serviceWorker.controller), duration: null, seekable: null, played: false, movedTo: null, sought: null, shown: null, error: null });
      const v = window.__clipEl;
      try { ${body} } catch (e) { r.error = (r.error ? r.error + "; " : "") + e.message + (v && v.error ? " (MediaError " + v.error.code + ")" : ""); }
      return JSON.stringify(r);
    })()`));
    await step(`
      const el = document.createElement("video"); el.muted = true; el.playsInline = true; el.preload = "auto";
      el.setAttribute("playsinline", ""); el.setAttribute("muted", "");
      el.style.cssText = "position:fixed;left:0;top:120px;width:320px;height:180px;z-index:2147483647;background:#000";
      el.src = ${JSON.stringify(src)}; document.body.append(el); window.__clipEl = el;
      await within(new Promise((ok, no) => { el.onloadedmetadata = ok; el.onerror = () => no(new Error("the element's error " + (el.error && el.error.code))); }), 20000, "no metadata in 20 s");
      r.duration = el.duration; r.seekable = el.seekable.length ? el.seekable.end(el.seekable.length - 1) : 0;`);
    await step(`
      if (!v || r.duration == null) return JSON.stringify(r);
      await within(v.play(), 15000, "play() didn't start in 15 s");
      const t0 = v.currentTime;
      await new Promise((ok) => setTimeout(ok, 2500));
      r.movedTo = v.currentTime; r.played = v.currentTime > t0 + 0.5;
      v.pause();`);
    const read = await step(`
      if (!v || !r.played) return JSON.stringify(r);
      const framed = v.requestVideoFrameCallback ? new Promise((ok) => v.requestVideoFrameCallback((now, md) => ok(md.mediaTime))) : null;
      v.currentTime = 7.5;
      await within(new Promise((ok) => { v.onseeked = ok; }), 15000, "no seeked in 15 s");
      r.sought = v.currentTime;
      r.shown = framed ? await within(framed, 8000, "no frame in 8 s").catch(() => null) : null;`);
    await tab.shot(shotName);
    const answers = tab.requests.slice(asked).filter((q) => q.url.includes(clipPath)).map((q) => `${q.method} ${q.status ?? q.failed ?? "no answer"}`);
    console.log(`  note  ${as}: what reached the server for the clip, and its answers: ${answers.join(", ") || "nothing"}`);
    return { read, answers };
  };
  const plays = (r) => !r.error?.startsWith("no metadata") && r.played === true;
  const seeks = (r) => r.played === true && Math.abs((r.sought ?? 0) - 7.5) < 0.05 && (r.shown == null || Math.abs(r.shown - 7.5) < 0.05)
    && Math.abs((r.seekable ?? 0) - (r.duration ?? -1)) < 0.1;

  // The clip played and sought as the friend's Safari does it; the clip's requests reach the server as Safari makes them.
  const stranger = await walk("stranger", "clip-2-after-seek");
  check("as a stranger (no worker): the clip plays, its time moving", !stranger.read.worker && plays(stranger.read), JSON.stringify(stranger));
  check("as a stranger: a seek to 7.5 s lands there, the frame shown 7.5 s's", seeks(stranger.read), JSON.stringify(stranger));
  check("as a stranger: the server answered the clip's requests with 206 (a part of it), never 200 with the whole",
    stranger.answers.some((a) => / 206$/.test(a)) && !stranger.answers.some((a) => / 200$/.test(a)), stranger.answers.join(", "));
  console.log(`\n${pass} passed, ${fail} failed`);
  code = fail ? 1 : 0;
} catch (e) {
  console.log(`\nSTOPPED: ${e?.stack || e}\n${pass} passed, ${fail} failed before it stopped`);
  code = 1;
} finally {
  if (phone) { try { await phone.done(); } catch { /* down */ } }
  try { execSync(`/usr/bin/xcrun simctl shutdown ${process.env.LAB_UDID}`, { stdio: "ignore" }); } catch { /* already down */ }
  console.log(`  note  the device shut down at ${new Date().toTimeString().slice(0, 8)}`);
  if (shareId) { try { await api(tripApi(`/collage/share/${shareId}`), { method: "DELETE" }); console.log(`  note  the share ${shareId} revoked`); } catch { /* gone */ } }
}
process.exit(code);
