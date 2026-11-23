#!/usr/bin/env node
/* Flow 3 (The Itinerary + Plan it with your AI) on the design system (public/js/agenda.js,
 * plan-editor.js, plan-ai.js), checked statically and in real Chrome across 390, 768, 1440 in
 * dark (Void) and light (Paper).
 *
 *   node scripts/itinerary_ds_check.mjs --static
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> \
 *     --label "wegoplace itinerary_ds_check.mjs" -- node scripts/itinerary_ds_check.mjs
 *
 * PLANTS (ITIN_PLANT=<name>):
 *   rawcolor  injects a raw hex color into AG_CSS (static fails)
 *   offscale  injects a literal px font-size into AG_CSS (static fails)
 *   hideback  hides the shell's #backbtn from AG_CSS on plan pages (browser plan page fails)
 *   noai      drops data-plan-ai from served agenda.js (browser empty host check fails)
 *   noguest     removes GUEST_AI_LINE check in served agenda.js (browser guest check fails)
 *   noask       drops firstAsk call in served plan-ai.js (browser 3-step prompt check fails)
 *   nonetclear  drops --dock-room from served styles.css (browser offline clearance fails)
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const STATIC_ONLY = process.argv.includes("--static");
const PLANT = process.env.ITIN_PLANT || "";
const PLANTS = new Set(["rawcolor", "offscale", "hideback", "noai", "noguest", "noask", "nonetclear"]);
if (PLANT && !PLANTS.has(PLANT)) throw new Error(`no such ITIN_PLANT: ${PLANT}`);

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
section("0. Design system token & type-scale audit");
let agSrc = read("public/js/agenda.js");
let paSrc = read("public/js/plan-ai.js");
const peSrc = read("public/js/plan-editor.js");

if (PLANT === "rawcolor") agSrc = agSrc.replace("const AG_CSS = `\n", "const AG_CSS = `\n.ag-plant-raw { color: #ff00ff; }\n");
if (PLANT === "offscale") agSrc = agSrc.replace("const AG_CSS = `\n", "const AG_CSS = `\n.ag-plant-px { font-size: 13px; }\n");

const agCss = extractConst(agSrc, "AG_CSS");
const paCss = extractConst(paSrc, "PA_CSS");
const peCssFull = extractConst(peSrc, "PE_CSS");
const peDsMarker = "/* Design-system plan sheet (.pe.ds & .pe-foot.ds) */";
const peDsCss = peCssFull.includes(peDsMarker) ? peCssFull.slice(peCssFull.indexOf(peDsMarker)) : peCssFull;

