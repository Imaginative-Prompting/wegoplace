#!/usr/bin/env node
/* THE INVITE PAGE ON THE DESIGN SYSTEM (public/join.html, /join/<code>), measured against the sign-in page it leads to
 * (public/login.html), in a browser on the gate's server.
 *
 *   node scripts/gate.mjs --only join_design_check     (JOIN_SHOTS=<dir>: both states at 440 and 390, light and dark)
 *
 * The invite is the first screen someone new sees, and the sign-in page is the second: the two are one look. Each
 * component here is read from BOTH pages as computed, in light and in dark, and must be the same:
 *   1. SIGNED OUT (a name and Join): the name field is the sign-in page's name field (#join-name: size, height, corner,
 *      edge, fill, type) and at least 16 px; its label is the sign-in page's label and reads "Your name", never in
 *      capitals; Join is the sign-in page's Create account (fill, ink, height, corner, type); "Sign in" is the sign-in
 *      page's link (underlined, the sentence's ink, a 44 px tap).
 *   2. SIGNED IN ("You're signed in as …"): Join this trip is Create account; "Use a different account" is the sign-in
 *      page's Try again.
 *   3. The keyboard: the invite carries the sign-in page's keyboard script word for word (the body is one screen with
 *      its own scroller on both, and that script keeps a focused field and its button above the keys); and it preloads
 *      the fonts the sign-in page preloads (a face arriving late moves the centred line under it).
 *   4. No page error.
 * The sign-in page's make-account form shows only after a passkey sign-in came back without one: it is unhidden here
 * for the reading alone. The invite's own answer (GET /api/join/<code>) is a made-up trip given by this check through
 * CDP, so no link is made and nothing is written; Join is never pressed.
 *
 * PLANTED (JOIN_PLANT=<name>; the page served changed, never a file written):
 *   button   the Join buttons back to the old btn btn-primary: 1 and 2 red (Join, Join this trip).
 *   label    the name's field and label back to the old .field: 1 red (the label in capitals, the field and label).
 */
import fs from "node:fs";
import path from "node:path";
import { BASE, boot, evalIn, waitFor, sleep, signInAs } from "./lib/standalone_cdp.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const SHOTS = process.env.JOIN_SHOTS || "";
const PLANT = process.env.JOIN_PLANT || "";
if (PLANT && !["button", "label"].includes(PLANT)) throw new Error("JOIN_PLANT is one of button, label");

const CODE = "joinDesignCheckCode001";   // 22 characters, as a link's code is (join.js reads no other)
const VIEW = { trip: { name: "Canal week (made up)", starts_on: "2027-04-12", ends_on: "2027-04-18" }, host: { name: "Ada Reyes" } };
const plantHtml = (src) => {
  const t = PLANT === "button"
    ? src.replaceAll('class="ds-button ds-button--white ds-button--lg ds-button--block lg-go"', 'class="btn btn-primary btn-block"')
    : src.replace('<div class="ds-field">\n            <label class="ds-label" for="guest-name">', '<div class="field">\n            <label for="guest-name">')
      .replace('<input class="ds-input ds-input--lg" id="guest-name"', '<input class="input" id="guest-name"');
  if (t === src) throw new Error(`the ${PLANT} plant didn't take`);
  return t;
};

