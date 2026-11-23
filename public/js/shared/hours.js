// Opening hours: the one format, its two readers, its writer, and "is it open now".
//
// PURE, AND SHARED. No DOM, no storage, no imports: the app's pages import it to draw the
// "Open" badge, and the Worker imports the same file to refuse a place whose hours it cannot
// read. One reader on both sides is the point. When they were two, the server would have
// stored what the phone then showed as "open every day".
//
// THE FORMAT (what a place's `hours` holds, and nothing else):
//
//     Tue-Sat 12:30-15:00, 19:00-23:00; Sun 12:30-16:00
//
//   days      Mon Tue Wed Thu Fri Sat Sun; a run is Mon-Fri; a list is Mon, Wed, Fri;
//             every day is Daily
//   times     24-hour, HH:MM-HH:MM; a comma between two windows in a day; a window that
//             ends after midnight is written as it is, 18:00-02:00
//   groups    a semicolon between day groups; days not named are closed
//   always    a place that never closes is "24 hours"
//
// TWO READERS, because there are two kinds of text.
//
//   readHours(text)     STRICT. For anything written from now on. The format above or an
//                       error that says what was wrong and repeats the format, so whoever
//                       wrote it (a person, or an AI through the tools) can correct it.
//
//   readOldHours(text)  LENIENT, AND EXACT. For text written before there was a format:
//                       "Mo-Fr 9:00-18:00", "Monday to Saturday 9am-5pm; closed Sunday",
//                       "24/7". It understands more spellings, and it answers only when it
//                       understood EVERY word. "Approx Mo-Sa 09:00-18:00 (unverified)" is
//                       not hours anybody confirmed, so it is not read as hours: the caller
//                       keeps the text as a note. Reading the times out of a sentence like
//                       that and dropping the doubt is how a place gets a wrong "Open".
//
// Both return { ok: true, hours, text } or { ok: false, error }. `text` is the canonical
// spelling (writeHours(hours)): what gets stored. `hours` is
//
//     { always: boolean, windows: [{ days, from, to }] }
//
// with `days` a bit mask (bit 0 Sunday … bit 6 Saturday, the numbers Date#getDay() uses),
// `from` and `to` minutes after midnight, and `to` above 1440 for a window that runs past
// midnight into the next day.

export const HOURS_FORMAT =
  'Hours are written like "Tue-Sat 12:30-15:00, 19:00-23:00; Sun 12:30-16:00": days are Mon Tue Wed Thu Fri Sat Sun ' +
  '(a run Mon-Fri, a list Mon, Wed, Fri, every day Daily); times are 24-hour HH:MM-HH:MM, with a comma between two ' +
  'windows in a day and a window that ends after midnight written as it is (18:00-02:00); a semicolon separates day ' +
  'groups; days not named are closed; a place that never closes is "24 hours". Nothing else goes in the field.';

// Monday first, the order the format is written in. The mask uses Date#getDay() numbers.
const NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const BIT = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const ALL = 0b1111111;
const DAY_MIN = 1440;

const fail = (why) => ({ ok: false, error: `${why} ${HOURS_FORMAT}` });

/** The days from `a` through `b`, going forward through the week (Sat-Mon is Sat, Sun, Mon). */
function runMask(a, b) {
  let mask = 0;
  for (let i = NAMES.indexOf(a); ; i = (i + 1) % 7) {
    mask |= 1 << BIT[NAMES[i]];
    if (NAMES[i] === b) return mask;
  }
}

const namesOf = (mask) => NAMES.filter((n) => mask & (1 << BIT[n]));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// ── the writer ────────────────────────────────────────────────────────────────────────────

/** The canonical text for `hours`. Days with the same windows share a group; groups run in
 *  week order from Monday; two or more days in a row are written as a run. */
