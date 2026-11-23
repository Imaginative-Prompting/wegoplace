#!/usr/bin/env node
/* The picture pad (public/ds/pad.js) and the faces a picture is drawn in, in a browser, on /design's columns (Void
 * and Paper), where the pad's Save puts the drawing, the color and the initials into four faces (24, 32, 44, 96).
 *
 *   node scripts/gate.mjs --only pad_check
 *
 * One background and one drawing color: a picture is drawn on its owner's color, in the ink their initials wear on it
 * (public/ds/drawing.js). It holds:
 *   3. SAVE, AND BACK: Save is off on a pad that hasn't changed and on after a stroke; it puts the picture into the
 *      four faces (one <path> per stroke), on the color picked.
 *   1. THE PAD DRAWS WHAT IS STORED: after a line, two broad dots and a line run off the edge, the pad's canvas and
 *      the stored drawing as every face draws it (pictureSvg, its colours as the face computes them, rendered at the
 *      pad's own pixels) are the same picture: under 1% of the circle's pixels differ by more than 40 of 255.
 *   2. THE CIRCLE HOLDS EVERY STROKE: every stored point lies inside the circle less half its brush (a line dragged
 *      past the edge slides along the rim), and every point is an integer on the 255 grid.
 *   4. UNDO TAKES BACK WHAT WAS DONE: a stroke, and a Clear (which empties the pad: Save and Clear off, Undo on, the
 *      initials and "Draw here" back); no Fill, no second ink, no palettes on the pad.
 *   5. A COLOR RECOLOURS: picking Sun repaints the pad's ground in Sun and its lines in Sun's ink (the tones'
 *      own, read from the page), names it in words, ticks it alone, and keeps the drawing.
 *   5b. A BRUSH SAYS ITS SIZE, NOT A COLOUR: the three brush dots are the sheet's ink-1, whatever the color.
 *   5c. INITIALS, WHILE NOTHING IS DRAWN: the field shows on an empty pad, keeps letters and digits only, in capitals,
 *      three at most; the paper shows them; Save with nothing drawn gives initials on the color; a stroke hides it.
 *   3b. BACK TO INITIALS takes all four faces back to the initials.
 *   6. REDUCED MOTION: a picture's cross-fade into a face takes no time.
 *   7. EVERY OLD PICTURE IS DRAWN ON ITS OWNER'S COLOR: a picture stored on each of the old pad's eight palettes, with
 *      both inks and a Fill, put into a face of a different color each, in both columns (Void and Paper): the ground
 *      it is painted with is the face's color, every line is that color's initials ink, and the Fill is not drawn.
 *
 * PLANTED (PAD_PLANT=<name>, served in place of public/ds/pad.js, or of public/ds/avatar.css for gray):
 *   noclamp  the circle's clamp taken out: 2 red (2).
 *   wide     the pad drawing each line half as wide again as it stores it: 1 red (1).
 *   nodot    the pad stroking a one-point stroke as a path of no length (a canvas draws no cap on it): the two broad
 *            dots missing from the pad, 1 red (1).
 *   dotink   the brush dots painted in the color's ink: 1 red (5b).
 *   stale    the pad not reading the colours again when a color is picked: 1 red (5).
 *   gray     a face of a person drawing its picture on gray, not their color: 2 red (3, 7).
 *   slowfade the pad's fades (the hint's, the initials') taking 1.5 s, not 150 ms: ALL GREEN. 4 reads the hint and the
 *            initials once their fades have ended, so how fast a machine runs them can't turn it red (it did read
 *            them at a fixed 150 ms, mid-fade on a busy machine: 21 Nov, the hint 0 and 0.49).
 */
import fs from "node:fs";
import { BASE, boot, evalIn, waitFor, sleep } from "./lib/standalone_cdp.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

const PLANT = process.env.PAD_PLANT || "";
const PLANTS = ["noclamp", "wide", "nodot", "dotink", "stale", "gray", "slowfade"];
if (PLANT && !PLANTS.includes(PLANT)) throw new Error(`PAD_PLANT is one of ${PLANTS.join(", ")}`);
const PLANTED = PLANT ? (() => {
  const file = PLANT === "gray" ? "../public/ds/avatar.css" : "../public/ds/pad.js";
  const src = fs.readFileSync(new URL(file, import.meta.url), "utf8");
  const t = PLANT === "noclamp" ? src.replace("if (d <= max || d === 0) return [gx, gy];", "return [gx, gy];")
    : PLANT === "nodot" ? src.replace("      if (pts.length === 1) {", "      if (false) {")
    : PLANT === "dotink" ? src.replace('for (const b of host.querySelectorAll("[data-pad-size]")) b.setAttribute("aria-pressed", String(+b.dataset.padSize === size));',
      'for (const b of host.querySelectorAll("[data-pad-size]")) { b.firstElementChild.style.background = ink; b.setAttribute("aria-pressed", String(+b.dataset.padSize === size)); }')
    : PLANT === "stale" ? src.replace("color = b.dataset.padColor; readColors(); settle(true);", "color = b.dataset.padColor; settle(true);")
    : PLANT === "slowfade" ? src.replace('const paper = $("[data-pad-paper]"), cv = $("[data-pad-ink]"), letters = $("[data-pad-letters]");',
      'const paper = $("[data-pad-paper]"), cv = $("[data-pad-ink]"), letters = $("[data-pad-letters]"); document.head.insertAdjacentHTML("beforeend", "<style>.ds-pad-hint, .ds-pad-initials { transition-duration: 1500ms !important; }</style>");')
    : PLANT === "gray" ? src.replace("  --ds-pic-ground: var(--ds-person);\n", "")
    : src.replace("      ctx.lineWidth = width;\n      ctx.stroke(path());", "      ctx.lineWidth = width * 1.5;\n      ctx.stroke(path());");
  if (t === src) throw new Error(`the ${PLANT} plant didn't take`);
  return { pattern: PLANT === "gray" ? "*/ds/avatar.css*" : "*/ds/pad.js*", type: PLANT === "gray" ? "text/css" : "text/javascript", body: t };
})() : null;

const b = await boot({ vw: 1440, vh: 1000, dsf: 2, reduceMotion: false });
const { cdp, S } = b;
const J = async (e) => JSON.parse(await evalIn(cdp, S, e));
if (PLANTED) {
  cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: `${PLANTED.type}; charset=utf-8` }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(PLANTED.body).toString("base64") }, S).catch(() => {}); });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: PLANTED.pattern }] }, S);
}
const PAD = `document.querySelector("#dz-dark [data-pad-host]")`;
const FACES = `[...document.querySelectorAll("#dz-dark [data-pad-faces] .ds-face")]`;
const click = (sel) => evalIn(cdp, S, `(${PAD}.querySelector('${sel}').click(), 1)`);
const disabled = (sel) => J(`${PAD}.querySelector('${sel}').disabled`);
// A colour as the page computes it, as "r,g,b": a token's value read through a probe in the given element.
const TONE = (where, prop) => `(() => { const p = document.createElement("i"); p.style.color = "var(${prop})"; ${where}.append(p); const c = getComputedStyle(p).color; p.remove(); return c.match(/\\d+/g).slice(0, 3).join(","); })()`;
const PX = (u, v) => `JSON.stringify((() => { const cv = ${PAD}.querySelector("canvas"), n = cv.width; return [...cv.getContext("2d").getImageData(n * ${u} | 0, n * ${v} | 0, 1, 1).data].slice(0, 3).join(","); })())`;
let rect = null;
async function line(pts) {
  const at = ([u, v]) => ({ x: rect.x + u * rect.width, y: rect.y + v * rect.height });
  const [a, ...rest] = pts.map(at);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y }, S);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", buttons: 1, clickCount: 1 }, S);
  for (const p of rest) { await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "left", buttons: 1 }, S); await sleep(10); }
  const z = rest[rest.length - 1] || a;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: z.x, y: z.y, button: "left", buttons: 0, clickCount: 1 }, S);
  await sleep(150);
}
// The stored drawing, read back from the face it was put into: what its ground and lines are painted with (as the
// browser computes them), and each stroke's path.
const STORED = `JSON.stringify((() => {
  const svg = ${FACES}[3].querySelector("svg");
  if (!svg) return null;
  const rgb = (c) => c.match(/\\d+/g).slice(0, 3).join(",");
  return { ground: rgb(getComputedStyle(svg.querySelector("rect")).fill),
    paths: [...svg.querySelectorAll("path")].map((p) => ({ d: p.getAttribute("d"), ink: rgb(getComputedStyle(p).stroke), w: +p.getAttribute("stroke-width") })) };
})())`;

try {
  await cdp.send("Page.navigate", { url: `${BASE}/design` }, S);
  await waitFor(cdp, S, `${PAD} && ${PAD}.querySelector("canvas") && document.fonts.status === "loaded" ? 1 : 0`, { label: "/design's pad", timeout: 30000 });
  await evalIn(cdp, S, `(${PAD}.scrollIntoView({ block: "center" }), 1)`);
  await sleep(500);
  rect = await J(`JSON.stringify(${PAD}.querySelector("canvas").getBoundingClientRect())`);

  section("4. One background and one drawing color (the tools)");
  const tools = await J(`JSON.stringify({ palettes: ${PAD}.querySelectorAll("[data-pad-palette]").length, inks: ${PAD}.querySelectorAll("[data-pad-ink-pick]").length,
    fill: ${PAD}.querySelectorAll("[data-pad-fill]").length, colors: ${PAD}.querySelectorAll("[data-pad-color]").length, brushes: ${PAD}.querySelectorAll("[data-pad-size]").length })`);
  check("no palettes, no second ink, no Fill; twenty colors and three brushes", tools.palettes === 0 && tools.inks === 0 && tools.fill === 0 && tools.colors === 20 && tools.brushes === 3, JSON.stringify(tools));

  section("3. Save, and back (an empty pad)");
  check("Save is off on a pad that hasn't changed", await disabled("[data-pad-save]"));
  const teal = await J(`JSON.stringify(${TONE(PAD, "--person-teal")})`), tealInk = await J(`JSON.stringify(${TONE(PAD, "--person-teal-on")})`);

  // A line, two broad dots, and a fine line dragged across the top, past the circle's edge.
  await line(Array.from({ length: 24 }, (_, i) => { const t = 0.25 + (i / 23) * (Math.PI - 0.5); return [0.5 + 0.28 * Math.cos(t), 0.5 + 0.28 * Math.sin(t)]; }));
  await click('[data-pad-size="2"]');
  await line([[0.36, 0.36]]); await line([[0.64, 0.36]]);
  await click('[data-pad-size="0"]');
  // Pressed inside the circle (a press outside it lands on nothing), then run out past its right-hand edge.
  await line(Array.from({ length: 21 }, (_, i) => [0.45 + i * 0.04, 0.12]));
  check("Save is on after a stroke", !(await disabled("[data-pad-save]")));
  await click("[data-pad-save]");
  await sleep(500);
  const stored = await J(STORED);
  const drawn = await J(`JSON.stringify(${FACES}.map((f) => ({ drawn: f.hasAttribute("data-drawn"), paths: f.querySelectorAll("svg path").length, ready: f.querySelector(".ds-face-pic")?.hasAttribute("data-ready") || false })))`);
  check("Save puts the picture into all four faces, one path per stroke (4), on Teal in Teal's ink", drawn.length === 4 && drawn.every((f) => f.drawn && f.ready && f.paths === 4)
    && stored?.ground === teal && stored.paths.every((p) => p.ink === tealInk), JSON.stringify({ drawn, ground: stored?.ground, teal, inks: [...new Set(stored?.paths.map((p) => p.ink))], tealInk }));

  section("1. The pad draws what is stored");
  // The stored picture drawn at the pad's own pixels, beside the pad's canvas: the same picture. A picture's markup
  // names its colours as the face's variables, which an image doesn't have: they are put in as the face computes them.
  const cmp = await J(`(async () => {
    const cv = ${PAD}.querySelector("canvas"), n = cv.width;
    const face = ${FACES}[3], cs = getComputedStyle(face);
    const svg = face.querySelector("svg").outerHTML
      .replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" width="' + n + '" height="' + n + '" ')
      .replace(/var\\(--ds-pic-ground[^"]*\\)/g, cs.getPropertyValue("--ds-pic-ground").trim())
      .replace(/var\\(--ds-pic-ink[^"]*\\)/g, cs.getPropertyValue("--ds-pic-ink").trim());
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await img.decode();
    const c = document.createElement("canvas"); c.width = c.height = n;
    const x = c.getContext("2d");
    x.beginPath(); x.arc(n / 2, n / 2, n / 2, 0, Math.PI * 2); x.clip();
    x.drawImage(img, 0, 0, n, n);
    const a = x.getImageData(0, 0, n, n).data, b = cv.getContext("2d").getImageData(0, 0, n, n).data;
    let inside = 0, off = 0;
    const r = n / 2 - 2;
    for (let y = 0; y < n; y++) for (let x2 = 0; x2 < n; x2++) {
      if ((x2 - n / 2 + 0.5) ** 2 + (y - n / 2 + 0.5) ** 2 > r * r) continue;
      inside++;
      const i = (y * n + x2) * 4;
      if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 40) off++;
    }
    return JSON.stringify({ n, inside, off, share: off / inside });
  })()`);
  check("the pad's canvas and the stored picture differ in under 1% of the circle (more than 40 of 255)", cmp.share < 0.01, `${cmp.off} of ${cmp.inside} pixels at ${cmp.n} across (${(cmp.share * 100).toFixed(3)}%)`);

  section("2. The circle holds every stroke");
  {
    const out = [], notInt = [];
    for (const p of stored.paths) {
      const nums = p.d.match(/-?\d+(\.\d+)?/g).map(Number);
      const max = 127.5 - p.w / 2 + 0.75;
      for (let i = 0; i < nums.length; i += 2) {
        const d = Math.hypot(nums[i] - 127.5, nums[i + 1] - 127.5);
        if (d > max) out.push(`${nums[i]},${nums[i + 1]} (${d.toFixed(1)} > ${max.toFixed(1)})`);
      }
    }
    // The points themselves (not the midpoints between them) are integers: every M, the Q's control and the L.
    for (const p of stored.paths) for (const m of p.d.matchAll(/[MQL](-?[\d.]+),(-?[\d.]+)/g)) if (!Number.isInteger(+m[1]) || !Number.isInteger(+m[2])) notInt.push(m[0]);
    check("every stored point is inside the circle less half its brush (the line past the edge slid along the rim)", !out.length, out.slice(0, 6).join(" | ") || `${stored.paths.length} strokes`);
    check("every stored point is an integer on the 255 grid", !notInt.length, notInt.slice(0, 6).join(" "));
  }

  section("4. Undo takes back what was done");
  {
    // A dot at (0.5, 0.75), where nothing else is drawn: Undo takes it back.
    const spot = PX(0.5, 0.82);
    const before = await J(spot);
    await click('[data-pad-size="2"]');
    await line([[0.5, 0.82]]);
    const dotted = await J(spot);
    await click("[data-pad-undo]");
    await sleep(150);
    const back = await J(spot);
    check("a stroke is in the color's ink, and Undo takes it back", dotted === tealInk && back === before && before === teal, `${before} → ${dotted} → ${back}`);
    await click("[data-pad-clear]");
    // The hint and the initials fade back in (pad.css, --dur-150): read them once their fades have ENDED, never at a fixed
    // 150 ms, which on a busy machine lands mid-fade (21 Nov: the hint read 0 and 0.49 on rework's gate, the drawing fine).
    const cleared = await J(`(async () => {
      const pad = ${PAD}, hint = pad.querySelector("[data-pad-hint]"), letters = pad.querySelector("[data-pad-letters]");
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await Promise.all([hint, letters].flatMap((e) => e.getAnimations()).map((a) => a.finished.catch(() => {})));
      return JSON.stringify({ clear: pad.querySelector("[data-pad-clear]").disabled, undo: pad.querySelector("[data-pad-undo]").disabled,
        hint: +getComputedStyle(hint).opacity, letters: +getComputedStyle(letters).opacity });
    })()`);
    await click("[data-pad-undo]");
    await sleep(250);
    const again = await J(PX(0.5, 0.78));
    check("Clear empties the pad (Clear off, Undo on, the initials and the hint back) and Undo brings the whole drawing back",
      cleared.clear && !cleared.undo && cleared.hint > 0.5 && cleared.letters > 0.9 && again === tealInk, `${JSON.stringify(cleared)} → ${again}`);
  }

  section("5. A color recolours");
  {
    const sun = await J(`JSON.stringify(${TONE(PAD, "--person-sun")})`), sunInk = await J(`JSON.stringify(${TONE(PAD, "--person-sun-on")})`);
    await click('[data-pad-color="#F0C808"]');
    await sleep(150);
    const g = await J(PX(0.1, 0.5)), l = await J(PX(0.5, 0.78));
    const said = await J(`JSON.stringify({ name: ${PAD}.querySelector("[data-pad-colorname]").textContent, on: [...${PAD}.querySelectorAll("[data-pad-color][aria-checked='true']")].map((x) => x.getAttribute("aria-label")) })`);
    check("picking Sun repaints the ground in Sun and the lines in Sun's ink, says Sun in words and ticks it alone, and keeps the drawing",
      g === sun && l === sunInk && said.name === "Sun" && said.on.join() === "Sun" && !(await disabled("[data-pad-save]")), `${g} (Sun ${sun}), ${l} (ink ${sunInk}), ${JSON.stringify(said)}`);
  }

  section("5b. A brush says its size, not a colour");
  {
    const dots = await J(`JSON.stringify({ ink1: ${TONE(PAD, "--ink-1")}, dots: [...${PAD}.querySelectorAll("[data-pad-size] > i")].map((i) => getComputedStyle(i).backgroundColor.match(/\\d+/g).slice(0, 3).join(",")) })`);
    check("the three brush dots are the sheet's ink-1, not the color's ink", dots.dots.length === 3 && dots.dots.every((c) => c === dots.ink1), JSON.stringify(dots));
  }

  section("5c. Initials, while nothing is drawn");
  {
    const field = `${PAD}.querySelector("[data-pad-initials-input]")`;
    const shown = () => J(`JSON.stringify((() => { const r = ${PAD}.querySelector("[data-pad-initrow]"); return !r.hidden && getComputedStyle(r).visibility !== "hidden" && !r.inert; })())`);
    const withDrawing = await shown();
    await click("[data-pad-clear]");
    await sleep(150);
    const empty = await shown();
    await evalIn(cdp, S, `(${field}.focus(), ${field}.select(), 1)`);
    await cdp.send("Input.insertText", { text: "zq9!x" }, S);
    await sleep(150);
    const typed = await J(`JSON.stringify({ value: ${field}.value, paper: ${PAD}.querySelector("[data-pad-letters]").textContent })`);
    check("the field is away while something is drawn (its space kept, out of reach) and shown on an empty pad", !withDrawing && empty, `${withDrawing} / ${empty}`);
    check("it keeps letters and digits only, in capitals, three at most, and the paper shows them", typed.value === "ZQ9" && typed.paper === "ZQ9", JSON.stringify(typed));
    await click("[data-pad-save]");
    await sleep(400);
    const faces = await J(`JSON.stringify(${FACES}.map((f) => ({ drawn: f.hasAttribute("data-drawn"), letters: f.textContent.trim(), ground: getComputedStyle(f).backgroundColor.match(/\\d+/g).slice(0, 3).join(",") })))`);
    const sun = await J(`JSON.stringify(${TONE(PAD, "--person-sun")})`);
    check("Save with nothing drawn gives the initials typed, on the color picked", faces.every((f) => !f.drawn && f.letters === "ZQ9" && f.ground === sun), JSON.stringify(faces));
    await click("[data-pad-undo]");          // the drawing back, for what follows
    await sleep(200);
    check("a stroke on the pad hides the field again", !(await shown()));
  }

  section("3b. Back to initials");
  await click("[data-pad-initials]");
  await sleep(300);
  const initials = await J(`JSON.stringify(${FACES}.map((f) => ({ drawn: f.hasAttribute("data-drawn"), pic: !!f.querySelector(".ds-face-pic"), letters: f.textContent.trim() })))`);
  check("Back to initials takes all four faces back to the initials", initials.every((f) => !f.drawn && !f.pic && f.letters === "ZQ9"), JSON.stringify(initials));

  section("6. Reduced motion");
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, S);
  await click("[data-pad-save]");
  await sleep(200);
  const fade = await J(`JSON.stringify(${FACES}.map((f) => { const p = f.querySelector(".ds-face-pic"); return p ? getComputedStyle(p).transitionDuration : "none"; }))`);
  check("a picture's cross-fade into a face takes no time with reduced motion", fade.every((d) => d !== "none" && parseFloat(d) < 0.02), fade.join(" "));

  section("7. Every old picture is drawn on its owner's color");
  {
    const rows = await J(`(async () => {
      const { faceHtml } = await import("/ds/avatar.js");
      const at = (pts) => pts.map(([x, y]) => [Math.round(x * 255), Math.round(y * 255)]);
      const COLORS = ["#0072B2", "#E69F00", "#CC79A7", "#56B4E9", "#009E73", "#F0C808", "#2E2E2E", "#E0E0E0"];
      const TONES = ["deep-blue", "amber", "mauve", "sky", "green", "sun", "charcoal", "paper"];
      const out = [];
      for (const col of ["dz-dark", "dz-light"]) {
        const host = document.createElement("div");
        document.getElementById(col).append(host);
        for (let palette = 0; palette < 8; palette++) {
          // Filled with its first ink, then drawn in its second, and a dot in the first: the old pad's three ways.
          const drawing = { palette, strokes: [{ ink: 0, brush: 255, pts: at([[0.5, 0.5]]) }, { ink: 1, brush: 52, pts: at([[0.2, 0.6], [0.5, 0.3], [0.8, 0.6]]) }, { ink: 0, brush: 110, pts: at([[0.5, 0.75]]) }] };
          host.insertAdjacentHTML("beforeend", faceHtml({ name: "Old picture " + palette, color: COLORS[palette], drawing, size: 44 }));
          const face = host.lastElementChild, svg = face.querySelector("svg");
          const probe = (v) => { const p = document.createElement("i"); p.style.color = "var(" + v + ")"; face.append(p); const c = getComputedStyle(p).color; p.remove(); return c.match(/\\d+/g).slice(0, 3).join(","); };
          const rgb = (c) => (c.match(/\\d+/g) || []).slice(0, 3).join(",");
          out.push({ col, palette, tone: TONES[palette], want: probe("--person-" + TONES[palette]), wantInk: probe("--person-" + TONES[palette] + "-on"),
            ground: rgb(getComputedStyle(svg.querySelector("rect")).fill), face: rgb(getComputedStyle(face).backgroundColor),
            inks: [...svg.querySelectorAll("path")].map((p) => rgb(getComputedStyle(p).stroke)), widest: Math.max(...[...svg.querySelectorAll("path")].map((p) => +p.getAttribute("stroke-width"))) });
        }
        host.remove();
      }
      return JSON.stringify(out);
    })()`);
    const bad = rows.filter((r) => r.ground !== r.want || r.face !== r.want || r.inks.length !== 2 || r.inks.some((c) => c !== r.wantInk) || r.widest > 255);
    check(`all 8 old palettes, in both columns (${rows.length}): ground and face are the owner's color, both lines its ink, the Fill not drawn`,
      rows.length === 16 && !bad.length, bad.length ? JSON.stringify(bad.slice(0, 3)) : `e.g. ${rows[0].tone} ${rows[0].ground} / ${rows[0].wantInk}; ${rows[15].tone} ${rows[15].ground} / ${rows[15].wantInk}`);
  }

  console.log(`\npage errors: ${b.pageErrors.length ? b.pageErrors.join(" | ").slice(0, 400) : "none"}`);
  check("no page errors", !b.pageErrors.length);
} finally {
  await b.done().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }
