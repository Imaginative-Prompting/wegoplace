// Scratch: the two stills of ds's fixes. Split at 320 with Add a purchase open (your picture stepped out), and the
// rail at 768 (five tabs, each 44 px or more, names clear of the next).
import { BASE, boot, evalIn, waitFor, sleep, appSettled } from "./lib/standalone_cdp.mjs";
import { tripPath } from "./lib/gate_trip.mjs";
import fs from "node:fs";
import path from "node:path";
const OUT = process.env.WGP_SHOTS;
const b = await boot({ vw: 320, vh: 640, dsf: 2, reduceMotion: false });
const { cdp, S } = b;
const page = (e) => evalIn(cdp, S, e);
const shot = async (name) => { const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, S); fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, "base64")); console.log(name); };
try {
  for (const scheme of ["dark", "light"]) {
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, S);
    await b.setInsets({ top: 20, right: 0, bottom: 0, left: 0 });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 2, mobile: true }, S);
    await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/split")}` }, S);
    await appSettled(cdp, S);
    await waitFor(cdp, S, `document.querySelector("#view .sp-head") && document.querySelector("#rt-fixed .fab") ? 1 : 0`, { label: "Split", timeout: 30000 });
    await sleep(800);
    await shot(`split-320-${scheme}`);
    await page(`(document.querySelector("#rt-fixed .fab").click(), 1)`);
    await waitFor(cdp, S, `document.querySelector(".sh-root[data-open='1'] .sh-sheet") ? 1 : 0`, { label: "the sheet" });
    await sleep(900);
    console.log(`picture while open: ${await page(`JSON.stringify((() => { const m = getComputedStyle(document.querySelector(".head-more")); return { opacity: m.opacity, visibility: m.visibility }; })())`)}`);
    await shot(`split-320-sheet-${scheme}`);
    await b.setInsets({ top: 24, right: 0, bottom: 20, left: 0 });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true }, S);
    await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/")}` }, S);
    await appSettled(cdp, S);
    await waitFor(cdp, S, `document.querySelector("#view .ag-day") && document.querySelector("[data-rail-brand][data-is]") ? 1 : 0`, { label: "the rail", timeout: 30000 });
    await sleep(900);
    console.log(`tabs at 768: ${await page(`JSON.stringify([...document.querySelectorAll(".tabbar .tab")].map((a) => Math.round(a.getBoundingClientRect().height)))`)}`);
    await shot(`rail-768-${scheme}`);
  }
  console.log(`page errors: ${b.pageErrors.join(" | ").slice(0, 300) || "none"}`);
} finally { await b.done().catch(() => {}); }
