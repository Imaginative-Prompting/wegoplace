// Finding real places and their photos (src/mcp/tools.js find_places, find_picture; src/map/pois.js, world.js,
// wikimedia.js), and the web search the site may offer the assistant (src/assistant/talk.js webSearch, meter.js
// searchWorst). Through the assistant's own loop on a server of its own, with a stand-in model, a stand-in world of
// made-up places at real positions and stand-in Wikidata and Commons (checks/lib/pois-world.mjs). Never the network.
//
//   node --disable-warning=ExperimentalWarning checks/assistant/find.mjs [--port <port>]
//
// It holds:
//   1. find_places near a place on the trip: real places of the kinds asked, nearest first, each within a metre of where it is,
//      and an answer that says it is never complete ("not every one") and names OpenStreetMap; near a point; a name;
//      nowhere to search, and a place with no position, refused in words;
//   2. find_picture: a free photo found with its license, its credit out of its HTML and its page, as a file set_picture
//      takes (Commons' 1280-wide copy of a 3000-wide original; a small original whole) and set_picture keeps it; a
//      license that isn't free ("nc" after a CC BY too) is "nothing found"; no item, nothing found; every request to
//      Wikimedia names the site (its User-Agent). A 3 km search is cut to fit 16 tiles (60°N too); a site without
//      the limiter set up refuses; a tile's buffer points are its neighbour's;
//   3. at most FIND_CALLS_PER_MINUTE searches a minute an account: the next is refused in words;
//   4. web search: off unless the site says so (no server tool in the request, and wrangler.jsonc ships it empty); on,
//      OpenRouter's search on Exa with its caps; the meter's worst case holds a search answered at its largest
//      (every search used, every result at its most characters), planted.
// Everyone and everything in it is made up.

import fs from "node:fs";
import path from "node:path";
import { CheckError, ROOT, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { startModel } from "../lib/model-standin.mjs";
import { PHOTO_URL, PLACES, poisTile, sizedCopy, startPoisWorld, startWikimedia } from "../lib/pois-world.mjs";
import { TOOLS } from "../../src/mcp/tools.js";
import { NEAR, poisInTile, tileOf, tilesAround } from "../../src/map/pois.js";
import { freeLicense } from "../../src/map/wikimedia.js";
import { FIND_CALLS_PER_MINUTE } from "../../public/js/shared/limits.js";
import { webSearch } from "../../src/assistant/talk.js";
import { SEARCH_MICRO, worstCase } from "../../src/assistant/meter.js";
import { distanceM } from "../../src/map/pois.js";

const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 8918);
const t = new Report("finding real places, their photos, and the web search");
const KEY = "sk-or-check-not-real";
const at = (name) => PLACES.find((p) => p.name === name);

