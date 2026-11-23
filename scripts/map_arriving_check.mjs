#!/usr/bin/env node
/* The Map while a trip's map is being made and arriving (public/js/map.js noteNow: "cutting",
 * then "arriving" until the streets draw): never a blank map without a word.
 *
 *   node scripts/gate.mjs --only map_arriving_check     [WGP_WORLD=<a .pmtiles world>]
 *
 * Its own server with maps on, the stand-in world served from this machine (WGP_WORLD, else
 * build/tiles/peru.pmtiles found in this tree, in the clone a worktree belongs to, or in the repository `origin` names
 * when that is a folder here; else it fails naming every place it looked), a browser with WebGL (SwiftShader).
 * Planted: MAP_ARRIVING_PLANT=none looks for a world nobody has (red at once, naming the places it looked). A made-up
 * person makes a trip with Lima as its area, through the routes, and opens its Map at once.
 *
 * WHAT IT PROVES, sampling the screen every 150 ms from the first open until the map is drawn:
 *   1. while the map is being made, the card says so ("being made");
 *   2. once it is made, until its streets are drawn, the card says it is made and on its way;
 *      no sample is a made map with neither streets nor a card;
 *   3. once drawn, the card is gone, by itself;
 *   4. the map opened after its streets were drawn on another visit shows no "on its way".
 *
 * PLANTED: the "arriving" card taken out of noteNow: 2 fails (a sample with no card and no
 * streets).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { serveWorld } from "../checks/map/world.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}

// The world to cut from: WGP_WORLD, else build/tiles/peru.pmtiles (a regional extract; build/ is never committed) in
// this tree, in the clone a worktree belongs to, or in the repository `origin` names when that is a folder here.
function findWorld() {
  if (process.env.WGP_WORLD) return { found: fs.existsSync(process.env.WGP_WORLD) ? process.env.WGP_WORLD : null, looked: [process.env.WGP_WORLD] };
  const rel = process.env.MAP_ARRIVING_PLANT === "none" ? "build/tiles/nobody-has-this.pmtiles" : "build/tiles/peru.pmtiles";
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const git = (...a) => { try { return execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
  const roots = [repo];
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  if (common) roots.push(path.dirname(common));
  const origin = git("remote", "get-url", "origin").replace(/^file:\/\//, "");
  if (origin.startsWith("/")) roots.push(origin);
  const looked = [...new Set(roots)].map((r) => path.join(r, rel));
  return { found: looked.find((f) => fs.existsSync(f)) || null, looked };
}
const { found: WORLD, looked } = findWorld();
if (!WORLD) { console.log(`  FAIL  no world to cut from: looked in ${looked.join(", ")} (set WGP_WORLD to a .pmtiles world that holds Lima)`); process.exit(1); }
console.log(`  note  the world: ${WORLD}`);
const world = await serveWorld(WORLD);
const server = await startServer({ name: "arriving", port: await freeLoopbackPort(), maps: true, vars: { WORLD_URL: world.url, MAP_DELAY_MS: "20000" } });
ownServer(server.origin);
const { boot, evalIn, waitFor, sleep, appSettled } = await import("./lib/standalone_cdp.mjs");

let b = null;
try {
  await server.start();
  const host = new Person(server.origin, "Noor Fenwick");
  await host.signUp();
  const id = `arriving-${Date.now().toString(36)}`;
  const made = await host.post("/api/trips", { id, name: "Arriving (a made-up trip)", default_tz: "America/Lima" });
  if (made.status >= 300) throw new Error(`making the trip: ${made.status} ${made.text.slice(0, 160)}`);
  b = await boot({ vw: 390, vh: 844, dsf: 1, gl: true });
  const { cdp, S } = b;
  const page = (expr) => evalIn(cdp, S, expr);
  await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: host.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
  if (host.jar.cookies.get("wgp_who")) await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: host.jar.cookies.get("wgp_who"), sameSite: "Lax" }, S);
  // The area, as Make a trip writes it for Lima; then the Map, at once.
  const area = await host.call("PUT", `/api/trips/${id}/areas`, { areas: [{ id: "lima", name: "Lima", west: -77.2, south: -12.25, east: -76.85, north: -11.9, sort: 1 }] });
  if (area.status >= 300) throw new Error(`the area: ${area.status} ${area.text.slice(0, 160)}`);
  await cdp.send("Page.navigate", { url: `${server.origin}/t/${id}/#/places?view=map` }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `document.querySelector("#view .mp-root") ? 1 : 0`, { label: "the Map" });
  // Sample: the card's kind, the map's state, and whether the archive's streets have drawn (the
  // map's debug handle: its style set and MapLibre idle once since).
  const SAMPLE = `import("/js/store.js").then(({ store }) => { const t = store.tiles() || {}; const n = document.querySelector("#view .mp-note");
    const r = document.querySelector("#view .mp-root"); const v = window.__wgpMapView;
    const streets = !!(v && v.drawn && v.drawn());
    return JSON.stringify({ state: t.state || "", card: n && !n.hidden ? n.dataset.kind || "?" : "", engine: r ? r.dataset.engine : "", streets }); })`;
  const seen = [];
  const t0 = Date.now();
  for (let i = 0; i < 600; i++) {
    const s = JSON.parse(await page(SAMPLE));
    s.t = Date.now() - t0;
    const lastS = seen[seen.length - 1];
    if (!lastS || lastS.state !== s.state || lastS.card !== s.card || lastS.engine !== s.engine || lastS.streets !== s.streets) seen.push(s);
    if (s.state === "ready" && s.streets && !s.card) { await sleep(1500); break; }
    await sleep(150);
  }
  console.log(`  note  what the screen was, as it changed: ${seen.map((s) => `${(s.t / 1000).toFixed(1)}s ${s.state}/${s.card || "no card"}/${s.engine}${s.streets ? "/streets" : ""}`).join(" → ")}`);
  check("while the map is being made, the card says so", seen.some((s) => s.state === "cutting" && s.card === "cutting") && seen.every((s) => s.state !== "cutting" || s.card === "cutting"), "");
  check("made but not yet drawn: the card says it is on its way, never a map with no streets and no word", seen.filter((s) => s.state === "ready" && !s.streets).every((s) => s.card === "arriving"),
    JSON.stringify(seen.filter((s) => s.state === "ready" && !s.streets && s.card !== "arriving")));
  const end = seen[seen.length - 1];
  check("drawn: the streets are on screen and the card is gone by itself", !!end && end.state === "ready" && end.streets && !end.card, JSON.stringify(end));
  // Another visit to a map already drawn: no "on its way".
  await cdp.send("Page.navigate", { url: "about:blank" }, S);
  await sleep(150);
  await cdp.send("Page.navigate", { url: `${server.origin}/t/${id}/#/places?view=map` }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `document.querySelector("#view .mp-root") ? 1 : 0`, { label: "the Map again" });
  const kinds = [];
  for (let i = 0; i < 40; i++) { const s = JSON.parse(await page(SAMPLE)); if (s.card) kinds.push(s.card); await sleep(150); }
  check("opened again later: nothing says the map is on its way", !kinds.includes("arriving") && !kinds.includes("cutting"), kinds.join(" ") || "no card");
  check("no page error", b.pageErrors.length === 0, b.pageErrors.join(" | ").slice(0, 300));
} catch (e) {
  fail++; failures.push("the check ran to its end");
  console.log(`  FAIL  the check ran to its end   -> ${e && e.stack ? e.stack : e}`);
} finally {
  if (b) await b.done().catch(() => {});
  await server.stop();
  await world.stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(fail ? 1 : 0);
