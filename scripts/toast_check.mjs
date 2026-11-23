#!/usr/bin/env node
/* The one transient message (public/js/toast.js).
 *
 * Chrome needs the Bash sandbox disabled, and the launcher (scripts/lib/browser.mjs) starts it
 * only through the queue:
 *   WGP_BASE=http://localhost:<port> python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> --label <what> -- node scripts/toast_check.mjs
 *
 * Why it exists: the app once had five copies of this, and four of them left a timer running
 * that hid whatever message arrived while the last one faded. A refusal that landed in that
 * fifth of a second was never seen.
 *
 * WHAT IT PROVES
 *   0. No browser: toast.js is the only file under public/ that touches the message's node,
 *      names its "showing" class, makes a node like it or keeps a toast function of its own;
 *      every file that shows a message imports the one function; the shell has the one node;
 *      the service worker keeps the module for offline. A sixth copy fails here.
 *   1. In the app: every screen that shows messages shares the one node. A message shows.
 *      One that replaces it mid-way gets its own five seconds. A message timed into the fade
 *      of the one before, early, in the middle and at its very end, is on screen and stays.
 *      The last one goes away. An empty message shows nothing.
 *   2. Messages that arrive together are shown together: two refusals 50 ms apart are both
 *      on screen, the older above, and both are still there until the newer one's five
 *      seconds end; four in a row leave the newest three; the same sentence twice is said
 *      once; a message that arrives 1.7 s after another replaces it.
 *   3. On a phone (320 and 390 wide) a long sentence takes the width of the screen, inside
 *      its gutters, in three lines or fewer, and sits above the round + button instead of
 *      over it. On a wide screen it stays at 420 px, centered.
 *   4. With `{ action: { label, onClick } }`: renders a >=44 px `<button class="toast-act">`,
 *      keeps showing past 5 s, runs `onClick` once and closes on press, and uses no travel under
 *      `prefers-reduced-motion: reduce` (PLANTS: TOAST_PLANT=noaction|twice).
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_ONLY = process.argv.includes("--static");
const PLANT = process.env.TOAST_PLANT || "";
if (PLANT && !["noaction", "twice"].includes(PLANT)) throw new Error(`no such TOAST_PLANT: ${PLANT}`);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// ── 0. one module, and nothing else ───────────────────────────────────────────────────────
section("0. toast.js is the only toast (no browser)");
{
  const pub = path.join(REPO, "public");
  const files = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { if (d.name !== "vendor") walk(full); continue; }
      // /design is the design system's own page, not the app: its working phone shows a toast of its own on purpose.
      if (/\.(js|mjs|html)$/.test(d.name) && path.relative(REPO, full) !== "public/design.html") files.push(path.relative(REPO, full));
    }
  };
  walk(pub);
  const MODULE = "public/js/toast.js";
  const text = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(REPO, f), "utf8")]));
  check("the module is there", files.includes(MODULE));
  const others = files.filter((f) => f !== MODULE);
  const hits = (re) => others.filter((f) => re.test(text[f]));

  const showing = hits(/toast-in/);
  check('no other file names the "showing" class', showing.length === 0, showing.join(", "));
  const reach = hits(/getElementById\(\s*["'`]toast["'`]\s*\)|querySelector(All)?\(\s*["'`][^"'`]*(#toast|\.toast)\b|\$\(\s*["'`]#?toast["'`]\s*\)/);
  check("no other file reaches for the message's node", reach.length === 0, reach.join(", "));
  const makes = hits(/className\s*=\s*["'`][^"'`]*\btoast\b|classList\.add\(\s*["'`]toast\b|\.id\s*=\s*["'`]toast["'`]/);
  check("no other file makes a node like it", makes.length === 0, makes.join(", "));
  const own = hits(/function\s+\w*[tT]oast\w*\s*\(|(?:const|let|var)\s+\w*[tT]oast\w*\s*=\s*(?:async\b|function\b|\()/);
  check("no other file keeps a toast function of its own", own.length === 0, own.join(", "));
  const callers = others.filter((f) => /(?<![\w.$])toast\(/.test(text[f]));
  // (The shell's modules are import(), never import statements: docs/CONTRACTS.md, "A phone
  // that had the app before".)
  const unimported = callers.filter((f) => !/import\s*\{[^}]*\btoast\b[^}]*\}\s*from\s*["'][^"']*\/toast\.js["']/.test(text[f])
    && !(f === "public/index.html" && /import\(\s*["']\/js\/toast\.js["']\s*\)/.test(text[f]) && /\{\s*toast\b[^}]*\}/.test(text[f])));
  check("every file that shows a message imports the one function", callers.length >= 5 && unimported.length === 0,
    `${callers.length} callers: ${callers.join(", ")}${unimported.length ? "; not imported in " + unimported.join(", ") : ""}`);

  const shell = text["public/index.html"] || "";
  const nodes = shell.match(/<[a-z]+[^>]*\bid="toast"[^>]*>/g) || [];
  check("the shell has the one node, and a screen reader is told about it",
    nodes.length === 1 && /role="status"/.test(nodes[0]) && /aria-live="polite"/.test(nodes[0]) && /\bhidden\b/.test(nodes[0]), nodes.join(" "));
  check("the service worker keeps the module for offline", /["']\/js\/toast\.js["']/.test(text["public/sw.js"] || ""));

  const mod = text[MODULE] || "";
  check("the module imports nothing and sets exactly two timers, each cleared before it is set again (a message that stays clears both)",
    !/^\s*import\b/m.test(mod) && (mod.match(/setTimeout\(/g) || []).length === 2 && (mod.match(/clearTimeout\(/g) || []).length === 3,
    `${(mod.match(/setTimeout\(/g) || []).length} set, ${(mod.match(/clearTimeout\(/g) || []).length} cleared`);

  const css = fs.readFileSync(path.join(REPO, "public/styles.css"), "utf8");
  check("toast.js supports .toast-act button and longer SHOW_ACTION_MS, and styles.css holds a 44 px .toast-act tap target",
    /\.toast-act/.test(mod) && /SHOW_ACTION_MS\s*=\s*\d+/.test(mod)
      && /\.toast-act\s*\{[^}]*min-height:\s*var\(--control-44\)/.test(css));
}

if (STATIC_ONLY) {
  console.log(`\n${pass} passed, ${fail} failed (static only)`);
  if (fail) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
  process.exit(0);
}

// ── 1. in the app ─────────────────────────────────────────────────────────────────────────
const { BASE, appSettled, boot, evalIn, sleep, waitFor } = await import("./lib/standalone_cdp.mjs");
const { tripPath } = await import("./lib/gate_trip.mjs");
const b = await boot({ vw: 390, vh: 844, dsf: 1 });
const { cdp, S } = b;
if (PLANT) {
  const src = fs.readFileSync(path.join(REPO, "public/js/toast.js"), "utf8");
  const bad = PLANT === "noaction"
    ? src.replace("const nextAct = label && onClick ? { label, onClick } : null;", "const nextAct = null;")
    : src.replace("action = null;\n  lines = [];", "lines = [];");
  cdp.on((m) => {
    if (m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    if (new URL(request.url).pathname === "/js/toast.js") {
      cdp.send("Fetch.fulfillRequest", {
        requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }],
        body: Buffer.from(bad).toString("base64"),
      }, m.sessionId || S).catch(() => {});
      return;
    }
    cdp.send("Fetch.continueRequest", { requestId }, m.sessionId || S).catch(() => {});
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/toast.js*" }] }, S);
}
const page = (expr) => evalIn(cdp, S, expr);
const state = () => page(`(() => { const n = document.getElementById("toast"); const cs = getComputedStyle(n);
  return JSON.stringify({ hidden: n.hidden, text: n.textContent, showing: n.classList.contains("toast-in"), opacity: Number(cs.opacity), display: cs.display }); })()`).then(JSON.parse);
const visible = (s, text) => !s.hidden && s.display !== "none" && s.showing && s.opacity > 0.95 && s.text === text;
try {
  section("1. one node for every screen");
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/")}` }, S);
  await appSettled(cdp, S);
  for (const [hash, route] of [["#/pack", "pack"], ["#/split", "split"], ["#/memories", "memories"], ["#/settings", "settings"]]) {
    await page(`(location.hash = ${JSON.stringify(hash)}, 1)`);
    await waitFor(cdp, S, `document.querySelector("#view").dataset.route === ${JSON.stringify(route)} ? 1 : 0`, { label: `the ${route} screen` });
    await sleep(700);
    const n = await page(`document.querySelectorAll(".toast, [id='toast']").length`);
    check(`${route}: one message node in the document, the shell's`, n === 1, `${n} nodes`);
  }

  section("2. a message, and one that replaces it");
  await page(`import("/js/toast.js").then((m) => { window.__toast = m.toast; return 1; })`);
  await page(`(window.__toast("one"), 1)`);
  await sleep(450);
  let s = await state();
  check("a message is on screen, fully, within half a second", visible(s, "one"), JSON.stringify(s));
  // Replaced three seconds in. Two and a half seconds later the FIRST one's five seconds are
  // over; the second still has half of its own.
  await sleep(2550);
  await page(`(window.__toast("two"), 1)`);
  await sleep(2600);
  s = await state();
  check("a message that replaces one mid-way is still there after the first one's time is up", visible(s, "two"), JSON.stringify(s));
  // Its five seconds and the fade end 2.64 s from here. A busy machine runs the page's timers late (measured on the
  // Studio's parallel lane: hidden 130 ms after the fade, sometimes past 250), so the node is waited for, never past
  // 750 ms more: a message that stayed would still be red.
  await sleep(2400 + 240 + 250);
  for (let waited = 0; waited < 750 && !(await state()).hidden; waited += 50) await sleep(50);
  s = await state();
  check("…and goes after its own five seconds and the fade", s.hidden === true && s.showing === false, JSON.stringify(s));

  section("3. a message that arrives while the last one fades");
  // Timed from the fade itself, read from the element (the moment "toast-in" comes off), not from the first message's
  // call plus 5 s: on a busy machine a timer set 5.2 s ahead fires tens of ms late, past the 240 ms fade, while one set
  // at the fade's start still fires before the toast's own hide timer, set at the same moment for later. The page's own
  // clock; there is no network in this part.
  for (const d of [30, 120, 210]) {
    const r = JSON.parse(await page(`new Promise((res) => {
      const first = "first ${d}", second = "second ${d}";
      const n0 = document.getElementById("toast");
      const seen = new MutationObserver(() => {
        if (n0.classList.contains("toast-in")) return;
        seen.disconnect();
        const fadeAt = performance.now();
        setTimeout(() => {
          const t2 = performance.now();
          const fading = !n0.hidden && !n0.classList.contains("toast-in");
          window.__toast(second);
          setTimeout(() => {
            const n = document.getElementById("toast"), cs = getComputedStyle(n);
            res(JSON.stringify({ into: Math.round(t2 - fadeAt), fading, hidden: n.hidden, text: n.textContent,
              showing: n.classList.contains("toast-in"), opacity: Number(cs.opacity), display: cs.display }));
          }, 700);
        }, ${d});
      });
      window.__toast(first);
      seen.observe(n0, { attributes: true, attributeFilter: ["class"] });
    })`));
    check(`${d} ms into the fade: the second message really did land in it`, r.into >= d && r.fading === true, `${r.into} ms after the first one's fade began, the first one ${r.fading ? "still fading" : "already gone"}`);
    check(`${d} ms into the fade: it is on screen 0.7 s later, not hidden by the first one's timer`, visible(r, `second ${d}`), JSON.stringify(r));
  }
  await sleep(5000 - 700 + 240 + 300);
  s = await state();
  check("the last message goes away too", s.hidden === true && s.showing === false, JSON.stringify(s));

  section("4. nothing to say");
  await page(`(window.__toast(""), window.__toast(null), window.__toast("   "), 1)`);
  await sleep(200);
  s = await state();
  check("an empty message shows nothing", s.hidden === true && s.showing === false, JSON.stringify(s));

  section("5. messages that arrive together are shown together");
  const shown = () => page(`(() => { const n = document.getElementById("toast"); const cs = getComputedStyle(n);
    return JSON.stringify({ on: !n.hidden && n.classList.contains("toast-in") && Number(cs.opacity) > 0.95,
      lines: [...n.querySelectorAll(".toast-line")].map((l) => l.textContent),
      tops: [...n.querySelectorAll(".toast-line")].map((l) => Math.round(l.getBoundingClientRect().top)) }); })()`).then(JSON.parse);
  const A1 = "That date is outside the trip.", A2 = "Someone else changed this first.";
  // Fired by the page's own clock, 50 ms apart: two refusals coming back from one flush.
  await page(`new Promise((res) => { window.__toast(${JSON.stringify(A1)}); setTimeout(() => { window.__toast(${JSON.stringify(A2)}); res(1); }, 50); })`);
  await sleep(500);
  let g = await shown();
  check("two refusals 50 ms apart are both on screen", g.on && g.lines.join(" | ") === `${A1} | ${A2}`, JSON.stringify(g));
  check("…one under the other, the older above", g.tops.length === 2 && g.tops[1] > g.tops[0], JSON.stringify(g.tops));
  await sleep(4200);                                   // 4.75 s after the second: inside its five seconds
  g = await shown();
  check("both are still there near the end of the newer one's five seconds", g.on && g.lines.length === 2, JSON.stringify(g));
  await sleep(300 + 240 + 400);
  s = await state();
  check("…and they go together after it", s.hidden === true && s.showing === false, JSON.stringify(s));

  await page(`new Promise((res) => { let i = 0; const next = () => { window.__toast("refusal " + (++i)); if (i < 4) setTimeout(next, 50); else res(1); }; next(); })`);
  await sleep(400);
  g = await shown();
  check("four in a row leave the newest three, the oldest dropped", g.on && g.lines.join(" | ") === "refusal 2 | refusal 3 | refusal 4", JSON.stringify(g.lines));
  await page(`(window.__toast("refusal 4"), 1)`);
  await sleep(200);
  g = await shown();
  check("the same sentence again is said once", g.lines.join(" | ") === "refusal 2 | refusal 3 | refusal 4", JSON.stringify(g.lines));
  await sleep(1700);
  await page(`(window.__toast("on its own"), 1)`);
  await sleep(400);
  g = await shown();
  check("a message that arrives 1.7 s after the last replaces what is showing", g.on && g.lines.join(" | ") === "on its own", JSON.stringify(g.lines));
  await sleep(5000 + 240 + 300);

  section("6. on a phone it takes the width of the screen, above the + button");
  const LONG = "Deleted. A shared board showed it, and that board's link no longer opens.";
  await page(`(location.hash = "#/memories", 1)`);
  await waitFor(cdp, S, `document.querySelector(".me-fab") ? 1 : 0`, { label: "the Memories screen and its + button" });
  for (const [w, wide] of [[320, false], [390, false], [1440, true]]) {
    await b.metrics(w, 844, 1);
    await sleep(400);
    await page(`(window.__toast(${JSON.stringify(LONG)}), 1)`);
    await sleep(500);
    const box = JSON.parse(await page(`(() => {
      const q = (n) => { const r = n.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
      const n = document.getElementById("toast"), fab = document.querySelector(".me-fab");
      const lh = parseFloat(getComputedStyle(n).lineHeight), pad = parseFloat(getComputedStyle(n).paddingTop) + parseFloat(getComputedStyle(n).paddingBottom);
      return JSON.stringify({ vw: document.documentElement.clientWidth, rail: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--rail-w")) || 0, toast: q(n), fab: fab ? q(fab) : null, rows: Math.round((n.getBoundingClientRect().height - pad) / lh) }); })()`));
    const t = box.toast, f = box.fab;
    const overFab = !!f && t.b > f.t && t.t < f.b && t.r > f.l && t.l < f.r;
    if (!wide) {
      check(`${w} wide: the sentence takes the screen's width, inside its gutters`, t.l >= 16 && t.r <= box.vw - 16 && t.w >= box.vw - 32 - 2 && Math.abs((t.l + t.r) / 2 - box.vw / 2) <= 1, JSON.stringify(t));
      check(`${w} wide: in three lines or fewer`, box.rows <= 3, `${box.rows} lines, ${t.h} px tall`);
      check(`${w} wide: above the + button, not over it`, !!f && !overFab && t.b <= f.t, JSON.stringify({ toast: t, fab: f }));
    } else {
      // Centered in the page, beside the bar at the left (the layouts: a sidebar from 1024, --rail-w).
      const mid = box.rail + (box.vw - box.rail) / 2;
      check(`${w} wide: no wider than 420 px, centered in the page beside the bar, clear of the + button`, t.w <= 420 && Math.abs((t.l + t.r) / 2 - mid) <= 1 && !overFab, JSON.stringify({ toast: t, fab: f, mid }));
    }
    await sleep(1600);                                 // the next width's message replaces this one
  }
  await b.metrics(390, 844, 1);

  section("7. action button & reduced motion");
  await page(`(window.__actCalls = 0, window.__toast("Added to the itinerary", { action: { label: "Undo", onClick: () => { window.__actCalls++; } } }), 1)`);
  await sleep(400);
  const act1 = JSON.parse(await page(`(() => {
    const n = document.getElementById("toast");
    const btn = n ? n.querySelector(".toast-act") : null;
    const r = btn ? btn.getBoundingClientRect() : null;
    return JSON.stringify({
      on: !!n && !n.hidden && n.classList.contains("toast-in"),
      tag: btn ? btn.tagName : null,
      label: btn ? btn.textContent.trim() : null,
      h: r ? Math.round(r.height) : 0,
      pe: btn ? getComputedStyle(btn).pointerEvents : null,
    });
  })()`));
  check("action toast draws a >=44 px <button> labelled by its words that takes taps",
    act1.on && act1.tag === "BUTTON" && act1.label === "Undo" && act1.h >= 44 && act1.pe === "auto",
    JSON.stringify(act1));
  await sleep(5100);
  const still = await state();
  check("action toast stays visible past 5 s", !still.hidden && still.showing && still.opacity > 0.95, JSON.stringify(still));
  await page(`(() => { const b = document.querySelector("#toast .toast-act"); if (b) { b.click(); b.click(); } return 1; })()`);
  await sleep(400);
  const afterAct = JSON.parse(await page(`(() => { const n = document.getElementById("toast");
    return JSON.stringify({ calls: window.__actCalls, hidden: n.hidden, showing: n.classList.contains("toast-in") }); })()`));
  check("pressing the action runs onClick once and closes the toast",
    afterAct.calls === 1 && afterAct.hidden === true && afterAct.showing === false,
    JSON.stringify(afterAct));

  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, S);
  await page(`(window.__actCalls = 0, window.__toast("Plan saved", { action: { label: "Undo", onClick: () => { window.__actCalls++; } } }), 1)`);
  await sleep(100);
  const rm = JSON.parse(await page(`(() => { const n = document.getElementById("toast");
    return JSON.stringify({ hidden: n.hidden, showing: n.classList.contains("toast-in"), transform: getComputedStyle(n).transform }); })()`));
  check("reduced motion shows action toast with zero travel", !rm.hidden && rm.showing && rm.transform === "none", JSON.stringify(rm));
  await page(`(() => { const b = document.querySelector("#toast .toast-act"); if (b) b.click(); return 1; })()`);
  await sleep(400);
  const rmAfter = JSON.parse(await page(`(() => { const n = document.getElementById("toast");
    return JSON.stringify({ calls: window.__actCalls, hidden: n.hidden, showing: n.classList.contains("toast-in") }); })()`));
  check("reduced-motion action press runs onClick once and closes",
    rmAfter.calls === 1 && rmAfter.hidden === true && rmAfter.showing === false,
    JSON.stringify(rmAfter));
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] }, S);

  check("no page error", b.pageErrors.length === 0, b.pageErrors.join(" | "));
} catch (e) {
  fail++; failures.push("the check ran to its end");
  console.log(`  FAIL  the check ran to its end   -> ${e && e.stack ? e.stack : e}`);
} finally {
  await b.done();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
