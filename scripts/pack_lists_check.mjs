#!/usr/bin/env node
/* Packing on the trip's lists (public/js/packing.js, the store's packing writes, and
 * public/js/packing-refusals.js), with two people in two browsers.
 *
 * Chrome needs the Bash sandbox disabled, and the launcher (scripts/lib/browser.mjs) starts it
 * only through the queue:
 *   WGP_BASE=http://localhost:<port> python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> --label <what> -- node scripts/pack_lists_check.mjs
 *
 * The model it holds the app to: lists are the TRIP's (a list one person adds is everyone's);
 * a person's things are their own and the group's are everyone's; a thing is on a list or not
 * (stored as a bag of the list's, which the screen never shows: a new thing goes in the list's
 * first, a list made on the screen gets one of its own); a tick belongs to a thing on a list,
 * and on a list for the day to that day.
 *
 * WHAT IT PROVES
 *   0. No browser: the sentence for each refusal the server can give a packing write (a thing
 *      put on a list whose place for it is gone is said as the list, never a bag).
 *   1. The tab reads the trip's lists from the snapshot: no request to an address that is
 *      gone, no second database on the phone, the names on screen are the trip's.
 *   2. The starter list: a look first, then one request per thing, each landing in its bag
 *      on every list packed once and on no list for the day.
 *   3. Two people. A thing added on a list is on it, in its first place. A list A adds shows
 *      for B, with one place of its own and no bag named anywhere. A's thing is not in B's
 *      list. Each person's tick is their own. A tick on one list does not tick the other. The
 *      group's thing is ticked and put on another list by B, and A sees both.
 *   4. No signal. A tick and a new list made offline wait on the phone and are sent when the
 *      signal is back; a list B added in between is still there (A's write named only its own).
 *   5. Refusals, each as a sentence on screen and the screen put back: a list someone else
 *      still has a thing on; a thing put on a list that was removed on another phone.
 *   6. A list for the day. Outside its days it reads without ticking. On a day of the trip
 *      (the page's clock moved there, the phone's own time zone set far from the trip's) the
 *      tick is kept for the TRIP's day; the next day starts unticked; the first day's tick is
 *      still there when the clock goes back.
 *   7. The trip's own suggested items replace the plain starter list when the trip has any.
 *
 * Two people: A is the checkout's first account, B is another member of the trip, read from
 * the roster when the check runs. Everything it makes starts with "pack-check" (or is counted
 * before and after), and it removes all of it, at the start too in case a run was cut short.
 */
