#!/usr/bin/env node
/* SMALL AND SIDEWAYS PHONES, THE PAGES A STRANGER OR A NEW PERSON SEES, on a server of its own (the plan and the
 * assistant on, so the assistant's tab is offered), made-up people, at 320 x 568, 360 x 780 and 844 x 390 on its
 * side (scripts/lib/narrow.mjs: the safe areas through Chrome's own override, read back first):
 *
 *   signed out: sign-in, the terms, the privacy page, a join link, a shared board (a memory posted through the
 *   composer, the board shared as a link, opened as a stranger opens it);
 *   a new person with no trip: Your trips with Make a trip, Your account, the join link signed in;
 *   a trip just made, its host: the Itinerary and Packing with nothing in them, Places with one place and Split
 *   with one purchase (each with a long name, as real ones are), Photos with one memory, Chat, the assistant's
 *   tab, People and settings.
 *
 * On each, as narrow_check judges the trip's screens: the page doesn't scroll sideways; nothing read or tapped
 * runs off the side; no words cut; on its side no words and no control's symbol under the notch; nothing held to
 * the screen past its top or foot, or under the status bar or the home bar; no control under another or under a bar,
 * and no words under a bar; controls met in the order they are seen. At 768 x 1024 too (a tablet).
 *
 *   node scripts/gate.mjs --only narrow_public_check
 *
 * PLANTED (each verdict shown to go red):
 *   NARROW_PUBLIC_PLANT=wide   css/account.css with sign-in's column a fixed 400 px: sign-in and the join link,
 *                              at 320 and 360 (the column is cut at the side of the page box that scrolls).
 *   NARROW_PUBLIC_PLANT=cut    css/account.css with sign-in's line under the wordmark on one line, clipped:
 *                              sign-in at every size.
 *   NARROW_PUBLIC_PLANT=notch  styles.css without the rule that widens the rail by the left safe area: the
 *                              trip's screens on its side. (Sign-in's own column is 420 px in the middle of
 *                              the screen, so nothing of it can reach a notch.)
 *   NARROW_PUBLIC_PLANT=legal  css/legal.css without its own body: the terms and the privacy page as the app's one
 *                              fixed screen, with nothing past the first screen reachable, at every size.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";
import { PHONES, setPhone, judge, insetsHonest } from "./lib/narrow.mjs";
import { pickPhotos, cdpPage } from "./lib/photo_picker.mjs";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PLANT = process.env.NARROW_PUBLIC_PLANT || "";
const read = (f) => fs.readFileSync(path.join(REPO, "public", f), "utf8");
const PLANTS = {
  wide: () => ["*/css/account.css*", read("css/account.css") + "\n.lg-wrap{width:400px;max-width:none;flex:none}\n"],
  cut: () => ["*/css/account.css*", read("css/account.css") + "\n.lg-what{white-space:nowrap;overflow:hidden}\n"],
  notch: () => { const css = read("styles.css"), t = css.replace(/\/\* A phone on its side: the rail stands[\s\S]*?\n\}\n/, "");
    if (t === css) throw new Error("the notch plant changed nothing"); return ["*/styles.css*", t]; },
  legal: () => { const css = read("css/legal.css"), t = css.replace("body { display: block; height: auto; min-height: 100dvh; overflow: visible; }\n", "");
    if (t === css) throw new Error("the legal plant changed nothing"); return ["*/css/legal.css*", t]; },
};
if (PLANT && !PLANTS[PLANT]) throw new Error(`no such plant: ${PLANT}`);
const PLANTED = PLANT ? PLANTS[PLANT]() : null;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 1500) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await startServer({
  name: "narrow-public", port: await freeLoopbackPort(),
  vars: { PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y", ASSISTANT_ENABLED: "true",
    ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5" },
  secrets: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", OPENROUTER_API_KEY: "sk-or-check-not-real" },
});
ownServer(server.origin);
const { boot, evalIn, waitFor, appSettled } = await import("./lib/standalone_cdp.mjs");

let b = null, TMP = null;
try {
  // One photograph, made from a picture the tree already carries.
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-narrow-"));
  const PHOTO = path.join(TMP, "harbor.jpg");
  execFileSync("sips", ["-s", "format", "jpeg", "-Z", "1200", path.join(REPO, "public/img/demo-hero.webp"), "--out", PHOTO], { stdio: "ignore" });
  await server.start();
  const ada = new Person(server.origin, "Ada Reyes");
  await ada.signUp();
  const ben = new Person(server.origin, "Ben Okafor-Lindqvist");
  await ben.signUp();
  const day = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
  const trip = (await ada.post("/api/trips", { name: "Porto and the Douro valley in November", default_tz: "UTC", starts_on: day(0), ends_on: day(3) })).json.trip.id;
  const code = (await ada.post(`/api/trips/${trip}/links`, { uses: 5 })).json.link.code;
  // One place and one purchase whose names are long, as real ones are.
  const T = `/api/trips/${trip}`;
  const area = await ada.call("PUT", `${T}/areas`, { areas: [{ id: "ribeira", name: "Ribeira", west: -8.63, south: 41.13, east: -8.59, north: 41.16 }] });
  const place = await ada.call("PUT", `${T}/places`, { places: [{ id: "long-place", name: "Miradouro da Senhora do Monte e Jardim do Passeio Alegre", kind: "sight",
    subkind: "viewpoint", why: "The whole river and both banks in one look", area: "ribeira", lat: 41.141, lng: -8.611 }] });
  const buy = await ada.post(`${T}/purchases`, { id: "pu-long", description: "Port tasting in the cellars across the river, and the little boat back for all six of us",
    amount_minor: 18450, currency: "EUR", amount_exp: 2, split_mode: "weight", spent_at: Math.floor(Date.now() / 1000) - 600,
    shares: [{ user_id: ada.user.id, weight: 1, share_minor: 18450 }] });
  check("made up: a place and a purchase with long names", area.status === 200 && place.status === 200 && buy.status === 201,
    `${area.status} ${place.status} ${buy.status} ${JSON.stringify(buy.json || "").slice(0, 200)}`);

  b = await boot({ vw: 390, vh: 844, dsf: 2, reduceMotion: true });
  const { cdp, S } = b;
  const page = (expr) => evalIn(cdp, S, expr);
  const wait = (expr, label, timeout = 45000) => waitFor(cdp, S, `${expr} ? 1 : 0`, { label, timeout });
  const signInAs = async (p) => {
    await cdp.send("Network.clearBrowserCookies", {}, S);
    await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: p.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
    await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: encodeURIComponent(p.user.id), sameSite: "Lax" }, S);
  };
  const signOut = () => cdp.send("Network.clearBrowserCookies", {}, S);
  const go = async (url, ready, label) => {
    await cdp.send("Page.navigate", { url: "about:blank" }, S);
    await sleep(100);
    await cdp.send("Page.navigate", { url }, S);
    await appSettled(cdp, S).catch(() => {});
    await wait(ready, label);
    await sleep(900);
    // The page asked for, not one it was sent on to (a sign-in, another section).
    const asked = new URL(url), at = JSON.parse(await page(`JSON.stringify([location.pathname, location.hash])`));
    if (at[0] !== asked.pathname || at[1] !== asked.hash) throw new Error(`${label}: asked for ${asked.pathname}${asked.hash}, at ${at[0]}${at[1]}`);
  };
  if (PLANTED) {
    cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/css; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(PLANTED[1]).toString("base64") }, S).catch(() => {}); });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: PLANTED[0] }] }, S);
  }

  // A shared board, once, through the app as a person makes one (the composer, the board's sheet, Share).
  section("A shared board, made");
  await signInAs(ada);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, S);
  await go(`${server.origin}/t/${trip}/?${Date.now()}#/memories`, `document.querySelector(".me-fab")`, "Photos");
  await pickPhotos({ ...cdpPage(cdp, S), files: [PHOTO] });   // Add photos: the phone's picker first, then the sheet
  await wait(`document.querySelectorAll(".me-pickrow").length === 1`, "the picked file");
  await page(`(() => { const i = document.querySelector("#me-cap-in"); i.value = "The harbour at dusk, from the bridge's upper deck"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await wait(`document.querySelector(".me-go") && !document.querySelector(".me-go").disabled`, "Upload enabled");
  await page(`(document.querySelector(".me-go").click(), 1)`);
  await wait(`[...document.querySelectorAll(".me-card")].some((c) => /harbour/i.test(c.textContent)) && !document.querySelector(".me-job")`, "the memory posted", 90000);
  await page(`(document.querySelector('.me-viewbtn[data-view="collage"]').click(), 1)`);
  await wait(`document.querySelector(".cg-look")`, "the board");
  await sleep(1500);
  await page(`(document.querySelector(".cg-look").click(), 1)`);
  await wait(`document.querySelector('.cg-lookfoot .cg-save[data-kind="link"]')`, "the board's sheet");
  await page(`(document.querySelector('.cg-lookfoot .cg-save[data-kind="link"]').click(), 1)`);
  await wait(`(document.querySelector(".cg-shareurl") || {}).value`, "the link", 90000);
  const shared = (await page(`document.querySelector(".cg-shareurl").value`)).split("/s/")[1];
  check("made up: a memory posted and its board shared as a link", !!shared, shared);
  // The sheet shut, and Photos back to its feed, as a person who hasn't chosen the board sees it.
  await page(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
  await wait(`!document.querySelector(".sh-root[data-open='1']")`, "the sheet shut", 10000);
  await page(`(document.querySelector('.me-viewbtn[data-view="feed"]').click(), 1)`);
  await wait(`document.querySelector("#view .me-card")`, "the feed");

  const inTrip = (hash) => `${server.origin}/t/${trip}/?${Date.now()}${hash}`;
  for (const ph of PHONES) {
    section(ph.name);
    await setPhone(cdp, S, ph);
    // NARROW_SHOTS=<folder>: a still of each screen that goes red. Only through the stills queue, never beside it.
    const shot = process.env.NARROW_SHOTS ? async (label) => { fs.mkdirSync(process.env.NARROW_SHOTS, { recursive: true });
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, S);
      fs.writeFileSync(path.join(process.env.NARROW_SHOTS, label.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".png"), Buffer.from(data, "base64")); } : null;
    const look = (screen) => judge(page, check, ph, screen, shot);

    await signOut();
    await go(`${server.origin}/login`, `document.querySelector("#page:not([data-wait]) #signin-what")`, "sign-in");
    if (!(await insetsHonest(page, check, ph))) throw new Error("the safe-area emulation isn't honest");
    await look("Sign-in");
    await go(`${server.origin}/terms`, `document.querySelector("h1")`, "the terms");
    await look("The terms");
    await go(`${server.origin}/privacy`, `document.querySelector("h1")`, "the privacy page");
    await look("The privacy page");
    await go(`${server.origin}/join/${code}`, `document.querySelector("#page:not([data-wait]) .lg-wrap")`, "the join link");
    await look("A join link (signed out)");
    await go(`${server.origin}/s/${shared}`, `document.querySelector(".tile img, .tile video") && document.querySelector(".mark svg")`, "the shared board");
    await look("A shared board (a stranger)");

    await signInAs(ben);
    await go(`${server.origin}/trips`, `document.querySelector("#make-title")`, "Your trips");
    await look("Your trips, Make a trip (no trip yet)");
    await go(`${server.origin}/account`, `document.getElementById("yours")`, "Your account");
    await look("Your account (new)");
    await go(`${server.origin}/join/${code}`, `document.querySelector("#page:not([data-wait]) .lg-wrap")`, "the join link");
    await look("A join link (signed in)");

    await signInAs(ada);
    await go(inTrip("#/"), `document.querySelector("#view .ag-empty, #view .empty, #view [data-plan-add], #view h1")`, "the Itinerary");
    await look("Itinerary, nothing planned");
    await go(inTrip("#/places"), `document.querySelector("#view .pl-row")`, "Places");
    await look("Places, one place with a long name");
    await go(inTrip("#/p/long-place"), `document.querySelector("#view .pl-title h1")`, "the place");
    await look("The place with a long name");
    await go(inTrip("#/split"), `document.querySelector("#view .sp-row")`, "Split");
    await look("Split, one purchase with a long description");
    await go(inTrip("#/split/pu-long"), `document.querySelector(".sh-root[data-open='1'] .sh-sheet")`, "the purchase");
    await look("The purchase with a long description");
    await go(inTrip("#/pack"), `document.querySelector("#view .pk-own")`, "Packing");
    await look("Packing, nothing on it");
    await go(inTrip("#/memories"), `document.querySelector("#view .me-card")`, "Photos");
    await look("Photos, one memory");
    await go(inTrip("#/chat"), `document.querySelector("#view .ch-input, #view [class^='ch-']")`, "Chat");
    await look("Chat");
    await go(inTrip("#/chat/assistant"), `document.querySelector("#view .as-room")`, "the assistant");
    await look("The assistant's tab");
    await go(`${server.origin}/trips/${encodeURIComponent(trip)}`, `(document.getElementById("trip-name") || {}).textContent === ${JSON.stringify("Porto and the Douro valley in November")}`, "People and settings");
    await look("People and settings");
  }
  check("no exception reached the page", b.pageErrors.length === 0, b.pageErrors.join(" | ") || "clean");
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  if (b) await b.done();
  await server.stop().catch(() => {});
  if (TMP) try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);
