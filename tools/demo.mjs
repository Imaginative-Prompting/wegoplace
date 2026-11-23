// WeGoPlace on your own computer, with the made-up trip on it, in one command:
//
//   npm run demo [-- --port 8788]
//
// It starts the Worker locally (wrangler dev) on a database made fresh from the migrations, puts the
// made-up trip in (seed/demo-trip.json: twelve days, 60 plans, 331 places, four made-up people, their
// purchases, packing and pictures) through the same routes the app uses, and prints a one-use sign-in
// link for each of the four people. Open one, press the button, and you're that person on the trip;
// open another in a private window to be someone else beside them. Ctrl-C stops it, and the database
// goes with it: the next run starts fresh.
//
// Nothing leaves your computer but what the app itself asks for: the map's tiles for the trip's map
// (Protomaps' public world build) and the label fonts. Exchange rates are a stand-in with fixed rates.

import { startServer, CheckError } from "../checks/lib/server.mjs";
import { demoTripOn } from "../checks/lib/demo.mjs";
import { makeLink } from "./signin-link.mjs";

const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 8788);
if (!Number.isInteger(port) || port < 1024 || port > 64535) { console.error("--port: a number from 1024 to 64535"); process.exit(2); }

let server;
const stop = async (code) => { await server?.stop().catch(() => {}); process.exit(code); };
process.on("SIGINT", () => { console.log("\nStopping; the demo's database goes with it."); stop(0); });
process.on("SIGTERM", () => stop(0));

try {
  console.log(`Starting WeGoPlace on port ${port} with a fresh database…`);
  server = await startServer({ name: "demo", port });
  await server.start();
  console.log("Putting the made-up trip in, through the app's own routes (about a minute)…");
  const demo = await demoTripOn(server.origin);
  const lines = demo.seed.people.map((p) => {
    const link = makeLink({ who: demo.ids[p.key], origin: server.origin, hours: 24 });
    server.sql(link.sql);
    return `  ${p.name}${p.host ? " (the host)" : ""}\n    ${link.url}`;
  });
  console.log(`\nWeGoPlace is on ${server.origin}, with "${demo.seed.trip.name}".`);
  console.log("Sign in as one of its people: open a link and press the button (each works once, for a day):\n");
  console.log(lines.join("\n"));
  console.log(`\nThe app is at ${server.origin}/t/${encodeURIComponent(demo.tripId)}/ once you're in. Ctrl-C stops it.`);
  await new Promise(() => {});
} catch (error) {
  console.error(error instanceof CheckError ? `Couldn't start: ${error.message}` : error);
  await stop(1);
}
