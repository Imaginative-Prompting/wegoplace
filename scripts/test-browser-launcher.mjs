#!/usr/bin/env node
// No script here can reach the machine owner's own Chrome, or any browser but the pinned
// Chrome for Testing that scripts/lib/browser.mjs starts.
//
//   node scripts/test-browser-launcher.mjs
//       Reads every code file in the repo (tracked, new, and the ignored build/ folder) and
//       fails if one names his Chrome, starts or attaches to a browser by itself, kills
//       processes by name, hardcodes a dev server, or bypasses the launcher; and holds the
//       launcher to its refusals and to its quiet command line (every switch, feature and the
//       resolver wall that keep the browser from calling anything outside this computer).
//       Starts no browser. Each rule first catches a planted file.
//
//   python3 ~/Documents/GitHub/imaginative-prompting/pipelines/lyric-video/tools/gpu.py run --kind parallel \
//       --who <session> --label "launcher test" -- node scripts/test-browser-launcher.mjs --browser
//       The same, then real launches (sandbox off): the process that runs is Chrome for
//       Testing, headless and muted, on the port from its own profile; macOS lists no new
//       com.google.Chrome; close() leaves no process and no profile, and settles only once its
//       browser has exited (planted: a close() that doesn't wait); and neither does a
//       harness that throws, is interrupted, is terminated or is killed outright. And QUIET,
//       MEASURED: one browser is left up for a minute (on the app's sign-in page when WGP_BASE
//       is given, as in the gate) while every socket of its whole process tree is read twice a
//       second; then its own net log is read. One socket, connection or resolved address
//       outside this computer fails it.
//
// Exit 0 = pass.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CHROME_APP, CHROME_BUNDLE, CHROME_HOME, CHROME_VERSION,
  QUIET_FEATURES, QUIET_FLAGS, QUIET_RESOLVER,
  baseUrl, checkChromeAt, chromeArgs, chromeExecutable, launchChrome, queueOf, sleep,
} from "./lib/browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const LAUNCHER = "scripts/lib/browser.mjs";
const SELF = "scripts/test-browser-launcher.mjs";
const BROWSER = process.argv.includes("--browser");

let pass = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) pass++; else failures.push(name);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
const throws = (fn) => { try { fn(); return ""; } catch (e) { return e.message || String(e); } };
const rejects = async (fn) => { try { await fn(); return ""; } catch (e) { return e.message || String(e); } };

// ── the rules ─────────────────────────────────────────────────────────────────────────────
// Each is a pattern over CODE lines (a comment can't start a browser, so comment lines are
// skipped) with the files it may appear in, and a line planted to show it can fail.

const CODE = /\.(js|mjs|cjs|ts|py|sh|zsh|bash|command)$/;

