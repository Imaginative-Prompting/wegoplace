// HOW WE KNOW IT BROKE: the pages' error reports and the Worker's own (src/errors.js, public/js/shared/error-clean.js,
// public/js/error-report.js), and the site owner's page of them (src/admin/errors.js). First the cleaning, on its own;
// then a server of its own (ERROR_PROBE on, so an address throws and the cron can be run with a job that fails):
// reports signed out and signed in, what is kept of them (nothing of a trip or a person: check:privacy reads those
// lines), the Worker's own errors, the cron's, the 30-day sweep, and the owner's page, absent for everyone until
// ADMIN_ACCOUNTS names someone. Everyone in it is made up.
//
//   node checks/errors/run.mjs [--port <n>]   (a free port when not named)

import { CheckError, startServer, freePort } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { cleanMessage, cleanReport, placeOf, withoutWords } from "../../public/js/shared/error-clean.js";

const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : await freePort());
const t = new Report("how we know it broke");

const TRIP = "Lagoon Weekend Planted";
const HOST = "Ines Planted";
const MEMBER = "Oskar Planted";

/** Whether a kept group carries any of these words, or a trip's id, an address, a quote's inside, a long number. */
const carries = (row, words, ids) => {
  const text = `${row.message}\n${row.stack}\n${row.place}`;
  return words.some((w) => text.toLowerCase().includes(w.toLowerCase())) || ids.some((id) => text.includes(id)) || /@\w+\.\w|\d{5,}/.test(text);
};

