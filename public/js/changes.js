// The trip's list of changes made through connected apps, and their undo (#/changes, reached
// from Other, Sections, "Changes").
//
// An app a person connects (Claude, say) works on their trips as them, and every write it makes
// is one CHANGE the server records whole (src/trips/changes.js): who asked, which app, when, the
// one line the app wrote about it, and each row it touched. This screen is where people see
// them and put one back:
//
//   * newest first, the last 30 days (the server's CHANGE_DAYS), fifty at a time;
//   * each line says what it touched in words ("3 places added, 1 plan changed"); a row that
//     is someone else's own (their packing) only as a count, as the server gives it;
//   * Undo puts the change's rows back. When that is more than one thing it first says what it
//     will do. Afterwards it says what went back and what was left alone, and why, in the
//     server's reasons made readable. The undo is a line of its own, and can be undone;
//   * where the person can't put something back the line says who can, by the rule undo holds
//     it to (the server sends it with each row: `may_not`);
//   * making a trip has no undo, and says so;
//   * with no signal: the list as the phone last had it (kept in the trip's database), and Undo
//     says it needs signal. Nothing is queued: an undo is decided on what the trip is NOW.
//   * live: the trip's socket says the data moved, and an open list reads itself again.
//
// What is marked new (since this person last looked) is kept by changes-seen.js, which the
// mark on Other (changes-dot.js) reads.
//
// Owner prefix .chg-*; the styles are injected once (split.js's pattern: they ship inside the
// module, so precaching it precaches them).

import { esc, fmtAgo, dayKey, fmtDay, toMs } from "./util.js";
import { live } from "./live.js";
import { fetchWithin } from "./net.js";
import { markChangesSeen, changesSeenOf } from "./changes-seen.js";
import { faceHtml, personTone, personVars } from "../ds/avatar.js";
import { pictureNow, wakePictures } from "./pictures.js";

function memberFaceSig(store) {
  const me = store.me();
  const myColor = typeof store.myNoteColor === "function" ? store.myNoteColor() : "";
  const ms = (store.members() || [])
    .filter((m) => m && m.id)
    .map((m) => [m.id, m.name || "", m.initials || "", m.note_color || "", m.avatar || ""].join("|"))
    .sort();
  const mePart = me
    ? [me.id || "", me.name || "", me.initials || "", myColor || me.note_color || "", me.avatar || ""].join("|")
    : "";
  return `${mePart}::${ms.join(";")}`;
}

