// packing-refusals.js — what to say when the server turns a packing write down.
//
// A write is made on the phone first and sent when there is signal, which can be days later.
// By then someone else may have removed the bag it names, or still have things in the bag it
// removes. The store drops a refused write and puts the screen back the way the server has
// it; this is the sentence that goes with that, so the change does not just quietly vanish.
//
// The shell calls it for every refused write (store's "reject" event) and it answers only for
// packing: null means "not mine, say what you would have said". What the shell would have
// said is refusalLine(), at the end of this file: the general sentence for every other write.
//
// No imports and no DOM, so the sentences can be checked without a browser. The names come
// from the write itself (the store keeps the label or the bag's name on it for this), because
// by the time the answer arrives the thing named may no longer be on the phone to look up.
//
// Why these and not the server's own words: its refusals are written for whoever sent the
// request, which is also an AI through the MCP, so they name keys ("day-pack" holds 2). A
// person on the Pack tab knows the bag by the name on screen.

const things = (n) => `${n} thing${n === 1 ? "" : "s"}`;
const quoted = (name, fallback) => (name ? `“${name}”` : fallback);

/**
 * @param {{ op: { kind: string, op: string, id: string, payload?: object }, status: number, body: any }} refusal
 * @returns {string|null} one sentence for the person, or null when this is not a packing write
 *   (or is one this module has nothing better to say about than the shell does).
 */
export function refusalWords({ op, status, body }) {
  if (!op || typeof op.kind !== "string") return null;
  const b = body && typeof body === "object" ? body : {};
  const p = op.payload || {};
  const row = Array.isArray(b.rows) && b.rows[0] ? b.rows[0] : null;
  const error = typeof b.error === "string" ? b.error : "";
  const reason = typeof b.reason === "string" ? b.reason : "";

  if (op.kind === "pack-bag") {
    const bag = quoted(p.name, "That bag");
    if (op.op === "delete") {
      const held = row && Array.isArray(row.held) && row.held[0] ? Number(row.held[0].items) : 0;
      if (held) return `${bag} still holds ${things(held)}, counting everyone's, so it stays. They have to move to another bag first.`;
      if (row && Array.isArray(row.suggested) && row.suggested.length) return `Suggested items start in ${bag}, so it stays.`;
      if (row && /^A list has/.test(row.error || "")) return `${bag} is its list's only bag, so it stays.`;
      return (row && row.error) || reason || `${bag} couldn't be removed.`;
    }
    // A list this phone still showed was removed elsewhere: the server takes the write for a
    // new list with no name. A bag removed elsewhere, moved here: a new bag with no name.
    if (row && /^A list needs a name/.test(row.error || "")) return `That list was removed on another phone, so ${bag} went with it.`;
    if (row && /^A bag needs a name/.test(row.error || "")) return "That bag was removed on another phone.";
    if (row && /^A list has/.test(row.error || "")) return `That list already has as many bags as a list can have, so ${bag} wasn't added.`;
    return (row && row.error) || reason || `${bag} couldn't be saved.`;
  }

  if (op.kind === "pack-list") {
    const list = quoted(p.name, "That list");
    if (op.op === "delete") {
      if (error === "last list") return "A trip keeps at least one packing list, so this one stays.";
      if (error === "list in use") {
        const n = Number(b.items) || 0;
        if (n) return `${list} stays: ${things(n)} still ${n === 1 ? "is" : "are"} on it, counting everyone's.`;
        if (Array.isArray(b.starters) && b.starters.length) return `Suggested items start on ${list}, so it stays.`;
        return `${list} stays: something was just put on it.`;
      }
      return reason || `${list} couldn't be removed.`;
    }
    if (error === "too many lists") return `A trip has ${Number(b.max) || 10} packing lists at most, so ${list} wasn't added.`;
    // Renamed or moved here, removed elsewhere: the server takes the write for a new list.
    if (row && /^A (new )?list needs/.test(row.error || "")) return "That list was removed on another phone.";
    return (row && row.error) || reason || `${list} couldn't be saved.`;
  }

  if (op.kind === "pack-tick") {
    const thing = quoted(p.label, "That thing");
    if (error === "no such item") return `${thing} was deleted on another phone.`;
    if (error === "no such list") return "That list was removed on another phone.";
    if (error === "not on that list") return `${thing} was taken off that list on another phone, so there is nothing to tick.`;
    if (error === "bad day" || error === "not a day of that list" || error === "not a day of the trip") {
      return `${quoted(p.list_name, "That list")} isn't packed on that day, so the tick wasn't kept.`;
    }
    return status === 403 ? null : (reason || null);
  }

  if (op.kind === "pack-place") {
    const thing = quoted(p.label, "that thing");
    if (error === "no such item") return `${quoted(p.label, "That thing")} was deleted on another phone.`;
    if (error === "no such list") return `That list was removed on another phone, so ${thing} wasn't put on it.`;
    // The screen shows lists, not bags (packing.js): a bag gone under a thing is its list having changed.
    if (error === "no such bag") return `That list changed on another phone, so ${thing} wasn't put on it.`;
    return status === 403 ? null : (reason || null);
  }

  if (op.kind === "packing") {
    // The server's sentence says the number and that the group's things count on their own.
    if (error === "too many items") return reason || "That list is full.";
    if (error === "no such item") return "That thing was deleted on another phone.";
    return null;
  }

  return null;
}

/**
 * The general sentence for a refused write that nothing above answers for (a plan, a purchase,
 * a note): what it was, by the words the person typed when the write still carries them, and
 * why, in the server's own sentence when it sent one. A change made days ago with no signal
 * must not vanish as "a change couldn't be saved (400)".
 * @param {{ op?: { payload?: object }, status?: number, body?: any }} refusal
 * @returns {string}
 */
export function refusalLine({ op, status, body } = {}, known = {}) {
  if (status === 403) return "That change wasn't yours to make, so it was undone.";
  const p = (op && op.payload) || {};
  // What the person calls it: the words the write carries, or else (a change that didn't touch them) the words the
  // thing has on this phone, which the shell passes as `known.name`.
  const typed = [p.title, p.label, p.name, p.description, p.body, p.text, known.name].find((v) => typeof v === "string" && v.trim());
  let name = typed ? typed.replace(/\s+/g, " ").trim() : "";
  if (name.length > 40) name = `${name.slice(0, 39).trimEnd()}…`;
  // Changed here with no signal, deleted on another phone meanwhile: said as that, by its name, never by the
  // server's sentence, which names the row by its id for the apps that write to the trip (27 Nov: "There's no
  // purchase or payment "pu-1a80…" on this trip.").
  if (status === 404 && !(op && op.op === "delete")) return `${name ? `“${name}”` : (known.noun || "That")} was deleted on another phone, so the change wasn't kept.`;
  const what = name ? `“${name}”` : "A change";
  const reason = body && typeof body === "object" && typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason) return `${what} couldn't be saved. ${reason}`;
  return `${what} couldn't be saved (${status || "no connection"}).`;
}
