#!/usr/bin/env node
// The site's VAPID keys: the pair push services know this site's notifications by (RFC 8292).
//
//   node tools/vapid-keys.mjs --local <file>   a new pair into <file> (a .dev.vars: VAPID_PUBLIC_KEY and
//                                              VAPID_PRIVATE_KEY), never printed; for a server on this machine
//   node tools/vapid-keys.mjs --put            a new pair set on the deployed Worker with `wrangler secret put`
//                                              (once, when a site is set up; it refuses when the Worker
//                                              already has keys, unless --replace)
//
// Replacing the keys ends every phone's subscription (each has to say yes again), so --put does it once.
// The public key is not secret (every page gets it); it is set as a secret too, so the two never part.

import fs from "node:fs";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const at = argv.indexOf("--local");
const local = at >= 0 ? argv[at + 1] : null;
const put = argv.includes("--put");
const replace = argv.includes("--replace");
if (!local && !put) {
  console.error("Say where: --local <file> (a .dev.vars) or --put (the deployed Worker, with wrangler).");
  process.exit(2);
}

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
const { kty, crv, d, x, y } = await crypto.subtle.exportKey("jwk", pair.privateKey);
const privateJwk = JSON.stringify({ kty, crv, d, x, y });

if (local) {
  const was = fs.existsSync(local) ? fs.readFileSync(local, "utf8") : "";
  if (/^VAPID_(PUBLIC|PRIVATE)_KEY=/m.test(was) && !replace) {
    console.error(`${local} already has VAPID keys; --replace makes new ones (every subscription made with the old ones ends).`);
    process.exit(1);
  }
  const kept = was.split("\n").filter((l) => l && !/^VAPID_(PUBLIC|PRIVATE)_KEY=/.test(l));
  fs.writeFileSync(local, [...kept, `VAPID_PUBLIC_KEY=${publicKey}`, `VAPID_PRIVATE_KEY=${privateJwk}`, ""].join("\n"), { mode: 0o600 });
  console.log(`VAPID keys written to ${local} (not printed). The server reads them when it starts.`);
}

if (put) {
  const list = spawnSync("npx", ["wrangler", "secret", "list"], { encoding: "utf8" });
  if (list.status !== 0) { console.error(`wrangler secret list failed:\n${list.stderr}`); process.exit(1); }
  if (/VAPID_(PUBLIC|PRIVATE)_KEY/.test(list.stdout) && !replace) {
    console.error("The Worker already has VAPID keys. --replace makes new ones, and every phone's subscription ends.");
    process.exit(1);
  }
  for (const [name, value] of [["VAPID_PUBLIC_KEY", publicKey], ["VAPID_PRIVATE_KEY", privateJwk]]) {
    const r = spawnSync("npx", ["wrangler", "secret", "put", name], { input: value, encoding: "utf8" });
    if (r.status !== 0) { console.error(`wrangler secret put ${name} failed:\n${r.stderr}`); process.exit(1); }
    console.log(`${name} set on the Worker.`);
  }
}
