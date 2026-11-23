// The old site's write addresses, answered 503 for good.
//
// A phone that had the old app (v54, the Pages site built from `master`) keeps its unsent changes
// in a queue and sends them to the old addresses (POST /api/events, PATCH /api/purchases/<id>, …).
// After the cutover its first load can still be the old app, served by its old service worker,
// and the new Worker has none of those addresses. The old app drops a change for good on a 4xx
// (a 404 "no such route" lost 11 of 12 waiting changes in wgp-client's walk, 14 Nov) and keeps it
// on no answer, a 401, 408, 429 or a 5xx. So every write to one of these addresses is answered
// 503 with a sentence, before anything looks at the session (a 401 would also send the old app
// to its sign-in page): the queue stays on the phone, the new app takes it over when it loads,
// and sends each change to the trip's own addresses. For good, not for a while: such a phone can
// come back any time.
//
// The list is every write route the old site had (master's functions/, read 14 Nov), less the
// seven the new server still serves at the same address with the same meaning: POST
// /api/auth/{login,register}/{options,verify} and /api/auth/logout, PATCH /api/me, POST
// /api/fx/refresh. `:id` is one segment. check:routes fails if a route of the new server takes one
// of these addresses for a write; check:refusals asks each and holds the 503.

export const OLD_WRITES = [
  ["POST", "/api/collage/share"],
  ["POST", "/api/collage/share/:id/video"],
  ["POST", "/api/collage/share/:id/item"],
  ["DELETE", "/api/collage/share/:id"],
  ["POST", "/api/events"],
  ["PATCH", "/api/events/:id"],
  ["DELETE", "/api/events/:id"],
  ["POST", "/api/invite/check"],
  ["POST", "/api/invites"],
  ["POST", "/api/media/begin"],
  ["POST", "/api/media/part"],
  ["PUT", "/api/media/part"],
  ["POST", "/api/media/finish"],
  ["POST", "/api/media/abort"],
  ["POST", "/api/media/thumb"],
  ["PUT", "/api/media/thumb"],
  ["DELETE", "/api/media/object"],
  ["POST", "/api/memories"],
  ["PATCH", "/api/memories/:id"],
  ["DELETE", "/api/memories/:id"],
  ["POST", "/api/notes"],
  ["DELETE", "/api/notes/:id"],
  ["POST", "/api/packing"],
  ["PATCH", "/api/packing"],
  ["DELETE", "/api/packing"],
  ["PATCH", "/api/packing/:id"],
  ["DELETE", "/api/packing/:id"],
  ["PUT", "/api/packing/placements"],
  ["POST", "/api/packing/placements"],
  ["DELETE", "/api/packing/placements"],
  ["POST", "/api/packing/sections"],
  ["PATCH", "/api/packing/sections"],
  ["DELETE", "/api/packing/sections"],
  ["PATCH", "/api/packing/sections/:id"],
  ["DELETE", "/api/packing/sections/:id"],
  ["POST", "/api/packing/views"],
  ["PATCH", "/api/packing/views"],
  ["DELETE", "/api/packing/views"],
  ["PATCH", "/api/packing/views/:id"],
  ["DELETE", "/api/packing/views/:id"],
  ["POST", "/api/purchases"],
  ["PATCH", "/api/purchases/:id"],
  ["DELETE", "/api/purchases/:id"],
  ["POST", "/api/trip/import"],
];

const MATCHERS = OLD_WRITES.map(([method, pattern]) => [method, new RegExp(`^${pattern.replace(/:id/g, "[^/]+")}/?$`)]);

/** Whether a request is a write to one of the old site's addresses. */
export const isOldWrite = (method, pathname) => MATCHERS.some(([m, re]) => m === method && re.test(pathname));

/** The answer: 503, so the old app keeps the change for the new one to send. */
export function oldWrite() {
  return new Response(JSON.stringify({
    error: "the app has been updated",
    reason: "This address belonged to the app before its update. Your phone keeps this change and sends it again once the new app has loaded.",
  }), { status: 503, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "30" } });
}
