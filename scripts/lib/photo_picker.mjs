// For checks that add photos as a phone does: pickPhotos (driven in the launcher's own module, scripts/lib/browser.mjs:
// a tap opens the phone's picker, answered with the check's files, then the one Add photos sheet opens), madePhoto() (a
// made-up photo to answer it with: a small JPEG in a temp folder of its own, removed when the check ends) and cdpPage()
// (pickPhotos' send and on for a standalone_cdp session).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JPEG } from "../../checks/lib/images.mjs";
export { pickPhotos } from "./browser.mjs";

let made = null;
export function madePhoto() {
  if (made) return made;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-photo-"));
  made = path.join(dir, "made-up.jpg");
  fs.writeFileSync(made, JPEG);
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return made;
}

/** pickPhotos' `send` and `on` for a standalone_cdp page (its one connection carries every session: keep to S). */
export const cdpPage = (cdp, S) => ({
  send: (method, params) => cdp.send(method, params, S),
  on: (fn) => cdp.on((m) => { if (m.sessionId === S) fn(m); }),
});
