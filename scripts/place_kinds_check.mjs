#!/usr/bin/env node
/* Place kinds and subkinds: the one list, its reader and speller, and the glyph each subkind draws.
 *
 *   node scripts/place_kinds_check.mjs
 *
 * No browser and no server: public/js/shared/place-kinds.js is pure, and this imports it the
 * way the Worker does. public/js/icons.js is imported too (it only builds strings).
 *
 * What it holds to:
 *   - the list is well formed: unique ids, a home kind, a label and a line for each;
 *   - the strict reader takes the exact ids under ANY of the seven kinds and refuses
 *     everything else with the list in the refusal; a spelling slip is told its spelling, and
 *     any other word gets the list and no guess (spelledSubkind never maps one word to another);
 *   - every subkind draws a glyph that exists; no two subkinds draw the same one; the
 *     subkinds still waiting for a drawing are exactly the ones named here;
 *   - a stored row with a word not on the list draws its kind's glyph, and nothing throws.
 */
import {
  KIND_COVERS, PLACE_KINDS, SUBKINDS, SUBKIND_LIST,
  readPlaceKind, spelledSubkind, subkind, subkindLabel, subkindsOf,
} from "../public/js/shared/place-kinds.js";
import { CALLER_WORDS, CATEGORIES, ICON_IDS, TIER_OF, UNDRAWN_SUBKINDS, categoryOf, getIcon, getIconId } from "../public/js/icons.js";

// Subkinds on the list whose glyph is not drawn yet; they would show their home kind's glyph.
// Empty since every subkind got its own drawing, and it stays empty: a subkind added to the
// list arrives with its drawing, or this check says which one didn't.
const WAITING_FOR_A_GLYPH = [];

