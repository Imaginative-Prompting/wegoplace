// The accounts check: sign-up, sign-in, the ways an account signs in, getting back in, signing
// out, deleting, what each kind of visitor may reach, and the two pages' own scripts. It starts its own server on its own
// empty database, with Google, GitHub and email played on this computer, and stops it again.
//
//   node checks/accounts/run.mjs               every part, in order
//   node checks/accounts/run.mjs passkeys trips    only the parts named (a part needs the ones before it)
//   --port <n> (a free one when not named)   --keep (leave the server's folder for reading afterwards)
//
// See README.md beside this file.

import crypto from "node:crypto";
import { startServer, CheckError, freePort } from "../lib/server.mjs";
import { startStandin } from "../lib/standin.mjs";
import { Report } from "../lib/person.mjs";
import { passkeys, trips } from "./passkeys.mjs";
import { providers, paused } from "./providers.mjs";
import { LIMITS_HERE, email, link, limits } from "./back-in.mjs";
import { sessions, deleting } from "./leaving.mjs";
import { pages } from "./pages.mjs";
import { client } from "./client.mjs";
import { who } from "./who.mjs";
import { guests } from "./guests.mjs";

// In order. `paused` restarts the server with new accounts paused, Google off and no email.
const PARTS = { passkeys, trips, pages, client, providers, email, link, guests, who, sessions, deleting, limits, paused };

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? await freePort());
const keep = argv.includes("--keep") ? (argv.splice(argv.indexOf("--keep"), 1), true) : false;
const wanted = argv.length ? argv : Object.keys(PARTS);
for (const name of wanted) if (!PARTS[name]) { console.error(`no part called ${name}; there are: ${Object.keys(PARTS).join(", ")}`); process.exit(2); }

// Made for this run and gone with it: they open nothing anywhere.
const made = () => crypto.randomBytes(24).toString("base64url");
const clients = { google: { id: "check-google-client", secret: made() }, github: { id: "check-github-client", secret: made() } };
const authSecret = made();

const report = new Report("accounts");
let server;
let standin;
let code = 1;
try {
  standin = await startStandin({ port: port + 10, clients });
  server = await startServer({
    name: "accounts", port, keep, email: true,
    vars: { GOOGLE_CLIENT_ID: clients.google.id, GITHUB_CLIENT_ID: clients.github.id, EMAIL_FROM: "account@check.example", AUTH_STANDIN: standin.origin },
    secrets: { GOOGLE_CLIENT_SECRET: clients.google.secret, GITHUB_CLIENT_SECRET: clients.github.secret, AUTH_SECRET: authSecret },
  });
  await server.start();
  const ctx = { server, standin, report, authSecret, clients, people: {} };
  for (const name of wanted) {
    if (name === "limits") {
      // Small limits, so they can be reached however slowly this machine sends (back-in.mjs).
      await server.halt();
      await server.start({ limits: LIMITS_HERE });
    }
    if (name === "paused") {
      await server.halt();
      await server.start({ vars: { SIGNUPS: "paused", GOOGLE_CLIENT_ID: "", EMAIL_FROM: "" }, limits: "configured" });
    }
    await PARTS[name](ctx);
  }
  report.part("The server's log");
  const log = server.log();
  const errors = log.split("\n").filter((line) => /Uncaught|✘|\[ERROR\]|\b500\b/.test(line) && !/signin_error/.test(line));
  report.ok("nothing failed inside the server while the check ran", errors.length === 0, errors.slice(0, 10).join("\n        "));
  const secrets = [clients.google.secret, clients.github.secret, authSecret];
  report.ok("no secret is in its log", !secrets.some((s) => log.includes(s)));
  code = report.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  code = 2;
} finally {
  if (keep && server) console.log(`kept: ${server.work}`);
  await server?.stop();
  await standin?.stop();
}
process.exit(code);
