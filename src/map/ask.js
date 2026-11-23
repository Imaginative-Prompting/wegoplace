// An areas write (or the host) asks for the trip's map to be cut again (src/map/map-object.js),
// after the answer where the Worker can wait for it. Never fails the write. Kept apart from the
// object's own module so the routes that call it load in Node too (the checks import them).
import { errorLine } from "../log.js";

export async function askForMap(env, tripId, { forced = false } = {}) {
  if (!env.MAPS) return;
  const go = env.MAPS.getByName(tripId).ask({ trip: tripId, forced })
    .catch((e) => console.log(JSON.stringify({ map_ask_failed: tripId, error: errorLine(e, env) })));
  if (env.LATER) env.LATER(go);
  else await go;
}
