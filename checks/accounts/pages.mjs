// The sign-in page and the account page, as far as plain HTTP and their own source can show:
// who is served which file, that every address their scripts ask for has a handler, that every
// element their scripts reach for is in the page, and that nothing of the invite codes is left.
// What a browser draws is not checked here (a browser check does that).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../lib/server.mjs";
import { Person } from "../lib/person.mjs";

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

/** Every `call("GET", "/api/…")` and `api("POST", `/api/…/${x}`)` in a script, as [method, path]. */
function asked(source) {
  const found = [];
  for (const m of source.matchAll(/\b(?:call|api)\(\s*"([A-Z]+)",\s*(["`])([^"`]+)\2/g)) {
    // A `${…}` in the address stands for one part of the path.
    found.push([m[1], m[3].replace(/\$\{[^}]*\}/g, "x")]);
  }
  return found;
}

/** Every form in a page, as [method, action]. */
const forms = (html) => [...html.matchAll(/<form\b[^>]*\bmethod="(\w+)"[^>]*\baction="([^"]+)"/g)].map((m) => [m[1].toUpperCase(), m[2]]);

const typeOf = (res) => res.headers.find(([k]) => k === "content-type")?.[1] ?? "";
const idsIn = (html) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
/** The ids a script reaches for through $("…"), within `source`. */
const idsAsked = (source) => new Set([...source.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));

export async function pages({ server, report: t, people }) {
  const { origin } = server;
  const { ana } = people;
  const nobody = new Person(origin, "Nobody");

  const loginHtml = read("public/login.html");
  const accountHtml = read("public/account.html");
  const authJs = read("public/js/auth.js");
  const accountJs = read("public/js/account.js");
  const settingsJs = read("public/js/settings.js");

  t.part("The pages: who is served what");
  {
    for (const address of ["/login", "/login/new", `/login/link/${"a".repeat(43)}`]) {
      const page = await nobody.get(address, { page: true });
      t.ok(`${address.length > 30 ? "/login/link/<token>" : address} is the sign-in page, to anyone`,
        page.status === 200 && /text\/html/.test(typeOf(page)) && page.text.includes("data-login-page"),
        [page.status, typeOf(page)]);
    }
    for (const file of ["/styles.css", "/css/account.css", "/js/auth.js", "/img/wordmark.svg"]) {
      t.same(`${file}, which it needs, is public`, (await nobody.get(file)).status, 200);
    }
    const served = await nobody.get("/js/auth.js");
    t.ok("the script served is the one in the tree", served.text === authJs);
    // The account page is a file like the others: the same for everyone, with nothing of an
    // account in it. Its script asks /api/me and sends a signed-out browser to sign in (the
    // browser check follows that; here, that the script does it and the file holds no one's data).
    const away = await nobody.get("/account", { page: true });
    const mine = await ana.get("/account", { page: true });
    t.ok("/account is the account page, the same file signed in or out",
      mine.status === 200 && mine.text.includes("data-account-page") && !mine.text.includes("data-login-page") && away.text === mine.text, [away.status, mine.status]);
    t.ok("with nothing of the account in it", !mine.text.includes("Ana Check") && !mine.text.includes(ana.user.id));
    t.ok("its script sends someone signed out to sign in, and back afterwards", /if \(!user\) \{ location\.replace\(`\/login\?next=\/account\$\{location\.hash \? encodeURIComponent\(location\.hash\) : ""\}`\); return; \}/.test(fs.readFileSync(path.join(ROOT, "public/js/account.js"), "utf8")));
    t.same("what it asks for is refused signed out", [(await nobody.get("/api/me")).status, (await nobody.get("/api/auth/ways")).status, (await nobody.get("/api/account/email")).status], [401, 401, 401]);
    const direct = await ana.get("/account.html", { page: true });
    t.ok("/account.html goes to /account", [301, 302, 307, 308].includes(direct.status) && new URL(direct.location, origin).pathname === "/account", [direct.status, direct.location]);
  }

  t.part("The pages: what their scripts ask for exists");
  {
    const { findRoute } = await import(pathToFileURL(path.join(ROOT, "src/routes.js")));
    const calls = [...asked(authJs), ...asked(accountJs), ...forms(loginHtml), ...forms(accountHtml)];
    const missing = calls.filter(([method, address]) => !findRoute(method, address));
    t.ok(`each of the ${calls.length} requests in the two scripts and the pages' forms has a handler`, calls.length >= 25 && missing.length === 0,
      missing.map((c) => c.join(" ")).join(", ") || `only ${calls.length} found`);
    // The sign-in page's controller is the part of auth.js after this line.
    const controller = authJs.slice(authJs.indexOf("function initLoginPage"));
    const loginIds = idsIn(loginHtml);
    const lost = [...idsAsked(controller)].filter((id) => !loginIds.has(id));
    t.ok("every element the sign-in script reaches for is in login.html", idsAsked(controller).size >= 25 && lost.length === 0, lost.join(", "));
    const panels = [...controller.matchAll(/const PANELS = \[([^\]]+)\]/g)].flatMap((m) => m[1].match(/"(\w+)"/g) ?? []).map((p) => `p-${p.replaceAll('"', "")}`);
    t.ok("and so is each of its screens", panels.length === 5 && panels.every((id) => loginIds.has(id)), panels.filter((id) => !loginIds.has(id)).join(", "));
    const accountIds = idsIn(accountHtml);
    // Its message lines are named in a list and looked up as said["msg-…"]: nine with v86's units line and the plan's,
    // ten with "What's yours" (msg-yours, v93), eleven with Your color (msg-color, v135), ten again when the color went
    // into the picture's sheet (25 Nov).
    const messageIds = new Set([...accountJs.matchAll(/"(arrived|msg-[a-z]+)"/g)].map((m) => m[1]));
    const lostHere = [...idsAsked(accountJs), ...messageIds].filter((id) => !accountIds.has(id));
    t.ok("every element the account script reaches for is in account.html", idsAsked(accountJs).size >= 25 && messageIds.size === 10 && lostHere.length === 0,
      lostHere.join(", ") || `${idsAsked(accountJs).size} elements, ${messageIds.size} message lines`);
    // The words for each short code a redirect can come back with.
    const providersJs = read("src/accounts/providers.js");
    const codes = new Set([...providersJs.matchAll(/\b(?:toLogin|toCreateStep|toAccount|back)\(\s*(?:[\w.?/" ]+,\s*)?"([a-z-]+)"/g)].map((m) => m[1]));
    for (const m of providersJs.matchAll(/\? "([a-z-]+)" : (?:"([a-z-]+)"|null)/g)) { codes.add(m[1]); if (m[2]) codes.add(m[2]); }
    const worded = new Set([...authJs.slice(authJs.indexOf("export function resultWords")).matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]));
    const unworded = [...codes].filter((code) => !worded.has(code));
    t.ok(`each of the ${codes.size} results a trip to Google or GitHub can come back with has words`, codes.size >= 9 && unworded.length === 0, unworded.join(", ") || [...codes].join(", "));
  }

  t.part("The pages: nothing of the invite codes is left");
  {
    for (const [file, source] of [["public/login.html", loginHtml], ["public/account.html", accountHtml], ["public/js/auth.js", authJs], ["public/js/account.js", accountJs]]) {
      t.ok(`${file} doesn't mention them`, !/invite/i.test(source));
    }
    t.ok("Settings no longer asks for /api/invites or draws the panel", !/\/api\/invite|st-invite|\?invite=/.test(settingsJs));
    t.same("and /api/invites has no handler: a signed-in script asking gets no JSON from it",
      (await ana.post("/api/invites", {})).json?.code ?? null, null);
  }
}
