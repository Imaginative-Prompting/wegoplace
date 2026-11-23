// A trip's map maker: one Durable Object per trip (env.MAPS.getByName(<trip id>)) that cuts the
// trip's map (src/map/cut.js) when its areas change. Not the trip's room (src/trips/room.js), which
// must set no alarm so it hibernates; this one sets an alarm only while a cut is owed.
//
//   ask({ trip, forced })  an areas write (or the host asking) owes a cut: an alarm MAP_DELAY_MS on
//                          (15 s), so several writes in a row are one cut. Asked again before it
//                          fires, it moves on. When a cut will really follow (the regions' bounds
//                          changed or the host asked, the map isn't one put in by hand, the day's
//                          cuts aren't used up), the trip says "cutting" at once, so a phone that
//                          opens the map in those seconds reads that its map is being made.
//   alarm()                runs the cut, one at a time for the trip by construction. At most
//                          MAP_CUTS_PER_DAY a day (UTC): past that the trip's note says when it can
//                          cut again, and the alarm is set for then.
//
// It stores four small values: the trip's id, whether the owed cut is forced, the day's count, and
// the regions' bounds the last map was cut from (an areas write that didn't change them cuts nothing).

import { DurableObject } from "cloudflare:workers";
import { MAP_CUTS_PER_DAY } from "../../public/js/shared/limits.js";
import { cutTrip, regionsOf } from "./cut.js";
import { REV, write } from "../trips/rev.js";
import { errorLine } from "../log.js";

const DELAY_MS = 15000;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

export class TripMap extends DurableObject {
  async ask({ trip, forced = false }) {
    await this.ctx.storage.put("trip", trip);
    if (forced) await this.ctx.storage.put("forced", true);
    const delay = Number(this.env.MAP_DELAY_MS) >= 0 && this.env.MAP_DELAY_MS !== undefined ? Number(this.env.MAP_DELAY_MS) : DELAY_MS;
    await this.ctx.storage.setAlarm(Date.now() + delay);
    await this.sayComing(trip, forced);
    return { at: Date.now() + delay };
  }

  /** The trip's map state "cutting" from the ask, when the alarm will cut (its own tests, read the same way). */
  async sayComing(trip, forced) {
    const count = await this.ctx.storage.get("count");
    if (count?.day === day(Date.now()) && count.n >= MAP_CUTS_PER_DAY) return;
    const regions = await regionsOf(this.env, trip);
    if (!regions.length) return;
    const row = await this.env.DB.prepare("SELECT tiles, tiles_state, tiles_source FROM trips WHERE id = ?1").bind(trip).first();
    if (!row || row.tiles_state === "cutting") return;
    if (!forced && row.tiles && row.tiles_source && row.tiles_source !== "cut") return;
    const sig = JSON.stringify(regions.map((r) => [r.id, r.west, r.south, r.east, r.north]));
    if (!forced && sig === (await this.ctx.storage.get("sig")) && row.tiles_state === "ready" && row.tiles_source === "cut") return;
    await write(this.env, trip, [this.env.DB.prepare(
      `UPDATE trips SET tiles_state = 'cutting', tiles_note = '', tiles_at = ?2, rev = ${REV(1)} WHERE id = ?1`,
    ).bind(trip, Math.floor(Date.now() / 1000))]);
  }

  async alarm() {
    const trip = await this.ctx.storage.get("trip");
    if (!trip) return;
    const forced = (await this.ctx.storage.get("forced")) === true;
    const today = day(Date.now());
    const count = await this.ctx.storage.get("count");
    const n = count?.day === today ? count.n : 0;
    if (n >= MAP_CUTS_PER_DAY) {
      const tomorrow = Date.parse(`${today}T00:00:00Z`) + 86400000;
      await write(this.env, trip, [this.env.DB.prepare(
        `UPDATE trips SET tiles_note = ?2, rev = ${REV(1)} WHERE id = ?1`,
      ).bind(trip, `This trip's map was made ${MAP_CUTS_PER_DAY} times today; the next one is made after midnight (UTC), with every change since.`)]);
      await this.ctx.storage.setAlarm(tomorrow + 1000);
      return;
    }
    // Nothing to cut when the regions' bounds are what the map was cut from (a name changed, a
    // neighborhood was added) and the map is there.
    const regions = await regionsOf(this.env, trip);
    const sig = JSON.stringify(regions.map((r) => [r.id, r.west, r.south, r.east, r.north]));
    const row = await this.env.DB.prepare("SELECT tiles_state, tiles_source FROM trips WHERE id = ?1").bind(trip).first();
    if (!forced && sig === (await this.ctx.storage.get("sig")) && row?.tiles_state === "ready" && row?.tiles_source === "cut") {
      this.last = { state: "unchanged" };
      return;
    }
    await this.ctx.storage.put("count", { day: today, n: n + 1 });
    await this.ctx.storage.delete("forced");
    const result = await cutTrip(this.env, trip, { forced });
    if (result.state === "ready" || result.state === "none") await this.ctx.storage.put("sig", sig);
    // leftOut is the areas' NAMES (a trip's titles): counted, never named, in the log. A failed cut's `why` is its
    // error's message: map_cut_failed (src/map/cut.js) logs that error as errorLine has it.
    console.log(JSON.stringify({ map_cut: trip, ...result, regions: undefined, why: undefined, leftOut: result.leftOut?.length ?? 0, glyphs: result.glyphs?.length }));
    this.last = result;
  }

  /** What the last cut in this object's memory did (for the checks). */
  async lastCut() { return this.last ?? null; }
}
