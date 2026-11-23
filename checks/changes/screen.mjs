// The trip's list of changes made through connected apps, and their undo, as the app shows them,
// in a browser (Chrome for Testing):
//
//   node checks/changes/screen.mjs [--port <port>] [--shots <folder>]
//
// On a server of its own, a made-up trip of three made-up people, each with an AI app connected
// the way a person connects one (check:mcp's road). It holds:
//   1. nothing changed yet: Other lists "Changes"; the screen says "Nothing has been changed
//      through a connected app";
//   2. an app's change marks Other on an open phone within seconds (a dot, and "new changes" in
//      its name), and "New" on Other's Changes row; opening the list clears it; the Itinerary,
//      open meanwhile, says nothing about the apps adding (no banner, no toast: AGENTS.md, Never);
//   3. the list: newest first, who asked, which app, the summary, what it touched in words;
//      opened, a line names each thing; a purchase this person can't change says who can,
//      and offers no Undo;
//   4. a second phone, open on the list, sees an app's new change arrive with no reload, undoes
//      it (it says what it will put back first), and the trip is put back, on the server and on
//      the first phone;
//   5. a change with a row someone changed since: undo puts back the rest and says what it left
//      alone and why, in words; the undo is a line at the top, and undoing it brings the change
//      back;
//   6. no signal: the list as the phone last had it, saying so, and Undo says it needs signal;
//      nothing is sent;
//   7. making a trip is a line that says it can't be undone;
//   8. no page has an error.
// --shots: stills at 320 and 390 wide, light and dark (made-up trip only).

import fs from "node:fs";
import path from "node:path";
import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";
import { McpClient, connect } from "../lib/mcp.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8795);
const shots = flag("--shots");
// --look: the stills at a desktop's 1440 instead, and at 320 with the phone's text a step larger
// (Safari's text size at 115%: the page laid out at 320 / 1.15 = 278 CSS px, drawn on the 320 screen).
const LOOK = argv.includes("--look");
const STILL_SIZES = LOOK
  ? [{ label: "1440", width: 1440, height: 900, scale: 1, mobile: false }, { label: "320-text115", width: 278, height: 557, scale: 2.3, mobile: true }]
  : [{ label: "390", width: 390, height: 844, scale: 2, mobile: true }, { label: "320", width: 320, height: 640, scale: 2, mobile: true }];
