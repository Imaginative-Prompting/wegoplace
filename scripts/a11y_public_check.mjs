#!/usr/bin/env node
/* ACCESSIBILITY, AS axe-core JUDGES IT (scripts/lib/axe.mjs), on the pages a stranger or a new person sees,
 * on a server of its own (the plan and the assistant on, so the assistant's tab is offered), made-up people,
 * at 390 and 1440, light and dark:
 *
 *   sign-in (signed out); Your trips on a new account with Make a trip; Your account; a trip's assistant
 *   tab; and a shared board (a memory posted through the composer, the board shared as a link, the
 *   link opened signed out, as a stranger opens it).
 *
 * Zero serious or critical violations; every finding is printed by screen and rule. What axe can't judge is
 * not claimed. The trip's own screens are a11y_check's.
 *
 *   node scripts/gate.mjs --only a11y_public_check
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";
import { axeOn, blocking, line, AXE_VERSION } from "./lib/axe.mjs";
import { pickPhotos, cdpPage } from "./lib/photo_picker.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 2000) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const server = await startServer({
  name: "a11y-public", port: await freeLoopbackPort(),
  vars: { PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y", ASSISTANT_ENABLED: "true",
    ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5" },
  secrets: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", OPENROUTER_API_KEY: "sk-or-check-not-real" },
});
ownServer(server.origin);
const { boot, evalIn, waitFor, appSettled } = await import("./lib/standalone_cdp.mjs");

// One photograph, made from a picture the tree already carries.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-a11y-"));
const PHOTO = path.join(TMP, "harbor.jpg");
execFileSync("sips", ["-s", "format", "jpeg", "-Z", "1200", path.join(REPO, "public/img/demo-hero.webp"), "--out", PHOTO], { stdio: "ignore" });

let b = null;
try {
  await server.start();
  console.log(`axe-core ${AXE_VERSION}`);
  const ada = new Person(server.origin, "Ada Reyes");
  await ada.signUp();
  const day = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
  const trip = (await ada.post("/api/trips", { name: "Porto in November", default_tz: "UTC", starts_on: day(0), ends_on: day(3) })).json.trip.id;

  b = await boot({ vw: 390, vh: 844, dsf: 2, reduceMotion: true });
  const { cdp, S } = b;
  const page = (expr) => evalIn(cdp, S, expr);
  const evaluate = (expression) => cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, S);
  const wait = (expr, label, timeout = 45000) => waitFor(cdp, S, `${expr} ? 1 : 0`, { label, timeout });
  const signIn = async () => {
    await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: ada.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
    await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: encodeURIComponent(ada.user.id), sameSite: "Lax" }, S);
  };
  const signOut = () => cdp.send("Network.clearBrowserCookies", {}, S);
  const go = async (url, ready, label) => {
    await cdp.send("Page.navigate", { url: "about:blank" }, S);
    await sleep(100);
    await cdp.send("Page.navigate", { url }, S);
    await appSettled(cdp, S).catch(() => {});
    await wait(ready, label);
    await sleep(900);
  };

  // A shared board, once, through the app as a person makes one (the composer, the board's sheet, Share).
  section("A shared board, made");
  await signIn();
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, S);
  await go(`${server.origin}/t/${trip}/?${Date.now()}#/memories`, `document.querySelector(".me-fab")`, "Photos");
  await pickPhotos({ ...cdpPage(cdp, S), files: [PHOTO] });   // Add photos: the phone's picker first, then the sheet
  await wait(`document.querySelectorAll(".me-pickrow").length === 1`, "the picked file");
  await page(`(() => { const i = document.querySelector("#me-cap-in"); i.value = "The harbour at dusk"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
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
  // With a memory, Photos names its add in its head from 768 (+ Add photos), no floating +.
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, S);
  await go(`${server.origin}/t/${trip}/?${Date.now()}#/memories`, `document.querySelector(".me-card")`, "Photos with a memory");
  const named = JSON.parse(await page(`JSON.stringify((() => { const a = document.querySelector("#view .me-headadd"), f = document.querySelector("#rt-fixed .fab");
    return { add: a && getComputedStyle(a).display !== "none" ? a.textContent.trim() : null, fab: !!f && getComputedStyle(f).display !== "none" }; })())`));
  check("1440, Photos with a memory: \"+ Add photos\" named in its head, no floating +", named.add === "+ Add photos" && !named.fab, JSON.stringify(named));

  const all = [];
  for (const [w, h, dsf, mobile] of [[390, 844, 2, true], [1440, 900, 1, false]]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dsf, mobile }, S);
    for (const scheme of ["light", "dark"]) {
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: "reduce" }] }, S);
      const tag = `${w}, ${scheme}`;
      section(tag);
      const found = [];
      const look = async (screen) => { const f = await axeOn(evaluate, `${screen} (${tag})`); found.push(...f); all.push(...f); };

      await signOut();
      await go(`${server.origin}/login`, `document.querySelector("main, form, button")`, "sign-in");
      await look("Sign-in");
      await go(`${server.origin}/s/${shared}`, `document.querySelector("img, video, main")`, "the shared board");
      await look("A shared board (a stranger)");

      await signIn();
      await go(`${server.origin}/trips`, `document.querySelector("#make-title")`, "Your trips");
      await look("Your trips, Make a trip");
      await go(`${server.origin}/account`, `document.getElementById("yours")`, "Your account");
      await look("Your account");
      await go(`${server.origin}/t/${trip}/#/chat/assistant`, `document.querySelector("#view [class^='as-'], #view [class*='assistant'], #view h1, #view h2")`, "the assistant");
      await look("The assistant's tab");

      const bad = found.filter(blocking);
      check(`${tag}: no serious or critical violation on any screen`, bad.length === 0, bad.map(line).join("\n          "));
      const rest = found.filter((f) => !blocking(f));
      console.log(rest.length ? `  moderate and minor (listed, not failed):\n    ${rest.map(line).join("\n    ")}` : "  moderate and minor: none");
    }
  }
  if (process.env.WGP_A11Y_OUT) fs.writeFileSync(process.env.WGP_A11Y_OUT, JSON.stringify(all, null, 1));
  check("no exception reached the page", b.pageErrors.length === 0, b.pageErrors.join(" | ") || "clean");
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  if (b) await b.done();
  await server.stop().catch(() => {});
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);
