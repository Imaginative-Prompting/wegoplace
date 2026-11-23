// The secret this checkout's dev server signs session cookies with, for harnesses that mint
// their own cookie (passkeys can't be typed into a headless browser).
//
// It comes from THIS checkout's .dev.vars and nowhere else. Harnesses used to carry one
// folder's secret as a string, so against any other checkout's server every signed request
// came back 401 and the run died on "Failed to fetch dynamically imported module". A secret
// written into a file is also a secret in the repo's history.
//
// NOT ON THE GATE. The gate's server has its own settings and nothing of a developer's, and its
// people sign in with the passkey they signed up with (scripts/lib/gate_trip.mjs), so a check
// on the gate that asks for this secret would pass only in a tree that happens to hold a
// .dev.vars. The gate marks its checks (WGP_GATE) and the asking is refused there, on every
// machine alike. So nothing may ask when it is merely loaded: ask where the cookie is made.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function devSecret() {
  if (process.env.WGP_GATE) {
    throw new Error("A check on the gate asked for the developer's secret (.dev.vars). The gate's server doesn't hold it and "
      + "a tree without that file would fail here: sign a person in through scripts/lib/gate_trip.mjs (signedIn, signInAs).");
  }
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const file = path.join(REPO, ".dev.vars");
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { throw new Error(`No ${file}. The dev server needs it too: echo "AUTH_SECRET=$(openssl rand -hex 32)" > .dev.vars`); }
  const m = /^AUTH_SECRET\s*=\s*["']?([^"'\s]+)["']?\s*$/m.exec(text);
  if (!m) throw new Error(`${file} has no AUTH_SECRET line.`);
  return m[1];
}
