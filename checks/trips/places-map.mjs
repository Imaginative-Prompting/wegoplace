// Places' map at a phone's width (public/js/map.js): one area of sixty places, sixteen of them within a few steps of
// the square. Tapping the biggest cluster until it spreads opens a fan of every pin there, each with its name.
//
//   node checks/trips/places-map.mjs [--port <port>] [--shots <folder>] [--scheme dark]
//
// On a server of its own, 440 x 956. It holds:
//   1. The crowd opens: the square's cluster spreads within three taps, and no two pins cover each other.
//   2. NO NAME UNDER THE MAP'S CONTROLS: no label shown lies under the compass, full-screen or locate buttons, the
//      scale, the + or the tab bar (a fanned pin's name hung under the full-screen button, 27 Nov).
//   3. NO NAME CROSSES THE MAP'S EDGES: every label shown lies inside the room the map shows, below the page's head (the
//      surface runs on under it) and inside its sides (a fanned name hung cut under the head, 27 Nov).
//   And no page has an error.
//
// Planted (MAP_LABEL_PLANT=<name>, map.js served with that part taken out): chrome (2 red), edge (3 red).
// Everyone and everything in it is made up.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";
import { sendAs } from "../lib/demo.mjs";
import { seedTrip } from "../../tools/seed-trip.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8793);
const shots = flag("--shots");
const scheme = flag("--scheme") ?? "light";
const PLANT = process.env.MAP_LABEL_PLANT || "";
const PLANTS = {
  chrome: [["const underChrome = (b) => S.chrome.some(", "const underChrome = (b) => false && S.chrome.some("]],
  edge: [["\n        || b.y < roomTop || b.y + b.h > roomBottom;", ";"], ["if (inside && (isSel || g.fan ||", "if ((isSel || g.fan ||"]],
};
if (PLANT && !PLANTS[PLANT]) { console.error(`MAP_LABEL_PLANT is one of ${Object.keys(PLANTS).join(", ")}`); process.exit(2); }
if (shots) fs.mkdirSync(shots, { recursive: true });
const t = new Report("Places' map, a crowded square");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sixty places: every fourth one, and the first five, within ~40 m of the square; the rest spread over the area.
const SUB = [["hotel", "lodging"], ["restaurant", "food"], ["cafe", "food"], ["bakery", "food"], ["restaurant", "food"], ["street_food", "food"],
  ["market", "food"], ["bar", "drink"], ["brewery", "drink"], ["viewpoint", "sight"], ["museum", "sight"], ["church", "sight"], ["plaza", "sight"],
  ["park", "sight"], ["beach", "sight"], ["tour", "activity"], ["hike", "activity"]];
const W = ["Muelle", "Viejo", "Azul", "Sal", "Gaviota", "Faro", "Pimienta", "Lobo", "Ancla", "Coral", "Brisa", "Roca", "Marea", "Cerro", "Puerta", "Luna"];
const X = ["de la Plaza", "del Malecón", "de los Pescadores", "del Cerro"];
const places = [];
for (let i = 1; i <= 60; i++) {
  const [subkind, kind] = SUB[i % SUB.length];
  const crowded = i % 4 === 0 || i <= 5;
  const lat = crowded ? -12.07 + ((i * 37) % 9 - 4) * 0.00004 : -12.07 + ((i * 53) % 41 - 20) * 0.0011;
  const lng = crowded ? -77.15 + ((i * 29) % 9 - 4) * 0.00004 : -77.15 + ((i * 71) % 43 - 21) * 0.0012;
  const name = i % 7 === 0 ? `${W[i % 16]} ${X[Math.floor(i / 16)]} and the House of the ${W[(i + 7) % 16]} by the Old Harbour Steps`
    : `${W[i % 16]} ${X[Math.floor(i / 16)]}${["", " Norte", " Sur", " Alto"][i % 4]}`;
  places.push({ id: `p-${String(i).padStart(2, "0")}`, name, kind, subkind, area: "puerto", lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
}
const SEED = {
  trip: { name: "A crowded square (made up)", starts_on: "2027-03-09", ends_on: "2027-03-12", default_tz: "America/Lima", currencies: ["PEN"] },
  areas: [{ id: "puerto", name: "Puerto Viejo", west: -77.18, south: -12.10, east: -77.12, north: -12.04, sort: 1 }],
  places, events: [],
};

let server, chrome;
try {
  server = await startServer({ name: "places-map", port });
  await server.start();
  const { origin } = server;
  const ana = new Person(origin, "Ana Crowdmap");
  if ((await ana.signUp()).status !== 200) throw new CheckError("couldn't make Ana's account");
  const { tripId } = await seedTrip(SEED, sendAs(ana));

  chrome = await openChrome();
  const page = await chrome.page({ width: 440, height: 956, mobile: true, passkeys: false });
  await page.scheme(scheme);
  await page.setCookie(origin, "wgp_session", ana.jar.cookies.get("wgp_session"));
  await page.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(ana.user.id), sameSite: "Lax" });
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  if (PLANT) {
    const src = fs.readFileSync(path.join(ROOT, "public/js/map.js"), "utf8");
    let out = src;
    for (const [from, to] of PLANTS[PLANT]) {
      if (!out.includes(from)) throw new CheckError(`the ${PLANT} plant didn't take: map.js has changed`);
      out = out.replace(from, to);
    }
    const body = Buffer.from(out).toString("base64");
    page.on((m) => { if (m.method === "Fetch.requestPaused") page.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body }).catch(() => {}); });
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/map.js*" }] });
  }
  const tapAt = async (x, y) => { for (const type of ["touchStart", "touchEnd"]) await page.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] }); };
  const marks = async () => JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll(".mp-pin, .mp-cluster")].map((m) => { const r = m.getBoundingClientRect(); return { n: m.classList.contains("mp-cluster") ? Number(m.querySelector(".mp-cluster-body").textContent.trim()) : 1, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; }).filter((m) => m.y > 160 && m.y < 650))`));

  await page.goto(`${origin}/t/${encodeURIComponent(tripId)}/#/places?view=map`);
  await page.until(`document.querySelectorAll(".mp-cluster").length > 3`, "the map's clusters", 25000);
  await sleep(2500);
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    const big = (await marks()).filter((m) => m.n > 1).sort((a, b) => b.n - a.n)[0];
    if (!big) { opened = true; break; }
    await tapAt(big.x, big.y);
    await sleep(1800);
    opened = !(await marks()).some((m) => m.n > 1);
  }
  const ms = await marks();
  let over = 0;
  for (let a = 0; a < ms.length; a++) for (let b = a + 1; b < ms.length; b++) {
    const A = ms[a], B = ms[b];
    const ox = Math.max(0, Math.min(A.x + A.w / 2, B.x + B.w / 2) - Math.max(A.x - A.w / 2, B.x - B.w / 2));
    const oy = Math.max(0, Math.min(A.y + A.h / 2, B.y + B.h / 2) - Math.max(A.y - A.h / 2, B.y - B.h / 2));
    if (ox * oy > (A.w * A.h) / 3) over++;
  }
  t.ok("the square's cluster spreads within three taps, and no two pins cover each other", opened && ms.length >= 15 && over === 0,
    JSON.stringify({ opened, marks: ms.length, over }));
  const under = JSON.parse(await page.eval(`JSON.stringify((() => {
    const ctl = [...document.querySelectorAll(".mp-btns > *, .mp-scale, .tabbar, #rt-fixed .fab")].map((n) => n.getBoundingClientRect()).filter((r) => r.width && r.height);
    const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const shown = [...document.querySelectorAll('.mp-pin[data-label="1"] .mp-pin-label')].map((l) => ({ name: l.textContent, r: l.getBoundingClientRect() })).filter((x) => x.r.width);
    return { shown: shown.length, under: shown.filter((x) => ctl.some((c) => hit(x.r, c))).map((x) => x.name) }; })())`));
  t.ok("no name shown lies under the map's buttons, its scale, the + or the tab bar", under.shown >= 8 && under.under.length === 0, JSON.stringify(under));
  // The room: the map's own box, less what the page's head covers (map.js keeps that height as --mp-note-top).
  const edge = JSON.parse(await page.eval(`JSON.stringify((() => {
    const root = [...document.querySelectorAll("*")].find((n) => n.style && n.style.getPropertyValue("--mp-note-top"));
    const box = root.getBoundingClientRect(), padTop = parseFloat(root.style.getPropertyValue("--mp-note-top")) || 0;
    const room = { top: box.top + padTop, bottom: box.bottom, left: box.left, right: box.right };
    const shown = [...document.querySelectorAll('.mp-pin[data-label="1"] .mp-pin-label')].map((l) => ({ name: l.textContent, r: l.getBoundingClientRect() })).filter((x) => x.r.width);
    return { room: Object.fromEntries(Object.entries(room).map(([k, v]) => [k, Math.round(v)])), shown: shown.length,
      out: shown.filter((x) => x.r.top < room.top - 0.5 || x.r.bottom > room.bottom + 0.5 || x.r.left < room.left - 0.5 || x.r.right > room.right + 0.5).map((x) => x.name) }; })())`));
  t.ok("no name shown crosses the map's edges (the page's head, its sides)", edge.shown >= 8 && edge.out.length === 0, JSON.stringify(edge));
  if (shots) await page.shot(path.join(shots, `crowd-open-440-${scheme}.png`)).catch(async () => {
    fs.writeFileSync(path.join(shots, `crowd-open-440-${scheme}.png`), Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64")); });
  t.ok("no page error", page.errors.length === 0, page.errors.join(" | "));
} catch (e) {
  t.ok("ran to the end", false, e instanceof CheckError ? e.message : (e.stack || String(e)));
} finally {
  await chrome?.close().catch(() => {});
  await server?.stop().catch(() => {});
}
process.exit(t.end());
