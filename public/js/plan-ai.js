// plan-ai.js — the empty Itinerary's choice ("Plan it with your AI" vs "Add plans yourself"),
// the 3-step connect sheet, and the live AI-adding banner on the Itinerary.
//
// Reads its first ask and dateRange from shared/first-ask.js (shared with the MCP prompt) and
// polls /api/account/apps only while the connect sheet is open and the document is visible.

import { openSheet } from "./sheet.js";
import { esc } from "./util.js";
import { firstAsk, dateRange, PLAN_WORDS } from "./shared/first-ask.js";
import { fetchWithin } from "./net.js";
import { siteOrigin } from "./site.js";

const POLL_MS = 4000;

const APP_CHOICES = [
  { id: "claude", label: "Claude", i: 0 },
  { id: "code", label: "Claude Code", i: 1 },
  { id: "other", label: "Another AI", i: 2 },
];

async function copyText(text) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall back below */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * The empty Itinerary when the trip has neither plans nor places yet: a choice between connecting
 * your own AI and adding plans by hand.
 */
export function emptyWaysHTML(can, { trip = null, people = 0, invite = false } = {}) {
  const dates = trip ? dateRange(trip.starts_on, trip.ends_on) : "";
  const who = people <= 1 ? "Only you so far." : `${people} people.`;
  const sub = [dates, who].filter(Boolean).join(". ").replace(/\.\./g, ".");
  // The host's way to bring people in, right where the trip says who is on it (js/invite.js).
  return `<div class="pa-empty ds">` +
    (sub || invite ? `<div class="pa-who">${sub ? `<p class="pa-tripsub">${esc(sub)}</p>` : ""}` +
      (invite ? `<button type="button" class="ds-button ds-button--gray pa-invite" data-invite>Invite people</button>` : "") + `</div>` : "") +
    `<h2 class="ds-h2 pa-ask-h">How do you want to plan it?</h2>` +
    `<p class="ds-body pa-intro">Your own AI can build this trip with you: it looks things up, adds the plans and places here, and everyone on the trip sees them.</p>` +
    `<div class="pa-ways">` +
      (can
        ? `<button type="button" class="ds-button ds-button--white ds-button--lg ds-button--block" data-plan-ai>Plan it with your AI</button>` +
          `<button type="button" class="ds-button ds-button--gray ds-button--lg ds-button--block" data-plan-add>Add plans yourself</button>`
        : `<p class="ds-body pa-intro">Only members on this trip can add plans.</p>`) +
    `</div>` +
    `<p class="ag-empty-ai pa-fine">Works with Claude, Claude Code and any app that takes MCP servers, on the plan you already pay for. Nothing extra to buy here.</p>` +
  `</div>`;
}

let aiOpen = null;

let aiOpening = null;

/**
 * Open the 3-step connect sheet: THE one way to connect your own AI, wherever it is asked for (a trip's first screen
 * as "Plan it with your AI"; More's AI apps and Your account as "Connect your AI").
 * Options: { trip, place, people, onConnected, title }. With no trip (Your account) its first ask plans whichever trip
 * comes next. The address it gives is the site's own (site.js), never this page's: a page at www.wegoplace.com still
 * shows https://wegoplace.com/mcp, the one the server takes. It is asked here, not by the caller, so no way in can show
 * another; a phone that has never heard it shows this page's own. Resolves to { close, el } once the sheet is open.
 */
export function openPlanWithAiSheet(opts = {}) {
  if (aiOpen) return Promise.resolve(aiOpen);
  aiOpening ??= siteOrigin().catch(() => null).then((origin) => {
    aiOpening = null;
    return aiOpen ?? sheetAt(origin || location.origin, opts);
  });
  return aiOpening;
}

function sheetAt(origin, { trip = null, place = "", people = 0, onConnected = null, title = "Plan it with your AI" }) {
  injectPlanAiStyles();

  const mcpUrl = `${String(origin).replace(/\/$/, "")}/mcp`;
  const cmd = `claude mcp add --transport http wegoplace ${mcpUrl}`;
  const ask = !trip ? `In WeGoPlace, read my trips, then plan the next one: ${PLAN_WORDS}` : firstAsk({
    name: trip && trip.name,
    place,
    starts_on: trip && trip.starts_on,
    ends_on: trip && trip.ends_on,
    people,
  });

  const wrap = document.createElement("div");
  wrap.className = "pa-sheet ds";
  const foot = document.createElement("div");
  foot.className = "pa-foot ds";
  foot.innerHTML = `<button type="button" class="ds-button ds-button--white ds-button--lg ds-button--block" data-pa-connected>I've connected it</button>`;

  let picked = "claude";
  let apps = [];
  let timer = null;
  let closed = false;
  const copyTimers = new Map();

  function step1Content() {
    if (picked === "code") {
      return `<p class="pa-step-copy">Run this in a terminal. Then type <code>/mcp</code> in Claude Code and choose Authenticate.</p>` +
        `<div class="pa-code"><pre class="pa-code-pre"><code>${esc(cmd)}</code></pre>` +
        `<button type="button" class="ds-button ds-button--gray ds-button--sm pa-copy" data-pa-copy="cmd">Copy</button></div>`;
    }
    const lead = picked === "claude"
      ? `In Claude, open Customize, then Connectors; press + Add, then Add custom connector, and paste this address. Add it on the web or desktop and it works on your phone too.`
      : `Anything that takes MCP servers: give it this address.`;
    return `<p class="pa-step-copy">${lead}</p>` +
      `<div class="pa-code"><pre class="pa-code-pre"><code>${esc(mcpUrl)}</code></pre>` +
      `<button type="button" class="ds-button ds-button--gray ds-button--sm pa-copy" data-pa-copy="url">Copy</button></div>`;
  }

  wrap.innerHTML =
    `<div class="ds-modes pa-seg" role="group" aria-label="Where you chat" style="--ds-n: 3; --ds-i: 0">` +
      `<span class="ds-modes-hl" aria-hidden="true"></span>` +
      APP_CHOICES.map((c) =>
        `<button type="button" class="ds-mode pa-choice" data-pa-pick="${c.id}" data-i="${c.i}" aria-pressed="${c.id === picked}">${esc(c.label)}</button>`
      ).join("") +
    `</div>` +
    `<section class="pa-step pa-step--first">` +
      `<span class="pa-num" aria-hidden="true">1</span>` +
      `<div class="pa-step-body">` +
        `<h3 class="pa-step-h">Connect it</h3>` +
        `<div class="pa-step1">${step1Content()}</div>` +
      `</div>` +
    `</section>` +
    `<section class="pa-step">` +
      `<span class="pa-num" aria-hidden="true">2</span>` +
      `<div class="pa-step-body">` +
        `<h3 class="pa-step-h">Say yes when it asks</h3>` +
        `<p class="pa-step-copy">A WeGoPlace page shows what it may do: read your trips, and add and change things on them. It can't delete a trip or add or remove people.</p>` +
      `</div>` +
    `</section>` +
    `<section class="pa-step">` +
      `<span class="pa-num" aria-hidden="true">3</span>` +
      `<div class="pa-step-body">` +
        `<h3 class="pa-step-h">Tell it what you want</h3>` +
        `<p class="pa-step-copy">Start with this, then say what you like.</p>` +
        `<div class="pa-code pa-code--ask"><p class="pa-code-pre pa-ask-pre">${esc(ask)}</p>` +
        `<button type="button" class="ds-button ds-button--gray ds-button--sm pa-copy" data-pa-copy="ask">Copy</button></div>` +
      `</div>` +
    `</section>`;
  wrap.append(foot);

  function paintConn() {
    const btn = foot.querySelector("[data-pa-connected]");
    if (!btn) return;
    if (apps.length) {
      btn.textContent = "Connected";
      btn.dataset.connected = "1";
    } else {
      btn.textContent = "I've connected it";
      delete btn.dataset.connected;
    }
  }

  async function poll() {
    if (closed || document.hidden || !wrap.isConnected) return;
    try {
      const res = await fetchWithin("/api/account/apps", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok || closed || !wrap.isConnected) return;
      const body = await res.json().catch(() => null);
      if (body && Array.isArray(body.apps)) {
        apps = body.apps;
        paintConn();
      }
    } catch { /* ignore transient offline/network errors */ }
  }

  const onVis = () => { if (!document.hidden) poll(); };
  document.addEventListener("visibilitychange", onVis);

  const sheet = openSheet({
    title,
    contentEl: wrap,
    dragFrom: "handle",
    closeButton: true,
    onOpen: () => {
      poll();
      timer = setInterval(poll, POLL_MS);
    },
    onClose: () => {
      closed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      for (const id of copyTimers.values()) clearTimeout(id);
      copyTimers.clear();
      if (aiOpen === api) aiOpen = null;
    },
  });

  wrap.addEventListener("click", async (ev) => {
    const pick = ev.target.closest("[data-pa-pick]");
    if (pick) {
      picked = pick.dataset.paPick;
      const seg = wrap.querySelector(".pa-seg");
      if (seg) seg.style.setProperty("--ds-i", pick.dataset.i || "0");
      for (const b of wrap.querySelectorAll("[data-pa-pick]")) {
        b.setAttribute("aria-pressed", String(b.dataset.paPick === picked));
      }
      const step1 = wrap.querySelector(".pa-step1");
      if (step1) step1.innerHTML = step1Content();
      return;
    }
    const copy = ev.target.closest("[data-pa-copy]");
    if (copy) {
      const what = copy.dataset.paCopy;
      const val = what === "cmd" ? cmd : what === "ask" ? ask : mcpUrl;
      const ok = await copyText(val);
      if (!ok || closed) return;
      const prev = copy.dataset.paLabel || copy.textContent;
      copy.dataset.paLabel = prev;
      copy.textContent = "Copied";
      clearTimeout(copyTimers.get(copy));
      copyTimers.set(copy, setTimeout(() => {
        if (copy.isConnected) copy.textContent = prev;
        copyTimers.delete(copy);
      }, 1800));
    }
  });

  foot.addEventListener("click", (ev) => {
    if (!ev.target.closest("[data-pa-connected]")) return;
    sheet.close();
    if (typeof onConnected === "function") onConnected(apps.slice());
  });

  const api = { close: () => sheet.close(), el: sheet.el };
  aiOpen = api;
  return api;
}

let injected = false;
export function injectPlanAiStyles() {
  if (injected || document.getElementById("pa-styles")) { injected = true; return; }
  injected = true;
  const s = document.createElement("style");
  s.id = "pa-styles";
  s.textContent = PA_CSS;
  document.head.append(s);
}

const PA_CSS = `
.pa-empty {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 0 12px;
  text-align: left;
}
.pa-who { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 0 0 20px; }
.pa-who .pa-tripsub { margin: 0; }
.pa-tripsub {
  margin: 0 0 20px;
  color: var(--ink-2);
  font-size: var(--size-14);
  line-height: 1.45;
}
.pa-ask-h {
  margin: 0;
  color: var(--ink-1);
}
.pa-intro {
  margin: 0 0 14px;
  color: var(--ink-2);
}
.pa-ways {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pa-fine {
  margin: 10px 0 0;
  font-size: var(--size-14);
  line-height: 1.45;
  color: var(--ink-2);
}
.pa-fine a {
  color: var(--ink-1);
  text-decoration: underline;
  text-underline-offset: 3px;
  font-weight: 500;
}

.pa-sheet {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding-bottom: 8px;
}
.pa-foot.ds { width: 100%; }
.pa-seg {
  margin-bottom: 16px;
}
.pa-choice {
  padding: 0 6px;
}
.pa-step {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  column-gap: 12px;
  padding: 14px 0;
  border-top: 1px solid var(--hair);
}
.pa-step--first {
  border-top: 0;
  padding-top: 0;
}
.pa-num {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-full);
  background: var(--gray-3);
  color: var(--ink-2);
  font-family: var(--type-mono);
  font-size: var(--size-12);
  line-height: 24px;
  font-weight: 600;
  text-align: center;
}
.pa-step-body {
  min-width: 0;
}
.pa-step-h {
  margin: 0;
  font-family: var(--type-ui);
  font-weight: 600;
  font-size: var(--size-16);
  line-height: 24px;
  color: var(--ink-1);
}
.pa-step-copy {
  margin: 2px 0 0;
  font-size: var(--size-14);
  line-height: 1.45;
  color: var(--ink-2);
}
.pa-step-copy code {
  font-family: var(--type-mono);
  font-size: var(--size-12);
  color: var(--ink-1);
  background: var(--code);
  padding: 1px 5px;
  border-radius: var(--radius-8);
}
.pa-code {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
}
.pa-code--ask {
  align-items: start;
}
.pa-code-pre {
  margin: 0;
  min-width: 0;
  background: var(--well);
  border: 1px solid var(--edge);
  border-radius: var(--radius-12);
  padding: 10px 12px;
  font-family: var(--type-mono);
  font-size: var(--size-12);
  line-height: 1.45;
  color: var(--ink-1);
  overflow-x: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.pa-ask-pre {
  font-family: var(--type-ui);
  font-size: var(--size-14);
  line-height: 1.5;
}
.pa-copy {
  flex: 0 0 auto;
}
.pa-foot.ds {
  margin-top: 16px;
}
`;