const b = await boot({ vw: 440, vh: 956, dsf: 2, reduceMotion: true });
const { cdp, S } = b;
const ev = (e) => evalIn(cdp, S, e);
const J = async (e) => JSON.parse(await ev(e));
// The invite's answer, made up; with a plant, the page itself as planted.
const pageHtml = PLANT ? plantHtml(await (await fetch(`${BASE}/join/${CODE}`)).text()) : null;
cdp.on((m) => {
  if (m.sessionId !== S || m.method !== "Fetch.requestPaused") return;
  const { requestId, request } = m.params;
  const u = new URL(request.url);
  const body = (s, type) => cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, body: Buffer.from(s).toString("base64"),
    responseHeaders: [{ name: "Content-Type", value: type }, { name: "Cache-Control", value: "no-store" }] }, S).catch(() => {});
  if (u.pathname === `/api/join/${CODE}` && request.method === "GET") return body(JSON.stringify(VIEW), "application/json");
  if (pageHtml && u.pathname === `/join/${CODE}`) return body(pageHtml, "text/html; charset=utf-8");
  cdp.send("Fetch.continueRequest", { requestId }, S).catch(() => {});
});
// Past the service worker: a request it makes is its own, and never paused here.
await cdp.send("Network.enable", {}, S);
await cdp.send("Network.setBypassServiceWorker", { bypass: true }, S);
await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*/join/${CODE}*` }] }, S);
if (PLANT) console.log(`PLANTED: ${PLANT}`);

const scheme = async (s) => { await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: s }, { name: "prefers-reduced-motion", value: "reduce" }] }, S); await sleep(400); };
const signOut = async () => { for (const name of ["s2", "wgp_session", "wgp_who"]) await cdp.send("Network.deleteCookies", { name, url: BASE }, S); };
const open = async (p, ready, label) => {
  await cdp.send("Page.navigate", { url: `${BASE}${p}` }, S);
  await waitFor(cdp, S, ready, { label, timeout: 20000 }).catch(async (e) => {
    const seen = await ev(`JSON.stringify({ at: location.pathname, panels: [...document.querySelectorAll("section, .lg-stack, main")].filter((n) => !n.hidden).map((n) => n.id || n.className), text: document.body.innerText.replace(/\\s+/g, " ").slice(0, 300) })`).catch(() => "?");
    throw new Error(`${e.message}; the page showed ${seen}`);
  });
  await sleep(600);
};
// What a component is, as drawn: the properties that make its look.
const LOOK = {
  field: ["font-size", "font-family", "height", "border-top-left-radius", "border-top-width", "border-top-color", "background-color", "color", "padding-left"],
  label: ["font-size", "font-family", "font-weight", "letter-spacing", "text-transform", "color"],
  button: ["font-size", "font-family", "font-weight", "height", "border-top-left-radius", "border-top-width", "border-top-color", "background-color", "color"],
  link: ["font-weight", "text-decoration-line", "text-underline-offset", "color"],
};
const read = (map) => J(`JSON.stringify(Object.fromEntries(Object.entries(${JSON.stringify(map)}).map(([k, [sel, kind]]) => {
  const n = document.querySelector(sel); if (!n) return [k, null];
  const cs = getComputedStyle(n); const r = n.getBoundingClientRect();
  return [k, { ...Object.fromEntries(${JSON.stringify(LOOK)}[kind].map((p) => [p, cs.getPropertyValue(p)])), text: n.textContent.trim(), tapH: Math.round(r.height), shown: !!r.height }]; })))`);
const diff = (a, c) => !a || !c ? ["missing"] : Object.keys(a).filter((k) => !["text", "tapH", "shown"].includes(k) && a[k] !== c[k]).map((k) => `${k}: ${a[k]} vs ${c[k]}`);
// The sign-in page's, signed out, its make-account form unhidden for the reading.
const SIGNIN = { field: ["#join-name", "field"], label: ['label[for="join-name"]', "label"], go: ["#btn-join", "button"], fade: ["#btn-signin-again", "button"], link: [".lg-fine a", "link"] };
const VISITOR = { field: ["#guest-name", "field"], label: ['label[for="guest-name"]', "label"], go: ["#btn-guest", "button"], link: ["#go-signin", "link"] };
const ACCOUNT = { go: ["#btn-join", "button"], fade: ["#btn-other", "button"] };
async function stills(state) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of [[440, 956], [390, 844]]) {
    await b.metrics(w, h);
    for (const s of ["light", "dark"]) { await scheme(s); await b.shot(path.join(SHOTS, `join-${state}-${w}-${s}${PLANT ? `-planted-${PLANT}` : ""}.png`)); }
  }
  await b.metrics(440, 956);
}

try {
  await b.setInsets({ top: 59, right: 0, bottom: 34, left: 0 });
  const ref = {};
  await signOut();
  await open("/login", `document.getElementById("btn-signin")?.getBoundingClientRect().height ? 1 : 0`, "the sign-in page");
  await ev(`(document.getElementById("signin-make").hidden = false, 1)`);
  for (const s of ["light", "dark"]) { await scheme(s); ref[s] = await read(SIGNIN); }

  section("1. Signed out: the name, Join and Sign in are the sign-in page's");
  await open(`/join/${CODE}`, `(() => { const v = document.getElementById("as-visitor"); return v && !v.hidden && v.getBoundingClientRect().height ? 1 : 0; })()`, "the invite, signed out");
  for (const s of ["light", "dark"]) {
    await scheme(s);
    const got = await read(VISITOR);
    check(`${s}: the name field is the sign-in page's`, diff(got.field, ref[s].field).length === 0, diff(got.field, ref[s].field).join("; ") || got.field?.height);
    check(`${s}: its label is the sign-in page's`, diff(got.label, ref[s].label).length === 0, diff(got.label, ref[s].label).join("; "));
    check(`${s}: Join is the sign-in page's Create account`, diff(got.go, ref[s].go).length === 0, diff(got.go, ref[s].go).join("; ") || got.go?.["background-color"]);
    check(`${s}: "Sign in" is the sign-in page's link, a 44 px tap`, diff(got.link, ref[s].link).length === 0 && got.link?.tapH >= 44, `${diff(got.link, ref[s].link).join("; ")} tap ${got.link?.tapH}`);
    if (s === "light") {
      check(`the label reads "Your name", not in capitals`, got.label?.text === "Your name" && got.label?.["text-transform"] === "none", JSON.stringify([got.label?.text, got.label?.["text-transform"]]));
      check("the name field is at least 16 px", parseFloat(got.field?.["font-size"]) >= 16, got.field?.["font-size"]);
    }
  }
  await stills("signed-out");

  section("2. Signed in: Join this trip and Use a different account are the sign-in page's");
  await signInAs(cdp, S);
  await open(`/join/${CODE}`, `(() => { const v = document.getElementById("as-account"); return v && !v.hidden && v.getBoundingClientRect().height ? 1 : 0; })()`, "the invite, signed in");
  for (const s of ["light", "dark"]) {
    await scheme(s);
    const got = await read(ACCOUNT);
    check(`${s}: Join this trip is the sign-in page's Create account`, diff(got.go, ref[s].go).length === 0 && got.go?.text === "Join this trip", diff(got.go, ref[s].go).join("; ") || got.go?.text);
    check(`${s}: Use a different account is the sign-in page's Try again`, diff(got.fade, ref[s].fade).length === 0, diff(got.fade, ref[s].fade).join("; "));
  }
  await stills("signed-in");

  section("3. The keyboard script and the fonts are the sign-in page's");
  const kb = (file) => { const t = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8"); const a = t.indexOf("// The keyboard. The body is 100dvh"); return a < 0 ? "" : t.slice(a, t.indexOf("</script>", a)); };
  check("join.html's keyboard script is login.html's", kb("join.html") !== "" && kb("join.html") === kb("login.html"), `${kb("join.html").length} vs ${kb("login.html").length} characters`);
  // The fonts it draws in come before its first paint, as the sign-in page's do: a face that arrives late moves the
  // centred line under it ("Sign in", half a pixel), and the page no longer appears once (checks/accounts/browser.mjs).
  const preloads = (file) => [...fs.readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8").matchAll(/<link rel="preload" href="([^"]+)" as="font"/g)].map((m) => m[1]).sort();
  check("join.html preloads the fonts login.html preloads", JSON.stringify(preloads("join.html")) === JSON.stringify(preloads("login.html")), `${preloads("join.html")} vs ${preloads("login.html")}`);

  section("4. No page errors");
  check("nothing thrown", b.pageErrors.length === 0, b.pageErrors.join(" | ").slice(0, 400));
} catch (e) {
  fail++; failures.push(`stopped: ${e.message}`);
  console.log(`  FAIL  stopped: ${e.stack || e}`);
} finally {
  await b.done().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }
