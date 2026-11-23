#!/usr/bin/env node
/* What's yours, on Your account (public/account.html #yours, account.js): the person's export
 * (GET /api/account/export), in a real browser on servers of its own, made-up people:
 *
 *   1. Its own card above "Delete your account", the sentence and a plain "Download your data" link
 *      with `download`; the Delete card points to it ("Download what's yours first, above.").
 *   2. The link gives the person signed in a JSON file named wegoplace-account-<day>.json with their
 *      own account in it; signed out the same address is refused. The day is where the person is: the
 *      link carries the page's own date (?day=), and a page in New York at 20:30, the evening before
 *      the server's UTC day, gets a file named by its own day.
 *   3. The assistant is named only where the site offers it: a site without it says "your account,
 *      and your messages and memories on each trip"; with it, "… and your conversations with the
 *      assistant".
 *   4. With no signal, the link says so in words and asks nothing.
 *   5. With WGP_SHOTS=<folder>: stills of the card and of Delete's line at 390, 320 with larger text
 *      (278 at 2.3) and 1440, light and dark.
 *
 *   node scripts/gate.mjs --only export_card_check
 *
 * PLANTED (red when put in by hand): the card's link without `download`, or pointing elsewhere (1,
 * 2); account.js naming the assistant on every site (3).
 */
import fs from "node:fs";
import path from "node:path";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { openChrome } from "../checks/lib/chrome.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.WGP_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// "Without": a site with the plan and not the assistant (a site with neither never reaches the line).
const plain = await startServer({
  name: "export-card", port: await freeLoopbackPort(),
  vars: { PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y" },
  secrets: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" },
});
const withIt = await startServer({
  name: "export-card-assistant", port: await freeLoopbackPort(),
  vars: { PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y", ASSISTANT_ENABLED: "true",
    ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5" },
  secrets: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", OPENROUTER_API_KEY: "sk-or-check-not-real" },
});
ownServer(plain.origin);
ownServer(withIt.origin);
let chrome = null;
try {
  await plain.start();
  await withIt.start();
  chrome = await openChrome();
  const pageAs = async (server, who, { width = 390, height = 844, mobile = true } = {}) => {
    const p = await chrome.page({ width, height, mobile, passkeys: false });
    if (who) {
      await p.setCookie(server.origin, "wgp_session", who.jar.cookies.get("wgp_session"));
      await p.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: encodeURIComponent(who.user.id), sameSite: "Lax" });
    }
    return p;
  };
  const ada = new Person(plain.origin, "Ada Reyes");
  await ada.signUp();
  await ada.post("/api/trips", { name: "Porto in November", default_tz: "UTC" });

  section("1. The card, and Delete's line");
  const p = await pageAs(plain, ada);
  await p.goto(`${plain.origin}/account`);
  await p.until(`document.getElementById("yours") && document.getElementById("yours").getBoundingClientRect().height > 80 ? 1 : 0`, "Your account laid out", 20000);
  await sleep(800);
  const card = JSON.parse(await p.eval(`JSON.stringify((() => {
    const y = document.getElementById("yours"), a = document.getElementById("btn-export"), del = document.getElementById("delete-title").closest("section");
    const order = [...document.querySelectorAll(".ac-card")].map((s) => s.id || s.getAttribute("aria-labelledby"));
    const d = new Date(), day = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    return { day, title: document.getElementById("yours-title").textContent, words: document.getElementById("yours-words").textContent, link: a.textContent, href: a.getAttribute("href"), download: a.hasAttribute("download"),
      before: order.indexOf("yours") === order.indexOf("delete-title") - 1, pointer: (document.getElementById("yours-first") || {}).textContent || "", pointerHref: document.querySelector("#yours-first a")?.getAttribute("href"), inDelete: del.contains(document.getElementById("yours-first")) };
  })())`));
  check("its own card, just above Delete: \"What's yours\", the sentence, and a plain \"Download your data\" link that downloads", card.title === "What's yours" && card.link === "Download your data" && card.href === `/api/account/export?day=${card.day}` && card.download && card.before, JSON.stringify(card));
  check("Delete's card points to it", card.inDelete && card.pointer === "Download what's yours first, above." && card.pointerHref === "#yours", JSON.stringify(card));

  section("2. The file, signed in; refused signed out");
  const got = JSON.parse(await p.eval(`fetch(document.getElementById("btn-export").href, { credentials: "same-origin" }).then(async (r) => JSON.stringify({ status: r.status, type: r.headers.get("content-type"), disp: r.headers.get("content-disposition"), body: await r.text() }))`));
  let body = null;
  try { body = JSON.parse(got.body); } catch { body = null; }
  check("the link gives the person signed in a JSON file named for the day, with their own account in it", got.status === 200 && /application\/json/.test(got.type || "") && /attachment; filename="wegoplace-account-\d{4}-\d{2}-\d{2}\.json"/.test(got.disp || "") && !!body && JSON.stringify(body).includes("Ada Reyes"), JSON.stringify({ status: got.status, type: got.type, disp: got.disp }));
  // Late in the evening west of UTC: the page in New York at 20:30, the evening before the server's UTC day.
  // The link carries the day where the person is, and the file is named by it, not by the server's day.
  const utcDay = new Date().toISOString().slice(0, 10);
  const at = Date.parse(`${utcDay}T01:30:00Z`);
  const theirDay = new Date(at - 86400e3).toISOString().slice(0, 10);
  const ny = await pageAs(plain, ada);
  await ny.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
  await ny.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const Real = Date, shift = ${at} - Real.now();
    class Shifted extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + shift); } static now() { return Real.now() + shift; } }
    window.Date = Shifted; })()` });
  await ny.goto(`${plain.origin}/account`);
  await ny.until(`document.getElementById("btn-export") && /day=/.test(document.getElementById("btn-export").getAttribute("href")) ? 1 : 0`, "the link with its day", 20000);
  const late = JSON.parse(await ny.eval(`(async () => { const a = document.getElementById("btn-export"); const r = await fetch(a.href, { credentials: "same-origin" });
    return JSON.stringify({ clock: new Date().toString().slice(0, 24), href: a.getAttribute("href"), disp: r.headers.get("content-disposition") }); })()`));
  check(`in New York at 20:30 on ${theirDay} (the server's day is ${utcDay}), the link carries ${theirDay}`, late.href === `/api/account/export?day=${theirDay}`, JSON.stringify(late));
  check(`  and the file is named by it: wegoplace-account-${theirDay}.json`, new RegExp(`filename="wegoplace-account-${theirDay}\\.json"`).test(late.disp || ""), late.disp);
  await ny.close();
  const out = await pageAs(plain, null);
  await out.goto(`${plain.origin}/login`);
  const refused = await out.eval(`fetch("/api/account/export", { credentials: "same-origin" }).then((r) => r.status)`);
  check("signed out, the same address is refused", refused === 401, String(refused));
  await out.close();

  section("3. The assistant, named only where the site has it");
  check("a site with the plan and without the assistant: \"your account, and your messages and memories on each trip\"", card.words === "Download what's yours: your account, and your messages and memories on each trip.", card.words);
  const deletedOf = (pg) => pg.eval(`document.getElementById("delete-title").closest("section").querySelector(".ac-list-row").innerText.replace(/\\s+/g, " ").trim()`);
  const plainDeleted = await deletedOf(p);
  check("and Delete's list doesn't name it", !/assistant/.test(plainDeleted), plainDeleted);
  const ben = new Person(withIt.origin, "Ben Okafor");
  await ben.signUp();
  const q = await pageAs(withIt, ben);
  await q.goto(`${withIt.origin}/account`);
  await q.until(`!document.getElementById("plan")?.hidden ? 1 : 0`, "the plan card on a site with the assistant", 20000);
  await sleep(500);
  const words2 = await q.eval(`document.getElementById("yours-words").textContent`);
  check("a site with it: \"… and your conversations with the assistant\"", words2 === "Download what's yours: your account, your messages and memories on each trip, and your conversations with the assistant.", words2);
  const withDeleted = await deletedOf(q);
  check("and Delete's list names them among what goes", /your own packing lists, your conversations with the assistant, your memories/.test(withDeleted), withDeleted);
  await q.close();

  section("4. With no signal");
  await p.send("Network.enable");
  await p.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await p.until(`navigator.onLine === false ? 1 : 0`, "offline");
  await p.eval(`(document.getElementById("btn-export").scrollIntoView({ block: "center" }), 1)`);
  await p.click("#btn-export");
  await sleep(400);
  const said = await p.eval(`(() => { const m = document.getElementById("msg-yours"); return m.hidden ? "" : m.textContent; })()`);
  check("the link says it needs signal, in words, and nothing is asked", /Downloading needs signal/.test(said) && (await p.eval("location.pathname")) === "/account", said);
  await p.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await p.close();

  if (SHOTS) {
    section("5. Stills");
    // Read off the PNG's own header: a still smaller than the box it was cut to is no still (16 Nov:
    // three light ones came out 24 to 55 px wide, cut before the cards were laid out).
    const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
    const small = [];
    let made = 0;
    for (const [site, server, who, suffix] of [["with the assistant", withIt, ben, ""], ["without it", plain, ada, "-no-assistant"]]) {
      for (const [tag, size, scale] of [["390", { width: 390, height: 844, mobile: true }, 0], ["320-larger-text", { width: 278, height: 557, mobile: true }, 2.3], ["1440", { width: 1440, height: 900, mobile: false }, 0]]) {
        const s = await pageAs(server, who, size);
        if (scale) await s.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: scale, mobile: true });
        await s.goto(`${server.origin}/account`);
        // Laid out: the card and Delete's card both have their height, and the sentence its words.
        await s.until(`(() => { const y = document.getElementById("yours"), d = document.getElementById("delete-title"); return y && d && y.getBoundingClientRect().height > 80 && d.closest("section").getBoundingClientRect().height > 80 ? 1 : 0; })()`, `Your account laid out (${site}, ${tag})`, 20000);
        if (server === withIt) await s.until(`/assistant/.test(document.getElementById("yours-words").textContent) ? 1 : 0`, "the sentence with the assistant", 10000);
        for (const scheme of ["light", "dark"]) {
          await s.scheme(scheme);
          await sleep(400);
          const r = JSON.parse(await s.eval(`JSON.stringify((() => { const a = document.getElementById("yours").getBoundingClientRect(), b = document.getElementById("delete-title").closest("section").getBoundingClientRect();
            return { x: Math.max(0, Math.min(a.left, b.left) - 12), y: a.top + scrollY - 12, width: Math.min(innerWidth, Math.max(a.right, b.right) - Math.min(a.left, b.left) + 24), height: b.bottom - a.top + 24 }; })())`));
          const { data } = await s.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...r, scale: 1 } });
          const buf = Buffer.from(data, "base64");
          const got = pngSize(buf);
          const ratio = size.mobile ? (scale || 2) : 1;
          if (got.w < Math.floor(r.width * ratio * 0.9) || got.h < Math.floor(r.height * ratio * 0.9) || r.height < 200) small.push(`${tag}-${scheme}${suffix}: ${got.w}×${got.h} for a box of ${Math.round(r.width)}×${Math.round(r.height)}`);
          fs.writeFileSync(path.join(SHOTS, `${tag}-${scheme}-whats-yours${suffix}.png`), buf);
          made++;
        }
        await s.close();
      }
    }
    check("every still is the size of the cards it shows, light and dark (none cut before they were laid out)", small.length === 0 && made === 12, small.join("; ") || `${made} stills`);
  }

} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  await chrome?.close().catch(() => {});
  await plain.stop().catch(() => {});
  await withIt.stop().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);
