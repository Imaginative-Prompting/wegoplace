// Whether a browser would install the app, asked of Chrome itself: the same test Chrome runs before
// it offers "Install app" in its menu or its own install banner, on a phone and on a desktop, each
// signed in at / in a browser's own profile (Chrome never offers to install from a private window),
// on a server of its own:
//
//   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> \
//     --label "installable" -- node checks/install/browser.mjs [--port <port>] [--shots <folder>]
//
// The port is 8807 unless given. It holds, for each:
//   1. Chrome finds nothing in the way of installing (Page.getInstallabilityErrors is empty);
//   2. the manifest Chrome read (Page.getAppManifest): its address, no parse errors, the name,
//      start_url and scope /, display standalone, a 192 and a 512 icon that each answer as a PNG,
//      and the app's id (Page.getAppId) is the site's / , as the manifest's "id" says;
//   3. the service worker is in control of the page / opens (signed in, the app goes on from / to
//      its first page), and / opens that same page again with no network at all, every page
//      answered by the worker, showing the same heading: the fetch handler is what Chrome's own
//      install banner asks for, and what opening the installed app with no signal needs.
//
// INSTALLABLE_PLANT=icons serves the manifest with its icons taken out, and INSTALLABLE_PLANT=worker
// refuses the worker's registration in the page. Both are done in the browser, nothing in the tree
// changes, and each must make the check fail. Everyone in it is made up.

