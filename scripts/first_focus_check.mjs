#!/usr/bin/env node
/* Where the keyboard's focus starts when a sheet opens: never on a button that destroys.
 *
 *   WGP_BASE=http://localhost:<port> python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel \
 *     --who <session> --label "wegoplace first_focus_check.mjs" -- node scripts/first_focus_check.mjs
 *   node scripts/first_focus_check.mjs --static        the part that needs no browser
 *
 * Whatever has the focus is what Enter and Space press, and a sheet takes the focus the moment
 * it opens. A sheet that asks "delete this?" with the focus on Delete deletes on the Enter that
 * was meant for the screen behind it. The rule lives in ONE place, public/js/sheet.js
 * (keeperIn): the first focus passes over every control that destroys and lands on the first
 * that keeps. A control that destroys says so in its markup: .btn-danger, or data-destroys.
 *
 * WHAT IT PROVES
 *   S. Without a browser, from the source:
 *      - sheet.js gives the first focus through keeperIn, and to nothing else;
 *      - every button in the app whose words destroy (Delete, Remove, Discard, Stop sharing,
 *        Erase) carries the mark the rule reads, and so does every button labelled that way
 *        for a screen reader (a button that only OPENS the question is marked too: passing
 *        over it costs nothing);
 *      - the app opens exactly the sheets this check knows of, file by file. A sheet added
 *        or removed fails here until its row in SHEETS says where its first focus lands.
 *   A. The rule itself, on the real sheet.js, with made-up sheets: Delete first in the body;
 *      Delete alone in the head with Keep below; nothing but Delete; a destroying control
 *      marked data-destroys; a first control that is disabled; and a sheet with nothing that
 *      destroys, whose first control still gets the focus. Then a real Enter on the first:
 *      Keep is pressed, Delete is not.
 *   B. The app's own sheets that hold something that destroys, each opened the way a person
 *      opens it, on the seeded trip, with a row made for this run and removed after:
 *      - Split: the editor of a purchase (Delete in its foot band);
 *      - Packing: the editor of an item (Delete beside Save in the head);
 *      - Packing: "Lists" (a delete for each list), opened by the first
 *        real tap after the press-and-hold, which used to be swallowed.
 *      In each: the focus is in the sheet and on nothing that destroys; every control in it
 *      that destroys carries the mark; and a real Enter, sent the moment it has opened,
 *      deletes nothing.
 *   The two confirms in Memories (the Delete memory sheet, and "Stop sharing" in the Collage
 *   sheet) need a trip with memories and a shared board, which scripts/board_memory_check.mjs
 *   makes on a server of its own: it holds them to the same rule, with a real Enter.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_ONLY = process.argv.includes("--static");

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 320) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

// Every sheet the app opens, by the file that opens it. `destroys`: it holds a control that
// destroys, and `held` says which check opens it and holds it to the rule.
const SHEETS = {
  "public/js/account-picture.js": [
    { name: "Your picture (the pad; Back to initials takes the stored picture away)", destroys: true, held: "picture_places_check.mjs §5" },
  ],
  "public/js/agenda.js": [
    { name: "free time actions (Add a plan here, Chat about this, What's near)", destroys: false },
  ],
  "public/js/assistant.js": [
    { name: "This conversation (each document's Delete, then Delete this conversation)", destroys: true, held: "assistant_screens_check.mjs H; with a document, assistant_attach_check.mjs 5" },
    { name: "a chosen document's sheet (Delete this document, or a refused one's Remove it)", destroys: true, held: "assistant_attach_check.mjs 2 and 3" },
  ],
  "public/js/chat.js": [
    { name: "a message's actions (Delete message, or the host's Delete of someone's)", destroys: true, held: "checks/chat/screen.mjs" },
  ],
  "public/js/invite.js": [
    { name: "Invite people (the link made: Share, or Copy where a phone can't share)", destroys: false },
  ],
  "public/js/memories.js": [
    { name: "Collage (with Shared links: Stop sharing, asked in place)", destroys: true, held: "board_memory_check.mjs §2c" },
    { name: "Framing", destroys: false },
    { name: "When it happened (a memory's day: the day, and Save)", destroys: false },
    { name: "Delete memory", destroys: true, held: "board_memory_check.mjs §3" },
    { name: "Add photos (after the phone's picker)", destroys: false },
  ],
  "public/js/packing.js": [
    { name: "an offer to copy a list", destroys: false },
    { name: "the wrapper every Packing sheet goes through", destroys: false },
    { name: "where an item goes", destroys: false },
    { name: "an item's editor", destroys: true, held: "here, B" },
    { name: "Lists", destroys: true, held: "here, B" },
  ],
  "public/js/place-editor.js": [
    { name: "a place's editor (Remove this place, asked in place)", destroys: true, held: "place_check.mjs §9" },
  ],
  "public/js/settings.js": [
    { name: "Report a bug (what happened, a screenshot, what goes with it, Send)", destroys: false },
  ],
  "public/js/references.js": [
    { name: "Quick reference, the list: it opens on the sheet itself, never on a link that dials", destroys: false },
    { name: "an item of it (Remove from the list, asked in place)", destroys: true, held: "first_focus_check.mjs B, references_check.mjs" },
  ],
  "public/js/plan-ai.js": [
    { name: "Plan it with your AI (3-step connect sheet)", destroys: false },
  ],
  "public/js/plan-editor.js": [
    { name: "a plan's editor (Remove this plan, asked in place)", destroys: true, held: "plans_check.mjs §7" },
  ],
  "public/js/spot-picker.js": [
    { name: "Put it on the map (the trip's map under a fixed pin)", destroys: false },
  ],
  "public/js/split.js": [
    { name: "a purchase's editor (and its pickers, in the same sheet)", destroys: true, held: "here, B" },
  ],
};
const DESTROY_WORDS = /^(?:Delete|Remove|Discard|Stop sharing(?!…)|Erase)\b/;
const MARK = /\bbtn-danger\b|\bdata-destroys\b/;

section("S. from the source");
{
  const sheet = read("public/js/sheet.js");
  const DESTROYS = (/^const DESTROYS = "([^"]+)";/m.exec(sheet) || [])[1];
  check("sheet.js names what destroys: the danger style, or data-destroys", DESTROYS === ".btn-danger,[data-destroys]", DESTROYS);
  const open = sheet.slice(sheet.indexOf("export function openSheet("), sheet.indexOf("export function keeperIn("));
  const focuses = [...open.matchAll(/^\s*\((.*)\)\.focus\(\{ preventScroll: true \}\);\s*$/gm)].map((m) => m[1].trim());
  check("a sheet's first focus is given through keeperIn, and only there", focuses.length === 1 && focuses[0] === "keeperIn(sheet) || sheet", JSON.stringify(focuses));
  const keeper = sheet.slice(sheet.indexOf("export function keeperIn("), sheet.indexOf("export function focusKeeper("));
  check("keeperIn passes over what destroys", /n\.matches\(DESTROYS\)/.test(keeper) && /continue;/.test(keeper));

  const files = fs.readdirSync(path.join(REPO, "public/js")).filter((f) => f.endsWith(".js")).map((f) => `public/js/${f}`).concat(["public/index.html"]);
  const unmarked = [], marked = [];
  const counts = {};
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)) {
      const words = m[2].trim(), tag = m[1];
      const label = (/aria-label="([^"]*)"/.exec(tag) || [])[1] || "";
      if (!DESTROY_WORDS.test(words) && !DESTROY_WORDS.test(label)) continue;
      (MARK.test(tag) ? marked : unmarked).push(`${f}: "${label || words}"`);
    }
    // A labelled icon button closes after its icon, not after words: read the opening tag alone.
    for (const m of src.matchAll(/<button\b([^>]*aria-label="([^"]*)"[^>]*)>/g)) {
      if (!DESTROY_WORDS.test(m[2])) continue;
      const row = `${f}: "${m[2]}"`;
      if (marked.includes(row) || unmarked.includes(row)) continue;
      (MARK.test(m[1]) ? marked : unmarked).push(row);
    }
    if (f === "public/js/sheet.js") continue;
    // The sheets a file opens: a call that hands over an object, not a definition, not a comment.
    const calls = src.split("\n").filter((line) => !/^\s*(\/\/|\*|function )/.test(line) && /(?<![\w.])open(?:Bottom)?Sheet\(\{/.test(line)).length;
    if (calls) counts[f] = calls;
  }
  check("every button whose words or label destroy carries the mark the rule reads", unmarked.length === 0 && marked.length >= 6,
    unmarked.length ? `unmarked: ${unmarked.join("; ")}` : `${marked.length} marked: ${marked.join("; ")}`);
  const want = Object.fromEntries(Object.entries(SHEETS).map(([f, list]) => [f, list.length]));
  const same = JSON.stringify(Object.entries(counts).sort()) === JSON.stringify(Object.entries(want).sort());
  check("the app opens exactly the sheets this check knows of (a new one: say in SHEETS where its first focus lands)", same,
    same ? Object.entries(counts).map(([f, n]) => `${path.basename(f)} ${n}`).join(", ") : `in the source ${JSON.stringify(counts)} / in SHEETS ${JSON.stringify(want)}`);
  const loose = Object.entries(SHEETS).flatMap(([f, list]) => list.filter((s) => s.destroys && !s.held).map((s) => `${f}: ${s.name}`));
  check("every sheet that holds something that destroys names the check that holds it", loose.length === 0, loose.join("; "));
}

if (STATIC_ONLY) {
  console.log(`\n${pass} passed, ${fail} failed (the source only; the browser part was not run)`);
  if (fail) console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(fail ? 1 : 0);
}

const { BASE, appSettled, boot, evalIn, sleep, waitFor } = await import("./lib/standalone_cdp.mjs");
const TRIP = (await import("./lib/gate_trip.mjs")).tripPath();
const TAG = `first-focus ${Date.now().toString(36)}`;
const b = await boot({ vw: 390, vh: 844, dsf: 1 });
const { cdp, S } = b;
const page = (expr) => evalIn(cdp, S, expr);
const inStore = (body) => page(`import("/js/store.js").then(async ({ store }) => { ${body} })`);
const pressEnter = async () => {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r", unmodifiedText: "\r" } : {}) }, S);
  }
  await sleep(350);
};
// What has the focus, and what the open sheet holds that destroys.
const FOCUS = `(() => {
  const sh = [...document.querySelectorAll(".sh-sheet")].pop();
  const a = document.activeElement;
  const DESTROYS = ".btn-danger,[data-destroys]";
  const words = (n) => ((n.textContent || "").trim() || n.getAttribute("aria-label") || "").replace(/\\s+/g, " ").slice(0, 40);
  const destroyers = sh ? [...sh.querySelectorAll("button,a[href]")].filter((n) => ${DESTROY_WORDS}.test(words(n))) : [];
  return JSON.stringify({
    open: !!sh,
    inSheet: !!sh && !!a && sh.contains(a),
    on: a ? (a === sh ? "the sheet itself" : a.tagName.toLowerCase() + (a.className ? "." + String(a.className).split(/\\s+/)[0] : "") + (words(a) ? ' "' + words(a) + '"' : "")) : "",
    onDestroyer: !!a && (a.matches(DESTROYS) || ${DESTROY_WORDS}.test(words(a))),
    destroyers: destroyers.map(words),
    unmarked: destroyers.filter((n) => !n.matches(DESTROYS)).map(words),
  });
})()`;
const focus = async () => JSON.parse(await page(FOCUS));
const go = async (hash, ready, label) => {
  await cdp.send("Page.navigate", { url: "about:blank" }, S); await sleep(150);
  await cdp.send("Page.navigate", { url: `${BASE}${TRIP}${hash}` }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, ready, { label });
  await sleep(500);
};
const closeSheets = async () => {
  await page(`import("/js/sheet.js").then((m) => (m.closeAllSheets(), 1))`);
  await waitFor(cdp, S, `document.querySelector(".sh-sheet") ? 0 : 1`, { label: "the sheet gone" });
  await sleep(250);
};

let purchaseId = "", itemId = "", refId = "";
try {
  // ── A. the rule, on made-up sheets ────────────────────────────────────────────────────
  section("A. the rule itself, on the real sheet.js");
  await go("#/settings", `document.querySelector("#view") && document.querySelector("#view").childElementCount ? 1 : 0`, "the app");
  // Opens a made-up sheet and says where the focus is. `presses` counts each button's clicks.
  const made = async (name, { body = "", foot = "", closeButton = true }) => {
    await page(`import("/js/sheet.js").then(({ openSheet }) => {
      const mk = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d; };
      window.__presses = {};
      const bodyEl = mk(${JSON.stringify(body)});
      const footEl = ${foot ? `mk(${JSON.stringify(foot)})` : "null"};
      for (const root of [bodyEl, footEl]) if (root) for (const n of root.querySelectorAll("[id]")) n.addEventListener("click", () => { window.__presses[n.id] = (window.__presses[n.id] || 0) + 1; });
      window.__made = openSheet({ title: ${JSON.stringify(name)}, contentEl: bodyEl, footEl, closeButton: ${closeButton} });
      return 1;
    })`);
    await sleep(450);
    const first = await page(`(() => { const sh = [...document.querySelectorAll(".sh-sheet")].pop(); const n = sh.querySelector("select,button:not(.sh-x),a[href],input[type=checkbox],input[type=radio]"); return n ? n.id : ""; })()`);
    const at = await page(`(() => { const a = document.activeElement; return a ? (a.id || (a.classList.contains("sh-sheet") ? "the sheet itself" : a.tagName)) : ""; })()`);
    return { first, at };
  };
  const DEL = `<button class="btn btn-danger" type="button" id="del">Delete</button>`, KEEP = `<button class="btn" type="button" id="keep">Keep</button>`;

  let m = await made("Delete first in the body", { body: DEL + KEEP });
  check("Delete first in the body, Keep after: the focus starts on Keep", m.first === "del" && m.at === "keep", JSON.stringify(m));
  await pressEnter();
  const presses = JSON.parse(await page(`JSON.stringify(window.__presses)`));
  check("a real Enter there presses Keep, and Delete is never pressed", presses.keep === 1 && !presses.del, JSON.stringify(presses));
  await closeSheets();

  m = await made("Delete in the head", { foot: DEL, body: KEEP });
  check("Delete alone in the head, Keep below in the body: Keep", m.first === "del" && m.at === "keep", JSON.stringify(m));
  await closeSheets();

  m = await made("Nothing but Delete", { body: DEL, closeButton: false });
  check("nothing but Delete: the sheet takes the focus itself", m.first === "del" && m.at === "the sheet itself", JSON.stringify(m));
  await pressEnter();
  check("and a real Enter presses nothing", JSON.stringify(JSON.parse(await page(`JSON.stringify(window.__presses)`))) === "{}", await page(`JSON.stringify(window.__presses)`));
  await closeSheets();

  m = await made("Marked another way", { body: `<button class="btn btn-sm" type="button" id="del" data-destroys>Discard</button>` + KEEP });
  check("a destroying control marked data-destroys is passed over too", m.first === "del" && m.at === "keep", JSON.stringify(m));
  await closeSheets();

  m = await made("A disabled first control", { body: `<button class="btn" type="button" id="off" disabled>Post</button>` + KEEP });
  check("a first control that is disabled is passed over: the focus is in the sheet, on the next", m.first === "off" && m.at === "keep", JSON.stringify(m));
  await closeSheets();

  m = await made("Nothing that destroys", { body: `<button class="btn" type="button" id="one">One</button><button class="btn" type="button" id="two">Two</button>` });
  check("with nothing that destroys, the first control still gets the focus", m.first === "one" && m.at === "one", JSON.stringify(m));
  await closeSheets();

  // ── B. the app's own ──────────────────────────────────────────────────────────────────
  section("B. Split: a purchase's editor");
  await go("#/split", `document.querySelector("#rt-fixed .fab") ? 1 : 0`, "Split");
  purchaseId = JSON.parse(await inStore(`
    const ids = store.members().map((x) => x.id);
    const row = await store.addPurchase({ description: ${JSON.stringify(TAG)}, amount_minor: 1200, currency: "PEN", amount_exp: 2, shares: ids.map((u) => ({ user_id: u, weight: 1 })) });
    return JSON.stringify(row.id);`));
  await waitFor(cdp, S, `import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, { label: "the purchase reaching the server" });
  await waitFor(cdp, S, `document.querySelector('.sp-row[data-id="${purchaseId}"]') ? 1 : 0`, { label: "the purchase's row" });
  await page(`(document.querySelector('.sp-row[data-id="${purchaseId}"]').click(), 1)`);
  await waitFor(cdp, S, `document.querySelector('.sh-sheet [data-act="del"]') ? 1 : 0`, { label: "the editor, with its Delete" });
  await sleep(700);
  let f = await focus();
  // Split names its Delete for what it deletes ("Delete purchase").
  check("the editor holds a Delete, and it carries the mark", f.destroyers.some((d) => /^Delete\b/.test(d)) && f.unmarked.length === 0, JSON.stringify(f));
  check("the focus is in the sheet, and not on what destroys", f.inSheet && !f.onDestroyer, f.on);
  await pressEnter();
  await sleep(600);
  check("a real Enter as it opened deleted nothing", (await inStore(`return store.purchases().some((p) => p.id === ${JSON.stringify(purchaseId)} && !p.deleted_at) ? 1 : 0;`)) === 1);
  await closeSheets().catch(() => {});

  section("B. Packing: an item's editor, and Lists");
  await go("#/pack", `document.querySelector('[data-act="new"], .pk-fab') ? 1 : 0`, "Packing");
  itemId = JSON.parse(await inStore(`const row = await store.addPacking(store.me().id, { label: ${JSON.stringify(TAG)} }); return JSON.stringify(row.id);`));
  await waitFor(cdp, S, `import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, { label: "the item reaching the server" });
  // The item's row, wherever its list put it: unfolded and on screen, then pressed and held.
  const at = await waitFor(cdp, S, `(() => {
    const li = document.querySelector('.pk-item[data-id="${itemId}"]');
    if (!li) { const fold = [...document.querySelectorAll('[data-act="fold"][aria-expanded="false"]')][0]; if (fold) fold.click(); return 0; }
    li.scrollIntoView({ block: "center" });
    const r = li.getBoundingClientRect();
    return r.height > 0 ? JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }) : 0;
  })()`, { label: "the item's row on screen", timeout: 20000 }).then(JSON.parse);
  await sleep(400);
  const where = JSON.parse(await page(`(() => { const r = document.querySelector('.pk-item[data-id="${itemId}"]').getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }); })()`));
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: where.x, y: where.y, button: "left", clickCount: 1 }, S);
  await sleep(700);                          // the long press that opens "where it goes"
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: where.x, y: where.y, button: "left", clickCount: 1 }, S);
  await waitFor(cdp, S, `document.querySelector('.sh-sheet [data-act="edititem"]') ? 1 : 0`, { label: "where the item goes, with Edit item" });
  await sleep(500);
  f = await focus();
  check("where an item goes: the focus is in the sheet, on nothing that destroys", f.inSheet && !f.onDestroyer && f.unmarked.length === 0, JSON.stringify(f));
  await page(`(document.querySelector('.sh-sheet [data-act="edititem"]').click(), 1)`);
  await waitFor(cdp, S, `document.querySelector('.sh-sheet [data-act="del"]') ? 1 : 0`, { label: "the item's editor, with its Delete" });
  await sleep(700);
  f = await focus();
  check("the item's editor holds a Delete, and it carries the mark", f.destroyers.includes("Delete") && f.unmarked.length === 0, JSON.stringify(f));
  check("the focus is in the sheet, and not on what destroys", f.inSheet && !f.onDestroyer, f.on);
  await pressEnter();
  await sleep(600);
  check("a real Enter as it opened deleted nothing", (await inStore(`return store.packing(store.me().id).some((p) => p.id === ${JSON.stringify(itemId)}) ? 1 : 0;`)) === 1);
  await closeSheets().catch(() => {});

  const before = JSON.parse(await inStore(`return JSON.stringify(store.packLists().map((l) => [l.key, l.bags.length]));`));
  // A real tap (press and release), the first on the list since the press-and-hold above: the
  // click that hold was waiting to swallow landed on its sheet, and this one must not be eaten.
  const chip = JSON.parse(await page(`(() => { const n = document.querySelector('[data-act="managebags"]'); n.scrollIntoView({ block: "center" }); const r = n.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }); })()`));
  await sleep(300);
  for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: chip.x, y: chip.y, button: "left", clickCount: 1 }, S);
  const opened = await waitFor(cdp, S, `document.querySelector(".sh-sheet #pk-manage") ? 1 : 0`, { label: "Lists", timeout: 6000 }).then(() => true, () => false);
  check("the first tap after a press-and-hold is not swallowed: Lists opens", opened);
  if (!opened) throw new Error("Lists did not open");
  await sleep(700);
  f = await focus();
  check("Lists holds a delete for a list, each carrying the mark", f.destroyers.length >= 1 && f.unmarked.length === 0, JSON.stringify(f));
  check("the focus is in the sheet, and not on what destroys", f.inSheet && !f.onDestroyer, f.on);
  await pressEnter();
  await sleep(600);
  const after = JSON.parse(await inStore(`return JSON.stringify(store.packLists().map((l) => [l.key, l.bags.length]));`));
  check("a real Enter as it opened deleted no list and no bag", JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  await closeSheets().catch(() => {});

  section("B. The quick reference list");
  refId = `rf-${TAG.replace(/\W+/g, "-")}`;
  await inStore(`await store.addReference(${JSON.stringify(refId)}, { title: ${JSON.stringify(TAG)}, body: "Police, fire and ambulance: 112\\nhttps://example.org/x" }); return 1;`);
  await go("#/", `document.querySelector(".rf-fab") && getComputedStyle(document.querySelector(".rf-fab")).display !== "none" ? 1 : 0`, "the quick reference's button");
  await page(`(document.querySelector(".rf-fab").click(), 1)`);
  await waitFor(cdp, S, `document.querySelector(".sh-root[data-open='1'] .rf-list") ? 1 : 0`, { label: "the quick reference" });
  f = await focus();
  check("the list holds nothing that destroys (Remove is inside an item's form), and nothing unmarked", f.destroyers.length === 0 && f.unmarked.length === 0, JSON.stringify(f));
  check("it opens on the sheet itself: not a link that dials, nothing that destroys", f.on === "the sheet itself" && !f.onDestroyer
    && !(await page(`!!document.activeElement.closest('a[href^="tel:"], a[href^="https:"]')`)), f.on);
  await page(`(document.querySelector('[data-rf-change="${refId}"]').click(), 1)`);
  await waitFor(cdp, S, `document.querySelector("[data-rf-remove]") ? 1 : 0`, { label: "the item's form" });
  await sleep(500);
  f = await focus();
  check("an item's form holds Remove from the list, carrying the mark", f.destroyers.some((d) => /^Remove\b/.test(d)) && f.unmarked.length === 0, JSON.stringify(f));
  check("it opens on what keeps (Save), not on Remove", f.inSheet && !f.onDestroyer, f.on);
  await pressEnter();
  await sleep(600);
  check("a real Enter as it opened removed nothing", (await inStore(`return store.references().some((r) => r.id === ${JSON.stringify(refId)}) ? 1 : 0;`)) === 1);
  await closeSheets().catch(() => {});

  check("no page error", b.pageErrors.length === 0, b.pageErrors.join(" | "));
} catch (e) {
  fail++; failures.push("the check ran to its end");
  console.log(`  FAIL  the check ran to its end   -> ${e && e.stack ? e.stack : e}`);
} finally {
  // What this run made, removed: only its own two rows, by id.
  try {
    await cdp.send("Page.navigate", { url: `${BASE}${TRIP}#/settings` }, S);
    await appSettled(cdp, S);
    await inStore(`
      ${purchaseId ? `if (store.purchases().some((p) => p.id === ${JSON.stringify(purchaseId)})) await store.deletePurchase(${JSON.stringify(purchaseId)});` : ""}
      ${itemId ? `if (store.packing(store.me().id).some((p) => p.id === ${JSON.stringify(itemId)})) await store.deletePacking(${JSON.stringify(itemId)});` : ""}
      ${refId ? `if (store.references().some((r) => r.id === ${JSON.stringify(refId)})) await store.deleteReference(${JSON.stringify(refId)});` : ""}
      return 1;`);
    await waitFor(cdp, S, `import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, { label: "this run's rows removed", timeout: 15000 });
  } catch (e) { console.log(`  note  this run's rows could not be removed: ${e && e.message}`); }
  await b.done().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(fail ? 1 : 0);
