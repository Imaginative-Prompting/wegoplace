// A SHARED BOARD ON THE WALL (migration 0041; src/api/collage.js, src/share-page.js). A share keeps where its board is in
// its picture, its scale and its material, all six or none, and its page draws that board, in that material, on the
// wall, with the look public/js/shared/board-look.js gives the app. A share made before draws its whole picture as a
// corkboard, on the wall.
//
//   node checks/trips/share-board.mjs [--port <port>]   (its server on the port and the inspector on port+1000)
//
// 1. Sent with all six: kept as sent; its page has the board at that place, in that material, its frame and grain at
//    the share's scale, the wall's paint, and a dark look for a phone at Night.
// 2. Each wrong way is refused in words, and keeps nothing: five of six, a place outside the picture, a material that
//    isn't one, a scale that isn't a number.
// 3. A share sent without (made before): its whole picture a corkboard, on the wall.
// 4. The look is board-look.js's own, not a copy: the wall, the material's grain, the frame's colours and the shadow.
// 5. The fasteners are the app's (fasteners.js): a tack on corkboard, a magnet on slate, each photograph's variant and seat
//    from the pin the app sent with it (a photograph sent without hashes its place), and a pin that isn't a number
//    refused.
// 6. The camera can't lose the board (panLimit, which the page carries): fitted, the picture is centred; at full zoom
//    on a phone, panned as far as it goes each way, half the screen is still board; a share made before pans
//    over its whole picture as it always has. (In a browser: checks/trips/board-page.mjs.)
// 7. The lamp's pool on the wall, as the app's: centred on the board, pool.size times its longer side across, under the
//    panel, its light by day and at Night and its noise from board-look.js.
// 8. A shared clip answers a range as /media/ does (src/media-files.js rangedGet; Safari on an iPhone won't play a
//    video without): Accept-Ranges on every answer, 206 for bytes=0-1, an open-ended and a suffix range, each the
//    right bytes with the clip's size, 416 with `bytes */<size>` past the end, the board's picture the same, and an
//    item the board hasn't got the plain 404. (A seek in a browser: checks/trips/board-page.mjs.)
// Everyone in it is made up.

import { CheckError, startServer, freePort } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { JPEG, mp4OfSize } from "../lib/images.mjs";
import { BOARD_LOOK, GRAIN, GROUNDS, POOL_NOISE, WALL_GRAIN, corkTileOf, woodOf } from "../../public/js/shared/board-look.js";
import { MAGNETS, TACKS, fastHash, fastenerGeometry } from "../../public/js/shared/fasteners.js";
import { panLimit } from "../../src/share-page.js";

const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : await freePort());
const t = new Report("a shared board on the wall");