import fs from "node:fs";
import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { makeLink } from "../../tools/signin-link.mjs";
import { openChrome } from "../lib/chrome.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8807);
const PLANT = process.env.INSTALLABLE_PLANT ?? null;
if (PLANT && !["icons", "worker"].includes(PLANT)) throw new Error(`INSTALLABLE_PLANT is "icons" or "worker", not "${PLANT}"`);
const t = new Report(PLANT ? `installable (planted: ${PLANT})` : "installable");
const MAIN = `http://localhost:${port}`;
const DEVICES = [
  { name: "a phone", width: 390, height: 844, mobile: true },
  { name: "a desktop", width: 1280, height: 800, mobile: false },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The manifest as the tree has it, with its icons taken out (the icons plant). */
function iconlessManifest() {
  const m = JSON.parse(fs.readFileSync(new URL("../../public/manifest.webmanifest", import.meta.url), "utf8"));
  delete m.icons;
  return Buffer.from(JSON.stringify(m)).toString("base64");
}

/** Answers this page's requests for the manifest with `body` (base64) instead of the server's. */
async function serveManifest(page, body) {
  page.on((m) => {
    if (m.method !== "Fetch.requestPaused") return;
    page.send("Fetch.fulfillRequest", {
      requestId: m.params.requestId, responseCode: 200, body,
      responseHeaders: [{ name: "Content-Type", value: "application/manifest+json" }],
    }).catch(() => { /* the page went away */ });
  });
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/manifest.webmanifest" }] });
}

const shots = flag("--shots");
if (shots) fs.mkdirSync(shots, { recursive: true });
const shot = async (page, name) => { if (shots) await page.shot(`${shots}/${name}.png`); };

/**
 * Where the page comes to rest: loaded, its heading drawn, and its path the same for 2.5 s (with
 * no network, / can wait over a second before it goes on to the app's first page). The heading,
 * to compare.
 */
async function settled(page) {
  const read = `document.readyState === "complete" && document.querySelector("h1")?.innerText.trim() ? { path: location.pathname, title: document.querySelector("h1").innerText.trim().slice(0, 60) } : null`;
  let last = null, since = Date.now();
  for (const end = Date.now() + 20000; Date.now() < end; await sleep(200)) {
    const now = await page.eval(`(() => { try { return ${read}; } catch { return null; } })()`).catch(() => null);
    const key = now ? `${now.path}|${now.title}` : null;
    if (key !== last) { last = key; since = Date.now(); } else if (key && Date.now() - since > 2500) {
      await page.settle();
      return now;
    }
  }
  throw new Error(`the page never came to rest (last: ${last})`);
}

// (Chrome's own pages, its no-connection page among them, have no ServiceWorkerContainer.)
const REFUSE_WORKER = `if (typeof ServiceWorkerContainer !== "undefined") ServiceWorkerContainer.prototype.register = function () { return Promise.reject(new DOMException("no worker here", "SecurityError")); };`;

let server, chrome, code = 1;
try {
  server = await startServer({ name: "installable", port });
  await server.start();

  for (const device of DEVICES) {
    t.part(`As ${device.name} (${device.width}×${device.height})`);
    chrome = await openChrome();
    const page = await chrome.page({
      width: device.width, height: device.height, mobile: device.mobile,
      passkeys: false, serviceWorker: true, ownProfile: true,
      before: PLANT === "worker" ? REFUSE_WORKER : null,
    });
    if (PLANT === "icons") await serveManifest(page, iconlessManifest());

    // Signed in by the one-use link, as the sign-in page's own button does it.
    const ada = new Person(MAIN, device.mobile ? "Ada Reyes" : "Teo Lund");
    if ((await ada.signUp()).status !== 200) throw new CheckError("couldn't make the account");
    const link = makeLink({ who: ada.user.id, origin: MAIN, hours: 1 });
    server.sql(link.sql);
    await page.goto(`${MAIN}/login`);
    const used = await page.eval(`fetch("/api/auth/link", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ token: ${JSON.stringify(link.url.split("/").pop())} }) }).then((r) => r.status)`);
    if (used !== 200) throw new CheckError(`the one-use link answered ${used}`);

    // / is where the installed app opens (start_url). Signed in, the app goes on from there to the
    // page it shows first; where it settles is the page to find again with no network.
    await page.goto(`${MAIN}/`);
    let controlled = false;
    try {
      await page.until("navigator.serviceWorker && navigator.serviceWorker.controller", "the worker to take control", 20000);
      controlled = true;
    } catch { /* told below */ }
    const landed = await settled(page).catch((e) => ({ error: e.message }));
    await shot(page, `${device.mobile ? "phone" : "desktop"}-online`);

    // 1. Chrome's own test.
    const { installabilityErrors } = await page.send("Page.getInstallabilityErrors");
    t.same("Chrome finds nothing in the way of installing", installabilityErrors.map((e) => [e.errorId, ...e.errorArguments.map((a) => `${a.name}=${a.value}`)].join(" ")), []);

    // 2. The manifest Chrome read.
    const manifest = await page.send("Page.getAppManifest");
    t.same("Chrome read the manifest from /manifest.webmanifest, without errors", [manifest.url, manifest.errors], [`${MAIN}/manifest.webmanifest`, []]);
    let data = {};
    try { data = JSON.parse(manifest.data || "{}"); } catch { /* told below */ }
    t.same("  its name, start_url, scope and display",
      [data.name, data.start_url, data.scope, data.display], ["We Go Place", "/", "/", "standalone"]);
    const icons = Array.isArray(data.icons) ? data.icons : [];
    t.same("  a 192 and a 512 icon", ["192x192", "512x512"].map((s) => icons.some((i) => i.sizes === s)), [true, true]);
    const answered = await page.eval(`Promise.all(${JSON.stringify(icons.map((i) => i.src))}.map((src) => fetch(src, { cache: "no-store" }).then((r) => r.status + " " + r.headers.get("content-type")).catch((e) => String(e))))`);
    t.ok("  each icon answers as a PNG", icons.length > 0 && answered.every((a) => a === "200 image/png"), JSON.stringify(answered));
    const { appId } = await page.send("Page.getAppId");
    t.same("  the app's id is the site's /", appId, `${MAIN}/`);

    // 3. The worker, and / with no network.
    t.ok(`the service worker is in control of the page / opens (${landed.path})`, controlled, JSON.stringify(landed));
    const documents = [];
    const off = page.on((m) => {
      if (m.method === "Network.responseReceived" && m.params.type === "Document") documents.push({ url: m.params.response.url, status: m.params.response.status, worker: m.params.response.fromServiceWorker });
    });
    await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    let offline = null;
    try {
      await page.goto(`${MAIN}/`);
      offline = await settled(page);
    } catch (e) { offline = { error: e.message.slice(0, 160) }; }
    await shot(page, `${device.mobile ? "phone" : "desktop"}-offline`);
    await page.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    off();
    const answers = documents.map((d) => `${new URL(d.url).pathname} ${d.status}${d.worker ? " (worker)" : ""}`);
    t.ok("with no network, / opens the same page again, every page answered by the worker",
      offline?.path === landed.path && documents.length > 0 && documents.every((d) => d.worker && d.status === 200), JSON.stringify({ online: landed.path, offline, answers }));
    t.same("  and it shows what it showed with the network", offline?.title, landed.title);

    const errors = page.errors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(e) && !(PLANT === "worker" && /no worker here|\[auth\] sw/.test(e)));
    t.same("no error in the page", errors, []);
    await chrome.close();
    chrome = null;
    await sleep(200);
  }
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await chrome?.close().catch(() => {});
  await server?.stop();
}
process.exit(code);
