#!/usr/bin/env node
/* The picture someone draws, from the pad to every face, in a browser on the gate's made-up trip.
 *
 *   node scripts/gate.mjs --only picture_places_check
 *
 * It holds:
 *   0. DRAW NOTHING AND NOTHING CHANGES: with nobody's picture, the chat, Photos, More, the trip's people and Your
 *      account draw no picture holder anywhere and ask for no picture.
 *   1. A PICTURE SHOWS WHERE THE PERSON SHOWS: the host draws one (through the same route the pad uses), and another
 *      person on the trip sees it in the host's place in the chat and on the trip's people, fetched once and kept.
 *   2. THE PAD DRAWS WHAT IS STORED: Your account's face carries it; the pad opens with it, and its canvas is the
 *      stored picture (under 1% of the circle's pixels differ by more than 40 of 255).
 *   3. SAVE KEEPS IT: a stroke added and Save pressed, the circle travels up into the face, the face has
 *      the new picture (one stroke more), and a fresh load still has it.
 *   4. REDUCED MOTION: another color and Save, and nothing travels.
 *   6. NOTHING MOVES UNDER A FINGER: on an empty pad (the initials field showing), the canvas's box is the same before
 *      the first stroke and after it ends (22 Nov: the field went, the sheet held at the bottom got shorter, and the
 *      pad dropped about 60 px, so a stroke begun during the jump landed off).
 *   5. BACK TO INITIALS: the pad's sheet takes its first focus on something that keeps, and Back to initials (it takes
 *      the stored picture away at once) is marked as destroying; then the face is the initials again, /api/me has no
 *      picture, and your own picture at the top right of the app is the initials too.
 *   1c. BYTES THAT AREN'T A PICTURE ARE ASKED FOR ONCE: a hash whose answer is not a picture (served by this check)
 *      gives the initials, and asking for it three times (two at once, one after) makes one request.
 *   1b. KEPT ONLY FOR WHO MAY SEE IT: with the host's picture kept on the phone for another person on the trip, a
 *      stranger (an account on no trip with the host, signed up for this) who signs in on the same phone asks the
 *      server, is refused (404), and gets no picture; and after that person signs out (the app's own sign-out), the
 *      phone keeps no picture at all. The stranger's account is deleted at the end.
 * The host's picture is taken away at the end whatever happened (DELETE /api/me/avatar), and the one message this
 * check writes in the trip's chat as the host (so the host shows there) is removed by its id.
 *
 * PLANTED (PICS_PLANT=<name>, served in place of the file named):
 *   noload  js/pictures.js answering every hash with nothing: 1, 2 and 3 red.
 *   anyone  js/pictures.js keeping a picture for everyone on the phone, not for who was let see it: 1b red.
 *   nohold  js/chat.js drawing a square with no holder for a picture: 1 red (the chat).
 *   rerequest  js/pictures.js not remembering bytes that aren't a picture: 1c red (asked again).
 *   sheetdrag  js/sheet.js taking a stroke on the pad for a pull on the sheet: 3 red (the stroke lost, nothing new saved).
 *   jump    ds/pad.js taking the initials field out of the sheet when the first stroke ends (as it did): 6 red.
 */
import { BASE, boot, evalIn, waitFor, sleep, appSettled, signInAs } from "./lib/standalone_cdp.mjs";
import { tripPath, tripApi, TRIP, HOST, PEOPLE, ORIGIN, d1 } from "./lib/gate_trip.mjs";
import { Person } from "../checks/lib/person.mjs";
import { Passkey } from "../checks/parity/lib.mjs";
import fs from "node:fs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

