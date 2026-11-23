// The account page (/account): the name, the ways this account signs in, its email for getting
// back in, the trips it is on, signing out, and deleting it. The page is a file anyone can
// fetch; what is in it comes from /api/me, and someone signed out is sent to /login from here.
//
// Everything it asks the server is in src/accounts/ (and /api/me in src/api/me.js):
//   GET    /api/me                               who is signed in
//   GET    /api/trips                            the trips they are on, and which they host
//   PATCH  /api/me { name }                      the name
//   GET    /api/auth/ways                        passkeys, Google and GitHub sign-ins, the old username
//   DELETE /api/auth/ways/passkey/<id>           remove a passkey
//   DELETE /api/auth/ways/<provider>/<subject>   remove a Google or GitHub sign-in
//   GET    /api/account/apps, DELETE …/<id>      the AI apps connected (below)
//   GET, POST, DELETE /api/account/email, POST /api/account/email/confirm
//   GET    /api/account/plan, POST …/checkout { interval }, POST …/portal   the plan (src/billing/), where offered
//   POST   /api/auth/logout, /api/auth/logout/all
//   DELETE /api/me { confirm: "delete" }
// Adding Google or GitHub is a plain form post to /login/<provider> with intent=link; it comes
// back here with ?signin=<what happened>.

import { guestLine, guestNoteSeen, placeWord, waysIn } from "./guest.js";
import {
  addPasskey, afterLeaving, api, askTwice, AuthError, busyState, call, cleanName, deleteAccount, leavingWords, me, messages,
  providerName, resultWords, signOut, signOutEverywhere, support,
} from "./auth.js";
import { openPlanWithAiSheet } from "./plan-ai.js";
import { localeUnits, setDisabled } from "./util.js";
import { formatBytes } from "./shared/bytes.js";
import { paintPicture } from "./account-picture.js";

const $ = (id) => document.getElementById(id);
const busy = busyState();
const detail = $("detail");
// Who is signed in, from /api/me (start). A guest (js/guest.js) changes what the page offers.
let user = null;
// What this site offers to sign in with (/api/auth/ways' providers): the guest's sentences name only these.
let siteWays = {};
const said = Object.fromEntries(["arrived", "msg-name", "msg-units", "msg-out", "msg-delete", "msg-ways", "msg-email", "msg-apps", "msg-plan", "msg-yours"]
  .map((id) => [id, messages($(id), detail)]));
const clearAll = () => { for (const m of Object.values(said)) m.clear(); };

/** One action at a time: the button waits with a spinner, and what went wrong lands beside it. */
async function run(btn, waiting, where, action) {
  if (busy.on) return;
  clearAll();
  busy.start(btn, waiting);
  try {
    await action();
  } catch (e) {
    // Signed out underneath an open page (signed out everywhere from another device, say).
    if (e?.code === "signed-out") { location.replace("/login?next=/account&error=signed-out"); return; }
    said[where].fail(e);
  } finally {
    busy.stop(btn);
  }
}

const ICONS = {
  passkey: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l3 3M13.5 9.5l2 2"/>',
  provider: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.4-3.8 4.4-5.8 8-5.8s6.6 2 8 5.8"/>',
  trip: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.4"/>',
  host: '<path d="M6 21V4M6 5h11l-2.2 3.5L17 12H6"/>',
  synced: '<path d="M7 18a4 4 0 0 1-.6-7.95A6 6 0 0 1 18 9.5a4.25 4.25 0 0 1-.5 8.5H7Z"/>',
  device: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  app: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
};
const SVG = "http://www.w3.org/2000/svg";
function icon(name, cls) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.setAttribute("class", cls);
  svg.innerHTML = ICONS[name];
  return svg;
}
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
const day = (seconds) => new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const dates = (way) => `Added ${day(way.createdAt)}` + (way.lastUsedAt ? ` · last used ${day(way.lastUsedAt)}` : " · not used yet");

// ── the ways to sign in ────────────────────────────────────────────────────────────────

function wayRow({ kind, title, label, pill, meta, removable, remove }) {
  const row = el("div", "ac-way");
  row.append(icon(kind, "ac-ico"));
  const main = el("div", "ac-way-main");
  const head = el("div", "ac-way-title");
  head.append(el("span", "", title));
  if (label) head.append(el("span", "ac-way-label meta", label));
  if (pill) {
    // The icon and the words say it; the tag has no tint of its own (the system's gray tag).
    const tag = el("span", "ds-tag");
    tag.append(icon(pill.icon), pill.words);
    head.append(tag);
  }
  main.append(head, el("span", "meta", meta));
  row.append(main);
  if (removable) {
    const btn = el("button", "ds-button ds-button--fade ds-button--sm", "Remove");
    btn.type = "button";
    btn.setAttribute("data-act", "");
    btn.setAttribute("aria-label", `Remove ${title}${label ? ` ${label}` : ""}`);
    askTwice(btn, "Tap again to remove", () => run(btn, "Removing…", "msg-ways", async () => {
      await remove();
      await paintWays();
      said["msg-ways"].say(`${title} removed. It can't sign in to this account any more.`, "ok");
    }), { destroys: true });
    row.append(btn);
  }
  return row;
}

async function paintWays() {
  const ways = await call("GET", "/api/auth/ways");
  const total = ways.passkeys.length + ways.identities.length;
  const removable = total > 1;      // an account always keeps one; the server refuses the last too
  const rows = [];
  for (const p of ways.passkeys) {
    rows.push(wayRow({
      kind: "passkey",
      title: "Passkey",
      pill: p.synced === true ? { icon: "synced", words: "Synced to your other devices" }
        : p.synced === false ? { icon: "device", words: "On one device only" } : null,
      meta: dates(p),
      removable,
      remove: () => call("DELETE", `/api/auth/ways/passkey/${encodeURIComponent(p.id)}`),
    }));
  }
  for (const i of ways.identities) {
    rows.push(wayRow({
      kind: "provider",
      title: providerName(i.provider),
      label: i.label || "",
      meta: dates(i),
      removable,
      remove: () => call("DELETE", `/api/auth/ways/${encodeURIComponent(i.provider)}/${encodeURIComponent(i.subject)}`),
    }));
  }
  $("ways").replaceChildren(...rows);
  $("ways-only").hidden = removable;
  $("ways-username").hidden = !ways.username;
  $("username").textContent = ways.username || "";
  siteWays = ways.providers || {};
  for (const form of document.querySelectorAll("form[data-provider]")) form.hidden = !ways.providers?.[form.dataset.provider];
}

$("btn-add-passkey").addEventListener("click", (e) => run(e.currentTarget, "Waiting for your device…", "msg-ways", async () => {
  await addPasskey();
  // A guest's first way in makes them an account (the same person, nothing moved): the page is
  // drawn again as an account's, and says so.
  if (user?.guest) { guestNoteSeen(); location.replace("/account?signin=kept"); return; }
  await paintWays();
  said["msg-ways"].say("Passkey added. This device can sign in with it from now on.", "ok");
}));

// ── a guest ────────────────────────────────────────────────────────────────────────────
// Someone who joined by a link with only a name (js/guest.js): no way to sign in but this
// browser. The ways card leads with what that means and offers the ways to keep their place; what
// needs an account (an AI app, the plan, email for getting back in) isn't offered.
function paintGuest() {
  const guest = !!user?.guest;
  $("ways-title").textContent = guest ? "Keep your place" : "Ways to sign in";
  $("ways-guest").textContent = guestLine(siteWays);
  $("apps-guest").textContent = `Add ${waysIn(siteWays)} to connect an app.`;
  $("ways-guest").hidden = !guest;
  $("btn-add-passkey").classList.toggle("btn-primary", guest);
  $("apps-guest").hidden = !guest;
  $("apps-connect").hidden = guest;
  if (guest) { $("plan").hidden = true; $("email-card").hidden = true; $("ways-only").hidden = true; }
  // Signing out, and deleting: only what is true of a guest. A guest has one browser and no ways to sign in, AI
  // apps or email, and hosts no trip.
  $("out-words").textContent = guest
    ? `You're a guest: signing out ends your place on ${placeWord()}. Add a way to sign in first to keep it.`
    : "Signing out everywhere also signs out your other browsers and devices. Your passkeys keep working.";
  $("btn-signout-all").hidden = guest;
  $("deleted-account").hidden = guest;
  $("deleted-hosted").hidden = guest;
  $("delete-host").hidden = guest;
  $("ways-say").hidden = guest;
}

// ── deleting, while you host a trip other people are on ──────────────────────────────
// The server refuses it (409 host); the page says so before anyone presses: the trips by name, what to do first, and
// Delete off with that box as its reason (a disabled control says why in words).
function paintDeleteHost(r) {
  const hosted = (Array.isArray(r?.trips) ? r.trips : []).filter((t) => t.role === "host" && Number(t.members) > 1);
  const box = $("delete-host"), btn = $("btn-delete"), words = box.querySelector("span");
  box.hidden = !hosted.length;
  btn.disabled = !!hosted.length;
  if (!hosted.length) { btn.removeAttribute("aria-describedby"); return; }
  const parts = ["You host "];
  hosted.forEach((t, i) => {
    if (i) parts.push(i === hosted.length - 1 ? " and " : ", ");
    const b = document.createElement("span");
    b.className = "strong";
    b.textContent = `“${t.name}”`;
    parts.push(b);
  });
  parts.push(hosted.length === 1 ? ", and other people are on it. Offer it to one of them, or delete the trip, first."
    : ", and other people are on them. Offer each to one of them, or delete it, first.");
  words.replaceChildren(...parts);
  btn.setAttribute("aria-describedby", "delete-host");
}

// ── AI apps ────────────────────────────────────────────────────────────────────────────
// The apps connected to this account (the MCP): each one's name, what it may do, since when,
// and Disconnect, asked twice.
//   GET    /api/account/apps         -> { apps: [{ id, name, scope, connected_at }] }
//   DELETE /api/account/apps/<id>    -> { ok, disconnected }

async function paintApps() {
  const { apps } = await call("GET", "/api/account/apps");
  $("apps-connect").textContent = apps.length ? "Connect another AI" : "Connect your AI";
  $("apps").replaceChildren(...apps.map((a) => {
    const row = el("div", "ac-way");
    row.append(icon("app", "ac-ico"));
    const main = el("div", "ac-way-main");
    const head = el("div", "ac-way-title");
    head.append(el("span", "ac-way-label", a.name));
    const may = a.scope.includes("trips:write") ? "Can see and change your trips" : "Can see your trips";
    main.append(head, el("span", "meta", `${may} · connected ${a.connected_at ? day(a.connected_at) : "earlier"}`));
    row.append(main);
    const btn = el("button", "ds-button ds-button--fade ds-button--sm", "Disconnect");
    btn.type = "button";
    btn.setAttribute("data-act", "");
    btn.setAttribute("aria-label", `Disconnect ${a.name}`);
    askTwice(btn, "Tap again to disconnect", () => run(btn, "Disconnecting…", "msg-apps", async () => {
      await call("DELETE", `/api/account/apps/${encodeURIComponent(a.id)}`);
      await paintApps();
      said["msg-apps"].say(`${a.name} is disconnected. It can't reach your trips any more.`, "ok");
    }), { destroys: true });
    row.append(btn);
    return row;
  }));
}

// Connect your AI: the one sheet (js/plan-ai.js), which gives the site's own address itself; the list is read again
// when it says an app has connected, and when it closes.
$("apps-connect").addEventListener("click", () => {
  openPlanWithAiSheet({ title: "Connect your AI", onConnected: () => { paintApps().catch(() => {}); } });
});

// Arriving at /account#ai-apps (from a trip's empty itinerary or places): the card, once drawn.
function toAppsCard() {
  if (location.hash !== "#ai-apps") return;
  $("ai-apps").scrollIntoView({ block: "start" });
}

// ── the trips ──────────────────────────────────────────────────────────────────────────

// ── the plan (model §20) ───────────────────────────────────────────────────────────────
// Only where the site offers it (GET answers 404 otherwise, and the card stays hidden). The price
// is said here, on the host's own page, and nowhere else; it is Stripe's own (the Price objects).

// A price is never broken across rows ("$5.00 a / month" at 320 with larger text): its spaces don't break.
const money = (p, every) => `${new Intl.NumberFormat(undefined, { style: "currency", currency: p.currency }).format(p.amount / 100)} a ${every}`.replace(/ /g, "\u00a0");

// Why a plan ended, by the server's reason (src/billing/plan.js: Stripe's own cancellation reason, or ours). A cancelled
// plan ending at the end of what was paid for, and a reason not listed here, say only the day.
const ENDED_WHY = {
  refunded: ": the payment was refunded",
  dispute_lost: ": the payment was disputed with your bank",
  payment_failed: ": the payment didn't go through",
  never_paid: ": the first payment didn't go through",
};

const PAUSED = "The plan isn't on sale right now.";
const GIVEN = "It was given to you: nothing is charged, and there's nothing to manage.";

async function paintPlan() {
  const r = await api("GET", "/api/account/plan");
  if (r.status === 404) { $("plan").hidden = true; return null; }
  if (r.status !== 200) throw serverWords(r);
  const { plan, prices, room, assistant } = r.body;
  // What's yours names the assistant's conversations only where the site has the assistant.
  // So do Delete's list of what goes with the account, and the sentence, by the same rule.
  if (assistant) {
    $("yours-words").textContent = "Download what's yours: your account, your messages and memories on each trip, and your conversations with the assistant.";
    $("deleted-assistant").hidden = false;
  }
  const pool = formatBytes(room.pool), free = formatBytes(room.free);
  const both = assistant ? " and the assistant" : "";
  $("plan-title").textContent = plan.active ? "Your plan" : `More room${both}`;
  $("plan-lead").textContent = plan.active
    // A given plan: "nobody else pays" would sit beside "nothing is charged", so it says only who shares it.
    ? `${pool} across the trips you host${assistant ? ", and the assistant on each of them, for everyone on it" : ""}. The people on your trips share it${plan.status === "comp" ? "." : ": nobody else pays."}`
    : `You have ${free} free across the trips you host. The plan makes it ${pool}${assistant ? ", with the assistant on each of them, for everyone on it" : ""}. The people on your trips share it: nobody else pays.`;
  $("plan-use").textContent = `You use ${formatBytes(room.used)} of ${formatBytes(room.limit)}.`;
  const state = plan.active
    // Past due: no "renews on" (Stripe has moved the period on while its payment is still owed); the plan stays on while
    // Stripe tries the payment again (retries on, the site's billing setting).
    // Given by the site's operator (plan.status "comp", 0046): on, with nothing charged, renewing or to manage.
    ? plan.status === "comp" ? GIVEN
    : [plan.status === "past_due" ? "Your last payment didn't go through: update how you pay in Manage your plan. The plan stays on while it's tried again." : null,
       plan.cancels ? `It ends on ${day(plan.cancels)}; nothing you've added is removed.`
         : plan.until && plan.status !== "past_due" ? `${plan.interval === "year" ? "Yearly" : "Monthly"}, renews on ${day(plan.until)}.` : null,
       plan.held && assistant ? "The assistant is paused while a payment is disputed." : null].filter(Boolean).join(" ")
    // An ended plan always says so, and why when the server knows (21 Nov: after a refund the card said nothing at all):
    // the day it ended, the reason in plain words, that nothing is removed, and the end-room rule when it holds.
    : plan.status
      ? `Your plan ended${plan.ended ? ` on ${day(plan.ended)}` : ""}${ENDED_WHY[plan.reason] || ""}. Nothing you've added is removed${room.used > room.free ? `; new photos fit again once you use less than ${free}, or with the plan.` : "."}`
      : "";
  // Sales paused (PLAN_SALES): someone without the plan is told so in words, and the buy button says why it can't be
  // pressed; someone with it sees nothing new (it renews, and Manage your plan works, as before).
  const paused = !plan.active && r.body.sales === "paused";
  const stateLine = [state, paused ? PAUSED : ""].filter(Boolean).join(" ");
  $("plan-state").textContent = stateLine;
  $("plan-state").hidden = !stateLine;
  paintAssistantMonth(plan, r.body.assistant_month);
  $("plan-buy").hidden = plan.active;
  // A given plan has no subscription behind it: nothing to manage, so no "Manage your plan".
  $("plan-have").hidden = !plan.active || plan.status === "comp";
  if (!plan.active) {
    const can = Boolean(prices);
    $("btn-plan-monthly").textContent = can ? `Get more room, ${money(prices.monthly, "month")}` : "Get more room";
    $("btn-plan-yearly").textContent = can ? `Or ${money(prices.yearly, "year")}` : "Yearly";
    $("btn-plan-yearly").hidden = !can || paused;
    setDisabled($("btn-plan-monthly"), paused ? PAUSED : can ? "" : "The price couldn't be read just now.");
    if (!can) said["msg-plan"].say("The price couldn't be read just now. Reload to try again.", "err");
  }
  $("plan").hidden = false;
  return plan;
}

// The assistant's month, for the host: no amounts and no list of trips, ever. The box stays hidden unless the month is
// running low (LOW of the allowance used, or more): then one quiet line saying so, and when it starts again; when it's
// all used, that it has and when it's back. Only with the plan and where the site has the assistant on.
const LOW = 0.8;
function paintAssistantMonth(plan, m) {
  const box = $("plan-ai");
  const used = Number(m?.used), allowance = Number(m?.allowance);
  if (!plan?.active || !m || typeof m !== "object" || !(allowance > 0) || !(used >= LOW * allowance)) { box.hidden = true; return; }
  const back = Number.isFinite(Number(m.back)) ? new Date(Number(m.back) * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) : "";
  $("plan-ai-line").textContent = used >= allowance
    ? `The assistant has used this month's room.${back ? ` It's back on ${back}.` : ""}`
    : `The assistant has used most of this month's room.${back ? ` It starts again on ${back}.` : ""}`;
  box.hidden = false;
}

// ── what's yours (the export) ────────────────────────────────────────────────────────────
// A plain link the browser downloads (GET /api/account/export answers it as a file). With no
// signal it would end on the browser's own error page: said here in words instead, and nothing asked.
//
// The file is named by the day where the person is (in New York at 8 pm on the 16th, the 16th, not
// the server's 17th): the link carries this phone's own date, set again at each press so a page
// left open past midnight sends the new one. The server takes it only within a day of its own.
const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const exportHref = () => `/api/account/export?day=${localDay()}`;
$("btn-export").setAttribute("href", exportHref());
$("btn-export").addEventListener("click", (e) => {
  if (navigator.onLine) { e.currentTarget.setAttribute("href", exportHref()); said["msg-yours"].clear(); return; }
  e.preventDefault();
  said["msg-yours"].say("Downloading needs signal. Try again when you're connected.", "err");
});

/** A refusal from the plan's routes, in the server's own words. */
/** The server's refusal, said as it is (an AuthError: the words themselves, never "Something went wrong" over them). */
function serverWords(r) {
  return new AuthError(r.body?.error || "plan", r.body?.reason || "The plan couldn't be reached just now. Try again in a moment.");
}

async function toStripe(btn, path, body) {
  await run(btn, "Opening…", "msg-plan", async () => {
    const r = await api("POST", path, body);
    if (r.status !== 200 || typeof r.body?.url !== "string") throw serverWords(r);
    location.assign(r.body.url);
  });
}
$("btn-plan-monthly").addEventListener("click", () => toStripe($("btn-plan-monthly"), "/api/account/plan/checkout", { interval: "monthly" }));
$("btn-plan-yearly").addEventListener("click", () => toStripe($("btn-plan-yearly"), "/api/account/plan/checkout", { interval: "yearly" }));
$("btn-plan-manage").addEventListener("click", () => toStripe($("btn-plan-manage"), "/api/account/plan/portal"));

/** Back from Checkout: Stripe tells the server a moment later, so the card is read again until it says so. */
async function afterCheckout() {
  for (let i = 0; i < 10; i++) {
    const plan = await paintPlan().catch(() => null);
    if (plan?.active) { said["msg-plan"].say("Thanks: your plan is on.", "ok"); return; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  said["msg-plan"].say("Stripe is still confirming your payment. This card shows your plan as soon as it does; reload in a minute.", "ok");
}

// ── the name ───────────────────────────────────────────────────────────────────────────

$("form-name").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = cleanName($("name").value);
  if (!name) { clearAll(); said["msg-name"].say("Type a name, up to 40 characters.", "err"); return; }
  run($("btn-name"), "Saving…", "msg-name", async () => {
    const saved = await call("PATCH", "/api/me", { name });
    $("name").value = saved.me?.name ?? name;
    said["msg-name"].say("Saved. The people on your trips see this name from now on.", "ok");
  });
});

// ── kilometers or miles ────────────────────────────────────────────────────────────────
// The account's units (GET/PATCH /api/me `units`): null until picked, and then the phone's
// language decides (util.js localeUnits). Every distance the app draws follows it; times on foot
// are minutes either way.

let units = null;
function paintUnits() {
  const shown = units || localeUnits();
  for (const b of document.querySelectorAll("[data-units]")) b.setAttribute("aria-pressed", b.dataset.units === shown ? "true" : "false");
  // The switch's highlight under the one chosen (ds-modes: Kilometers is the first, Miles the second).
  const row = document.querySelector(".ac-units-row");
  if (row) row.style.setProperty("--ds-i", shown === "imperial" ? "1" : "0");
  $("units-note").textContent = units
    ? `Distances on your trips are in ${shown === "imperial" ? "miles" : "kilometers"}. Times on foot don't change.`
    : `Not chosen yet: this phone's language reads ${shown === "imperial" ? "miles" : "kilometers"}. Pick one to keep it on every phone.`;
}
for (const b of document.querySelectorAll("[data-units]")) {
  b.addEventListener("click", () => {
    if (b.dataset.units === units) return;
    run(b, "Saving…", "msg-units", async () => {
      const saved = await call("PATCH", "/api/me", { units: b.dataset.units });
      units = saved.me?.units ?? b.dataset.units;
      paintUnits();
      said["msg-units"].say(`Saved. Your trips show ${units === "imperial" ? "miles" : "kilometers"} from the next time they open.`, "ok");
    });
  });
}

// ── email, for getting back in ─────────────────────────────────────────────────────────

let codeId = null;
function paintEmail(mail) {
  $("email-card").hidden = !mail.offered;
  $("email-has").hidden = !mail.email;
  $("email-address").textContent = mail.email || "";
  $("email-label").textContent = mail.email ? "Change it to" : "Email address";
  $("form-email").hidden = false;
  $("form-email-code").hidden = true;
  $("email").value = "";
  codeId = null;
}

$("form-email").addEventListener("submit", (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  if (!email) { clearAll(); said["msg-email"].say("Type an email address.", "err"); return; }
  run($("btn-email-send"), "Sending…", "msg-email", async () => {
    const sent = await call("POST", "/api/account/email", { email });
    codeId = sent.id;
    $("email-sent-to").textContent = sent.sentTo;
    $("form-email").hidden = true;
    $("form-email-code").hidden = false;
    $("email-code").value = "";
    $("email-code").focus();
    said["msg-email"].say("A 6-digit code is on its way. It works for 15 minutes.", "info");
  });
});

$("form-email-code").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = $("email-code").value.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) { clearAll(); said["msg-email"].say("The code is 6 digits.", "err"); return; }
  run($("btn-email-confirm"), "Checking…", "msg-email", async () => {
    const mail = await call("POST", "/api/account/email/confirm", { id: codeId, code });
    paintEmail({ offered: true, email: mail.email });
    said["msg-email"].say("Confirmed. You can get back in with a code sent to this address.", "ok");
  });
});

$("btn-email-other").addEventListener("click", () => {
  clearAll();
  $("form-email-code").hidden = true;
  $("form-email").hidden = false;
  $("email").focus();
});

askTwice($("btn-email-remove"), "Tap again to remove", (btn) => run(btn, "Removing…", "msg-email", async () => {
  await call("DELETE", "/api/account/email");
  paintEmail({ offered: true, email: null });
  said["msg-email"].say("Removed. This account can't get back in by email now.", "ok");
}), { destroys: true });

// ── signing out, and deleting ──────────────────────────────────────────────────────────

// Each clears this phone once the server has said yes (auth.js), and asks first, saying how
// many, when changes made here haven't been sent: leaving loses them. Sign out alone asks only then.
// A guest's place goes with either (their way back in is this browser), so for them both always ask.
const asGuest = () => !!user?.guest;
askTwice($("btn-signout"), leavingWords("Tap again to sign out", { always: false, guest: asGuest }), (btn) => run(btn, "Signing out…", "msg-out", async () => {
  location.replace(afterLeaving(await signOut()));
}));

askTwice($("btn-signout-all"), leavingWords("Tap again to sign out everywhere", { guest: asGuest }), (btn) => run(btn, "Signing out…", "msg-out", async () => {
  location.replace(afterLeaving(await signOutEverywhere()));
}));

askTwice($("btn-delete"), leavingWords("Tap again to delete your account for good"), (btn) => run(btn, "Deleting…", "msg-delete", async () => {
  location.replace(afterLeaving(await deleteAccount(), "deleted"));
}), { destroys: true });

// ── start ──────────────────────────────────────────────────────────────────────────────

async function start() {

  // What the address came back with, said once: the code is taken out of the address so a
  // reload doesn't say it again.
  const query = new URLSearchParams(location.search);
  const arrived = resultWords(query.get("signin"), query.get("with"));
  if (query.has("signin")) history.replaceState(null, "", "/account");
  const paid = query.get("plan") === "done";
  if (paid) history.replaceState(null, "", "/account#plan");

  const cap = support();
  if (!cap.ok) {
    $("btn-add-passkey").disabled = true;
    $("btn-add-passkey").removeAttribute("data-act");
    $("passkey-unsupported").textContent = cap.message;
    $("passkey-unsupported").hidden = false;
  }

  try {
    user = await me();
    // Back here after signing in, to the card it was sent to (#ai-apps) if it was sent to one.
    if (!user) { location.replace(`/login?next=/account${location.hash ? encodeURIComponent(location.hash) : ""}`); return; }
    // A guest isn't asked for what only an account has (the server refuses it: 403 guest).
    const guest = !!user.guest;
    // An account now (a way to sign in added, here or elsewhere): the app's note to a guest goes.
    if (!guest) guestNoteSeen();
    const [, mail, , trips] = await Promise.all([paintWays(), guest ? { offered: false } : call("GET", "/api/account/email"), paintApps(),
      guest ? null : call("GET", "/api/trips"), guest ? null : paintPlan()]);
    paintEmail(mail);
    paintGuest();
    if (!guest) paintDeleteHost(trips);
  } catch (e) {
    $("loading").hidden = true;
    $("failed-text").textContent = `${e?.message || "This page couldn't load."} Reload to try again.`;
    $("failed").hidden = false;
    return;
  }
  $("name").value = user.name;
  paintPicture($("picture"), user, { detail, onUser: (next) => { user = { ...user, ...next }; } });
  units = user.units ?? null;
  paintUnits();
  $("loading").hidden = true;
  $("account").hidden = false;
  toAppsCard();
  if (location.hash === "#plan" && !$("plan").hidden) $("plan").scrollIntoView({ block: "start" });
  if (arrived) said.arrived.say(arrived[1], arrived[0]);
  if (paid) afterCheckout();
}

start();