let server, code = 1;
try {
  // ── the cleaning, on its own ──
  t.part("What a report keeps, cleaned on the page and again on the server");
  t.same("a message's quoted words, links, addresses, long numbers and tokens are taken out; code's own words stay",
    cleanMessage(`Cannot read properties of undefined (reading 'length') for "${TRIP}" at https://wegoplace.com/t/abc/#/p/x mail ${HOST.split(" ")[0].toLowerCase()}@mail.example.org id 1234567 tok AbCdEf0123456789XyZw99`),
    "Cannot read properties of undefined (reading 'length') for \"…\" at [link] mail [email] id # tok …");
  t.same("where: the page and the screen by their patterns, never an id", [
    placeOf("/t/k3x9q2/#/e/ev-12"), placeOf("/t/k3x9q2/#/p/fonda-la-paz"), placeOf("/t/k3x9q2/#/split/pu-9"), placeOf("/t/k3x9q2/#/chat/assistant/cv-1"),
    placeOf("/t/k3x9q2/#/settings/credits"), placeOf("/join/AbCdEf123"), placeOf("/trips"), placeOf("/t/k3x9q2/?x=1#/map"),
  ], ["/t/:trip/#/e/:id", "/t/:trip/#/p/:id", "/t/:trip/#/split/:id", "/t/:trip/#/chat/assistant/:id", "/t/:trip/#/settings/credits", "/join/:id", "/trips", "/t/:trip/#/map"]);
  t.same("words taken out wherever they stand, quoted or not, case aside, longest first",
    withoutWords(`no plan for ${TRIP} by ines planted and Oskar Planted`, [TRIP, HOST, MEMBER, "Ines"]), "no plan for … by … and …");
  const page = cleanReport({ kind: "error", name: "TypeError", message: "x is not a function", stack: "TypeError: x\n    at go (https://wegoplace.com/t/k3x9q2/:120:9)\n    at run (https://wegoplace.com/js/agenda.js?v=3:44:2)", place: "/t/k3x9q2/#/e/ev-1", version: "v99" });
  t.same("a page's inline script and our own module are its frames, each by its pattern; the screen too", [page?.stack, page?.place], ["go (/t/:trip/:120:9)\nrun (/js/agenda.js:44:2)", "/t/:trip/#/e/:id"]);
  t.same("an error only in someone else's script (an extension's) isn't kept",
    cleanReport({ kind: "error", message: "boom", stack: "Error: boom\n    at x (chrome-extension://abc/content.js:1:1)" }), null);
  t.same("a sync that keeps failing: fixed words, its status and tries, nothing it was sending",
    cleanReport({ kind: "sync", status: 503, tries: 5, message: `sending ${TRIP}`, place: "/t/k3x9q2/#/pack" })?.message, "Changes kept failing to send: 5 tries in a row, the last answered 503.");

  // ── a server of its own ──
  server = await startServer({ name: "errors", port, vars: { ERROR_PROBE: "on" } });
  await server.start();
  const o = server.origin;
  const rows = () => server.sql("SELECT * FROM error_groups ORDER BY first_seen");
  const report = (who, body, headers = {}) => who.call("POST", "/api/errors", body, { headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", ...headers } });

  const host = new Person(o, HOST);
  await host.signUp();
  const member = new Person(o, MEMBER);
  await member.signUp();
  const trip = (await host.post("/api/trips", { name: TRIP, default_tz: "UTC" })).json.trip.id;
  const link = (await host.post(`/api/trips/${trip}/links`, { uses: 1 })).json.link.code;
  await member.post(`/api/join/${link}`);
  const stranger = new Person(o, "Nobody Signed In");

  t.part("A page's report, signed out and signed in");
  const out = await report(stranger, { kind: "error", name: "TypeError", message: "sign-in broke", stack: "TypeError: x\n    at go (https://wegoplace.com/js/auth.js:10:2)", place: "/login", version: "v99" });
  t.same("signed out: taken, and kept, its browser by name and major version only; the page told its kind's fingerprint (200 { group }), that row's",
    [out.status, rows().find((r) => r.message === "sign-in broke")?.browser, rows().find((r) => r.message === "sign-in broke")?.fingerprint === out.json?.group], [200, "Safari 18 · iOS", true]);
  // Ben's page sends what a careless line of ours could: the trip's name and the people's, unquoted, an address, a long
  // number, the trip's id in its frames and its screen.
  const leaky = { kind: "rejection", name: "Error", message: `no stop for ${TRIP} with ${HOST} and ${MEMBER.toLowerCase()} mail ${"oskar"}@planted.example.org 4412345678`,
    stack: `Error: x\n    at plan (https://wegoplace.com/t/${trip}/:88:3)\n    at go (https://wegoplace.com/js/agenda.js:10:2)`, place: `/t/${trip}/#/e/ev-77`, version: "v99" };
  const signedIn = await report(member, leaky);
  const kept = rows().find((r) => r.kind === "rejection");
  t.same("signed in: taken, and kept", [signedIn.status, !!kept, kept?.fingerprint === signedIn.json?.group], [200, true, true]);
  t.ok("an error report keeps nothing of a trip or a person: no trip's or person's name, no address, no long number, no trip's id, where only as a pattern",
    !!kept && !carries(kept, [TRIP, HOST, MEMBER], [trip]), JSON.stringify(kept));
  t.ok("  (planted: a kept report carrying the trip's name is caught by the same reading)", carries({ ...kept, message: `${kept?.message} ${TRIP}` }, [TRIP, HOST, MEMBER], [trip]));
  // A shared board's page, read by a stranger: the server knows its trip from the page's address (the report's Referer)
  // and takes out the board's title, the trip's name and its people's, as for a signed-in reporter.
  const BOARD = "Sunset Pier Planted Board";
  const share = (await host.call("POST", `/api/trips/${trip}/collage/share?mime=image/jpeg&w=10&h=10&title=${encodeURIComponent(BOARD)}`, Buffer.alloc(2048, 3), { headers: { "Content-Type": "image/jpeg" } })).json;
  const boardId = share?.id ?? share?.share?.id ?? /\/s\/([a-f0-9]{32})/.exec(JSON.stringify(share))?.[1];
  const fromBoard = { kind: "error", name: "TypeError", message: `no frame for ${BOARD} on ${TRIP}, made by ${HOST}`, stack: `TypeError: x\n    at draw (https://wegoplace.com/s/${boardId}/:40:2)`, place: `/s/${boardId}/`, version: "v99" };
  const boardReport = await report(stranger, fromBoard, { Referer: `${o}/s/${boardId}/` });
  const boardKept = rows().find((r) => r.message.startsWith("no frame for"));
  t.ok("a shared board's page, signed out: the board's title, its trip's name and its people's taken out; where only as /s/:id",
    boardReport.status === 200 && !!boardKept && !carries(boardKept, [BOARD, TRIP, HOST], [boardId, trip]) && boardKept.place === "/s/:id/", JSON.stringify(boardKept ?? share));
  // The page says which board it is (error-report.js sends its share id beside the report): with no Referer at all, as a
  // referrer policy may leave it, the board's words still go.
  const noReferer = await report(stranger, { ...fromBoard, message: `no picture for ${BOARD} on ${TRIP}, made by ${HOST}`, board: boardId });
  const noRefererKept = rows().find((r) => r.message.startsWith("no picture for"));
  t.ok("a board's report with no Referer at all, its board named in the report: the same words taken out, and the id never kept",
    noReferer.status === 200 && !!noRefererKept && !carries(noRefererKept, [BOARD, TRIP, HOST], [boardId, trip]), JSON.stringify(noRefererKept));
  const unknownBoard = await report(stranger, { ...fromBoard, message: `no frame for ${BOARD} (control)` });
  t.ok("  (the same report from a page that isn't a board keeps the title: it's the board's own address that tells which words go)",
    unknownBoard.status === 200 && rows().some((r) => r.message.includes(BOARD)));
  server.sql("DELETE FROM error_groups WHERE message LIKE '%(control)%'");
  const again = await report(member, leaky);
  t.same("the same error again is the same kind: one group, counted twice", [again.status, again.json?.group === signedIn.json?.group, rows().filter((r) => r.kind === "rejection").length, rows().find((r) => r.kind === "rejection")?.count], [200, true, 1, 2]);
  const big = await report(stranger, { kind: "error", message: "x".repeat(9000), stack: "Error\n at a (https://wegoplace.com/js/a.js:1:1)" });
  const notJson = await stranger.call("POST", "/api/errors", "not json", { headers: { "Content-Type": "application/json" } });
  t.same("a report over 8 KB is refused (413), and one that isn't JSON (400), each in words", [big.status, typeof big.json?.reason, notJson.status], [413, "string", 400]);
  const elsewhere = await stranger.call("POST", "/api/errors", { kind: "error", message: "x" }, { headers: { Origin: "https://other.check.example" } });
  t.same("from another site's page: refused before it's read (403)", elsewhere.status, 403);

  t.part("The Worker's own errors, and the cron's");
  const thrown = await stranger.call("GET", "/api/__probe/throw");
  const own = rows().find((r) => r.source === "server");
  t.same("an uncaught error in a request: answered 500 in words, and counted where it happened, as a pattern", [thrown.status, typeof thrown.json?.reason, own?.kind, own?.place, /probe/.test(own?.message ?? "")], [500, "string", "exception", "GET /api/*", true]);
  server.sql(`INSERT INTO error_groups (fingerprint, source, kind, name, message, stack, place, version, browser, first_seen, last_seen, count) VALUES
    ('oldoldoldoldold1', 'client', 'error', 'Error', 'planted, last seen 31 days ago', '', '/trips', 'v1', '', ${Date.now() - 40 * 86400e3}, ${Date.now() - 31 * 86400e3}, 3),
    ('newnewnewnewnew1', 'client', 'error', 'Error', 'planted, last seen 29 days ago', '', '/trips', 'v1', '', ${Date.now() - 40 * 86400e3}, ${Date.now() - 29 * 86400e3}, 3)`);
  const cronRun = await stranger.call("GET", "/api/__probe/cron");
  const cronRow = rows().find((r) => r.source === "cron");
  t.same("a cron job that failed is counted by its name; the others ran", [cronRun.status, cronRow?.place, /probe/.test(cronRow?.message ?? "")], [204, "cron probe", true]);
  t.same("a kind not seen for 30 days goes with the cron; one seen 29 days ago stays", [rows().some((r) => r.fingerprint === "oldoldoldoldold1"), rows().some((r) => r.fingerprint === "newnewnewnewnew1")], [false, true]);

  t.part("The site owner's page");
  const absent = [await host.call("GET", "/admin/errors", null, { page: true }), await host.get("/api/admin/errors")];
  t.same("with ADMIN_ACCOUNTS unset, the page and its list don't exist for anyone (404)", absent.map((r) => r.status), [404, 404]);
  const hostId = (await host.me())?.user?.id ?? (await host.me())?.id;
  await server.halt();
  await server.start({ vars: { ADMIN_ACCOUNTS: hostId } });
  const ownerPage = await host.call("GET", "/admin/errors", null, { page: true });
  const ownerList = await host.get("/api/admin/errors");
  t.same("the account it names sees every kind, most often first, with its count, first and last seen, version and browser",
    [ownerPage.status, /What broke/.test(ownerPage.text), /sign-in broke/.test(ownerPage.text), ownerList.status, ownerList.json?.groups?.[0]?.count >= ownerList.json?.groups?.at(-1)?.count, ["first_seen", "last_seen", "version", "browser"].every((k) => k in (ownerList.json?.groups?.[0] ?? {}))],
    [200, true, true, 200, true, true]);
  const memberSees = [await member.call("GET", "/admin/errors", null, { page: true }), await member.get("/api/admin/errors"), await member.post("/api/admin/errors/clear", { fingerprints: [kept?.fingerprint] })];
  t.same("anyone else signed in: 404 everywhere (as an address the site hasn't got), and nothing cleared", [...memberSees.map((r) => r.status), rows().some((r) => r.fingerprint === kept?.fingerprint)], [404, 404, 404, true]);
  const outSees = [await stranger.call("GET", "/admin/errors", null, { page: true }), await stranger.get("/api/admin/errors")];
  t.same("signed out: sent to sign in (the page), 401 (the list)", [outSees[0].status, /\/login/.test(outSees[0].location ?? ""), outSees[1].status], [302, true, 401]);
  t.ok("the page can't be framed", (ownerPage.headers ?? []).some(([k, v]) => k === "x-frame-options" && /deny/i.test(v)));
  const cleared = await host.post("/api/admin/errors/clear", { fingerprints: [kept?.fingerprint] });
  t.same("\"Fixed\" clears a kind for the owner", [cleared.status, cleared.json?.cleared, rows().some((r) => r.fingerprint === kept?.fingerprint)], [200, 1, false]);
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  code = 2;
} finally {
  await server?.stop().catch(() => {});
}
process.exit(code);