if (shots) fs.mkdirSync(shots, { recursive: true });
const t = new Report("the trip's list of changes, in the app");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server, chrome, code = 1;
try {
  server = await startServer({ name: "changes-screen", port });
  await server.start();
  const { origin } = server;
  const sql = (q) => server.sql(q);
  const [ada, ben, cleo] = ["Ada Reyes", "Ben Okafor", "Cleo Tran"].map((n) => new Person(origin, n));
  for (const p of [ada, ben, cleo]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const made = await ada.post("/api/trips", { name: "Coast week", default_tz: "UTC", starts_on: day(-1), ends_on: day(5), currencies: ["EUR"] });
  if (made.status !== 201) throw new CheckError(`trip: ${made.status} ${made.text}`);
  const trip = made.json.trip.id;
  const T = `/api/trips/${trip}`;
  for (const p of [ben, cleo]) {
    const link = (await ada.post(`${T}/links`, { uses: 1 })).json.link;
    await p.post(`/api/join/${link.code}`);
  }
  /** An AI app connected for this person, named as a person's would be. */
  const app = async (p, name) => {
    const c = await connect(origin, p, { name, address: p.address });
    if (c.tokens?.status !== 200) throw new CheckError(`couldn't connect ${name} for ${p.name}`);
    const mcp = new McpClient(origin, c.tokens.json.access_token);
    await mcp.initialize();
    return mcp;
  };
  const A = await app(ada, "Claude");
  const B = await app(ben, "Claude");
  const must = async (what, call) => { const r = await call; if (r.isError) throw new CheckError(`${what}: ${r.text.slice(0, 300)}`); return r.json; };
  const at = (d, h) => `${day(d)}T${String(h).padStart(2, "0")}:00`;

  chrome = await openChrome();
  const phone = async (p) => {
    const page = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
    await page.setCookie(origin, "wgp_session", p.jar.cookies.get("wgp_session"));
    await page.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(p.user.id), sameSite: "Lax" });
    return page;
  };
  const pa = await phone(ada);
  const go = async (page, hash, ready, what) => { await page.open(`${origin}/t/${trip}/${hash}`); await page.until(ready, what, 20000); await sleep(500); };
  const shoot = async (page, name, prep = null) => {
    if (!shots) return;
    for (const size of STILL_SIZES) for (const scheme of ["light", "dark"]) {
      const w = size.label;
      await page.size({ width: size.width, height: size.height, mobile: size.mobile });
      await page.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: size.mobile });
      await page.scheme(scheme);
      await sleep(350);
      if (prep) await page.eval(prep);
      await sleep(150);
      fs.writeFileSync(path.join(shots, `${name}-${w}-${scheme}.png`), Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    }
    await page.size({ width: 390, height: 844, mobile: true });
    await page.scheme("light");
  };
  const lines = (page) => page.eval(`JSON.stringify([...document.querySelectorAll(".chg-line")].map((l) => ({
    id: l.dataset.id, app: l.querySelector(".chg-app")?.textContent.trim(),
    head: [...l.querySelectorAll(".chg-head > span:not(.chg-new)")].map((x) => x.textContent.trim()).join(" "),
    sum: l.querySelector(".chg-sum")?.textContent.trim(), touch: l.querySelector(".chg-touch")?.textContent.trim(),
    isNew: !!l.querySelector(".chg-new"), undo: l.querySelector('[data-act="undo"]')?.textContent.trim() ?? null,
    undoOff: !!l.querySelector('[data-act="undo"]')?.disabled, state: l.querySelector(".chg-state")?.textContent.replace(/\\s+/g, " ").trim() ?? null,
    rows: [...l.querySelectorAll(".chg-row .chg-what")].map((r) => r.textContent.replace(/\\s+/g, " ").trim()),
    result: l.querySelector(".chg-result") ? [...l.querySelectorAll(".chg-result h3, .chg-result p, .chg-result li")].map((x) => x.textContent.replace(/\\s+/g, " ").trim()).join(" ") : null,
  })))`).then(JSON.parse);
  const lineOf = (list, sum) => list.find((l) => l.sum === sum) ?? null;
  const press = async (page, sum, act) => {
    const ok = await page.eval(`(() => { const l = [...document.querySelectorAll(".chg-line")].find((x) => x.querySelector(".chg-sum")?.textContent.trim() === ${JSON.stringify(sum)});
      const b = l?.querySelector('[data-act="${act}"]'); if (!b || b.disabled) return false; b.scrollIntoView({ block: "center" }); b.click(); return true; })()`);
    if (!ok) throw new CheckError(`no ${act} on "${sum}"`);
    await sleep(300);
  };

  t.part("1. Nothing changed yet");
  await go(pa, "#/settings", `!!document.querySelector('a.st-row[href="#/changes"]')`, "Other, with Changes");
  t.same("More lists Changes, with nothing new at its right", await pa.eval(`[...document.querySelectorAll('a.st-row[href="#/changes"] .ds-item-title, a.st-row[href="#/changes"] [data-note="changes"]')].map((x) => x.textContent.trim()).join(" / ")`),
    "Changes / ");
  await pa.click('a.st-row[href="#/changes"]');
  await pa.until(`!!document.querySelector(".chg-empty h2")`, "the empty list", 20000);
  t.same("the screen, with nothing changed, says so, and has Back", [await pa.eval(`document.querySelector(".chg-empty h2").textContent`), await pa.eval(`location.hash`)],
    ["Nothing has been changed through a connected app", "#/changes"]);
  await shoot(pa, "1-empty");

  t.part("2. The mark on Other");
  await go(pa, "#/", `!!document.querySelector(".tabbar")`, "the Agenda");
  // No "<app> is adding to this trip" at the Itinerary's top, and no toast about it (AGENTS.md, Never: no notices to
  // people about technical matters). Whatever the page says from here while the apps write is recorded, toasts included.
  await pa.eval(`(window.__chgSaid = [], new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) {
    const s = (n.textContent || "").trim(); if (/Everything it adds|adding to this trip|changes? to this trip/.test(s)) window.__chgSaid.push(s.slice(0, 90)); } })
    .observe(document.body, { childList: true, subtree: true, characterData: true }), 1)`);
  await must("places", A.call("put_places", { trip_id: trip, summary: "Three places in the old town", places: [
    { id: "cafe-lume", name: "Cafe Lume", kind: "food", subkind: "cafe", why: "Coffee before the boat" },
    { id: "miradouro", name: "The high viewpoint", kind: "sight", subkind: "viewpoint", why: "The light at six" },
    { id: "tasca", name: "Tasca do Cais", kind: "food", subkind: "restaurant", why: "Fish at lunch" },
  ] }));
  const marked = await pa.until(`document.documentElement.hasAttribute("data-changes-new")`, "the mark on More", 20000).then(() => true, () => false);
  t.same("an app's change marks More (your picture) on an open phone, with no reload: a dot, and \"new changes\" in its name",
    [marked, await pa.eval(`document.querySelector('.head-more').getAttribute("aria-label")`),
      await pa.eval(`document.querySelector('.head-more').hasAttribute("data-new")`)],
    [true, "More, new changes", true]);
  await must("events", A.call("put_events", { trip_id: trip, summary: "Dinner by the harbour, and the boat", events: [
    { id: "boat", kind: "transit", title: "Boat to the island", starts: at(1, 11), tz: "UTC" },
    { id: "dinner", kind: "meal", title: "Dinner by the harbour", starts: at(1, 19), tz: "UTC", place_id: "tasca" },
  ] }));
  await must("taxi", B.call("put_purchase", { trip_id: trip, summary: "The taxi from the airport", purchase: {
    id: "taxi", description: "Taxi from the airport", amount: "42.00", currency: "EUR", spent_on: day(0),
    split: { mode: "even", people: [ada.user.id, ben.user.id, cleo.user.id] } } }));
  await sleep(2500);
  t.same("the Itinerary, open while two apps wrote, says nothing about it: no banner at its top, no toast (the list is under More, Changes)",
    JSON.parse(await pa.eval(`JSON.stringify({ route: location.hash, banner: !!document.querySelector(".pa-banner, .ag-aislot"),
      words: /adding to this trip|changes? to this trip/.test(document.querySelector("#view")?.textContent || ""), said: window.__chgSaid || null })`)),
    { route: "#/", banner: false, words: false, said: [] });
  await go(pa, "#/settings", `!!document.querySelector('a.st-row[href="#/changes"]')`, "Other");
  t.same("More's Changes row says New", await pa.eval(`document.querySelector('a.st-row[href="#/changes"] [data-note="changes"]').textContent`), "New");
  await pa.click('a.st-row[href="#/changes"]');
  await pa.until(`document.querySelectorAll(".chg-line").length >= 3`, "the list", 20000);
  await sleep(600);
  t.same("opening the list clears the mark", [await pa.eval(`document.documentElement.hasAttribute("data-changes-new")`), await pa.eval(`document.querySelector('.head-more').getAttribute("aria-label")`)], [false, "More"]);

  t.part("3. The list");
  let L = await lines(pa);
  t.same("newest first, each with its app, who asked, its summary and what it touched in words, marked New",
    L.map((l) => [l.app, l.head, l.sum, l.touch, l.isNew]),
    [["Claude", "Claude for Ben Okafor", "The taxi from the airport", "1 purchase added", true],
     ["Claude", "Claude for you", "Dinner by the harbour, and the boat", "2 plans added", true],
     ["Claude", "Claude for you", "Three places in the old town", "3 places added", true]]);
  const taxi = lineOf(L, "The taxi from the airport");
  t.same("a purchase this person can't change says who can, and offers no Undo", [taxi.undo, taxi.state], [null, "Only Ben Okafor can undo this: it would take away the purchase “Taxi from the airport”."]);
  await press(pa, "Three places in the old town", "open");
  L = await lines(pa);
  t.same("opened, a line names each thing it touched", lineOf(L, "Three places in the old town").rows,
    ["Place “Cafe Lume”", "Place “The high viewpoint”", "Place “Tasca do Cais”"]);
  await pa.eval(`document.getElementById("view").scrollTop = 0, 1`);
  await shoot(pa, "2-list");
  // The head of each line wraps at 320 with the phone's text a step larger (Safari's 115%: laid
  // out at 278 CSS px): no separator that can be seen starts or ends a line, and the head does
  // wrap there (the rule is met, not missed). On a desktop the list keeps a reading width.
  const headSeps = `JSON.stringify([...document.querySelectorAll(".chg-head")].map((h) => {
    const edge = h.getBoundingClientRect().left + 14;
    const when = h.querySelector(".chg-when"), dot = h.querySelector(".chg-dot");
    const prev = when.previousElementSibling;
    const starts = when.getBoundingClientRect().top > prev.getBoundingClientRect().top + 2;
    return { starts, seen: dot.getBoundingClientRect().right > edge + 0.5 };
  }))`;
  await pa.send("Emulation.setDeviceMetricsOverride", { width: 278, height: 557, deviceScaleFactor: 2.3, mobile: true });
  await sleep(400);
  const narrow = JSON.parse(await pa.eval(headSeps));
  t.ok("at 320 with larger text no line of a head starts with a separator that can be seen, and a head does wrap there",
    narrow.length > 0 && narrow.every((x) => !(x.starts && x.seen)) && narrow.some((x) => x.starts), JSON.stringify(narrow));
  await pa.size({ width: 1440, height: 900, mobile: false });
  await sleep(400);
  const wide = JSON.parse(await pa.eval(`JSON.stringify([document.querySelector(".chg").getBoundingClientRect().width, JSON.parse(${headSeps}).every((x) => !x.starts && x.seen)])`));
  t.same("on a desktop the list keeps the chat's reading width, each head on one line with its dot", [wide[0] <= 720, wide[1]], [true, true]);
  await pa.size({ width: 390, height: 844, mobile: true });
  await sleep(300);

  t.part("4. A second phone: an app's change arrives, and is undone there");
  const pb = await phone(ben);
  await go(pb, "#/changes", `document.querySelectorAll(".chg-line").length >= 3`, "Ben's list");
  await must("lunch", A.call("put_events", { trip_id: trip, summary: "Lunch at the tasca, and a walk", events: [
    { id: "lunch", kind: "meal", title: "Lunch at the tasca", starts: at(2, 13), tz: "UTC", place_id: "tasca" },
    { id: "walk", kind: "activity", title: "A walk on the cliffs", starts: at(2, 16), tz: "UTC" },
  ] }));
  const arrived = await pb.until(`[...document.querySelectorAll(".chg-sum")].some((s) => s.textContent.trim() === "Lunch at the tasca, and a walk")`, "the new change on Ben's phone", 20000).then(() => true, () => false);
  t.ok("an app's new change arrives on an open list on another phone, with no reload, at the top", arrived && (await lines(pb))[0]?.sum === "Lunch at the tasca, and a walk");
  await press(pb, "Lunch at the tasca, and a walk", "undo");
  const asked = await pb.eval(`document.querySelector(".chg-confirm")?.textContent.replace(/\\s+/g, " ").trim() ?? null`);
  t.ok("undoing more than one thing says what it will do first, and nothing is put back yet",
    /Undo will: Take away 2 plans: “Lunch at the tasca”, “A walk on the cliffs”/.test(asked ?? "") && sql(`SELECT COUNT(*) AS n FROM events WHERE trip_id = '${trip}' AND id IN ('lunch', 'walk')`)[0].n === 2, asked);
  await pb.eval(`document.querySelector('[data-act="do-undo"]').click(), 1`);
  await pb.until(`!!document.querySelector(".chg-result")`, "the undo's result", 20000);
  const res4 = lineOf(await lines(pb), "Lunch at the tasca, and a walk");
  t.same("it says what it did in the trip's own words (an added thing: \"Took away 2 plans\"), and the trip is as before on the server", [res4.result?.startsWith("Took away 2 plans"), sql(`SELECT COUNT(*) AS n FROM events WHERE trip_id = '${trip}' AND id IN ('lunch', 'walk')`)[0].n], [true, 0]);
  await pb.until(`document.querySelector(".chg-line .chg-sum")?.textContent.trim() === "Undid: Lunch at the tasca, and a walk"`, "the undo's own line at the top", 20000);
  t.same("the undo is a line of its own at the top, by Ben in the app, and the change says who undid it",
    [(await lines(pb))[0].head, lineOf(await lines(pb), "Lunch at the tasca, and a walk").state?.replace(/, (just now|\d+ min ago)/, "")],
    ["You in the app", "Undone by you. Undo that line to bring this change back."]);
  await go(pa, "#/", `!!document.querySelector('.ag-slot[data-k="c:boat"]')`, "Ada's Agenda");
  t.ok("and the first phone's Agenda has the boat but not the lunch", await pa.eval(`!document.querySelector('.ag-slot[data-k="c:lunch"]') && !document.querySelector('.ag-slot[data-k="c:walk"]')`));

  t.part("5. Something changed since: left alone, and said");
  // Cleo renames the cafe by hand, in the app's own route.
  const renamed = await cleo.call("PUT", `${T}/places`, { places: [{ id: "cafe-lume", name: "Cafe Lume (closed Mondays)" }] });
  if (renamed.status !== 200) throw new CheckError(`rename: ${renamed.status} ${renamed.text}`);
  await go(pa, "#/changes", `document.querySelectorAll(".chg-line").length >= 5`, "Ada's list");
  await press(pa, "Three places in the old town", "undo");
  await pa.eval(`document.querySelector('[data-act="do-undo"]').click(), 1`);
  await pa.until(`!!document.querySelector(".chg-result")`, "the undo's result", 20000);
  await sleep(800);
  const res5 = lineOf(await lines(pa), "Three places in the old town");
  // The cafe was renamed by hand since; the tasca has the dinner on it now; the viewpoint goes.
  t.same("it puts back what it can, and says what it left alone and why, in words",
    res5.result, "Took away 1 place Left alone: “Cafe Lume” was changed since, so it was left as it is. “Tasca do Cais” stays: something on the trip uses it now (a plan at that place, say). The undo is a line of its own at the top, and can be undone.");
  t.same("on the server: the viewpoint is gone, the renamed cafe and the dinner's tasca stay",
    sql(`SELECT id, name FROM places WHERE trip_id = '${trip}' ORDER BY id`), [{ id: "cafe-lume", name: "Cafe Lume (closed Mondays)" }, { id: "tasca", name: "Tasca do Cais" }]);
  await pa.eval(`document.querySelector(".chg-line[data-id] .chg-result")?.closest(".chg-line").scrollIntoView({ block: "start" }), 1`);
  await shoot(pa, "3-result", `document.querySelector(".chg-result")?.closest(".chg-line").scrollIntoView({ block: "start" }), 1`);
  // The tasca is a place the dinner is on: taking the places away left it (an event points at it).
  // The undo of the undo brings the viewpoint back.
  await press(pa, "Undid: Three places in the old town", "undo");
  await pa.until(`!![...document.querySelectorAll(".chg-line")].find((l) => l.querySelector(".chg-sum")?.textContent.trim() === "Undid: Three places in the old town")?.querySelector(".chg-result")`, "the redo's result", 20000);
  await pa.until(`[...document.querySelectorAll(".chg-sum")].some((x) => x.textContent.trim().startsWith("Brought back: "))`, "the line that brought it back", 20000).catch(() => {});
  t.ok("undoing the undo says what it did for a removed thing (\"Brought back 1 place\")",
    /^Brought back 1 place\b/.test(lineOf(await lines(pa), "Undid: Three places in the old town")?.result ?? ""), lineOf(await lines(pa), "Undid: Three places in the old town")?.result);
  t.same("undoing the undo brings the change back, and its line says so (\"Brought back\", never \"Undid: Undid:\")",
    [sql(`SELECT id FROM places WHERE trip_id = '${trip}' ORDER BY id`).map((r) => r.id), (await lines(pa)).filter((l) => /^Brought back: Three places in the old town$/.test(l.sum)).length, (await lines(pa)).some((l) => /Undid: Undid:/.test(l.sum))],
    [["cafe-lume", "miradouro", "tasca"], 1, false]);

  t.part("5b. A changed thing");
  await must("detail", A.call("put_events", { trip_id: trip, summary: "The boat leaves from pier 3", events: [
    { id: "boat", kind: "transit", title: "Boat to the island", starts: at(1, 11), tz: "UTC", detail: "From pier 3; tickets on board." },
  ] }));
  await go(pa, "#/changes", `[...document.querySelectorAll(".chg-sum")].some((x) => x.textContent.trim() === "The boat leaves from pier 3")`, "the boat's change");
  await press(pa, "The boat leaves from pier 3", "undo");
  await pa.until(`!![...document.querySelectorAll(".chg-line")].find((l) => l.querySelector(".chg-sum")?.textContent.trim() === "The boat leaves from pier 3")?.querySelector(".chg-result")`, "its result", 20000);
  t.same("a changed thing undone says so in the trip's words (\"Changed “Boat to the island” back\"), and the plan is as it was",
    [lineOf(await lines(pa), "The boat leaves from pier 3")?.result?.split(" The undo")[0], sql(`SELECT detail FROM events WHERE trip_id = '${trip}' AND id = 'boat'`)[0]?.detail ?? ""],
    ["Changed “Boat to the island” back", ""]);
  await shoot(pa, "3b-changed", `[...document.querySelectorAll(".chg-line")].find((l) => l.querySelector(".chg-result"))?.scrollIntoView({ block: "start" }), 1`);

  t.part("6. No signal");
  await pa.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(500);
  await go(pa, "#/settings", `!!document.querySelector('a.st-row[href="#/changes"]')`, "Other").catch(() => {});
  await pa.eval(`location.hash = "#/changes", 1`);
  await pa.until(`document.querySelectorAll(".chg-line").length >= 5 && !document.getElementById("chg-net").hidden`, "the kept list, offline", 20000);
  const before6 = sql(`SELECT COUNT(*) AS n FROM trip_changes WHERE trip_id = '${trip}'`)[0].n;
  const off = await lines(pa);
  t.same("the list as the phone last had it, saying so, and Undo says it needs signal",
    [await pa.eval(`/^No signal\\. This is the list as this phone last had it, and putting something back waits until you're connected\\.$/.test(document.getElementById("chg-net").textContent.trim())`), off.find((l) => l.undo)?.undo, off.find((l) => l.undo)?.undoOff],
    [true, "Undo needs signal", true]);
  const clear = await pa.eval(`(() => { const v = document.getElementById("view"); v.scrollTop = v.scrollHeight; const last = [...document.querySelectorAll(".chg-line")].at(-1).getBoundingClientRect();
    const over = ["netpill", "backbtn"].map((id) => document.getElementById(id)).filter((e) => e && !e.hidden && e.getBoundingClientRect().width > 0).map((e) => e.getBoundingClientRect());
    return over.length === 2 && over.every((o) => o.top >= last.bottom - 1 || o.bottom <= last.top + 1); })()`);
  t.ok("scrolled to its foot, the last card clears the Offline pill and Back", clear);
  await pa.eval(`document.getElementById("view").scrollTop = 0, 1`);
  await shoot(pa, "4-no-signal");
  t.same("nothing is sent", sql(`SELECT COUNT(*) AS n FROM trip_changes WHERE trip_id = '${trip}'`)[0].n, before6);
  await pa.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const back = await pa.until(`document.getElementById("chg-net").hidden && [...document.querySelectorAll('[data-act="undo"]')].some((b) => !b.disabled)`, "signal back", 20000).then(() => true, () => false);
  t.ok("with signal back, the list reads itself again and Undo is there", back);

  t.part("7. Making a trip");
  const second = await must("create", A.call("create_trip", { name: "Weekend inland", summary: "Made the weekend inland", starts_on: day(10), ends_on: day(12), default_tz: "UTC", currencies: ["EUR"] }));
  const trip2 = second.trip?.id ?? second.id;
  await pa.open(`${origin}/t/${trip2}/#/changes`);
  await pa.until(`document.querySelectorAll(".chg-line").length >= 1`, "the new trip's list", 20000);
  const made7 = (await lines(pa))[0];
  t.same("making a trip is a line that says it can't be undone, with no Undo", [made7.sum, made7.undo, made7.state],
    ["Made the weekend inland", null, "Making a trip can't be undone. Only its host can delete it, under People and settings."]);

  t.ok("no page has an error", pa.errors.length === 0 && pb.errors.length === 0, JSON.stringify([...pa.errors, ...pb.errors].slice(0, 3)));
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
