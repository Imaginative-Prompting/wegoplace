// THE GATE'S OWN SERVER AND DATABASE, MADE FROM NOTHING.
//
// Every check on the gate that drives "the lane's server" drives this one: a server started
// here (checks/lib/server.mjs: wrangler.jsonc's own settings, nothing of a developer's
// .dev.vars or database), its database made by the migrations and nothing else, and on it the
// made-up trip, whole (checks/lib/demo.mjs: seed/demo-trip.json through tools/seed-trip.mjs
// and tools/demo-fill.mjs, every row through the routes a person's write goes through). Four
// made-up people, one of them the host. No database is carried from one run to the next, so a
// gate run says the same thing on any machine, and no still taken on it shows anyone's trip.
//
//   const gate = await makeGateDb();
//   gate.env      { WGP_BASE, WGP_GATE_CARD }: what a check started on it is given
//   gate.card     what scripts/lib/gate_trip.mjs reads through WGP_GATE_CARD (below)
//   await gate.stop()
//
// THE CARD is a file in the server's own work folder (removed with it), mode 600: the server's
// address, the trip's id, where its database is kept (for a check that reads rows), and the
// four people with the passkey each signed up with. Those passkeys are made in this run, for
// accounts that exist only in this run's database; a check signs a person in with one, through
// the sign-in routes, and so gets a session of its own that it may end.

import fs from "node:fs";
import path from "node:path";
import { freePort, startServer, WRANGLER } from "../../checks/lib/server.mjs";
import { demoTripOn } from "../../checks/lib/demo.mjs";
import { d1EachOn } from "./gate_sql.mjs";

export async function makeGateDb({ name = "gate", port = null, say = () => {} } = {}) {
  const t0 = Date.now();
  // A port whose stand-ins' ports and inspector (a thousand up) are free too (27 Nov: a port the system handed out had
  // its inspector's taken, and the gate's server refused to start).
  const server = await startServer({ name, port: port ?? await freePort() });
  try {
    await server.start();
    say(`The gate's server answers on ${server.origin} (its database: the migrations, nothing else), ${Math.round((Date.now() - t0) / 1000)} s`);
    const demo = await demoTripOn(server.origin);
    const card = {
      made: Date.now(),
      origin: server.origin,
      trip: demo.tripId,
      name: demo.seed.trip.name,
      database: { wrangler: WRANGLER, work: server.work, state: server.state, config: path.join(server.work, "wrangler.json") },
      people: demo.seed.people.map((p) => {
        const passkey = demo.people[p.key].passkeys[0];
        return {
          key: p.key, name: p.name, host: !!p.host, id: demo.ids[p.key],
          passkey: { jwk: passkey.jwk, credId: passkey.credId.toString("utf8"), userHandle: passkey.userHandle },
        };
      }),
    };
    const file = path.join(server.work, "gate-card.json");
    fs.writeFileSync(file, JSON.stringify(card, null, 2), { mode: 0o600 });
    say(`The made-up trip is on it: “${card.name}” (${card.trip}), ${demo.seed.places.length} places, ${demo.seed.events.length} plans, `
      + `${card.people.length} people, ${demo.seed.purchases.length} purchases; ${Math.round((Date.now() - t0) / 1000)} s in all`);
    return { server, demo, card, file, env: { WGP_BASE: server.origin, WGP_GATE_CARD: file }, stop: () => server.stop() };
  } catch (error) {
    await server.stop().catch(() => {});
    throw error;
  }
}


// ── THE TRIP'S ROWS, BY KEY ─────────────────────────────────────────────────────────────────
// A check removes only rows it made, each by the id it recorded when it made it; never "the
// first", "the last" or "the newest" (a harness once took the first row of a feed for its own,
// and its cleanup deleted a purchase of the trip). The gate holds every check to that: it
// reads the key of every row of the made-up trip before a check and after it, and a check
// that leaves the set different (a row gone, or a row left behind) has failed, whatever its
// own tally says.
//
// Each line: the table, how a row is named (its key), and which rows are the trip's.
const TRIP_ROWS = [
  ["trips", "id", "id = :trip"],
  ["trip_members", "user_id", "trip_id = :trip"],
  ["trip_links", "id", "trip_id = :trip"],
  ["trip_changes", "id", "trip_id = :trip"],
  ["areas", "id", "trip_id = :trip"],
  ["places", "id", "trip_id = :trip"],
  ["events", "id", "trip_id = :trip"],
  ["pictures", "target_kind || '/' || target_id", "trip_id = :trip"],
  ["media_objects", "r2_key", "trip_id = :trip"],
  ["purchases", "id", "trip_id = :trip"],
  ["purchase_shares", "purchase_id || '/' || user_id", "purchase_id IN (SELECT id FROM purchases WHERE trip_id = :trip)"],
  ["packing_lists", "key", "trip_id = :trip"],
  ["packing_bags", "list_key || '/' || key", "trip_id = :trip"],
  ["packing_starters", "id", "trip_id = :trip"],
  ["packing_items", "id", "trip_id = :trip"],
  ["packing_placements", "item_id || '/' || list_key", "trip_id = :trip"],
  ["packing_ticks", "item_id || '/' || list_key || '/' || COALESCE(day, '')", "trip_id = :trip"],
  ["memories", "id", "trip_id = :trip"],
  ["memory_media", "id", "memory_id IN (SELECT id FROM memories WHERE trip_id = :trip)"],
  ["memory_tags", "memory_id || '/' || tag", "memory_id IN (SELECT id FROM memories WHERE trip_id = :trip)"],
  // A plan's notes are the chat's messages since migration 0027 (event_notes is gone).
  ["messages", "id", "trip_id = :trip"],
  ["collage_shares", "id", "trip_id = :trip"],
  ["collage_share_items", "share_id || '/' || idx", "share_id IN (SELECT id FROM collage_shares WHERE trip_id = :trip)"],
];

/** Every row of the card's trip, as Map(table → Set of keys). One command, a statement a table. */
export function tripRows(card) {
  if (!/^[\w-]+$/.test(card.trip)) throw new Error(`the gate's trip id isn't one to write into a statement: ${card.trip}`);
  const sql = TRIP_ROWS.map(([table, key, where]) =>
    `SELECT CAST(${key} AS TEXT) AS k FROM ${table} WHERE ${where.replaceAll(":trip", `'${card.trip}'`)}`).join("; ");
  const each = d1EachOn(card.database, sql, 4);
  if (each.length !== TRIP_ROWS.length) throw new Error(`the trip's rows: ${TRIP_ROWS.length} statements asked, ${each.length} answered`);
  return new Map(TRIP_ROWS.map(([table], i) => [table, new Set(each[i].map((row) => row.k))]));
}

/** What differs between two readings, a line a table; [] when they are the same. */
export function rowsDiff(before, after) {
  const lines = [];
  const some = (keys) => `${keys.slice(0, 4).join(", ")}${keys.length > 4 ? `, … (${keys.length})` : ""}`;
  for (const [table, was] of before) {
    const now = after.get(table) || new Set();
    const gone = [...was].filter((k) => !now.has(k)), left = [...now].filter((k) => !was.has(k));
    if (gone.length) lines.push(`${table}: ${gone.length} of the trip's gone (${some(gone)})`);
    if (left.length) lines.push(`${table}: ${left.length} left behind (${some(left)})`);
  }
  return lines;
}
