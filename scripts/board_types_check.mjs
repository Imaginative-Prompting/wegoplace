#!/usr/bin/env node
/* A shared board whose memories hold a photograph the server can't keep as it is: every print still opens.
 *
 * Chrome needs the Bash sandbox disabled, and the launcher (scripts/lib/browser.mjs) starts it only through the queue:
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> --label <what> -- node scripts/board_types_check.mjs
 *
 * Why it exists: what a board's link serves is cleaned of what a camera wrote into it (src/media/strip.js), and the
 * server refuses what it can't clean: HEIC and AVIF (415). A memory keeps its original exactly, and an iPhone shoots
 * HEIC, so the phone sends a JPEG it draws itself for such a photograph (public/js/memories.js, sendable()). A
 * drawing carries no camera data. Without that, the print was silently left out: on the board, not tappable, nothing
 * said.
 *
 * ITS OWN SERVER (checks/lib/server.mjs) on a free port. One made-up person, two trips, each with two memories made
 * through the routes: a JPEG and an AVIF on one, a JPEG and a HEIC on the other (each made here by sips from a picture
 * the tree carries; a JPEG thumbnail each). Chrome for Testing draws AVIF and can't read HEIC: so the first shows the
 * drawing at work, the second the words for a photograph no browser here can draw (Safari draws HEIC).
 *
 * WHAT IT PROVES
 *   1. JPEG + AVIF: the board is shared; the app sent the AVIF's print as a JPEG it drew, at the photograph's own size;
 *      the server keeps a print for each memory, every one a JPEG; the board's page has a tile for each; the share's
 *      sentence says nothing is lost.
 *   2. JPEG + HEIC (in Chrome): the board is shared; the JPEG's print is kept; the share's sentence ends "1 photo on it
 *      won't open full size: this browser can't read it."; nothing for the HEIC was kept.
 *   3. No page error.
 * Planted (board-types plants, the code before the drawing): the AVIF's print missing and nothing said: red.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";

const server = await startServer({ name: "board-types", port: await freeLoopbackPort() });
ownServer(server.origin);
const { REPO, appSettled, boot, evalIn, sleep, waitFor } = await import("./lib/standalone_cdp.mjs");

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 320) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 800) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// The pictures, made from one the tree carries: 1200 px on the long side, and a 400 px JPEG thumbnail of each.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-board-types-"));
const SRC = path.join(REPO, "public/img/demo-hero.webp");
const made = (name, format, px) => {
  const out = path.join(TMP, name);
  execFileSync("sips", ["-s", "format", format, "-Z", String(px), SRC, "--out", out], { stdio: "ignore" });
  return fs.readFileSync(out);
};
const ORIGINAL = { jpeg: made("o.jpg", "jpeg", 1200), avif: made("o.avif", "avif", 1200), heic: made("o.heic", "heic", 1200) };
const THUMB = made("t.jpg", "jpeg", 400);
// The photographs' own size (all three are the same picture at the same size).
const [W, H] = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path.join(TMP, "o.avif")], { encoding: "utf8" })
  .match(/pixelWidth: (\d+)\s+pixelHeight: (\d+)/).slice(1, 3).map(Number);

const browsers = [];
try {
  await server.start();
  const host = new Person(server.origin, "Iris Pell");
  await host.signUp();
  // A memory made through the routes, as the app makes one: the original, its thumbnail, the memory.
  async function memory(T, id, caption, mime, bytes) {
    const begun = (await host.post(`${T}/media/begin`, { name: `${id}.${mime.split("/")[1]}`, mime, bytes: bytes.length, kind: "photo" })).json;
    const part = await host.call("PUT", `${T}/media/part?key=${encodeURIComponent(begun.key)}&id=${encodeURIComponent(begun.uploadId)}&n=1`, bytes, { headers: { "Content-Type": "application/octet-stream" } });
    await host.post(`${T}/media/finish`, { key: begun.key, id: begun.uploadId, parts: [{ n: 1, etag: part.json?.etag }] });
    const th = await host.call("POST", `${T}/media/thumb?for=${encodeURIComponent(begun.key)}&mime=image/jpeg`, THUMB, { headers: { "Content-Type": "image/jpeg" } });
    const m = await host.post(`${T}/memories`, { id, caption, media: [{ key: begun.key, thumb_key: th.json?.key, kind: "photo", w: W, h: H }] });
    if (m.status !== 201) throw new Error(`memory ${id}: ${m.status} ${m.text}`);
  }
  async function tripWith(name, second) {
    const t = (await host.post("/api/trips", { name, default_tz: "Europe/Lisbon" })).json.trip.id;
    await memory(`/api/trips/${t}`, `m-${second}-jpeg`, "Station, as a JPEG", "image/jpeg", ORIGINAL.jpeg);
    await memory(`/api/trips/${t}`, `m-${second}`, `Station, as ${second.toUpperCase()}`, `image/${second}`, ORIGINAL[second]);
    return t;
  }
  const tripAvif = await tripWith("AVIF trip", "avif"), tripHeic = await tripWith("HEIC trip", "heic");

  const b = await boot({ vw: 390, vh: 844, dsf: 1 });
  browsers.push(b);
  const { cdp, S } = b;
  const sent = [];
  cdp.on((m) => { if (m.sessionId === S && m.method === "Network.requestWillBeSent") sent.push(`${m.params.request.method} ${m.params.request.url}`); });
  await cdp.send("Network.deleteCookies", { name: "s2", url: server.origin }, S);
  await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: host.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
  const page = (expr) => evalIn(cdp, S, expr);
  const wait = (expr, label, timeout = 45000) => waitFor(cdp, S, expr, { label, timeout });
  // Open a trip's board, share it, and answer the link's id and the sentence under it.
  async function share(tripId) {
    await cdp.send("Page.navigate", { url: `${server.origin}/t/${tripId}/?${Date.now()}#/memories` }, S);
    await appSettled(cdp, S);
    await wait(`document.querySelectorAll(".me-card").length === 2 ? 1 : 0`, "the two memories");
    await page(`(document.querySelector('.me-viewbtn[data-view="collage"]').click(), 1)`);
    await wait(`document.querySelector(".cg-look") ? 1 : 0`, "the board");
    await sleep(1500);
    await page(`(document.querySelector(".cg-look").click(), 1)`);
    await wait(`document.querySelector('.cg-lookfoot .cg-save[data-kind="link"]') ? 1 : 0`, "the board's sheet");
    sent.length = 0;
    await page(`(document.querySelector('.cg-lookfoot .cg-save[data-kind="link"]').click(), 1)`);
    await wait(`/^Link (copied|ready)/.test((document.querySelector(".cg-lookstat") || {}).textContent || "") ? 1 : 0`, "the link and its sentence", 120000);
    const id = (await page(`document.querySelector(".cg-shareurl").value`)).split("/s/")[1];
    return { id, said: await page(`document.querySelector(".cg-lookstat").textContent`), items: sent.filter((u) => /^POST .*\/collage\/share\/[^/]+\/item\?/.test(u)).map((u) => new URL(u.split(" ")[1]).searchParams) };
  }
  const kept = (id) => server.sql(`SELECT memory_id, mime, width, height FROM collage_share_items WHERE share_id = '${String(id).replace(/[^\w-]/g, "")}' ORDER BY memory_id`);
  const tiles = async (id) => ((await (await fetch(`${server.origin}/s/${id}`)).text()).match(/class="tile"/g) || []).length;

  section("1. a JPEG and an AVIF: the AVIF's print drawn as a JPEG, every print opens");
  const a = await share(tripAvif);
  const avifSent = a.items.find((q) => q.get("memory") === "m-avif");
  check("the app sent the AVIF's print as a JPEG it drew, at the photograph's own size",
    !!avifSent && avifSent.get("mime") === "image/jpeg" && Number(avifSent.get("w")) === W && Number(avifSent.get("h")) === H,
    JSON.stringify(a.items.map((q) => [q.get("memory"), q.get("mime"), q.get("w"), q.get("h")])));
  const keptA = kept(a.id);
  check("the server keeps a print for each memory, each a JPEG, the AVIF's at its size",
    JSON.stringify(keptA) === JSON.stringify([{ memory_id: "m-avif", mime: "image/jpeg", width: W, height: H }, { memory_id: "m-avif-jpeg", mime: "image/jpeg", width: W, height: H }]), JSON.stringify(keptA));
  check("the board's page has a tile for each", (await tiles(a.id)) === 2);
  check("the share's sentence says nothing is lost", !/won't open/.test(a.said), a.said);

  section("2. a JPEG and a HEIC, in a browser that can't read HEIC: said, never silent");
  const h = await share(tripHeic);
  const keptH = kept(h.id);
  check("the JPEG's print is kept; nothing for the HEIC", keptH.length === 1 && keptH[0].memory_id === "m-heic-jpeg", JSON.stringify(keptH));
  check("the share's sentence says one photo won't open full size because this browser can't read it",
    /1 photo on it won't open full size: this browser can't read it\.$/.test(h.said.trim()), h.said);
  check("the board's page has the one tile", (await tiles(h.id)) === 1);

  check("no page error", b.pageErrors.length === 0, b.pageErrors.join(" | "));
} catch (e) {
  fail++; failures.push("the check ran to its end");
  console.log(`  FAIL  the check ran to its end   -> ${e && e.stack ? e.stack : e}`);
} finally {
  for (const b of browsers) await b.done().catch(() => {});
  await server.stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(fail ? 1 : 0);
