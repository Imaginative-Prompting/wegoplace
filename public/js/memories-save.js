// Save originals to the camera roll, and drive the offline media cache.
//
// Two jobs, one file, because they are the same promise seen from two ends: the bytes that
// went up are the bytes that come down, and four days of the trek have no radio to fetch them
// over. Nothing here compresses, transcodes, resizes or re-encodes anything, ever. A save
// fetches the ORIGINAL object and hands those exact bytes to the share sheet; a thumbnail is
// never a substitute for it.
//
// ── the iOS reality, stated once ─────────────────────────────────────────────────────────
// No web app can write to Photos silently. `navigator.share({files})` opens the system share
// sheet and the human taps "Save Image" / "Save N Images". That tap is mandatory and this
// module never pretends otherwise — no copy here or in any caller may imply a silent save.
//
// The gesture rule is PER share() CALL, not per file. One sheet carries many files, so
// "Save 3 Videos" is one tap. The real ceiling is memory: every file must be resident in RAM
// when the sheet opens, and Safari kills the tab somewhere around a gigabyte of payload. So a
// selection is packed GREEDILY into the fewest calls that fit SHARE_BATCH_BYTES below, and a
// selection needing three calls costs three taps — which the UI must say BEFORE the first one
// (`plan.batchCount`, a number, not a paragraph).
//
// share() also needs transient user activation, and on Safari an `await` before the call
// spends it. That is why saveNext() is NOT an async function: when a batch is already primed
// it reaches navigator.share() with no await in front of it. When it is not primed it fetches
// instead and returns {status:"ready"}, and the NEXT tap shares. That is the honest three-tap
// path from the spec. prewarm() exists so a viewer can prime batch 0 while the user is still
// looking at the photo, turning Save back into a single tap.
//
// ── who gets which path ──────────────────────────────────────────────────────────────────
//   share sheet   iOS/iPadOS Safari 15+ and every iOS browser (all WebKit) — the path that
//                 matters, and the only one that reaches Photos. Also Android Chrome 76+,
//                 Samsung Internet, macOS Safari 16.4+, Edge/Chrome on Windows and ChromeOS,
//                 and — measured here, not assumed — Chrome on macOS, which answers
//                 canShare({files}) true and opens the macOS share sheet.
//   download      Firefox anywhere, and anything else where canShare({files}) is false.
//                 downloadBatch() writes the same untouched original bytes to the browser's
//                 download folder. It is NOT a save to Photos and must not be labelled as one.
// The branch is decided by an actual canShare({files}) probe with a real File, never by
// sniffing the user agent — that list is a description of what the probe returns today, not a
// thing this module reasons about.
//
// ── contract with offline media ──────────────────────────────────────────────────────────
// Media items are `memory_media` rows (migration 0007): {r2_key, thumb_key, kind, mime,
// bytes, duration_s, ...}. Anything with `key`/`r2_key` and `mime`/`bytes` is accepted.
// `mediaCache.*` is the bridge to the offline media block in sw.js; the message names are duplicated
// there and nowhere else.

import { store } from "./store.js";

// ── tunables ─────────────────────────────────────────────────────────────────────────────

/**
 * Bytes of file payload one navigator.share() call may carry.
 *
 * This exists because the files are held in RAM while the share sheet is open: iOS builds the
 * whole payload before it draws the sheet, and Safari terminates the page somewhere around
 * ~1 GB. 350 MB is the conservative starting point from the spec — roughly 8 phone photos and
 * 3 short 4K clips, which is one sheet and one tap for a normal day's shooting. It is NOT a
 * per-video rule and must never become one.
 *
 * It is calibrated on an actual iPhone before a trip. Raise it until a save of the
 * biggest realistic selection reloads the page, then come back down a step. Every caller can
 * also pass `batchBytes` to createSaveSession() for a one-off, which is what the harness uses
 * to prove the split without moving 350 MB.
 */
export const SHARE_BATCH_BYTES = 350 * 1024 * 1024;

/**
 * Second, softer ceiling: files per share() call.
 *
 * Bytes are the ceiling that crashes the page; count is the one that makes the sheet unusable.
 * 900 small photos fit inside 350 MB and produce a share sheet iOS renders for several seconds
 * and a "Save 900 Images" tap nobody can undo. 64 is a sheet a person can still read.
 */
export const SHARE_BATCH_FILES = 64;

/**
 * Planning weight for an item whose `bytes` column is missing or zero.
 *
 * Planning happens before anything is fetched, so an unknown size has to be guessed at. Guess
 * HIGH: a batch that turns out smaller than planned costs one extra tap, while a batch that
 * turns out bigger reloads the page and loses the whole save. 8 MB is a large phone photo.
 */
const UNKNOWN_ITEM_BYTES = 8 * 1024 * 1024;

// Sanity rails on a caller-supplied budget. Below the floor no real photo fits in a batch;
// above the ceiling the page is being asked to hold more than Safari survives.
const BUDGET_MIN = 4 * 1024 * 1024;
const BUDGET_MAX = 1024 * 1024 * 1024;

// ── media URLs ───────────────────────────────────────────────────────────────────────────

/**
 * URL of an R2 media object. Exported so the feed, the viewer and this module all build the
 * same string — sw.js caches by exact path, and two spellings of one key are two cache
 * entries and one of them is always the one that is missing offline.
 *
 * Keys may contain "/" and those separators are real path structure, so each segment is
 * encoded on its own rather than percent-escaping the slashes.
 */
export function mediaUrl(key) {
  const k = String(key || "").replace(/^\/+/, "");
  return "/media/" + k.split("/").map(encodeURIComponent).join("/");
}

// ── item normalisation ───────────────────────────────────────────────────────────────────

// Extension per MIME. Used only to NAME the file — never to convert it. iOS decides what a
// share sheet may do with a file from its type, so a .mov handed over as "clip.bin" loses the
// "Save Video" action even though the bytes are perfect.
const EXT = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/gif": "gif",
  "image/webp": "webp", "image/heic": "heic", "image/heif": "heif",
  "image/heic-sequence": "heics", "image/avif": "avif", "image/tiff": "tif",
  "video/quicktime": "mov", "video/mp4": "mp4", "video/x-m4v": "m4v",
  "video/webm": "webm", "video/mpeg": "mpg", "video/3gpp": "3gp",
};

const extFromKey = (key) => {
  const m = /\.([A-Za-z0-9]{2,5})$/.exec(String(key || "").split("/").pop() || "");
  return m ? m[1].toLowerCase() : "";
};

function normalise(raw) {
  if (!raw) return null;
  const key = raw.key || raw.r2_key || raw.r2Key || "";
  if (!key) return null;
  const mime = String(raw.mime || raw.type || "").split(";")[0].trim().toLowerCase();
  const bytes = Number(raw.bytes) > 0 ? Number(raw.bytes) : 0;
  const kind = raw.kind || (mime.startsWith("video/") ? "video" : "photo");
  return {
    id: raw.id || key,
    key,
    thumbKey: raw.thumb_key || raw.thumbKey || "",
    kind,
    mime,
    bytes,
    // seconds from D1, milliseconds when a row was just written locally. Both are accepted
    // for the same reason store.js's toMs() exists.
    createdAt: toMs(raw.created_at ?? raw.createdAt ?? raw.memory_created_at),
    weight: bytes || UNKNOWN_ITEM_BYTES,
    raw,
  };
}

function toMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

// One name per item, numbered across the WHOLE selection rather than per batch, so a save
// that splits into three sheets still lands 1..N in Photos instead of three files called -01.
function fileNameFor(item, n) {
  const d = new Date(item.createdAt || Date.now());
  const day = Number.isFinite(d.getTime())
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    : "trip";
  const ext = EXT[item.mime] || extFromKey(item.key) || (item.kind === "video" ? "mp4" : "jpg");
  return `WeGoPlace-${day}-${String(n).padStart(2, "0")}.${ext}`;
}

// ── capability ───────────────────────────────────────────────────────────────────────────

let capCache = null;

/**
 * What this browser can actually do, measured rather than assumed.
 * @returns {{share:boolean, files:boolean, reason:string}}
 *   files=true  -> the share sheet path; a save ends in the OS "Save Image"/"Save Video" tap.
 *   files=false -> the download fallback; state that plainly in the UI, do not say "Photos".
 */
export function shareCapability() {
  if (capCache) return capCache;
  const share = typeof navigator !== "undefined" && typeof navigator.share === "function";
  let files = false;
  let reason = "";
  if (!share) {
    reason = "no-share";
  } else if (typeof navigator.canShare !== "function") {
    // Web Share level 1: share() exists but files are not part of it.
    reason = "no-canshare";
  } else {
    try {
      // A real File, not an empty object: canShare({files:[]}) answers true in browsers that
      // cannot share a single byte, and a probe that lies is worse than no probe.
      const probe = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "probe.jpg", { type: "image/jpeg" });
      files = navigator.canShare({ files: [probe] });
      if (!files) reason = "files-refused";
    } catch (e) {
      reason = "canshare-threw";
    }
  }
  capCache = { share, files, reason };
  return capCache;
}

