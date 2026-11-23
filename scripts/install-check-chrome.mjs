// Installs the one browser the browser checks run on: Chrome for Testing at the version scripts/lib/browser.mjs
// pins, for this platform (Mac on Apple Silicon or Intel, Linux x64, Windows x64), under
// ~/.local/share/chrome-for-testing/, outside this tree, so every copy of it finds the same browser.
//
//   node scripts/install-check-chrome.mjs
//
// No installer of Google's runs. It downloads Google's zip from its Chrome for Testing bucket, checks the zip's
// SHA-256 against the one pinned in browser.mjs (CHROME_BUILDS), unpacks it beside where it goes, checks what
// came out (on a Mac: the bundle's id and version, and that it isn't quarantined, which would put a Gatekeeper
// dialog on the screen the first time a check launched it), and only then moves it into place. On Linux and
// Windows, whose files don't say their version, it writes a stamp naming the version and the hash it checked,
// which the launcher requires. Already installed and right: it says so and changes nothing.
//
// Unpacking uses the system's own tool: ditto on a Mac, unzip on Linux, tar on Windows 10 and later.
// To remove it: delete ~/.local/share/chrome-for-testing (browser checks then refuse until it's installed again).
// To move to a new version: change CHROME_VERSION and each build's sha256 in browser.mjs (an empty sha256 makes
// this print the hash it downloaded and stop, for pinning).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CHROME_APP, CHROME_BUILD, CHROME_BUNDLE, CHROME_HOME, CHROME_STAMP, CHROME_VERSION, checkChromeAt, stampFor } from "./lib/browser.mjs";

if (!CHROME_BUILD) {
  console.error(`Google builds Chrome for Testing for Mac, Linux x64 and Windows x64; there's no pinned build for ${process.platform}-${process.arch}.`);
  process.exit(2);
}
if (fs.existsSync(CHROME_APP)) {
  try { checkChromeAt(CHROME_APP); console.log(`Already installed: ${CHROME_APP}`); process.exit(0); } catch (e) {
    console.error(`Something is at ${CHROME_APP} that isn't the pinned build: ${e.message}\nDelete it, then run this again.`);
    process.exit(2);
  }
}

const url = `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${CHROME_BUILD.name}/chrome-${CHROME_BUILD.name}.zip`;
fs.mkdirSync(CHROME_HOME, { recursive: true });
const temp = fs.mkdtempSync(path.join(CHROME_HOME, ".installing-"));
try {
  const zip = path.join(temp, `chrome-${CHROME_BUILD.name}.zip`);
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google's bucket answered ${res.status}`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  const hash = createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
  console.log(`sha256 ${hash}`);
  if (!CHROME_BUILD.sha256) throw new Error("No hash is pinned for this build: pin the one above in browser.mjs's CHROME_BUILDS, then run this again.");
  if (hash !== CHROME_BUILD.sha256) throw new Error(`The zip's hash isn't the pinned one (${CHROME_BUILD.sha256}): nothing installed.`);

  const unpacked = path.join(temp, "unpacked");
  fs.mkdirSync(unpacked);
  if (process.platform === "darwin") execFileSync("/usr/bin/ditto", ["-x", "-k", zip, unpacked]);
  else if (process.platform === "win32") execFileSync("tar", ["-xf", zip, "-C", unpacked]);
  else execFileSync("unzip", ["-q", zip, "-d", unpacked]);
  const folder = path.join(unpacked, `chrome-${CHROME_BUILD.name}`);

  if (process.platform === "darwin") {
    const plist = path.join(folder, "Google Chrome for Testing.app", "Contents/Info.plist");
    const read = (key) => execFileSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], { encoding: "utf8" }).trim();
    if (read("CFBundleIdentifier") !== CHROME_BUNDLE) throw new Error(`Its bundle id is ${read("CFBundleIdentifier")}.`);
    if (read("CFBundleShortVersionString") !== CHROME_VERSION) throw new Error(`It's version ${read("CFBundleShortVersionString")}.`);
    if (execFileSync("/usr/bin/xattr", [path.join(folder, "Google Chrome for Testing.app")], { encoding: "utf8" }).includes("com.apple.quarantine")) throw new Error("It's quarantined.");
  } else {
    const exe = path.join(folder, process.platform === "win32" ? "chrome.exe" : "chrome");
    if (!fs.existsSync(exe)) throw new Error(`The zip has no ${path.basename(exe)}.`);
    fs.writeFileSync(path.join(folder, CHROME_STAMP), stampFor(CHROME_BUILD));
  }

  const home = path.join(CHROME_HOME, CHROME_VERSION);
  fs.mkdirSync(home, { recursive: true });
  fs.renameSync(folder, path.join(home, `chrome-${CHROME_BUILD.name}`));
  checkChromeAt(CHROME_APP);
  console.log(`Installed ${CHROME_APP}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
