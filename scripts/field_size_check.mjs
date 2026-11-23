#!/usr/bin/env node
/* NO FIELD ZOOMS THE PAGE. iOS zooms into any focused field whose text is under 16px and doesn't zoom back, which breaks
 * an installed app (22 Nov: the quick reference's form zoomed in after a tap on Add, on a phone). The rule is
 * WebKit's own and exact: the field's COMPUTED font-size, at least 16px. WebKit itself can't run here, so this holds the
 * number it reads, on every field the app shows.
 *
 *   node scripts/gate.mjs --only field_size_check
 *
 * It walks every screen and sheet that has a field, as a person reaches it on the gate's made-up trip (as its host):
 * the Itinerary's + and a plan's Change (the plan editor), Places' + and a place's Change (the place editor), Packing's
 * +, Split's + and a purchase, the chat's box and the assistant's, the quick reference's form, More's Report a bug;
 * Your account, Your trips with Make a trip, People and settings, a join link's page, Report a bug's own page; and,
 * signed out, the sign-in page. Each step must show at least one field (so it reached what it is for), and every
 * input, textarea and select it shows (not hidden, not a checkbox, radio, file or button) is held to 16px or more.
 *
 * PLANTED (FIELD_PLANT=small): the design system's field rule (ds/controls.css) served at 14px again: red at every
 * design-system field.
 */
import fs from "node:fs";
import { BASE, boot, evalIn, waitFor, sleep, appSettled } from "./lib/standalone_cdp.mjs";
import { tripPath, TRIP } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const PLANT = process.env.FIELD_PLANT || "";
if (PLANT && PLANT !== "small") throw new Error("FIELD_PLANT is small");
const PLANTED = PLANT ? (() => {
  const src = read("public/ds/controls.css");
  const t = src.replace("  font-size: var(--size-16);\n  line-height: 22px;", "  font-size: var(--size-14);\n  line-height: 20px;");
  if (t === src) throw new Error("the small plant didn't take");
  return t;
})() : null;

