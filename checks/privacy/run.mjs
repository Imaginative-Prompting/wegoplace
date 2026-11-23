// What WeGoPlace promises about privacy, in one place (docs/model.md §7, §17, §20, §22), each promise held by the
// lines of the checks that prove it. This runs those checks and reads their own report lines: a promise is kept
// when every line listed for it passed. A line listed here that a check no longer prints (renamed, taken out)
// fails too, so this list can't quietly hold less than it says. Nothing is checked twice in a different way:
// the proof is in each check, and this is where a person reads them together.
//
//   node checks/privacy/run.mjs [--only <check name>]
//
// Each check runs on its own server and port, one after another (none of them on 8791). Everyone in them is
// made up. Adding a privacy promise: write the line in the check that proves it, then list it here.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Report } from "../lib/person.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;

// The checks and how to run them; each takes a free port of its own (checks/lib/server.mjs freePort).
const CHECKS = {
  people: ["checks/assistant/people.mjs"],
  chat: ["checks/assistant/chat.mjs"],
  talk: ["checks/assistant/talk.mjs"],
  export: ["checks/assistant/export.mjs"],
  meter: ["--disable-warning=ExperimentalWarning", "checks/assistant/meter.mjs"],
  billing: ["checks/billing/run.mjs"],
  push: ["checks/push/run.mjs"],
  errors: ["checks/errors/run.mjs"],
  // Only check:accounts' guests part (its stand-in for Google on its port + 10).
  guests: ["checks/accounts/run.mjs", "guests"],
};

// Each promise, in words, and the lines that hold it: [check, the start of the line as the check prints it].
export const PROMISES = [
  { promise: "A conversation with the assistant is its person's alone: nobody else reads, deletes or adds to it, the host included.", lines: [
    ["people", "someone else on the trip lists only their own: none of Ben's"],
    ["people", "reading Ben's conversation by its id: the same answer as no conversation at all"],
    ["people", "  and the host can't either"],
    ["people", "deleting it: refused the same way, and it is still Ben's"],
    ["people", "asking into it: refused the same way, and nothing reached the model"],
    ["chat", "another person can't share from Ben's conversation"],
  ] },
  { promise: "The model is never sent anyone's private words: not another person's conversation, not by its tools, not when asked for them.", lines: [
    ["people", "a tool that would read conversations isn't offered"],
    ["people", "another trip she is on, by its id: this trip's answer, never that one's"],
    ["people", "no tool offered reads conversations"],
    ["people", "asked for Ben's words: the model is sent nothing of Ben's to answer from"],
    ["people", "no request made for anyone but Ben carries Ben's words"],
    ["chat", "  and nothing of anyone's own conversation"],
  ] },
  { promise: "The model's provider keeps nothing and never learns who: zero retention, no collection, an opaque tag.", lines: [
    ["meter", "only providers that keep nothing"],
    ["meter", "the account by its opaque tag (32 hex), never its id or a name"],
  ] },
  { promise: "The assistant's ledger keeps money, never words; the host sees it per trip, never per person; a member sees no numbers.", lines: [
    ["meter", "no word of what was asked or answered anywhere in it"],
    ["meter", "a member: that it has room this month, and no number"],
    ["meter", "used up: no room, and the day it's back, still no number"],
    ["meter", "the host: the month's allowance, what's used, per trip, and never per person"],
    ["talk", "the host sees the month (allowance, used, when it's back) and this trip's line; a member sees no numbers"],
    ["talk", "the account's plan: the month per trip the host hosts, by name, never per person"],
  ] },
  { promise: "Share with group puts one question and its answer in the chat, and nothing else of the conversation.", lines: [
    ["chat", "nothing else of the conversation went with it"],
  ] },
  { promise: "A person's export is theirs and nothing else: no one else's words, no key, credential, session, Stripe id or push endpoint.", lines: [
    ["export", "another person's words: not Cleo's chat, not her conversation"],
    ["export", "not the trip's plans, places or purchases as such"],
    ["export", "no key, credential id, session, Stripe id, push endpoint or public key"],
    ["export", "the host's ledger says nothing of who asked"],
  ] },
  { promise: "What goes when someone goes: a deleted account's conversations and tag go; their asks stay in a host's ledger without who asked.", lines: [
    ["meter", "a member deleted: their asks stay in the host's ledger, without who asked; their tag goes"],
    ["meter", "a host deleted: their ledger goes with them"],
    ["talk", "an account deleted takes every conversation of its own"],
    ["export", "an account deleted takes its conversations and its tag"],
    ["export", "a member who leaves keeps their conversations"],
  ] },
  // The plan's promises, as the Terms say them ("The plan") and the privacy page ("The plan, where the site offers it").
  { promise: "A full refund ends the plan at once; a partial one changes nothing.", lines: [
    ["billing", "a full refund ends the plan at Stripe at once, saying why"],
    ["billing", "a partial refund changes nothing"],
  ] },
  { promise: "While a payment is disputed the plan's assistant is paused and its room stays; a dispute that goes the customer's way ends the plan.", lines: [
    ["billing", "a dispute open: the plan stays, the assistant's allowance is held"],
    ["billing", "won: let go"],
    ["billing", "lost: the plan ends, saying why"],
  ] },
  { promise: "A payment that failed and is being tried again keeps the plan working meanwhile.", lines: [
    ["billing", "past due: still the plan"],
  ] },
  { promise: "Nothing is removed when a plan ends: over the free room only new files are refused, until they fit or the plan is back.", lines: [
    ["billing", "unpaid: the plan ends; nothing is removed, the pool and allowance go"],
    ["billing", "ended: the free limit again, nothing removed, every new byte refused, the way to more room named again"],
  ] },
  { promise: "The assistant's month turns at 00:00 UTC on the 1st, and what's left of a month doesn't carry over.", lines: [
    ["meter", "the month turns at 00:00 UTC on the 1st: the last second of a month counts in it, the next second in the next, and the share is back at that second"],
    ["meter", "a call from last month doesn't count in this one"],
  ] },
  { promise: "Deleting an account ends its plan at Stripe first, then deletes what we kept of it here, its disputes included.", lines: [
    ["billing", "then deleted: the plan ended at Stripe first, the account's billing rows gone"],
    ["billing", "  her disputes go with her (Stripe keeps the dispute itself), and nobody else's do"],
  ] },
  { promise: "A member learns nothing of the host's plan: no price where the room is full, only that the host can get more.", lines: [
    ["billing", "a member's write that doesn't fit: refused, naming the host as the way to more room, with no price"],
    ["meter", "a host with no plan: refused in words that say nothing of the plan's price"],
  ] },
  { promise: "A phone is told only what it asked for: words only where the person turned them on, never their own messages, never after muting or leaving.", lines: [
    ["push", "Ada's message reaches Ben, Cleo and Fay's phones, once each; never Ada's own, Dee's (muted) or Eli's (left)"],
    ["push", "Ben's phone (no words): who wrote, and in which trip"],
    ["chat", "the others told of the answer"],
    ["push", "a deleted account's phones go with it"],
  ] },
  { promise: "An error report holds nothing of a trip or a person: no trip's name, no one's name, nothing quoted, no address, no id; only where it broke, as a pattern, and the browser's name.", lines: [
    ["errors", "an error report keeps nothing of a trip or a person: no trip's or person's name, no address, no long number, no trip's id, where only as a pattern"],
    ["errors", "  (planted: a kept report carrying the trip's name is caught by the same reading)"],
    ["errors", "a shared board's page, signed out: the board's title, its trip's name and its people's taken out; where only as /s/:id"],
    ["errors", "a board's report with no Referer at all, its board named in the report: the same words taken out, and the id never kept"],
    ["errors", "signed out: taken, and kept, its browser by name and major version only; the page told its kind's fingerprint (200 { group }), that row's"],
    ["errors", "a sync that keeps failing: fixed words, its status and tries, nothing it was sending"],
    ["errors", "anyone else signed in: 404 everywhere (as an address the site hasn't got), and nothing cleared"],
  ] },
  { promise: "A guest (on a trip by its link with only a name) is kept as a name and a session: no email, nothing to sign in by elsewhere; their export and their deleting work as anyone's.", lines: [
    ["guests", "the guest is kept with a name and nothing to sign in by"],
    ["guests", "an email on the account: refused in words"],
    ["guests", "the export works for a guest, and says they are one"],
    ["guests", "a guest deletes themself: done and signed out"],
    ["guests", "what they wrote keeps their name; nothing signs them in"],
  ] },
  { promise: "A host can't use a guest's way back to reach anyone else: the link is for a guest only, only while every trip they're on is that host's, used once, and it signs the old phone out.", lines: [
    ["guests", "for someone with an account: refused, saying how they get back"],
    ["guests", "while the guest is on a trip another host hosts: refused, and that trip isn't named"],
    ["guests", "the old phone is signed out"],
    ["guests", "a link made before the guest joined another host's trip doesn't work, and nobody else is signed out"],
    ["guests", "a host's link made while they were a guest no longer signs them in"],
  ] },
];

const t = new Report("what WeGoPlace promises about privacy");
const wanted = new Set(PROMISES.flatMap((p) => p.lines.map(([c]) => c)));
const heard = {};
for (const [name, args] of Object.entries(CHECKS)) {
  if (!wanted.has(name) || (only && only !== name)) continue;
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const lines = `${r.stdout}\n${r.stderr}`.split("\n").map((l) => /^ {2}(pass|FAIL) {2}(.*)$/.exec(l)).filter(Boolean).map((m) => ({ ok: m[1] === "pass", text: m[2] }));
  heard[name] = { lines, exit: r.status };
  console.log(`  (${name}: ${lines.filter((l) => l.ok).length} passed, ${lines.filter((l) => !l.ok).length} failed, exit ${r.status})`);
}
for (const { promise, lines } of PROMISES) {
  t.part(promise);
  for (const [check, start] of lines) {
    if (only && only !== check) continue;
    const found = heard[check]?.lines.find((l) => l.text.startsWith(start));
    t.ok(`${check}: ${start}`, !!found?.ok, found ? "it failed in its check" : "the check didn't print this line (renamed or taken out?): list it again");
  }
}
process.exit(t.end());
