#!/usr/bin/env node
/* Joining a trip by its link with only a name (a guest), and the pages around it, by real
 * presses in real Chrome on a server of its own (an empty database, removed afterwards).
 *
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> --label <what> -- node scripts/guests_check.mjs [--shots <dir>]
 *
 * Chrome needs the Bash sandbox disabled; the launcher (scripts/lib/browser.mjs) starts it.
 *
 * WHAT IT PROVES (made-up people: a host, Ana and Ben, who join with names alone)
 *   1. The join page signed out asks one thing: a name field, and Join, the largest control on
 *      the page and the first button; "Already have an account? Sign in" under it, to the
 *      sign-in page with the link to come back to. Join with no name says what to type and puts
 *      nobody on the trip.
 *   2. Ana types her name and presses Join: she is in the app at the trip, on it as a guest
 *      (the people the server lists), and the app holds the guest line until she taps OK; a
 *      reload doesn't say it again.
 *   3. As a guest: the account page leads with "Keep your place" and the line, a passkey first;
 *      no AI app to connect, no plan, no email. Sign out's first press says her place goes with
 *      it. Your trips doesn't offer her a trip to make, and says why. The sign-in page, signed in
 *      as her, says she's a guest, and "Sign in to an account you have" warns her place stays
 *      behind, naming her.
 *   4. She adds a passkey on the account page: the page says her place is kept, its card is
 *      Ways to sign in with the passkey in it, and the server says she's no guest now.
 *   5. Ben joins the same way. The host's People: Ben marked Guest with "Send a link to rejoin
 *      as Ben Ortiz", Ana (an account now) with neither. The link, opened on another browser
 *      (Ben's new phone) and its Sign in pressed, signs that browser in as Ben, still a guest;
 *      his first browser is signed out.
 *   6. The sign-in page, signed out, as Lexicommons lays it out: "Sign in or create an account",
 *      then Google, GitHub and the passkey, one under another and the same width, with making an
 *      account a closed fold under them that opens to its form.
 *   7. A guest opening the trip's link again while on it isn't told the guest line again.
 *   8. A guest who adds a passkey before tapping the line away isn't told it once they're an account.
 *   9. A one-use sign-in link opened on a phone where a guest is signed in names them, says the link ends their
 *      place, and asks before it does (nothing signed in on the first press).
 *
 * PLANTED: GUESTS_PLANT=1 serves the join and sign-in pages and their scripts as they were before
 * guests (the commit before them, read from git): 1 and 2 go red, and it stops in 5 (Ben can't join).
 * GUESTS_PLANT=signin serves only the sign-in page and its script from before, and leaves out 1 to 5:
 * 6 goes red (the passkey first, the providers after it, no fold). GUESTS_PLANT=fixes serves the guest's
 * pages as they were before 17 Nov's six fixes: 7, 8 and 9 go red.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { startServer, ROOT } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { openChrome } from "../checks/lib/chrome.mjs";
import { openMaking } from "../checks/lib/signin-page.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";
import { GUEST_LEAVING, guestLine } from "../public/js/guest.js";
// This check's server has Google and GitHub set up, so a guest is told of all three ways in.
const GUEST_LINE = guestLine({ google: true, github: true });

const argv = process.argv.slice(2);
const shotsAt = (() => { const i = argv.indexOf("--shots"); return i < 0 ? null : path.resolve(argv[i + 1]); })();
if (shotsAt) fs.mkdirSync(shotsAt, { recursive: true });
const PLANT_MODE = process.env.GUESTS_PLANT || "";
const PLANT = !!PLANT_MODE;
const SIGNIN_ONLY = PLANT_MODE === "signin";
// GUESTS_PLANT=fixes: the guest's pages as they were before the six fixes of 17 Nov (FIXES_BEFORE): 7, 8 and 9 go red.
const FIXES = PLANT_MODE === "fixes";
const FIXES_BEFORE = "f5c5627";
// The commit whose pages had no guests: the files the plant serves.
const BEFORE = "c8301ad";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date(Date.now() + d * 86400e3));

const server = await startServer({
  name: "guests", port: await freeLoopbackPort(),
  vars: { GOOGLE_CLIENT_ID: "guests-check.apps.example", GITHUB_CLIENT_ID: "guests-check" },
  secrets: { GOOGLE_CLIENT_SECRET: "guests-check-secret", GITHUB_CLIENT_SECRET: "guests-check-secret" },
});
ownServer(server.origin);

/** The plant: these paths answered with the file as it was at BEFORE (or FIXES_BEFORE). */
const fixesOld = FIXES ? Object.fromEntries(["index.html", "login.html", "account.html", "js/guest.js", "js/join.js", "js/auth.js", "js/account.js"]
  .map((f) => [f, execFileSync("git", ["show", `${FIXES_BEFORE}:public/${f}`], { cwd: ROOT, encoding: "utf8" })])) : null;
