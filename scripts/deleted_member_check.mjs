#!/usr/bin/env node
/* A member whose account is gone: every place that draws them still does, without a color.
 *
 * Chrome needs the Bash sandbox disabled, and the launcher (scripts/lib/browser.mjs) starts it
 * only through the queue:
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> --label <what> -- node scripts/deleted_member_check.mjs
 *
 * Why it exists: deleting an account keeps its name on the trip (the messages it wrote and the
 * money it logged are other people's too) and takes its note color away for good: the member
 * row reads `deleted: true, note_color: null`. Every screen writes a person's color inline as
 * `--nc:<hex>`, and one that wrote `--nc:null` would paint that person's initials white on
 * nothing.
 *
 * ITS OWN SERVER. The member is really deleted, through the route a person uses, and that
 * cannot be undone, so it does not happen in the lane's database. The check starts a server
 * of its own (checks/lib/server.mjs: an empty database under .wrangler/check/, removed
 * afterwards) on a port that is free when it runs, and makes that server this process's base
 * URL, whatever the caller set (scripts/lib/browser.mjs, ownServer). Two made-up people sign up with passkeys over plain HTTP
 * (checks/lib/person.mjs); the browser is the host's.
 *
 * WHAT IT PROVES
 *   1. The plant is real, read from the snapshot and not from a stub: the member is on the
 *      roster with their name and initials, `deleted: true`, `note_color: null`; their message
 *      about the time before a plan and their purchase are still on the trip.
 *   2. In both themes, at 390 wide: their message in the chat, their row in Split, and their
 *      choice under a new purchase's "Paid by" and under its "Split" each show their initials,
 *      readable (4.5:1 against what is behind them), on the neutral tone and not on anyone's
 *      color, with no `--nc` written for them. Settle up names them (its balances are a name and
 *      a phrase, with no marks). The host, beside them, is in their own color (their face carries
 *      their tone, data-person), so the check can tell the two apart (in the chat, a third member:
 *      the browser is the host's, and one's own messages carry no initials).
 *
 * THE COLORS ARE SET, NEVER DRAWN. A color is drawn at random at sign-up, so the host and the third
 * member are given theirs here (PATCH /api/me) before the trip is made: a check that reads a face's
 * color must know which color it is (21 Nov: a host who drew charcoal, whose token is its own hex,
 * turned this check red at random). The host's is charcoal on purpose, the case that found it.
 *
 * Planted: DELMEM_PLANT=hostneutral takes the tone off the host's and the third member's faces in
 * the page before each read (the "own color" cases go red).
 */
import process from "node:process";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";

// The server first: everything below that reads the base URL must find this one.
const PLANT = process.env.DELMEM_PLANT || "";
if (PLANT && PLANT !== "hostneutral") throw new Error(`no such plant: ${PLANT}`);
// The colors this check gives the host and the third member, exactly as the palette holds them (src/api/trip.js
// NOTE_COLORS, upper case: PATCH /api/me refuses any other spelling), and their tones (public/ds/avatar.js).
const HOST_COLOR = "#2E2E2E", HOST_TONE = "charcoal", STAY_COLOR = "#5B6ABF", STAY_TONE = "indigo";

const server = await startServer({ name: "deleted-member", port: await freeLoopbackPort() });
ownServer(server.origin);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// What the page is asked on every screen: each leaf element whose text is exactly these
// initials, with its ink, what is actually behind it (the nearest ancestor that paints), the
// contrast between the two, and whether a color was written for it.
const READ = `(initials) => {
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const parse = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ""); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const out = [];
  for (const n of document.querySelectorAll("#view *, .sh-sheet *")) {
    if (n.childElementCount !== 0 || n.textContent.trim() !== initials) continue;
    const r = n.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const ink = parse(getComputedStyle(n).color);
    let behind = null, written = false, tone = null, p = n;
    for (let depth = 0; p && p !== document.documentElement; p = p.parentElement, depth++) {
      if (depth < 4 && /--nc\\s*:/.test(p.getAttribute("style") || "")) written = true;
      if (depth < 4 && tone === null && p.dataset && p.dataset.person) tone = p.dataset.person;
      if (!behind) { const bg = parse(getComputedStyle(p).backgroundColor); if (bg && bg.a > 0.99) behind = bg.rgb; }
    }
    if (!behind) behind = parse(getComputedStyle(document.body).backgroundColor).rgb;
    const a = lum(ink.rgb), b = lum(behind);
    out.push({ where: (n.closest(".sh-sheet") ? "sheet " : "") + String(n.className || n.tagName).split(" ")[0],
      ink: hex(ink.rgb), behind: hex(behind), contrast: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100, written, tone });
  }
  return JSON.stringify(out);
}`;

