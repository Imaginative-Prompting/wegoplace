#!/usr/bin/env node
/* Pack for today: a packing list "for the day" at the top of its days in the Itinerary
 * (public/js/agenda.js packsFor/packHTML, the tap that ticks, packSlice), with two people in
 * two browsers on the gate's made-up trip and its list "A day out".
 *
 * Chrome needs the Bash sandbox disabled, and the launcher (scripts/lib/browser.mjs) starts it
 * only through the queue:
 *   node scripts/gate.mjs --only pack_today_check
 *
 * WHAT IT PROVES
 *   1. On a day of the list that is the trip's today (the page's clock moved there, the phone's
 *      own zone far from the trip's), the day opens on "Pack for today": the list's name, the
 *      count, and a row for each of your things and the group's on it, read from the trip, and
 *      nobody else's. It stands above the day's stays and plans. Every row is a full target.
 *   2. A tick there is Pack's tick: one write, for the TRIP's day; Pack (opened by the band's
 *      head, on that list) shows the thing packed; unticked in Pack, the band reads it unticked.
 *   3. The other person: their own band, their own things; the group's thing A ticked reads
 *      ticked on B's band when B's phone hears of it, without B opening anything (the day is
 *      repainted by a tick, not only by a plan changing).
 *   4. The list's other days: a day gone says what was packed on it; a day to come says how
 *      many things; neither has anything to tick. A day that isn't one of the list's shows
 *      nothing at all.
 *   5. No signal: a tick in the band reads ticked at once, waits in the phone's one write queue,
 *      and is sent once when the signal is back. Packed in full, the rows stay while they are being
 *      ticked; the next time the Itinerary opens the band is its one line ("all 3 packed").
 *   6. A list for the day with no dates is packed on every day of the trip; a list that carries
 *      nothing of yours or the group's shows nothing.
 *
 * PLANTED, each red here when put in public/js/agenda.js by hand (and taken out again):
 *   - packsOn() answering true for every day: section 4's "nothing on a day that isn't one of
 *     its days" fails.
 *   - tickToday() ticking the phone's own day instead of the band's: section 2's "for the TRIP's
 *     day" fails.
 *   - packSlice() left out of dataSlice(): section 3's "B's band reads it ticked" fails.
 *
 * Everything it makes starts with "pack-today" and is removed at the end (and at the start, in
 * case a run was cut short); a tick it adds to the trip's own list is taken off by the item and
 * day it ticked.
 */