const PLANT = process.env.PICS_PLANT || "";
if (PLANT && !["noload", "nohold", "anyone", "rerequest", "sheetdrag", "jump"].includes(PLANT)) throw new Error(`no such plant: ${PLANT}`);
const PLANTED_FILE = PLANT === "noload" || PLANT === "anyone" || PLANT === "rerequest" ? "js/pictures.js" : PLANT === "sheetdrag" ? "js/sheet.js" : PLANT === "jump" ? "ds/pad.js" : "js/chat.js";
const PLANTED = PLANT ? (() => {
  const src = fs.readFileSync(new URL(`../public/${PLANTED_FILE}`, import.meta.url), "utf8");
  const t = PLANT === "noload"
    ? src.replace("export function pictureOf(hash) {", "export function pictureOf(hash) {\n  return Promise.resolve(null);")
    : PLANT === "jump" ? src.replace('    initRow.toggleAttribute("data-away", !empty);\n    initRow.inert = !empty;\n', "    initRow.hidden = !empty;\n")
    : PLANT === "sheetdrag" ? src.replace('    if (at.closest("[data-own-gesture]")) return;\n', "")
    : PLANT === "rerequest" ? src.replace("          else { known.set(h, null); bytes = null; }\n", "          else bytes = null;\n")
    : PLANT === "anyone" ? src.replace("const keptAt = (hash) => { const who = sessionAccount(); return who ? `${address(hash)}?for=${encodeURIComponent(who)}` : null; };", "const keptAt = (hash) => address(hash);")
    : src.replace("esc(s.initials) + pictureHolder(s.pic)", "esc(s.initials)");
  if (t === src) throw new Error(`the ${PLANT} plant didn't take`);
  return t;
})() : null;

