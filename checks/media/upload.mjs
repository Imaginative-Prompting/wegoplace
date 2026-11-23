// Big uploads: a file goes up in 8 MiB parts and comes back byte for byte. Two sizes: about
// 20 MiB (three parts, the size of video people really send) and 130 MiB (seventeen parts).
// It starts its own server on its own empty database and bucket, and stops it again.
//
//   node checks/media/upload.mjs [--port 8791] [--keep] [--sizes 20,130]   (MiB)
//   --browser   also from a real browser, the way the app sends a part (XMLHttpRequest with a
//               Blob, parts one after another on a connection the browser keeps open), first
//               with the app's service worker left out and then with it answering the page.
//               This starts a browser, so it goes through the machine's queue.
//
// Every part must answer; a part that hangs fails the check after 60 s instead of holding it.

import crypto from "node:crypto";
import { startServer, CheckError } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8791);
const sizes = (flag("--sizes") ?? "20,130").split(",").map((mib) => Math.round(Number(mib) * 1024 * 1024) + 12345);
const keep = argv.includes("--keep");
const inBrowser = argv.includes("--browser");

const TRIP = { id: "check-trip", name: "Check trip", starts_on: "2031-05-01", ends_on: "2031-05-09", default_tz: "Europe/Lisbon" };
/** Where the trip's stored files are sent and asked about. */
const MEDIA = `/api/trips/${TRIP.id}/media`;
const PART_WAIT = 60_000;

/** Part `n` as the browser makes it (see UPLOAD below): a pattern, so both sides can make the same bytes. */
function patternPart(n, length) {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + n * 7 + (i >>> 11)) & 255;
  return out;
}

/** In the page: upload `bytes` as the app does and answer what happened. */
const UPLOAD = (bytes, name) => `(async () => {
  const json = async (path, body) => { const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const begun = await json("${MEDIA}/begin", { name: ${JSON.stringify(name)}, mime: "video/mp4", bytes: ${bytes}, kind: "video" });
  if (begun.status !== 201) return { failed: "begin " + begun.status };
  const { key, uploadId, part_size: size, parts: count } = begun.body;
  const sendPart = (url, blob) => new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.timeout = ${PART_WAIT};
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.response });
    xhr.onerror = () => resolve({ status: 0, why: "the connection failed" });
    xhr.ontimeout = () => resolve({ status: 0, why: "no answer in ${PART_WAIT / 1000} s" });
    xhr.send(blob);
  });
  const etags = [];
  for (let n = 1; n <= count; n++) {
    const length = n < count ? size : ${bytes} - size * (count - 1);
    const part = new Uint8Array(length);
    for (let i = 0; i < length; i++) part[i] = (i * 31 + n * 7 + (i >>> 11)) & 255;
    const res = await sendPart("${MEDIA}/part?key=" + encodeURIComponent(key) + "&id=" + encodeURIComponent(uploadId) + "&n=" + n, new Blob([part]));
    if (res.status !== 200 || !res.body?.etag) return { failed: "part " + n + " of " + count + ": " + (res.why || res.status), key };
    etags.push({ n, etag: res.body.etag });
  }
  const done = await json("${MEDIA}/finish", { key, id: uploadId, parts: etags });
  return { key, count, size, finish: done.status, bytes: done.body?.bytes, controlled: !!navigator.serviceWorker?.controller };
})()`;

/** `bytes` of noise that is the same every run, made a part at a time (never the whole file in memory twice). */
function partOf(seed, n, length) {
  const out = Buffer.alloc(length);
  let block = crypto.createHash("sha256").update(`${seed}:${n}`).digest();
  for (let at = 0; at < length; at += 32) {
    block = crypto.createHash("sha256").update(block).digest();
    block.copy(out, at, 0, Math.min(32, length - at));
  }
  return out;
}

const within = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} didn't answer in ${ms / 1000} s`)), ms).unref()),
]);

const t = new Report("big uploads");
let server;
let code = 1;
try {
  server = await startServer({ name: "upload", port, keep });
  await server.start();
  const { origin } = server;

  const uma = new Person(origin, "Uma Check");
  await uma.signUp();
  const brought = await uma.post("/api/trips", TRIP);
  if (brought.status !== 201) throw new CheckError(`couldn't make a trip to upload to: ${brought.status} ${brought.text.slice(0, 200)}`);

  for (const bytes of sizes) {
    const mib = (bytes / 1024 / 1024).toFixed(1);
    t.part(`A ${mib} MiB video`);
    const begun = await uma.post(`${MEDIA}/begin`, { name: `check-${mib}.mp4`, mime: "video/mp4", bytes, kind: "video" });
    if (!t.same("the upload opens, in 8 MiB parts", [begun.status, begun.json?.part_size, begun.json?.parts], [201, 8 * 1024 * 1024, Math.ceil(bytes / (8 * 1024 * 1024))])) continue;
    const { key, uploadId, part_size: partSize, parts: count } = begun.json;
    const sent = crypto.createHash("sha256");
    const etags = [];
    const slow = [];
    let failed = null;
    const started = Date.now();
    for (let n = 1; n <= count && !failed; n++) {
      const body = partOf(mib, n, n < count ? partSize : bytes - partSize * (count - 1));
      sent.update(body);
      const at = Date.now();
      try {
        const res = await within(uma.call("POST", `${MEDIA}/part?key=${encodeURIComponent(key)}&id=${encodeURIComponent(uploadId)}&n=${n}`, body,
          { headers: { "Content-Type": "application/octet-stream" } }), PART_WAIT, `part ${n} of ${count}`);
        if (res.status !== 200 || !res.json?.etag) failed = `part ${n} of ${count}: ${res.status} ${res.text.slice(0, 200)}`;
        else etags.push({ n, etag: res.json.etag });
      } catch (e) { failed = e.message; }
      if (Date.now() - at > 10_000) slow.push(`part ${n}: ${((Date.now() - at) / 1000).toFixed(1)} s`);
    }
    t.ok(`all ${count} parts are taken (${((Date.now() - started) / 1000).toFixed(1)} s)`, !failed && etags.length === count, failed ?? "");
    t.ok("no part takes longer than 10 s", slow.length === 0, slow.join(", "));
    if (failed) continue;
    const done = await within(uma.post(`${MEDIA}/finish`, { key, id: uploadId, parts: etags }), PART_WAIT, "finish");
    t.same("the upload finishes at its full size", [done.status, done.json?.bytes], [200, bytes]);

    // Back down, whole, and compared by hash; then a range from the middle of it.
    const whole = await fetch(`${origin}/media/${key.split("/").map(encodeURIComponent).join("/")}`, { headers: { Cookie: uma.jar.header() } });
    const got = crypto.createHash("sha256");
    let length = 0;
    for await (const chunk of whole.body) { got.update(chunk); length += chunk.length; }
    t.same("what comes back is what went up, byte for byte", [whole.status, length, got.digest("hex")], [200, bytes, sent.digest("hex")]);
    const from = partSize - 5, to = partSize + 4;      // across the first part's edge
    const range = await fetch(`${origin}/media/${key.split("/").map(encodeURIComponent).join("/")}`, { headers: { Cookie: uma.jar.header(), Range: `bytes=${from}-${to}` } });
    const want = Buffer.concat([partOf(mib, 1, partSize).subarray(partSize - 5), partOf(mib, 2, Math.min(partSize, bytes - partSize)).subarray(0, 5)]);
    t.same("and a range across two parts is those bytes", [range.status, Buffer.from(await range.arrayBuffer()).toString("hex")], [206, want.toString("hex")]);
  }

  if (inBrowser) {
    const { openChrome } = await import("../lib/chrome.mjs");
    const chrome = await openChrome();
    try {
      const token = uma.jar.cookies.get("wgp_session");
      for (const withWorker of [false, true]) {
        const page = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false, serviceWorker: withWorker });
        await page.setCookie(origin, "wgp_session", token);
        await page.goto(`${origin}/`);
        if (withWorker) {
          // The page a person has is one the service worker answers: wait for it, then load again.
          await page.until(`navigator.serviceWorker.getRegistration().then((r) => !!(r && r.active))`, "the app's service worker to be ready", 90000);
          await page.goto(`${origin}/`);
          await page.until(`!!navigator.serviceWorker.controller`, "the service worker to answer the page");
        }
        for (const bytes of sizes) {
          const mib = (bytes / 1024 / 1024).toFixed(1);
          t.part(`A ${mib} MiB video from a browser, ${withWorker ? "with the app's service worker answering the page" : "the service worker left out"}`);
          const started = Date.now();
          let got;
          try { got = await within(page.eval(UPLOAD(bytes, `browser-${mib}.mp4`)), PART_WAIT * 3, "the upload"); } catch (e) { got = { failed: e.message }; }
          // With the worker left out, the browser is told to send this page's requests past any
          // service worker (chrome.mjs), so whether one has taken the page by now says nothing:
          // the app's page registers its worker either way, and it claims the page when it is
          // ready. With the worker in, it must be answering the page, or this run proved nothing.
          t.ok(`every part is taken and the upload finishes (${((Date.now() - started) / 1000).toFixed(1)} s)`, !got.failed && got.finish === 200 && got.bytes === bytes && (got.controlled || !withWorker), got);
          if (got.failed || got.finish !== 200) continue;
          const want = crypto.createHash("sha256");
          for (let n = 1; n <= got.count; n++) want.update(patternPart(n, n < got.count ? got.size : bytes - got.size * (got.count - 1)));
          const back = await fetch(`${origin}/media/${got.key.split("/").map(encodeURIComponent).join("/")}`, { headers: { Cookie: uma.jar.header() } });
          const have = crypto.createHash("sha256");
          for await (const chunk of back.body) have.update(chunk);
          t.same("what comes back is what went up", have.digest("hex"), want.digest("hex"));
        }
      }
    } finally {
      await chrome.close().catch((e) => console.error(e.message));
    }
  }

  t.part("The server's log");
  const log = server.log();
  const errors = log.split("\n").filter((line) => /Uncaught|✘|\[ERROR\]|\b500\b|Error inside|Failed to drain|Network connection lost/.test(line));
  t.ok("nothing failed inside the server, and no request body was left undrained", errors.length === 0, errors.slice(0, 6).join("\n        "));
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  if (keep && server) console.log(`kept: ${server.work}`);
  await server?.stop();
}
process.exit(code);
