// axe-core in a page the checks drive (a dev dependency, pinned; never served to anyone).
//
//   const evaluate = (expression) => cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, S);
//   const findings = await axeOn(evaluate, "Itinerary, 390, light");
//
// It is handed the page to run in (the caller's browser, from scripts/lib/browser.mjs) and starts
// or reaches no browser itself.
//
// Runs the WCAG 2.0, 2.1 and 2.2 A and AA rules, and aria-dialog-name (a best-practice rule: every sheet
// here is a dialog, and one without a name is announced as nothing), on the whole document and answers each violation as
// { screen, rule, impact, help, nodes, first } — "first" is the first offending element's selector. What
// axe can't judge (its "incomplete" results: contrast over an image, say) is left out on purpose: a
// check built on this claims only what axe decides.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = fs.readFileSync(path.join(REPO, "node_modules/axe-core/axe.min.js"), "utf8");
export const AXE_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "node_modules/axe-core/package.json"), "utf8")).version;

const RUN = `axe.run(document, {
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] },
  // And one rule axe files under best practice, not WCAG: a dialog has a name (every sheet is a dialog).
  rules: { "aria-dialog-name": { enabled: true } },
  resultTypes: ["violations"],
}).then((r) => JSON.stringify(r.violations.map((v) => ({ rule: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length,
  first: (v.nodes[0] && v.nodes[0].target || []).join(" ") }))))`;

export async function axeOn(evaluate, screen) {
  // The library goes in as a script of its own, once per document (a navigation clears it).
  const has = await evaluate("typeof window.axe === 'object' ? 1 : 0");
  if (!has.result || has.result.value !== 1) {
    const put = await evaluate(SOURCE);
    if (put.exceptionDetails) throw new Error(`axe-core did not load: ${put.exceptionDetails.text}`);
  }
  const r = await evaluate(RUN);
  if (r.exceptionDetails) throw new Error(`axe.run threw on ${screen}: ${r.exceptionDetails.text}`);
  return JSON.parse(r.result.value).map((v) => ({ screen, ...v }));
}

// Serious and critical are what a check fails on; moderate and minor are listed.
export const blocking = (f) => f.impact === "serious" || f.impact === "critical";
export const line = (f) => `${f.screen} · ${f.rule} (${f.impact}, ${f.nodes} element${f.nodes === 1 ? "" : "s"}; first: ${f.first}) — ${f.help}`;
