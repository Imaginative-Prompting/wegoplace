// The first thing a person says to their own AI about a trip: written once, here, and read by the app's "Plan it with
// your AI" sheet and by the MCP's own prompt (src/mcp/server.js, plan_this_trip), so the two never say it differently.
// Pure: no imports, nothing that runs.
//
// It holds to what the trip-setup guide asks of an AI (src/mcp/guides/trip-setup.md): read the trip before writing,
// write only what it has from the person or from a source it read, and say what it couldn't confirm. So the ask says
// those three things in the person's own voice, and nothing the guide already tells the AI.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NUMBERS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** "Mar 6 to 13", "Mar 30 to Apr 2", "Dec 30, 2027 to Jan 2, 2028"; "" without both dates. */
export function dateRange(startsOn, endsOn) {
  const at = (d) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split("-").map(Number) : null);
  const a = at(startsOn), b = at(endsOn);
  if (!a || !b) return "";
  const day = (x) => `${MONTHS[x[1] - 1]} ${x[2]}`;
  if (a[0] !== b[0]) return `${day(a)}, ${a[0]} to ${day(b)}, ${b[0]}`;
  if (a[1] === b[1]) return a[2] === b[2] ? day(a) : `${day(a)} to ${b[2]}`;
  return `${day(a)} to ${day(b)}`;
}

/** "for six of us", "for the two of us", "just me"; "" when the count isn't known. */
export function peopleWords(n) {
  if (!Number.isInteger(n) || n < 1) return "";
  if (n === 1) return "just me";
  if (n === 2) return "for the two of us";
  return `for ${NUMBERS[n] || n} of us`;
}

/** What to do, once the trip is said: the same in every first ask. */
export const PLAN_WORDS = "look up what's worth doing, add a plan for each day with times you've checked, " +
  "and save the places worth knowing with why each one is. Tell me anything you couldn't confirm.";

/**
 * The first ask, from what is known of the trip: its name (always), its place, its dates and how many are on it (each
 * left out when not known). Quotes in the name are kept as typed: the name is the person's own.
 */
export function firstAsk({ name, place = "", starts_on = "", ends_on = "", people = 0 } = {}) {
  const trip = String(name || "").trim() || "our trip";
  const where = String(place || "").trim();
  const when = dateRange(starts_on, ends_on);
  const who = peopleWords(people);
  const about = [where ? `in ${where}` : "", when, who].filter(Boolean).join(", ");
  return `In WeGoPlace, plan my trip "${trip}"${about ? `, ${about}` : ""}. Read the trip first. Then ${PLAN_WORDS}`;
}
