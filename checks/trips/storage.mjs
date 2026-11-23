// Storage (src/trips/storage.js, drain.js; model §7): what a host holds, read from the rows;
// a write that wouldn't fit refused before any bytes move, and what each person is told;
// uploads under way holding their bytes, and cancelling them; boards that count and go when
// revoked; a memory leaving the boards it is on; deleting a trip, and the drain; handing a trip
// over as an offer; the trip's own map. Part of check:trips, which runs its server with
// STORAGE_LIMIT_BYTES at LIMIT so a limit can be filled. Everyone here is made up.

import fs from "node:fs";
import { jpegOfSize, png } from "../lib/images.mjs";
import { noSuchTrip } from "../../src/trips/access.js";
import path from "node:path";

export const LIMIT = 1024 * 1024;     // what run.mjs sets STORAGE_LIMIT_BYTES to
const KB = 1024;

export async function storage({ t, server, person, patch, put, del, newTrip, bring }) {
  const kit = await person("Kit Check");     // the host
  const lou = await person("Lou Check");     // a member
  const mo = await person("Mo Check");       // another member, who will be offered the trip
  const trip = await newTrip(kit, { name: "Storage trip", starts_on: "2027-06-01", ends_on: "2027-06-10" });
  const other = await newTrip(kit, { name: "Kit's other trip" });
  const T = `/api/trips/${trip.id}`;
  await bring(kit, trip.id, lou);
  await bring(kit, trip.id, mo);
  const begin = (p, at, bytes, name = "clip.mp4") => p.post(`${at}/media/begin`, { name, mime: "video/mp4", bytes, kind: "video" });
  const meter = async () => (await kit.get("/api/account/storage")).json;
  const drainRun = () => fetch(`${server.origin}/__scheduled?cron=*/15+*+*+*+*`).then((r) => r.text());
  const queued = () => server.sql("SELECT COUNT(*) AS n FROM files_to_delete")[0].n;

  // ── the meter, and the limit ────────────────────────────────────────────────────────────
  t.part("Storage: the host's meter, and a write that doesn't fit");
  const empty = await meter();
  t.same("a host's meter starts empty, at the limit, listing the trips they host", [empty.limit, empty.used, empty.reserved, empty.trips.map((x) => x.name).sort()],
    [LIMIT, 0, 0, ["Kit's other trip", "Storage trip"]]);
  t.same("a member who hosts nothing has an empty meter of their own", [(await lou.get("/api/account/storage")).json?.trips, (await lou.get("/api/account/storage")).json?.used], [[], 0]);
  const held = await begin(lou, T, 800 * KB);
  t.same("a member begins an upload: its declared size is held against the host", [held.status, (await meter()).reserved], [201, 800 * KB]);
  const res = (await meter()).reservations;
  t.same("the host's meter lists it: whose, how much, on which trip", res.map((r) => [r.user_name, r.bytes, r.trip_name]), [["Lou Check", 800 * KB, "Storage trip"]]);
  const snap = (await mo.get(T)).json;
  t.same("every member sees the host's room in the trip's snapshot", [snap.storage?.host_id, snap.storage?.limit, snap.storage?.host_used, snap.storage?.trip_bytes], [kit.user.id, LIMIT, 800 * KB, 800 * KB]);

  const memberRefused = await begin(mo, T, 300 * KB);
  t.same("a write that wouldn't fit is refused before any bytes move", [memberRefused.status, memberRefused.json?.error, memberRefused.json?.needed], [413, "storage full", 300 * KB]);
  t.ok("a member is told this trip's share, the host's room and that only the host can free space, never the host's other trips",
    !("trips" in memberRefused.json) && !("reservations" in memberRefused.json) && /This trip's host has 224 KB left of 1 MB/.test(memberRefused.json.reason)
      && /This trip uses 800 KB/.test(memberRefused.json.reason) && /Only the host can free space/.test(memberRefused.json.reason)
      && /held by uploads still under way/.test(memberRefused.json.reason) && !/Kit's other trip/.test(JSON.stringify(memberRefused.json)), memberRefused.json);
  const hostRefused = await begin(kit, `/api/trips/${other.id}`, 300 * KB);
  t.ok("the host is told every trip they host, largest first, and that deleting a trip frees it; and which uploads hold the space",
    hostRefused.status === 413 && hostRefused.json.trips?.[0]?.name === "Storage trip" && hostRefused.json.reservations?.length === 1
      && /Deleting photos and videos, or a whole trip, frees what they hold\.$/.test(hostRefused.json.reason) && /held by uploads still under way/.test(hostRefused.json.reason), hostRefused.json);
  t.ok("no refusal mentions a price", !/price|pay|plan|upgrade|\$/i.test(memberRefused.json.reason + hostRefused.json.reason));

  // Cancelling an upload under way frees it at once: its maker, or the host.
  const notYours = await del(mo, `${T}/media/object?key=${encodeURIComponent(held.json.key)}`);
  t.same("another member can't cancel someone's upload", notYours.status, 403);
  const cancelled = await del(kit, `${T}/media/object?key=${encodeURIComponent(held.json.key)}`);
  t.same("the host cancels it, and its bytes are free at once", [cancelled.status, cancelled.json?.freed_bytes, (await meter()).reserved], [200, 800 * KB, 0]);
  t.same("  (its upload goes to the drain, to be aborted)", server.sql(`SELECT upload_id IS NOT NULL AS u FROM files_to_delete WHERE r2_key = '${held.json.key}'`)[0]?.u, 1);
  t.same("now it fits", (await begin(mo, T, 300 * KB)).status, 201);

  // A stored file, all the way through, counts at R2's size.
  const bytes = Buffer.alloc(40 * KB, 7);
  const up = await begin(lou, T, bytes.length, "photo.jpg");
  const part = await lou.call("PUT", `${T}/media/part?key=${encodeURIComponent(up.json.key)}&id=${encodeURIComponent(up.json.uploadId)}&n=1`, bytes, { headers: { "Content-Type": "application/octet-stream" } });
  const fin = await lou.post(`${T}/media/finish`, { key: up.json.key, id: up.json.uploadId, parts: [{ n: 1, etag: part.json?.etag }] });
  t.same("a stored file counts at its size", [fin.status, (await meter()).used], [200, 300 * KB + 40 * KB]);
  const thumbTooBig = await lou.call("POST", `${T}/media/thumb?mime=image/jpeg`, jpegOfSize(700 * KB, 1), { headers: { "Content-Type": "image/jpeg" } });
  t.same("a thumbnail that wouldn't fit is refused the same way", [thumbTooBig.status, thumbTooBig.json?.error], [413, "storage full"]);
  t.same("(the media/usage meter is gone: the account's storage is the meter)", (await kit.get(`${T}/media/usage`)).status, 404);

  // An upload abandoned past its day stops holding its bytes, and the drain clears it. Until the
  // drain runs, it can't take parts or finish either: holding the room and being allowed to
  // finish are one condition.
  const slow = Buffer.alloc(8 * KB, 5);
  const late = await begin(lou, T, slow.length, "late.jpg");
  const latePart = await lou.call("PUT", `${T}/media/part?key=${encodeURIComponent(late.json.key)}&id=${encodeURIComponent(late.json.uploadId)}&n=1`, slow, { headers: { "Content-Type": "application/octet-stream" } });
  const cancelLate = await begin(lou, T, KB, "cancel.jpg");
  t.same("  (two uploads begun, one with its part in)", [late.status, latePart.status, cancelLate.status], [201, 200, 201]);
  server.sql(`UPDATE media_objects SET created_at = created_at - 90000 WHERE trip_id = '${trip.id}' AND state = 'pending'`);
  const usedBefore = (await meter()).used;
  t.same("an upload under way for more than a day holds nothing", (await meter()).reserved, 0);
  const lateFinish = await lou.post(`${T}/media/finish`, { key: late.json.key, id: late.json.uploadId, parts: [{ n: 1, etag: latePart.json?.etag }] });
  t.ok("before the drain has run, it can't finish: refused in words, begin again", lateFinish.status === 409 && lateFinish.json?.error === "upload expired" && /more than a day/.test(lateFinish.json?.reason), lateFinish.json);
  const lateAgain = await lou.call("PUT", `${T}/media/part?key=${encodeURIComponent(late.json.key)}&id=${encodeURIComponent(late.json.uploadId)}&n=1`, slow, { headers: { "Content-Type": "application/octet-stream" } });
  t.same("  nor take a part", [lateAgain.status, lateAgain.json?.error], [409, "upload expired"]);
  t.same("  (nothing was stored: the host's use is what it was, and the row is still waiting for the drain)",
    [(await meter()).used, server.sql(`SELECT state FROM media_objects WHERE r2_key = '${late.json.key}'`)[0]?.state], [usedBefore, "pending"]);
  const lateCancel = await lou.post(`${T}/media/abort`, { key: cancelLate.json.key, id: cancelLate.json.uploadId });
  t.same("one past its day can still be cancelled", [lateCancel.status, lateCancel.json?.aborted], [200, true]);
  await drainRun();
  t.same("and the drain removes its row (its upload aborted)", server.sql(`SELECT COUNT(*) AS n FROM media_objects WHERE trip_id = '${trip.id}' AND state = 'pending'`)[0].n, 0);

  // Over the limit (a trip migrated in): everything reads, and nothing new is taken.
  server.sql(`INSERT INTO media_objects (r2_key, upload_id, user_id, trip_id, role, kind, mime, orig_name, bytes, sha256, state, thumb_for, created_at, stored_at)
    VALUES ('o/zz/planted/over.mp4', '', '${lou.user.id}', '${trip.id}', 'original', 'video', 'video/mp4', 'over.mp4', ${LIMIT}, '', 'stored', '', 1, 1)`);
  t.same("a host over the limit: the trip still reads", (await lou.get(T)).status, 200);
  t.same("and every new byte is refused", (await begin(lou, T, 1)).status, 413);
  server.sql("DELETE FROM media_objects WHERE r2_key = 'o/zz/planted/over.mp4'");

  // ── boards ──────────────────────────────────────────────────────────────────────────────
  t.part("Storage: shared boards count, and go when revoked or when their memory goes");
  const before = (await meter()).used;
  const board = await lou.call("POST", `${T}/collage/share?mime=image/jpeg&w=10&h=10&title=Ours`, Buffer.alloc(20 * KB, 3), { headers: { "Content-Type": "image/jpeg" } });
  const shareId = board.json?.share?.id;
  t.same("a shared board counts against the host", [board.status, (await meter()).used - before], [201, 20 * KB]);
  const memory = await lou.post(`${T}/memories`, { id: "mem-board", caption: "On the board", media: [{ key: up.json.key, w: 10, h: 10 }] });
  t.same("  (a memory with the stored photo)", memory.status, 201);
  const item = await lou.call("POST", `${T}/collage/share/${shareId}/item?idx=0&kind=photo&mime=image/jpeg&w=10&h=10&memory=mem-board`, jpegOfSize(10 * KB, 4), { headers: { "Content-Type": "image/jpeg" } });
  t.same("a photograph on the board counts too, and records the memory it came from",
    [item.status, (await meter()).used - before, server.sql(`SELECT memory_id FROM collage_share_items WHERE share_id = '${shareId}'`)[0]?.memory_id], [200, 30 * KB, "mem-board"]);
  const wrongMemory = await lou.call("POST", `${T}/collage/share/${shareId}/item?idx=1&kind=photo&mime=image/jpeg&memory=nope`, jpegOfSize(KB, 4), { headers: { "Content-Type": "image/jpeg" } });
  t.same("  (a memory that isn't the trip's is refused)", wrongMemory.status, 400);
  t.same("the board's page answers", (await fetch(`${server.origin}/s/${shareId}`)).status, 200);
  const gone = await lou.call("DELETE", `${T}/memories/mem-board`);
  t.same("deleting the memory takes it out of every board it is on: the board is unshared, its files freed",
    [gone.status, gone.json?.boards_unshared, (await meter()).used - before + 40 * KB], [200, 1, 0]);
  t.same("  (the board's page no longer answers, and its files are queued for the drain)",
    [(await fetch(`${server.origin}/s/${shareId}`)).status, server.sql(`SELECT COUNT(*) AS n FROM files_to_delete WHERE r2_key LIKE 'shares/${shareId}%'`)[0].n], [404, 2]);
  const second = await mo.call("POST", `${T}/collage/share?mime=image/jpeg&w=10&h=10&title=Mo`, Buffer.alloc(5 * KB, 3), { headers: { "Content-Type": "image/jpeg" } });
  t.same("only a board's maker or the host revokes it", (await del(lou, `${T}/collage/share/${second.json.share.id}`)).status, 403);
  const revoked = await del(kit, `${T}/collage/share/${second.json.share.id}`);
  t.same("the host revokes it: its files go, and what it held is free", [revoked.status, revoked.json?.revoked, (await (async () => (await meter()).used)()) === before - 40 * KB], [200, true, true]);
  t.same("  (revoking it again changes nothing)", (await del(kit, `${T}/collage/share/${second.json.share.id}`)).json?.revoked, false);

  // A board's page draws a tile at the photograph's own thumbnail when it needs no more (migration
  // 0026): the item keeps the thumbnail of the media the app names at share time. An app that
  // names none (today's, and every board already shared) gets the original. No size 404s.
  const small = Buffer.alloc(2 * KB, 6);
  const upT = await lou.post(`${T}/media/begin`, { name: "large.jpg", mime: "image/jpeg", bytes: small.length, kind: "photo" });
  const partT = await lou.call("PUT", `${T}/media/part?key=${encodeURIComponent(upT.json.key)}&id=${encodeURIComponent(upT.json.uploadId)}&n=1`, small, { headers: { "Content-Type": "application/octet-stream" } });
  await lou.post(`${T}/media/finish`, { key: upT.json.key, id: upT.json.uploadId, parts: [{ n: 1, etag: partT.json?.etag }] });
  const thumbMemory = await lou.post(`${T}/memories`, { id: "mem-thumb", caption: "Small and large", media: [{ key: upT.json.key, w: 4000, h: 3000 }] });
  const mediaId = server.sql("SELECT id FROM memory_media WHERE memory_id = 'mem-thumb'")[0]?.id;
  const thumbFile = path.join(server.work, "thumb.webp");
  fs.writeFileSync(thumbFile, Buffer.alloc(777, 9));
  const thumbKey = `o/zz/planted/thumb-${process.pid}.webp`;
  server.put("wegoplace-media", thumbKey, thumbFile);
  server.sql(`UPDATE memory_media SET thumb_key = '${thumbKey}' WHERE id = '${mediaId}'`);
  const tb = await lou.call("POST", `${T}/collage/share?mime=image/jpeg&w=10&h=10&title=Thumbs`, Buffer.alloc(KB, 3), { headers: { "Content-Type": "image/jpeg" } });
  const tbId = tb.json?.share?.id;
  const send = (idx, extra) => lou.call("POST", `${T}/collage/share/${tbId}/item?idx=${idx}&kind=photo&mime=image/jpeg&w=4000&h=3000${extra}`, jpegOfSize(3 * KB, 4), { headers: { "Content-Type": "image/jpeg" } });
  const withMedia = await send(0, `&memory=mem-thumb&media=${encodeURIComponent(mediaId)}`);
  const without = await send(1, "&memory=mem-thumb");
  const noMemory = await send(2, `&media=${encodeURIComponent(mediaId)}`);
  const notItsOwn = await send(3, "&memory=mem-thumb&media=nope");
  t.same("a photograph shared with its media id keeps that photograph's thumbnail; one shared without keeps none (as every board before this)",
    [thumbMemory.status, withMedia.status, without.status, server.sql(`SELECT idx, thumb_key FROM collage_share_items WHERE share_id = '${tbId}' ORDER BY idx`).map((r) => [r.idx, r.thumb_key])],
    [201, 200, 200, [[0, thumbKey], [1, ""]]]);
  t.same("  (a media id without its memory, or one that isn't the memory's, is refused, saying so)",
    [noMemory.status, noMemory.json?.error, notItsOwn.status, notItsOwn.json?.error], [400, "media without its memory", 400, "no such media"]);
  const boardPage = await (await fetch(`${server.origin}/s/${tbId}`)).text();
  const tileTag = (i) => (boardPage.match(new RegExp(`<button class="tile" data-i="${i}"[^>]*>`, "s")) ?? [""])[0];
  t.same("the board's page marks the tile that has a thumbnail, and only that one", [/data-thumb="1"/.test(tileTag(0)), /data-thumb/.test(tileTag(1)), tileTag(1) !== ""], [true, false, true]);
  const got = async (p) => { const r = await fetch(`${server.origin}/s/${tbId}${p}`); return [r.status, (await r.arrayBuffer()).byteLength]; };
  t.same("the thumbnail is served at /i/<n>/thumb; an item without one serves its original there; an old size's address serves the original; nothing 404s",
    [await got("/i/0/thumb"), await got("/i/1/thumb"), await got("/i/0/lod/640"), await got("/i/0")], [[200, 777], [200, 3 * KB], [200, 3 * KB], [200, 3 * KB]]);
  await del(lou, `${T}/collage/share/${tbId}`);
  await lou.call("DELETE", `${T}/memories/mem-thumb`);
  fs.rmSync(thumbFile, { force: true });

  // ── which boards show what, and why one stopped ─────────────────────────────────────────
  t.part("Shared boards: who made each, which memories it shows, and why it stopped");
  const shares = async (p) => (await p.get(`${T}/collage/shares`)).json?.shares ?? [];
  const byId = async (p, id) => (await shares(p)).find((x) => x.id === id);
  t.same("a board the host revoked says so, to everyone on the trip: who made it, when it stopped, and why",
    await (async () => { const x = await byId(lou, second.json.share.id); return [x?.created_by, Number.isInteger(x?.revoked_at), x?.revoked_why, x?.memories]; })(),
    [mo.user.id, true, "host", []]);
  // Lou's memory, with a photograph of her own; Mo's board shows it.
  const shot = Buffer.alloc(6 * KB, 2);
  const mine = await begin(lou, T, shot.length, "square.jpg");
  const minePart = await lou.call("PUT", `${T}/media/part?key=${encodeURIComponent(mine.json.key)}&id=${encodeURIComponent(mine.json.uploadId)}&n=1`, shot, { headers: { "Content-Type": "application/octet-stream" } });
  await lou.post(`${T}/media/finish`, { key: mine.json.key, id: mine.json.uploadId, parts: [{ n: 1, etag: minePart.json?.etag }] });
  const louMemory = await lou.post(`${T}/memories`, { id: "mem-square", caption: "The square", media: [{ key: mine.json.key, w: 10, h: 10 }] });
  t.same("  (Lou has a memory; it is on no board yet)", [louMemory.status, (await lou.get(`${T}/memories/mem-square`)).json?.memory?.boards], [201, 0]);
  const mosBoard = await mo.call("POST", `${T}/collage/share?mime=image/jpeg&w=10&h=10&title=Square`, Buffer.alloc(3 * KB, 3), { headers: { "Content-Type": "image/jpeg" } });
  const onIt = await mo.call("POST", `${T}/collage/share/${mosBoard.json?.share?.id}/item?idx=0&kind=photo&mime=image/jpeg&w=10&h=10&memory=mem-square`, jpegOfSize(KB, 4), { headers: { "Content-Type": "image/jpeg" } });
  t.same("  (Mo shares a board showing a photograph from it)", [mosBoard.status, onIt.status], [201, 200]);
  t.same("Lou's memory says it is on one shared board, in the feed and on its own, before she deletes it",
    [(await lou.get(`${T}/memories/mem-square`)).json?.memory?.boards, ((await lou.get(`${T}/memories`)).json?.memories ?? []).find((m) => m.id === "mem-square")?.boards], [1, 1]);
  t.same("the list says who made Mo's board and which memory it shows, and that it is shared",
    await (async () => { const x = await byId(lou, mosBoard.json.share.id); return [x?.created_by, x?.memories, x?.revoked, x?.revoked_at, x?.revoked_why]; })(),
    [mo.user.id, ["mem-square"], false, null, null]);
  await lou.call("DELETE", `${T}/memories/mem-square`);
  t.same("Lou deletes her memory: on Mo's list his board has stopped, because a memory on it was deleted",
    await (async () => { const x = await byId(mo, mosBoard.json.share.id); return [x?.revoked, Number.isInteger(x?.revoked_at), x?.revoked_why, x?.memories]; })(),
    [true, true, "memory", []]);
  const ownBoard = await mo.call("POST", `${T}/collage/share?mime=image/jpeg&w=10&h=10&title=Mine`, Buffer.alloc(2 * KB, 3), { headers: { "Content-Type": "image/jpeg" } });
  await del(mo, `${T}/collage/share/${ownBoard.json.share.id}`);
  t.same("a board its maker revokes says the maker did", (await byId(mo, ownBoard.json.share.id))?.revoked_why, "maker");
  const hostsOwn = await kit.call("POST", `${T}/collage/share?mime=image/jpeg&w=10&h=10&title=Host`, Buffer.alloc(2 * KB, 3), { headers: { "Content-Type": "image/jpeg" } });
  await del(kit, `${T}/collage/share/${hostsOwn.json.share.id}`);
  t.same("the host revoking their own board is its maker revoking it", (await byId(kit, hostsOwn.json.share.id))?.revoked_why, "maker");

  // ── handing the trip over ───────────────────────────────────────────────────────────────
  t.part("Storage: handing a trip over is an offer the other person accepts");
  const offered = await kit.post(`${T}/host`, { to: mo.user.id });
  t.same("the host offers the trip to a member; nothing changes yet", [offered.status, offered.json?.handover?.to, (await kit.get(T)).json.trip.host_id], [201, mo.user.id, kit.user.id]);
  t.same("the member's list of trips shows the offer, without opening the trip", (await mo.get("/api/trips")).json.trips.find((x) => x.id === trip.id)?.offered_to_me?.offered_at > 0, true);
  t.same("and the trip's snapshot carries it", (await lou.get(T)).json.handover?.to, mo.user.id);
  t.same("only the member offered it can accept", [(await lou.post(`${T}/host/accept`)).status, (await lou.post(`${T}/host/accept`)).json?.error], [404, "no offer"]);
  t.same("a member can't offer the trip", (await lou.post(`${T}/host`, { to: lou.user.id })).status, 403);
  const back = await del(kit, `${T}/host`);
  t.same("the host takes it back", [back.json?.withdrawn, (await mo.get("/api/trips")).json.trips.find((x) => x.id === trip.id)?.offered_to_me], [true, null]);
  await kit.post(`${T}/host`, { to: mo.user.id });
  t.same("the member declines", [(await mo.post(`${T}/host/decline`)).status, (await kit.get(T)).json.handover], [200, null]);
  await kit.post(`${T}/host`, { to: lou.user.id });
  await del(lou, `${T}/members/${lou.user.id}`);
  t.same("an offer ends when that member leaves", (await kit.get(T)).json.handover, null);
  // The trip has to fit what the new host may hold. The trip holds a video of 200 KB.
  server.sql(`INSERT INTO media_objects (r2_key, upload_id, user_id, trip_id, role, kind, mime, orig_name, bytes, sha256, state, thumb_for, created_at, stored_at)
    VALUES ('o/zz/planted/trip.mp4', '', '${kit.user.id}', '${trip.id}', 'original', 'video', 'video/mp4', 'trip.mp4', ${200 * KB}, '', 'stored', '', 1, 1)`);
  const mos = await newTrip(mo, { name: "Mo's own" });
  server.sql(`INSERT INTO media_objects (r2_key, upload_id, user_id, trip_id, role, kind, mime, orig_name, bytes, sha256, state, thumb_for, created_at, stored_at)
    VALUES ('o/zz/planted/mo.mp4', '', '${mo.user.id}', '${mos.id}', 'original', 'video', 'video/mp4', 'mo.mp4', ${LIMIT - 100 * KB}, '', 'stored', '', 1, 1)`);
  await kit.post(`${T}/host`, { to: mo.user.id });
  const tooBig = await mo.post(`${T}/host/accept`);
  t.ok("accepting a trip that doesn't fit what the new host may hold is refused, saying how much each holds",
    tooBig.status === 413 && tooBig.json?.error === "storage full" && /doesn't fit/.test(tooBig.json?.reason) && (await kit.get(T)).json.trip.host_id === kit.user.id, tooBig.json);
  server.sql("DELETE FROM media_objects WHERE r2_key = 'o/zz/planted/mo.mp4'");
  const accepted = await mo.post(`${T}/host/accept`);
  t.same("once it fits, accepting makes them the host, and the offer is done",
    [accepted.status, accepted.json?.trip?.host_id, (await mo.get(T)).json.handover, (await mo.get("/api/account/storage")).json.trips.some((x) => x.id === trip.id)], [200, mo.user.id, null, true]);
  t.same("the old host is a member now", (await kit.get("/api/trips")).json.trips.find((x) => x.id === trip.id)?.role, "member");
  const deleteHost = await mo.call("DELETE", "/api/me", { confirm: "delete" });
  t.ok("an account that hosts a trip others are on can't be deleted; the answer names both ways out",
    deleteHost.status === 409 && /Offer it to one of them/.test(deleteHost.json?.reason) && /or delete the trip/.test(deleteHost.json?.reason), deleteHost.json);

  // ── the trip's map ──────────────────────────────────────────────────────────────────────
  t.part("Storage: the trip's own map");
  t.same("a trip with no map says so", [(await kit.get(`${T}/tiles`)).status, (await kit.get(`${T}/tiles`)).json?.error, (await kit.get(T)).json.tiles], [404, "no map", null]);
  const tmp = path.join(server.work, "archive.pmtiles");
  fs.writeFileSync(tmp, Buffer.from(Array.from({ length: 4096 }, (_, i) => i & 255)));
  server.put("wegoplace-tiles", `maps/${trip.id}.pmtiles`, tmp);
  server.sql(`UPDATE trips SET tiles = 'maps/${trip.id}.pmtiles', tiles_state = 'ready', tiles_source = 'set', tiles_version = 'v-hand', tiles_bytes = 4096 WHERE id = '${trip.id}'`);
  const ranged = await kit.call("GET", `${T}/tiles`, null, { headers: { Range: "bytes=10-19" } });
  t.same("the trip's archive is served to its people by range", [ranged.status, ranged.headers.find(([k]) => k === "content-range")?.[1], (await kit.get(T)).json.tiles], [206, "bytes 10-19/4096", { state: "ready", version: "v-hand", bytes: 4096, at: null, source: "set", note: "", glyphs: [], ready: true }]);
  t.same("and to nobody else", (await (await person("Nell Check")).get(`${T}/tiles`)).status, 404);

  // ── deleting a trip, and the drain ──────────────────────────────────────────────────────
  t.part("Storage: deleting a trip, and the drain");
  await mo.post(`${T}/purchases`, { id: "pu-store", description: "Bus", amount_minor: 1000, currency: "EUR", amount_exp: 2, split_mode: "weight", spent_at: 1812153600,
    shares: [{ user_id: mo.user.id, weight: 1, share_minor: 500 }, { user_id: kit.user.id, weight: 1, share_minor: 500 }] });
  t.same("only the host deletes a trip", (await kit.call("DELETE", T, { confirm: "Storage trip" })).status, 403);
  const unconfirmed = await mo.call("DELETE", T, {});
  t.same("without its name typed, nothing goes, and the answer says what would",
    [unconfirmed.status, unconfirmed.json?.error, unconfirmed.json?.need, unconfirmed.json?.goes],
    [400, "confirm", "Storage trip", { members: 2, photos: 0, videos: 1, pictures: 0, receipts: 0, bytes: 200 * KB, boards: 0, purchases: 1, payments: 0, someone_owes: true, map_bytes: 0 }]);
  t.same("a name that isn't it is refused the same way", (await mo.call("DELETE", T, { confirm: "Storage" })).status, 400);
  // A row in every table a trip's rows live in, through the routes, so the delete is held to
  // all of them (tripRows below reads which tables those are from the schema).
  const photo = Buffer.alloc(6 * KB, 9);
  const ph = await begin(mo, T, photo.length, "last.jpg");
  const phPart = await mo.call("PUT", `${T}/media/part?key=${encodeURIComponent(ph.json.key)}&id=${encodeURIComponent(ph.json.uploadId)}&n=1`, photo, { headers: { "Content-Type": "application/octet-stream" } });
  const phDone = await mo.post(`${T}/media/finish`, { key: ph.json.key, id: ph.json.uploadId, parts: [{ n: 1, etag: phPart.json?.etag }] });
  const lastBoard = await mo.call("POST", `${T}/collage/share?mime=image/jpeg&w=10&h=10&title=Last`, Buffer.alloc(2 * KB, 3), { headers: { "Content-Type": "image/jpeg" } });
  const planted = {
    photo: phDone,
    area: await put(mo, `${T}/areas`, { areas: [{ id: "old-town", name: "Old town" }] }),
    place: await put(mo, `${T}/places`, { places: [{ id: "p-cafe", name: "Corner cafe", kind: "food", subkind: "cafe", why: "Breakfast", area: "old-town" }] }),
    event: await mo.post(`${T}/events`, { id: "e-walk", title: "Walk", starts_at: Date.UTC(2027, 5, 2, 10) / 1000, tz: "UTC", place_id: "p-cafe" }),
    note: await mo.post(`${T}/messages`, { id: "n-walk", body: "Bring water", about: { kind: "event", id: "e-walk" } }),
    item: await mo.post(`${T}/packing`, { id: "pk-hat", label: "Hat", bags: { "leaving-home": "main-bag" } }),
    tick: await put(mo, `${T}/packing/ticks`, { item_id: "pk-hat", list_key: "leaving-home", ticked: true }),
    starter: await put(mo, `${T}/packing/starters`, { starters: [{ scope: "person", label: "Passport", category: "documents", bags: { "leaving-home": "on-me" } }] }),
    memory: await mo.post(`${T}/memories`, { id: "mem-last", caption: "Last day", tags: ["walk"], media: [{ key: ph.json.key, w: 10, h: 10 }] }),
    board: lastBoard,
    boardItem: await mo.call("POST", `${T}/collage/share/${lastBoard.json?.share?.id}/item?idx=0&kind=photo&mime=image/jpeg&w=10&h=10&memory=mem-last`, jpegOfSize(KB, 4), { headers: { "Content-Type": "image/jpeg" } }),
    link: await mo.post(`${T}/links`, {}),
    picture: await mo.call("PUT", `${T}/pictures/place/p-cafe?license=own`, png(40, 30), { headers: { "Content-Type": "application/octet-stream" } }),
    pictureLink: await mo.post(`${T}/pictures/event/e-walk/upload-link`, { license: "own" }),
    offer: await mo.post(`${T}/host`, { to: kit.user.id }),
    message: await mo.post(`${T}/messages`, { id: "m-walk", body: "Who's coming?", about: { kind: "event", id: "e-walk" } }),
    reference: await mo.post(`${T}/references`, { id: "rf-numbers", title: "Emergency numbers", body: "112" }),
  };
  t.ok("  (planted through the routes: a photo, an area, a place, an event and its note, a packed and ticked item, a starter, a memory with a tag, a board with a photograph, a link, an offer, a place's picture, an upload link for an event's, a message about the walk, a quick reference item)",
    Object.values(planted).every((r) => r.status >= 200 && r.status < 300), Object.fromEntries(Object.entries(planted).map(([k, r]) => [k, r.status])));
  // A change an AI made, the row it recorded, and a picture it holds for its undo: only the MCP
  // makes these (check:mcp, through its tools), so they are planted here by hand.
  const heldKey = server.sql(`SELECT r2_key FROM pictures WHERE trip_id = '${trip.id}' LIMIT 1`)[0]?.r2_key;
  server.sql(`INSERT INTO trip_changes (id, trip_id, user_id, source, summary, kind, rev, created_at) VALUES ('ch-planted', '${trip.id}', '${mo.user.id}', 'oauth:Check App', 'Planted', 'write', 1, 1)`);
  server.sql(`INSERT INTO trip_change_rows (change_id, tbl, row_key, before, after) VALUES ('ch-planted', 'places', '["${trip.id}","p-cafe"]', NULL, '{}')`);
  server.sql(`INSERT INTO files_held (r2_key, trip_id, change_id, held_at) VALUES ('${heldKey}', '${trip.id}', 'ch-planted', 1)`);
  // What went, for a phone asking since its last (0036): an area added and deleted through the routes leaves its line;
  // a trip's floor is written only by the migration and the drain, so it's planted by hand.
  await put(mo, `${T}/areas`, { areas: [{ id: "a-gone", name: "Gone" }] });
  t.same("  (an area added and deleted through the routes, for what went)", (await mo.call("DELETE", `${T}/areas/a-gone`)).status, 200);
  server.sql(`INSERT INTO trip_delta_floor (trip_id, rev) VALUES ('${trip.id}', 0)`);
  // The assistant's (model §20): a conversation with a turn and a document, an ask running, and a call in the host's ledger.
  // Only the assistant writes these (check:assistant-talk, through its routes), so they're planted by hand.
  server.sql(`INSERT INTO ai_conversations (id, trip_id, user_id, title, created_at, updated_at) VALUES ('c-planted', '${trip.id}', '${mo.user.id}', 'Planted', 1, 1)`);
  server.sql(`INSERT INTO ai_turns (user_id, conversation_id, id, seq, role, words, created_at) VALUES ('${mo.user.id}', 'c-planted', 't-planted', 1, 'person', 'Planted', 1)`);
  server.sql(`INSERT INTO ai_asks (trip_id, ask_id, user_id, started_at, busy_until) VALUES ('${trip.id}', 'a-planted', '${mo.user.id}', 1, 1)`);
  // A document given the assistant on that conversation (0045): its original and its text, both to the drain with the trip.
  server.sql(`INSERT INTO ai_files (user_id, id, trip_id, conversation_id, name, mime, bytes, text_reserve, text_bytes, text_chars, r2_key, text_key, state, created_at)
    VALUES ('${mo.user.id}', 'f-planted', '${trip.id}', 'c-planted', 'plan.txt', 'text/plain', 12, 0, 12, 12, 'assistant/planted/f', 'assistant/planted/f.txt', 'ready', 1)`);
  server.sql(`INSERT INTO ai_calls (id, host_id, trip_id, user_id, month, feature, state, worst, cost, started_at, busy_until, model) VALUES ('call-planted', '${mo.user.id}', '${trip.id}', '${mo.user.id}', '2027-06', 'ask', 'settled', 10, 7, 1, 1, 'm')`);
  const tripsRows = tripRows(server, trip.id);
  t.ok("before the delete, every table the schema says holds a trip's rows holds some of this one's (a new table fails here until this check plants a row in it)",
    tripsRows.unknown.length === 0 && Object.values(tripsRows.rows).every((ids) => ids.length > 0),
    { empty: Object.entries(tripsRows.rows).filter(([, ids]) => !ids.length).map(([name]) => name), unknown: tripsRows.unknown });
  const keysBefore = queued();
  const deleted = await mo.call("DELETE", T, { confirm: "  Storage trip " });
  t.same("its name, typed with spaces around it, deletes it: every file queued for the drain", [deleted.status, deleted.json?.deleted, queued() - keysBefore], [200, true, deleted.json?.files]);
  const { ai_calls: ledger = 0, ...left } = rowsStill(server, tripsRows.rows);
  t.same(`nothing of it is left in any of the ${Object.keys(tripsRows.rows).length} tables (${Object.keys(tripsRows.rows).join(", ")})`, left, {});
  t.same("  but the assistant's ledger, kept for the host's month without the trip (deleting a trip doesn't hand back what it cost); its conversations' turns gone too",
    [ledger, server.sql("SELECT trip_id, cost FROM ai_calls WHERE id = 'call-planted'")[0], server.sql("SELECT COUNT(*) AS n FROM ai_turns WHERE conversation_id = 'c-planted'")[0].n], [1, { trip_id: "", cost: 7 }, 0]);
  t.same("asking for it afterwards answers exactly as a trip you aren't on", [(await kit.get(T)).status, (await kit.get(T)).text], [404, await noSuchTrip().text()]);
  t.same("it holds nothing now", (await mo.get("/api/account/storage")).json.trips.some((x) => x.id === trip.id), false);
  await drainRun();
  t.same("the drain removes the queued files", queued(), 0);
  t.same("  (the stored photo is out of the bucket)", server.has("wegoplace-media", up.json.key), false);
  // A file that keeps failing stays, counted, for a person to look at.
  server.sql(`INSERT INTO files_to_delete (bucket, r2_key, upload_id, queued_at) VALUES ('media', '${"x".repeat(1100)}', NULL, 1)`);
  for (let i = 0; i < 10; i++) await drainRun();
  t.same("a file that fails ten runs stays, with its error", server.sql("SELECT attempts, last_error IS NOT NULL AS why FROM files_to_delete")[0], { attempts: 10, why: 1 });
  t.ok("and every run says how many have stopped", /files_to_delete: 1 file\(s\) failed 10 runs/.test(server.log()));
  server.sql("DELETE FROM files_to_delete");
}

/**
 * Every row of a trip, table by table, found from the schema and not from a list: the trip's
 * own row; every row of a table with a `trip_id` column; and, following the declared foreign
 * keys, every row hanging off one of those (a board's photographs, a purchase's shares, a
 * memory's media and tags), however deep. Answers { rows: { table: [rowid…] }, unknown }, where
 * `unknown` names what this can't follow: a column that names a trip some other way, or a table
 * without rowids.
 */
function tripRows(server, tripId) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const tables = server.sql(`SELECT m.name, m.sql,
      (SELECT json_group_array(name) FROM pragma_table_info(m.name)) AS cols,
      (SELECT json_group_array(json_object('parent', "table", 'from', "from", 'to', "to")) FROM pragma_foreign_key_list(m.name)) AS fks
    FROM sqlite_master m WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%' AND m.name NOT LIKE 'd1_%'`)
    .map((r) => ({ name: r.name, sql: r.sql, cols: JSON.parse(r.cols), fks: JSON.parse(r.fks) }));
  const unknown = [];
  const select = new Map([["trips", `SELECT rowid FROM trips WHERE id = ${q(tripId)}`]]);
  for (const tb of tables) {
    if (/WITHOUT\s+ROWID/i.test(tb.sql)) unknown.push(`${tb.name}: no rowids`);
    if (tb.cols.includes("trip_id")) select.set(tb.name, `SELECT rowid FROM "${tb.name}" WHERE trip_id = ${q(tripId)}`);
    for (const c of tb.cols) if (/trip/i.test(c) && c !== "trip_id" && tb.name !== "trips") unknown.push(`${tb.name}.${c}`);
  }
  // Tables hanging off the trip's, through their declared keys, until nothing new turns up.
  for (let grew = true, round = 0; grew && round < 10; round++) {
    grew = false;
    for (const tb of tables) {
      if (select.has(tb.name)) continue;
      const ways = tb.fks.filter((f) => select.has(f.parent) && f.to);
      if (!ways.length) continue;
      select.set(tb.name, ways.map((f) => `SELECT rowid FROM "${tb.name}" WHERE "${f.from}" IN (SELECT "${f.to}" FROM "${f.parent}" WHERE rowid IN (${select.get(f.parent)}))`).join(" UNION "));
      grew = true;
    }
  }
  const names = [...select.keys()];
  const row = server.sql(`SELECT ${names.map((n, i) => `(SELECT json_group_array(rowid) FROM (${select.get(n)})) AS c${i}`).join(", ")}`)[0];
  return { rows: Object.fromEntries(names.map((n, i) => [n, JSON.parse(row[`c${i}`])])), unknown };
}

/** Of the rows tripRows found, those still there: { table: count }, only the tables with some. */
function rowsStill(server, rows) {
  const names = Object.keys(rows).filter((n) => rows[n].length);
  const row = server.sql(`SELECT ${names.map((n, i) => `(SELECT COUNT(*) FROM "${n}" WHERE rowid IN (SELECT value FROM json_each('${JSON.stringify(rows[n])}'))) AS c${i}`).join(", ")}`)[0];
  return Object.fromEntries(names.map((n, i) => [n, row[`c${i}`]]).filter(([, n]) => n > 0));
}

