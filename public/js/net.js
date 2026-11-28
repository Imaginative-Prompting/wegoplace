// net.js — how long the app waits on the server, in one place.
//
// The service worker never touches /api/, so a request held open (one bar that carries nothing,
// a server that took the connection and stalled) waits for the browser to give up: about a
// minute in Safari, minutes in Chrome. All that time the screen says nothing, and a write on the
// wire holds everything queued behind it. So every request to the API is given up after a while
// of its own, and every caller treats a request given up as no signal: nothing came back, so
// nothing is known to have been refused, and what was being sent is kept and sent again.
//
// Uploads are different. A photo on a slow line can take minutes and be fine, as long as it
// moves. So an upload has no clock at all, only a stall: it is given up when no bytes have moved
// for STALL_MS, or when that long has passed since the last byte with no answer. The assistant's
// answer, which streams while it is worked out, has the same stall and no clock either.

/** A read (GET, HEAD), from the request to the end of its answer's body. */
export const READ_LIMIT_MS = 12_000;
/** A write: small, but the server does more with it. */
export const WRITE_LIMIT_MS = 20_000;
/** An upload or a streamed answer: this long with nothing moving. */
export const STALL_MS = 30_000;

const limitOf = (method) => (method === "GET" || method === "HEAD" ? READ_LIMIT_MS : WRITE_LIMIT_MS);

/**
 * Runs `run(signal)` (a fetch and the reading of its body) under the method's limit. The signal
 * aborts at the limit, so a fetch not yet answered rejects and a body half read throws: each
 * caller already treats both as no answer. The timer is cleared however `run` ends.
 */
export async function within(method, run) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), limitOf(method));
  try {
    return await run(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetch(), under the method's limit, its answer's body read in full inside the limit and handed
 * back as a Response, so a caller reads it (res.ok, res.status, await res.json()) as it read
 * fetch's. Given up, it rejects, as fetch() rejects with no signal: each caller already takes
 * that for no signal. For small JSON answers: never an upload, a stream or a file.
 */
export function fetchWithin(input, init = {}) {
  return within(init.method || "GET", async (signal) => {
    const res = await fetch(input, { ...init, signal });
    const nobody = [101, 204, 205, 304].includes(res.status);
    const body = nobody ? null : await res.arrayBuffer();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  });
}

/**
 * Sends bytes (a Blob, a File, an ArrayBuffer) over XHR, the only way a page sees an upload's
 * progress, and gives it up on a stall. Resolves, never rejects:
 *   { ok, status, body }      the server answered (body is its JSON, or null)
 *   { ok: false, status: 0 }  no answer: the line failed, or the phone said "offline"
 *   { ok: false, status: 0, stalled: true }  nothing moved for `stallMs` (STALL_MS unless given), and it was given up:
 *                             a caller that still has signal may send it again with a longer stall (a slow server)
 * `onProgress(loaded)` gets the bytes sent so far.
 *
 * The phone saying it has no signal (the window's "offline") gives a send up at once: a request in flight then neither
 * moves nor fails until the stall's limit, so an upload sat "Uploading" for 30 s and only then waited, by which time
 * the signal was back and its "online" gone by (up to ~45 s to go on, 27 Nov). Given up, the caller waits for signal
 * and sends that part again; at most one part is sent twice.
 */
export function sendBytes(url, body, { method = "POST", type = "application/octet-stream", headers = {}, onProgress, stallMs = STALL_MS } = {}) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let stall = 0, stalled = false;
    const lost = () => xhr.abort();
    const done = (r) => { clearTimeout(stall); removeEventListener("offline", lost); resolve(r); };
    addEventListener("offline", lost);
    const wait = () => { clearTimeout(stall); stall = setTimeout(() => { stalled = true; xhr.abort(); }, stallMs); };
    xhr.open(method, url);
    xhr.responseType = "json";
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    if (type) xhr.setRequestHeader("Content-Type", type);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    // Every sign of movement starts the stall's count again: bytes going up, the last of them
    // gone (then the count is the wait for an answer), the answer's first bytes coming down.
    xhr.upload.onprogress = (e) => { wait(); if (e.lengthComputable && onProgress) onProgress(e.loaded); };
    xhr.upload.onload = wait;
    xhr.onprogress = wait;
    xhr.onload = () => done({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body: xhr.response ?? null });
    xhr.onerror = () => done({ ok: false, status: 0, body: null });
    xhr.onabort = () => done({ ok: false, status: 0, body: null, ...(stalled ? { stalled: true } : {}) });
    xhr.ontimeout = () => done({ ok: false, status: 0, body: null });
    wait();
    xhr.send(body);
  });
}
