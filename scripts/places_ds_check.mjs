#!/usr/bin/env node
/* Flow 4 (Places, Map, Place page, Place editor, Spot picker) on the design system
 * (public/js/places.js, map.js, map-keep.js, place-editor.js, spot-picker.js), checked
 * statically and in real Chrome across 390, 768, 1440 in dark (Void) and light (Paper).
 *
 *   node scripts/places_ds_check.mjs --static
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> \
 *     --label "wegoplace places_ds_check.mjs" -- node scripts/places_ds_check.mjs
 *
 * PLANTS (PLACES_PLANT=<name>):
 *   rawcolor  injects a raw hex color into places.js CSS (static fails)
 *   offscale  injects a literal px font-size into map.js CSS (static fails)
 *   catback   restores a --cat reference into places.js (static fails)
 *   hideback    hides shell #backbtn on place pages from places.js CSS (browser detail check fails)
 *   catpin      puts a style="--cat" attribute back on pins in served map.js (browser map check fails)
 *   nonetclear  drops --dock-room from styles.css and .mp-body --foot-clear from map.js (browser offline check fails)
 *   scalehit    drops scaleBox collision and PIN_LABEL_PX bottom reserve in map.js (browser map scale check fails)
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// The Places rows in the list, not the leaving ones flip() keeps a moment as position:fixed ghosts (motion.js exit()).
const LISTED = `[...document.querySelectorAll("#view .pl-row")].filter((r) => getComputedStyle(r).position !== "fixed").length`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const STATIC_ONLY = process.argv.includes("--static");
const PLANT = process.env.PLACES_PLANT || "";
const PLANTS = new Set(["rawcolor", "offscale", "catback", "hideback", "catpin", "nonetclear", "scalehit"]);
if (PLANT && !PLANTS.has(PLANT)) throw new Error(`no such PLACES_PLANT: ${PLANT}`);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 260) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

function extractConst(src, name) {
  const m = new RegExp(`const ${name} = \`([\\s\\S]*?)\\n\`;`).exec(src);
  return m ? m[1] : "";
}

// ── Static Design System Audit ───────────────────────────────────────────────────────────────
section("0. Design system token, type-scale, and basemap audit");
let plSrc = read("public/js/places.js");
let mpSrc = read("public/js/map.js");
const pfSrc = read("public/js/place-editor.js");
const spSrc = read("public/js/spot-picker.js");
const stSrc = read("public/styles.css");

if (PLANT === "rawcolor") plSrc = plSrc.replace("const CSS = `\n", "const CSS = `\n.pl-plant-raw { color: #ff00ff; }\n");
if (PLANT === "offscale") mpSrc = mpSrc.replace("const CSS = `\n", "const CSS = `\n.mp-plant-px { font-size: 13px; }\n");
if (PLANT === "catback") plSrc = plSrc.replaceAll("--cat-", "--x-cat-");

const plCss = extractConst(plSrc, "CSS");
const mpCss = extractConst(mpSrc, "CSS");
const pfCss = extractConst(pfSrc, "PF_CSS");
const spCss = extractConst(spSrc, "SP_CSS");

for (const [label, css] of [
  ["places.js CSS", plCss],
  ["map.js CSS", mpCss],
  ["place-editor.js PF_CSS", pfCss],
  ["spot-picker.js SP_CSS", spCss],
]) {
  check(`${label} CSS present`, css.length > 100);
  const rawHex = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const rawFn = css.match(/\b(?:rgba?|hsla?)\(/g) || [];
  check(`${label}: zero raw hex/rgb/hsl colors`, rawHex.length === 0 && rawFn.length === 0, [...rawHex, ...rawFn].join(", "));
  const tints = css.match(/--tint\b/g) || [];
  check(`${label}: zero undefined --tint references`, tints.length === 0, tints.join(", "));
  const badSizes = [...css.matchAll(/font-size\s*:\s*([^;}{]+)/g)]
    .map((m) => m[1].trim())
    .filter((v) => !/^var\(--size-(?:12|14|16|20|28|number)\)$/.test(v));
  check(`${label}: every font-size uses strict --size-* tokens`, badSizes.length === 0, badSizes.join(", "));
}

check("places.js binds --ds-k from --cat-* category tokens", /catToneVars/.test(plSrc) && /--cat-/.test(plSrc) && /var\(--ds-k/.test(plCss));
check("map.js binds --ds-k from --cat-* category tokens", /catToneVars/.test(mpSrc) && /--cat-/.test(mpSrc) && /var\(--ds-k/.test(mpCss));
check("places.js uses .ds-head, .ds-head-end, and rescues .head-more in paintHead",
  /pl-top ds-head/.test(plSrc) && /ds-head-end/.test(plSrc) && /head\.querySelector\("\.head-more"\)/.test(plSrc));
check("styles.css removes .pl-top head-more offset and 52px room entry",
  !/body:has\(#view \.pl-top\)/.test(stSrc) && !/:is\([^)]*\.pl-top/.test(stSrc));
const { getIcon } = await import("../public/js/icons.js");
check("pharmacy glyph uses capsule pill (never + cross)", /data-icon="pill"/.test(getIcon("practical", "pharmacy")) && !/data-icon="cross"/.test(getIcon("practical", "pharmacy")));
check("place-editor.js wraps kind chips, collapses optional fields behind More details, and styles disabled Add without opacity",
  /pf-wrap pf-kinds/.test(pfSrc) && /data-act="toggle-more"/.test(pfSrc) && /:disabled\s*\{/.test(pfCss));
check("place-editor.js keeps labels sentence-case, focuses sheet (not Kind), always shows Put it on the map, and uses areaChipList",
  /\.pf\.ds \.field\s*>\s*label[\s\S]*?text-transform:\s*none;\s*letter-spacing:\s*0/.test(pfCss)
  && !/body\.querySelector\("\.pf-kind"\)\s*;\s*if\s*\(k\)\s*k\.focus/.test(pfSrc)
  && /data-pin-wait="1"[\s\S]*?Put it on the map[\s\S]*?This trip has no map yet\. Paste a map link or coordinates in Address or Link\. It shows in the list either way\./.test(pfSrc)
  && /\.pf\.ds \.pf-mapbtn:disabled\s*\{[^}]*opacity:\s*1/.test(pfCss)
  && /areaChipList\(store\.areas\(\)\)/.test(pfSrc));

// Verify map_fit_check and narrow_check plant anchor strings remain intact in map.js
const MAP_ANCHORS = [
  "@media (max-height: 500px){ .mp-btns{flex-direction:row} }",
  "@media (max-height: 420px) and (min-width: 480px){ .mp-sheet{height:calc(150px + var(--mp-dock))} }",
  "  .mp-root{--mp-card-h:207px}\n",
  "height:calc(var(--mp-card-h) + var(--mp-dock) + var(--mp-under, 0px))",
];
check("map.js preserves all map_fit_check & narrow_check plant anchor lines",
  MAP_ANCHORS.every((s) => mpSrc.includes(s)));

// Verify map-keep.js Void & Light basemap layers omit pois/shields and preserve all 4 font stacks
globalThis.location ??= { origin: "http://localhost" };
const keep = await import("../public/js/map-keep.js");
const basemaps = await import("../public/vendor/basemaps/basemaps.mjs");
const darkLayers = keep.styleLayers(basemaps, "dark");
const lightLayers = keep.styleLayers(basemaps, "light");
const bgOf = (layers, id) => (layers.find((l) => l.id === id) || {}).paint || {};
const fontsDark = keep.fontStacks(darkLayers);
const fontsLight = keep.fontStacks(lightLayers);
check("map-keep styleLayers dark (Void) uses #000000 background and #0d0d0c earth",
  bgOf(darkLayers, "background")["background-color"] === "#000000" && bgOf(darkLayers, "earth")["fill-color"] === "#0d0d0c");
check("map-keep styleLayers light (Paper) uses #fdfdfc background and #f2f1ed earth",
  bgOf(lightLayers, "background")["background-color"] === "#fdfdfc" && bgOf(lightLayers, "earth")["fill-color"] === "#f2f1ed");
check("styleLayers omits landcover, pois, address_label, roads_shields and preserves 4 font stacks",
  [darkLayers, lightLayers].every((ls) => ls.every((l) => !["pois", "landcover"].includes(l["source-layer"]) && !["address_label", "roads_shields"].includes(l.id)))
  && fontsLight.length === 4 && JSON.stringify(fontsDark) === JSON.stringify(fontsLight)
  && fontsLight.includes("Noto Sans Regular") && fontsLight.includes("Noto Sans Medium")
  && fontsLight.includes("Noto Sans Italic") && fontsLight.some((f) => /Devanagari/.test(f)),
  fontsLight.join(" | "));

if (STATIC_ONLY) {
  console.log(`\n${pass} passed, ${fail} failed (static only)`);
  if (fail) console.log(`failed:\n  ${failures.join("\n  ")}`);
  process.exit(fail ? 1 : 0);
}

// ── Browser checks ───────────────────────────────────────────────────────────────────────────
const { startServer } = await import("../checks/lib/server.mjs");
const { Person } = await import("../checks/lib/person.mjs");
const { openChrome } = await import("../checks/lib/chrome.mjs");
const { freeLoopbackPort, ownServer } = await import("./lib/browser.mjs");

const plantedPlaces = () => (PLANT === "hideback"
  ? plSrc.replace("const CSS = `\n", "const CSS = `\nbody:has(#view .pl-page) #backbtn { display: none; }\n")
  : plSrc);
const plantedMap = () => {
  if (PLANT === "catpin") return mpSrc.replace('<span class="mp-pin-body">', '<span class="mp-pin-body" style="--cat:#ff00ff">');
  if (PLANT === "nonetclear") {
    return mpSrc
      .replace(
        ".mp-root:not([data-mode=\"card\"]) .mp-body{\n  padding-bottom:max(var(--foot-clear, 0px), calc(var(--mp-dock) + var(--mp-under, 0px) + var(--sp-6)))}",
        ""
      )
      .replace(
        "bottom:max(var(--mp-chrome, 12px), var(--mp-scale-floor, 0px));",
        "bottom:var(--mp-chrome, 12px);"
      );
  }
  if (PLANT === "scalehit") {
    return mpSrc
      .replace("S.scaleBox = scale ? { x: scale.l - 4, y: scale.t - 4, w: scale.r - scale.l + 8, h: scale.b - scale.t + 8 } : null;", "S.scaleBox = null;");
  }
  return mpSrc;
};

const server = await startServer({ name: "places-ds", port: await freeLoopbackPort() });
ownServer(server.origin);
let chrome = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await server.start();
  const { origin } = server;
  const host = new Person(origin, "Ada Reyes");
  await host.signUp();

  const trip = (await host.post("/api/trips", {
    name: "Lisbon week", default_tz: "Europe/Lisbon", starts_on: "2027-05-01", ends_on: "2027-05-05",
  })).json.trip.id;
  const mustPut = async (p, body) => {
    const r = await host.call("PUT", p, body);
    if (r.status >= 300) throw new Error(`PUT ${p} failed ${r.status}: ${r.text.slice(0, 200)}`);
    return r;
  };
  await mustPut(`/api/trips/${trip}/areas`, {
    areas: [
      { id: "alfama", name: "Alfama", west: -9.135, south: 38.708, east: -9.123, north: 38.716, sort: 0 },
      { id: "chiado", name: "Chiado", west: -9.146, south: 38.708, east: -9.138, north: 38.714, sort: 1 },
      { id: "ca", name: "Costa Alta", sort: 2 },
      { id: "ca-centro", name: "Centro", parent: "ca", sort: 0 },
      { id: "ca-airport", name: "Airport", parent: "ca", sort: 1 },
      { id: "vs", name: "Valle Seco", sort: 3 },
      { id: "vs-centro", name: "Centro", parent: "vs", sort: 0 },
      { id: "vs-airport", name: "Airport", parent: "vs", sort: 1 },
    ],
  });
  await mustPut(`/api/trips/${trip}/places`, {
    places: [
      { id: "santa-clara", name: "Cafe Santa Clara", name_local: "Café de Santa Clara", kind: "food", subkind: "cafe", area: "alfama", why: "Morning espresso on the terrace.", address: "Campo de Santa Clara 12", lat: 38.715, lng: -9.125, rating: 4.8, rating_count: 140 },
      { id: "tile-museum", name: "Tile Museum", kind: "sight", subkind: "museum", area: "alfama", why: "Quiet cloister.", address: "Rua da Madre de Deus 4", lat: 38.712, lng: -9.129, rating: 4.7, rating_count: 820 },
      { id: "chiado-pharmacy", name: "Farmácia Barreto", kind: "practical", subkind: "pharmacy", area: "chiado", why: "Open late.", address: "Rua Garrett 73", lat: 38.711, lng: -9.141, rating: 4.6, rating_count: 420 },
    ],
  });

  chrome = await openChrome();
  const attachPlant = async (p) => {
    if (!["hideback", "catpin", "nonetclear", "scalehit"].includes(PLANT)) return;
    p.on((m) => {
      if (m.method !== "Fetch.requestPaused") return;
      const u = new URL(m.params.request.url);
      let body = null;
      let ct = "text/javascript; charset=utf-8";
      if (u.pathname === "/js/places.js") body = plantedPlaces();
      else if (u.pathname === "/js/map.js") body = plantedMap();
      else if (u.pathname === "/styles.css" && PLANT === "nonetclear") {
        ct = "text/css; charset=utf-8";
        body = stSrc
          .replace('body[data-back="1"], body[data-netpill="1"]', 'body[data-back="1"]')
          .replace('body[data-back="1"][data-netpill="1"]', 'body[data-back="1"][data-netpill="0"]');
      }
      if (body === null) { p.send("Fetch.continueRequest", { requestId: m.params.requestId }).catch(() => {}); return; }
      p.send("Fetch.fulfillRequest", {
        requestId: m.params.requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: ct }, { name: "Cache-Control", value: "no-store" }],
        body: Buffer.from(body).toString("base64"),
      }).catch(() => {});
    });
    const patterns = [{ urlPattern: "*/js/places.js*" }, { urlPattern: "*/js/map.js*" }];
    if (PLANT === "nonetclear") patterns.push({ urlPattern: "*/styles.css*" });
    await p.send("Fetch.enable", { patterns });
  };

  // 1. Phone (390) Void: Places list grouped by area, monochrome icons, chip toggle, embedded map, place detail
  section("1. Phone (390) Void: list, filter, map, card, detail, editor");
  const p = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
  await attachPlant(p);
  await p.setCookie(origin, "wgp_session", host.jar.cookies.get("wgp_session"));
  await p.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(host.user.id), sameSite: "Lax" });
  await p.scheme("dark");
  await p.goto(`${origin}/t/${trip}/#/places`);
  await p.until(`document.querySelectorAll("#view .pl-row").length === 3`, "Places list", 20000);
  await sleep(400);

  const listState = JSON.parse(await p.eval(`JSON.stringify((() => {
    const h = document.querySelector("#view .pl-top.ds-head");
    const more = !!document.querySelector("#view .ds-head-end .head-more");
    const areas = [...document.querySelectorAll("#view .pl-area")].map((n) => n.innerText.replace(/\\s+/g, " ").trim());
    const ico = document.querySelector("#view .pl-ico");
    const ir = ico ? ico.getBoundingClientRect() : null;
    const hasCat = !![...document.querySelectorAll("#view [style]")].find((n) => /--cat/.test(n.getAttribute("style") || ""));
    return {
      hasDsHead: !!h,
      more,
      areas,
      icoW: ir ? Math.round(ir.width) : 0,
      hasCat,
      canvas: getComputedStyle(document.body).backgroundColor,
    };
  })())`));
  check("Places list uses .ds-head + .head-more, area groups with counts, 32px category-tinted badges, --cat tokens, Void canvas",
    listState.hasDsHead && listState.more && listState.areas.join("|") === "Alfama 2|Chiado 1"
      && listState.icoW === 32 && listState.hasCat && listState.canvas === "rgb(0, 0, 0)",
    JSON.stringify(listState));

  await p.click('.pl-head .chip[data-kind="food"]');
  // The list repaints a moment after the tap, and the rows that leave stay a moment more as position:fixed ghosts fading
  // out (motion.js flip's exit). So: wait, bounded, for the one Food row among the rows in the list's flow, never a fixed
  // sleep; a red names every row it saw, ghosts marked.
  await p.until(`${LISTED} === 1 ? 1 : 0`, "the list filtered to Food", 5000).catch(() => {});
  const chipState = JSON.parse(await p.eval(`JSON.stringify((() => {
    const on = document.querySelector('.pl-head .chip[data-kind="food"][aria-pressed="true"]');
    const rows = ${LISTED};
    const seen = [...document.querySelectorAll("#view .pl-row")].map((r) => (r.querySelector(".pl-name, .pl-title") || r).textContent.trim().slice(0, 24) + (getComputedStyle(r).position === "fixed" ? " (leaving)" : ""));
    return { pressed: !!on, hasCheck: !!on?.querySelector(".pl-check"), rows, fillBg: on ? getComputedStyle(on.querySelector(".pl-fill")).backgroundColor : "", seen };
  })())`));
  check("Tapping Food chip selects category-coloured pill with check mark and filters to 1 row",
    chipState.pressed && chipState.hasCheck && chipState.rows === 1 && chipState.fillBg !== "" && chipState.fillBg !== "rgb(247, 246, 242)",
    JSON.stringify(chipState));
  await p.click('.pl-head .chip[data-kind="food"]');
  await sleep(300);

  await p.click(".pl-viewbtn");
  await p.until(`document.querySelector("#view .mp-root .mp-pin") ? 1 : 0`, "embedded map", 20000);
  await sleep(500);
  const mapState = JSON.parse(await p.eval(`JSON.stringify((() => {
    const pin = document.querySelector("#view .mp-pin");
    const body = pin?.querySelector(".mp-pin-body");
    const pr = body?.getBoundingClientRect();
    const catPin = !![...document.querySelectorAll("#view .mp-pin, #view .mp-cluster, #view [style]")].find((n) => /--cat/.test(n.getAttribute("style") || ""));
    return {
      pins: document.querySelectorAll("#view .mp-pin").length,
      clusters: document.querySelectorAll("#view .mp-cluster").length,
      pinW: pr ? Math.round(pr.width) : 0,
      pinBg: body ? getComputedStyle(body).backgroundColor : "",
      catPin,
    };
  })())`));
  check("Embedded map draws 32px category-coloured circular pins with --cat-* tokens",
    mapState.pins + mapState.clusters >= 1 && (mapState.pins === 0 || (mapState.pinW === 32 && mapState.pinBg !== "" && mapState.pinBg !== "rgb(247, 246, 242)")) && mapState.catPin,
    JSON.stringify(mapState));

  await p.click('.mp-body .pl-row[data-pick="santa-clara"]');
  await p.until(`document.querySelector('#view .mp-card') ? 1 : 0`, "map place card", 10000);
  await sleep(350);
  const cardState = JSON.parse(await p.eval(`JSON.stringify((() => {
    const maps = document.querySelector('#view .mp-acts [data-act="gmaps"]');
    const det = document.querySelector('#view .mp-acts [data-act="details"]');
    return {
      maps: maps?.textContent.trim(),
      mapsBg: maps ? getComputedStyle(maps).backgroundColor : "",
      det: det?.textContent.trim(),
    };
  })())`));
  check('Map card shows white "Open in Maps" and gray "Place page"',
    cardState.maps === "Open in Maps" && cardState.mapsBg === "rgb(247, 246, 242)" && cardState.det === "Place page",
    JSON.stringify(cardState));

  await p.click('#view .mp-acts [data-act="details"]');
  await p.until(`document.querySelector("#view .pl-page") ? 1 : 0`, "place detail page", 15000);
  await sleep(400);
  const detState = JSON.parse(await p.eval(`JSON.stringify((() => {
    const back = document.getElementById("backbtn");
    const br = back?.getBoundingClientRect();
    const maps = document.querySelector("#view .pl-maps-btn");
    return {
      backOk: !!back && getComputedStyle(back).display !== "none" && !back.hidden && !!br && br.width >= 44 && br.height >= 44,
      noTopBack: !document.querySelector("#view [data-place-back]"),
      mapsBg: maps ? getComputedStyle(maps).backgroundColor : "",
      addrLabel: (document.querySelector("#view .pl-addr .eyebrow") || {}).textContent?.trim(),
      local: (document.querySelector("#view .pl-local") || {}).textContent?.trim(),
    };
  })())`));
  check('Place page keeps shell 44px #backbtn, white "Open in Maps", "Address, to show a driver", local name',
    detState.backOk && detState.noTopBack && detState.mapsBg === "rgb(247, 246, 242)"
      && detState.addrLabel === "Address, to show a driver" && detState.local === "Café de Santa Clara",
    JSON.stringify(detState));

  await p.click('#view [data-act="change"]');
  await p.until(`document.querySelector(".sh-root[data-open='1'] .pf.ds") ? 1 : 0`, "place editor", 10000);
  await sleep(350);
  const edState = JSON.parse(await p.eval(`JSON.stringify((() => {
    const save = document.querySelector('.pf-foot.ds [data-act="save"]');
    const rem = document.querySelector('#pf-remove [data-act="remove"]');
    const title = document.querySelector(".sh-root[data-open='1'] .sh-title");
    const tr = title?.getBoundingClientRect();
    const sr = save?.getBoundingClientRect();
    return {
      saveBg: save ? getComputedStyle(save).backgroundColor : "",
      destroys: !!rem?.hasAttribute("data-destroys"),
      titleText: title?.textContent?.trim() || "",
      titleW: tr ? Math.round(tr.width) : 0,
      titleRight: tr ? Math.round(tr.right) : 999,
      saveLeft: sr ? Math.round(sr.left) : 0,
      saveRight: sr ? Math.round(sr.right) : 999,
    };
  })())`));
  check("Place editor uses .pf.ds, white save button, and data-destroys on Remove",
    edState.saveBg === "rgb(247, 246, 242)" && edState.destroys, JSON.stringify(edState));
  check("Place editor keeps title visible and compact Save/Add pill clear inside 390px .sh-head",
    edState.titleText === "Change place" && edState.titleW >= 60 && edState.saveRight <= 390 && edState.titleRight <= edState.saveLeft + 1,
    JSON.stringify(edState));
  await p.eval(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
  await p.until(`!document.querySelector(".sh-root[data-open='1']")`, "change sheet closed", 10000);
  await p.goto(`${origin}/t/${trip}/#/places?view=list`);
  await p.until(`document.querySelector('.pl-head[data-view="list"]') && document.querySelectorAll("#view .pl-row").length >= 3`, "Places list for add check", 15000);
  await sleep(300);
  await p.click("#rt-fixed .fab");
  await p.until(`document.querySelector(".sh-root[data-open='1'][data-entered='1'] .pf.ds")`, "Add a place sheet", 10000);
  await sleep(250);
  const addInit = JSON.parse(await p.eval(`JSON.stringify((() => {
    const root = document.querySelector(".sh-root[data-open='1']");
    const save = root.querySelector('.pf-foot.ds [data-act="save"]');
    const kinds = root.querySelector(".pf-kinds");
    const moreBtn = root.querySelector('[data-act="toggle-more"]');
    const more = root.querySelector("#pf-more");
    const pin = root.querySelector(".pf-pin");
    const pinLine = root.querySelector("#pf-pinline");
    const mapBtn = root.querySelector("#pf-pinbox .pf-mapbtn");
    const uppercaseLabels = [...root.querySelectorAll(".pf.ds .field > label, .pf.ds .pe-label")]
      .filter((n) => getComputedStyle(n).textTransform !== "none")
      .map((n) => n.textContent.trim());
    return {
      tall: root.dataset.tall === "1",
      saveDisabled: !!save?.disabled,
      saveOpacity: save ? getComputedStyle(save).opacity : "",
      saveTitle: save?.getAttribute("title") || "",
      kindFocused: !!document.activeElement?.closest?.(".pf-kind"),
      ringOnChip: !!root.querySelector(".pf-kind:focus-visible"),
      kindsWrap: kinds ? getComputedStyle(kinds).flexWrap : "",
      kindsCut: kinds ? kinds.scrollWidth > kinds.clientWidth + 1 : true,
      moreExpanded: moreBtn?.getAttribute("aria-expanded") || "",
      moreHidden: !!more?.hidden,
      pinBorderW: pin ? getComputedStyle(pin).borderTopWidth : "",
      pinText: pinLine?.textContent?.trim() || "",
      mapBtnText: mapBtn?.textContent?.trim() || "",
      mapBtnDisabled: !!mapBtn?.disabled,
      mapBtnOpacity: mapBtn ? getComputedStyle(mapBtn).opacity : "",
      uppercaseLabels,
    };
  })())`));
  check("Add a place opens compact (not tall) with sentence-case labels, no ring on Kind, collapsed More details, Put it on the map action, and disabled recolored Add",
    !addInit.tall && addInit.saveDisabled && addInit.saveOpacity === "1" && !!addInit.saveTitle
      && !addInit.kindFocused && !addInit.ringOnChip
      && addInit.uppercaseLabels.length === 0
      && addInit.kindsWrap === "wrap" && !addInit.kindsCut
      && addInit.moreExpanded === "false" && addInit.moreHidden
      && addInit.pinBorderW === "0px" && addInit.mapBtnText === "Put it on the map"
      && addInit.mapBtnDisabled && addInit.mapBtnOpacity === "1"
      && addInit.pinText === "This trip has no map yet. Paste a map link or coordinates in Address or Link. It shows in the list either way.",
    JSON.stringify(addInit));
  await p.click('.pf [data-act="toggle-more"]');
  await p.eval(`(() => { const i = document.querySelector("#pf-name"); i.value = "Harbor Bakery"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  const addAfter = JSON.parse(await p.eval(`JSON.stringify({
    moreExpanded: document.querySelector('.pf [data-act="toggle-more"]')?.getAttribute("aria-expanded") || "",
    moreHidden: !!document.querySelector("#pf-more")?.hidden,
    saveDisabled: !!document.querySelector('.pf-foot.ds [data-act="save"]')?.disabled,
    areas: [...document.querySelectorAll(".pf-area")].map((b) => b.textContent.trim()),
  })`));
  check("Toggling More details reveals optional fields, duplicate area chips add parent names, and typing Name enables Add",
    addAfter.moreExpanded === "true" && !addAfter.moreHidden && !addAfter.saveDisabled
      && addAfter.areas.includes("Centro, Costa Alta") && addAfter.areas.includes("Centro, Valle Seco")
      && addAfter.areas.includes("Airport, Costa Alta") && addAfter.areas.includes("Airport, Valle Seco")
      && addAfter.areas.includes("Alfama"),
    JSON.stringify(addAfter));
  await p.close();

  // 2. Wide (1440) Paper: two-pane with "+ Add a place" white and detail "Open in Maps" gray
  section("2. Desktop (1440) Paper: two-pane head button and gray Open in Maps");
  const pw = await chrome.page({ width: 1440, height: 900, mobile: false, passkeys: false });
  await attachPlant(pw);
  await pw.setCookie(origin, "wgp_session", host.jar.cookies.get("wgp_session"));
  await pw.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(host.user.id), sameSite: "Lax" });
  await pw.scheme("light");
  await pw.goto(`${origin}/t/${trip}/#/p/santa-clara`);
  await pw.until(`document.querySelector("#view[data-two='1'] .rt-pane-b .pl-page") ? 1 : 0`, "two-pane place", 20000);
  await sleep(400);
  const wideState = JSON.parse(await pw.eval(`JSON.stringify((() => {
    const head = document.querySelector("#view .pl-head");
    const add = document.querySelector("#view .pl-headadd");
    const maps = document.querySelector("#view .pl-maps-btn");
    return {
      headBg: head ? getComputedStyle(head).backgroundColor : "",
      addBg: add ? getComputedStyle(add).backgroundColor : "",
      mapsBg: maps ? getComputedStyle(maps).backgroundColor : "",
    };
  })())`));
  check('1440 Paper two-pane: Paper --canvas head, "+ Add a place" is solid (--solid #141412) and "Open in Maps" is gray',
    wideState.headBg === "rgb(253, 253, 252)" && wideState.addBg === "rgb(20, 20, 18)" && wideState.mapsBg !== "rgb(20, 20, 18)",
    JSON.stringify(wideState));

  // 3. Offline look checks: Places list & map sheet clear Offline pill, map labels stay clear of .mp-scale
  section("3. Offline look checks: list & map sheet clearance and scale-bar label avoidance");
  const longWhy = Array.from({ length: 16 }, (_, i) =>
    `Terrace note ${i + 1}: shade from the fig tree, corner table near the steps, and cash-only espresso counter before nine.`
  ).join("\n\n");
  const longTrip = (await host.post("/api/trips", {
    name: "Netherlands Offline Walk", default_tz: "Europe/Amsterdam", starts_on: "2027-06-01", ends_on: "2027-06-06",
  })).json.trip.id;
  await mustPut(`/api/trips/${longTrip}/areas`, {
    areas: [
      { id: "centrum", name: "Centrum", west: 4.86, south: 52.345, east: 4.92, north: 52.385, sort: 0 },
      { id: "zuid", name: "Museumkwartier", west: 4.86, south: 52.345, east: 4.91, north: 52.365, sort: 1 },
    ],
  });
  const longPlaces = [
    { id: "centraal", name: "Amsterdam Centraal", kind: "transit", subkind: "train_station", area: "centrum", why: "Main station.", address: "Stationsplein", lat: 52.3791, lng: 4.9003 },
    { id: "rijks", name: "Rijksmuseum", kind: "sight", subkind: "museum", area: "zuid", why: "Dutch masters.", address: "Museumstraat 1", lat: 52.3600, lng: 4.8852 },
    { id: "vondel", name: "Vondelpark", kind: "sight", subkind: "park", area: "zuid", why: "Wide lawns and morning paths.", notes: longWhy, address: "Vondelpark 1", lat: 52.3520, lng: 4.8650 },
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `stop-${i + 1}`,
      name: `Canal Corner ${i + 1}`,
      kind: i % 2 ? "food" : "sight",
      subkind: i % 2 ? "cafe" : "viewpoint",
      area: i < 4 ? "centrum" : "zuid",
      why: `Stop ${i + 1} along the route.`,
      address: `Gracht ${10 + i}`,
      lat: 52.348 + (i % 4) * 0.004,
      lng: 4.872 + (i % 3) * 0.009,
    })),
  ];
  await mustPut(`/api/trips/${longTrip}/places`, { places: longPlaces });

  const po = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
  await attachPlant(po);
  await po.setCookie(origin, "wgp_session", host.jar.cookies.get("wgp_session"));
  await po.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(host.user.id), sameSite: "Lax" });
  await po.scheme("dark");
  await po.goto(`${origin}/t/${longTrip}/#/places`);
  await po.until(`document.querySelectorAll("#view .pl-row").length === 12`, "long Places list", 20000);
  await sleep(300);

  const onlineErrors = [...p.errors, ...pw.errors, ...po.errors];
  po.errors.length = 0;

  await po.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await po.until(`document.body.dataset.netpill === "1" && !document.getElementById("netpill").hidden ? 1 : 0`, "offline pill", 20000);
  await sleep(300);

  await po.eval(`(() => { const v = document.getElementById("view"); v.scrollTop = v.scrollHeight; return 1; })()`);
  await sleep(350);
  const offPlList = JSON.parse(await po.eval(`JSON.stringify((() => {
    const last = [...document.querySelectorAll("#view .pl-row")].at(-1)?.getBoundingClientRect();
    const pill = document.getElementById("netpill")?.getBoundingClientRect();
    const fab = document.querySelector("#rt-fixed .fab")?.getBoundingClientRect();
    const bar = document.querySelector(".tabbar")?.getBoundingClientRect();
    return {
      lastBottom: last ? Math.round(last.bottom) : null,
      pillTop: pill ? Math.round(pill.top) : null,
      fabTop: fab ? Math.round(fab.top) : null,
      barTop: bar ? Math.round(bar.top) : null,
    };
  })())`));
  check("390 offline Places list scrolled to end clears Offline pill, +, and tab bar by >= 8px",
    offPlList.lastBottom !== null && offPlList.pillTop !== null && offPlList.lastBottom <= offPlList.pillTop - 8 &&
    (offPlList.fabTop === null || offPlList.lastBottom <= offPlList.fabTop - 8) &&
    (offPlList.barTop === null || offPlList.lastBottom <= offPlList.barTop - 8),
    JSON.stringify(offPlList));

  await po.click(".pl-viewbtn");
  await po.until(`document.querySelector("#view .mp-body .pl-row") && document.querySelector("#view .mp-scale") ? 1 : 0`, "offline map", 20000);
  await sleep(600);

  await po.eval(`(() => { const b = document.querySelector("#view .mp-body"); b.scrollTop = b.scrollHeight; return 1; })()`);
  await sleep(350);
  const offSheetList = JSON.parse(await po.eval(`JSON.stringify((() => {
    const last = [...document.querySelectorAll("#view .mp-body .pl-row")].at(-1)?.getBoundingClientRect();
    const pill = document.getElementById("netpill")?.getBoundingClientRect();
    const fab = document.querySelector("#rt-fixed .fab")?.getBoundingClientRect();
    const bar = document.querySelector(".tabbar")?.getBoundingClientRect();
    return {
      lastBottom: last ? Math.round(last.bottom) : null,
      pillTop: pill ? Math.round(pill.top) : null,
      fabTop: fab ? Math.round(fab.top) : null,
      barTop: bar ? Math.round(bar.top) : null,
    };
  })())`));
  check("390 offline Map sheet list scrolled to end clears Offline pill, +, and tab bar by >= 8px",
    offSheetList.lastBottom !== null && offSheetList.pillTop !== null && offSheetList.lastBottom <= offSheetList.pillTop - 8 &&
    (offSheetList.fabTop === null || offSheetList.lastBottom <= offSheetList.fabTop - 8) &&
    (offSheetList.barTop === null || offSheetList.lastBottom <= offSheetList.barTop - 8),
    JSON.stringify(offSheetList));

  await po.click("#view .mp-grab");
  await po.until(`document.querySelector('#view .mp-root[data-sheet="shut"]') ? 1 : 0`, "offline map sheet shut", 10000);
  await sleep(350);
  const shutScale = JSON.parse(await po.eval(`JSON.stringify((() => {
    const s = document.querySelector("#view .mp-scale")?.getBoundingClientRect();
    const pill = document.getElementById("netpill")?.getBoundingClientRect();
    return {
      scaleBottom: s ? Math.round(s.bottom) : null,
      pillTop: pill ? Math.round(pill.top) : null,
    };
  })())`));
  check("390 offline shut map sheet keeps .mp-scale clear above Offline pill by >= 8px",
    shutScale.scaleBottom !== null && shutScale.pillTop !== null && shutScale.scaleBottom <= shutScale.pillTop - 8,
    JSON.stringify(shutScale));
  await po.click("#view .mp-peek");
  await po.until(`document.querySelector('#view .mp-root[data-sheet="open"]') ? 1 : 0`, "offline map sheet reopened", 10000);
  await sleep(350);

  const scaleFitHit = JSON.parse(await po.eval(`JSON.stringify((() => {
    const s = document.querySelector("#view .mp-scale")?.getBoundingClientRect();
    const hits = [];
    const over = (r) => !!(s && r && r.width > 0 && r.height > 0 && !(r.right <= s.left || r.left >= s.right || r.bottom <= s.top || r.top >= s.bottom));
    for (const pin of document.querySelectorAll("#view .mp-pin")) {
      const b = pin.querySelector(".mp-pin-body")?.getBoundingClientRect();
      const l = pin.dataset.label === "1" ? pin.querySelector(".mp-pin-label")?.getBoundingClientRect() : null;
      if (over(b)) hits.push({ id: pin.dataset.id, what: "body", r: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)] });
      if (over(l)) hits.push({ id: pin.dataset.id, what: "label", r: [Math.round(l.left), Math.round(l.top), Math.round(l.right), Math.round(l.bottom)] });
    }
    return { scale: s ? [Math.round(s.left), Math.round(s.top), Math.round(s.right), Math.round(s.bottom)] : null, hits, pins: document.querySelectorAll("#view .mp-pin").length };
  })())`));
  check("390 offline fitted map keeps pins and labels out of .mp-scale's box",
    scaleFitHit.scale !== null && scaleFitHit.pins >= 1 && scaleFitHit.hits.length === 0,
    JSON.stringify(scaleFitHit));

  // Select Vondelpark first (opens card sheet so .mp-scale settles), then position it right above .mp-scale:
  // label must never sit behind .mp-scale (flips above)
  await po.eval(`(() => { __wgpMapView.jumpTo({ lng: 4.8650, lat: 52.3520, zoom: 14 }); return 1; })()`);
  await sleep(300);
  await po.click('.mp-pin[data-id="vondel"] .mp-pin-body');
  await po.until(`document.querySelector('#view .mp-card') ? 1 : 0`, "offline map card", 10000);
  await sleep(450);
  await po.eval(`(() => {
    const s = document.querySelector("#view .mp-scale").getBoundingClientRect();
    const r = document.querySelector("#view .mp-surface").getBoundingClientRect();
    const ox = (s.left + s.width / 2) - (r.left + r.width / 2);
    const oy = (s.top - 10) - (r.top + r.height / 2);
    __wgpMapView.jumpTo({ lng: 4.8650, lat: 52.3520, zoom: 14, offset: [ox, oy] });
    return 1;
  })()`);
  await sleep(350);
  const nearScale = JSON.parse(await po.eval(`JSON.stringify((() => {
    const s = document.querySelector("#view .mp-scale").getBoundingClientRect();
    const pin = document.querySelector('.mp-pin[data-id="vondel"]');
    const l = pin && pin.dataset.label === "1" ? pin.querySelector(".mp-pin-label").getBoundingClientRect() : null;
    const hit = !!(l && !(l.right <= s.left || l.left >= s.right || l.bottom <= s.top || l.top >= s.bottom));
    return {
      labpos: pin?.dataset.labpos || null,
      shown: pin?.dataset.label || null,
      hit,
      scale: [Math.round(s.left), Math.round(s.top), Math.round(s.right), Math.round(s.bottom)],
      label: l ? [Math.round(l.left), Math.round(l.top), Math.round(l.right), Math.round(l.bottom)] : null,
    };
  })())`));
  check("Pin positioned just above .mp-scale keeps its selected label visible and out of .mp-scale's box",
    !nearScale.hit && nearScale.shown === "1",
    JSON.stringify(nearScale));

  await po.goto(`${origin}/t/${longTrip}/#/p/vondel`);
  await po.until(`document.querySelector("#view .pl-page") ? 1 : 0`, "offline place detail", 15000);
  await sleep(350);
  await po.eval(`(() => { const v = document.getElementById("view"); v.scrollTop = v.scrollHeight; return 1; })()`);
  await sleep(350);
  const offDet390 = JSON.parse(await po.eval(`JSON.stringify((() => {
    const kids = [...document.querySelectorAll("#view .pl-page > *")].filter((el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.width > 0; });
    const last = kids.at(-1)?.getBoundingClientRect();
    const pill = document.getElementById("netpill")?.getBoundingClientRect();
    const back = document.getElementById("backbtn")?.getBoundingClientRect();
    return {
      lastBottom: last ? Math.round(last.bottom) : null,
      pillTop: pill ? Math.round(pill.top) : null,
      backTop: back ? Math.round(back.top) : null,
    };
  })())`));
  check("390 offline Place detail scrolled to end clears Offline pill and Back by >= 8px",
    offDet390.lastBottom !== null && offDet390.pillTop !== null && offDet390.backTop !== null &&
    offDet390.lastBottom <= offDet390.pillTop - 8 && offDet390.lastBottom <= offDet390.backTop - 8,
    JSON.stringify(offDet390));

  await po.size({ width: 1440, height: 900, mobile: false });
  await po.until(`document.querySelector('#view[data-two="1"] .rt-pane-b .pl-page') ? 1 : 0`, "1440 offline two-pane place", 15000);
  await sleep(350);
  await po.eval(`(() => { const b = document.querySelector("#view .rt-pane-b"); b.scrollTop = b.scrollHeight; return 1; })()`);
  await sleep(350);
  const offDet1440 = JSON.parse(await po.eval(`JSON.stringify((() => {
    const b = document.querySelector("#view .rt-pane-b");
    const kids = [...b.querySelectorAll(".pl-page > *")].filter((el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.width > 0; });
    const last = kids.at(-1)?.getBoundingClientRect();
    const pill = document.getElementById("netpill")?.getBoundingClientRect();
    return {
      padBottom: Math.round(parseFloat(getComputedStyle(b).paddingBottom) || 0),
      lastBottom: last ? Math.round(last.bottom) : null,
      pillTop: pill ? Math.round(pill.top) : null,
      vh: innerHeight,
    };
  })())`));
  check("1440 two-pane offline Place detail clears Offline pill by >= 8px",
    offDet1440.lastBottom !== null && offDet1440.pillTop !== null &&
    offDet1440.padBottom >= offDet1440.vh - offDet1440.pillTop + 8 && offDet1440.lastBottom <= offDet1440.pillTop - 8,
    JSON.stringify(offDet1440));

  await po.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const offlineErrors = po.errors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR_/.test(e));

  await pw.close();
  await po.close();

  const allErrors = [...onlineErrors, ...offlineErrors];
  check("no console/page errors", allErrors.length === 0, allErrors.join(" | ").slice(0, 300));
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  await chrome?.close().catch(() => {});
  await server.stop().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);
