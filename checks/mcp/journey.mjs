// A whole trip through the MCP, in the order an AI works one (the guides' order), on a made-up
// trip shaped like the first rebuild's: flights across zones, two stays, a trek with its own
// packing list, a pass, a restaurant, money, a picture, then a change of plan undone. Each write is
// read back through the tools and held to what was sent. Part of check:mcp.
//
// Everything here is invented: the trip, the town, the places, the people.

export async function journey({ t, server, person, app, bring }) {
  const host = await person("Ida Journey");
  const friend = await person("Oto Journey");
  const { mcp } = await app(host, { name: "Journey App" });
  const ok = (r) => !r.isError;

  t.part("A whole trip, as an AI sets one up");
  const made = await mcp.call("create_trip", { name: "Highlands, a check", starts_on: "2027-06-04", ends_on: "2027-06-12", default_tz: "America/Lima",
    currencies: ["PEN", "USD"], interests: "Two friends; a four-day trek is the point; altitude is the risk." });
  const T = made.json?.trip?.id;
  await bring(host, T, friend);
  const trip = (await mcp.call("get_trip", { trip_id: T })).json;
  const weekday = (day) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(`${day}T12:00:00Z`).getUTCDay()];
  t.same("the trip: every day with its weekday (the calendar's own), both people, the default list a new trip has",
    [ok(made), trip?.days?.length, trip?.days?.every((d) => d.weekday === weekday(d.day)), trip?.members?.length,
      trip?.packing_lists?.map((l) => [l.key, "bags" in l])],
    [true, 9, true, 2, [["leaving-home", false]]]);

  const areas = await mcp.call("put_areas", { trip_id: T, summary: "The town and the trek", areas: [
    { id: "valle", name: "Valle", sort: 1, west: -72.20, south: -13.70, east: -71.80, north: -13.30 },
    { id: "old-quarter", name: "Old quarter", parent: "valle", sort: 2 },
    { id: "trek", name: "The trek", sort: 3, west: -72.60, south: -13.30, east: -72.30, north: -13.10 },
  ] });
  const places = await mcp.call("put_places", { trip_id: T, summary: "The places the trip is built around", places: [
    { id: "airport", name: "Valle airport", kind: "transit", subkind: "airport", area: "valle", lat: -13.536, lng: -71.937, why: "Where the flight lands.", is_anchor: true },
    { id: "hotel", name: "Casa Check", kind: "lodging", subkind: "hotel", area: "old-quarter", lat: -13.515, lng: -71.976, address: "Calle Ejemplo 1", why: "Home on both sides of the trek.", is_anchor: true, elevation_m: 3400 },
    { id: "trailhead", name: "Km 0 trailhead", kind: "transit", subkind: "trailhead", area: "trek", lat: -13.215, lng: -72.383, why: "Where the trek starts.", is_anchor: true },
    { id: "pass", name: "The high pass", kind: "sight", subkind: "mountain", area: "trek", lat: -13.243, lng: -72.484, elevation_m: 4215, why: "Day two's high point.", is_anchor: true },
    { id: "lunch", name: "Fonda Check", kind: "food", subkind: "restaurant", area: "old-quarter", lat: -13.5165, lng: -71.978, why: "The booked lunch.", is_anchor: true,
      hours: "Tue-Sun 12:00-16:00", tags: ["reserve-ahead"] },
    { id: "atm", name: "Check bank machine", kind: "practical", subkind: "atm", area: "old-quarter", lat: -13.5152, lng: -71.9748, why: "Soles for the tips, three minutes from the hotel.",
      near_anchor: "hotel", walk_minutes: 3 },
  ] });
  t.same("areas, then the places, each in its area's bounds", [ok(areas), ok(places), places.json?.places?.length], [true, true, 6]);
  const brief = (await mcp.call("list_places", { trip_id: T, brief: true })).json;
  t.same("  list_places brief: every place in short, grouped by area as [id, name, subkind] (a long trip's all fit)",
    [brief?.columns, Object.keys(brief?.places_by_area ?? {}).sort(), Object.values(brief?.places_by_area ?? {}).flat().length],
    [["id", "name", "subkind"], ["old-quarter", "trek", "valle"], 6]);

  const sent = [
    { id: "flight-in", kind: "flight", title: "XY 100  New York to Valle", starts: "2027-06-04T23:15", tz: "America/New_York", ends: "2027-06-05T05:00", end_tz: "America/Lima", place_id: "airport" },
    { id: "stay-1", kind: "lodging", title: "Casa Check", all_day: true, starts: "2027-06-05", ends: "2027-06-07", tz: "America/Lima", place_id: "hotel" },
    { id: "lunch-1", kind: "meal", title: "Lunch at Fonda Check", starts: "2027-06-06T13:30", tz: "America/Lima", place_id: "lunch", detail: "Table for 2; confirm against the booking." },
    { id: "trek-1", kind: "activity", title: "Trek, day 1", all_day: true, starts: "2027-06-07", tz: "America/Lima", place_id: "trailhead" },
    { id: "trek-2", kind: "activity", title: "Trek, day 2: the high pass", all_day: true, starts: "2027-06-08", tz: "America/Lima", place_id: "pass", detail: "The puffy in the daypack." },
    { id: "train", kind: "transit", title: "Train back", starts: "2027-06-10T15:48", ends: "2027-06-10T17:29", tz: "America/Lima" },
  ];
  const events = await mcp.call("put_events", { trip_id: T, summary: "The itinerary", events: sent });
  const back = new Map(((await mcp.call("list_events", { trip_id: T })).json?.events ?? []).map((e) => [e.id, e]));
  const same = sent.every((e) => { const b = back.get(e.id); return b && b.starts === e.starts && (b.ends ?? undefined) === e.ends && b.tz === e.tz && (b.end_tz ?? undefined) === e.end_tz && b.title === e.title; });
  t.ok("the itinerary reads back exactly as sent: each start and end as the booking prints them, in its own zone, all-day as dates",
    ok(events) && same && back.size === sent.length, [...back.values()].map((e) => [e.id, e.starts, e.ends, e.tz, e.end_tz]));
  t.same("  (the flight leaves on a Friday in New York and lands on a Saturday in the trip's zone)", [back.get("flight-in")?.weekday, back.get("stay-1")?.weekday], ["Friday", "Saturday"]);

  const lists = await mcp.call("set_packing_lists", { trip_id: T, summary: "Packing: the trip's list, and the trek's", lists: [
    { key: "leaving-home", name: "Flying out" },
    { key: "trek", name: "The trek" },
  ] });
  const first = await mcp.call("set_packing_starters", { trip_id: T, summary: "Starters for the trek", starters: [
    { scope: "person", label: "Passport", category: "documents", on: ["leaving-home", "trek"], note: "Checked at the trail control." },
    { scope: "person", label: "Rain jacket", category: "clothes", on: ["leaving-home", "trek"] },
    { scope: "group", label: "First-aid kit", category: "meds", on: ["leaving-home", "trek"] },
  ] });
  const second = await mcp.call("set_packing_starters", { trip_id: T, summary: "Starters for the town", starters: [
    { scope: "person", label: "Casual shirts", category: "clothes", on: ["leaving-home"], note: "Stay at the hotel during the trek." },
    { scope: "person", label: "rain JACKET", note: "Taped seams, or it's a wind shell." },
  ] });
  const packing = (await mcp.call("get_packing", { trip_id: T })).json;
  const rain = packing?.starters?.find((s) => s.label === "Rain jacket");
  t.same("packing: the default list shaped, a trek list added; a second starters call adds one and changes one, the rest stay",
    [ok(lists), ok(first), ok(second), packing?.lists?.map((l) => l.key).sort(), packing?.starters?.length, rain?.note, JSON.stringify(rain?.on), packing?.lists?.some((l) => "bags" in l)],
    [true, true, true, ["leaving-home", "trek"], 4, "Taped seams, or it's a wind shell.", '["leaving-home","trek"]', false]);
  const items = await mcp.call("put_packing_items", { trip_id: T, summary: "My boots, and the group's stove", items: [
    { id: "boots", list: "mine", label: "Boots", category: "clothes", on: ["trek"] },
    { id: "stove", list: "group", label: "Stove", category: "gear", on: ["trek"] },
  ] });
  t.ok("a person's own item and the group's", ok(items) && items.json?.items?.length === 2, items.text.slice(0, 200));

  const lunch = await mcp.call("put_purchase", { trip_id: T, summary: "Lunch, split two ways", purchase: { id: "lunch-pay", description: "Lunch", amount: "84.50", currency: "PEN",
    spent_on: "2027-06-06", event_id: "lunch-1", split: { mode: "even", people: [host.user.id, friend.user.id] } } });
  const payBack = await mcp.call("put_payment", { trip_id: T, summary: "Oto paid back his half", payment: { id: "back-1", from: friend.user.id, to: host.user.id, amount: "42.25", currency: "PEN", paid_on: "2027-06-07" } });
  const split = (await mcp.call("get_split", { trip_id: T })).json;
  t.same("  get_split's answer starts with by_currency (who owes whom), before the purchases", Object.keys(split ?? {})[0], "by_currency");
  t.same("money: an even split by the app's own rounding, and paying it back leaves both at zero",
    [ok(lunch), ok(payBack), split?.purchases?.find((p) => p.id === "lunch-pay")?.shares?.map((s) => s.amount).sort(),
      (split?.by_currency?.PEN?.people ?? []).map((x) => [x.id, x.balance]).sort(), split?.by_currency?.PEN?.transfers],
    [true, true, ["42.25", "42.25"], [[host.user.id, "0.00"], [friend.user.id, "0.00"]].sort(), []]);

  const pic = await mcp.call("set_picture", { trip_id: T, summary: "A picture for the pass", place_id: "pass", url: "https://images.example/the-pass.jpg", license: "CC0" });
  t.same("a picture by address, kept with its license", [ok(pic), pic.json?.picture?.license, pic.json?.picture?.width], [true, "CC0", 1280]);

  t.part("A change of plan, and its undo");
  const closed = await mcp.call("put_events", { trip_id: T, summary: "The trail closed: trek days undecided", events: [
    { id: "trek-1", title: "Trek, day 1 (route decided later)", detail: "Decided at the briefing." },
    { id: "trek-2", title: "Trek, day 2 (route decided later)", detail: "Decided at the briefing." },
  ] });
  const afterClose = new Map(((await mcp.call("list_events", { trip_id: T })).json?.events ?? []).map((e) => [e.id, e]));
  t.same("changing two events by id changes only what's sent: the titles and details move, the days and places stay",
    [ok(closed), afterClose.get("trek-1")?.title, afterClose.get("trek-1")?.starts, afterClose.get("trek-2")?.place_id], [true, "Trek, day 1 (route decided later)", "2027-06-07", "pass"]);
  const undo = await mcp.call("undo_change", { trip_id: T, change_id: closed.json?.change_id });
  const afterUndo = new Map(((await mcp.call("list_events", { trip_id: T })).json?.events ?? []).map((e) => [e.id, e]));
  t.same("undoing it puts both back exactly as they were before", [ok(undo), undo.json?.undone, afterUndo.get("trek-1")?.title, afterUndo.get("trek-2")?.detail],
    [true, 2, "Trek, day 1", "The puffy in the daypack."]);
  const busy = await mcp.call("remove_places", { trip_id: T, summary: "No pass", ids: ["pass"] });
  t.ok("a place an event is on can't be removed, and the refusal names the event", busy.isError && /trek-2/.test(busy.text), busy.text.slice(0, 300));
  const gone = await mcp.call("remove_places", { trip_id: T, summary: "No bank machine", ids: ["atm"] });
  t.ok("one nothing points at can", ok(gone), gone.text.slice(0, 200));

  t.part("What the trip holds now, and its list");
  const end = (await mcp.call("get_trip", { trip_id: T })).json;
  const changes = (await mcp.call("list_changes", { trip_id: T })).json?.changes ?? [];
  t.same("the trip holds what was written: 5 places (one removed), 6 events, 4 starters, 1 purchase and 1 payment",
    [end?.holds?.places, end?.holds?.events, end?.holds?.packing_starters, end?.holds?.purchases], [5, 6, 4, 2]);
  t.same("every write is one line in the list of changes, with the app's name; the refused one isn't there",
    [changes.length, changes.every((c) => c.source === "oauth:Journey App"), changes.some((c) => c.summary === "No pass")], [14, true, false]);
}
