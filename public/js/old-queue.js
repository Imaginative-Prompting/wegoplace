// The changes a phone made with no signal in the app as it was before a trip had an address
// (service worker v54 and older), turned into the changes this app sends.
//
// That app kept two queues. The main one (database "wegoplace") is carried into the trip's
// database by trip-adopt.js, each change marked OLD_MARK. The packing screen kept a second one
// in a database of its own ("wegoplace-pack"), beside the lists and bags it knew by id; that
// comes along as one record. Neither is sent as it is: packing has changed shape since.
//
//   then                                     now
//   a thing is "done" (one flag)             a tick per list the thing sits on
//   each person has their own copy of a      the trip has one list of each name, and one bag
//   list, and their own bags on it           of each name on it, for everyone
//   lists and bags are known by an id        … by a key, which the trip's lists carry
//
// THE RULES (docs/CONTRACTS.md, "A phone that had the app before"):
//   1. A plan, a note, a purchase, a change to the person's own settings: sent as written.
//   2. A new packing thing: sent without the fields that are gone (`done`, `section`).
//   3. `done` on a thing, new or changed: one tick (or the tick taken off) on every list the
//      thing sits on that is packed once, with no day. That is what the server's own move of
//      the old rows did with the flag. A thing on no list has nothing to tick: said.
//   4. From the packing screen's queue, what ADDS is carried: a new list, a new bag, a thing
//      put in a bag or taken off a list. A list or a bag is found by its name: the trip's
//      list of that name is the one that person's copy became.
//   5. What would change a list or a bag for everyone else is NOT carried, because it was
//      made on the person's own copy: a rename, a removal, a new order. A rename and a removal
//      are said, in one line each; a new order is not (nothing the person would miss).
//   6. Nothing is dropped without a line. `told` is every such line's case.
//
// Pure: no storage, no network, no clock. store.js runs it once, after the first answer from
// the server (the trip's lists as they are now), and before anything it marks is sent.

/** The mark on a waiting change that came from the old app. */
export const OLD_MARK = "v54";

const SEP = "\u0000";
const norm = (s) => String(s == null ? "" : s).trim().replace(/\s+/g, " ").toLowerCase();
// The key the server's move gave a list or a bag made from an old name.
const movedKey = (name) => String(name == null ? "" : name).trim().replace(/ /g, "-").toLowerCase();

function findByName(rows, name) {
  const k = movedKey(name), n = norm(name);
  return rows.find((r) => r.key === k) || rows.find((r) => norm(r.name) === n) || null;
}

/**
 * @param {object} a
 * @param {object[]} a.ops         the waiting changes marked OLD_MARK, oldest first
 * @param {object|null} a.old      the old packing screen's record: { views, sections, placements, queue }
 * @param {object[]} a.lists       the trip's lists now: { key, name, sort, repeat, bags: [{ key, name, sort }] }
 * @param {Map<string,string>} a.placements  "item\0list" -> bag key, as the trip has them now
 * @param {(id: string) => (object|null)} a.item   a packing thing by id (for its label)
 * @param {(name: string, taken: Set<string>, fallback: string) => string} a.makeKey
 * @param {number} [a.now]         the stamp new changes carry
 * @returns {{ ops: object[], told: object[] }} the changes to send, in order, and what to say
 */
export function translateOld({ ops = [], old = null, lists = [], placements = new Map(), item = () => null, makeKey, now = 0 }) {
  const out = [];
  const told = [];
  const done = new Map();                       // thing id -> ticked or not, the last word wins
  const labels = new Map();                     // thing id -> its label, where a change carried one
  const gone = new Set();                       // things removed in this queue
  const labelOf = (id) => labels.get(id) || (item(id) || {}).label || "";

  // ── the main queue ─────────────────────────────────────────────────────────────────────
  for (const op of ops) {
    const { from, seq, ...rest } = op;         // the mark and the old place in line go
    if (rest.kind !== "packing") { out.push(rest); continue; }
    if (rest.op === "delete") { gone.add(rest.id); done.delete(rest.id); out.push(rest); continue; }
    const { done: flag, section, ...payload } = rest.payload || {};
    if (payload.label) labels.set(rest.id, payload.label);
    // A new thing made unticked has no tick to take off.
    if (rest.op === "create") { if (flag) done.set(rest.id, true); out.push({ ...rest, payload }); continue; }
    if (flag !== undefined) done.set(rest.id, !!flag);
    // A change that was only the tick has nothing left to send as a change to the thing.
    if (Object.keys(payload).some((k) => k !== "updated_at")) out.push({ ...rest, payload });
  }

  // ── the packing screen's queue ─────────────────────────────────────────────────────────
  // The trip's lists as this goes along: what the server has, plus what this queue adds.
  const work = lists.map((l) => ({ key: l.key, name: l.name, sort: l.sort || 0, repeat: l.repeat || "once", bags: (l.bags || []).map((b) => ({ ...b })) }));
  const placed = new Map(placements);
  const listOf = new Map();                     // old list id -> the trip's list (in `work`)
  const bagOf = new Map();                      // old bag id -> { list, bag }
  const oldViews = new Map(((old && old.views) || []).map((v) => [v.id, v]));
  const oldSecs = new Map(((old && old.sections) || []).map((s) => [s.id, s]));
  const queue = ((old && old.queue) || []).filter((q) => q && typeof q.t === "string");

  // What this queue made itself never reached the server under its old id: it is the
  // person's own and new, so a rename or a removal of it is theirs to make.
  const madeView = new Map(queue.filter((q) => q.t === "view.create").map((q) => [q.id, { ...(q.body || {}) }]));
  const madeSec = new Map(queue.filter((q) => q.t === "sec.create").map((q) => [q.id, { ...(q.body || {}) }]));
  for (const q of queue) {
    if (q.t === "view.patch" && madeView.has(q.id)) Object.assign(madeView.get(q.id), q.body);
    if (q.t === "sec.patch" && madeSec.has(q.id)) Object.assign(madeSec.get(q.id), q.body);
  }
  const droppedView = new Set(queue.filter((q) => q.t === "view.delete" && madeView.has(q.id)).map((q) => q.id));
  const droppedSec = new Set(queue.filter((q) => q.t === "sec.delete" && madeSec.has(q.id)).map((q) => q.id));
  for (const [id, s] of madeSec) if (droppedView.has(s.view_id)) droppedSec.add(id);

  // WHICH LIST AND BAG OF THE TRIP an old id means. The old app saved its lists and bags with
  // its unsent changes already applied, so one it renamed with no signal is known here only
  // by the NEW name, which the trip never heard of. Three ways, in this order:
  //   1. by name (nothing was renamed: the trip's list of that name is the one);
  //   2. by what sits in it: a thing the old app had in that list or bag, and did not move in
  //      this queue, sits in the trip's list or bag it became;
  //   3. by what is left: one old list (or one bag of a list) still unknown, and one of the
  //      trip's that no old one became.
  const moved = new Set(queue.filter((q) => q.t === "place.put" || q.t === "place.del").map((q) => `${q.item_id}${SEP}${q.view_id}`));
  const oldPlaces = ((old && old.placements) || []).filter((p) => p && !moved.has(`${p.item_id}${SEP}${p.view_id}`));
  const sitsNow = new Map();                    // thing -> [{ list key, bag key }] as the trip has it
  for (const [k, bag] of placements) {
    const [thing, list] = k.split(SEP);
    if (!sitsNow.has(thing)) sitsNow.set(thing, []);
    sitsNow.get(thing).push({ list, bag });
  }
  const most = (votes) => {
    const ranked = [...votes].sort((a, b) => b[1] - a[1]);
    return ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
  };
  const knownViews = [...oldViews.values()].filter((v) => !madeView.has(v.id));
  for (const v of knownViews) {
    let l = findByName(work, v.name);
    if (!l) {
      const votes = new Map();
      for (const p of oldPlaces) if (p.view_id === v.id) for (const s of sitsNow.get(p.item_id) || []) votes.set(s.list, (votes.get(s.list) || 0) + 1);
      const key = most(votes);
      l = key ? work.find((x) => x.key === key) || null : null;
    }
    listOf.set(v.id, l);
  }
  {
    const lost = knownViews.filter((v) => !listOf.get(v.id));
    const free = work.filter((l) => !knownViews.some((v) => listOf.get(v.id) === l));
    if (lost.length === 1 && free.length === 1) listOf.set(lost[0].id, free[0]);
  }
  const knownSecs = [...oldSecs.values()].filter((s) => !madeSec.has(s.id));
  for (const s of knownSecs) {
    const l = listOf.get(s.view_id) || null;
    let b = l ? findByName(l.bags, s.name) : null;
    if (l && !b) {
      const votes = new Map();
      for (const p of oldPlaces) {
        if (p.section_id !== s.id) continue;
        const now = (sitsNow.get(p.item_id) || []).find((x) => x.list === l.key);
        if (now) votes.set(now.bag, (votes.get(now.bag) || 0) + 1);
      }
      const key = most(votes);
      b = key ? l.bags.find((x) => x.key === key) || null : null;
    }
    bagOf.set(s.id, b ? { list: l, bag: b } : null);
  }
  for (const l of work) {
    const here = knownSecs.filter((s) => listOf.get(s.view_id) === l);
    const lost = here.filter((s) => !bagOf.get(s.id));
    const free = l.bags.filter((b) => !here.some((s) => (bagOf.get(s.id) || {}).bag === b));
    if (lost.length === 1 && free.length === 1) bagOf.set(lost[0].id, { list: l, bag: free[0] });
  }
  const viewList = (id) => listOf.get(id) || null;
  const secBag = (id) => bagOf.get(id) || null;
  // A list or bag the old app REMOVED with no signal is not in what it saved at all: only its
  // id is left, in the removal. It can be named when it is the only one of the trip's that
  // nothing the old app still knows became; otherwise it is said without a name.
  const goneViews = queue.filter((q) => q.t === "view.delete" && !madeView.has(q.id) && !oldViews.has(q.id));
  const goneSecs = queue.filter((q) => q.t === "sec.delete" && !madeSec.has(q.id) && !oldSecs.has(q.id));
  const freeLists = work.filter((l) => !knownViews.some((v) => listOf.get(v.id) === l));
  const freeBags = work.flatMap((l) => l.bags.filter((b) => !knownSecs.some((s) => (bagOf.get(s.id) || {}).bag === b)).map((bag) => ({ list: l, bag })));
  const goneList = goneViews.length === 1 && freeLists.length === 1 ? freeLists[0] : null;
  const goneBag = goneSecs.length === 1 && !goneViews.length && freeBags.length === 1 ? freeBags[0] : null;
  const nextSort = (rows) => rows.reduce((m, r) => Math.max(m, r.sort || 0), -1) + 1;
  const addBag = (list, name) => {
    const had = findByName(list.bags, name);
    if (had) return { bag: had, isNew: false };
    const bag = { key: makeKey(name, new Set(list.bags.map((b) => b.key)), "bag"), name: String(name).trim().replace(/\s+/g, " "), sort: nextSort(list.bags) };
    list.bags.push(bag);
    return { bag, isNew: true };
  };

  for (const q of queue) {
    if (q.t === "view.create") {
      if (droppedView.has(q.id)) continue;
      const body = madeView.get(q.id);
      const had = findByName(work, body.name);
      if (had) { listOf.set(q.id, had); continue; }       // the trip has a list of that name: it is that one
      const list = { key: makeKey(body.name, new Set(work.map((l) => l.key)), "list"), name: String(body.name).trim().replace(/\s+/g, " "), sort: nextSort(work), repeat: "once", bags: [] };
      // A list is made with its bags: the ones this queue goes on to add to it.
      for (const [sid, s] of madeSec) {
        if (s.view_id !== q.id || droppedSec.has(sid)) continue;
        const { bag } = addBag(list, s.name);
        bagOf.set(sid, { list, bag });
      }
      if (!list.bags.length) list.bags.push({ key: "main-bag", name: "Main bag", sort: 0 });
      work.push(list);
      listOf.set(q.id, list);
      out.push({ kind: "pack-list", op: "create", id: list.key, at: q.at || now,
        payload: { name: list.name, sort: list.sort, repeat: "once", bags: list.bags.map((b) => ({ ...b })) } });
      continue;
    }
    if (q.t === "sec.create") {
      if (droppedSec.has(q.id) || bagOf.has(q.id)) continue;   // gone again, or made with its list
      const body = madeSec.get(q.id);
      const list = viewList(body.view_id);
      if (!list) { told.push({ case: "bag-lost", name: body.name }); bagOf.set(q.id, null); continue; }
      const { bag, isNew } = addBag(list, body.name);
      bagOf.set(q.id, { list, bag });
      if (isNew) out.push({ kind: "pack-bag", op: "create", id: `${list.key}${SEP}${bag.key}`, at: q.at || now,
        payload: { list_key: list.key, key: bag.key, name: bag.name, sort: bag.sort } });
      continue;
    }
    if (q.t === "view.patch") {
      if (madeView.has(q.id)) continue;                        // folded into the new list above
      const list = viewList(q.id);
      const to = q.body && q.body.name;
      // A list this can't find is still said: the name the person chose is known either way.
      if (to && (!list || norm(to) !== norm(list.name))) told.push({ case: "list-renamed", from: list ? list.name : "", to: String(to).trim() });
      continue;
    }
    if (q.t === "sec.patch") {
      if (madeSec.has(q.id)) continue;
      const hit = secBag(q.id);
      const to = q.body && q.body.name;
      if (to && (!hit || norm(to) !== norm(hit.bag.name))) told.push({ case: "bag-renamed", from: hit ? hit.bag.name : "", to: String(to).trim() });
      continue;
    }
    if (q.t === "view.delete") {
      if (madeView.has(q.id)) continue;
      const list = viewList(q.id) || goneList;
      told.push({ case: "list-removed", name: list ? list.name : "" });
      continue;
    }
    if (q.t === "sec.delete") {
      if (madeSec.has(q.id)) continue;
      const hit = secBag(q.id) || goneBag;
      told.push({ case: "bag-removed", name: hit ? hit.bag.name : "", list: hit ? hit.list.name : "" });
      continue;
    }
    if (q.t === "place.put" || q.t === "place.del") {
      if (gone.has(q.item_id) || droppedView.has(q.view_id)) continue;
      const list = viewList(q.view_id);
      if (q.t === "place.del") {
        if (!list || !placed.has(`${q.item_id}${SEP}${list.key}`)) continue;   // nothing there to take off
        placed.delete(`${q.item_id}${SEP}${list.key}`);
        out.push({ kind: "pack-place", op: "update", id: `${q.item_id}${SEP}${list.key}`, at: q.at || now,
          payload: { item_id: q.item_id, list_key: list.key, bag_key: null, label: labelOf(q.item_id), bag_name: "" } });
        continue;
      }
      if (droppedSec.has(q.section_id)) continue;
      const hit = secBag(q.section_id);
      if (!list || !hit || hit.list !== list) { told.push({ case: "place-lost", label: labelOf(q.item_id) }); continue; }
      if (placed.get(`${q.item_id}${SEP}${list.key}`) === hit.bag.key) continue;
      placed.set(`${q.item_id}${SEP}${list.key}`, hit.bag.key);
      out.push({ kind: "pack-place", op: "update", id: `${q.item_id}${SEP}${list.key}`, at: q.at || now,
        payload: { item_id: q.item_id, list_key: list.key, bag_key: hit.bag.key, label: labelOf(q.item_id), bag_name: hit.bag.name } });
    }
    // A new order of lists or bags ("view.order", "sec.order") was the person's own copy's.
  }

  // ── the ticks, last: a tick needs its thing on the list ────────────────────────────────
  for (const [id, ticked] of done) {
    if (gone.has(id)) continue;
    const on = work.filter((l) => l.repeat !== "daily" && placed.has(`${id}${SEP}${l.key}`));
    if (!on.length) { if (ticked) told.push({ case: "tick-nowhere", label: labelOf(id) }); continue; }
    for (const l of on) {
      out.push({ kind: "pack-tick", op: "update", id: `${id}${SEP}${l.key}${SEP}`, at: now,
        payload: { item_id: id, list_key: l.key, day: null, ticked, label: labelOf(id), list_name: l.name } });
    }
  }
  return { ops: out, told };
}

const q = (s, fallback) => {
  let t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  if (t.length > 40) t = `${t.slice(0, 39).trimEnd()}…`;
  return t ? `“${t}”` : fallback;
};

/**
 * One line for the person about a change that was not carried over.
 * @param {{ case: string }} t  one entry of translateOld()'s `told`
 * @returns {string}
 */
export function oldWords(t) {
  switch (t && t.case) {
    case "list-renamed": return `The list ${q(t.from, "you renamed")} kept its ${t.from ? "" : "old "}name. Lists are shared by everyone on the trip now; rename it in Packing if you still want ${q(t.to, "the new name")}.`;
    case "bag-renamed": return `The bag ${q(t.from, "you renamed")} kept its ${t.from ? "" : "old "}name. Bags are shared by everyone on the trip now; rename it in Packing if you still want ${q(t.to, "the new name")}.`;
    case "list-removed": return `The list ${q(t.name, "you removed")} is still here. Lists are shared by everyone on the trip now; remove it in Packing if nobody needs it.`;
    case "bag-removed": return `The bag ${q(t.name, "you removed")} is still here. Bags are shared by everyone on the trip now; remove it in Packing if nobody needs it.`;
    case "bag-lost": return `The bag ${q(t.name, "you added")} wasn't added: its list is gone.`;
    case "place-lost": return `${q(t.label, "A thing")} wasn't moved: the bag it went to is gone.`;
    case "tick-nowhere": return `${q(t.label, "A thing")} isn't on a list, so its tick wasn't kept.`;
    case "failed": return "Some packing changes made before the update couldn't be carried over.";
    case "refused": return refusedWords(t);
    default: return "";
  }
}

