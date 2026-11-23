#!/usr/bin/env node
/* What a guest is told names only what is true for them: the ways in this site has, and who can connect an
 * AI app. By real presses in real Chrome, on two servers of its own (empty databases, removed afterwards):
 * one with no Google or GitHub set up (as wegoplace.com until they're registered), one with both (stand-in ids).
 *
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> --label <what> -- node scripts/guest_words_check.mjs [--shots <dir>]
 *
 * Chrome needs the Bash sandbox disabled; the launcher (scripts/lib/browser.mjs) starts it.
 *
 * WHAT IT PROVES, on each server (made-up people: a host with an empty trip, and a friend who joins by name)
 *   1. The line the app holds after joining names a passkey, and Google and GitHub only where the site has them.
 *   2. The empty Itinerary and the empty Places tell the guest "Anyone on the trip with an account can connect
 *      an AI app to fill it in." with no way to connect one; the host, on the same trip, gets "Plan it with your AI"
 *      on the empty Itinerary (the control).
 *   3. Keep your place (Your account) and the sign-in page say the same line; the AI apps card says what to add,
 *      naming the same ways, and offers no connecting. Signing out says it ends her place here, with no Sign out
 *      everywhere; Delete names only what a guest has.
 *
 * PLANTED: GUESTWORDS_PLANT=1 serves the files this change touched as they were before it (BEFORE, read from
 * git): on the server without Google, 1 and 3 go red (Google named), and on both, 2 (a guest offered an AI app).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { startServer, ROOT } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { openChrome } from "../checks/lib/chrome.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";
import { GUEST_AI_LINE, guestLine, waysIn } from "../public/js/guest.js";

const argv = process.argv.slice(2);
const shotsAt = (() => { const i = argv.indexOf("--shots"); return i < 0 ? null : path.resolve(argv[i + 1]); })();
if (shotsAt) fs.mkdirSync(shotsAt, { recursive: true });
const PLANT = !!process.env.GUESTWORDS_PLANT;
// The commit before this change: the files the plant serves.
const BEFORE = "f5c5627";
const PLANTED = PLANT ? Object.fromEntries(["public/index.html", "public/js/guest.js", "public/js/agenda.js", "public/js/places.js", "public/js/store.js", "public/js/account.js", "public/account.html", "public/js/auth.js"]
  .map((f) => [f.replace(/^public/, "").replace(/^\/index\.html$/, "/"), execFileSync("git", ["show", `${BEFORE}:${f}`], { cwd: ROOT, encoding: "utf8" })])) : null;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date(Date.now() + d * 86400e3));

async function plantOld(page) {
  if (!PLANTED) return;
  page.on((m) => {
    if (m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    const u = new URL(request.url);
    const key = /^\/t\/[^/]+\/?$/.test(u.pathname) ? "/" : u.pathname === "/account" ? "/account.html" : u.pathname;
    const body = PLANTED[key];
    if (!body) { page.send("Fetch.continueRequest", { requestId }).catch(() => {}); return; }
    const type = key.endsWith(".js") ? "text/javascript" : "text/html";
    page.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: `${type}; charset=utf-8` }, { name: "Cache-Control", value: "no-store" }],
      body: Buffer.from(body).toString("base64") }).catch(() => {});
  });
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/t/*" }, { urlPattern: "*/account" }, { urlPattern: "*/js/*" }] });
}

const shot = async (page, name) => { if (!shotsAt) return; await page.settle(); await page.shot(path.join(shotsAt, `${name}.png`)); };
const HELD = `(() => { const t = document.getElementById("toast"); if (!t || t.hidden) return null; return [...t.querySelectorAll(".toast-kept")].map((n) => n.textContent); })()`;
// The empty screen's AI line: its words and whether it offers the way to connect one.
const AI_LINE = (sel) => `(() => { const p = document.querySelector(${JSON.stringify(sel)}); return p ? { words: p.textContent.replace(/\\s+/g, " ").trim(), link: !!p.querySelector('a[href="/account#ai-apps"]') } : null; })()`;

let code = 1;
const servers = [];
try {
  const chrome = await openChrome();
  for (const [tag, providers] of [["no-google", {}], ["google-github", { google: true, github: true }]]) {
    const vars = providers.google ? { GOOGLE_CLIENT_ID: "words-check.apps.example", GITHUB_CLIENT_ID: "words-check" } : {};
    const secrets = providers.google ? { GOOGLE_CLIENT_SECRET: "words-check-secret", GITHUB_CLIENT_SECRET: "words-check-secret" } : {};
    const server = await startServer({ name: `guest-words-${tag}`, port: await freeLoopbackPort(), vars, secrets });
    servers.push(server);
    ownServer(server.origin);
    await server.start();
    const line = guestLine(providers);
    section(`${tag}: a guest is told of ${waysIn(providers)}`);
    const host = new Person(server.origin, "Mara Voss");
    await host.signUp();
    const made = await host.post("/api/trips", { name: "Coast week", default_tz: "Europe/Lisbon", starts_on: day(10), ends_on: day(16), currencies: ["EUR"] });
    const tripId = made.json?.trip?.id;
    const link = (await host.post(`/api/trips/${tripId}/links`, {})).json?.link;
    if (!tripId || !link) throw new Error(`setup: ${made.status} ${JSON.stringify(link)}`);

    const ana = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
    await plantOld(ana);
    await ana.goto(`${server.origin}/join/${link.code}`);
    await ana.until(`!document.getElementById("page").hasAttribute("data-wait") && !document.getElementById("as-visitor").hidden`, "the join page");
    await ana.type("#guest-name", "Ana Reyes");
    await ana.click("#btn-guest");
    await ana.until(`location.pathname === "/t/${tripId}/"`, "the trip", 20000);
    const held = await ana.until(HELD, "the held line", 12000).catch(() => null);
    check(`1. the line after joining names ${waysIn(providers)}, and nothing else`, !!held && held.includes(line), JSON.stringify(held));
    await shot(ana, `${tag}-1-guest-line`);
    if (held) await ana.click("#toast .toast-ok");

    await ana.until(`document.querySelector(".ag-empty-ai") ? 1 : 0`, "the empty Itinerary", 15000).catch(() => null);
    const agenda = await ana.eval(AI_LINE(".ag-empty-ai"));
    check("2. the empty Itinerary tells a guest who can connect an AI app, and offers no way to", !!agenda && agenda.words === GUEST_AI_LINE && !agenda.link, JSON.stringify(agenda));
    await shot(ana, `${tag}-2-itinerary`);
    await ana.goto(`${server.origin}/t/${tripId}/#/places`);
    await ana.until(`document.querySelector(".pl-empty-ai") ? 1 : 0`, "the empty Places", 15000).catch(() => null);
    const places = await ana.eval(AI_LINE(".pl-empty-ai"));
    check("   and so do the empty Places", !!places && places.words === GUEST_AI_LINE && !places.link, JSON.stringify(places));
    await shot(ana, `${tag}-2-places`);

    await ana.goto(`${server.origin}/account`);
    await ana.until(`!document.getElementById("account").hidden`, "the account page", 20000);
    const acct = await ana.eval(`({ title: document.getElementById("ways-title").textContent, line: document.getElementById("ways-guest").textContent, apps: document.getElementById("apps-guest").textContent,
      connect: !document.getElementById("apps-connect").hidden })`);
    check("3. Keep your place says the same line", acct.title === "Keep your place" && acct.line === line, JSON.stringify(acct));
    check("   and the AI apps card says what to add, the same ways, with nothing to connect", acct.apps === `Add ${waysIn(providers)} to connect an app.` && !acct.connect, JSON.stringify(acct));
    const leaving = await ana.eval(`({ words: document.getElementById("out-words")?.textContent ?? null, everywhere: !document.getElementById("btn-signout-all").hidden,
      deleted: document.getElementById("delete-title").closest("section").querySelector(".ac-list-row").innerText.replace(/\\s+/g, " ").trim(),
      host: document.getElementById("delete-title").closest("section").innerText.includes("A trip you host") })`);
    check("   signing out says it ends her place on this phone, and Sign out everywhere isn't offered",
      leaving.words === "You're a guest: signing out ends your place on this phone. Add a way to sign in first to keep it." && !leaving.everywhere, JSON.stringify(leaving));
    check("   Delete names only what a guest has (no ways to sign in, AI apps, email, or trips hosted)",
      /^Goes: your picture, your settings, your own packing lists,( your conversations with the assistant,)? your memories with the boards you shared from them\.$/.test(leaving.deleted) && !leaving.host, JSON.stringify(leaving));
    await shot(ana, `${tag}-3-keep-your-place`);       // the whole page: Keep your place down to Delete
    await ana.goto(`${server.origin}/login`);
    await ana.until(`!document.getElementById("page").hasAttribute("data-wait") && !document.getElementById("p-account").hidden`, "the sign-in page, signed in");
    const signin = await ana.eval(`document.getElementById("account-guest").textContent`);
    check("   the sign-in page, signed in as her, says it too", signin === line, signin);
    await ana.close();

    // The control: the host, on the same empty trip, is offered "Plan it with your AI" directly.
    const hostPage = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
    await plantOld(hostPage);
    await hostPage.setCookie(server.origin, "wgp_session", host.jar.cookies.get("wgp_session"));
    await hostPage.goto(`${server.origin}/t/${tripId}/`);
    await hostPage.until(`document.querySelector("[data-plan-ai]") || document.querySelector(".ag-empty-ai") ? 1 : 0`, "the host's empty Itinerary", 15000).catch(() => null);
    const hostOffer = await hostPage.eval(`(() => { const b = document.querySelector("[data-plan-ai]"); const p = document.querySelector(".ag-empty-ai"); return { btn: b ? b.textContent.trim() : null, fine: p ? p.textContent.replace(/\\s+/g, " ").trim() : "" }; })()`);
    check("   (the host is still offered Plan it with your AI: the control)", !!hostOffer && /Plan it with your AI/.test(hostOffer.btn || ""), JSON.stringify(hostOffer));
    await hostPage.close();
  }
  await chrome.close();
  console.log(`\n${pass} passed, ${fail} failed${PLANT ? " (PLANTED: the files from before)" : ""}`);
  if (fail) console.log(`failed: ${failures.join(" | ")}`);
  code = fail ? 1 : 0;
} catch (e) {
  console.log(`\nSTOPPED: ${e?.stack || e}\n${pass} passed, ${fail} failed before it stopped`);
} finally {
  for (const s of servers) await s.stop().catch(() => {});
}
process.exit(code);