let server, code = 1;
try {
  server = await startServer({ name: "share-board", port });
  await server.start();
  const o = server.origin;
  const host = new Person(o, "Host Wall");
  await host.signUp();
  const trip = (await host.post("/api/trips", { name: "Wall Trip", default_tz: "UTC" })).json.trip.id;
  const T = `/api/trips/${trip}`;
  const share = (fields) => host.call("POST", `${T}/collage/share?${new URLSearchParams({ mime: "image/jpeg", w: "2048", h: "1536", title: "Board", ...fields })}`,
    JPEG, { headers: { "Content-Type": "image/jpeg" } });
  const item = (id, extra = "", idx = 0) => host.call("POST", `${T}/collage/share/${id}/item?idx=${idx}&kind=photo&mime=image%2Fjpeg&w=40&h=30&fx=0.2&fy=0.2&fw=0.3&fh=0.3&rot=7${extra}`,
    JPEG, { headers: { "Content-Type": "application/octet-stream" } });
  const page = async (id) => (await fetch(`${o}/s/${id}`)).text();
  const panelOf = (html) => /<div class="board-panel" data-bg="([a-z]+)" aria-hidden="true" style="left:([\d.]+)%;top:([\d.]+)%;width:([\d.]+)%;height:([\d.]+)%"><\/div>/.exec(html);
  const row = (id) => server.sql(`SELECT board_x, board_y, board_w, board_h, board_scale, board_ground FROM collage_shares WHERE id = '${id}'`)[0];
  const ruleOf = (html) => (/\.board-panel\{([^}]*)\}/.exec(html) ?? [])[1] ?? "";
  const darkOf = (html) => (/@media \(prefers-color-scheme:dark\)\{\.board-panel\{([^}]*)\}\}/.exec(html) ?? [])[1] ?? "";

  t.part("1. Sent with all six: kept, and drawn");
  const six = { bx: "0.0625", by: "0.0833", bw: "0.875", bh: "0.8333", bs: "0.5", bg: "slate" };
  const made = await share(six);
  const id = made.json?.share?.id;
  if (made.status !== 201 || !id) throw new CheckError(`the share wasn't made: ${made.status} ${JSON.stringify(made.json)}`);
  await item(id);
  t.same("kept as sent", row(id), { board_x: 0.0625, board_y: 0.0833, board_w: 0.875, board_h: 0.8333, board_scale: 0.5, board_ground: "slate" });
  const html = await page(id);
  const p = panelOf(html);
  t.same("its page has the board at that place, in that material, under the photographs",
    p && [p[1], Number(p[2]), Number(p[3]), Number(p[4]), Number(p[5])], ["slate", 6.25, 8.33, 87.5, 83.33]);
  t.ok("  the board comes before the tiles (under them)", html.indexOf('class="board-panel"') < html.indexOf('class="tiles"'));
  // The page's logical board is 1440 wide for a 2048 px picture: a unit is 0.5 x 1440/2048 px.
  const u = 0.5 * 1440 / 2048;
  const rule = ruleOf(html);
  const num = (re) => Number((re.exec(rule) ?? [])[1]);
  // The board is 0.875 x 0.8333 of a 2048 x 1536 picture at 0.5 px a unit: 3584 by 2560 units. Its wood is the app's and
  // the export's (woodOf: frameFrac of the shorter side, or frame.width if that is more), and so is the cork's tile.
  const units = { w: (0.875 * 2048) / 0.5, h: (0.8333 * 1536) / 0.5 };
  const wood = woodOf(units);
  t.ok(`slate's wood frame grows with the board: ${wood.toFixed(2)} units = ${(wood * u).toFixed(3)} px`,
    wood > BOARD_LOOK.frame.slate.width && Math.abs(num(/border-width:([\d.]+)px/) - wood * u) < 0.01, rule.slice(0, 200));
  t.ok("  its grain at 96 units a tile, its fill and its wood, by day", Math.abs(num(/background-size:([\d.]+)px/) - 96 * u) < 0.01
    && rule.includes(`background-color:${GROUNDS.slate.fill.light}`) && rule.includes(`background-image:${GRAIN.slate.light}`)
    && rule.includes(`border-color:${BOARD_LOOK.wood.light}`) && rule.includes(`inset 0 0 0 ${+u.toFixed(3)}px ${BOARD_LOOK.woodInner}`));
  t.ok("  and at Night: the dark fill, grain, wood and shadow", darkOf(html).includes(`background-color:${GROUNDS.slate.fill.dark}`)
    && darkOf(html).includes(`background-image:${GRAIN.slate.dark}`) && darkOf(html).includes(`border-color:${BOARD_LOOK.wood.dark}`));
  t.ok("the wall's paint, by day and at Night", html.includes(`background-color:${BOARD_LOOK.wall.light};background-image:${WALL_GRAIN.light}`)
    && html.includes(`.viewport{background-color:${BOARD_LOOK.wall.dark};background-image:${WALL_GRAIN.dark}}`));
  t.ok("  its grain anchored at the app's tile (96 units)", new RegExp(`data-wall-tile="${+(96 * u).toFixed(4)}"`).test(html));
  t.ok("the page names the board by its material", /aria-label="A slate board of 1 trip photographs and videos"/.test(html) && /aria-label="Interactive slate board\./.test(html));
  {
    const fridge = await share({ ...six, bg: "fridge", bs: "1" });
    const fHtml = await page(fridge.json.share.id);
    const f = ruleOf(fHtml);
    const u1 = 1440 / 2048;
    t.ok("a fridge: its rounded corners (22 units) at its scale, and no border on the panel", Math.abs(Number(/border-radius:([\d.]+)px/.exec(f)?.[1]) - 22 * u1) < 0.01
      && /border-width:0px/.test(f), f.slice(0, 160));
    const edgeRule = (h) => (/\.board-edge\{([^}]*)\}/.exec(h) ?? [])[1] ?? "";
    const edgeDark = (h) => (/@media \(prefers-color-scheme:dark\)\{\.board-edge\{([^}]*)\}\}/.exec(h) ?? [])[1] ?? "";
    t.ok(`  its enamel line a screen hairline (${BOARD_LOOK.hair.enamel}px), placed over the board from the camera, its corners following`,
      edgeRule(fHtml).includes(`border:${BOARD_LOOK.hair.enamel}px solid ${BOARD_LOOK.enamel.light}`) && edgeDark(fHtml).includes(`border-color:${BOARD_LOOK.enamel.dark}`)
        && new RegExp(`class="board-edge" data-bg="fridge"[^>]*data-r="${+(22 * u1).toFixed(3)}"`).test(fHtml), edgeRule(fHtml));
    const paper = await share({ ...six, bg: "paper" });
    const pHtml = await page(paper.json.share.id);
    t.ok(`a paper board: no border on the panel; its edge line a ${BOARD_LOOK.hair.line}px screen hairline`, /border-width:0px/.test(ruleOf(pHtml))
      && edgeRule(pHtml).includes(`border:${BOARD_LOOK.hair.line}px solid ${BOARD_LOOK.line.light}`) && edgeDark(pHtml).includes(`border-color:${BOARD_LOOK.line.dark}`));
    t.ok(`at Night every board has its lit rim, ${BOARD_LOOK.hair.rim}px on the screen; slate's wood has no edge line`,
      [fHtml, pHtml, html].every((h) => edgeDark(h).includes(`box-shadow:0 0 0 ${BOARD_LOOK.hair.rim}px ${BOARD_LOOK.rim.dark}`)) && !/border:/.test(edgeRule(html)));
    t.ok("  the edge's place is the panel's, in the board's logical px", new RegExp(`class="board-edge" data-bg="slate" aria-hidden="true" data-x="${+(0.0625 * 1440).toFixed(3)}" data-y="${+(0.0833 * 1080).toFixed(3)}"`).test(html));
    const cork = await share({ ...six, bg: "corkboard" });
    const c = ruleOf(await page(cork.json.share.id));
    const tile = corkTileOf(units);
    t.ok(`a corkboard: the cork photograph at the app's tile for this board (${tile.toFixed(1)} units, more than the least, ${BOARD_LOOK.cork.tile})`,
      c.includes(`background-image:${GRAIN.corkboard.light}`) && c.includes("/textures/cork.jpg") && tile > BOARD_LOOK.cork.tile
      && Math.abs(Number(/background-size:([\d.]+)px/.exec(c)?.[1]) - tile * u) < 0.01, c.slice(0, 200));
  }

  t.part("2. Each wrong way refused in words, nothing kept");
  const before = server.sql("SELECT COUNT(*) AS n FROM collage_shares")[0].n;
  const wrong = [
    ["five of six (no material)", { ...six, bg: undefined }],
    ["a place past the picture's edge", { ...six, bx: "0.5", bw: "0.6" }],
    ["a place at a negative", { ...six, by: "-0.1" }],
    ["a board of no width", { ...six, bw: "0" }],
    ["a material that isn't one", { ...six, bg: "lava" }],
    ["a scale that isn't a number", { ...six, bs: "big" }],
    ["a scale of 0", { ...six, bs: "0" }],
  ];
  const answers = [];
  for (const [what, fields] of wrong) {
    const r = await share(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
    answers.push([what, r.status, r.json?.error, typeof r.json?.reason === "string" && r.json.reason.length > 20]);
  }
  t.ok(`each of ${wrong.length} refused (400, "bad board", with a sentence)`, answers.every(([, s, e, said]) => s === 400 && e === "bad board" && said), JSON.stringify(answers.filter(([, s, e, said]) => !(s === 400 && e === "bad board" && said))));
  t.same("  and none kept", server.sql("SELECT COUNT(*) AS n FROM collage_shares")[0].n, before);

  t.part("3. A share made before (sent without): a corkboard, on the wall");
  const old = await share({});
  await item(old.json.share.id);
  const oldHtml = await page(old.json.share.id);
  const op = panelOf(oldHtml);
  t.same("kept with none of the six", Object.values(row(old.json.share.id)), [null, null, null, null, null, null]);
  t.same("its whole picture is the board, a corkboard", op && [op[1], Number(op[2]), Number(op[3]), Number(op[4]), Number(op[5])], ["corkboard", 0, 0, 100, 100]);
  t.ok("  with the cork at its old size (300 px a tile) and the wall round it", Math.abs(Number(/background-size:([\d.]+)px/.exec(ruleOf(oldHtml))?.[1]) - 300) < 0.01
    && oldHtml.includes(`background-color:${BOARD_LOOK.wall.light}`));

  t.part("4. The look is board-look.js's, not a copy");
  const src = (await import("node:fs")).readFileSync(new URL("../../src/share-page.js", import.meta.url), "utf8");
  t.ok("src/share-page.js imports it and writes none of its colours itself",
    /import \{[^}]*BOARD_LOOK[^}]*\} from "\.\.\/public\/js\/shared\/board-look\.js";/.test(src)
      && ![BOARD_LOOK.wall.light, BOARD_LOOK.wall.dark, BOARD_LOOK.wood.light, BOARD_LOOK.woodInner, GROUNDS.corkboard.fill.light, "ambientcg"].some((c) => src.includes(c)));

  {
    // The wordmark's colorway follows the wall under it: the logo's paper colorway (dark ink) on the day wall, its void
    // colorway (light ink) on the night wall, each the logo's own values (public/ds/tokens.css), its letters at 3:1 at
    // least against that wall.
    const tokens = (await import("node:fs")).readFileSync(new URL("../../public/ds/tokens.css", import.meta.url), "utf8");
    const day = /\.mark\{[^}]*\}/.exec(html)?.[0] ?? "";
    const night = /@media \(prefers-color-scheme:dark\)\{\.mark\{[^}]*\}\}/.exec(html)?.[0] ?? "";
    const v = (rule, name) => new RegExp(`--${name}:(#[0-9A-Fa-f]{6})`).exec(rule)?.[1] ?? "";
    const paper = /:root \{([^}]*)\}/.exec(tokens)?.[1] ?? "", voidWay = /:root\[data-lum="dark"\] \{([^}]*)\}/.exec(tokens)?.[1] ?? "";
    const KEYS = ["logo-letter", "logo-figure", "logo-shade", "logo-pack", "logo-rope"];
    const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const byDay = v(day, "logo-letter") ? contrast(v(day, "logo-letter"), BOARD_LOOK.wall.light) : 0;
    const byNight = v(night, "logo-letter") ? contrast(v(night, "logo-letter"), BOARD_LOOK.wall.dark) : 0;
    t.ok(`the wordmark reads on the wall under it: the logo's paper colorway by day (${byDay.toFixed(1)}:1), its void colorway at Night (${byNight.toFixed(1)}:1), each 3:1 at least`,
      KEYS.every((k) => v(day, k) && paper.includes(`--${k}: ${v(day, k)}`)) && KEYS.every((k) => v(night, k) && voidWay.includes(`--${k}: ${v(night, k)}`))
        && byDay >= 3 && byNight >= 3, JSON.stringify({ day: KEYS.map((k) => v(day, k)), night: KEYS.map((k) => v(night, k)), byDay, byNight }));
  }

  t.ok("the hint has its touch words and its desktop words, the touch ones shown on a coarse pointer or a phone's screen (short side under 600, as the app's onPhone)",
    html.includes('<span class="hint-desk">Drag to move &middot; pinch or &#8984;/Ctrl-scroll to zoom</span><span class="hint-touch">Drag to move &middot; pinch to zoom</span>')
      && html.includes("@media (pointer:coarse){.hint-touch{display:inline}.hint-desk{display:none}}") && html.includes("Math.min(screen.width, screen.height) < 600) hintEl.dataset.touch = \"1\""));

  t.part("5. The app's fasteners");
  {
    const fastOf = (html, i) => {
      const tile = html.split('<button class="tile"')[i + 1] ?? "";
      const m = /<span class="fast" data-v="(\d)" aria-hidden="true" style="left:(-?[\d.]+)px;top:(-?[\d.]+)px;width:([\d.]+)px;height:([\d.]+)px;--s:([\d.]+)"><i><\/i><\/span>/.exec(tile);
      return m && { v: Number(m[1]), left: Number(m[2]), top: Number(m[3]), d: Number(m[4]) };
    };
    const want = (kind, pin, scale) => {
      const unit = scale * 1440 / 2048;                       // the page's px per board unit
      const g = fastenerGeometry(kind, { w: (0.3 * 1440) / unit, h: (0.3 * 1080) / unit }, pin);
      return { v: g.variant % 3, left: +(g.left * unit).toFixed(2), top: +(g.top * unit).toFixed(2), d: +(g.d * unit).toFixed(2) };
    };
    const cork = await share({ ...six, bg: "corkboard" });
    const corkId = cork.json.share.id;
    const sent = await item(corkId, "&pin=2654435761");
    const corkHtml = await page(corkId);
    t.same("a photograph sent with its pin keeps it", [sent.status, server.sql(`SELECT pin FROM collage_share_items WHERE share_id = '${corkId}'`)[0]?.pin], [200, 2654435761]);
    t.same("  its tack: the app's variant and seat for that pin, at the share's scale", fastOf(corkHtml, 0), want("tack", 2654435761, 0.5));
    t.ok("  the tacks' own colours (oxblood, bone, brass), by day and at Night", TACKS.light.every((c) => corkHtml.includes(c.mid)) && TACKS.dark.every((c) => corkHtml.includes(c.mid)) && !MAGNETS.light.some((c) => corkHtml.includes(c.mid)));
    const slate = await share(six);
    await item(slate.json.share.id, "&pin=7");
    const slateHtml = await page(slate.json.share.id);
    t.same("on slate a magnet, the app's for that pin", fastOf(slateHtml, 0), want("magnet", 7, 0.5));
    t.ok("  the magnets' own colours (cream, navy, charcoal)", MAGNETS.light.every((c) => slateHtml.includes(c.mid)) && !TACKS.light.some((c) => slateHtml.includes(c.mid)));
    const bare = await share({ ...six, bg: "paper" });
    await item(bare.json.share.id, "", 3);
    t.same("a photograph sent without a pin: its place's own (its slot and where it sits, the same on every server)", fastOf(await page(bare.json.share.id), 0), want("tack", fastHash("place:0.2000,0.2000", 3), 0.5));
    t.ok("no tack of the page's own old colours is left", !/#d94538|#d5a746|#568ba8/.test(corkHtml + slateHtml));
    const bad = await item(corkId, "&pin=lots", 1);
    t.same("a pin that isn't a whole number is refused in words, and nothing kept", [bad.status, bad.json?.error, server.sql(`SELECT COUNT(*) AS n FROM collage_share_items WHERE share_id = '${corkId}' AND idx = 1`)[0].n], [400, "bad pin", 0]);
  }

  t.part("6. The camera can't lose the board");
  {
    // The slate share above on a 390 x 844 phone: its picture 1440 x 1080 logical px, the board 90..1350 across and
    // 90..990 down (a band of wall 90 px each side), the page's top zoom 6.
    const P = [1440, 1080], B = [[0.0625 * 1440, 0.9375 * 1440], [0.0833 * 1080, (0.0833 + 0.8333) * 1080]], V = [390, 844], K = 6;
    const seen = (t0, k, b, view) => Math.max(0, Math.min(view, t0 + b[1] * k) - Math.max(0, t0 + b[0] * k));
    const fit = Math.min(V[0] / P[0], V[1] / P[1]);
    const fitted = [0, 1].map((a) => panLimit(V[a], fit, P[a], B[a][0], B[a][1]));
    t.ok("fitted, the whole picture is on the screen, centred", fitted.every(([lo, hi], a) => lo === hi && Math.abs(lo * 2 + P[a] * fit - V[a]) < 1e-9), JSON.stringify(fitted));
    const ends = [0, 1].flatMap((a) => panLimit(V[a], K, P[a], B[a][0], B[a][1]).map((t0) => seen(t0, K, B[a], V[a]) / V[a]));
    t.ok(`at full zoom (${K}), panned as far as it goes each way, at least half the screen is board: ${ends.map((f) => f.toFixed(2)).join(", ")}`,
      ends.every((f) => f >= 1 / 2 - 1e-9), JSON.stringify(ends));
    const old = [0, 1].flatMap((a) => [V[a] - P[a] * K, 0].map((t0) => seen(t0, K, B[a], V[a]) / V[a]));
    t.ok(`  (the rule before, the picture's own edge: ${old.map((f) => f.toFixed(2)).join(", ")} of the screen board; across, both ends all wall)`,
      old[0] === 0 && old[1] === 0, JSON.stringify(old));
    const mid = fit * 1.5;
    t.same("  a little way in, the whole band of wall can still be reached", [0, 1].map((a) => panLimit(V[a], mid, P[a], B[a][0], B[a][1])),
      [0, 1].map((a) => P[a] * mid <= V[a] ? [(V[a] - P[a] * mid) / 2, (V[a] - P[a] * mid) / 2] : [V[a] - P[a] * mid, -0]));
    t.same("a share made before (its whole picture the board) pans over the whole picture, as it did",
      [0, 1].map((a) => panLimit(V[a], K, P[a], 0, P[a])), [0, 1].map((a) => [V[a] - P[a] * K, -0]));
    t.ok("the page carries panLimit and its camera keeps to it", /var panLimit = function \w*\(view, k, P, b0, b1\)/.test(html)
      && /var lx = panLimit\(vw, k, W, /.test(html) && /var ly = panLimit\(vh, k, H, /.test(html));
  }

  t.part("7. The lamp's pool on the wall");
  {
    // The slate board: 0.0625..0.9375 of 1440 across, 0.0833..0.9166 of 1080 down; its longer side 1260 logical px.
    const m = /<div class="board-pool" aria-hidden="true" style="left:(-?[\d.]+)px;top:(-?[\d.]+)px;width:([\d.]+)px;height:([\d.]+)px"><\/div><div class="board-panel"/.exec(html);
    const R = (BOARD_LOOK.pool.size * 0.875 * 1440) / 2, cx = (0.0625 + 0.875 / 2) * 1440, cy = (0.0833 + 0.8333 / 2) * 1080;
    t.ok(`centred on the board, ${BOARD_LOOK.pool.size} times its longer side across (${(2 * R).toFixed(0)} px), just under the panel`,
      !!m && Math.abs(Number(m[1]) + R - cx) < 0.01 && Math.abs(Number(m[2]) + R - cy) < 0.01 && Math.abs(Number(m[3]) - 2 * R) < 0.01 && m[3] === m[4], JSON.stringify(m && m.slice(1)));
    const pool = (/\.board-pool\{([^}]*)\}/.exec(html) ?? [])[1] ?? "", after = (/\.board-pool::after\{([^}]*)\}/.exec(html) ?? [])[1] ?? "";
    const dark = (/@media \(prefers-color-scheme:dark\)\{\.board-pool\{([^}]*)\}\}/.exec(html) ?? [])[1] ?? "";
    t.ok("  its light fading to nothing at its edge, by day and at Night, as BOARD_LOOK.pool says", pool.includes(`radial-gradient(closest-side,${BOARD_LOOK.pool.light},`)
      && dark.includes(`radial-gradient(closest-side,${BOARD_LOOK.pool.dark},`) && /,rgba\(255,252,244,0\) 100%\)/.test(pool) && /,rgba\(255,226,186,0\) 100%\)/.test(dark), pool + " | " + dark);
    t.ok(`  dithered by board-look.js's noise, as large as the pool, at ${BOARD_LOOK.pool.noise}`, after.includes(`opacity:${BOARD_LOOK.pool.noise}`)
      && after.includes(`background-image:${POOL_NOISE}`) && after.includes("background-size:100% 100%"), after.slice(0, 120));
    const src = (await import("node:fs")).readFileSync(new URL("../../public/js/collage.js", import.meta.url), "utf8");
    t.ok("  the app's .cg-pool uses the same noise (one source)", /\.cg-pool::after\{[\s\S]{0,200}?background-image:\$\{POOL_NOISE\};/.test(src) && !src.includes("feTurbulence"));
  }

  t.part("8. A shared clip answers a range, as /media/ does");
  {
    // A clip on the board (its bytes all different, so a wrong slice shows), and the board's own picture.
    const clip = mp4OfSize(300_000);
    for (let i = 8 + 20; i < clip.length; i++) clip[i] = (i * 7) % 251;
    const made = await share({});
    const sid = made.json?.share?.id;
    const sent = await host.call("POST", `${T}/collage/share/${sid}/item?idx=0&kind=video&mime=video%2Fmp4&w=640&h=360&fx=0.2&fy=0.2&fw=0.3&fh=0.3&rot=0`,
      clip, { headers: { "Content-Type": "application/octet-stream" } });
    t.same("made up: a board with a clip on it", [made.status, sent.status], [201, 200]);
    const size = clip.length, at = `${o}/s/${sid}/i/0`;
    const get = async (range, url = at) => { const r = await fetch(url, range ? { headers: { Range: range } } : {}); return { r, body: Buffer.from(await r.arrayBuffer()) }; };
    const h = (r, k) => r.headers.get(k);
    const same = (r) => h(r, "accept-ranges") === "bytes" && /^public, max-age=31536000, immutable$/.test(h(r, "cache-control") ?? "") && h(r, "x-content-type-options") === "nosniff";
    const say = (r, body) => `${r.status} ${JSON.stringify({ range: h(r, "content-range"), length: h(r, "content-length"), type: h(r, "content-type"), ranges: h(r, "accept-ranges"), cache: h(r, "cache-control"), sniff: h(r, "x-content-type-options"), got: body.length })}`;

    const whole = await get(null);
    t.ok("asked for nothing in particular: 200, the whole clip as sent, saying it takes ranges, kept for good, not sniffed",
      whole.r.status === 200 && whole.body.equals(clip) && h(whole.r, "content-type") === "video/mp4" && h(whole.r, "content-length") === String(size) && same(whole.r), say(whole.r, whole.body));
    const probe = await get("bytes=0-1");
    t.ok("bytes=0-1 (how a player probes): 206, those two bytes, and the clip's size", probe.r.status === 206 && probe.body.equals(clip.subarray(0, 2))
      && h(probe.r, "content-range") === `bytes 0-1/${size}` && h(probe.r, "content-length") === "2" && same(probe.r), say(probe.r, probe.body));
    const open = await get("bytes=100000-");
    t.ok("bytes=100000- (how a player seeks): 206, from there to the end", open.r.status === 206 && open.body.equals(clip.subarray(100000))
      && h(open.r, "content-range") === `bytes 100000-${size - 1}/${size}` && same(open.r), say(open.r, open.body));
    const tail = await get("bytes=-500");
    t.ok("bytes=-500: 206, the last 500", tail.r.status === 206 && tail.body.equals(clip.subarray(size - 500))
      && h(tail.r, "content-range") === `bytes ${size - 500}-${size - 1}/${size}` && same(tail.r), say(tail.r, tail.body));
    const past = await get(`bytes=${size}-`);
    t.ok("a range past the end: 416, with the clip's real size to ask again by", past.r.status === 416 && h(past.r, "content-range") === `bytes */${size}`
      && h(past.r, "accept-ranges") === "bytes", say(past.r, past.body));
    const picture = await get("bytes=0-1", `${o}/s/${sid}/image`);
    t.ok("the board's own picture the same way: 206 for bytes=0-1", picture.r.status === 206 && /^bytes 0-1\/\d+$/.test(h(picture.r, "content-range") ?? "")
      && same(picture.r), say(picture.r, picture.body));
    const none = await get("bytes=0-1", `${o}/s/${sid}/i/9`);
    t.ok("a clip the board hasn't got, asked for a range: still the plain 404", none.r.status === 404 && h(none.r, "x-content-type-options") === "nosniff", say(none.r, none.body));
  }
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await server?.stop();
}
process.exit(code);
