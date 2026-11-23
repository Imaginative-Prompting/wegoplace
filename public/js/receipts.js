// A purchase's receipt: its picture, taken or picked while the purchase is added or changed
// (model §17). It is one kind of picture made on this phone (picture-make.js) and held until its
// purchase is on the server (picture-wait.js, kind "purchase"): this file is what Split asks of it,
// in a receipt's words. A payment has no receipt.
//
// The server's side: PUT /api/trips/<trip>/pictures/purchase/<id>?license=own with the bytes
// (src/trips/pictures.js), DELETE the same address to remove it.

import { PICTURE_LIMITS } from "./shared/limits.js";
import { makePicture } from "./picture-make.js";
import * as wait from "./picture-wait.js";

const target = (id) => ({ kind: "purchase", id });

/** A picked file -> { blob, w, h } at the receipt's size, or throws an Error whose message can be shown. */
export const makeReceipt = (file, limits = PICTURE_LIMITS.receipt) => makePicture(file, limits);

/** Starts the waiting pictures for a trip's store: reads what waits, and sends it whenever there is signal. */
export const start = (store) => wait.start(store);

/** Calls fn whenever what waits changes. Answers the unsubscribe. */
export const onChange = (fn) => wait.on("change", fn);

/**
 * A purchase's receipt as this phone sees it:
 *   { state: "waiting", url, w, h } a picture not yet on the server (url: on this phone)
 *   { state: "refused", url, w, h, reason, status } the server said no, and why (its HTTP status)
 *   { state: "removing" } removed here, not yet on the server
 *   { state: "stored", url, w, h } on the server (the purchase's own `receipt`)
 *   null: none
 */
export function receiptOf(purchase) {
  if (!purchase) return null;
  const here = wait.waitingFor(target(purchase.id));
  if (here) return here;
  const s = purchase.receipt;
  return s && s.url ? { state: "stored", url: s.url, w: s.width, h: s.height } : null;
}

/** How many pictures wait on this phone for this trip (receipts and every other kind). */
export const waitingCount = () => wait.waitingCount();

/** Holds a made picture as purchase `id`'s receipt, and sends it when it can (the save doesn't wait for it). */
export async function hold(id, made) {
  await wait.holdMade(target(id), made, { wait: false });
}

/** Removes purchase `id`'s receipt: one waiting here goes at once; one on the server goes when there is signal. */
export const remove = (id, { onServer }) => wait.removePicture(target(id), { onServer });

/** The purchase itself was deleted: whatever waits for it goes (the server takes a stored receipt with the purchase). */
export const purchaseGone = (id) => wait.rowGone(target(id));

/** Sends what waits. Answers how many still wait (refused ones not counted). */
export const sendWaiting = () => wait.sendWaiting();

/** For the checks: the receipts this phone holds, without the pictures. */
export const receiptsState = () => {
  const st = wait.pictureWaitState();
  return { trip: st.trip, held: st.held.filter((r) => r.kind === "purchase").map(({ id, op, bytes, w, h, refused }) => ({ id, op, bytes, w, h, refused })) };
};