const CHG_CSS = `
/* The floating Back, and with no signal the Offline pill above it, sit over the screen's foot:
   the list ends above both. */
.chg {
  padding-bottom: calc(var(--back-h, 44px) * 2 + 56px);
  color: var(--ink-1);
}
@media (min-width: 720px) {
  .chg { max-width: 720px; margin-left: auto; margin-right: auto; width: 100%; }
}
.chg-tophead { margin: 0 0 8px; }
.chg-h1 {
  font-family: var(--type-head);
  font-weight: 500;
  font-size: var(--size-28);
  line-height: 1.1;
  letter-spacing: var(--track-head);
  color: var(--ink-1);
  margin: 0;
}
.chg-intro {
  font-size: var(--size-16);
  line-height: 22px;
  color: var(--ink-2);
  margin: 0 0 18px;
}
.chg-net {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin: 0 0 16px;
  padding: 12px 14px;
  border-radius: var(--radius-16);
  background: var(--warning-bg);
  border: 1px solid var(--warning-edge);
  color: var(--ink-1);
  font-size: var(--size-14);
  line-height: 20px;
}
.chg-net svg {
  flex: none;
  width: 18px;
  height: 18px;
  stroke: var(--warning);
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  margin-top: 1px;
}
.chg-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.chg-day {
  font-size: var(--size-14);
  line-height: 20px;
  font-weight: 400;
  color: var(--ink-2);
  padding: 14px 0 6px;
  border-top: 1px solid var(--hair);
}
.chg-day:first-child { border-top: 0; padding-top: 4px; }
.chg-line {
  padding: 12px 0;
  border-top: 1px solid var(--hair);
}
.chg-line:first-child,
.chg-day + .chg-line { border-top: 0; }
.chg-main {
  display: grid;
  grid-template-columns: var(--control-32) minmax(0, 1fr) auto;
  column-gap: 12px;
  row-gap: 6px;
  align-items: start;
}
.chg-ico.ds-face { flex: none; }
.chg-ico.ds-face:not([data-person]) {
  background: var(--gray-3);
  color: var(--ink-2);
}
.chg-ico > svg {
  width: 16px;
  height: 16px;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.chg-top {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.chg-top:has(+ .chg-acts[data-note]) { grid-column: 2 / -1; }
.chg-top:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 3px;
  border-radius: var(--radius-8);
}
/* Keeps the wrapped separator hidden cleanly when the timestamp drops onto line 2 (checks/changes/screen.mjs). */
.chg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: var(--size-14);
  color: var(--ink-2);
  line-height: 20px;
  margin-top: 2px;
  margin-left: -14px;
  clip-path: inset(-6px -6px -6px 14px);
}
.chg-head > :first-child { margin-left: 14px; }
.chg-dot { display: inline-block; width: 6px; margin-right: 8px; text-align: center; }
.chg-app { font-weight: 500; color: var(--ink-2); }
.chg-when {
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  font-family: var(--type-mono);
  font-size: var(--size-12);
  font-variant-numeric: tabular-nums;
}
.chg-new {
  padding: 2px 8px;
  border-radius: var(--radius-8);
  background: var(--gray-2);
  border: 1px solid var(--edge);
  color: var(--ink-1);
  font-size: var(--size-12);
  font-weight: 600;
  line-height: 16px;
}
.chg-sum {
  display: block;
  margin: 0 0 2px;
  font-size: var(--size-16);
  font-weight: 600;
  line-height: 22px;
  color: var(--ink-1);
  overflow-wrap: anywhere;
}
.chg-line[data-undone] .chg-sum {
  color: var(--ink-2);
  text-decoration: line-through;
  text-decoration-color: var(--ink-3);
}
.chg-touch {
  margin: 2px 0 0;
  font-size: var(--size-14);
  color: var(--ink-2);
  line-height: 20px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.chg-touch .chg-chev {
  flex: none;
  width: 15px;
  height: 15px;
  stroke: var(--ink-2);
  fill: none;
  stroke-width: 1.8;
  stroke-linecap: round;
  transition: transform var(--dur-200) var(--ease-standard);
}
.chg-line[data-open] .chg-chev { transform: rotate(90deg); }
.chg-acts {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.chg-acts[data-note] { grid-column: 2 / -1; }
.chg-state { font-size: var(--size-14); color: var(--ink-2); line-height: 20px; }
.chg-state b { color: var(--ink-1); font-weight: 600; }

.chg-detail,
.chg-confirm,
.chg-result { margin-left: 44px; }
@media (max-width: 359px) {
  .chg-detail,
  .chg-confirm,
  .chg-result { margin-left: 0; }
}
.chg-detail { padding: 8px 0 2px; }
.chg-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--hair);
}
.chg-row {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 8px 0;
  border-bottom: 1px solid var(--hair);
  font-size: var(--size-14);
  line-height: 20px;
}
.chg-row:last-child { border-bottom: 0; }
.chg-op {
  flex: none;
  width: 72px;
  font-size: var(--size-12);
  font-weight: 600;
  color: var(--ink-2);
}
.chg-op::before {
  content: "";
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  vertical-align: 1px;
  border: 1.5px solid currentColor;
}
.chg-op[data-op="added"] { color: var(--positive); }
.chg-op[data-op="removed"] { color: var(--negative); }
.chg-op[data-op="changed"] { color: var(--info); }
.chg-op[data-op="added"]::before { border-radius: var(--radius-full); background: currentColor; }
.chg-op[data-op="removed"]::before { border-radius: var(--radius-full); }
.chg-op[data-op="changed"]::before { transform: rotate(45deg); border-radius: 1px; }
.chg-what { min-width: 0; overflow-wrap: anywhere; color: var(--ink-1); }
.chg-what small { display: block; color: var(--ink-2); font-size: var(--size-14); }

.chg-confirm,
.chg-result {
  margin-top: 10px;
  padding: 12px 14px;
  border-radius: var(--radius-16);
  font-size: var(--size-14);
  line-height: 20px;
}
.chg-confirm {
  background: var(--well);
  border: 1px solid var(--edge);
  color: var(--ink-1);
}
.chg-confirm p,
.chg-result p { margin: 0 0 6px; }
.chg-confirm ul,
.chg-result ul { margin: 0 0 8px; padding-left: 20px; list-style: disc; }
.chg-confirm li,
.chg-result li { margin: 2px 0; }
.chg-confirm .chg-acts { padding: 4px 0 0; }
.chg-result {
  background: var(--positive-bg);
  border: 1px solid var(--positive-edge);
  color: var(--ink-1);
}
.chg-result[data-left] {
  background: var(--warning-bg);
  border-color: var(--warning-edge);
}
.chg-result h3 {
  margin: 0 0 4px;
  font-size: var(--size-14);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}
.chg-result h3 svg {
  width: 16px;
  height: 16px;
  stroke: currentColor;
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.chg-empty {
  text-align: center;
  padding: 40px 16px;
  color: var(--ink-2);
}
.chg-empty svg {
  width: 32px;
  height: 32px;
  stroke: var(--ink-2);
  fill: none;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  margin-bottom: 10px;
}
.chg-empty h2 {
  font-family: var(--type-head);
  font-weight: 500;
  font-size: var(--size-20);
  line-height: 26px;
  letter-spacing: var(--track-head);
  color: var(--ink-1);
  margin: 0 0 6px;
}
.chg-empty p {
  margin: 0 auto;
  max-width: 32ch;
  font-size: var(--size-14);
  line-height: 20px;
}
.chg-more { margin: 16px auto 0; display: inline-flex; }
.chg-skel { height: 72px; border-radius: var(--radius-16); background: var(--well); }

/* DS buttons inside Changes */
.chg.ds .btn.ds-button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: var(--control-32);
  padding: 0 12px;
  border-radius: var(--radius-12);
  font-family: var(--type-ui);
  font-size: var(--size-14);
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
}
.chg.ds .btn.ds-button::before { content: ""; position: absolute; inset: -6px 0; }
.chg.ds .btn.ds-button--gray {
  background: var(--fill);
  color: var(--ink-1);
  border: 1px solid var(--edge);
}
.chg.ds .btn.ds-button--white {
  background: var(--solid);
  color: var(--on-solid);
  border: 1px solid transparent;
}
@media (hover: hover) and (pointer: fine) {
  .chg.ds .btn.ds-button--gray:hover { background: var(--fill-hover); border-color: var(--edge-strong); }
  .chg.ds .btn.ds-button--white:hover { background: var(--solid-hover); }
}
.chg.ds .btn.ds-button:disabled { opacity: 0.55; cursor: not-allowed; }
`;

function styles() {
  if (document.querySelector("style[data-chg]")) return;
  const s = document.createElement("style");
  s.dataset.chg = "1";
  s.textContent = CHG_CSS;
  document.head.append(s);
}

const ICON = {
  app: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M17.5 6.5 15 9M9 15l-2.5 2.5"/>',
  person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  tick: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  part: '<path d="M12 8v5M12 16.5v.1"/><circle cx="12" cy="12" r="9"/>',
  signal: '<path d="M2 8.8a15 15 0 0 1 20 0"/><path d="M5.5 12.3a10 10 0 0 1 13 0"/><path d="M9 15.8a5 5 0 0 1 6 0"/><path d="M12 19.3h.01"/><path d="M3 3l18 18"/>',
  list: '<rect x="4" y="3.5" width="16" height="17" rx="2.5"/><path d="M8 8.5h8M8 12h8M8 15.5h5"/>',
};
const ico = (k, cls = "") => `<svg ${cls ? `class="${cls}" ` : ""}viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;

// ── words ───────────────────────────────────────────────────────────────────────────────────

/** Each table as a person names what is in it: [one, many]. */
const NOUN = {
  trips: ["the trip's details", "the trip's details"],
  areas: ["area", "areas"],
  places: ["place", "places"],
  events: ["plan", "plans"],
  event_notes: ["note", "notes"],
  packing_lists: ["packing list", "packing lists"],
  packing_bags: ["bag", "bags"],
  packing_starters: ["starter item", "starter items"],
  packing_items: ["packing item", "packing items"],
  packing_placements: ["item in a bag", "items in bags"],
  packing_ticks: ["tick", "ticks"],
  purchases: ["purchase", "purchases"],
  payments: ["payment", "payments"],
  purchase_shares: ["share of a purchase", "shares of purchases"],
  pictures: ["picture", "pictures"],
};
const nounOf = (r) => NOUN[r.payment ? "payments" : r.table] ?? ["thing", "things"];
const count = (n, [one, many]) => (one === many ? one : `${n} ${n === 1 ? one : many}`);
const PAST = { added: "added", changed: "changed", removed: "removed" };
// What undo does to a row the change added, changed or removed: the act is always "undo"; what it
// does is said in the trip's own verbs, before ("Take away 2 plans") and after ("Took away 2 plans").
const BACK = { added: "take away", changed: "change back", removed: "bring back" };
const quote = (s) => `“${s}”`;
const cap = (s) => String(s).replace(/^./, (c) => c.toUpperCase());

/** A list of words joined as a sentence: "a, b and c". */
function and(list) {
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/**
 * The rows a person reads: the parts of a thing already counted with it go (a purchase's shares
 * when the purchase is there, an item's bags and ticks when the item is).
 */
function readable(rows) {
  const purchases = new Set(rows.filter((r) => r.table === "purchases").map((r) => r.key[0]));
  const items = new Set(rows.filter((r) => r.table === "packing_items").map((r) => r.key[0]));
  return rows.filter((r) => !(r.table === "purchase_shares" && purchases.has(r.key[0]))
    && !((r.table === "packing_placements" || r.table === "packing_ticks") && items.has(r.key[0])));
}

/** A row's name, with what the phone knows: a picture by what it is on. */
function nameOf(r, store) {
  if (r.table === "pictures") {
    const [, kind, id] = r.key;
    if (kind === "cover") return "the trip's cover picture";
    const thing = kind === "place" ? store.places().find((p) => p.id === id)
      : kind === "event" ? store.events().find((e) => e.id === id)
      : kind === "purchase" ? store.purchase(id) : null;
    const what = thing ? (thing.name || thing.title || thing.description) : null;
    const of = kind === "purchase" ? "the receipt" : "the picture";
    return what ? `${of} of ${quote(what)}` : kind === "purchase" ? "a receipt" : `a ${kind === "event" ? "plan" : kind}'s picture`;
  }
  if (r.table === "trips") return "the trip's name, dates or currencies";
  if (r.label && !["packing_placements", "packing_ticks", "purchase_shares"].includes(r.table)) return quote(r.label);
  return null;
}

/** "3 places added, 1 plan changed", in the order the change touched them. */
function touchedWords(line) {
  const groups = new Map();
  for (const r of readable(line.rows)) {
    const noun = nounOf(r);
    const k = `${noun[0]}\n${r.op}`;
    const g = groups.get(k) ?? groups.set(k, { noun, op: r.op, n: 0 }).get(k);
    g.n += 1;
  }
  const out = [...groups.values()].map((g) => `${count(g.n, g.noun)} ${PAST[g.op]}`);
  if (line.private_rows_of_others) out.push(`${line.private_rows_of_others} of someone's own packing`);
  if (!out.length) return line.kind === "create" ? "Made the trip" : "Nothing left to show";
  return out.join(", ").replace(/^./, (c) => c.toUpperCase());
}

/** Names for people ids, from the roster; "someone" for one who isn't on it. */
function peopleWords(ids, store, me) {
  const roster = new Map(store.members().map((m) => [m.id, m.name]));
  const names = ids.map((id) => (id === me ? "you" : roster.get(id) || "someone who left the trip"));
  return [...new Set(names)];
}

/** What undoing would do to a row, as a person reads it: "take away the purchase “Taxi”". */
function wouldDo(r, store) {
  const name = nameOf(r, store);
  const noun = nounOf(r)[0];
  const thing = !name ? `a ${noun}` : r.table === "trips" || r.table === "pictures" ? name : `the ${noun} ${name}`;
  return r.op === "changed" ? `change ${thing} back` : `${BACK[r.op]} ${thing}`;
}

