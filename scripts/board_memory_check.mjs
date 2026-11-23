#!/usr/bin/env node
/* A shared board and the memories on it; a full trip said in words; an upload that outlived
 * its day. Two people, two browsers.
 *
 * Chrome needs the Bash sandbox disabled, and the launcher (scripts/lib/browser.mjs) starts it
 * only through the queue:
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> --label <what> -- node scripts/board_memory_check.mjs
 *
 * Why it exists: a shared board is a link anyone can open, holding copies of people's
 * photographs. A person who deletes their photograph has to have deleted it from the links
 * too, which only works if every copy says which memory it came from. And a trip's storage is
 * its host's: when it is full the server says whose room it is and who can free it, and the
 * app has to pass that sentence on instead of "Rejected (413)".
 *
 * ITS OWN SERVER (checks/lib/server.mjs: an empty database under .wrangler/check/, removed
 * afterwards) on a port that is free when it runs, because it fills a trip's storage and ages
 * an upload in the database. That server is made this process's base URL, whatever the caller
 * set (scripts/lib/browser.mjs, ownServer).
 * Two made-up people sign up with passkeys over plain HTTP (checks/lib/person.mjs).
 *
 * WHAT IT PROVES
 *   1. Each of two people posts a memory through the composer.
 *   2. One shares the board as a link. Every photograph the app sends for it names its
 *      memory, the server's rows hold a memory of the trip for each, and the link opens.
 *      The board's sheet lists the trip's shared links to every member: who made each and
 *      that anyone with the link can open it. Its maker and the trip's host are offered
 *      "Stop sharing…"; another member is offered only "Copy link". The list fits at 320
 *      and 390 wide.
 *      Stopping asks first and can be backed out of; a refusal from the server is said and
 *      the board stays shared; its maker stops one, the host stops a member's, and each
 *      reads why on their own phone, in words that differ for who is reading. Each link
 *      answers 404 from then on.
 *   3. The host deletes their memory. Before: the sheet says a shared board shows it and
 *      will stop. After: their app says a board went with it; the link answers 404; the
 *      list says a memory on it was deleted. A memory on no board says nothing, before or
 *      after. Only the host is offered Delete on someone else's memory, and it deletes.
 *   4. With the host's storage full: an upload's card says "No room" and, under it, the
 *      server's own sentence, which differs for the host and for a member; the card still
 *      offers Retry and Discard and nothing spills sideways; sharing a board says the
 *      sentence in the sheet and shows no link, and at 320 and 390 wide the sentence wraps
 *      inside the sheet with its title, its three buttons and its close button on screen.
 *   5. An upload whose reservation ran out between two parts (the row aged in the database
 *      while the request was held) begins again by itself and lands as a memory, without a
 *      failed card.
 *
 * WGP_SHOTS=<folder> also writes a picture of each sentence at 320, 390, 768 and 1440 wide
 * in both themes, to look at. Nothing is asserted from them.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";
import { pickPhotos, cdpPage } from "./lib/photo_picker.mjs";

// The server first: everything below that reads the base URL must find this one.
const server = await startServer({ name: "board-memory", port: await freeLoopbackPort() });
ownServer(server.origin);
const { REPO, appSettled, boot, evalIn, sleep, waitFor } = await import("./lib/standalone_cdp.mjs");

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 320) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 800) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const SHOTS = process.env.WGP_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
// A picture of what is on screen now, at each width and in both themes, for a person to look
// at. The theme goes through the app's own switch, and is put back as it was.
async function look(X, name, again = null) {
  if (!SHOTS) return;
  const was = await X.page(`localStorage.getItem("wgp.theme") || "system"`);
  for (const theme of ["light", "void"]) {
    await X.page(`import("/js/settings.js").then((m) => (m.applyTheme(${JSON.stringify(theme)}), 1))`);
    await sleep(700);                // the colors cross-fade; a picture taken sooner is in between
    for (const w of [320, 768, 1440, 390]) {
      await X.metrics(w, 844, 2);
      if (again) await again();      // a message that goes away by itself is shown again
      await sleep(400);
      await X.shot(path.join(SHOTS, `${w}-${theme}-${name}.png`));
    }
  }
  await X.page(`import("/js/settings.js").then((m) => (m.applyTheme(${JSON.stringify(was)}), 1))`);
  await X.metrics(390, 844, 1);
  await sleep(300);
}

// Three photographs of different sizes, made from a picture the tree already carries.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-board-"));
const SRC = path.join(REPO, "public/img/demo-hero.webp");
const photo = (name, px) => {
  const out = path.join(TMP, name);
  execFileSync("sips", ["-s", "format", "jpeg", "-Z", String(px), SRC, "--out", out], { stdio: "ignore" });
  return { path: out, name, bytes: fs.statSync(out).size };
};
const HARBOR = photo("harbor.jpg", 1600), MARKET = photo("market.jpg", 1400), LATE = photo("late.jpg", 1200), PIER = photo("pier.jpg", 1000);

const browsers = [];
try {
  await server.start();
  const day = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date(Date.now() + d * 86400e3));
  const host = new Person(server.origin, "Mara Voss"), member = new Person(server.origin, "Teo Lind");
  await host.signUp(); await member.signUp();
  const made = await host.post("/api/trips", { name: "Coast week", default_tz: "Europe/Lisbon", starts_on: day(0), ends_on: day(4) });
  const tripId = made.json.trip.id, T = `/api/trips/${tripId}`;
  const link = (await host.post(`${T}/links`, {})).json.link;
  await member.post(`/api/join/${link.code}`);

  // A browser signed in as one of them, on Memories, with every request it makes written down.
  async function browserOf(who) {
    const b = await boot({ vw: 390, vh: 844, dsf: 1 });
    browsers.push(b);
    const { cdp, S } = b;
    const sent = [];
    cdp.on((m) => { if (m.sessionId === S && m.method === "Network.requestWillBeSent") sent.push(`${m.params.request.method} ${m.params.request.url}`); });
    // boot() signs in a person of the lane's database; here the browser is this person's.
    await cdp.send("Network.deleteCookies", { name: "s2", url: server.origin }, S);
    await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: who.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
    const page = (expr) => evalIn(cdp, S, expr);
    const wait = (expr, label, timeout = 45000) => waitFor(cdp, S, expr, { label, timeout });
    const memories = async () => {
      await cdp.send("Page.navigate", { url: `${server.origin}/t/${tripId}/?${Date.now()}#/memories` }, S);
      await appSettled(cdp, S);
      await wait(`document.querySelector(".me-fab") ? 1 : 0`, "the Memories tab");
      await sleep(400);
    };
    const compose = async (file, caption) => {
      await pickPhotos({ ...cdpPage(cdp, S), files: [file.path] });   // Add photos: the phone's picker first, then the sheet
      await wait(`document.querySelectorAll(".me-pickrow").length === 1 ? 1 : 0`, "the picked file");
      await page(`(() => { const i = document.querySelector("#me-cap-in"); i.value = ${JSON.stringify(caption)}; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
      await wait(`document.querySelector(".me-go") && !document.querySelector(".me-go").disabled ? 1 : 0`, "Upload enabled");
      await page(`(document.querySelector(".me-go").click(), 1)`);
    };
    const card = (caption) => `[...document.querySelectorAll(".me-card")].find((c) => (c.querySelector(".me-cap") || {}).textContent === ${JSON.stringify(caption)})`;
    const toast = () => page(`(() => { const n = document.getElementById("toast"); return JSON.stringify({ hidden: n.hidden, text: n.textContent }); })()`).then(JSON.parse);
    // The board's sheet, opened from the feed, with its list of shared links.
    const boardSheet = async () => {
      await memories();
      await page(`(document.querySelector('.me-viewbtn[data-view="collage"]').click(), 1)`);
      await wait(`document.querySelector(".cg-look") ? 1 : 0`, "the board");
      await sleep(1500);
      await page(`(document.querySelector(".cg-look").click(), 1)`);
      await wait(`document.querySelector(".cg-links") ? 1 : 0`, "the board's sheet");
    };
    const closeSheet = async () => {
      await page(`(document.querySelector(".sh-root .sh-x").click(), 1)`);
      await wait(`document.querySelector(".cg-links") ? 0 : 1`, "the sheet closed");
      await sleep(300);
    };
    // The list as it reads on screen, once it holds `n` boards.
    const links = async (n) => {
      await wait(`document.querySelectorAll(".cg-link").length === ${n} ? 1 : 0`, `${n} shared link${n === 1 ? "" : "s"} listed`);
      return JSON.parse(await page(`JSON.stringify([...document.querySelectorAll(".cg-link")].map((li) => ({
        id: li.dataset.id, live: li.dataset.live === "1",
        who: li.querySelector(".cg-linkwho").textContent, state: li.querySelector(".cg-linkstate").textContent,
        copy: !!li.querySelector(".cg-linkcopy"), stop: !!li.querySelector(".cg-linkask1"),
        buttons: [...li.querySelectorAll("button")].map((x) => x.textContent) })))`));
    };
    // Share the board from its open sheet; answers the new link's id.
    const share = async () => {
      const before = await page(`(document.querySelector(".cg-shareurl") || {}).value || ""`);
      await page(`(document.querySelector('.cg-lookfoot .cg-save[data-kind="link"]').click(), 1)`);
      await wait(`(() => { const v = (document.querySelector(".cg-shareurl") || {}).value || ""; return v && v !== ${JSON.stringify(before)} ? 1 : 0; })()`, "the link", 90000);
      return (await page(`document.querySelector(".cg-shareurl").value`)).split("/s/")[1];
    };
    // Stop a board from the list: the first tap asks, the second does it.
    const askStop = async (id) => {
      await page(`(document.querySelector('.cg-link[data-id="${id}"] .cg-linkask1').click(), 1)`);
      await wait(`document.querySelector('.cg-link[data-id="${id}"] .cg-linkstop') ? 1 : 0`, "the question before stopping");
    };
    const stop = async (id) => {
      await askStop(id);
      await page(`(document.querySelector('.cg-link[data-id="${id}"] .cg-linkstop').click(), 1)`);
      await wait(`(document.querySelector('.cg-link[data-id="${id}"]') || { dataset: {} }).dataset.live === "0" ? 1 : 0`, "the board listed as stopped");
    };
    return { ...b, who, sent, page, wait, memories, compose, card, toast, boardSheet, closeSheet, links, share, askStop, stop };
  }

  // ── 1. two people, a memory each ────────────────────────────────────────────────────────
  section("1. each posts a memory through the composer");
  const A = await browserOf(host), B = await browserOf(member);
  await A.memories(); await B.memories();
  await A.compose(HARBOR, "Harbor at dawn");
  await A.wait(`${A.card("Harbor at dawn")} ? 1 : 0`, "the host's memory in the feed");
  await B.compose(MARKET, "Market stalls");
  await B.wait(`${B.card("Market stalls")} ? 1 : 0`, "the member's memory in the feed");
  const feed = (await member.get(`${T}/memories`)).json;
  const rows = feed.memories || feed.items || [];
  const harbor = rows.find((m) => m.caption === "Harbor at dawn"), market = rows.find((m) => m.caption === "Market stalls");
  check("both memories are on the trip, each with its photograph", !!harbor && !!market && harbor.media.length === 1 && market.media.length === 1,
    JSON.stringify(rows.map((m) => [m.caption, (m.media || []).length])));

  // ── 2. a board shared as a link ─────────────────────────────────────────────────────────
  section("2. the member shares the board; every photograph names its memory");
  const anyone = new Person(server.origin, "Nobody");
  // Enter, as a keyboard sends it to the window: it presses whatever has the focus.
  const pressEnter = async (X) => {
    for (const type of ["keyDown", "keyUp"]) {
      await X.cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r", unmodifiedText: "\r" } : {}) }, X.S);
    }
    await sleep(250);
  };
  const opens = async (id) => (await anyone.get(`/s/${id}`, { page: true })).status;
  const why = (id) => (server.sql(`SELECT revoked_why FROM collage_shares WHERE id = '${String(id).replace(/[^\w-]/g, "")}'`)[0] || {}).revoked_why;
  const row = (list, id) => list.find((r) => r.id === id) || { who: "", state: "", buttons: [] };
  await B.boardSheet();
  await B.wait(`(document.querySelector(".cg-linksnote").textContent || document.querySelector(".cg-link")) ? 1 : 0`, "the list read from the server");
  const empty = JSON.parse(await B.page(`JSON.stringify({ note: document.querySelector(".cg-linksnote").textContent, hidden: document.querySelector(".cg-linksnote").hidden, rows: document.querySelectorAll(".cg-link").length })`));
  check("a trip that has shared nothing says so", empty.note === "Nothing from this trip is shared yet." && empty.hidden === false && empty.rows === 0, JSON.stringify(empty));
  B.sent.length = 0;
  const shareId = await B.share();
  const itemsSent = B.sent.filter((u) => /^POST .*\/collage\/share\/[^/]+\/item\?/.test(u)).map((u) => new URL(u.split(" ")[1]).searchParams);
  const items = itemsSent.map((q) => q.get("memory"));
  check("the app sent a photograph for each memory on the board", items.length === 2, `${items.length} sent`);
  check("every one of them names the memory it came from", items.length > 0 && items.every(Boolean) && [...items].sort().join() === [harbor.id, market.id].sort().join(),
    JSON.stringify(items));
  const stored = server.sql(`SELECT memory_id FROM collage_share_items WHERE share_id = '${shareId.replace(/[^\w-]/g, "")}'`).map((r) => r.memory_id);
  check("the server's rows hold a memory of the trip for each", stored.length === 2 && stored.every((id) => id === harbor.id || id === market.id), JSON.stringify(stored));
  // Each names the photograph too, so the board keeps its thumbnail (the page draws small tiles from it).
  const photoOf = { [harbor.id]: harbor.media[0].id, [market.id]: market.media[0].id };
  check("…and which of the memory's photographs it is", itemsSent.length === 2 && itemsSent.every((q) => q.get("media") && q.get("media") === String(photoOf[q.get("memory")])),
    JSON.stringify(itemsSent.map((q) => [q.get("memory"), q.get("media")])));
  const thumbs = server.sql(`SELECT i.thumb_key AS kept, (SELECT m.thumb_key FROM memory_media m WHERE m.memory_id = i.memory_id) AS own FROM collage_share_items i WHERE i.share_id = '${shareId.replace(/[^\w-]/g, "")}'`);
  check("the server's rows keep each photograph's own thumbnail", thumbs.length === 2 && thumbs.every((r) => r.kept && r.kept === r.own), `${thumbs.filter((r) => r.kept && r.kept === r.own).length} of ${thumbs.length}`);
  check("the link opens for someone who isn't signed in", (await opens(shareId)) === 200);

  section("2b. the trip's shared links: to its maker, to the host, to another member");
  let mine = await B.links(1);
  check("its maker sees it as theirs, open to anyone with the link", mine[0].id === shareId && /^You · \S/.test(mine[0].who) && mine[0].state === "Anyone with the link can open it." && mine[0].live,
    JSON.stringify(mine[0]));
  check("…and is offered Copy link and Stop sharing…", mine[0].buttons.join(" | ") === "Copy link | Stop sharing…", mine[0].buttons.join(" | "));
  await B.page(`(document.querySelector(".cg-linkcopy").click(), 1)`);
  await sleep(500);
  const copied = await B.toast();
  check("Copy link says it copied, or shows the link to copy by hand", copied.hidden === false && (copied.text === "Link copied." || copied.text === `${server.origin}/s/${shareId}`), JSON.stringify(copied));
  await B.closeSheet();

  await A.boardSheet();
  let hosts = await A.links(1);
  check("the host sees who made it, by name", /^Teo Lind · \S/.test(hosts[0].who) && hosts[0].state === "Anyone with the link can open it.", JSON.stringify(hosts[0]));
  check("the host is offered Stop sharing… on a member's board", hosts[0].buttons.join(" | ") === "Copy link | Stop sharing…", hosts[0].buttons.join(" | "));
  await look(A, "links-as-host");
  const hostShare = await A.share();
  hosts = await A.links(2);
  check("a board the host shares joins the list, newest first", hosts[0].id === hostShare && /^You · /.test(hosts[0].who) && hosts[1].id === shareId, JSON.stringify(hosts.map((r) => [r.id === hostShare ? "host's" : "member's", r.who])));
  await A.closeSheet();

  await B.boardSheet();
  mine = await B.links(2);
  const theirs = row(mine, hostShare);
  check("another member sees the host's board, by the host's name", /^Mara Voss · \S/.test(theirs.who) && theirs.state === "Anyone with the link can open it.", JSON.stringify(theirs));
  check("…and is offered Copy link only: not theirs to stop", theirs.buttons.join(" | ") === "Copy link", theirs.buttons.join(" | "));
  check("…while their own still offers Stop sharing…", row(mine, shareId).stop === true);
  for (const w of [320, 390]) {
    await B.metrics(w, 844, 1);
    await sleep(350);
    await B.page(`(document.querySelector(".cg-links").scrollIntoView({ block: "start" }), 1)`);
    const fit = JSON.parse(await B.page(`(() => {
      const vw = document.documentElement.clientWidth;
      const box = (n) => { const q = n.getBoundingClientRect(); return { l: Math.round(q.left), r: Math.round(q.right), w: Math.round(q.width) }; };
      const within = (q) => q.l >= 0 && q.r <= vw && q.w > 0;
      const cards = [...document.querySelectorAll(".cg-link")];
      const btns = [...document.querySelectorAll(".cg-link button")].map(box);
      const lines = [...document.querySelectorAll(".cg-link p")];
      return JSON.stringify({ vw, cards: cards.map(box), cardsIn: cards.length === 2 && cards.map(box).every(within), btns, btnsIn: btns.length === 3 && btns.every(within),
        spill: Math.max(0, ...cards.map((c) => c.scrollWidth - c.clientWidth), ...lines.map((l) => l.scrollWidth - l.clientWidth)),
        small: btns.filter((q) => q.w < 44).length,
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth }); })()`));
    check(`${w} wide: both boards' cards and their three buttons are on screen, nothing spills`, fit.cardsIn && fit.btnsIn && fit.spill <= 0 && fit.page <= 0 && fit.small === 0, JSON.stringify(fit));
  }
  await B.metrics(390, 844, 1);
  await look(B, "links-as-member");

  section("2c. stopping a board: asked first, a refusal said, then its maker stops it");
  await B.askStop(shareId);
  const asking = JSON.parse(await B.page(`(() => { const li = document.querySelector('.cg-link[data-id="${shareId}"]');
    return JSON.stringify({ ask: (li.querySelector(".cg-linkask") || {}).textContent, buttons: [...li.querySelectorAll("button")].map((x) => x.textContent) }); })()`));
  check("the first tap asks, and says what stopping does", asking.ask === "Stop sharing this board? Its link will no longer open." && asking.buttons.join(" | ") === "Stop sharing | Keep it shared", JSON.stringify(asking));
  await look(B, "links-asking");
  const askFocus = await B.page(`(() => { const a = document.activeElement; return a ? (a.className + " / " + a.textContent) : ""; })()`);
  check("the question opens with the keyboard's focus on Keep it shared, never on Stop sharing", /cg-linkkeep/.test(askFocus) && !/cg-linkstop/.test(askFocus), askFocus);
  await pressEnter(B);                                  // Enter, as a keyboard sends it: it presses what has the focus
  mine = await B.links(2);
  check("Enter there keeps it shared: the board is as it was, and its link still opens", row(mine, shareId).buttons.join(" | ") === "Copy link | Stop sharing…" && (await opens(shareId)) === 200);
  const backFocus = await B.page(`(() => { const a = document.activeElement; return a ? (a.className + " / " + a.textContent) : ""; })()`);
  check("and the focus is back on the button the question came from", /cg-linkask1/.test(backFocus), backFocus);

  // A refusal: the server's answer is replaced by the 403 it gives someone who is neither the
  // board's maker nor the trip's host (a person can be that by the time they tap, if the host
  // changed while the sheet was open).
  let refusing = true;
  B.cdp.on((m) => {
    if (m.sessionId !== B.S || m.method !== "Fetch.requestPaused" || !refusing) return;
    if (m.params.request.method !== "DELETE") { B.cdp.send("Fetch.continueRequest", { requestId: m.params.requestId }, B.S).catch(() => {}); return; }
    B.cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 403,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(JSON.stringify({ error: "forbidden", reason: "only its maker or the trip's host revokes a board" })).toString("base64") }, B.S).catch(() => {});
  });
  await B.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/collage/share/*", requestStage: "Request" }] }, B.S);
  await B.askStop(shareId);
  await B.page(`(document.querySelector('.cg-link[data-id="${shareId}"] .cg-linkstop').click(), 1)`);
  await B.wait(`document.getElementById("toast").hidden === false && /maker/.test(document.getElementById("toast").textContent) ? 1 : 0`, "the refusal said");
  const refused = await B.toast();
  refusing = false;
  await B.cdp.send("Fetch.disable", {}, B.S);
  mine = await B.links(2);
  check("a refusal is said in a sentence", refused.text === "Only its maker or the trip's host can stop a shared board.", JSON.stringify(refused));
  check("…and the board stays listed as shared, its link still opening", row(mine, shareId).live === true && row(mine, shareId).stop === true && (await opens(shareId)) === 200, JSON.stringify(row(mine, shareId)));
  await look(B, "stop-refused", () => B.page(`import("/js/toast.js").then((m) => (m.toast(${JSON.stringify(refused.text)}), 1))`));

  await B.stop(shareId);
  mine = await B.links(2);
  check("its maker stops it: their list says they did, and offers nothing more", /^You stopped sharing it on \S.*\.$/.test(row(mine, shareId).state) && row(mine, shareId).buttons.length === 0, JSON.stringify(row(mine, shareId)));
  check("the link answers 404, and the server kept that its maker stopped it", (await opens(shareId)) === 404 && why(shareId) === "maker", `${await opens(shareId)} ${why(shareId)}`);
  check("the host's board is untouched", row(mine, hostShare).live === true && (await opens(hostShare)) === 200);

  section("2d. the host stops a member's board");
  const third = await B.share();
  await B.links(3);
  await B.closeSheet();
  await A.boardSheet();
  hosts = await A.links(3);
  check("the host reads that the member stopped the first, by name", /^Teo Lind stopped sharing it on \S.*\.$/.test(row(hosts, shareId).state), row(hosts, shareId).state);
  await A.stop(third);
  hosts = await A.links(3);
  check("the host stops the member's new board: the host's list says so", /^You stopped it on \S.*, as the trip's host\.$/.test(row(hosts, third).state) && row(hosts, third).buttons.length === 0, JSON.stringify(row(hosts, third)));
  check("the link answers 404, and the server kept that the host stopped it", (await opens(third)) === 404 && why(third) === "host", `${await opens(third)} ${why(third)}`);
  await A.closeSheet();
  await B.boardSheet();
  mine = await B.links(3);
  check("its maker reads that the trip's host stopped it", /^The trip's host stopped it on \S.*\.$/.test(row(mine, third).state) && row(mine, third).buttons.length === 0, JSON.stringify(row(mine, third)));
  await B.closeSheet();

  // ── 3. the memory is deleted ────────────────────────────────────────────────────────────
  section("3. the host deletes their memory: said before, said after, and the link is gone");
  const openDelete = async (X, caption) => {
    await X.page(`(${X.card(caption)}.querySelector(".me-del").click(), 1)`);
    await X.wait(`document.querySelector(".me-dokill") ? 1 : 0`, "the delete sheet");
    await sleep(900);                                   // the sheet asks the server again for the boards
    return JSON.parse(await X.page(`(() => { const w = document.querySelector(".me-delboards"); return JSON.stringify({ hidden: !w || w.hidden, text: w ? w.textContent : "" }); })()`));
  };
  const confirmDelete = async (X, caption) => {
    await X.page(`(document.querySelector(".me-dokill").click(), 1)`);
    await X.wait(`${X.card(caption)} ? 0 : 1`, "the memory gone from the feed");
    await sleep(400);
  };
  await B.memories();
  await B.wait(`${B.card("Harbor at dawn")} ? 1 : 0`, "the host's memory on the member's phone");
  check("a member is not offered Delete on someone else's memory", (await B.page(`${B.card("Harbor at dawn")}.querySelector(".me-del") ? 1 : 0`)) === 0
    && (await B.page(`${B.card("Market stalls")}.querySelector(".me-del") ? 1 : 0`)) === 1);
  await A.memories();
  await A.wait(`${A.card("Harbor at dawn")} ? 1 : 0`, "the host's own memory");
  check("the trip's host is offered Delete on a member's memory", (await A.page(`${A.card("Market stalls")}.querySelector(".me-del") ? 1 : 0`)) === 1);
  // The other sheet that carries its actions in the head, at phone widths: the title whole,
  // the actions and the close button on screen.
  const headFit = (X) => X.page(`(() => {
    const sh = [...document.querySelectorAll(".sh-sheet")].pop(), vw = document.documentElement.clientWidth;
    const q = (n) => { const r = n.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; };
    const inside = (o) => o.w > 0 && o.l >= 0 && o.r <= vw;
    const t = sh.querySelector(".sh-title"), x = sh.querySelector(".sh-x");
    const btns = [...sh.querySelectorAll(".sh-head .sh-foot button")].map(q);
    return JSON.stringify({ title: t.textContent, titleBox: q(t), whole: inside(q(t)) && t.scrollWidth <= t.clientWidth, x: x ? q(x) : null, xIn: !x || inside(q(x)),
      btns, btnsIn: btns.length > 0 && btns.every(inside), small: btns.filter((o) => o.w < 44).length,
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth }); })()`).then(JSON.parse);
  const fits = (f) => f.whole && f.xIn && f.btnsIn && f.small === 0 && f.page <= 0;
  await A.page(`(${A.card("Harbor at dawn")}.querySelector(".me-cell").click(), 1)`);
  await A.wait(`document.querySelector(".me-vframe") ? 1 : 0`, "the viewer, with Framing for its author");
  await A.page(`(document.querySelector(".me-vframe").click(), 1)`);
  await A.wait(`document.querySelector(".me-frsave") ? 1 : 0`, "the Framing sheet");
  for (const w of [320, 390]) {
    await A.metrics(w, 844, 1);
    await sleep(350);
    const f = await headFit(A);
    check(`${w} wide: Framing shows its whole title, Reset, Save and its close button`, f.title === "Framing" && f.btns.length === 2 && fits(f), JSON.stringify(f));
  }
  await look(A, "framing");
  await A.memories();
  await A.wait(`${A.card("Harbor at dawn")} ? 1 : 0`, "the feed again");

  const warned = await openDelete(A, "Harbor at dawn");
  check("before the delete, the sheet says a shared board shows it and will stop", warned.hidden === false && warned.text === "A shared board shows this. Deleting it stops that board's link.", JSON.stringify(warned));
  for (const w of [320, 390]) {
    await A.metrics(w, 844, 1);
    await sleep(350);
    // What will go is read before a thumb reaches Delete: the count and the board sentence
    // sit above the two buttons, and Delete reads in the app's danger style.
    const f = JSON.parse(await A.page(`(() => {
      const sh = [...document.querySelectorAll(".sh-sheet")].pop(), vw = document.documentElement.clientWidth, vh = innerHeight;
      const q = (n) => { const r = n.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
      const inside = (o) => o.w > 0 && o.l >= 0 && o.r <= vw && o.b <= vh;
      const t = sh.querySelector(".sh-title"), x = sh.querySelector(".sh-x");
      const kill = sh.querySelector(".me-dokill"), keep = sh.querySelector(".me-docancel"), lead = sh.querySelector(".lead"), warn = sh.querySelector(".me-delboards");
      const probe = document.createElement("span"); probe.style.color = "var(--warn)"; sh.append(probe);
      const warnColor = getComputedStyle(probe).color; probe.remove();
      return JSON.stringify({ title: t.textContent, whole: inside(q(t)) && t.scrollWidth <= t.clientWidth, xIn: !x || inside(q(x)),
        kill: q(kill), keep: q(keep), lead: q(lead), warn: q(warn), btnsIn: inside(q(kill)) && inside(q(keep)),
        inHead: !!sh.querySelector(".sh-head .me-dokill"), killText: kill.textContent, keepText: keep.textContent,
        focus: document.activeElement === keep ? "keep" : document.activeElement === kill ? "delete" : document.activeElement.tagName,
        danger: kill.classList.contains("btn-danger"), killColor: getComputedStyle(kill).color, warnColor, keepColor: getComputedStyle(keep).color,
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth }); })()`));
    check(`${w} wide: Delete memory shows its whole title, Delete, Keep and its close button`,
      f.title === "Delete memory" && f.whole && f.xIn && f.btnsIn && f.kill.w >= 44 && f.keep.w >= 44 && f.kill.h >= 44 && f.keep.h >= 44 && f.page <= 0, JSON.stringify(f));
    check(`${w} wide: what will go (the count, the board sentence) sits above Delete and Keep`,
      !f.inHead && f.lead.h > 0 && f.warn.h > 0 && f.lead.b <= f.warn.t && f.warn.b <= f.kill.t && f.warn.b <= f.keep.t, JSON.stringify(f));
    check(`${w} wide: Delete reads in the danger style, Keep does not`,
      f.killText === "Delete" && f.keepText === "Keep" && f.danger && f.killColor === f.warnColor && f.keepColor !== f.warnColor, JSON.stringify(f));
    check(`${w} wide: the keyboard's focus starts on Keep, not on Delete`, f.focus === "keep", f.focus);
    const wrap = JSON.parse(await A.page(`(() => { const p = document.querySelector(".me-delboards"), vw = document.documentElement.clientWidth, r = p.getBoundingClientRect();
      return JSON.stringify({ l: Math.round(r.left), r: Math.round(r.right), spill: p.scrollWidth - p.clientWidth, vw }); })()`));
    check(`${w} wide: the warning wraps inside the sheet`, wrap.l >= 0 && wrap.r <= wrap.vw && wrap.spill <= 0, JSON.stringify(wrap));
  }
  await A.metrics(390, 844, 1);
  await look(A, "delete-warning");
  // Enter, as a keyboard sends it, straight after the sheet opened: it presses Keep.
  await pressEnter(A);
  await A.wait(`document.querySelector(".me-dokill") ? 0 : 1`, "the delete sheet closed by Enter");
  check("Enter on the sheet as it opened keeps the memory: nothing was deleted", !!(await A.page(`${A.card("Harbor at dawn")} ? 1 : 0`)) && (await opens(hostShare)) === 200);
  await sleep(500);
  await openDelete(A, "Harbor at dawn");
  await confirmDelete(A, "Harbor at dawn");
  const said = await A.toast();
  await look(A, "deleted-with-a-board", () => A.page(`import("/js/toast.js").then((m) => (m.toast(${JSON.stringify(said.text)}), 1))`));
  check("the app tells the person who deleted it", said.hidden === false && said.text === "Deleted. A shared board showed it, and that board's link no longer opens.", JSON.stringify(said));
  check("the link answers 404 from then on", (await opens(hostShare)) === 404 && why(hostShare) === "memory", `${await opens(hostShare)} ${why(hostShare)}`);
  check("the board's photographs are gone from the server with it", server.sql(`SELECT COUNT(*) AS n FROM collage_share_items WHERE share_id = '${hostShare.replace(/[^\w-]/g, "")}'`)[0].n === 0);
  await A.boardSheet();
  hosts = await A.links(3);
  check("the list says a memory on it was deleted", /^Its link stopped on \S.*: a memory on it was deleted\.$/.test(row(hosts, hostShare).state) && row(hosts, hostShare).buttons.length === 0, JSON.stringify(row(hosts, hostShare)));
  await look(A, "links-all-stopped");
  await A.closeSheet();

  // A memory on no board: nothing is said, before or after.
  await A.memories();
  await A.compose(PIER, "Pier lights");
  await A.wait(`${A.card("Pier lights")} ? 1 : 0`, "a second memory of the host's");
  await sleep(5600);                                  // the last message has run out
  const calm = await openDelete(A, "Pier lights");
  check("a memory on no board: the delete sheet says nothing about boards", calm.hidden === true && calm.text === "", JSON.stringify(calm));
  await confirmDelete(A, "Pier lights");
  const quiet = await A.toast();
  check("deleting a memory that is on no board says nothing", quiet.hidden === true || quiet.text !== said.text && !/board/.test(quiet.text), JSON.stringify(quiet));

  // The host deletes a member's memory: the trip's storage is the host's.
  await B.memories();
  await B.compose(PIER, "Ferry deck");
  await B.wait(`${B.card("Ferry deck")} ? 1 : 0`, "a new memory of the member's");
  await A.memories();
  await A.wait(`${A.card("Ferry deck")} ? 1 : 0`, "the member's memory on the host's phone");
  await openDelete(A, "Ferry deck");
  await confirmDelete(A, "Ferry deck");
  const left = ((await member.get(`${T}/memories`)).json.memories || []).map((m) => m.caption);
  check("the host deletes a member's memory, and it is gone from the trip", !left.includes("Ferry deck") && left.includes("Market stalls"), JSON.stringify(left));

  // ── 4. the host's storage is full ───────────────────────────────────────────────────────
  section("4. a full trip, in the server's words");
  const meter = (await host.get("/api/account/storage")).json;
  await server.halt();
  await server.start({ vars: { STORAGE_LIMIT_BYTES: String(meter.used + 2000) } });
  const begin = { name: LATE.name, mime: "image/jpeg", bytes: LATE.bytes, kind: "photo" };
  const toMember = (await member.post(`${T}/media/begin`, begin)), toHost = (await host.post(`${T}/media/begin`, begin));
  check("the server refuses both, with a sentence for each that differs",
    toMember.status === 413 && toHost.status === 413 && /Only the host can free space\.$/.test(toMember.json.reason) && /^You have /.test(toHost.json.reason),
    JSON.stringify([toMember.status, toMember.json && toMember.json.reason, toHost.status, toHost.json && toHost.json.reason]));
  const fullCard = async (X, want, whose) => {
    await X.memories();
    await X.compose(LATE, "Late arrival");
    await X.wait(`(document.querySelector(".me-job") || { dataset: {} }).dataset.state === "failed" ? 1 : 0`, `${whose}: the upload's card, refused`);
    const c = JSON.parse(await X.page(`(() => { const j = document.querySelector(".me-job"); const why = j.querySelector(".me-jobwhy");
      return JSON.stringify({ state: j.querySelector(".me-jobstate").textContent, why: why ? why.textContent : null,
        retry: !!j.querySelector(".me-retry"), discard: !!j.querySelector(".me-discard"),
        storage: (() => { const a = j.querySelector("a.me-storage"); if (!a) return null; const r = a.getBoundingClientRect();
          return { href: a.getAttribute("href"), words: a.textContent.trim(), onScreen: r.left >= 0 && r.right <= innerWidth && r.width > 0, tall: Math.round(r.height) }; })(),
        spill: j.scrollWidth - j.clientWidth, wide: why ? why.scrollWidth - why.clientWidth : 0,
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth }); })()`));
    check(`${whose}: the card says "No room", not a number`, c.state === "No room", c.state);
    check(`${whose}: and under it the server's own sentence, as it came`, c.why === want, JSON.stringify(c.why));
    check(`${whose}: Retry and Discard are still there, and nothing spills sideways`, c.retry && c.discard && c.spill <= 0 && c.wide <= 0 && c.page <= 0, JSON.stringify(c));
    if (whose === "the host") check("the host: the card has a way to their storage, Your trips, whole on screen", !!c.storage && c.storage.href === "/trips" && c.storage.words === "Your storage" && c.storage.onScreen, JSON.stringify(c.storage));
    else check(`${whose}: no way to storage that isn't theirs to free`, c.storage === null, JSON.stringify(c.storage));
    await look(X, `no-room-${whose.replace(/\W+/g, "-")}`);
    await X.page(`(document.querySelector(".me-discard").click(), 1)`);
    await X.wait(`document.querySelector(".me-job") ? 0 : 1`, "the card discarded");
  };
  await fullCard(B, toMember.json.reason, "a member");
  await fullCard(A, toHost.json.reason, "the host");

  await B.boardSheet();
  await B.page(`(document.querySelector('.cg-lookfoot .cg-save[data-kind="link"]').click(), 1)`);
  await B.wait(`/Only the host can free space\\.$/.test((document.querySelector(".cg-lookstat") || {}).textContent || "") ? 1 : 0`, "the refusal in the sheet", 60000);
  const sheet = JSON.parse(await B.page(`JSON.stringify({ stat: document.querySelector(".cg-lookstat").textContent, link: !document.querySelector(".cg-lookfoot .me-frout").hidden })`));
  check("sharing a board says the server's sentence in the sheet", /^This trip's host has .* Only the host can free space\.$/.test(sheet.stat), sheet.stat);
  check("…and shows no link", sheet.link === false);
  // The sentence is long. On a phone it has to wrap inside the sheet, and it must not push the
  // sheet's title, its buttons or its close button off the side. Held at two phone widths.
  for (const w of [320, 390]) {
    await B.metrics(w, 844, 1);
    await sleep(350);
    const fit = JSON.parse(await B.page(`(() => {
      const vw = document.documentElement.clientWidth;
      const box = (n) => { const q = n.getBoundingClientRect(); return { l: Math.round(q.left), r: Math.round(q.right), w: Math.round(q.width), h: Math.round(q.height) }; };
      const within = (b) => b.l >= 0 && b.r <= vw && b.w > 0;
      const stat = document.querySelector(".cg-lookstat"), title = document.querySelector(".sh-root .sh-title"), x = document.querySelector(".sh-root .sh-x");
      const btns = [...document.querySelectorAll(".cg-lookfoot .cg-save")].map(box);
      return JSON.stringify({ vw, stat: box(stat), statIn: within(box(stat)), spill: stat.scrollWidth - stat.clientWidth,
        title: box(title), titleSeen: within(box(title)) && title.scrollWidth <= title.clientWidth,
        x: box(x), xIn: within(box(x)), btns, btnsIn: btns.length === 3 && btns.every(within) }); })()`));
    check(`${w} wide: the sentence wraps inside the sheet`, fit.statIn && fit.spill <= 0, JSON.stringify({ stat: fit.stat, spill: fit.spill }));
    check(`${w} wide: the sheet still shows its whole title and its close button`, fit.titleSeen && fit.xIn, JSON.stringify({ title: fit.title, x: fit.x }));
    check(`${w} wide: all three of its buttons are on screen`, fit.btnsIn, JSON.stringify(fit.btns));
  }
  await B.metrics(390, 844, 1);
  await look(B, "share-refused");

  // ── 5. an upload that outlived its day ──────────────────────────────────────────────────
  section("5. an upload whose day ran out between two parts begins again by itself");
  await server.halt();
  await server.start({ vars: { STORAGE_LIMIT_BYTES: String(1024 * 1024 * 1024) } });
  await B.memories();
  // Hold the first part, age the upload's row past its day, let the part go: the server
  // answers 409 "upload expired", as it would for a phone that had been off since yesterday.
  let aged = 0;
  B.cdp.on((m) => {
    if (m.sessionId !== B.S || m.method !== "Fetch.requestPaused") return;
    if (!aged) {
      aged = 1;
      server.sql("UPDATE media_objects SET created_at = created_at - 2 * 86400 WHERE state = 'pending'");
    }
    B.cdp.send("Fetch.continueRequest", { requestId: m.params.requestId }, B.S).catch(() => {});
  });
  await B.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/media/part*", requestStage: "Request" }] }, B.S);
  B.sent.length = 0;
  await B.compose(LATE, "Late arrival");
  await B.wait(`${B.card("Late arrival")} ? 1 : 0`, "the memory, after beginning again", 90000);
  await B.cdp.send("Fetch.disable", {}, B.S);
  const begins = B.sent.filter((u) => /^POST .*\/media\/begin$/.test(u)).length;
  check("the server was asked to begin twice: once, and once more after the expiry", aged === 1 && begins === 2, `${begins} begins, row aged: ${aged}`);
  check("no failed card is left on screen", (await B.page(`document.querySelectorAll('.me-job[data-state="failed"]').length`)) === 0);
  const late = ((await member.get(`${T}/memories`)).json.memories || []).find((m) => m.caption === "Late arrival");
  check("the memory is on the trip with its photograph", !!late && late.media.length === 1 && late.media[0].bytes === LATE.bytes, JSON.stringify(late && late.media));

  check("no page error in either browser", A.pageErrors.length === 0 && B.pageErrors.length === 0, [...A.pageErrors, ...B.pageErrors].join(" | "));
} catch (e) {
  fail++; failures.push("the check ran to its end");
  console.log(`  FAIL  the check ran to its end   -> ${e && e.stack ? e.stack : e}`);
} finally {
  for (const b of browsers) await b.done().catch(() => {});
  await server.stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(fail ? 1 : 0);
