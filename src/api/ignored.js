// No silent yes. Every route that writes a trip's rows names, in its
// answer, the fields it was sent and doesn't take (`ignored: ["events[1].zz", …]`), and still
// does the write: a phone runs a cached app against a newer server, never the other way, and its
// store drops a write refused with a 4xx, so refusing every unknown field would turn each field
// retired later into dropped writes on every phone not yet updated. What lost the old app's tick
// wasn't an unknown field; it was a field whose MEANING MOVED, answered yes. Those are refused by
// name, saying where the meaning went: MOVED below, kept here where it's seen.
//
// The lists are what each route reads (checked against its code, 14 Nov). The app's own bodies
// are held exact by measurement: wgp-client's gate has a check that no write the app makes comes
// back with `ignored`.

import { WRITABLE as PLACE_FIELDS } from "./places.js";
import { PACKING_ITEM_FIELDS } from "../../public/js/shared/trip-rules.js";

const EVENT = ["id", "title", "starts_at", "tz", "end_tz", "ends_at", "all_day", "kind", "detail", "url", "place_id", "source"];
const SHARE = ["user_id", "weight", "share_minor"];
const PURCHASE = ["id", "kind", "description", "amount_minor", "currency", "amount_exp", "paid_by", "split_mode", "shares", "spent_at", "day", "event_id", "place_id", "note"];
const BAG = ["key", "name", "sort", "remove"];
const LIST = ["key", "name", "sort", "repeat", "dates", "bags"];
const STARTER = ["id", "label", "scope", "category", "note", "qty", "bags", "remove"];

/** The fields whose meaning moved: refused by name, with where it went. */
export const MOVED = {
  item: {
    done: "Packed or not is a tick of its own now: PUT …/packing/ticks { item_id, list_key, ticked }.",
    section: "Where a thing goes is its bags now: bags { list key: bag key }.",
  },
};

/** What each write takes: `takes` at the top, and for a field holding rows or an object, its own. */
export const SPECS = {
  event: { takes: EVENT },
  events: { takes: ["events"], rows: { events: { takes: EVENT } } },
  places: { takes: ["places"], rows: { places: { takes: ["id", ...PLACE_FIELDS] } } },
  areas: { takes: ["areas"], rows: { areas: { takes: ["id", "name", "parent", "sort", "west", "south", "east", "north"] } } },
  purchase: { takes: PURCHASE, rows: { shares: { takes: SHARE } } },
  lists: { takes: ["lists"], rows: { lists: { takes: LIST, rows: { bags: { takes: BAG } } } } },
  starters: { takes: ["starters"], rows: { starters: { takes: STARTER } } },
  tick: { takes: ["item_id", "list_key", "ticked", "day"] },
  // A trip's quick reference list (src/api/references.js): one item, or a list of them.
  reference: { takes: ["id", "title", "body", "position"] },
  references: { takes: ["references"], rows: { references: { takes: ["id", "title", "body", "position"] } } },
  item: { takes: PACKING_ITEM_FIELDS, moved: MOVED.item },
  items: { takes: ["items"], rows: { items: { takes: PACKING_ITEM_FIELDS, moved: MOVED.item } } },
  message: { takes: ["id", "body", "about"], one: { about: { takes: ["kind", "id", "part"] } } },
  messageEdit: { takes: ["body"] },
  // The assistant (src/assistant/talk.js): a conversation made, and an ask in it.
  assistantConversation: { takes: ["id", "title"] },
  assistantAsk: { takes: ["id", "words", "files"] },
  assistantShare: { takes: ["id", "turn"] },
  assistantOff: { takes: ["off"] },
  trip: { takes: ["name", "starts_on", "ends_on", "default_tz", "currencies", "interests"] },
  // A memory (src/api/memories.js): what the app's POST and PATCH send, with when it happened (0029).
  memory: { takes: ["id", "caption", "tags", "media", "day", "taken_at"], rows: { media: { takes: ["key", "thumb_key", "kind", "w", "h", "width", "height", "duration", "duration_s"] } } },
  memoryEdit: { takes: ["framing", "day", "taken_at"] },
};

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** Walks a body against a spec: the paths it ignores, and the moved fields it carries. */
export function read(body, spec, at = "", out = { ignored: [], moved: [] }) {
  if (!isObject(body)) return out;
  for (const k of Object.keys(body)) {
    const path = at ? `${at}.${k}` : k;
    if (spec.moved && Object.hasOwn(spec.moved, k)) out.moved.push({ field: path, words: spec.moved[k] });
    else if (!spec.takes.includes(k)) out.ignored.push(path);
  }
  for (const [k, inner] of Object.entries(spec.rows ?? {})) {
    if (Array.isArray(body[k])) body[k].forEach((row, i) => read(row, inner, `${at ? `${at}.` : ""}${k}[${i}]`, out));
  }
  for (const [k, inner] of Object.entries(spec.one ?? {})) read(body[k], inner, at ? `${at}.${k}` : k, out);
  return out;
}

/**
 * A route that writes, told what it takes: a moved field is refused before the route runs; any
 * other field it doesn't take is named in its answer (when the answer is a success in JSON).
 */
export function told(handler, spec) {
  const wrapped = async (ctx) => {
    let body = null;
    try { body = await ctx.request.clone().json(); } catch { body = null; }
    const { ignored, moved } = read(body, spec);
    if (moved.length) {
      return new Response(JSON.stringify({ error: "field moved", fields: moved.map((m) => m.field), reason: `${moved.map((m) => `${m.field}: ${m.words}`).join(" ")} Nothing was written.` }),
        { status: 400, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
    }
    const res = await handler(ctx);
    if (!ignored.length || res.status < 200 || res.status > 299 || !(res.headers.get("Content-Type") || "").includes("application/json")) return res;
    const answer = await res.json();
    const headers = new Headers(res.headers);
    headers.delete("Content-Length");
    return new Response(JSON.stringify({ ...answer, ignored }), { status: res.status, headers });
  };
  // The route check unwraps to the handler (inTrip does the same), and reads the spec.
  wrapped.inner = handler;
  wrapped.told = spec;
  return wrapped;
}