for (const [label, css] of [["agenda.js AG_CSS", agCss], ["plan-ai.js PA_CSS", paCss], ["plan-editor.js .pe.ds", peDsCss]]) {
  check(`${label} CSS present`, css.length > 100);
  const rawHex = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const rawFn = css.match(/\b(?:rgba?|hsla?)\(/g) || [];
  check(`${label}: zero raw hex/rgb/hsl colors`, rawHex.length === 0 && rawFn.length === 0, [...rawHex, ...rawFn].join(", "));
  const tints = css.match(/--tint\b/g) || [];
  check(`${label}: zero undefined --tint references`, tints.length === 0, tints.join(", "));
  const badSizes = [...css.matchAll(/font-size\s*:\s*([^;}{]+)/g)].map((m) => m[1].trim()).filter((v) => !/^var\(--size-(?:12|14|16|20|28|number)\)$/.test(v));
  check(`${label}: every font-size uses strict --size-* tokens`, badSizes.length === 0, badSizes.join(", "));
}
check("agenda.js binds --ds-k from --plan-*/--cat-* tokens", /--plan-/.test(agSrc) && /--cat-/.test(agSrc) && /var\(--ds-k/.test(agCss));
check("agenda.js AG_CSS drops uppercase text-transform for sentence case",
  !/text-transform\s*:\s*uppercase/.test(agCss));
const tzRule = agCss.match(/\.ag-tz\s*\{[^}]*\}/)?.[0] || "";
check("agenda.js .ag-tz uses quiet gray tag (var(--gray-3)), not --warning",
  tzRule.includes("var(--gray-3)") && !/--warning/.test(tzRule), tzRule);
check("plan-editor.js wraps kind chips, collapses optional fields behind More details, and styles disabled Add without opacity",
  /pe-kindwrap pe-kinds/.test(peSrc) && /data-act="toggle-more"/.test(peSrc) && /:disabled\s*\{/.test(peDsCss));
check("Flow 3 touch-ups: flush empty gutter, body-font ask, 1-row 3-action plan bar (2x2 with photo), and stay kind chip at right",
  /\.ag-empty-ways\.empty\s*\{\s*align-items:\s*stretch;\s*padding:\s*var\(--sp-4\)\s+0\b/.test(agCss)
  && !/<pre class="pa-code-pre pa-ask-pre"><code>/.test(paSrc)
  && /\.ag-detail \.ph \.ag-d-acts\s*\{\s*flex-wrap:\s*nowrap;/.test(agCss)
  && /\.ag-detail \.ph \.ag-d-acts:has\(\[data-photo="remove"\]\)/.test(agCss)
  && /\.ag-detail \.ph \.ag-d-acts :is\(\.btn, \.ds-button\)/.test(agCss)
  && /<span class="ag-stay-body">[\s\S]*?\$\{trailing\}/.test(agSrc));
check("plan-ai.js uses ds-modes / ds-modes-hl / ds-mode for Where you chat",
  /class="ds-modes pa-seg"[^>]*style="--ds-n: 3; --ds-i: 0"/.test(paSrc)
  && /class="ds-modes-hl"/.test(paSrc)
  && /class="ds-mode pa-choice"/.test(paSrc)
  && !/\.pa-seg-hl\b/.test(paCss));

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

const plantedAgenda = () => {
  if (PLANT === "hideback") return agSrc.replace("const AG_CSS = `\n", "const AG_CSS = `\nbody:has(#view .ag-detail) #backbtn { display: none; }\n");
  if (PLANT === "noguest") return agSrc.replace("store.me()?.guest ? GUEST_AI_LINE", "false ? GUEST_AI_LINE");
  return agSrc;
};
const plantedAi = () => {
  if (PLANT === "noai") return paSrc.replaceAll("data-plan-ai", "data-plan-disabled-ai");
  if (PLANT === "noask") return paSrc.replace("firstAsk({", "(() => 'Write some plans.')({");
  return paSrc;
};

const server = await startServer({ name: "itinerary-ds", port: await freeLoopbackPort() });
ownServer(server.origin);
let chrome = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayOff = (n) => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

try {
  await server.start();
  const { origin } = server;
  const host = new Person(origin, "Ada Reyes");
  await host.signUp();
  const guestUser = new Person(origin, "Ben Okafor");

  const emptyTrip = (await host.post("/api/trips", {
    name: "Autumn in Porto", default_tz: "Europe/Lisbon", starts_on: dayOff(2), ends_on: dayOff(6),
  })).json.trip.id;
  const linkCode = (await host.post(`/api/trips/${emptyTrip}/links`, { uses: 2 })).json.link.code;

  chrome = await openChrome();
  const attachPlant = async (p) => {
    if (!["hideback", "noai", "noguest", "noask", "nonetclear"].includes(PLANT)) return;
    p.on((m) => {
      if (m.method !== "Fetch.requestPaused") return;
      const u = new URL(m.params.request.url);
      let body = null;
      let ct = "text/javascript; charset=utf-8";
      if (u.pathname === "/js/agenda.js") body = plantedAgenda();
      else if (u.pathname === "/js/plan-ai.js") body = plantedAi();
      else if (u.pathname === "/styles.css" && PLANT === "nonetclear") {
        ct = "text/css; charset=utf-8";
        body = read("public/styles.css")
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
    const patterns = [{ urlPattern: "*/js/agenda.js*" }, { urlPattern: "*/js/plan-ai.js*" }];
    if (PLANT === "nonetclear") patterns.push({ urlPattern: "*/styles.css*" });
    await p.send("Fetch.enable", { patterns });
  };

  // 1. Empty trip: signed-in member
  section("1. Empty trip: How do you want to plan it? + 3-step AI sheet");
  const p = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
  await attachPlant(p);
  await p.setCookie(origin, "wgp_session", host.jar.cookies.get("wgp_session"));
  await p.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(host.user.id), sameSite: "Lax" });
  await p.scheme("dark");
  await p.goto(`${origin}/t/${emptyTrip}/#/`);
  await p.until(`document.querySelector("#view .empty") ? 1 : 0`, "empty Itinerary", 20000);
  await sleep(400);
  const emp = JSON.parse(await p.eval(`JSON.stringify((() => {
    const e = document.querySelector("#view .empty");
    const ai = e.querySelector("[data-plan-ai]");
    const self = e.querySelector("[data-plan-add]");
    const fab = document.querySelector("#rt-fixed .fab");
    const h1 = document.querySelector("#view .ag-tripname-t");
    const h2 = e.querySelector(".pa-ask-h");
    return {
      text: e.innerText.replace(/\\s+/g, " ").trim(),
      ai: ai ? ai.textContent.trim() : null,
      aiBg: ai ? getComputedStyle(ai).backgroundColor : null,
      self: self ? self.textContent.trim() : null,
      fabShown: !!fab && getComputedStyle(fab).display !== "none" && !fab.hidden,
      headMoreInEnd: !!document.querySelector("#view .ds-head-end .head-more"),
      h1Left: h1 ? Math.round(h1.getBoundingClientRect().left) : -1,
      h2Left: h2 ? Math.round(h2.getBoundingClientRect().left) : -2,
      aiLeft: ai ? Math.round(ai.getBoundingClientRect().left) : -3,
    };
  })())`));
  check('empty signed-in trip offers white "Plan it with your AI" and gray "Add plans yourself", no FAB, aligned with header gutter',
    /How do you want to plan it\?/.test(emp.text) && emp.ai === "Plan it with your AI" && emp.self === "Add plans yourself"
      && !emp.fabShown && emp.headMoreInEnd
      && Math.abs(emp.h1Left - emp.h2Left) <= 2 && Math.abs(emp.h1Left - emp.aiLeft) <= 2,
    JSON.stringify(emp));

  if (emp.ai) {
    await p.click("[data-plan-ai]");
    await p.until(`document.querySelector(".sh-root[data-open='1'] .pa-sheet") ? 1 : 0`, "AI sheet open", 10000);
    await sleep(400);
    await p.click('[data-pa-pick="code"]');
    await sleep(350);
    const aiModes = JSON.parse(await p.eval(`JSON.stringify((() => {
      const seg = document.querySelector(".pa-seg");
      const hl = seg?.querySelector(".ds-modes-hl");
      const btns = [...(seg?.querySelectorAll(".ds-mode") || [])];
      const sr = seg?.getBoundingClientRect();
      const hr = hl?.getBoundingClientRect();
      return {
        hasModes: !!seg?.classList.contains("ds-modes"),
        dsN: getComputedStyle(seg).getPropertyValue("--ds-n").trim(),
        dsI: getComputedStyle(seg).getPropertyValue("--ds-i").trim(),
        hlMoved: !!(sr && hr && hr.left > sr.left + 20 && hr.width > 40),
        pressed: btns.find((b) => b.getAttribute("aria-pressed") === "true")?.dataset.paPick || "",
        overflow: btns.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent.trim()),
      };
    })())`));
    check("3-step AI sheet uses ds-modes switcher with sliding highlight and zero button clip",
      aiModes.hasModes && aiModes.dsN === "3" && aiModes.dsI === "1" && aiModes.hlMoved && aiModes.pressed === "code" && aiModes.overflow.length === 0,
      JSON.stringify(aiModes));
    const codeText = await p.eval(`document.querySelector(".pa-step1").innerText`);
    const askText = await p.eval(`document.querySelector(".pa-ask-pre").innerText`);
    const fonts = JSON.parse(await p.eval(`JSON.stringify({
      ask: getComputedStyle(document.querySelector(".pa-ask-pre")).fontFamily,
      cmd: getComputedStyle(document.querySelector(".pa-step1 .pa-code-pre code")).fontFamily,
    })`));
    const footBtn = await p.eval(`document.querySelector("[data-pa-connected]").textContent.trim()`);
    const aiHead = JSON.parse(await p.eval(`JSON.stringify((() => {
      const t = document.querySelector(".sh-root[data-open='1'] .sh-title");
      const x = document.querySelector(".sh-root[data-open='1'] .sh-x");
      const c = document.querySelector(".sh-root[data-open='1'] [data-pa-connected]");
      const tr = t?.getBoundingClientRect();
      const xr = x?.getBoundingClientRect();
      return {
        title: t?.textContent?.trim() || "",
        titleW: tr ? Math.round(tr.width) : 0,
        titleRight: tr ? Math.round(tr.right) : 999,
        xLeft: xr ? Math.round(xr.left) : 0,
        xRight: xr ? Math.round(xr.right) : 999,
        inBody: !!c?.closest(".sh-body") && !c?.closest(".sh-head"),
      };
    })())`));
    check("3-step AI sheet toggles Claude Code command with live origin and personalized ask in body font",
      codeText.includes(`${origin}/mcp`) && /claude mcp add --transport http wegoplace/.test(codeText)
        && /Autumn in Porto/.test(askText) && footBtn === "I've connected it" && fonts.ask !== fonts.cmd,
      JSON.stringify({ codeText, askText, footBtn, fonts }));
    check("3-step AI sheet keeps title and close button clear in .sh-head with CTA inside .sh-body",
      aiHead.title === "Plan it with your AI" && aiHead.titleW >= 80 && aiHead.xRight <= 390 && aiHead.titleRight <= aiHead.xLeft + 1 && aiHead.inBody,
      JSON.stringify(aiHead));
    await p.click("[data-pa-connected]");
    await sleep(300);
  }
  await p.close();

  // 2. Empty trip: guest
  section("2. Empty trip: guest");
  const pg = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
  await attachPlant(pg);
  await pg.goto(`${origin}/join/${linkCode}`);
  await pg.until(`!document.getElementById("page").hasAttribute("data-wait") && !document.getElementById("as-visitor").hidden`, "join page", 15000);
  await pg.type("#guest-name", guestUser.name);
  await pg.click("#btn-guest");
  await pg.until(`location.pathname === "/t/${emptyTrip}/"`, "joined trip", 20000);
  await pg.until(`document.querySelector("#view .ag-empty-ai") ? 1 : 0`, "guest empty Itinerary", 15000);
  await sleep(300);
  const gEmpty = JSON.parse(await pg.eval(`JSON.stringify({ aiBtn: !!document.querySelector("[data-plan-ai]"), line: document.querySelector(".ag-empty-ai").textContent.trim() })`));
  check("guest never sees Plan it with your AI and sees GUEST_AI_LINE",
    !gEmpty.aiBtn && /Anyone on the trip with an account can connect an AI app/.test(gEmpty.line), JSON.stringify(gEmpty));
  await pg.close();

  // 3. Populated trip: list, free-time sheet, plan detail page (Void & Light across 390/768/1440)
  section("3. Populated Itinerary, Free time sheet, and Plan detail page");
  const fullTrip = (await host.post("/api/trips", {
    name: "Lisbon week", default_tz: "Europe/Lisbon", starts_on: dayOff(-1), ends_on: dayOff(2),
  })).json.trip.id;
  await host.call("PUT", `/api/trips/${fullTrip}/places`, { places: [
    { id: "time-out", name: "Time Out Market", name_local: "Mercado da Ribeira", kind: "food", subkind: "market", address: "Av. 24 de Julho 49", lat: 38.707, lng: -9.146 },
  ] });
  const ts = (d, h, m) => Math.floor(Date.parse(`${dayOff(d)}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`) / 1000);
  const lunchDetail = Array.from({ length: 14 }, (_, i) =>
    `Meet at the south entrance stall ${i + 1} for fresh pastries, seafood counters, and shared tables before the afternoon walk.`
  ).join("\n\n");
  await host.post(`/api/trips/${fullTrip}/events`, { id: "ev-stay", title: "Alfama Flat", kind: "lodging", starts_at: ts(-1, 15, 0), ends_at: ts(2, 11, 0), tz: "Europe/Lisbon" });
  await host.post(`/api/trips/${fullTrip}/events`, { id: "ev-morning", title: "Morning coffee", kind: "meal", starts_at: ts(0, 9, 0), ends_at: ts(0, 10, 0), tz: "Europe/Lisbon", place_id: "time-out" });
  await host.post(`/api/trips/${fullTrip}/events`, { id: "ev-lunch", title: "Market lunch", kind: "meal", starts_at: ts(0, 13, 0), ends_at: ts(0, 14, 30), tz: "Europe/Lisbon", place_id: "time-out", detail: lunchDetail });
  await host.post(`/api/trips/${fullTrip}/events`, { id: "ev-afternoon", title: "Tram 28 to Graca", kind: "transit", starts_at: ts(0, 16, 0), ends_at: ts(0, 17, 30), tz: "Europe/Lisbon" });
  await host.post(`/api/trips/${fullTrip}/events`, { id: "ev-dinner", title: "Dinner in Bairro Alto", kind: "meal", starts_at: ts(0, 20, 0), ends_at: ts(0, 21, 30), tz: "Europe/Lisbon", place_id: "time-out" });
  await host.post(`/api/trips/${fullTrip}/events`, { id: "ev-tz-flight", title: "Redeye across zones", kind: "flight", starts_at: ts(0, 23, 40), ends_at: ts(1, 8, 10), tz: "America/Bogota", place_id: "time-out" });
  await host.post(`/api/trips/${fullTrip}/events`, { id: "ev-sintra", title: "Sintra palaces", kind: "activity", starts_at: ts(1, 9, 30), ends_at: ts(1, 13, 0), tz: "Europe/Lisbon" });
  await host.post(`/api/trips/${fullTrip}/events`, { id: "ev-plain", title: "Pack for checkout", kind: "plan", starts_at: ts(1, 15, 0), ends_at: ts(1, 16, 0), tz: "Europe/Lisbon" });
  await host.post(`/api/trips/${fullTrip}/events`, { id: "ev-belem", title: "Pasteis de Belem", kind: "meal", starts_at: ts(2, 10, 0), ends_at: ts(2, 11, 30), tz: "Europe/Lisbon" });

  const p2 = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
  await attachPlant(p2);
  await p2.setCookie(origin, "wgp_session", host.jar.cookies.get("wgp_session"));
  await p2.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(host.user.id), sameSite: "Lax" });
  await p2.scheme("dark");
  await p2.goto(`${origin}/t/${fullTrip}/#/`);
  await p2.until(`document.querySelector("#view .ag-day[data-today='1']") && document.querySelector("#view .ag-gaplink") ? 1 : 0`, "populated Itinerary", 20000);
  await sleep(500);

  const listState = JSON.parse(await p2.eval(`JSON.stringify((() => {
    const h = document.querySelector("#view .ds-head.ag-tripname");
    const todayHead = document.querySelector("#view .ag-day[data-today='1'] .ag-dayhead");
    const pastHead = document.querySelector("#view .ag-day[data-past='1']");
    const planRows = [...document.querySelectorAll("#view .ag-slot, #view .ag-staywrap:has(> .ag-stay:not(.ag-pk))")];
    const allHaveTone = planRows.length >= 7 && planRows.every((n) => /--ds-k:\\s*var\\(--(?:plan|cat)-[a-z]+\\)/.test(n.getAttribute("style") || ""));
    const tokenOf = (sel) => {
      const s = document.querySelector(sel)?.getAttribute("style") || "";
      const m = /--ds-k:\\s*var\\((--(?:plan|cat)-[a-z]+)\\)/.exec(s);
      return m ? m[1] : null;
    };
    const tokens = {
      lunch: tokenOf('#view li.ag-slot[data-k="c:ev-lunch"]'),
      afternoon: tokenOf('#view li.ag-slot[data-k="c:ev-afternoon"]'),
      flight: tokenOf('#view li.ag-slot[data-k="c:ev-tz-flight"]'),
      sintra: tokenOf('#view li.ag-slot[data-k="c:ev-sintra"]'),
      belem: tokenOf('#view li.ag-slot[data-k="c:ev-belem"]'),
      stay: tokenOf('#view .ag-staywrap[data-k="s:ev-stay"]'),
      plain: tokenOf('#view li.ag-slot[data-k="c:ev-plain"]'),
    };
    const dsEl = document.querySelector("#view .ds") || document.querySelector("#view");
    const dsK = (sel) => {
      const n = document.querySelector(sel);
      return n ? getComputedStyle(n).getPropertyValue("--ds-k").trim() : "";
    };
    const plainColor = dsK('#view li.ag-slot[data-k="c:ev-plain"]');
    const planTokColor = dsEl ? getComputedStyle(dsEl).getPropertyValue("--plan-plan").trim() : "";
    const transitColor = dsK('#view li.ag-slot[data-k="c:ev-afternoon"]');
    const activityColor = dsK('#view li.ag-slot[data-k="c:ev-sintra"]');
    const canvas = getComputedStyle(document.body).backgroundColor;
    const stays = [...document.querySelectorAll("#view .ag-stay:not(.ag-pk)")].map((s) => {
      const b = s.querySelector(".ag-stay-body")?.getBoundingClientRect();
      const k = (s.querySelector(".ag-stay-kind") || s.querySelector(".ag-stay-shot"))?.getBoundingClientRect();
      return { ok: !!b && !!k && k.left >= b.right - 1, bRight: b ? Math.round(b.right) : 0, kLeft: k ? Math.round(k.left) : 0 };
    });
    return {
      hasDsHead: !!h,
      todayText: todayHead ? todayHead.innerText.replace(/\\s+/g, " ").trim() : "",
      hasPast: !!pastHead,
      allHaveTone,
      tokens,
      plainColor,
      planTokColor,
      transitColor,
      activityColor,
      canvas,
      headMoreInEnd: !!document.querySelector("#view .ds-head-end .head-more"),
      stays,
    };
  })())`));
  check("Itinerary uses .ds-head, Today prefix, past day state, stay kind mark at right, kind tokens on plan rows (neutral on plain plan), Void black ground",
    listState.hasDsHead && /^Today, /.test(listState.todayText) && /Day \d+ of \d+/.test(listState.todayText) && listState.hasPast
      && listState.stays.length >= 1 && listState.stays.every((s) => s.ok)
      && listState.allHaveTone
      && listState.tokens.lunch === "--cat-food"
      && listState.tokens.afternoon === "--plan-transit"
      && listState.tokens.flight === "--plan-flight"
      && listState.tokens.sintra === "--plan-activity"
      && listState.tokens.belem === "--plan-meal"
      && listState.tokens.stay === "--plan-lodging"
      && listState.tokens.plain === "--plan-plan"
      && !!listState.plainColor && listState.plainColor === listState.planTokColor
      && listState.plainColor !== listState.transitColor && listState.plainColor !== listState.activityColor
      && listState.canvas === "rgb(0, 0, 0)" && listState.headMoreInEnd,
    JSON.stringify(listState));
  const whenClear = JSON.parse(await p2.eval(`JSON.stringify((() => {
    const bad = [];
    for (const card of document.querySelectorAll("#view .ag-card")) {
      const w = card.querySelector(".ag-when")?.getBoundingClientRect();
      const b = card.querySelector(".ag-cardbody")?.getBoundingClientRect();
      if (w && b && w.right > b.left + 1) bad.push({ id: card.getAttribute("href"), whenRight: Math.round(w.right), bodyLeft: Math.round(b.left) });
    }
    return { count: document.querySelectorAll("#view .ag-card").length, tzCount: document.querySelectorAll("#view .ag-tz").length, bad };
  })())`));
  check("390 cards keep cross-timezone .ag-when column clear of .ag-cardbody",
    whenClear.count >= 6 && whenClear.tzCount >= 2 && whenClear.bad.length === 0, JSON.stringify(whenClear));

  // Tap gap -> Free time sheet -> Add a plan here pre-fills starts/ends
  await p2.click("#view .ag-gaplink");
  await p2.until(`document.querySelector(".sh-root[data-open='1'] .ag-gapsheet") ? 1 : 0`, "Free time bottom sheet", 10000);
  await sleep(350);
  const gapSheet = JSON.parse(await p2.eval(`JSON.stringify({
    add: (document.querySelector(".ag-gapsheet [data-gap-add]") || {}).textContent?.trim(),
    chat: (document.querySelector('.ag-gapsheet [data-plan-chat="before"]') || {}).textContent?.trim(),
  })`));
  check("Tapping free time opens Free time sheet with Add a plan here and Chat about this time",
    gapSheet.add === "Add a plan here" && /Chat about this/.test(gapSheet.chat || ""), JSON.stringify(gapSheet));
  await p2.click(".ag-gapsheet [data-gap-add]");
  await p2.until(`document.querySelector("#pe-title") ? 1 : 0`, "Add a plan from gap", 10000);
  await sleep(300);
  const prefilled = JSON.parse(await p2.eval(`JSON.stringify({ start: document.querySelector("#pe-time").value, end: document.querySelector("#pe-end").value })`));
  const peHead = JSON.parse(await p2.eval(`JSON.stringify((() => {
    const t = document.querySelector(".sh-root[data-open='1'] .sh-title");
    const s = document.querySelector(".sh-root[data-open='1'] .pe-foot [data-act='save']");
    const tr = t?.getBoundingClientRect();
    const sr = s?.getBoundingClientRect();
    return {
      title: t?.textContent?.trim() || "",
      titleW: tr ? Math.round(tr.width) : 0,
      titleRight: tr ? Math.round(tr.right) : 999,
      saveLeft: sr ? Math.round(sr.left) : 0,
      saveRight: sr ? Math.round(sr.right) : 999,
    };
  })())`));
  check("Add a plan here pre-fills the gap start/end times", prefilled.start === "10:00" && prefilled.end === "13:00", JSON.stringify(prefilled));
  check("Add a plan sheet keeps title visible and compact Save/Add pill clear inside 390px .sh-head",
    peHead.title === "Add a plan" && peHead.titleW >= 60 && peHead.saveRight <= 390 && peHead.titleRight <= peHead.saveLeft + 1,
    JSON.stringify(peHead));
  const peAddState = JSON.parse(await p2.eval(`JSON.stringify((() => {
    const root = document.querySelector(".sh-root[data-open='1']");
    const save = root.querySelector('.pe-foot [data-act="save"]');
    const kinds = root.querySelector(".pe-kinds");
    const moreBtn = root.querySelector('[data-act="toggle-more"]');
    const more = root.querySelector("#pe-more");
    return {
      tall: root.dataset.tall === "1",
      saveDisabled: !!save?.disabled,
      saveOpacity: save ? getComputedStyle(save).opacity : "",
      kindsWrap: kinds ? getComputedStyle(kinds).flexWrap : "",
      kindsCut: kinds ? kinds.scrollWidth > kinds.clientWidth + 1 : true,
      moreExpanded: moreBtn?.getAttribute("aria-expanded") || "",
      moreHidden: !!more?.hidden,
    };
  })())`));
  check("Add a plan opens compact (not tall) with wrapped kinds, collapsed More details, and disabled recolored Add",
    !peAddState.tall && peAddState.saveDisabled && peAddState.saveOpacity === "1"
      && peAddState.kindsWrap === "wrap" && !peAddState.kindsCut
      && peAddState.moreExpanded === "false" && peAddState.moreHidden,
    JSON.stringify(peAddState));
  await p2.click('.pe [data-act="toggle-more"]');
  await p2.eval(`(() => { const i = document.querySelector("#pe-title"); i.value = "Harbor walk"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  const peAfter = JSON.parse(await p2.eval(`JSON.stringify({
    moreExpanded: document.querySelector('.pe [data-act="toggle-more"]')?.getAttribute("aria-expanded") || "",
    moreHidden: !!document.querySelector("#pe-more")?.hidden,
    saveDisabled: !!document.querySelector('.pe-foot [data-act="save"]')?.disabled,
  })`));
  check("Toggling More details reveals optional plan fields and typing title enables Add",
    peAfter.moreExpanded === "true" && !peAfter.moreHidden && !peAfter.saveDisabled, JSON.stringify(peAfter));
  await p2.eval(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
  await sleep(400);

  // Plan detail page: shell's floating #backbtn (44px, visible & working), top row kind + date, white Open in Maps
  await p2.click('a.ag-card[href="#/e/ev-lunch"]');
  await p2.until(`document.querySelector("#view .ag-detail") ? 1 : 0`, "plan page", 15000);
  await sleep(400);
  const detail = JSON.parse(await p2.eval(`JSON.stringify((() => {
    const topBack = document.querySelector("#view [data-plan-back]");
    const dockBack = document.getElementById("backbtn");
    const dr = dockBack ? dockBack.getBoundingClientRect() : null;
    const dockShown = !!dockBack && getComputedStyle(dockBack).display !== "none" && !dockBack.hidden && !!dr && dr.width >= 44 && dr.height >= 44;
    const kind = document.querySelector(".ag-d-kind");
    const date = document.querySelector(".ag-d-date");
    const kr = kind ? kind.getBoundingClientRect() : null;
    const dtr = date ? date.getBoundingClientRect() : null;
    const maps = document.querySelector(".ag-b-act-maps");
    const acts = [...document.querySelectorAll("#view .ag-detail > .ag-d-acts :is(.btn, .ds-button)")].map((b) => {
      const r = b.getBoundingClientRect();
      return { text: b.textContent.trim(), label: b.getAttribute("aria-label") || "", top: Math.round(r.top), right: Math.round(r.right) };
    });
    return {
      noTopBack: !topBack,
      dockShown,
      kindText: kind ? kind.textContent.trim() : "",
      kindTop: kr ? Math.round(kr.top) : 999,
      dateTop: dtr ? Math.round(dtr.top) : 999,
      change: (document.querySelector("[data-plan-change]") || {}).textContent?.trim(),
      acts,
      maps: maps ? maps.textContent.trim() : null,
      mapsWhite: !!maps && maps.classList.contains("ds-button--white"),
      local: (document.querySelector(".ag-b-local") || {}).textContent?.trim(),
      placeLink: (document.querySelector("a.ag-b-lead") || {}).getAttribute?.("href") || "",
      placeButtons: [...document.querySelectorAll(".ag-b-acts :is(a, button)")].map((b) => b.textContent.trim()),
      photoBelow: (() => { const ph = document.querySelector("#view #photo"), said = document.querySelector("#view .ag-notes, #view [data-said]"); return !!ph && !!said && ph.getBoundingClientRect().top > said.getBoundingClientRect().top; })(),
    };
  })())`));
  const actTops = detail.acts.map((a) => a.top);
  check("Plan page keeps shell's 44px #backbtn, kind/date top row, two things to do side by side (Change, Chat about this), white Open in Maps as the place's one button, its name opening its details, the photo's buttons further down, and the local name",
    detail.noTopBack && detail.dockShown && detail.kindTop < 140 && detail.dateTop < 140 && detail.change === "Change"
      && detail.acts.length === 2 && Math.max(...actTops) - Math.min(...actTops) <= 2
      && detail.acts.every((a) => a.right <= 390)
      && detail.acts.map((a) => a.text).join("|") === "Change|Chat about this"
      && detail.maps === "Open in Maps" && detail.mapsWhite && detail.placeButtons.join("|") === "Open in Maps" && /^#\/p\//.test(detail.placeLink)
      && detail.photoBelow && detail.local === "Mercado da Ribeira",
    JSON.stringify(detail));
  await p2.click("#backbtn");
  await p2.until(`document.querySelector("#view .ag-day") ? 1 : 0`, "back to Itinerary", 15000);
  check("Shell #backbtn returns to Itinerary", true);

  // 4. Offline pill clearance at the foot of Itinerary & Plan page (390 & 1440)
  section("4. Offline pill clearance at the foot of Itinerary & Plan page");
  const onlineErrors = [...p.errors, ...pg.errors, ...p2.errors];
  p2.errors.length = 0;
  await p2.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await p2.until(`document.body.dataset.netpill === "1" && !document.getElementById("netpill").hidden ? 1 : 0`, "offline pill", 20000);
  await sleep(300);

  await p2.eval(`(() => { const v = document.getElementById("view"); v.scrollTop = v.scrollHeight; return 1; })()`);
  await sleep(350);
  const offList = JSON.parse(await p2.eval(`JSON.stringify((() => {
    const last = [...document.querySelectorAll("#view .ag-card")].at(-1)?.getBoundingClientRect();
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
  check("390 offline Itinerary scrolled to end clears Offline pill, +, and tab bar by >= 8px",
    offList.lastBottom !== null && offList.pillTop !== null && offList.lastBottom <= offList.pillTop - 8 &&
    (offList.fabTop === null || offList.lastBottom <= offList.fabTop - 8) &&
    (offList.barTop === null || offList.lastBottom <= offList.barTop - 8),
    JSON.stringify(offList));

  await p2.eval(`(location.hash = "#/e/ev-lunch", 1)`);
  await p2.until(`document.querySelector("#view .ag-detail") ? 1 : 0`, "offline plan page", 15000);
  await sleep(350);
  await p2.eval(`(() => { const v = document.getElementById("view"); v.scrollTop = v.scrollHeight; return 1; })()`);
  await sleep(350);
  const offPlan = JSON.parse(await p2.eval(`JSON.stringify((() => {
    const kids = [...document.querySelectorAll("#view .ag-detail > *")].filter((el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.width > 0; });
    const last = kids.at(-1)?.getBoundingClientRect();
    const pill = document.getElementById("netpill")?.getBoundingClientRect();
    const back = document.getElementById("backbtn")?.getBoundingClientRect();
    return {
      lastBottom: last ? Math.round(last.bottom) : null,
      pillTop: pill ? Math.round(pill.top) : null,
      backTop: back ? Math.round(back.top) : null,
    };
  })())`));
  check("390 offline Plan page scrolled to end clears Offline pill and Back by >= 8px",
    offPlan.lastBottom !== null && offPlan.pillTop !== null && offPlan.backTop !== null &&
    offPlan.lastBottom <= offPlan.pillTop - 8 && offPlan.lastBottom <= offPlan.backTop - 8,
    JSON.stringify(offPlan));

  await p2.size({ width: 1440, height: 900, mobile: false });
  await p2.until(`document.querySelector('#view[data-two="1"] .rt-pane-b .ag-detail') ? 1 : 0`, "1440 two-pane offline plan", 15000);
  await sleep(350);
  await p2.eval(`(() => { const b = document.querySelector("#view .rt-pane-b"); b.scrollTop = b.scrollHeight; return 1; })()`);
  await sleep(350);
  const offPane = JSON.parse(await p2.eval(`JSON.stringify((() => {
    const b = document.querySelector("#view .rt-pane-b");
    const kids = [...b.querySelectorAll(".ag-detail > *")].filter((el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.width > 0; });
    const last = kids.at(-1)?.getBoundingClientRect();
    const pill = document.getElementById("netpill")?.getBoundingClientRect();
    return {
      padBottom: Math.round(parseFloat(getComputedStyle(b).paddingBottom) || 0),
      lastBottom: last ? Math.round(last.bottom) : null,
      pillTop: pill ? Math.round(pill.top) : null,
      vh: innerHeight,
    };
  })())`));
  check("1440 two-pane offline Plan page clears Offline pill by >= 8px",
    offPane.lastBottom !== null && offPane.pillTop !== null &&
    offPane.padBottom >= offPane.vh - offPane.pillTop + 8 && offPane.lastBottom <= offPane.pillTop - 8,
    JSON.stringify(offPane));
  const twoPaneMaps = JSON.parse(await p2.eval(`JSON.stringify((() => {
    const add = document.querySelector("#view .ag-headadd");
    const maps = document.querySelector("#view .rt-pane-b .ag-b-act-maps");
    const details = document.querySelector("#view .rt-pane-b .ag-b-act:not(.ag-b-act-maps)");
    return {
      addBg: add ? getComputedStyle(add).backgroundColor : null,
      mapsBg: maps ? getComputedStyle(maps).backgroundColor : null,
      detailsBg: details ? getComputedStyle(details).backgroundColor : null,
      nameLink: (document.querySelector("#view .rt-pane-b a.ag-b-lead") || {}).getAttribute?.("href") || null,
    };
  })())`));
  check("1440 two-pane demotes Open in Maps to gray beside white + Add a plan; it is the place's one button, its name the way to its details",
    !!twoPaneMaps.mapsBg && !!twoPaneMaps.addBg && twoPaneMaps.mapsBg !== twoPaneMaps.addBg && twoPaneMaps.detailsBg === null && /^#\/p\//.test(twoPaneMaps.nameLink || ""),
    JSON.stringify(twoPaneMaps));

  await p2.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const offlineErrors = p2.errors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR_/.test(e));
  await p2.close();

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
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);
