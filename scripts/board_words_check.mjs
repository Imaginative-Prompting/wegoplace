#!/usr/bin/env node
/* What the app says about shared boards (public/js/board-words.js). No browser, no server:
 *   node scripts/board_words_check.mjs
 *
 * WHAT IT PROVES
 *   - Before a delete: nothing for a memory on no board, one sentence for one board, the number
 *     for several; a count that isn't a number says nothing.
 *   - After a delete: the same three cases, from the server's `boards_unshared`.
 *   - A board's line: a live board says anyone with the link can open it; a stopped one says
 *     why, to its maker, to another member and to the host, for each reason the server gives
 *     ("maker", "host", "memory") and for a board stopped before reasons were kept; the day is
 *     left out when the server kept none.
 *   - Who is offered "Stop sharing": the board's maker and the trip's host, never anyone else,
 *     never on a board that already stopped.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = await import(path.join(REPO, "public/js/board-words.js"));

let pass = 0, fail = 0;
const failures = [];
function check(name, got, want) {
  const ok = got === want;
  if (ok) { pass++; console.log(`  ok    ${name}   — ${JSON.stringify(got)}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}   -> got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); }
}

const names = { "u-host": "Mara Voss", "u-maker": "Teo Lind", "u-other": "Ines Brandt" };
const nameOf = (id) => names[id] || "";
const as = (me, day = "Sat Nov 14") => ({ me, hostId: "u-host", nameOf, day });
const board = (why, revoked = true) => ({ id: "b1", created_by: "u-maker", revoked, revoked_why: why });

console.log("\nbefore a memory is deleted");
check("on no board", W.boardsWarning(0), "");
check("no count at all", W.boardsWarning(undefined), "");
check("not a number", W.boardsWarning("many"), "");
check("one board", W.boardsWarning(1), "A shared board shows this. Deleting it stops that board's link.");
check("three boards", W.boardsWarning(3), "3 shared boards show this. Deleting it stops their links.");

console.log("\nafter it is deleted");
check("no board went", W.boardsUnshared(0), "");
check("no count", W.boardsUnshared(null), "");
check("one board went", W.boardsUnshared(1), "Deleted. A shared board showed it, and that board's link no longer opens.");
check("two boards went", W.boardsUnshared(2), "Deleted. 2 shared boards showed it, and their links no longer open.");

console.log("\nwho made a board");
check("the reader", W.boardMaker("u-maker", as("u-maker")), "You");
check("another member", W.boardMaker("u-maker", as("u-other")), "Teo Lind");
check("someone no longer on the roster", W.boardMaker("u-gone", as("u-other")), "Someone who has left");

console.log("\na board's line");
check("live", W.boardState(board(null, false), as("u-other")), "Anyone with the link can open it.");
check("a memory on it was deleted", W.boardState(board("memory"), as("u-maker")), "Its link stopped on Sat Nov 14: a memory on it was deleted.");
check("its maker stopped it, read by its maker", W.boardState(board("maker"), as("u-maker")), "You stopped sharing it on Sat Nov 14.");
check("its maker stopped it, read by someone else", W.boardState(board("maker"), as("u-other")), "Teo Lind stopped sharing it on Sat Nov 14.");
check("the host stopped it, read by the host", W.boardState(board("host"), as("u-host")), "You stopped it on Sat Nov 14, as the trip's host.");
check("the host stopped it, read by its maker", W.boardState(board("host"), as("u-maker")), "The trip's host stopped it on Sat Nov 14.");
check("stopped before reasons were kept", W.boardState(board(null), as("u-maker")), "Its link stopped on Sat Nov 14.");
check("no day kept", W.boardState(board("memory"), as("u-maker", "")), "Its link stopped: a memory on it was deleted.");
check("a reason this app doesn't know", W.boardState(board("something new"), as("u-maker")), "Its link stopped on Sat Nov 14.");

console.log("\nwho is offered Stop sharing");
check("its maker", W.mayStopBoard(board(null, false), as("u-maker")), true);
check("the trip's host", W.mayStopBoard(board(null, false), as("u-host")), true);
check("another member", W.mayStopBoard(board(null, false), as("u-other")), false);
check("nobody, once it has stopped", W.mayStopBoard(board("maker"), as("u-maker")), false);
check("nobody signed in", W.mayStopBoard(board(null, false), { me: "", hostId: "u-host" }), false);
check("a trip whose host isn't known yet", W.mayStopBoard(board(null, false), { me: "u-other", hostId: "" }), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
