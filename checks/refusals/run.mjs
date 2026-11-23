// Every refusal the server can send is read by tools/refusals.mjs, so the file a person reads them
// in (its --out) can't miss one: anything in src/ that looks like a refusal (err(4xx…),
// json({ error … }), answer, refuse, plain, fail, messagePage, oauthRefusal, a bare
// JSON.stringify({ error … }), fetchRefused) lies inside one it read. A refusal written some new
// way fails here until the tool reads that way too. And each is one of two kinds: one a person or an AI can cause says what would be taken instead, in a sentence; one
// only the app's own code can cause is on the tool's PROTOCOL list. One that is neither fails. No
// server.
//
//   npm run check:refusals

import { Report } from "../lib/person.mjs";
import { actionable, allRefusals, hasSentence, protocolOf, refusalsIn, unread } from "../../tools/refusals.mjs";

const t = new Report("every refusal read");
const list = allRefusals();
const missed = unread(allRefusals({ withRelays: true }));
t.ok(`every refusal-like call in src/ is one the tool read (${list.length} read)`, missed.length === 0, missed.slice(0, 10).join("\n        "));
t.ok("  (with nothing counted as read, nearly every one of them is reported missing: the rule can fail)", unread([]).length >= list.length * 0.9, unread([]).length);
const planted = refusalsIn("src/planted.js", `export function x(ctx) {
  if (a) return err(400, "bad thing", { reason: "Say what was wrong." });
  if (b) return json({ error: "no words" }, 409);
  return err(422, "listed", { need: "a list of three" });
}`);
t.same("  (a planted file: each form read, with its status, code, sentence, and whether it can be acted on: a need alone names a shape, not what to do)",
  planted.map((r) => [r.status, r.code, r.reason, actionable(r)]), [[400, "bad thing", "Say what was wrong.", true], [409, "no words", null, false], [422, "listed", null, false]]);
const neither = list.filter((r) => !actionable(r));
t.ok(`every refusal says what would be taken instead, or is protocol by name (${list.filter(hasSentence).length} with sentences, ${list.filter((r) => !hasSentence(r) && protocolOf(r)).length} protocol)`,
  neither.length === 0, neither.slice(0, 12).map((r) => `${r.status} ${r.code} ${r.file}:${r.line}`).join("\n        "));
const kinds = refusalsIn("src/api/planted.js", `export async function planted(ctx) {
  if (a) return err(400, "bad id", { id });
  if (b) return err(400, "bad id", { id, reason: "Ids are letters." });
  if (c) return err(404, "not found");
  if (d) return err(400, "title required");
  if (e) return err(502, "could not store it");
  if (f) return err(400, "bad events", { rows });
  if (g) { fail("label required"); fail("label required", { reason: "An item needs a label." }); }
  if (h) return plain(404, "not found");
}`);
const files = refusalsIn("src/media-files.js", `export async function onRequest(ctx) {
  if (a) return plain(404, "not found");
}`);
t.same("  (planted: a protocol id, the same with a sentence, a not-found outside the routes that may, a person's field with no words, a 502, a batch's rows, a row's fail with and without words, a plain body repeating its code)",
  kinds.map((r) => [r.code, hasSentence(r), Boolean(protocolOf(r)), actionable(r)]),
  [["bad id", false, true, true], ["bad id", true, true, true], ["not found", false, false, false], ["title required", false, false, false],
    ["could not store it", false, true, true], ["bad events", true, true, true], ["label required", false, false, false], ["label required", true, false, true],
    ["not found", false, false, false]]);
t.same("  (a plain body that only repeats its code is no sentence: outside the file routes it is neither; in them, protocol)",
  files.map((r) => [r.reason, hasSentence(r), Boolean(protocolOf(r))]), [["not found", false, true]]);
t.ok("every refusal has its status and a code", list.every((r) => r.status !== null && r.code), list.filter((r) => r.status === null || !r.code).map((r) => `${r.file}:${r.line}`).join(", "));
process.exit(t.end());
