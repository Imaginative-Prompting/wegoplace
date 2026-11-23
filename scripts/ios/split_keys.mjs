#!/usr/bin/env node
// Split's add sheet with the iPhone's own keyboard up: is its button above the keys? Off the gate
// (scripts/ios/README.md says what it needs). On a check server of its own.
//
//   LAB_UDID=<a device of your own> IOS_AXE=<the AXe binary> node scripts/ios/split_keys.mjs <out folder> [--port <port>]
//
// A made-up trip with two made-up people; the phone is one of them, signed in by the relay (its cookie handed to
// the phone). Split is opened in a Mobile Safari tab, the harder of the two places it runs: there iOS shrinks the
// page's own viewport for the keyboard, where the Home Screen app keeps it. Real touches through UIKit:
//   1. Add: the + touched. The amount field has focus from that touch and the keyboard is up, with nothing else
//      touched; the sheet's "Add purchase" is wholly above the keys and spans the sheet. Digits typed on the
//      keyboard reach the field.
//   2. Edit: a purchase of this person's touched, then its amount touched to bring the keys up: "Save changes" is
//      wholly above them too.
// "Above the keys" is read on the page: the button's box against the visual viewport's foot (the keyboard's top
// edge), in the same coordinates. A still of each. The device is erased first and shut down at the end, whatever
// happens.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connect } from "./phone.mjs";
import { startServer } from "../../checks/lib/server.mjs";
import { Person } from "../../checks/lib/person.mjs";
import { freeLoopbackPort } from "../lib/browser.mjs";
import { equalShares } from "../../public/js/money.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8889);
const out = path.resolve(argv[0] || "");
if (!argv[0]) { console.error("usage: node scripts/ios/split_keys.mjs <out folder> [--port <port>]"); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 400) : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 800) : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const down = () => { try { execSync(`/usr/bin/xcrun simctl shutdown ${process.env.LAB_UDID}`, { stdio: "ignore" }); } catch { /* already down */ } };
process.on("uncaughtException", (e) => { console.log(`\nSTOPPED (${e?.stack || e})`); down(); process.exit(1); });
process.on("unhandledRejection", (e) => { console.log(`\nSTOPPED (${e?.stack || e})`); down(); process.exit(1); });

// What the page says about the sheet's button and the keys: in layout-viewport coordinates, the visual viewport's
// foot is where the keyboard begins.
const KEYS = (sel) => `(() => {
  const vv = window.visualViewport, b = document.querySelector(".sh-root:last-of-type " + ${JSON.stringify(sel)});
  const s = document.querySelector(".sh-root:last-of-type .sh-sheet");
  if (!b || !vv) return JSON.stringify(null);
  const r = b.getBoundingClientRect(), sr = s.getBoundingClientRect();
  const keyTop = vv.offsetTop + vv.height;
  return JSON.stringify({ top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), sheetWidth: Math.round(sr.width),
    keyTop: Math.round(keyTop), innerHeight, vvHeight: Math.round(vv.height), vvTop: Math.round(vv.offsetTop),
    shKb: getComputedStyle(document.querySelector(".sh-root:last-of-type")).getPropertyValue("--sh-kb").trim(),
    tall: document.querySelector(".sh-root:last-of-type").dataset.tall === "1",
    focus: document.activeElement ? (document.activeElement.dataset.sp || document.activeElement.className) : "",
    words: b.textContent.trim(), value: (document.querySelector(".sh-root:last-of-type .sp-amtin") || {}).value });
})()`;

let server = null, phone = null, code = 1;
try {
  server = await startServer({ name: "split-keys", port });
  await server.start();
  const ben = new Person(server.origin, "Ben Okafor"), ada = new Person(server.origin, "Ada Reyes");
  for (const p of [ben, ada]) if ((await p.signUp()).status !== 200) throw new Error(`couldn't make ${p.name}`);
  const trip = (await ada.post("/api/trips", { name: "Lisbon and the coast", default_tz: "Europe/Lisbon", currencies: ["EUR"] })).json.trip;
  const link = await ada.post(`/api/trips/${trip.id}/links`, { uses: 1 });
  await ben.post(`/api/join/${link.json.link.code}`);
  const ids = [ada.user.id, ben.user.id].sort();
  for (const [who, id, what, amount] of [[ada, "pu-keys-1", "Dinner at the harbour", 9000], [ben, "pu-keys-2", "Groceries", 3000]]) {
    const r = await who.post(`/api/trips/${trip.id}/purchases`, { id, description: what, amount_minor: amount, currency: "EUR", amount_exp: 2,
      paid_by: who.user.id, spent_at: Math.floor(Date.now() / 1000) - 3600, split_mode: "weight",
      shares: ids.map((u, i) => ({ user_id: u, weight: 1, share_minor: equalShares(amount, 2, id)[i] })) });
    if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 160)}`);
  }
  check("setup: two made-up people on a made-up trip, a purchase each", true, trip.id);

  const listen = await freeLoopbackPort();
  phone = await connect({ listen, upstream: port, out, said: [], pageErrors: [] });
  phone.cookie({ name: "wgp_session", value: ben.jar.cookies.get("wgp_session"), maxAge: 3600 });
  const tab = await phone.openTab();
  execSync(`/usr/bin/xcrun simctl openurl ${process.env.LAB_UDID} "http://localhost:${listen}/t/${trip.id}/#/split"`);
  await tab.wait(`document.querySelectorAll(".sp-row").length === 2 && !!document.querySelector(".fab") ? 1 : 0`, "Split in Safari, with its two rows", 90000);
  await sleep(1500);
  await tab.shot("split-keys-0-split");

  // ── 1. Add ──────────────────────────────────────────────────────────────────────────────────────
  console.log(`  note  ${await tab.touchEl(".fab")}`);
  await tab.wait(`document.querySelector(".sh-root .sp-amtin") ? 1 : 0`, "the add sheet");
  await sleep(2500);                                    // the sheet up and the keyboard with it
  const add = JSON.parse(await tab.page(KEYS('[data-act="save"]')));
  console.log(`  note  add, the keys up: ${JSON.stringify(add)}`);
  check("Add: the amount has focus from the + alone, and the sheet is at its full height", !!add && add.focus === "amount" && add.tall, JSON.stringify(add));
  check("Add: the keyboard is up (the visual viewport is short of the page)", !!add && (add.keyTop < add.innerHeight - 150 || add.vvHeight < 600), JSON.stringify(add));
  check("Add: \"Add purchase\" is wholly above the keys", !!add && add.bottom <= add.keyTop && add.top >= 0, JSON.stringify(add));
  check("Add: and it spans the sheet", !!add && add.width >= add.sheetWidth - 40, JSON.stringify(add));
  await tab.shot("split-keys-1-add");
  // Digits on the keyboard: AXe types them as keys pressed.
  try { execSync(`"${process.env.IOS_AXE}" type "18.60" --udid ${process.env.LAB_UDID}`, { stdio: "ignore" }); } catch (e) { console.log(`  note  (typing: ${String(e.message).slice(0, 80)})`); }
  await sleep(1200);
  const typed = JSON.parse(await tab.page(KEYS('[data-act="save"]')));
  check("Add: digits typed on the keyboard reach the field, and the button stays above the keys, now on", !!typed && typed.value === "18.60" && typed.bottom <= typed.keyTop, JSON.stringify(typed));
  await tab.shot("split-keys-2-add-typed");
  await tab.page(`(document.activeElement && document.activeElement.blur(), document.querySelector(".sh-scrim").click(), 1)`);
  await tab.wait(`document.querySelector(".sh-root") ? 0 : 1`, "the sheet put away", 15000);
  await sleep(1500);

  // ── 2. Edit ─────────────────────────────────────────────────────────────────────────────────────
  console.log(`  note  ${await tab.touchEl('.sp-row[data-id="pu-keys-2"]')}`);
  await tab.wait(`document.querySelector(".sh-root .sp-amtin") ? 1 : 0`, "the edit sheet");
  await sleep(1500);
  console.log(`  note  ${await tab.touchEl(".sh-root .sp-amtin")}`);
  await sleep(2500);
  const edit = JSON.parse(await tab.page(KEYS('[data-act="save"]')));
  console.log(`  note  edit, the keys up: ${JSON.stringify(edit)}`);
  check("Edit: the amount, touched, has the keys", !!edit && edit.focus === "amount", JSON.stringify(edit));
  check("Edit: \"Save changes\" is wholly above the keys and spans the sheet", !!edit && edit.words === "Save changes" && edit.bottom <= edit.keyTop && edit.top >= 0 && edit.width >= edit.sheetWidth - 40, JSON.stringify(edit));
  await tab.shot("split-keys-3-edit");

  console.log(`\n${pass} passed, ${fail} failed`);
  code = fail ? 1 : 0;
} catch (e) {
  console.log(`\nSTOPPED: ${e?.stack || e}\n${pass} passed, ${fail} failed before it stopped`);
  code = 1;
} finally {
  if (phone) { try { await phone.done(); } catch { /* down */ } }
  down();
  console.log(`  note  the device shut down at ${new Date().toTimeString().slice(0, 8)}`);
  if (server) await server.stop().catch(() => {});
}
process.exit(code);
