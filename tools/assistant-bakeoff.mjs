// THE ASSISTANT'S BAKE-OFF: which model to pick (docs/model.md §20, "his to pick"), and how hard it should think.
//
// Each row (a model, and the reasoning level the site would send it) runs the same tasks through the app's own
// assistant: a server on this machine started as the site would be (the plan on, the assistant on with that model,
// its prices and its level), its own tools, its step and token caps, and only providers that keep nothing. What it
// did is read from the trip's rows; what it said, for exact names and numbers. No judge model. Then a report to
// read (report.md) and the numbers behind it (results.json).
//
//   OPENROUTER_API_KEY=… node tools/assistant-bakeoff.mjs --models <id>[@level],… --out <new folder>
//       [--set round-1,round-2] [--only <task>,…] [--max-dollars 5] [--port 8868] [--lists <folder>]
//   node tools/assistant-bakeoff.mjs --estimate --models … [--set …] --from <an earlier run's results.json> [--lists <folder>]
//   node tools/assistant-bakeoff.mjs --standin good|bad --out <new folder> [--models standin/a@low,…] [--set …]
//
//   --models       OpenRouter model ids, as its site lists them, each with the level the site would send:
//                  "id" or "id@default" sends no reasoning field (the site as it is: the model thinks as its own
//                  default has it); "id@low" (any of OpenRouter's levels) sends that; "id@lowest" the least the
//                  model allows (none, minimal or low). The level is the app's own setting, ASSISTANT_REASONING_EFFORT.
//                  "id@level>fallback@level" names the row's fallback: a call the first model's provider refuses goes
//                  once more to it, at its own level (the app's ASSISTANT_FALLBACK_MODEL and _REASONING_EFFORT), decided
//                  against OpenRouter's lists as a row is. "+search" goes last.
//   --set          the tasks: round-1 (tools/bakeoff/tasks.mjs, one trip a row) and/or round-2 (tools/bakeoff/
//                  round-2.mjs, a fresh trip and server for each task); round-1 by default
//   --out          a folder for report.md and results.json; it must not hold a report already
//   --max-dollars  the most the whole run may spend; no task starts once it has (default 5)
//   --lists        a folder holding OpenRouter's public lists (models.json, zdr.json) to read instead of asking
//   --estimate     no run: what each row and the whole grid would cost, and about how long, from --from's tokens
//   --no-attach    don't upload a task's documents (proving a task's scoring before the app takes files); the report says so
//   --real-ai      give the server Cloudflare's Workers AI (env.AI, for a PDF's toMarkdown), which runs on the account even
//                  from wrangler dev: then only the made-up fixtures in tools/bakeoff/documents/ may be sent, each held by
//                  its hash (FIXTURES); anything else is refused before it leaves. import-pdf needs it in a real run.
//   --standin good|bad   no key, nothing leaves this machine: the stand-in model answers each task as a model
//                  that does it right (good) or wrong (bad). The harness's own check (checks/assistant/bakeoff.mjs).
//
// THE MODEL LIST IS DECIDED AT RUN TIME, from OpenRouter's public lists (no key): a row runs only if its model takes
// tools, has at least one zero-data-retention endpoint that takes tools (and reasoning, when a level is sent), and
// takes the level asked. Every row left out is named with why, in the report and before anything runs.
//
// An ask is waited for as long as the app itself may take: its steps times one model call's own limit, and a
// minute more (ASK_CEILING_MS). An ask that doesn't come back in that time, or fails any other way, is that task
// FAILED, with why and how long it took; the run waits for the trip to be free again and goes on to the next task
// and the next row. A row whose run dies (its server, its trip) is kept with why. Each model call's own line in the
// server's log (src/assistant/provider.js) goes into the task's record: how each call ended, its reasoning tokens,
// and for a refused call its status and OpenRouter's words for why. results.json and report.md are written after
// every task, so a run stopped for any reason leaves what it had.
//
// The key is read from OPENROUTER_API_KEY, given only to the local server (its secrets file, mode 600, removed
// with it), and never written to the report, the results or the screen. Nothing touches the production site.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startServer } from "../checks/lib/server.mjs";
import { startModel } from "../checks/lib/model-standin.mjs";
import { demoTripOn, loadDemo } from "../checks/lib/demo.mjs";
import { TASKS, rowsOf } from "./bakeoff/tasks.mjs";
import { TASKS_2, rowsOf2 } from "./bakeoff/round-2.mjs";
import { TASKS_2B, emptyTripOn, rowsOf2b, standins as standins2b } from "./bakeoff/round-2b.mjs";
import { PHOTOS, PHOTO_URL, PLACES, startPoisWorld, startWikimedia } from "../checks/lib/pois-world.mjs";
import { openWorld } from "../src/map/world.js";
import { TALK } from "../src/assistant/talk.js";
import { EFFORTS, PROVIDER } from "../src/assistant/provider.js";

/** How long one ask is waited for: as long as the app may take (every step a model call at its own limit), and a minute more. */
export const ASK_CEILING_MS = TALK.steps * PROVIDER.timeoutMs + 60_000;
/** How long a trip may stay busy after an ask was given up here: the app's own hold on it, and a little more. */
const FREE_WAIT_MS = (TALK.askSeconds + 15) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STANDIN_KEY = "sk-or-standin-not-real";

/**
 * The task sets: round 1 on one trip a row; round 2 each task on a fresh trip (and server) of its own; round 2b, the
 * planning tasks, each on a fresh EMPTY trip (round-2b.mjs emptyTripOn), scored against the map's real places.
 */
const STANDINS_2B = standins2b({ PLACES, PHOTOS, PHOTO_URL });
export const SETS = {
  "round-1": { tasks: TASKS, rows: rowsOf, fresh: false },
  "round-2": { tasks: TASKS_2, rows: rowsOf2, fresh: true },
  "round-2b": { tasks: TASKS_2B.map((t) => ({ ...t, standin: STANDINS_2B[t.id] })), rows: rowsOf2b, fresh: true, empty: true, world: true },
};

/** The share of a call's max_tokens OpenRouter gives thinking at each level (its reasoning docs). */
export const EFFORT_SHARE = { max: 0.95, xhigh: 0.95, high: 0.8, medium: 0.5, low: 0.2, minimal: 0.1, none: 0 };

/**
 * The made-up documents the import tasks send, by their SHA-256: a --real-ai run sends these and nothing else.
 * (amsterdam-draft.pdf and -photo.jpg are made from amsterdam-draft.md: one page, nothing real but public places.)
 */
export const FIXTURES = {
  "amsterdam-draft.md": { sha256: "39a3bbf6a08339d4696f2bed290f424addf992744172d2eea211cdd1e073baf7" },
  "amsterdam-draft.pdf": { sha256: "644b7cd001f54fc3157f9fa7a45792338dc113f07ba0bd2bb64744a89cb31b92" },
  "amsterdam-draft-photo.jpg": { sha256: "ec2593421fb0fe7f0188ca80eb882d35a9c21b3832d82bcbe8583332b403fd3d" },
};

/** Whether these bytes are the made-up fixture of that name (its SHA-256 in FIXTURES). */
export const isFixture = (name, bytes) => Object.hasOwn(FIXTURES, name) && createHash("sha256").update(bytes).digest("hex") === FIXTURES[name].sha256;

/** A row's name in the report: the model, the level when one is sent, ">" its fallback, and "+search" when web search is on. */
export const labelOf = (m) => `${m.effort ? `${m.id}@${m.effort}` : m.id}${m.fallback ? `>${labelOf(m.fallback)}` : ""}${m.search ? "+search" : ""}`;

/** "id[@level][>fallback[@level]][+search]" as its parts: { id, level, search, fallback: { id, level } | null }. */
export function rowAsked(asked) {
  const search = /\+search$/.test(asked);
  const [first, second = null] = asked.replace(/\+search$/, "").split(">");
  const part = (x) => { const [id, level = "default"] = x.split("@"); return { id, level }; };
  return { ...part(first), search, fallback: second ? part(second) : null };
}

// ── which rows run: OpenRouter's public lists ──────────────────────────────────────────────────────

/** OpenRouter's public list of models and its list of zero-data-retention endpoints (no key), or read from a folder. */
export async function openRouterLists(folder = null) {
  if (folder) {
    const read = (f) => JSON.parse(fs.readFileSync(path.join(folder, f), "utf8"));
    return { models: read("models.json").data ?? [], zdr: (({ data }) => data)(read("zdr.json")) ?? [] };
  }
  const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`OpenRouter's ${u} answered ${r.status}`); return r.json(); };
  const [models, zdr] = await Promise.all([get("https://openrouter.ai/api/v1/models"), get("https://openrouter.ai/api/v1/endpoints/zdr")]);
  return { models: models.data ?? [], zdr: zdr.data ?? zdr ?? [] };
}

/**
 * The rows asked for ("id", "id@level", "id@lowest", "id@default"), decided against OpenRouter's lists:
 * { rows: [{ id, effort, input, output, reasoning, endpoints }], left: [{ asked, why }] }.
 */
export function decideRows(asked, { models, zdr }) {
  const rows = [], left = [];
  for (const a of asked) {
    const { id, level, search, fallback: fb } = rowAsked(a);
    // The fallback is decided as a row of its own (listed, tools, a zero-retention endpoint, its level, its price).
    let fallback = null;
    if (fb) {
      const d = decideRows([fb.level === "default" ? fb.id : `${fb.id}@${fb.level}`], { models, zdr });
      if (!d.rows.length) { left.push({ asked: a, why: `its fallback ${fb.id}: ${d.left[0]?.why}` }); continue; }
      if (fb.id === id) { left.push({ asked: a, why: "its fallback is the same model (the app takes none then)" }); continue; }
      const { id: fid, effort: feffort, input: finput, output: foutput, endpoints: fendpoints } = d.rows[0];
      fallback = { id: fid, effort: feffort, input: finput, output: foutput, endpoints: fendpoints };
    }
    const m = models.find((x) => x.id === id);
    if (!m) { left.push({ asked: a, why: "OpenRouter lists no such model" }); continue; }
    if (!(m.supported_parameters ?? []).includes("tools")) { left.push({ asked: a, why: "it doesn't take tools, and the assistant needs them" }); continue; }
    const r = m.reasoning ?? null;
    let effort = null;
    if (level !== "default") {
      const allowed = r?.supported_efforts === null ? EFFORTS : r?.supported_efforts ?? null;
      if (!r || !allowed) { left.push({ asked: a, why: "it offers no reasoning level to set" }); continue; }
      effort = level === "lowest" ? allowed.at(-1) : level;
      if (!EFFORTS.includes(effort)) { left.push({ asked: a, why: `"${level}" isn't one of OpenRouter's levels (${EFFORTS.join(", ")})` }); continue; }
      if (!allowed.includes(effort)) { left.push({ asked: a, why: `it doesn't take "${effort}" (it takes ${allowed.join(", ")})` }); continue; }
    }
    const need = effort ? ["tools", "reasoning"] : ["tools"];
    const eps = zdr.filter((e) => e.model_id === id);
    const fit = eps.filter((e) => need.every((p) => (e.supported_parameters ?? []).includes(p)));
    if (!eps.length) { left.push({ asked: a, why: "no endpoint of it keeps nothing (zero data retention)" }); continue; }
    if (!fit.length) { left.push({ asked: a, why: `none of its ${eps.length} zero-retention endpoints takes ${need.join(" and ")}` }); continue; }
    // Millionths of a dollar a token, without the float's tail ("0.0000001" is 0.1, not 0.09999999999999999).
    const perMillion = (x) => Number((Number(x) * 1e6).toPrecision(12));
    const input = perMillion(m.pricing?.prompt), output = perMillion(m.pricing?.completion);
    if (!(input > 0 && output > 0)) { left.push({ asked: a, why: "OpenRouter lists no price for it, and the meter needs one" }); continue; }
    if (rows.some((x) => labelOf(x) === labelOf({ id, effort, search, fallback }))) { left.push({ asked: a, why: `the same row as ${labelOf({ id, effort, search, fallback })}, asked again` }); continue; }
    rows.push({ id, effort, search, input, output, reasoning: r, endpoints: { zdr: fit.length, providers: [...new Set(fit.map((e) => e.provider_name))] }, ...(fallback ? { fallback } : {}) });
  }
  return { rows, left };
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────

/** Each model call's own line from the server's log (src/assistant/provider.js), after a mark. */
export function callLines(log) {
  const out = [];
  for (const l of String(log ?? "").split("\n")) {
    const at = l.indexOf('{"assistant_call":');
    if (at < 0) continue;
    try { out.push(JSON.parse(l.slice(at).trim()).assistant_call); } catch { /* a line cut short */ }
  }
  return out;
}

/**
 * Runs the sets' tasks on each row. models: [{ id, effort?, input, output }]; key (the real one) or standin ("good"|"bad").
 * Returns { started, sets, models: [{ id, effort, label, input, output, tasks: [record], error }], stopped }.
 */
export async function bakeOff({ models, key = null, standin = null, port = 8868, maxDollars = 5, only = null, sets = ["round-1"], say = () => {},
  save = () => {}, askCeilingMs = ASK_CEILING_MS, freeWaitMs = FREE_WAIT_MS, hang = null, refuse = null, refuseOnce = null, alter = [], attach = true, realAi = false }) {
  const seed = loadDemo();
  const scrub = scrubber(key);
  const out = { started: new Date().toISOString(), sets, models: [], stopped: null };
  let spent = 0;
  const model = standin ? await startModel({ key: STANDIN_KEY }) : null;
  const over = () => spent >= maxDollars * 1e6;
  // Round 2b reads the map's real places: in a dry run, a stand-in world and Wikimedia on this machine; in a real
  // run, the world build itself (Protomaps) and Wikimedia, and pictures fetched from where they really are.
  const needsWorld = sets.some((s) => SETS[s]?.world);
  const standWorld = needsWorld && standin ? await startPoisWorld() : null;
  const standWiki = needsWorld && standin ? await startWikimedia() : null;
  const world = needsWorld ? await openWorld(standWorld ? { WORLD_URL: standWorld.url } : {}) : null;
  // A dry run's stand-in for Cloudflare's toMarkdown: the made-up PDF answers the Markdown it was made from; nothing else.
  const converter = standin ? await startConverter() : null;

  /**
   * A server as the site would be for this row, a fresh made-up trip on it, the host's plan on; run(ctx) on it.
   * Its setup (the server, the trip: before any call of the model, so nothing spent) is tried once more if it fails,
   * as a busy machine can be slow to start one (20 Nov: load 28 on twelve cores); a second failure stops the row.
   */
  // Each server's own work and state dir (.wrangler/check/<name>-<pid>): a run starts a fresh server a task, and with one
  // name for all of them every server of the run used the same dir. stop() removes it once the ports are free, and the
  // next task's server started at the same path while the last one's workerd, slow to go on a loaded machine, could still
  // be in it: twice on 21 Nov a row stopped on "sql failed (exit 1)" there. A name of its own each: no dir is shared.
  let made = 0;
  const onTrip = async (m, run, set = {}, task = null) => {
    for (let attempt = 1; ; attempt++) {
      let server = null, ready = false;
      try {
        server = await startServer({
          name: `bakeoff-${++made}`, port,
          vars: { PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y", ASSISTANT_ENABLED: "true",
            ASSISTANT_MODEL: m.id, ASSISTANT_PRICE_INPUT: String(m.input), ASSISTANT_PRICE_OUTPUT: String(m.output), ASSISTANT_REASONING_EFFORT: m.effort ?? "", ASSISTANT_WEB_SEARCH: m.search ? "true" : "",
            ASSISTANT_FALLBACK_MODEL: m.fallback?.id ?? "", ASSISTANT_FALLBACK_PRICE_INPUT: m.fallback ? String(m.fallback.input) : "",
            ASSISTANT_FALLBACK_PRICE_OUTPUT: m.fallback ? String(m.fallback.output) : "", ASSISTANT_FALLBACK_REASONING_EFFORT: m.fallback?.effort ?? "",
            ...(standWorld ? { WORLD_URL: standWorld.url, WIKIMEDIA_API_VIA: standWiki.url } : {}), ...(!standin ? { PICTURE_FETCH_VIA: "" } : {}),
            PLAN_AI_ALLOWANCE_MICRO: String(Math.ceil(maxDollars * 1e6) + 1_000_000), ...(model ? { OPENROUTER_API_BASE: model.base } : {}),
            ...(converter ? { DOCUMENT_CONVERT_VIA: converter.url } : {}) },
          ai: realAi,
          secrets: { STRIPE_SECRET_KEY: "sk_test_bakeoff", STRIPE_WEBHOOK_SECRET: "whsec_bakeoff", OPENROUTER_API_KEY: model ? STANDIN_KEY : key },
        });
        await server.start();
        const demo = set.empty ? await emptyTripOn(server.origin, task?.trip ?? {}) : await demoTripOn(server.origin);
        const now = Math.floor(Date.now() / 1000);
        server.sql(`INSERT INTO billing_subscriptions (id, user_id, customer, status, interval, current_period_end, held, updated_at, synced_at)
          VALUES ('sub_bakeoff', '${demo.ids.ada}', 'cus_bakeoff', 'active', 'month', ${now + 30 * 86400}, 0, ${now}, ${Date.now()})`);
        ready = true;
        await run({ seed, trip: demo.tripId, people: demo.people, origin: server.origin, sql: (s) => server.sql(s), server, world });
        return;
      } catch (e) {
        if (ready || attempt >= 2) throw e;
        say(`  the server or its trip didn't come up (${scrub(e?.message ?? e).split("\n")[0].slice(0, 160)}); trying once more`);
      } finally {
        await server?.stop().catch(() => {});
      }
    }
  };

  /** One task on a trip: its plant, its asks in turn (each read before and after), its lines; the record. */
  const runTask = async (task, setName, rowsFn, base) => {
    const ctx = { ...base, expect: null };
    // The trip as the task found it, before its own plant: a fresh trip holds the seed's rows whatever ran before.
    const start = Object.fromEntries(["events", "places", "purchases"].map((t) => [t, Number(base.sql(`SELECT COUNT(*) AS n FROM ${t} WHERE trip_id = '${base.trip}'`)[0]?.n ?? 0)]));
    if (task.plant) await task.plant(ctx);
    const asks = task.asks ? task.asks(seed) : [{ words: task.words(seed) }];
    const answers = model ? (task.asks ? task.standin[standin](seed) : [task.standin[standin](seed)]) : [];
    const seen = new Set(base.sql("SELECT id FROM ai_calls").map((r) => r.id));
    const mark = base.server.logMark();
    const A = `/api/trips/${base.trip}/assistant/conversations`;
    const who = base.people[task.asker];
    const made = new Set();
    const done = [];
    let failed = null;
    for (const [i, ask] of asks.entries()) {
      const conv = `c-bakeoff-${task.id}-${ask.conv ?? "main"}`;
      const askId = `q-bakeoff-${task.id}-${i + 1}`;
      const before = rowsFn(base.sql, base.trip);
      if (model) {
        const these = typeof answers[i] === "function" ? answers[i]({ ...ctx, asks: done }) : answers[i] ?? [];
        // The harness's own check plants here, on a task's first call: answered late (hang), refused (refuse), or
        // answered otherwise (alter: cut off, refused with OpenRouter's words …).
        these.forEach((a, j) => {
          const firstCall = i === 0 && j === 0;
          // Refused once by the first model's provider, then the same answer: what the row's fallback answers.
          if (firstCall && refuseOnce?.task === task.id) model.next({ status: refuseOnce.status, errorBody: { message: "Provider returned error", code: refuseOnce.status, metadata: { provider_name: "Stand-in" } } });
          const planted = firstCall ? alter.find((x) => x.task === task.id)?.with : null;
          model.next(!firstCall ? a : hang?.task === task.id ? { ...a, hang: hang.ms } : refuse?.task === task.id ? { status: refuse.status } : planted ? { ...a, ...planted } : a);
        });
      }
      const t0 = Date.now();
      // The ask, waited for as long as the app may take. Anything else (no answer in that time, the server gone) is
      // this task failed, never the run.
      let r = null;
      try {
        if (!made.has(conv)) { await who.post(A, { id: conv }, { timeoutMs: askCeilingMs }); made.add(conv); }
        // A document the ask attaches (tools/bakeoff/documents/): uploaded to the conversation first, as the app does,
        // and named in the ask. With attach off (proving a task's scoring before the app takes files), not sent.
        const files = [];
        for (const name of attach ? ask.files ?? [] : []) {
          const bytes = fs.readFileSync(path.join(ROOT, "tools/bakeoff/documents", name));
          // With Workers AI on (the account's own service), only the made-up fixtures leave this machine.
          if (realAi && !isFixture(name, bytes)) throw new Error(`--real-ai sends only the made-up fixtures, by their hashes: ${name} isn't one`);
          const type = { ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg" }[path.extname(name)] ?? "application/octet-stream";
          const up = await who.call("POST", `${A}/${conv}/files`, bytes, { headers: { "Content-Type": type, "X-File-Name": name }, timeoutMs: askCeilingMs });
          if (![200, 201].includes(up.status) || !up.json?.file?.id) throw new Error(`the document ${name} couldn't be attached: HTTP ${up.status}${up.json?.reason ? `, ${up.json.reason}` : ""}`);
          files.push(up.json.file.id);
        }
        r = await who.post(`${A}/${conv}/ask`, { id: askId, words: ask.words, ...(files.length ? { files } : {}) }, { timeoutMs: askCeilingMs });
      } catch (e) {
        failed = /^timeout:/.test(String(e?.message)) ? `no answer within ${Math.round(askCeilingMs / 1000)} s${asks.length > 1 ? ` (ask ${i + 1})` : ""}, so it was given up here`
          : `the ask failed${asks.length > 1 ? ` (ask ${i + 1})` : ""}: ${scrub(e?.message ?? e)}`;
      }
      const seconds = (Date.now() - t0) / 1000;
      if (failed) {
        // The app may still be working on it: the next task waits until the trip is free (its ask's row gone).
        const end = Date.now() + freeWaitMs;
        let free = false;
        while (Date.now() < end) {
          try { free = base.sql(`SELECT 1 FROM ai_asks WHERE trip_id = '${base.trip}'`).length === 0; } catch { free = true; }
          if (free) break;
          await sleep(1000);
        }
        if (!free) failed += `; the trip was still busy with it ${Math.round(freeWaitMs / 1000)} s later`;
        done.push({ words: ask.words, answer: "", refused: null, seconds, steps: 0, before, after: rowsFn(base.sql, base.trip) });
        break;
      }
      const lines = String(r?.text ?? "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const turn = lines.find((l) => l.turn)?.turn ?? null;
      const error = r ? lines.find((l) => l.error) ?? (r.status !== 200 ? r.json ?? { error: `HTTP ${r.status}` } : null) : null;
      done.push({ words: ask.words, answer: scrub(turn?.words ?? ""), refused: turn ? null : scrub(error?.reason ?? error?.error ?? "no answer"), seconds,
        steps: (turn?.detail?.steps ?? []).length, asked: Array.isArray(turn?.detail?.asked) ? turn.detail.asked : [], stopped: turn?.detail?.stopped ?? null, failed: turn?.detail?.failed ?? null, before, after: rowsFn(base.sql, base.trip) });
    }
    const calls = base.sql("SELECT id, state, cost, worst, prompt_tokens, completion_tokens FROM ai_calls").filter((c) => !seen.has(c.id));
    const cost = calls.reduce((s, c) => s + Number(c.state === "settled" ? c.cost : c.worst), 0);
    spent += cost;
    const said = callLines(base.server.log().slice(mark)).map((c) => ({ ...c, error: c.error ? scrub(c.error) : c.error }));
    let scored;
    if (failed) scored = [{ what: "the ask came back", ok: false, got: failed }];
    else {
      const sctx = { ...ctx, asks: done, before: done[0].before, after: done.at(-1).after, answer: done.at(-1).answer, refused: done.find((a) => a.refused)?.refused ?? null };
      try { scored = await task.score(sctx); } catch (e) { scored = [{ what: "its answer could be scored", ok: false, got: scrub(e?.message ?? e) }]; }
    }
    return {
      id: task.id, set: setName, what: task.what, asker: seed.people.find((p) => p.key === task.asker).name.split(" ")[0],
      start, words: done[0]?.words ?? asks[0].words, ...(asks.some((a) => a.files?.length) ? { files: asks.flatMap((a) => a.files ?? []), attached: attach } : {}), answer: done.at(-1)?.answer ?? "", refused: done.find((a) => a.refused)?.refused ?? null, failed,
      asks: done.map(({ words, answer, refused, seconds, steps, asked, stopped, failed: why }) => ({ words, answer, refused, seconds, steps, asked: asked ?? [], stopped, provider_status: why?.provider ?? null, provider_error: why?.error ?? null })),
      // Why an ask stopped, from the turn's own detail (the app's record; the log line below is a second source):
      // the first ask that stopped on an error, with the provider's HTTP status when it answered one.
      ...(() => { const e = done.find((a) => a.stopped === "error"); return { stopped: e ? "error" : done.find((a) => a.stopped)?.stopped ?? null, provider_status: e?.failed?.provider ?? null, provider_error: e?.failed?.error ?? null }; })(),
      // The tools each call of the model asked for, in order over the task's asks (the turn's own record).
      tools: done.flatMap((a) => a.asked ?? []),
      steps: done.reduce((s, a) => s + a.steps, 0), seconds: done.reduce((s, a) => s + a.seconds, 0), calls: calls.length,
      prompt_tokens: calls.reduce((s, c) => s + (Number(c.prompt_tokens) || 0), 0), completion_tokens: calls.reduce((s, c) => s + (Number(c.completion_tokens) || 0), 0),
      reasoning_tokens: said.reduce((s, c) => s + (Number(c.reasoning_tokens) || 0), 0),
      provider: { calls: said, refused: said.filter((c) => c.status !== 200), cut_off: said.filter((c) => c.finish_reason === "length").length },
      cost_micro: cost, lines: scored, passed: scored.every((l) => l.ok),
    };
  };

  try {
    for (const m of models) {
      const row = { ...m, effort: m.effort ?? null, label: labelOf(m), tasks: [], error: null };
      out.models.push(row);
      if (over()) { out.stopped = `the run reached its ${maxDollars} dollars before ${row.label}`; break; }
      const record = (r) => {
        row.tasks.push(r);
        save(out);
        say(`  ${r.set} ${r.id}: ${r.passed ? "pass" : "FAIL"} (${r.lines.filter((l) => l.ok).length}/${r.lines.length}), ${r.seconds.toFixed(1)} s, $${(r.cost_micro / 1e6).toFixed(4)}${r.provider.refused.length ? `, ${r.provider.refused.length} call(s) refused` : ""}`);
      };
      try {
        for (const setName of sets) {
          const set = SETS[setName];
          const tasks = set.tasks.filter((t) => !only || only.includes(t.id));
          if (!tasks.length) continue;
          if (!set.fresh) {
            say(`${row.label}: ${setName} on a fresh made-up trip…`);
            await onTrip(m, async (base) => {
              for (const task of tasks) {
                if (over()) { out.stopped = `the run reached its ${maxDollars} dollars at ${row.label}, before "${task.id}"`; break; }
                record(await runTask(task, setName, set.rows, base));
              }
            });
          } else {
            say(`${row.label}: ${setName}, each task on a fresh made-up trip…`);
            for (const task of tasks) {
              if (over()) { out.stopped = `the run reached its ${maxDollars} dollars at ${row.label}, before "${task.id}"`; break; }
              await onTrip(m, async (base) => record(await runTask(task, setName, set.rows, base)), set, task);
            }
          }
          if (out.stopped) break;
        }
      } catch (e) {
        // This row's run died (its server, its trip): kept with why, and the run goes on to the next row.
        row.error = scrub(e?.message ?? e);
        say(`  ${row.label} stopped: ${row.error}`);
      } finally {
        save(out);
      }
      if (out.stopped) break;
    }
  } finally {
    // A dry run keeps what each request to the stand-in carried that a row decides: its model and its reasoning.
    if (model) out.requests = model.calls.map((c) => ({ model: c.body?.model ?? null, reasoning: c.body?.reasoning ?? null, search: (c.body?.tools ?? []).some((t) => t.type === "openrouter:web_search") }));
    await model?.close();
    await standWorld?.stop();
    await standWiki?.stop();
    await converter?.stop();
  }
  return out;
}

/** The stand-in for Cloudflare's toMarkdown: amsterdam-draft.pdf answers amsterdam-draft.md's text; anything else a 422. */
async function startConverter() {
  const md = fs.readFileSync(path.join(ROOT, "tools/bakeoff/documents/amsterdam-draft.md"), "utf8");
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const known = decodeURIComponent(req.headers["x-file-name"] ?? "") === "amsterdam-draft.pdf";
      res.writeHead(known ? 200 : 422, { "Content-Type": "application/json" });
      res.end(JSON.stringify(known ? { markdown: md } : { error: "the stand-in converts only amsterdam-draft.pdf" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/`, stop: () => new Promise((r) => server.close(r)) };
}

/** What takes the key out of any text kept from a run (an answer, a refusal). */
export const scrubber = (key) => (s) => (key ? String(s ?? "").replaceAll(key, "[the key]") : String(s ?? ""));

const money = (micro) => `$${(micro / 1e6).toFixed(micro < 10_000 ? 4 : 3)}`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
/** What a host's month of the assistant is taken to be, for "asks a month". */
export const MONTH_MICRO = 2_000_000;

/** A row's numbers for the summary. */
export function summed(m) {
  const asks = m.tasks.flatMap((t) => t.asks ?? []);
  const nAsks = Math.max(1, m.tasks.reduce((s, t) => s + Math.max(1, (t.asks ?? []).length), 0));
  const cost = m.tasks.reduce((s, t) => s + t.cost_micro, 0);
  const calls = m.tasks.flatMap((t) => t.provider?.calls ?? []);
  const per = (set) => { const ts = m.tasks.filter((t) => t.set === set); return ts.length ? { passed: ts.filter((t) => t.passed).length, of: ts.length } : null; };
  return {
    m, passed: m.tasks.filter((t) => t.passed).length, of: m.tasks.length, sets: Object.fromEntries(Object.keys(SETS).map((s) => [s, per(s)])),
    lines: m.tasks.reduce((s, t) => s + t.lines.filter((l) => l.ok).length, 0), linesOf: m.tasks.reduce((s, t) => s + t.lines.length, 0),
    cost, perAsk: cost / nAsks, asksOnMonth: cost > 0 ? Math.floor(MONTH_MICRO / (cost / nAsks)) : null,
    secs: median(asks.length ? asks.map((a) => a.seconds) : m.tasks.map((t) => t.seconds)),
    steps: m.tasks.length ? m.tasks.reduce((s, t) => s + t.steps, 0) / m.tasks.length : 0,
    reasoningPerCall: calls.length ? calls.reduce((s, c) => s + (Number(c.reasoning_tokens) || 0), 0) / calls.length : 0,
    cutOff: calls.filter((c) => c.finish_reason === "length").length, refused: calls.filter((c) => c.status !== 200).length, callsSeen: calls.length,
    failed: m.tasks.filter((t) => !t.passed).map((t) => t.id),
  };
}

/** The report, in words and tables, to read. */
export function report(results, { app = "", standin = null, left = [] } = {}) {
  const ms = results.models.filter((m) => m.tasks.length);
  const label = (m) => m.label ?? labelOf(m);
  const sum = ms.map(summed).sort((a, b) => b.passed - a.passed || b.lines - a.lines || a.cost - b.cost);
  const tasks = [];
  for (const m of ms) for (const t of m.tasks) if (!tasks.some((x) => x.id === t.id && x.set === t.set)) tasks.push({ id: t.id, set: t.set ?? "round-1" });
  const setsRun = [...new Set(tasks.map((t) => t.set))];
  const L = [];
  L.push(`# The assistant's bake-off, ${results.started.slice(0, 10)}`, "");
  L.push(`Each row (a model, and the reasoning level the site sends it) did the same ${tasks.length} tasks through WeGoPlace's own assistant${app ? ` (the app at ${app})` : ""}: its tools, its caps (${TALK.steps} steps an ask, ${TALK.maxTokens.toLocaleString("en-US")} tokens written a call, ${TALK.askTokens.toLocaleString("en-US")} an ask), and only providers that keep nothing. ${setsRun.includes("round-2") ? "Round 2's tasks each ran on a fresh made-up trip of their own. " : "Each row ran on its own fresh copy of the made-up trip. "}A task passes when every line under it passes. Each line is a fact read from the trip's rows (what it wrote, changed or left alone) or from its answer (an exact name, number or time). No model judged another; a line that reads the answer's words for a cue shows the sentence it read when it fails.`, "");
  L.push(`**Thinking and the cap.** A row with a level sends OpenRouter's reasoning setting; a row without one sends none, and the model thinks as its own default has it (many of these think by default). Either way, its thinking counts against the ${TALK.maxTokens.toLocaleString("en-US")} tokens a call may write: OpenRouter gives thinking about 80% of them at high, 50% at medium, 20% at low. A call whose thinking used them all comes back with nothing said and nothing done ("cut off" below). The caps are the app's as they are today.`, "");
  if (standin) L.push(`**A dry run:** no model was asked. The stand-in answered each task as a model that does it ${standin === "good" ? "right" : "wrong"}, to prove the harness and its scoring.`, "");
  if (results.stopped) L.push(`**Stopped early:** ${results.stopped}.`, "");
  for (const m of results.models.filter((x) => x.error)) L.push(`**${label(m)} stopped** after ${m.tasks.length} of its tasks: ${m.error}.`, "");
  const gaveUp = ms.flatMap((m) => m.tasks.filter((t) => t.failed).map((t) => `${label(m)} on ${t.id}`));
  if (gaveUp.length) L.push(`**Didn't come back** (each counted as that task failed, and the run went on): ${gaveUp.join("; ")}.`, "");
  const lefts = left.length ? left : results.left ?? [];
  if (lefts.length) L.push("**Left out before the run** (OpenRouter's public lists, read at run time):", "", ...lefts.map((x) => `- ${x.asked}: ${x.why}`), "");
  L.push("## Summary, best first", "");
  const setCols = setsRun.length > 1 ? setsRun.map((s) => ` ${s} |`).join("") : "";
  L.push(`| Row | Level sent | Tasks passed |${setCols} Lines passed | Cost, all tasks | Cost an ask | Asks on ${money(MONTH_MICRO)} a month | Median time an ask | Steps a task | Thinking tokens a call | Calls cut off | Calls refused | Failed tasks |`);
  L.push(`|---|---|---|${setsRun.length > 1 ? setsRun.map(() => "---|").join("") : ""}---|---|---|---|---|---|---|---|---|---|`);
  for (const s of sum) {
    const sets = setsRun.length > 1 ? setsRun.map((x) => ` ${s.sets[x] ? `${s.sets[x].passed} of ${s.sets[x].of}` : "not run"} |`).join("") : "";
    L.push(`| ${label(s.m)} | ${s.m.effort ?? "none (its default)"} | ${s.passed} of ${s.of} |${sets} ${s.lines} of ${s.linesOf} | ${money(s.cost)} | ${money(s.perAsk)} | ${s.asksOnMonth?.toLocaleString("en-US") ?? "–"} | ${s.secs.toFixed(1)} s | ${s.steps.toFixed(1)} | ${Math.round(s.reasoningPerCall)} | ${s.cutOff} of ${s.callsSeen} | ${s.refused} of ${s.callsSeen} | ${s.failed.join(", ") || "none"} |`);
  }
  L.push("", `Prices used (millionths of a dollar a token, input / output): ${ms.map((m) => `${label(m)} ${m.input} / ${m.output}`).join("; ")}. Cost is what OpenRouter said each call cost; a call it hadn't priced counts at its worst case. An ask is one thing a person asked; a task may ask several.`, "");
  const refusedAll = ms.flatMap((m) => m.tasks.flatMap((t) => (t.provider?.refused ?? []).map((c) => ({ row: label(m), task: t.id, ...c }))));
  if (refusedAll.length) {
    L.push("## Calls the provider refused", "", "| Row | Task | Status | OpenRouter's words |", "|---|---|---|---|");
    for (const c of refusedAll) L.push(`| ${c.row} | ${c.task} | ${c.status} | ${String(c.error ?? "").replace(/\|/g, "/") || "(none)"} |`);
    L.push("");
  }
  L.push("## Task by task", "", `| Task | ${sum.map((s) => label(s.m)).join(" | ")} |`, `|---|${sum.map(() => "---").join("|")}|`);
  for (const x of tasks) {
    L.push(`| ${x.id}${setsRun.length > 1 ? ` (${x.set})` : ""} | ${sum.map((s) => { const t = s.m.tasks.find((y) => y.id === x.id && (y.set ?? "round-1") === x.set); return t ? `${t.passed ? "pass" : "FAIL"} (${t.lines.filter((l) => l.ok).length}/${t.lines.length})` : "not run"; }).join(" | ")} |`);
  }
  L.push("");
  for (const x of tasks) {
    const firstOf = ms.map((m) => m.tasks.find((t) => t.id === x.id && (t.set ?? "round-1") === x.set)).find(Boolean);
    const asks = firstOf.asks?.length ? firstOf.asks.map((a) => a.words) : [firstOf.words];
    L.push(`## ${x.id}: ${firstOf.what}`, "");
    if (asks.length === 1) L.push(`${firstOf.asker} asks: "${asks[0]}"`, "");
    else L.push(`${firstOf.asker} asks, in turn:`, "", ...asks.map((w, i) => `${i + 1}. "${w}"`), "");
    for (const s of sum) {
      const t = s.m.tasks.find((y) => y.id === x.id && (y.set ?? "round-1") === x.set);
      if (!t) continue;
      const thought = t.reasoning_tokens ? `, ${t.reasoning_tokens} thinking` : "";
      L.push(`**${label(s.m)}**: ${t.passed ? "pass" : "FAIL"}, ${t.seconds.toFixed(1)} s, ${t.steps} step${t.steps === 1 ? "" : "s"}, ${t.calls} call${t.calls === 1 ? "" : "s"}, ${t.prompt_tokens + t.completion_tokens} tokens${thought}, ${money(t.cost_micro)}`, "");
      if (t.tools?.length) L.push(`Tools asked for, call by call: ${t.tools.map((c, i) => `${i + 1}. ${c.length ? c.join(", ") : "(answered)"}`).join("; ")}.`, "");
      for (const c of t.provider?.refused ?? []) L.push(`A call was refused: ${c.status}${c.error ? `, "${c.error}"` : ""}.`, "");
      if (t.provider?.cut_off) L.push(`${t.provider.cut_off} call${t.provider.cut_off === 1 ? " was" : "s were"} cut off at the cap (finished on length).`, "");
      if (t.files && !t.attached) L.push(`**Not attached:** ${t.files.join(", ")} (the run was made with --no-attach, to prove the scoring).`, "");
      if (t.failed) L.push(`Didn't come back: ${t.failed}.`, "");
      if (t.stopped === "error") L.push(`Stopped by an error: ${t.provider_status ? `the provider answered HTTP ${t.provider_status}` : t.provider_error === "unreachable" ? "the provider couldn't be reached" : `"${t.provider_error ?? "unknown"}"`}.`, "");
      const shown = t.asks?.length ? t.asks : [{ answer: t.answer, refused: t.refused }];
      shown.forEach((a, i) => {
        if (shown.length > 1) L.push(`Answer ${i + 1}:`, "");
        if (a.refused) L.push(`Refused: ${a.refused}`, "");
        else if (!t.failed || a.answer) L.push(...String(a.answer).slice(0, 900).split("\n").map((y) => `> ${y}`), ...(String(a.answer).length > 900 ? ["> …"] : []), "");
      });
      for (const l of t.lines) L.push(`- ${l.ok ? "pass" : "FAIL"}: ${l.what}${l.got && !l.ok ? `. Got: ${l.got}` : ""}`);
      L.push("");
    }
  }
  return `${L.join("\n")}\n`;
}

// ── the estimate ──────────────────────────────────────────────────────────────────────────────

/**
 * What each row would cost and take, before any real run: each task's tokens and calls from an earlier run's
 * results (the mean of the rows that were answered), round 2's asks taken at round 1's mean ask and half again
 * (they take more steps), and each call's thinking at its level's share of the cap (the model's own default level
 * when none is sent and it thinks by default). Answers { rows: [{ label, cost, minutes }], cost, minutes, basis }.
 */
export function estimate(rows, { sets, only = null, from }) {
  const seed = loadDemo();
  const answered = (from.models ?? []).flatMap((m) => m.tasks).filter((t) => t.calls > 0 && t.prompt_tokens + t.completion_tokens > 0 && !t.failed);
  if (!answered.length) throw new Error("the earlier run has no answered task to take tokens from");
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const byTask = (id) => { const ts = answered.filter((t) => t.id === id); return ts.length ? ts : answered; };
  const basisOf = (ts) => ({ prompt: mean(ts.map((t) => t.prompt_tokens)), completion: mean(ts.map((t) => t.completion_tokens)), calls: mean(ts.map((t) => t.calls)), seconds: median(ts.map((t) => t.seconds)) });
  const anAsk = basisOf(answered);
  const HARDER = 1.5;
  // A planning ask runs most of its steps (search, areas, places, plans, a photo): about twice a round-2 ask's again.
  const PLANNING = 3;
  // A +search row: at most ASSISTANT_WEB_SEARCH_MAX searches a call; taken as 3 a task, each its price and its results.
  const SEARCHES_A_TASK = 3, SEARCH_PRICE_MICRO = 7000, SEARCH_RESULT_CHARS = 5 * 2000;
  const SERVER_S = 12;
  const plan = [];
  for (const s of sets) for (const t of SETS[s].tasks.filter((x) => !only || only.includes(x.id))) {
    if (s === "round-1") plan.push({ ...basisOf(byTask(t.id)), fresh: false });
    else { const n = t.asks(seed).length, k = s === "round-2b" ? PLANNING : HARDER; plan.push({ prompt: anAsk.prompt * n * k, completion: anAsk.completion * n * k, calls: anAsk.calls * n * k, seconds: anAsk.seconds * n * k, fresh: true, planning: s === "round-2b" }); }
  }
  const out = rows.map((r) => {
    const level = r.effort ?? ((r.reasoning?.mandatory || r.reasoning?.default_enabled) ? r.reasoning?.default_effort ?? null : null);
    const think = (EFFORT_SHARE[level] ?? 0) * TALK.maxTokens;
    let cost = 0, secs = sets.includes("round-1") ? SERVER_S : 0;
    for (const p of plan) {
      const written = Math.min(p.completion + p.calls * think, p.calls * TALK.maxTokens);
      cost += p.prompt * r.input + written * r.output;
      if (r.search && p.planning) cost += SEARCHES_A_TASK * (SEARCH_PRICE_MICRO + SEARCH_RESULT_CHARS * r.input);
      secs += p.seconds + (p.fresh ? SERVER_S : 0);
    }
    return { label: labelOf(r), input: r.input, output: r.output, thinks: level ?? "no", cost: Math.round(cost), minutes: secs / 60 };
  });
  return { rows: out, cost: out.reduce((s, r) => s + r.cost, 0), minutes: out.reduce((s, r) => s + r.minutes, 0), tasks: plan.length,
    basis: { answered: answered.length, anAsk: { prompt: Math.round(anAsk.prompt), completion: Math.round(anAsk.completion), calls: +anAsk.calls.toFixed(2) }, harder: HARDER, planning: PLANNING } };
}

// ── the command ──
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
  const outDir = flag("--out");
  const standin = flag("--standin");
  const doEstimate = argv.includes("--estimate");
  const fail = (words) => { console.error(words); process.exit(2); };
  const sets = (flag("--set") ?? "round-1").split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of sets) if (!SETS[s]) fail(`--set: no set "${s}" (there are ${Object.keys(SETS).join(", ")})`);
  const only = flag("--only")?.split(",") ?? null;
  const asked = (flag("--models") ?? (standin ? "standin/model-a,standin/model-b" : "")).split(",").map((s) => s.trim()).filter(Boolean);
  if (!asked.length) fail("--models <id>[@level],… is needed");

  if (doEstimate) {
    const from = flag("--from");
    if (!from) fail("--estimate needs --from <an earlier run's results.json>: its tokens a task");
    const { rows, left } = decideRows(asked, await openRouterLists(flag("--lists")).catch((e) => fail(e.message)));
    const e = estimate(rows, { sets, only, from: JSON.parse(fs.readFileSync(from, "utf8")) });
    console.log(`Estimate for ${rows.length} rows × ${e.tasks} tasks (${sets.join(" + ")}), the cap as it is (${TALK.maxTokens} tokens a call):`);
    console.log(`  basis: ${e.basis.answered} answered tasks of ${from}; an ask ≈ ${e.basis.anAsk.prompt} tokens in, ${e.basis.anAsk.completion} out, ${e.basis.anAsk.calls} calls; round 2 at ×${e.basis.harder}, round 2b at ×${e.basis.planning}`);
    for (const r of e.rows) console.log(`  ${r.label.padEnd(44)} ${String(r.input.toFixed(3)).padStart(7)} / ${String(r.output.toFixed(3)).padStart(7)}  thinks: ${String(r.thinks).padEnd(7)} ${money(r.cost).padStart(8)}  ~${r.minutes.toFixed(0)} min`);
    console.log(`  in all: ${money(e.cost)}, ~${(e.minutes / 60).toFixed(1)} h of running`);
    for (const x of left) console.log(`  left out: ${x.asked}: ${x.why}`);
    process.exit(0);
  }

  if (!outDir) fail("--out <a new folder> is needed: where report.md and results.json go");
  if (fs.existsSync(path.join(outDir, "report.md"))) fail(`${outDir} holds a report already: give a new folder`);
  if (standin && !["good", "bad"].includes(standin)) fail("--standin is good or bad");
  const key = standin ? null : process.env.OPENROUTER_API_KEY;
  if (!standin && !key) fail("OPENROUTER_API_KEY isn't set (or run --standin good for a dry run)");
  const realAi = argv.includes("--real-ai");
  if (realAi && standin) fail("--real-ai is for a real run (a dry run converts with its own stand-in)");
  const pdfTasks = TASKS_2B.filter((t) => t.asks?.({ people: [] })?.some((a) => (a.files ?? []).some((f) => f.endsWith(".pdf")))).map((t) => t.id);
  if (!standin && !realAi && sets.includes("round-2b") && pdfTasks.some((id) => !only || only.includes(id)))
    fail(`${pdfTasks.join(", ")} send a PDF, which only Cloudflare's conversion reads: add --real-ai, or leave them out with --only`);
  let models, left = [];
  if (standin) {
    models = asked.map((a) => {
      const { id, level, search, fallback } = rowAsked(a);
      for (const l of [level, fallback?.level ?? "default"]) if (l !== "default" && !EFFORTS.includes(l)) fail(`--models: "${l}" isn't one of OpenRouter's levels`);
      return { id, effort: level === "default" ? null : level, search, input: 0.1, output: 0.5,
        ...(fallback ? { fallback: { id: fallback.id, effort: fallback.level === "default" ? null : fallback.level, input: 0.1, output: 0.5 } } : {}) };
    });
  } else {
    ({ rows: models, left } = decideRows(asked, await openRouterLists(flag("--lists")).catch((e) => fail(e.message))));
    for (const x of left) console.log(`left out: ${x.asked}: ${x.why}`);
    if (!models.length) fail("no row is left to run");
  }
  const app = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  fs.mkdirSync(outDir, { recursive: true });
  // Written after every task, and once more at the end whatever happened: a run stopped for any reason leaves what it had.
  const write = (results) => {
    fs.writeFileSync(path.join(outDir, "results.json"), `${JSON.stringify({ app, standin, left, ...results }, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, "report.md"), report(results, { app, standin, left }));
  };
  let last = { started: new Date().toISOString(), sets, models: [], stopped: null };
  let results;
  try {
    results = await bakeOff({ models, key, standin, sets, port: Number(flag("--port") ?? 8868), maxDollars: Number(flag("--max-dollars") ?? 5), only, attach: !argv.includes("--no-attach"), realAi,
      say: (s) => console.log(s), save: (r) => { last = r; write(r); } });
  } catch (e) {
    results = { ...last, stopped: `the run itself stopped: ${scrubber(key)(e?.message ?? e)}` };
  }
  write(results);
  console.log(`\nThe report: ${path.resolve(outDir, "report.md")}`);
}
