// Notes on plans are messages in the chat (migration 0027), as the app shows them, in a browser:
//
//   node checks/chat/agenda.mjs [--port <port>] [--shots <folder>]
//
// On a server of its own, a made-up trip of three made-up people. It holds:
//   - the Agenda has no notes and no note box: a plan something was said about carries a small
//     chip with the chat's glyph and how many, and so does the free time before a plan (a count:
//     the words are on the free time's page and in the chat, never lines in the itinerary);
//   - a plan's page lists what was said about it, oldest first, newest last, by name; the free
//     time's page lists what was said about that time; neither page has a box to write in;
//   - "Chat about this" (and "Chat about this time") opens the chat with that plan held above
//     the box, and what is sent from there shows on the plan's page and on the Agenda;
//   - another person's message about the plan reaches an open plan page with no reload;
//   - a message removed in the chat goes from the plan's page;
//   - no page has an error.
// --shots: stills at 320 and 390 wide, light and dark (made-up trip only).

import fs from "node:fs";
import path from "node:path";
import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8795);
const shots = flag("--shots");
if (shots) fs.mkdirSync(shots, { recursive: true });
const t = new Report("notes on plans, as the chat's messages, in the app");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server, chrome, code = 1;
try {
  server = await startServer({ name: "chat-agenda", port });
  await server.start();
  const { origin } = server;
  const [ada, ben, cleo] = ["Ada Reyes", "Ben Okafor", "Cleo Tran"].map((n) => new Person(origin, n));
  for (const p of [ada, ben, cleo]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  // The trip is on now, so the Agenda opens on its days.
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const made = await ada.post("/api/trips", { name: "Coast week", default_tz: "UTC", starts_on: day(-1), ends_on: day(5), currencies: ["EUR"] });
  if (made.status !== 201) throw new CheckError(`trip: ${made.status} ${made.text}`);
  const trip = made.json.trip.id;
  const T = `/api/trips/${trip}`;
  for (const p of [ben, cleo]) {
    const link = (await ada.post(`${T}/links`, { uses: 1 })).json.link;
    await p.post(`/api/join/${link.code}`);
  }
  const at = (d, h) => Math.floor(Date.parse(`${day(d)}T${String(h).padStart(2, "0")}:00:00Z`) / 1000);
  for (const [id, title, d, h] of [["breakfast", "Breakfast at the bakery", 1, 8], ["boat", "Boat to the island", 1, 11], ["dinner", "Dinner by the harbour", 1, 19]]) {
    const r = await ada.post(`${T}/events`, { id, title, starts_at: at(d, h), tz: "UTC" });
    if (r.status !== 201) throw new CheckError(`event ${id}: ${r.status} ${r.text}`);
  }
  const M = `${T}/messages`;
  const say = (who, id, body, about) => who.post(M, { id, body, about });
  await say(ben, "m-1", "Bring cash, the boat takes no cards", { kind: "event", id: "boat" });
  await sleep(1100);
  await say(cleo, "m-2", "I'll get the tickets", { kind: "event", id: "boat" });
  await sleep(1100);
  await say(ben, "m-3", "Time for a swim before the boat?", { kind: "event", id: "boat", part: "before" });
  await sleep(1100);
  await say(cleo, "m-4", "Coffee at the pier first", { kind: "event", id: "boat", part: "before" });
  await say(ada, "m-5", "Who's in for the market?");

  chrome = await openChrome();
  const page = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
  await page.setCookie(origin, "wgp_session", ada.jar.cookies.get("wgp_session"));
  await page.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(ada.user.id), sameSite: "Lax" });
  const go = async (hash, ready, what) => { await page.open(`${origin}/t/${trip}/${hash}`); await page.until(ready, what, 20000); await sleep(600); };
  const shoot = async (name) => {
    if (!shots) return;
    for (const [w, h] of [[390, 844], [320, 640]]) for (const scheme of ["light", "dark"]) {
      await page.size({ width: w, height: h, mobile: true });
      await page.scheme(scheme);
      await sleep(400);
      // Two frames drawn first, and a blank capture taken again: headless Chrome sometimes hands back
      // the page's background alone after a change of address, though the page is drawn (measured
      // 15 Nov: the chat's DOM visible, the point at its middle a message, the capture 7 KB of ground).
      let png = null;
      for (let tries = 0; tries < 4 && !(png?.length > 20000); tries++) {
        await page.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        png = Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64");
        if (png.length <= 20000) await sleep(500);
      }
      if (png.length <= 20000) throw new CheckError(`the still ${name}-${w}-${scheme} came out blank four times`);
      fs.writeFileSync(path.join(shots, `${name}-${w}-${scheme}.png`), png);
    }
    await page.size({ width: 390, height: 844, mobile: true });
    await page.scheme("light");
  };

  t.part("The Agenda");
  await go("#/", `!!document.querySelector('.ag-slot[data-k="c:boat"]')`, "the Agenda's boat");
  const agenda = JSON.parse(await page.eval(`JSON.stringify({
    chip: (document.querySelector('.ag-slot[data-k="c:boat"] .ag-talk') || {}).textContent?.trim() || null,
    chipLabel: document.querySelector('.ag-slot[data-k="c:boat"] .ag-talk')?.getAttribute("aria-label") || null,
    others: [...document.querySelectorAll('.ag-slot:not([data-k="c:boat"]) .ag-talk')].length,
    gap: (() => { const r = [...document.querySelectorAll(".ag-rail")].find((x) => x.querySelector(".ag-talk-gap")); return r ? [r.querySelector(".ag-talk-gap").textContent.trim(), r.querySelector(".ag-gaplink").getAttribute("aria-label")] : null; })(),
    words: document.body.innerText.includes("Time for a swim before the boat?"),
    stickies: document.querySelectorAll(".ag-hn, .ag-sticky, .ag-comp, .ag-gn").length,
  })`));
  t.same("the boat carries a chip with how many were said about it (2), the plans nobody wrote about none",
    [agenda.chip, agenda.chipLabel, agenda.others], ["2", "2 messages about this plan", 0]);
  t.same("the free time before the boat carries a count of what was said about it (2), named in its link's words, and none of the words themselves; no sticky notes or note box anywhere",
    [agenda.gap, agenda.words, agenda.stickies], [["2", "3h free, 2 messages about this time"], false, 0]);
  await page.eval(`document.querySelector('.ag-slot[data-k="c:boat"]').scrollIntoView({ block: "center" }), 1`);
  await shoot("1-agenda");

  t.part("A plan's page, and the time before it");
  await go("#/e/boat", `document.querySelectorAll(".ch-said-row").length >= 2`, "the boat's page with what was said");
  const said = JSON.parse(await page.eval(`JSON.stringify({ rows: [...document.querySelectorAll(".ch-said-row")].map((r) => [r.querySelector(".ch-said-who b").textContent, r.querySelector(".ch-said-body").textContent]), box: !!document.querySelector(".ag-comp, textarea"), head: document.querySelector(".ag-d-said .ag-d-h2")?.textContent.trim() })`));
  t.same("the plan's page lists what was said about it, oldest first, by name, under \"Said about this plan\", with no box to write in",
    [said.head, said.rows, said.box], ["Said about this plan", [["Ben Okafor", "Bring cash, the boat takes no cards"], ["Cleo Tran", "I'll get the tickets"]], false]);
  await shoot("2-plan");
  await go("#/e/boat?gap=1", `document.querySelectorAll(".ch-said-row").length >= 2`, "the free time's page");
  const gap = JSON.parse(await page.eval(`JSON.stringify({ rows: [...document.querySelectorAll(".ch-said-row .ch-said-body")].map((b) => b.textContent), button: document.querySelector('[data-plan-chat="before"]')?.textContent.trim() || null })`));
  t.same("the free time's page lists what was said about that time, and offers \"Chat about this time\"",
    [gap.rows, gap.button], [["Time for a swim before the boat?", "Coffee at the pier first"], "Chat about this time"]);
  await shoot("3-free-time");
  // "Chat about this time": the chat holds the time, named as its own page names it.
  await page.click('[data-plan-chat="before"]');
  await page.until(`location.hash.startsWith("#/chat") && !!document.querySelector(".ch-held .ch-card-kind")`, "the chat holding the free time", 20000);
  await sleep(600);
  const heldGap = JSON.parse(await page.eval(`JSON.stringify([document.querySelector(".ch-held .ch-card-kind").textContent.trim(), document.querySelector(".ch-held .ch-card-title").textContent.trim(),
    [...document.querySelectorAll(".ch-msg .ch-card-kind")].map((k) => k.textContent.trim())])`));
  t.same("the chat holds the free time as \"Free time\", \"Before Boat to the island\", and the messages about it are headed so too (never \"Plan · before it\")",
    [heldGap[0], heldGap[1], heldGap[2].includes("Free time"), heldGap[2].some((k) => /before it/i.test(k))], ["Free time", "Before Boat to the island", true, false]);
  await shoot("3b-chat-free-time");

  t.part("Chat about this");
  await go("#/e/boat", `!!document.querySelector("[data-plan-chat]")`, "the boat's page");
  await page.click("[data-plan-chat]");
  await page.until(`location.hash.startsWith("#/chat") && !!document.querySelector(".ch-box")`, "the chat", 20000);
  await sleep(800);
  const held = await page.eval(`(document.querySelector(".ch-held") || {}).innerText || ""`);
  t.ok("\"Chat about this\" opens the chat with the boat held above the box", /Boat to the island/.test(held), held.slice(0, 160));
  await shoot("4-chat-held");
  // Sent once the box has emptied; tapped again (up to three times) while the words are still in it:
  // on a loaded machine the box could move between where the tap was aimed and the press (15 Nov).
  await page.type("#ch-input", "Life jackets are on board");
  for (let i = 0; i < 3; i++) {
    await page.click(".ch-send");
    if (await page.until(`document.getElementById("ch-input").value === ""`, "the box emptied by the send", 5000).then(() => true, () => false)) break;
  }
  let sent = null;
  for (let i = 0; i < 50 && !sent; i++) { await sleep(200); sent = server.sql(`SELECT about_kind, about_id FROM messages WHERE trip_id = '${trip}' AND body = 'Life jackets are on board'`)[0] ?? null; }
  t.same("what is sent from there is a message about the boat", sent, { about_kind: "event", about_id: "boat" });
  await go("#/e/boat", `document.querySelectorAll(".ch-said-row").length >= 3`, "the boat's page with the new one");
  t.ok("and it shows last on the plan's page", /Life jackets are on board/.test(await page.eval(`[...document.querySelectorAll(".ch-said-row")].at(-1).textContent`)));

  t.part("From other phones, with no reload");
  await say(ben, "m-6", "The island has no shop", { kind: "event", id: "boat" });
  const arrived = await page.until(`[...document.querySelectorAll(".ch-said-row")].some((r) => /no shop/.test(r.textContent))`, "Ben's message on the open page", 20000).then(() => true, () => false);
  await ben.call("DELETE", `${M}/m-1`);
  const left = await page.until(`![...document.querySelectorAll(".ch-said-row")].some((r) => /takes no cards/.test(r.textContent))`, "the removed one to go", 20000).then(() => true, () => false);
  t.same("another person's message about the plan arrives on the open page, and one removed in the chat goes, with no reload", [arrived, left], [true, true]);
  await go("#/", `!!document.querySelector('.ag-slot[data-k="c:boat"] .ag-talk')`, "the Agenda again");
  t.same("the Agenda's chip counts what is there now (3)", await page.eval(`document.querySelector('.ag-slot[data-k="c:boat"] .ag-talk').textContent.trim()`), "3");

  t.ok("no page has an error", page.errors.length === 0, JSON.stringify(page.errors.slice(0, 3)));
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await chrome?.close();
  await server?.stop();
}
process.exit(code);
