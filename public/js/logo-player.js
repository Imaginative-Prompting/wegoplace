// The sign-in page's wordmark, moving: the hikers' idle loop (public/logo/idle-60.json, 4.8 s
// at 60 frames a second, keyed on the logo's rig; at 30 a re-gripping hand jumped visibly between frames) drawn into the wordmark paintWordmark() put
// in. Its frame 0 is the still wordmark, so the moment it starts shows nothing jump.
//
// The still wordmark stays, and nothing here runs, when:
//   - the device asks for reduced motion (and it goes back to the still if that is turned on
//     while the page is open);
//   - the loop or the letters can't be had (no signal on a cached page, a file that isn't JSON);
//   - the page is in the background (no frames are drawn while it is hidden).
// Light pages get the paper colours and dark ones void's, as the still one does; the gap that
// lifts a hiker off a letter is cut out, so the page's own ground shows through it.
//
// Only the sign-in page plays it. Nothing inside a trip moves by itself.
import { drawFrame } from "./hikers-player.js";

const REDUCED = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

async function json(url) {
  const res = await fetch(url);
  if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

/** Plays the idle loop in `host`'s <svg> (call it once the still wordmark is in). Returns a stop function, which leaves the still one. */
export function playWordmark(host) {
  let stopped = false, raf = 0, still = null, svg = null, loop = null, word = null, start = 0, at = 0, last = "";
  const colorway = () => (document.documentElement.getAttribute("data-lum") === "dark" ? "void" : "paper");

  function showStill() {
    if (svg && still !== null && last !== "still") { svg.innerHTML = still; last = "still"; }
  }
  function tick(t) {
    raf = 0;
    if (stopped || !host.isConnected) return;
    if (REDUCED?.matches) { showStill(); return; }
    if (!start) start = t - at;
    at = t - start;
    const k = Math.floor(((t - start) * loop.fps) / 1000) % loop.frames;
    const cw = colorway(), key = `${cw} ${k}`;
    if (key !== last) {
      svg.innerHTML = drawFrame(loop, k, { letters: word.letters, counters: word.counters, colorway: cw, mode: "mask", id: "wgp-logo", letterStroke: word.letterStroke });
      last = key;
    }
    raf = requestAnimationFrame(tick);
  }
  // The loop and the letters are fetched the first time it may move, never under reduced motion.
  let loading = null;
  // A pause (the page in the background) carries on from the same moment when it comes back.
  const pause = () => { cancelAnimationFrame(raf); raf = 0; start = 0; };
  function resume() {
    if (stopped || raf || REDUCED.matches || document.hidden) return;
    if (!loop) {
      loading ??= Promise.all([json("/logo/idle-60.json"), json("/logo/wordmark-data.json")])
        .then(([l, w]) => { loop = l; word = w; resume(); }, () => {});
      return;
    }
    raf = requestAnimationFrame(tick);
  }
  const onMotion = () => { if (REDUCED.matches) { pause(); at = 0; showStill(); } else resume(); };
  const onVisible = () => { if (document.hidden) pause(); else resume(); };

  svg = host?.querySelector("svg") ?? null;
  if (REDUCED && svg) {
    still = svg.innerHTML;
    REDUCED.addEventListener("change", onMotion);
    document.addEventListener("visibilitychange", onVisible);
    resume();
  }

  return function stop() {
    stopped = true;
    pause();
    REDUCED?.removeEventListener("change", onMotion);
    document.removeEventListener("visibilitychange", onVisible);
    showStill();
  };
}
