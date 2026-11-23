// The route table: which handler answers which method and path.
//
// It reads top to bottom and the first row that fits wins, so the order is part of the
// behavior: a fixed path stands above the `:id` row it would otherwise fall into
// (…/packing/lists above …/packing/:id), and a row for one method stands above the
// any-method row for the same path (GET /api/fx above * /api/fx). `npm run check:routes`
// holds the table to its own list of rows added on purpose (add a row here, add it there),
// checks that each row is the first to fit its own path, and checks that every row of a trip
// is wrapped (below).
//
// A path is matched with path-to-regexp 6: letter case is ignored, one trailing slash is
// allowed, and what a `:name` catches reaches the handler still percent-encoded. `:name*`
// catches any number of segments as an array, and catches nothing at all when there are none.
//
// EVERYTHING OF A TRIP IS UNDER /api/trips/:trip, AND EVERY SUCH ROW IS WRAPPED IN inTrip().
// The wrapper is the one place that checks the caller is on the trip in the address
// (src/trips/access.js); a handler under it never asks. The rows are made by `trip()` so that
// a row can't be added without it, and the route check fails on one that is.
//
// A row for …/things/:id beside the row for …/things is never decoration. The client's
// offline queue addresses every row it wrote as `${base}/${id}` (public/js/store.js) and reads
// a 4xx on that shape as a permanent refusal: it drops the write. A missing `:id` row is days
// of offline edits flushed as nothing.
//
// No fixed path may be added under …/purchases/ or …/events/: it would shadow a row whose id
// happened to be that word. /api/fx/refresh is safe because nothing addresses a rate by id;
// …/memories keeps its own list of reserved ids for the same reason.

import { match } from "path-to-regexp";

import * as account from "./accounts/account.js";
import * as apps from "./accounts/apps.js";
import * as errors from "./errors.js";
import * as adminErrors from "./admin/errors.js";
import * as bugReports from "./bug-reports.js";
import * as push from "./push/routes.js";
import * as oauth from "./mcp/oauth.js";
import * as email from "./accounts/email.js";
import * as guests from "./accounts/guests.js";
import { useLink } from "./accounts/link.js";
import * as passkeys from "./accounts/passkeys.js";
import * as providers from "./accounts/providers.js";
import * as collage from "./api/collage.js";
import * as events from "./api/events.js";
import * as references from "./api/references.js";
import * as fx from "./api/fx.js";
import * as me from "./api/me.js";
import * as avatar from "./accounts/avatar.js";
import * as accountExport from "./accounts/export.js";
import * as media from "./api/media.js";
import * as memories from "./api/memories.js";
import * as messages from "./api/messages.js";
import * as packing from "./api/packing.js";
import * as packingLists from "./api/packing/lists.js";
import * as starters from "./api/packing/starters.js";
import * as places from "./api/places.js";
import * as purchases from "./api/purchases.js";
import * as snapshot from "./api/trip.js";
import * as mediaFiles from "./media-files.js";
import * as sharePage from "./share-page.js";
import { appAt, pageAt } from "./static.js";
import * as tiles from "./tiles.js";
import * as mapRoutes from "./map/routes.js";
import { inTrip } from "./trips/access.js";
import { SPECS, told } from "./api/ignored.js";
import * as areas from "./trips/areas.js";
import * as changes from "./trips/changes.js";
import * as billing from "./billing/routes.js";
import * as talk from "./assistant/talk.js";
import * as docs from "./assistant/files.js";
import * as links from "./trips/links.js";
import * as members from "./trips/members.js";
import * as live from "./trips/live.js";
import * as trips from "./trips/trips.js";
import * as storage from "./trips/storage.js";
import * as pictures from "./trips/pictures.js";

/** Where a trip's routes live. */
export const TRIP = "/api/trips/:trip";
/** A row of a trip: `path` is what follows the trip in the address ("" is the trip itself). */
const trip = (method, path, handler) => [method, TRIP + path, inTrip(handler)];

