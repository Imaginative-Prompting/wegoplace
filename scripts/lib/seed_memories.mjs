/* Seed real memories over the real API, and take them away again.
 *
 * WHY THIS IS A LIBRARY AND NOT A FIXTURE. The local D1 is normally EMPTY of memories — the
 * suites that touch them seed their own rows and delete them, because a check that counts rows
 * breaks on a leftover one (that is the 32/33 in the design-pass-2 reports).
 * The consequence is that anything which renders #/memories WITHOUT seeding is measuring three
 * empty states: a feed with no cards, a stamp list with no stamps, and a collage board with no
 * photos — and an empty board cannot overhang anything. So a check that wants to say something
 * about the three Memories views has to bring its own content.
 *
 * The photo is made, not photographed (checks/lib/images.mjs: a sky over a ridge), turned into a
 * JPEG with sips, so there is no fixture to persist and nothing to download. The memories go on
 * the gate's made-up trip, as its host (scripts/lib/gate_trip.mjs).
 *
 * DELETION IS THE CONTRACT. cleanup() is idempotent and is wired to process exit by seed(),
 * so a crash mid-run still takes the rows with it.
 */
"use strict";

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scene } from "../../checks/lib/images.mjs";
import { ORIGIN, signIn, tripApi } from "./gate_trip.mjs";

const PART = 8 * 1024 * 1024;

/** Requests as the trip's host, signed in for this run: api(path, { method, body }) answers { status, json, text }. */
export async function makeApi() {
  const host = await signIn();
  const api = async (p, { method = "GET", body = null } = {}) => {
    const res = await host.call(method, p, body instanceof Uint8Array ? Buffer.from(body) : body);
    return { status: res.status, json: res.json, text: res.text };
  };
  api.session = host.jar.cookies.get("wgp_session");
  return api;
}

/**
 * @param {number} count how many memories to create
 * @returns {{ids: string[], cleanup: () => Promise<void>, captions: string[]}} (captions: the words the memories carry)
 */
export async function seedMemories(count = 6, { tag = "standalone verify" } = {}) {
  const api = await makeApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-seed-"));
  const photo = path.join(dir, "seed.jpg");
  const thumb = path.join(dir, "seed.thumb.jpg");
  const src = path.join(dir, "seed.png");
  fs.writeFileSync(src, scene(2000, 1500, 28));
  execSync(`sips -s format jpeg -Z 2000 ${JSON.stringify(src)} --out ${JSON.stringify(photo)}`, { stdio: "ignore" });
  execSync(`sips -s format jpeg -Z 480 ${JSON.stringify(photo)} --out ${JSON.stringify(thumb)}`, { stdio: "ignore" });
  const o = execSync(`sips -g pixelWidth -g pixelHeight ${JSON.stringify(photo)}`).toString();
  const w = Number(/pixelWidth: (\d+)/.exec(o)[1]), h = Number(/pixelHeight: (\d+)/.exec(o)[1]);
  const buf = fs.readFileSync(photo);
  const tbuf = new Uint8Array(fs.readFileSync(thumb));
  // Both pictures are in memory now, so the folder goes here and not in cleanup(): a caller
  // that leans on the exit handler below never calls cleanup(), and each run of it used to
  // leave a folder of two JPEGs in the temp directory.
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }

  const ids = [];
  const keys = [];        // every object this seeder put in the bucket, attached or not

  const upload = async () => {
    const beg = await api(tripApi("/media/begin"), { method: "POST", body: { name: "seed.jpg", mime: "image/jpeg", bytes: buf.length, kind: "photo" } });
    if (beg.status !== 201) throw new Error("media/begin: " + beg.text);
    const { key, uploadId, parts } = beg.json;
    const etags = [];
    for (let n = 1; n <= parts; n++) {
      const slice = buf.subarray((n - 1) * PART, Math.min(n * PART, buf.length));
      const r = await api(`${tripApi("/media/part")}?key=${encodeURIComponent(key)}&id=${encodeURIComponent(uploadId)}&n=${n}`, { method: "POST", body: slice });
      if (r.status !== 200) throw new Error(`media/part ${n}: ` + r.text);
      etags.push({ n, etag: r.json.etag });
    }
    const fin = await api(tripApi("/media/finish"), { method: "POST", body: { key, id: uploadId, parts: etags } });
    if (fin.status !== 200) throw new Error("media/finish: " + fin.text);
    keys.push(key);
    return key;
  };

  let wired = false;
  const cleanup = async () => {
    while (ids.length) {
      const id = ids.pop();
      try { await api(tripApi(`/memories/${id}`), { method: "DELETE" }); } catch { }
    }
    // Deleting a memory DOES cascade to its media (measured: usage went 8 objects -> 6 when
    // one seeded memory was deleted). What does NOT get cleaned up is an upload whose memory
    // POST never happened — a throw between media/finish and memories POST leaves the object
    // in the bucket with nothing pointing at it, and an orphan is invisible to a row count
    // while still failing any check that the trip and the bucket are left empty.
    // This session left six such orphans that way, and they had to be swept by hand. So every
    // key is offered to the trip's media/object: already-cascaded keys answer deleted:false, an
    // attached one answers 409, and only a real orphan is actually removed.
    while (keys.length) {
      const k = keys.pop();
      try { await api(`${tripApi("/media/object")}?key=${encodeURIComponent(k)}`, { method: "DELETE" }); } catch { }
    }
  };

  // Captions vary in length on purpose: a one-word caption and a wrapping one exercise
  // different row heights, which is what the feed's geometry actually depends on.
  const caps = ["Train into the valley", "Platform", "Blue car 224, the 06:10 out of the junction",
                "Rain on the rails", "The last bridge", "Three of us ahead on the switchbacks"];
  // A check's memories carry its own tag; stills meant to be shown pass a plain made-up one.
  const tags = [tag];
  try {
    for (let i = 0; i < count; i++) {
      const key = await upload();
      const tr = await api(`${tripApi("/media/thumb")}?for=${encodeURIComponent(key)}&mime=image/jpeg`, { method: "POST", body: tbuf });
      if (tr.status !== 200 && tr.status !== 201) throw new Error("media/thumb: " + tr.text);
      if (tr.json && tr.json.key) keys.push(tr.json.key);
      const r = await api(tripApi("/memories"), {
        method: "POST",
        body: { caption: caps[i % caps.length], tags,
                media: [{ key, thumb_key: tr.json.key, kind: "photo", w, h }] },
      });
      if (r.status !== 201) throw new Error("memories POST: " + r.text);
      ids.push(r.json.memory.id);
      if (!wired) {
        wired = true;
        // A crash must not leave rows behind: the checks that count them would break.
        process.on("exit", () => {
          if (!ids.length) return;
          try {
            execSync(`node -e ${JSON.stringify(
              `(async()=>{for(const id of JSON.parse(process.env.IDS)){` +
              `await fetch(process.env.AT+id,{method:"DELETE",headers:{Cookie:"wgp_session="+process.env.SESSION,Origin:process.env.FROM}});}})()`)}`,
              { stdio: "ignore", env: { ...process.env, IDS: JSON.stringify(ids), AT: `${ORIGIN}${tripApi("/memories/")}`, SESSION: api.session, FROM: ORIGIN } });
          } catch { }
        });
      }
    }
  } catch (e) { await cleanup(); throw e; }
  return { ids, cleanup, captions: caps.slice(0, Math.min(count, caps.length)) };
}