const b = await boot({ vw: 440, vh: 956, dsf: 2, reduceMotion: true });
const { cdp, S } = b;
// A join link's page, without making a link (a row the trip would keep): its one read, GET /api/join/<code>, is answered
// here with a made-up trip, the shape src/trips/links.js viewJoin gives. And, planted, ds/controls.css at 14px.
const JOIN_CODE = "fieldSizeCheckCode0000"; // the 22 url-safe characters a code is (join.js, links.js CODE_RE)
const JOIN_VIEW = { trip: { name: "Coast week", starts_on: null, ends_on: null }, host: { name: "Mara Voss" } };
cdp.on((m) => {
  if (m.sessionId !== S || m.method !== "Fetch.requestPaused") return;
  const css = m.params.request.url.includes("/ds/controls.css");
  const body = css ? PLANTED : JSON.stringify(JOIN_VIEW);
  cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: css ? "text/css; charset=utf-8" : "application/json" }, { name: "Cache-Control", value: "no-store" }],
    body: Buffer.from(body).toString("base64") }, S).catch(() => {});
});
await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*/api/join/${JOIN_CODE}`, requestStage: "Request" },
  ...(PLANTED ? [{ urlPattern: "*/ds/controls.css*" }] : [])] }, S);
if (PLANTED) console.log("PLANTED: small (ds/controls.css at 14px)");
const ev = (e) => evalIn(cdp, S, e);
const J = async (e) => JSON.parse(await ev(e));

// Every field a person could focus: shown, and of a kind that takes typing or a choice.
const FIELDS = `JSON.stringify([...document.querySelectorAll("input, textarea, select")].filter((n) => {
  const t = (n.getAttribute("type") || "").toLowerCase();
  if (["hidden", "checkbox", "radio", "file", "range", "submit", "button", "color", "image", "reset"].includes(t)) return false;
  return n.getClientRects().length > 0 && getComputedStyle(n).visibility !== "hidden";
}).map((n) => ({ f: n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (n.getAttribute("name") ? "[" + n.getAttribute("name") + "]" : "") + (n.className ? "." + String(n.className).trim().split(/\\s+/)[0] : ""),
  px: parseFloat(getComputedStyle(n).fontSize) })))`;

async function visit(url, ready) {
  await cdp.send("Page.navigate", { url: "about:blank" }, S);
  await sleep(150);
  await cdp.send("Page.navigate", { url }, S);
  await appSettled(cdp, S).catch(() => {});
  if (ready) await waitFor(cdp, S, ready, { label: url, timeout: 20000 }).catch(() => {});
  await sleep(700);
}
async function press(selector) {
  await waitFor(cdp, S, `(() => { const n = document.querySelector(${JSON.stringify(selector)}); return n && n.getClientRects().length && !n.disabled ? 1 : 0; })()`, { label: selector, timeout: 12000 });
  await ev(`(document.querySelector(${JSON.stringify(selector)}).click(), 1)`);
  await sleep(900);
}
async function step(name, url, { ready = null, open = [] } = {}) {
  try {
    await visit(url, ready);
    for (const sel of open) await press(sel);
    const fields = await J(FIELDS);
    const small = fields.filter((x) => !(x.px >= 16));
    check(`${name}: ${fields.length} field${fields.length === 1 ? "" : "s"}, each 16px or more`, fields.length > 0 && small.length === 0,
      small.length ? `under 16px: ${small.map((x) => `${x.f} ${x.px}px`).join(", ")}` : fields.length ? fields.map((x) => `${x.f} ${x.px}`).join(", ") : "no field reached");
  } catch (e) {
    check(`${name}: reached`, false, e.message);
  }
}

try {
  section("In the trip, as its host");
  const T = (hash) => `${BASE}${tripPath(hash)}`;
  await visit(T("#/"), `document.querySelector("#view") ? 1 : 0`);
  const ids = await J(`import("/js/store.js").then(({ store }) => JSON.stringify({ e: store.events()[0]?.id, p: store.places()[0]?.id, s: store.purchases().find((x) => x.kind !== "payment")?.id ?? store.purchases()[0]?.id }))`);
  const FAB = ".fab.ds-fab:not([hidden])";
  await step("the Itinerary's + (a plan's editor)", T("#/"), { open: [FAB] });
  await step("a plan's Change (the plan editor)", T(`#/e/${encodeURIComponent(ids.e)}`), { open: ["[data-plan-change]"] });
  await step("Places' + (a place's editor)", T("#/places"), { open: [FAB] });
  await step("a place's Change (the place editor)", T(`#/p/${encodeURIComponent(ids.p)}`), { open: ['[data-act="change"]'] });
  await step("Packing's + (an item's editor)", T("#/pack"), { open: [FAB] });
  await step("Split's + (a purchase's editor)", T("#/split"), { open: [FAB] });
  await step("a purchase's page", T(`#/split/${encodeURIComponent(ids.s)}`), { ready: `document.querySelector(".sh-root[data-open='1']") ? 1 : 0` });
  await step("the chat's box", T("#/chat"), { ready: `document.querySelector(".ch-input") ? 1 : 0` });
  // The assistant's box is the chat's own (.ch-input, above) and is drawn only where the site offers the assistant;
  // the gate's site doesn't.
  if (await ev(`document.querySelector('.ch-tabs a[href="#/chat/assistant"]') ? 1 : 0`)) {
    await step("the assistant's box", T("#/chat/assistant"), { ready: `document.querySelector("#as-input") ? 1 : 0` });
  } else console.log("  (the assistant isn't offered on this site: its box, the chat's own field, is held above)");
  await step("the quick reference's form", T("#/"), { open: [".rf-fab", ".rf-add"] });
  await step("More › Report a bug", T("#/settings"), { open: ["#st-report"] });

  section("The pages of their own");
  await step("Your account", `${BASE}/account`, { ready: `document.querySelector("#name") ? 1 : 0` });
  // With trips, Make a trip's form waits behind its button: pressed.
  await step("Your trips, Make a trip", `${BASE}/trips`, { ready: `document.querySelector("#make-open") ? 1 : 0`, open: ["#make-open"] });
  await step("People and settings", `${BASE}/trips/${encodeURIComponent(TRIP)}`, { ready: `document.querySelector("input, textarea, select") ? 1 : 0` });
  await step("Report a bug's own page", `${BASE}/report`, { ready: `document.querySelector("#rb-text") ? 1 : 0` });

  section("Signed out");
  for (const name of ["s2", "wgp_session", "wgp_who"]) await cdp.send("Network.deleteCookies", { name, url: BASE }, S);
  await step("the sign-in page, Trouble signing in? opened", `${BASE}/login`, { ready: `document.querySelector("#trouble summary") ? 1 : 0`, open: ["#trouble summary"] });
  await step("a join link's page (a guest's name)", `${BASE}/join/${JOIN_CODE}`, { ready: `document.getElementById("page") && !document.getElementById("page").hasAttribute("data-wait") ? 1 : 0` });

  section("No page errors");
  check("nothing thrown", b.pageErrors.length === 0, b.pageErrors.join(" | ").slice(0, 400));
} catch (e) {
  fail++; failures.push(`stopped: ${e.message}`);
  console.log(`  FAIL  stopped: ${e.stack || e}`);
} finally {
  await b.done().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }
