#!/usr/bin/env node
/* Plans by hand, in real browsers, on a server of its own: a plan added, changed and removed
 * in the Agenda (public/js/plan-editor.js, plan-form.js, agenda.js, the store's event writes).
 *
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> \
 *     --label "wegoplace plans_check.mjs" -- node scripts/plans_check.mjs
 *
 * WGP_SHOTS=<folder> also writes pictures at 320, 390, 768 and 1440 wide in both themes, to look
 * at: the empty Agenda, the sheet (new, with a refusal, with the question before a removal),
 * a plan's page, the dates asked of a trip that has none. Nothing is asserted from them.
 *
 * The server is this check's own (checks/lib/server.mjs: an empty database, a port of its own).
 * Two made-up people, a browser each. The first person's phone is set to a time zone far from
 * the trip's: every time below is the TRIP's clock, and the check computes what the server
 * should hold from the trip's zone alone.
 *
 * WHAT IT PROVES
 *   1. THE EMPTY AGENDA OFFERS IT: "Add a plan", one line that an AI app can fill the trip
 *      in too, and the + button.
 *   2. A PLAN IS ADDED THROUGH THE SHEET, the way a person does it: the name has the focus;
 *      the days offered are the trip's, not a calendar; no name is refused in a sentence
 *      under the field and nothing is sent; then name, kind, day, start, end, note and link,
 *      and Add. The Agenda shows it on its day at its time and has scrolled to it; the server
 *      got ONE request, the instants read in the trip's zone, the link made whole.
 *   3. ITS PAGE shows the note and the link, and offers Change.
 *   4. ANY MEMBER CHANGES ANY PLAN. The other person sees it, opens Change, finds every field
 *      as it was saved, changes the name and the time: the request carries only what changed,
 *      and the first person's phone shows the change.
 *   5. NO TIME IS ALL DAY; A STAY RUNS THROUGH ITS DAYS; AN END BEFORE THE START'S CLOCK IS
 *      THE NEXT DAY, each said in the line under the times before it is saved.
 *   6. WITH NO SIGNAL a plan is on the Agenda at once, waits in the phone's queue, and is
 *      sent when the API answers again.
 *   7. A PLAN IS REMOVED after a question that starts on "Keep it"; keeping keeps; removing
 *      returns to the Agenda without it, and the server no longer has it.
 *   8. WHERE: a search of the trip's places by part of a name; one is chosen, saved with the
 *      plan, and shown on its card. A name no place has is offered as a new place
 *      (scripts/place_check.mjs follows that through).
 *   9. A TRIP WITH NO DATES: the sheet asks for them first, refuses half an answer in a
 *      sentence, says it needs signal when there is none, and once they are set carries on
 *      to the plan in the same sheet.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";

const server = await startServer({ name: "plans", port: await freeLoopbackPort() });
ownServer(server.origin);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const SHOTS = process.env.WGP_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const ZONE = "Europe/Lisbon";
// The trip's days: a week that starts three days from now, as the trip's zone counts days.
const dayOf = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date(Date.now() + d * 86400e3));
const DAYS = [3, 4, 5, 6, 7, 8, 9].map(dayOf);
// The instant a clock time on a day means in the trip's zone, worked out here and not by the
// module under test: try the two offsets Lisbon can have and keep the one that reads back.
function instant(day, time) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  for (const off of [0, 1]) {
    const t = Date.parse(`${day}T${time}:00Z`) - off * 3600e3;
    const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    if (`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` === `${day} ${time}`) return t / 1000;
  }
  throw new Error(`no instant for ${day} ${time}`);
}
// The same in any zone: every whole and half hour of offset a zone can have, the one that reads back.
function instantIn(day, time, zone) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  for (let off = -14 * 4; off <= 14 * 4; off++) {
    const t = Date.parse(`${day}T${time}:00Z`) - off * 900e3;
    const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    if (`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` === `${day} ${time}`) return t / 1000;
  }
  throw new Error(`no instant for ${day} ${time} in ${zone}`);
}

const phones = [];
try {
  await server.start();
  const host = new Person(server.origin, "Mara Voss"), other = new Person(server.origin, "Teo Lind");
  await host.signUp(); await other.signUp();
  const hostId = (await host.me()).id;

  const madeA = await host.post("/api/trips", { name: "Harbor week", default_tz: ZONE, starts_on: DAYS[0], ends_on: DAYS[6] });
  const madeB = await host.post("/api/trips", { name: "Someday", default_tz: ZONE });
  const A = `/api/trips/${madeA.json.trip.id}`, B = `/api/trips/${madeB.json.trip.id}`;
  const idA = madeA.json.trip.id, idB = madeB.json.trip.id;
  const link = await host.post(`${A}/links`, {});
  const joined = await other.post(`/api/join/${link.json.link.code}`);
  check("two people on a trip with a week of days, and a second trip with no dates",
    madeA.status === 201 && madeB.status === 201 && joined.status < 300, `${madeA.status} ${madeB.status} ${link.status} ${joined.status} ${joined.text.slice(0, 200)}`);
  const eventsOf = async (who, trip) => (await who.get(`${trip}/events`)).json.events;

  const { boot, evalIn, waitFor, appSettled, sleep } = await import("./lib/standalone_cdp.mjs");

  // A phone: one browser, signed in as one person.
  async function phoneOf(person, { zone = "" } = {}) {
    const b = await boot({ vw: 390, vh: 844, dsf: 1 });
    phones.push(b);
    const { cdp, S } = b;
    if (zone) await cdp.send("Emulation.setTimezoneOverride", { timezoneId: zone }, S);
    for (const name of ["s2", "wgp_session", "wgp_who"]) await cdp.send("Network.deleteCookies", { name, url: server.origin }, S);
    await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: person.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
    const who = person.jar.cookies.get("wgp_who");
    if (who) await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: who, sameSite: "Lax" }, S);
    const page = (expr) => evalIn(cdp, S, expr);
    const writes = [];
    cdp.on((m) => {
      if (m.sessionId !== S || m.method !== "Network.requestWillBeSent") return;
      const r = m.params.request;
      if (r.method !== "GET" && /\/api\//.test(r.url)) writes.push({ method: r.method, path: new URL(r.url).pathname, body: r.postData || "" });
    });
    const wait = (expr, label) => waitFor(cdp, S, expr, { label });
    const p = {
      b, page, writes, wait,
      async open(trip, hash, ready, label) {
        await cdp.send("Page.navigate", { url: `${server.origin}/t/${trip}/?${Date.now()}${hash}` }, S);
        await sleep(300);
        await appSettled(cdp, S);
        try { await wait(ready, label); } catch (e) {
          const seen = await page(`(location.pathname + location.hash + " :: " + ((document.querySelector("#view") || document.body).innerText || "").replace(/\\s+/g, " ").trim().slice(0, 400))`).catch(() => "");
          throw new Error(`${e.message}\n      on screen: ${seen}`);
        }
        await sleep(400);
      },
      async tap(sel, label = sel) {
        const got = await page(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return 0; if (n.disabled) return -1; n.click(); return 1; })()`);
        if (got !== 1) throw new Error(`tap: ${label} ${got === 0 ? "is not there" : "is disabled"}`);
        await sleep(180);
      },
      async type(sel, value) {
        const ok = await page(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return 0; n.focus(); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event("input", { bubbles: true })); n.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()`);
        if (!ok) throw new Error(`type: ${sel} is not there`);
        await sleep(140);
      },
      apiOff: (off) => cdp.send("Network.setBlockedURLs", { urls: off ? ["*/api/*"] : [] }, S),
      inStore: (body) => page(`import("/js/store.js").then(async ({ store }) => { ${body} })`),
      async sheet(title) {
        await wait(`(() => { const r = document.querySelector(".sh-root"); return r && r.dataset.entered === "1" && /${title}/.test(r.querySelector(".sh-title").textContent) ? 1 : 0; })()`, `the sheet "${title}"`);
        await sleep(250);
      },
      async sheetGone() {
        await wait(`document.querySelector(".sh-root") ? 0 : 1`, "the sheet closed");
        await sleep(250);
      },
      // The plan sheet as it stands: every field, what is pressed, what is said.
      form: async () => JSON.parse(await page(`JSON.stringify((() => {
        const q = (s) => document.querySelector(s);
        const v = (s) => (q(s) ? q(s).value : null);
        return {
          title: v("#pe-title"), time: v("#pe-time"), end: v("#pe-end"), endDay: v("#pe-endday"), note: v("#pe-note"), link: v("#pe-link"),
          kind: (q('.pe-kind[aria-pressed="true"]') || { dataset: {} }).dataset.kind || "",
          day: (q('.pe-day[aria-pressed="true"]') || { dataset: {} }).dataset.day || "",
          days: [...document.querySelectorAll(".pe-day")].map((n) => n.dataset.day),
          endDays: [...document.querySelectorAll("#pe-endday option")].map((n) => n.value),
          hint: q("#pe-hint") && !q("#pe-hint").hidden ? q("#pe-hint").textContent : "",
          said: [...document.querySelectorAll(".pe-say")].filter((n) => !n.hidden).map((n) => n.dataset.say + ": " + n.textContent),
          where: q("#pe-where") ? "search" : q(".pe-place") ? q(".pe-placeline").innerText.replace(/\\s+/g, " ").trim() : "",
          focus: document.activeElement ? (document.activeElement.id || document.activeElement.dataset.act || document.activeElement.className) : "",
          action: (q('.sh-root [data-act="save"]') || { textContent: "" }).textContent.trim(),
          saveDisabled: !!q('.sh-root [data-act="save"]')?.disabled,
          saveOpacity: q('.sh-root [data-act="save"]') ? getComputedStyle(q('.sh-root [data-act="save"]')).opacity : "",
          tall: q('.sh-root')?.dataset.tall === "1",
          moreExpanded: q('.pe [data-act="toggle-more"]')?.getAttribute("aria-expanded") || "",
        };
      })())`)),
      // What the Agenda shows: each day with a plan on it, and the plans in order.
      agenda: async () => JSON.parse(await page(`JSON.stringify((() => {
        const text = (n) => (n ? n.innerText.replace(/\\s+/g, " ").trim() : "");
        return {
          empty: text(document.querySelector("#view .empty")),
          days: [...document.querySelectorAll("#view .ag-day")].map((d) => ({
            day: d.dataset.day,
            cards: [...d.querySelectorAll(".ag-card")].map((c) => text(c)),
            stays: [...d.querySelectorAll(".ag-stay")].map((c) => text(c)),
          })).filter((d) => d.cards.length || d.stays.length),
        };
      })())`)),
      async look(name) {
        if (!SHOTS) return;
        const was = await page(`document.documentElement.getAttribute("data-theme") || ""`);
        for (const theme of ["light", "dark"]) {
          await page(`(document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)}), document.documentElement.setAttribute("data-lum", ${JSON.stringify(theme)}), 1)`);
          await sleep(600);
          for (const w of [320, 768, 1440, 390]) {
            await b.metrics(w, 844, w > 400 ? 1 : 2);
            await sleep(400);
            await b.shot(path.join(SHOTS, `${name}-${w}-${theme}.png`));
          }
        }
        await page(`(${JSON.stringify(was)} ? document.documentElement.setAttribute("data-theme", ${JSON.stringify(was)}) : document.documentElement.removeAttribute("data-theme"), 1)`);
        await b.metrics(390, 844, 1);
        await sleep(300);
      },
    };
    return p;
  }
  const EMPTY = `document.querySelector("#view .empty") ? 1 : 0`;
  const LIST = `document.querySelector("#view .ag-day") ? 1 : 0`;
  const first = await phoneOf(host, { zone: "Pacific/Auckland" });
  const second = await phoneOf(other);

  // ── 1 ──────────────────────────────────────────────────────────────────────────────────────
  section("1. the empty Agenda offers it");
  await first.open(idA, "#/", EMPTY, "the Agenda of a trip with no plans");
  const offer = JSON.parse(await first.page(`JSON.stringify((() => {
    const e = document.querySelector("#view .empty");
    const b = e.querySelector("button[data-plan-add]");
    const ai = e.querySelector("button[data-plan-ai]");
    const fab = document.querySelector("#rt-fixed .fab[data-plan-add]");
    return { words: e.innerText.replace(/\\s+/g, " ").trim(), button: b ? b.textContent.trim() : "", ai: ai ? ai.textContent.trim() : "",
      fab: fab && !fab.hidden ? fab.getAttribute("aria-label") : "", zone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  })())`));
  check('"How do you want to plan it?", with "Plan it with your AI" and "Add plans yourself"', /How do you want to plan it\?/.test(offer.words) && offer.ai === "Plan it with your AI" && offer.button === "Add plans yourself", JSON.stringify(offer));
  check("one fine line explains it works with Claude, Claude Code and MCP servers", /Claude, Claude Code and any app that takes MCP servers/.test(offer.words), offer.words);
  check("no floating + on that choice screen (the screen already has both ways in)", offer.fab === "", offer.fab);
  check("this phone's own zone is nowhere near the trip's", offer.zone === "Pacific/Auckland", offer.zone);
  await first.look("agenda-empty");

  // ── 2 ──────────────────────────────────────────────────────────────────────────────────────
  section("2. a plan is added through the sheet");
  await first.tap("#view .empty button[data-plan-add]", "Add a plan");
  await first.sheet("Add a plan");
  let f = await first.form();
  check("Add a plan opens compact (not tall) with More details collapsed and Add disabled (not dimmed)",
    !f.tall && f.focus !== "pe-title" && f.moreExpanded === "false" && f.saveDisabled && f.saveOpacity === "1",
    JSON.stringify({ tall: f.tall, focus: f.focus, moreExpanded: f.moreExpanded, saveDisabled: f.saveDisabled, saveOpacity: f.saveOpacity }));
  check("the days offered are the trip's seven, the first chosen (the trip hasn't started)", f.days.join() === DAYS.join() && f.day === DAYS[0], `${f.days.join()} / ${f.day}`);
  check("a new plan is a Plan, with no time, and says what no time means", f.kind === "plan" && f.time === "" && /takes the whole day/.test(f.hint), JSON.stringify(f));
  const wherePh = await first.page(`(document.querySelector("#pe-where") || { placeholder: "" }).placeholder`);
  check("with no places on the trip Where asks for a name (a place can be made from here)", f.where === "search" && wherePh === "Name a place", `${f.where} / ${wherePh}`);
  check('the action is "Add"', f.action === "Add", f.action);
  await first.look("sheet-new");
  let before = first.writes.length;
  await first.type("#pe-title", "Dinner by the harbor");
  f = await first.form();
  check("typing a title enables Add", !f.saveDisabled && f.said.length === 0, JSON.stringify({ saveDisabled: f.saveDisabled, said: f.said }));
  await first.tap('.pe-kind[data-kind="meal"]', "Food");
  await first.tap(`.pe-day[data-day="${DAYS[2]}"]`, "the third day");
  await first.type("#pe-time", "19:30");
  await first.type("#pe-end", "21:00");
  await first.tap('.pe [data-act="toggle-more"]', "More details");
  await first.type("#pe-note", "Table for six, under Voss.");
  await first.type("#pe-link", "example.com/menu");
  f = await first.form();
  check("the form holds what was put in, and the line about no time is gone", f.kind === "meal" && f.day === DAYS[2] && f.time === "19:30" && f.end === "21:00" && f.hint === "", JSON.stringify(f));
  await first.look("sheet-filled");
  before = first.writes.length;
  await first.tap('.sh-root [data-act="save"]', "Add");
  await first.sheetGone();
  await first.wait(LIST, "the Agenda with a plan on it");
  await sleep(900);
  let ag = await first.agenda();
  check("the Agenda shows it on its day, at the trip's clock time", ag.days.length === 1 && ag.days[0].day === DAYS[2] && ag.days[0].cards.length === 1 && /19:30/.test(ag.days[0].cards[0]) && /21:00/.test(ag.days[0].cards[0]) && /Dinner by the harbor/.test(ag.days[0].cards[0]), JSON.stringify(ag));
  // The phone's own clock reads that instant as the morning of the NEXT date: a plan drawn by the
  // phone's zone would sit on the wrong day of the trip.
  const phoneDay = await first.page(`new Intl.DateTimeFormat("en-CA").format(new Date(${instant(DAYS[2], "19:30")} * 1000))`);
  check("this phone's own clock would have put it on the next date; the Agenda goes by the trip's", phoneDay === DAYS[3] && ag.days.length === 1 && ag.days[0].day === DAYS[2], `${phoneDay} / ${ag.days.map((d) => d.day).join()}`);
  const seen = await first.page(`(() => { const c = document.querySelector("#view .ag-card"); const r = c.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight ? 1 : 0; })()`);
  check("…and it is on screen", seen === 1);
  // It was on screen without moving the list, so the list did not move: the first day's own
  // line is still under its heading, not behind it.
  const stayed = JSON.parse(await first.page(`JSON.stringify((() => {
    const day = document.querySelector("#view .ag-day");
    const line = day.querySelector(".ag-nothing").getBoundingClientRect(), head = day.querySelector(".ag-dayhead").getBoundingClientRect();
    return { top: document.querySelector("#view").scrollTop, clear: line.top >= head.bottom, words: day.querySelector(".ag-nothing").textContent };
  })())`));
  check("…where it already was: the list did not move, and the first day's line is clear of its heading", stayed.top === 0 && stayed.clear && stayed.words === "Nothing scheduled.", JSON.stringify(stayed));
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the plan sent");
  const posts = first.writes.slice(before).filter((w) => w.method === "POST" && w.path === `${A}/events`);
  const sent = posts.length ? JSON.parse(posts[0].body) : {};
  check("ONE request, to this trip's events", posts.length === 1, JSON.stringify(first.writes.slice(before).map((w) => w.method + " " + w.path)));
  check("the instants are the trip's clock, not this phone's", sent.starts_at === instant(DAYS[2], "19:30") && sent.ends_at === instant(DAYS[2], "21:00") && sent.tz === ZONE && !sent.all_day, JSON.stringify({ got: [sent.starts_at, sent.ends_at, sent.tz, sent.all_day], want: [instant(DAYS[2], "19:30"), instant(DAYS[2], "21:00")] }));
  check("kind, note and the link made whole go with it, under an id the server takes", sent.kind === "meal" && sent.detail === "Table for six, under Voss." && sent.url === "https://example.com/menu" && /^ev-[0-9a-f-]{36}$/.test(sent.id || ""), JSON.stringify(sent));
  let rows = await eventsOf(host, A);
  check("the server has it, made by this person", rows.length === 1 && rows[0].title === "Dinner by the harbor" && rows[0].created_by === hostId && rows[0].starts_at === sent.starts_at, JSON.stringify(rows));
  const dinner = rows[0].id;
  await first.look("agenda-one-plan");

  // ── 3 ──────────────────────────────────────────────────────────────────────────────────────
  section("3. its page");
  await first.tap("#view .ag-card", "the plan's card");
  await first.wait(`document.querySelector("#view").dataset.route === "event" && document.querySelector("#view .ag-d-title") ? 1 : 0`, "the plan's page");
  await sleep(500);
  const pg = JSON.parse(await first.page(`JSON.stringify((() => {
    const v = document.querySelector("#view");
    const a = v.querySelector(".ag-d-link");
    const c = v.querySelector("[data-plan-change]");
    return { text: v.innerText.replace(/\\s+/g, " ").trim().slice(0, 400), link: a ? a.getAttribute("href") : "", change: c ? c.textContent.trim() : "" };
  })())`));
  check("the page shows its name, time, note and link", /Dinner by the harbor/.test(pg.text) && /19:30/.test(pg.text) && /Table for six, under Voss\./.test(pg.text) && pg.link === "https://example.com/menu", JSON.stringify(pg));
  check('…and offers "Change"', pg.change === "Change", pg.change);
  await first.look("plan-page");
  // "Chat about this": the trip's chat, with the plan held above its box.
  await first.tap("[data-plan-chat]", "Chat about this");
  await first.wait(`location.hash === "#/chat" && document.querySelector(".ch-held .ch-card-held") ? 1 : 0`, "the chat with the plan held");
  await sleep(400);
  const heldCard = await first.page(`(() => { const c = document.querySelector(".ch-held .ch-card-held"); return c.dataset.kind + " :: " + c.innerText.replace(/\\s+/g, " ").trim(); })()`);
  check('"Chat about this" opens the chat with this plan held above the box', /^event :: .*Dinner by the harbor/.test(heldCard), heldCard);
  await first.look("chat-about-plan");
  await first.tap('.ch-card-held [data-act="drop-about"]', "Not about this");
  check("…and it can be let go", (await first.page(`document.querySelector(".ch-held .ch-card-held") ? 1 : 0`)) === 0);
  // Back from the chat is the plan's page again: the chat was one step on from it.
  await first.page(`(history.back(), 1)`);
  await first.wait(`document.querySelector("#view").dataset.route === "event" && /Dinner by the harbor/.test(document.querySelector("#view").innerText) ? 1 : 0`, "back on the plan's page");
  check("Back from the chat is the plan's page again", true);
  await sleep(300);
  // The page's end clears Back, which is fixed over the page: at the top of the scroll it sits over
  // whatever is under it, and what has to hold is that the page's last line can be scrolled clear
  // of it, on a phone and on the narrowest. The page grows with what has been said about the plan
  // (the chat's messages since migration 0027: the page lists them, and has no note box), so nine
  // are sent about it, as the first person, while the page is open.
  for (let i = 1; i <= 9; i++) {
    const sent = await first.page(`fetch(${JSON.stringify(`${A}/messages`)}, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "pc-said-${i}", body: ${JSON.stringify(`Note ${i}: ${"bring the tickets and the booking number ".repeat((i % 3) + 1).trim()}.`)}, about: { kind: "event", id: ${JSON.stringify(dinner)} } }) }).then((r) => r.status)`);
    if (sent !== 201) throw new Error(`message ${i} about the plan: ${sent}`);
  }
  // The page lists them as the chat's socket brings them (no reload: Back stays the way back).
  await first.wait(`document.querySelectorAll("#view .ch-said-row").length === 9 ? 1 : 0`, "the nine messages on the plan's page");
  const pageEnd = async () => {
    await sleep(300);
    await first.page(`(() => { const v = document.querySelector("#view"); v.scrollTop = v.scrollHeight; return 1; })()`);
    await sleep(400);
    return JSON.parse(await first.page(`JSON.stringify((() => {
      const v = document.querySelector("#view");
      let last = 0, words = "";
      for (const n of v.querySelectorAll("*")) {
        if (![...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
        const r = n.getBoundingClientRect();
        if (r.width && r.height && r.bottom > last) { last = r.bottom; words = n.textContent.trim().slice(0, 40); }
      }
      const back = document.getElementById("backbtn");
      const bk = back && !back.hidden ? back.getBoundingClientRect() : null;
      return { w: innerWidth, scrolls: v.scrollHeight - v.clientHeight, atEnd: Math.abs(v.scrollTop + v.clientHeight - v.scrollHeight) < 2,
        last: Math.round(last), words, bar: bk ? Math.round(bk.top) : null };
    })())`));
  };
  const endOne = await pageEnd();
  check("a long plan's page scrolls, and at its end the last line is clear of Back", endOne.scrolls > 100 && endOne.atEnd && endOne.bar !== null && endOne.last <= endOne.bar, JSON.stringify(endOne));
  await first.look("plan-page-end");
  await first.b.metrics(320, 844, 2);
  const endNarrow = await pageEnd();
  check("…and at 320 wide", endNarrow.scrolls > 100 && endNarrow.atEnd && endNarrow.bar !== null && endNarrow.last <= endNarrow.bar, JSON.stringify(endNarrow));
  await first.b.metrics(390, 844, 1);
  await first.page(`(document.querySelector("#view").scrollTop = 0, 1)`);
  await sleep(300);

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────────
  section("4. any member changes any plan");
  await second.open(idA, "#/", LIST, "the other person's Agenda");
  ag = await second.agenda();
  check("the other person sees the plan", ag.days.length === 1 && /Dinner by the harbor/.test(ag.days[0].cards[0]), JSON.stringify(ag));
  await second.tap("#view .ag-card", "the plan's card");
  await second.wait(`document.querySelector("#view [data-plan-change]") ? 1 : 0`, "the plan's page, for the other person");
  await sleep(400);
  await second.tap("#view [data-plan-change]", "Change");
  await second.sheet("Change plan");
  f = await second.form();
  check("every field is as it was saved", f.title === "Dinner by the harbor" && f.kind === "meal" && f.day === DAYS[2] && f.time === "19:30" && f.end === "21:00" && f.endDay === "" && f.note === "Table for six, under Voss." && f.link === "https://example.com/menu" && f.action === "Save", JSON.stringify(f));
  await second.type("#pe-title", "Dinner on the pier");
  await second.type("#pe-time", "20:00");
  before = second.writes.length;
  await second.tap('.sh-root [data-act="save"]', "Save");
  await second.sheetGone();
  await second.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the change sent");
  const patches = second.writes.slice(before).filter((w) => w.method === "PATCH" && w.path === `${A}/events/${dinner}`);
  const patch = patches.length ? JSON.parse(patches[0].body) : {};
  const keys = Object.keys(patch).filter((k) => k !== "updated_at").sort().join();
  check("ONE request, carrying only what changed", patches.length === 1 && keys === "starts_at,title" && patch.title === "Dinner on the pier" && patch.starts_at === instant(DAYS[2], "20:00"), JSON.stringify(second.writes.slice(before)));
  rows = await eventsOf(host, A);
  check("the server has the change, and nothing else moved", rows.length === 1 && rows[0].title === "Dinner on the pier" && rows[0].starts_at === instant(DAYS[2], "20:00") && rows[0].ends_at === instant(DAYS[2], "21:00") && rows[0].kind === "meal" && rows[0].url === "https://example.com/menu" && rows[0].created_by === hostId, JSON.stringify(rows));
  const pgText = await second.page(`document.querySelector("#view").innerText.replace(/\\s+/g, " ").trim().slice(0, 200)`);
  check("the page the change was made from shows it", /Dinner on the pier/.test(pgText) && /20:00/.test(pgText), pgText);
  await first.inStore(`await store.refresh(); return 1;`);
  await sleep(700);
  const firstText = await first.page(`document.querySelector("#view").innerText.replace(/\\s+/g, " ").trim().slice(0, 200)`);
  check("the first person's phone shows it too", /Dinner on the pier/.test(firstText) && /20:00/.test(firstText), firstText);

  // ── 5 ──────────────────────────────────────────────────────────────────────────────────────
  section("5. all day, a stay through its days, an end the next day");
  await first.open(idA, "#/", LIST, "the Agenda");
  await first.tap("#rt-fixed .fab[data-plan-add]", "the + button");
  await first.sheet("Add a plan");
  await first.type("#pe-title", "Guesthouse on the hill");
  await first.tap('.pe-kind[data-kind="lodging"]', "Stay");
  await first.tap(`.pe-day[data-day="${DAYS[1]}"]`, "the second day");
  f = await first.form();
  check("the days an end can be on are the days after the start, to the day after the trip's last",
    f.endDays[0] === "" && f.endDays[1] === DAYS[2] && f.endDays.length === 7 && f.endDays[5] === DAYS[6] && f.endDays[6] > DAYS[6], f.endDays.join());
  await first.tap('.pe [data-act="toggle-more"]', "More details");
  await first.type("#pe-endday", DAYS[4]);
  f = await first.form();
  check("no time and a later end day: it says it takes whole days", /takes whole days, through the day it ends/.test(f.hint), f.hint);
  before = first.writes.length;
  await first.tap('.sh-root [data-act="save"]', "Add");
  await first.sheetGone();
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the stay sent");
  let post = JSON.parse((first.writes.slice(before).find((w) => w.method === "POST") || { body: "{}" }).body);
  check("the stay is all day, from the first minute of its first day to its last day, in the trip's zone",
    post.all_day === 1 && post.kind === "lodging" && post.starts_at === instant(DAYS[1], "00:00") && post.ends_at === instant(DAYS[4], "00:00"), JSON.stringify(post));
  await sleep(600);
  ag = await first.agenda();
  const stayDays = ag.days.filter((d) => d.stays.some((s) => /Guesthouse on the hill/.test(s))).map((d) => d.day);
  check("the Agenda draws the stay on each of its four days", stayDays.join() === DAYS.slice(1, 5).join(), JSON.stringify(ag));

  await first.tap("#rt-fixed .fab[data-plan-add]", "the + button");
  await first.sheet("Add a plan");
  await first.type("#pe-title", "Night bus north");
  await first.tap('.pe-kind[data-kind="transit"]', "Transit");
  await first.tap(`.pe-day[data-day="${DAYS[5]}"]`, "the sixth day");
  // Measured at once, before anything else changes the sheet: the tap itself brings the chip in.
  const chipSeen = await first.page(`(() => { const c = document.querySelector('.pe-day[aria-pressed="true"]'); const row = c.parentElement.getBoundingClientRect(); const r = c.getBoundingClientRect(); return r.left >= row.left - 1 && r.right <= row.right + 1 ? 1 : 0; })()`);
  await first.type("#pe-time", "22:40");
  await first.type("#pe-end", "06:10");
  f = await first.form();
  check("an end before the start's clock says it is the next day, and \"Ends on\" shows that day", /^Ends the next day, \w{3} \d{1,2} \w{3}\.$/.test(f.hint) && f.endDay === DAYS[6], `${f.hint} / ${f.endDay}`);
  check("the chosen day's chip is wholly in its row", chipSeen === 1);
  await first.b.metrics(1440, 844, 1); await sleep(300);
  await first.b.metrics(390, 844, 1); await sleep(400);
  const chipAfter = await first.page(`[...document.querySelectorAll('.pe-day[aria-pressed="true"], .pe-kind[aria-pressed="true"]')].map((c) => { const row = c.parentElement.getBoundingClientRect(); const r = c.getBoundingClientRect(); return r.left >= row.left - 1 && r.right <= row.right + 1 ? "in" : "out"; }).join()`);
  check("…and still is, with the chosen kind's, after the sheet was wide and then narrow again", chipAfter === "in,in", chipAfter);
  await first.type("#pe-end", "23:30");
  f = await first.form();
  check("an end later the same evening: \"Ends on\" goes back to the same day, and the line is gone", f.endDay === "" && f.hint === "", `${f.hint} / ${f.endDay}`);
  await first.type("#pe-end", "06:10");
  f = await first.form();
  check("…and the next day again when the end is put back", f.endDay === DAYS[6] && /^Ends the next day/.test(f.hint), `${f.hint} / ${f.endDay}`);
  await first.look("sheet-next-day");
  before = first.writes.length;
  await first.tap('.sh-root [data-act="save"]', "Add");
  await first.sheetGone();
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the night bus sent");
  post = JSON.parse((first.writes.slice(before).find((w) => w.method === "POST") || { body: "{}" }).body);
  check("…and is saved ending the next morning", post.starts_at === instant(DAYS[5], "22:40") && post.ends_at === instant(DAYS[6], "06:10") && !post.all_day, JSON.stringify(post));

  // ── 6 ──────────────────────────────────────────────────────────────────────────────────────
  section("6. with no signal");
  await first.apiOff(true);
  await first.tap("#rt-fixed .fab[data-plan-add]", "the + button");
  await first.sheet("Add a plan");
  await first.type("#pe-title", "Market walk");
  await first.tap(`.pe-day[data-day="${DAYS[3]}"]`, "the fourth day");
  await first.tap('.sh-root [data-act="save"]', "Add");
  await first.sheetGone();
  await sleep(700);
  ag = await first.agenda();
  const walkDay = ag.days.find((d) => d.day === DAYS[3]);
  const waiting = await first.inStore(`return store.pending();`);
  rows = await eventsOf(host, A);
  check("the plan is on the Agenda at once, all day", !!walkDay && walkDay.cards.some((c) => /Market walk/.test(c) && /All day/.test(c)), JSON.stringify(walkDay));
  check("it waits on the phone; the server has not heard of it", waiting === 1 && !rows.some((r) => r.title === "Market walk"), `${waiting} ${rows.map((r) => r.title).join()}`);
  await first.apiOff(false);
  await first.page(`(window.dispatchEvent(new Event("online")), 1)`);
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the waiting plan sent");
  rows = await eventsOf(host, A);
  const walk = rows.find((r) => r.title === "Market walk");
  check("when the API answers again it is sent", !!walk && walk.all_day === 1 && walk.starts_at === instant(DAYS[3], "00:00"), JSON.stringify(walk));

  // ── 7 ──────────────────────────────────────────────────────────────────────────────────────
  section("7. a plan is removed");
  await first.tap(`#view a.ag-card[href="#/e/${encodeURIComponent(walk.id)}"]`, "the Market walk card");
  await first.wait(`document.querySelector("#view [data-plan-change]") ? 1 : 0`, "the plan's page");
  await sleep(500);
  await first.tap("#view [data-plan-change]", "Change");
  await first.sheet("Change plan");
  f = await first.form();
  check("the sheet opens on a control that keeps, not on the one that removes", f.focus !== "remove" && !/btn-danger/.test(f.focus), f.focus);
  await first.tap('.pe [data-act="remove"]', "Remove this plan");
  const ask = JSON.parse(await first.page(`JSON.stringify({ words: document.querySelector("#pe-ask").textContent, focus: document.activeElement.dataset.act || "", buttons: [...document.querySelectorAll(".pe-askrow button")].map((b) => b.textContent.trim()) })`));
  check('it asks first, naming the plan, and the focus is on "Keep it"', /Remove “Market walk”\? The notes on it go with it\./.test(ask.words) && ask.focus === "keep" && ask.buttons.join() === "Keep it,Remove", JSON.stringify(ask));
  await first.look("sheet-remove-ask");
  before = first.writes.length;
  await first.tap('.pe [data-act="keep"]', "Keep it");
  const kept = await first.page(`(document.querySelector('.pe [data-act="remove"]') && !document.querySelector("#pe-ask") && document.activeElement.dataset.act === "remove") ? 1 : 0`);
  check("keeping keeps: the question is gone, nothing was sent", kept === 1 && first.writes.length === before);
  await first.tap('.pe [data-act="remove"]', "Remove this plan");
  await first.tap('.pe [data-act="remove-yes"]', "Remove");
  await first.sheetGone();
  await first.wait(`document.querySelector("#view").dataset.route === "agenda" && document.querySelector("#view .ag-day") ? 1 : 0`, "back on the Agenda");
  await sleep(700);
  ag = await first.agenda();
  check("removing returns to the Agenda, without it", !ag.days.some((d) => d.cards.some((c) => /Market walk/.test(c))) && !/Not on this phone/.test(await first.page(`document.querySelector("#view").innerText`)), JSON.stringify(ag.days.map((d) => d.cards)));
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the removal sent");
  rows = await eventsOf(host, A);
  check("one DELETE, and the server no longer has it", first.writes.slice(before).filter((w) => w.method === "DELETE" && w.path === `${A}/events/${walk.id}`).length === 1 && !rows.some((r) => r.id === walk.id), JSON.stringify(first.writes.slice(before)));

  // ── 8 ──────────────────────────────────────────────────────────────────────────────────────
  section("8. where");
  const put = await host.call("PUT", `${A}/places`, { places: [
    { id: "harbor-grill", name: "Harbor Grill", kind: "food", subkind: "restaurant", why: "The fish comes off the boats outside." },
    { id: "harbor-market", name: "Harbor Market", kind: "food", subkind: "market", why: "Mornings only." },
    { id: "old-fort", name: "The Old Fort", kind: "sight", subkind: "castle", why: "The view over the bay." },
  ] });
  check("another device gives the trip three places", put.status === 200, `${put.status} ${put.text.slice(0, 400)}`);
  await first.inStore(`await store.refresh(); return 1;`);
  await sleep(500);
  await first.tap("#rt-fixed .fab[data-plan-add]", "the + button");
  await first.sheet("Add a plan");
  await first.tap('.pe [data-act="toggle-more"]', "More details");
  f = await first.form();
  const searchPh = await first.page(`(document.querySelector("#pe-where") || { placeholder: "" }).placeholder`);
  check("now Where is a search of the trip's places", f.where === "search" && searchPh === "Search this trip's places, or name a new one", `${f.where} / ${searchPh}`);
  await first.type("#pe-where", "harb");
  let hits = JSON.parse(await first.page(`JSON.stringify([...document.querySelectorAll(".pe-hit")].map((n) => n.innerText.replace(/\\s+/g, " ").trim()))`));
  check("typing part of a name finds the places with it, each with what kind it is, then the offer to add what was typed",
    hits.length === 3 && /^Harbor Grill restaurant$/.test(hits[0]) && /^Harbor Market market$/.test(hits[1]) && hits[2] === "Add “harb” as a new place", JSON.stringify(hits));
  await first.type("#pe-where", "zzz");
  const none = await first.page(`document.querySelector("#pe-found").innerText.replace(/\\s+/g, " ").trim()`);
  check("a name no place has offers only to add it as a new place (place_check follows that through)", none === "Add “zzz” as a new place", none);
  await first.type("#pe-where", "Harbor Grill");
  hits = JSON.parse(await first.page(`JSON.stringify([...document.querySelectorAll(".pe-hit")].map((n) => n.innerText.replace(/\\s+/g, " ").trim()))`));
  check("a place's whole name: the place, and no offer to add a second of that name", hits.length === 1 && /^Harbor Grill restaurant$/.test(hits[0]), JSON.stringify(hits));
  await first.type("#pe-where", "grill");
  await first.look("sheet-where");
  await first.tap('.pe-hit[data-place="harbor-grill"]', "Harbor Grill");
  f = await first.form();
  check("the chosen place is shown, with a way to change it", /^Harbor Grill restaurant$/.test(f.where) && f.focus === "clear-place", JSON.stringify([f.where, f.focus]));
  await first.type("#pe-title", "Lunch off the boats");
  await first.tap('.pe-kind[data-kind="meal"]', "Food");
  await first.tap(`.pe-day[data-day="${DAYS[0]}"]`, "the first day");
  await first.type("#pe-time", "13:00");
  before = first.writes.length;
  await first.tap('.sh-root [data-act="save"]', "Add");
  await first.sheetGone();
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the lunch sent");
  post = JSON.parse((first.writes.slice(before).find((w) => w.method === "POST") || { body: "{}" }).body);
  await sleep(600);
  ag = await first.agenda();
  const lunch = (ag.days.find((d) => d.day === DAYS[0]) || { cards: [] }).cards.find((c) => /Lunch off the boats/.test(c)) || "";
  check("the plan is saved with its place, and its card names the place", post.place_id === "harbor-grill" && /Harbor Grill/.test(lunch), JSON.stringify([post.place_id, lunch]));

  section("8a. the plan's page names its place once");
  {
    // A local name that is the name again (capitals, other spacing, no accents) is not a second
    // name; one of its own is shown beside the name. util.js localNameOf decides for every screen.
    const src = (name) => fs.readFileSync(new URL(`../public/js/${name}`, import.meta.url), "utf8");
    const own = ["agenda.js", "places.js", "map.js"].filter((n) => /esc\((p|place)\.name_local\)/.test(src(n)));
    check("no screen draws a place's local name without asking localNameOf", own.length === 0, own.join(", "));
    const band = async (local, label) => {
      const sent = await host.call("PUT", `${A}/places`, { places: [{ id: "harbor-grill", name_local: local }] });
      if (sent.status !== 200) throw new Error(`the local name was refused: ${sent.status} ${sent.text.slice(0, 200)}`);
      await first.inStore(`await store.refresh(); return 1;`);
      await first.open(idA, `#/e/${encodeURIComponent(post.id)}`, `document.querySelector("#view .ag-b-name") ? 1 : 0`, label);
      await sleep(400);
      return JSON.parse(await first.page(`JSON.stringify((() => { const n = document.querySelector("#view .ag-b-name"), l = n.querySelector(".ag-b-local"); return { name: n.textContent.replace(/\\s+/g, " ").trim(), local: l ? l.textContent : null }; })())`));
    };
    const twice = await band("HARBOR  GRILL", "the lunch's page, its place's local name the name in capitals");
    check("a local name that is the name again is not drawn beside it", twice.name === "Harbor Grill" && twice.local === null, JSON.stringify(twice));
    const own2 = await band("Grelha do Porto", "the lunch's page, its place with a local name of its own");
    check("a local name of its own is drawn beside the name", own2.local === "Grelha do Porto" && own2.name === "Harbor Grill Grelha do Porto", JSON.stringify(own2));
    await first.look("plan-page-local-name");
    const back = await host.call("PUT", `${A}/places`, { places: [{ id: "harbor-grill", name_local: "" }] });
    if (back.status !== 200) throw new Error(`the local name was not put back: ${back.status}`);
    await first.inStore(`await store.refresh(); return 1;`);
    await first.open(idA, "#/", LIST, "the Agenda again");
    await sleep(400);
  }

  section("8b. what's near, opened from a gap: the gap's length reads as the Agenda says it");
  {
    // The Agenda's page for a gap links to Places as #/places?near=<place>&free=<minutes>.
    // One function says how long a gap is on both screens (util.js fmtSpan): no screen has its own.
    const src = (name) => fs.readFileSync(new URL(`../public/js/${name}`, import.meta.url), "utf8");
    const own = ["agenda.js", "places.js"].filter((n) => /function fmtSpan\b/.test(src(n)) || !/import \{[^}]*\bfmtSpan\b[^}]*\} from "\.\/util\.js"/.test(src(n)));
    check("the Agenda and Places take the one function from util.js, and neither has its own", own.length === 0 && /export function fmtSpan\b/.test(src("util.js")), own.join(", "));
    const quay = await host.call("PUT", `${A}/places`, { places: [
      { id: "quay-cafe", name: "Quay Cafe", kind: "food", subkind: "cafe", why: "Coffee by the water.", lat: 38.71, lng: -9.14 },
    ] });
    check("another device adds a place that is on the map", quay.status === 200, `${quay.status} ${quay.text.slice(0, 200)}`);
    const headOf = async (free) => {
      await first.open(idA, `#/places?near=quay-cafe&free=${free}`, `document.querySelector("#view .pl-anchor-t small") ? 1 : 0`, `Places, from a gap of ${free} minutes`);
      return first.page(`document.querySelector("#view .pl-anchor-t").innerText.replace(/\\s+/g, " ").trim()`);
    };
    const cardSays = (free) => first.page(`import("/js/util.js").then(({ fmtSpan }) => fmtSpan(${free} * 60000))`);
    const long = await headOf(550);
    check("a gap of 550 minutes reads “9h 10m free”, as its card on the Agenda does: never “550 min”", long === "Near Quay Cafe · 9h 10m free" && (await cardSays(550)) === "9h 10m", long);
    await first.look("places-from-a-long-gap");
    // The narrowest phone and the longest place name the made-up trip has (seed/demo-trip.json):
    // the head has no room for both whole, and it is the NAME that gives way. The time is the
    // part a person came for.
    const seed = JSON.parse(fs.readFileSync(new URL("../seed/demo-trip.json", import.meta.url), "utf8"));
    const longest = [...seed.places].sort((a, b) => b.name.length - a.name.length)[0];
    const far = await host.call("PUT", `${A}/places`, { places: [
      { id: "longest-name", name: longest.name, kind: longest.kind, subkind: longest.subkind, why: "The longest name the made-up trip has.", lat: 38.712, lng: -9.142 },
    ] });
    if (far.status !== 200) throw new Error(`adding the long-named place: ${far.status} ${far.text.slice(0, 200)}`);
    await first.b.metrics(320, 844, 2);
    await first.open(idA, "#/places?near=longest-name&free=550", `document.querySelector("#view .pl-anchor-t small") ? 1 : 0`, "Places at 320 wide, from a long gap, near the longest name");
    const narrow = JSON.parse(await first.page(`(() => {
      const t = document.querySelector("#view .pl-anchor-t"), time = t.querySelector("small"), name = t.querySelector(".pl-anchor-n");
      const r = time.getBoundingClientRect(), x = document.querySelector("#view .pl-anchor .pl-x").getBoundingClientRect(), n = name.getBoundingClientRect();
      // Its own width, were nothing squeezing it: a copy laid out alone.
      const alone = time.cloneNode(true); alone.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
      t.append(alone); const need = alone.getBoundingClientRect().width; alone.remove();
      return JSON.stringify({ says: time.innerText.trim(), width: Math.round(r.width), need: Math.round(need), gapToX: Math.round(x.left - r.right),
        nameCut: name.scrollWidth > name.clientWidth, nameWidth: Math.round(n.width), nameSays: name.innerText.trim(), page: document.documentElement.scrollWidth,
        line: (document.querySelector("#view .pl-sep") || { textContent: "" }).textContent.trim() });
    })()`));
    check(`at 320 wide, near “${longest.name}”: the gap's length is whole and clear of the ×, and the name takes the cut`,
      narrow.says === "· 9h 10m free" && narrow.width >= narrow.need - 1 && narrow.gapToX >= 0 && narrow.nameCut && narrow.nameWidth >= 48 && /^Near /.test(narrow.nameSays) && narrow.page <= 320, JSON.stringify(narrow));
    check("the line under what fits says the gap the same way: “Won't fit in 9h 10m”", narrow.line === "Won't fit in 9h 10m", narrow.line);
    if (SHOTS) await first.b.shot(path.join(SHOTS, "places-long-gap-longest-name-320.png"));
    await first.b.metrics(390, 844, 1);
    const short = await headOf(45);
    check("a gap under an hour reads in minutes, the same way: “45m free”", short === "Near Quay Cafe · 45m free" && (await cardSays(45)) === "45m", short);
    const even = await headOf(120);
    check("and whole hours read as hours: “2h free”", even === "Near Quay Cafe · 2h free", even);
  }

  // ── 9 ──────────────────────────────────────────────────────────────────────────────────────
  section("9. a trip with no dates");
  await first.open(idB, "#/", EMPTY, "the Agenda of a trip with no dates");
  await first.tap("#view .empty button[data-plan-add]", "Add a plan");
  await first.sheet("Add a plan");
  const asks = JSON.parse(await first.page(`JSON.stringify({ lead: (document.querySelector(".pe-lead") || { textContent: "" }).textContent, name: !!document.querySelector("#pe-title"), first: !!document.querySelector("#pe-first"), last: !!document.querySelector("#pe-last") })`));
  check("the sheet asks for the trip's dates first, and says why", /no dates yet/.test(asks.lead) && asks.first && asks.last && !asks.name, JSON.stringify(asks));
  await first.look("sheet-dates");
  before = first.writes.length;
  await first.tap('.pe [data-act="set-dates"]', "Set the dates, with none");
  let saidDates = await first.page(`(document.querySelector('[data-say="dates"]').hidden ? "" : document.querySelector('[data-say="dates"]').textContent)`);
  check("neither day: a sentence, nothing sent", saidDates === "Pick both days." && first.writes.length === before, saidDates);
  await first.type("#pe-first", DAYS[3]);
  await first.type("#pe-last", DAYS[1]);
  await first.tap('.pe [data-act="set-dates"]', "Set the dates, the wrong way round");
  saidDates = await first.page(`document.querySelector('[data-say="dates"]').textContent`);
  check("the last day before the first: a sentence, nothing sent", saidDates === "The last day can't be before the first." && first.writes.length === before, saidDates);
  await first.type("#pe-last", DAYS[5]);
  await first.apiOff(true);
  await first.tap('.pe [data-act="set-dates"]', "Set the dates, with no signal");
  await first.wait(`document.querySelector('[data-say="dates"]') && !document.querySelector('[data-say="dates"]').hidden ? 1 : 0`, "the answer with no signal");
  saidDates = await first.page(`document.querySelector('[data-say="dates"]').textContent`);
  const stillAsks = await first.page(`(document.querySelector("#pe-first") && document.querySelector('.pe [data-act="set-dates"]').textContent === "Set the dates" && !document.querySelector('.pe [data-act="set-dates"]').disabled) ? 1 : 0`);
  check("with no signal it says it needs signal, and the days typed are still there", /needs signal/.test(saidDates) && stillAsks === 1 && (await first.page(`document.querySelector("#pe-first").value`)) === DAYS[3], saidDates);
  await first.apiOff(false);
  before = first.writes.length;   // the attempt with no signal was a request too, one that never left
  await first.tap('.pe [data-act="set-dates"]', "Set the dates");
  await first.wait(`document.querySelector("#pe-title") ? 1 : 0`, "the plan form, after the dates");
  await sleep(300);
  f = await first.form();
  const tripB = (await host.get(B)).json;
  const datesSent = first.writes.slice(before).filter((w) => w.method === "PATCH" && w.path === B).map((w) => w.body);
  check("with signal the dates are set on the trip", datesSent.length === 1 && datesSent[0] === JSON.stringify({ starts_on: DAYS[3], ends_on: DAYS[5] }) && tripB.trip.starts_on === DAYS[3] && tripB.trip.ends_on === DAYS[5], JSON.stringify([datesSent, tripB.trip && tripB.trip.starts_on, tripB.trip && tripB.trip.ends_on]));
  check("…and the same sheet carries on to the plan: those three days, the name focused", f.days.join() === DAYS.slice(3, 6).join() && f.focus === "pe-title" && f.action === "Add", JSON.stringify(f));
  await first.type("#pe-title", "First swim");
  await first.tap('.sh-root [data-act="save"]', "Add");
  await first.sheetGone();
  await first.wait(LIST, "the Agenda of the trip that now has dates");
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the first plan of that trip sent");
  rows = await eventsOf(host, B);
  check("the plan is on that trip, on its first day", rows.length === 1 && rows[0].title === "First swim" && rows[0].starts_at === instant(DAYS[3], "00:00"), JSON.stringify(rows));

  // ── 10 ─────────────────────────────────────────────────────────────────────────────────────
  section("10. nothing shows through the pinned bars");
  // The day strip and the day heading under it stay put while the list scrolls beneath them.
  // Asked of the picture itself: at each place in the scroll, the bars' own pixels with the
  // list drawn are the bars' own pixels with the list hidden. "The same" allows what the
  // browser's own drawing does from one frame to the next (a pixel or two moving by 1 part in
  // 255): a line of the list seen through the old see-through bar moved hundreds of pixels by
  // 3. So: no more than four pixels may move by more than 1.
  await first.b.metrics(390, 520, 1);
  await first.open(idA, "#/", LIST, "the Agenda, on a short screen");
  // A plan added to a day that is off the bottom of the screen: the list goes to it.
  await first.page(`(document.querySelector("#view").scrollTop = 0, 1)`);
  await first.tap("#rt-fixed [data-plan-add]", "the + button");
  await first.sheet("Add a plan");
  await first.type("#pe-title", "Last walk");
  await first.tap(`.pe-day[data-day="${DAYS[6]}"]`, "the last day");
  await first.type("#pe-time", "08:15");
  await first.tap('.sh-root [data-act="save"]', "Add");
  await first.sheetGone();
  await sleep(900);
  const went = JSON.parse(await first.page(`JSON.stringify((() => {
    const view = document.querySelector("#view");
    const card = [...document.querySelectorAll("#view .ag-card")].find((c) => /Last walk/.test(c.textContent));
    if (!card) return { card: false };
    const r = card.getBoundingClientRect(), v = view.getBoundingClientRect();
    const strip = document.querySelector(".ag-strip").getBoundingClientRect();
    let floor = strip.bottom;
    for (const h of document.querySelectorAll(".ag-dayhead")) { const q = h.getBoundingClientRect(); if (q.top <= strip.bottom + 1 && q.bottom > floor) floor = q.bottom; }
    return { card: true, top: view.scrollTop, whole: r.top >= floor - 1 && r.bottom <= v.bottom + 1, r: [Math.round(r.top), Math.round(r.bottom)], floor: Math.round(floor), bottom: Math.round(v.bottom) };
  })())`));
  check("a plan added to a day off the bottom of the screen: the list goes to it, whole, below the bars", went.card && went.top > 0 && went.whole, JSON.stringify(went));
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "that plan sent");
  const barsAt = (top) => first.page(`(async () => {
    const view = document.querySelector("#view");
    view.scrollTop = ${top};
    await new Promise((r) => setTimeout(r, 320));
    const strip = document.querySelector(".ag-strip").getBoundingClientRect();
    let bottom = strip.bottom, pinned = "";
    for (const h of document.querySelectorAll(".ag-dayhead")) {
      const r = h.getBoundingClientRect();
      if (r.top <= strip.bottom + 1 && r.bottom > bottom) { bottom = r.bottom; pinned = h.closest(".ag-day").dataset.day; }
    }
    const under = (y0, y1) => [...document.querySelectorAll(".ag-list > *, .ag-stays > *")].filter((n) => {
      const r = n.getBoundingClientRect();
      return r.height > 0 && r.bottom > y0 + 2 && r.top < y1 - 2;
    }).length;
    return JSON.stringify({ at: view.scrollTop, max: view.scrollHeight - view.clientHeight, x: strip.left, y: Math.ceil(strip.top), w: strip.width, h: Math.floor(bottom) - Math.ceil(strip.top),
      pinned, underStrip: under(strip.top, strip.bottom), underHead: bottom > strip.bottom ? under(strip.bottom, bottom) : 0 });
  })()`).then(JSON.parse);
  const grab = async (g) => (await first.b.cdp.send("Page.captureScreenshot", { format: "png", clip: { x: g.x, y: g.y, width: g.w, height: g.h, scale: 1 } }, first.b.S)).data;
  const hideList = (off) => first.page(`(() => { for (const n of document.querySelectorAll(".ag-list, .ag-stays, .ag-lede")) n.style.visibility = ${off ? '"hidden"' : '""'}; return 1; })()`);
  // The two pictures, compared in the page: how far the furthest pixel moved, and how many moved past the allowance.
  const apart = (a, b) => first.page(`(async () => {
    const load = (d) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = "data:image/png;base64," + d; });
    const [ia, ib] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})]);
    if (ia.width !== ib.width || ia.height !== ib.height) return JSON.stringify({ most: 255, over: -1 });
    const px = (i) => { const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const g = c.getContext("2d"); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
    const pa = px(ia), pb = px(ib);
    let most = 0, over = 0;
    for (let k = 0; k < pa.length; k += 4) {
      const d = Math.max(Math.abs(pa[k] - pb[k]), Math.abs(pa[k + 1] - pb[k + 1]), Math.abs(pa[k + 2] - pb[k + 2]));
      if (d > most) most = d;
      if (d > 1) over++;
    }
    return JSON.stringify({ most, over });
  })()`).then(JSON.parse);
  const shown = [], passed = { strip: 0, head: 0, places: 0, most: 0 };
  for (const theme of ["light", "dark"]) {
    await first.page(`(document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)}), document.documentElement.setAttribute("data-lum", ${JSON.stringify(theme)}), 1)`);
    await sleep(500);
    const max = (await barsAt(0)).max;
    for (let top = 0; top <= max; top += 17) {
      const g = await barsAt(top);
      if (!g.underStrip && !g.underHead) continue;
      passed.places++; passed.strip += g.underStrip ? 1 : 0; passed.head += g.underHead ? 1 : 0;
      const drawn = await grab(g);
      await hideList(true);
      await sleep(60);
      const bare = await grab(g);
      await hideList(false);
      const d = drawn === bare ? { most: 0, over: 0 } : await apart(drawn, bare);
      passed.most = Math.max(passed.most, d.most);
      if (d.over < 0 || d.over > 4) {
        if (SHOTS && !shown.length) {
          fs.writeFileSync(path.join(SHOTS, "bars-with-the-list.png"), Buffer.from(drawn, "base64"));
          fs.writeFileSync(path.join(SHOTS, "bars-without-the-list.png"), Buffer.from(bare, "base64"));
        }
        shown.push(`${theme} at ${g.at}px: ${d.over} pixels, the furthest by ${d.most} (heading ${g.pinned || "none"}, ${g.underStrip} under the strip, ${g.underHead} under the heading)`);
      }
    }
  }
  await first.page(`(document.documentElement.removeAttribute("data-theme"), document.documentElement.removeAttribute("data-lum"), 1)`);
  check("the list did pass under the strip and under a pinned heading", passed.strip >= 6 && passed.head >= 6, JSON.stringify(passed));
  check("at every such place, in both themes, the bars look the same with the list hidden", passed.places > 0 && shown.length === 0,
    shown.length ? `${shown.length} of ${passed.places}: ${shown.slice(0, 4).join("; ")}` : `${passed.places} places; the furthest any pixel moved: ${passed.most} in 255`);
  await first.b.metrics(390, 844, 1);

  // ── 11 ─────────────────────────────────────────────────────────────────────────────────────
  // The flight from home leaves from home's zone. New York 18:00 on the trip's first day, Lisbon
  // 06:05 the next morning, added on the phone set to Auckland: three zones, one plan.
  section("11. leaving from another time zone");
  const NY = "America/New_York";
  await first.open(idA, "#/", LIST, "the Agenda");
  await first.tap("#rt-fixed .fab[data-plan-add]", "the + button");
  await first.sheet("Add a plan");
  const zonesOf = () => first.page(`JSON.stringify({
    open: [...document.querySelectorAll(".pe-zopen")].map((n) => n.dataset.side + ":" + n.getAttribute("aria-expanded") + ":" + n.textContent.trim()),
    fields: [...document.querySelectorAll(".pe-zone")].map((n) => n.dataset.side + ":" + n.querySelector("input").value),
    list: [...document.querySelectorAll(".tr-zone-list:not([hidden]) .tr-zone-opt")].map((n) => n.innerText.replace(/\\s+/g, " ").trim()).slice(0, 3),
  })`).then(JSON.parse);
  await first.type("#pe-title", "Flight from home");
  let z = await zonesOf();
  check("a Plan offers no zones", z.open.length === 0 && z.fields.length === 0, JSON.stringify(z));
  await first.tap('.pe-kind[data-kind="flight"]', "Flight");
  z = await zonesOf();
  check("a Flight offers both, closed: the trip's zone until one is opened",
    z.open.join("|") === "from:false:Leaves from another time zone|to:false:Arrives in another time zone" && z.fields.length === 0, JSON.stringify(z));
  await first.tap('.pe-kind[data-kind="transit"]', "Transit");
  check("so does a Transit", (await zonesOf()).open.length === 2);
  await first.tap('.pe-kind[data-kind="flight"]', "Flight");
  await first.tap(`.pe-day[data-day="${DAYS[0]}"]`, "the first day");
  await first.type("#pe-time", "18:00");
  await first.type("#pe-end", "06:05");
  f = await first.form();
  check("in the trip's zone alone, 18:00 to 06:05 is the next morning, as for a night bus", f.endDay === DAYS[1] && /^Ends the next day/.test(f.hint), `${f.hint} / ${f.endDay}`);
  await first.tap('.pe-zopen[data-side="from"]', "Leaves from another time zone");
  f = await first.form();
  z = await zonesOf();
  check("opened: a field to find the zone by its city, with the focus in it, and a way back",
    z.fields.join() === "from:" && f.focus === "pe-fromzone" && (await first.page(`document.querySelector('[data-act="zone-close"][data-side="from"]') ? 1 : 0`)) === 1, JSON.stringify({ z, focus: f.focus }));
  before = first.writes.length;
  await first.tap('.sh-root [data-act="save"]', "Add, with the zone not chosen");
  f = await first.form();
  check("Add with the zone not chosen: a sentence under it, nothing sent",
    f.said.length === 1 && /^fromzone: Choose the time zone it leaves from/.test(f.said[0]) && first.writes.length === before && f.focus === "pe-fromzone", JSON.stringify(f.said) + " " + f.focus);
  await first.type("#pe-fromzone", "new york");
  z = await zonesOf();
  check('"new york" finds New York first, with its country and its offset that day', /^New York, United States GMT-[45]$/.test(z.list[0] || ""), JSON.stringify(z.list));
  await first.look("sheet-zone-list");
  await first.wait(`document.querySelector(".tr-zone-list:not([hidden]) .tr-zone-opt") ? 1 : 0`, "the zone list's first choice");
  await first.page(`(document.querySelector(".tr-zone-list:not([hidden]) .tr-zone-opt").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true })), 1)`);
  await sleep(250);
  z = await zonesOf();
  f = await first.form();
  check("chosen: the field says the city, its country and its offset; the sentence is gone", /^from:New York, United States · GMT-[45]$/.test(z.fields.join()) && f.said.length === 0, JSON.stringify({ z, said: f.said }));
  check("the line under the times says each time on its own zone's clock, and the day it lands",
    /^Leaves at 18:00, New York time\. Arrives the next day, \w{3} \d{1,2} \w{3}, at 06:05 Lisbon time\.$/.test(f.hint) && f.endDay === DAYS[1], `${f.hint} / ${f.endDay}`);
  await first.look("sheet-zone-chosen");
  // The arrival side, opened and closed again, leaves the arrival in the trip's zone.
  await first.tap('.pe-zopen[data-side="to"]', "Arrives in another time zone");
  await first.tap('[data-act="zone-close"][data-side="to"]', "The trip's time zone");
  f = await first.form();
  z = await zonesOf();
  check("closed again: the button is back, with the focus on it", z.open.join() === "to:false:Arrives in another time zone" && f.focus === "zone-open", JSON.stringify({ z, focus: f.focus }));
  before = first.writes.length;
  await first.tap('.sh-root [data-act="save"]', "Add");
  await first.sheetGone();
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the flight sent");
  post = JSON.parse((first.writes.slice(before).find((w) => w.method === "POST") || { body: "{}" }).body);
  const leaves = instantIn(DAYS[0], "18:00", NY), lands = instantIn(DAYS[1], "06:05", ZONE);
  check("sent: it leaves at 18:00 New York time and lands at 06:05 Lisbon time the next day",
    post.starts_at === leaves && post.ends_at === lands && post.tz === NY && post.end_tz === ZONE && post.kind === "flight", JSON.stringify({ post, want: [leaves, lands] }));
  // Twelve hours and five minutes on the clocks, less the hours between the two zones: five for
  // most of the year, four in the weeks when only one of them has changed its clocks.
  check("…which is the clocks' twelve hours and five minutes less the hours between the zones", [6, 7].includes((lands - leaves - 5 * 60) / 3600), `${(lands - leaves) / 60} minutes in the air`);
  rows = await eventsOf(host, A);
  const flight = rows.find((r) => r.title === "Flight from home");
  check("the server keeps both zones", !!flight && flight.tz === NY && flight.end_tz === ZONE && flight.starts_at === leaves && flight.ends_at === lands, JSON.stringify(flight));
  await sleep(600);
  const cardOf = (ag) => { for (const d of ag.days) for (const c of d.cards) if (/Flight from home/.test(c)) return { day: d.day, text: c }; return null; };
  let card = cardOf(await first.agenda());
  const phoneSays = await first.page(`new Intl.DateTimeFormat("en-CA", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(${leaves} * 1000))`);
  check("on the Agenda it is on the day it leaves, each end at its own clock with its zone, though this phone's clock says another day",
    !!card && card.day === DAYS[0] && /18:00/.test(card.text) && /06:05/.test(card.text) && !phoneSays.startsWith(DAYS[0]), JSON.stringify({ card, phoneSays }));
  // The zones are chips of letters, or GMT and the hours. Never a bare signed number, which
  // beside the weekday an arrival lands on ("06:05 +00 Wed") would read as a count of days.
  const chips = JSON.parse(await first.page(`JSON.stringify([...document.querySelectorAll("#view .ag-card")].filter((c) => /Flight from home/.test(c.innerText)).flatMap((c) => [...c.querySelectorAll(".ag-tz")].map((n) => n.textContent.trim())))`));
  check("its two zones are chips of letters, or GMT and the hours: neither is a bare signed number",
    chips.length === 2 && chips.every((c) => /^(?:[A-Z]{2,5}|GMT[+-]\d{1,2}(?::\d{2})?)$/.test(c)) && /^E[SD]T$/.test(chips[0]) && /^(GMT|GMT\+1)$/.test(chips[1]), JSON.stringify(chips));
  // Each end of the plan is one piece: a zone chip sits on its own time's line, and the arrow
  // on the line of the time it points to, however the card wraps. Measured as the card is,
  // and again with its row of times squeezed to 70 px, where the line has to break.
  const endsOf = (squeeze) => first.page(`JSON.stringify([...document.querySelectorAll("#view .ag-card")].filter((c) => /Flight from home/.test(c.innerText)).flatMap((c) => {
    const when = c.querySelector(".ag-when");
    if (${squeeze}) when.style.width = "70px";
    const out = [...c.querySelectorAll(".ag-end")].map((end) => {
      const mids = [...end.children].map((n) => { const r = n.getBoundingClientRect(); return Math.round(r.top + r.height / 2); });
      return { words: end.innerText.replace(/\\s+/g, " ").trim(), spread: Math.max(...mids) - Math.min(...mids), mid: Math.round(mids.reduce((a, m) => a + m, 0) / mids.length) }; });
    when.style.width = "";
    return out; }))`).then(JSON.parse);
  const ends = await endsOf(false), squeezed = await endsOf(true);
  check("each end's clock, zone and weekday share a line, and the arrow is with the end it points to",
    ends.length === 2 && ends.every((e) => e.spread <= 6) && /^18:00 E[SD]T$/.test(ends[0].words) && /^→ 06:05 (GMT|GMT\+1) \w{3}$/.test(ends[1].words), JSON.stringify(ends));
  check("squeezed until the line breaks, it breaks between the two ends, never inside one",
    squeezed.length === 2 && squeezed.every((e) => e.spread <= 6) && squeezed[1].mid - squeezed[0].mid >= 12, JSON.stringify(squeezed));
  await first.look("agenda-flight");
  // The other person, in the trip's own zone, sees the same plan on the same day.
  await second.open(idA, "#/", LIST, "the Agenda, the other phone");
  await second.wait(`[...document.querySelectorAll("#view .ag-card")].some((c) => /Flight from home/.test(c.innerText)) ? 1 : 0`, "the flight on the other phone");
  const ag2 = await second.agenda();
  let c2 = null; for (const d of ag2.days) for (const c of d.cards) if (/Flight from home/.test(c)) c2 = { day: d.day, text: c };
  check("the other phone has it on the same day at the same clocks", !!c2 && c2.day === DAYS[0] && /18:00/.test(c2.text) && /06:05/.test(c2.text), JSON.stringify(c2));
  // Changed again: it opens with its zone showing, and saved unchanged writes nothing.
  await first.page(`(() => { const c = [...document.querySelectorAll("#view .ag-card")].find((n) => /Flight from home/.test(n.innerText)); c.click(); return 1; })()`);
  await first.wait(`document.querySelector("#view").dataset.route === "event" && document.querySelector("[data-plan-change]") ? 1 : 0`, "the flight's page");
  await sleep(400);
  await first.look("flight-page");
  await first.tap("[data-plan-change]", "Change");
  await first.sheet("Change plan");
  f = await first.form();
  z = await zonesOf();
  check("Change opens with New York showing, the arrival in the trip's zone, the times as typed",
    /^from:New York, United States · GMT-[45]$/.test(z.fields.join()) && z.open.join() === "to:false:Arrives in another time zone" && f.time === "18:00" && f.end === "06:05" && f.endDay === DAYS[1] && f.day === DAYS[0], JSON.stringify({ z, f }));
  before = first.writes.length;
  await first.tap('.sh-root [data-act="save"]', "Save, unchanged");
  await first.sheetGone();
  await sleep(500);
  check("saved unchanged, nothing is written", first.writes.slice(before).filter((w) => w.method !== "GET").length === 0, JSON.stringify(first.writes.slice(before)));
  // The way home: from the trip's zone, arriving in New York's.
  await first.open(idA, "#/", LIST, "the Agenda");
  await first.tap("#rt-fixed .fab[data-plan-add]", "the + button");
  await first.sheet("Add a plan");
  await first.type("#pe-title", "Flight home");
  await first.tap('.pe-kind[data-kind="flight"]', "Flight");
  await first.tap(`.pe-day[data-day="${DAYS[6]}"]`, "the last day");
  await first.type("#pe-time", "11:30");
  await first.type("#pe-end", "14:10");
  await first.tap('.pe-zopen[data-side="to"]', "Arrives in another time zone");
  await first.type("#pe-tozone", "new york");
  await first.wait(`document.querySelector(".tr-zone-list:not([hidden]) .tr-zone-opt") ? 1 : 0`, "the zone list's first choice");
  await first.page(`(document.querySelector(".tr-zone-list:not([hidden]) .tr-zone-opt").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true })), 1)`);
  await sleep(250);
  f = await first.form();
  check("the way home lands the same day: an earlier clock, a later moment", f.endDay === "" && /^Leaves at 11:30, Lisbon time\. Arrives the same day, at 14:10 New York time\.$/.test(f.hint), `${f.hint} / ${f.endDay}`);
  before = first.writes.length;
  await first.tap('.sh-root [data-act="save"]', "Add");
  await first.sheetGone();
  await first.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the flight home sent");
  post = JSON.parse((first.writes.slice(before).find((w) => w.method === "POST") || { body: "{}" }).body);
  check("…sent leaving in the trip's zone and landing in New York's", post.tz === ZONE && post.end_tz === NY && post.starts_at === instantIn(DAYS[6], "11:30", ZONE) && post.ends_at === instantIn(DAYS[6], "14:10", NY), JSON.stringify(post));

  check("no page error in either browser", first.b.pageErrors.length === 0 && second.b.pageErrors.length === 0, [...first.b.pageErrors, ...second.b.pageErrors].join(" | "));
} catch (e) {
  fail++; failures.push("the check ran to its end");
  console.log(`  FAIL  the check ran to its end   -> ${e && e.stack ? e.stack : e}`);
} finally {
  for (const b of phones) await b.done().catch(() => {});
  await server.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(fail ? 1 : 0);