let pass = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) pass++;
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 400) : ""}`); }
}
const section = (s) => console.log(`\n${s}`);

section("the list");
check("there are seven kinds, and the app's seven are the same seven",
  PLACE_KINDS.length === 7 && [...PLACE_KINDS].sort().join() === [...CATEGORIES].sort().join(), PLACE_KINDS.join(" "));
check("every kind has a line saying what it is for", PLACE_KINDS.every((k) => typeof KIND_COVERS[k] === "string" && KIND_COVERS[k].length > 5));
check("no subkind id is listed twice", new Set(SUBKINDS.map((s) => s.id)).size === SUBKINDS.length);
for (const s of SUBKINDS) {
  check(`${s.id}: a lowercase id, a home kind, a label and a line`,
    /^[a-z]+(_[a-z]+)*$/.test(s.id) && PLACE_KINDS.includes(s.kind) && s.label.length > 1 && s.covers.length > 3
    && subkind(s.id) === s, JSON.stringify(s));
}
check("the word a person reads is the list's label, for every subkind", SUBKINDS.every((s) => subkindLabel(s.id) === s.label));
check("a word from before the list reads as it was written, with a capital; no word reads as nothing",
  subkindLabel("tour_office") === "Tour office" && subkindLabel("fine_dining") === "Fine dining" && subkindLabel("") === "" && subkindLabel(undefined) === ""
  && subkindLabel("toString") === "ToString" && subkindLabel("constructor") === "Constructor",
  [subkindLabel("tour_office"), subkindLabel("fine_dining"), subkindLabel("toString")].join(" | "));
check("every kind is home to at least three subkinds", PLACE_KINDS.every((k) => subkindsOf(k).length >= 3),
  PLACE_KINDS.map((k) => `${k} ${subkindsOf(k).length}`).join(", "));
check("the list as text is one line per kind, in the kinds' order, naming every subkind once",
  SUBKIND_LIST.split("\n").length === 7
  && SUBKIND_LIST.split("\n").every((line, i) => line.startsWith(PLACE_KINDS[i] + ": "))
  && SUBKIND_LIST.split("\n").flatMap((l) => l.split(": ")[1].split(", ")).join() === SUBKINDS.map((s) => s.id).join());
check("the list cannot be changed by whoever imports it", Object.isFrozen(SUBKINDS) && Object.isFrozen(SUBKINDS[0]));

section("the strict reader");
let pairs = 0, pairsOk = 0;
for (const k of PLACE_KINDS) for (const s of SUBKINDS) {
  pairs++;
  const r = readPlaceKind(k, s.id);
  if (r.ok && r.kind === k && r.subkind === s.id) pairsOk++;
}
check(`every subkind is accepted under every kind (${pairs} pairs)`, pairsOk === pairs, `${pairsOk} of ${pairs}`);
for (const [k, s, why] of [
  ["food", "tapas_bar", "not on the list"], ["food", "Restaurant", "a capital"], ["food", "ice cream", "a space"],
  ["food", "ice-cream", "a hyphen"], ["food", " cafe", "a leading space"], ["food", "", "empty"],
  ["food", null, "null"], ["food", undefined, "nothing"], ["food", 7, "a number"], ["food", ["cafe"], "an array"],
  ["sight", "toString", "an object's own method name"], ["sight", "constructor", "another"],
]) {
  const r = readPlaceKind(k, s);
  check(`refused, ${why}: ${JSON.stringify(s)}`, !r.ok && r.error.includes(SUBKIND_LIST) && /tags/.test(r.error), JSON.stringify(r));
}
for (const [k, why] of [["eat", "not a kind"], ["Food", "a capital"], ["", "empty"], [null, "null"], ["cafe", "a subkind"], ["__proto__", "an object's own key"]]) {
  const r = readPlaceKind(k, "cafe");
  check(`refused, the kind is ${why}: ${JSON.stringify(k)}`, !r.ok && PLACE_KINDS.every((x) => r.error.includes(x)), JSON.stringify(r));
}
for (const [written, right] of [["cafe ", "cafe"], [" cafe", "cafe"], ["Cafe", "cafe"], ["ice cream", "ice_cream"], ["Ice-Cream", "ice_cream"]]) {
  const e = readPlaceKind("food", written).error || "";
  check(`a spelling-only mistake is shown as written and told its spelling: ${JSON.stringify(written)}`,
    e.startsWith(`${JSON.stringify(written)} is not on the list of subkinds. Write it as "${right}".`) && !/ now/.test(e.split("\n")[0]), e.split("\n")[0]);
}
for (const w of ["pass", "village", "fine_dining", "tapas_bar"]) {
  const e = readPlaceKind("sight", w).error || "";
  check(`a word not on the list is refused with the list and no guess at what it means: ${w}`,
    e.startsWith(`"${w}" is not on the list of subkinds. Pick the closest one.`) && e.includes(SUBKIND_LIST) && !/ now\b/.test(e.split("\n")[0]), e.split("\n")[0]);
}
check("the speller only respells: the list's id in another case or with spaces or hyphens, never another word",
  spelledSubkind("Ice-Cream") === "ice_cream" && spelledSubkind(" CAFE ") === "cafe" && spelledSubkind("pass") === null
  && spelledSubkind("toString") === null && spelledSubkind("") === null && spelledSubkind(undefined) === null);
check("a kind with only its spelling wrong is told its spelling; every refusal of a kind says what each kind is for",
  readPlaceKind("Food ", "cafe").error.startsWith('"Food " is not a kind of place. Write it as "food".')
  && !/Write it as/.test(readPlaceKind("eat", "cafe").error)
  && PLACE_KINDS.every((k) => readPlaceKind("eat", "cafe").error.includes(`${k} (${KIND_COVERS[k]})`)));
section("the glyphs");
const idOf = (s) => getIconId(s.kind, s.id);
check("every subkind draws a glyph that exists", SUBKINDS.every((s) => ICON_IDS.includes(idOf(s))),
  SUBKINDS.filter((s) => !ICON_IDS.includes(idOf(s))).map((s) => s.id).join(" "));
const drawn = SUBKINDS.filter((s) => !UNDRAWN_SUBKINDS.includes(s.id));
const byGlyph = new Map();
for (const s of drawn) byGlyph.set(idOf(s), [...(byGlyph.get(idOf(s)) || []), s.id]);
const shared = [...byGlyph].filter(([, ids]) => ids.length > 1);
check("no two subkinds draw the same glyph", shared.length === 0, shared.map(([g, ids]) => `${g}: ${ids.join(", ")}`).join("; "));
check("a subkind's glyph is the same under every kind",
  drawn.every((s) => PLACE_KINDS.every((k) => getIconId(k, s.id) === idOf(s))));
check("the subkinds waiting for a drawing are exactly the ones this check names",
  [...UNDRAWN_SUBKINDS].sort().join() === [...WAITING_FOR_A_GLYPH].sort().join(),
  `in the app: ${UNDRAWN_SUBKINDS.join(" ")}`);
const KIND_GLYPH = Object.fromEntries(PLACE_KINDS.map((k) => [k, getIconId(k, "")]));
{
  // Every phone loads the table. A drawing stays in it only while something can ask for it:
  // a subkind, a kind with no subkind, a word another screen uses, or the last-resort pin.
  const reached = new Set(["pin", ...Object.values(KIND_GLYPH)]);
  for (const s of SUBKINDS) reached.add(idOf(s));
  for (const w of CALLER_WORDS) reached.add(getIconId("practical", w));
  const dead = ICON_IDS.filter((id) => !reached.has(id));
  check("no drawing sits in the table that nothing can reach", dead.length === 0, dead.join(" "));
}
check("a subkind with no drawing yet shows its home kind's glyph, whatever kind the place is filed under",
  UNDRAWN_SUBKINDS.every((id) => PLACE_KINDS.every((k) => getIconId(k, id) === KIND_GLYPH[subkind(id).kind])));
check("a word nothing knows draws the place's own kind", PLACE_KINDS.every((k) => getIconId(k, "zzz") === KIND_GLYPH[k]));
{
  // A stored row from before the list (planted: none is left in any database): its kind's glyph, and nothing throws.
  let threw = null, wrong = [];
  for (const k of PLACE_KINDS) for (const w of ["pass", "village", "fine_dining", "Tapas Bar", "constructor"]) {
    try { if (getIconId(k, w) !== KIND_GLYPH[k] && getIconId(k, w) !== getIconId(k, w.split(/[_\s]/)[0])) wrong.push(`${k}/${w}`); getIcon(k, w); }
    catch (e) { threw = `${k}/${w}: ${e.message}`; }
  }
  check("a stored row with a word not on the list draws its kind's glyph (or its head word's), and never throws",
    !threw && wrong.length === 0, threw ?? wrong.join(" "));
}
check("a kind that is a built-in word is no kind: it draws as practical, like any unknown kind",
  ["constructor", "toString", "__proto__", "hasOwnProperty"].every((k) => categoryOf(k) === "practical" && getIconId(k, "") === KIND_GLYPH.practical));
check("the words other screens ask for still draw their own marks",
  getIconId("transit", "flight") === "plane" && getIconId("transit", "transfer") === "car"
  && getIconId("activity", "trek") === "hiker" && getIconId("practical", "sim_card") === "sim"
  && getIconId("lodging", "apartment") === "house" && getIconId("lodging", "airbnb") === "house"
  && getIconId("food", "meal") === "cutlery" && getIconId("activity", "walk") === "hiker");
check("getIcon writes an svg naming the glyph it drew",
  /^<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" data-icon="cup">.+<\/svg>$/.test(getIcon("food", "cafe")));
check("every subkind has an urgency tier from 1 to 6", SUBKINDS.every((s) => TIER_OF[s.id] >= 1 && TIER_OF[s.id] <= 6)
  && TIER_OF.pharmacy === 1 && TIER_OF.hospital === 1 && TIER_OF.hotel === 3);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(failures.length ? 1 : 0);