/** Why this person can't undo a row, in words: who can, and what it would do. */
function mayNotWords(r, store, me) {
  const why = r.may_not?.why || "";
  const who = peopleWords(r.may_not?.who ?? [], store, me).filter((n) => n !== "you");
  const name = nameOf(r, store) || `the ${nounOf(r)[0]}`;
  if (/purchase is changed by|receipt is changed by/.test(why)) {
    return `Only ${who.length ? and(who).replace(/ and /, " or ") : "who logged it or who paid"} can undo this: it would ${wouldDo(r, store)}.`;
  }
  if (/someone's own packing/.test(why)) return `${cap(name)} is on someone's own packing list: only they can undo that.`;
  if (/picture's file is gone/.test(why)) return `The file of ${name} is gone, so it can't come back.`;
  return `${cap(name)} can't be undone: ${why}.`;
}

/** What an undo did, in the trip's verbs: "Took away 1 place", "Brought back 2 plans", "Changed “Dinner” back". */
function didWords(rows, store) {
  const groups = new Map();
  for (const r of rows) {
    const noun = nounOf(r);
    const k = `${r.op}\n${noun[0]}`;
    const g = groups.get(k) ?? groups.set(k, { op: r.op, noun, names: [] }).get(k);
    g.names.push(nameOf(r, store));
  }
  return [...groups.values()].map((g) => {
    if (g.op === "changed") return g.names.length === 1 && g.names[0] ? `Changed ${g.names[0]} back` : `Changed ${count(g.names.length, g.noun)} back`;
    return `${g.op === "added" ? "Took away" : "Brought back"} ${count(g.names.length, g.noun)}`;
  });
}

/** The server's reason a row was left alone, made readable. `line`: the change, for its rows' names. */
function leftWords(left, line, store, me) {
  const out = [];
  const others = left.filter((l) => /^private to someone else/.test(l.why)).length;
  for (const l of left) {
    if (/^private to someone else/.test(l.why)) continue;
    const row = line.rows.find((r) => r.table === l.table && JSON.stringify(r.key) === JSON.stringify(l.key))
      ?? { table: l.table, key: l.key ?? [], label: l.label, op: "changed" };
    const name = nameOf(row, store) || (l.label ? quote(l.label) : `a ${nounOf(row)[0]}`);
    const Name = name.replace(/^./, (c) => c.toUpperCase());
    if (l.why === "written since") out.push(`${Name} was changed since, so it was left as it is.`);
    else if (/purchase is changed by|receipt is changed by|someone's own packing|picture's file is gone/.test(l.why)) {
      out.push(`${mayNotWords({ ...row, may_not: row.may_not ?? { why: l.why, who: [] } }, store, me)} It was left as it is.`);
    }
    else if (/points at it now/.test(l.why)) {
      // Undo would take away what the change added, and something uses it now (a plan at that
      // place); or bring back what it removed, and what that was on is gone.
      out.push(row.op === "added" ? `${Name} stays: something on the trip uses it now (a plan at that place, say).`
        : row.op === "removed" ? `${Name} couldn't come back: what it was part of is gone.`
        : `${Name} was left as it is: something on the trip depends on it as it is now.`);
    }
    else out.push(`${Name} was left as it is: ${l.why}.`);
  }
  if (others) out.push(`${others === 1 ? "One row" : `${others} rows`} of someone's own packing ${others === 1 ? "was" : "were"} left: only they can undo that.`);
  return out;
}

/**
 * A line's summary as a person reads it. The server writes an undo as "Undid: <what it undid>", so
 * an undo of an undo would say "Undid: Undid: …": an even number of undos is the change brought
 * back, an odd number is it undone.
 */
function shownSummary(line) {
  let s = String(line.summary || "");
  let n = 0;
  while (s.startsWith("Undid: ")) { s = s.slice(7); n += 1; }
  if (!s) return "No summary";
  return n === 0 ? s : n % 2 ? `Undid: ${s}` : `Brought back: ${s}`;
}

/** Who and where a line came from. */
function originOf(line, store, me) {
  const who = line.by?.id === me ? "you" : (line.by?.name || "someone who left the trip");
  if (line.source === "app") return { icon: "person", app: line.by?.id === me ? "You" : (line.by?.name || "Someone"), for: "in the app" };
  if (line.source === "rollback") return { icon: "app", app: "Undone by itself", for: `an app's request for ${who} was refused partway` };
  // The trip's assistant (model §20), acting as the person who asked it.
  if (line.source === "assistant") return { icon: "app", app: "The assistant", for: `asked by ${who}` };
  const app = String(line.source || "").replace(/^oauth:/, "") || "A connected app";
  return { icon: "app", app, for: `for ${who}` };
}

// ── the screen ──────────────────────────────────────────────────────────────────────────────

export default async function mount(el, ctx) {
  const { store } = ctx;
  styles();
  const me = store.me().id;
  const trip = store.tripId();
  const ASIDE = "changes";
  const state = {
    lines: null,          // as last read (or as kept), newest first
    more: false,          // the server may have older
    from: "none",         // "server" | "kept" | "none"
    open: new Set(),      // lines opened
    confirm: null,        // the line whose undo is asking first
    busy: null,           // the line whose undo is out
    results: new Map(),   // line id → { undone, left, error }
    seenBefore: changesSeenOf(trip, me),
  };
  let alive = true;

  el.innerHTML = `
    <div class="chg ds">
      <div class="chg-tophead ds-head"><h1 class="chg-h1">Changes</h1></div>
      <p class="chg-intro">What apps connected to this trip, like Claude, changed in the last 30 days. Anyone on the trip can undo a change. Edits made by hand in the app aren't listed.</p>
      <div class="chg-net" id="chg-net" hidden role="status"></div>
      <div id="chg-body" aria-live="polite">
        <div class="stack"><div class="skeleton chg-skel"></div><div class="skeleton chg-skel"></div><div class="skeleton chg-skel"></div></div>
      </div>
    </div>`;
  const body = el.querySelector("#chg-body");
  const net = el.querySelector("#chg-net");

  const byId = (id) => state.lines?.find((l) => l.id === id) ?? null;

  function paintNet() {
    const off = !store.online();
    net.hidden = !off && state.from !== "kept";
    if (net.hidden) return;
    net.innerHTML = `${ico("signal")}<span>${off
      ? "No signal. This is the list as this phone last had it, and putting something back waits until you're connected."
      : "Couldn't reach the trip just now. This is the list as this phone last had it."}</span>`;
  }

  function actsButton(line) {
    return line.kind !== "create" && !line.undone_by && line.rows.some((r) => !r.may_not);
  }

  function iconHtmlFor(line) {
    const o = originOf(line, store, me);
    const actor = line.by?.id ? (store.members() || []).find((m) => m && m.id === line.by.id) : null;
    const my = store.me();
    const isMe = !!(actor && actor.id === me);
    const name = (isMe && my?.name) || actor?.name;
    const initials = (isMe && my?.initials) || actor?.initials;
    const avatar = isMe && my && "avatar" in my ? my.avatar : actor?.avatar;
    const color = isMe && typeof store.myNoteColor === "function"
      ? (store.myNoteColor() || my?.note_color || actor?.note_color)
      : actor?.note_color;
    const tone = personTone(color);
    const pAttr = tone ? ` data-person="${esc(tone)}" style="${personVars(tone)}"` : "";
    return line.source === "app" && actor
      ? faceHtml({
        name,
        initials,
        drawing: avatar ? pictureNow(avatar) : null,
        picture: avatar && !pictureNow(avatar) ? avatar : null,
        size: 32,
        me: isMe,
        color,
        className: "chg-ico",
        decorative: true,
      })
      : `<span class="chg-ico ds-face"${pAttr} aria-hidden="true">${ico(o.icon)}</span>`;
  }

  function lineHtml(line) {
    const o = originOf(line, store, me);
    const open = state.open.has(line.id);
    const res = state.results.get(line.id);
    const isNew = line.rev > state.seenBefore && !(line.source === "app" && line.by?.id === me) && line.kind !== "create";
    const rows = readable(line.rows);
    const at = new Date(toMs(line.created_at));
    const head = `
      <span class="chg-app">${esc(o.app)}</span>
      <span>${esc(o.for)}</span>
      <time class="chg-when" datetime="${at.toISOString()}" title="${esc(at.toLocaleString())}"><span class="chg-dot" aria-hidden="true">·</span>${esc(fmtAgo(line.created_at))}</time>
      ${isNew ? '<span class="chg-new">New</span>' : ""}`;
    const detail = open ? `
      <div class="chg-detail">
        <ul class="chg-rows">${rows.map((r) => {
          const name = nameOf(r, store);
          const noun = nounOf(r)[0];
          const what = !name ? `A ${noun}` : r.table === "trips" || r.table === "pictures" ? cap(name) : `${cap(noun)} ${name}`;
          return `<li class="chg-row"><span class="chg-op" data-op="${r.op}">${PAST[r.op]}</span>
            <span class="chg-what">${esc(what)}${r.may_not ? `<small>${esc(mayNotWords(r, store, me))}</small>` : ""}</span></li>`;
        }).join("")}
        ${line.private_rows_of_others ? `<li class="chg-row"><span class="chg-op" data-op="changed">Private</span><span class="chg-what">${line.private_rows_of_others} ${line.private_rows_of_others === 1 ? "row" : "rows"} of someone's own packing<small>Only they see what, and only they can put ${line.private_rows_of_others === 1 ? "it" : "them"} back.</small></span></li>` : ""}
        </ul>
      </div>` : "";
    const actsIsBtn = actsButton(line);
    return `
      <li class="chg-line" data-id="${esc(line.id)}"${open ? " data-open" : ""}${line.undone_by ? " data-undone" : ""}>
        <div class="chg-main">
          ${iconHtmlFor(line)}
          <button class="chg-top" type="button" data-act="open" aria-expanded="${open}" aria-controls="chg-d-${esc(line.id)}">
            <span class="chg-sum">${esc(shownSummary(line))}</span>
            <span class="chg-head">${head}</span>
            <span class="chg-touch">${esc(touchedWords(line))}${ico("chev", "chg-chev")}</span>
          </button>
          <div class="chg-acts"${actsIsBtn ? "" : " data-note"}>${actsHtml(line)}</div>
        </div>
        <div id="chg-d-${esc(line.id)}">${detail}</div>
        ${state.confirm === line.id ? confirmHtml(line) : ""}
        ${res ? resultHtml(line, res) : ""}
      </li>`;
  }

  /** What can be done with a line, or why nothing can. */
  function actsHtml(line) {
    if (line.kind === "create") return `<span class="chg-state">Making a trip can't be undone. Only its host can delete it, under People and settings.</span>`;
    if (line.undone_by) {
      const u = byId(line.undone_by);
      const who = u ? (u.by?.id === me ? "you" : (u.by?.name || "someone")) : null;
      return `<span class="chg-state"><b>Undone</b>${who ? ` by ${esc(who)}${u.source !== "app" ? `, through ${esc(originOf(u, store, me).app)}` : ""}, ${esc(fmtAgo(u.created_at))}` : ""}. Undo that line to bring this change back.</span>`;
    }
    const mine = line.rows.filter((r) => !r.may_not);
    if (!mine.length) {
      const blocked = line.rows.filter((r) => r.may_not);
      const words = blocked.length ? mayNotWords(blocked[0], store, me)
        : line.private_rows_of_others ? "Only the person whose own packing this is can undo it." : "Nothing in this change is left to undo.";
      return `<span class="chg-state">${esc(words)}</span>`;
    }
    if (state.busy === line.id) return `<button class="btn ds-button ds-button--gray" type="button" disabled>Undoing…</button>`;
    if (!store.online()) return `<button class="btn ds-button ds-button--gray" type="button" disabled data-act="undo">Undo needs signal</button>`;
    return `<button class="btn ds-button ds-button--gray" type="button" data-act="undo" aria-label="Undo: ${esc(shownSummary(line))}">Undo</button>`;
  }

  function confirmHtml(line) {
    const put = readable(line.rows).filter((r) => !r.may_not);
    const groups = new Map();
    for (const r of put) {
      const noun = nounOf(r);
      const k = `${r.op}\n${noun[0]}`;
      const g = groups.get(k) ?? groups.set(k, { op: r.op, noun, names: [] }).get(k);
      g.names.push(nameOf(r, store));
    }
    const items = [...groups.values()].map((g) => {
      const named = g.names.filter(Boolean);
      const shown = named.slice(0, 4).join(", ") + (named.length > 4 ? ` and ${named.length - 4} more` : "");
      return `<li>${esc(`${BACK[g.op].replace(/^./, (c) => c.toUpperCase())} ${count(g.names.length, g.noun)}${shown ? `: ${shown}` : ""}`)}</li>`;
    }).join("");
    const kept = line.rows.filter((r) => r.may_not).map((r) => mayNotWords(r, store, me));
    if (line.private_rows_of_others) kept.push(`${line.private_rows_of_others} of someone's own packing stays: only they can undo that.`);
    return `
      <div class="chg-confirm" role="group" aria-label="Undo this change">
        <p><b>Undo will:</b></p>
        <ul>${items}</ul>
        ${kept.length ? `<p>It leaves:</p><ul>${kept.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>` : ""}
        <p>Anything changed since stays as it is.</p>
        <div class="chg-acts"><button class="btn ds-button ds-button--white" type="button" data-act="do-undo">Undo it</button>
          <button class="btn ds-button ds-button--gray" type="button" data-act="cancel">Keep it</button></div>
      </div>`;
  }

  function resultHtml(line, res) {
    if (res.error) {
      return `<div class="chg-result" data-left role="status"><h3>${ico("part")}Nothing was undone</h3><p>${esc(res.error)}</p></div>`;
    }
    const left = leftWords(res.left ?? [], line, store, me);
    // What it did: the change's rows this person could undo, but those it left alone.
    const leftKeys = new Set((res.left ?? []).filter((l) => l.key).map((l) => `${l.table}\n${JSON.stringify(l.key)}`));
    const done = readable(line.rows).filter((r) => !r.may_not && !leftKeys.has(`${r.table}\n${JSON.stringify(r.key)}`));
    const did = didWords(done, store);
    const head = res.undone
      ? `${ico("tick")}${esc(did.length ? did.join(", ") : `Undid ${res.undone === 1 ? "1 thing" : `${res.undone} things`}`)}`
      : `${ico("part")}Nothing was undone`;
    return `
      <div class="chg-result"${left.length ? " data-left" : ""} role="status">
        <h3>${head}</h3>
        ${left.length ? `<p>Left alone:</p><ul>${left.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
        ${res.undone ? "<p>The undo is a line of its own at the top, and can be undone.</p>" : ""}
      </div>`;
  }

  function dayHeading(sec, tz) {
    const now = Math.floor(Date.now() / 1000);
    const k = dayKey(sec, tz);
    if (k === dayKey(now, tz)) return "Today";
    if (k === dayKey(now - 86400, tz)) return "Yesterday";
    return fmtDay(sec, tz);
  }

  let lastBodyHtml = "";

  function listBodyHtml() {
    const tz = store.trip()?.default_tz;
    let lastDay = "";
    let itemsHtml = "";
    for (const line of state.lines) {
      const k = dayKey(line.created_at, tz);
      if (k !== lastDay) {
        itemsHtml += `<li class="chg-day">${esc(dayHeading(line.created_at, tz))}</li>`;
        lastDay = k;
      }
      itemsHtml += lineHtml(line);
    }
    return `<ol class="chg-list">${itemsHtml}</ol>
      ${state.more ? `<button class="btn ds-button ds-button--gray chg-more" type="button" data-act="older"${store.online() ? "" : " disabled"}>${store.online() ? "Show older" : "Older ones need signal"}</button>` : ""}`;
  }

  function repaintFaces() {
    if (!alive || !state.lines) return;
    const tmp = document.createElement("div");
    for (const li of body.querySelectorAll(".chg-line[data-id]")) {
      const line = byId(li.dataset.id);
      if (!line) continue;
      const oldIco = li.querySelector(":scope > .chg-main > .chg-ico");
      if (!oldIco) continue;
      tmp.innerHTML = iconHtmlFor(line);
      const nextIco = tmp.firstElementChild;
      if (nextIco) oldIco.replaceWith(nextIco);
    }
    if (state.lines.length && lastBodyHtml) lastBodyHtml = listBodyHtml();
    wakePictures(body);
  }

  function paint() {
    if (!alive) return;
    paintNet();
    if (!state.lines) return;
    if (!state.lines.length) {
      lastBodyHtml = "";
      body.innerHTML = `
        <div class="chg-empty">
          ${ico("list")}
          <h2>Nothing has been changed through a connected app</h2>
          <p>When an app like Claude adds or changes something on this trip, it shows here, with a way to undo it.</p>
        </div>`;
      return;
    }
    const html = listBodyHtml();
    if (html === lastBodyHtml) return;
    // A repaint keeps focus on the button that had it and keeps scroll position intact.
    const viewTop = el.scrollTop;
    const docEl = document.scrollingElement;
    const docTop = docEl ? docEl.scrollTop : 0;
    const had = document.activeElement?.closest?.(".chg-line") ? [document.activeElement.closest(".chg-line").dataset.id, document.activeElement.dataset.act] : null;
    lastBodyHtml = html;
    body.innerHTML = html;
    wakePictures(body);
    if (had) body.querySelector(`.chg-line[data-id="${CSS.escape(had[0])}"] [data-act="${had[1]}"]`)?.focus({ preventScroll: true });
    if (el.scrollTop !== viewTop) el.scrollTop = viewTop;
    if (docEl && docEl.scrollTop !== docTop) docEl.scrollTop = docTop;
  }

  const PAGE = 50;
  let reading = null;
  let again = false;
  /** Reads the newest page (the list as it is now), keeps it for no signal, and marks it seen. */
  async function read() {
    if (reading) { again = true; return reading; }
    reading = (async () => {
      try {
        const res = await fetchWithin(store.tripApi(`/changes?limit=${PAGE}`), { credentials: "same-origin", headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(String(res.status));
        const { changes } = await res.json();
        if (!alive) return;
        // Older pages already shown stay below the new first page.
        const older = state.from === "server" && state.lines ? state.lines.filter((l) => l.created_at < (changes.at(-1)?.created_at ?? 0)) : [];
        state.lines = [...changes, ...older];
        state.more = changes.length === PAGE || older.length > 0 && state.more;
        state.from = "server";
        store.keepAside(ASIDE, { at: Date.now(), lines: changes, more: changes.length === PAGE });
        const newest = Math.max(0, ...changes.map((l) => l.rev ?? 0));
        markChangesSeen(trip, me, Math.max(newest, store.trip()?.newest_change ?? 0));
      } catch {
        if (!alive) return;
        if (!state.lines) {
          const kept = await store.readAside(ASIDE);
          state.lines = kept?.lines ?? [];
          state.more = false;
          state.from = kept ? "kept" : "none";
          if (!kept) {
            body.innerHTML = `<div class="chg-empty">${ico("signal")}<h2>The list needs signal the first time</h2><p>This phone hasn't read the trip's changes yet. It will as soon as it's connected.</p></div>`;
            paintNet();
            return;
          }
        } else if (state.from !== "server") state.from = "kept";
      }
      paint();
    })();
    try { await reading; } finally { reading = null; }
    if (again && alive) { again = false; read(); }
  }

  async function older() {
    const last = state.lines?.at(-1);
    if (!last) return;
    try {
      const res = await fetchWithin(store.tripApi(`/changes?limit=${PAGE}&before=${last.created_at}`), { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(String(res.status));
      const { changes } = await res.json();
      const seen = new Set(state.lines.map((l) => l.id));
      state.lines.push(...changes.filter((l) => !seen.has(l.id)));
      state.more = changes.length === PAGE;
    } catch { /* no signal: the button says so on the next paint */ }
    paint();
  }

  async function undo(line) {
    state.confirm = null;
    state.busy = line.id;
    state.results.delete(line.id);
    paint();
    let res;
    try {
      const r = await fetchWithin(store.tripApi(`/changes/${encodeURIComponent(line.id)}/undo`), {
        method: "POST", credentials: "same-origin", headers: { Accept: "application/json" },
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j) res = { undone: j.undone ?? 0, left: j.left ?? [] };
      else res = { error: (j && j.reason) || `The trip didn't take it (${r.status}). Nothing was changed.` };
    } catch {
      res = { error: "No signal, so nothing was changed. Undo again when you're connected." };
    }
    if (!alive) return;
    state.busy = null;
    state.results.set(line.id, res);
    paint();
    if (res.undone) {
      // The trip itself (the screens behind this one) and the list, with the undo's own line.
      store.refresh();
      await read();
    }
  }

  body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    const id = b.closest(".chg-line")?.dataset.id;
    const line = id ? byId(id) : null;
    const act = b.dataset.act;
    if (act === "older") { older(); return; }
    if (!line) return;
    if (act === "open") {
      if (state.open.has(id)) state.open.delete(id); else state.open.add(id);
      paint();
    } else if (act === "undo") {
      // More than one thing: say what first. One: it is what the line says.
      const put = readable(line.rows).filter((r) => !r.may_not);
      if (put.length > 1 || line.rows.some((r) => r.may_not) || line.private_rows_of_others) { state.confirm = id; paint(); }
      else undo(line);
    } else if (act === "do-undo") undo(line);
    else if (act === "cancel") { state.confirm = null; paint(); }
  });

  // What moves the list: the trip's data (an app's write is one), the signal, the store's status.
  let lastFaceSig = memberFaceSig(store);
  const stops = [
    live.on("data", () => read()),
    store.on("status", () => paint()),
    store.on("change", () => {
      if (!alive) return;
      const sig = memberFaceSig(store);
      if (sig === lastFaceSig) return;
      lastFaceSig = sig;
      repaintFaces();
    }),
  ];
  const onOnline = () => { paint(); read(); };
  const onOffline = () => paint();
  addEventListener("online", onOnline);
  addEventListener("offline", onOffline);

  // The kept list first, so there is something at once with no signal; then the trip's.
  const kept = await store.readAside(ASIDE);
  if (kept && !state.lines) {
    state.lines = kept.lines ?? [];
    state.more = false;
    state.from = "kept";
    paint();
  }
  read();

  return () => {
    alive = false;
    for (const s of stops) { try { s(); } catch { /* */ } }
    removeEventListener("online", onOnline);
    removeEventListener("offline", onOffline);
  };
}

/** For the checks: the words, without a page. */
export const changesWords = { touchedWords, leftWords, mayNotWords, didWords, readable, shownSummary };
