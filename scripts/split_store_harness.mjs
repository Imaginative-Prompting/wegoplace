#!/usr/bin/env node
/* Purchases through the offline store — END TO END, in real Chrome, against the real
 * this lane's dev server (WGP_BASE) and the real local D1.
 *
 *   node scripts/split_store_harness.mjs
 *
 * Chrome needs the Bash sandbox disabled (it cannot create its ProcessSingleton socket
 * otherwise), and the launcher (scripts/lib/browser.mjs) starts it only through the queue:
 *   WGP_BASE=http://127.0.0.1:<port> python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> --label <what> -- node <this file>
 *
 * WHAT IT PROVES, most important first. "It is entered standing in a shop,
 * one-handed, with no signal" is the requirement under every other requirement, so most of
 * this run has no working API at all:
 *
 *   0. AN ALREADY-INSTALLED PHONE SURVIVES THE UPGRADE. The origin is seeded with a
 *      DB_VERSION 1 database — meta, queue and the four v1 rowstores, exactly what a phone
 *      that installed the app last week is carrying — before the app is ever loaded. Had the
 *      version bump been forgotten, onupgradeneeded would not fire, "purchases" would not
 *      exist, hydrate()'s transaction would throw NotFoundError, ready() would reject and
 *      index.html would mount an EMPTY app. That is total offline data loss on upgrade, and it
 *      is the one failure in this build that costs real data, so it is checked first.
 *   1. ADD WITH NO SIGNAL. Three purchases entered offline, one an unequal 'exact' split, one
 *      with no description at all — the two-taps-and-a-number path.
 *   2. THE FOLD. An offline edit of a still-queued purchase merges into its pending create, so
 *      ONE POST goes out carrying the final amount rather than a POST and a PATCH. A
 *      created-then-deleted purchase leaves NO op at all.
 *   3. COLD RESTART. The page is reloaded with the API still unreachable. The feed comes back
 *      from IndexedDB with the edits applied and the durable queue intact — a purchase added
 *      on a mountain survives the app being killed by iOS — and the store re-derives "offline"
 *      from a failed request rather than from navigator.onLine.
 *   4. THE RADIO COMES BACK. The queue drains BY ITSELF, the server's normalised rows are
 *      ADOPTED (created_at arrives in SECONDS where the optimistic stamp was MILLISECONDS —
 *      that is the visible proof adoption happened), and the reconciling refresh that follows
 *      does not wipe the rows.
 *   5. D1 AGREES. Read straight out of the local database: the rows are there, exactly once,
 *      with the folded amount, and SUM(share_minor) = amount_minor on every row in the table.
 *
 * "No signal" here is modelled as the API being unreachable while the asset server is not —
 * CDP Network.setBlockedURLs on /api/*, plus navigator.onLine emulation during the write
 * phase. That is deliberate: this harness is about store.js's queue, and the service worker's
 * own offline story has its own checks (sw_navigation_check and captive_portal_check), and would
 * otherwise be the thing under test on the reload.
 *
 * Nothing below is asserted from reading code. Every number came out of the browser or out of
 * sqlite.
 */
import { BASE, REPO, appSettled, boot, evalIn, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { TRIP, d1 as gateD1 } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + detail : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 600) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// Runtime.evaluate against a page that may be reloading under us. Retry only that failure.
async function ev(cdp, S, expr, tries = 6) {
  for (let i = 0; ; i++) {
    try { return await evalIn(cdp, S, expr); }
    catch (e) {
      const m = String(e);
      if (i >= tries || !/context was destroyed|Cannot find context|Inspected target/i.test(m)) throw e;
      await sleep(400);
    }
  }
}
// Everything that touches the store runs inside the page against the SAME module instance the
// shell imported — a dynamic import of an already-evaluated module URL returns the same record.
const inStore = (cdp, S, body) => ev(cdp, S,
  `(async () => { const { store } = await import("/js/store.js"); ${body} })()`);

// The shell toasts "reject" and refreshes; a harness has to see them, so park them on window.
const watchRejects = (cdp, S) => inStore(cdp, S,
  `window.__rejects = []; store.on("reject", (r) => window.__rejects.push(r)); return 1;`);