/** True when a save can end in Photos. False means the caller must offer a download instead. */
export const canSaveToPhotos = () => shareCapability().files;

// ── planning ─────────────────────────────────────────────────────────────────────────────

const clampBudget = (n) => Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, Number(n) || SHARE_BATCH_BYTES));

/**
 * Pack a selection into the fewest share() calls that fit the budget. Pure — no fetching, no
 * side effects — so the UI can show the tap count before anything is downloaded.
 *
 * Greedy in selection order, which is also display order: a batch keeps taking items until the
 * next one would cross the byte budget or the file-count cap, then a new batch starts. Items
 * are never reordered to pack tighter; "Save 12" landing in Photos out of order to save one
 * tap is a bad trade.
 *
 * An item bigger than the budget on its own cannot be split — a share sheet takes whole files
 * — so it gets a batch to itself and is reported in `oversize`. It is never dropped.
 *
 * @param {object[]} items  memory_media rows
 * @param {{batchBytes?:number, batchFiles?:number}} [opts]
 * @returns {{batches:object[][], batchCount:number, fileCount:number, totalBytes:number,
 *            oversize:object[], budget:number}}
 */
export function planBatches(items, opts = {}) {
  const budget = clampBudget(opts.batchBytes);
  const maxFiles = Math.max(1, Number(opts.batchFiles) || SHARE_BATCH_FILES);
  const list = (items || []).map(normalise).filter(Boolean);

  const batches = [];
  const oversize = [];
  let cur = [];
  let curBytes = 0;
  const flush = () => { if (cur.length) { batches.push(cur); cur = []; curBytes = 0; } };

  for (const it of list) {
    if (it.weight > budget) {
      flush();
      batches.push([it]);
      oversize.push(it);
      continue;
    }
    if (cur.length && (curBytes + it.weight > budget || cur.length >= maxFiles)) flush();
    cur.push(it);
    curBytes += it.weight;
  }
  flush();

  return {
    batches,
    batchCount: batches.length,
    fileCount: list.length,
    totalBytes: list.reduce((n, it) => n + it.weight, 0),
    oversize,
    budget,
  };
}

/**
 * The label the button carries. A count, never a sentence — UI copy should not explain
 * the UI is a defect. Returns e.g. "Save 12" or "Save 12 · 3 taps".
 */
export function saveLabel(plan) {
  if (!plan || !plan.fileCount) return "Save";
  const n = `Save ${plan.fileCount}`;
  return plan.batchCount > 1 ? `${n} · ${plan.batchCount} taps` : n;
}

// ── fetching originals ───────────────────────────────────────────────────────────────────

// Told to sw.js on every save fetch. A 350 MB batch pulled for saving must NOT be written into
// the offline media cache: it would evict everything the trek actually needs, to store copies
// of files that are now in Photos anyway. Already-cached originals still answer from cache —
// this hint suppresses the WRITE, not the read.
const SAVE_HINT = { "x-wgp-media": "save" };

async function fetchOriginal(item, n, { signal, onBytes }) {
  const res = await fetch(mediaUrl(item.key), {
    credentials: "same-origin",
    headers: SAVE_HINT,
    signal,
  });
  if (!res.ok) throw new Error(`media ${res.status} for ${item.key}`);

  // Stream when the body is readable so a 400 MB video reports progress instead of sitting at
  // zero for a minute; fall back to blob() where it is not (older Safari on a cached response).
  let blob;
  if (res.body && typeof res.body.getReader === "function" && onBytes) {
    const reader = res.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      onBytes(value.byteLength);
    }
    blob = new Blob(chunks, { type: res.headers.get("Content-Type") || item.mime || "" });
  } else {
    blob = await res.blob();
    if (onBytes) onBytes(blob.size);
  }

  // THE fidelity check, and the reason a save can be trusted at all. `bytes` is what the
  // upload recorded for this exact object; a body of a different length is a truncated
  // download or the wrong object, and either one must fail loudly rather than land a broken
  // file in someone's camera roll under the name of a real memory.
  if (item.bytes && blob.size !== item.bytes) {
    throw new Error(`length mismatch for ${item.key}: got ${blob.size} B, expected ${item.bytes} B`);
  }

  const type = item.mime || blob.type || "application/octet-stream";
  return new File([blob], fileNameFor(item, n), {
    type,
    lastModified: item.createdAt || Date.now(),
  });
}

// ── the save session ─────────────────────────────────────────────────────────────────────

/**
 * A save in progress. It holds its place across cancels: if the user dismisses the sheet for
 * batch 2 of 3, `index` stays at 1 and the next tap re-opens batch 2. Nothing is re-fetched,
 * because the prepared files are still in memory.
 *
 * Recipe for the UI — this is the whole integration:
 *
 *   const s = createSaveSession(items, { onProgress: render });
 *   if (!s.supported) { await downloadBatch(items); return; }   // no share sheet here
 *   button.textContent = saveLabel(s.plan);                     // "Save 12 · 3 taps"
 *   button.onclick = async () => {
 *     const r = await s.saveNext();          // NOT awaited before the call inside — see below
 *     if (r.status === "ready") return;      // files fetched; the next tap opens the sheet
 *     if (r.status === "cancelled") return;  // sheet dismissed; same batch waits
 *     if (r.status === "error") show(r.error.message);
 *     if (s.done) button.textContent = "Saved";
 *   };
 *
 * saveNext() is deliberately not an `async function`. Safari spends transient user activation
 * on the first `await`, so an async wrapper would make navigator.share() throw NotAllowedError
 * on exactly the browser this feature exists for.
 *
 * @param {object[]} items  memory_media rows, in display order
 * @param {{batchBytes?:number, batchFiles?:number, title?:string, text?:string,
 *          onProgress?:function}} [opts]
 */
export function createSaveSession(items, opts = {}) {
  const plan = planBatches(items, opts);
  const cap = shareCapability();
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};

  let index = 0;                 // next batch to share
  let primed = null;             // { batch, files, bytes } for `index`, or null
  let priming = null;            // in-flight prepare promise
  let controller = null;
  let cancelled = false;

  const numberOffset = (i) => plan.batches.slice(0, i).reduce((n, b) => n + b.length, 0);

  const emit = (phase, extra) => onProgress(Object.assign({
    phase,
    batch: index + 1,
    batchCount: plan.batchCount,
    fileCount: plan.fileCount,
  }, extra || {}));

  function prepare(i = index) {
    if (primed && primed.i === i) return Promise.resolve(primed);
    if (priming && priming.i === i) return priming.p;

    const batch = plan.batches[i];
    if (!batch) return Promise.resolve(null);

    controller = new AbortController();
    const total = batch.reduce((n, it) => n + it.weight, 0);
    let loaded = 0;
    emit("fetching", { loaded: 0, total });

    const p = (async () => {
      const files = [];
      let base = numberOffset(i);
      for (const it of batch) {
        const f = await fetchOriginal(it, ++base, {
          signal: controller.signal,
          onBytes: (n) => {
            loaded += n;
            emit("fetching", { loaded, total });
          },
        });
        files.push(f);
      }
      const out = { i, batch, files, bytes: files.reduce((n, f) => n + f.size, 0) };
      primed = out;
      priming = null;
      emit("ready", { bytes: out.bytes });
      return out;
    })();

    priming = { i, p };
    p.catch(() => { priming = null; });
    return p;
  }

  // Sync entry, no awaits before share(). Everything after the call may await freely.
  function shareNow() {
    if (!primed || primed.i !== index) {
      return Promise.resolve({ status: "error", error: new Error("batch not primed") });
    }
    const files = primed.files;

    // Re-check against the ACTUAL files. The probe in shareCapability() proves the browser can
    // share a 4-byte JPEG; it says nothing about whether it will accept a 300 MB .mov.
    if (typeof navigator.canShare === "function" && !navigator.canShare({ files })) {
      return Promise.resolve({ status: "unsupported", error: new Error("canShare refused this batch") });
    }

    const payload = { files };
    if (opts.title) payload.title = opts.title;
    if (opts.text) payload.text = opts.text;

    let p;
    try {
      p = navigator.share(payload);           // <- must be the first thing the gesture reaches
    } catch (e) {
      return Promise.resolve({ status: classify(e), error: e });
    }

    return p.then(
      () => {
        // Resolved means the sheet was dismissed by ACTING on it. It does NOT mean the user
        // tapped "Save Image" specifically — iOS resolves the same way for AirDrop or Messages
        // and tells the page nothing about which action ran. So this advances the batch, and
        // no caller may render it as "saved to Photos" with any more certainty than that.
        index += 1;
        primed = null;
        emit(index >= plan.batchCount ? "done" : "next");
        return { status: "shared", batch: index, batchCount: plan.batchCount, done: index >= plan.batchCount };
      },
      (e) => {
        const status = classify(e);
        // Cancelling keeps the place AND the fetched files: the next tap re-opens the same
        // sheet with no download. A cancel that restarted the save would punish the one user
        // action people take by accident.
        emit(status === "cancelled" ? "cancelled" : "error", { error: e });
        return { status, error: e };
      },
    );
  }

  return {
    /** The batching plan. `plan.batchCount` is the tap count the UI must show up front. */
    plan,
    /** Capability probe result; `supported` is the short form. */
    capability: cap,
    supported: cap.files,
    get index() { return index; },
    get batchCount() { return plan.batchCount; },
    get done() { return index >= plan.batchCount; },
    /** True when the next tap opens the sheet rather than starting a download. */
    get ready() { return !!primed && primed.i === index; },

    /**
     * Fetch the next batch's originals WITHOUT sharing. Call it when a viewer opens so the
     * Save tap is a single tap. Safe to call repeatedly; the second call is a no-op.
     */
    prewarm: () => prepare(index).then(() => ({ status: "ready" })),

    /**
     * The click handler. Not async on purpose — see the note above.
     * @returns {Promise<{status:"ready"|"shared"|"cancelled"|"error"|"unsupported"|"done"}>}
     */
    saveNext() {
      if (cancelled) return Promise.resolve({ status: "error", error: new Error("session aborted") });
      if (index >= plan.batchCount) return Promise.resolve({ status: "done" });
      if (!cap.files) return Promise.resolve({ status: "unsupported", error: new Error(cap.reason) });
      if (primed && primed.i === index) return shareNow();
      return prepare(index).then(
        (out) => (out ? { status: "ready", bytes: out.bytes, batch: index + 1, batchCount: plan.batchCount }
                      : { status: "done" }),
        (e) => ({ status: e && e.name === "AbortError" ? "cancelled" : "error", error: e }),
      );
    },

    /** Stop an in-flight fetch. The session cannot be reused afterwards. */
    abort() {
      cancelled = true;
      if (controller) controller.abort();
      primed = null;
      priming = null;
      emit("aborted");
    },
  };
}

// AbortError is the user dismissing the sheet and is not a failure — it must not raise an
// error banner, and it must not lose the batch. NotAllowedError is the gesture rule being
// broken (an await crept in before share(), or the call came from a timer) and IS a bug.
function classify(e) {
  if (!e) return "error";
  if (e.name === "AbortError") return "cancelled";
  return "error";
}

// ── fallback: plain download ─────────────────────────────────────────────────────────────

/**
 * The path for browsers with no file-share: Firefox anywhere, Chrome on macOS and Linux, any
 * headless run. Bytes are identical to the share path — same fetch, same length check, same
 * original object. What differs is the destination: the browser's download folder, not Photos.
 * Say that in the UI; a "Save to Photos" label on this path would be a lie.
 *
 * Sequential and one anchor at a time, because Safari and Firefox both drop all but the first
 * of a burst of programmatic downloads.
 */
export async function downloadBatch(items, opts = {}) {
  const list = (items || []).map(normalise).filter(Boolean);
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  const saved = [];
  const failed = [];
  let n = 0;
  for (const it of list) {
    n += 1;
    onProgress({ phase: "downloading", index: n, total: list.length });
    try {
      const file = await fetchOriginal(it, n, { signal: opts.signal });
      await dropAnchor(file);
      saved.push(file.name);
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      failed.push({ key: it.key, error: e });
    }
  }
  onProgress({ phase: "done", index: n, total: list.length });
  return { saved, failed };
}

/** One item, one download. */
export const downloadItem = (item, opts) => downloadBatch([item], opts);

function dropAnchor(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.rel = "noopener";
  a.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px";
  document.body.appendChild(a);
  a.click();
  // Revoking synchronously races the browser's own read of the blob in WebKit. One frame plus
  // a tick is enough everywhere, and holding a 400 MB object URL any longer is what makes the
  // second download in a row fail on a phone.
  return new Promise((r) => setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
    r();
  }, 250));
}

/**
 * One entry point when the caller does not want to branch itself. Uses the share sheet where
 * it exists and downloads where it does not. NOTE: the share path still needs a gesture per
 * batch, so this is only a one-call answer for browsers on the download path or for a
 * single-batch selection triggered from a click handler.
 */
export function saveMedia(items, opts = {}) {
  if (!canSaveToPhotos()) return downloadBatch(items, opts).then((r) => ({ status: "downloaded", ...r }));
  const session = createSaveSession(items, opts);
  return session.saveNext().then((r) => Object.assign({ session }, r));
}

// ── offline media cache (bridge to the offline media block in sw.js) ─────────────────────
//
// sw.js owns the storage; this is the only thing that talks to it. The rules it enforces:
// thumbnails are cached on sight, originals only when pinned or explicitly prefetched, the
// whole lot lives under a byte ceiling, and eviction is LRU that never touches a pin.
//
// register() first, always. The worker classifies a /media/ response as thumb or original from
// the `bytes` column this call gives it — guessing from Content-Length is the fallback, and a
// wrong guess either fills the phone with 4K video or refuses to keep a 40 KB thumbnail.

const SW_TIMEOUT = 8000;

async function callSW(type, payload) {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) {
    return { ok: false, reason: "no-sw" };
  }
  let reg;
  try {
    reg = await navigator.serviceWorker.ready;
  } catch {
    return { ok: false, reason: "no-sw" };
  }
  const target = navigator.serviceWorker.controller || (reg && reg.active);
  if (!target) return { ok: false, reason: "no-controller" };

  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => { ch.port1.close(); resolve({ ok: false, reason: "timeout" }); }, SW_TIMEOUT);
    ch.port1.onmessage = (e) => {
      clearTimeout(t);
      ch.port1.close();
      resolve(e.data || { ok: true });
    };
    target.postMessage(Object.assign({ type }, payload), [ch.port2]);
  });
}

const keysOf = (items) => (Array.isArray(items) ? items : [items])
  .map((x) => (typeof x === "string" ? x : (x && (x.key || x.r2_key || x.r2Key))))
  .filter(Boolean);

export const mediaCache = {
  /**
   * Teach the worker what the feed knows: exact byte lengths per key, and which key is the
   * thumbnail of which original. Call it after every feed load. Cheap and idempotent.
   */
  register: (items) => callSW("media/register", {
    items: (items || []).map(normalise).filter(Boolean).map((it) => ({
      key: it.key, bytes: it.bytes, kind: it.kind, mime: it.mime, thumbKey: it.thumbKey,
    })),
  }),

  /**
   * Pull originals into the cache now. This is what "opening a memory prefetches its
   * originals" means, and it is what turns a save into the two-tap case. Needs signal; it is
   * a no-op that reports `{ok:false}` without one.
   */
  prefetch: (items) => callSW("media/prefetch", { keys: keysOf(items) }),

  /**
   * Keep these originals offline no matter what. A pin is never evicted — that is the whole
   * point of the four trek days — so a pinned set larger than the ceiling stops new caching
   * rather than silently dropping something the user asked for.
   */
  pin: (items) => callSW("media/pin", { keys: keysOf(items) }),

  /** Release a pin. The bytes stay until LRU wants the room. */
  unpin: (items) => callSW("media/unpin", { keys: keysOf(items) }),

  /** Drop these from the cache outright (used after the author deletes a memory). */
  forget: (items) => callSW("media/forget", { keys: keysOf(items) }),

  /** @returns {Promise<{ok, originals:{count,bytes}, thumbs:{count,bytes}, pinned:{count,bytes}, budget}>} */
  stats: () => callSW("media/stats"),

  /**
   * Move the originals ceiling. Persisted in the cache index, clamped by the worker. Exists
   * for the same reason SHARE_BATCH_BYTES is tunable: the right number is a property of the
   * phone, not of this repo.
   */
  setBudget: (bytes) => callSW("media/budget", { bytes }),

  /**
   * Whether the OS promised not to evict this origin.
   *
   * store.js already calls navigator.storage.persist() at boot (requestPersistence()) and this
   * deliberately does not call it a second time — a duplicate prompt-shaped call is how one of
   * the two ends up reading a stale answer. This just makes the answer reachable from the
   * Memories tab, because a phone WITHOUT persistence can lose the trip's cached photos to a
   * routine storage sweep and the trip owner should learn that before the trailhead, not after.
   */
  persisted: async () => {
    try { await store.ready(); } catch { /* boot failure is not this module's to report */ }
    return store.persisted();
  },
};

export default { createSaveSession, planBatches, saveMedia, downloadBatch, mediaCache, mediaUrl };
