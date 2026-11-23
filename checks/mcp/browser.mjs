// Connecting an AI app, in a real browser (Chrome for Testing): the road a person takes when
// Claude, or any app, asks to use their WeGoPlace account. check:mcp walks the same road with
// Node's fetch, which sets every header itself; this one lets the browser send what a browser
// sends. Until 15 Nov no browser had ever submitted the consent page's form, and every real
// Allow was refused: the page was served with `Referrer-Policy: no-referrer`, under which a
// browser posts its own form with `Origin: null`, and the gate refuses a write from an Origin
// that isn't the site's.
//
//   node checks/mcp/browser.mjs [--port <port>]
//
// It holds:
//   1. signed in: an app registers (with Claude's own redirect address), the person opens
//      /authorize, sees the page, taps Allow; the browser lands on the app's address with a code
//      and the state it was sent; the code buys tokens; a tool answers with them. The Allow is
//      sent with the site's own Origin;
//   2. Cancel, tapped: the browser lands on the app's address with error=access_denied;
//   3. signed out: /authorize sends the person to sign in, a passkey signs them in, they come
//      back to the same page and Allow works;
//   4. what the app does, the person sees: a place the app gives a picture through set_picture
//      shows it on the place's page, drawn from the picture (model §6), and so does its plan on
//      the Agenda;
//   5. what /register, /token and /mcp answer a request that carries another site's Origin (a
//      browser-based app would send one; Claude's and ChatGPT's connectors call from their
//      servers and send none): said, not judged here.
// Its own server and browser. Everyone in it is made up.

import crypto from "node:crypto";
import { CheckError, startServer } from "../lib/server.mjs";
import { Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";
import { makeAccount } from "../lib/signin-page.mjs";
import { McpClient, register, token } from "../lib/mcp.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8795);
const t = new Report("connecting an AI app, in a browser");
const b64url = (buf) => Buffer.from(buf).toString("base64url");
// Claude's own redirect address: the browser never reaches it here (the check answers it in the
// browser itself), but it is what a real connection registers.
const APP_BACK = "https://claude.ai/api/mcp/auth_callback";

let server, chrome, code = 1;
try {
  server = await startServer({ name: "mcp-browser", port });
  await server.start();
  const { origin } = server;
  chrome = await openChrome();
  const page = await chrome.page({ width: 390, height: 844, mobile: true });

  // The app's address answered in the browser: what it was sent there with is written down.
  const landed = [];
  const posts = [];
  const authorizePosts = new Set();
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "https://claude.ai/*", requestStage: "Request" }] });
  page.on(async (m) => {
    if (m.method === "Fetch.requestPaused") {
      // Only the page the browser was sent to (not, say, that page's own favicon).
      if (m.params.resourceType === "Document") landed.push(m.params.request.url);
      await page.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/html" }], body: Buffer.from("<p>the app</p>").toString("base64") }).catch(() => {});
    }
    // The headers a request really went with are in its ExtraInfo event (the network stack adds
    // Origin after the page's own request is written down).
    if (m.method === "Network.requestWillBeSent" && m.params.request.method === "POST" && new URL(m.params.request.url).pathname === "/authorize") {
      authorizePosts.add(m.params.requestId);
    }
    if (m.method === "Network.requestWillBeSentExtraInfo" && authorizePosts.has(m.params.requestId)) {
      const h = m.params.headers || {};
      posts.push({ origin: h.Origin ?? h.origin ?? null });
    }
  });
  const waitLanded = async (n) => { for (let i = 0; i < 150 && landed.length < n; i++) await new Promise((r) => setTimeout(r, 100)); return landed[n - 1] ?? null; };

  // A person, signed up in this browser with a passkey (the browser's own, a virtual one).
  await page.goto(`${origin}/trips`);
  await page.until(`location.pathname === "/login" && !document.getElementById("p-signin")?.hidden`, "the sign-in page");
  // Making an account, as a person does it (checks/lib/signin-page.mjs): the passkey button, back without one here, a name.
  await makeAccount(page, "Nia Connect");
  await page.until(`location.pathname === "/trips"`, "Your trips, signed in", 20000);

  const reg = await register(origin, { name: "Claude", redirect: APP_BACK });
  if (reg.status !== 201) throw new CheckError(`couldn't register an app: ${reg.status} ${JSON.stringify(reg.json)}`);
  const clientId = reg.json.client_id;
  /** /authorize for this app, with its PKCE pair and a state. */
  const ask = () => {
    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(8));
    const q = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: APP_BACK, scope: "trips:read trips:write", state,
      code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
      resource: new URL("/mcp", origin).toString(),
    });
    return { verifier, state, url: `${origin}/authorize?${q}` };
  };
  const consent = () => page.until(`!!document.querySelector("[data-authorize-page] button[value=approve]")`, "the consent page", 20000);
  /** The code it came back with, traded for tokens, and one tool's answer. */
  const useCode = async (back, a) => {
    const u = new URL(back);
    const tokens = await token(origin, { grant_type: "authorization_code", code: u.searchParams.get("code"), redirect_uri: APP_BACK, client_id: clientId, code_verifier: a.verifier });
    const mcp = new McpClient(origin, tokens.json?.access_token);
    await mcp.initialize();
    const trips = await mcp.call("list_trips");
    return { state: u.searchParams.get("state"), hasCode: !!u.searchParams.get("code"), tokens: tokens.status, tool: trips.isError ? trips.text.slice(0, 120) : "answered", mcp };
  };

  t.part("1. Signed in: Allow, tapped");
  const a1 = ask();
  await page.open(a1.url);
  await consent();
  await page.click("[data-authorize-page] button[value=approve]");
  const back1 = await waitLanded(1);
  t.same("the Allow goes with the site's own Origin, and the browser lands on the app's address with a code and its state",
    [posts[0]?.origin, back1 ? new URL(back1).origin + new URL(back1).pathname : null, back1 && new URL(back1).searchParams.get("state") === a1.state, !!(back1 && new URL(back1).searchParams.get("code"))],
    [origin, APP_BACK, true, true]);
  const used1 = back1 ? await useCode(back1, a1) : null;
  t.same("the code buys tokens, and a tool answers with them", [used1?.tokens, used1?.tool], [200, "answered"]);

  t.part("1b. The address the Connect your AI sheet copies is the one an app connects to");
  {
    const prm = await (await fetch(new URL("/.well-known/oauth-protected-resource/mcp", origin))).json();
    await page.goto(`${origin}/account#ai-apps`);
    await page.until(`!document.getElementById("account").hidden && !!document.getElementById("apps-connect")`, "the account page", 20000);
    // How to connect is the one sheet (js/plan-ai.js), opened from the account's AI apps card.
    await page.click("#apps-connect");
    await page.until(`!!document.querySelector('.sh-root [data-pa-copy="url"]')`, "the Connect your AI sheet", 8000);
    await page.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin, browserContextId: page.context }).catch(() => {});
    await page.click('.sh-root [data-pa-copy="url"]');
    await page.until(`document.querySelector('.sh-root [data-pa-copy="url"]').textContent !== "Copy"`, "Copy to say it copied", 5000).catch(() => {});
    const copied = await page.eval(`navigator.clipboard.readText().catch((e) => "read: " + e.message)`);
    t.same("Copy gives the address the server's own metadata names as the resource an app signs in for, and the consent page's resource",
      [copied, prm.resource], [prm.resource, new URL("/mcp", origin).toString()]);
    await page.eval(`(document.querySelector(".sh-scrim") && document.querySelector(".sh-scrim").click(), 1)`);
  }

  t.part("2. Cancel, tapped");
  const a2 = ask();
  await page.open(a2.url);
  await consent();
  await page.click("[data-authorize-page] button[value=deny]");
  const back2 = await waitLanded(2);
  const q2 = back2 ? new URL(back2).searchParams : new URLSearchParams();
  t.same("the browser lands on the app's address with the refusal OAuth names (access_denied) and its state, and no code",
    [q2.get("error"), q2.get("state") === a2.state, q2.has("code")], ["access_denied", true, false]);

  t.part("3. Signed out: sign in, come back, Allow");
  // Signed out: a browser with no session (its passkey is still on the browser's own device).
  await page.send("Network.clearBrowserCookies");
  const a3 = ask();
  await page.open(a3.url);
  await page.until(`location.pathname === "/login" && !document.getElementById("p-signin")?.hidden`, "the sign-in page", 20000);
  t.ok("signed out, /authorize sends the person to sign in", true);
  await page.click("#btn-signin");
  await consent();
  t.ok("a passkey signs them in, and they're back on the same app's consent page", await page.eval(`location.pathname === "/authorize" && /Claude/.test(document.querySelector("h1")?.textContent ?? "")`));
  await page.click("[data-authorize-page] button[value=approve]");
  const back3 = await waitLanded(3);
  const used3 = back3 ? await useCode(back3, a3) : null;
  t.same("Allow works there too: a code, tokens, a tool's answer", [used3?.state === a3.state, used3?.hasCode, used3?.tokens, used3?.tool], [true, true, 200, "answered"]);

  t.part("4. What the app does, the person sees: a picture set through set_picture");
  {
    const mcp = used3.mcp;
    const made = await mcp.call("create_trip", { summary: "A trip", name: "Harbour weekend", starts_on: "2027-06-04", ends_on: "2027-06-06", default_tz: "Europe/Lisbon", currencies: ["EUR"] });
    const trip = made.json?.trip?.id;
    await mcp.call("put_places", { trip_id: trip, summary: "The harbour", places: [{ id: "harbour", name: "The harbour", kind: "sight", subkind: "landmark", why: "Boats.", lat: 38.7, lng: -9.14 }] });
    const ev = await mcp.call("put_events", { trip_id: trip, summary: "A walk", events: [{ id: "walk", title: "Walk to the harbour", starts: "2027-06-05T10:00", tz: "Europe/Lisbon", place_id: "harbour" }] });
    const pic = await mcp.call("set_picture", { trip_id: trip, summary: "A picture for the harbour", place_id: "harbour", url: "https://pics.example/harbour.png", license: "CC BY 4.0", credit: "A photographer", source: "https://pics.example/" });
    const url = pic.json?.picture?.url ?? null;
    t.ok("the app makes a trip, a place, a plan there, and gives the place a picture by its address", !!trip && !ev.isError && !pic.isError && /^\/media\//.test(url ?? ""), `${ev.text.slice(0, 120)} | ${pic.text.slice(0, 120)}`);
    await page.open(`${origin}/t/${trip}/#/p/harbour`);
    await page.until(`!!document.querySelector(".pl-hero img") && document.querySelector(".pl-hero img").complete`, "the place's page with its photograph", 20000).catch(() => {});
    t.same("the person opens the place: its photograph is the picture the app set, drawn",
      await page.eval(`(() => { const i = document.querySelector(".pl-hero img"); return i ? [new URL(i.src).pathname, i.naturalWidth > 0] : null; })()`), [url, true]);
    await page.open(`${origin}/t/${trip}/#/`);
    await page.until(`!!document.querySelector(".ag-card img")`, "the plan's card with its photograph", 20000).catch(() => {});
    t.same("and on the Agenda, the plan at that place shows it",
      await page.eval(`(() => { const i = document.querySelector(".ag-card img"); return i ? new URL(i.src).pathname : null; })()`), url);

    // Changed elsewhere (the app removes it, then sets it again), the open page follows with no
    // reload, as any change does (the trip's room, or the store's own pull).
    await page.open(`${origin}/t/${trip}/#/p/harbour`);
    await page.until(`!!document.querySelector(".pl-hero img")`, "the place's photograph again", 20000).catch(() => {});
    await mcp.call("remove_picture", { trip_id: trip, summary: "No picture", place_id: "harbour" });
    const goneAt = await page.until(`!document.querySelector(".pl-hero img")`, "the photograph to go", 15000).then(() => true, () => false);
    const again = await mcp.call("set_picture", { trip_id: trip, summary: "The picture back", place_id: "harbour", url: "https://pics.example/harbour.png", license: "CC BY 4.0", credit: "A photographer", source: "https://pics.example/" });
    const backUrl = again.json?.picture?.url ?? "";
    const backAt = await page.until(`(() => { const i = document.querySelector(".pl-hero img"); return i && new URL(i.src).pathname === ${JSON.stringify(backUrl)}; })()`, "the new photograph", 15000).then(() => true, () => false);
    t.same("removed and set again by the app, the open place page drops it and draws the new one, with no reload", [goneAt, backAt], [true, true]);

    // The credits page lists it, from the picture itself.
    await page.open(`${origin}/t/${trip}/#/settings/credits`);
    await page.until(`document.querySelectorAll(".cr-item").length > 2`, "the credits page", 20000).catch(() => {});
    t.same("the credits page lists it, with its credit and license, from the picture",
      await page.eval(`(() => { const r = [...document.querySelectorAll(".cr-item")].find((x) => /The harbour/.test(x.textContent)); return r ? [r.querySelector(".cr-by").textContent.trim(), r.querySelector(".cr-lic").textContent.trim(), new URL(r.querySelector("img").src).pathname] : null; })()`),
      ["A photographer", "CC BY 4.0", backUrl]);

    // A cover set by the app shows on Your trips.
    const cover = await mcp.call("set_picture", { trip_id: trip, summary: "A cover", cover: true, url: "https://pics.example/harbour.png", license: "CC BY 4.0", credit: "A photographer", source: "https://pics.example/" });
    await page.open(`${origin}/trips`);
    await page.until(`!!document.querySelector(".tr-cover") && document.querySelector(".tr-cover").complete`, "a cover on Your trips", 20000).catch(() => {});
    const coverUrl = cover.json?.picture?.url ?? cover.json?.cover?.url ?? null;
    t.same("a cover the app sets shows on the trip's row in Your trips",
      await page.eval(`(async () => { const i = document.querySelector(".tr-cover"); return i ? [new URL(i.src).pathname, i.naturalWidth > 0, (await fetch(i.src)).status] : null; })()`),
      [coverUrl, true, 200]);
  }

  t.part("5. Another site's Origin on the app's own addresses (said, not judged)");
  const other = "https://another-site.example";
  const reg4 = await fetch(new URL("/register", origin), { method: "POST", headers: { "Content-Type": "application/json", Origin: other },
    body: JSON.stringify({ client_name: "Browser App", redirect_uris: [APP_BACK], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
  const tok4 = await fetch(new URL("/token", origin), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: other }, body: "grant_type=authorization_code&code=nope" });
  const mcp4 = await fetch(new URL("/mcp", origin), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Origin: other }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  const said = (r) => `${r.status}, Access-Control-Allow-Origin: ${r.headers.get("access-control-allow-origin") ?? "(none)"}`;
  console.log(`        /register: ${said(reg4)}; /token (a made-up code): ${said(tok4)}; /mcp (no token): ${said(mcp4)}`);
  t.ok("none of the three is refused for its Origin (the gate isn't in their path)", ![reg4, tok4, mcp4].some((r) => r.status === 403), [reg4.status, tok4.status, mcp4.status]);

  t.ok("the page has no error", page.errors.length === 0, JSON.stringify(page.errors.slice(0, 3)));
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