export function writeHours(hours) {
  if (!hours || !Array.isArray(hours.windows) || !hours.windows.length) return "";
  if (hours.always) return "24 hours";
  // What each day holds, as text, so days that match can be grouped.
  const perDay = NAMES.map((n) => hours.windows
    .filter((w) => w.days & (1 << BIT[n]))
    .sort((x, y) => x.from - y.from)
    .map((w) => `${hhmm(w.from)}-${w.to === DAY_MIN ? "24:00" : hhmm(w.to % DAY_MIN)}`)
    .join(", "));
  const groups = [];
  for (let i = 0; i < 7; i++) {
    if (!perDay[i]) continue;
    const g = groups.find((x) => x.windows === perDay[i]);
    if (g) g.days.push(i); else groups.push({ windows: perDay[i], days: [i] });
  }
  return groups.map((g) => {
    if (g.days.length === 7) return `Daily ${g.windows}`;
    const parts = [];
    for (let i = 0; i < g.days.length;) {
      let j = i;
      while (j + 1 < g.days.length && g.days[j + 1] === g.days[j] + 1) j++;
      parts.push(j > i ? `${NAMES[g.days[i]]}-${NAMES[g.days[j]]}` : NAMES[g.days[i]]);
      i = j + 1;
    }
    return `${parts.join(", ")} ${g.windows}`;
  }).join("; ");
}

// ── building, shared by both readers ──────────────────────────────────────────────────────

/** Groups of { mask, spans: [{ from, to }] } into hours, or a reason they don't make sense. */
function build(groups) {
  let seen = 0;
  const windows = [];
  for (const g of groups) {
    const twice = g.mask & seen;
    if (twice) return { why: `${namesOf(twice).join(" and ")} ${namesOf(twice).length > 1 ? "are" : "is"} given hours twice.` };
    seen |= g.mask;
    const spans = [...g.spans].sort((a, b) => a.from - b.from);
    for (let i = 1; i < spans.length; i++) {
      if (spans[i].from < spans[i - 1].to) return { why: `Two windows on the same day overlap (${hhmm(spans[i - 1].from)}-${hhmm(spans[i - 1].to % DAY_MIN)} and ${hhmm(spans[i].from)}-${hhmm(spans[i].to % DAY_MIN)}).` };
    }
    for (const s of spans) windows.push({ days: g.mask, from: s.from, to: s.to });
  }
  if (!windows.length) return { why: "No hours were given." };
  const always = windows.some((w) => w.days === ALL && w.from === 0 && w.to >= DAY_MIN);
  const hours = always ? { always: true, windows: [{ days: ALL, from: 0, to: DAY_MIN }] } : { always: false, windows };
  return { hours };
}

const done = (hours) => ({ ok: true, hours, text: writeHours(hours) });

// ── the strict reader ─────────────────────────────────────────────────────────────────────

const DAYSPEC = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:-(Mon|Tue|Wed|Thu|Fri|Sat|Sun))?$/;
const WINDOW = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/;

/** Read text in the one format. Spaces may vary; nothing else may. */
export function readHours(text) {
  if (typeof text !== "string") return fail("Hours must be text.");
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return fail("Hours are empty: leave the field out instead.");
  if (t === "24 hours") return done({ always: true, windows: [{ days: ALL, from: 0, to: DAY_MIN }] });

  const groups = [];
  for (const raw of t.split(";")) {
    const g = raw.trim();
    if (!g) return fail("There is a semicolon with no day group beside it.");
    // The days are everything before the first time.
    const at = g.search(/\d/);
    if (at < 0) return fail(`"${g}" names no times.`);
    const dayText = g.slice(0, at).trim();
    const timeText = g.slice(at).trim();
    if (!dayText) return fail(`"${g}" names no days: start it with the days, or Daily.`);

    let mask = 0;
    if (dayText === "Daily") mask = ALL;
    else {
      for (const part of dayText.split(",")) {
        const m = DAYSPEC.exec(part.trim());
        if (!m) return fail(`"${part.trim()}" is not a day or a run of days.`);
        if (m[2] && m[2] === m[1]) return fail(`"${part.trim()}" is a run from a day to itself.`);
        const add = m[2] ? runMask(m[1], m[2]) : 1 << BIT[m[1]];
        if (mask & add) return fail(`"${dayText}" names ${namesOf(mask & add).join(" and ")} twice.`);
        mask |= add;
      }
    }

    const spans = [];
    for (const part of timeText.split(",")) {
      const m = WINDOW.exec(part.trim());
      if (!m) return fail(`"${part.trim()}" is not a time window (HH:MM-HH:MM, 24-hour).`);
      const [h1, m1, h2, m2] = [+m[1], +m[2], +m[3], +m[4]];
      if (h1 > 23 || m1 > 59 || m2 > 59 || h2 > 24 || (h2 === 24 && m2 !== 0)) return fail(`"${part.trim()}" is not a time of day.`);
      const from = h1 * 60 + m1;
      let to = h2 * 60 + m2;
      if (to === from) return fail(`"${part.trim()}" opens and closes at the same minute.`);
      if (to < from) to += DAY_MIN;                 // runs past midnight
      spans.push({ from, to });
    }
    groups.push({ mask, spans });
  }
  const b = build(groups);
  return b.hours ? done(b.hours) : fail(b.why);
}

// ── the lenient reader ────────────────────────────────────────────────────────────────────

const OLD_DAY = {
  mo: "Mon", mon: "Mon", monday: "Mon", tu: "Tue", tue: "Tue", tues: "Tue", tuesday: "Tue",
  we: "Wed", wed: "Wed", weds: "Wed", wednesday: "Wed", th: "Thu", thu: "Thu", thur: "Thu", thurs: "Thu", thursday: "Thu",
  fr: "Fri", fri: "Fri", friday: "Fri", sa: "Sat", sat: "Sat", saturday: "Sat", su: "Sun", sun: "Sun", sunday: "Sun",
};
const dayOf = (w) => OLD_DAY[w] || OLD_DAY[w.replace(/s$/, "")] || null;

const ALWAYS_OLD = /^(open )?(24 ?\/ ?7|24 ?(h|hrs?|hours?)|at all times|always open|always)(,? (daily|every day))?$/;

/** A time of day in minutes, or null when the text doesn't settle which one it is. `settled`
 *  says whether the spelling itself is unambiguous (24-hour with minutes, or am/pm). */
function oldTime(text) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s?(am|pm)?$/.exec(text);
  if (!m) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    return { at: h * 60 + min, settled: true };
  }
  if (h > 24 || (h === 24 && min)) return null;
  return { at: h * 60 + min, settled: !!m[2] };       // "9" alone could be morning or evening
}

/**
 * Read text written before there was a format. ok only when every word was understood and
 * the result reads back the same through the strict reader.
 */
