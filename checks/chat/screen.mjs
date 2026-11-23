// The chat's screen (public/js/chat.js, public/js/chat-dot.js), in a real browser: two people on
// one trip, each in a page of their own (Chrome for Testing), against a real server.
//
//   node checks/chat/screen.mjs [--port 8791]      (through the channel's queue, like every browser check)
//
// 1. Both ways within seconds, by the trip's socket; a run of one person's messages shows its
//    time once, and a tap shows the others'.
// 2. About a thing: held above the box from another screen (chatAbout), sent, drawn as a card on
//    the other page, and the card opens the thing.
// 3. Without signal: a message waits, says so, and lands in the server's order when the signal
//    is back; while it waits, signing out would count it.
// 4. Edit and delete one's own; the host deletes someone else's; what's left in place; the sheet
//    offers Copy on anyone's message and Edit/Delete only where they're allowed.
// 5. Refused for good (about a thing deleted meanwhile): the server's reason, Try again, Remove.
// 6. Words are text: markup is shown as written, an http(s) address is a link out (no referrer).
// 7. Paging back: "Earlier messages" brings the older ones, and the message being read stays put.
// 8. The unread mark: someone else's message while in another section marks Other (Chat isn't in
//    the bar) with words; one's own never does; opening the chat clears it.
// 9. The keyboard: with a 336 px keyboard taken out of a phone's viewport, the box, the last
//    message and the held thing stay on glass.
// 10a. What the server sends is never markup: hostile values from a stand-in snapshot stay in their attributes.
// 10. Signing out empties the chat's database.
//
// Its server and browser are its own. Everyone in it is made up.

import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8791);
const t = new Report("the chat's screen");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server, chrome;
let code = 1;
const errorsFrom = [];

// The keyboard, faked the way a synthetic keyboard harness fakes it: the
// visual viewport's height shrinks and the events fire; the layout viewport stays (iOS standalone).
const VV_SHIM = `(() => {
  const vv = window.visualViewport;
  if (!vv) return;
  const p = Object.getPrototypeOf(vv);
  const gh = Object.getOwnPropertyDescriptor(p, "height").get;
  window.__kb = { h: 0 };
  Object.defineProperty(p, "height", { configurable: true, get() { return gh.call(this) - window.__kb.h; } });
  window.__setKb = (h) => { window.__kb = { h }; vv.dispatchEvent(new Event("resize")); vv.dispatchEvent(new Event("scroll")); };
})();`;

const SEND = (text) => `(() => { const i = document.querySelector('.ch-input'); i.value = ${JSON.stringify(text)};
  i.dispatchEvent(new Event('input')); document.querySelector('.ch-box').requestSubmit(); return true; })()`;
const BODIES = "[...document.querySelectorAll('.ch-msg')].map((m) => ({ id: m.dataset.id, text: m.querySelector('.ch-body, .ch-deleted')?.textContent ?? '', mine: m.classList.contains('ch-mine'), waiting: m.classList.contains('ch-waiting'), state: m.querySelector('.ch-state')?.textContent ?? '' }))";

try {
  server = await startServer({ name: "chat-screen", port });
  await server.start();
  const hana = new Person(server.origin, "Hana Screen");
  const kai = new Person(server.origin, "Kai Screen");
  for (const p of [hana, kai]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  const T = (await hana.post("/api/trips", { name: "Chat on screen", default_tz: "UTC", starts_on: "2027-04-01", ends_on: "2027-04-09" })).json.trip.id;
  await hana.call("PUT", `/api/trips/${T}/places`, { places: [{ id: "p-stay", name: "Casa Prueba", kind: "lodging", subkind: "hostel", why: "Where we sleep." }] });
  await hana.post(`/api/trips/${T}/events`, { id: "e-walk", title: "Sunrise walk", starts_at: Date.UTC(2027, 3, 2, 6) / 1000, tz: "UTC" });
  await hana.post(`/api/trips/${T}/events`, { id: "e-soon-gone", title: "A tour that gets cancelled", starts_at: Date.UTC(2027, 3, 3, 9) / 1000, tz: "UTC" });
  const link = await hana.post(`/api/trips/${T}/links`, { uses: 1 });
  await kai.post(`/api/join/${link.json.link.code}`);

  chrome = await openChrome();
  const open = async (p, { shim = false } = {}) => {
    const page = await chrome.page({ width: 390, height: 844, mobile: true, ...(shim ? { before: VV_SHIM } : {}) });
    await page.setCookie(server.origin, "wgp_session", p.jar.cookies.get("wgp_session"));
    await page.goto(`${server.origin}/t/${T}/#/chat`);
    await page.until("document.querySelector('.ch-feed')", "the chat", 20000);
    return page;
  };
  const H = await open(hana);
  const K = await open(kai, { shim: true });
  await K.until("!document.querySelector('.ch-empty').hidden", "the empty chat");
  t.same("an empty chat says so, and says what a person does to talk about a thing",
    await K.eval("document.querySelector('.ch-empty').innerText.replace(/\\s+/g, ' ').trim()"),
    "No messages yet Everyone on the trip sees what's written here. Press \"Chat about this\" on a plan, a place or a purchase to talk about it here.");

  t.part("1. Both ways, within seconds");
  let at = Date.now();
  await H.eval(SEND("Morning! Bags by the door at 6:30."));
  await K.until(`document.body.innerText.includes('Bags by the door')`, "Hana's message on Kai's page", 10000);
  const hk = Date.now() - at;
  at = Date.now();
  await K.eval(SEND("On my way down"));
  await H.until(`document.body.innerText.includes('On my way down')`, "Kai's message on Hana's page", 10000);
  const kh = Date.now() - at;
  t.ok(`Hana's message reaches Kai's open chat (${hk} ms) and Kai's reaches Hana's (${kh} ms)`, hk < 5000 && kh < 5000);
  for (const w of ["One", "Two", "Three"]) await H.eval(SEND(`${w} more thing`));
  await K.until("document.body.innerText.includes('Three more thing')", "Hana's run");
  await sleep(300);
  const times = await K.eval(`[...document.querySelectorAll('.ch-msg')].filter((m) => /more thing/.test(m.textContent)).map((m) => { const t = m.querySelector('time'); const r = t.getBoundingClientRect(); return r.width > 2 && r.height > 2; })`);
  t.same("a run of one person's messages shows its time once, on the last", times, [false, false, true]);
  await K.eval(`(() => { [...document.querySelectorAll('.ch-msg')].find((m) => /One more thing/.test(m.textContent)).querySelector('.ch-bubble').click(); return true; })()`);
  await sleep(150);
  t.ok("  (a tap on one shows its own time)", await K.eval(`(() => { const t = [...document.querySelectorAll('.ch-msg')].find((m) => /One more thing/.test(m.textContent)).querySelector('time').getBoundingClientRect(); return t.width > 2; })()`));

  t.part("2. About a thing");
  await H.eval("location.hash = '#/', true");
  await H.until("!document.querySelector('.ch')", "the agenda");
  await H.eval(`import('/js/chat.js').then((m) => { m.chatAbout('event', 'e-walk'); return true; })`);
  await H.until("document.querySelector('.ch-card-held')", "the event held above the box");
  const heldText = await H.eval("document.querySelector('.ch-card-held').innerText");
  await H.eval(SEND("Is this still on if it rains?"));
  await K.until("[...document.querySelectorAll('.ch-msg')].some((m) => m.querySelector('a.ch-card') && /if it rains/.test(m.textContent))", "the card on Kai's page", 10000);
  const card = await K.eval("(() => { const a = [...document.querySelectorAll('.ch-msg')].find((m) => /if it rains/.test(m.textContent)).querySelector('a.ch-card'); return { href: a.getAttribute('href'), text: a.innerText }; })()");
  t.same("chatAbout from the agenda holds the plan above the box; sent, it's a card over the words on Kai's page, named a plan as the app names it, linking to it",
    [/Sunrise walk/.test(heldText), card.href, /Sunrise walk/.test(card.text), /^PLAN|^Plan/.test(card.text)], [true, "#/e/e-walk", true, true]);
  await K.eval("(() => { [...document.querySelectorAll('a.ch-card')].pop().click(); return true; })()");
  await K.until("location.hash === '#/e/e-walk'", "the event opened");
  t.ok("  (the card opens the event)", true);
  await K.eval("location.hash = '#/chat', true");
  await K.until("document.querySelector('.ch-feed .ch-msg')", "the chat again");

  t.part("3. Without signal");
  await K.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await K.eval(SEND("Sent from the pass, no signal"));
  await K.until("document.querySelector('.ch-waiting')", "the waiting message");
  const waitingNow = await K.eval(`(() => { const w = document.querySelector('.ch-waiting'); return { text: w.innerText, dashed: getComputedStyle(w.querySelector('.ch-bubble')).borderStyle }; })()`);
  const counted = await K.eval("import('/js/forget.js').then((m) => m.waitingChanges())");
  t.same("offline, the message shows as waiting (a clock, the words, a dashed edge), and signing out would count it",
    [/Waiting to send/.test(waitingNow.text), waitingNow.dashed, counted >= 1], [true, "dashed", true]);
  await H.eval(SEND("Anyone there?"));
  await sleep(500);
  await K.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await K.eval("dispatchEvent(new Event('online')), true");
  await K.until("!document.querySelector('.ch-waiting')", "the waiting message sent", 20000);
  await H.until("document.body.innerText.includes('Sent from the pass')", "the late message on Hana's page", 10000);
  const order = await H.eval(`[...document.querySelectorAll('.ch-msg')].map((m) => m.textContent).filter((x) => /Anyone there|Sent from the pass/.test(x)).map((x) => /Anyone/.test(x) ? "anyone" : "pass")`);
  t.same("back online it lands, and takes the server's order: after Hana's message sent while it waited", order, ["anyone", "pass"]);

  t.part("3b. What waits is sent without opening the chat");
  {
    // The chat's sends fail (the rest of the app is online), so a message waits.
    await K.requests(`*/api/trips/${T}/messages*`, "fail");
    await K.eval(SEND("Written on the pass"));
    await K.until("[...document.querySelectorAll('.ch-waiting')].some((m) => /Written on the pass/.test(m.textContent))", "the message waiting");
    // Signing out with it still waiting: the account page counts it and says so.
    await K.goto(`${server.origin}/account`);
    await K.until("!document.getElementById('account')?.hidden && !!document.getElementById('btn-signout')", "the account page", 20000);
    await K.click("#btn-signout");
    await K.until("document.getElementById('btn-signout').classList.contains('lg-armed')", "Sign out to ask");
    const ask = await K.eval("document.getElementById('btn-signout').textContent");
    t.same("signing out with a chat message still waiting counts it and says so, asking again", ask, "1 change hasn't been sent. Tap again to sign out");
    // Not signed out: the app opens on the Agenda, the chat never opened, and the signal is back.
    await K.requests(`*/api/trips/${T}/messages*`, "off");
    await K.goto(`${server.origin}/t/${T}/#/`);
    const sentAt = Date.now();
    await H.until("document.body.innerText.includes('Written on the pass')", "the waiting message on Hana's page", 20000);
    t.same(`opened on the Agenda, the app sends what waited in the chat without the chat being opened, and Hana's chat shows it (${Date.now() - sentAt} ms)`,
      [await K.eval("!!document.querySelector('.ch')"), await K.eval("location.hash")], [false, "#/"]);
    await K.eval("location.hash = '#/chat', true");
    await K.until("!!document.querySelector('.ch-input') && !document.querySelector('.ch-waiting')", "Kai's chat with nothing waiting");
  }

  t.part("4. Changing and deleting");
  const sheetOf = async (page, re) => {
    // The message drawn first: a page just opened (3b reloads Kai's) draws its chat a moment later.
    await page.until(`[...document.querySelectorAll('.ch-msg')].some((m) => ${re}.test(m.textContent))`, `the message ${re}`, 15000);
    await page.eval(`(() => { const b = [...document.querySelectorAll('.ch-msg')].find((m) => ${re}.test(m.textContent)).querySelector('.ch-bubble'); b.focus(); b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
    await page.until("document.querySelector('.ch-acts')", "the message's sheet");
    const acts = await page.eval("[...document.querySelectorAll('.ch-acts [data-do]')].map((b) => b.dataset.do)");
    return acts;
  };
  const tap = (page, act) => page.eval(`(() => { document.querySelector('.ch-acts [data-do="${act}"]').click(); return true; })()`);
  const kaiOnHana = await sheetOf(K, "/Bags by the door/");
  await tap(K, "copy");
  await sleep(400);
  const kaiOnOwn = await sheetOf(K, "/On my way down/");
  t.same("the sheet: Copy on anyone's message; Edit and Delete on one's own", [kaiOnHana, kaiOnOwn], [["copy"], ["copy", "edit", "delete"]]);
  // The first focus never lands on what destroys (scripts/first_focus_check.mjs names this sheet).
  await K.until("document.activeElement && document.activeElement.closest('.ch-acts')", "the focus in the sheet");
  const focused = await K.eval("document.activeElement.dataset.do ?? document.activeElement.className");
  // A real Enter, as the keyboard sends it (scripts/first_focus_check.mjs's own).
  for (const type of ["keyDown", "keyUp"]) {
    await K.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r", unmodifiedText: "\r" } : {}) });
  }
  await K.until("!document.querySelector('.ch-acts')", "the sheet closed");
  await sleep(600);
  t.same("  (the sheet opens with the focus on Copy, not Delete, and a real Enter there deletes nothing)",
    [focused, await K.eval("[...document.querySelectorAll('.ch-msg')].some((m) => /On my way down/.test(m.textContent) && !m.querySelector('.ch-deleted'))")], ["copy", true]);
  await sheetOf(K, "/On my way down/");
  await tap(K, "edit");
  await K.until("document.querySelector('.ch-editing')", "editing");
  await K.eval(SEND("On my way down, ten minutes"));
  await H.until("document.body.innerText.includes('ten minutes')", "the edit on Hana's page", 10000);
  const edited = await H.eval(`[...document.querySelectorAll('.ch-msg')].find((m) => /ten minutes/.test(m.textContent)).innerText`);
  t.ok("Kai edits his own: Hana's page shows the new words, \"edited\"", /edited/.test(edited), edited);
  await sheetOf(K, "/ten minutes/");
  await tap(K, "delete");
  await H.until("[...document.querySelectorAll('.ch-deleted')].some((d) => d.textContent === 'Message deleted')", "the delete on Hana's page", 10000);
  t.ok("Kai deletes his own: \"Message deleted\" stays in its place on Hana's page", true);
  const hostOnKai = await sheetOf(H, "/Sent from the pass/");
  await tap(H, "delete");
  await K.until("[...document.querySelectorAll('.ch-deleted')].some((d) => d.textContent === 'Message deleted by the host')", "the host's delete on Kai's page", 10000);
  t.same("the host deletes Kai's message: her sheet offers it, and Kai's page says \"Message deleted by the host\"", hostOnKai, ["copy", "delete"]);

  t.part("5. Refused for good");
  await K.eval("location.hash = '#/', true");
  await K.until("!document.querySelector('.ch')", "Kai's agenda");
  await K.eval(`import('/js/chat.js').then((m) => { m.chatAbout('event', 'e-soon-gone'); return true; })`);
  await K.until("document.querySelector('.ch-card-held')", "the held tour");
  await hana.call("DELETE", `/api/trips/${T}/events/e-soon-gone`);
  await K.eval(SEND("Shall we book the tour?"));
  await K.until("document.querySelector('.ch-failed')", "the refusal", 10000);
  const failed = await K.eval("document.querySelector('.ch-waiting').innerText");
  t.ok("a message about a thing deleted meanwhile: \"Not sent\" with the server's own reason, Try again and Remove",
    /Not sent: There's no event/.test(failed) && /Try again/.test(failed) && /Remove/.test(failed), failed);
  await K.eval("(() => { document.querySelector('[data-act=discard]').click(); return true; })()");
  await K.until("!document.querySelector('.ch-waiting')", "removed");
  t.ok("  (Remove takes it away, and nothing waits)", (await K.eval("import('/js/forget.js').then((m) => m.waitingChanges())")) === 0);

  t.part("6. Words are text");
  await H.eval(SEND(`<img src=x onerror="window.__pwned=1"> <b>bold?</b> see https://example.com/a?b=1&c=2. and javascript:alert(1)`));
  await K.until("document.body.innerText.includes('bold?')", "the markup message");
  const words = await K.eval(`(() => { const m = [...document.querySelectorAll('.ch-msg')].find((x) => /bold\\?/.test(x.textContent)); const a = m.querySelectorAll('.ch-body a');
    return { text: m.querySelector('.ch-body').textContent, imgs: m.querySelectorAll('img').length, bolds: m.querySelectorAll('.ch-body b').length,
      links: [...a].map((l) => [l.getAttribute('href'), l.target, l.rel, l.referrerPolicy, l.textContent]), pwned: window.__pwned ?? 0 }; })()`);
  t.same("markup shows as written (no image, no bold, nothing ran); the address is a link out, no referrer, its full stop left outside; javascript: is not a link",
    [words.imgs, words.bolds, words.pwned, words.links, /<img src=x/.test(words.text)],
    [0, 0, 0, [["https://example.com/a?b=1&c=2", "_blank", "noopener noreferrer", "no-referrer", "https://example.com/a?b=1&c=2"]], true]);

  t.part("7. Paging back");
  // Seventy more, written straight into the database (one person may send 30 a minute).
  const s0 = server.sql(`SELECT message_seq AS s, rev FROM trips WHERE id = '${T}'`)[0];
  const now = Math.floor(Date.now() / 1000);
  server.sql(`INSERT INTO messages (trip_id, id, seq, touched, author, body, about_name, created_at, rev) VALUES ` +
    Array.from({ length: 70 }, (_, i) => `('${T}', 'old-${i}', ${s0.s + i + 1}, ${s0.s + i + 1}, '${hana.user.id}', 'Message number ${i}', '', ${now - 3600 + i}, ${s0.rev})`).join(", "));
  server.sql(`UPDATE trips SET message_seq = ${s0.s + 70}, rev = rev + 1 WHERE id = '${T}'`);
  const K2 = await open(kai);
  await K2.until("document.querySelectorAll('.ch-msg').length >= 50", "the newest window");
  const first = await K2.eval("document.querySelectorAll('.ch-msg').length");
  await K2.eval("document.getElementById('view').scrollTop = 0, true");
  // Measured by its words: once older ones arrive the message joins their run and drops its name
  // line, so its box changes, while what is being read must stay put.
  const anchor = await K2.eval("(() => { const m = document.querySelector('.ch-msg'); return { id: m.dataset.id, top: Math.round(m.querySelector('.ch-body').getBoundingClientRect().top) }; })()");
  await K2.eval("(() => { document.querySelector('[data-act=older]').click(); return true; })()");
  await K2.until(`document.querySelectorAll('.ch-msg').length > ${first}`, "the older messages");
  await sleep(300);
  const after = await K2.eval(`(() => { const m = document.querySelector('.ch-msg[data-id="${anchor.id}"]'); return { top: Math.round(m.querySelector('.ch-body').getBoundingClientRect().top), n: document.querySelectorAll('.ch-msg').length }; })()`);
  t.ok(`"Earlier messages" brings older ones (${first} → ${after.n}), and the words being read stay where they were (${anchor.top} → ${after.top} px)`,
    after.n > first && Math.abs(after.top - anchor.top) <= 2, { anchor, after });

  t.part("8. The unread mark");
  await K.eval("location.hash = '#/', true");
  await K.until("!document.querySelector('.ch')", "Kai's agenda");
  await sleep(1500);
  const before = await K.eval("document.documentElement.hasAttribute('data-chat-unread')");
  await H.eval("location.hash = '#/chat', true");
  await H.until("document.querySelector('.ch-input')", "Hana's chat");
  await H.eval(SEND("Dinner at eight?"));
  await K.until("document.documentElement.hasAttribute('data-chat-unread')", "the dot on Kai's page", 10000).catch(async (e) => {
    console.log("    (what Kai's page holds:", JSON.stringify(await K.eval(`Promise.all([import('/js/chat-dot.js').then((m) => m.chatDotState()), import('/js/live.js').then((m) => m.live.state()), import('/js/store.js').then((m) => [m.store.tripId(), m.store.me().id]), Promise.resolve(Object.entries(localStorage).filter(([k]) => k.startsWith('wgp.chat'))), Promise.resolve(location.hash)])`)), ")");
    throw e;
  });
  // Chat is on the bar for everyone, so the dot is on its own tab (its data-new, the design system's .ds-tab-dot),
  // and More (your picture, .head-more) isn't marked.
  const mark = await K.eval(`(() => { const c = document.querySelector('.tabbar .tab[data-tab="chat"]'), o = document.querySelector('.head-more');
    return { label: c.getAttribute('aria-label'), dot: c.hasAttribute('data-new'), more: o.getAttribute('aria-label'), moreDot: o.hasAttribute('data-new') }; })()`);
  t.same("someone else's message while Kai is in the agenda: the Chat tab is marked, with \"new messages\" in its name; More isn't",
    [before, mark.label, mark.dot, mark.more, mark.moreDot], [false, "Chat, new messages", true, "More", false]);
  await K.eval("location.hash = '#/chat', true");
  await K.until("document.querySelector('.ch-input') && !document.documentElement.hasAttribute('data-chat-unread')", "the mark cleared");
  t.ok("  (opening the chat clears it)", true);
  // Back in the chat, what was said while Kai was away is drawn: the socket's pokes reach the chat
  // only while it is open, so opening it again reads what changed (before, it stayed missing until
  // the next message). And read means drawn: the chat marks reading as far as what it painted.
  const drawn = await K.until("[...document.querySelectorAll('.ch-msg')].some((m) => /Dinner at eight/.test(m.textContent))", "Hana's message drawn in Kai's chat", 10000).then(() => true, () => false);
  t.ok("  (back in the chat, Hana's message, sent while Kai was away, is drawn without another message to bring it)", drawn);
  await K.eval(SEND("Yes, eight"));
  await K.eval("location.hash = '#/', true");
  await sleep(2500);
  t.same("  (Kai's own message never marks it)", await K.eval("document.documentElement.hasAttribute('data-chat-unread')"), false);

  t.part("8b. New messages on Your trips");
  {
    const row = (page) => page.eval(`(() => { const r = [...document.querySelectorAll("#list .tr-trip")][0]; const a = r?.querySelector("a.tr-new");
      return a ? { words: a.textContent.trim(), href: a.getAttribute("href"), label: a.getAttribute("aria-label"), icon: !!a.querySelector("svg") } : null; })()`);
    const trips = async () => { await K.goto(`${server.origin}/trips`); await K.until(`!document.getElementById("page").hidden`, "Your trips"); };
    await trips();
    const before = await row(K);
    await H.eval(SEND("Bring cash for the bus"));
    await H.until("!document.querySelector('.ch-waiting') && document.body.innerText.includes('Bring cash for the bus')", "Hana's message sent");
    await trips();
    const marked = await row(K);
    t.same("someone else's message since Kai last read the chat: his Your trips marks that trip, a pill with an icon and its words, opening its chat",
      [before, marked], [null, { words: "New messages", href: `/t/${T}/#/chat`, label: "New messages in Chat on screen's chat", icon: true }]);
    await K.click("#list a.tr-new");
    await K.until("location.hash === '#/chat' && [...document.querySelectorAll('.ch-msg')].some((m) => /Bring cash/.test(m.textContent))", "the trip's chat");
    await K.eval(SEND("Will do"));
    await K.until("!document.querySelector('.ch-waiting')", "Kai's message sent");
    await trips();
    t.same("  (read, and his own message after it: the mark is gone)", await row(K), null);
    await K.goto(`${server.origin}/t/${T}/#/chat`);
    await K.until("!!document.querySelector('.ch-input')", "Kai's chat again");
  }

  t.part("9. The keyboard");
  await K.eval("location.hash = '#/', true");
  await K.until("!document.querySelector('.ch')", "Kai's agenda");
  await K.eval(`import('/js/chat.js').then((m) => { m.chatAbout('place', 'p-stay'); return true; })`);
  await K.until("document.querySelector('.ch-card-held')", "the stay held");
  await sleep(500);
  await K.eval("document.querySelector('.ch-input').focus(), true");
  await K.eval("window.__setKb(336), true");
  await sleep(600);
  const glass = await K.eval(`(() => { const vv = window.visualViewport; const bottom = vv.offsetTop + vv.height;
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
    const msgs = document.querySelectorAll('.ch-msg'); const last = msgs[msgs.length - 1].getBoundingClientRect();
    return { glassBottom: Math.round(bottom), box: r('.ch-box'), held: r('.ch-card-held'), last: { top: Math.round(last.top), bottom: Math.round(last.bottom) }, kb: getComputedStyle(document.querySelector('.ch-box')).getPropertyValue('--kb-h') }; })()`);
  t.ok(`a 336 px keyboard: the box sits on it (box ${glass.box.top}–${glass.box.bottom}, glass ends ${glass.glassBottom}), the held stay is in view, and the last message ends above the box (${glass.last.bottom})`,
    glass.box.bottom <= glass.glassBottom + 1 && glass.box.bottom >= glass.glassBottom - 2 && glass.held.top >= 0 && glass.held.bottom <= glass.glassBottom
      && glass.last.bottom <= glass.box.top + 1 && glass.last.top >= 0, glass);
  await K.eval("window.__setKb(0), document.querySelector('.ch-input').blur(), true");

  t.part("10a. What the server sends is never markup");
  {
    // A stand-in snapshot and chat, answered to a fresh page of Kai's: a member's color, name and
    // initials, an event's id, and a message's about (kind and id) each carry a quote and an angle
    // bracket. The page escapes every value it puts in markup, and only a color reaches a style.
    const BAD = `"><img src=x onerror="window.__pwned=1">'`;
    const snap = (await kai.get(`/api/trips/${T}`)).json;
    const hanaRow = snap.members.find((m) => m.id === hana.user.id);
    Object.assign(hanaRow, { note_color: `#fff;" onmouseover="window.__pwned=2" data-x="${BAD}`, name: `Hana ${BAD}`, initials: `<i>H</i>` });
    const walk = snap.events.find((e) => e.id === "e-walk");
    const badId = `e${BAD}`;
    snap.events.push({ ...walk, id: badId, title: `Walk ${BAD}` });
    const msgs = (await kai.get(`/api/trips/${T}/messages?limit=50`)).json;
    const top = msgs.seq + 1;
    const nowS = Math.floor(Date.now() / 1000);
    const planted = (id, seq, about, body) => ({ id, seq, touched: seq, author: hana.user.id, author_name: `Hana ${BAD}`, body, about, created_at: nowS + 900, edited_at: null, deleted: null, rev: 1 });   // its own run: square and name shown
    msgs.messages.push(
      planted(`m${BAD}`, top, { kind: "event", id: badId, name: `n${BAD}` }, `About the walk ${BAD}`),
      planted("m-kind", top + 1, { kind: `event" onclick="window.__pwned=3`, id: "e-walk", name: "x" }, "An odd kind"),
    );
    msgs.seq = top + 1;
    const K3 = await chrome.page({ width: 390, height: 844, mobile: true });
    await K3.setCookie(server.origin, "wgp_session", kai.jar.cookies.get("wgp_session"));
    const tripPath = new URL(`/api/trips/${T}`, server.origin).pathname;
    K3.wire.listeners.add((m) => {
      if (m.sessionId !== K3.session || m.method !== "Fetch.requestPaused") return;
      const url = new URL(m.params.request.url);
      const body = url.pathname === tripPath ? snap : url.pathname === `${tripPath}/messages` ? msgs : null;
      if (!body) { K3.send("Fetch.continueRequest", { requestId: m.params.requestId }).catch(() => {}); return; }
      K3.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }],
        body: Buffer.from(JSON.stringify(body)).toString("base64") }).catch(() => {});
    });
    // The page's later refreshes ask `?since=<rev>`: answered the same whole snapshot (no `delta`), or the server's own
    // members would replace the planted row under load and the check would read the real names (17 Nov, 28/1 in a gate).
    await K3.send("Fetch.enable", { patterns: [{ urlPattern: `*${tripPath}` }, { urlPattern: `*${tripPath}?*` }, { urlPattern: `*${tripPath}/messages*` }] });
    await K3.goto(`${server.origin}/t/${T}/#/chat`);
    await K3.until("[...document.querySelectorAll('.ch-msg')].some((m) => /About the walk/.test(m.textContent))", "the planted messages", 20000);
    await sleep(500);
    const got = await K3.eval(`(() => {
      const feed = document.querySelector('.ch-feed');
      const odd = [...feed.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.name)).filter((n) => /^on|^data-x$/.test(n));
      const planted = [...document.querySelectorAll('.ch-msg')].find((m) => /About the walk/.test(m.textContent));
      const kindMsg = [...document.querySelectorAll('.ch-msg')].find((m) => /An odd kind/.test(m.textContent));
      const sq = planted.querySelector('.ch-sq');
      return { pwned: window.__pwned ?? 0, imgs: feed.querySelectorAll('img').length, italics: feed.querySelectorAll('.ch-sq i').length, odd,
        squareStyle: sq.getAttribute('style'), initials: sq.textContent, name: planted.querySelector('.ch-name').textContent,
        cardHref: planted.querySelector('a.ch-card')?.getAttribute('href') ?? null, cardKind: planted.querySelector('.ch-card')?.dataset.kind ?? null,
        oddKindCard: !!kindMsg.querySelector('.ch-card'), body: planted.querySelector('.ch-body').textContent };
    })()`);
    t.same("a member's color, name and initials, an event's id and a message's about, each carrying a quote and markup: nothing runs, nothing leaves its attribute, the color isn't used (not a color), the card links to the event's own address, and an unknown kind draws no card",
      // The square's style: none at all since the faces went on ds/avatar.js (a color that isn't one of the palette's
      // gets no tone and no style attribute), an empty one before; either way the planted value never reaches it.
      [got.pwned, got.imgs, got.italics, got.odd, got.squareStyle || "", got.initials, got.name, got.cardHref, got.cardKind, got.oddKindCard, got.body],
      [0, 0, 0, [], "", "<i>H</i>", `Hana ${BAD}`, `#/e/${encodeURIComponent(badId)}`, "event", false, `About the walk ${BAD}`]);
    errorsFrom.push(K3);
  }

  t.part("10. Signing out");
  // forget.js empties each database rather than deleting it (a delete waits on every open copy
  // of the app, and the next sign-in would wait behind it): so, empty.
  const rowsIn = `new Promise((resolve) => { const r = indexedDB.open('wegoplace-chat:${T}'); r.onsuccess = () => { const d = r.result;
    const names = [...d.objectStoreNames]; const t = d.transaction(names, 'readonly'); const out = {};
    for (const n of names) { const q = t.objectStore(n).count(); q.onsuccess = () => { out[n] = q.result; }; }
    t.oncomplete = () => { d.close(); resolve(out); }; }; })`;
  const rowsBefore = await K.eval(rowsIn);
  await K.eval("import('/js/forget.js').then((m) => m.forgetThisPhone()).then(() => true)");
  const rowsAfter = await K.eval(rowsIn);
  t.same(`signing out (forget.js) empties the chat's database for the trip (it had ${rowsBefore.messages} messages and where reading stopped)`,
    [rowsBefore.messages > 0, rowsAfter], [true, { messages: 0, meta: 0, outbox: 0 }]);

  const errors = [H, K, K2, ...errorsFrom].flatMap((p) => p.errors).filter((e) => !/WebSocket connection to .* failed|ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(e));
  t.same("no errors on any page", errors, []);
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await chrome?.close();
  await server?.stop();
}
process.exit(code);
