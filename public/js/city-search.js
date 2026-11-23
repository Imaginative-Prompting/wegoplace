// city-search.js: a town says where a trip is. It finds the trip's time zone, and gives the
// trip an area for its map.
//
// The zone database names a zone by ONE city ("Asia/Tokyo"), so typing the place a trip really
// goes to ("Kyoto", "Cusco", "Hallstatt") found nothing. This reads a table of towns, each with
// its country, region, zone, position and size (public/towns/, made by scripts/make_towns.mjs
// from GeoNames' files), and answers what was typed with rows a person can pick from.
//
// THE TABLE IS MANY SMALL FILES, FETCHED AS SOMEBODY TYPES: one for each run of first letters
// (docs/CONTRACTS.md, "A town says where a trip is"). Nothing here runs on import, nothing is
// asked of any server but this site's own static files, and the worker keeps each file it has
// fetched, so what was found once is found again with no signal.
//
//   townSource({ fetcher, base }) -> the table: index() and file(prefix), each fetched once
//   findTowns(source, typed, opts) -> Promise of { rows, reached }: the best first, and whether
//                                     the table could be read (false with no signal and no copy)
//       a row: { kind, name, town, region, country, cc, zone, lat, lng, people }
//       kind "city" (has a position), "country" or "zone" (a zone only)
//       name: the spelling that was typed where that is one of the town's names ("Machu Picchu"
//       for Machupicchu, "Kioto" for Kyoto); town: the table's own name for it
//   zoneRows(typed, zones, index) -> rows of kind "zone" from a plain list of zone ids: what
//                                    there is to offer when the table can't be read
//   zoneNear(source, lat, lng)  -> Promise of { zone, away } or null: the zone at a spot that
//                                    is no town of the table (a pasted map link)
//   rowLabel(row)               "Kyoto, Japan"; "Springfield, Illinois, United States"
//   rowWhere(row, when)         "GMT+9"
//   zoneWords(zone, when)       "Tokyo time, GMT+9"
//   zonePlace(index, zone)      "Tokyo, Japan": a stored zone as a place, with no region word
//   boxFor(row)                 { west, south, east, north }: the area a town gets
//   areaIdFor(name, taken)      "kyoto": an id the server takes, not one of `taken`
//   areaOf(row, taken)          the area a picked row gives a trip, or null (a country has none)
//   placeWords(row)             what picking it means, in a sentence
//   areaAcrossKm(area)          how far across an area a trip already has is
//   planWords(plan, name)       what adding `name` does to the map of the others, in sentences
//   fold(words), squash(words)  how names are compared; the table's maker uses these very ones

/** What a file of the table may weigh, and how many of the largest towns a split file keeps. The maker reads both. */
export const CAP_BYTES = 48000;
export const HEAD_ROWS = 40;