export function readOldHours(text) {
  if (typeof text !== "string" || !text.trim()) return fail("There are no hours to read.");
  const strict = readHours(text);
  if (strict.ok) return strict;

  const cant = (what) => fail(`These hours can't be read exactly (${what}).`);
  const t = text.toLowerCase()
    .replace(/[‐-―−]/g, "-")          // every kind of dash
    .replace(/(\d)\.(\d{2})(?!\d)/g, "$1:$2")         // 9.30 is 9:30
    .replace(/\s+/g, " ").trim().replace(/[.;]+$/, "").trim();
  if (ALWAYS_OLD.test(t)) return done({ always: true, windows: [{ days: ALL, from: 0, to: DAY_MIN }] });

  const groups = [];
  let closed = 0;
  // A full stop ends a clause only after a letter or a closing time, never inside "9.30"
  // (already turned into 9:30 above).
  for (const raw of t.split(/[;\n]|\.(?= |$)/)) {
    let clause = raw.trim();
    if (!clause) continue;
    clause = clause.replace(/^open /, "");
    const isClosed = /^closed /.test(clause) || / closed$/.test(clause);
    if (isClosed) clause = clause.replace(/^closed (on )?/, "").replace(/ closed$/, "");

    // Words, each one a day, a time range, a connector, or not understood.
    let mask = 0;
    const spans = [];
    const words = clause
      .replace(/(\d{1,2}(?::\d{2})?\s?(?:am|pm)?)\s?(?:-|to|until|till)\s?(\d{1,2}(?::\d{2})?\s?(?:am|pm)?)/g, (_, a, b) => ` <${a.replace(/ /g, "")}|${b.replace(/ /g, "")}> `)
      .replace(/\b([a-z]+)\s?(?:-|to|through|thru)\s?([a-z]+)\b/g, (whole, a, b) => (dayOf(a) && dayOf(b) ? ` {${dayOf(a)}|${dayOf(b)}} ` : whole))
      .replace(/every ?day/g, "daily")
      .split(/[\s,]+/).filter(Boolean);
    for (const w of words) {
      if (w === "and" || w === "&" || w === "on") continue;
      if (w === "daily") { mask |= ALL; continue; }
      if (w === "weekdays") { mask |= runMask("Mon", "Fri"); continue; }
      if (w === "weekends") { mask |= runMask("Sat", "Sun"); continue; }
      let m;
      if ((m = /^\{(\w+)\|(\w+)\}$/.exec(w))) {
        if (m[1] === m[2]) return cant(`"${w}" runs from a day to itself`);
        mask |= runMask(m[1], m[2]);
        continue;
      }
      if ((m = /^<(.+)\|(.+)>$/.exec(w))) {
        const a = oldTime(m[1]), b = oldTime(m[2]);
        if (!a || !b) return cant(`"${m[1]}-${m[2]}" is not a pair of times`);
        // "9-5" does not say morning or evening; reading it either way is a guess.
        if (!a.settled || !b.settled) return cant(`"${m[1]}-${m[2]}" doesn't say which half of the day`);
        if (a.at === b.at || a.at >= DAY_MIN) return cant(`"${m[1]}-${m[2]}" is not a window`);
        spans.push({ from: a.at, to: b.at < a.at ? b.at + DAY_MIN : b.at });
        continue;
      }
      const d = dayOf(w);
      if (d) { mask |= 1 << BIT[d]; continue; }
      return cant(`"${w}" is not a day or a time`);
    }

    if (isClosed) {
      if (spans.length || !mask) return cant("a closed clause should name days only");
      closed |= mask;
      continue;
    }
    if (!spans.length) return cant(`"${raw.trim()}" names days and no times`);
    groups.push({ mask, spans });
  }
  if (!groups.length) return cant("no opening times in it");
  // Times with no day at all mean every day, and only when that is all the text says.
  for (const g of groups) {
    if (g.mask) continue;
    if (groups.length > 1) return cant("some times have no days");
    g.mask = ALL;
  }
  if (groups.some((g) => g.mask & closed)) return cant("a day is both open and closed");

  const b = build(groups);
  if (!b.hours) return cant(b.why.replace(/\.$/, ""));
  // Proof that nothing was lost: the canonical text, read strictly, is the same hours.
  const back = readHours(writeHours(b.hours));
  if (!back.ok || writeHours(back.hours) !== writeHours(b.hours)) return cant("it doesn't fit the format");
  return done(b.hours);
}

// ── open now ──────────────────────────────────────────────────────────────────────────────

/**
 * Is it open at `now` ({ day: 0 Sunday … 6 Saturday, min: minutes after midnight }, in the
 * place's own time zone)? Returns null when there is nothing to say, or one of
 *   { open: true, always: true }
 *   { open: true, until, mins }                       closes at `until`, in `mins` minutes
 *   { open: false, day, at, today, tomorrow }         next opens on `day` at `at`
 */
export function openState(hours, now) {
  if (!hours || !now) return null;
  if (hours.always) return { open: true, always: true };
  let end = -1;
  const yday = (now.day + 6) % 7;
  for (const w of hours.windows) {
    if ((w.days & (1 << now.day)) && now.min >= w.from && now.min < w.to) end = Math.max(end, w.to);
    // A window opened yesterday and still running (18:00-02:00) belongs to yesterday's days.
    if (w.to > DAY_MIN && (w.days & (1 << yday))) {
      const m = now.min + DAY_MIN;
      if (m >= w.from && m < w.to) end = Math.max(end, w.to - DAY_MIN);
    }
  }
  if (end >= 0) return { open: true, until: end % DAY_MIN, mins: end - now.min };

  for (let d = 0; d < 8; d++) {
    const day = (now.day + d) % 7;
    let next = Infinity;
    for (const w of hours.windows) {
      if (!(w.days & (1 << day))) continue;
      if (d > 0 || w.from > now.min) next = Math.min(next, w.from);
    }
    if (next < Infinity) return { open: false, day, at: next % DAY_MIN, today: d === 0, tomorrow: d === 1 };
  }
  return null;
}