const OLD = PLANT && !FIXES ? {
  join: execFileSync("git", ["show", `${BEFORE}:public/join.html`], { cwd: ROOT, encoding: "utf8" }),
  joinJs: execFileSync("git", ["show", `${BEFORE}:public/js/join.js`], { cwd: ROOT, encoding: "utf8" }),
  login: execFileSync("git", ["show", `${BEFORE}:public/login.html`], { cwd: ROOT, encoding: "utf8" }),
  authJs: execFileSync("git", ["show", `${BEFORE}:public/js/auth.js`], { cwd: ROOT, encoding: "utf8" }),
} : null;
async function plantFixes(page) {
  page.on((m) => {
    if (m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    const p = new URL(request.url).pathname;
    const f = /^\/t\/[^/]+\/?$/.test(p) ? "index.html" : p === "/account" ? "account.html" : /^\/login(\/link\/[^/]+)?\/?$/.test(p) ? "login.html"
      : /^\/js\/(guest|join|auth|account)\.js$/.test(p) ? p.slice(1) : null;
    if (!f) { page.send("Fetch.continueRequest", { requestId }).catch(() => {}); return; }
    page.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: `${f.endsWith(".js") ? "text/javascript" : "text/html"}; charset=utf-8` }, { name: "Cache-Control", value: "no-store" }],
      body: Buffer.from(fixesOld[f]).toString("base64") }).catch(() => {});
  });
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/t/*" }, { urlPattern: "*/account" }, { urlPattern: "*/login*" }, { urlPattern: "*/js/*" }] });
}
async function plantOld(page) {
  if (FIXES) return plantFixes(page);
  if (!OLD) return;
  page.on((m) => {
    if (m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    const p = new URL(request.url).pathname;
    const body = !SIGNIN_ONLY && /^\/join\/[^/]+\/?$/.test(p) ? [OLD.join, "text/html"] : !SIGNIN_ONLY && p === "/js/join.js" ? [OLD.joinJs, "text/javascript"]
      : p === "/login" ? [OLD.login, "text/html"] : p === "/js/auth.js" ? [OLD.authJs, "text/javascript"] : null;
    if (!body) { page.send("Fetch.continueRequest", { requestId }).catch(() => {}); return; }
    page.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: `${body[1]}; charset=utf-8` }, { name: "Cache-Control", value: "no-store" }],
      body: Buffer.from(body[0]).toString("base64") }).catch(() => {});
  });
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/join/*" }, { urlPattern: "*/js/join.js*" }, { urlPattern: "*/login" }, { urlPattern: "*/js/auth.js*" }] });
}

async function shot(page, name) {
  if (!shotsAt) return;
  await page.settle();
  await page.shot(path.join(shotsAt, `${name}.png`));
}

