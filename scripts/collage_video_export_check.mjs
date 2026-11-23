// THE LOOPING VIDEO EXPORT (a board saved as a clip that loops), recorded for real in a browser.
//
// Videos on a board did not render in an export: there was no video export at all,
// and a board of clips came out as motionless posters. This records one and inspects it.
import { BASE, boot, evalIn, waitFor, sleep } from "./lib/standalone_cdp.mjs";
import { tripPath } from "./lib/gate_trip.mjs";

const results = [];
const check = (n, ok, d) => { results.push(!!ok); console.log(`${ok ? "  ok  " : "  FAIL"}  ${n}${d ? "   — " + d : ""}`); };
// AWAIT FIRST, THEN STRINGIFY. Wrapping an async IIFE in JSON.stringify() serialises the
// PENDING PROMISE — "{}" — so every field came back undefined and the failure looked like the
// feature not working rather than the harness not waiting. evalIn's awaitPromise only helps if
// the promise is the outermost value.
const J = async (c, S, e) => JSON.parse(
  await evalIn(c, S, `Promise.resolve(${e}).then((v) => JSON.stringify(v))`));

// THE FIXTURE IS MADE HERE, IN THE PAGE. The repo's checked-in test clips
// were COMPLETELY STATIC (measured: 0% of pixels differ
// between t=0.2s and t=2.0s — so a board built from them cannot prove that a moving clip
// reaches the output. The harness records its own moving clip with the same MediaRecorder the
// feature uses, hands it over as a blob: URL, and nothing is ever written to public/.

const b = await boot({ vw: 900, vh: 700, dsf: 1 });
try {
  await b.setInsets({ top: 0, right: 0, bottom: 0, left: 0 });
  await b.cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/memories")}` }, b.S);
  await waitFor(b.cdp, b.S, `document.querySelector(".me-viewbtn") ? 1 : 0`, { label: "memories" });
  await sleep(600);

  // Make the moving clip once and park it on window for the sections below.
  const fixture = await J(b.cdp, b.S, `(async () => {
    const c = document.createElement("canvas");
    c.width = 320; c.height = 180;
    const g = c.getContext("2d");
    const stream = c.captureStream(30);
    const type = ["video/mp4", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 3000000 });
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start();
    const t0 = performance.now();
    await new Promise((res) => {
      const tick = () => {
        const t = (performance.now() - t0) / 1000;
        if (t >= 4) return res();
        // A big high-contrast block sweeping the whole frame: unmistakable motion, and it
        // survives being drawn small into a print on a board.
        g.fillStyle = "#101014"; g.fillRect(0, 0, 320, 180);
        const x = (t / 4) * 260;
        g.fillStyle = "#ffd400"; g.fillRect(x, 20, 60, 140);
        g.fillStyle = "#ff2d55"; g.fillRect(260 - x, 70, 60, 40);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    rec.stop();
    await done;
    const blob = new Blob(parts, { type });
    window.__CLIP = URL.createObjectURL(blob);
    return { bytes: blob.size, type, url: window.__CLIP.slice(0, 12) + "…" };
  })()`);
  check("the harness built its own MOVING clip to test with",
    fixture.bytes > 5000, `${(fixture.bytes / 1024).toFixed(0)} KB of ${fixture.type}`);

  console.log("\n1. the browser can record at all");
  const cap = await J(b.cdp, b.S, `(async () => {
    const X = await import("/js/collage-export.js");
    return { type: X.videoExportType(), can: X.canExportVideo() };
  })()`);
  check("MediaRecorder is available and a container was chosen", cap.can && !!cap.type, cap.type || "(none)");

  console.log("\n2. record a board that really has clips on it");
  const out = await J(b.cdp, b.S, `(async () => {
    const L = await import("/js/collage-layout.js");
    const X = await import("/js/collage-export.js");
    // Four photos and two clips, one of them trimmed to a 1.5s window so the trim path is
    // exercised rather than just the dealt one.
    const media = [
      { id: "p1", memoryId: "m", kind: "photo", width: 1200, height: 900, url: "/img/demo-hero.webp", thumb_url: "/img/demo-hero.webp" },
      { id: "p2", memoryId: "m", kind: "photo", width: 900, height: 1200, url: "/img/demo-hero.webp", thumb_url: "/img/demo-hero.webp" },
      { id: "v0", memoryId: "m", kind: "video", width: 640, height: 360, duration_s: 4,
        url: window.__CLIP, thumb_url: "/img/demo-hero.webp",
        trim_start_s: 1, trim_end_s: 2.5 },
      { id: "v1", memoryId: "m", kind: "video", width: 640, height: 360, duration_s: 4,
        url: window.__CLIP, thumb_url: "/img/demo-hero.webp" },
    ];
    const lay = L.layoutCollage(media, { seed: "vid_check", background: "corkboard" });
    const vids = lay.items.filter((i) => i.kind === "video");
    const t0 = performance.now();
    const r = await X.exportCollageVideo(lay, { targetLongEdge: 720, longEdge: 720, fps: 24, seconds: 3 });
    return {
      bytes: r.bytes, type: r.type, name: r.name, w: r.width, h: r.height,
      seconds: r.seconds, frames: r.frames, videos: r.videos,
      tookMs: Math.round(performance.now() - t0),
      loops: vids.map((v) => [v.id, v.loopStartMs, v.loopMs]),
    };
  })()`);
  check("it produced a file with real bytes in it", out.bytes > 20000,
    `${(out.bytes / 1024).toFixed(0)} KB of ${out.type}, ${out.name}`);
  check("both clips were opened and played into it", out.videos === 2, `${out.videos} clips`);
  check("the trim is what drives the loop, not the dealt window",
    JSON.stringify(out.loops.find((l) => l[0].endsWith("v0"))) === JSON.stringify([out.loops.find((l) => l[0].endsWith("v0"))[0], 1000, 1500]),
    JSON.stringify(out.loops));
  check("dimensions are EVEN — H.264 rejects odd ones and yields an empty file, not an error",
    out.w % 2 === 0 && out.h % 2 === 0, `${out.w}x${out.h}`);
  check("it is downscaled to the cap, not the board's full size",
    Math.max(out.w, out.h) <= 720, `long edge ${Math.max(out.w, out.h)}`);
  check("it recorded roughly the frames the duration and fps imply",
    out.frames > out.seconds * 8, `${out.frames} frames over ${out.seconds}s`);

  console.log("\n3. the recording actually MOVES — decode it and compare frames");
  // THE HONEST TEST. Comparing the file size of two DIFFERENT boards was not one: they hold a
  // different number of prints, so the sizes differ for reasons that have nothing to do with
  // motion, and the fixture clip could be nearly static anyway. This decodes the file this
  // export actually produced and looks at two moments of it.
  const moved = await J(b.cdp, b.S, `(async () => {
    const L = await import("/js/collage-layout.js");
    const X = await import("/js/collage-export.js");
    const media = [
      { id: "p1", memoryId: "m", kind: "photo", width: 1200, height: 900, url: "/img/demo-hero.webp", thumb_url: "/img/demo-hero.webp" },
      { id: "v0", memoryId: "m", kind: "video", width: 640, height: 360, duration_s: 4,
        url: window.__CLIP, thumb_url: "/img/demo-hero.webp" },
    ];
    const lay = L.layoutCollage(media, { seed: "move_check", background: "corkboard" });
    const out = await X.exportCollageVideo(lay, { targetLongEdge: 480, longEdge: 480, fps: 24, seconds: 3 });

    // Play the RESULT and grab frames as they are presented. requestVideoFrameCallback is used
    // rather than seeking because a MediaRecorder file has no seek index worth trusting.
    const url = URL.createObjectURL(out.blob);
    const v = document.createElement("video");
    v.src = url; v.muted = true; v.playsInline = true;
    await new Promise((res, rej) => {
      v.addEventListener("loadeddata", res, { once: true });
      v.addEventListener("error", () => rej(new Error("the produced file would not decode")), { once: true });
      setTimeout(() => rej(new Error("decode timed out")), 8000);
    });
    const c = document.createElement("canvas");
    c.width = out.width; c.height = out.height;
    const g = c.getContext("2d", { willReadFrequently: true });
    const grabs = [];
    await v.play();
    await new Promise((res) => {
      const take = () => {
        g.drawImage(v, 0, 0, c.width, c.height);
        grabs.push(g.getImageData(0, 0, c.width, c.height).data.slice());
        if (grabs.length >= 6) return res();
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => setTimeout(take, 120));
        else setTimeout(take, 140);
      };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => take());
      else setTimeout(take, 140);
      setTimeout(res, 6000);
    });
    v.pause(); URL.revokeObjectURL(url);

    // How many pixels differ between the first grab and the most different later one?
    let best = 0;
    for (let k = 1; k < grabs.length; k++) {
      let n = 0;
      const a = grabs[0], b2 = grabs[k];
      for (let i = 0; i < a.length; i += 4 * 37) {          // every 37th pixel is plenty
        if (Math.abs(a[i] - b2[i]) + Math.abs(a[i+1] - b2[i+1]) + Math.abs(a[i+2] - b2[i+2]) > 24) n++;
      }
      best = Math.max(best, n);
    }
    const sampled = Math.floor(grabs[0].length / (4 * 37));
    return { grabs: grabs.length, changed: best, sampled, decoded: true,
             pct: sampled ? Math.round((best / sampled) * 1000) / 10 : 0 };
  })()`);
  check("the produced file DECODES in a browser", moved.decoded && moved.grabs >= 2,
    `${moved.grabs} frames read back`);
  check("…and its pixels CHANGE over time — the clip is playing, not a poster",
    moved.changed > 0 && moved.pct > 0.2,
    `${moved.pct}% of sampled pixels differ between frames (${moved.changed}/${moved.sampled})`);
} catch (e) {
  console.log("\nHARNESS ERROR: " + (e && e.stack ? e.stack : e));
  results.push(false);
} finally {
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  await b.done();
  process.exit(results.every(Boolean) ? 0 : 1);
}
