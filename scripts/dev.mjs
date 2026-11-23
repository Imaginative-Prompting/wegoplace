#!/usr/bin/env node
// `npm run dev`: the Worker on this machine, kept between runs in .wrangler/state, as wrangler dev runs it, with what
// every local wrangler of ours runs with (checks/lib/server.mjs LOCAL_WRANGLER_ENV: no metrics, no local trace store
// growing about 0.5 GB an hour). On 8788, or the port given: `npm run dev -- --port 8790` (put the same port in
// .dev.vars's PUBLIC_ORIGIN). Workers AI stays off (--local) unless --remote-ai is given. Anything else given goes to
// wrangler dev as it is.

import { spawn } from "node:child_process";
import { LOCAL_WRANGLER_ENV, ROOT, WRANGLER } from "../checks/lib/server.mjs";

const args = process.argv.slice(2);
if (!args.includes("--port")) args.unshift("--port", "8788");
// wrangler.jsonc's Workers AI binding (a PDF's toMarkdown) runs on the Cloudflare account even from wrangler dev: a
// dev server leaves it off (wrangler's own --local, "remote bindings disabled") unless asked with --remote-ai.
const remoteAi = args.indexOf("--remote-ai");
if (remoteAi >= 0) args.splice(remoteAi, 1);
else if (!args.includes("--local") && !args.includes("--remote")) args.push("--local");
const child = spawn(WRANGLER, ["dev", ...args], { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...LOCAL_WRANGLER_ENV } });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