const RULES = [
  { id: "names his Chrome",
    re: /Google Chrome(?! for Testing)\.app|MacOS\/Google Chrome(?! for Testing)|com\.google\.Chrome(?![.\w])|channel:\s*["'`]chrome|CHROME_PATH|CHROME_BIN|PUPPETEER_EXECUTABLE_PATH|\bexecutablePath\b/,
    allow: [LAUNCHER],
    plant: 'const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";' },
  { id: "names another browser",
    re: /safaridriver|Safari\.app|Firefox\.app|geckodriver|chromedriver|Chromium\.app|Microsoft Edge|Brave Browser|Arc\.app|chrome-headless-shell/,
    allow: [],
    plant: 'spawn("safaridriver", ["-p", "9515"]);' },
  { id: "starts a browser itself",
    re: /--remote-debugging-(port|pipe|address)|--headless\b|--user-data-dir|--no-sandbox/,
    allow: [LAUNCHER],
    plant: 'spawn(bin, ["--headless=new", "--remote-debugging-port=9222", `--user-data-dir=${dir}`]);' },
  { id: "launches through a browser library",
    re: /\bpuppeteer\.launch\b|["'`]playwright(-core)?["'`]|["'`]chrome-launcher["'`]|["'`]selenium-webdriver["'`]|\b(chromium|webkit|firefox)\.launch(PersistentContext)?\b|\.launch\(\s*\{[^}]*\b(headless|channel)\b/,
    allow: [],
    plant: 'const browser = await puppeteer.launch({ headless: "new" });' },
  { id: "opens an app through macOS",
    re: /\bopen\s+-(a|b|n|g|na|ga)\b|\/usr\/bin\/open\b|\bosascript\b|["'`]open["'`]\s*,\s*\[/,
    allow: [],
    plant: 'execSync(`open -a "Safari" ${url}`);' },
  { id: "attaches to a browser on a fixed port",
    re: /(127\.0\.0\.1|localhost):9\d{3}\b|\bCDP_PORT\b|\bSAFARIDRIVER_PORT\b/,
    allow: [],
    plant: 'const v = await (await fetch("http://127.0.0.1:9222/json/version")).json();' },
  { id: "kills processes by name",
    re: /\bpkill\b|\bkillall\b|\bpgrep\b[^\n]*\bkill\b/,
    allow: [LAUNCHER],   // its watcher ends the browser of ONE profile path, minted for that launch
    plant: 'execSync(`pkill -f "user-data-dir=${prefix}"`);' },
  { id: "hardcodes a dev server",
    re: /(127\.0\.0\.1|localhost):87\d\d\b|process\.env\.(ORIGIN|WGP_ORIGIN|WGP_BASE)\b|\bos\.environ(\.get\(|\[)["'](ORIGIN|WGP_ORIGIN|WGP_BASE)["']/,
    allow: [LAUNCHER],
    plant: 'const ORIGIN = process.env.ORIGIN || "http://localhost:8788";' },
  { id: "serves or drives a fixed port",
    re: /\b(const|let|var)\s+\w*PORT\w*\s*=[^;]*\b\d{4,5}\b|\.listen\(\s*\d{4,5}\b|--port[= ]\d{4,5}\b/,
    allow: ["package.json"],   // the root's `dev` script names the port a person runs the server on; no harness reads it
    plant: 'const PORT = Number(process.env.PORT || 8799);' },
  { id: "carries a secret",
    // A value named sha256 is a hash (a download pinned by it, as browser.mjs's CHROME_BUILDS), not a secret.
    re: /(?<!sha256:\s*)["'`][0-9a-f]{64}["'`]/,
    allow: [],
    plant: 'const SECRET = process.env.AUTH_SECRET || "' + "0123456789abcdef".repeat(4) + '";' },
  { id: "names the app's own folder",
    re: /\/Users\/[^/"'`\s]+\/Documents\/GitHub\/wegoplace\b/,
    allow: [],
    plant: 'const REPO = "/Users/someone/Documents/GitHub/wegoplace";' },
];

// A file that speaks the DevTools protocol must get its browser from the launcher, directly or
// through a module it imports.
const SPEAKS_CDP = /Page\.navigate|Runtime\.evaluate|Target\.(createTarget|attachToTarget|getTargets)|\/json\/(version|list|new)\b|webSocketDebuggerUrl|browserWSEndpoint/;
// A dev server's address comes from baseUrl(), never from a string in the file. (A harness that
// serves its own pages builds its address from the port the system gave it: a template, no digits.)
const LITERAL_BASE = /\b(ORIGIN|BASE|BASE_URL|UP|UPSTREAM|HOST_URL)\s*=\s*[^;]*["'`]https?:\/\/[^"'`$]*[\w.-]+(:\d+)?["'`/]/;

function codeLines(text) {
  const out = [];
  let block = false;
  text.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (block) { if (t.includes("*/")) block = false; return; }
    if (t.startsWith("/*")) { if (!t.includes("*/")) block = true; return; }
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("#")) return;
    out.push({ n: i + 1, line });
  });
  return out;
}

function importsOf(file, text) {
  const out = [];
  const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'`](\.{1,2}\/[^"'`]+)["'`]/g;
  let m;
  while ((m = re.exec(text))) out.push(path.normalize(path.join(path.dirname(file), m[1])));
  return out;
}

const rule_allows = (id, file) => RULES.find((r) => r.id === id).allow.includes(file);

/** Every finding in `files` ({ path: text }), as "rule: file:line  text". */
function scan(files) {
  const found = [];
  const reaches = new Map();
  const reachesLauncher = (file, seen = new Set()) => {
    if (file === LAUNCHER) return true;
    if (reaches.has(file)) return reaches.get(file);
    if (seen.has(file) || !(file in files)) return false;
    seen.add(file);
    const ok = importsOf(file, files[file]).some((f) => reachesLauncher(f, seen));
    reaches.set(file, ok);
    return ok;
  };
  for (const [file, text] of Object.entries(files)) {
    if (file === SELF) continue;   // this file is the rules themselves
    const isPackage = path.basename(file) === "package.json";
    if (file.endsWith(".md")) {
      // Prose may tell the history; a command line that runs his Chrome may not stay.
      text.split("\n").forEach((line, i) => {
        if (/Google Chrome(?! for Testing)\.app\/Contents\/MacOS/.test(line)) found.push(`names his Chrome: ${file}:${i + 1}  ${line.trim().slice(0, 100)}`);
      });
      continue;
    }
    if (!CODE.test(file) && !isPackage) continue;
    const lines = isPackage ? text.split("\n").map((line, i) => ({ n: i + 1, line })) : codeLines(text);
    for (const rule of RULES) {
      if (rule.allow.includes(file)) continue;
      for (const { n, line } of lines) {
        if (rule.re.test(line)) found.push(`${rule.id}: ${file}:${n}  ${line.trim().slice(0, 100)}`);
      }
    }
    if (isPackage || file === LAUNCHER) continue;
    const code = lines.map((l) => l.line).join("\n");
    if (SPEAKS_CDP.test(code) && !reachesLauncher(file)) {
      found.push(`drives a browser the launcher didn't start: ${file}  (it speaks the DevTools protocol and never imports ${LAUNCHER})`);
    }
    if (/\blaunchChrome\s*\(/.test(code) && !reachesLauncher(file)) {
      found.push(`drives a browser the launcher didn't start: ${file}  (its launchChrome isn't ${LAUNCHER}'s)`);
    }
    for (const { n, line } of lines) {
      if (/\.(js|mjs|cjs|ts)$/.test(file) && LITERAL_BASE.test(line) && !(rule_allows("hardcodes a dev server", file))) {
        found.push(`hardcodes a dev server: ${file}:${n}  ${line.trim().slice(0, 100)}  (a literal address, not baseUrl())`);
      }
    }
  }
  return found;
}

function repoFiles() {
  const list = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\0").filter(Boolean);
  // build/ is ignored, and a driver living there once ran outside every rule (AGENTS.md).
  const walk = (dir) => {
    let out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out = out.concat(walk(p)); else out.push(path.relative(REPO, p));
    }
    return out;
  };
  if (fs.existsSync(path.join(REPO, "build"))) list.push(...walk(path.join(REPO, "build")));
  const files = {};
  for (const f of new Set(list)) {
    if (f.startsWith("node_modules/") || f.startsWith("public/vendor/")) continue;
    if (!CODE.test(f) && !f.endsWith(".md") && path.basename(f) !== "package.json") continue;
    const full = path.join(REPO, f);
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    files[f] = fs.readFileSync(full, "utf8");
  }
  return files;
}

// ── 1. the rules can fail ────────────────────────────────────────────────────────────────
console.log("\n── planted files: each rule catches its own");
for (const rule of RULES) {
  const got = scan({ "scripts/planted.mjs": `import "./lib/browser.mjs";\n${rule.plant}\n` });
  check(`planted: ${rule.id}`, got.some((g) => g.startsWith(rule.id + ":")), got[0] ?? "nothing found");
}
{
  const cdpAlone = scan({ "scripts/planted.mjs": 'const ws = new WebSocket(url);\nawait send("Page.navigate", { url });\n' });
  check("planted: a script that speaks CDP without the launcher", cdpAlone.some((g) => g.startsWith("drives a browser")), cdpAlone[0] ?? "nothing found");
  const viaHelper = scan({
    "scripts/planted.mjs": 'import { boot } from "./helper.mjs";\nawait send("Page.navigate", { url });\n',
    "scripts/helper.mjs": 'import { launchChrome } from "./lib/browser.mjs";\nexport const boot = () => launchChrome();\n',
  });
  check("control: the same script through a helper that imports the launcher passes", viaHelper.length === 0, viaHelper[0] ?? "");
  const ownLaunch = scan({ "scripts/planted.mjs": 'const launchChrome = (o) => start(o);\nawait launchChrome({});\n' });
  check("planted: a launchChrome that isn't the launcher's", ownLaunch.some((g) => g.startsWith("drives a browser")), ownLaunch[0] ?? "nothing found");
  const literalBase = scan({ "scripts/planted.mjs": 'import "./lib/browser.mjs";\nconst BASE = "http://dev.example:9000";\n' });
  check("planted: a server address written as a literal", literalBase.some((g) => g.startsWith("hardcodes a dev server")), literalBase[0] ?? "nothing found");
  const inComment = scan({ "scripts/planted.mjs": 'import "./lib/browser.mjs";\n// it used to spawn "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new\n' });
  check("control: the history told in a comment passes", inComment.length === 0, inComment[0] ?? "");
  const md = scan({ "docs/planted.md": '```sh\n"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new\n```\n' });
  check("planted: a doc's command line that runs his Chrome", md.length === 1, md[0] ?? "nothing found");
  const pkg = scan({ "package.json": '{ "scripts": { "check": "node x.mjs --remote-debugging-port=9222" } }\n' });
  check("planted: a package.json script that starts a browser", pkg.some((g) => g.startsWith("starts a browser itself")), pkg[0] ?? "nothing found");
  const clean = scan({ "scripts/planted.mjs": 'import { baseUrl, launchChrome } from "./lib/browser.mjs";\nconst ORIGIN = baseUrl();\nconst b = await launchChrome({ args: ["about:blank"] });\nawait b.close();\n' });
  check("control: a harness written the right way passes", clean.length === 0, clean[0] ?? "");
}

// ── 2. the repo ──────────────────────────────────────────────────────────────────────────
console.log("\n── every code file in the repo");
const files = repoFiles();
const findings = scan(files);
const codeCount = Object.keys(files).filter((f) => CODE.test(f)).length;
check(`no file can reach a browser but through the launcher (${codeCount} code files, ${Object.keys(files).length - codeCount} docs read)`,
  findings.length === 0, findings.length ? `${findings.length} finding(s)` : "");
for (const f of findings) console.log("        " + f);
const users = Object.keys(files).filter((f) => f !== LAUNCHER && f !== SELF && /\blaunchChrome\s*\(/.test(files[f]));
// A floor, not a count: 18 since the old dev-server harnesses retired (21 Nov).
check("harnesses do launch through it (the scan isn't reading an empty repo)", users.length >= 15, `${users.length} files call launchChrome`);
for (const rule of RULES) {
  for (const f of rule.allow) {
    if (f === LAUNCHER) continue;
    const still = f in files && codeLines(files[f]).some(({ line }) => rule.re.test(line));
    check(`the exception for ${f} (${rule.id}) is still needed`, still, still ? "" : "remove it from the rule's allow list");
  }
}

// --mute-audio doesn't silence speech synthesis: macOS speaks it outside Chrome.
{
  const speaking = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "vendor") walk(p); continue; }
      if (!/\.(js|mjs|html)$/.test(e.name)) continue;
      if (/speechSynthesis|SpeechSynthesisUtterance/.test(fs.readFileSync(p, "utf8"))) speaking.push(path.relative(REPO, p));
    }
  };
  walk(path.join(REPO, "public"));
  check("the app speaks nothing the mute flag can't silence (no speechSynthesis in public/)", speaking.length === 0,
    speaking.length ? `${speaking.join(", ")}: silence it in ${LAUNCHER} for every page before adding speech` : "");
}

// ── 3. the launcher's refusals (no browser started) ──────────────────────────────────────
console.log("\n── the launcher refuses");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-launcher-test-"));
function fakeApp(name, bundle, version) {
  const app = path.join(TMP, name);
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents/MacOS/Google Chrome for Testing"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundle}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>\n`);
  return app;
}
try {
  const exe = chromeExecutable();
  check("the one browser is the pinned Chrome for Testing", exe.startsWith(CHROME_HOME + path.sep) && exe.includes(CHROME_VERSION) && exe.endsWith("/Google Chrome for Testing"), exe);
  check("chromeExecutable takes no argument", chromeExecutable.length === 0);

  const HIS = "/Applications/Google Chrome.app";
  if (fs.existsSync(HIS)) {
    const why = throws(() => checkChromeAt(HIS));
    check("his own Chrome's app is refused", why !== "", why.slice(0, 90));
  } else {
    console.log("NOTE  /Applications/Google Chrome.app isn't on this machine; the stand-in below covers it");
  }
  // His Chrome, even renamed so its executable has the right file name:
  const disguised = throws(() => checkChromeAt(fakeApp("Disguised.app", "com.google.Chrome", CHROME_VERSION)));
  check("an app with his Chrome's bundle id is refused whatever its files are called", /com\.google\.Chrome\b/.test(disguised) && /not com\.google\.chrome\.for\.testing/.test(disguised), disguised.slice(0, 90));
  const wrongVersion = throws(() => checkChromeAt(fakeApp("Other.app", CHROME_BUNDLE, "1.2.3.4")));
  check("another version of Chrome for Testing is refused", /1\.2\.3\.4/.test(wrongVersion) && /pinned/.test(wrongVersion), wrongVersion.slice(0, 90));
  const control = throws(() => checkChromeAt(fakeApp("Right.app", CHROME_BUNDLE, CHROME_VERSION)));
  check("control: the same stand-in with the right id and version is accepted", control === "", control.slice(0, 90));
  const missing = throws(() => checkChromeAt(path.join(TMP, "Nowhere.app")));
  check("a missing app is refused, with no fallback", /isn't installed/.test(missing) && /never fall back/.test(missing), missing.slice(0, 90));

  // Nothing in the environment can name another browser.
  const envRun = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { chromeExecutable } from ${JSON.stringify(pathToFileURL(path.join(HERE, "lib/browser.mjs")).href)}; console.log(chromeExecutable());`],
    { encoding: "utf8", env: { ...process.env, CHROME_PATH: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      CHROME_BIN: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      PUPPETEER_EXECUTABLE_PATH: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", BROWSER: "google-chrome" } });
  check("no environment variable changes the browser", envRun.status === 0 && envRun.stdout.trim() === exe, envRun.stdout.trim() || envRun.stderr.trim().slice(0, 90));

  // launchChrome's own options: each refused before anything is spawned.
  // Counted among THIS test's own descendants, never across the machine: other sessions run
  // their browser checks beside this one, and a count of every Chrome fails whenever one of
  // theirs starts in these few seconds.
  const before = BROWSER ? chromeProcesses(process.pid) : null;
  for (const [name, options, expect] of [
    ["a path to another browser", { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }, /args.* only/],
    ["a channel", { channel: "chrome" }, /args.* only/],
    ["its own profile", { args: ["--user-data-dir=/tmp/somewhere"] }, /sets --user-data-dir/],
    ["a chosen debugging port", { args: ["--remote-debugging-port=9222"] }, /sets --remote-debugging-port/],
    ["a debugging port open to the network", { args: ["--remote-debugging-address=0.0.0.0"] }, /sets --remote-debugging-address/],
    ["a window on his screen (not headless)", { args: ["--headless=false"] }, /sets --headless/],
    ["no sandbox", { args: ["--no-sandbox"] }, /sets --no-sandbox/],
    ["its own resolver rules (the wall is the launcher's)", { args: ["--host-resolver-rules=MAP * 192.0.2.1"] }, /sets --host-resolver-rules/],
    ["host rules", { args: ["--host-rules=MAP * 192.0.2.1"] }, /sets --host-rules/],
    ["a proxy", { args: ["--proxy-server=192.0.2.1:8080"] }, /sets --proxy-server/],
    ["features turned back on", { args: ["--enable-features=PreconnectToSearch"] }, /sets --enable-features/],
    ["args that aren't strings", { args: [9222] }, /array of strings/],
  ]) {
    const why = await rejects(() => launchChrome(options));
    check(`launchChrome refuses ${name}`, expect.test(why), why.slice(0, 90));
  }
  // Outside the queue: a process with no `gpu.py run` among its parents. The test itself may be
  // running under the queue, so the child is handed to launchd first (its shell exits at once),
  // and it carries the variables the queue's main lane sets, to show they open nothing.
  const outFile = path.join(TMP, "outside.txt");
  spawnSync("/bin/sh", ["-c", 'GPU_WHO=someone GPU_KIND=parallel GPU_LABEL=forged "$0" --input-type=module -e "$1" >/dev/null 2>&1 &', process.execPath,
    `import fs from "node:fs";
     import { launchChrome } from ${JSON.stringify(pathToFileURL(path.join(HERE, "lib/browser.mjs")).href)};
     for (let i = 0; i < 100 && process.ppid !== 1; i++) await new Promise((r) => setTimeout(r, 50));
     let said;
     try { const b = await launchChrome(); await b.close(); said = "LAUNCHED"; } catch (e) { said = "REFUSED " + e.message; }
     const { execFileSync } = await import("node:child_process");
     let kids = "unknown";      // (ps is not allowed inside a command sandbox; the count is only read under --browser)
     try {
       kids = execFileSync("/bin/ps", ["-axo", "ppid=,args="], { encoding: "utf8", maxBuffer: 64 << 20 }).split(String.fromCharCode(10))
         .filter((l) => parseInt(l, 10) === process.pid && l.includes("Google Chrome")).length;
     } catch { /* stays unknown */ }
     fs.writeFileSync(${JSON.stringify(outFile)} + ".part", "ppid " + process.ppid + " " + said + " | chrome children " + kids);
     fs.renameSync(${JSON.stringify(outFile)} + ".part", ${JSON.stringify(outFile)});`]);
  let outside = "";
  for (let i = 0; i < 120 && !outside; i++) { await sleep(250); try { outside = fs.readFileSync(outFile, "utf8"); } catch { /* not written yet */ } }
  // Which machines have a queue (queueOf): this one keeps it whatever the environment says; one with none has none.
  const here = queueOf();
  check("the environment can't take a machine's queue away (WGP_QUEUE pointed nowhere)", here === null || queueOf({ named: "/nowhere/gpu.py" }) === here, String(here));
  check("a machine with no queue has none, so its harnesses launch for themselves (the gate runs them one at a time)",
    queueOf({ home: "/nowhere/gpu.py", named: "/nowhere/either.py" }) === null);
  check("a launch outside the machine's queue is refused, whatever its environment says", /^ppid 1 REFUSED .*gpu\.py run --kind parallel/.test(outside), outside.slice(0, 90) || "the child never answered");
  if (before) {
    const fresh = chromeProcesses(process.pid).filter((p) => !before.includes(p));
    check("none of those refusals started a process", fresh.length === 0 && / \| chrome children 0$/.test(outside),
      `${fresh.length} new under this test; outside the queue: ${(/chrome children \d+$/.exec(outside) || ["not reported"])[0]}`);
  }

  // The base URL.
  const base = (argv, env) => throws(() => baseUrl({ argv, env }));
  check("no base URL is refused (there is no default)", /No base URL/.test(base([], {})), base([], {}).slice(0, 70));
  check("WGP_BASE is taken", baseUrl({ argv: [], env: { WGP_BASE: "http://127.0.0.1:8792" } }) === "http://127.0.0.1:8792");
  check("--base= wins over WGP_BASE, and a trailing slash goes", baseUrl({ argv: ["node", "x", "--base=http://localhost:8791/"], env: { WGP_BASE: "http://127.0.0.1:8792" } }) === "http://localhost:8791");
  for (const [name, url] of [
    ["the live site", "https://wegoplace.com"],
    ["the live site over http with a port", "http://wegoplace.com:8792"],
    ["a host that only starts like localhost", "http://localhost.example.com:8792"],
    ["a host that only starts like 127.0.0.1", "http://127.0.0.1.nip.io:8792"],
    ["another machine on the network", "http://192.168.1.20:8792"],
    ["https on this computer", "https://127.0.0.1:8792"],
    ["an address with no port", "http://127.0.0.1"],
    ["an address with a path", "http://127.0.0.1:8792/app"],
    ["an address with a login", "http://user:pw@127.0.0.1:8792"],
    ["something that isn't a URL", "8792"],
  ]) {
    const why = base([], { WGP_BASE: url });
    check(`base URL refused: ${name}`, why !== "", why.slice(0, 70));
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

// ── 3b. quiet: what the command line must carry ──────────────────────────────────────────
// This test's OWN copy of the list, so a switch taken out of the launcher is a failure here and
// not a list that quietly got shorter. What each is for is told in the launcher.
const MUST_FLAGS = [
  "--disable-background-networking", "--disable-component-update", "--disable-client-side-phishing-detection",
  "--disable-default-apps", "--disable-sync", "--metrics-recording-only", "--no-pings",
  "--disable-domain-reliability", "--disable-breakpad",
];
// And one the command line must NOT carry: it changes the browser's own features (a synthesized
// scroll is refused with it), and stops no request. See the launcher.
const MUST_NOT = ["--disable-field-trial-config"];
const MUST_FEATURES = ["NetworkTimeServiceQuerying", "AutofillServerCommunication", "AimEnabled", "AimServerRequestOnStartupEnabled", "PreconnectToSearch"];
const MUST_WALL = "--host-resolver-rules=MAP www.localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]";
// Every quiet piece missing from a command line (an array of arguments), as words.
function quietMissing(line) {
  const missing = MUST_FLAGS.filter((f) => !line.includes(f));
  const featureSwitches = line.filter((a) => a.startsWith("--disable-features="));
  const off = featureSwitches.length ? featureSwitches[featureSwitches.length - 1].slice("--disable-features=".length).split(",") : [];
  if (featureSwitches.length !== 1) missing.push(`${featureSwitches.length} --disable-features switches (the browser reads only the last)`);
  missing.push(...MUST_FEATURES.filter((f) => !off.includes(f)).map((f) => `feature ${f} not off`));
  if (!line.includes(MUST_WALL)) missing.push("the resolver wall");
  return missing;
}
console.log("\n── quiet: the command line");
{
  const callers = ["--disable-gpu", "--disable-features=Translate,MediaRouter", "--window-size=390,844", "about:blank"];
  const bare = chromeArgs("/tmp/p", []);
  const line = chromeArgs("/tmp/p", callers);
  check("the launcher's lists are the ones held here", QUIET_FLAGS.length === MUST_FLAGS.length && MUST_FLAGS.every((f) => QUIET_FLAGS.includes(f))
    && QUIET_FEATURES.length === MUST_FEATURES.length && MUST_FEATURES.every((f) => QUIET_FEATURES.includes(f)) && `--host-resolver-rules=${QUIET_RESOLVER}` === MUST_WALL,
    `${QUIET_FLAGS.length} switches, ${QUIET_FEATURES.length} features, the wall`);
  check("a bare launch carries every switch, every feature off, and the wall", quietMissing(bare).length === 0, quietMissing(bare).join("; "));
  check("so does a launch whose caller turns features off itself", quietMissing(line).length === 0, quietMissing(line).join("; "));
  const off = line.find((a) => a.startsWith("--disable-features=")).split("=")[1].split(",");
  check("it does not carry the switch that changes the browser's own features", !bare.some((a) => MUST_NOT.includes(a)) && !line.some((a) => MUST_NOT.includes(a)), MUST_NOT.join(" "));
  check("the caller's features are in that one switch too", off.includes("Translate") && off.includes("MediaRouter"), off.join(","));
  check("the caller's other arguments follow, in their order", line.slice(-3).join(" ") === "--disable-gpu --window-size=390,844 about:blank", line.slice(-3).join(" "));
  check("the profile is the one it was given", line.includes("--user-data-dir=/tmp/p"));
  // The check must be able to fail: a command line that lost one piece is caught, each piece in turn.
  const lost = [
    ...MUST_FLAGS.map((f) => [f, bare.filter((a) => a !== f)]),
    ...MUST_FEATURES.map((f) => [`feature ${f}`, bare.map((a) => a.startsWith("--disable-features=") ? a.replace(new RegExp(`${f},?`), "") : a)]),
    ["the wall", bare.filter((a) => !a.startsWith("--host-resolver-rules="))],
    ["a second features switch after the first", [...bare, "--disable-features=Translate"]],
  ];
  const uncaught = lost.filter(([, l]) => quietMissing(l).length === 0).map(([n]) => n);
  check(`control: a command line that lost any one of the ${lost.length} is caught`, uncaught.length === 0, uncaught.join(", "));
}

// ── 4. real launches ─────────────────────────────────────────────────────────────────────
function chromeProcesses(root) {
  // pid + command line of everything running from a Chrome app (his or the pinned one) that
  // `root` started, directly or through a child.
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
  const under = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (under.has(r.ppid) && !under.has(r.pid)) { under.add(r.pid); grew = true; }
  }
  return rows.filter((r) => r.pid !== root && under.has(r.pid) && /Google Chrome/.test(r.args)).map((r) => `${r.pid} ${r.args}`);
}
function hisChromeApps() {
  // What macOS itself lists under his Chrome's bundle id (a headless copy shows up here as a background app).
  try {
    const out = execFileSync("/usr/bin/lsappinfo", ["list"], { encoding: "utf8", maxBuffer: 64 << 20 });
    return out.split(/\n(?=\s*\d+\)\s)/).filter((b) => /bundleID="com\.google\.Chrome"/.test(b)).map((b) => (b.match(/pid = (\d+)/) || [])[1]).filter(Boolean);
  } catch { return null; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// QUIET, MEASURED. How long the browser is left up, and what counts as this computer.
const QUIET_SECONDS = 60;
const isLoopback = (host) => /^(127(\.\d+){3}|::1|localhost)$/i.test(String(host).replace(/^\[|\]$/g, ""));
const hostOfAddress = (a) => { const m = /^\[([^\]]+)\](?::\d+)?$/.exec(a) || /^(\d+(?:\.\d+){3})(?::\d+)?$/.exec(a) || /^(.*?):(?:\d+|\*)$/.exec(a); return m ? m[1] : a; };
function treeOf(root) {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)/.exec(l)).filter(Boolean).map((m) => [Number(m[1]), Number(m[2])]);
  const under = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of rows) if (under.has(ppid) && !under.has(pid)) { under.add(pid); grew = true; }
  }
  return [...under];
}
// Every network socket of those processes, as lsof names them: "TCP 127.0.0.1:5->127.0.0.1:6".
function socketsOf(pids) {
  let out = "";
  try { out = execFileSync("/usr/sbin/lsof", ["-nP", "-i", "-a", "-p", pids.join(",")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 << 20 }); }
  catch (e) { out = (e.stdout && String(e.stdout)) || ""; }      // lsof exits 1 when one of the pids has gone or has no socket
  // A TCP socket with no far end that isn't listening (no state, or CLOSED) has been made and not
  // yet connected: it reaches nothing, and is named so. When it connects, its connection is a line
  // of its own ("local->remote"), judged by where it went. (15 Nov: under a loaded machine a
  // socket caught at second 0 between being made and connecting, "TCP *:51636", was read as a
  // listener on every interface, and the check went red on a browser that stayed home.)
  return out.split("\n").slice(1).map(socketOfLine).filter(Boolean);
}
function socketOfLine(l) {
  const m = /\s(?:IPv4|IPv6)\s+\S+\s+\S+\s+(TCP|UDP)\s+(\S+)(?:\s+\((\w+)\))?/.exec(l);
  if (!m) return null;
  return m[1] === "TCP" && !m[2].includes("->") && m[3] !== "LISTEN" ? `TCP ${m[2]} (not connected)` : `${m[1]} ${m[2]}`;
}
// A net log as the browser writes it: its constants, then "events", one event a line. Whole, it is
// JSON. Cut short (a browser ended before it closed its log) it is read up to its last whole
// event: the constants (the head, before "events"), then each line that is a whole event.
function readNetLog(text) {
  try { return JSON.parse(text); } catch { /* cut short, or not a log */ }
  try {
    const at = text.search(/"events"\s*:\s*\[/);
    if (at < 0) return null;
    const log = JSON.parse(text.slice(0, at) + '"events":[]}');
    for (const line of text.slice(at).split("\n").slice(1)) {
      try { log.events.push(JSON.parse(line.trim().replace(/,$/, ""))); } catch { /* the cut line, or the closing */ }
    }
    return log;
  } catch { return null; }
}
// Is a socket's every end on this computer? A connection is "local->remote", judged by its far
// end; a TCP socket not yet connected reaches nothing; anything else is a listener or a UDP
// socket, judged by the address it is bound to ("*" is every interface: outside).
function socketInside(sock) {
  if (sock.endsWith(" (not connected)")) return true;
  const name = sock.slice(4);
  const [local, remote] = name.split("->");
  return isLoopback(hostOfAddress(remote ?? local));
}
const withProfile = (profile) => execFileSync("/bin/ps", ["-axo", "pid=,args="], { encoding: "utf8", maxBuffer: 64 << 20 })
  .split("\n").filter((l) => l.includes(profile)).map((l) => l.trim());
async function goneWithin(ms, pid, profile) {
  const end = Date.now() + ms;
  for (;;) {
    const left = [alive(pid) ? `pid ${pid} alive` : "", ...withProfile(profile).map((l) => "process " + l.slice(0, 70)), fs.existsSync(profile) ? "profile still on disk" : ""].filter(Boolean);
    if (!left.length) return "";
    if (Date.now() > end) return left.join("; ");
    await sleep(250);
  }
}

console.log("\n── reading lsof: a socket made and not yet connected reaches nothing; a listener on every interface does");
{
  const row = (proto, name, state) => `Google  4242 someone   45u  IPv4 0x1234567890abcdef      0t0  ${proto} ${name}${state ? ` (${state})` : ""}`;
  const cases = [
    [row("TCP", "*:51636", ""), true, "made, not yet connected (15 Nov, second 0 under load)"],
    [row("TCP", "*:51636", "CLOSED"), true, "made and closed, never connected"],
    [row("TCP", "*:51636", "LISTEN"), false, "listening on every interface"],
    [row("TCP", "127.0.0.1:51636", "LISTEN"), true, "listening on this computer (the debugging port)"],
    [row("TCP", "127.0.0.1:51636->127.0.0.1:8791", "ESTABLISHED"), true, "connected to this computer"],
    [row("TCP", "192.168.1.20:51636->192.0.2.10:443", "SYN_SENT"), false, "connecting outside"],
    [row("UDP", "*:5353", ""), false, "a UDP socket on every interface"],
  ];
  for (const [line, inside, what] of cases) {
    const sock = socketOfLine(line);
    check(`lsof: ${what}: ${inside ? "inside" : "outside"}`, !!sock && socketInside(sock) === inside, sock || "not read");
  }
}

if (BROWSER) {
  console.log("\n── real launches");
  const hisBefore = hisChromeApps();
  const b = await launchChrome({ args: ["about:blank"] });
  try {
    const ps = execFileSync("/bin/ps", ["-o", "args=", "-p", String(b.pid)], { encoding: "utf8" }).trim();
    check("the process running is the pinned Chrome for Testing", ps.startsWith(chromeExecutable() + " "), ps.slice(0, 110));
    check("it is headless, muted, and on a port it chose", / --headless=new /.test(ps + " ") && / --mute-audio /.test(ps + " ") && / --remote-debugging-port=0 /.test(ps + " "), "");
    check("its profile is the one minted for this launch", ps.includes(`--user-data-dir=${b.profile}`) && fs.existsSync(path.join(b.profile, "DevToolsActivePort")), b.profile);
    const written = fs.readFileSync(path.join(b.profile, "DevToolsActivePort"), "utf8").split("\n");
    check("the port and websocket are the ones in that profile's DevToolsActivePort", Number(written[0]) === b.port && b.wsUrl === `ws://127.0.0.1:${b.port}${written[1].trim()}`, `port ${b.port}`);
    const version = await (await fetch(`${b.origin}/json/version`)).json();
    check("the browser on that port says it is that version", String(version.Browser).includes(CHROME_VERSION), version.Browser);
    check("it answers only on this computer", (await rejects(() => fetch(`http://${Object.values(os.networkInterfaces()).flat().find((i) => i.family === "IPv4" && !i.internal)?.address ?? "192.0.2.1"}:${b.port}/json/version`, { signal: AbortSignal.timeout(1500) }))) !== "", "");
    const target = await b.pageTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("no websocket")); });
    const answer = await new Promise((res) => {
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) res(m.result?.result?.value); };
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "navigator.userAgent + ' | ' + (6 * 7)", returnByValue: true } }));
    });
    ws.close();
    check("its page can be driven", /\| 42$/.test(String(answer)), String(answer).slice(0, 110));
    const hisAfter = hisChromeApps();
    if (hisBefore && hisAfter) {
      const fresh = hisAfter.filter((p) => !hisBefore.includes(p));
      check("macOS lists no new app under his Chrome's bundle id", fresh.length === 0, fresh.length ? `new pid(s) ${fresh.join(", ")}` : `${hisAfter.length} before and after`);
    } else {
      check("macOS lists no new app under his Chrome's bundle id", false, "lsappinfo couldn't be read (run with the sandbox off)");
    }
  } finally {
    await b.close();
  }
  const left = await goneWithin(3000, b.pid, b.profile);
  check("close() leaves no process and no profile", left === "", left);

  // close() settles only once its browser has exited: looked at the moment it settles, with its
  // throw swallowed as a harness's .catch(() => {}) does, the pid is gone and so is the profile.
  // PLANTED in the same run: a copy of the launcher whose close() doesn't wait for the exit. The
  // same look must find its browser still running.
  {
    const settle = async (launch) => {
      const x = await launch({ args: ["about:blank"] });
      await x.pageTarget();
      let threw = "";
      await x.close().catch((e) => { threw = e.message || String(e); });
      return { x, threw, running: alive(x.pid), profile: fs.existsSync(x.profile) };
    };
    const exited = (r) => !r.threw && !r.running && !r.profile;
    const said = (r) => [r.running ? `pid ${r.x.pid} still running` : `pid ${r.x.pid} gone`, r.profile ? "its profile on disk" : "its profile removed", r.threw ? `close() threw: ${r.threw.slice(0, 120)}` : "close() resolved"].join("; ");
    const real = await settle(launchChrome);
    check("close() settles only once its browser has exited (the pid gone and the profile removed as it settles)", exited(real), said(real));
    const WAIT = /const waitGone = async \(ms\) => \{[^\n]*\};/;
    const source = fs.readFileSync(path.join(HERE, "lib/browser.mjs"), "utf8");
    if (!WAIT.test(source)) {
      check("  (planted: a close() that doesn't wait is caught)", false, "close()'s wait isn't where the plant looks for it");
    } else {
      const planted = path.join(fs.realpathSync(os.tmpdir()), `wgp-launcher-nowait-${process.pid}.mjs`);
      fs.writeFileSync(planted, source.replace(WAIT, "const waitGone = async () => {};"));
      try {
        const { launchChrome: launchPlanted } = await import(pathToFileURL(planted).href);
        const p = await settle(launchPlanted);
        check("  (planted: a close() that doesn't wait is caught: its browser still running as it settles)", !exited(p) && p.running, said(p));
        // Then the planted browser is ended, and a second close(), now that it has exited, removes
        // its profile and its watcher.
        p.x.killSync();
        for (let i = 0; i < 100 && alive(p.x.pid); i++) await sleep(100);
        await sleep(300);
        const again = await p.x.close().then(() => "", (e) => e.message || String(e));
        const still = await goneWithin(5000, p.x.pid, p.x.profile);
        check("  (and the planted browser is ended afterwards, its profile removed)", again === "" && still === "", again || still || `pid ${p.x.pid} gone, profile removed`);
      } finally {
        fs.rmSync(planted, { force: true });
      }
    }
  }

  // QUIET, MEASURED. One browser, left up on a page, with its own net log written.
  console.log(`\n── quiet, measured: ${QUIET_SECONDS} s`);
  {
    const page = process.env.WGP_BASE ? `${baseUrl()}/login` : "about:blank";
    const netlog = path.join(os.tmpdir(), `wgp-launcher-netlog-${process.pid}.json`);
    const q = await launchChrome({ args: ["--disable-features=Translate,MediaRouter", `--log-net-log=${netlog}`, page] });
    const seen = new Map();          // socket -> [first second, last second]
    let samples = 0, processes = 0, loaded = "";
    try {
      const live = execFileSync("/bin/ps", ["-o", "args=", "-p", String(q.pid)], { encoding: "utf8", maxBuffer: 16 << 20 }).trim();
      // The live command line, split where a switch or the page begins (the wall's value has spaces in it).
      const liveArgs = live.slice(live.indexOf(" --headless=new") + 1).split(/ (?=--|about:|https?:)/);
      check("the browser that is running carries every quiet piece", quietMissing(liveArgs).length === 0, quietMissing(liveArgs).join("; ") || `${liveArgs.length} arguments`);
      const t0 = Date.now();
      while (Date.now() - t0 < QUIET_SECONDS * 1000) {
        const pids = treeOf(q.pid);
        processes = Math.max(processes, pids.length);
        const at = Math.round((Date.now() - t0) / 1000);
        for (const sock of socketsOf(pids)) { const e = seen.get(sock); if (e) e[1] = at; else seen.set(sock, [at, at]); }
        samples++;
        if (!loaded && process.env.WGP_BASE && Date.now() - t0 > 3000) {
          const list = await (await fetch(`${q.origin}/json/list`)).json();
          const t = list.find((x) => x.type === "page");
          loaded = t ? `${t.url} “${t.title}”` : "no page";
        }
        await sleep(500);
      }
    } finally {
      await q.close();
    }
    const sockets = [...seen.keys()];
    const outsideSockets = sockets.filter((x) => !socketInside(x));
    check("the sampling sees the browser's sockets (its debugging port among them)", sockets.some((x) => x === `TCP 127.0.0.1:${q.port}`),
      sockets.length ? `${sockets.length} sockets over ${samples} samples of up to ${processes} processes` : "lsof showed nothing: run with the sandbox off");
    check(`for ${QUIET_SECONDS} s no socket of its process tree reaches outside this computer`, sockets.length > 0 && outsideSockets.length === 0,
      outsideSockets.map((x) => `${x} (${seen.get(x).join("–")} s)`).join("; ").slice(0, 400) || `${sockets.length} sockets, all on this computer`);

    // The net log is read once it is whole: the browser's tree gone, and the file no longer
    // growing. On a loaded machine close() can end a browser that hasn't finished exiting in
    // 3 s with SIGKILL, and its log stops mid-line; such a log is read up to its last whole
    // event (below). (15 Nov: read as it was still being written, a 2.7 MB log gave 0 events.)
    await goneWithin(10000, q.pid, q.profile);
    let text = "";
    for (let size = -1, i = 0; i < 40; i++) {
      let now = -1;
      try { now = fs.statSync(netlog).size; } catch { /* not there: checked below */ }
      if (now === size && now >= 0) break;
      size = now;
      await sleep(250);
    }
    try { text = fs.readFileSync(netlog, "utf8"); } catch { /* checked below */ }
    fs.rmSync(netlog, { force: true });
    // The net log, event by event. An address outside this computer fails it wherever it is:
    // a connection tried or made, or a name resolved. ONE thing is let through and named: a
    // UDP socket pointed at an address with nothing sent on it. That is how the browser asks
    // the system whether IPv6 has a route (pointing a UDP socket sends no packet); it does so
    // whenever it resolves a name, "localhost" included, and has no switch.
    let events = [], types = {}, sources = {};
    const whole = readNetLog(text), cut = readNetLog(text.slice(0, Math.floor(text.length * 0.6)));
    // The property, not a size: the cut log's events are the whole log's first ones, each the same, and some of
    // them (15 Nov's bug read none). A short log (a browser with little to do, as one from a fresh home) has
    // most of its first 60% in its constants, and few events there.
    const samePrefix = !!cut && !!whole && cut.events.every((e, i) => JSON.stringify(e) === JSON.stringify(whole.events[i]));
    check("a net log cut mid-line is read up to its last whole event (as one ended by SIGKILL is)", !!cut && cut.events.length > 0 && !!whole && cut.events.length < whole.events.length && samePrefix,
      `${cut ? cut.events.length : "unreadable"} of ${whole ? whole.events.length : "unreadable"} events from the first 60% of the log`);
    try {
      const log = whole;
      events = log.events || [];
      for (const [k, v] of Object.entries(log.constants.logEventTypes)) types[v] = k;
      for (const [k, v] of Object.entries(log.constants.logSourceType)) sources[v] = k;
    } catch { /* an unreadable log fails "written and read" below */ }
    const bySource = new Map();      // source id -> { kind, addresses:Set, sent:boolean }
    const resolved = new Set();
    for (const e of events) {
      const src = e.source || {};
      const row = bySource.get(src.id) || { kind: sources[src.type] || "?", addresses: new Set(), sent: false };
      bySource.set(src.id, row);
      if (/BYTES_SENT/.test(types[e.type] || "")) row.sent = true;
      const params = e.params || {};
      for (const key of ["address", "remote_address"]) if (typeof params[key] === "string") row.addresses.add(params[key]);
      for (const a of Array.isArray(params.address_list) ? params.address_list : []) resolved.add(String(a));
      const walk = (v) => {          // endpoint addresses sit inside nested results
        if (!v || typeof v !== "object") return;
        for (const [k, x] of Object.entries(v)) { if (k === "endpoint_address" && typeof x === "string") resolved.add(x); else walk(x); }
      };
      walk(params);
    }
    const outsideOf = (set) => [...set].filter((a) => !isLoopback(hostOfAddress(a)));
    const reached = [], pointed = new Set();
    let addressCount = resolved.size;
    for (const row of bySource.values()) {
      addressCount += row.addresses.size;
      for (const a of outsideOf(row.addresses)) {
        if (/^UDP_(CLIENT_)?SOCKET$/.test(row.kind) && !row.sent) pointed.add(a);
        else reached.push(`${row.kind} ${a}`);
      }
    }
    const outsideAddresses = [...new Set([...reached, ...outsideOf(resolved).map((a) => `resolved ${a}`)])];
    if (process.env.WGP_BASE) {
      check("the app's page loaded under the wall", loaded.startsWith(page) && !/“(localhost|127\.0\.0\.1)?”$/.test(loaded) && text.includes(`"url":"${page}`), loaded || "never read");
    }
    check("its net log was written and read", events.length > 100, `${text.length} bytes, ${events.length} events`);
    check("its net log has no connection and no resolved address outside this computer", events.length > 100 && outsideAddresses.length === 0,
      outsideAddresses.slice(0, 8).join(", ") || `${addressCount} addresses, all on this computer`);
    console.log(`  note  UDP sockets pointed at an address with nothing sent (the IPv6 route probe): ${[...pointed].sort().join(", ") || "none"}`);
    // What the browser still ASKS for by name, for the record. With the wall standing each ask
    // ends there (the checks above are what prove nothing left this computer).
    const asked = new Set();
    for (const m of text.matchAll(/"url":"(?:https?|wss?):\/\/([^"\/:]+)/g)) if (!isLoopback(m[1])) asked.add(m[1]);
    console.log(`  note  names outside this computer it still asked for (each ends at the wall): ${[...asked].sort().join(", ") || "none"}`);
  }

  // A harness that doesn't get to close(): the browser must still go, with its profile.
  // How long the slowest child so far took to bring its browser up. The whole-run ceiling below
  // has to leave room for that: on a machine under load a launch alone has taken over 4 s, and
  // a ceiling shorter than the launch ends the child before it has a browser to report.
  let slowestLaunch = 0;
  const child = (ending, env = {}) => new Promise((resolve) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", `
      import { launchChrome } from ${JSON.stringify(pathToFileURL(path.join(HERE, "lib/browser.mjs")).href)};
      const b = await launchChrome({ args: ["about:blank"] });
      await b.pageTarget();
      console.log(JSON.stringify({ pid: b.pid, profile: b.profile }));
      ${ending}
    `], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let out = "", info = null;
    const born = Date.now();
    c.said = "";
    c.stderr.on("data", (d) => { c.said += d; });
    c.stdout.on("data", (d) => {
      out += d;
      if (!info && out.includes("\n")) { try { info = JSON.parse(out.split("\n")[0]); } catch { /* not yet */ } if (info) { slowestLaunch = Math.max(slowestLaunch, Date.now() - born); resolve({ c, info }); } }
    });
    c.on("exit", () => { if (!info) resolve({ c, info: null }); });
  });
  for (const [name, ending, signal] of [
    ["throws", 'throw new Error("the harness broke");', null],
    ["calls process.exit", "process.exit(3);", null],
    ["is interrupted (SIGINT)", "await new Promise(() => setInterval(() => {}, 1000));", "SIGINT"],
    ["is terminated (SIGTERM)", "await new Promise(() => setInterval(() => {}, 1000));", "SIGTERM"],
    ["is killed outright (SIGKILL)", "await new Promise(() => setInterval(() => {}, 1000));", "SIGKILL"],
  ]) {
    const { c, info } = await child(ending);
    if (!info) { check(`a harness that ${name} leaves no browser`, false, "the child never launched one"); continue; }
    const ran = alive(info.pid) || signal === null;   // for the signalled ones, the browser is up until we signal
    if (signal) c.kill(signal);
    await new Promise((res) => (c.exitCode !== null || c.signalCode !== null ? res() : c.on("exit", res)));
    const still = await goneWithin(8000, info.pid, info.profile);
    check(`a harness that ${name} leaves no browser and no profile`, ran && still === "", still || (ran ? "" : "its browser wasn't running before the signal"));
  }

  // Ceilings: a call the browser never answers, and a harness that just keeps going, both end
  // loudly, with the call's name, and leave no browser.
  const runCeiling = () => Math.max(4, Math.ceil((slowestLaunch * 3) / 1000));
  const ASK = `
      const t = await b.pageTarget();
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((res) => { ws.onopen = res; });
      const call = (id, expression, awaitPromise) => new Promise((res) => {
        ws.addEventListener("message", (e) => { if (JSON.parse(e.data).id === id) res(); });
        ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise } }));
      });
      await call(1, "6 * 7", false);`;
  for (const [name, ending, envOf, expectOf] of [
    ["sends a call the browser never answers", `${ASK}
 await call(2, "new Promise(() => {})", true);`,
      () => ({ WGP_CALL_CEILING_S: "4" }), () => /DEVTOOLS CALL NEVER ANSWERED: Runtime\.evaluate, sent \d+ s ago \(ceiling WGP_CALL_CEILING_S=4\)/],
    // The run's clock starts when the launcher loads, before the browser is up: three times
    // the slowest launch seen in this run, and never under 4 s.
    ["never finishes", `${ASK}
 await new Promise(() => setInterval(() => {}, 1000));`,
      () => ({ WGP_RUN_CEILING_S: String(runCeiling()) }),
      () => new RegExp(`HARNESS STILL RUNNING after \\d+ s \\(ceiling WGP_RUN_CEILING_S=${runCeiling()}\\)\\. No DevTools call is waiting; the last ones sent: Runtime\\.evaluate`)],
  ]) {
    const t0 = Date.now();
    const env = envOf(), expect = expectOf();
    const wait = (Number(env.WGP_RUN_CEILING_S || 0) + 30) * 1000;
    const { c, info } = await child(ending, env);
    if (!info) { check(`a harness that ${name} is ended at its ceiling`, false, "the child never launched a browser"); continue; }
    const code = await Promise.race([
      new Promise((res) => (c.exitCode !== null ? res(c.exitCode) : c.on("exit", (x) => res(x)))),
      sleep(wait).then(() => "still running"),
    ]);
    if (code === "still running") c.kill("SIGKILL");
    const still = await goneWithin(8000, info.pid, info.profile);
    check(`a harness that ${name} is ended at its ceiling, with exit 124 and the call's name`,
      code === 124 && expect.test(c.said) && still === "",
      `exit ${code} after ${Math.round((Date.now() - t0) / 1000)} s; ${still || "no browser, no profile"}; said: ${c.said.trim().split("\n")[0].slice(0, 110)}`);
  }
  {
    // An answered call is forgotten: a harness that answers quickly and then works for longer
    // than the call ceiling is not ended by it.
    const { c, info } = await child(`${ASK}
 await new Promise((r) => setTimeout(r, 7000)); await b.close(); process.exit(0);`, { WGP_CALL_CEILING_S: "3" });
    const code = info ? await new Promise((res) => (c.exitCode !== null ? res(c.exitCode) : c.on("exit", (x) => res(x)))) : "never launched";
    check("a call that was answered is not held against the harness", code === 0, `exit ${code} ${c.said.trim().slice(0, 90)}`);
  }

  await sleep(1500);
  const watchers = execFileSync("/bin/ps", ["-axo", "pid=,args="], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n")
    .filter((l) => l.includes("wgp-browser-watcher") && l.includes(` ${process.pid} `));
  check("no watcher process outlives its launch", watchers.length === 0, watchers.join(" | ").slice(0, 110));
} else {
  console.log("\nNOTE  no browser started. Add --browser (through gpu.py, sandbox off) for the real launches.");
}

// ── every local wrangler: no trace store ──────────────────────────────────────────────────
// wrangler dev keeps every request's trace under <state>/v3/observability/ unless X_LOCAL_OBSERVABILITY is "false",
// about 0.5 GB an hour while it runs (16 Nov). Every place this repository starts one passes LOCAL_WRANGLER_ENV
// (checks/lib/server.mjs) or the setting itself; a started server's own process carries it, and its state keeps no
// trace store. Planted: a start without it in the text, and a wrangler dev started without it, whose store appears.
{
  const { LOCAL_WRANGLER_ENV, startServer, freePort, WRANGLER, ROOT: REPO_ROOT } = await import("../checks/lib/server.mjs");
  check("LOCAL_WRANGLER_ENV turns the local trace store off", LOCAL_WRANGLER_ENV.X_LOCAL_OBSERVABILITY === "false");
  // A start: wrangler (by its binary or through npx) with dev, or pages dev, among its first arguments.
  const START = /spawn(?:Sync)?\(\s*(?:WRANGLER|"npx")\s*,\s*\[\s*(?:"wrangler",\s*)?(?:"pages",\s*)?"dev"/;
  const keepsNoTraces = (text) => !START.test(text) || /LOCAL_WRANGLER_ENV|X_LOCAL_OBSERVABILITY: "false"/.test(text);
  const starters = [];
  for (const dir of ["scripts", "checks", "tools"]) {
    for (const f of fs.readdirSync(path.join(REPO_ROOT, dir), { recursive: true })) {
      const p = path.join(dir, f);
      if (!/\.(m?js|cjs)$/.test(p) || p === "scripts/test-browser-launcher.mjs") continue;
      const text = fs.readFileSync(path.join(REPO_ROOT, p), "utf8");
      if (START.test(text)) starters.push([p, keepsNoTraces(text)]);
    }
  }
  // The two that must always be found (npm run dev's and every check's): the search finding them is what says it works.
  const MUST = ["scripts/dev.mjs", "checks/lib/server.mjs"];
  check(`every place that starts a local wrangler dev runs it with no trace store (${starters.map(([p]) => p).join(", ")})`,
    MUST.every((m) => starters.some(([p]) => p === m)) && starters.every(([, ok]) => ok),
    [...MUST.filter((m) => !starters.some(([p]) => p === m)).map((m) => `${m} not found`), ...starters.filter(([, ok]) => !ok).map(([p]) => p)].join(", "));
  check("npm run dev starts it through scripts/dev.mjs (with LOCAL_WRANGLER_ENV)",
    JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).scripts.dev === "node scripts/dev.mjs" && keepsNoTraces(fs.readFileSync(path.join(REPO_ROOT, "scripts/dev.mjs"), "utf8")));
  check("  (planted: a start without it is caught)", !keepsNoTraces('const c = spawn(WRANGLER, ["dev", "--port", "1"], { env: process.env });'));

  // A check server, started as every check starts one: its own process carries the setting, and after a request its
  // state holds no trace store.
  const store = (state) => fs.existsSync(path.join(state, "v3/observability/miniflare-wobs-trace-store"))
    && fs.readdirSync(path.join(state, "v3/observability/miniflare-wobs-trace-store"), { recursive: true }).length > 0;
  // Free ports, never fixed ones: two gates side by side reach this row together (21 Nov: a fixed port refused one).
  const tracePort = await freePort();
  const server = await startServer({ name: "launcher-traces", port: tracePort });
  try {
    await server.start();
    for (let i = 0; i < 5; i++) await fetch(`${server.origin}/login`).then((r) => r.text()).catch(() => {});
    const record = JSON.parse(fs.readFileSync(path.join(server.state, "..", "server.pid"), "utf8"));
    const envOf = execFileSync("/bin/ps", ["eww", "-o", "command=", "-p", String(record.pid)], { encoding: "utf8" });
    check("a started check server's process runs with X_LOCAL_OBSERVABILITY=false", /\bX_LOCAL_OBSERVABILITY=false\b/.test(envOf), envOf.slice(0, 80));
    check("  and after its requests, its state keeps no trace store", !store(server.state));
  } finally {
    await server.stop().catch(() => {});
  }
  // The plant: wrangler dev started without the setting, on its own state: its store appears.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-traces-"));
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };
  delete env.X_LOCAL_OBSERVABILITY;
  const plantPort = await freePort({ avoid: [tracePort] });
  const child = spawn(WRANGLER, ["dev", "--port", String(plantPort), "--ip", "127.0.0.1", "--inspector-port", String(plantPort + 1000), "--persist-to", bare, "--show-interactive-dev-session=false"],
    { cwd: REPO_ROOT, env, detached: true, stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { await sleep(1000); up = await fetch(`http://127.0.0.1:${plantPort}/login`).then(() => true).catch(() => false); }
    for (let i = 0; i < 5; i++) await fetch(`http://127.0.0.1:${plantPort}/login`).then((r) => r.text()).catch(() => {});
    await sleep(1500);
    check("  (planted: wrangler dev started without it keeps a trace store, which is why every start has it)", up && store(bare), up ? "" : "never came up");
  } finally {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
    await sleep(1500);
    fs.rmSync(bare, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log("failed:\n  " + failures.join("\n  ")); process.exit(1); }
