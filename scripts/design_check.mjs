#!/usr/bin/env node
/* The design system's page (/design) in a browser, at 390 and 1440: what a screen built on public/ds/ is made of.
 *
 *   node scripts/gate.mjs --only design_check
 *
 * It holds:
 *   1. A ROW IS LAID OUT: in every list row (.ds-item) on the page, the title sits above its second line, and the
 *      words stay clear of the amount at the right (the trail).
 *   1b. A NAME WRAPS BEFORE IT IS CUT: a row's name that fits in two lines is never cut, and no name runs past two.
 *   1c. HIDDEN MEANS HIDDEN: a .ds-button given the hidden attribute is not drawn (a control's own display would
 *      otherwise beat the browser's [hidden]).
 *   2. THE FACES: the three faces of the system (Instrument Sans, Bricolage Grotesque, Geist Mono) have loaded.
 *   3. NO PAGE ERRORS.
 *
 * PLANTED (DESIGN_PLANT=<name>, served in place of public/ds/lists.css):
 *   inline   a row's title, second line and amount left inline: 1 red (1, at each size).
 *   cut      a row's name kept to one line and cut with an ellipsis: 1 red (1b, at each size).
 *   hidden   public/ds/base.css served without its [hidden] rule: 1 red (1c, at each size).
 */
import { BASE, boot, evalIn, waitFor, sleep } from "./lib/standalone_cdp.mjs";
import fs from "node:fs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

const PLANT = process.env.DESIGN_PLANT || "";
if (PLANT && !["inline", "cut", "hidden"].includes(PLANT)) throw new Error(`no such plant: ${PLANT}`);
const PLANTED_FILE = PLANT === "hidden" ? "base.css" : "lists.css";
const PLANTED = PLANT ? (() => {
  const src = fs.readFileSync(new URL(`../public/ds/${PLANTED_FILE}`, import.meta.url), "utf8");
  const t = PLANT === "hidden" ? src.replace(".ds [hidden], .ds[hidden] { display: none !important; }", "")
    : PLANT === "inline"
    ? src.replace(/\n  display: block;\n/g, "\n").replace("\n  display: -webkit-box;\n", "\n").replace(".ds-item-trail > .ds-amount { display: block; }\n", "")
    : src.replace("  -webkit-line-clamp: 2;\n  line-clamp: 2;\n", "  white-space: nowrap;\n  text-overflow: ellipsis;\n").replace("  display: -webkit-box;\n", "  display: block;\n");
  if (t === src) throw new Error(`the ${PLANT} plant didn't take`);
  return t;
})() : null;

const b = await boot({ vw: 390, vh: 844, dsf: 2, reduceMotion: true });
const { cdp, S } = b;
const J = async (e) => JSON.parse(await evalIn(cdp, S, e));
if (PLANTED) {
  cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "text/css; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(PLANTED).toString("base64") }, S).catch(() => {}); });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*/ds/${PLANTED_FILE}*` }] }, S);
}
try {
  for (const [w, h, dsf, mobile] of [[390, 844, 2, true], [1440, 900, 1, false]]) {
    section(`At ${w}`);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dsf, mobile }, S);
    await cdp.send("Page.navigate", { url: `${BASE}/design` }, S);
    await waitFor(cdp, S, `document.querySelector("[data-shell]") && document.fonts.status === "loaded" ? 1 : 0`, { label: "/design", timeout: 30000 });
    await sleep(400);
    // Rows inside a view that isn't shown measure as nothing: only rows with a size are read.
    const rows = await J(`JSON.stringify((() => { const bad = [], wrapBad = []; let read = 0, wrapped = 0;
      for (const r of document.querySelectorAll(".ds-item")) {
        const box = r.getBoundingClientRect(); if (!box.width || !box.height) continue;
        const t = r.querySelector(".ds-item-main > .ds-item-title"), s = r.querySelector(".ds-item-main > .ds-item-sub"), m = r.querySelector(".ds-item-main"), tr = r.querySelector(".ds-item-trail");
        if (!t) continue;
        read++;
        const tb = t.getBoundingClientRect(), sb = s && s.getBoundingClientRect(), mb = m.getBoundingClientRect(), trb = tr && tr.getBoundingClientRect();
        const stacked = !sb || sb.top >= tb.bottom - 1, clear = !trb || mb.right <= trb.left + 1;
        if (!stacked || !clear) bad.push(t.textContent.trim() + (stacked ? "" : " (second line beside the title)") + (clear ? "" : " (words under the amount)"));
        // The name's own lines: cut while two lines would hold it, or more than two shown.
        const line = parseFloat(getComputedStyle(t).lineHeight) || 22, lines = Math.round(t.scrollHeight / line);
        const cut = t.scrollWidth > t.clientWidth + 1 || (lines <= 2 && t.scrollHeight > t.clientHeight + 1);
        if (cut || t.clientHeight > 2 * line + 1) wrapBad.push(t.textContent.trim() + (cut ? " (cut)" : " (more than two lines)"));
        if (lines === 2) wrapped++;
      }
      return { read, bad, wrapBad, wrapped }; })())`);
    check(`${w}: every row's title is above its second line, its words clear of the amount (${rows.read} rows read)`, rows.read >= 5 && !rows.bad.length, rows.bad.slice(0, 6).join(" | "));
    check(`${w}: a row's name wraps to a second line before it is cut, and shows no more than two (${rows.wrapped} on two lines)`, !rows.wrapBad.length && (w > 400 || rows.wrapped >= 1), rows.wrapBad.slice(0, 6).join(" | "));
    const hid = await evalIn(cdp, S, `(() => { const b = document.createElement("button"); b.className = "ds-button ds-button--gray"; b.textContent = "Hidden"; b.hidden = true;
      document.querySelector("#dz-dark").append(b); const d = getComputedStyle(b).display; b.remove(); return d; })()`);
    check(`${w}: a .ds-button with the hidden attribute is not drawn`, hid === "none", hid);
    const faces = await J(`JSON.stringify(["Instrument Sans", "Bricolage Grotesque", "Geist Mono"].filter((f) => !document.fonts.check("16px '" + f + "'")))`);
    check(`${w}: the system's three faces have loaded`, !faces.length, faces.join(", "));
  }
  console.log(`\npage errors: ${b.pageErrors.length ? b.pageErrors.join(" | ").slice(0, 400) : "none"}`);
  check("no page errors", !b.pageErrors.length);
} finally {
  await b.done().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }
