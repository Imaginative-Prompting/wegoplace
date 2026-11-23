#!/usr/bin/env node
/* A document given the assistant, in the app (public/js/assistant.js; the server's side is src/assistant/files.js),
 * in a real browser at a phone's 390 px, on a server of its own with the plan on, a stand-in model and a stand-in for
 * Cloudflare's conversion on this machine (nothing reaches a model or Cloudflare). Made-up people; the made-up
 * planning document of the bake-off's import tasks (tools/bakeoff/documents/).
 *
 *   1. THE PAPERCLIP in the assistant's box, its press area at least 44 px, offering files and (on a phone) the camera
 *      and the photo library (accept holds image/* and the document types);
 *   2. CHOSEN ON THE LIST: a conversation is made for it and opens; its chip says "Reading…" while the server reads it
 *      (the conversion held so it can be seen), and Ask is off saying why ("Wait for … to be read."); then ready, with
 *      its pages; the box asks what to do with it. Each sheet here is held to first_focus_check's rule: the first focus
 *      is on nothing that destroys, each control that destroys carries the mark, and a real Enter the moment it opens
 *      destroys nothing (its chip's sheet here, the refused chip's in 3, More with a document in 5);
 *   3. A REFUSAL in the server's own words: a file that isn't a document shows "not added" on its chip and the
 *      server's sentence in the box; its sheet removes it, and nothing of it is kept;
 *   4. THE ASK carries the document: the request's files, the model told it is attached, and the question shows it
 *      under its bubble, there again after a reload (the server keeps it with the question);
 *   5. MORE lists the conversation's documents, each with Delete: deleted, it's gone on the server, and the question
 *      shows its name crossed out, "deleted";
 *   6. WITH NO SIGNAL the paperclip is off and says why;
 *   7. with WGP_SHOTS=<folder>, a still of each state at 390, light and dark;
 *   8. ON A CONVERSATION THE BACK RIDES ABOVE THE BOX: with no chip, with chips and with the keyboard up (the shell's
 *      --kb-h and data-kb, as index.html sets them), the dock's Back is clear of the box (its foot 8 px over the box's
 *      top edge), at least 44 px high, and the conversation's last message ends above it; a tap on it goes back to
 *      the list (stills of the three, dark);
 *   and no page error.
 *
 *   node scripts/assistant_attach_check.mjs           (sandbox off; through the channel's queue)
 *
 * PLANTED (red when put in by hand): ask() without `files` (4: the request carries none, the model isn't told);
 * the chip's state left "reading" after the answer (2); the More sheet without its documents (5).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CheckError, startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { startModel } from "../checks/lib/model-standin.mjs";
import { openChrome } from "../checks/lib/chrome.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.WGP_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DOCS = path.join(ROOT, "tools/bakeoff/documents");
const PDF = path.join(DOCS, "amsterdam-draft.pdf");
const KEY = "sk-or-check-not-real";
const JUNK = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "wgp-attach-")), "notes.bin");
fs.writeFileSync(JUNK, Buffer.from([0, 1, 2, 3, 255, 254, 253, 0, 9, 9]));

let model = null, server = null, chrome = null, convert = null;
const pageErrors = [];
try {
  // Cloudflare's conversion, stood in: the PDF answers the Markdown it was made from, held 4 s so "Reading…" shows past
  // the screen's own slide from the list into the conversation.
  const md = fs.readFileSync(path.join(DOCS, "amsterdam-draft.md"), "utf8");
  convert = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => setTimeout(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ markdown: md })); }, 4000));
  });
  await new Promise((r) => convert.listen(0, "127.0.0.1", r));
  model = await startModel({ key: KEY });
  server = await startServer({
    name: "assistant-attach", port: await freeLoopbackPort(),
    vars: { PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y", ASSISTANT_ENABLED: "true",
      ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5", OPENROUTER_API_BASE: model.base,
      DOCUMENT_CONVERT_VIA: `http://127.0.0.1:${convert.address().port}/` },
    secrets: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", OPENROUTER_API_KEY: KEY },
  });
  ownServer(server.origin);
  await server.start();

  const ada = new Person(server.origin, "Ada Reyes"), teo = new Person(server.origin, "Teo Marsh");
  for (const p of [ada, teo]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  const made = await ada.post("/api/trips", { name: "Canal week", default_tz: "Europe/Amsterdam", starts_on: "2027-05-12", ends_on: "2027-05-15" });
  if (made.status !== 201) throw new CheckError(`the trip: ${made.status}`);
  const trip = made.json.trip.id;
  await teo.post(`/api/join/${(await ada.post(`/api/trips/${trip}/links`, { uses: 1 })).json.link.code}`);
  const now = Math.floor(Date.now() / 1000);
  server.sql(`INSERT INTO billing_subscriptions (id, user_id, customer, status, interval, current_period_end, held, updated_at, synced_at)
    VALUES ('sub_ada', '${ada.user.id}', 'cus_ada', 'active', 'month', ${now + 30 * 86400}, 0, ${now}, ${Date.now()})`);
  check("made up: a trip whose host has the plan, two people on it", !!trip);

  chrome = await openChrome();
  const pageAs = async (who, scheme = "light") => {
    const page = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
    await page.setCookie(server.origin, "wgp_session", who.jar.cookies.get("wgp_session"));
    await page.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: encodeURIComponent(who.user.id), sameSite: "Lax" });
    await page.send("Network.enable");
    await page.send("Runtime.enable");
    await page.send("DOM.enable");
    await page.scheme(scheme);
    page.on((m) => { if (m.method === "Runtime.exceptionThrown") pageErrors.push(`${who.name}: ${m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text}`.slice(0, 300)); });
    return page;
  };
  const go = async (page, hash) => { await page.goto(`${server.origin}/t/${trip}/${hash}`); await page.settle(); };
  const read = (page, expr) => page.eval(expr);
  const json = async (page, expr) => JSON.parse(await page.eval(`JSON.stringify(${expr})`));
  const text = (page, sel) => page.eval(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ""`);
  // The first focus in a sheet (scripts/first_focus_check.mjs's rule): what has it, and what the open sheet holds that
  // destroys, each carrying the mark (.btn-danger or data-destroys) that sheet.js's keeperIn passes over.
  const focusRule = (page) => json(page, `(() => {
    const sh = [...document.querySelectorAll(".sh-sheet")].pop(), a = document.activeElement;
    const DESTROYS = ".btn-danger,[data-destroys]", W = /^(?:Delete|Remove|Discard|Stop sharing(?!…)|Erase)\\b/;
    const words = (n) => ((n.textContent || "").trim() || n.getAttribute("aria-label") || "").replace(/\\s+/g, " ").slice(0, 40);
    const label = (n) => n.getAttribute("aria-label") || "";
    const destroyers = sh ? [...sh.querySelectorAll("button,a[href]")].filter((n) => W.test(words(n)) || W.test(label(n))) : [];
    return { inSheet: !!sh && !!a && sh.contains(a), on: a === sh ? "the sheet itself" : a ? words(a) : "",
      onDestroyer: !!a && (a.matches(DESTROYS) || W.test(words(a)) || W.test(label(a))),
      destroyers: destroyers.map((n) => label(n) || words(n)), unmarked: destroyers.filter((n) => !n.matches(DESTROYS)).map((n) => label(n) || words(n)) };
  })()`);
  // A real Enter, sent the moment a sheet is there (before it has finished rising): it must press nothing that destroys.
  const enterAtOnce = async (page) => {
    for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
  };
  /** Chooses files on the box's file input, as the phone's picker does (its change event, the files set). */
  const choose = async (page, files) => {
    const { root } = await page.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".as-file-input" });
    if (!nodeId) throw new CheckError("no file input in the box");
    await page.send("DOM.setFileInputFiles", { nodeId, files });
  };
  /** The height and width a control is pressed at: the larger of its box and its ::before's. */
  const pressed = (page, sel) => json(page, `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const r = n.getBoundingClientRect(); const b = getComputedStyle(n, "::before");
    const bh = b.content === "none" ? 0 : parseFloat(b.height) || (r.height - parseFloat(b.top || 0) - parseFloat(b.bottom || 0)); const bw = b.content === "none" ? 0 : parseFloat(b.width) || (r.width - parseFloat(b.left || 0) - parseFloat(b.right || 0));
    return { h: Math.max(r.height, bh), w: Math.max(r.width, bw) }; })()`);
  const shot = async (page, name) => { if (SHOTS) await page.shot(path.join(SHOTS, `390-${name}.png`)); };
  // A state that moves on by itself (Reading…, its dots never still): taken at once, never waiting for the page to rest.
  const snap = async (page, name) => { if (!SHOTS) return; const { data } = await page.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(SHOTS, `390-${name}.png`), Buffer.from(data, "base64")); };
  /** What is drawn just above the box at its left and middle (nothing of the page should peek out there). */
  const aboveBox = (page) => json(page, `(() => { const r = document.querySelector(".as-box .ch-box-row").getBoundingClientRect(); const ys = [r.top - 6, r.top - 2];
    const name = (n) => (n.id ? "#" + n.id : n.tagName.toLowerCase()) + "." + String(n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className).split(" ").filter(Boolean).join(".");
    return ys.flatMap((y) => [r.left + 60, r.left + r.width / 2].map((x) => document.elementsFromPoint(x, y).slice(0, 5).map(name).join(" > "))); })()`);

  // ═══ 1. the paperclip ═══════════════════════════════════════════════════════════════════
  section("1. The paperclip in the assistant's box");
  const p = await pageAs(ada);
  await go(p, "#/chat/assistant");
  await p.until(`document.querySelector(".as-attach") && document.querySelector(".as-empty, .as-list") ? 1 : 0`, "the Assistant tab with its box");
  const clip = await json(p, `({ label: document.querySelector(".as-attach").getAttribute("aria-label"), off: document.querySelector(".as-attach").disabled, accept: document.querySelector(".as-file-input").accept, multiple: document.querySelector(".as-file-input").multiple })`);
  check("a paperclip, named, on", clip.label === "Add a document or a photo" && !clip.off, JSON.stringify(clip));
  check("  it offers files, and on a phone the camera and the photo library (image/* beside the document types)", /image\/\*/.test(clip.accept) && /application\/pdf/.test(clip.accept) && /\.docx/.test(clip.accept) && clip.multiple, clip.accept);
  const clipSize = await pressed(p, ".as-attach");
  check("  pressed at 44 px or more each way", clipSize && clipSize.h >= 44 && clipSize.w >= 44, JSON.stringify(clipSize));
  await shot(p, "light-assistant-list");

  // ═══ 2. chosen on the list: a conversation for it, Reading, then ready ════════════════════
  section("2. Chosen on the list: Reading, then ready");
  await choose(p, [PDF]);
  await p.until(`/^#\\/chat\\/assistant\\/.+/.test(location.hash) ? 1 : 0`, "a conversation made for it, opened");
  await p.until(`document.querySelector('.as-file[data-state="reading"]') ? 1 : 0`, "its chip, reading", 5000);
  const reading = await json(p, `({ chip: document.querySelector(".as-file").textContent, send: document.querySelector(".ch-send").disabled, why: document.querySelector(".ch-send").getAttribute("aria-description") })`);
  check("its chip says it's being read, with its name", /amsterdam-draft\.pdf/.test(reading.chip) && /Reading/.test(reading.chip), reading.chip);
  await p.eval(`(() => { const i = document.querySelector("#as-input"); i.value = "Turn it into our trip"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  const whileReading = await json(p, `({ off: document.querySelector(".ch-send").disabled, why: document.querySelector(".ch-send").getAttribute("aria-description") })`);
  check("  Ask is off while it's read, and says why in words", whileReading.off && whileReading.why === "Wait for amsterdam-draft.pdf to be read.", JSON.stringify(whileReading));
  await sleep(900);   // the slide from the list ends (the conversion is still held)
  check("  still reading after the screen's slide (the still shows Reading)", (await read(p, `document.querySelector('.as-file[data-state="reading"]') ? 1 : 0`)) === 1, "");
  await snap(p, "light-reading");
  await p.until(`document.querySelector('.as-file[data-state="ready"]') ? 1 : 0`, "its chip, ready", 15000);
  const ready = await json(p, `({ chip: document.querySelector(".as-file").textContent, off: document.querySelector(".ch-send").disabled, why: document.querySelector(".ch-send").getAttribute("aria-description") })`);
  check("then ready, with its pages; Ask on again, saying nothing", /amsterdam-draft\.pdf/.test(ready.chip) && /1 page/.test(ready.chip) && !ready.off && ready.why === null, JSON.stringify(ready));
  await p.eval(`(() => { const i = document.querySelector("#as-input"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  const placeholder = await read(p, `document.querySelector("#as-input").placeholder`);
  check("  the box asks what to do with it, on one line at 390", placeholder === "Say what to do with it" && (await read(p, `document.querySelector("#as-input").scrollWidth <= document.querySelector("#as-input").clientWidth + 1`)) === true, placeholder);
  const chipSize = await pressed(p, ".as-file");
  check("  its chip is pressed at 44 px or more high", chipSize && chipSize.h >= 44, JSON.stringify(chipSize));
  await shot(p, "light-ready");
  const conv = (await read(p, `decodeURIComponent(location.hash.split("/").pop())`));
  const kept = await ada.get(`/api/trips/${trip}/assistant/conversations/${encodeURIComponent(conv)}/files`);
  check("  kept on the server, read", kept.status === 200 && kept.json.files.length === 1 && kept.json.files[0].state === "ready", JSON.stringify(kept.json?.files?.map((f) => [f.name, f.state])));
  // Its sheet holds Delete this document alone: the first focus passes over it, and an Enter the moment it opens
  // deletes nothing.
  await p.click('.as-file[data-state="ready"]');
  await p.until(`document.querySelector('.sh-sheet [data-do="delete"]') ? 1 : 0`, "the document's sheet");
  await enterAtOnce(p);
  await p.rest();
  const readyFocus = await focusRule(p);
  check("  its sheet: the focus is in it, on nothing that destroys, and Delete carries the mark", readyFocus.inSheet && !readyFocus.onDestroyer && readyFocus.destroyers.includes("Delete this document") && readyFocus.unmarked.length === 0, JSON.stringify(readyFocus));
  const afterEnter = await ada.get(`/api/trips/${trip}/assistant/conversations/${encodeURIComponent(conv)}/files`);
  check("  a real Enter the moment it opened deleted nothing", afterEnter.json.files.length === 1 && (await read(p, `document.querySelectorAll('.as-files .as-file[data-state="ready"]').length`)) === 1, JSON.stringify(afterEnter.json.files.map((f) => f.name)));
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await p.until(`document.querySelector('.sh-sheet [data-do="delete"]') ? 0 : 1`, "the document's sheet closed", 5000);
  await p.rest();

  // ═══ 3. a refusal in the server's own words ═════════════════════════════════════════════
  section("3. A file that isn't a document: refused in the server's words");
  await choose(p, [JUNK]);
  await p.until(`document.querySelector('.as-file[data-state="refused"]') ? 1 : 0`, "its chip, not added", 10000);
  const refused = await json(p, `({ chip: document.querySelector('.as-file[data-state="refused"]').textContent, said: document.querySelector(".as-said").hidden ? "" : document.querySelector(".as-said").textContent })`);
  check("its chip says it wasn't added, and the box says why in the server's own sentence", /notes\.bin/.test(refused.chip) && /not added/.test(refused.chip) && /^notes\.bin wasn't added: .{12,}/.test(refused.said), JSON.stringify(refused));
  await shot(p, "light-refused");
  await p.click('.as-file[data-state="refused"]');
  await p.until(`document.querySelector('[data-do="drop"]') ? 1 : 0`, "its sheet");
  await enterAtOnce(p);
  await p.rest();   // the sheet has finished rising before anything in it is pressed
  const dropFocus = await focusRule(p);
  check("  its sheet: the focus is in it, not on Remove it, which carries the mark; an Enter as it opened removed nothing",
    dropFocus.inSheet && !dropFocus.onDestroyer && dropFocus.destroyers.includes("Remove it") && dropFocus.unmarked.length === 0
      && (await read(p, `document.querySelectorAll('.as-files .as-file[data-state="refused"]').length`)) === 1, JSON.stringify(dropFocus));
  const sheetLine = await text(p, ".as-sheet-line");
  check("  its sheet says why, and removes it", /It wasn't added: /.test(sheetLine), sheetLine);
  await p.click('[data-do="drop"]');
  await p.until(`document.querySelector('.as-file[data-state="refused"]') ? 0 : 1`, "the refused chip gone");
  const after = await ada.get(`/api/trips/${trip}/assistant/conversations/${encodeURIComponent(conv)}/files`);
  check("  gone from the box, and nothing of it kept", after.json.files.length === 1 && (await read(p, `document.querySelector(".as-said").hidden`)) === true, JSON.stringify(after.json.files.map((f) => f.name)));

  // ═══ 4. the ask carries it ══════════════════════════════════════════════════════════════
  section("4. The question carries the document, and keeps it");
  const calls0 = model.calls.length;
  model.next({ tools: [{ name: "read_document", arguments: {} }], hang: 800 });
  model.next({ words: "I read your planning document and added its days to the trip.", hang: 800 });
  await p.type("#as-input", "Turn it into our trip");
  await p.click(".ch-send");
  await p.until(`document.querySelector(".as-a:not(.as-working) .as-a-body") ? 1 : 0`, "the answer", 20000);
  const asked = model.calls.slice(calls0)[0]?.body?.messages?.at(-1)?.content ?? "";
  check("the request carried the document: the model was told it is attached, by name", /\[Attached: "amsterdam-draft\.pdf"/.test(asked), asked.slice(-200));
  const q = await json(p, `[...document.querySelectorAll(".as-q .as-q-files .as-file")].map((n) => n.textContent)`);
  check("  the question shows it under its bubble; the box is empty of it", q.length === 1 && /amsterdam-draft\.pdf/.test(q[0]) && (await read(p, `document.querySelector(".as-files").hidden`)) === true, JSON.stringify(q));
  check("  nothing of the page peeks out just above the box (the toast, the button) once it's answered", true, JSON.stringify(await aboveBox(p)));
  await shot(p, "light-asked");
  await go(p, `#/chat/assistant/${encodeURIComponent(conv)}`);
  await p.until(`document.querySelector(".as-q-files") ? 1 : 0`, "the question again, after a reload", 10000);
  check("  there again after a reload (the server keeps it with the question)", /amsterdam-draft\.pdf/.test(await text(p, ".as-q-files")), await text(p, ".as-q-files"));

  // ═══ 5. More: its documents, with delete ════════════════════════════════════════════════
  section("5. More lists its documents, each with Delete");
  await p.click('.as-more[data-act="more"]');
  await p.until(`document.querySelector(".as-doc") ? 1 : 0`, "the sheet's documents");
  await enterAtOnce(p);
  await p.rest();
  const moreFocus = await focusRule(p);
  const stillThere = await ada.get(`/api/trips/${trip}/assistant/conversations/${encodeURIComponent(conv)}/files`);
  check("its sheet: the focus is in it, on nothing that destroys; each Delete carries the mark; an Enter as it opened deleted nothing",
    moreFocus.inSheet && !moreFocus.onDestroyer && moreFocus.destroyers.includes("Delete amsterdam-draft.pdf") && moreFocus.destroyers.includes("Delete this conversation")
      && moreFocus.unmarked.length === 0 && stillThere.json.files.length === 1 && (await read(p, `document.querySelectorAll(".as-doc").length`)) === 1,
    JSON.stringify({ ...moreFocus, files: stillThere.json.files.length }));
  const docs =await json(p, `[...document.querySelectorAll(".as-doc")].map((n) => n.textContent)`);
  check("the sheet lists the document, its pages, with Delete", docs.length === 1 && /amsterdam-draft\.pdf/.test(docs[0]) && /1 page/.test(docs[0]) && /Delete/.test(docs[0]), JSON.stringify(docs));
  const delSize = await pressed(p, ".as-doc-del");
  check("  Delete pressed at 44 px or more high", delSize && delSize.h >= 44, JSON.stringify(delSize));
  await shot(p, "light-more-documents");
  await p.click('[data-do="delete-doc"]');
  await p.until(`document.querySelector(".as-doc") ? 0 : 1`, "the document gone from the sheet");
  const gone = await ada.get(`/api/trips/${trip}/assistant/conversations/${encodeURIComponent(conv)}/files`);
  check("  deleted on the server", gone.json.files.length === 0, JSON.stringify(gone.json.files));
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await p.until(`document.querySelector('.as-q-files .as-file[data-state="gone"]') ? 1 : 0`, "the question's chip, deleted", 5000);
  check("  the question keeps its name, crossed out, \"deleted\"", /deleted/.test(await text(p, ".as-q-files")), await text(p, ".as-q-files"));

  // ═══ 6. no signal ═══════════════════════════════════════════════════════════════════════
  section("6. With no signal the paperclip is off, saying why");
  await p.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await p.until(`document.querySelector(".as-attach").disabled ? 1 : 0`, "the paperclip off", 5000);
  const off = await read(p, `document.querySelector(".as-attach").getAttribute("aria-description")`);
  check("off, with its reason in words", /^No signal: /.test(off || ""), off);
  await p.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await p.close();

  // ═══ 7. the stills in dark ══════════════════════════════════════════════════════════════
  if (SHOTS) {
    section("7. Stills, dark");
    const d = await pageAs(ada, "dark");
    await go(d, "#/chat/assistant");
    await d.until(`document.querySelector(".as-attach") ? 1 : 0`, "the box");
    await d.shot(path.join(SHOTS, "390-dark-assistant-list.png"));
    model.next({ words: "Done.", hang: 200 });
    await choose(d, [PDF]);
    await d.until(`document.querySelector('.as-file[data-state="reading"]') ? 1 : 0`, "reading", 5000);
    await sleep(900);
    await snap(d, "dark-reading");
    await d.until(`document.querySelector('.as-file[data-state="ready"]') ? 1 : 0`, "ready", 15000);
    await d.shot(path.join(SHOTS, "390-dark-ready.png"));
    await choose(d, [JUNK]);
    await d.until(`document.querySelector('.as-file[data-state="refused"]') ? 1 : 0`, "refused", 10000);
    await d.shot(path.join(SHOTS, "390-dark-refused.png"));
    await d.close();
  }

  // ═══ 8. on a conversation, the Back above the box ═══════════════════════════════════════
  section("8. On a conversation the dock's Back rides above the box");
  {
    const b = await pageAs(ada, "dark");
    await go(b, "#/chat/assistant");
    // The conversation asked in part 4, made long enough to scroll (ten more made-up turns in this check's own
    // database), so its last message would end under the Back if the conversation kept no room for it.
    const seq0 = Number(server.sql(`SELECT COALESCE(MAX(seq), 0) AS n FROM ai_turns WHERE user_id = '${ada.user.id}' AND conversation_id = '${conv}'`)[0].n);
    for (let i = 1; i <= 10; i++) {
      const person = i % 2 === 1;
      server.sql(`INSERT INTO ai_turns (user_id, conversation_id, id, seq, role, words, detail, created_at) VALUES ('${ada.user.id}', '${conv}', 'q-long-${i}${person ? "" : ".answer"}', ${seq0 + i}, '${person ? "person" : "assistant"}',
        '${person ? "And what about the museums on Thursday?" : "Thursday has the Van Gogh Museum at ten and lunch at the Foodhallen after. Both are on the trip, and nothing is booked yet."}', '{}', ${Math.floor(Date.now() / 1000) - 600 + i})`);
    }
    // Opened from the list as a person would.
    const row = `.as-row[href="#/chat/assistant/${encodeURIComponent(conv)}"]`;
    await b.until(`document.querySelector(${JSON.stringify(row)}) ? 1 : 0`, "that conversation in the list");
    await b.click(row);
    await b.until(`document.body.dataset.back === "1" && document.querySelector("#backbtn") && document.querySelector(".as-turns .as-a:not(.as-working)") ? 1 : 0`, "the conversation, its answer, with Back", 10000);
    const geom = () => json(b, `(() => { const bb = document.querySelector("#backbtn").getBoundingClientRect(), bx = document.querySelector(".as-box").getBoundingClientRect();
      const v = document.querySelector("#view"); v.scrollTop = v.scrollHeight; const last = [...document.querySelectorAll(".as-turns > li")].pop();
      const lr = last ? last.getBoundingClientRect() : null;
      return { back: [bb.left, bb.top, bb.right, bb.bottom].map(Math.round), box: [bx.left, bx.top, bx.right, bx.bottom].map(Math.round), gap: Math.round(bx.top - bb.bottom), h: Math.round(bb.height), lastEnd: lr ? Math.round(lr.bottom) : null }; })()`);
    const clear = (g) => g.back[3] <= g.box[1] && g.h >= 44 && Math.abs(g.gap - 8) <= 1 && g.lastEnd !== null && g.lastEnd <= g.back[1];
    await sleep(500);
    const g1 = await geom();
    check("no chip: Back clear of the box, its foot 8 px over it, 44 px or more, and the last message ends above it", clear(g1), JSON.stringify(g1));
    await b.rest();
    await snap(b, "dark-back-no-chip");   // the viewport as it is (a whole-page capture moves what's fixed)
    await choose(b, [PDF]);
    await b.until(`document.querySelector('.as-files .as-file[data-state="ready"]') ? 1 : 0`, "a chip, ready", 15000);
    await sleep(300);
    const g2 = await geom();
    check("  with a chip: the Back rises with the box", clear(g2) && g2.back[3] < g1.back[3], JSON.stringify(g2));
    await b.rest();
    await snap(b, "dark-back-chip");
    // The keys up, as the shell says so (index.html: --kb-h on <html>, data-kb on <body>; the box's own --kb-h).
    await b.eval(`(() => { document.documentElement.style.setProperty("--kb-h", "320px"); document.body.dataset.kb = "1"; document.querySelector(".as-box").style.setProperty("--kb-h", "320px"); return 1; })()`);
    await sleep(400);
    const g3 = await geom();
    check("  with the keyboard up: the Back rides above the box, over the keys", clear(g3) && g3.back[3] < g2.back[3], JSON.stringify(g3));
    // For the still only: a block, said to be the keyboard, where the keys would cover the screen's foot.
    await b.eval(`(() => { const k = document.createElement("div"); k.id = "kb-standin"; k.textContent = "the keyboard (stood in for this still)";
      k.style.cssText = "position:fixed;left:0;right:0;bottom:0;height:320px;z-index:99;display:grid;place-items:center;background:var(--gray-3);color:var(--ink-2);font:500 14px/20px var(--type-ui)";
      document.body.append(k); return 1; })()`);
    await snap(b, "dark-back-keyboard");
    await b.eval(`(document.getElementById("kb-standin")?.remove(), 1)`);
    await b.eval(`(() => { document.documentElement.style.setProperty("--kb-h", "0px"); document.body.dataset.kb = "0"; document.querySelector(".as-box").style.removeProperty("--kb-h"); return 1; })()`);
    await sleep(300);
    await b.click("#backbtn");
    await b.until(`location.hash === "#/chat/assistant" && document.querySelector(".as-list, .as-empty") ? 1 : 0`, "the list again", 8000).catch(() => {});
    check("  a tap on Back goes back to the list", (await read(b, `location.hash`)) === "#/chat/assistant", await read(b, `location.hash`));
    await b.close();
  }

  check("no page error", pageErrors.length === 0, pageErrors.join(" | "));
} catch (e) {
  fail++; failures.push(`ran to the end: ${e?.message ?? e}`);
  console.log(`  FAIL  the check stopped: ${String(e?.stack || e).slice(0, 900)}`);
} finally {
  await chrome?.close().catch(() => {});
  await server?.stop().catch(() => {});
  await model?.close().catch(() => {});
  await new Promise((r) => (convert ? convert.close(r) : r()));
  fs.rmSync(path.dirname(JUNK), { recursive: true, force: true });
}
console.log(`\na document given the assistant, in the app: ${pass} passed, ${fail} failed`);
if (failures.length) console.log(failures.map((f) => `  FAILED  ${f}`).join("\n"));
process.exit(fail ? 1 : 0);