import { BASE, appSettled, boot, evalIn, signInAs, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { TRIP, HOST } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const TAG = "pack-today";
const tagged = (v) => String(v || "").startsWith(TAG);

async function person(uid, { zone } = {}) {
  const b = await boot({ vw: 390, vh: 844, dsf: 1 });
  const { cdp, S } = b;
  if (zone) await cdp.send("Emulation.setTimezoneOverride", { timezoneId: zone }, S);
  await signInAs(cdp, S, uid);
  const requests = [];
  const errors = [];
  cdp.on((m) => {
    if (m.sessionId !== S) return;
    if (m.method === "Network.requestWillBeSent") {
      const u = new URL(m.params.request.url);
      if (u.pathname.startsWith("/api/")) requests.push({ method: m.params.request.method, path: u.pathname, body: m.params.request.postData || "" });
    }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const page = (expr) => evalIn(cdp, S, expr);
  const inStore = (body) => page(`(async () => { const { store } = await import("/js/store.js"); await store.ready(); ${body} })()`);
  let clockId = null;
  const me = {
    uid, b, cdp, S, page, inStore, requests, errors,
    async open(hash = "#/") {
      await cdp.send("Page.navigate", { url: "about:blank" }, S);
      await sleep(120);
      await cdp.send("Page.navigate", { url: `${BASE}/t/${TRIP}/${hash}` }, S);
      await appSettled(cdp, S);
      if (hash === "#/") await waitFor(cdp, S, `document.querySelector(".ag-day") ? 1 : 0`, { label: `${uid}: the Itinerary's days` });
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
    async synced() {
      await waitFor(cdp, S, `(async () => { const { store } = await import("/js/store.js"); return store.pending() === 0 ? 1 : 0; })()`, { label: `${uid}: nothing waiting to be sent` });
      await inStore(`await store.refresh(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));`);
      await sleep(150);
    },
    // What a day's top says: each band's key, title, meta and rows.
    bands: (day) => page(`(() => {
      const d = document.querySelector('.ag-day[data-day="${day}"]');
      if (!d) return null;
      return [...d.querySelectorAll(".ag-stays > .ag-staywrap")].map((w) => ({
        k: w.dataset.k,
        name: (w.querySelector(".ag-stay-name") || {}).textContent || "",
        meta: (w.querySelector(".ag-stay-meta") || {}).textContent || "",
        href: (w.querySelector("a.ag-stay") || {}).getAttribute?.("href") || "",
        rows: [...w.querySelectorAll("[data-pack-tick]")].map((b) => ({ id: b.dataset.packTick, day: b.dataset.packDay, done: b.dataset.done === "1",
          pressed: b.getAttribute("aria-pressed"), label: (b.querySelector(".ag-pk-l") || {}).textContent || "", meta: (b.querySelector(".ag-pk-m") || {}).textContent || "",
          h: Math.round(b.getBoundingClientRect().height) })),
      }));
    })()`),
    tapRow: (id) => page(`(() => { const n = document.querySelector('[data-pack-tick="${id}"]'); if (!n) return "no row"; n.click(); return "ok"; })()`),
    offline: async (off) => {
      await cdp.send("Network.emulateNetworkConditions", { offline: off, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
      await sleep(200);
    },
  };
  return me;
}

// 10:00 on a day in the trip's zone, as a UTC moment; or 22:00, for a phone whose own calendar is
// already on the next day.
const at = (day, hour, zone) => {
  for (let h = -24; h < 48; h++) {
    const t = Date.parse(`${day}T00:00:00Z`) + h * 3600000;
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
    const get = (k) => p.find((x) => x.type === k).value;
    if (`${get("year")}-${get("month")}-${get("day")}` === day && +get("hour") === hour) return t;
  }
  throw new Error(`no ${hour}:00 on ${day} in ${zone}`);
};

// What the trip says a person's band holds on a list: their things and the group's in a bag of it.
const expected = (snap, uid, list) => {
  const mine = snap.packing.filter((r) => r.owner === uid || r.owner === "group");
  return mine.filter((r) => snap.packing_placements.some((x) => x.item_id === r.id && x.list_key === list.key && list.bags.some((b) => b.key === x.bag_key)));
};

const A = await person(HOST.id, { zone: "Asia/Tokyo" });
let B = null;
const ticksMade = [];               // [item, list, day] this check ticked on the trip's own list
let snap0 = null;
try {
  await A.open();
  snap0 = await A.snapshot();
  // The ones a cut-short run left.
  for (const l of snap0.packing_lists.filter((x) => tagged(x.name))) await A.api("DELETE", `/api/trips/${TRIP}/packing/lists/${encodeURIComponent(l.key)}`);
  for (const r of snap0.packing.filter((x) => tagged(x.label))) await A.api("DELETE", `/api/trips/${TRIP}/packing/${encodeURIComponent(r.id)}`);
  snap0 = await A.snapshot();
  const trip = snap0.trip;
  const zone = trip.default_tz;
  const daily = snap0.packing_lists.filter((l) => l.repeat === "daily" && Array.isArray(l.dates) && l.dates.length >= 3);
  const L = daily[0];
  if (!L) throw new Error("the made-up trip has no list for the day with three dates");
  const [dPast, dToday] = L.dates;
  const dLater = L.dates[L.dates.length - 1];
  const dayN = (n) => { const d = new Date(`${trip.starts_on}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  let dNot = null;
  for (let n = 0; ; n++) { const d = dayN(n); if (d > trip.ends_on) break; if (!L.dates.includes(d) && d > dToday) { dNot = d; break; } }
  const roster = (snap0.members || []).map((m) => m.id);
  // A person's own things are theirs alone: the host's phone reads its own and the group's, the
  // other person's phone reads theirs (each from its own snapshot, below).
  const wantA = expected(snap0, HOST.id, L);
  const group = wantA.find((r) => r.owner === "group");
  const ownA = wantA.filter((r) => r.owner === HOST.id);
  check(`the made-up trip's "${L.name}" carries the host's things and the group's`, ownA.length >= 2 && !!group, `host ${ownA.length}, group ${group ? 1 : 0}`);
  const B_ID = roster.find((id) => id !== HOST.id);
  if (!B_ID) throw new Error("the trip has one member; this check needs two");
  const ticksOn = (snap, day) => snap.packing_ticks.filter((t) => t.list_key === L.key && t.day === day);
  check("nothing on it is ticked on its days before the check", L.dates.every((d) => ticksOn(snap0, d).length === 0), JSON.stringify(snap0.packing_ticks.filter((t) => t.list_key === L.key)));

  // ── 1. today ─────────────────────────────────────────────────────────────────────────────
  section(`1. ${dToday}, a day of "${L.name}", is the trip's today: the list is at the top of it`);
  // 22:00 there, already the next day on this phone's own calendar.
  await A.clock(at(dToday, 22, zone));
  await A.open();
  const phoneDay = await A.page(`(() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })()`);
  check("the phone's own calendar says another day than the trip's", phoneDay !== dToday, `phone ${phoneDay}, trip ${dToday}`);
  let bands = await A.bands(dToday);
  const band = (bs) => (bs || []).find((x) => x.k === `pk:${L.key}`);
  let b1 = band(bands);
  check("the day opens on Pack for today", !!b1 && bands[0].k === `pk:${L.key}` && b1.name === "Pack for today", JSON.stringify(bands && bands.map((x) => x.k)));
  const ringed = await A.page(`(document.querySelector(".ag-pill[aria-current]") || { dataset: {} }).dataset.jump || ""`);
  check(`…and that day is the one the strip rings, at 22:00 there (the first screen names today, not tomorrow)`, ringed === dToday, ringed);
  check("…naming the list and how much of it is packed", !!b1 && b1.meta === `${L.name} · 0 of ${wantA.length} packed`, b1 && b1.meta);
  check("…with a row for each of the host's things and the group's on it, and nobody else's",
    !!b1 && JSON.stringify(b1.rows.map((r) => r.id).sort()) === JSON.stringify(wantA.map((r) => r.id).sort()), b1 && b1.rows.map((r) => r.label).join(", "));
  check("…each row named as the thing is, the group's said so", !!b1 && b1.rows.every((r) => {
    const item = wantA.find((x) => x.id === r.id);
    return item && r.label.startsWith(item.label) && (item.owner === "group" ? /The group's/.test(r.meta) : !/group/.test(r.meta));
  }), b1 && b1.rows.map((r) => `${r.label}|${r.meta}`).join(", "));
  check("…every row for the trip's day, unticked, and a full 44px target", !!b1 && b1.rows.every((r) => r.day === dToday && !r.done && r.pressed === "false" && r.h >= 44),
    b1 && b1.rows.map((r) => `${r.day} ${r.h}px`).join(", "));
  check("…and the head opens that list in Pack", !!b1 && b1.href === `#/pack?list=${encodeURIComponent(L.key)}`, b1 && b1.href);
  const order = await A.page(`(() => { const d = document.querySelector('.ag-day[data-day="${dToday}"]'); const pk = d.querySelector('[data-k="pk:${L.key}"]').getBoundingClientRect();
    const rest = [...d.querySelectorAll('.ag-stays > [data-k^="s:"], .ag-list > *')].map((n) => n.getBoundingClientRect().top); return rest.every((t) => t >= pk.bottom - 1); })()`);
  check("it stands above the day's stays and plans", order === true);
  const others = (await A.page(`[...document.querySelectorAll('.ag-day[data-day="${dToday}"] [data-pack-tick]')].length`));
  check("the other days have no row to tick", (await A.page(`document.querySelectorAll('[data-pack-tick]').length`)) === others);

  // ── 2. a tick there is Pack's tick ───────────────────────────────────────────────────────
  section("2. a tick in the band is the tick Pack shows");
  const t1 = ownA[0];
  {
    const from = A.requests.length;
    check("the host taps a thing of theirs", (await A.tapRow(t1.id)) === "ok");
    await waitFor(A.cdp, A.S, `document.querySelector('[data-pack-tick="${t1.id}"][data-done="1"]') ? 1 : 0`, { label: "the row ticked" });
    await A.synced();
    const writes = A.requests.slice(from).filter((r) => r.method !== "GET");
    check("one write, to the ticks", writes.length === 1 && writes[0].path === `/api/trips/${TRIP}/packing/ticks`, writes.map((r) => `${r.method} ${r.path}`).join(" "));
    const ticks = ticksOn(await A.snapshot(), dToday).filter((t) => t.item_id === t1.id);
    check("the tick is kept for the TRIP's day, not the phone's", ticks.length === 1, JSON.stringify((await A.snapshot()).packing_ticks.filter((t) => t.item_id === t1.id)));
    if (ticks.length) ticksMade.push([t1.id, L.key, dToday]);
    b1 = band(await A.bands(dToday));
    check("the band counts it, and the row reads packed by its box and its line", !!b1 && b1.meta === `${L.name} · 1 of ${wantA.length} packed`
      && b1.rows.find((r) => r.id === t1.id).pressed === "true", b1 && b1.meta);
    await A.page(`(() => { document.querySelector('[data-k="pk:${L.key}"] a.ag-stay').click(); return 1; })()`);
    await waitFor(A.cdp, A.S, `document.querySelector('.pk-view[data-view="${L.key}"][aria-checked="true"]') && document.querySelector('.pk-item[data-id="${t1.id}"]') ? 1 : 0`,
      { label: "Pack, on the list the band named" });
    const inPack = await A.page(`(() => { const li = document.querySelector('.pk-item[data-id="${t1.id}"]'); return li ? li.dataset.done : null; })()`);
    check("the band's head opens Pack on that list, the thing packed there", inPack === "1", inPack);
    // Unticked in Pack: the band reads it unticked.
    await A.page(`(() => { document.querySelector('.pk-item[data-id="${t1.id}"] [data-act="tick"]').click(); return 1; })()`);
    await sleep(400);
    await A.synced();
    check("unticked in Pack…", ticksOn(await A.snapshot(), dToday).every((t) => t.item_id !== t1.id));
    await A.open();
    b1 = band(await A.bands(dToday));
    check("…the band reads it unticked", !!b1 && b1.rows.find((r) => r.id === t1.id).done === false && b1.meta === `${L.name} · 0 of ${wantA.length} packed`, b1 && b1.meta);
  }

  // ── 3. the other person ──────────────────────────────────────────────────────────────────
  section("3. the other person: their own band; the group's tick reaches it");
  B = await person(B_ID);
  await B.clock(at(dToday, 10, zone));
  await B.open();
  const wantB = expected(await B.snapshot(), B_ID, L);
  check(`B has things of their own on "${L.name}" too`, wantB.some((r) => r.owner === B_ID), `${wantB.length} rows`);
  check("…and none of B's is in the host's snapshot", !snap0.packing.some((r) => r.owner === B_ID));
  let bB = band(await B.bands(dToday));
  check("B's band has B's things and the group's, none of the host's", !!bB && JSON.stringify(bB.rows.map((r) => r.id).sort()) === JSON.stringify(wantB.map((r) => r.id).sort()),
    bB && bB.rows.map((r) => r.label).join(", "));
  await A.tapRow(group.id);
  await waitFor(A.cdp, A.S, `document.querySelector('[data-pack-tick="${group.id}"][data-done="1"]') ? 1 : 0`, { label: "the group's row ticked" });
  await A.synced();
  if (ticksOn(await A.snapshot(), dToday).some((t) => t.item_id === group.id)) ticksMade.push([group.id, L.key, dToday]);
  // B's phone hears of it (as a live message or the next sync would bring it); nothing reopens.
  await B.inStore(`await store.refresh();`);
  const got = await B.page(`new Promise((res) => { const t0 = Date.now(); const k = () => { const n = document.querySelector('[data-pack-tick="${group.id}"]');
    if (n && n.dataset.done === "1") return res(true); if (Date.now() - t0 > 4000) return res(false); requestAnimationFrame(k); }; k(); })`);
  check("the group's thing the host ticked reads ticked on B's band, with nothing reopened", got === true);
  bB = band(await B.bands(dToday));
  check("…and B's count says so", !!bB && bB.meta === `${L.name} · 1 of ${wantB.length} packed`, bB && bB.meta);

  // ── 4. the list's other days ─────────────────────────────────────────────────────────────
  section("4. the list's other days, and a day that isn't one of them");
  {
    // A tick on the day before, made through the routes (it can't be made on a day gone).
    const past = await A.api("PUT", `/api/trips/${TRIP}/packing/ticks`, { item_id: ownA[0].id, list_key: L.key, day: dPast, ticked: true });
    check("(a thing ticked on the list's first day, through the routes)", past.status === 200, JSON.stringify(past.body).slice(0, 160));
    if (past.status === 200) ticksMade.push([ownA[0].id, L.key, dPast]);
    await A.synced();
    await A.open();
    const p = band(await A.bands(dPast));
    check(`${dPast}, gone: "Pack for the day" says what was packed, and has nothing to tick`, !!p && p.name === "Pack for the day" && p.meta === `${L.name} · 1 of ${wantA.length} packed` && p.rows.length === 0,
      p && `${p.name} | ${p.meta} | ${p.rows.length} rows`);
    const later = band(await A.bands(dLater));
    check(`${dLater}, to come: how many things, nothing to tick`, !!later && later.name === "Pack for the day" && later.meta === `${L.name} · ${wantA.length} things` && later.rows.length === 0,
      later && `${later.name} | ${later.meta}`);
    check("…and its head opens the list too", !!later && later.href === `#/pack?list=${encodeURIComponent(L.key)}`);
    const none = await A.bands(dNot);
    check(`${dNot}, not a day of the list: nothing about packing`, Array.isArray(none) && !none.some((x) => x.k.startsWith("pk:")), JSON.stringify(none && none.map((x) => x.k)));
  }

  // ── 5. no signal ─────────────────────────────────────────────────────────────────────────
  section("5. no signal: the tick waits like any tick");
  {
    const t2 = ownA[1];
    await A.offline(true);
    const from = A.requests.length;
    await A.tapRow(t2.id);
    await sleep(350);
    const row = (band(await A.bands(dToday)) || { rows: [] }).rows.find((r) => r.id === t2.id);
    const waiting = await A.inStore(`return store.pending();`);
    check("offline: the row reads ticked at once and one write waits", !!row && row.done === true && waiting === 1, `done ${row && row.done}, waiting ${waiting}`);
    const kept = await A.page(`new Promise((res) => { const r = indexedDB.open("wegoplace:${TRIP}"); r.onsuccess = () => { const q = r.result.transaction("queue").objectStore("queue").getAll(); q.onsuccess = () => res(q.result.map((o) => o.kind).join(" ")); }; })`);
    check("…in the phone's one write queue", kept === "pack-tick", kept);
    await A.offline(false);
    await A.inStore(`window.dispatchEvent(new Event("online"));`);
    await A.synced();
    const sent = A.requests.slice(from).filter((r) => r.method !== "GET");
    check("back online: sent once", sent.length === 1 && sent[0].path === `/api/trips/${TRIP}/packing/ticks`, sent.map((r) => `${r.method} ${r.path}`).join(" "));
    const on = ticksOn(await A.snapshot(), dToday).some((t) => t.item_id === t2.id);
    check("…and kept for the day", on);
    if (on) ticksMade.push([t2.id, L.key, dToday]);
  }

  // ── 5b. packed in full ─────────────────────────────────────────────────────────────────────
  section("5b. packed in full: open while it is being ticked, its one line the next time");
  {
    for (const r of (band(await A.bands(dToday)) || { rows: [] }).rows.filter((x) => !x.done)) {
      await A.tapRow(r.id);
      await waitFor(A.cdp, A.S, `document.querySelector('[data-pack-tick="${r.id}"][data-done="1"]') ? 1 : 0`, { label: `${r.label} ticked` });
      ticksMade.push([r.id, L.key, dToday]);
    }
    await A.synced();
    let full = band(await A.bands(dToday));
    check("the last tick made here leaves the rows where they were (nothing taken from under the finger)", !!full && full.rows.length === wantA.length && full.rows.every((r) => r.done)
      && full.meta === `${L.name} · all ${wantA.length} packed`, full && `${full.meta} · ${full.rows.length} rows`);
    await A.open();
    full = band(await A.bands(dToday));
    check("opened again, a list packed in full is its one line: what it is and that it's all packed, nothing to tick", !!full && full.name === "Pack for today"
      && full.meta === `${L.name} · all ${wantA.length} packed` && full.rows.length === 0, full && `${full.name} | ${full.meta} | ${full.rows.length} rows`);
    check("…and the line still opens the list in Pack", !!full && full.href === `#/pack?list=${encodeURIComponent(L.key)}`);
  }

  // ── 6. a list with no dates, and a list that carries nothing of yours ────────────────────
  section("6. a list for the day with no dates is on every day of the trip; an empty one on none");
  {
    const key = `${TAG}-every`;
    const made = await A.api("PUT", `/api/trips/${TRIP}/packing/lists`, { lists: [{ key, name: `${TAG} every day`, repeat: "daily", bags: [{ key: "pocket", name: "Pocket" }] }] });
    check("(a list for the day with no dates, made through the routes)", made.status === 200, JSON.stringify(made.body).slice(0, 160));
    await A.synced();
    await A.open();
    const days = await A.page(`[...document.querySelectorAll(".ag-day")].map((d) => d.dataset.day)`);
    const withIt = await A.page(`[...document.querySelectorAll('.ag-day [data-k="pk:${key}"]')].length`);
    check("with nothing of anyone's on it, it shows on no day", withIt === 0, `${withIt} days`);
    const item = await A.api("POST", `/api/trips/${TRIP}/packing`, { id: `${TAG}-keys`, label: `${TAG} keys`, category: "misc", bags: { [key]: "pocket" } });
    check("(a thing of the host's put on it)", item.status === 201 || item.status === 200, item.status);
    await A.synced();
    const tripDays = days.filter((d) => d >= trip.starts_on && d <= trip.ends_on);
    const on = await A.page(`[...document.querySelectorAll('.ag-day')].filter((d) => d.querySelector('[data-k="pk:${key}"]')).map((d) => d.dataset.day)`);
    check("with a thing on it, it is on every day of the trip and no other", JSON.stringify(on) === JSON.stringify(tripDays), `${on.length} of ${tripDays.length} days`);
    const today = band(await A.bands(dToday)) && (await A.bands(dToday)).find((x) => x.k === `pk:${key}`);
    check("…ticked on today, with the thing's name and no bag named (the list has one bag)", !!today && today.rows.length === 1 && today.rows[0].label === `${TAG} keys` && today.rows[0].meta === "",
      today && JSON.stringify(today.rows));
  }

  check("no page error in either browser", A.errors.length === 0 && B.errors.length === 0, [...A.errors, ...B.errors].join(" | ").slice(0, 300));
} catch (e) {
  fail++;
  failures.push(`the check stopped: ${e.message}`);
  console.log(`  FAIL  the check stopped: ${e.stack || e.message}`);
} finally {
  // Every tick it made, by the thing and the day; everything tagged; the clocks back.
  try {
    for (const [item, list, day] of ticksMade) await A.api("PUT", `/api/trips/${TRIP}/packing/ticks`, { item_id: item, list_key: list, day, ticked: false });
    const s = await A.snapshot();
    for (const r of s.packing.filter((x) => tagged(x.label))) await A.api("DELETE", `/api/trips/${TRIP}/packing/${encodeURIComponent(r.id)}`);
    for (const l of s.packing_lists.filter((x) => tagged(x.name))) await A.api("DELETE", `/api/trips/${TRIP}/packing/lists/${encodeURIComponent(l.key)}`);
    const after = await A.snapshot();
    const left = after.packing_ticks.filter((t) => ticksMade.some(([i, l, d]) => t.item_id === i && t.list_key === l && t.day === d)).length
      + after.packing.filter((x) => tagged(x.label)).length + after.packing_lists.filter((x) => tagged(x.name)).length;
    check("everything the check made is gone", left === 0, `${left} left`);
  } catch (e) { check("everything the check made is gone", false, e.message); }
  await A.clock(null).catch(() => {});
  if (B) await B.clock(null).catch(() => {});
  await A.b.done();
  if (B) await B.b.done();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);
