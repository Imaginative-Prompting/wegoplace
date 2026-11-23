#!/usr/bin/env node
/* Stills of the pages a friend sees when joining by link: the join page signed out (a name and
 * Join), the sign-in page as Lexicommons lays it out, with and without Google and GitHub set up,
 * and its fold open. A made-up trip and made-up people, on a server of its own (an empty
 * database, removed afterwards).
 *
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> --label <what> -- node scripts/guest_stills.mjs <outDir>
 *
 * Chrome needs the Bash sandbox disabled; the launcher (scripts/lib/browser.mjs) starts it.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { openChrome } from "../checks/lib/chrome.mjs";
import { openMaking } from "../checks/lib/signin-page.mjs";
import { freeLoopbackPort } from "./lib/browser.mjs";

const out = path.resolve(process.argv[2] || "");
if (!process.argv[2]) { console.error("usage: node scripts/guest_stills.mjs <outDir>"); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

const day = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date(Date.now() + d * 86400e3));
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";
const SIZES = [["390", 390, 844], ["320", 320, 568]];
const shots = [];

async function still(page, name) {
  await page.settle();
  const file = path.join(out, `${name}.png`);
  await page.shot(file);
  shots.push(name);
  console.log(`  still ${name}.png`);
}

async function run({ providers }) {
  const vars = providers ? { GOOGLE_CLIENT_ID: "stills-google.apps.example", GITHUB_CLIENT_ID: "stills-github" } : {};
  const secrets = providers ? { GOOGLE_CLIENT_SECRET: "stills-secret", GITHUB_CLIENT_SECRET: "stills-secret" } : {};
  const server = await startServer({ name: `guest-stills-${providers ? "ways" : "plain"}`, port: await freeLoopbackPort(), vars, secrets });
  let chrome = null;
  try {
    await server.start();
    const host = new Person(server.origin, "Mara Voss");
    await host.signUp();
    const made = await host.post("/api/trips", { name: "Coast week", default_tz: "Europe/Lisbon", starts_on: day(10), ends_on: day(16), currencies: ["EUR"] });
    if (made.status !== 201) throw new Error(`the trip wasn't made: ${made.status} ${made.text.slice(0, 200)}`);
    const link = (await host.post(`/api/trips/${made.json.trip.id}/links`, {})).json.link;
    chrome = await openChrome();
    const tag = providers ? "with-google-github" : "passkey-only";
    for (const [w, width, height] of SIZES) {
      for (const scheme of w === "390" ? ["light", "dark"] : ["light"]) {
        // An iPhone that holds passkeys (Face ID), as a friend's phone would be: the page names it.
        const page = await chrome.page({ width, height, mobile: true, passkeys: false,
          before: "PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(true);" });
        await page.send("Emulation.setUserAgentOverride", { userAgent: IPHONE });
        await page.scheme(scheme);
        if (!providers) {
          await page.goto(`${server.origin}/join/${link.code}`);
          await page.until(`!document.getElementById("page").hasAttribute("data-wait") && !document.getElementById("as-visitor").hidden`, "the join page, signed out");
          await still(page, `join-signed-out-${w}-${scheme}`);
          if (w === "390") {
            await page.type("#guest-name", "Ana Reyes");
            await page.eval(`document.activeElement.blur()`);
            await still(page, `join-name-typed-${w}-${scheme}`);
          }
        }
        await page.goto(`${server.origin}/login`);
        await page.until(`!document.getElementById("page").hasAttribute("data-wait") && !document.getElementById("p-signin").hidden`, "the sign-in page");
        await still(page, `signin-${tag}-${w}-${scheme}`);
        if (w === "390" && scheme === "light") {
          // After "Continue with a passkey" with none here: the account's making open under the buttons.
          await openMaking(page);
          await page.eval(`document.activeElement.blur()`);
          await still(page, `signin-${tag}-making-${w}-${scheme}`);
        }
        if (page.errors.length) console.log(`  page errors (${tag} ${w} ${scheme}): ${JSON.stringify(page.errors).slice(0, 400)}`);
        await page.close();
      }
    }
  } finally {
    if (chrome) await chrome.close();
    await server.stop();
  }
}

let code = 1;
try {
  await run({ providers: false });
  await run({ providers: true });
  console.log(`\n${shots.length} stills in ${out}`);
  code = 0;
} catch (e) {
  console.error(`FAILED: ${e?.stack || e}`);
}
process.exit(code);