// A change that WAS carried over, and that the trip then refused (store.js adds these: any 4xx
// on a change that came from the old app's queues). The person made it weeks ago, under the old
// app's rules and against the trip as it was then, so they are not looking at the screen for
// it: it is said here, with the thing's name, not in a message that is gone in five seconds.
//   { case: "refused", kind, op: "create"|"update"|"delete", label, status }
function refusedWords(t) {
  const made = t.op === "create";
  const gone = t.op === "delete";
  const why = t.status === 404 ? (made ? "what it belonged to is no longer on the trip" : "it is no longer on the trip")
    : t.status === 403 ? (t.kind === "purchase" ? `only whoever added it or paid for it can ${gone ? "remove it" : "change it now"}`
      : t.kind === "note" ? "only whoever wrote it can remove it"
        : gone ? "it isn't yours to remove" : "it isn't yours to change now")
      : "the trip couldn't take it as it was written";
  const name = q(t.label, "");
  if (t.kind === "me") return `A change to your own settings from before the update wasn't kept: ${why}.`;
  if (!name) return `A change you made before the update wasn't kept: ${why}.`;
  if (made) return `${name}, which you added before the update, wasn't kept: ${why}.`;
  if (gone) return `${name} is still here. You removed it before the update, but ${why}.`;
  return `Your change to ${name} from before the update wasn't kept: ${why}.`;
}

/**
 * The lines for everything that was not carried over, for one message that stays until it is
 * tapped: three at most; with more, the first two and how many more there were.
 * @param {{ case: string }[]} told
 * @returns {string[]}
 */
export function oldLines(told) {
  const seen = new Map();                  // line → whether it is about packing
  for (const t of Array.isArray(told) ? told : []) {
    const line = oldWords(t);
    if (line && !seen.has(line)) seen.set(line, t.case !== "refused");
  }
  const lines = [...seen.keys()];
  if (lines.length <= 3) return lines;
  const more = lines.length - 2;
  const packing = lines.slice(2).every((l) => seen.get(l));
  return [...lines.slice(0, 2), `and ${more} more ${packing ? "packing changes" : "changes"} from before the update weren't carried over.`];
}