import path from "node:path";
import { BASE, REPO, appSettled, boot, evalIn, signInAs, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { TRIP, HOST as TRIP_HOST } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const TAG = "pack-check";
const A_ID = TRIP_HOST.id;               // the trip's host; B is another member, read from the roster

// ── 0. the sentences ──────────────────────────────────────────────────────────────────────
section("0. what a refused packing write says (no browser)");
{
  const { refusalWords, refusalLine } = await import(path.join(REPO, "public/js/packing-refusals.js"));
  // The general line, for a refused write that is not packing's.
  check("a refused plan is named by its title, with the server's reason",
    refusalLine({ op: { kind: "event", op: "create", id: "e1", payload: { title: "Ferry  out" } }, status: 400, body: { error: "not a day of the trip", reason: "The trip has no dates yet, so nothing can be put on a day of it. Set the trip's dates first." } })
      === "“Ferry out” couldn't be saved. The trip has no dates yet, so nothing can be put on a day of it. Set the trip's dates first.");
  check("…with no reason from the server, the status", refusalLine({ op: { kind: "purchase", op: "create", id: "p1", payload: { title: "Lunch" } }, status: 409, body: { error: "x" } }) === "“Lunch” couldn't be saved (409).");
  check("…a write that carries no words is a change", refusalLine({ op: { kind: "event", op: "delete", id: "e1" }, status: 404, body: null }) === "A change couldn't be saved (404)."
    && refusalLine({ op: { kind: "event", op: "update", id: "e1", payload: { starts_at: 5 } }, status: 0, body: null }) === "A change couldn't be saved (no connection).");
  check("…a long name is cut", refusalLine({ op: { payload: { title: "A".repeat(60) } }, status: 400 }) === `“${"A".repeat(39)}…” couldn't be saved (400).`);
  check("…a change that wasn't theirs to make says so, whatever it was", refusalLine({ op: { payload: { title: "Lunch" } }, status: 403, body: { reason: "nope" } }) === "That change wasn't yours to make, so it was undone.");
  const say = (kind, op, payload, status, body) => refusalWords({ op: { kind, op, id: "x", payload }, status, body });
  const bagHeld = { error: "bad lists", rows: [{ index: 0, key: "travel", error: "A bag that holds items can't be removed: \"carry-on\" holds 2 (counting everyone's). Keep it, or move the items to another bag first.", held: [{ key: "carry-on", items: 2 }] }] };
  check("a bag that holds things: its name on screen, the number, whose",
    say("pack-bag", "delete", { name: "Carry-on" }, 400, bagHeld) === "“Carry-on” still holds 2 things, counting everyone's, so it stays. They have to move to another bag first.",
    say("pack-bag", "delete", { name: "Carry-on" }, 400, bagHeld));
  check("…one thing is one thing",
    /holds 1 thing,/.test(say("pack-bag", "delete", { name: "Carry-on" }, 400, { error: "bad lists", rows: [{ error: "x", held: [{ key: "carry-on", items: 1 }] }] })));
  check("a bag suggested items start in",
    say("pack-bag", "delete", { name: "Carry-on" }, 400, { error: "bad lists", rows: [{ error: "Suggested items start in \"carry-on\" (3), so it can't be removed.", suggested: [{ key: "carry-on", starters: 3 }] }] }) === "Suggested items start in “Carry-on”, so it stays.");
  check("a bag added to a list that was removed elsewhere",
    say("pack-bag", "create", { name: "Beach bag" }, 400, { error: "bad lists", rows: [{ error: "A list needs a name of 1 to 40 characters: it is a tab and a sentence (\"3 of 9 packed for Leaving home\")." }] }) === "That list was removed on another phone, so “Beach bag” went with it.");
  check("the last list", say("pack-list", "delete", { name: "Leaving home" }, 409, { error: "last list", reason: "A trip always has at least one packing list. Rename this one, or add another first." }) === "A trip keeps at least one packing list, so this one stays.");
  check("a list things are still on",
    say("pack-list", "delete", { name: "Day out" }, 409, { error: "list in use", reason: "3 item(s) have a bag on this list.", items: 3 }) === "“Day out” stays: 3 things still are on it, counting everyone's.");
  check("…and one thing is, not are",
    say("pack-list", "delete", { name: "Day out" }, 409, { error: "list in use", items: 1 }) === "“Day out” stays: 1 thing still is on it, counting everyone's.");
  check("a list suggested items start on",
    say("pack-list", "delete", { name: "Day out" }, 409, { error: "list in use", starters: ["starter-1"] }) === "Suggested items start on “Day out”, so it stays.");
  check("a tick for a thing deleted elsewhere", say("pack-tick", "update", { label: "Socks" }, 404, { error: "no such item" }) === "“Socks” was deleted on another phone.");
  check("a tick on a day the list isn't packed",
    say("pack-tick", "update", { label: "Socks", list_name: "Day out" }, 400, { error: "not a day of that list" }) === "“Day out” isn't packed on that day, so the tick wasn't kept.");
  check("a thing put on a list whose place for it was removed elsewhere: said as the list, never a bag",
    say("pack-place", "update", { label: "Socks" }, 400, { error: "no such bag" }) === "That list changed on another phone, so “Socks” wasn't put on it.");
  check("too many things: the server's own sentence, which has the number",
    say("packing", "create", { label: "x" }, 409, { error: "too many items", reason: "A packing list holds at most 300 items (the group's counts on its own)." }) === "A packing list holds at most 300 items (the group's counts on its own).");
  check("anything that isn't packing is left to the shell", say("purchase", "update", {}, 400, { error: "bad amount" }) === null && say("pack-tick", "update", {}, 403, { error: "forbidden" }) === null);
}

// ── the two people ────────────────────────────────────────────────────────────────────────
// One browser each. `clock` moves the page's own Date (every new Date() and Date.now()) by a
// fixed number of milliseconds, for the list for the day; `zone` is the phone's time zone.
async function person(uid, { zone } = {}) {
  const b = await boot({ vw: 390, vh: 844, dsf: 1 });
  const { cdp, S } = b;
  if (zone) await cdp.send("Emulation.setTimezoneOverride", { timezoneId: zone }, S);
  await signInAs(cdp, S, uid);
  const requests = [];
  cdp.on((m) => {
    if (m.sessionId !== S || m.method !== "Network.requestWillBeSent") return;
    const u = new URL(m.params.request.url);
    if (u.pathname.startsWith("/api/")) requests.push({ method: m.params.request.method, path: u.pathname, body: m.params.request.postData || "" });
  });
  const page = (expr) => evalIn(cdp, S, expr);
  const inStore = (body) => page(`(async () => { const { store } = await import("/js/store.js"); await store.ready(); ${body} })()`);
  let clockId = null;
  const me = {
    uid, b, cdp, S, page, inStore, requests,
    async open(hash = "#/pack") {
      await cdp.send("Page.navigate", { url: "about:blank" }, S);
      await sleep(120);
      await cdp.send("Page.navigate", { url: `${BASE}/t/${TRIP}/${hash}` }, S);
      await appSettled(cdp, S);
      await waitFor(cdp, S, `document.querySelector(".pk-hero") ? 1 : 0`, { label: `${uid}: the Pack tab with the trip's lists` });
    },
    async clock(ms) {
      if (clockId) await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: clockId }, S);
      clockId = null;
      if (ms == null) return;
      const r = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
        const Real = Date, off = ${Math.round(ms)} - Real.now();
        class Moved extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + off); } static now() { return Real.now() + off; } }
        window.Date = Moved;
      })()` }, S);
      clockId = r.identifier;
    },
    api: (method, p, body) => page(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, credentials: "same-origin",
      headers: { "Content-Type": "application/json" }${body === undefined ? "" : `, body: ${JSON.stringify(JSON.stringify(body))}`} })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`),
    snapshot: async () => (await me.api("GET", `/api/trips/${TRIP}`)).body,
    // The store has nothing waiting and has read the server since.
    async synced() {
      await waitFor(cdp, S, `(async () => { const { store } = await import("/js/store.js"); return store.pending() === 0 ? 1 : 0; })()`, { label: `${uid}: nothing waiting to be sent` });
      await inStore(`await store.refresh(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));`);
      await sleep(120);
    },
    tap: (sel) => page(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return "no ${sel.replace(/"/g, "'")}"; n.click(); return "ok"; })()`),
    has: (sel) => page(`!!document.querySelector(${JSON.stringify(sel)})`),
    text: (sel) => page(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); return n ? n.innerText.replace(/\\s+/g, " ").trim() : null; })()`),
    type: (sel, value) => page(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return "no field"; n.value = ${JSON.stringify(value)};
      n.dispatchEvent(new Event("input", { bubbles: true })); n.dispatchEvent(new Event("change", { bubbles: true })); return "ok"; })()`),
    list: async (key) => { const r = await me.tap(`.pk-view[data-view="${key}"]`); await sleep(250); return r; },
    owner: async (tab) => { const r = await me.tap(`[data-act="owner"][data-tab="${tab}"]`); await sleep(200); return r; },
    // The sheet gone AND the screen under it drawn again: Pack holds its repaint while a sheet is
    // open and asks for it in the frame after (packing.js scheduleRender), so a read in the same
    // frame the sheet left sees the list from before (it did, every time, once v78's shell moved
    // the timing by a frame). Two frames: the one that repaints, and one after it.
    closeSheet: async () => {
      await me.tap(".sh-scrim");
      await waitFor(cdp, S, `document.querySelector(".sh-root") ? 0 : 1`, { label: `${uid}: the sheet gone` });
      await page(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))`);
    },
    idOf: (owner, label) => inStore(`const r = store.packing(${owner === "group" ? '"group"' : "store.me().id"}).find((x) => x.label === ${JSON.stringify(label)}); return r ? r.id : null;`),
    // Add a thing through the editor: the + button, its name, the bag on the list on screen.
    async add(label, { bag } = {}) {
      await me.tap("#rt-fixed .pk-fab");
      await waitFor(cdp, S, `document.querySelector('.sh-sheet [name="label"]') ? 1 : 0`, { label: `${uid}: the editor` });
      await me.type('.sh-sheet [name="label"]', label);
      if (bag) await me.tap(`.sh-sheet [data-act="pick"][data-view="${bag[0]}"][data-sec="${bag[1]}"]`);
      await me.tap('.sh-sheet [data-act="save"]');
      await waitFor(cdp, S, `[...document.querySelectorAll(".pk-item .pk-label")].some((n) => n.textContent === ${JSON.stringify(label)}) ? 1 : 0`, { label: `${uid}: ${label} in the list` });
    },
    row: (id) => page(`(() => { const li = document.querySelector('.pk-item[data-id="${id}"]'); if (!li) return null;
      return { done: li.dataset.done === "1", button: !!li.querySelector('button[data-act="tick"]'), box: !!li.querySelector(".pk-box"),
        on: !!li.closest(".pk-on"), text: li.innerText.replace(/\\s+/g, " ").trim() }; })()`),
    tick: async (id) => { const r = await me.tap(`.pk-item[data-id="${id}"] [data-act="tick"]`); await sleep(350); return r; },
    // On or off a list, through the sheet every list is on: tap the row's lists button, then On it or Not on it.
    async move(id, listKey, on) {
      await me.tap(`.pk-item[data-id="${id}"] [data-act="move"]`);
      await waitFor(cdp, S, `document.querySelector('.sh-sheet [data-act="put"]') ? 1 : 0`, { label: `${uid}: the lists sheet` });
      const r = await me.page(`(() => { const b = [...document.querySelectorAll('.sh-sheet [data-act="put"][data-view="${listKey}"]')].find((x) => ${on ? "!!x.dataset.sec" : "!x.dataset.sec"});
        if (!b) return "no ${on ? "On it" : "Not on it"}"; b.click(); return "ok"; })()`);
      await sleep(300);
      await me.closeSheet();
      return r;
    },
    async listsSheet() {
      await me.tap('[data-act="managebags"]');
      await waitFor(cdp, S, `document.querySelector("#pk-manage") ? 1 : 0`, { label: `${uid}: the Lists sheet` });
    },
    views: () => page(`[...document.querySelectorAll(".pk-view-name")].map((n) => n.textContent)`),
    toast: () => page(`(() => { const n = document.getElementById("toast"); return n && !n.hidden ? n.textContent : ""; })()`),
    async offline(off) {
      await cdp.send("Network.emulateNetworkConditions", { offline: off, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
      await sleep(200);
    },
  };
  return me;
}

const bare = (lists) => JSON.stringify((lists || []).map((l) => ({ key: l.key, name: l.name, sort: l.sort, repeat: l.repeat, dates: l.dates,
  bags: l.bags.map((x) => ({ key: x.key, name: x.name, sort: x.sort })) })));
const tagged = (v) => String(v || "").startsWith(TAG);

// Everything this check ever makes, removed. Each person's own things by that person (nobody
// else can), then the group's, then the bags and lists, then the starters as they were.
async function sweep(people, startersBefore) {
  for (const p of people) {
    const snap = await p.snapshot();
    for (const r of snap.packing || []) {
      if (tagged(r.label)) await p.api("DELETE", `/api/trips/${TRIP}/packing/${encodeURIComponent(r.id)}`);
    }
  }
  const a = people[0];
  if (startersBefore) await a.api("PUT", `/api/trips/${TRIP}/packing/starters`, { starters: startersBefore });
  const snap = await a.snapshot();
  for (const l of snap.packing_lists || []) {
    if (tagged(l.name)) { await a.api("DELETE", `/api/trips/${TRIP}/packing/lists/${encodeURIComponent(l.key)}`); continue; }
    const gone = l.bags.filter((x) => tagged(x.name)).map((x) => ({ key: x.key, remove: true }));
    if (gone.length) await a.api("PUT", `/api/trips/${TRIP}/packing/lists`, { lists: [{ key: l.key, bags: gone }] });
  }
}

// AN EMPTY LIST ON A FULL TRIP. The trip this check drives is a full one: every person has
// things of their own, the group has its things, and the trip suggests items for each. The
// empty states are made here: one owner's things are taken off through the routes a person's
// own delete goes through, and put back when the section is over, each with the id, the bags
// and the ticks it had (an item's id is free again once it is gone: docs/API.md, Idempotency).
// What was set aside is put back on every way out of the check, the failed ones too.
const asides = [];
const packingOf = (snap, owner) => {
  const rows = snap.packing.filter((r) => r.owner === owner && !tagged(r.label)).sort((a, b) => a.id.localeCompare(b.id));
  return {
    items: rows.map((r) => ({ id: r.id, owner: r.owner, label: r.label, category: r.category, note: r.note || "", qty: r.qty == null ? "" : String(r.qty), sort: r.sort,
      bags: Object.fromEntries(snap.packing_placements.filter((x) => x.item_id === r.id).map((x) => [x.list_key, x.bag_key]).sort()) })),
    ticks: snap.packing_ticks.filter((t) => rows.some((r) => r.id === t.item_id)).map((t) => ({ item_id: t.item_id, list_key: t.list_key, day: t.day || null }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
};
async function setAside(p, owner) {
  const had = packingOf(await p.snapshot(), owner);
  for (const r of had.items) {
    const gone = await p.api("DELETE", `/api/trips/${TRIP}/packing/${encodeURIComponent(r.id)}`);
    if (gone.status !== 200) throw new Error(`setting ${r.id} aside: ${gone.status} ${JSON.stringify(gone.body).slice(0, 160)}`);
  }
  let back = false;
  const aside = {
    count: had.items.length,
    async putBack() {
      if (back) return;
      back = true;
      // While its own things were aside, everything untagged on this owner's list was put there
      // by this check (a starter's rows carry no tag): that goes first.
      for (const r of (await p.snapshot()).packing.filter((x) => x.owner === owner && !tagged(x.label))) {
        await p.api("DELETE", `/api/trips/${TRIP}/packing/${encodeURIComponent(r.id)}`);
      }
      if (had.items.length) {
        const put = await p.api("PUT", `/api/trips/${TRIP}/packing/items`, { items: had.items });
        if (put.status !== 200) throw new Error(`putting ${had.items.length} things back: ${put.status} ${JSON.stringify(put.body).slice(0, 200)}`);
      }
      for (const t of had.ticks) {
        const tick = await p.api("PUT", `/api/trips/${TRIP}/packing/ticks`, { item_id: t.item_id, list_key: t.list_key, ...(t.day ? { day: t.day } : {}), ticked: true });
        if (tick.status !== 200) throw new Error(`ticking ${t.item_id} again: ${tick.status}`);
      }
    },
  };
  asides.push(aside);
  return aside;
}
const putAllBack = async () => { for (const aside of asides) await aside.putBack(); };

const A = await person(A_ID, { zone: "Asia/Tokyo" });   // a phone a long way from the trip's time zone
let B = null;
let startersBefore = null;
let listsBefore = null;
try {
  await A.open();
  const first = await A.snapshot();
  const roster = (first.members || []).map((m) => m.id);
  const B_ID = roster.find((id) => id !== A_ID);
  if (!B_ID) throw new Error("the trip has one member; this check needs two");
  B = await person(B_ID);
  await B.open();
  // Everything below about "each person's own" means nothing if both browsers are one person.
  const whoA = (await A.api("GET", "/api/me")).body, whoB = (await B.api("GET", "/api/me")).body;
  check("the two browsers are the two people", !!whoA && whoA.id === A_ID && !!whoB && whoB.id === B_ID, `${whoA && whoA.id} / ${whoB && whoB.id}`);

  startersBefore = (first.packing_starters || []).filter((x) => !tagged(x.label)).map(({ rev, ...x }) => x);
  await sweep([A, B], startersBefore);
  const base = await A.snapshot();
  listsBefore = bare(base.packing_lists);
  const once = base.packing_lists.filter((l) => l.repeat !== "daily");
  const L1 = once[0];
  const L2 = once[1] || null;
  const trip = base.trip;
  const baseB = await B.snapshot();
  const before = { A: JSON.stringify(packingOf(base, A_ID)), B: JSON.stringify(packingOf(baseB, B_ID)), group: JSON.stringify(packingOf(base, "group")) };
  const mineBefore = { A: base.packing.filter((r) => r.owner === A_ID).length, B: baseB.packing.filter((r) => r.owner === B_ID).length };
  const groupBefore = base.packing.filter((r) => r.owner === "group").length;

  // ── 1. the tab on the trip's lists ──────────────────────────────────────────────────────
  section("1. the tab reads the trip's lists");
  {
    await A.open();
    const names = await A.page(`[...document.querySelectorAll(".pk-view .pk-view-name")].map((n) => n.textContent)`);
    check("the lists on screen are the trip's, in the trip's order", JSON.stringify(names) === JSON.stringify(base.packing_lists.map((l) => l.name)), names.join(" · "));
    check("the trip has a list packed once with at least two bags to work in", !!L1 && L1.bags.length >= 2, L1 && `${L1.name}: ${L1.bags.map((x) => x.name).join(", ")}`);
    const view = await A.text("#view");
    check('nothing says "leg", and there is no empty-lists state', !/\blegs?\b/i.test(view), view.slice(0, 160));
    const gone = A.requests.filter((r) => /\/packing\/(views|sections|placements)/.test(r.path) || (r.method === "GET" && /\/api\/packing/.test(r.path)));
    check("no request to a packing address that is gone, and none to read packing by itself", gone.length === 0, gone.map((r) => `${r.method} ${r.path}`).join(" "));
    const dbs = await A.page(`indexedDB.databases().then((d) => d.map((x) => x.name).sort().join(" "))`);
    check("the phone has no second packing database", !/wegoplace-pack/.test(dbs) && /wegoplace/.test(dbs), dbs);
    // The press area: the box, and the invisible expander above and below it where it has one (the system's 32 px
    // controls press at 44 through a ::before).
    const sizes = await A.page(`(() => { const out = []; for (const n of document.querySelectorAll(".pk-view, .pk-ownbtn")) { const r = n.getBoundingClientRect(), b = getComputedStyle(n, "::before");
      const grow = b.content && b.content !== "none" && b.position === "absolute" ? Math.max(0, -parseFloat(b.top) || 0) + Math.max(0, -parseFloat(b.bottom) || 0) : 0;
      if (r.height + grow < 44) out.push(n.className + " " + Math.round(r.height + grow)); } return out; })()`);
    check("every list and owner button presses at 44 px or more", sizes.length === 0, sizes.join(", "));
  }

  // ── 2. the starter list ─────────────────────────────────────────────────────────────────
  section("2. the starter list: look, then write, each thing in its bag");
  {
    // Somebody whose own list is empty: the starter is only offered there. B's own things are
    // set aside until section 7 is over (B is the newcomer of this check from here on), and so
    // are the trip's suggestions for a person, for this section: the plain list is what a trip
    // that suggests nothing offers.
    const who = B;
    const mine = await setAside(B, B_ID);
    const personStarters = startersBefore.filter((x) => x.scope === "person");
    if (personStarters.length) {
      const set = await A.api("PUT", `/api/trips/${TRIP}/packing/starters`, { starters: startersBefore.filter((x) => x.scope !== "person") });
      if (set.status !== 200) throw new Error(`setting the trip's suggestions for a person aside: ${set.status} ${JSON.stringify(set.body).slice(0, 200)}`);
    }
    await B.synced();
    check("B's list is empty to start from (their own things set aside), and the trip suggests nothing for a person",
      (await B.snapshot()).packing.filter((r) => r.owner === B_ID).length === 0 && (await B.snapshot()).packing_starters.every((x) => x.scope !== "person"),
      `${mine.count} of B's things and ${personStarters.length} suggestions set aside`);
    {
      await who.open();
      await who.list(L1.key);
      const offered = await who.text('[data-act="seed"]');
      check("an empty list offers the plain starter list, and adds nothing by itself", offered === "Add the starter list" && (await who.page(`document.querySelectorAll(".pk-item").length`)) === 0, offered);
      const from = who.requests.length;
      await who.tap('[data-act="seed"]');
      await waitFor(who.cdp, who.S, `document.querySelector('.sh-sheet [data-act="seedgo"]') ? 1 : 0`, { label: "the look-first sheet" });
      const groups = await who.page(`[...document.querySelectorAll(".sh-sheet .pk-where")].map((g) => [g.querySelector(".pk-where-h span").textContent, g.querySelectorAll(".pk-pv-i").length])`);
      const n = groups.reduce((s, g) => s + g[1], 0);
      check("the sheet shows every thing under the bag it would land in on this list", n >= 15 && groups.every((g) => L1.bags.some((x) => x.name === g[0])), JSON.stringify(groups));
      check("looking wrote nothing", who.requests.slice(from).every((r) => r.method === "GET"), who.requests.slice(from).map((r) => `${r.method} ${r.path}`).join(" "));
      await who.tap('.sh-sheet [data-act="seedgo"]');
      await waitFor(who.cdp, who.S, `document.querySelectorAll(".pk-item").length >= ${n} ? 1 : 0`, { label: "the starter rows" });
      await who.synced();
      const writes = who.requests.slice(from).filter((r) => r.method !== "GET");
      const posts = writes.filter((r) => r.method === "POST" && r.path === `/api/trips/${TRIP}/packing`);
      check("one request per thing, each carrying its bags, and nothing else", posts.length === n && writes.length === n && posts.every((r) => { try { return Object.keys(JSON.parse(r.body).bags || {}).length >= 1; } catch { return false; } }),
        `${posts.length} POSTs of ${writes.length} writes for ${n} things`);
      const snap = await who.snapshot();
      const made = snap.packing.filter((r) => r.owner === who.uid);
      const placed = (list) => snap.packing_placements.filter((p) => p.list_key === list.key && made.some((r) => r.id === p.item_id));
      check("on the server: every thing has a bag on every list packed once", made.length === n && once.every((l) => placed(l).length === n), once.map((l) => `${l.name} ${placed(l).length}`).join(", "));
      check("…and is on no list for the day", base.packing_lists.filter((l) => l.repeat === "daily").every((l) => placed(l).length === 0));
      // The plain list files by position: the first bag, the second, the third.
      const passport = made.find((r) => r.label === "Passport");
      const bottle = made.find((r) => r.label === "Water bottle");
      const at = (r, l) => (snap.packing_placements.find((p) => p.item_id === r.id && p.list_key === l.key) || {}).bag_key;
      check("the passport is in the third bag (on you) and the water bottle in the second (the day bag)",
        !!passport && !!bottle && at(passport, L1) === L1.bags[Math.min(2, L1.bags.length - 1)].key && at(bottle, L1) === L1.bags[1].key, `${at(passport, L1)} / ${at(bottle, L1)}`);
      check("nothing is ticked", snap.packing_ticks.filter((t) => made.some((r) => r.id === t.item_id)).length === 0);
      // Taken away again: these are not tagged, so by id.
      for (const r of made) await who.api("DELETE", `/api/trips/${TRIP}/packing/${encodeURIComponent(r.id)}`);
      await who.synced();
      check("and the starter rows are removed again", (await who.snapshot()).packing.filter((r) => r.owner === who.uid).length === 0);
    }
    if (personStarters.length) {
      const set = await A.api("PUT", `/api/trips/${TRIP}/packing/starters`, { starters: startersBefore });
      check("the trip's suggestions are put back as they were", set.status === 200
        && JSON.stringify((await A.snapshot()).packing_starters.map(({ rev, ...x }) => x)) === JSON.stringify(startersBefore), `${set.status}`);
      await B.synced();
    }
  }

  // ── 3. two people ───────────────────────────────────────────────────────────────────────
  section("3. two people: lists are the trip's, things and ticks are each person's");
  const NEWLIST = `${TAG} beach`;
  let newKey = null;
  let aSocks = null, bSocks = null, stove = null;
  {
    await A.open(); await A.list(L1.key);
    await B.open(); await B.list(L1.key);
    await A.add(`${TAG} socks`);
    await B.add(`${TAG} socks`);
    await A.synced(); await B.synced();
    aSocks = await A.idOf("mine", `${TAG} socks`);
    bSocks = await B.idOf("mine", `${TAG} socks`);
    check("each has their own socks, two different things", !!aSocks && !!bSocks && aSocks !== bSocks, `${aSocks} / ${bSocks}`);
    check("A's thing is not in B's list, and B's is not in A's",
      !(await B.has(`.pk-item[data-id="${aSocks}"]`)) && !(await A.has(`.pk-item[data-id="${bSocks}"]`)) && !(await B.snapshot()).packing.some((r) => r.id === aSocks));
    const placedIn = await A.inStore(`return store.packBag(${JSON.stringify(aSocks)}, ${JSON.stringify(L1.key)}) || "";`);
    check("a thing added on a list is on it, in its first place (the screen shows no bags)",
      placedIn === L1.bags[0].key && (await A.row(aSocks)).on === true, JSON.stringify({ placedIn, first: L1.bags[0].key, row: await A.row(aSocks) }));

    // A adds a list in the Lists sheet.
    await A.listsSheet();
    await A.type("#pk-newview", NEWLIST);
    await A.tap('.sh-sheet [data-act="viewadd"]');
    await sleep(300);
    await A.closeSheet();
    await A.synced();
    const made = (await A.snapshot()).packing_lists.find((l) => l.name === NEWLIST);
    newKey = made && made.key;
    check("A's new list is on the trip on the server, with one place of its own for things, never shown", !!made && made.repeat === "once" && made.bags.length === 1 && made.bags[0].name === "Bag", JSON.stringify(made));
    const put = A.requests.filter((r) => r.method === "PUT" && r.path === `/api/trips/${TRIP}/packing/lists`).map((r) => JSON.parse(r.body)).pop();
    check("the write named the one new list and no other", !!put && put.lists.length === 1 && put.lists[0].name === NEWLIST, JSON.stringify(put));
    await B.synced();
    check("B sees A's list at its next sync", (await B.views()).includes(NEWLIST), (await B.views()).join(" · "));
    check("no bag is named anywhere on the screen", !/Bag\b|Main bag|Day bag|On me/.test(await B.page(`document.querySelector("#view .pk-bags").textContent`)));

    // Ticks.
    await A.tick(aSocks);
    await A.synced(); await B.synced();
    check("A ticks A's socks: packed on A's phone", (await A.row(aSocks)).done === true);
    check("B's socks are not ticked by it", (await B.row(bSocks)).done === false);
    const t1 = (await A.snapshot()).packing_ticks.filter((t) => t.item_id === aSocks);
    check("the server has one tick: A's socks on that list, with no day", t1.length === 1 && t1[0].list_key === L1.key && t1[0].day === null, JSON.stringify(t1));
    if (L2) {
      await A.list(L2.key);
      const r = await A.row(aSocks);
      check("on the other list the same socks are carried and NOT packed", !!r && r.done === false && r.button === true, JSON.stringify(r));
      const tabLeft = await A.page(`(() => { const n = document.querySelector(".pk-sum-n[data-count]"), t = document.querySelector("#pk-own-mine"); return JSON.stringify({ big: n ? n.dataset.count : null, tab: t ? t.getAttribute("aria-label") : null }); })()`);
      const tl = JSON.parse(tabLeft || "{}");
      check("what is left is counted for the list on screen: the big number, and Mine's name says the same", /^\d+$/.test(tl.big || "") && new RegExp(`^Mine, ${tl.big} still to pack of \\d+ for `).test(tl.tab || ""), tabLeft);
      await A.tick(aSocks);
      await A.synced();
      await A.list(L1.key);
      await A.tick(aSocks);                     // untick on the first list
      await A.synced();
      const t2 = (await A.snapshot()).packing_ticks.filter((t) => t.item_id === aSocks).map((t) => t.list_key);
      check("unticking on the first list leaves the tick on the second", JSON.stringify(t2) === JSON.stringify([L2.key]), JSON.stringify(t2));
      await A.tick(aSocks);
      await A.synced();
    }
    await B.tick(bSocks);
    await B.synced(); await A.synced();
    check("B ticks B's socks; A's stay as A left them", (await B.row(bSocks)).done === true && (await A.row(aSocks)).done === true);

    // The group's thing.
    await A.owner("group");
    await A.add(`${TAG} stove`);
    await A.synced();
    stove = await A.idOf("group", `${TAG} stove`);
    await B.owner("group");
    await B.synced();
    const forB = await B.row(stove);
    check("the group's thing A added is in B's group list, tickable, and says whose it is to rename", !!forB && forB.button === true && /Theirs to rename or delete/.test(forB.text), JSON.stringify(forB));
    await B.tick(stove);
    // A new thing goes on every list packed once, the new list too: B takes it off that one.
    await B.move(stove, newKey, false);
    await B.synced(); await A.synced();
    const forA = await A.row(stove);
    check("B ticks it: A sees it packed", !!forA && forA.done === true && forA.on === true, JSON.stringify(forA));
    await A.list(newKey);
    const offNew = await A.row(stove);
    check("B takes it off the new list: A sees it there under Not on this list, with no box", !!offNew && offNew.on === false && offNew.box === false, JSON.stringify(offNew));
    await A.list(L1.key);
    const moves = B.requests.filter((r) => r.method === "PATCH" && r.path === `/api/trips/${TRIP}/packing/${stove}`).map((r) => JSON.parse(r.body));
    check("taking it off a list sent that one list and nothing about the thing itself", moves.length === 1 && JSON.stringify(Object.keys(moves[0])) === '["bags"]' && moves[0].bags[newKey] === null, JSON.stringify(moves));
    await A.owner("mine"); await B.owner("mine");
  }

  // ── 4. no signal ────────────────────────────────────────────────────────────────────────
  section("4. no signal: the writes wait on the phone, and name only what they change");
  const OFF_LIST = `${TAG} offline`;
  const B_LIST = `${TAG} other`;
  {
    await A.list(L1.key);
    await A.offline(true);
    const before = A.requests.length;
    await A.tick(aSocks);                       // untick, offline
    await A.listsSheet();
    await A.type("#pk-newview", OFF_LIST);
    await A.tap('.sh-sheet [data-act="viewadd"]');
    await sleep(300);
    await A.closeSheet();
    const waiting = await A.inStore(`return store.pending();`);
    check("offline: the tick and the new list are on screen and two writes wait", waiting === 2 && (await A.row(aSocks)).done === false
      && (await A.views()).includes(OFF_LIST), `waiting ${waiting}`);
    const kept = await A.page(`new Promise((res) => { const r = indexedDB.open("wegoplace:${TRIP}"); r.onsuccess = () => { const q = r.result.transaction("queue").objectStore("queue").getAll(); q.onsuccess = () => { res(q.result.map((o) => o.kind).join(" ")); r.result.close(); }; }; })`);
    check("both are in the phone's one write queue, to survive the app closing", kept === "pack-tick pack-list", kept);
    // Meanwhile B, with signal, adds a list A has never heard of.
    await B.listsSheet();
    await B.type("#pk-newview", B_LIST);
    await B.tap('.sh-sheet [data-act="viewadd"]');
    await sleep(300);
    await B.closeSheet();
    await B.synced();
    await A.offline(false);
    await A.inStore(`await store.flush();`);
    await A.synced();
    const snap = await A.snapshot();
    const names = snap.packing_lists.map((l) => l.name);
    check("back online: A's list and B's list are both on the trip", names.includes(OFF_LIST) && names.includes(B_LIST) && names.includes(NEWLIST), names.join(" · "));
    check("the offline untick reached the server", !snap.packing_ticks.some((t) => t.item_id === aSocks && t.list_key === L1.key));
    const sent = A.requests.slice(before).filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
    check("exactly those two writes went out, once each", JSON.stringify(sent.sort()) === JSON.stringify([`PUT /api/trips/${TRIP}/packing/lists`, `PUT /api/trips/${TRIP}/packing/ticks`]), sent.join(" "));
  }

  // ── 5. refusals ─────────────────────────────────────────────────────────────────────────
  section("5. refusals: said as a sentence, and the screen put back");
  {
    // 5c. a list someone else still has a thing on.
    const LIST = `${TAG} list`;
    await A.listsSheet();
    await A.type("#pk-newview", LIST);
    await A.tap('.sh-sheet [data-act="viewadd"]');
    await sleep(300);
    await A.closeSheet();
    await A.synced();
    const made = (await A.snapshot()).packing_lists.find((l) => l.name === LIST);
    await B.synced();
    await B.move(bSocks, made.key, true);
    await B.synced(); await A.synced();
    await A.listsSheet();
    await A.tap(`.sh-sheet [data-act="viewdel"][data-id="${made.key}"]`);
    await sleep(200);
    await A.tap(`.sh-sheet [data-act="viewdel"][data-id="${made.key}"]`);
    await waitFor(A.cdp, A.S, `(() => { const n = document.getElementById("toast"); return n && !n.hidden && /still is on it|still are on it/.test(n.textContent) ? 1 : 0; })()`, { label: "the list refusal on screen" });
    const saidList = await A.toast();
    check("a list someone else still has a thing on stays, and the phone says so", saidList === `“${LIST}” stays: 1 thing still is on it, counting everyone's.`, saidList);
    await A.closeSheet();
    await A.synced();
    check("the list is back on A's screen", (await A.page(`[...document.querySelectorAll(".pk-view-name")].map((n) => n.textContent)`)).includes(LIST));
    // B takes the thing off it; now it goes.
    await B.move(bSocks, made.key, false);
    await B.synced(); await A.synced();
    await A.listsSheet();
    await A.tap(`.sh-sheet [data-act="viewdel"][data-id="${made.key}"]`);
    await sleep(200);
    await A.tap(`.sh-sheet [data-act="viewdel"][data-id="${made.key}"]`);
    await sleep(300);
    await A.closeSheet();
    await A.synced();
    check("with nothing on it, the list is removed", !(await A.snapshot()).packing_lists.some((l) => l.key === made.key));

    // 5d. a thing put on a list that was removed on another phone while this one had no signal.
    const offList = (await A.snapshot()).packing_lists.find((l) => l.name === OFF_LIST);
    await A.offline(true);
    await A.move(aSocks, offList.key, true);
    await A.list(offList.key);
    check("offline: the socks show on that list", (await A.row(aSocks)).on === true, JSON.stringify(await A.row(aSocks)));
    const gone = await B.api("DELETE", `/api/trips/${TRIP}/packing/lists/${encodeURIComponent(offList.key)}`);
    check("meanwhile the list is removed elsewhere (nothing was on it on the server)", gone.status === 200, JSON.stringify(gone.body).slice(0, 200));
    await A.offline(false);
    await A.inStore(`await store.flush();`);
    await waitFor(A.cdp, A.S, `(() => { const n = document.getElementById("toast"); return n && !n.hidden && /removed on another phone/.test(n.textContent) ? 1 : 0; })()`, { label: "the refusal on screen" });
    const saidMove = await A.toast();
    check("the phone says the list is gone, naming the thing", saidMove === `That list was removed on another phone, so “${TAG} socks” wasn't put on it.`, saidMove);
    await A.synced();
    await A.list(L1.key);
    const back = await A.row(aSocks);
    check("the socks are still on the list they were on, not lost", !!back && back.on === true, JSON.stringify(back));
  }

  // ── 6. a list for the day ───────────────────────────────────────────────────────────────
  section("6. a list for the day: ticked for the trip's day, and only on its days");
  {
    const DAY = `${TAG} day`;
    const dayKey = `${TAG}-day`;
    const madeDay = await A.api("PUT", `/api/trips/${TRIP}/packing/lists`, { lists: [{ key: dayKey, name: DAY, repeat: "daily", bags: [{ key: "day-pack", name: "Day pack" }] }] });
    check("the trip gets a list for the day (the way an AI setting the trip up would add one)", madeDay.status === 200, JSON.stringify(madeDay.body).slice(0, 200));
    const hasDates = !!(trip.starts_on && trip.ends_on);
    check("the trip has dates, so its days can be told from other days", hasDates, `${trip.starts_on} to ${trip.ends_on}, ${trip.default_tz}`);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: trip.default_tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const outside = today < trip.starts_on || today > trip.ends_on;
    await A.synced();
    await A.list(dayKey);
    await A.move(aSocks, dayKey, "day-pack");
    await A.synced();
    const icon = await A.page(`(() => { const n = document.querySelector('.pk-view[data-view="${dayKey}"] svg'); return n ? n.dataset.icon : null; })()`);
    check("a list for the day has its own shape in the switcher, not only its name", icon === "pk-day", icon);
    if (outside) {
      const r = await A.row(aSocks);
      const line = await A.text('.pk-meter-line[data-closed="1"]');
      check("today is not a day of the trip: the thing is listed but there is nothing to tap", !!r && r.button === false && r.box === true && r.done === false, JSON.stringify(r));
      check("and the screen says when the list IS packed", /^Packed each day of the trip, .+ to .+\. Today isn't one of them\./.test(line || ""), line);
      const from = A.requests.length;
      await A.page(`(() => { const n = document.querySelector('.pk-item[data-id="${aSocks}"] .pk-tick'); n && n.click(); return 1; })()`);
      await sleep(400);
      check("tapping the row sends nothing", A.requests.slice(from).filter((x) => x.method !== "GET").length === 0);
    } else {
      console.log("  (today is a day of the trip here, so the closed state is checked with the clock moved, below)");
    }

    // The second day of the trip, late in the evening THERE: 03:00 UTC on the third day is
    // still the second day anywhere west of UTC-3, and already the third in UTC and in Tokyo,
    // which is where this phone thinks it is.
    const dayN = (n) => { const d = new Date(`${trip.starts_on}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const d2 = dayN(1), d3 = dayN(2);
    const lateOn = (day) => {                     // 22:00 on that day in the trip's zone, as a UTC moment
      for (let h = 0; h < 48; h++) {
        const t = Date.parse(`${day}T00:00:00Z`) + h * 3600000;
        const p = new Intl.DateTimeFormat("en-CA", { timeZone: trip.default_tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
        const get = (k) => p.find((x) => x.type === k).value;
        if (`${get("year")}-${get("month")}-${get("day")}` === day && get("hour") === "22") return t;
      }
      return Date.parse(`${day}T22:00:00Z`);
    };
    await A.clock(lateOn(d2));
    await A.open(); await A.list(dayKey);
    const phoneDay = await A.page(`(() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })()`);
    check("the phone's own calendar says a different day from the trip's", phoneDay !== d2, `phone ${phoneDay}, trip ${d2}`);
    const open2 = await A.row(aSocks);
    const meter2 = await A.text(".pk-meter-line");
    check("on a day of the trip the thing can be ticked, and the count names the trip's day", !!open2 && open2.button === true && open2.done === false && /^0 of 1 packed for pack-check day, \w{3} \w{3} \d+/.test(meter2 || ""), `${meter2}`);
    await A.tick(aSocks);
    await A.synced();
    const ticks2 = (await A.snapshot()).packing_ticks.filter((t) => t.item_id === aSocks && t.list_key === dayKey);
    check("the tick is kept for the TRIP's day, not the phone's", ticks2.length === 1 && ticks2[0].day === d2, JSON.stringify(ticks2));
    check("and the row reads packed", (await A.row(aSocks)).done === true);

    await A.clock(lateOn(d3));
    await A.open(); await A.list(dayKey);
    const open3 = await A.row(aSocks);
    check("the next day starts unticked", !!open3 && open3.done === false && open3.button === true, JSON.stringify(open3));
    check("…with the first day's tick still on the server", (await A.snapshot()).packing_ticks.some((t) => t.item_id === aSocks && t.list_key === dayKey && t.day === d2));

    // Named dates: packed on the second day only. On the third it reads without ticking.
    const named = await A.api("PUT", `/api/trips/${TRIP}/packing/lists`, { lists: [{ key: dayKey, dates: [d2] }] });
    await A.synced();
    const closed3 = await A.row(aSocks);
    const line3 = await A.text('.pk-meter-line[data-closed="1"]');
    check("a list for one named day, on another day: listed, nothing to tap, and it says which day",
      named.status === 200 && !!closed3 && closed3.button === false && /^Packed on \w{3} \w{3} \d+\. Today isn't that day\./.test(line3 || ""), `${named.status} ${line3}`);

    await A.clock(lateOn(d2));
    await A.open(); await A.list(dayKey);
    check("back on the second day, its tick is still there", (await A.row(aSocks)).done === true);
    await A.clock(null);
    await A.open();
  }

  // ── 7. the trip's own suggestions ───────────────────────────────────────────────────────
  section("7. the trip's suggested items replace the plain list");
  {
    const mine = (await B.snapshot()).packing.filter((r) => r.owner === B.uid);
    // B's list has to be empty for the offer to show: B's check socks go first.
    for (const r of mine.filter((x) => tagged(x.label))) await B.api("DELETE", `/api/trips/${TRIP}/packing/${encodeURIComponent(r.id)}`);
    const emptyNow = mine.every((x) => tagged(x.label));
    const set = await A.api("PUT", `/api/trips/${TRIP}/packing/starters`, { starters: [
      ...startersBefore,
      { scope: "person", label: `${TAG} towel`, category: "gear", bags: { [L1.key]: L1.bags[1].key } },
      { scope: "group", label: `${TAG} tarp`, category: "gear", bags: { [L1.key]: L1.bags[0].key } },
    ] });
    check("the trip is given a suggested thing for each person and one for the group", set.status === 200, JSON.stringify(set.body).slice(0, 200));
    await B.synced();
    await B.open(); await B.list(L1.key);
    if (emptyNow) {
      const offered = await B.text('[data-act="seed"]');
      check("an empty list now offers the trip's suggestions, not the plain list", offered === "Add the suggested list", offered);
      await B.tap('[data-act="seed"]');
      await waitFor(B.cdp, B.S, `document.querySelector('.sh-sheet [data-act="seedgo"]') ? 1 : 0`, { label: "the suggestions sheet" });
      const rows = await B.page(`[...document.querySelectorAll(".sh-sheet .pk-where")].map((g) => [g.querySelector(".pk-where-h span").textContent, [...g.querySelectorAll(".pk-pv-l")].map((n) => n.textContent)])`);
      const personRows = rows.flatMap((g) => g[1]);
      check("the sheet shows the person's suggestions under their bag, and not the group's",
        personRows.includes(`${TAG} towel`) && !personRows.includes(`${TAG} tarp`) && rows.some((g) => g[0] === L1.bags[1].name && g[1].includes(`${TAG} towel`)), JSON.stringify(rows));
      await B.tap('.sh-sheet [data-act="seedgo"]');
      await waitFor(B.cdp, B.S, `[...document.querySelectorAll(".pk-item .pk-label")].some((n) => n.textContent === ${JSON.stringify(`${TAG} towel`)}) ? 1 : 0`, { label: "the suggested towel" });
      await B.synced();
      const snap = await B.snapshot();
      const towel = snap.packing.find((r) => r.label === `${TAG} towel` && r.owner === B.uid);
      check("on the server the towel is B's, in the bag the trip suggested", !!towel && snap.packing_placements.some((p) => p.item_id === towel.id && p.list_key === L1.key && p.bag_key === L1.bags[1].key));
    } else {
      check("B's own list is empty for the offer (their things are set aside)", false, `B has ${mine.length} things: ${mine.map((x) => x.label).slice(0, 6).join(", ")}`);
    }
    {
      // The group's check stove goes, and the group's own things are set aside, so the group
      // list is empty.
      for (const r of (await A.snapshot()).packing.filter((x) => x.owner === "group" && tagged(x.label))) await A.api("DELETE", `/api/trips/${TRIP}/packing/${encodeURIComponent(r.id)}`);
      const groups = await setAside(A, "group");
      await B.synced();
      await B.owner("group");
      // The tab is drawn in the frame after the sync's repaint: wait for the offer (a list that
      // never offers it still reads null after the wait).
      await waitFor(B.cdp, B.S, `document.querySelector('[data-act="seed"]') ? 1 : 0`, { label: "the group's empty list", timeout: 5000 }).catch(() => {});
      const offered = await B.text('[data-act="seed"]');
      check("the empty group list offers the group's suggestions", offered === "Add the suggested list", `${offered} (${groups.count} of the group's things set aside)`);
      await B.owner("mine");
      await groups.putBack();
    }
  }

  section("afterwards");
  await sweep([A, B], startersBefore);
  await putAllBack();
  await A.synced(); await B.synced();
  const end = await A.snapshot();
  check("the trip's lists and bags are as they were", bare(end.packing_lists) === listsBefore, bare(end.packing_lists).slice(0, 300));
  check("the suggested items are as they were", JSON.stringify(end.packing_starters.map(({ rev, ...x }) => x)) === JSON.stringify(startersBefore));
  const leftA = end.packing.filter((r) => tagged(r.label)), leftB = (await B.snapshot()).packing.filter((r) => tagged(r.label));
  check("nothing the check made is left, and both lists count what they did before",
    leftA.length === 0 && leftB.length === 0 && end.packing.filter((r) => r.owner === A_ID).length === mineBefore.A && end.packing.filter((r) => r.owner === "group").length === groupBefore,
    `${leftA.length + leftB.length} left`);
  const endB = await B.snapshot();
  check("what was set aside is back as it was: each person's things and the group's, with their ids, bags and ticks",
    JSON.stringify(packingOf(end, A_ID)) === before.A && JSON.stringify(packingOf(endB, B_ID)) === before.B && JSON.stringify(packingOf(end, "group")) === before.group,
    `A ${JSON.stringify(packingOf(end, A_ID)) === before.A}, B ${JSON.stringify(packingOf(endB, B_ID)) === before.B}, the group ${JSON.stringify(packingOf(end, "group")) === before.group}`);
  check("no page error in either browser", A.b.pageErrors.length === 0 && B.b.pageErrors.length === 0, [...A.b.pageErrors, ...B.b.pageErrors].join(" | "));
} catch (e) {
  fail++; failures.push("the check ran to its end");
  console.log(`  FAIL  the check ran to its end   -> ${e && e.stack ? e.stack : e}`);
  try { if (B && listsBefore) await sweep([A, B], startersBefore); } catch (e2) { console.log(`  (the sweep failed too: ${e2.message})`); }
  try { await putAllBack(); } catch (e2) { console.log(`  (putting back what was set aside failed too: ${e2.message})`); }
} finally {
  await A.b.done();
  if (B) await B.b.done();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
