// THE TRIP'S QUICK REFERENCE LIST (migration 0048, src/api/references.js, the MCP's set_references and get_trip), on a
// server of its own with the real migrations: anyone on the trip adds, changes and removes items, someone not on it
// can't; a create sent again is the same row; every refusal in words, writing nothing; the list in the trip's snapshot
// whole and in a phone's delta (what changed, what went); an AI's write recorded with its undo; the limits; and the
// list gone with the trip. Everyone in it is made up.
//
//   node checks/references/run.mjs [--port <n>]

import { CheckError, startServer, freePort } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { McpClient, connect } from "../lib/mcp.mjs";
import { REFERENCE_TEXT_MAX, REFERENCE_TITLE_MAX, REFERENCES_MAX } from "../../public/js/shared/limits.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? await freePort());
const t = new Report("the trip's quick reference list");

let server, code = 1;
try {
  server = await startServer({ name: "references", port });
  await server.start();
  const o = server.origin;
  const rows = (trip) => server.sql(`SELECT id, title, body, position, created_by FROM trip_references WHERE trip_id = '${trip}' ORDER BY position, id`);
  const person = async (name) => { const p = new Person(o, name); if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${name}`); return p; };
  const ada = await person("Ada Reference");
  const ben = await person("Ben Reference");
  const cy = await person("Cy Outside");
  const trip = (await ada.post("/api/trips", { name: "Canal week (made up)", default_tz: "Europe/Amsterdam" })).json.trip.id;
  const link = (await ada.post(`/api/trips/${trip}/links`, { uses: 1 })).json.link.code;
  await ben.post(`/api/join/${link}`);
  const R = `/api/trips/${trip}/references`;

  t.part("1. Anyone on the trip adds, changes and removes; someone not on it can't");
  const a1 = await ada.post(R, { id: "rf-emergency", title: "Emergency numbers", body: "Police, fire and ambulance: 112\r\nThe hotel: +31 20 765 4321" });
  t.same("the host adds one: 201, the row, its line breaks kept as \\n", [a1.status, a1.json?.reference?.title, a1.json?.reference?.body], [201, "Emergency numbers", "Police, fire and ambulance: 112\nThe hotel: +31 20 765 4321"]);
  const again = await ada.post(R, { id: "rf-emergency", title: "Something else" });
  t.same("the same create sent again (its answer lost): 200, the row it made, unchanged", [again.status, again.json?.reference?.title, rows(trip).length], [200, "Emergency numbers", 1]);
  const b1 = await ben.post(R, { id: "rf-money", title: "Money and ATMs", body: "Cards almost everywhere." });
  t.same("a member adds one; it goes at the end of the list", [b1.status, rows(trip).map((r) => r.id)], [201, ["rf-emergency", "rf-money"]]);
  const p1 = await ben.call("PATCH", `${R}/rf-emergency`, { body: "Police, fire and ambulance: 112" });
  t.same("a member changes the host's: only what's sent changes", [p1.status, rows(trip)[0].title, rows(trip)[0].body], [200, "Emergency numbers", "Police, fire and ambulance: 112"]);
  const before = JSON.stringify(rows(trip));
  const out = [await cy.get(R), await cy.post(R, { id: "rf-cy", title: "Not mine" }), await cy.call("PATCH", `${R}/rf-money`, { title: "x" }), await cy.call("DELETE", `${R}/rf-money`)];
  t.ok("someone not on the trip: refused as if there were no such trip, every time, nothing written", out.every((r) => r.status === 404 && r.json?.error === "no such trip") && JSON.stringify(rows(trip)) === before, out.map((r) => r.status).join(","));

  t.part("2. Refusals, in words, writing nothing");
  const refused = async (label, res, status, words) => {
    const r = await res;
    t.ok(label, r.status === status && words.test(r.json?.reason ?? JSON.stringify(r.json?.rows ?? "")) && JSON.stringify(rows(trip)) === before, `${r.status} ${r.text.slice(0, 200)}`);
  };
  await refused("no title: 400", ada.post(R, { id: "rf-x", body: "x" }), 400, /needs a title/);
  await refused(`a title past ${REFERENCE_TITLE_MAX} characters: 400`, ada.post(R, { id: "rf-x", title: "x".repeat(REFERENCE_TITLE_MAX + 1) }), 400, /at most 80/);
  await refused(`a text past ${REFERENCE_TEXT_MAX} characters: 400`, ada.post(R, { id: "rf-x", title: "x", body: "y".repeat(REFERENCE_TEXT_MAX + 1) }), 400, /at most 2000/);
  await refused("a change that empties the title: 400", ada.call("PATCH", `${R}/rf-money`, { title: "  " }), 400, /needs a title/);
  await refused("a change to an item that isn't there: 404", ada.call("PATCH", `${R}/rf-nothing`, { title: "x" }), 404, /no item/);
  await refused("a list with a row of each wrong kind: 400, each row named, nothing written", ada.call("PUT", R, { references: [{ id: "rf-ok", title: "Fine" }, { title: "No id" }, { id: "rf-bad", title: "" }] }), 400, /needs its id[\s\S]*needs a title/);

  t.part("3. A list put and removed (the MCP's routes)");
  const put = await ada.call("PUT", R, { references: [{ id: "rf-money", body: "Cards almost everywhere; some shops cards only." }, { id: "rf-door", title: "Door code", body: "4321#" }] });
  t.same("PUT: one changed, one added at the end", [put.status, rows(trip).map((r) => [r.id, r.body])],
    [200, [["rf-emergency", "Police, fire and ambulance: 112"], ["rf-money", "Cards almost everywhere; some shops cards only."], ["rf-door", "4321#"]]]);
  const del = await ada.call("DELETE", R, { ids: ["rf-door", "rf-nothing"] });
  t.same("DELETE a list: what's there goes, what isn't is passed over", [del.status, del.json?.deleted, rows(trip).map((r) => r.id)], [200, 1, ["rf-emergency", "rf-money"]]);

  t.part("4. In the trip's snapshot, whole, and in a phone's delta");
  const snap = (await ada.get(`/api/trips/${trip}`)).json;
  t.same("the snapshot sends the list whole, in its order", snap.references?.map((r) => r.id), ["rf-emergency", "rf-money"]);
  const since = snap.rev;
  await ben.call("PATCH", `${R}/rf-money`, { title: "Money" });
  await ben.call("DELETE", `${R}/rf-emergency`);
  const delta = (await ada.get(`/api/trips/${trip}?since=${since}`)).json;
  t.same("a delta: the item changed since, and the one that went", [delta.delta, delta.references?.map((r) => [r.id, r.title]), delta.gone?.references], [true, [["rf-money", "Money"]], ["rf-emergency"]]);
  const removedTwice = await ben.call("DELETE", `${R}/rf-emergency`);
  t.same("removed again (a queued removal arriving twice): 200, nothing more", [removedTwice.status, removedTwice.json?.deleted], [200, false]);
  const empty = await (async () => { await ben.call("DELETE", `${R}/rf-money`); return (await ada.get(`/api/trips/${trip}`)).json; })();
  t.same("an empty list is still sent, as [] (an absent one reads as unchanged on a phone)", empty.references, []);

  t.part("5. An AI reads and writes it, each write in the list of changes with its undo");
  const c = await connect(o, ada, { address: ada.address });
  if (c.tokens?.status !== 200) throw new CheckError("couldn't connect an app for Ada");
  const mcp = new McpClient(o, c.tokens.json.access_token);
  await mcp.initialize();
  const set = await mcp.call("set_references", { trip_id: trip, summary: "Added the emergency numbers to the quick reference",
    references: [{ id: "rf-ai-emergency", title: "Emergency numbers", body: "112" }, { id: "rf-ai-embassy", title: "Embassy", body: "+31 70 123 4567" }] });
  t.ok("set_references adds, as one change with its id", !set.isError && set.json?.change_id && rows(trip).length === 2, set.text.slice(0, 300));
  const got = await mcp.call("get_trip", { trip_id: trip });
  t.same("get_trip shows the list whole, and counts it", [got.json?.references?.map((r) => r.id), got.json?.holds?.references], [["rf-ai-emergency", "rf-ai-embassy"], 2]);
  const change = await mcp.call("set_references", { trip_id: trip, summary: "The embassy's line changed; the emergency item removed",
    references: [{ id: "rf-ai-embassy", body: "+31 70 765 0000" }, { id: "rf-ai-emergency", remove: true }] });
  t.same("a change and a removal in one call", [change.isError, rows(trip).map((r) => [r.id, r.body])], [false, [["rf-ai-embassy", "+31 70 765 0000"]]]);
  const changes = (await ada.get(`/api/trips/${trip}/changes`)).json?.changes ?? [];
  t.ok("both are on the trip's list of changes, by their summaries", changes.some((ch) => /emergency numbers to the quick reference/.test(ch.summary)) && changes.some((ch) => /embassy's line changed/.test(ch.summary)), JSON.stringify(changes.map((ch) => ch.summary)));
  const undo = await mcp.call("undo_change", { trip_id: trip, change_id: change.json?.change_id });
  t.same("undo puts the item back and the line as it was", [undo.isError, rows(trip).map((r) => [r.id, r.body])], [false, [["rf-ai-emergency", "112"], ["rf-ai-embassy", "+31 70 123 4567"]]]);
  const unknown = await mcp.call("set_references", { trip_id: trip, summary: "x", references: [{ id: "rf-ai-x", title: "x", colour: "red" }] });
  t.ok("a field the tool doesn't take: refused by name, nothing written", unknown.isError && /colour/.test(unknown.text) && rows(trip).length === 2, unknown.text.slice(0, 200));
  const bad = await mcp.call("set_references", { trip_id: trip, summary: "x", references: [{ id: "rf-ai-y", title: "" }] });
  t.ok("a row the route refuses: the words come back, nothing written", bad.isError && /needs a title/.test(bad.text) && rows(trip).length === 2, bad.text.slice(0, 200));

  t.part(`6. At most ${REFERENCES_MAX} items a trip`);
  const now = Math.floor(Date.now() / 1000);
  const planted = Array.from({ length: REFERENCES_MAX - rows(trip).length }, (_, i) => `rf-plant-${i}`);
  server.sql(`INSERT INTO trip_references (trip_id, id, title, body, position, created_at, updated_at) VALUES ${planted.map((id, i) => `('${trip}', '${id}', 'Planted', '', ${100 + i}, ${now}, ${now})`).join(", ")}`);
  const full = rows(trip).length;
  const one = await ada.post(R, { id: "rf-one-more", title: "One more" });
  const many = await ada.call("PUT", R, { references: [{ id: "rf-one-more", title: "One more" }] });
  t.ok(`one past ${REFERENCES_MAX}: refused in words (one, and in a list), nothing written`, one.status === 409 && many.status === 409 && /at most 100/.test(one.json?.reason ?? "") && rows(trip).length === full, `${one.status} ${many.status} ${one.text.slice(0, 120)}`);
  const changeAtCap = await ada.call("PUT", R, { references: [{ id: "rf-plant-0", title: "Changed at the cap" }] });
  t.same("  while a change to one that's there still goes", changeAtCap.status, 200);

  t.part("7. Gone with the trip");
  const gone = await ada.call("DELETE", `/api/trips/${trip}`, { confirm: "Canal week (made up)" });
  t.ok("the trip deleted: its list is gone, and so is what recorded it", [200, 204].includes(gone.status) && rows(trip).length === 0
    && server.sql(`SELECT COUNT(*) AS n FROM trip_gone WHERE trip_id = '${trip}'`)[0].n === 0, `${gone.status} ${gone.text.slice(0, 160)}`);

  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  code = 2;
} finally {
  await server?.stop().catch(() => {});
}
process.exit(code);