/** [method, path, handler]. "*" is any method. */
export const ROUTES = [
  // Accounts (src/accounts/). Which of these answer without a session is the gate's list.
  ["POST", "/api/auth/register/options", passkeys.registerOptions],
  ["POST", "/api/auth/register/verify", passkeys.registerVerify],
  ["POST", "/api/auth/login/options", passkeys.loginOptions],
  ["POST", "/api/auth/login/verify", passkeys.loginVerify],
  ["POST", "/api/auth/passkeys/options", passkeys.passkeysOptions],
  ["POST", "/api/auth/passkeys/verify", passkeys.passkeysVerify],
  ["POST", "/api/auth/pending/create", providers.pendingCreate],
  ["POST", "/api/auth/pending/attach", providers.pendingAttach],
  ["GET", "/api/auth/pending", providers.pendingView],
  ["POST", "/api/auth/recover/confirm", email.recoverConfirm],
  ["POST", "/api/auth/recover", email.recoverStart],
  ["POST", "/api/auth/link", useLink],
  ["POST", "/api/auth/logout/all", account.logoutAll],
  ["POST", "/api/auth/logout", account.logout],
  ["GET", "/api/auth/config", account.config],
  ["DELETE", "/api/auth/ways/passkey/:id", account.removePasskey],
  ["DELETE", "/api/auth/ways/:provider/:subject", account.removeIdentity],
  ["GET", "/api/auth/ways", account.ways],
  ["POST", "/api/account/email/confirm", email.emailConfirm],
  ["GET", "/api/account/email", email.emailGet],
  ["POST", "/api/account/email", email.emailAdd],
  ["DELETE", "/api/account/email", email.emailRemove],
  // What the trips an account hosts hold (src/trips/storage.js).
  ["GET", "/api/account/storage", storage.getAccountStorage],
  // What is the person's own, as one file (src/accounts/export.js).
  ["GET", "/api/account/export", accountExport.getExport],
  // The plan (src/billing/): 404 in words where the site doesn't offer it.
  ["GET", "/api/account/plan", billing.getPlan],
  ["POST", "/api/account/plan/checkout", billing.postCheckout],
  ["POST", "/api/account/plan/portal", billing.postPortal],
  ["POST", "/api/billing/stripe", billing.stripeWebhook],
  ["GET", "/api/me", me.onRequestGet],
  ["PATCH", "/api/me", me.onRequestPatch],
  ["DELETE", "/api/me", account.removeAccount],
  // A person's drawn picture, in place of their initials (src/accounts/avatar.js), and reading one by its hash.
  ["PUT", "/api/me/avatar", avatar.putAvatar],
  ["DELETE", "/api/me/avatar", avatar.deleteAvatar],
  ["GET", "/api/avatars/:hash", avatar.getAvatar],
  // The sign-in page under its other two addresses, and the trip to Google or GitHub and back.
  ["GET", "/login/new", pageAt("/login")],
  ["GET", "/login/link/:token", pageAt("/login")],
  ["GET", "/login/:provider/callback", providers.callback],
  ["POST", "/login/:provider", providers.start],
  ["GET", "/login/:provider", providers.startByGet],

  // Exchange rates: the site's, one table for every trip, so no trip in the address.
  ["POST", "/api/fx/refresh", fx.refreshFx],
  ["GET", "/api/fx", fx.onRequestGet],
  ["*", "/api/fx", fx.onRequest],

  // Connecting an AI app: the page that approves it (src/mcp/oauth.js), and the account's
  // connected apps (src/accounts/apps.js).
  ["GET", "/authorize", oauth.getAuthorize],
  ["POST", "/authorize", oauth.postAuthorize],
  ["GET", "/api/account/apps", apps.listApps],
  ["DELETE", "/api/account/apps/:id", apps.disconnectApp],
  // What broke: a page's report, signed in or not (src/errors.js), and the site owner's page of them
  // (src/admin/errors.js: only for the accounts ADMIN_ACCOUNTS names, absent for everyone else).
  ["POST", "/api/errors", errors.postError],
  ["GET", "/admin/errors", adminErrors.page],
  ["GET", "/api/admin/errors", adminErrors.list],
  ["POST", "/api/admin/errors/clear", adminErrors.clear],
  // A bug report, signed in or not (src/bug-reports.js); its sender's screenshot back (their export names it); the
  // operator's reads (ADMIN_ACCOUNTS only, a 404 for everyone else).
  ["POST", "/api/bug-reports", bugReports.postBugReport],
  ["GET", "/api/account/bug-reports/:id/screenshot", bugReports.ownScreenshot],
  ["GET", "/api/admin/bug-reports/:id", bugReports.adminOne],
  ["GET", "/api/admin/bug-reports", bugReports.adminList],
  // A person's phones told of new messages (src/push/routes.js).
  ["GET", "/api/account/push", push.getPush],
  ["PUT", "/api/account/push", push.putPush],
  ["DELETE", "/api/account/push", push.deletePush],

  // Trips: the account's own, and the link someone joins one by (with its page).
  ["GET", "/api/trips", trips.listTrips],
  ["POST", "/api/trips", trips.createTrip],
  ["GET", "/api/join/:code", links.viewJoin],
  ["POST", "/api/join/:code", links.join],
  ["GET", "/join/:code", pageAt("/join")],
  // A picture sent to a one-use upload link: no session, the token is the credential.
  ["PUT", "/pictures/upload/:token", pictures.uploadByLink],
  // A trip's people and settings (the page reads the id from its address). /trips itself is
  // public/trips.html, served by the file server.
  ["GET", "/trips/:id", pageAt("/trip-people")],
  // The app, at one trip's address (its tabs follow the #).
  ["GET", "/t/:id", appAt],

  // One trip. Every row is for the people on it.
  trip("GET", "/rev", trips.tripRev),
  trip("GET", "/live", live.openLive),
  trip("GET", "/members", members.getMembers),
  trip("GET", "/people", members.getPeople),
  trip("DELETE", "/members/:user", members.removeMember),
  // The host's link that signs a guest in again on a new phone (src/accounts/guests.js).
  trip("POST", "/members/:user/rejoin", guests.makeRejoinLink),
  // Handing the trip over: an offer, accepted or declined (fixed paths above /host's rows).
  trip("POST", "/host/accept", members.acceptHost),
  trip("POST", "/host/decline", members.declineHost),
  trip("POST", "/host", members.offerHost),
  trip("DELETE", "/host", members.withdrawHost),
  // The trip's own offline map (src/tiles.js); GET and HEAD.
  trip("*", "/tiles", tiles.tripTiles),
  // The host asks for the map to be made again now (an uploaded or hand-named one replaced too).
  trip("POST", "/tiles/cut", mapRoutes.cutAgain),
  trip("POST", "/tiles/plan", mapRoutes.planMap),
  // The host makes a map they uploaded the trip's.
  trip("POST", "/tiles/use", mapRoutes.useUpload),
  trip("GET", "/links", links.listLinks),
  trip("POST", "/links", links.createLink),
  trip("DELETE", "/links/:id", links.revokeLink),
  // The list of changes an AI made, and their undo (src/trips/changes.js).
  trip("GET", "/changes", changes.getChanges),
  trip("DELETE", "/changes", changes.deleteChanges),
  trip("POST", "/changes/:id/undo", changes.postUndo),
  trip("GET", "/areas", areas.getAreas),
  trip("PUT", "/areas", told(areas.putAreas, SPECS.areas)),
  trip("DELETE", "/areas", areas.deleteAreas),
  trip("DELETE", "/areas/:id", areas.deleteAreas),
  trip("PUT", "/places", told(places.putPlaces, SPECS.places)),
  trip("DELETE", "/places", places.deletePlaces),
  trip("DELETE", "/places/:id", places.deletePlaces),
  // Packing's fixed paths stand above packing/:id, which would otherwise take them for an
  // item whose id is "lists", "starters" or "ticks".
  trip("PUT", "/packing/lists", told(packingLists.putLists, SPECS.lists)),
  trip("DELETE", "/packing/lists/:key", packingLists.deleteList),
  trip("PUT", "/packing/starters", told(starters.putStarters, SPECS.starters)),
  trip("PATCH", "/packing/starters", told(starters.patchStarters, SPECS.starters)),
  trip("PUT", "/packing/ticks", told(packing.putTick, SPECS.tick)),
  trip("PUT", "/packing/items", told(packing.putItems, SPECS.items)),
  trip("DELETE", "/events/:id", events.deleteEvent),
  trip("PATCH", "/events/:id", told(events.patchEvent, SPECS.event)),
  trip("DELETE", "/packing/:id", packing.onRequestDelete),
  trip("PATCH", "/packing/:id", told(packing.onRequestPatch, SPECS.item)),
  trip("DELETE", "/purchases/:id", purchases.deletePurchase),
  // Pictures: the cover's rows first (their paths would fit /pictures/:kind/:id too).
  trip("PUT", "/pictures/cover", pictures.putCover),
  trip("DELETE", "/pictures/cover", pictures.deleteCover),
  trip("POST", "/pictures/cover/from-url", pictures.fromUrlCover),
  trip("POST", "/pictures/cover/upload-link", pictures.makeCoverLink),
  trip("PUT", "/pictures/:kind/:id", pictures.putTargetPicture),
  trip("DELETE", "/pictures/:kind/:id", pictures.deleteTargetPicture),
  trip("POST", "/pictures/:kind/:id/from-url", pictures.fromUrlTarget),
  trip("POST", "/pictures/:kind/:id/upload-link", pictures.makeTargetLink),
  trip("PATCH", "/purchases/:id", told(purchases.patchPurchase, SPECS.purchase)),
  // Each of these three also answers its bare address (…/media), where `path` catches nothing.
  trip("*", "/collage/:path*", collage.onRequest),
  trip("*", "/media/:path*", media.onRequest),
  trip("*", "/memories/:path*", memories.onRequest),
  // The trip's reference list (src/api/references.js): one item a write from the app's queue, a list from the MCP.
  trip("DELETE", "/references/:id", references.deleteReference),
  trip("PATCH", "/references/:id", told(references.patchReference, SPECS.reference)),
  trip("GET", "/references", references.onRequestGet),
  trip("POST", "/references", told(references.postReference, SPECS.reference)),
  trip("PUT", "/references", told(references.putReferences, SPECS.references)),
  trip("DELETE", "/references", references.deleteReferences),
  trip("GET", "/events", events.onRequestGet),
  trip("POST", "/events", told(events.onRequestPost, SPECS.event)),
  trip("PUT", "/events", told(events.putEvents, SPECS.events)),
  trip("DELETE", "/events", events.deleteEvents),
  // The trip's chat (model §17).
  trip("GET", "/messages", messages.listMessages),
  trip("POST", "/messages", told(messages.postMessage, SPECS.message)),
  trip("PATCH", "/messages/:id", told(messages.patchMessage, SPECS.messageEdit)),
  trip("DELETE", "/messages/:id", messages.deleteMessage),
  trip("PUT", "/chat/mute", messages.putMute),
  // The assistant (model §20; src/assistant/talk.js): each person's own conversations on the trip.
  trip("GET", "/assistant", talk.getAssistant),
  trip("PUT", "/assistant/off", told(talk.putOff, SPECS.assistantOff)),
  trip("POST", "/assistant/conversations", told(talk.postConversation, SPECS.assistantConversation)),
  trip("GET", "/assistant/conversations/:id", talk.getConversation),
  trip("DELETE", "/assistant/conversations/:id", talk.deleteConversation),
  trip("POST", "/assistant/conversations/:id/ask", told(talk.postAsk, SPECS.assistantAsk)),
  trip("POST", "/assistant/conversations/:id/share", told(talk.postShare, SPECS.assistantShare)),
  // The documents a person gives the assistant on a conversation of theirs (src/assistant/files.js; migration 0045).
  trip("POST", "/assistant/conversations/:id/files", docs.postFile),
  trip("GET", "/assistant/conversations/:id/files", docs.getFiles),
  trip("GET", "/assistant/conversations/:id/files/:file", docs.getFile),
  trip("DELETE", "/assistant/conversations/:id/files/:file", docs.deleteFile),
  trip("DELETE", "/packing", packing.onRequestDelete),
  trip("GET", "/packing", packing.onRequestGet),
  trip("PATCH", "/packing", told(packing.onRequestPatch, SPECS.item)),
  trip("POST", "/packing", told(packing.onRequestPost, SPECS.item)),
  trip("GET", "/places", places.onRequestGet),
  trip("GET", "/purchases", purchases.onRequestGet),
  trip("POST", "/purchases", told(purchases.onRequestPost, SPECS.purchase)),
  // The trip itself: the whole of it, and its details.
  trip("GET", "", snapshot.onRequestGet),
  trip("PATCH", "", told(trips.patchTrip, SPECS.trip)),
  trip("DELETE", "", trips.deleteTrip),

  // Not under /api: a shared board's page, a stored file, map data.
  ["GET", "/s/:id*", sharePage.onRequestGet],
  ["*", "/media/:path*", mediaFiles.onRequest],
  // The map's label fonts, the same for every trip (src/tiles.js).
  ["*", "/tiles/fonts/:path*", tiles.fonts],
];

const matchers = ROUTES.map(([, path]) => match(path, { end: true }));

/**
 * The first route that fits, as { handler, params }, or null when none does: the request is
 * for a static file, or for an API address nothing answers (src/index.js says which).
 */
export function findRoute(method, pathname) {
  for (let i = 0; i < ROUTES.length; i++) {
    const [routeMethod, , handler] = ROUTES[i];
    if (routeMethod !== "*" && routeMethod !== method) continue;
    const hit = matchers[i](pathname);
    if (hit) return { handler, params: hit.params, index: i };
  }
  return null;
}

/** The methods the table answers at a path, whatever method was asked ("*" for any). */
export function methodsAt(pathname) {
  const found = new Set();
  for (let i = 0; i < ROUTES.length; i++) if (matchers[i](pathname)) found.add(ROUTES[i][0]);
  return [...found];
}
