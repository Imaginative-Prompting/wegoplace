#!/usr/bin/env node
/* Flow 5 (Photos: Feed, Board chrome, Viewer, the Add photos sheet) on the design system
 * (public/css/memories.css, public/css/collage.css lines 222+, public/js/memories.js; the List view
 * went on 25 Nov), checked statically and in real Chrome across
 * 390, 768, 1440 in dark (Void) and light (Paper). Corkboard core (collage.css 1..221 and
 * collage*.js) stays untouched.
 *
 *   node scripts/photos_ds_check.mjs --static
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> \
 *     --label "wegoplace photos_ds_check.mjs" -- node scripts/photos_ds_check.mjs
 *
 * PLANTS (PHOTOS_PLANT=<name>):
 *   rawcolor    injects a raw hex color into memories.css (static fails)
 *   offscale    injects an off-scale font-size into memories.css (static fails)
 *   overlay     puts .me-over back into memories.js feed cards (static & browser fail)
 *   corktokens  replaces corkboard color token in collage.css lines 1..221 (static fails)
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const STATIC_ONLY = process.argv.includes("--static");
const PLANT = process.env.PHOTOS_PLANT || "";
const PLANTS = new Set(["rawcolor", "offscale", "overlay", "corktokens"]);
if (PLANT && !PLANTS.has(PLANT)) throw new Error(`no such PHOTOS_PLANT: ${PLANT}`);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 260) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// ── 0. Static Design System Audit ───────────────────────────────────────────────────────────
section("0. Flow 5 design system token, contrast, scale, and corkboard-preserve audit");
let memCss = read("public/css/memories.css");
let collageCss = read("public/css/collage.css");
let memJs = read("public/js/memories.js");
const stSrc = read("public/styles.css");

if (PLANT === "rawcolor") memCss += "\n.me-plant-raw { color: #ff00ff; }\n";
if (PLANT === "offscale") memCss += "\n.me-plant-px { font-size: 13px; }\n";
if (PLANT === "overlay") memJs = memJs.replace('<div class="me-by">', '<div class="me-over">');
if (PLANT === "corktokens") collageCss = collageCss.replace("--cg-paper: #fdfaf3;", "--cg-paper: var(--fill);");

const collageLines = collageCss.split("\n");
const corkCss = collageLines.slice(0, 221).join("\n");
const boardChromeCss = collageLines.slice(221).join("\n");

check("corkboard CSS (collage.css lines 1..221) preserved without DS tokens",
  corkCss.includes("--cg-paper: #fdfaf3;")
  && corkCss.includes("--cg-paper-ink: #4b4332;")
  && corkCss.includes("background: var(--ground);")
  && !/var\(--(?:fill|ink-1|radius-|size-)/.test(corkCss),
  "corkboard lines 1..221 intact");

// Legacy token regex aligned with tokens.css vs styles.css (allowlisted exceptions checked below).
const LEGACY_RE = /var\(--(?:accent|accent-ink|accent-soft|surface|surface-2|ground|ink|line|line-strong|warn|warn-soft|ok|ok-soft|shadow|press|tap|font-display|tint|nc|r-(?:sm|md|lg)|sp-[0-9]+|kind-[a-z-]+|cat-[a-z-]+)(?![-\w])/g;

// Strip documented viewer backdrop/scrim/framing-grid rules and --me-scape compat vars before scanning for raw colors.
function stripAllowedMemoriesColors(css) {
  return css
    .replace(/:root(?:\[data-lum="dark"\])?\s*\{\s*--me-scape:\s*#[0-9a-fA-F]{6};\s*\}/g, "")
    .replace(/\.me-vscrim\s*\{[^}]*\}/g, "")
    .replace(/\.me-vvideo\s*\{[^}]*\}/g, "")
    .replace(/\.me-vtop\s*\{[^}]*\}/g, "")
    .replace(/\.me-vbottom\s*\{[^}]*\}/g, "")
    .replace(/\.me-frgrid\s*\{[^}]*\}/g, "");
}

for (const [label, rawCss, isMemoriesCss] of [
  ["public/css/memories.css", memCss, true],
  ["public/css/collage.css (lines 222+ chrome)", boardChromeCss, false],
]) {
  const clean = stripComments(rawCss);
  check(`${label} CSS present`, clean.length > 200);

  const colorScanTarget = (isMemoriesCss ? stripAllowedMemoriesColors(clean) : clean)
    .replace(/-webkit-mask-image\s*:[^;}{]+;/g, "")
    .replace(/mask-image\s*:[^;}{]+;/g, "");
  const rawHex = colorScanTarget.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const rawFn = colorScanTarget.match(/\b(?:rgba?|hsla?)\(/g) || [];
  check(`${label}: zero stray raw hex/rgb/hsl colors`, rawHex.length === 0 && rawFn.length === 0, [...rawHex, ...rawFn].join(", "));

  // board_memory_check.mjs explicitly asserts Delete color === getComputedStyle(var(--warn)) inside .me-delsheet .me-dokill.
  const legacyTarget = isMemoriesCss
    ? clean.replace(/\.me-delsheet\s+\.me-dokill\s*\{[^}]*\}/g, "")
    : clean;
  const legacy = legacyTarget.match(LEGACY_RE) || [];
  check(`${label}: zero legacy or undefined tokens`, legacy.length === 0, legacy.join(", "));

  const badSizes = [...clean.matchAll(/font-size\s*:\s*([^;}{]+)/g)]
    .map((m) => m[1].trim())
    .filter((v) => !/^var\(--size-(?:12|14|16|20|28|number)\)$/.test(v));
  check(`${label}: every font-size uses strict --size-* tokens`, badSizes.length === 0, badSizes.join(", "));

  const faintHits = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    const body = m[2];
    if (/::placeholder|:disabled|\[disabled\]/.test(sel)) continue;
    const decls = body.replace(/text-decoration-color\s*:[^;]+;/g, "");
    if (/(?:^|[\s;])color\s*:\s*var\(--ink-[34]\b/.test(decls)) {
      faintHits.push(sel.replace(/\s+/g, " "));
    }
  }
  check(`${label}: zero --ink-3/--ink-4 on readable text`, faintHits.length === 0, faintHits.join(" | "));
}

// The 52 px of room for a fixed picture went with the last screen that had it (Split, 27 Nov: its head holds the picture
// now); while any screen keeps the rule, it keeps its :not(…).
check("styles.css removes .me-top offset & 52px room entry, the room rule (while any screen has it) keeping :not(:has(.head-more[data-away]))",
  !/body:has\(#view \.me-top\)/.test(stSrc)
  && !/:is\([^)]*\.me-top/.test(stSrc)
  && (!/#view :is\([^)]*\) \{ padding-right: 52px; \}/.test(stSrc) || /body:not\(\[data-back="1"\]\):not\(:has\(\.head-more\[data-away\]\)\)/.test(stSrc)));

const sheetCount = (memJs.match(/openSheet\(\{/g) || []).length;
check("memories.js moves Feed to DS root, .ds-head/.ds-head-end, byline under photos (no .me-over), and Board chrome",
  /el\.classList\.add\("ds",\s*"me-root"\)/.test(memJs)
  && /el\.classList\.remove\("ds",\s*"me-root",\s*"me-scape"\)/.test(memJs)
  && /el\.querySelector\("\[data-head-more\]"\)/.test(memJs)
  && /me-top ds-head/.test(memJs)
  && /ds-head-end/.test(memJs)
  && /label:\s*"Board"/.test(memJs)
  && /me-views-hl/.test(memJs)
  && /me-by/.test(memJs)
  && !/me-over|me-byline/.test(memJs)
  && /me-day ds-day/.test(memJs)
  && /(?:pictureHolder|faceHtml)\(/.test(memJs)
  && /faceMarkup\(/.test(memJs)
  && /originEl/.test(memJs)
  && /fab\.setAttribute\("data-aside"/.test(memJs)
  && sheetCount === 5,
  `openSheet count=${sheetCount}`);

check("memories.css resets composer field labels to sentence case and memories.js refits Board on resize",
  /\.me-comp \.field\s*>\s*label[\s\S]*?text-transform:\s*none;\s*letter-spacing:\s*0;/.test(memCss)
  && /host\.hidden\s*\|\|\s*getComputedStyle\(host\)\.display\s*===\s*"none"/.test(memJs)
  && /board\.fit\(false\)/.test(memJs));

if (STATIC_ONLY) {
  console.log(`\n${pass} passed, ${fail} failed (static only)`);
  if (fail) console.log(`failed:\n  ${failures.join("\n  ")}`);
  process.exit(fail ? 1 : 0);
}

// ── 1. Browser checks (Void & Paper at 390, 768, 1440) ──────────────────────────────────────
const { startServer } = await import("../checks/lib/server.mjs");
const { Person } = await import("../checks/lib/person.mjs");
const { openChrome } = await import("../checks/lib/chrome.mjs");
const { JPEG } = await import("../checks/lib/images.mjs");
const { freeLoopbackPort, ownServer } = await import("./lib/browser.mjs");

const server = await startServer({ name: "photos-ds", port: await freeLoopbackPort() });
ownServer(server.origin);
let chrome = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadPhotoMemory(origin, person, tripId, { caption, tags }) {
  const cookie = `wgp_session=${person.jar.cookies.get("wgp_session")}`;
  const beg = await person.post(`/api/trips/${tripId}/media/begin`, {
    name: "scene.jpg", mime: "image/jpeg", bytes: JPEG.length, kind: "photo",
  });
  const { key, uploadId } = beg.json;
  const partRes = await fetch(
    `${origin}/api/trips/${tripId}/media/part?key=${encodeURIComponent(key)}&id=${encodeURIComponent(uploadId)}&n=1`,
    { method: "POST", headers: { cookie, "content-type": "application/octet-stream" }, body: JPEG },
  );
  const partJson = await partRes.json();
  await person.post(`/api/trips/${tripId}/media/finish`, {
    key, id: uploadId, parts: [{ n: 1, etag: partJson.etag }],
  });
  const thumbRes = await fetch(
    `${origin}/api/trips/${tripId}/media/thumb?for=${encodeURIComponent(key)}&mime=image/jpeg`,
    { method: "POST", headers: { cookie, "content-type": "image/jpeg" }, body: JPEG },
  );
  const thumbJson = await thumbRes.json();
  await person.post(`/api/trips/${tripId}/memories`, {
    caption, tags, media: [{ key, thumb_key: thumbJson.key, kind: "photo", w: 40, h: 30 }],
  });
}

try {
  await server.start();
  const { origin } = server;
  const ada = new Person(origin, "Ada Reyes");
  const ben = new Person(origin, "Ben Okafor");
  await ada.signUp();
  await ben.signUp();

  const trip = (await ada.post("/api/trips", {
    name: "Alps week", default_tz: "UTC", starts_on: "2027-06-01", ends_on: "2027-06-05",
  })).json.trip.id;
  const link = (await ada.post(`/api/trips/${trip}/links`, { uses: 1 })).json.link.code;
  await ben.post(`/api/join/${link}`);

  await uploadPhotoMemory(origin, ada, trip, { caption: "Morning ridge pass", tags: ["alps", "hike"] });
  await uploadPhotoMemory(origin, ben, trip, { caption: "", tags: ["valley"] });

  chrome = await openChrome();
  const page = await chrome.page({ width: 390, height: 844, mobile: true });
  await page.setCookie(origin, "wgp_session", ada.jar.cookies.get("wgp_session"));
  await page.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(ada.user.id), sameSite: "Lax" });

  for (const theme of ["dark", "light"]) {
    section(`1. Flow 5 browser audit (${theme})`);
    await page.scheme(theme);
    for (const [label, size] of [
      ["390", { width: 390, height: 844, mobile: true }],
      ["768", { width: 768, height: 1024, mobile: false }],
      ["1440", { width: 1440, height: 900, mobile: false }],
    ]) {
      await page.size(size);
      await page.open(`${origin}/t/${trip}/#/memories`);
      await page.until("document.querySelectorAll('#view .me-card').length >= 2", "feed rendered", 20000);
      await sleep(300);

      // Ensure Feed is selected first across persisted sizes.
      await page.eval(`(() => { const b = document.querySelector('.me-viewbtn[data-view="feed"]'); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); })()`);
      await sleep(250);

      const feed = JSON.parse(await page.eval(`JSON.stringify((() => {
        const view = document.getElementById('view');
        const card = view.querySelector('.me-card');
        const shot = card.querySelector('.me-shot').getBoundingClientRect();
        const by = card.querySelector('.me-by').getBoundingClientRect();
        const ava = card.querySelector('.me-ava');
        const avaCs = getComputedStyle(ava);
        const day = view.querySelector('.me-day');
        const segs = [...view.querySelectorAll('.me-viewbtn span')].map((s) => s.textContent.trim());
        return {
          rootDs: view.classList.contains('ds') && view.classList.contains('me-root'),
          hasScape: view.classList.contains('me-scape'),
          dsHead: !!view.querySelector('.me-top.ds-head .ds-head-end'),
          segs,
          hasHl: !!view.querySelector('.me-views-hl'),
          overCount: view.querySelectorAll('.me-over').length,
          byBelowShot: by.top >= shot.bottom - 1,
          avaCircle: ava.classList.contains('ds-face') && parseFloat(avaCs.borderRadius) >= 16,
          avaStyle: ava.getAttribute('style') || '',
          dayTransform: getComputedStyle(day).textTransform,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      })())`));
      check(`${theme} ${label} feed: DS shell, sliding 2-way control ("Feed/Board"), no .me-over`,
        feed.rootDs && !feed.hasScape && feed.dsHead && JSON.stringify(feed.segs) === '["Feed","Board"]' && feed.hasHl && feed.overCount === 0,
        JSON.stringify(feed));
      check(`${theme} ${label} feed: byline under photo, filled person-token circle .ds-face (no --nc), sentence-case day`,
        feed.byBelowShot && feed.avaCircle && /--ds-person:var\(--person-/.test(feed.avaStyle) && !/--nc\b/.test(feed.avaStyle) && feed.dayTransform !== "uppercase" && !feed.overflow,
        JSON.stringify(feed));

      if (theme === "dark" && label === "390") {
        // Test grow-from-origin viewer open & close.
        await page.eval(`document.querySelector('#view .me-cell').click()`);
        await page.until("document.querySelector('.me-view.ds')", "viewer opened", 10000);
        await sleep(360);
        const vw = JSON.parse(await page.eval(`JSON.stringify((() => ({
          ds: document.querySelector('.me-view')?.classList.contains('ds'),
          whoCircle: !!document.querySelector('.me-vwho .ds-face'),
          imgCount: document.querySelectorAll('.me-vimg').length,
        }))())`));
        check(`${theme} ${label} viewer: DS chrome & zoom-from-origin opened cleanly`, vw.ds && vw.whoCircle && vw.imgCount >= 1, JSON.stringify(vw));
        await page.eval(`document.querySelector('.me-vclose').click()`);
        await page.until("!document.querySelector('.me-view')", "viewer closed", 10000);

        // Test Board view & corkboard preserved + DS Board drawer + fits above tabbar.
        await page.eval(`document.querySelector('.me-viewbtn[data-view="collage"]').click()`);
        await page.until("document.querySelector('#view .cg-look') && document.querySelector('#view .cg-board')", "board view opened", 10000);
        await sleep(300);
        const bv = JSON.parse(await page.eval(`JSON.stringify((() => {
          const view = document.getElementById('view');
          const st = document.querySelector('.me-stage[data-stage="collage"]').getBoundingClientRect();
          const bd = document.querySelector('#view .cg-board')?.getBoundingClientRect();
          const tab = document.querySelector('.tabbar')?.getBoundingClientRect();
          return {
            vi: document.querySelector('.me-views').style.getPropertyValue('--me-vi'),
            share: document.querySelector('.cg-look-share')?.textContent?.trim(),
            items: document.querySelectorAll('#view .cg-item').length,
            stageBottom: Math.round(st.bottom),
            boardBottom: bd ? Math.round(bd.bottom) : 0,
            tabTop: tab ? Math.round(tab.top) : 999,
            scrollOverflow: view.scrollHeight - view.clientHeight,
          };
        })())`));
        check(`${theme} ${label} board: hl moved (--me-vi=1), fits above tabbar, Save or share DS control, corkboard untouched`,
          bv.vi === "1" && bv.share === "Save or share" && bv.items >= 1
            && bv.stageBottom <= 845 && bv.boardBottom > 100 && bv.boardBottom <= bv.tabTop + 1 && bv.scrollOverflow <= 1,
          JSON.stringify(bv));

        await page.eval(`document.querySelector('.cg-look').click()`);
        await page.until("document.querySelector('.cg-looksheet.ds')", "board drawer opened", 10000);
        const heads = await page.eval(`JSON.stringify([...document.querySelectorAll('.cg-lookhead')].map((h) => h.textContent.trim()))`);
        check(`${theme} ${label} board sheet: DS drawer without Photo style`, !JSON.parse(heads).includes("Photo style"), heads);
        await page.eval(`document.querySelector('.sh-close, .sh-scrim')?.click()`);
        await page.until("!document.querySelector('.cg-looksheet')", "board drawer closed", 10000);

        // Back on the Feed, "Add photos": the phone's picker first (stood in: its click answers with one made-up photo,
        // or with a cancel), then the one sheet, only when something was chosen.
        await page.eval(`document.querySelector('.me-viewbtn[data-view="feed"]').click()`);
        await sleep(250);
        const PICKER = (answer) => `(async () => {
          const c = document.createElement("canvas"); c.width = c.height = 64; c.getContext("2d").fillRect(0, 0, 64, 64);
          const blob = await new Promise((r) => c.toBlob(r, "image/jpeg"));
          const file = new File([blob], "made-up.jpg", { type: "image/jpeg" });
          const real = HTMLInputElement.prototype.click;
          window.__picker = 0;
          HTMLInputElement.prototype.click = function () {
            if (this.type !== "file") return real.call(this);
            HTMLInputElement.prototype.click = real; window.__picker++;
            if (${JSON.stringify(answer)} === "cancel") { setTimeout(() => this.dispatchEvent(new Event("cancel")), 30); return; }
            const dt = new DataTransfer(); dt.items.add(file); this.files = dt.files;
            setTimeout(() => this.dispatchEvent(new Event("change", { bubbles: true })), 30);
          };
          return 1; })()`;
        await page.eval(PICKER("cancel"));
        await page.eval(`document.querySelector('.me-fab').click()`);
        await sleep(700);
        const cancelled = JSON.parse(await page.eval(`JSON.stringify({ picker: window.__picker, sheet: !!document.querySelector('.me-comp') })`));
        check(`${theme} ${label} Add photos: the phone's picker opens at once, and choosing nothing opens no sheet`, cancelled.picker === 1 && !cancelled.sheet, JSON.stringify(cancelled));
        await page.eval(PICKER("one"));
        await page.eval(`document.querySelector('.me-fab').click()`);
        await page.until("document.querySelector('.me-comp.ds')", "composer opened", 10000);
        await sleep(300);
        const compState = JSON.parse(await page.eval(`JSON.stringify({
          picker: window.__picker,
          title: (document.querySelector('.sh-root .sh-title, .sh-root h2') || {}).textContent || "",
          picked: document.querySelectorAll('.me-comp .me-pickrow').length,
          pickButton: !!document.querySelector('.me-comp .me-pick:not([hidden])'),
          go: (document.querySelector('.me-go') || {}).textContent || "",
          moreClosed: !!document.querySelector('.me-comp details.me-more:not([open]) .me-tagin'),
          fabAside: !!document.querySelector('.me-fab')?.hasAttribute('data-aside'),
          upper: [...document.querySelectorAll('.me-comp .field > label, .me-comp .me-comp-label')]
            .filter((n) => getComputedStyle(n).textTransform !== "none").map((n) => n.textContent.trim()),
        })`));
        check(`${theme} ${label} Add photos: one sheet titled Add photos, holding what was chosen ("Upload 1 photo"), tags folded under More`,
          compState.picker === 1 && compState.title.trim() === "Add photos" && compState.picked === 1 && !compState.pickButton && /^Upload 1 photo$/.test(compState.go.trim()) && compState.moreClosed,
          JSON.stringify(compState));
        check(`${theme} ${label} composer: DS sheet, sentence-case labels, FAB steps aside`,
          compState.fabAside && compState.upper.length === 0, JSON.stringify(compState));
        await page.eval(`document.querySelector('.sh-close, .sh-scrim')?.click()`);
        await page.until("!document.querySelector('.me-comp')", "composer closed", 10000);
      }
    }
  }

  // Board resize (1440 -> 390) + fresh light 390 Board fit above tabbar
  await page.eval(`document.querySelector('.me-viewbtn[data-view="collage"]').click()`);
  await page.until("document.querySelector('#view .cg-board')", "desktop board opened for resize", 10000);
  await sleep(300);
  await page.size({ width: 390, height: 844, mobile: true });
  await sleep(400);
  const resz = JSON.parse(await page.eval(`JSON.stringify((() => {
    const view = document.getElementById('view');
    const st = document.querySelector('.me-stage[data-stage="collage"]').getBoundingClientRect();
    const bd = document.querySelector('#view .cg-board')?.getBoundingClientRect();
    const tab = document.querySelector('.tabbar')?.getBoundingClientRect();
    return {
      stageW: Math.round(st.width),
      stageBottom: Math.round(st.bottom),
      boardBottom: bd ? Math.round(bd.bottom) : 0,
      tabTop: tab ? Math.round(tab.top) : 999,
      scrollOverflow: view.scrollHeight - view.clientHeight,
    };
  })())`));
  check("light Board resized 1440 -> 390 re-fits cleanly inside 390px and above .tabbar",
    resz.stageW <= 390 && resz.stageBottom <= 845 && resz.boardBottom > 100 && resz.boardBottom <= resz.tabTop + 1 && resz.scrollOverflow <= 1,
    JSON.stringify(resz));

  const fresh = await chrome.page({ width: 390, height: 844, mobile: true });
  await fresh.setCookie(origin, "wgp_session", ada.jar.cookies.get("wgp_session"));
  await fresh.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(ada.user.id), sameSite: "Lax" });
  await fresh.scheme("light");
  await fresh.open(`${origin}/t/${trip}/#/memories`);
  await fresh.until("document.querySelector('.me-viewbtn[data-view=\"collage\"]')", "fresh 390 light Photos", 20000);
  await fresh.eval(`document.querySelector('.me-viewbtn[data-view="collage"]').click()`);
  await fresh.until("document.querySelector('#view .cg-board')", "fresh 390 light Board", 15000);
  await sleep(350);
  const f390 = JSON.parse(await fresh.eval(`JSON.stringify((() => {
    const view = document.getElementById('view');
    const st = document.querySelector('.me-stage[data-stage="collage"]').getBoundingClientRect();
    const bd = document.querySelector('#view .cg-board')?.getBoundingClientRect();
    const tab = document.querySelector('.tabbar')?.getBoundingClientRect();
    return {
      stageBottom: Math.round(st.bottom),
      boardBottom: bd ? Math.round(bd.bottom) : 0,
      tabTop: tab ? Math.round(tab.top) : 999,
      scrollOverflow: view.scrollHeight - view.clientHeight,
    };
  })())`));
  check("fresh light 390 page Board fits above .tabbar with zero scroll overflow",
    f390.stageBottom <= 845 && f390.boardBottom > 100 && f390.boardBottom <= f390.tabTop + 1 && f390.scrollOverflow <= 1,
    JSON.stringify(f390));
  await fresh.close();

  check("zero page errors", page.errors.length === 0, JSON.stringify(page.errors.slice(0, 3)));
} finally {
  await chrome?.close();
  await server?.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);
