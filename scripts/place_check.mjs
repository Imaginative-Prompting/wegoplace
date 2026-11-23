#!/usr/bin/env node
/* A place by hand, in real browsers, on a server of its own: a place added, changed, put on
 * the map and removed (public/js/place-editor.js, place-form.js, spot-picker.js, the map's
 * pick mode in map.js, places.js, the store's place writes, and the plan sheet's Where).
 *
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> \
 *     --label "wegoplace place_check.mjs" -- node scripts/place_check.mjs
 *
 * WGP_SHOTS=<folder> also writes pictures at 320, 390, 768 and 1440 wide in both themes, to look
 * at. Nothing is asserted from them.
 *
 * The server is this check's own (checks/lib/server.mjs: an empty database, a port of its own).
 * Two made-up people, a browser each. A check server has no map maker, so whether the trip HAS
 * a map is played here: the snapshot's `tiles` and an archive that holds no tiles
 * (scripts/lib/empty_archive.mjs). That is enough for "Put it on the map": the picker moves
 * the same camera over the drawn ground.
 *
 * WHAT IT PROVES
 *   1. THE EMPTY PLACES OFFERS IT: "Add a place", the line about AI apps, and no + button
 *      beside the button in the page.
 *   2. A PLACE IS ADDED THROUGH THE SHEET: the name has the focus and no kind is pressed; no
 *      name, then no kind, are each refused in a sentence and nothing is sent; a kind brings
 *      its own "what kind of" row with the first chosen; the trip's areas are chips with "No
 *      area" first. Saved, it is in the list ("not on the map"), the server got ONE request
 *      carrying only what was given, the link made whole, and the + button is there.
 *   3. ITS PAGE says "Not on the map: go by the address." (and "Not on the map." for a place
 *      with no address), shows the note, and offers Change.
 *   4. ANY MEMBER CHANGES ANY PLACE: the other person finds every field as saved, changes two,
 *      and the request carries only those two.
 *   5. PUT IT ON THE MAP: not offered while the trip has no map; with one, the trip's map
 *      opens in a sheet with a pin fixed in its middle, on the place's area; arrow keys move
 *      it; "Here" gives the spot under the pin to the place sheet; Cancel changes nothing; a
 *      spot outside the place's area is said and not saved; Places' own map has its map back
 *      afterwards; "Take it off the map" clears the pin.
 *   6. A LINK THAT CARRIES A LOCATION offers it; a short link says it can't.
 *   7. WITH NO SIGNAL a place is in the list at once, waits in the phone's queue, and is sent
 *      when the API answers again.
 *   8. A NEW PLACE A FEW METERS FROM ANOTHER OF ITS KIND is saved, and a line names both.
 *   9. REMOVAL: a place a plan is at stays, and the sheet says which plan; a free one is
 *      removed after a question that starts on "Keep it", and its page goes back to Places.
 *  10. FROM A PLAN: a name no place has offers to make the place; the place sheet opens over
 *      the plan sheet with the name in it and the plan's kind pressed; saved, the plan sheet
 *      has that place chosen, and the plan is saved at it.
 *  11. A REMOVAL THE SERVER REFUSES LATER (a plan was put there meanwhile) is said in a
 *      sentence that names the place, and the place is back.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";
import { emptyArchive } from "./lib/empty_archive.mjs";

const server = await startServer({ name: "place", port: await freeLoopbackPort() });
ownServer(server.origin);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const SHOTS = process.env.WGP_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const ZONE = "Europe/Lisbon";
const dayOf = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date(Date.now() + d * 86400e3));
const DAYS = [3, 4, 5, 6, 7, 8, 9].map(dayOf);
// The trip's areas: two with bounds (one a small box, to be outside of), one without.
const HARBOR = { west: -9.16, south: 38.70, east: -9.12, north: 38.72 };
const AREAS = [
  { id: "old-town", name: "Old town", west: -9.15, south: 38.705, east: -9.13, north: 38.715, sort: 0 },
  { id: "harbor", name: "Harbor", ...HARBOR, sort: 1 },
  { id: "hill", name: "The hill", sort: 2 },
];
const inBox = (b, lat, lng) => lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;

const phones = [];
try {
  await server.start();
  const host = new Person(server.origin, "Mara Voss"), other = new Person(server.origin, "Teo Lind");
  await host.signUp(); await other.signUp();
  const made = await host.post("/api/trips", { name: "Harbor week", default_tz: ZONE, starts_on: DAYS[0], ends_on: DAYS[6] });
  const trip = made.json.trip.id, T = `/api/trips/${trip}`;
  const link = await host.post(`${T}/links`, {});
  const joined = await other.post(`/api/join/${link.json.link.code}`);
  const areas = await host.call("PUT", `${T}/areas`, { areas: AREAS });
  check("two people on a trip with three areas and no places", made.status === 201 && joined.status < 300 && areas.status < 300,
    `${made.status} ${joined.status} ${areas.status} ${areas.text.slice(0, 200)}`);
  const placesOf = async (who) => (await who.get(`${T}/places`)).json.places;
  const eventsOf = async (who) => (await who.get(`${T}/events`)).json.events;

  const { boot, evalIn, waitFor, appSettled, sleep } = await import("./lib/standalone_cdp.mjs");

  // Whether the trip has a map, as the snapshot says it (docs/API.md, "The trip's map").
  const play = { ready: false, bytes: emptyArchive(4000) };
  const tilesNow = () => (play.ready
    ? { state: "ready", version: "one", bytes: play.bytes.length, at: 1790000000, source: "cut", note: "", glyphs: null, ready: true }
    : null);

  // A phone: one browser, signed in as one person.
  async function phoneOf(person) {
    const b = await boot({ vw: 390, vh: 844, dsf: 1 });
    phones.push(b);
    const { cdp, S } = b;
    for (const name of ["s2", "wgp_session", "wgp_who"]) await cdp.send("Network.deleteCookies", { name, url: server.origin }, S);
    await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: person.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
    const who = person.jar.cookies.get("wgp_who");
    if (who) await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: who, sameSite: "Lax" }, S);
    const page = (expr) => evalIn(cdp, S, expr);
    const writes = [];
    let off = false;

    // The archive's address, answered here; and the snapshot, given its `tiles`.
    await cdp.send("Fetch.enable", { patterns: [
      { urlPattern: `*${T}/tiles*`, requestStage: "Request" },
      { urlPattern: `*${T}`, requestStage: "Response" },
      { urlPattern: `*${T}?*`, requestStage: "Response" },
    ] }, S);
    cdp.on(async (m) => {
      if (m.sessionId !== S) return;
      if (m.method === "Network.requestWillBeSent") {
        const r = m.params.request;
        if (r.method !== "GET" && r.method !== "HEAD" && /\/api\//.test(r.url)) writes.push({ method: r.method, path: new URL(r.url).pathname, body: r.postData || "" });
        return;
      }
      if (m.method !== "Fetch.requestPaused") return;
      const { requestId, request } = m.params;
      const u = new URL(request.url);
      try {
        if (off) { await cdp.send("Fetch.failRequest", { requestId, errorReason: "InternetDisconnected" }, S); return; }
        if (u.pathname === `${T}/tiles`) {
          if (!play.ready) {
            await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 404,
              responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from('{"error":"no map"}').toString("base64") }, S);
            return;
          }
          const size = play.bytes.length;
          const common = [{ name: "Content-Type", value: "application/octet-stream" }, { name: "Accept-Ranges", value: "bytes" },
            { name: "Cache-Control", value: "private, no-cache" }];
          const range = Object.entries(request.headers).find(([k]) => k.toLowerCase() === "range");
          const mm = range && /^bytes=(\d+)-(\d+)$/.exec(range[1]);
          if (request.method === "HEAD" || !mm) {
            await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [...common, { name: "Content-Length", value: String(size) }],
              ...(request.method === "HEAD" ? {} : { body: play.bytes.toString("base64") }) }, S);
            return;
          }
          const from = Number(mm[1]), to = Math.min(Number(mm[2]), size - 1);
          await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 206,
            responseHeaders: [...common, { name: "Content-Range", value: `bytes ${from}-${to}/${size}` }, { name: "Content-Length", value: String(to - from + 1) }],
            body: play.bytes.subarray(from, to + 1).toString("base64") }, S);
          return;
        }
        if (m.params.responseStatusCode === 200 && request.method === "GET") {
          const got = await cdp.send("Fetch.getResponseBody", { requestId }, S);
          const snap = JSON.parse(got.base64Encoded ? Buffer.from(got.body, "base64").toString("utf8") : got.body);
          if (snap && snap.trip) snap.tiles = tilesNow();
          const headers = (m.params.responseHeaders || []).filter((h) => !/^content-(length|encoding)$/i.test(h.name));
          await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: headers,
            body: Buffer.from(JSON.stringify(snap)).toString("base64") }, S);
          return;
        }
        await cdp.send("Fetch.continueRequest", { requestId }, S);
      } catch (e) {
        console.log(`  (the check's own answer failed: ${u.pathname} ${e.message})`);
        try { await cdp.send("Fetch.continueRequest", { requestId }, S); } catch { /* already answered */ }
      }
    });

    const wait = (expr, label, timeout) => waitFor(cdp, S, expr, { label, ...(timeout ? { timeout } : {}) });
    const p = {
      b, page, writes, wait,
      async open(hash, ready, label) {
        await cdp.send("Page.navigate", { url: `${server.origin}/t/${trip}/?${Date.now()}${hash}` }, S);
        await sleep(300);
        await appSettled(cdp, S);
        try { await wait(ready, label); } catch (e) {
          const seen = await page(`(location.pathname + location.hash + " :: " + ((document.querySelector("#view") || document.body).innerText || "").replace(/\\s+/g, " ").trim().slice(0, 400))`).catch(() => "");
          throw new Error(`${e.message}\n      on screen: ${seen}`);
        }
        await sleep(400);
      },
      async tap(sel, label = sel) {
        // ".sh-root …" is the sheet on top: with two sheets up, a person can't press the one underneath.
        const top = sel.startsWith(".sh-root ");
        const got = await page(`(() => { const all = document.querySelectorAll(${JSON.stringify(sel)}); const n = all[${top} ? all.length - 1 : 0]; if (!n) return 0; if (n.disabled) return -1; n.click(); return 1; })()`);
        if (got !== 1) throw new Error(`tap: ${label} ${got === 0 ? "is not there" : "is disabled"}`);
        await sleep(200);
      },
      async type(sel, value) {
        const ok = await page(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return 0; n.focus(); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event("input", { bubbles: true })); n.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()`);
        if (!ok) throw new Error(`type: ${sel} is not there`);
        await sleep(160);
      },
      // The whole API out of reach for this phone, the archive and the snapshot included.
      async apiOff(on) {
        off = on;
        await cdp.send("Network.setBlockedURLs", { urls: on ? ["*/api/*"] : [] }, S);
      },
      inStore: (body) => page(`import("/js/store.js").then(async ({ store }) => { ${body} })`),
      refresh: async () => { await page(`import("/js/store.js").then(({ store }) => store.refresh()).then(() => 1)`); await sleep(500); },
      async sheet(title) {
        await wait(`(() => { const all = [...document.querySelectorAll(".sh-root")]; const r = all[all.length - 1]; return r && r.dataset.entered === "1" && ${JSON.stringify(title)} === r.querySelector(".sh-title").textContent.trim() ? 1 : 0; })()`, `the sheet "${title}"`);
        await sleep(300);
      },
      sheets: () => page(`document.querySelectorAll(".sh-root").length`),
      async sheetsDown(n, label) {
        await wait(`document.querySelectorAll(".sh-root").length === ${n} ? 1 : 0`, label || `${n} sheet(s) left`);
        await sleep(300);
      },
      toast: () => page(`(() => { const t = document.querySelector(".toast"); return t && !t.hidden ? t.innerText.replace(/\\s+/g, " ").trim() : ""; })()`),
      // The place sheet as it stands: every field, what is pressed, what is said.
      form: async () => JSON.parse(await page(`JSON.stringify((() => {
        const q = (s) => document.querySelector(s);
        const v = (s) => (q(s) ? q(s).value : null);
        const text = (n) => (n ? n.innerText.replace(/\\s+/g, " ").trim() : "");
        const pressed = (s, key) => (q(s + '[aria-pressed="true"]') || { dataset: {} }).dataset[key];
        return {
          name: v("#pf-name"), address: v("#pf-address"), why: v("#pf-why"), link: v("#pf-link"),
          kind: pressed(".pf-kind", "kind") || "",
          kinds: [...document.querySelectorAll(".pf-kind")].map((n) => n.dataset.kind),
          sub: pressed(".pf-sub", "sub") || "",
          subs: [...document.querySelectorAll(".pf-sub")].map((n) => n.dataset.sub),
          subLabel: text(q("#pf-subbox .pe-label")),
          area: q(".pf-area") ? (pressed(".pf-area", "area") ?? "?") : null,
          areas: [...document.querySelectorAll(".pf-area")].map((n) => n.dataset.area + ":" + text(n)),
          pin: text(q("#pf-pinline")),
          pinActs: [...document.querySelectorAll("#pf-pinbox [data-act]")].map((n) => n.dataset.act + ":" + text(n)),
          mapBtn: {
            text: text(q("#pf-pinbox .pf-mapbtn")),
            disabled: !!q("#pf-pinbox .pf-mapbtn")?.disabled,
            opacity: q("#pf-pinbox .pf-mapbtn") ? getComputedStyle(q("#pf-pinbox .pf-mapbtn")).opacity : "",
          },
          pinNote: text(q("#pf-pinbox .pf-pinnote")),
          said: [...document.querySelectorAll(".pf .pe-say")].filter((n) => !n.hidden).map((n) => n.dataset.say + ": " + n.textContent),
          ask: text(q("#pf-ask")),
          removeActs: [...document.querySelectorAll("#pf-remove [data-act]")].map((n) => n.dataset.act + ":" + text(n)),
          focus: document.activeElement ? (document.activeElement.id || document.activeElement.dataset.act || document.activeElement.dataset.kind || document.activeElement.className) : "",
          kindFocused: !!document.activeElement?.closest?.(".pf-kind"),
          action: text(q('.sh-root .pf') ? q('.sh-root .pf').closest(".sh-root").querySelector('[data-act="save"]') : null),
          saveDisabled: !!q('.sh-root [data-act="save"]')?.disabled,
          saveOpacity: q('.sh-root [data-act="save"]') ? getComputedStyle(q('.sh-root [data-act="save"]')).opacity : "",
          tall: q('.sh-root')?.dataset.tall === "1",
          moreExpanded: q('.pf [data-act="toggle-more"]')?.getAttribute("aria-expanded") || "",
        };
      })())`)),
      // What Places shows: the rows in order, or the empty state.
      list: async () => JSON.parse(await page(`JSON.stringify((() => {
        const text = (n) => (n ? n.innerText.replace(/\\s+/g, " ").trim() : "");
        const e = document.querySelector("#view .empty");
        const fab = document.querySelector("#rt-fixed .fab[data-place-add]");
        return {
          empty: text(e),
          button: e && e.querySelector('[data-act="add-place"]') ? text(e.querySelector('[data-act="add-place"]')) : "",
          ai: e && e.querySelector(".pl-empty-ai a") ? e.querySelector(".pl-empty-ai a").getAttribute("href") + " " + text(e.querySelector(".pl-empty-ai a")) : "",
          fab: fab && !fab.hidden ? fab.getAttribute("aria-label") : "",
          fabs: [...document.querySelectorAll("#rt-fixed .fab")].filter((n) => !n.hidden).length,
          rows: [...document.querySelectorAll("#view .pl-row")].map((r) => ({ name: text(r.querySelector(".pl-name")), meta: text(r.querySelector(".pl-meta")), href: r.getAttribute("href") })),
        };
      })())`)),
      // The picker as it stands.
      picker: async () => JSON.parse(await page(`JSON.stringify((() => {
        const host = document.querySelector(".sp-pick-map");
        const root = host && host.querySelector(".mp-root");
        const pin = root && root.querySelector(".mp-pickpin");
        const v = window.__wgpMapView;
        if (!host || !root || !pin || !v) return { there: false, host: !!host, root: !!root, pin: !!pin, view: !!v };
        const h = host.getBoundingClientRect(), r = pin.getBoundingClientRect();
        const sheetRoots = [...document.querySelectorAll(".sh-root")];
        return {
          there: true, pick: root.dataset.pick || "", pinShown: !pin.hidden && r.width > 0,
          // the pin's tip against the middle of the map
          tipDx: Math.round((r.left + r.width / 2 - (h.left + h.width / 2)) * 10) / 10,
          tipDy: Math.round((r.top + r.height * 40.8 / 42 - (h.top + h.height / 2)) * 10) / 10,
          w: Math.round(h.width), h: Math.round(h.height),
          cam: v.cam(), say: (document.querySelector("#sp-pick-say") || { textContent: "" }).textContent,
          sheetHidden: getComputedStyle(root.querySelector(".mp-sheet")).display === "none",
          sheets: sheetRoots.length,
          focus: document.activeElement ? (document.activeElement.dataset.act || document.activeElement.className) : "",
        };
      })())`)),
      async key(sel, key, shift = false) {
        await page(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); n.focus(); n.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, shiftKey: ${shift}, bubbles: true, cancelable: true })); return 1; })()`);
        await sleep(350);
      },
      // The same screen on the narrowest phone: what is cut short or covered there.
      async narrow(expr) {
        await b.metrics(320, 844, 2);
        await sleep(450);
        const got = JSON.parse(await page(`JSON.stringify(${expr})`));
        await b.metrics(390, 844, 1);
        await sleep(300);
        return got;
      },
      async look(name) {
        if (!SHOTS) return;
        const was = await page(`document.documentElement.getAttribute("data-theme") || ""`);
        for (const theme of ["light", "dark"]) {
          await page(`(document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)}), document.documentElement.setAttribute("data-lum", ${JSON.stringify(theme)}), 1)`);
          await sleep(600);
          for (const w of [320, 768, 1440, 390]) {
            await b.metrics(w, 844, w > 400 ? 1 : 2);
            await sleep(450);
            await b.shot(path.join(SHOTS, `${name}-${w}-${theme}.png`));
          }
        }
        await page(`(${JSON.stringify(was)} ? document.documentElement.setAttribute("data-theme", ${JSON.stringify(was)}) : document.documentElement.removeAttribute("data-theme"), 1)`);
        await b.metrics(390, 844, 1);
        await sleep(300);
      },
    };
    return p;
  }
  const PLACES = `document.querySelector("#view").dataset.route === "places" && (document.querySelector("#view .pl-row") || document.querySelector("#view .empty")) ? 1 : 0`;
  const pageOf = (name) => `document.querySelector("#view").dataset.route === "place" && ${JSON.stringify(name)} === (document.querySelector("#view h1") || { textContent: "" }).textContent.trim() ? 1 : 0`;
  const putBodies = (p, from) => p.writes.slice(from).filter((w) => w.path === `${T}/places`);
  const first = await phoneOf(host);
  const second = await phoneOf(other);

  // ── 1 ──────────────────────────────────────────────────────────────────────────────────────
  section("1. the empty Places offers it");
  await first.open("#/places", PLACES, "Places of a trip with no places");
  let l = await first.list();
  check('"No places yet", with a button that says "Add a place"', /No places yet/.test(l.empty) && l.button === "Add a place", JSON.stringify(l));
  check("one line says an AI app can fill the trip in too, with the way to Your account", /An AI app can fill the trip in too/.test(l.empty) && l.ai === "/account#ai-apps Your account", l.empty + " / " + l.ai);
  check("no + button beside the button in the page", l.fab === "" && l.fabs === 0, JSON.stringify({ fab: l.fab, fabs: l.fabs }));
  await first.look("places-empty");

  // ── 2 ──────────────────────────────────────────────────────────────────────────────────────
  section("2. a place is added through the sheet");
  await first.tap('#view .empty [data-act="add-place"]', "Add a place");
  await first.sheet("Add a place");
  let f = await first.form();
  check("Add a place opens compact (not tall) with focus on the sheet (no ring on a kind chip), More details collapsed, and Add disabled (not dimmed)", !f.tall && f.focus === "sh-sheet" && !f.kindFocused && f.moreExpanded === "false" && f.saveDisabled && f.saveOpacity === "1", JSON.stringify({ tall: f.tall, focus: f.focus, kindFocused: f.kindFocused, moreExpanded: f.moreExpanded, saveDisabled: f.saveDisabled, saveOpacity: f.saveOpacity }));
  check("the seven kinds are offered and none is pressed; no 'what kind of' row yet", f.kinds.join() === "lodging,food,drink,sight,activity,transit,practical" && f.kind === "" && f.subs.length === 0, JSON.stringify({ kinds: f.kinds, kind: f.kind, subs: f.subs }));
  check('the trip\'s areas are chips, "No area" first and pressed', f.areas.join("|") === ":No area|old-town:Old town|harbor:Harbor|hill:The hill" && f.area === "", f.areas.join("|") + " / " + f.area);
  check("the trip has no map: Put it on the map shows disabled (not dimmed) with the reason and list reassurance", f.mapBtn.text === "Put it on the map" && f.mapBtn.disabled && f.mapBtn.opacity === "1" && f.pinActs.length === 0 && f.pin === "This trip has no map yet. Paste a map link or coordinates in Address or Link. It shows in the list either way.", JSON.stringify(f.mapBtn) + " / " + f.pin + " / " + f.pinActs.join());
  check('the action is "Add"', f.action === "Add", f.action);
  await first.look("sheet-new");
  let before = first.writes.length;
  await first.type("#pf-name", "Tide cafe");
  f = await first.form();
  check("typing a name enables Add", !f.saveDisabled && f.said.length === 0, JSON.stringify({ saveDisabled: f.saveDisabled, said: f.said }));
  await first.tap('.sh-root [data-act="save"]', "Add, with no kind");
  f = await first.form();
  check('no kind: "Choose what kind of place it is." under the kinds, the focus on the first kind, nothing sent',
    f.said.length === 1 && f.said[0] === "kind: Choose what kind of place it is." && f.focus === "lodging" && first.writes.length === before, JSON.stringify(f.said) + " " + f.focus);
  await first.look("sheet-refused-kind");
  await first.tap('.pf-kind[data-kind="food"]', "Food");
  f = await first.form();
  check('Food pressed: the sentence goes, and "What kind of food" appears with the first chosen', f.said.length === 0 && f.kind === "food" && /^What kind of food$/i.test(f.subLabel) && f.subs.length > 3 && f.sub === f.subs[0], JSON.stringify({ said: f.said, label: f.subLabel, sub: f.sub, subs: f.subs }));
  await first.tap('.pf-sub[data-sub="cafe"]', "Cafe");
  await first.tap('.pf [data-act="toggle-more"]', "More details");
  await first.tap('.pf-area[data-area="harbor"]', "Harbor");
  await first.type("#pf-address", "Cais do Sal, by the ferry steps");
  await first.type("#pf-why", "Opens at six. Sit outside.");
  await first.type("#pf-link", "example.com/tide");
  await first.look("sheet-filled");
  before = first.writes.length;
  await first.tap('.sh-root [data-act="save"]', "Add");
  await first.sheetsDown(0, "the place sheet closed");
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the new place sent");
  await sleep(500);
  l = await first.list();
  const tide = l.rows.find((r) => r.name === "Tide cafe");
  check("it is in the list: its kind, that it is not on the map, its area", !!tide && tide.meta.startsWith("Café") && /not on the map/.test(tide.meta) && /Harbor/.test(tide.meta), JSON.stringify(l.rows));
  const sent = putBodies(first, before);
  const body = sent.length ? JSON.parse(sent[0].body) : {};
  const row0 = (body.places || [])[0] || {};
  check("the server got ONE request, a list of one place", sent.length === 1 && sent[0].method === "PUT" && (body.places || []).length === 1, JSON.stringify(sent).slice(0, 400));
  check("…carrying only what was given, the link made whole, no pin",
    row0.name === "Tide cafe" && row0.kind === "food" && row0.subkind === "cafe" && row0.area === "harbor" && row0.address === "Cais do Sal, by the ferry steps" &&
    row0.why === "Opens at six. Sit outside." && row0.website === "https://example.com/tide" && !("lat" in row0) && !("lng" in row0) &&
    Object.keys(row0).sort().join() === "address,area,id,kind,name,subkind,website,why", JSON.stringify(row0));
  check("its id is its name as a slug and a short tail", /^tide-cafe-[a-z0-9]{6}$/.test(row0.id || ""), row0.id);
  let rows = await placesOf(host);
  const tideId = row0.id;
  check("the server has it", rows.length === 1 && rows[0].id === tideId && rows[0].lat == null, JSON.stringify(rows.map((r) => [r.id, r.name, r.lat])));
  check('the + button is there now, named "Add a place"', l.fab === "Add a place" && l.fabs === 1, JSON.stringify({ fab: l.fab, fabs: l.fabs }));
  await first.look("places-one");

  // ── 3 ──────────────────────────────────────────────────────────────────────────────────────
  section("3. its page");
  await first.tap(`#view .pl-row[href="#/p/${encodeURIComponent(tideId)}"]`, "the row");
  await first.wait(pageOf("Tide cafe"), "the place's page");
  await sleep(400);
  let pg = JSON.parse(await first.page(`JSON.stringify((() => {
    const text = (n) => (n ? n.innerText.replace(/\\s+/g, " ").trim() : "");
    const v = document.querySelector("#view");
    return { nopin: text(v.querySelector(".pl-nopin")), banner: text(v.querySelector(".pl-banner")), why: text(v.querySelector(".pl-why")), addr: text(v.querySelector(".pl-addr-line")),
      change: text(v.querySelector('[data-act="change"]')), all: text(v).slice(0, 600) };
  })())`));
  check('"Not on the map: go by the address.", said quietly (not the warning banner)', pg.nopin === "Not on the map: go by the address." && pg.banner === "", JSON.stringify(pg));
  check("the note and the address are on it, and Change", pg.why === "Opens at six. Sit outside." && pg.addr === "Cais do Sal, by the ferry steps" && pg.change === "Change", JSON.stringify(pg));
  await first.look("place-page-no-pin");
  // A place's local name is shown under its name, unless it is the name again.
  const localOf = async (local, title) => {
    const put = await host.call("PUT", `${T}/places`, { places: [{ id: "twice-named", name: "Tide Steps", kind: "sight", subkind: "viewpoint", name_local: local }] });
    if (put.status !== 200) throw new Error(`the place with a local name was refused: ${put.status} ${String(put.text).slice(0, 300)}`);
    await first.refresh();
    await first.open("#/p/twice-named", pageOf("Tide Steps"), title);
    await sleep(300);
    return { status: put.status, ...JSON.parse(await first.page(`JSON.stringify((() => { const v = document.querySelector("#view"), n = v.querySelector(".pl-local"), band = v.querySelector(".pl-addr");
      return { local: n ? n.textContent : null, band: band ? band.innerText.replace(/\\s+/g, " ").trim() : null, copy: !!v.querySelector(".pl-copy") }; })())`)) };
  };
  const again = await localOf("TIDE  STEPS", "a place whose local name is its name in capitals");
  check("a local name that is the name again (capitals, other spacing) is not shown under it", again.status === 200 && again.local === null, JSON.stringify(again));
  check("a place with no address says so: no dash to show a driver, and no Copy", /^address no address written down\.$/i.test(again.band || "") && again.copy === false, JSON.stringify(again));
  const other2 = await localOf("Escadas da Maré", "the same place with a local name of its own");
  check("a local name of its own is shown under the name", other2.status === 200 && other2.local === "Escadas da Maré", JSON.stringify(other2));
  await first.look("place-page-local-name");
  const untwice = await host.call("DELETE", `${T}/places`, { ids: ["twice-named"] });
  await first.refresh();
  check("that place is taken off again, by its id", untwice.status === 200 && (await placesOf(host)).map((r) => r.id).join() === tideId, `${untwice.status}`);
  await first.open(`#/p/${encodeURIComponent(tideId)}`, pageOf("Tide cafe"), "back on the first place's page");

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────────
  section("4. any member changes any place");
  await second.open(`#/p/${encodeURIComponent(tideId)}`, pageOf("Tide cafe"), "the other person's phone, the place's page");
  await second.tap('#view [data-act="change"]', "Change");
  await second.sheet("Change place");
  f = await second.form();
  check("every field is as it was saved", f.name === "Tide cafe" && f.kind === "food" && f.sub === "cafe" && f.area === "harbor" && f.address === "Cais do Sal, by the ferry steps" &&
    f.why === "Opens at six. Sit outside." && f.link === "https://example.com/tide" && f.action === "Save", JSON.stringify(f));
  check('the sheet offers "Remove this place" at its foot', f.removeActs.join() === "remove:Remove this place", f.removeActs.join());
  await second.type("#pf-name", "Tide Cafe & Bar");
  await second.type("#pf-why", "Opens at six. Sit outside. Cash only.");
  before = second.writes.length;
  await second.tap('.sh-root [data-act="save"]', "Save");
  await second.sheetsDown(0);
  await second.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the change sent");
  const changed = putBodies(second, before);
  const cb = changed.length ? (JSON.parse(changed[0].body).places || [])[0] || {} : {};
  check("the request carries only what changed", changed.length === 1 && Object.keys(cb).sort().join() === "id,name,why" && cb.id === tideId && cb.name === "Tide Cafe & Bar", JSON.stringify(cb));
  await second.wait(pageOf("Tide Cafe & Bar"), "the page shows the new name");
  await first.refresh();
  await first.wait(pageOf("Tide Cafe & Bar"), "the first person's phone shows the change");
  check("the first person's phone shows the change", true);

  // A place with nothing but a name and a kind: its page says only "Not on the map."
  await first.open("#/places", PLACES, "Places");
  await first.tap("#rt-fixed .fab[data-place-add]", "the + button");
  await first.sheet("Add a place");
  await first.type("#pf-name", "The lookout");
  await first.tap('.pf-kind[data-kind="sight"]', "Sight");
  before = first.writes.length;
  await first.tap('.sh-root [data-act="save"]', "Add");
  await first.sheetsDown(0);
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the second place sent");
  const lookoutBody = (JSON.parse(putBodies(first, before)[0].body).places || [])[0] || {};
  const lookoutId = lookoutBody.id;
  check("a name and a kind are enough: the first 'what kind of' is sent, and an empty note", !!lookoutId && lookoutBody.kind === "sight" && !!lookoutBody.subkind && lookoutBody.why === "" &&
    Object.keys(lookoutBody).sort().join() === "id,kind,name,subkind,why", JSON.stringify(lookoutBody));
  await first.open(`#/p/${encodeURIComponent(lookoutId)}`, pageOf("The lookout"), "the lookout's page");
  const bare = await first.page(`(document.querySelector("#view .pl-nopin") || { innerText: "" }).innerText.trim()`);
  check('with no address either, the page says "Not on the map."', bare === "Not on the map.", bare);

  // ── 5 ──────────────────────────────────────────────────────────────────────────────────────
  section("5. put it on the map");
  play.ready = true;
  await first.open(`#/p/${encodeURIComponent(tideId)}`, pageOf("Tide Cafe & Bar"), "the place's page, the trip now with a map");
  await first.wait(`import("/js/store.js").then(({ store }) => store.tiles() && store.tiles().ready ? 1 : 0)`, "the trip says it has a map");
  await first.tap('#view [data-act="change"]', "Change");
  await first.sheet("Change place");
  f = await first.form();
  check('with a map the sheet offers "Put it on the map"', f.pin === "It shows in the list either way." && f.pinActs.join() === "pick:Put it on the map", f.pin + " / " + f.pinActs.join());
  await first.tap('#pf-pinbox [data-act="pick"]', "Put it on the map");
  await first.sheet("On the map");
  await first.wait(`document.querySelector(".sp-pick-map .mp-root") && window.__wgpMapView ? 1 : 0`, "the map in the picker");
  await sleep(1200);
  let pk = await first.picker();
  check("the trip's map is in the sheet, over the place sheet, with a real size", pk.there && pk.sheets === 2 && pk.w >= 280 && pk.h >= 240, JSON.stringify(pk));
  check("a pin is fixed with its tip on the middle of the map; the map's own panel is out of the way", pk.there && pk.pick === "1" && pk.pinShown && Math.abs(pk.tipDx) <= 1 && Math.abs(pk.tipDy) <= 1.5 && pk.sheetHidden, JSON.stringify(pk));
  check("it opens on the place's area", pk.there && inBox(HARBOR, pk.cam.lat, pk.cam.lng), JSON.stringify(pk.cam));
  check("the line names the place", /Move the map until the pin is on “Tide Cafe & Bar”, then press Here\./.test(pk.say || ""), pk.say);
  const tight = await first.narrow(`(() => {
    const top = [...document.querySelectorAll(".sh-root")].pop();
    const t = top.querySelector(".sh-title");
    const box = (n) => { const r = n.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
    const over = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    const sc = box(top.querySelector(".mp-scale"));
    const others = [...top.querySelectorAll(".sp-pick-zoom button, .mp-ctrl")].filter((n) => n.getBoundingClientRect().width > 0);
    return { w: innerWidth, title: t.textContent, cut: t.scrollWidth > t.clientWidth, others: others.length, under: others.filter((n) => over(box(n), sc)).length, scale: sc.map(Math.round) };
  })()`);
  check("at 320 wide the picker's title is whole, and the map's scale is beside the zoom buttons, under nothing",
    tight.w === 320 && tight.title === "On the map" && !tight.cut && tight.others >= 2 && tight.under === 0, JSON.stringify(tight));
  await first.look("picker");
  const cam0 = pk.cam;
  await first.key(".sp-pick-map", "ArrowRight");
  await first.key(".sp-pick-map", "ArrowUp", true);
  pk = await first.picker();
  check("the arrow keys move the map under the pin (right: further east; Shift+up: a little north)", pk.cam.lng > cam0.lng && pk.cam.lat > cam0.lat && Math.abs(pk.cam.zoom - cam0.zoom) < 1e-6,
    `${JSON.stringify(cam0)} -> ${JSON.stringify(pk.cam)}`);
  await first.tap('.sp-pick-zoom [data-zoom="1"]', "zoom in");
  await sleep(600);
  const zoomed = await first.picker();
  check("the + button zooms in about the pin", zoomed.cam.zoom > pk.cam.zoom + 0.5 && Math.abs(zoomed.cam.lat - pk.cam.lat) < 1e-4 && Math.abs(zoomed.cam.lng - pk.cam.lng) < 1e-4, `${JSON.stringify(pk.cam)} -> ${JSON.stringify(zoomed.cam)}`);
  // Cancel first: nothing changes.
  await first.tap('.sh-root [data-act="cancel"]', "Cancel");
  await first.sheetsDown(1, "the picker closed, the place sheet still open");
  f = await first.form();
  check("Cancel changes nothing", f.pin === "It shows in the list either way." && f.pinActs.join() === "pick:Put it on the map", f.pin);
  // Again, and Here.
  await first.tap('#pf-pinbox [data-act="pick"]', "Put it on the map");
  await first.sheet("On the map");
  await first.wait(`document.querySelector(".sp-pick-map .mp-root") ? 1 : 0`, "the map in the picker again");
  await sleep(900);
  pk = await first.picker();
  // A place with no pin opens on its area every time: what Cancel left behind is not kept.
  check("opened again, it is on the place's area as before, not where Cancel left it",
    Math.abs(pk.cam.lat - cam0.lat) < 1e-6 && Math.abs(pk.cam.lng - cam0.lng) < 1e-6 && Math.abs(pk.cam.zoom - cam0.zoom) < 1e-6, `${JSON.stringify(cam0)} / ${JSON.stringify(pk.cam)}`);
  await first.key(".sp-pick-map", "ArrowLeft");
  await first.key(".sp-pick-map", "ArrowDown", true);
  pk = await first.picker();
  const spot = pk.cam;
  check("moved west and a little south, still inside the area", spot.lng < cam0.lng - 1e-3 && spot.lat < cam0.lat - 1e-4 && inBox(HARBOR, spot.lat, spot.lng), `${JSON.stringify(cam0)} -> ${JSON.stringify(spot)}`);
  await first.tap('.sh-root [data-act="here"]', "Here");
  await first.sheetsDown(1, "the picker closed");
  f = await first.form();
  const said = /^On the map at (-?\d+\.\d+), (-?\d+\.\d+)\.$/.exec(f.pin) || [];
  check("Here: the place sheet says where, the spot that was under the pin", said.length === 3 && Math.abs(Number(said[1]) - spot.lat) < 2e-5 && Math.abs(Number(said[2]) - spot.lng) < 2e-5, `${f.pin} / ${JSON.stringify(spot)}`);
  check('…and offers "Move the pin" and "Take it off the map"; the focus is back on the first', f.pinActs.join() === "pick:Move the pin,unpin:Take it off the map" && f.focus === "pick", f.pinActs.join() + " / " + f.focus);
  check("inside its area: nothing is said about the spot", f.said.length === 0, JSON.stringify(f.said));
  await first.look("sheet-pinned");
  before = first.writes.length;
  await first.tap('.sh-root [data-act="save"]', "Save");
  await first.sheetsDown(0);
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the pin sent");
  const pinned = putBodies(first, before);
  const pb = pinned.length ? (JSON.parse(pinned[0].body).places || [])[0] || {} : {};
  check("saving sends only the pin", pinned.length === 1 && Object.keys(pb).sort().join() === "id,lat,lng" && Math.abs(pb.lat - spot.lat) < 2e-5 && Math.abs(pb.lng - spot.lng) < 2e-5, JSON.stringify(pb));
  rows = await placesOf(host);
  const onServer = rows.find((r) => r.id === tideId);
  check("the server has the pin", !!onServer && Math.abs(onServer.lat - spot.lat) < 2e-5 && Math.abs(onServer.lng - spot.lng) < 2e-5, JSON.stringify(onServer && [onServer.lat, onServer.lng]));
  const nopinNow = await first.page(`document.querySelector("#view .pl-nopin") ? 1 : 0`);
  check("its page no longer says it is not on the map", nopinNow === 0, String(nopinNow));

  // Places' own map has its map back: no pick mode, its panel, and the place's pin.
  await first.open("#/places?view=map", `document.querySelector("#view .mp-root") && window.__wgpMapView ? 1 : 0`, "Places, the map");
  await sleep(1200);
  const back = JSON.parse(await first.page(`JSON.stringify((() => {
    const root = document.querySelector("#view .mp-root");
    return { pick: root.dataset.pick || "", pickPin: !root.querySelector(".mp-pickpin").hidden, sheet: getComputedStyle(root.querySelector(".mp-sheet")).display,
      pins: [...root.querySelectorAll(".mp-pin")].map((n) => n.dataset.id) };
  })())`));
  check("Places' own map is itself again: no fixed pin, its panel back, the place's pin on it", back.pick === "" && !back.pickPin && back.sheet !== "none" && back.pins.includes(tideId), JSON.stringify(back));
  // …and the picker opened from the map face gives the map back to it afterwards.
  await first.tap("#rt-fixed .fab[data-place-add]", "the + button, over the map");
  await first.sheet("Add a place");
  await first.type("#pf-name", "Ferry steps");
  await first.tap('.pf-kind[data-kind="transit"]', "Transit");
  await first.tap('#pf-pinbox [data-act="pick"]', "Put it on the map");
  await first.sheet("On the map");
  await first.wait(`document.querySelector(".sp-pick-map .mp-root") ? 1 : 0`, "the map moved into the picker");
  await sleep(900);
  const lent = await first.page(`(document.querySelector("#view .mp-root") ? 1 : 0)`);
  // Far outside every area, to be refused below with an area chosen.
  await first.page(`(window.__wgpMapView.jumpTo({ lng: -8.6, lat: 41.15, zoom: 14 }), 1)`);
  await sleep(700);
  await first.tap('.sh-root [data-act="here"]', "Here");
  await first.sheetsDown(1, "the picker closed");
  await sleep(600);
  const returned = JSON.parse(await first.page(`JSON.stringify((() => { const root = document.querySelector("#view .mp-root"); return root ? { pick: root.dataset.pick || "", pickPin: !root.querySelector(".mp-pickpin").hidden, sheet: getComputedStyle(root.querySelector(".mp-sheet")).display, cam: window.__wgpMapView.cam() } : null; })())`));
  check("opened over Places' map: the map is lent to the picker, then back where it was, with no fixed pin and its panel back",
    lent === 0 && !!returned && returned.pick === "" && !returned.pickPin && returned.sheet !== "none" && Math.abs(returned.cam.lat - 41.15) > 0.5, JSON.stringify({ lent, returned }));
  f = await first.form();
  check("with no area chosen any spot is fine", /^On the map at 41\.15\d*, -8\.6\d*\.$/.test(f.pin) && f.said.length === 0, f.pin + " " + JSON.stringify(f.said));
  await first.tap('.pf [data-act="toggle-more"]', "More details");
  await first.tap('.pf-area[data-area="harbor"]', "Harbor");
  f = await first.form();
  check("an area the spot is outside of: said at once under the pin", f.said.join() === "pin: That spot is outside Harbor. Move the pin, or pick the area it is in.", JSON.stringify(f.said));
  await first.look("sheet-pin-outside");
  before = first.writes.length;
  await first.tap('.sh-root [data-act="save"]', "Add, with the pin outside its area");
  await sleep(400);
  f = await first.form();
  check("…and not saved: the sheet stays, nothing is sent", (await first.sheets()) === 1 && first.writes.length === before && /outside Harbor/.test(f.said.join()), JSON.stringify(f.said));
  await first.tap('#pf-pinbox [data-act="unpin"]', "Take it off the map");
  f = await first.form();
  check('"Take it off the map": no pin, nothing said, "Put it on the map" again', f.pin === "It shows in the list either way." && f.said.length === 0 && f.pinActs.join() === "pick:Put it on the map", f.pin + " / " + f.pinActs.join());
  await first.tap(".sh-scrim", "outside the sheet");
  await first.sheetsDown(0, "the sheet left without saving");
  rows = await placesOf(host);
  check("left without saving: no such place", !rows.some((r) => r.name === "Ferry steps"), rows.map((r) => r.name).join());

  // A pin taken off a saved place.
  await first.open(`#/p/${encodeURIComponent(tideId)}`, pageOf("Tide Cafe & Bar"), "the place's page");
  await first.tap('#view [data-act="change"]', "Change");
  await first.sheet("Change place");
  await first.tap('#pf-pinbox [data-act="unpin"]', "Take it off the map");
  before = first.writes.length;
  await first.tap('.sh-root [data-act="save"]', "Save");
  await first.sheetsDown(0);
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the cleared pin sent");
  const cleared = putBodies(first, before);
  const clb = cleared.length ? (JSON.parse(cleared[0].body).places || [])[0] || {} : {};
  rows = await placesOf(host);
  check("a pin taken off is cleared on the server: lat and lng both null", cleared.length === 1 && clb.lat === null && clb.lng === null && Object.keys(clb).sort().join() === "id,lat,lng" && rows.find((r) => r.id === tideId).lat == null, JSON.stringify(clb));

  // ── 6 ──────────────────────────────────────────────────────────────────────────────────────
  section("6. a link that carries a location");
  await first.tap('#view [data-act="change"]', "Change");
  await first.sheet("Change place");
  await first.type("#pf-link", "https://maps.app.goo.gl/AbCdEf123");
  f = await first.form();
  check("a short map link: no offer, and a line says why and what to do", !f.pinActs.some((a) => /^use-link/.test(a)) && /A short map link doesn't say where it points\./.test(f.pinNote), f.pinActs.join() + " / " + f.pinNote);
  await first.type("#pf-link", "https://www.google.com/maps/place/Tide/@38.7100,-9.1400,17z/data=!3d38.71120!4d-9.14080");
  f = await first.form();
  // A link that names the place itself places it as it is pasted, and says so (a stranger's walk,
  // 16 Nov: Add left a pasted place "not on the map").
  if (SHOTS) {
    for (const scheme of ["light", "dark"]) {
      await first.b.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, first.b.S);
      await first.page(`(document.querySelector("#pf-pinbox").scrollIntoView({ block: "center" }), 1)`);
      await sleep(400);
      await first.b.shot(path.join(SHOTS, `placed-from-the-link-390-${scheme}.png`));
    }
    await first.b.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, first.b.S);
  }
  check("a link that names the place places it at once, from the place, not where its map was looking, and says so, with Change", f.pin === "Placed from the link, at 38.71120, -9.14080." && !f.pinActs.some((a) => /^use-link/.test(a)) && f.pinActs.includes("pick:Change") && f.pinNote === "", f.pin + " / " + f.pinActs.join() + " / " + f.pinNote);
  await first.tap('#pf-pinbox [data-act="unpin"]', "Take it off the map");
  await first.type("#pf-link", "https://www.google.com/maps/place/Tide/@38.7100,-9.1400,17z/data=!3d38.71120!4d-9.14080");
  f = await first.form();
  check("taken off the map, the same link doesn't put it back (it is offered instead)", /shows in the list either way\./.test(f.pin) && f.pinActs.some((a) => a === "use-link:Use this link's location"), f.pin + " / " + f.pinActs.join());
  await first.type("#pf-link", "https://www.google.com/maps/place/Tide/@38.7100,-9.1400,17z/data=!3d38.71120!4d-9.14081");
  f = await first.form();
  check("another link that names a place: placed from it", f.pin === "Placed from the link, at 38.71120, -9.14081.", f.pin);
  await first.type("#pf-link", "https://www.google.com/maps/@38.7150,-9.1300,15z");
  f = await first.form();
  check("then a link that only names a view: the pin the old link placed goes with it, and the view is only offered", /shows in the list either way\./.test(f.pin) && f.pinActs.some((a) => a === "use-link:Use this link's location"), f.pin + " / " + f.pinActs.join());
  await first.tap('#pf-pinbox [data-act="use-link"]', "Use this link's location");
  const viewOnly = await first.form();
  check("a link that only says where its map was looking: offered with a warning to check the pin", /may be beside the place/.test(f.pinNote) && viewOnly.pin === "On the map at 38.71500, -9.13000.", f.pinNote + " / " + viewOnly.pin);
  await first.type("#pf-link", "https://www.google.com/maps/place/Tide/@38.7100,-9.1400,17z/data=!3d38.71120!4d-9.14080");
  await first.tap('#pf-pinbox [data-act="use-link"]', "Use this link's location");
  before = first.writes.length;
  await first.tap('.sh-root [data-act="save"]', "Save");
  await first.sheetsDown(0);
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the link's pin sent");
  rows = await placesOf(host);
  const linked = rows.find((r) => r.id === tideId);
  check("saved: the pin and the link", !!linked && Math.abs(linked.lat - 38.7112) < 1e-6 && Math.abs(linked.lng + 9.1408) < 1e-6 && /^https:\/\/www\.google\.com\/maps\/place\/Tide/.test(linked.website || ""), JSON.stringify(linked && [linked.lat, linked.lng, linked.website]));

  // ── 7 ──────────────────────────────────────────────────────────────────────────────────────
  section("7. with no signal");
  await first.open("#/places", PLACES, "Places");
  await first.apiOff(true);
  await first.tap("#rt-fixed .fab[data-place-add]", "the + button");
  await first.sheet("Add a place");
  await first.type("#pf-name", "Night market");
  await first.tap('.pf-kind[data-kind="food"]', "Food");
  await first.tap('.sh-root [data-act="save"]', "Add");
  await first.sheetsDown(0);
  await sleep(700);
  l = await first.list();
  const waiting = await first.inStore(`return store.pending();`);
  rows = await placesOf(host);
  check("the place is in the list at once", l.rows.some((r) => r.name === "Night market" && /not on the map/.test(r.meta)), JSON.stringify(l.rows.map((r) => r.name)));
  check("it waits on the phone; the server has not heard of it", waiting === 1 && !rows.some((r) => r.name === "Night market"), `${waiting} ${rows.map((r) => r.name).join()}`);
  await first.apiOff(false);
  await first.page(`(window.dispatchEvent(new Event("online")), 1)`);
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the waiting place sent");
  rows = await placesOf(host);
  check("when the API answers again it is sent", rows.some((r) => r.name === "Night market" && r.kind === "food"), rows.map((r) => r.name).join());

  // ── 8 ──────────────────────────────────────────────────────────────────────────────────────
  section("8. a new place a few meters from another of its kind");
  await sleep(5500);                         // any earlier line has left the screen
  await first.tap("#rt-fixed .fab[data-place-add]", "the + button");
  await first.sheet("Add a place");
  await first.type("#pf-name", "Tide kiosk");
  await first.tap('.pf-kind[data-kind="food"]', "Food");
  await first.type("#pf-address", "38.71121, -9.14081");
  f = await first.form();
  check("coordinates typed as the address place it at once, and say so", f.pin === "Placed from the coordinates, at 38.71121, -9.14081." && !f.pinActs.some((a) => /^use-link/.test(a)), f.pin + " / " + f.pinActs.join());
  await first.tap('.sh-root [data-act="save"]', "Add");
  await first.sheetsDown(0);
  await first.wait(`(() => { const t = document.querySelector(".toast"); return t && !t.hidden && /Tide kiosk/.test(t.innerText) ? 1 : 0; })()`, "the line about the place nearby");
  const nearLine = await first.toast();
  rows = await placesOf(host);
  check("it is saved all the same", rows.some((r) => r.name === "Tide kiosk"), rows.map((r) => r.name).join());
  check("a line names both places and how far apart", /^“Tide kiosk” is \d+ m from “Tide Cafe & Bar”\. If they are one place, remove one of them\.$/.test(nearLine), nearLine);
  if (SHOTS) await first.b.shot(path.join(SHOTS, "near-line-390.png"));

  // ── 9 ──────────────────────────────────────────────────────────────────────────────────────
  section("9. removal");
  const plan = await host.post(`${T}/events`, { id: "breakfast-ferry", title: "Breakfast before the ferry", kind: "meal", starts_at: Math.floor(Date.parse(`${DAYS[1]}T08:00:00Z`) / 1000), tz: ZONE, place_id: tideId });
  check("(a plan is put at the first place)", plan.status < 300, `${plan.status} ${plan.text.slice(0, 200)}`);
  await first.refresh();
  await first.open(`#/p/${encodeURIComponent(tideId)}`, pageOf("Tide Cafe & Bar"), "the place's page");
  await first.tap('#view [data-act="change"]', "Change");
  await first.sheet("Change place");
  await first.tap('#pf-remove [data-act="remove"]', "Remove this place");
  f = await first.form();
  before = first.writes.length;
  check("a place a plan is at stays: the sheet names the plan, and offers only OK", f.ask === "“Tide Cafe & Bar” is where a plan is: “Breakfast before the ferry”. Change where that plan is first." && f.removeActs.join() === "keep:OK" && f.focus === "keep", f.ask + " / " + f.removeActs.join() + " / " + f.focus);
  await first.look("sheet-remove-held");
  await first.tap('#pf-remove [data-act="keep"]', "OK");
  f = await first.form();
  check("OK puts the button back; nothing was sent", f.removeActs.join() === "remove:Remove this place" && first.writes.length === before, f.removeActs.join());
  await first.tap(".sh-scrim", "outside the sheet");
  await first.sheetsDown(0);
  // A free place, from its page.
  await first.open(`#/p/${encodeURIComponent(lookoutId)}`, pageOf("The lookout"), "the lookout's page");
  await first.tap('#view [data-act="change"]', "Change");
  await first.sheet("Change place");
  await first.tap('#pf-remove [data-act="remove"]', "Remove this place");
  f = await first.form();
  check('a free place: "Remove “The lookout”?", the focus on "Keep it"', f.ask === "Remove “The lookout”?" && f.removeActs.join() === "keep:Keep it,remove-yes:Remove" && f.focus === "keep", f.ask + " / " + f.removeActs.join() + " / " + f.focus);
  await first.look("sheet-remove-ask");
  await first.tap('#pf-remove [data-act="keep"]', "Keep it");
  rows = await placesOf(host);
  check("keeping keeps", rows.some((r) => r.id === lookoutId) && (await first.sheets()) === 1, rows.map((r) => r.name).join());
  await first.tap('#pf-remove [data-act="remove"]', "Remove this place");
  before = first.writes.length;
  await first.tap('#pf-remove [data-act="remove-yes"]', "Remove");
  await first.sheetsDown(0);
  await first.wait(PLACES, "back in Places");
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the removal sent");
  await sleep(400);
  l = await first.list();
  rows = await placesOf(host);
  const del = first.writes.slice(before).filter((w) => w.method === "DELETE");
  check("removing goes back to Places without it, and the server no longer has it", !l.rows.some((r) => r.name === "The lookout") && !rows.some((r) => r.id === lookoutId) &&
    del.length === 1 && del[0].path === `${T}/places/${encodeURIComponent(lookoutId)}`, JSON.stringify({ rows: l.rows.map((r) => r.name), del }));

  // ── 10 ─────────────────────────────────────────────────────────────────────────────────────
  section("10. from a plan");
  await first.open("#/", `document.querySelector("#view").dataset.route === "agenda" && document.querySelector("#rt-fixed .fab[data-plan-add]") ? 1 : 0`, "the Agenda");
  await first.tap("#rt-fixed .fab[data-plan-add]", "Add a plan");
  await first.sheet("Add a plan");
  await first.type("#pe-title", "Drinks at sunset");
  await first.tap('.pe-kind[data-kind="meal"]', "Food");
  if (await first.page(`document.querySelector('.pe [data-act="toggle-more"]') && document.querySelector('#pe-more')?.hidden ? 1 : 0`)) {
    await first.tap('.pe [data-act="toggle-more"]', "More details");
  }
  await first.type("#pe-where", "tide");
  let found = JSON.parse(await first.page(`JSON.stringify([...document.querySelectorAll("#pe-found .pe-hit")].map((n) => (n.dataset.place ? "place:" : n.dataset.act + ":") + n.innerText.replace(/\\s+/g, " ").trim()))`));
  check("part of a name finds the trip's places, and offers to add what was typed as a new one", found.filter((x) => /^place:/.test(x)).length === 2 && found[found.length - 1] === "new-place:Add “tide” as a new place", JSON.stringify(found));
  await first.type("#pe-where", "Sunset bar");
  found = JSON.parse(await first.page(`JSON.stringify([...document.querySelectorAll("#pe-found .pe-hit")].map((n) => (n.dataset.place ? "place:" : n.dataset.act + ":") + n.innerText.replace(/\\s+/g, " ").trim()))`));
  check("a name no place has: only the offer to add it", found.join() === "new-place:Add “Sunset bar” as a new place", JSON.stringify(found));
  const offer = await first.narrow(`(() => {
    const n = document.querySelector("#pe-found .pe-make .pe-placen");
    const r = n.closest("button").getBoundingClientRect();
    return { w: innerWidth, words: n.innerText, cut: n.scrollWidth > n.clientWidth + 1 || getComputedStyle(n).textOverflow === "ellipsis" && getComputedStyle(n).whiteSpace === "nowrap", right: Math.round(r.right) };
  })()`);
  check("at 320 wide the offer is whole: it wraps, it is not cut short", offer.w === 320 && offer.words === "Add “Sunset bar” as a new place" && !offer.cut && offer.right <= 320, JSON.stringify(offer));
  await first.look("from-a-plan");
  await first.tap('#pe-found [data-act="new-place"]', "Add “Sunset bar” as a new place");
  await first.sheet("Add a place");
  f = await first.form();
  check("the place sheet opens over the plan sheet, the name in it, the plan's kind pressed (a meal: Food)", (await first.sheets()) === 2 && f.name === "Sunset bar" && f.kind === "food" && f.sub !== "", JSON.stringify({ name: f.name, kind: f.kind, sub: f.sub }));
  await first.tap('.pf-kind[data-kind="drink"]', "Drink");
  before = first.writes.length;
  await first.tap('.sh-root [data-act="save"]', "Add");
  await first.sheetsDown(1, "the place sheet closed, the plan sheet still open");
  const chosen = await first.page(`(document.querySelector(".pe-placeline") || { innerText: "" }).innerText.replace(/\\s+/g, " ").trim()`);
  check("the plan sheet is back with that place chosen", /Sunset bar/.test(chosen), chosen);
  await first.tap('.sh-root [data-act="save"]', "Add the plan");
  await first.sheetsDown(0);
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the place and the plan sent");
  rows = await placesOf(host);
  const bar = rows.find((r) => r.name === "Sunset bar");
  const evs = await eventsOf(host);
  const drinks = evs.find((e) => e.title === "Drinks at sunset");
  check("the place is on the server as a Drink, and the plan is at it", !!bar && bar.kind === "drink" && !!drinks && drinks.place_id === bar.id, JSON.stringify({ bar: bar && [bar.id, bar.kind], plan: drinks && drinks.place_id }));

  // ── 11 ─────────────────────────────────────────────────────────────────────────────────────
  section("11. a removal the server refuses later");
  await second.open("#/places", PLACES, "the other person's Places");
  await second.refresh();
  const nmId = (await placesOf(host)).find((r) => r.name === "Night market").id;
  await second.apiOff(true);
  // Meanwhile the first person puts a plan at the Night market.
  const supper = await host.post(`${T}/events`, { id: "supper-market", title: "Supper at the market", kind: "meal", starts_at: Math.floor(Date.parse(`${DAYS[2]}T19:00:00Z`) / 1000), tz: ZONE, place_id: nmId });
  await second.tap(`#view .pl-row[href="#/p/${encodeURIComponent(nmId)}"]`, "the Night market's row");
  await second.wait(pageOf("Night market"), "the Night market's page");
  await second.tap('#view [data-act="change"]', "Change");
  await second.sheet("Change place");
  await second.tap('#pf-remove [data-act="remove"]', "Remove this place");
  await second.tap('#pf-remove [data-act="remove-yes"]', "Remove");
  await second.sheetsDown(0);
  await second.wait(PLACES, "back in Places");
  await sleep(500);
  l = await second.list();
  check("(without signal the phone lets it go: it knows of no plan there)", supper.status < 300 && !l.rows.some((r) => r.name === "Night market") && (await second.inStore(`return store.pending();`)) === 1, JSON.stringify(l.rows.map((r) => r.name)));
  await sleep(4500);
  await second.apiOff(false);
  await second.page(`(window.dispatchEvent(new Event("online")), 1)`);
  await second.wait(`(() => { const t = document.querySelector(".toast"); return t && !t.hidden && /Night market/.test(t.innerText) ? 1 : 0; })()`, "the sentence about the refused removal");
  const refusedLine = await second.toast();
  check("the server keeps it, and the phone says why, by the place's name", refusedLine === "A plan is at “Night market” now, so it stays.", refusedLine);
  await second.wait(`[...document.querySelectorAll("#view .pl-name")].some((n) => n.textContent.trim() === "Night market") ? 1 : 0`, "the place back in the list");
  rows = await placesOf(host);
  check("the place is back in the list, and still on the server", rows.some((r) => r.id === nmId), rows.map((r) => r.name).join());
  if (SHOTS) await second.b.shot(path.join(SHOTS, "refused-line-390.png"));

  check("no page error in either browser", first.b.pageErrors.length === 0 && second.b.pageErrors.length === 0, [...first.b.pageErrors, ...second.b.pageErrors].join(" | "));
} catch (e) {
  fail++; failures.push("the check ran to its end");
  console.log(`  FAIL  the check ran to its end   -> ${e && e.stack ? e.stack : e}`);
} finally {
  for (const b of phones) await b.done().catch(() => {});
  await server.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(fail ? 1 : 0);
