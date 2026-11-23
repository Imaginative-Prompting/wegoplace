// The collage appearance drawer, driven for real: ground and N-per-memory (every photo is bare: there is no Photo style).
//
//   node scripts/gate.mjs --who <session> --only collage_look     (the gate's own server, its made-up trip)
//
// PLANTED: COLLAGELOOK_PLANT=style serves today's memories.js with the Photo style group back in the drawer
// (Mixed, Polaroid, Print, Bare): 2 and 4 go red.
//
// A board is made of the trip's memories, so the check brings its own: six, made before the
// browser starts and removed when it ends, however it ends.
import { BASE, boot, evalIn, waitFor, sleep } from "./lib/standalone_cdp.mjs";
import { seedMemories, makeApi } from "./lib/seed_memories.mjs";
import { tripPath, tripApi, TRIP_NAME, PEOPLE, d1 } from "./lib/gate_trip.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLANT = process.env.COLLAGELOOK_PLANT || "";
if (PLANT && PLANT !== "style") throw new Error(`no such plant: ${PLANT}`);
const PLANTED = PLANT ? (() => {
  const s = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/js/memories.js"), "utf8");
  const t = s.replace('+ group("Photos from each memory",', '+ group("Photo style", "", [["mixed", "Mixed"], ["polaroid", "Polaroid"], ["print", "Print"], ["bare", "Bare"]]'
    + '.map(([v, l]) => chip("frame", v, l, look.frame === v)).join("")) + group("Photos from each memory",');
  if (t === s) throw new Error("the style plant changed nothing"); return t; })() : null;

const results = [];
const check = (n, ok, d) => { results.push(!!ok); console.log(`${ok ? "  ok  " : "  FAIL"}  ${n}${d ? "   — " + d : ""}`); };
// AWAIT FIRST, THEN STRINGIFY. Wrapping an async expression in JSON.stringify() serialises the
// PENDING PROMISE — "{}" — so every field comes back undefined and the failure reads as the
// feature being broken rather than the harness not waiting. evalIn's awaitPromise only helps
// when the promise is the OUTERMOST value, which it is not once it is inside a call.
const J = async (c, S, e) => JSON.parse(
  await evalIn(c, S, `Promise.resolve(${e}).then((v) => JSON.stringify(v))`));

const seed = await seedMemories(6);
const api = await makeApi();
// The names of the trip's places and plans: none may be on a page a stranger opens.
const tripNow = (await api(tripApi())).json || {};
const tripWords = [...(tripNow.places || []).map((p) => p.name), ...(tripNow.events || []).map((e) => e.title)].filter((w) => w && w.length >= 6 && !TRIP_NAME.includes(w));
let shared = null;      // the board this run shares: its link is stopped on exit
console.log(`seeded ${seed.ids.length} memories; removed on exit`);
const b = await boot({ vw: 390, vh: 844 });
try {
  await b.setInsets({ top: 59, right: 0, bottom: 34, left: 0 });
  if (PLANTED) {
    b.cdp.on((m) => { if (m.sessionId === b.S && m.method === "Fetch.requestPaused") b.cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(PLANTED).toString("base64") }, b.S).catch(() => {}); });
    await b.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/memories.js*" }] }, b.S);
  }
  // Start clean: this preference persists in localStorage, so a previous run would decide the
  // answers to every assertion below.
  // Clear the stored preference ONCE, before the first load — and keep the identifier so it can
  // be removed again. Left installed it re-clears on every document, including the reload in
  // section 6, which is a persistence test that would then be testing the harness.
  const wipe = await b.cdp.send("Page.addScriptToEvaluateOnNewDocument",
    { source: `try { localStorage.removeItem("wgp.collage.look"); } catch {}` }, b.S);
  await b.cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/memories")}` }, b.S);
  await waitFor(b.cdp, b.S, `document.querySelector('.me-viewbtn[data-view="collage"]') ? 1 : 0`,
    { label: "the memories view toggle" });
  await sleep(500);

  const tap = async (sel) => {
    await evalIn(b.cdp, b.S, `(() => { const n = document.querySelector(${JSON.stringify(sel)});
      if (n) n.scrollIntoView({ block: "center" }); return 1; })()`);
    await sleep(250);
    const p = await J(b.cdp, b.S, `(() => { const n = document.querySelector(${JSON.stringify(sel)});
      if (!n) return null; const r = n.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
    if (!p) throw new Error("no element: " + sel);
    const pt = [{ x: p.x, y: p.y, radiusX: 6, radiusY: 6, force: 1, id: 1 }];
    await b.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt }, b.S);
    await sleep(50);
    await b.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, b.S);
    await sleep(700);
  };

  console.log("\n1. the board, and the button on it");
  await tap('.me-viewbtn[data-view="collage"]');
  await waitFor(b.cdp, b.S, `document.querySelectorAll(".cg-item").length > 3 ? 1 : 0`, { label: "the board" });
  await sleep(700);
  check("the appearance button is on the board, not in the row above it",
    await evalIn(b.cdp, b.S, `!!document.querySelector(".cg-look")`));
  const before = await J(b.cdp, b.S, `({
    bg: document.querySelector(".cg-root").dataset.bg,
    items: document.querySelectorAll(".cg-item").length,
    frames: [...new Set([...document.querySelectorAll(".cg-item")].map(n => n.dataset.frame))].sort(),
  })`);
  check("it starts on the seed's own choices", !!before.bg && before.items > 3,
    `${before.bg}, ${before.items} prints, frames [${before.frames.join(",")}]`);

  console.log("\n2. the drawer opens with its groups");
  await tap(".cg-look");
  await waitFor(b.cdp, b.S, `document.querySelector(".cg-looksheet") ? 1 : 0`, { label: "the drawer" });
  const heads = await J(b.cdp, b.S, `[...document.querySelectorAll(".cg-lookhead")].map(h => h.textContent.trim())`);
  check("Background, Photos from each memory, and the boards already shared (no Photo style)",
    heads.length === 3 && /Background/.test(heads[0]) && /each memory/i.test(heads[1]) && /Shared links/.test(heads[2]),
    heads.join(" | "));
  const grounds = await J(b.cdp, b.S,
    `[...document.querySelectorAll('.cg-chip[data-g="background"]')].map(n => n.dataset.v)`);
  check("every ground in the registry is offered, plus Automatic",
    grounds.length === 6 && grounds[0] === "" && grounds.includes("fridge") && grounds.includes("slate"),
    grounds.map((g) => g || "(auto)").join(","));
  check("each ground carries its OWN colour as a swatch — no second palette to keep in step",
    await evalIn(b.cdp, b.S, `(() => {
      const n = document.querySelector('.cg-chip[data-g="background"][data-v="corkboard"] .cg-sw');
      return !!n && /rgb/.test(getComputedStyle(n).backgroundColor); })()`));

  console.log("\n3. changing the ground changes the board AND the fastener");
  await tap('.cg-chip[data-g="background"][data-v="fridge"]');
  const onFridge = await J(b.cdp, b.S, `({
    bg: document.querySelector(".cg-root").dataset.bg,
    kinds: [...new Set([...document.querySelectorAll(".cg-fast")].filter(f=>!f.hidden).map(f=>f.dataset.kind))],
  })`);
  check("the board is a fridge and every print is held by a MAGNET",
    onFridge.bg === "fridge" && onFridge.kinds.join(",") === "magnet",
    `${onFridge.bg}, [${onFridge.kinds.join(",")}]`);

  console.log("\n4. every print is bare: no frame to pick");
  const framed = await J(b.cdp, b.S, `({
    chips: document.querySelectorAll('.cg-chip[data-g="frame"]').length,
    frames: [...new Set([...document.querySelectorAll(".cg-item")].map(n => n.dataset.frame))],
  })`);
  check("the drawer offers no photo style, and every print on the fridge is bare",
    framed.chips === 0 && framed.frames.join(",") === "bare", `${framed.chips} frame chip(s), frames [${framed.frames.join(",")}]`);

  console.log("\n5. N photos from each memory");
  await tap('.cg-chip[data-g="perMemory"][data-v="1"]');
  const one = await evalIn(b.cdp, b.S, `document.querySelectorAll(".cg-item").length`);
  // ASSERT AGAINST THE DATA, not against a guess. On a trip where every memory happens to hold
  // one photo, "one per memory" legitimately changes nothing — and a check that demanded a
  // smaller number would be reporting the fixture, not the feature.
  const memCount = await evalIn(b.cdp, b.S, `(() => {
    const ids = [...document.querySelectorAll(".cg-item")].map(n => String(n.dataset.id || "").split(":")[0]);
    return new Set(ids).size; })()`);
  check("one per memory yields exactly one print per memory",
    one === memCount && one > 0 && one <= before.items,
    `${one} prints across ${memCount} memories (was ${before.items} in total)`);
  const perMem = await J(b.cdp, b.S, `(() => {
    const ids = [...document.querySelectorAll(".cg-item")].map(n => n.dataset.id || "");
    const mem = ids.map(i => String(i).split(":")[0]);
    const counts = {}; for (const m of mem) counts[m] = (counts[m] || 0) + 1;
    return { max: Math.max(...Object.values(counts)), memories: Object.keys(counts).length }; })()`);
  check("…and it really is one from EACH, not the first N overall",
    perMem.max === 1 && perMem.memories === one, `max ${perMem.max} per memory across ${perMem.memories}`);

  console.log("\n6. it survives a reload — it is a setting, not a mood");
  await b.cdp.send("Runtime.evaluate", { expression: `document.querySelector(".sh-root button.sh-x")?.click()` }, b.S);
  await sleep(400);
  await b.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: wipe.identifier }, b.S);
  await b.cdp.send("Page.reload", { ignoreCache: true }, b.S);
  await waitFor(b.cdp, b.S, `document.querySelector('.me-viewbtn[data-view="collage"]') ? 1 : 0`, { label: "reload" });
  await sleep(600);
  await tap('.me-viewbtn[data-view="collage"]');
  await waitFor(b.cdp, b.S, `document.querySelectorAll(".cg-item").length > 0 ? 1 : 0`, { label: "the board again" });
  await sleep(900);
  const after = await J(b.cdp, b.S, `({
    bg: document.querySelector(".cg-root").dataset.bg,
    items: document.querySelectorAll(".cg-item").length,
    frames: [...new Set([...document.querySelectorAll(".cg-item")].map(n => n.dataset.frame))],
  })`);
  check("the fridge and the one-per-memory both came back, every print still bare",
    after.bg === "fridge" && after.frames.join(",") === "bare" && after.items === one,
    `${after.bg}, [${after.frames.join(",")}], ${after.items} prints`);
  console.log("\n7. saving it out, and the share link");
  await tap(".cg-look");
  await waitFor(b.cdp, b.S, `document.querySelector(".cg-lookfoot") ? 1 : 0`, { label: "the drawer foot" });
  await sleep(400);
  const acts = await J(b.cdp, b.S,
    `[...document.querySelectorAll(".cg-lookfoot .cg-save")].map(n => n.dataset.kind)`);
  check("the drawer offers a still, a looping video, and a share link",
    acts.join(",") === "image,video,link", acts.join(","));

  // THE SHARE LINK, for real: render, upload, and then fetch the public page with the session
  // cookie stripped — because "public" is the entire claim and a page that only works while
  // signed in would pass any check that used the same browser.
  await tap('.cg-lookfoot .cg-save[data-kind="link"]');
  await waitFor(b.cdp, b.S,
    `(() => { const f = document.querySelector(".cg-shareurl"); return f && /\\/s\\//.test(f.value) ? 1 : 0; })()`,
    { label: "the share url", timeout: 60000 });
  const url = await evalIn(b.cdp, b.S, `document.querySelector(".cg-shareurl").value`);
  check("it produced a wegoplace.com/s/<id> link", /\/s\/[a-f0-9]{32}$/.test(url), url);
  shared = (/\/s\/([a-f0-9]{32})$/.exec(url) || [])[1] || null;

  const anon = await J(b.cdp, b.S, `(async () => {
    // No credentials at all — this is what a stranger's browser sends.
    const r = await fetch(${JSON.stringify("")} + document.querySelector(".cg-shareurl").value,
      { credentials: "omit", cache: "no-store" });
    const html = await r.text();
    const i = await fetch(document.querySelector(".cg-shareurl").value + "/image",
      { credentials: "omit", cache: "no-store" });
    const buf = await i.arrayBuffer();
    return { status: r.status, hasImg: /og:image/.test(html), cta: /Make your own/.test(html), mark: /class="mark"/.test(html),
             imgStatus: i.status, imgBytes: buf.byteLength,
             // What of the trip's words the page carries. Its name is the page's title, twice (the
             // tab and the link preview: the sharer's own words for the board), and must be nowhere
             // else; a memory's caption, a person's name, a place's name or the word "caption" itself
             // must not be there at all.
             named: html.split(${JSON.stringify(TRIP_NAME)}).length - 1,
             titled: [/<title>([^<]*)<\\/title>/.exec(html), /<meta property="og:title" content="([^"]*)">/.exec(html)].map((m) => (m ? m[1] : null)),
             leaks: [...(/caption/i.test(html) ? ["caption"] : []), ...${JSON.stringify([...seed.captions, ...PEOPLE.map((p) => p.name), ...tripWords])}.filter((words) => words && html.includes(words))] };
  })()`);
  check("a stranger with NO session gets the page", anon.status === 200, `HTTP ${anon.status}`);
  // The page is the board and a small wordmark: no call to action (src/share-page.js says why).
  check("…with a link preview image and the wordmark, and no call to action", anon.hasImg && anon.mark && !anon.cta,
    JSON.stringify({ image: anon.hasImg, mark: anon.mark, cta: anon.cta }));
  check("…and the picture itself loads for them too",
    anon.imgStatus === 200 && anon.imgBytes > 2000, `HTTP ${anon.imgStatus}, ${Math.round(anon.imgBytes/1024)} KB`);
  check("…and the page carries NOTHING about the trip but the picture and, as its title, the trip's name",
    anon.leaks.length === 0 && anon.named === 2 && anon.titled.every((t) => t === TRIP_NAME.replace(/&/g, "&amp;")),
    anon.leaks.length ? `found in the HTML: ${anon.leaks.join(" | ")}` : `the trip's name ${anon.named} times (the two titles); no caption, no person, no place`);
} catch (e) {
  console.log("\nHARNESS ERROR: " + (e && e.stack ? e.stack : e));
  results.push(false);
} finally {
  try {
    await evalIn(b.cdp, b.S, `(() => { try { localStorage.removeItem("wgp.collage.look"); } catch {} return 1; })()`);
  } catch { /* page gone */ }
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed${PLANT ? " (PLANTED: the Photo style group back)" : ""}`);
  if (shared) {
    const gone = await api(tripApi(`/collage/share/${shared}`), { method: "DELETE" }).catch((e) => ({ status: 0, text: String(e) }));
    console.log(`the shared board's link is stopped: HTTP ${gone.status}`);
    // A stopped board stays listed for its maker (so they see that it stopped, and why): a row
    // this run made. It is taken away by the id recorded when it was shared, and nothing else.
    if (/^[a-f0-9]{32}$/.test(shared)) {
      try { d1(`DELETE FROM collage_share_items WHERE share_id = '${shared}'; DELETE FROM collage_shares WHERE id = '${shared}'`); }
      catch (e) { console.log(`LEFT BEHIND  the stopped board's row ${shared} could not be removed: ${String(e.message).slice(0, 200)}`); }
    }
  }
  await seed.cleanup().catch(() => {});
  await b.done();
  process.exit(results.every(Boolean) ? 0 : 1);
}
