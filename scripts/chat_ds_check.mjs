#!/usr/bin/env node
/* Flow 6 (Chat, Assistant room, Changes) on the design system (public/css/chat.css,
 * public/js/chat.js, assistant.js, assistant-room.js, changes.js), checked statically
 * and in real Chrome across 390, 768, 1440 in dark (Void) and light (Paper).
 *
 *   node scripts/chat_ds_check.mjs --static
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> \
 *     --label "wegoplace chat_ds_check.mjs" -- node scripts/chat_ds_check.mjs
 *
 * PLANTS (CHAT_PLANT=<name>):
 *   rawcolor   injects a raw hex color into chat.css (static fails)
 *   offscale   injects a literal px font-size into CHG_CSS (static fails)
 *   legacytok  injects a legacy var(--accent) into chat.css (static fails)
 *   faint      injects var(--ink-3) readable text color into chat.css (static fails)
 *   hideback   hides the shell's #backbtn from CHG_CSS on #/changes (browser fails)
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const STATIC_ONLY = process.argv.includes("--static");
const PLANT = process.env.CHAT_PLANT || "";
const PLANTS = new Set(["rawcolor", "offscale", "legacytok", "faint", "hideback"]);
if (PLANT && !PLANTS.has(PLANT)) throw new Error(`no such CHAT_PLANT: ${PLANT}`);

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

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// ── Static Design System Audit ───────────────────────────────────────────────────────────────
section("0. Flow 6 design system token, contrast, and type-scale audit");
let chatCss = read("public/css/chat.css");
let chgSrc = read("public/js/changes.js");
const chatSrc = read("public/js/chat.js");
const asSrc = read("public/js/assistant.js");
const roomSrc = read("public/js/assistant-room.js");
const stSrc = read("public/styles.css");

if (PLANT === "rawcolor") chatCss += "\n.ch-plant-raw { color: #ff00ff; }\n";
if (PLANT === "legacytok") chatCss += "\n.ch-plant-legacy { color: var(--accent); }\n";
if (PLANT === "faint") chatCss += "\n.ch-plant-faint { color: var(--ink-3); }\n";
if (PLANT === "offscale") chgSrc = chgSrc.replace("const CHG_CSS = `\n", "const CHG_CSS = `\n.chg-plant-px { font-size: 13px; }\n");

const chgCss = extractConst(chgSrc, "CHG_CSS");
const LEGACY_RE = /var\(--(?:accent|accent-ink|accent-soft|surface|surface-2|ground|ink|line|line-strong|warn|warn-soft|ok|ok-soft|shadow|press|tap|font-display|tint|nc|r-(?:sm|md|lg)|sp-[0-9]+|kind-[a-z-]+|cat-[a-z-]+)(?![-\w])/g;

for (const [label, rawCss] of [["public/css/chat.css", chatCss], ["changes.js CHG_CSS", chgCss]]) {
  const clean = stripComments(rawCss);
  check(`${label} CSS present`, clean.length > 200);

  const nonMask = clean
    .replace(/-webkit-mask-image\s*:[^;}{]+;/g, "")
    .replace(/mask-image\s*:[^;}{]+;/g, "");
  const rawHex = nonMask.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const rawFn = nonMask.match(/\b(?:rgba?|hsla?)\(/g) || [];
  check(`${label}: zero raw hex/rgb/hsl colors`, rawHex.length === 0 && rawFn.length === 0, [...rawHex, ...rawFn].join(", "));

  const legacy = clean.match(LEGACY_RE) || [];
  check(`${label}: zero legacy or undefined tokens`, legacy.length === 0, legacy.join(", "));

  const badSizes = [...clean.matchAll(/font-size\s*:\s*([^;}{]+)/g)]
    .map((m) => m[1].trim())
    .filter((v) => !/^var\(--size-(?:12|14|16|20|28|number)\)$/.test(v));
  check(`${label}: every font-size uses strict --size-* tokens`, badSizes.length === 0, badSizes.join(", "));

  // Verify --ink-3 and --ink-4 never color readable text (only ::placeholder, [disabled]/:disabled, or text-decoration-color).
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

check("styles.css removes .ch-head offset & 52px room entry while keeping :not(:has(.head-more[data-away]))",
  !/body:has\(#view \.ch-head\)/.test(stSrc)
  && !/:is\([^)]*\.ch-head/.test(stSrc)
  && /body:not\(\[data-back="1"\]\):not\(:has\(\.head-more\[data-away\]\)\)/.test(stSrc));

check("chat.js uses DS root, .ds-head/.ds-head-end, .ch-newline, .ds-face, zero --nc, and keeps .ch-bell-t",
  /root\.className\s*=\s*"ch ds"/.test(chatSrc)
  && /ch-head ds-head/.test(chatSrc)
  && /ds-head-end/.test(chatSrc)
  && /ch-newline/.test(chatSrc)
  && /ch-sq ds-face/.test(chatSrc)
  && !/--nc\b/.test(chatSrc)
  && /ch-bell-t/.test(chatSrc));

check("assistant.js & assistant-room.js use DS root, .ch-tabs-pill, and .as-room-ico",
  /`ch as ds/.test(asSrc)
  && /ch-tabs-pill/.test(roomSrc)
  && /as-room-ico/.test(asSrc)
  && /root\.querySelector\("\.head-more"\)/.test(asSrc));

check("changes.js uses .chg.ds, day grouping, data-undone strike-through, and keeps .chg-head clip-path",
  /class="chg ds"/.test(chgSrc)
  && /chg-day/.test(chgSrc)
  && /data-undone/.test(chgSrc)
  && /clip-path:\s*inset\(-6px -6px -6px 14px\)/.test(chgCss));

if (STATIC_ONLY) {
  console.log(`\n${pass} passed, ${fail} failed (static only)`);
  if (fail) console.log(`failed:\n  ${failures.join("\n  ")}`);
  process.exit(fail ? 1 : 0);
}

// ── Browser checks ───────────────────────────────────────────────────────────────────────────
const { startServer } = await import("../checks/lib/server.mjs");
const { Person } = await import("../checks/lib/person.mjs");
const { openChrome } = await import("../checks/lib/chrome.mjs");
const { McpClient, connect } = await import("../checks/lib/mcp.mjs");
const { freeLoopbackPort, ownServer } = await import("./lib/browser.mjs");

const plantedChanges = () => (PLANT === "hideback"
  ? chgSrc.replace("const CHG_CSS = `\n", "const CHG_CSS = `\nbody:has(#view .chg) #backbtn { display: none; }\n")
  : chgSrc);

const server = await startServer({ name: "chat-ds", port: await freeLoopbackPort() });
ownServer(server.origin);
let chrome = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await server.start();
  const { origin } = server;
  const ada = new Person(origin, "Ada Reyes");
  const ben = new Person(origin, "Ben Okafor");
  await ada.signUp();
  await ben.signUp();

  const trip = (await ada.post("/api/trips", {
    name: "Coast week", default_tz: "UTC", starts_on: "2027-05-01", ends_on: "2027-05-05",
  })).json.trip.id;
  const link = (await ada.post(`/api/trips/${trip}/links`, { uses: 1 })).json.link.code;
  await ben.post(`/api/join/${link}`);

  await ada.post(`/api/trips/${trip}/events`, {
    id: "boat", kind: "transit", title: "Harbour ferry", starts_at: Date.UTC(2027, 4, 2, 10, 0) / 1000, tz: "UTC",
  });
  await ben.post(`/api/trips/${trip}/messages`, { id: "m-1", body: "Tickets are booked.", about: { kind: "event", id: "boat" } });
  await ben.post(`/api/trips/${trip}/messages`, { id: "m-2", body: "Meet at pier two." });
  await ada.post(`/api/trips/${trip}/messages`, { id: "m-3", body: "On my way." });

  const c = await connect(origin, ada, { name: "Claude", address: ada.address });
  const mcp = new McpClient(origin, c.tokens.json.access_token);
  await mcp.initialize();
  await mcp.call("put_places", {
    trip_id: trip,
    summary: "Added Old Town bakery",
    places: [{ id: "bakery", name: "Old Town bakery", kind: "food", subkind: "bakery", why: "Morning pastel de nata" }],
  });

  chrome = await openChrome();
  const page = await chrome.page({ width: 390, height: 844, mobile: true });
  await page.setCookie(origin, "wgp_session", ada.jar.cookies.get("wgp_session"));
  await page.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(ada.user.id), sameSite: "Lax" });

  if (PLANT === "hideback") {
    page.wire.listeners.add((m) => {
      if (m.sessionId !== page.session || m.method !== "Fetch.requestPaused") return;
      const u = new URL(m.params.request.url);
      if (u.pathname === "/js/changes.js") {
        page.send("Fetch.fulfillRequest", {
          requestId: m.params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/javascript" }],
          body: Buffer.from(plantedChanges()).toString("base64"),
        }).catch(() => {});
        return;
      }
      page.send("Fetch.continueRequest", { requestId: m.params.requestId }).catch(() => {});
    });
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "*changes.js*" }] });
  }

  for (const theme of ["dark", "light"]) {
    section(`1. Flow 6 browser audit (${theme})`);
    await page.scheme(theme);
    for (const [label, size] of [
      ["390", { width: 390, height: 844, mobile: true }],
      ["768", { width: 768, height: 1024, mobile: false }],
      ["1440", { width: 1440, height: 900, mobile: false }],
    ]) {
      await page.size(size);
      // Pre-seed unread seq = 1 on first pass so New divider appears above Ben's second message if seq=1 < seq=2.
      if (theme === "dark" && label === "390") {
        await page.open(`${origin}/t/${trip}/#/`);
        await page.eval(`localStorage.setItem("wgp.chat.read:${trip}:${ada.user.id}", "1"), true`);
      }
      await page.open(`${origin}/t/${trip}/#/chat`);
      await page.until("document.querySelectorAll('#view .ch-msg').length >= 3 && document.querySelector('#ch-input')", "chat loaded", 20000);
      // Measured once the screen has come to rest, not a fixed 300 ms in: on a busy machine that is mid slide-in, and
      // #view's edge reads as overflow (21 Nov, the changes screen's twin of this wait).
      await page.until("document.getAnimations().every((a) => a.playState !== 'running' || (a.effect && a.effect.getTiming().iterations === Infinity))", "the chat screen at rest", 10000);

      const emptySendBg = await page.eval(`(() => {
        const send = document.querySelector('.ch-send');
        const emptyBg = getComputedStyle(send).backgroundColor;
        const inp = document.querySelector('#ch-input');
        inp.value = 'See you there';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return emptyBg;
      })()`);
      // The send button's fill comes on by a transition: read once it has changed (at most 2 s), not at a fixed 250 ms.
      // On a busy machine's headless frames (8 to 11 a second, 22 Nov) it was still the empty one then, at a different
      // size each run, on rework's own tip too. A fill that never comes is still red: the read below says so.
      await page.until(`getComputedStyle(document.querySelector('.ch-send')).backgroundColor !== ${JSON.stringify(emptySendBg)}`, "the send button's fill", 2000).catch(() => {});
      const ch = JSON.parse(await page.eval(`JSON.stringify((() => {
        const b = document.querySelector('.ch-msg .ch-bubble');
        const bcs = getComputedStyle(b);
        const sq = document.querySelector('.ch-msg:not(.ch-mine) .ch-sq');
        const bell = document.querySelector('.ch-bell');
        const br = bell?.getBoundingClientRect();
        const send = document.querySelector('.ch-send');
        const hasBg = getComputedStyle(send).backgroundColor;
        const inp = document.querySelector('#ch-input');
        const sendDisabledAfterText = send?.disabled;
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return {
          rootDs: document.querySelector('#view .ch')?.classList.contains('ds'),
          bubbleBg: bcs.backgroundColor,
          bubbleBorder: bcs.borderTopWidth,
          bellText: bell?.textContent.trim(),
          bellW: br ? Math.round(br.width) : 0,
          bellH: br ? Math.round(br.height) : 0,
          bellRadius: bell ? parseFloat(getComputedStyle(bell).borderRadius) : 0,
          bellAria: bell?.getAttribute('aria-label') || '',
          sqRadius: getComputedStyle(sq).borderRadius,
          sqStyle: sq?.getAttribute('style'),
          sendDisabledAfterText,
          sendDisabled: send?.disabled,
          sendBgDiff: ${JSON.stringify("")} !== hasBg && ${JSON.stringify(emptySendBg)} !== hasBg && !sendDisabledAfterText,
          newline: !!document.querySelector('#view .ch-newline'),
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      })())`));
      check(`${theme} ${label} chat: DS lines not bubbles`, ch.rootDs && ch.bubbleBg === "rgba(0, 0, 0, 0)" && ch.bubbleBorder === "0px", JSON.stringify(ch));
      check(`${theme} ${label} chat: filled person-token circle face & zero --nc style`,
        !/--nc\b/.test(ch.sqStyle || "") && /--ds-person:var\(--person-/.test(ch.sqStyle || "") && parseFloat(ch.sqRadius) >= 16,
        `${ch.sqRadius} | ${ch.sqStyle}`);
      check(`${theme} ${label} chat: round 44px gray bell icon & send turns solid on text`,
        ["Notify", "On", "Muted"].includes(ch.bellText) && ch.bellW === 44 && ch.bellH === 44 && ch.bellRadius >= 22 && /^Notifications:/.test(ch.bellAria) && ch.sendBgDiff && !ch.overflow,
        JSON.stringify(ch));
      if (theme === "dark" && label === "390") {
        check(`${theme} ${label} chat: "New" divider drawn above unread message`, ch.newline);
      }

      await page.open(`${origin}/t/${trip}/#/changes`);
      await page.until("document.querySelectorAll('#view .chg-line').length >= 1", "changes loaded", 20000);
      // Measured at rest: the screen slides in, and a fixed 300 ms could catch #view still off to the right (21 Nov: its
      // right edge at 2632 px in a 1440 px window read as overflow).
      // A looping animation (a live dot) never ends, so only finite ones are waited for.
      await page.until("document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)", "the changes screen at rest", 10000);
      await sleep(100);

      const cg = JSON.parse(await page.eval(`JSON.stringify((() => {
        const line = document.querySelector('#view .chg-line');
        const lcs = getComputedStyle(line);
        const back = document.getElementById('backbtn');
        const bcs = back ? getComputedStyle(back) : null;
        return {
          rootDs: document.querySelector('#view .chg')?.classList.contains('ds'),
          dayCount: document.querySelectorAll('#view .chg-day').length,
          borderRadius: lcs.borderRadius,
          boxShadow: lcs.boxShadow,
          undoBtn: !!document.querySelector('#view .chg-line [data-act="undo"]'),
          backVisible: !!back && bcs.display !== 'none',
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      })())`));
      check(`${theme} ${label} changes: DS hairline list with day head and Undo`, cg.rootDs && cg.dayCount >= 1 && cg.borderRadius === "0px" && cg.boxShadow === "none" && cg.undoBtn && !cg.overflow, JSON.stringify(cg));
      if (label === "390") {
        check(`${theme} 390 changes: shell #backbtn stays visible`, cg.backVisible);
      }
    }
  }

  check("zero page errors", page.errors.length === 0, JSON.stringify(page.errors.slice(0, 3)));
} finally {
  await chrome?.close();
  await server?.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);