let server, model, world, wiki, code = 1;
try {
  model = await startModel({ key: KEY });
  world = await startPoisWorld();
  wiki = await startWikimedia();
  server = await startServer({
    name: "assistant-find", port,
    vars: { PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y", ASSISTANT_ENABLED: "true",
      ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5", OPENROUTER_API_BASE: model.base,
      WORLD_URL: world.url, WIKIMEDIA_API_VIA: wiki.url },
    secrets: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", OPENROUTER_API_KEY: KEY },
  });
  await server.start();
  const ada = new Person(server.origin, "Ada Reyes");
  if ((await ada.signUp()).status !== 200) throw new CheckError("couldn't make Ada");
  const trip = (await ada.post("/api/trips", { name: "Canal week", default_tz: "Europe/Amsterdam", starts_on: "2027-05-12", ends_on: "2027-05-15" })).json.trip.id;
  const now = Math.floor(Date.now() / 1000);
  server.sql(`INSERT INTO billing_subscriptions (id, user_id, customer, status, interval, current_period_end, held, updated_at, synced_at)
    VALUES ('sub_ada', '${ada.user.id}', 'cus_ada', 'active', 'month', ${now + 30 * 86400}, 0, ${now}, ${Date.now()})`);
  const hotel = at("Hotel Lindegracht");
  const A = `/api/trips/${trip}`;
  await ada.call("PUT", `${A}/areas`, { areas: [{ id: "ams", name: "Amsterdam", west: 4.80, south: 52.32, east: 4.98, north: 52.42 }] });
  await ada.call("PUT", `${A}/places`, { places: [
    { id: "hotel", name: hotel.name, kind: "lodging", subkind: "hotel", area: "ams", lat: hotel.lat, lng: hotel.lng, why: "Where we stay." },
    { id: "nowhere", name: "A place with no position", kind: "sight", subkind: "landmark", area: "ams", why: "Somewhere." },
  ] });
  await ada.post(`${A}/assistant/conversations`, { id: "c-find" });
  let n = 0;
  /** One ask whose first model call calls these tools: answers the tool results the loop handed back, parsed. */
  const toolResults = async (tools) => {
    const mark = model.calls.length;
    model.next({ tools });
    model.next({ words: "Done looking." });
    const r = await ada.post(`${A}/assistant/conversations/c-find/ask`, { id: `ask-${++n}`, words: "Look something up." });
    if (r.status !== 200) throw new CheckError(`the ask answered ${r.status}`);
    const back = model.calls.slice(mark)[1]?.body?.messages?.filter((m) => m.role === "tool") ?? [];
    return back.map((m) => { try { return JSON.parse(m.content); } catch { return { text: m.content }; } });
  };

  t.part("1. find_places");
  const [bakeries, byPoint, byName, nowhere, noPosition, byNames] = await toolResults([
    { name: "find_places", arguments: { place_id: "hotel", kinds: ["bakery"], radius_m: 800 } },
    { name: "find_places", arguments: { lat: 52.3731, lng: 4.8922, kinds: ["museum"], radius_m: 3000 } },
    { name: "find_places", arguments: { lat: 52.3731, lng: 4.8922, name: "Keuken van Kaas", radius_m: 2000 } },
    { name: "find_places", arguments: { kinds: ["bakery"] } },
    { name: "find_places", arguments: { place_id: "nowhere" } },
    { name: "find_places", arguments: { lat: 52.3731, lng: 4.8922, names: ["Keuken van Kaas", "Anne Frank House", "Cafe Zonnewende"], radius_m: 2000 } },
  ]);
  const b = at("Bakkerij Ochtendgloren"), z = at("Broodhuis De Zon");
  // A z15 tile keeps a position in steps of its 4,096 units (about 0.3 m here): "where it is" is within a metre.
  t.same("near the hotel, the bakeries only, nearest first", bakeries.places?.map((p) => [p.name, p.kind]), [[b.name, "bakery"], [z.name, "bakery"]]);
  t.ok("  each where it is, within a metre (a tile's own precision)", bakeries.places?.every((p, i) => distanceM(p, [b, z][i]) < 1),
    JSON.stringify(bakeries.places?.map((p, i) => distanceM(p, [b, z][i]).toFixed(2))));
  t.ok("  with each one's distance in metres, rising", bakeries.places?.every((p, i, a) => Number.isInteger(p.distance_m) && (i === 0 || p.distance_m >= a[i - 1].distance_m)) && bakeries.places[0].distance_m < 200,
    JSON.stringify(bakeries.places?.map((p) => p.distance_m)));
  t.ok("  never complete: complete false, and it says a place not listed may still exist", bakeries.complete === false && /not every one/.test(bakeries.note) && /may still exist/.test(bakeries.note), bakeries.note);
  t.ok("  names OpenStreetMap and the build it read", /OpenStreetMap/.test(bakeries.source) && /stand-in/.test(bakeries.source), bakeries.source);
  // 3 km from Dam Square needs ~9 × 9 z15 tiles: cut until it fits NEAR.tilesMax, and the answer says to what.
  const searchedTo = byPoint.searched?.radius_m;
  t.ok(`near a point, 3 km asked: the radius cut to fit ${NEAR.tilesMax} tiles, and the answer says so`, searchedTo < 3000 && tilesAround(52.3731, 4.8922, searchedTo).length <= NEAR.tilesMax
    && /cut to \d+ m/.test(byPoint.searched?.radius_cut ?? ""), JSON.stringify(byPoint.searched));
  const box = byPoint.searched?.bounds ?? {};
  const inBox = (p) => p.lng >= box.west && p.lng <= box.east && p.lat >= box.south && p.lat <= box.north;
  const rim = Array.from({ length: 72 }, (_, i) => { const a = (i * 5 * Math.PI) / 180, dLat = (searchedTo * Math.cos(a)) / 111_195, dLng = (searchedTo * Math.sin(a)) / (111_195 * Math.cos((52.3731 * Math.PI) / 180)); return { lat: 52.3731 + dLat, lng: 4.8922 + dLng }; });
  t.ok("  its searched.bounds hold the whole circle searched (72 points on its rim) and every place found, and no more than 2% beyond it (a city's area takes it as its bounds)",
    rim.every((p) => distanceM(p, { lat: 52.3731, lng: 4.8922 }) <= searchedTo + 1 && inBox(p)) && (byPoint.places ?? []).length > 0 && byPoint.places.every(inBox)
      && (box.north - 52.3731) * 111_195 <= searchedTo * 1.02 && (box.east - 4.8922) * 111_195 * Math.cos((52.3731 * Math.PI) / 180) <= searchedTo * 1.02,
    JSON.stringify(box));
  t.same("  the museums within the radius searched, every one", byPoint.places?.map((p) => p.name).sort(),
    PLACES.filter((p) => p.kind === "museum" && distanceM(p, { lat: 52.3731, lng: 4.8922 }) <= searchedTo).map((p) => p.name).sort());
  t.ok(`  and at 60°N (narrower tiles) a 3 km search still reads at most ${NEAR.tilesMax}`, (() => { let r = 3000; while (r > 50 && tilesAround(60.17, 24.94, r).length > NEAR.tilesMax) r = Math.floor(r * 0.85); return tilesAround(60.17, 24.94, r).length <= NEAR.tilesMax && tilesAround(60.17, 24.94, 3000).length > NEAR.tilesMax; })(),
    `${tilesAround(60.17, 24.94, 3000).length} tiles at 3 km`);
  t.same("by name: that place alone", byName.places?.map((p) => p.name), ["Keuken van Kaas"]);
  t.ok("nowhere to search: refused in words", nowhere.error === "nowhere to search" && /place_id .* lat and lng/.test(nowhere.reason), JSON.stringify(nowhere));
  t.ok("a place with no position: refused in words, naming it", noPosition.error === "no position" && noPosition.reason.includes("A place with no position"), JSON.stringify(noPosition));

  t.same("several names in ONE search (a document's places): an answer for each, by any name the map gives a place, and one it can't find said so",
    (byNames.results ?? []).map((r) => [r.name, r.places.map((p) => p.name), !!r.none]),
    [["Keuken van Kaas", ["Keuken van Kaas"], false], ["Anne Frank House", ["Anne Frank Huis"], false], ["Cafe Zonnewende", [], true]]);
  t.ok("  each found where it is, within a metre, and the search named its names", distanceM(byNames.results?.[1]?.places?.[0] ?? {}, at("Anne Frank Huis")) < 1 && byNames.searched?.names?.length === 3, JSON.stringify(byNames.searched));

  t.part("2. find_picture");
  const heardBefore = wiki.heard.length;
  const [free, small, notFree, none] = await toolResults([
    { name: "find_picture", arguments: { name: "Museum Het Waaghuis", lat: at("Museum Het Waaghuis").lat, lng: at("Museum Het Waaghuis").lng } },
    { name: "find_picture", arguments: { name: "Stadsmuseum Amstelkade", lat: at("Stadsmuseum Amstelkade").lat, lng: at("Stadsmuseum Amstelkade").lng } },
    { name: "find_picture", arguments: { name: "Grachtenmuseum Noord", lat: at("Grachtenmuseum Noord").lat, lng: at("Grachtenmuseum Noord").lng } },
    { name: "find_picture", arguments: { name: b.name, lat: b.lat, lng: b.lng } },
  ]);
  t.same("a free photo whose original (3000 × 2000) is too big: Commons' 1280-wide copy (no tracking), its license, its credit out of its HTML, its page",
    [free.found, free.url, free.width, free.height, free.license, free.credit, free.source], [true, PHOTO_URL, 1280, 853, "CC BY-SA 4.0", "A. Lens", "https://commons.wikimedia.org/wiki/File:Waaghuis.png"]);
  t.same("  one whose original (1200 × 800) fits as it is: the original", [small.found, small.url, small.width, small.license], [true, "https://upload.wikimedia.org/wikipedia/commons/c/cd/Small.png", 1200, "CC0"]);
  const stored = await toolResults([{ name: "set_picture", arguments: { summary: "The museum's photo", place_id: "hotel", url: free.url, license: free.license, credit: free.credit, source: free.source } }]);
  const kept = server.sql(`SELECT width, height, license, credit, source FROM pictures WHERE trip_id = '${trip}' AND target_kind = 'place' AND target_id = 'hotel'`)[0];
  t.same("  and set_picture keeps what find_picture found: the 1280-wide copy, its license, credit and page", [!stored[0]?.error, kept?.width, kept?.license, kept?.credit, kept?.source],
    [true, 1280, "CC BY-SA 4.0", "A. Lens", "https://commons.wikimedia.org/wiki/File:Waaghuis.png"]);
  t.same("free licenses only: CC0, public domain, CC BY, CC BY-SA, with a jurisdiction or IGO; nc or nd after one isn't free",
    ["CC0", "Public domain", "CC BY 4.0", "CC BY-SA 3.0 nl", "CC BY-SA 3.0 igo", "CC BY 4.0 nc", "CC BY-SA 3.0 nc-nd", "CC BY-NC 2.0"].map(freeLicense), [true, true, true, true, true, false, false, false]);
  t.ok("a photo under a license that isn't free (CC BY-NC): nothing found, saying why", notFree.found === false && /free license/.test(notFree.why), JSON.stringify(notFree));
  t.ok("a place with no item: nothing found", none.found === false, JSON.stringify(none));
  const agents = [...new Set(wiki.heard.slice(heardBefore).map((h) => h.agent))];
  t.same("every request to Wikimedia names the site", agents, [`WeGoPlace (+${server.origin})`]);

  t.part(`3. At most ${FIND_CALLS_PER_MINUTE} searches a minute`);
  const many = await toolResults(Array.from({ length: FIND_CALLS_PER_MINUTE + 1 }, () => ({ name: "find_places", arguments: { place_id: "hotel", kinds: ["cafe"] } })));
  const refused = many.filter((r) => r.error === "too many searches");
  t.ok(`the searches past the minute's ${FIND_CALLS_PER_MINUTE} refused in words (the ${(FIND_CALLS_PER_MINUTE + 1)}th at the latest, as the first part's count with them)`,
    refused.length >= 1 && refused.every((r) => r.refused === 429 && r.reason.includes(String(FIND_CALLS_PER_MINUTE))) && many.at(-1).error === "too many searches", `${refused.length} refused of ${many.length}`);

  t.part("3b. Fails closed, and each tile's own places");
  const bare = { env: {}, person: { id: "u-x" }, call: async () => { throw new Error("no route should be asked"); } };
  const closed = await Promise.all(["find_places", "find_picture"].map((n) => TOOLS.find((x) => x.name === n).run(bare, { trip_id: "t", lat: 52.37, lng: 4.89, name: "x", kinds: ["cafe"] })));
  t.ok("a site without the limiter set up finds nothing for anyone: refused, not set up, before any request", closed.every((r) => r.isError && /not set up/.test(r.content[0].text)), JSON.stringify(closed.map((r) => r.content[0].text)));
  const home = tileOf(b.lat, b.lng, 15), next = { x: home.x + 1, y: home.y };
  const raw = poisTile([b, { name: "From the next tile", kind: "cafe", lat: b.lat, lng: b.lng + 0.012 }], 15, home.x, home.y);
  t.same("a tile's points beyond its edge (a neighbour's, in its buffer) aren't counted as its own", poisInTile(raw, 15, home.x, home.y).map((p) => p.name), [b.name]);
  t.ok("  (the planted one really is in the next tile)", tileOf(b.lat, b.lng + 0.012, 15).x === next.x, "");

  t.part("4. The web search the site may offer");
  const config = fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
  t.ok("wrangler.jsonc ships it EMPTY (off), and its cap empty", /"ASSISTANT_WEB_SEARCH": ""/.test(config) && /"ASSISTANT_WEB_SEARCH_MAX": ""/.test(config), "");
  const offered = model.calls.map((c) => (c.body?.tools ?? []).filter((x) => x.type === "openrouter:web_search").length);
  t.ok("off: no request of this server's carried a search", offered.length > 0 && offered.every((x) => x === 0), JSON.stringify(offered.slice(0, 5)));
  t.same("on: OpenRouter's search, on Exa, five results of at most 2,000 characters, at most 3 searches a call", webSearch({ ASSISTANT_WEB_SEARCH: "true" }),
    [{ type: "openrouter:web_search", parameters: { engine: "exa", max_results: 5, max_uses: 3, max_characters: 2000 } }]);
  t.same("  its cap set by ASSISTANT_WEB_SEARCH_MAX, at most 10; anything but \"true\" leaves it off",
    [webSearch({ ASSISTANT_WEB_SEARCH: "true", ASSISTANT_WEB_SEARCH_MAX: "2" })[0].parameters.max_uses, webSearch({ ASSISTANT_WEB_SEARCH: "true", ASSISTANT_WEB_SEARCH_MAX: "50" })[0].parameters.max_uses, webSearch({ ASSISTANT_WEB_SEARCH: "yes" }).length], [2, 10, 0]);
  // Planted: a call that used every search, each bringing every result at its most characters, its words read again
  // after each, and wrote all it may: what it costs at the prices, against what the meter reserves before it.
  const env = { ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5" };
  const messages = [{ role: "system", content: "You help with a trip." }, { role: "user", content: "Find somewhere good for dinner tonight near the canal." }];
  const tools = [{ type: "function", function: { name: "list_places", description: "Places.", parameters: { type: "object", properties: {} } } }, ...webSearch({ ASSISTANT_WEB_SEARCH: "true" })];
  const sent = JSON.stringify(messages).length + JSON.stringify(tools).length;
  const largest = 3 * SEARCH_MICRO + (sent + 3 * (5 * 2000 + sent)) * 0.1 + 1200 * 0.5;
  const reserved = worstCase(env, { messages, tools, maxTokens: 1200 });
  t.ok(`the meter's worst case holds a search answered at its largest (reserved ${reserved} µ$ ≥ ${Math.ceil(largest)} µ$)`, reserved >= largest, `${reserved} < ${largest}`);
  t.same("  and without a search, the worst case is today's", worstCase(env, { messages, tools: tools.slice(0, 1), maxTokens: 1200 }),
    Math.ceil((JSON.stringify(messages).length + JSON.stringify(tools.slice(0, 1)).length) * 0.1 + 1200 * 0.5));
  code = t.end();
} catch (error) {
  console.error(error);
  t.end();
  code = 2;
} finally {
  await server?.stop().catch(() => {});
  await model?.close();
  await world?.stop();
  await wiki?.stop();
}
process.exit(code);
