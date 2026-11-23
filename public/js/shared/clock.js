// Clock times in a zone, both ways (model §16: "Event times through the MCP are local clock
// times"). Pure: the Worker's tools and the app can both use it.
//
// A booking prints the time where it happens ("dep 07:40 Lisbon"); an event keeps an instant
// (epoch seconds) and the zone it's read in. readClock() turns the printed form into the instant:
//   * "2027-05-08T07:40" read in `tz`;
//   * "2027-05-08T07:40+01:00" (or Z): the offset says the instant, and `tz` is only how it's
//     shown;
//   * a time that doesn't exist in `tz` (the hour the clocks skip) or happens twice (the hour
//     they repeat) is refused, with what it could mean, so whoever wrote it chooses.
// clockOf() is the other way: an instant as its local date, time and weekday in a zone.

const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const formatters = new Map();
function partsIn(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Whether `tz` is a zone this runtime knows. */
export function isZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try { partsIn(tz); return true; } catch { return false; }
}

/** An instant (epoch seconds) as its clock in `tz`: { date: "YYYY-MM-DD", time: "HH:MM", weekday, offset: "+01:00" }. */
export function clockOf(epoch, tz) {
  const p = Object.fromEntries(partsIn(tz).formatToParts(new Date(epoch * 1000)).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000;
  const off = Math.round((asUtc - epoch) / 60);
  const sign = off < 0 ? "-" : "+";
  const offset = `${sign}${String(Math.floor(Math.abs(off) / 60)).padStart(2, "0")}:${String(Math.abs(off) % 60).padStart(2, "0")}`;
  return { date, time: `${p.hour}:${p.minute}`, weekday: WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()], offset };
}

/** The weekday of a calendar day "YYYY-MM-DD". */
export const weekdayOf = (day) => WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];

/** The days from `first` to `last` ("YYYY-MM-DD", both included), each with its weekday. */
export function daysBetween(first, last) {
  const out = [];
  for (let t = Date.parse(`${first}T12:00:00Z`), end = Date.parse(`${last}T12:00:00Z`); t <= end && out.length < 400; t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push({ day, weekday: weekdayOf(day) });
  }
  return out;
}

/**
 * A clock time as an instant. Answers { epoch } or { error, reason, readings? }, where readings
 * are the instants a repeated time could mean, each with its offset.
 */
export function readClock(value, tz) {
  const m = typeof value === "string" ? CLOCK.exec(value.trim()) : null;
  if (!m) return { error: "bad time", reason: `A time is written YYYY-MM-DDTHH:MM, as the booking prints it where it happens (2027-05-08T07:40), read in the event's zone; ${value === undefined || value === null || value === "" ? "none was given" : `got ${JSON.stringify(value)}`}.` };
  if (tz === undefined || tz === null || tz === "") return { error: "no zone", reason: "No time zone was given. A zone is an IANA name, like Europe/Lisbon." };
  if (!isZone(tz)) return { error: "bad zone", reason: `${JSON.stringify(tz)} isn't a time zone. A zone is an IANA name, like Europe/Lisbon.` };
  const [, y, mo, d, h, mi, s = "00", off] = m;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) / 1000;
  const check = new Date(wall * 1000);
  if (check.getUTCFullYear() !== +y || check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 59) {
    return { error: "bad time", reason: `${value} isn't a date and time on the calendar.` };
  }
  if (off) {
    if (off === "Z") return { epoch: wall };
    const sign = off[0] === "-" ? -1 : 1;
    return { epoch: wall - sign * (Number(off.slice(1, 3)) * 3600 + Number(off.slice(4, 6)) * 60) };
  }
  // The instants whose clock in tz is this one: try the zone's offsets around it.
  const want = `${y}-${mo}-${d} ${h}:${mi}`;
  const found = new Set();
  for (const probe of [wall - 2 * 86400, wall - 86400, wall, wall + 86400, wall + 2 * 86400]) {
    const c = clockOf(probe, tz);
    const sign = c.offset[0] === "-" ? -1 : 1;
    const shift = sign * (Number(c.offset.slice(1, 3)) * 3600 + Number(c.offset.slice(4, 6)) * 60);
    const at = wall - shift;
    const back = clockOf(at, tz);
    if (`${back.date} ${back.time}` === want) found.add(at);
  }
  const at = [...found].sort((a, b) => a - b);
  if (at.length === 1) return { epoch: at[0] };
  if (!at.length) {
    return { error: "no such time", reason: `${value} doesn't happen in ${tz}: the clocks skip it. Write the time the booking means, or give it with its offset (${value}+hh:mm).` };
  }
  const readings = at.map((e) => ({ at: `${value}${clockOf(e, tz).offset}`, epoch: e }));
  return {
    error: "time happens twice", readings,
    reason: `${value} happens twice in ${tz} (the clocks go back): ${readings.map((r) => r.at).join(" or ")}. Give it with its offset to say which.`,
  };
}