const B = PEOPLE.find((p) => !p.host);
const MSG = `pic-check-${Date.now().toString(36)}`;     // the one message this check writes, removed by id at the end
const b = await boot({ vw: 390, vh: 844, dsf: 2, reduceMotion: false });
const { cdp, S } = b;
const J = async (e) => JSON.parse(await evalIn(cdp, S, e));
const asked = [], answered = [];
cdp.on((m) => {
  if (m.sessionId !== S) return;
  try {
    if (m.method === "Network.requestWillBeSent") asked.push(new URL(m.params.request.url).pathname);
    if (m.method === "Network.responseReceived") answered.push([new URL(m.params.response.url).pathname, m.params.response.status]);
  } catch {}
});
let stranger = null;
// A hash whose answer this check serves as bytes that aren't a picture (1c), beside the planted file if any.
const JUNK = "junkjunkjunk";
cdp.on((m) => {
  if (m.sessionId !== S || m.method !== "Fetch.requestPaused") return;
  const junk = m.params.request.url.includes(`/api/avatars/${JUNK}`);
  cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: junk ? "application/octet-stream" : "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }],
    body: junk ? Buffer.from("not a picture at all").toString("base64") : Buffer.from(PLANTED).toString("base64") }, S).catch(() => {});
});
await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*/api/avatars/${JUNK}*` }, ...(PLANTED ? [{ urlPattern: `*/${PLANTED_FILE}*` }] : [])] }, S);
const open = async (url, mark, label) => {
  await cdp.send("Page.navigate", { url: `${BASE}${url}` }, S);
  if (url.startsWith("/t/")) await appSettled(cdp, S);
  await waitFor(cdp, S, `${mark} ? 1 : 0`, { label, timeout: 30000 });
  await sleep(900);
};
const SCREENS = [
  [tripPath("#/chat"), `document.querySelector("#view .ch-msg")`, "the chat"],
  [tripPath("#/memories"), `document.querySelector("#view .me-card, #view .me-byline, #view .empty")`, "Photos"],
  [tripPath("#/settings"), `document.querySelector("#view #st-sections")`, "More"],
  [`/trips/${encodeURIComponent(TRIP)}`, `document.querySelector("#people .ac-way")`, "the trip's people"],
  ["/account", `!document.getElementById("account").hidden`, "Your account"],
];
// A picture of the host's, made up: a line and a dot in the ocean palette.
const D1 = { palette: 3, strokes: [{ ink: 0, brush: 52, pts: [[60, 140], [100, 90], [150, 100], [200, 150]] }, { ink: 1, brush: 110, pts: [[128, 70]] }] };
const put = (d) => J(`(async () => { const F = await import("/js/shared/avatar.js"); const bytes = F.encode(${JSON.stringify(d)});
  const r = await fetch("/api/me/avatar", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ drawing: F.toB64url(bytes) }) });
  return JSON.stringify({ status: r.status, me: r.ok ? (await r.json()).me : null }); })()`);
const takeAway = () => evalIn(cdp, S, `fetch("/api/me/avatar", { method: "DELETE", credentials: "same-origin" }).then((r) => r.status, () => 0)`);
const meNow = () => J(`fetch("/api/me", { credentials: "same-origin", cache: "no-store" }).then((r) => r.json()).then((m) => JSON.stringify(m.me || m))`);

try {
  await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });

  section("0. Draw nothing and nothing changes");
  {
    await open(tripPath("#/"), `document.querySelector("#view")`, "the app");
    await takeAway();                                  // the made-up trip's host starts with no picture
    // The host in the chat: one message of this check's own, through the chat's own route.
    const said = await J(`fetch(${JSON.stringify(tripApi("/messages"))}, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: ${JSON.stringify(MSG)}, body: "A made-up line, so the host shows in the chat." }) }).then((r) => JSON.stringify({ status: r.status }))`);
    if (said.status < 200 || said.status > 299) throw new Error(`the host's message was refused: ${said.status}`);
    asked.length = 0;
    const holders = [];
    for (const [url, mark, label] of SCREENS) {
      await open(url, mark, label);
      const n = await evalIn(cdp, S, `document.querySelectorAll(".ds-face-pic, [data-drawn]").length`);
      if (n) holders.push(`${label}: ${n}`);
    }
    check("with nobody's picture, no screen draws a picture holder", !holders.length, holders.join(", ") || `${SCREENS.length} screens`);
    const pics = asked.filter((p) => p.startsWith("/api/avatars"));
    check("and nothing asks for a picture", !pics.length, pics.join(", "));
  }

  section("1. A picture shows where the person shows");
  const first = await put(D1);
  const hash1 = first.me && first.me.avatar;
  check("the host's picture is taken (PUT /api/me/avatar) and named by a hash", first.status === 200 && /^[A-Za-z0-9_-]{12}$/.test(hash1 || ""), JSON.stringify(first).slice(0, 200));
  await signInAs(cdp, S, B.key);
  asked.length = 0;
  {
    await open(tripPath("#/chat"), `document.querySelector("#view .ch-msg")`, "the chat as another person");
    await sleep(800);
    const chat = await J(`JSON.stringify((() => { const host = ${JSON.stringify(HOST.name)};
      const theirs = [...document.querySelectorAll("#view .ch-msg")].filter((li) => (li.querySelector(".ch-name") || {}).textContent === host);
      const marks = theirs.map((li) => li.querySelector(".ch-sq")).filter(Boolean);
      return { theirs: theirs.length, marks: marks.length, drawn: marks.filter((m) => m.querySelector(".ds-face-pic[data-ready] svg path")).length,
        others: [...document.querySelectorAll("#view .ch-msg")].filter((li) => !theirs.includes(li) && li.querySelector(".ds-face-pic")).length }; })())`);
    check(`in the chat, the host's squares carry the host's picture (${chat.marks} of the host's ${chat.theirs} messages with a square), and nobody else's do`,
      chat.marks > 0 && chat.drawn === chat.marks && chat.others === 0, JSON.stringify(chat));
    await open(`/trips/${encodeURIComponent(TRIP)}`, `document.querySelector("#people .ac-way")`, "the trip's people as another person");
    await sleep(800);
    const people = await J(`JSON.stringify([...document.querySelectorAll("#people .ac-way")].map((row) => ({ name: (row.querySelector(".ac-way-label") || {}).textContent,
      drawn: !!row.querySelector(".tp-face .ds-face-pic[data-ready] svg path") })))`);
    const hostRow = people.find((p) => p.name === HOST.name);
    check("on the trip's people, the host's dot is the picture, and no one else's", !!hostRow && hostRow.drawn && people.filter((p) => p.drawn).length === 1, JSON.stringify(people));
    const fetched = asked.filter((p) => p === `/api/avatars/${hash1}`);
    check("the picture was fetched by its hash at most once a page, never anyone else's", fetched.length >= 1 && fetched.length <= 2 && asked.filter((p) => p.startsWith("/api/avatars/") && p !== `/api/avatars/${hash1}`).length === 0,
      `${fetched.length} of /api/avatars/${hash1}`);
  }

  section("1c. Bytes that aren't a picture are asked for once");
  {
    asked.length = 0;
    const got = await J(`(async () => { const P = await import("/js/pictures.js");
      const two = await Promise.all([P.pictureOf("${JUNK}"), P.pictureOf("${JUNK}")]); const third = await P.pictureOf("${JUNK}");
      return JSON.stringify({ pictures: [...two, third].filter(Boolean).length, holder: P.pictureHolder("${JUNK}") }); })()`);
    const n = asked.filter((p) => p === `/api/avatars/${JUNK}`).length;
    check("a hash answered with bytes that aren't a picture gives the initials, and three asks make one request", got.pictures === 0 && got.holder === "" && n === 1, `${JSON.stringify(got)}, ${n} request(s)`);
  }

  section("1b. Kept only for who may see it");
  {
    // The host's picture is kept on this phone for B (section 1). A stranger signs in on the same phone.
    const keptForB = await evalIn(cdp, S, `caches.open("wegoplace-pictures-v1").then((c) => c.keys()).then((k) => k.length, () => -1)`);
    stranger = new Person(ORIGIN, "Sol Vey");
    // A passkey of its own: the shared counter's first ids (check-passkey-1, …) are already the made-up trip's people's.
    const made = await stranger.signUp(Passkey.fresh(`${MSG}-stranger`));
    if (made.status !== 200) throw new Error(`the stranger couldn't sign up: ${made.status}`);
    for (const name of ["s2", "wgp_session", "wgp_who"]) await cdp.send("Network.deleteCookies", { name, url: BASE }, S);
    for (const [name, value] of stranger.jar.cookies) await cdp.send("Network.setCookie", { url: ORIGIN, name, value, ...(name === "wgp_session" ? { httpOnly: true } : {}), sameSite: "Lax" }, S);
    await open("/account", `!document.getElementById("account").hidden`, "the stranger's account");
    answered.length = 0;
    const got = await J(`(async () => { const P = await import("/js/pictures.js"); return JSON.stringify({ drawn: !!(await P.pictureOf(${JSON.stringify(hash1)})) }); })()`);
    const refused = answered.filter(([p]) => p === `/api/avatars/${hash1}`).map(([, st]) => st);
    check(`a stranger on the same phone (${keptForB} kept for the other person) asks the server, is refused, and gets no picture`, keptForB >= 1 && !got.drawn && refused.length === 1 && refused[0] === 404,
      JSON.stringify({ keptForB, got, refused }));
    // B again, the picture kept again, then signed out by the app's own sign-out.
    await signInAs(cdp, S, B.key);
    await open(tripPath("#/chat"), `document.querySelector("#view .ch-msg")`, "the chat as the other person again");
    await sleep(1200);
    const keptAgain = await evalIn(cdp, S, `caches.open("wegoplace-pictures-v1").then((c) => c.keys()).then((k) => k.length, () => -1)`);
    await evalIn(cdp, S, `import("/js/auth.js").then((m) => m.signOut()).then(() => 1, () => 0)`);
    await sleep(500);
    const left = await evalIn(cdp, S, `caches.keys().then((names) => names.includes("wegoplace-pictures-v1") ? caches.open("wegoplace-pictures-v1").then((c) => c.keys()).then((k) => k.length) : 0)`);
    check(`signed out, the phone keeps no picture (${keptAgain} kept before)`, keptAgain >= 1 && left === 0, `${keptAgain} → ${left}`);
    // Then off the trip's page: signed out, its own reads go on against a session that is gone, and whatever they do
    // must not land on the next page this check opens.
    await cdp.send("Page.navigate", { url: "about:blank" }, S);
    await sleep(300);
  }

  section("2. The pad draws what is stored");
  await signInAs(cdp, S, HOST.key);
  await open("/account", `!document.getElementById("account").hidden`, "Your account");
  await waitFor(cdp, S, `document.querySelector("#picture [data-pic-face] .ds-face[data-drawn] svg") ? 1 : 0`, { label: "the face's picture", timeout: 15000 }).catch(() => {});
  const card = await J(`JSON.stringify({ drawn: !!document.querySelector("#picture [data-pic-face] .ds-face[data-drawn] svg"),
    paths: document.querySelectorAll("#picture [data-pic-face] svg path").length, button: document.querySelector("#picture [data-pic-open]").textContent.trim() })`);
  check("Your account's face is the picture, with its two strokes, and the button says Change your picture", card.drawn && card.paths === 2 && card.button === "Change your picture", JSON.stringify(card));
  await evalIn(cdp, S, `(document.querySelector("#picture [data-pic-open]").click(), 1)`);
  await waitFor(cdp, S, `document.querySelector(".sh-root[data-open='1'] .ds-pad canvas") ? 1 : 0`, { label: "the pad", timeout: 15000 });
  await sleep(700);
  const PAD = `document.querySelector(".sh-root[data-open='1'] .ds-pad")`;
  const cmp = await J(`(async () => {
    const cv = ${PAD}.querySelector("canvas"), n = cv.width;
    const face = document.querySelector("#picture [data-pic-face] svg");
    if (!face || !n) return JSON.stringify({ n, face: !!face, share: 1 });
    // A picture's markup names its colours as the face's variables, which an image doesn't have: put in as the face
    // computes them (its owner's color, and the initials' ink on it).
    const cs = getComputedStyle(face.closest(".ds-face"));
    const svg = face.outerHTML.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" width="' + n + '" height="' + n + '" ')
      .replace(/var\\(--ds-pic-ground[^"]*\\)/g, cs.getPropertyValue("--ds-pic-ground").trim())
      .replace(/var\\(--ds-pic-ink[^"]*\\)/g, cs.getPropertyValue("--ds-pic-ink").trim());
    const img = new Image(); img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg); await img.decode();
    const c = document.createElement("canvas"); c.width = c.height = n; const x = c.getContext("2d");
    x.beginPath(); x.arc(n / 2, n / 2, n / 2, 0, Math.PI * 2); x.clip(); x.drawImage(img, 0, 0, n, n);
    const a = x.getImageData(0, 0, n, n).data, b = cv.getContext("2d").getImageData(0, 0, n, n).data;
    let inside = 0, off = 0; const r = n / 2 - 2;
    for (let y = 0; y < n; y++) for (let x2 = 0; x2 < n; x2++) {
      if ((x2 - n / 2 + 0.5) ** 2 + (y - n / 2 + 0.5) ** 2 > r * r) continue;
      inside++; const i = (y * n + x2) * 4;
      if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 40) off++;
    }
    return JSON.stringify({ n, inside, off, share: off / inside });
  })()`);
  check("the pad opens with the stored picture: its canvas and the face differ in under 1% of the circle", cmp.share < 0.01, JSON.stringify(cmp));

  section("3. Save keeps it");
  {
    // The pad in view (on a phone the sheet scrolls), and settled, before a finger goes on it.
    await evalIn(cdp, S, `(${PAD}.querySelector("canvas").scrollIntoView({ block: "center" }), 1)`);
    await sleep(500);
    const rect = await J(`JSON.stringify(${PAD}.querySelector("canvas").getBoundingClientRect())`);
    const under = await evalIn(cdp, S, `(() => { const c = ${PAD}.querySelector("canvas"), r = c.getBoundingClientRect(), e = document.elementFromPoint(r.left + r.width * 0.3, r.top + r.height * 0.7);
      return e === c ? "the pad" : (e ? e.tagName + "." + e.className : "nothing"); })()`);
    if (under !== "the pad") throw new Error(`a finger on the pad would land on ${under}, not the pad (${JSON.stringify(rect)})`);
    await evalIn(cdp, S, `(window.__flew = [], new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList && n.classList.contains("ac-pic-fly")) window.__flew.push(1); }).observe(document.body, { childList: true }), 1)`);
    const pts = Array.from({ length: 16 }, (_, i) => [0.3 + i * 0.025, 0.7 - Math.sin(i / 5) * 0.1]);
    const at = ([u, v]) => ({ x: rect.x + u * rect.width, y: rect.y + v * rect.height });
    const [p0, ...rest] = pts.map(at);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p0.x, y: p0.y }, S);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p0.x, y: p0.y, button: "left", buttons: 1, clickCount: 1 }, S);
    for (const p of rest) { await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "left", buttons: 1 }, S); await sleep(10); }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rest[rest.length - 1].x, y: rest[rest.length - 1].y, button: "left", buttons: 0, clickCount: 1 }, S);
    await sleep(200);
    await evalIn(cdp, S, `(${PAD}.querySelector("[data-pad-save]").click(), 1)`);
    await waitFor(cdp, S, `!document.querySelector(".sh-root[data-open='1']") && !document.querySelector(".ac-pic-fly") ? 1 : 0`, { label: "the sheet gone and the circle landed", timeout: 15000 });
    await sleep(400);
    const after = await J(`JSON.stringify({ paths: document.querySelectorAll("#picture [data-pic-face] .ds-face[data-drawn] svg path").length, flew: window.__flew.length,
      said: (document.querySelector("#picture [data-pic-msg] span") || {}).textContent || "" })`);
    const me2 = await meNow();
    check("Save: the circle travels up into the face, which has the picture with one stroke more", after.paths === 3 && after.flew === 1 && /Saved/.test(after.said), JSON.stringify(after));
    check("the stored picture is the new one (a new hash on /api/me)", !!me2.avatar && me2.avatar !== hash1, `${hash1} → ${me2.avatar}`);
    await open("/account", `!document.getElementById("account").hidden`, "Your account again");
    await waitFor(cdp, S, `document.querySelector("#picture [data-pic-face] .ds-face[data-drawn] svg") ? 1 : 0`, { label: "the face after a reload", timeout: 15000 }).catch(() => {});
    const again = await evalIn(cdp, S, `document.querySelectorAll("#picture [data-pic-face] .ds-face[data-drawn] svg path").length`);
    check("a fresh load of Your account has it (three strokes)", again === 3, `${again} paths`);
  }

  section("4. Reduced motion");
  {
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, S);
    await evalIn(cdp, S, `(window.__flew = [], new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList && n.classList.contains("ac-pic-fly")) window.__flew.push(1); }).observe(document.body, { childList: true }), 1)`);
    await evalIn(cdp, S, `(document.querySelector("#picture [data-pic-open]").click(), 1)`);
    await waitFor(cdp, S, `document.querySelector(".sh-root[data-open='1'] .ds-pad canvas") ? 1 : 0`, { label: "the pad", timeout: 15000 });
    await sleep(400);
    // Save waits for a change: another color, then Save.
    await evalIn(cdp, S, `(() => { const b = [...${PAD}.querySelectorAll("[data-pad-color]")].find((x) => x.getAttribute("aria-checked") !== "true"); b.click(); return 1; })()`);
    await evalIn(cdp, S, `(${PAD}.querySelector("[data-pad-save]").click(), 1)`);
    await waitFor(cdp, S, `!document.querySelector(".sh-root[data-open='1']") ? 1 : 0`, { label: "the sheet gone", timeout: 15000 });
    await sleep(500);
    check("with reduced motion nothing travels, and the face still has the picture", await evalIn(cdp, S, `window.__flew.length`) === 0
      && await evalIn(cdp, S, `document.querySelectorAll("#picture [data-pic-face] .ds-face[data-drawn] svg path").length`) === 3);
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] }, S);
  }

  section("5. Back to initials");
  {
    await evalIn(cdp, S, `(document.querySelector("#picture [data-pic-open]").click(), 1)`);
    await waitFor(cdp, S, `document.querySelector(".sh-root[data-open='1'] [data-pad-initials]:not([hidden])") ? 1 : 0`, { label: "Back to initials", timeout: 15000 });
    await sleep(500);
    const first = await J(`JSON.stringify((() => { const a = document.activeElement; return { inSheet: !!(a && a.closest(".sh-root[data-open='1']")), destroys: !!(a && a.matches("[data-destroys], .btn-danger")),
      what: a ? (a.getAttribute("aria-label") || a.textContent || a.tagName).trim().slice(0, 30) : null, marked: document.querySelector("[data-pad-initials]").hasAttribute("data-destroys") }; })())`);
    check("the pad's sheet takes the focus on something that keeps, and Back to initials (it takes the stored picture away) is marked as destroying", first.inSheet && !first.destroys && first.marked, JSON.stringify(first));
    await evalIn(cdp, S, `(document.querySelector(".sh-root[data-open='1'] [data-pad-initials]").click(), 1)`);
    await waitFor(cdp, S, `!document.querySelector(".sh-root[data-open='1']") ? 1 : 0`, { label: "the sheet gone", timeout: 15000 });
    await sleep(400);
    const face = await J(`JSON.stringify({ drawn: !!document.querySelector("#picture [data-pic-face] [data-drawn]"), letters: document.querySelector("#picture [data-pic-face] .ds-face").textContent.trim(),
      button: document.querySelector("#picture [data-pic-open]").textContent.trim() })`);
    const me3 = await meNow();
    check("the face is the initials again, the button says Draw your picture, and /api/me has no picture", !face.drawn && /^[A-Z]{1,2}$/.test(face.letters) && face.button === "Draw your picture" && !("avatar" in me3),
      JSON.stringify({ face, avatar: me3.avatar }));
    await open(tripPath("#/"), `document.querySelector("#view .ag-day, #view .empty")`, "the app");
    await sleep(800);
    check("in the app, your own picture at the top right is the initials too", await evalIn(cdp, S, `document.querySelectorAll(".head-more [data-drawn], .head-more .ds-face-pic").length`) === 0);
  }

  section("6. Nothing moves under a finger");
  {
    // Your account, no picture now (5): the pad opens empty, with the initials field under it.
    await open("/account", `!document.getElementById("account").hidden`, "Your account");
    await evalIn(cdp, S, `(document.querySelector("#picture [data-pic-open]").click(), 1)`);
    await waitFor(cdp, S, `document.querySelector(".sh-root[data-open='1'] .ds-pad canvas") ? 1 : 0`, { label: "the pad, empty", timeout: 15000 });
    await sleep(900);
    await evalIn(cdp, S, `(${PAD}.querySelector("canvas").scrollIntoView({ block: "center" }), 1)`);
    await sleep(500);
    const box = () => J(`JSON.stringify((() => { const r = ${PAD}.querySelector("canvas").getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); })())`);
    const field = () => evalIn(cdp, S, `(() => { const r = ${PAD}.querySelector("[data-pad-initrow]"); return !r.hidden && getComputedStyle(r).visibility !== "hidden"; })()`);
    const before = await box(), fieldBefore = await field();
    const rect = await J(`JSON.stringify(${PAD}.querySelector("canvas").getBoundingClientRect())`);
    const at = ([u, v]) => ({ x: rect.x + u * rect.width, y: rect.y + v * rect.height });
    const [p0, ...rest] = Array.from({ length: 8 }, (_, i) => at([0.35 + i * 0.03, 0.5]));
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p0.x, y: p0.y }, S);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p0.x, y: p0.y, button: "left", buttons: 1, clickCount: 1 }, S);
    for (const p of rest) { await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "left", buttons: 1 }, S); await sleep(10); }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rest[rest.length - 1].x, y: rest[rest.length - 1].y, button: "left", buttons: 0, clickCount: 1 }, S);
    // Every frame of what follows the stroke's end (a sheet eases to a new height over its own motion), then at rest.
    const frames = await J(`new Promise((ok) => { const out = []; const t0 = performance.now(); const step = () => { const r = ${PAD}.querySelector("canvas").getBoundingClientRect();
      out.push([r.x, r.y].map(Math.round).join(",")); if (performance.now() - t0 < 900) requestAnimationFrame(step); else ok(JSON.stringify([...new Set(out)])); }; requestAnimationFrame(step); })`);
    const after = await box(), fieldAfter = await field();
    check("after the first stroke on an empty pad, the canvas hasn't moved at any frame (its box the same before and after; the initials field away with its space kept)",
      fieldBefore && !fieldAfter && before.join() === after.join() && frames.length === 1 && frames[0] === before.slice(0, 2).join(","),
      JSON.stringify({ before, after, frames, field: [fieldBefore, fieldAfter] }));
    await evalIn(cdp, S, `(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
    await waitFor(cdp, S, `!document.querySelector(".sh-root[data-open='1']") ? 1 : 0`, { label: "the sheet gone, nothing saved", timeout: 15000 });
    check("…and closing without Save keeps no picture", !("avatar" in (await meNow())));
  }

  console.log(`\npage errors: ${b.pageErrors.length ? b.pageErrors.join(" | ").slice(0, 400) : "none"}`);
  check("no page errors", !b.pageErrors.length);
} finally {
  try { await signInAs(cdp, S, HOST.key); await takeAway(); } catch { /* the window may be gone; the next run starts by taking it away */ }
  try { d1(`DELETE FROM messages WHERE trip_id = '${TRIP}' AND id = '${MSG}'`); } catch (e) { console.log(`the check's message ${MSG} was not removed: ${e.message}`); }
  if (stranger) { try { await stranger.call("DELETE", "/api/me", { confirm: "delete" }); } catch { /* reported by the next run's sign-up */ } }
  await b.done().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }
