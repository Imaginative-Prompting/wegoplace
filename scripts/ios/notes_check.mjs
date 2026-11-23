#!/usr/bin/env node
// Notes on the live app (v121, 20 Nov), each measured where the app is used: an iPhone Simulator, the app added to
// the Home Screen and opened from its icon, real touches, the software keyboard. Off the gate (scripts/ios/README.md
// says what it needs). On the gate's server (WGP_BASE, WGP_GATE_CARD), as the made-up trip's host.
//
//   LAB_UDID=<a device of your own> IOS_AXE=<the AXe binary> WGP_BASE=… WGP_GATE_CARD=… node scripts/ios/notes_check.mjs <out folder>
//
// It holds:
//   A. NOTHING FADES THE HEAD AT REST: on the Itinerary, Places, Split, Photos and Chat, opened and not scrolled, the
//      page's title is wholly below the status bar's strip, nothing is drawn over it (the topmost thing at its middle is
//      the title), and no element over the head is see-through.
//   B. THE END OF THE ITINERARY IS ITS LAST ROW: its last day chosen by its pill and the list scrolled to its end, the
//      tab bar is back (the room the page keeps for it is filled), and what is below the last row up to the first thing
//      floating over the foot (the +, the dock, the bar) is the page's own clearance, at most 48 px, never a screen of
//      nothing.
//   C. A FIELD BEING TYPED IN STAYS ABOVE THE KEYS: in each sheet with a field (the Itinerary's +, Places' +, Split's +,
//      Packing's +), the first field touched with a finger brings the software keyboard up, and then the field is wholly
//      inside what is visible over the keys (window.visualViewport), and so is the sheet's own action (Add, Save).
//   D. A CHIP WITH AN ICON KEEPS INSIDE ITSELF: in each of those sheets, no chip with an icon has its words or its icon
//      past its own edge.
// A still of each: notes-<what>.png (the heads in light and dark, at rest and a little scrolled; each sheet before its
// field is touched and with the keys up). iOS's own questions (the location prompt) are answered Allow, as on a phone
// that has used the app. The device is erased first and shut down at the end, whatever happens.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connect } from "./phone.mjs";
const UDID = process.env.LAB_UDID;
import { makeApi } from "../lib/seed_memories.mjs";
import { ORIGIN, tripPath } from "../lib/gate_trip.mjs";
import { freeLoopbackPort } from "../lib/browser.mjs";

const out = path.resolve(process.argv[2] || "");
if (!process.argv[2]) { console.error("usage: node scripts/ios/notes_check.mjs <out folder>"); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 700) : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 1400) : ""}`); }
};
const measured = {};

// ── what the page answers ──────────────────────────────────────────────────────────────────────────────────────────
// A. The head at rest: the title, the status bar's strip, and what is drawn at the title's middle.
const HEAD = (title) => `(() => {
  const t = document.querySelector(${JSON.stringify(title)});
  if (!t) return JSON.stringify({ none: true });
  const r = t.getBoundingClientRect(), bar = document.querySelector(".statusbar"), b = bar ? bar.getBoundingClientRect() : { bottom: 0 };
  const probe = document.createElement("div"); probe.style.cssText = "position:fixed;top:0;height:env(safe-area-inset-top);width:1px;visibility:hidden"; document.body.append(probe);
  const inset = probe.getBoundingClientRect().height; probe.remove();
  const x = r.left + Math.min(r.width / 2, 40), y = r.top + r.height / 2;
  const stack = document.elementsFromPoint(x, y).slice(0, 6).map((n) => n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + "." + String(n.className).split(" ")[0]);
  const top = document.elementFromPoint(x, y);
  // Anything drawn at the title's middle above it, and how see-through it is.
  const over = document.elementsFromPoint(x, y).filter((n) => n !== t && !t.contains(n) && !n.contains(t)).slice(0, 4).map((n) => { const s = getComputedStyle(n); return { n: n.tagName.toLowerCase() + "." + String(n.className).split(" ")[0], bg: s.backgroundColor, op: s.opacity, mask: s.webkitMaskImage || s.maskImage }; });
  let faint = null; for (let n = t; n; n = n.parentElement) { const s = getComputedStyle(n); if (Number(s.opacity) < 0.99 || (s.webkitMaskImage && s.webkitMaskImage !== "none") || (s.maskImage && s.maskImage !== "none")) { faint = { n: n.tagName.toLowerCase() + "." + String(n.className).split(" ")[0], op: s.opacity, mask: s.webkitMaskImage || s.maskImage }; break; } }
  return JSON.stringify({ title: [Math.round(r.top), Math.round(r.bottom)], bar: Math.round(b.bottom), inset: Math.round(inset), onTop: !!top && (top === t || t.contains(top)), stack, over, faint,
    standalone: navigator.standalone === true || matchMedia("(display-mode: standalone)").matches, vv: window.visualViewport ? [Math.round(visualViewport.offsetTop), Math.round(visualViewport.height)] : null, ih: innerHeight });
})()`;
// B. The end of the list: what is below the last row up to the first thing floating over the foot.
const END = `(() => {
  const v = document.querySelector("#view"); v.scrollTop = v.scrollHeight;
  return new Promise((ok) => setTimeout(() => {
    const rows = [...v.querySelectorAll(".ag-day")].pop();
    const last = rows ? [...rows.querySelectorAll(".ag-slot, .ag-ev, .ag-row, .ag-empty, li, p")].filter((n) => n.getClientRects().length).pop() || rows : null;
    const lastBottom = last ? Math.round(last.getBoundingClientRect().bottom) : null;
    const floats = [".ag-fab", ".dock .backbtn:not([hidden])", ".netpill:not([hidden])", ".tabbar"].map((s) => document.querySelector(s)).filter((n) => n && n.getClientRects().length && getComputedStyle(n).display !== "none" && getComputedStyle(n).visibility !== "hidden");
    const floatTop = floats.length ? Math.round(Math.min(...floats.map((n) => n.getBoundingClientRect().top))) : innerHeight;
    // The + floats at the right: the room is measured below the last row's own column, under the highest float that is over it.
    return ok(JSON.stringify({ lastBottom, floatTop, room: lastBottom === null ? null : floatTop - lastBottom, bar: document.body.dataset.tabs || "here", scrollHeight: v.scrollHeight, client: v.clientHeight, padBottom: getComputedStyle(v).paddingBottom,
      listPad: (v.querySelector(".ag-days") || {}).style?.paddingBottom || "", ih: innerHeight }));
  }, 1200));
})()`;
// C and D. With a field focused: the field, the sheet's action and every chip with an icon, against what is visible.
const FIELD = `(() => {
  const vv = window.visualViewport, top = vv ? vv.offsetTop : 0, bottom = vv ? vv.offsetTop + vv.height : innerHeight;
  const f = document.activeElement, fr = f && f.getBoundingClientRect();
  const sheet = document.querySelector(".sh-root[data-open='1'] .sh-sheet") || document.querySelector(".sh-root .sh-sheet");
  const acts = sheet ? [...sheet.querySelectorAll("button")].filter((b) => /^(Add|Save|Add it|Done|Add a plan|Add this)/.test((b.textContent || "").trim()) && b.getClientRects().length) : [];
  const act = acts[0] || null, ar = act && act.getBoundingClientRect();
  const chips = sheet ? [...sheet.querySelectorAll(".chip, .ds-chip")].filter((c) => c.querySelector("svg, img, .ico") && c.getClientRects().length && !/auto|scroll/.test(getComputedStyle(c).overflowX)).map((c) => {
    const r = c.getBoundingClientRect(); const kids = [...c.querySelectorAll("*")].filter((k) => k.getClientRects().length);
    const out = kids.filter((k) => { const q = k.getBoundingClientRect(); return q.right > r.right + 0.5 || q.left < r.left - 0.5; });
    const past = out.length + (c.scrollWidth > c.clientWidth + 1 ? 1 : 0);
    return { words: (c.textContent || "").trim().slice(0, 30), cls: String(c.className).slice(0, 40), w: Math.round(r.width), past, out: out.map((k) => k.tagName.toLowerCase() + "+" + Math.round(Math.max(k.getBoundingClientRect().right - r.right, r.left - k.getBoundingClientRect().left))) };
  }) : [];
  return JSON.stringify({ field: f ? { tag: f.tagName.toLowerCase(), name: f.getAttribute("aria-label") || (f.labels && f.labels[0] ? f.labels[0].textContent.trim() : "") || f.placeholder || f.id, top: Math.round(fr.top), bottom: Math.round(fr.bottom) } : null,
    visible: [Math.round(top), Math.round(bottom)], keys: Math.round(innerHeight - (vv ? vv.height : innerHeight)), act: act ? { words: act.textContent.trim().slice(0, 20), top: Math.round(ar.top), bottom: Math.round(ar.bottom) } : null,
    chips, ih: innerHeight });
})()`;

const downNow = (why) => {
  console.log(`\nSTOPPED (${why})`);
  try { execSync(`/usr/bin/xcrun simctl shutdown ${process.env.LAB_UDID}`, { stdio: "ignore" }); } catch { /* already down */ }
  process.exit(1);
};
process.on("uncaughtException", (e) => downNow(e?.stack || e));
process.on("unhandledRejection", (e) => downNow(e?.stack || e));

let phone = null;
let code = 1;
try {
  const api = await makeApi();
  const listen = await freeLoopbackPort();
  phone = await connect({ listen, upstream: Number(new URL(ORIGIN).port), out, said: [], pageErrors: [] });
  phone.cookie({ name: "wgp_session", value: api.session, maxAge: 3600 });
  const at = (p) => `http://localhost:${listen}${p}`;
  const tab = await phone.openTab();
  await tab.go(at("/"));                                     // added to the Home Screen, opened from its icon
  await sleep(6000);
  const read = async (expr) => { try { return JSON.parse(await tab.page(expr)); } catch (e) { return { noAnswer: String(e.message).slice(0, 160) }; } };
  // iOS's own question over the app (where you are): answered Allow, as on a phone that has used the app before. The
  // alert is not in the app's accessibility tree, so its Allow is read at its place on an iPhone 17 (275,508 in points,
  // measured off this run's own still) and touched only if that is what is there.
  const AXE = process.env.IOS_AXE;
  const ALLOW = [275, 508];
  const answerIos = async () => {
    let at = "";
    try { at = execFileSync(AXE, ["describe-ui", "--point", ALLOW.join(","), "--udid", UDID], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch { return; }
    if (!/"AXLabel"\s*:\s*"Allow"/.test(at)) return;
    execFileSync(AXE, ["tap", "-x", String(ALLOW[0]), "-y", String(ALLOW[1]), "--udid", UDID], { stdio: "ignore" });
    console.log("  note  iOS asked for the location: touched Allow");
    await sleep(1200);
  };
  await answerIos();

  // ── A. the head at rest, on each main screen, in light and in dark ──
  for (const scheme of ["dark", "light"]) {
  execSync(`/usr/bin/xcrun simctl ui ${UDID} appearance ${scheme}`);
  for (const [name, hash, title] of [["itinerary", "#/", ".ag-tripname-t, h1.ag-tripname, .ag-tripname-flow"], ["places", "#/places", ".pl-top h1, .pl-top .h1, .pl-title, #view h1"],
    ["split", "#/split", ".sp-h1, #view h1"], ["photos", "#/memories", ".me-title"], ["chat", "#/chat", ".ch-head h1, #view h1"]]) {
    await tab.go(at(tripPath(hash)));
    await tab.wait(`document.querySelector(${JSON.stringify(title.split(", ")[0])}) || document.querySelector("#view h1") ? 1 : 0`, `the ${name}`, 30000).catch(() => 0);
    await sleep(2500);
    await answerIos();
    await tab.shot(`notes-a-head-${name}-${scheme}`);
    const h = await read(HEAD(title));
    measured[`head-${name}-${scheme}`] = h;
    check(`A. ${name} (${scheme}), at rest: the title wholly below the status bar's strip, nothing drawn over it, nothing over it see-through`,
      !h.none && h.standalone && h.title[0] >= h.bar && h.onTop && !h.faint, JSON.stringify(h));
    // A little scrolled: what the head does to what passes under it (a still only).
    await tab.page(`(document.querySelector("#view").scrollTop = 140, 1)`).catch(() => 0);
    await sleep(900);
    await tab.shot(`notes-a-head-${name}-${scheme}-scrolled`);
  }
  }

  // ── B. the end of the Itinerary, its last day chosen ──
  await tab.go(at(tripPath("#/")));
  await tab.wait(`document.querySelector(".ag-pill") ? 1 : 0`, "the Itinerary's day pills", 30000);
  await sleep(1500);
  await answerIos();
  await tab.page(`(() => { const p = [...document.querySelectorAll(".ag-pill")].pop(); p.scrollIntoView({ inline: "center", block: "nearest" }); return 1; })()`);
  await sleep(500);
  const lastPill = await read(`(() => { const p = [...document.querySelectorAll(".ag-pill")].pop(); const r = p.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), vy: window.visualViewport ? visualViewport.offsetTop : 0 }); })()`);
  await tab.tapAt(lastPill.x, lastPill.y);
  await sleep(1500);
  await tab.shot("notes-b-last-day-chosen");
  const end = await read(END);
  measured.end = end;
  await tab.shot("notes-b-end");
  check("B. the Itinerary scrolled to its end, its last day chosen: the bar back, and below the last row only the page's clearance (48 px at most) before the first thing floating over the foot",
    end.room !== null && end.room >= 0 && end.room <= 48 && end.bar === "here", JSON.stringify(end));

  // ── C and D. each sheet with a field: the keys up, the field and the action above them, chips inside themselves ──
  const OPEN = ".sh-root[data-open='1']";
  for (const [name, hash, plus, field, lower] of [
    ["itinerary-add", "#/", ".ag-fab", `${OPEN} input[type='text']`, [`${OPEN} input[type='search']`, `${OPEN} textarea`]],
    ["places-add", "#/places", ".pl-fab, .fab:not([hidden])", `${OPEN} input[type='text']`, [`${OPEN} textarea`, `${OPEN} input[type='url']`]],
    ["split-add", "#/split", ".sp-fab", `${OPEN} input[type='text']`, [`${OPEN} input[aria-label='What was it'], ${OPEN} input[placeholder='What was it']`]],
    ["packing-add", "#/pack", ".pk-fab", `${OPEN} input[type='text']`, [`${OPEN} textarea`]],
  ]) {
    await tab.go(at(tripPath(hash)));
    await tab.wait(`document.querySelector(${JSON.stringify(plus.split(", ")[0])}) || document.querySelector(".fab:not([hidden])") ? 1 : 0`, `the ${name} +`, 30000).catch(() => 0);
    await sleep(1500);
    const touched = await tab.touchEl(plus.split(", ")[0]);
    if (/^no /.test(touched)) await tab.touchEl(".fab:not([hidden])");
    await answerIos();
    const opened = await tab.wait(`document.querySelector(".sh-root[data-open='1']") ? 1 : 0`, `the ${name} sheet`, 15000).then(() => true, () => false);
    await sleep(1200);
    await tab.shot(`notes-c-${name}-open`);
    if (!opened) console.log(`  note  ${name}: no sheet open after the touch; on the screen: ${tab.screenLabels().slice(0, 12).join(" | ")}`);
    const fields = await read(`JSON.stringify([...document.querySelectorAll(".sh-root[data-open='1'] input, .sh-root[data-open='1'] textarea, .sh-root[data-open='1'] select")].filter((n) => n.getClientRects().length).map((n) => n.tagName.toLowerCase() + "[" + (n.type || "") + "] " + (n.getAttribute("aria-label") || n.placeholder || n.id || "")))`);
    console.log(`  note  ${name}: the sheet's fields, in order: ${JSON.stringify(fields)}`);
    // The field a person types in first: the sheet's first text field, touched with a finger (the keys come up).
    console.log(`  note  ${await tab.touchEl(field.split(", ")[0])}`);
    await sleep(2500);
    await tab.shot(`notes-c-${name}`);
    const m = await read(FIELD);
    measured[name] = m;
    const inside = (b) => b && b.top >= m.visible[0] - 0.5 && b.bottom <= m.visible[1] + 0.5;
    check(`C. ${name}: the keys up (${m.keys} px), the field being typed in wholly above them`, !!m.field && m.keys > 100 && inside(m.field), JSON.stringify(m));
    check(`C. ${name}: the sheet's action (${m.act ? m.act.words : "none found"}) is reachable above the keys`, !!m.act && inside(m.act), JSON.stringify({ act: m.act, visible: m.visible }));
    check(`D. ${name}: no chip with an icon has its words or icon past its own edge`, m.chips.every((c) => !c.past), JSON.stringify(m.chips));
    // A field further down, as a person reaches it: the keys put away, the sheet scrolled so the field stands low on the
    // screen (where the keys will come), then touched there. The keys come up over it; it must end up above them.
    for (const [k, sel] of lower.entries()) {
      await tab.page(`(document.activeElement && document.activeElement.blur(), 1)`).catch(() => 0);
      await sleep(1500);
      const at2 = await read(`(() => { const f = document.querySelector(${JSON.stringify(sel)}); if (!f) return JSON.stringify(null);
        const port = f.closest(".sh-body") || f.parentElement; const want = innerHeight * 0.72;
        port.scrollTop += f.getBoundingClientRect().top + f.getBoundingClientRect().height / 2 - want;
        const r = f.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + Math.min(r.width / 2, 120)), y: Math.round(r.top + r.height / 2) }); })()`);
      if (!at2 || at2.noAnswer) { check(`C. ${name}: a lower field (${k + 1}) to touch`, false, JSON.stringify({ sel, at2 })); continue; }
      await sleep(400);
      await tab.tapAt(at2.x, at2.y);
      await sleep(2500);
      await tab.shot(`notes-c-${name}-lower-${k + 1}`);
      const m2 = await read(FIELD);
      measured[`${name}-lower-${k + 1}`] = m2;
      const in2 = (b) => b && b.top >= m2.visible[0] - 0.5 && b.bottom <= m2.visible[1] + 0.5;
      check(`C. ${name}: a lower field (${m2.field ? m2.field.name : "?"}), touched where it stood (y ${at2.y}), ends wholly above the keys (${m2.keys} px)`,
        !!m2.field && m2.field.tag !== "main" && m2.keys > 100 && in2(m2.field), JSON.stringify(m2));
    }
    await tab.page(`(document.activeElement && document.activeElement.blur(), 1)`).catch(() => 0);
    await tab.page(`(() => { const s = document.querySelector(".sh-root[data-open='1'] .sh-scrim"); if (s) s.click(); return 1; })()`).catch(() => 0);
    await sleep(800);
  }
  fs.writeFileSync(path.join(out, "notes.json"), JSON.stringify(measured, null, 2) + "\n");
  console.log(`\n${pass} passed, ${fail} failed`);
  code = fail ? 1 : 0;
} catch (e) {
  console.log(`\nSTOPPED: ${e?.stack || e}\n${pass} passed, ${fail} failed before it stopped`);
  code = 1;
} finally {
  if (phone) { try { await phone.done(); } catch { /* down */ } }
  try { execSync(`/usr/bin/xcrun simctl shutdown ${process.env.LAB_UDID}`, { stdio: "ignore" }); } catch { /* already down */ }
  console.log(`  note  the device shut down at ${new Date().toTimeString().slice(0, 8)}`);
}
process.exit(code);
