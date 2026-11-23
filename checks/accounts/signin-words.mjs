// The sign-in page's passkey button and the note beside it never disagree: the button always says "Continue with a
// passkey" (one way in, whatever the device), and once pressed it waits for the device's own lock (Face ID, Touch ID, a
// fingerprint) only where the browser says this device can hold a passkey by itself; where it can't, it waits for "a
// passkey" and the note says why.
// The note belongs only where a passkey would be made or used: someone already signed in, on a device that can't hold
// one, never sees it on the signed-in page.
// Each case planted in a real browser (the device, by its user agent; the browser's answer, by
// PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable before the page runs):
//
//   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> \
//     --label "sign-in words" -- node checks/accounts/signin-words.mjs [--port <port>]

import { startServer, CheckError } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8846);
const t = new Report("the sign-in page's passkey words");

const DEVICES = {
  iPhone: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1",
  Mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15",
  Android: "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  Windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
};
// What the button waits for on each, pressed, when the device can hold a passkey by itself.
const OWN = { iPhone: "Face ID", Mac: "Touch ID", Android: "your fingerprint", Windows: "a passkey" };
const LOCKS = /Face ID|Touch ID|fingerprint|screen lock/;

const READ = `(() => {
  const b = document.getElementById("btn-signin"), note = document.getElementById("no-platform");
  const page = document.getElementById("page");
  return page && !page.hasAttribute("data-wait") ? { button: b.textContent.trim(), note: !note.hidden && note.getClientRects().length > 0 } : null;
})()`;

let server, chrome, code = 1;
try {
  server = await startServer({ name: "signin-words", port });
  await server.start();
  chrome = await openChrome();
  for (const [device, ua] of Object.entries(DEVICES)) {
    for (const holds of [true, false]) {
      const page = await chrome.page({ width: 390, height: 844, mobile: device === "iPhone" || device === "Android", passkeys: false,
        before: `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(${holds});` });
      await page.send("Emulation.setUserAgentOverride", { userAgent: ua });
      await page.goto(`${server.origin}/login`);
      const seen = await page.until(READ, "the sign-in page drawn");
      t.same(`${device}, ${holds ? "can hold a passkey by itself" : "can't"}: the button, and the note ${holds ? "hidden" : "shown"}`, seen, { button: "Continue with a passkey", note: !holds });
      // Pressed, it waits (no device here answers: the prompt stays open) for the device's own lock, or for "a passkey".
      await page.click("#btn-signin");
      const waiting = await page.until(`(() => { const b = document.getElementById("btn-signin"); return /^Waiting for/.test(b.textContent.trim()) ? b.textContent.trim() : null; })()`, "the button waiting");
      const wants = holds ? `Waiting for ${OWN[device]}…` : "Waiting for a passkey…";
      t.same(`  ${device}: pressed, it waits for ${holds ? OWN[device] : "a passkey"}`, waiting, wants);
      if (!holds) t.ok(`  ${device}: with the note shown, nothing names a lock the device hasn't got`, !LOCKS.test(waiting), waiting);
      await page.close();
    }
  }
  // Signed in, on a device that can't hold a passkey: the signed-in page has no passkey to make or use, so no note.
  const mira = new Person(server.origin, "Mira Made-up");
  if ((await mira.signUp()).status !== 200) throw new CheckError("couldn't make the account");
  const signedIn = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false,
    before: "PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);" });
  await signedIn.setCookie(server.origin, "wgp_session", mira.jar.cookies.get("wgp_session"));
  await signedIn.goto(`${server.origin}/login`);
  const there = await signedIn.until(`(() => { const page = document.getElementById("page"), note = document.getElementById("no-platform");
    return page && !page.hasAttribute("data-wait") && !document.getElementById("p-account").hidden ? { account: true, note: !note.hidden && note.getClientRects().length > 0 } : null; })()`, "the signed-in page");
  t.same("signed in, on a device that can't hold a passkey: the signed-in page, and no passkey note on it", there, { account: true, note: false });
  await signedIn.close();
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await chrome?.close().catch(() => {});
  await server?.stop();
}
process.exit(code);