const READ_QUEUE = `(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open("wegoplace:${TRIP}");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const rows = await new Promise((res, rej) => {
    const t = db.transaction(["queue"], "readonly");
    const g = t.objectStore("queue").getAll();
    g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error);
  });
  db.close();
  return JSON.stringify(rows.map((o) => ({ seq: o.seq, kind: o.kind, op: o.op, id: o.id,
    amount: o.payload && o.payload.amount_minor })));
})()`;

// (The gate's database, read while its server runs: scripts/lib/gate_trip.mjs, which tries a
// statement again on the local database's passing faults.)
const d1 = (sql, tries = 4) => gateD1(sql, tries);

// ── the fixtures this file makes, and the rows it found already there ───────────────────
// THIS HARNESS USED TO LEAVE ITS PURCHASES IN D1. Every run added two more, forever: the
// `pu_` rows an agent finds in the local database at 3am and mistakes for a person's real dinner are
// this file's. That is not a cosmetic untidiness — split_harness.mjs asserts what the Split
// screen shows on a phone that has synced, and the moment GET /api/trips/<id> starts carrying
// `purchases` those abandoned rows become that harness's input.
//
// So: what was in the table BEFORE anything was written is remembered and is never touched,
// what this run mints is remembered and is deleted, and the delete is checked rather than
// hoped for. Both live at module scope because the cleanup runs in a `finally` and a guard
// that is out of scope where the DELETE happens is not a guard.
let preIds = new Set();
const made = [];

const run = async () => {
  const b = await boot();
  const { cdp, S } = b;
  try {
    // Read before the first write, so "was it here already?" has an answer that cannot have
    // been influenced by this run.
    preIds = new Set(d1("SELECT id FROM purchases").map((r) => r.id));
    // ── 0. an already-installed phone ──────────────────────────────────────────────────
    section("0. the upgrade path - a phone already carrying a DB_VERSION 1 database");
    // boot() lands on /login, same origin, before any app module has run.
    const seeded = await ev(cdp, S, `(async () => {
      await new Promise((res, rej) => {
        const r = indexedDB.open("wegoplace:${TRIP}", 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          db.createObjectStore("meta", { keyPath: "k" });
          for (const s of ["events", "places", "packing", "notes"]) db.createObjectStore(s, { keyPath: "id" });
          db.createObjectStore("queue", { keyPath: "seq", autoIncrement: true });
        };
        r.onsuccess = () => { r.result.close(); res(); };
        r.onerror = () => rej(r.error);
      });
      const dbs = await indexedDB.databases();
      return JSON.stringify(dbs.find((d) => d.name === "wegoplace:${TRIP}"));
    })()`);
    check("seeded a v1 database the way an installed phone carries one", /"version":1/.test(seeded), seeded);

    await cdp.send("Page.navigate", { url: BASE + `/t/${TRIP}/` }, S);
    await appSettled(cdp, S);     // the shell reloads once when its worker first takes control
    await waitFor(cdp, S, `document.querySelector("#view") ? 1 : 0`, { label: "app shell" });
    const me = await waitFor(cdp, S,
      `(async () => { const { store } = await import("/js/store.js"); const m = store.me(); return m && m.id ? m.id : 0; })()`,
      { label: "store.ready() + /api/me" });
    await watchRejects(cdp, S);

    const stores = await ev(cdp, S, `(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open("wegoplace:${TRIP}");
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const out = { version: db.version, names: [...db.objectStoreNames] };
      db.close(); return JSON.stringify(out);
    })()`);
    check("onupgradeneeded fired: the database is now v4, holds a purchases store and a references store (0048: the quick reference list), and no notes store (they are the chat's since migration 0027)",
      /"version":4/.test(stores) && /"purchases"/.test(stores) && /"references"/.test(stores) && !/"notes"/.test(stores), stores);
    const nEvents = await inStore(cdp, S, `return store.events().length`);
    check("ready() resolved on the upgraded database - the app is NOT empty",
      !!me && nEvents > 0, `me=${me}, ${nEvents} events hydrated`);
    check("no exception reached the page during the upgrade", b.pageErrors.length === 0,
      b.pageErrors.join(" | ") || "clean");

    const members = JSON.parse(await inStore(cdp, S, `return JSON.stringify(store.members().map((m) => m.id))`));
    const trip = await inStore(cdp, S, `return store.trip() ? store.trip().id : ""`);
    check("roster available for the split selector", members.length >= 2, members.join(", "));
    console.log(`        trip=${trip}  me=${me}  members=[${members.join(", ")}]`);

    // ── 1. no signal ───────────────────────────────────────────────────────────────────
    section("1. no signal - three purchases entered in a market");
    await cdp.send("Network.setBlockedURLs", { urls: ["*/api/*"] }, S);
    await cdp.send("Network.emulateNetworkConditions",
      { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, S);
    await sleep(400);
    check("the app knows it is offline", (await inStore(cdp, S, `return store.online()`)) === false);

    // THE FEED DOES NOT START EMPTY, AND THIS FILE MUST NOT ASSUME IT DOES. `preIds` above
    // already refuses to delete rows that were here first — that was the cleanup half of the
    // problem. This is the other half: every count below used to be written as a bare literal
    // (=== 3, === 2), which is only true on a virgin purchases table. The moment ANY row
    // survives — a run killed between the drain and the `finally`, a second agent on the same
    // D1, or simply a real purchase in the lane's database — four checks fail at once and they fail looking
    // exactly like a store.js regression: "the feed reads back all three" with no numbers
    // printed next to it. That is the 8-phantom-failure morning AGENTS.md documents, and it
    // cost this workflow a full re-verification before anyone looked at the table.
    //
    // So the baseline is measured HERE — after hydrate, after the radio is cut, before the
    // first write — and everything downstream asserts a DELTA against it. Measured from the
    // feed rather than from `preIds` because the feed is what these checks are about: rows for
    // THIS trip, as store.js actually exposes them, which is not necessarily every row in the
    // table. Each check also prints its arithmetic now, so the next failure arrives with its
    // own evidence instead of sending someone back to sqlite to guess.
    const baseFeed = await inStore(cdp, S, `return store.purchases().length`);
    console.log(`        feed baseline before this run writes anything: ${baseFeed} purchase(s)`);

    const even = (ids) => ids.map((id) => ({ user_id: id, weight: 1 }));
    // 'exact' weights ARE minor amounts and must sum to the amount: the unequal case entered at
    // the drawer's disclosure rather than after the fact.
    const exact = (ids, total) => ids.map((id, i) => ({
      user_id: id, weight: i === 0 ? total - (ids.length - 1) * 1000 : 1000,
    }));

    const p1 = JSON.parse(await inStore(cdp, S, `
      const row = await store.addPurchase({
        description: "Dinner at Andenes", amount_minor: 4800, currency: "PEN", amount_exp: 2,
        shares: ${JSON.stringify(even(members))} });
      return JSON.stringify(row);`));
    made.push(p1.id);
    check("addPurchase returned a complete optimistic row", /^pu-[0-9a-f-]{36}$/.test(p1.id) && p1.trip_id === trip,
      `${p1.id}  ${p1.currency} ${p1.amount_minor}`);
    check("share_minor was RESOLVED by the store, not taken from the caller",
      p1.shares.every((s) => Number.isInteger(s.share_minor)) &&
      p1.shares.reduce((a, s) => a + s.share_minor, 0) === 4800,
      p1.shares.map((s) => `${s.user_id}:${s.share_minor}`).join(" "));
    check("shares are in contract order (user_id ascending)",
      p1.shares.map((s) => s.user_id).join() === [...members].sort().join(),
      p1.shares.map((s) => s.user_id).join(" "));
    check("created_at was stamped in MILLISECONDS locally", p1.created_at > 1e11, String(p1.created_at));

    // The fast path: no description at all, which is common, not an edge.
    const p2 = JSON.parse(await inStore(cdp, S, `
      const row = await store.addPurchase({ amount_minor: 12000, currency: "PEN", amount_exp: 2,
        split_mode: "exact", shares: ${JSON.stringify(exact(members, 12000))} });
      return JSON.stringify(row);`));
    made.push(p2.id);
    check("the two-taps-and-a-number path works with a BLANK description",
      p2.description === "" && p2.amount_minor === 12000, `${p2.id} split_mode=${p2.split_mode}`);
    check("an 'exact' split comes back verbatim (allocate has no branch for the equal case)",
      JSON.stringify(p2.shares.map((s) => s.share_minor)) ===
      JSON.stringify(p2.shares.map((s) => s.weight)),
      p2.shares.map((s) => `${s.user_id} w${s.weight}->${s.share_minor}`).join("  "));

    const p3 = JSON.parse(await inStore(cdp, S, `
      const row = await store.addPurchase({ description: "Taxi to the terminal", amount_minor: 3000,
        currency: "PEN", amount_exp: 2, shares: ${JSON.stringify(even(members))} });
      return JSON.stringify(row);`));
    made.push(p3.id);

    check("the feed reads back all three with no network",
      (await inStore(cdp, S, `return store.purchases().length`)) === baseFeed + 3,
      `${await inStore(cdp, S, `return store.purchases().length`)} in the feed = ${baseFeed} baseline + 3 just added`);
    // "use strict" explicitly: Runtime.evaluate runs a CLASSIC script, and in sloppy mode a
    // write to a frozen property silently no-ops instead of throwing. Every real caller is a
    // module, which is always strict — so the sloppy probe would have measured the wrong thing
    // and reported a store bug that is not there.
    check("frozen deeply: mutating a share throws at the call site (module semantics)",
      (await inStore(cdp, S, `
        const probe = () => { "use strict";
          const out = { frozen: Object.isFrozen(store.purchase(${JSON.stringify(p1.id)})) &&
                                Object.isFrozen(store.purchase(${JSON.stringify(p1.id)}).shares) &&
                                Object.isFrozen(store.purchase(${JSON.stringify(p1.id)}).shares[0]) };
          try { store.purchase(${JSON.stringify(p1.id)}).shares[0].share_minor = 1; out.threw = false; }
          catch (e) { out.threw = true; }
          out.value = store.purchase(${JSON.stringify(p1.id)}).shares[0].share_minor;
          return JSON.stringify(out); };
        return probe();`)) === JSON.stringify({ frozen: true, threw: true, value: p1.shares[0].share_minor }),
      `the share still reads ${p1.shares[0].share_minor} (4800 between ${members.length})`);
    check("nothing landed in the packing list (storeOf has an explicit purchase arm)",
      (await inStore(cdp, S, `
        const rows = [...store.packing("group"), ...store.packing(store.me().id)];
        return rows.filter((r) => /^pu[-_]/.test(String(r.id))).length`)) === 0);
    check("an impossible write is refused BEFORE it reaches the queue",
      (await inStore(cdp, S, `
        try { await store.addPurchase({ description: "x", amount_minor: 0, currency: "PEN",
          shares: ${JSON.stringify(even(members))} }); return "accepted"; }
        catch (e) { return e.message; }`)).includes("positive whole number"));
    check("a partial economic patch is refused (the shallow fold would lose the other shares)",
      (await inStore(cdp, S, `
        try { await store.updatePurchase(${JSON.stringify(p1.id)}, { amount_minor: 9900 }); return "accepted"; }
        catch (e) { return e.message; }`)).includes("all of: amount_minor"));

    // ── 2. the fold ────────────────────────────────────────────────────────────────────
    section("2. the fold - an edit and a delete, both while the create is still queued");
    await inStore(cdp, S, `
      await store.updatePurchase(${JSON.stringify(p1.id)}, {
        amount_minor: 5400, currency: "PEN", amount_exp: 2, split_mode: "weight",
        shares: ${JSON.stringify(even(members))} });
      return 1;`);
    await inStore(cdp, S, `await store.deletePurchase(${JSON.stringify(p3.id)}); return 1;`);

    const q = JSON.parse(await ev(cdp, S, READ_QUEUE));
    const opsFor = (id) => q.filter((o) => o.id === id);
    check("the edit FOLDED into the pending create - one op, still a create, new amount",
      opsFor(p1.id).length === 1 && opsFor(p1.id)[0].op === "create" && opsFor(p1.id)[0].amount === 5400,
      JSON.stringify(opsFor(p1.id)));
    check("create + delete annihilated - the third purchase leaves NO op at all",
      opsFor(p3.id).length === 0, q.map((o) => `${o.seq}:${o.kind}/${o.op}`).join(" "));
    check("the queue holds exactly two purchase ops",
      q.filter((o) => o.kind === "purchase").length === 2,
      q.map((o) => `${o.seq}:${o.kind}/${o.op}`).join(" "));
    check("the deleted purchase left the feed immediately",
      (await inStore(cdp, S, `return store.purchases().length`)) === baseFeed + 2,
      `${await inStore(cdp, S, `return store.purchases().length`)} in the feed = ${baseFeed} baseline + 3 added - 1 deleted`);
    check("store.pending() reports the depth the netline draws from",
      (await inStore(cdp, S, `return store.pending()`)) === 2);

    // ── 3. cold restart, API still unreachable ─────────────────────────────────────────
    section("3. the app is killed and relaunched - the API is still unreachable");
    // navigator.onLine back to true so the DOCUMENT can reload; /api/* stays blocked, which is
    // the Andes case store.js's netOk latch exists for — a radio that is up and carries nothing.
    await cdp.send("Network.emulateNetworkConditions",
      { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
    await cdp.send("Page.reload", {}, S);
    await sleep(2500);
    await waitFor(cdp, S, `document.querySelector("#view") ? 1 : 0`, { label: "app shell after reload" });
    await waitFor(cdp, S,
      `(async () => { const { store } = await import("/js/store.js"); return store.purchases().length ? 1 : 0; })()`,
      { label: "purchases hydrated from IndexedDB" });
    await watchRejects(cdp, S);

    const after = JSON.parse(await inStore(cdp, S, `return JSON.stringify(store.purchases())`));
    check("both purchases came back from IndexedDB with no API", after.length === baseFeed + 2,
      `${after.length} = ${baseFeed} baseline + 2   [${after.map((r) => `${r.id.slice(0, 9)}..=${r.amount_minor}`).join(" ")}]`);
    check("the folded EDIT survived the restart (5400, not the 4800 first entered)",
      after.some((r) => r.id === p1.id && r.amount_minor === 5400));
    check("its shares were re-resolved to the new amount and still sum exactly",
      after.find((r) => r.id === p1.id).shares.reduce((a, s) => a + s.share_minor, 0) === 5400,
      after.find((r) => r.id === p1.id).shares.map((s) => s.share_minor).join(" + ") + " = 5400");
    check("the blank-description 'exact' purchase survived intact",
      after.some((r) => r.id === p2.id && r.description === "" && r.split_mode === "exact"));
    check("the durable queue survived the restart",
      (await inStore(cdp, S, `return store.pending()`)) === 2);
    check("shares are frozen after hydrate too, not only after a write",
      (await inStore(cdp, S, `
        try { store.purchases()[0].shares.push({ user_id: "x" }); return "no throw"; }
        catch (e) { return "threw"; }`)) === "threw");
    await waitFor(cdp, S,
      `(async () => { const { store } = await import("/js/store.js"); return store.online() === false ? 1 : 0; })()`,
      { label: "store re-derives offline from a failed request" });
    check("the store re-derived 'offline' from a failed request, not from navigator.onLine",
      (await ev(cdp, S, `navigator.onLine`)) === true &&
      (await inStore(cdp, S, `return store.online()`)) === false, "navigator.onLine=true, store.online()=false");
    check("nothing was rejected while there was no API",
      (await ev(cdp, S, `JSON.stringify(window.__rejects || [])`)) === "[]");

    // ── 4. the radio comes back ────────────────────────────────────────────────────────
    section("4. the radio comes back");
    const beforeAdopt = after.find((r) => r.id === p1.id);
    await cdp.send("Network.setBlockedURLs", { urls: [] }, S);
    // Toggle the interface so the browser fires its own "online" event: the drain has to happen
    // by itself, not because a harness called flush().
    await cdp.send("Network.emulateNetworkConditions",
      { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, S);
    await sleep(300);
    await cdp.send("Network.emulateNetworkConditions",
      { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
    await waitFor(cdp, S,
      `(async () => { const { store } = await import("/js/store.js"); return store.pending() === 0 ? 1 : 0; })()`,
      { timeout: 60000, label: "queue drains" });
    check("the queue drained by itself when the radio came back", true, "store.pending() === 0");

    await sleep(1500);            // let the reconciling refresh() that flush() fires land
    const adopted = JSON.parse(await inStore(cdp, S, `return JSON.stringify(store.purchase(${JSON.stringify(p1.id)}))`));
    check("the server's normalised row was ADOPTED - created_at is now epoch SECONDS",
      beforeAdopt.created_at > 1e11 && adopted.created_at < 1e11,
      `${beforeAdopt.created_at} (ms, optimistic) -> ${adopted.created_at} (s, from D1)`);
    check("the id did not change - ids are minted on the client and upserted server-side",
      adopted.id === p1.id, adopted.id);
    check("the adopted row carries the folded amount and a summing split",
      adopted.amount_minor === 5400 && adopted.shares.reduce((a, s) => a + s.share_minor, 0) === 5400,
      `${adopted.amount_minor} = ${adopted.shares.map((s) => s.share_minor).join(" + ")}`);
    check("the reconciling refresh did NOT wipe the feed",
      (await inStore(cdp, S, `return store.purchases().length`)) === baseFeed + 2,
      `${await inStore(cdp, S, `return store.purchases().length`)} in the feed = ${baseFeed} baseline + 2 survivors, after the server round-trip`);
    check("no write was rejected", (await ev(cdp, S, `JSON.stringify(window.__rejects || [])`)) === "[]");
    check("no exception reached the page all run", b.pageErrors.length === 0,
      b.pageErrors.join(" | ") || "clean");

    // ── 5. D1 ──────────────────────────────────────────────────────────────────────────
    section("5. what is actually in the database");
    const rows = d1(`SELECT id, description, amount_minor, currency, amount_exp, split_mode, paid_by, created_by, created_at FROM purchases WHERE id IN ('${p1.id}','${p2.id}','${p3.id}') ORDER BY id`);
    check("exactly the two surviving purchases reached D1 - no duplicate from the upsert",
      rows.length === 2, rows.map((r) => `${r.id.slice(0, 9)}..=${r.currency} ${r.amount_minor}`).join(" | "));
    check("the annihilated purchase never reached the server at all",
      !rows.some((r) => r.id === p3.id), p3.id);
    check("D1 holds the FOLDED amount, not the amount first typed",
      (rows.find((r) => r.id === p1.id) || {}).amount_minor === 5400);
    check("the blank description stored as '' rather than being refused",
      (rows.find((r) => r.id === p2.id) || {}).description === "" &&
      (rows.find((r) => r.id === p2.id) || {}).split_mode === "exact");
    check("created_by is the session user, taken from the cookie and never from the body",
      rows.every((r) => r.created_by === me && r.paid_by === me));
    check("created_at is epoch SECONDS in D1", rows.every((r) => r.created_at < 1e11),
      rows.map((r) => r.created_at).join(", "));

    const inv = d1("SELECT p.id, p.amount_minor, (SELECT SUM(share_minor) FROM purchase_shares s WHERE s.purchase_id = p.id) AS sum_share, (SELECT COUNT(*) FROM purchase_shares s WHERE s.purchase_id = p.id) AS n FROM purchases p");
    check("THE INVARIANT holds for every purchase in the table: SUM(share_minor) = amount_minor",
      inv.length > 0 && inv.every((r) => r.sum_share === r.amount_minor),
      inv.map((r) => `${r.id.slice(0, 12)} ${r.amount_minor}=${r.sum_share}/${r.n}`).join("  "));
    const orphans = d1("SELECT COUNT(*) AS n FROM purchase_shares s LEFT JOIN purchases p ON p.id = s.purchase_id WHERE p.id IS NULL");
    check("no orphaned shares left behind", orphans[0].n === 0, `${orphans[0].n} orphans`);
  } finally {
    // Children first — D1 enforces the foreign key — retried, and then VERIFIED. A cleanup
    // whose failure is silent is worse than none: it looks like the table is clean and it is
    // not, and the next agent inherits the confusion rather than the rows.
    for (const id of made) {
      if (preIds.has(id)) {
        console.log(`  SKIPPED cleanup of ${id} — it was in D1 before this run started`);
        continue;
      }
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          d1(`DELETE FROM purchase_shares WHERE purchase_id = '${id}'`);
          d1(`DELETE FROM purchases WHERE id = '${id}'`);
          break;
        } catch (e) {
          console.log(`  cleanup of ${id} failed (attempt ${attempt}/3): ${String(e).split("\n")[0].slice(0, 160)}`);
          if (attempt < 3) await sleep(600);
        }
      }
    }
    if (made.length) {
      const left = d1(`SELECT id FROM purchases WHERE id IN (${made.map((i) => `'${i}'`).join(",")})`);
      check("the run left D1 exactly as it found it — every row it created is gone again",
        left.length === 0, left.map((r) => r.id).join(", ") || "nothing left behind");
    }
    await b.done();
  }
};

run().then(() => {
  console.log(`\n${pass}/${pass + fail} checks passed${fail ? "\nFAILED: " + failures.join("; ") : ""}`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error("\nHARNESS ERROR\n", e); process.exit(2); });
