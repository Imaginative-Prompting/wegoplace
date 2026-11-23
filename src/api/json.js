// The two things every API handler does with JSON: read a body, write an answer.

import { JSON_BODY_MAX } from "../../public/js/shared/limits.js";

/** The request's JSON body, or {} when there is none or it isn't JSON. */
// A body is read up to JSON_BODY_MAX bytes (one that said its length was refused before this, src/index.js); past it,
// it reads as nothing, and the route refuses an empty body in its own words.
export async function readJson(request) {
  try {
    if (!request.body) return {};
    const reader = request.body.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > JSON_BODY_MAX) { await reader.cancel().catch(() => {}); return {}; }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return {}; }
}

// An answer is someone's trip or account, so no cache keeps it (a shared computer's disk cache
// included) unless the caller says otherwise: the exchange rates set their own. The app keeps its
// data in IndexedDB (public/js/store.js) and its worker leaves /api/ to the network.
export function json(body, status = 200, headers) {
  const h = headers instanceof Headers ? headers : new Headers(headers || {});
  if (!h.has("Content-Type")) h.set("Content-Type", "application/json");
  if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}