// What a page's held message says, and whether it has its OK.
const HELD = `(() => { const t = document.getElementById("toast"); if (!t || t.hidden) return null;
  return { kept: [...t.querySelectorAll(".toast-kept")].map((n) => n.textContent), ok: !!t.querySelector(".toast-ok") }; })()`;

let chrome = null;
let code = 1;
try {
  await server.start();
  const host = new Person(server.origin, "Mara Voss");
  await host.signUp();
  const made = await host.post("/api/trips", { name: "Coast week", default_tz: "Europe/Lisbon", starts_on: day(10), ends_on: day(16), currencies: ["EUR"] });
  const tripId = made.json?.trip?.id;
  const T = `/api/trips/${tripId}`;
  const link = (await host.post(`${T}/links`, { days: 7, uses: 10 })).json?.link;
  if (!tripId || !link) throw new Error(`setup: trip ${made.status}, link ${JSON.stringify(link)}`);
  const joinAt = `/join/${link.code}`;
  const people = async () => (await host.get(`${T}/people`)).json?.members ?? [];
  chrome = await openChrome();

  let ana = null;
  walk: {
  if (SIGNIN_ONLY) { console.log("\n(GUESTS_PLANT=signin: sections 1 to 5 left out; only the sign-in page from before)"); break walk; }
  // ── 1. the join page, signed out ──────────────────────────────────────────────────────────
  section("1. the join page, signed out: a name and Join");
  ana = await chrome.page({ width: 390, height: 844, mobile: true });
  await plantOld(ana);
  await ana.goto(`${server.origin}${joinAt}`);
  await ana.until(`!document.getElementById("page").hasAttribute("data-wait") && document.getElementById("p-trip") && !document.getElementById("p-trip").hidden`, "the join page drawn");
  const look = await ana.eval(`(() => {
    const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const box = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), area: Math.round(r.width * r.height) }; };
    const controls = [...document.querySelectorAll("#page button, #page a")].filter(shown).map((el) => ({ id: el.id, words: el.textContent.trim(), ...box(el) }));
    const join = document.getElementById("btn-guest"), field = document.getElementById("guest-name"), signin = document.getElementById("go-signin");
    return { controls, join: shown(join) ? { words: join.textContent.trim(), ...box(join) } : null, field: shown(field),
      fieldLabel: document.querySelector('label[for="guest-name"]')?.textContent.trim() ?? null,
      signin: shown(signin) ? { words: signin.closest("p")?.textContent.replace(/\\s+/g, " ").trim(), href: signin.getAttribute("href"), ...box(signin) } : null };
  })()`);
  check("signed out it asks one thing: Your name, with Join", look.field && look.fieldLabel === "Your name" && look.join?.words === "Join", JSON.stringify({ field: look.field, label: look.fieldLabel, join: look.join }));
  const buttons = (look.controls || []).filter((c) => c.id !== "");
  check("Join is the largest control on the page and the first button", !!look.join && buttons.every((c) => c.area <= look.join.area) && buttons.filter((c) => c.top < look.join.top).length === 0,
    JSON.stringify(buttons.map((c) => [c.id, c.top, c.area])));
  check("\"Already have an account? Sign in\" sits under Join and goes to sign in, coming back to this link",
    !!look.signin && look.signin.words === "Already have an account? Sign in" && look.signin.top > look.join.top && look.signin.href === `/login?next=${encodeURIComponent(joinAt)}`,
    JSON.stringify(look.signin));
  await shot(ana, "1-join-signed-out");
  if (look.join) {
    await ana.click("#btn-guest");
    const said = await ana.until(`(() => { const m = document.getElementById("msg"); return m && !m.hidden ? m.textContent.trim() : null; })()`, "the message for no name");
    check("Join with no name says what to type", /Type your name/.test(said), said);
    check("  and puts nobody on the trip", (await people()).length === 1, JSON.stringify((await people()).map((m) => m.name)));
  }

  // ── 2. joining by name ────────────────────────────────────────────────────────────────────
  section("2. Ana joins with her name");
  let anaIn = false;
  if (look.join) {
    await ana.type("#guest-name", "Ana Reyes");
    await ana.click("#btn-guest");
    anaIn = await ana.until(`location.pathname === "/t/${tripId}/"`, "the trip in the app", 20000).then(() => true, () => false);
  }
  const anaRow = (await people()).find((m) => m.name === "Ana Reyes");
  check("she is in the app at the trip, and on it as a guest", anaIn && !!anaRow && anaRow.guest === true, JSON.stringify({ anaIn, anaRow }));
  const held = anaIn ? await ana.until(HELD, "the held message", 10000).catch(() => null) : null;
  check("the app holds the guest line, with its OK", !!held && held.kept.includes(GUEST_LINE) && held.ok, JSON.stringify(held));
  if (held) {
    await shot(ana, "2-guest-line");
    await ana.click("#toast .toast-ok");
    await ana.until(`(() => { const t = document.getElementById("toast"); return !t || t.hidden || !t.querySelector(".toast-kept"); })()`, "the message let go");
    await ana.goto(`${server.origin}/t/${tripId}/`);
    await sleep(2500);
    const again = await ana.eval(HELD);
    check("tapped away, a reload doesn't say it again", !again || !again.kept.includes(GUEST_LINE), JSON.stringify(again));
  }

  // ── 3. the pages a guest sees ─────────────────────────────────────────────────────────────
  section("3. as a guest: Your account, Your trips, the sign-in page");
  if (anaIn) {
    await ana.goto(`${server.origin}/account`);
    await ana.until(`!document.getElementById("account").hidden`, "the account page");
    const acct = await ana.eval(`({ title: document.getElementById("ways-title").textContent, line: document.getElementById("ways-guest").hidden ? null : document.getElementById("ways-guest").textContent,
      primary: document.getElementById("btn-add-passkey").classList.contains("btn-primary"), apps: !document.getElementById("apps-guest").hidden && document.getElementById("apps-connect").hidden,
      plan: document.getElementById("plan").hidden, email: document.getElementById("email-card").hidden })`);
    check("the account page leads with Keep your place and the guest line, a passkey first", acct.title === "Keep your place" && acct.line === GUEST_LINE && acct.primary, JSON.stringify(acct));
    check("  no AI app to connect (it says what to add), no plan, no email", acct.apps && acct.plan && acct.email, JSON.stringify(acct));
    await shot(ana, "3-account-guest");
    await ana.click("#btn-signout");
    const asks = await ana.until(`(() => { const b = document.getElementById("btn-signout"); return b.classList.contains("lg-armed") ? b.textContent.trim() : null; })()`, "Sign out asking");
    check("Sign out's first press says her place goes with it", asks === GUEST_LEAVING, asks);
    await sleep(5400);
    check("  (and asking ran out: still signed in)", (await ana.eval(`fetch("/api/me").then((r) => r.status)`)) === 200);

    await ana.goto(`${server.origin}/trips`);
    await ana.until(`!document.getElementById("page").hidden`, "Your trips");
    const trips = await ana.eval(`({ guest: !document.getElementById("make-guest").hidden, form: !document.getElementById("form-make").hidden, words: document.getElementById("make-guest").textContent.replace(/\\s+/g, " ").trim() })`);
    check("Your trips doesn't offer her a trip to make, and says why", trips.guest && !trips.form && /guest/.test(trips.words), JSON.stringify(trips));

    await ana.goto(`${server.origin}/login`);
    await ana.until(`!document.getElementById("page").hasAttribute("data-wait") && !document.getElementById("p-account").hidden`, "the sign-in page, signed in");
    const signedIn = await ana.eval(`({ line: document.getElementById("account-guest").hidden ? null : document.getElementById("account-guest").textContent, keep: document.getElementById("go-account").textContent.trim() })`);
    check("the sign-in page says she's a guest, and the way to keep her place", signedIn.line === GUEST_LINE && signedIn.keep === "Keep your place", JSON.stringify(signedIn));
    await ana.click("#btn-signin-other");
    const warn = await ana.until(`(() => { const w = document.getElementById("guest-warn"); return !document.getElementById("p-signin").hidden && w && !w.hidden ? w.textContent.trim() : null; })()`, "the warning");
    check("Sign in to an account you have warns her place stays behind, naming her", warn === "You're a guest on this phone. Signing in to another account leaves Ana Reyes's place behind.", warn);
    await shot(ana, "3-signin-guest-warned");
  }

  // ── 4. keeping her place ──────────────────────────────────────────────────────────────────
  section("4. Ana adds a passkey");
  if (anaIn) {
    await ana.goto(`${server.origin}/account`);
    await ana.until(`!document.getElementById("account").hidden`, "the account page");
    await ana.click("#btn-add-passkey");
    await ana.until(`location.search === "" && location.pathname === "/account" && !document.getElementById("account").hidden && document.getElementById("ways").children.length > 0`, "the page drawn again", 20000).catch(() => null);
    const after = await ana.eval(`({ said: [...document.querySelectorAll(".lg-msg")].filter((m) => !m.hidden).map((m) => m.textContent.trim()), title: document.getElementById("ways-title").textContent, rows: document.getElementById("ways").children.length, line: !document.getElementById("ways-guest").hidden })`);
    const me = await ana.eval(`fetch("/api/me").then((r) => r.json())`);
    check("the page says her place is kept", after.said.some((s) => /Your place is kept/.test(s)), JSON.stringify(after.said));
    check("  its card is Ways to sign in, with the passkey, no guest line", after.title === "Ways to sign in" && after.rows === 1 && !after.line, JSON.stringify(after));
    check("  and the server says she's no guest now, the same person", me?.guest === false && me?.id === anaRow?.id, JSON.stringify({ guest: me?.guest, same: me?.id === anaRow?.id }));
  }

  // ── 5. Ben, and the host's rejoin link ────────────────────────────────────────────────────
  section("5. Ben joins; the host sends him a link back in");
  const ben = await chrome.page({ width: 390, height: 844, mobile: true });
  await plantOld(ben);
  await ben.goto(`${server.origin}${joinAt}`);
  await ben.until(`!document.getElementById("page").hasAttribute("data-wait")`, "the join page");
  const benCan = await ben.eval(`!!document.getElementById("guest-name") && document.getElementById("guest-name").getClientRects().length > 0`);
  if (benCan) {
    await ben.type("#guest-name", "Ben Ortiz");
    await ben.click("#btn-guest");
    await ben.until(`location.pathname === "/t/${tripId}/"`, "Ben in the app", 20000).catch(() => null);
  }
  const benRow = (await people()).find((m) => m.name === "Ben Ortiz");
  check("Ben is on the trip as a guest", !!benRow && benRow.guest === true, JSON.stringify(benRow));
  const hostPage = await chrome.page({ width: 390, height: 844, mobile: true });
  await hostPage.setCookie(server.origin, "wgp_session", host.jar.cookies.get("wgp_session"));
  await hostPage.goto(`${server.origin}/trips/${tripId}`);
  await hostPage.until(`document.getElementById("people") && document.getElementById("people").children.length >= 2`, "People");
  const rows = await hostPage.eval(`[...document.querySelectorAll("#people .ac-way")].map((r) => ({ name: r.querySelector(".ac-way-label")?.textContent, guest: [...r.querySelectorAll(".ds-tag")].some((p) => p.textContent.trim() === "Guest"),
    rejoin: [...r.querySelectorAll("button")].map((b) => b.textContent.trim()).find((w) => /^Send a link to rejoin/.test(w)) ?? null }))`);
  const benSeen = rows.find((r) => r.name === "Ben Ortiz"), anaSeen = rows.find((r) => r.name === "Ana Reyes");
  check("People marks Ben a guest, with Send a link to rejoin as Ben Ortiz", !!benSeen && benSeen.guest && benSeen.rejoin === "Send a link to rejoin as Ben Ortiz", JSON.stringify(benSeen));
  check("  and Ana, an account now, with neither", !anaRow || (!!anaSeen && !anaSeen.guest && anaSeen.rejoin === null), JSON.stringify(anaSeen));
  if (benSeen?.rejoin) {
    await hostPage.eval(`[...document.querySelectorAll("#people .ac-way")].find((r) => r.querySelector(".ac-way-label")?.textContent === "Ben Ortiz").querySelector("button").id = "check-rejoin"`);
    await hostPage.click("#check-rejoin");
    const box = await hostPage.until(`(() => { const f = document.querySelector(".tr-rejoin input"); return f && f.value ? f.value : null; })()`, "the rejoin link");
    await shot(hostPage, "5-people-rejoin");
    check("the link is a one-use sign-in link of this site", new URL(box).origin === server.origin && /^\/login\/link\/[A-Za-z0-9_-]{20,}$/.test(new URL(box).pathname), box);
    const newPhone = await chrome.page({ width: 390, height: 844, mobile: true });
    await newPhone.goto(box);
    await newPhone.until(`!document.getElementById("page").hasAttribute("data-wait") && !document.getElementById("p-link").hidden`, "the link's page");
    await newPhone.eval(`(() => { const d = document.querySelector(".tr-linkset"); if (d) d.open = true; return 1; })()`);   // Make a link is under Link settings
    await newPhone.click("#btn-link");
    await newPhone.until(`location.pathname === "/account"`, "signed in", 20000).catch(() => null);
    const who = await newPhone.eval(`fetch("/api/me").then((r) => r.status === 200 ? r.json() : null)`);
    check("opened on Ben's new phone and pressed, it signs in as Ben, still a guest", who?.id === benRow?.id && who?.guest === true, JSON.stringify(who && { name: who.name, guest: who.guest }));
    const oldPhone = await ben.eval(`fetch("/api/me").then((r) => r.status)`);
    check("  and his first phone is signed out", oldPhone === 401, oldPhone);
    await newPhone.close();
  }
  await hostPage.close();
  await ben.close();
  }

  // ── 6. the sign-in page, signed out ───────────────────────────────────────────────────────
  section("6. the sign-in page, as Lexicommons lays it out");
  const visitor = await chrome.page({ width: 390, height: 844, mobile: true });
  await plantOld(visitor);
  await visitor.goto(`${server.origin}/login`);
  await visitor.until(`!document.getElementById("page").hasAttribute("data-wait") && !document.getElementById("p-signin").hidden`, "the sign-in page");
  const ways = await visitor.eval(`(() => {
    // Seen, not only laid out: a closed <details> keeps its content's boxes (::details-content) while showing none.
    const shown = (el) => !!el && (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0);
    const at = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), w: Math.round(r.width) }; };
    const list = [["google", document.querySelector('form[data-provider="google"] button')], ["github", document.querySelector('form[data-provider="github"] button')], ["passkey", document.getElementById("btn-signin")]]
      .filter(([, el]) => shown(el)).map(([k, el]) => ({ k, words: el.textContent.trim(), ...at(el) }));
    const fold = document.getElementById("trouble");
    return { title: document.getElementById("signin-title")?.textContent.trim(), list, fold: fold ? { open: fold.open, summary: fold.querySelector("summary")?.textContent.trim(), top: at(fold).top } : null,
      formShown: shown(document.getElementById("join-name")), usernameShown: shown(document.getElementById("signin-name")) };
  })()`);
  check("it says Sign in or create an account", ways.title === "Sign in or create an account", ways.title);
  check("then Google, GitHub and the passkey, one under another, the same width", ways.list.map((w) => w.k).join() === "google,github,passkey"
    && ways.list.every((w, i) => i === 0 || w.top > ways.list[i - 1].top) && new Set(ways.list.map((w) => w.w)).size === 1
    && ways.list.map((w) => w.words).join(" | ") === "Continue with Google | Continue with GitHub | Continue with a passkey", JSON.stringify(ways.list));
  check("then one closed row, Trouble signing in?, and nothing else: no name field until a sign-in comes back without a passkey",
    !!ways.fold && !ways.fold.open && ways.fold.summary === "Trouble signing in?" && !ways.formShown && !ways.usernameShown
    && ways.list.every((w) => w.top < ways.fold.top), JSON.stringify(ways));
  await shot(visitor, "6-signin");
  if (ways.fold) {
    // The passkey button on a device with none for this site: back without one, the account's making opens.
    await openMaking(visitor);
    const open = await visitor.eval(`({ what: document.getElementById("make-what").textContent.trim(), field: document.getElementById("join-name").checkVisibility(), button: document.getElementById("btn-join").textContent.trim(), again: document.getElementById("btn-signin-again").checkVisibility() })`);
    check("  Continue with a passkey, with none here: it opens the account's making: its line, Your name, Create account, and Try again",
      open.what === "No passkey here yet? Make your account." && open.field && open.button === "Create account" && open.again, JSON.stringify(open));
    await visitor.click("#trouble > summary");
    const trouble = await visitor.eval(`({ open: document.getElementById("trouble").open, username: document.getElementById("signin-name").checkVisibility(), email: document.getElementById("btn-recover").checkVisibility() })`);
    // This server sends no email, so the email way isn't offered (check:accounts-browser holds it where the site has email).
    check("  Trouble signing in? opens the username way (and no email way: this server sends no email)", trouble.open && trouble.username && !trouble.email, JSON.stringify(trouble));
  }
  await visitor.close();
  await ana?.close();

  if (!SIGNIN_ONLY) {
  const NOTE = `(() => { try { return localStorage.getItem("wgp.guestNote"); } catch { return "no storage"; } })()`;
  const joinAs = async (page, name) => {
    await plantOld(page);
    await page.goto(`${server.origin}${joinAt}`);
    await page.until(`!document.getElementById("page").hasAttribute("data-wait") && !document.getElementById("as-visitor").hidden`, "the join page");
    await page.type("#guest-name", name);
    await page.click("#btn-guest");
    return page.until(`location.pathname === "/t/${tripId}/"`, `${name} in the app`, 20000).then(() => true, () => false);
  };

  // ── 7. opening the trip's link again, already on it ───────────────────────────────────────
  section("7. a guest opens the trip's link again while on it");
  const eli = await chrome.page({ width: 390, height: 844, mobile: true });
  if (await joinAs(eli, "Eli Park")) {
    await eli.until(HELD, "the held line", 10000).catch(() => null);
    await eli.click("#toast .toast-ok").catch(() => {});
    await eli.goto(`${server.origin}${joinAt}`);
    await eli.until(`!document.getElementById("page").hasAttribute("data-wait") && !document.getElementById("as-account").hidden`, "the join page, signed in");
    await eli.click("#btn-join");
    await eli.until(`location.pathname === "/t/${tripId}/"`, "back in the app", 20000).catch(() => null);
    await sleep(2500);
    const note = await eli.eval(NOTE), again = await eli.eval(HELD);
    check("the guest line isn't said again (nothing new: they were on the trip already)", note !== "1" && !(again || []).includes?.(GUEST_LINE) && !(again?.kept || []).includes(GUEST_LINE), JSON.stringify({ note, again }));
  } else check("the guest line isn't said again (nothing new: they were on the trip already)", false, "Eli couldn't join");
  await eli.close();

  // ── 8. an account before the line was tapped away ─────────────────────────────────────────
  section("8. a guest adds a passkey before tapping the line away");
  const cleo = await chrome.page({ width: 390, height: 844, mobile: true });
  if (await joinAs(cleo, "Cleo Diaz")) {
    await cleo.until(HELD, "the held line", 10000).catch(() => null);
    await cleo.goto(`${server.origin}/account`);
    await cleo.until(`!document.getElementById("account").hidden`, "the account page", 20000);
    await cleo.click("#btn-add-passkey");
    await cleo.until(`location.search === "" && document.getElementById("ways-title").textContent === "Ways to sign in"`, "an account now", 20000).catch(() => null);
    await cleo.goto(`${server.origin}/t/${tripId}/`);
    await sleep(3000);
    const note = await cleo.eval(NOTE), held = await cleo.eval(HELD);
    const me = await cleo.eval(`fetch("/api/me").then((r) => r.json())`);
    check("an account now, the app doesn't tell them they're a guest", me?.guest === false && note !== "1" && !(held?.kept || []).includes(GUEST_LINE), JSON.stringify({ guest: me?.guest, note, held }));
  } else check("an account now, the app doesn't tell them they're a guest", false, "Cleo couldn't join");
  await cleo.close();

  // ── 9. a one-use link on a phone where someone is signed in ───────────────────────────────
  section("9. a sign-in link opened on a phone where a guest is signed in");
  const dan = await chrome.page({ width: 390, height: 844, mobile: true });
  const benId = (await people()).find((m) => m.name === "Ben Ortiz")?.id;
  const made9 = benId ? await host.post(`${T}/members/${encodeURIComponent(benId)}/rejoin`, {}) : null;
  if (made9?.status === 201 && await joinAs(dan, "Dan Moss")) {
    await dan.goto(`${server.origin}${made9.json.url}`);
    await dan.until(`!document.getElementById("page").hasAttribute("data-wait") && !document.getElementById("p-link").hidden`, "the link's page");
    const said = await dan.eval(`(() => { const l = document.getElementById("link-current"); return l && !l.hidden ? l.textContent.trim() : null; })()`);
    check("the link's page says who is signed in here, a guest, and that the link ends their place", !!said && /Dan Moss is signed in on this phone as a guest/.test(said) && /ends Dan Moss's place here/.test(said), said);
    await shot(dan, "9-link-over-a-guest");
    await dan.eval(`(() => { const d = document.querySelector(".tr-linkset"); if (d) d.open = true; return 1; })()`);   // Make a link is under Link settings
    await dan.click("#btn-link");
    const asks = await dan.until(`(() => { const b = document.getElementById("btn-link"); return b.classList.contains("lg-armed") ? b.textContent.trim() : null; })()`, "the button asking", 5000).catch(() => null);
    check("  the first press asks, saying what it ends; nothing is signed in yet", /^Tap again to end Dan Moss's place here and sign in with the link$/.test(asks || ""), asks);
    await sleep(5600);
    const still = await dan.eval(`fetch("/api/me").then((r) => r.json()).then((m) => m.name)`);
    check("  and without the second press, Dan is still the one signed in here", still === "Dan Moss", still);
  } else check("the link's page says who is signed in here, a guest, and that the link ends their place", false, `rejoin ${made9?.status}`);
  await dan.close();
  }

  console.log(`\n${pass} passed, ${fail} failed${PLANT ? ` (PLANTED: ${SIGNIN_ONLY ? "the sign-in page" : "the pages"} from before guests)` : ""}`);
  if (fail) console.log(`failed: ${failures.join(" | ")}`);
  code = fail ? 1 : 0;
} catch (e) {
  console.log(`\nSTOPPED: ${e?.stack || e}`);
  console.log(`${pass} passed, ${fail} failed before it stopped`);
  code = 1;
} finally {
  if (chrome) await chrome.close().catch(() => {});
  await server.stop().catch(() => {});
}
process.exit(code);
