// Pictures (src/trips/pictures.js; model §6, §17): one stored image per place, event, the trip's
// cover, and a purchase's receipt. The three ways in (the app's bytes, an address, a one-use
// upload link), every refusal in words, the host's storage, replacing and removing, and the
// pictures going with what they hang on. Part of check:trips. Fetches by address go to the far
// sites' stand-in (../lib/far.mjs), never the network. Everyone here is made up.

import { AVIF, AVIF_TURNED, JPEG, JPEG_TURNED, SVG, WEBP, avifSmallFirst, png } from "../lib/images.mjs";
import { PICTURE_LIMITS } from "../../public/js/shared/limits.js";
import { LIMIT } from "./storage.mjs";

const KB = 1024;
// Two planted stores the server holds mid-way (PICTURE_STORE_PAUSE, run.mjs): one after its bytes
// are in the bucket and before the write that points at them; one after that write, before it
// reads back what it wrote.
export const PAUSES = "1500:p-gone:before-write,1500:p-race:before-read";

export async function pictures({ t, server, person, put, del, newTrip, bring }) {
  const ada = await person("Ada Check");     // the host
  const ben = await person("Ben Check");     // a member
  const cy = await person("Cy Check");       // a member who neither made nor paid the purchase
  const trip = await newTrip(ada, { name: "Pictures trip", starts_on: "2027-07-01", ends_on: "2027-07-08", default_tz: "Europe/Lisbon" });
  const T = `/api/trips/${trip.id}`;
  await bring(ada, trip.id, ben);
  await bring(ada, trip.id, cy);
  await put(ada, `${T}/places`, { places: [
    { id: "p-pier", name: "The pier", kind: "sight", subkind: "viewpoint", why: "The light at six" },
    { id: "p-cafe", name: "Corner cafe", kind: "food", subkind: "cafe", why: "Breakfast" },
  ] });
  await ada.post(`${T}/events`, { id: "e-boat", title: "Boat out", starts_at: Date.UTC(2027, 6, 3, 9) / 1000, tz: "Europe/Lisbon" });
  await ada.post(`${T}/events`, { id: "e-walk", title: "Walk", starts_at: Date.UTC(2027, 6, 4, 9) / 1000, tz: "Europe/Lisbon" });
  await ada.post(`${T}/purchases`, { id: "pu-lunch", description: "Lunch", amount_minor: 3000, currency: "EUR", amount_exp: 2, split_mode: "weight",
    spent_at: Date.UTC(2027, 6, 3, 13) / 1000, shares: [{ user_id: ada.user.id, weight: 1, share_minor: 1500 }, { user_id: ben.user.id, weight: 1, share_minor: 1500 }] });
  const send = (p, at, bytes, q = "license=own") => p.call("PUT", `${T}/pictures/${at}?${q}`, bytes, { headers: { "Content-Type": "application/octet-stream" } });
  const snap = async (p = ada) => (await p.get(T)).json;
  const queued = (key) => server.sql(`SELECT COUNT(*) AS n FROM files_to_delete WHERE r2_key = '${key}'`)[0].n;
  const keyOf = (url) => url?.replace(/^\/media\//, "");

  // ── the app's way ───────────────────────────────────────────────────────────────────────
  t.part("Pictures: the app's way, each kind and each type");
  const pier = await send(ben, "place/p-pier", png(800, 600));
  t.same("a member puts a picture on a place: stored at its own size, read from its own bytes", [pier.status, pier.json?.picture?.width, pier.json?.picture?.height, pier.json?.picture?.mime, pier.json?.picture?.license],
    [200, 800, 600, "image/png", "own"]);
  const boat = await send(ben, "event/e-boat", JPEG);
  const cover = await ada.call("PUT", `${T}/pictures/cover?license=CC0`, WEBP, { headers: { "Content-Type": "application/octet-stream" } });
  const receipt = await send(ada, "purchase/pu-lunch", AVIF);
  t.same("an event's (JPEG), the trip's cover (WebP), a purchase's receipt (AVIF)",
    [[boat.status, boat.json?.picture?.mime], [cover.status, cover.json?.picture?.mime, cover.json?.picture?.license], [receipt.status, receipt.json?.picture?.mime]],
    [[200, "image/jpeg"], [200, "image/webp", "CC0"], [200, "image/avif"]]);
  const s = await snap(ben);
  t.same("the trip's snapshot carries each: the place's and the event's picture, the cover, the purchase's receipt",
    [s.places.find((p) => p.id === "p-pier")?.picture?.url, s.places.find((p) => p.id === "p-cafe")?.picture, s.events.find((e) => e.id === "e-boat")?.picture?.url,
      s.trip.cover?.url, s.purchases.find((p) => p.id === "pu-lunch")?.receipt?.url],
    [pier.json.picture.url, null, boat.json.picture.url, cover.json.picture.url, receipt.json.picture.url]);
  const file = await cy.get(pier.json.picture.url);
  t.same("its file opens for anyone on the trip, as an image", [file.status, file.headers.find(([k]) => k === "content-type")?.[1]], [200, "image/png"]);
  const outsider = await person("Out Check");
  t.same("and for nobody else: not a place's picture, not the cover, not a receipt",
    [(await outsider.get(pier.json.picture.url)).status, (await outsider.get(cover.json.picture.url)).status, (await outsider.get(receipt.json.picture.url)).status], [404, 404, 404]);
  const meter = (await ada.get("/api/account/storage")).json.trips.find((x) => x.id === trip.id);
  t.same("the host's meter counts them: three pictures and a receipt, each with how much", [meter.pictures.count, meter.receipts.count, meter.pictures.bytes > 0, meter.receipts.bytes === AVIF.length],
    [3, 1, true, true]);
  const goes = (await ada.call("DELETE", T, {})).json?.goes;
  t.same("and so does what deleting the trip would take", [goes?.pictures, goes?.receipts], [3, 1]);

  // ── refused, in words ───────────────────────────────────────────────────────────────────
  t.part("Pictures: refused, in words");
  const refusals = [
    ["an SVG", () => send(ben, "place/p-cafe", SVG), 415, "not a picture", /SVG/],
    ["something that isn't a picture at all", () => send(ben, "place/p-cafe", Buffer.from("just some words, not a picture at all")), 415, "not a picture", /JPEG, PNG, WebP or AVIF/],
    [`a picture 1 px over ${PICTURE_LIMITS.picture.px} on its long side`, () => send(ben, "place/p-cafe", png(PICTURE_LIMITS.picture.px + 1, 10)), 413, "too big", /1601 px/],
    [`a picture over ${PICTURE_LIMITS.picture.bytes / KB} KB`, () => send(ben, "place/p-cafe", png(1000, 1000, { noise: true })), 413, "too big", /KB/],
    ["a kind nothing hangs on", () => send(ben, "area/old-town", JPEG), 404, "no such kind", /place, an event/],
    ["a place the trip doesn't have", () => send(ben, "place/p-nowhere", JPEG), 404, "no such place", /Save it first/],
    ["a receipt for a purchase the server doesn't have yet", () => send(ada, "purchase/pu-later", JPEG), 404, "no such purchase", /Save the purchase first/],
    ["no license", () => send(ben, "place/p-cafe", JPEG, ""), 400, "bad license", /needs its license/],
    ["a license that forbids commercial use", () => send(ben, "place/p-cafe", JPEG, "license=CC%20BY-NC%204.0&credit=A&source=https://pics.example/a"), 400, "license refused", /NC or ND/],
    ["a license that forbids changes", () => send(ben, "place/p-cafe", JPEG, "license=CC%20BY-ND%202.0&credit=A&source=https://pics.example/a"), 400, "license refused", /NC or ND/],
    ["a license that needs credit, without it", () => send(ben, "place/p-cafe", JPEG, "license=CC%20BY%204.0"), 400, "credit needed", /credit .* and its source/],
    ["a receipt by someone who neither logged nor paid the purchase", () => send(cy, "purchase/pu-lunch", JPEG), 403, "forbidden", /who logged it, or who paid/],
  ];
  for (const [what, go, status, error, words] of refusals) {
    const res = await go();
    t.ok(`refused, saying why: ${what}`, res.status === status && res.json?.error === error && words.test(res.json?.reason ?? ""), { status: res.status, ...res.json });
  }
  const credited = await send(ben, "place/p-cafe", JPEG, "license=CC%20BY%204.0&credit=A%20photographer&source=https://pics.example/cafe");
  t.same("with its credit and source, a CC BY picture is taken", [credited.status, credited.json?.picture?.credit, credited.json?.picture?.source], [200, "A photographer", "https://pics.example/cafe"]);
  t.same("  (nothing refused left a file behind: the bucket holds exactly the five pictures' rows)",
    server.sql(`SELECT COUNT(*) AS n FROM media_objects WHERE trip_id = '${trip.id}' AND role IN ('picture', 'receipt')`)[0].n, 5);

  // A picture that wouldn't fit the host's storage is refused before any bytes move.
  server.sql(`INSERT INTO media_objects (r2_key, upload_id, user_id, trip_id, role, kind, mime, orig_name, bytes, sha256, state, thumb_for, created_at, stored_at)
    VALUES ('o/zz/planted/full.mp4', '', '${ada.user.id}', '${trip.id}', 'original', 'video', 'video/mp4', 'full.mp4', ${LIMIT - 60 * KB}, '', 'stored', '', 1, 1)`);
  const full = await send(ben, "event/e-walk", png(300, 300, { noise: true }));
  t.same("a picture that wouldn't fit the host's storage is refused before any bytes move, as every upload is",
    [full.status, full.json?.error, server.sql(`SELECT COUNT(*) AS n FROM media_objects WHERE trip_id = '${trip.id}' AND role = 'picture' AND state = 'pending'`)[0].n], [413, "storage full", 0]);
  server.sql("DELETE FROM media_objects WHERE r2_key = 'o/zz/planted/full.mp4'");

  // A phone stores a picture taken upright as a wide one plus a note to turn it (a JPEG's EXIF
  // orientation, an AVIF's irot); the size given is the one it is shown at, which is what the
  // limits and the app's layout go by.
  const size = (res) => [res.status, res.json?.picture?.mime, res.json?.picture?.width, res.json?.picture?.height];
  t.same("a JPEG held upright (stored 40 x 30, EXIF orientation 6) is taken at the size it shows: 30 x 40",
    size(await send(ben, "event/e-walk", JPEG_TURNED)), [200, "image/jpeg", 30, 40]);
  t.same("so is an AVIF turned a quarter (irot): 30 x 40", size(await send(ben, "event/e-walk", AVIF_TURNED)), [200, "image/avif", 30, 40]);
  t.same("an AVIF whose first image extents are a small one's is taken at its largest: 40 x 30", size(await send(ben, "event/e-walk", avifSmallFirst())), [200, "image/avif", 40, 30]);
  await del(ben, `${T}/pictures/event/e-walk`);

  // ── replacing and removing ──────────────────────────────────────────────────────────────
  t.part("Pictures: replaced, removed, and going with what they hang on");
  const oldKey = keyOf(pier.json.picture.url);
  const again = await send(ada, "place/p-pier", png(1200, 800));
  t.same("replacing a picture by hand sends the old file to the drain and its row with it",
    [again.status, again.json?.picture?.width, queued(oldKey), server.sql(`SELECT COUNT(*) AS n FROM media_objects WHERE r2_key = '${oldKey}'`)[0].n], [200, 1200, 1, 0]);
  const gone = await del(ben, `${T}/pictures/place/p-pier`);
  t.same("removing it by hand: the file to the drain at once, what it held freed",
    [gone.status, gone.json?.removed, gone.json?.freed_bytes > 0, queued(keyOf(again.json.picture.url)), (await snap()).places.find((p) => p.id === "p-pier")?.picture], [200, true, true, 1, null]);
  t.same("  (removing it again changes nothing)", (await del(ben, `${T}/pictures/place/p-pier`)).json?.removed, false);
  const boatKey = keyOf(boat.json.picture.url);
  await del(ada, `${T}/events/e-boat`);
  const cafeKey = keyOf(credited.json.picture.url);
  await ada.call("DELETE", `${T}/places`, { ids: ["p-cafe"] });
  const lunchKey = keyOf(receipt.json.picture.url);
  await del(ada, `${T}/purchases/pu-lunch`);
  t.same("deleting the event, the place and the purchase takes each one's picture with it, files to the drain",
    [server.sql(`SELECT COUNT(*) AS n FROM pictures WHERE trip_id = '${trip.id}' AND target_kind != 'cover'`)[0].n, queued(boatKey), queued(cafeKey), queued(lunchKey)], [0, 1, 1, 1]);
  t.same("only the cover is left", server.sql(`SELECT target_kind FROM pictures WHERE trip_id = '${trip.id}'`).map((r) => r.target_kind), ["cover"]);

  t.part("Pictures: what someone else does in the middle of setting one");
  await put(ada, `${T}/places`, { places: [{ id: "p-gone", name: "Gone soon", kind: "sight", subkind: "viewpoint", why: "x" }, { id: "p-race", name: "Two at once", kind: "sight", subkind: "viewpoint", why: "x" }] });
  // Ben sets a picture; while the server holds it (bytes stored, row reserved), Ada deletes the place.
  const setting = send(ben, "place/p-gone", png(64, 48));
  await new Promise((r) => setTimeout(r, 500));
  const deleted = await ada.call("DELETE", `${T}/places`, { ids: ["p-gone"] });
  const tooLate = await setting;
  t.same("the place deleted while a picture was being set: the picture answers 404 in words, and nothing is left behind",
    [deleted.status, tooLate.status, tooLate.json?.error, server.sql(`SELECT COUNT(*) AS n FROM pictures WHERE trip_id = '${trip.id}' AND target_id = 'p-gone'`)[0].n,
      server.sql(`SELECT COUNT(*) AS n FROM media_objects WHERE trip_id = '${trip.id}' AND state = 'pending'`)[0].n],
    [200, 404, "no such place", 0, 0]);
  // Ben's store is held after its write; meanwhile Cy sets the same place's picture.
  const first = send(ben, "place/p-race", png(64, 48));
  await new Promise((r) => setTimeout(r, 500));
  const second = await send(cy, "place/p-race", png(80, 60));
  const lost = await first;
  t.same("two people set the same picture at once: the later one's stands, and the other is told in words, with the picture that is there",
    [second.status, lost.status, lost.json?.error, lost.json?.picture?.width, /Someone else just set this picture/.test(lost.json?.reason ?? "")], [200, 409, "picture changed", 80, true]);
  t.same("  (the file that lost is on its way out, not left counted)", server.sql(`SELECT COUNT(*) AS n FROM media_objects WHERE trip_id = '${trip.id}' AND role = 'picture' AND r2_key NOT IN (SELECT r2_key FROM pictures)`)[0].n, 0);

  // ── by address ──────────────────────────────────────────────────────────────────────────
  t.part("Pictures: by address (a stand-in for far sites, never the network)");
  const fetchFor = (p, at, url, extra = {}) => p.post(`${T}/pictures/${at}/from-url`, { url, license: "CC BY 4.0", credit: "A photographer", source: "https://pics.example/", ...extra });
  await put(ada, `${T}/places`, { places: [{ id: "p-fort", name: "The fort", kind: "sight", subkind: "viewpoint", why: "x" }] });
  const askedBefore = server.farAsked().length;
  const fetched = await fetchFor(ben, "place/p-fort", "https://pics.example/harbour.png");
  t.same("a picture fetched by its address is stored like any other", [fetched.status, fetched.json?.picture?.width, fetched.json?.picture?.source], [200, 800, "https://pics.example/"]);
  t.same("  (after one redirect, too)", (await fetchFor(ben, "place/p-fort", "https://pics.example/once")).status, 200);
  const sized = await fetchFor(ben, "place/p-fort", "https://upload.wikimedia.org/wikipedia/commons/a/ab/Big.png");
  t.same("from a host that serves sized copies, its largest standard width under the limit (1280 px) is asked for first, and stored",
    [sized.status, sized.json?.picture?.width, server.farAsked().slice(askedBefore).at(-1)], [200, 1280, "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Big.png/1280px-Big.png"]);
  const before2 = server.farHeard().length;
  const small = await fetchFor(ben, "place/p-fort", "https://upload.wikimedia.org/wikipedia/commons/c/cd/Small.png");
  const tried = server.farHeard().slice(before2);
  t.same("a sized copy the site refuses (wider than its original) tries the next: 1280 refused, 960 stored",
    [small.status, small.json?.picture?.width, tried.map((h) => h.at.match(/(\d+)px-/)?.[1] ?? "original")], [200, 960, ["1280", "960"]]);
  t.ok("every fetch says who is asking: the app and this site's own address, nothing about the person",
    tried.every((h) => h.agent === `WeGoPlace (+${server.origin})`), tried.map((h) => h.agent));
  const asked = server.farAsked().length;
  const addressRefusals = [
    ["http", "http://pics.example/harbour.png", "not https"],
    ["another port", "https://pics.example:8443/harbour.png", "not port 443"],
    ["a name and password in it", "https://someone:secret@pics.example/harbour.png", "credentials in the address"],
    ["a number for the site", "https://127.0.0.1/harbour.png", "an address, not a name"],
    ["a private name", "https://router.local/x", "a private name"],
    ["a private name ending in a dot", "https://localhost./x", "a private name"],
    ["another, ending in a dot", "https://box.internal./x", "a private name"],
    ["a .localdomain name", "https://nas.localdomain/x", "a private name"],
    ["a home.arpa name", "https://printer.home.arpa/x", "a private name"],
    ["not an address", "harbour.png", "not an address"],
  ];
  for (const [what, url, cause] of addressRefusals) {
    const res = await fetchFor(ben, "place/p-fort", url);
    t.ok(`an address refused before anything is fetched: ${what}`, res.status === 400 && res.json?.cause === cause && res.json?.reason?.length > 10, res.json);
  }
  t.same("  (none of those reached the far sites)", server.farAsked().length, asked);
  const sent = [
    ["more than three redirects", "https://pics.example/hop1", 400, "redirects"],
    ["a redirect to a private name (refused before it is followed)", "https://pics.example/to-private", 400, "a private name"],
    ["an error from the far site (its own words never shown)", "https://pics.example/missing", 400, "refused"],
    ["an SVG", "https://pics.example/drawing.svg", 415, null],
    ["a picture over the pixels", "https://pics.example/wide.png", 413, null],
    ["a picture over the bytes (reading stops at the limit)", "https://pics.example/big.png", 413, null],
  ];
  for (const [what, url, status, cause] of sent) {
    const res = await fetchFor(ben, "place/p-fort", url);
    t.ok(`refused, saying why: ${what}`, res.status === status && (cause === null || res.json?.cause === cause) && !/must never be shown/.test(res.text), { status: res.status, ...res.json });
  }
  t.ok("  (the redirect to a private name was never followed)", !server.farAsked().some((a) => a.includes("router.local")));
  const started = Date.now();
  const slow = await fetchFor(ben, "place/p-fort", "https://pics.example/slow");
  t.ok("a far site that doesn't answer is given up on after 10 seconds, in words", slow.status === 400 && slow.json?.cause === "too slow" && Date.now() - started < 14000, { ms: Date.now() - started, ...slow.json });
  // Each account fetches at most 20 a minute: a fresh member asks until refused.
  const dee = await person("Dee Check");
  await bring(ada, trip.id, dee);
  let firstRefused = -1;
  for (let i = 0; i < 45 && firstRefused < 0; i++) if ((await fetchFor(dee, "place/p-fort", "https://pics.example/missing")).status === 429) firstRefused = i;
  t.ok("an account fetches at most 20 pictures a minute; then it is told to wait, in words", firstRefused >= 20 && firstRefused <= 40, { firstRefused });

  // ── an upload link ──────────────────────────────────────────────────────────────────────
  t.part("Pictures: an upload link, for an AI with a shell");
  await ada.post(`${T}/events`, { id: "e-dinner", title: "Dinner", starts_at: Date.UTC(2027, 6, 5, 19) / 1000, tz: "Europe/Lisbon" });
  const made = await ben.post(`${T}/pictures/event/e-dinner/upload-link`, { license: "own" });
  const path = made.json?.url ? new URL(made.json.url).pathname : "";
  t.ok("a member makes a link: one use, 15 minutes, the limits it takes", made.status === 201 && /^\/pictures\/upload\/[A-Za-z0-9_-]{20,}$/.test(path)
    && made.json.expires_at - Math.floor(Date.now() / 1000) <= 900 && made.json.max_px === PICTURE_LIMITS.picture.px, made.json);
  const shell = new (ben.constructor)(server.origin, "a shell");     // no session at all
  const putTo = (p, at, bytes) => p.call("PUT", at, bytes, { headers: { "Content-Type": "application/octet-stream" }, origin: null });
  const byLink = await putTo(shell, path, JPEG);
  t.same("the picture sent to it, with no session, is stored on the event, as the link's maker's", [byLink.status, (await snap()).events.find((e) => e.id === "e-dinner")?.picture?.created_by], [200, ben.user.id]);
  t.same("a second use is refused, in words", [(await putTo(shell, path, JPEG)).json?.error], ["no such link"]);
  t.same("so is a made-up one", (await putTo(shell, "/pictures/upload/" + "x".repeat(43), JPEG)).status, 404);
  const late = await ben.post(`${T}/pictures/event/e-dinner/upload-link`, { license: "own" });
  const latePath = new URL(late.json.url).pathname;
  server.sql(`UPDATE picture_links SET expires_at = 1 WHERE used_at IS NULL AND trip_id = '${trip.id}'`);
  t.same("and one past its 15 minutes", (await putTo(shell, latePath, JPEG)).status, 404);
  const big = await ben.post(`${T}/pictures/event/e-dinner/upload-link`, { license: "own" });
  t.same("a link takes the same limits: too big is refused", (await putTo(shell, new URL(big.json.url).pathname, png(1000, 1000, { noise: true }))).status, 413);
  const left = await ben.post(`${T}/pictures/event/e-dinner/upload-link`, { license: "own" });
  await del(ben, `${T}/members/${ben.user.id}`);
  t.same("a link whose maker has left the trip doesn't work", (await putTo(shell, new URL(left.json.url).pathname, JPEG)).status, 404);
  t.same("a link for something the trip doesn't have isn't made", (await ada.post(`${T}/pictures/event/e-nowhere/upload-link`, { license: "own" })).status, 404);

  t.part("Pictures: what always holds");
  t.same("no picture ever points at a file that isn't stored (so the drain's step for abandoned uploads can always run)",
    server.sql("SELECT COUNT(*) AS n FROM pictures p JOIN media_objects o ON o.r2_key = p.r2_key WHERE o.state != 'stored'")[0].n, 0);
  server.sql(`INSERT INTO media_objects (r2_key, upload_id, user_id, trip_id, role, kind, mime, orig_name, bytes, sha256, state, thumb_for, created_at, stored_at)
    VALUES ('p/zz/abandoned.png', '', '${ada.user.id}', '${trip.id}', 'picture', 'photo', 'image/png', '', 100, '', 'pending', '', 1, NULL)`);
  const ran = await fetch(`${server.origin}/__scheduled?cron=*/15+*+*+*+*`);
  t.same("  (and it does: an abandoned picture's row is cleared by the next run)", [ran.status, server.sql("SELECT COUNT(*) AS n FROM media_objects WHERE r2_key = 'p/zz/abandoned.png'")[0].n], [200, 0]);

  // A site run anywhere but Cloudflare turns fetching by address off (docs/API.md says why).
  await server.halt();
  await server.start({ vars: { PICTURE_FETCH_BY_ADDRESS: "off" } });
  const off = await ada.post(`${T}/pictures/place/p-fort/from-url`, { url: "https://pics.example/harbour.png", license: "own" });
  t.same("with fetching by address turned off, it says so in words, and nothing is fetched", [off.status, off.json?.error, /isn't offered/.test(off.json?.reason ?? "")], [404, "not offered", true]);
  t.same("  (the other two ways still work)", (await send(ada, "place/p-fort", png(40, 30))).status, 200);
}
