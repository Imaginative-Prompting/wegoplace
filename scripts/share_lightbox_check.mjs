#!/usr/bin/env node
/* A shared board's page (/s/<id>) under a finger: no focus ring round the board while it's pressed (a keyboard still
 * gets one), and a print opened in the lightbox never shows a black frame before its photograph.
 *
 *   node scripts/gate.mjs --who <session> --only share_lightbox
 *
 * On the gate's made-up trip: two memories of its own (a made-up 24 MP photograph, 6000 × 4000, and a small one),
 * shared as a board through the share routes the app uses, removed afterwards with the share.
 *
 * WHAT IT PROVES, at 390, by real touches
 *   1. A touch on the board: the board takes focus with no ring round it.
 *   2. A Tab into the board from nothing focused: its ring shows (the keyboard's way of knowing where it is).
 *   3. A tap on the big print: every frame from the lightbox opening holds a painted picture (the tile's print
 *      first), and the original takes its place once it has decoded (6000 px wide in the end).
 *
 *   4. Open on a print, ArrowRight while the next print is still decoding (decode() held 500 ms in the page), Escape
 *      at 100 ms: after 1.2 s the lightbox is still closed. 4b: a print tapped, another inside the hold: it ends on
 *      the second.
 *   5. While a print is open, the page's ground and its theme-color are black (Safari paints its bands from them), and
 *      once it closes both are as they were (the wall's ground, no theme-color).
 *
 * PLANTED: SHARE_PLANT=1 rewrites the page as it was before (the focus rules and the tile's print out: 1 and 3 red);
 * SHARE_PLANT=close takes out only the close's turn (4 red); SHARE_PLANT=tint takes out the tint (5 red).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, appSettled, boot, evalIn, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { makeApi } from "./lib/seed_memories.mjs";
import { d1, tripApi } from "./lib/gate_trip.mjs";
import { scene } from "../checks/lib/images.mjs";

const PLANT = !!process.env.SHARE_PLANT;
// SHARE_PLANT=close: only the close's turn taken out (the page otherwise as it is), for 4.
const PLANT_CLOSE = process.env.SHARE_PLANT === "close";
// SHARE_PLANT=tint: the lightbox opens without tinting the page (for 5).
const PLANT_TINT = process.env.SHARE_PLANT === "tint";
const PART = 8 * 1024 * 1024;
let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 600) : ""}`); }
};
const J = async (c, S, e) => JSON.parse(await evalIn(c, S, `Promise.resolve(${e}).then((v) => JSON.stringify(v))`));

// The photographs: a made-up scene, one at 6000 × 4000 (as a phone's 24 MP), one small; their thumbnails.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-share-lb-"));
const src = path.join(dir, "s.png"), small = path.join(dir, "small.jpg"), big = path.join(dir, "big.jpg"), thumb = path.join(dir, "t.jpg");
fs.writeFileSync(src, scene(1200, 800, 31));
execSync(`sips -s format jpeg ${JSON.stringify(src)} --out ${JSON.stringify(small)}`, { stdio: "ignore" });
execSync(`sips -s format jpeg -z 4000 6000 ${JSON.stringify(src)} --out ${JSON.stringify(big)}`, { stdio: "ignore" });
execSync(`sips -s format jpeg -Z 480 ${JSON.stringify(src)} --out ${JSON.stringify(thumb)}`, { stdio: "ignore" });
const bytes = { small: fs.readFileSync(small), big: fs.readFileSync(big), thumb: new Uint8Array(fs.readFileSync(thumb)) };
fs.rmSync(dir, { recursive: true, force: true });

const api = await makeApi();
const memories = [], keys = [];
let share = null, b = null, code = 1;
async function upload(buf, name) {
  const beg = await api(tripApi("/media/begin"), { method: "POST", body: { name, mime: "image/jpeg", bytes: buf.length, kind: "photo" } });
  const { key, uploadId, parts } = beg.json;
  const etags = [];
  for (let n = 1; n <= parts; n++) {
    const r = await api(`${tripApi("/media/part")}?key=${encodeURIComponent(key)}&id=${encodeURIComponent(uploadId)}&n=${n}`, { method: "POST", body: buf.subarray((n - 1) * PART, Math.min(n * PART, buf.length)) });
    etags.push({ n, etag: r.json.etag });
  }
  await api(tripApi("/media/finish"), { method: "POST", body: { key, id: uploadId, parts: etags } });
  keys.push(key);
  const th = await api(`${tripApi("/media/thumb")}?for=${encodeURIComponent(key)}&mime=image/jpeg`, { method: "POST", body: bytes.thumb });
  if (th.json?.key) keys.push(th.json.key);
  return { key, thumb: th.json?.key };
}
try {
  const made = [];
  for (const [name, buf, w, h] of [["big.jpg", bytes.big, 6000, 4000], ["small.jpg", bytes.small, 1200, 800]]) {
    const u = await upload(buf, name);
    const m = await api(tripApi("/memories"), { method: "POST", body: { caption: `Lightbox ${name}`, tags: ["standalone verify"], media: [{ key: u.key, thumb_key: u.thumb, kind: "photo", w, h }] } });
    memories.push(m.json.memory.id);
    made.push({ memory: m.json.memory.id, media: m.json.memory.media[0].id, buf, w, h });
  }
  const s = await api(`${tripApi("/collage/share")}?mime=image/jpeg&w=1200&h=800&title=Coast%20week`, { method: "POST", body: bytes.small });
  share = s.json?.share;
  if (!share) throw new Error(`share: ${s.status} ${s.text}`);
  const at = [[0.06, 0.1, 0.55, 0.5], [0.6, 0.45, 0.32, 0.3]];
  for (let i = 0; i < made.length; i++) {
    const [fx, fy, fw, fh] = at[i];
    const q = new URLSearchParams({ idx: String(i), kind: "photo", mime: "image/jpeg", w: String(made[i].w), h: String(made[i].h), fx: String(fx), fy: String(fy), fw: String(fw), fh: String(fh), rot: "0", memory: made[i].memory, media: made[i].media });
    const r = await api(`${tripApi(`/collage/share/${encodeURIComponent(share.id)}/item`)}?${q}`, { method: "POST", body: made[i].buf });
    if (r.status !== 200 && r.status !== 201) throw new Error(`item ${i}: ${r.status} ${r.text}`);
  }
  const pagePath = new URL(share.url, BASE).pathname;
  check("setup: a board shared with a 24 MP photograph on it", true, pagePath);

  b = await boot({ vw: 390, vh: 844 });
  const { cdp, S } = b;
  if (PLANT) {
    cdp.on(async (m) => {
      if (m.sessionId !== S || m.method !== "Fetch.requestPaused") return;
      const { requestId } = m.params;
      try {
        const got = await cdp.send("Fetch.getResponseBody", { requestId }, S);
        const page = got.base64Encoded ? Buffer.from(got.body, "base64").toString("utf8") : got.body;
        const html = PLANT_TINT
          ? page.replace("if (!lb.open) { lb.showModal(); tint(true); }", "if (!lb.open) { lb.showModal(); }")
          : PLANT_CLOSE
          ? page.replace(/(lb\.addEventListener\("close", function \(\) \{\n    tint\(false\);\n)    turn\+\+;\n/, "$1")
          : page.replace(/^  \.viewport:focus\{outline:none\}\n/m, "").replace(/^  \.viewport:focus-visible:not.*\n/m, "")
            .replace('var lo = it.k === "video" ? null : tilePrint(at);', "var lo = null;");
        if (html === page) throw new Error("the plant changed nothing");
        await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: Buffer.from(html).toString("base64") }, S);
      } catch { cdp.send("Fetch.continueRequest", { requestId }, S).catch(() => {}); }
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*${pagePath}`, requestStage: "Response" }] }, S);
  }
  // Every frame while the lightbox is open: is there a painted picture in it?
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    window.__lbFrames = [];
    const f = () => {
      const lb = document.getElementById("lb");
      if (lb && lb.open) {
        const img = lb.querySelector(".stage img");
        window.__lbFrames.push(!!(img && img.complete && img.naturalWidth > 0));
      }
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  })()` }, S);
  await cdp.send("Page.navigate", { url: `${BASE}${pagePath}` }, S);
  await waitFor(cdp, S, `[...document.querySelectorAll(".tile img.tile-media")].filter((i) => i.complete && i.naturalWidth > 0).length >= 2 ? 1 : 0`, { label: "the board's prints drawn", timeout: 30000 });
  const touch = async (x, y) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, radiusX: 6, radiusY: 6, force: 1, id: 1 }] }, S);
    await sleep(80);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, S);
  };

  // 1. a touch on the board's ground, away from the prints: a point the board itself is under
  const ground = await J(cdp, S, `(() => { const v = document.getElementById("canvas"); const r = v.getBoundingClientRect();
    for (let y = r.bottom - 40; y > r.top + 40; y -= 23) for (let x = r.left + 20; x < r.right - 20; x += 17) {
      const e = document.elementFromPoint(x, y); if (e && v.contains(e) && !e.closest(".tile, button, a")) return { x: Math.round(x), y: Math.round(y), what: e.className || e.id }; }
    return null; })()`);
  if (!ground) throw new Error("no bare board to touch");
  await touch(ground.x, ground.y);
  await sleep(300);
  const ring = await J(cdp, S, `(() => { const v = document.getElementById("canvas"); const cs = getComputedStyle(v);
    return { focused: document.activeElement === v, style: cs.outlineStyle, width: cs.outlineWidth }; })()`);
  check("1. a touch on the board: it takes focus, and no ring is drawn round it", ring.focused && (ring.style === "none" || ring.width === "0px"), JSON.stringify({ ...ring, at: ground }));

  // 2. the keyboard: nothing focused, then a Tab
  await evalIn(cdp, S, `(document.activeElement && document.activeElement.blur(), 1)`);
  // Tab until the board has focus (whatever comes before it in the page's order), at most twelve times.
  for (let i = 0; i < 12; i++) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, S);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, S);
    await sleep(120);
    if (await evalIn(cdp, S, `document.activeElement === document.getElementById("canvas") ? 1 : 0`)) break;
  }
  await sleep(200);
  const keyed = await J(cdp, S, `(() => { const v = document.getElementById("canvas"); const cs = getComputedStyle(v);
    return { focused: document.activeElement === v, style: cs.outlineStyle, width: cs.outlineWidth }; })()`);
  check("2. a Tab into the board: its ring shows", keyed.focused && keyed.style !== "none" && keyed.width !== "0px", JSON.stringify(keyed));

  // 3. the big print opened
  const tile = await J(cdp, S, `(() => { const t = document.querySelector('.tile[data-i="0"]'); const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  await evalIn(cdp, S, `(window.__lbFrames = [], 1)`);
  await touch(tile.x, tile.y);
  await waitFor(cdp, S, `(() => { const i = document.querySelector("#lb .stage img"); return i && i.naturalWidth >= 6000 && i.complete ? 1 : 0; })()`, { label: "the original in the lightbox", timeout: 30000 }).catch(() => null);
  await sleep(300);
  const frames = await J(cdp, S, `window.__lbFrames`);
  const dark = frames.filter((x) => !x).length;
  const end = await J(cdp, S, `(() => { const i = document.querySelector("#lb .stage img"); return i ? { w: i.naturalWidth, src: i.currentSrc.replace(location.origin, "") } : null; })()`);
  check("3. from the tap, every frame of the lightbox holds a painted picture", frames.length > 0 && dark === 0, `${frames.length} frames, ${dark} with no picture`);
  check("   and the original takes its place once decoded (6000 px wide)", !!end && end.w === 6000, JSON.stringify(end));

  // 4. Open on a print, a step to the next while its print is still decoding (decode() held 500 ms in the page), and
  //    closed the way a person does (Escape) before it has: the lightbox stays closed.
  const key = async (k, code, vk) => {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk }, S);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk }, S);
  };
  const LB = `(() => { const lb = document.getElementById("lb"); return { open: lb.open, cnt: lb.querySelector(".cnt").textContent }; })()`;
  if ((await J(cdp, S, LB)).open) { await key("Escape", "Escape", 27); await sleep(300); }
  await touch(tile.x, tile.y);
  await waitFor(cdp, S, `document.getElementById("lb").open ? 1 : 0`, { label: "the lightbox open", timeout: 8000 });
  await sleep(400);
  await evalIn(cdp, S, `(() => { const real = HTMLImageElement.prototype.decode; window.__realDecode = real;
    HTMLImageElement.prototype.decode = function () { return new Promise((ok) => setTimeout(ok, 500)).then(() => real.call(this)); }; return 1; })()`);
  await key("ArrowRight", "ArrowRight", 39);
  await sleep(100);
  await key("Escape", "Escape", 27);
  const closedAt = await J(cdp, S, LB);
  await sleep(1200);
  const after = await J(cdp, S, LB);
  check("4. a step to the next, then Escape before its print has decoded: the lightbox stays closed", !closedAt.open && !after.open,
    JSON.stringify({ atEscape: closedAt, after: after.open ? "it opened again by itself" : "closed" }));

  // 4b. A newer tap wins: a print tapped, then another within the hold; the lightbox ends on the second.
  const tile2 = await J(cdp, S, `(() => { const t = document.querySelector('.tile[data-i="1"]'); const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  await touch(tile.x, tile.y);
  await sleep(100);
  // The first tap's dialog may already be open on a page with no hold; a second tap then lands on it, not the board.
  const openAtOnce = (await J(cdp, S, LB)).open;
  if (!openAtOnce) await touch(tile2.x, tile2.y);
  await sleep(1500);
  const won = await J(cdp, S, LB);
  check("4b. a newer tap wins: tapped one print, then another inside the hold, the lightbox shows the second", won.open && /^2 \//.test(won.cnt),
    JSON.stringify({ ...won, ...(openAtOnce ? { why: "the first tap opened at once (nothing waited for its print), so the second never reached the board" } : {}) }));
  await evalIn(cdp, S, `(window.__realDecode && (HTMLImageElement.prototype.decode = window.__realDecode), 1)`);

  // 5. While a print is open the page's ground and theme-color are black; closed, both as they were.
  const GROUND = `(() => { const m = document.querySelector('meta[name="theme-color"]');
    return { html: getComputedStyle(document.documentElement).backgroundColor, body: getComputedStyle(document.body).backgroundColor, theme: m ? m.content : null }; })()`;
  if ((await J(cdp, S, LB)).open) { await key("Escape", "Escape", 27); await sleep(300); }
  const before = await J(cdp, S, GROUND);
  await touch(tile.x, tile.y);
  await waitFor(cdp, S, `document.getElementById("lb").open ? 1 : 0`, { label: "the lightbox open", timeout: 8000 });
  const open = await J(cdp, S, GROUND);
  await key("Escape", "Escape", 27);
  await sleep(300);
  const closed = await J(cdp, S, GROUND);
  check("5. a print open: the page's ground and its theme-color are black", open.html === "rgb(0, 0, 0)" && open.body === "rgb(0, 0, 0)" && open.theme === "#000000",
    JSON.stringify(open));
  check("   closed: both as they were (the wall's ground, no theme-color)", JSON.stringify(closed) === JSON.stringify(before) && before.html !== "rgb(0, 0, 0)" && before.theme === null,
    JSON.stringify({ before, closed }));

  console.log(`\n${pass} passed, ${fail} failed${PLANT ? (PLANT_TINT ? " (PLANTED: no tint)" : PLANT_CLOSE ? " (PLANTED: the close's turn taken out)" : " (PLANTED: the page as it was before)") : ""}`);
  if (fail) console.log(`failed: ${failures.join(" | ")}`);
  code = fail ? 1 : 0;
} catch (e) {
  console.log(`\nSTOPPED: ${e?.stack || e}\n${pass} passed, ${fail} failed before it stopped`);
} finally {
  if (b) { try { await b.done(); } catch { /* gone */ } }
  if (share) {
    await api(tripApi(`/collage/share/${encodeURIComponent(share.id)}`), { method: "DELETE" }).catch(() => {});
    // Revoking keeps the share's row (revoked_at); the rows this check made go too.
    try { d1(`DELETE FROM collage_share_items WHERE share_id = '${share.id}'; DELETE FROM collage_shares WHERE id = '${share.id}'`); } catch { /* the gate's row count says so if not */ }
  }
  for (const id of memories) await api(tripApi(`/memories/${id}`), { method: "DELETE" }).catch(() => {});
  for (const k of keys) await api(`${tripApi("/media/object")}?key=${encodeURIComponent(k)}`, { method: "DELETE" }).catch(() => {});
}
process.exit(code);
