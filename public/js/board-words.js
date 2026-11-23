// What the app says about a trip's shared boards. Words only: no document, no network, so the
// same sentences can be read by a check without a browser.
//
// A shared board is a link anyone can open. It stops when its maker stops it, when the trip's
// host stops it, or when a memory shown on it is deleted. The server says which
// (`revoked_why`: "maker", "host", "memory", or null for a board stopped before it kept why).

/**
 * Said in the delete sheet BEFORE a memory goes, when live boards show it.
 * @param {number} n  how many live boards show one of its photographs
 * @returns {string}  "" when none do
 */
export function boardsWarning(n) {
  const k = Math.floor(Number(n));
  if (!(k > 0)) return "";
  return k === 1
    ? "A shared board shows this. Deleting it stops that board's link."
    : `${k} shared boards show this. Deleting it stops their links.`;
}

/**
 * Said AFTER a memory went, when boards went with it.
 * @param {number} n  how many boards stopped being shared
 * @returns {string}  "" when none did
 */
export function boardsUnshared(n) {
  const k = Math.floor(Number(n));
  if (!(k > 0)) return "";
  return k === 1
    ? "Deleted. A shared board showed it, and that board's link no longer opens."
    : `Deleted. ${k} shared boards showed it, and their links no longer open.`;
}

/**
 * Who a board's line is about, as the reader sees them.
 * @param {string} id        an account id
 * @param {{ me: string, nameOf: (id: string) => string }} who
 */
export function boardMaker(id, { me, nameOf }) {
  if (id && id === me) return "You";
  return (id && nameOf(id)) || "Someone who has left";
}

/**
 * One line on whether a board's link opens, and when it doesn't, why.
 * @param {{ created_by: string, revoked: boolean, revoked_why: string|null }} share
 * @param {{ me: string, hostId: string, nameOf: (id: string) => string, day: string }} ctx
 *        `day` is the day it stopped, already formatted ("" when the server kept none)
 */
export function boardState(share, { me, hostId, nameOf, day }) {
  if (!share.revoked) return "Anyone with the link can open it.";
  const on = day ? ` on ${day}` : "";
  switch (share.revoked_why) {
    case "memory":
      return `Its link stopped${on}: a memory on it was deleted.`;
    case "maker":
      return share.created_by === me
        ? `You stopped sharing it${on}.`
        : `${boardMaker(share.created_by, { me, nameOf })} stopped sharing it${on}.`;
    case "host":
      return hostId && hostId === me
        ? `You stopped it${on}, as the trip's host.`
        : `The trip's host stopped it${on}.`;
    default:
      return `Its link stopped${on}.`;
  }
}

/**
 * May this person stop a board? Its maker, or the trip's host. The server decides; this is
 * only whether the button is offered.
 */
export function mayStopBoard(share, { me, hostId }) {
  if (!share || share.revoked || !me) return false;
  return share.created_by === me || (!!hostId && hostId === me);
}