let b = null;
try {
  await server.start();
  const T0 = Math.floor(Date.now() / 1000);
  const day = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date(Date.now() + d * 86400e3));

  // ── 1. the plant ────────────────────────────────────────────────────────────────────────
  section("1. a member really deleted, read from the snapshot");
  const host = new Person(server.origin, "Mara Voss"), gone = new Person(server.origin, "Teo Lind");
  // A third, who keeps their account: in the chat the browser's own messages (the host's) carry
  // no initials, so the one beside them there is this member.
  const stay = new Person(server.origin, "Ines Sola");
  await host.signUp(); await gone.signUp(); await stay.signUp();
  const given = [await host.call("PATCH", "/api/me", { note_color: HOST_COLOR }), await stay.call("PATCH", "/api/me", { note_color: STAY_COLOR })];
  check("the host's color and the third member's are set here, not drawn (charcoal and indigo)",
    given.every((r) => r.status === 200) && given[0].json.me.note_color === HOST_COLOR && given[1].json.me.note_color === STAY_COLOR,
    given.map((r) => `${r.status} ${r.json?.me?.note_color ?? r.text?.slice(0, 120)}`).join(", "));
  const hostId = (await host.me()).id, goneId = (await gone.me()).id;
  const made = await host.post("/api/trips", { name: "Coast week", default_tz: "Europe/Lisbon", starts_on: day(0), ends_on: day(4), currencies: ["EUR"] });
  const tripId = made.json.trip.id, T = `/api/trips/${tripId}`;
  const link = (await host.post(`${T}/links`, {})).json.link;
  const joined = await gone.post(`/api/join/${link.code}`);
  const joinedToo = await stay.post(`/api/join/${(await host.post(`${T}/links`, {})).json.link.code}`);
  const stayId = (await stay.me()).id;
  const shares = [{ user_id: hostId, weight: 1, share_minor: 3000 }, { user_id: goneId, weight: 1, share_minor: 3000 }];
  const purchase = (id, description) => ({ id, description, amount_minor: 6000, currency: "EUR", amount_exp: 2, split_mode: "weight", spent_at: T0, day: day(0), shares });
  const writes = [
    await host.post(`${T}/events`, { id: "e-dinner", title: "Dinner by the harbor", starts_at: T0 + 3600, tz: "Europe/Lisbon", kind: "meal" }),
    // What notes were (migration 0027): messages about the time before the plan, in the chat with
    // each person's initials (the Agenda's free time counts them).
    await gone.post(`${T}/messages`, { id: "n-gone", body: "I booked the table for eight", about: { kind: "event", id: "e-dinner", part: "before" } }),
    await host.post(`${T}/messages`, { id: "n-host", body: "Bring a jacket", about: { kind: "event", id: "e-dinner", part: "before" } }),
    await stay.post(`${T}/messages`, { id: "n-stay", body: "I'll bring the map" }),
    await gone.post(`${T}/purchases`, purchase("pu-fish", "Fish dinner")),
    await host.post(`${T}/purchases`, purchase("pu-taxi", "Taxi")),
  ];
  check("people on one trip, with a message and a purchase each (and a third with a message)", made.status === 201 && joined.status === 200 && joinedToo.status === 200 && writes.every((w) => w.status === 201),
    `trip ${made.status}, join ${joined.status} ${joinedToo.status}, writes ${writes.map((w) => w.status).join(" ")}`);
  const before = (await host.get(T)).json.members.find((m) => m.id === goneId);
  check("before: the member has a color", !!before && /^#[0-9a-f]{6}$/i.test(before.note_color || ""), JSON.stringify(before && before.note_color));
  const del = await gone.call("DELETE", "/api/me", { confirm: "delete" });
  check("they delete their account, the way a person does", del.status === 200 && del.json && del.json.ok === true, `${del.status} ${del.text.slice(0, 120)}`);
  const snap = (await host.get(T)).json;
  const row = snap.members.find((m) => m.id === goneId) || {};
  const palette = (snap.note_colors || []).map((c) => String(c.hex).toLowerCase());
  check("the snapshot keeps them on the roster by name, marked deleted, with no color",
    row.name === "Teo Lind" && row.deleted === true && row.note_color === null && row.initials === "TL", JSON.stringify(row));
  const theirs = (snap.chat?.about?.before_recent?.["e-dinner"] || []).find((m) => m.author === goneId) || {};
  check("their message is still on the trip, by their name, on the free time before the plan", theirs.body === "I booked the table for eight" && theirs.author_name === "Teo Lind",
    JSON.stringify({ body: theirs.body, author_name: theirs.author_name }));
  check("their purchase is still on the trip", snap.purchases.some((p) => p.id === "pu-fish" && p.paid_by === goneId));
  const hostRow = snap.members.find((m) => m.id === hostId) || {};
  check("the host, for comparison, has the color given them, from the palette", hostRow.note_color === HOST_COLOR && palette.includes(HOST_COLOR.toLowerCase()), `${hostRow.note_color} of ${palette.length}`);
  const stayRow = snap.members.find((m) => m.id === stayId) || {};
  check("…and so has the third member", stayRow.note_color === STAY_COLOR && palette.includes(STAY_COLOR.toLowerCase()), `${stayRow.note_color}`);

  // ── 2. every place that draws them ──────────────────────────────────────────────────────
  const { boot, evalIn, waitFor, appSettled, sleep } = await import("./lib/standalone_cdp.mjs");
  b = await boot({ vw: 390, vh: 844, dsf: 1 });
  const { cdp, S } = b;
  // boot() signs in a person of the lane's database; here the browser is the host's.
  await cdp.send("Network.deleteCookies", { name: "s2", url: server.origin }, S);
  await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: host.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
  const read = async (initials) => JSON.parse(await evalIn(cdp, S, `(${READ})(${JSON.stringify(initials)})`));
  const open = async (hash, ready, label) => {
    await cdp.send("Page.navigate", { url: `${server.origin}/t/${tripId}/?${Date.now()}${hash}` }, S);
    await appSettled(cdp, S);
    await waitFor(cdp, S, ready, { label });
    await sleep(500);
  };
  // The same four rules on every screen.
  const hold = async (screen, want, beside = { initials: "MV", row: hostRow, who: "the host", tone: HOST_TONE }) => {
    if (PLANT === "hostneutral") await evalIn(cdp, S, `(document.querySelectorAll("[data-person]").forEach((f) => { f.removeAttribute("data-person"); f.removeAttribute("style"); }), 1)`);
    const theirs = await read("TL"), hosts = await read(beside.initials);
    check(`${screen}: their initials are on screen`, theirs.length >= want, `${theirs.length} of ${want}: ${JSON.stringify(theirs)}`);
    check(`${screen}: readable, 4.5:1 against what is behind them`, theirs.length > 0 && theirs.every((x) => x.contrast >= 4.5), JSON.stringify(theirs));
    check(`${screen}: on the neutral tone: no color written for them, no tone on their face, and none of the palette's behind them`,
      theirs.length > 0 && theirs.every((x) => !x.written && !x.tone && !palette.includes(x.behind)), JSON.stringify(theirs));
    if (!beside.system) {
      check(`${screen}: ${beside.who} beside them keeps their own color`, hosts.some((x) => x.behind === String(beside.row.note_color).toLowerCase()), JSON.stringify(hosts));
    } else {
      // Since the color train (21 Nov) a face on the design system is in its person's own color (ds/avatar.js: data-person
      // and the --person-* token, never a hex written inline); the person who left has none, and is told apart in words too.
      check(`${screen}: ${beside.who} beside them is in their own color (${beside.tone}), not on the neutral tone`,
        hosts.length > 0 && hosts.every((x) => !x.written && x.tone === beside.tone) && theirs.every((x) => x.behind !== hosts[0].behind), JSON.stringify(hosts));
      if (beside.words) {
        const said = await evalIn(cdp, S, `(document.querySelector(".sh-sheet") || document.getElementById("view")).innerText`);
        check(`${screen}: their name says they're gone, in words ("${beside.words}")`, said.includes(beside.words), said.slice(0, 300));
      }
    }
  };

  for (const theme of ["light", "void"]) {
    section(`2. ${theme}: the chat, Split, a new purchase, settling up`);
    await cdp.send("Page.navigate", { url: `${server.origin}/t/${tripId}/#/` }, S);
    await appSettled(cdp, S);
    await evalIn(cdp, S, `(localStorage.setItem("wgp.theme", ${JSON.stringify(theme)}), 1)`);

    // Their words are the chat's since the notes became messages (migration 0027): the Agenda's
    // free time carries only how many there are, with no one's initials.
    await open("#/chat", `[...document.querySelectorAll("#view *")].some((n) => n.childElementCount === 0 && n.textContent.trim() === "TL") ? 1 : 0`, "their message in the chat");
    check(`${theme}: the theme is the one asked for`, (await evalIn(cdp, S, `document.documentElement.dataset.theme || ""`)) === theme);
    await hold(`${theme} chat`, 1, { initials: "IS", row: stayRow, who: "a member", system: true, tone: STAY_TONE });

    await open("#/split", `document.querySelectorAll("#view .sp-row").length >= 2 ? 1 : 0`, "Split's rows");
    await hold(`${theme} Split`, 1, { initials: "MV", row: hostRow, who: "the host", system: true, tone: HOST_TONE });

    await evalIn(cdp, S, `(document.querySelector('.fab[aria-label="Add a purchase"]').click(), 1)`);
    await waitFor(cdp, S, `document.querySelector(".sh-sheet") && /PAID BY/i.test(document.querySelector(".sh-sheet").innerText) ? 1 : 0`, { label: "the new purchase sheet" });
    await sleep(500);
    // Each row opens its people in place, one row at a time.
    await evalIn(cdp, S, `(document.querySelector('.sh-sheet [data-act="open-paid"]').click(), 1)`);
    await sleep(300);
    await hold(`${theme} new purchase, Paid by`, 1, { initials: "MV", row: hostRow, who: "the host", system: true, tone: HOST_TONE, words: "Teo Lind (account gone)" });
    await evalIn(cdp, S, `(document.querySelector('.sh-sheet [data-act="open-split"]').click(), 1)`);
    await sleep(300);
    await hold(`${theme} new purchase, Split`, 1, { initials: "MV", row: hostRow, who: "the host", system: true, tone: HOST_TONE, words: "Teo Lind (account gone)" });

    await open("#/split/settle", `document.querySelector(".sh-sheet") && /Teo Lind/.test(document.querySelector(".sh-sheet").innerText) ? 1 : 0`, "Settle up");
    check(`${theme} Settle up: they are there by name`, /Teo Lind/.test(await evalIn(cdp, S, `document.querySelector(".sh-sheet").innerText`)));
  }
  check("no page error", b.pageErrors.length === 0, b.pageErrors.join(" | "));
} catch (e) {
  fail++; failures.push("the check ran to its end");
  console.log(`  FAIL  the check ran to its end   -> ${e && e.stack ? e.stack : e}`);
} finally {
  if (b) await b.done().catch(() => {});
  await server.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(fail ? 1 : 0);