// Letters that are their own letter in some alphabet and have no mark to take off.
const PLAIN = { "ß": "ss", "ø": "o", "đ": "d", "ł": "l", "æ": "ae", "œ": "oe", "ı": "i", "þ": "th", "ð": "d", "ħ": "h" };
/** A name as it is read: no accents, lower case, one space between words. */
export const fold = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase()
  .replace(/[ßøđłæœıþðħ]/g, (ch) => PLAIN[ch]).replace(/[’`‘ʻ]/g, "'").replace(/[\s_]+/g, " ").trim();
/** A name as it is COMPARED: folded, then only its letters and digits. "Machu Picchu" and "Machupicchu" are one. */
export const squash = (s) => fold(s).replace(/[^a-z0-9]/g, "");
/** The later words of a name, as compared, three letters or more: a large town is found by them too ("york"). */
export const laterWords = (name) => fold(name).split(/[ -]/).slice(1).map((w) => w.replace(/[^a-z0-9]/g, "")).filter((w) => w.length >= 3);
const BIG_TOWN = 100000;            // the size from which a town is found by its later words

const validZones = new Map();
/** Whether this browser knows the zone (an older one may not know a zone renamed since). */
export function zoneKnown(zone) {
  if (!validZones.has(zone)) {
    let ok = true;
    try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch { ok = false; }
    validZones.set(zone, ok);
  }
  return validZones.get(zone);
}

/** The zone's own name as a person says it: "Tokyo", "New York", "Buenos Aires". */
export const zoneName = (zone) => String(zone || "").split("/").at(-1).replace(/_/g, " ");

/**
 * The moment a typed day stands for, for a zone's offset on it: noon UTC of that day when it is a
 * whole date a trip could have (from 1970, where the zone database is sure, to ten years ahead),
 * else now. A date being typed passes through years like 0002 and 0202, where a zone is local
 * mean time ("GMT+10:04:52"), and a line that said that would wrap and move the form under the
 * person's fingers (the film, 15 Nov).
 */
export function dayWhen(day, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return now;
  const t = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== day) return now;
  const y = +m[1];
  return y >= 1970 && y <= now.getUTCFullYear() + 10 ? t : now;
}

/** "GMT+9", "GMT-5", "GMT+5:30", "GMT": the zone's offset at `when` (a Date; now when not given). */
export function zoneOffset(zone, when = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(when)
      .find((part) => part.type === "timeZoneName")?.value || "";
  } catch { return ""; }
}

/** "Tokyo time, GMT+9": a zone said as a time, for the line under a place. */
export function zoneWords(zone, when) {
  const name = zoneName(zone), off = zoneOffset(zone, when);
  if (/^(UTC|GMT)$/i.test(name)) return "UTC";
  return off ? `${name} time, ${off}` : `${name} time`;
}

// ── the table ───────────────────────────────────────────────────────────────────────────
/** The name of the file for a run of first letters. ("t-" so that no file is called con.txt or aux.txt, which one system refuses.) */
export const fileName = (prefix) => `t-${prefix}.txt`;

/**
 * The table, read through `fetcher` (the page's fetch; a check gives its own) from `base`.
 * index() and file(prefix) each fetch once and share the answer; one that failed can be asked
 * again (the signal may be back).
 */
export function townSource({ fetcher = (url) => fetch(url), base = "/towns/" } = {}) {
  let index = null, near = null;
  const files = new Map();
  const get = async (name) => {
    const res = await fetcher(base + name);
    if (!res || !res.ok) throw new Error(`${name}: ${res ? res.status : "no answer"}`);
    return res;
  };
  return {
    index() {
      if (!index) {
        index = get("index.json").then((res) => res.json()).then((raw) => {
          const zoneCc = new Map();
          for (const [cc, [, zs]] of Object.entries(raw.countries)) for (const z of zs) if (!zoneCc.has(raw.zones[z])) zoneCc.set(raw.zones[z], cc);
          const countryKeys = Object.entries(raw.countries).map(([cc, [name]]) => ({ cc, name, key: squash(name) }));
          return { ...raw, zoneCc, countryKeys };
        }).catch((e) => { index = null; throw e; });
      }
      return index;
    },
    file(prefix) {
      if (!files.has(prefix)) {
        files.set(prefix, get(fileName(prefix)).then((res) => res.text()).then(parseFile).catch((e) => { files.delete(prefix); throw e; }));
      }
      return files.get(prefix);
    },
    /** near.txt as a Map: a one-degree square of the planet → the zone most of its people keep. */
    near() {
      if (!near) {
        near = get("near.txt").then((res) => res.text()).then((text) => {
          const cells = new Map();
          for (const line of text.split("\n")) {
            if (!line || line[0] === "#") continue;
            for (const pair of line.split(",")) { const i = pair.indexOf(":"); cells.set(parseInt(pair.slice(0, i), 36), parseInt(pair.slice(i + 1), 36)); }
          }
          return cells;
        }).catch((e) => { near = null; throw e; });
      }
      return near;
    },
  };
}

/** The one-degree square a spot is in, as near.txt numbers them. The maker numbers them with this. */
export const cellOf = (lat, lng) => (Math.min(179, Math.floor(lat) + 90)) * 360 + ((Math.floor(lng) + 180) % 360 + 360) % 360;

/**
 * The time zone at a spot that is no town of the table (a pasted map link): the zone most
 * people keep in its one-degree square, else in the nearest square within three that has a
 * town. { zone, away } (away: how many squares off), or null when no town is that near (open
 * sea, a far park): the caller keeps the zone it had and says so.
 */
export async function zoneNear(source, lat, lng) {
  const [index, cells] = await Promise.all([source.index(), source.near()]);
  const row = Math.min(179, Math.floor(lat) + 90), col = ((Math.floor(lng) + 180) % 360 + 360) % 360;
  for (let away = 0; away <= 3; away++) {
    let best = null, bestD = Infinity;
    for (let dr = -away; dr <= away; dr++) for (let dc = -away; dc <= away; dc++) {
      if (Math.max(Math.abs(dr), Math.abs(dc)) !== away) continue;
      const r = row + dr;
      if (r < 0 || r > 179) continue;
      const c = ((col + dc) % 360 + 360) % 360;
      const z = cells.get(r * 360 + c);
      if (z === undefined) continue;
      const d = Math.hypot(r + 0.5 - (lat + 90), (c + 0.5 - (lng + 180)) * Math.cos((lat * Math.PI) / 180));
      if (d < bestD) { bestD = d; best = z; }
    }
    if (best !== null && zoneKnown(index.zones[best])) return { zone: index.zones[best], away };
  }
  return null;
}

/** A file's lines as towns, largest first as the file has them. Keys are worked out once. */
function parseFile(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line || line[0] === "#") continue;
    const c = line.split("|");
    if (c.length < 7) continue;
    const people = parseInt(c[6], 36) * 100;
    const others = c[7] ? c[7].split(";") : [];
    out.push({
      name: c[0], cc: c[1], region: c[2], z: parseInt(c[3], 36),
      lat: parseInt(c[4], 36) / 100, lng: parseInt(c[5], 36) / 100, people, others,
      key: squash(c[0]), otherKeys: others.map(squash), wordKeys: people >= BIG_TOWN ? laterWords(c[0]) : [],
    });
  }
  return out;
}

/** The file that holds every town whose name starts with these letters; "" when the table has none. */
export function fileFor(index, q) {
  if (!q || !index.first.includes(q[0])) return "";
  let p = q[0];
  while (index.split[p] !== undefined && q.length > p.length) {
    const next = q[p.length];
    if (!index.split[p].includes(next)) return "";
    p += next;
  }
  return p;
}

/**
 * The spelling to show for a town found by what was typed: the one the person is typing where
 * that is one of the town's names, so nobody is corrected to a spelling they didn't use.
 * Word for word first ("machu picchu" is "Machu Picchu", not "Machupicchu"); then the town's
 * own name when it starts that way; then the other name that does.
 */
function shownName(t, typed, q) {
  const f = fold(typed);
  const all = [t.name, ...t.others];
  const same = all.find((n) => fold(n) === f);
  if (same) return same;
  const starts = all.find((n) => fold(n).startsWith(f));      // the town's own name first
  if (starts) return starts;
  if (t.key.startsWith(q)) return t.name;
  return t.others.find((_, i) => t.otherKeys[i].startsWith(q)) || t.name;
}

/** Typed with its marks ("Vík"), and one of the town's names is written exactly so. */
function writtenSo(t, typed) {
  const w = String(typed).normalize("NFC").trim().toLowerCase();
  if (w === fold(typed)) return false;                           // no marks typed: nothing to go by
  return [t.name, ...t.others].some((n) => n.normalize("NFC").toLowerCase() === w);
}

/** A country's zones as rows, the zone of its largest town first: a zone only, no position. */
function countryRows(index, cc, most) {
  const [name, zs] = index.countries[cc];
  const rows = [];
  for (const z of zs) {
    const zone = index.zones[z];
    if (!zoneKnown(zone)) continue;
    rows.push({ kind: "country", name, town: "", region: "", country: name, cc, zone, lat: null, lng: null, people: 0, zonesInCountry: zs.length });
    if (rows.length >= most) break;
  }
  return rows;
}

/**
 * Rows of kind "zone" for what was typed, from a plain list of zone ids: a zone called that,
 * or starting with it. With the table's index a row says its country too. This is all there
 * is to offer when the table can't be read.
 */
export function zoneRows(typed, zones, index = null) {
  const q = squash(typed);
  if (!q) return [];
  const exact = [], starts = [], inside = [];
  for (const zone of zones) {
    if (!zoneKnown(zone)) continue;
    const own = squash(zoneName(zone));
    const cc = index ? index.zoneCc.get(zone) || "" : "";
    const row = { kind: "zone", name: zoneName(zone), town: "", region: "", country: cc ? index.countries[cc][0] : "", cc, zone, lat: null, lng: null, people: 0 };
    if (own === q) exact.push(row);
    else if (own.startsWith(q)) starts.push(row);
    else if (fold(zoneName(zone)).split(" ").some((w) => w.startsWith(q))) inside.push(row);
  }
  return [...exact, ...starts, ...inside];
}

/**
 * What was typed, as rows to pick from, the best first:
 *   0. a town with a name written exactly as typed, marks and all ("Vík" is Iceland's);
 *   1. a large town called exactly that, by its own name or another of its names, the largest
 *      first ("paris" is France; "seville" is Spain's before Ohio's; "bombay" is Mumbai), and
 *      the town a country is named after ("singapore", "luxembourg": the city before the country);
 *   2. a country called exactly that, each of its zones ("japan"; "australia" lists several);
 *   3. a smaller town called exactly that ("paris" in Texas; "peru" in Indiana after Peru);
 *   4. a smaller town with another name that is exactly that ("thira");
 *   5. towns whose name starts with it, the largest first ("lis" finds Lisbon);
 *   6. countries whose name starts with it;
 *   7. towns with another name, or a later word, that starts with it ("york" finds New York);
 *   8. a zone called that with no town of its name found ("azores", "utc").
 * Nothing typed answers nothing. `limit` rows at most (8). `zones`: the zone ids this browser
 * knows, for 7 and for when the table can't be read; `reached` is false then.
 */
export async function findTowns(source, typed, { limit = 8, zones = [] } = {}) {
  const q = squash(typed);
  if (!q) return { rows: [], reached: true };
  let index = null, towns = [], reached = true;
  try { index = await source.index(); } catch { reached = false; }
  if (index) {
    const prefix = fileFor(index, q);
    if (prefix) { try { towns = await source.file(prefix); } catch { reached = false; } }
  }
  const tiers = [[], [], [], [], [], [], [], [], []];
  const had = new Set();              // one row for a place and zone, whichever way it was found
  const put = (tier, row) => {
    const k = `${row.kind}|${squash(row.town || row.name)}|${row.cc}|${row.region}|${row.zone}`;
    if (had.has(k) || tiers[tier].length >= limit) return;
    had.add(k);
    tiers[tier].push(row);
  };
  for (const t of towns) {
    let tier = -1;
    // "Large" also means the town its country is named after, whatever its size (Luxembourg, Monaco).
    if (t.key === q) tier = t.people >= BIG_TOWN || (index.countries[t.cc] && squash(index.countries[t.cc][0]) === q) ? 1 : 3;
    else if (t.otherKeys.includes(q)) tier = t.people >= BIG_TOWN ? 1 : 4;
    else if (t.key.startsWith(q)) tier = 5;
    else if (t.otherKeys.some((k) => k.startsWith(q)) || t.wordKeys.some((k) => k.startsWith(q))) tier = 7;
    if (tier < 0) continue;
    if (tier <= 4 && writtenSo(t, typed)) tier = 0;
    const zone = index.zones[t.z];
    if (!zone || !zoneKnown(zone)) continue;
    put(tier, { kind: "city", name: shownName(t, typed, q), town: t.name, region: t.region, country: (index.countries[t.cc] || [""])[0], cc: t.cc,
      zone, lat: t.lat, lng: t.lng, people: t.people });
  }
  if (index) {
    for (const c of index.countryKeys) {
      if (c.key === q) for (const row of countryRows(index, c.cc, 6)) put(2, row);
      else if (c.key.startsWith(q) || fold(c.name).split(" ").some((w) => w.startsWith(q) && q.length >= 3)) for (const row of countryRows(index, c.cc, 2)) put(6, row);
    }
  }
  // A town's row, by its own name and by the name it is shown by ("New York" for New York City):
  // the zone named after it says less than its row does.
  const cityNames = new Set(tiers.flat().filter((r) => r.kind === "city").flatMap((r) => [`${squash(r.town)}|${r.zone}`, `${squash(r.name)}|${r.zone}`]));
  for (const row of zoneRows(typed, zones.length ? zones : index ? index.zones : [], index)) {
    // Found as a town already (Tokyo is a town of the table and a zone's name): the town's row says more.
    if (cityNames.has(`${squash(row.name)}|${row.zone}`)) continue;
    put(8, row);
  }
  const rows = tiers.flat().slice(0, limit);
  // Two rows that would read the same are two towns, one of them shown by a name that was typed
  // ("Porto" for Portogruaro, beside the Porto of the same country): that one says its own name.
  const seen = new Map();
  for (const r of rows) seen.set(rowLabel(r), (seen.get(rowLabel(r)) || 0) + 1);
  for (const r of rows) if (r.kind === "city" && r.name !== r.town && seen.get(rowLabel(r)) > 1) r.name = r.town;
  return { rows, reached };
}

/** "Kyoto, Japan"; "Springfield, Illinois, United States"; a country alone for a country's row; "Singapore" once. */
export function rowLabel(row) {
  if (row.kind === "country") return row.name;
  const parts = [row.name];
  if (row.region && fold(row.region) !== fold(row.name)) parts.push(row.region);
  if (row.country && fold(row.country) !== fold(row.name)) parts.push(row.country);
  return parts.join(", ");
}

/** A row's time: "GMT+9". A country with several zones says which: "Sydney time, GMT+11". */
export function rowWhere(row, when) {
  if (/^(UTC|GMT)$/i.test(zoneName(row.zone))) return "UTC";
  if (row.kind === "country" && row.zonesInCountry > 1) return zoneWords(row.zone, when);
  return zoneOffset(row.zone, when);
}

/** A stored zone as a place: "Tokyo, Japan"; "Buenos Aires, Argentina"; "UTC". Without the index: the zone's own name. */
export function zonePlace(index, zone) {
  const name = zoneName(zone);
  if (!index) return name;
  const cc = index.zoneCc.get(zone);
  const country = cc ? index.countries[cc][0] : "";
  return country && fold(country) !== fold(name) ? `${name}, ${country}` : name;
}

// ── the area a town gets ────────────────────────────────────────────────────────────────
// The table gives a point and how many people, not a boundary. The box is a square around the
// point: 12 km to each side up to 100,000 people, growing with the logarithm of its people to
// 20 km at a million, and no further. The cap is the map's: the server cuts a trip's map to a
// depth that fits a phone, and measured against the real build a 40 km square of a dense city
// still reaches streets while a 56 km one drops a level. An airport further out than that is
// its own town: a person adds it as another area.
export const BOX_KM = { least: 12, most: 20 };
export function boxFor(row, halfKm = null) {
  const people = Math.max(1, Number(row.people) || 0);
  const half = halfKm ?? Math.min(BOX_KM.most, Math.max(BOX_KM.least, BOX_KM.least + 8 * Math.log10(people / 100000)));
  const lat = Number(row.lat), lng = Number(row.lng);
  const dLat = half / 110.574;
  const dLng = Math.min(170, half / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180))));
  const r4 = (v) => Math.round(v * 10000) / 10000;
  const wrap = (v) => (v > 180 ? v - 360 : v < -180 ? v + 360 : v);
  return {
    west: r4(wrap(lng - dLng)), south: r4(Math.max(-90, lat - dLat)),
    east: r4(wrap(lng + dLng)), north: r4(Math.min(90, lat + dLat)),
  };
}

/** How far across the box of a row is, in whole kilometers. */
export const acrossKm = (row) => Math.round(((boxFor(row).north - boxFor(row).south) * 110.574));

/**
 * The area a picked row gives a trip: { id, name, west, south, east, north }, or null for a
 * row with no position (a country, a zone) and for no row. `taken`: the ids the trip has.
 */
export function areaOf(row, taken = []) {
  if (!row || (row.kind !== "city" && row.kind !== "spot")) return null;
  const name = String(row.name).replace(/\s+/g, " ").trim().slice(0, 80);
  return { id: areaIdFor(name, taken), name, ...boxFor(row) };
}

/** What picking a row means, in a sentence under the field. */
export function placeWords(row) {
  if (row.kind === "city") return `The trip's map is made around ${row.name}, ${acrossKm(row)} km across. More can be added later.`;
  if (row.kind === "spot") return `The trip's map is made around that spot, ${acrossKm(row)} km across, and called ${row.name}.${row.viewOnly ? " The link only said where its map was looking, so the spot is a guess." : ""}`;
  return `${row.name} sets the time zone. Name a town or a city too and the trip's map is made around it.`;
}

/** How far across an area with bounds is, in whole kilometers (its height: the box is square on the ground). */
export const areaAcrossKm = (a) => Math.round((Number(a.north) - Number(a.south)) * 110.574);

const listOf = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
/**
 * What adding the area called `name` does to the trip's map, from the server's answer to
 * POST …/tiles/plan ({ regions: [{ id|null, name, now, would }], … }; docs/API.md): the whole
 * trip's map has to fit a phone, so one more town can cost the others street detail, or leave
 * a region off. Sentences for the person to read BEFORE it is added; "" when nothing is lost
 * (or the answer can't be read). Depths are never shown: 14 and deeper is every street.
 */
export function planWords(plan, name) {
  if (!plan || !Array.isArray(plan.regions)) return "";
  const STREETS = 14;
  const out = [];
  const mine = plan.regions.find((r) => r.id == null);
  const were = plan.regions.filter((r) => r.id != null && r.now != null);
  const lower = were.filter((r) => r.would != null && r.would < r.now);
  const off = were.filter((r) => r.would == null && !r.removed);      // removed: left out of the question on purpose, not to make room
  if (lower.length) {
    const most = Math.max(...lower.map((r) => r.now - r.would));
    const levels = most === 1 ? "a level" : lower.every((r) => r.now - r.would === most) ? `${most} levels` : `up to ${most} levels`;
    out.push(`The whole trip's map has to fit on a phone: with ${name} added, ${listOf(lower.map((r) => r.name))} ${lower.length === 1 ? "loses" : "lose"} ${levels} of street detail.`);
  }
  if (off.length) out.push(`${listOf(off.map((r) => r.name))} would be left off the map to make room.`);
  if (mine && mine.would == null) out.push(`${name} is too large to fit beside the rest, so it would be on the trip without a map of its own.`);
  else if (mine && mine.would < STREETS) out.push(`${name}'s own map would show less than every street.`);
  return out.join(" ");
}

/** An id for a town's area: its name in the letters an id takes ("sao-paulo"), numbered when `taken` has it. */
export function areaIdFor(name, taken = []) {
  const base = fold(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "area";
  const has = new Set(taken);
  if (!has.has(base)) return base;
  for (let n = 2; ; n++) if (!has.has(`${base}-${n}`)) return `${base}-${n}`;
}
