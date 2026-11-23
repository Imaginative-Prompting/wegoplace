// The made-up trip, whole, on a check's server: its people signed up (each with their seed color, set), the host's trip seeded
// (tools/seed-trip.mjs), the others joined by links, and their purchases, payments, items and
// pictures written as each of them (tools/demo-fill.mjs). Everyone and everything in it is made up.
//
//   const demo = await demoTripOn(server.origin);
//   demo.tripId, demo.people.ada (a Person), demo.ids.ada (a user id), demo.seed, demo.filled

import fs from "node:fs";
import path from "node:path";
import { ROOT, CheckError } from "./server.mjs";
import { Person } from "./person.mjs";
import { seedTrip } from "../../tools/seed-trip.mjs";
import { fillDemo } from "../../tools/demo-fill.mjs";

export const loadDemo = () => JSON.parse(fs.readFileSync(path.join(ROOT, "seed/demo-trip.json"), "utf8"));

/** A send, as the seed and fill tools take one, from a Person (their cookies, their address). */
// Another tool imports sendAs by this name: keep its name and its signature, (person) => async (method, at, body).
export const sendAs = (person) => async (method, at, body) => {
  const res = await person.call(method, at, body === undefined ? null : body);
  return { status: res.status, json: res.json };
};

export async function demoTripOn(origin, seed = loadDemo()) {
  const people = {};
  for (const p of seed.people) {
    people[p.key] = new Person(origin, p.name);
    const made = await people[p.key].signUp();
    if (made.status !== 200) throw new CheckError(`couldn't make ${p.name}: ${made.status}`);
    // Their own color, set as they would set it (the seed names one each): a drawn one changes with every new id.
    if (p.color) {
      const set = await people[p.key].call("PATCH", "/api/me", { note_color: p.color });
      if (set.status !== 200) throw new CheckError(`couldn't give ${p.name} their color ${p.color}: ${set.status} ${JSON.stringify(set.json)}`);
    }
  }
  const hostKey = seed.people.find((p) => p.host).key;
  const host = people[hostKey];
  const { tripId, report } = await seedTrip(seed, sendAs(host));
  for (const p of seed.people.filter((x) => !x.host)) {
    const link = await host.post(`/api/trips/${tripId}/links`, { uses: 1 });
    const joined = await people[p.key].post(`/api/join/${link.json?.link?.code}`);
    if (joined.status !== 200) throw new CheckError(`${p.name} couldn't join the demo trip: ${joined.status}`);
  }
  const ids = Object.fromEntries(Object.entries(people).map(([k, person]) => [k, person.user.id]));
  const as = Object.fromEntries(Object.entries(people).map(([k, person]) => [k, sendAs(person)]));
  const filled = await fillDemo(seed, { tripId, ids, as });
  return { tripId, seed, people, ids, host, report, filled };
}
