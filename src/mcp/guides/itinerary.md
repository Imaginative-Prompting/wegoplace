# The itinerary

The itinerary is the trip's events in time order. An event is one step: a flight, a check-in, a dinner, a tour, a
thing to get done. People look at it many times a day, often with no connection and one hand free, to answer "what's
next, when, where, and what do I need for it". Write every event so that it answers that without opening anything
else.

Read `get_trip_guide` first if you haven't. Every example here is invented.

## The six kinds

| `kind` | Use it for | Notes |
|---|---|---|
| `flight` | A flight | `tz` is the departure zone, `end_tz` the arrival zone. One event per flight leg. |
| `transit` | Any other movement, and the moments of arriving and leaving: a train, a bus, a ferry, a drive, a transfer, "Land in Lisbon" | Give it an end when the ride has a known length. |
| `lodging` | A stay | One event per stay, from check-in to check-out, pointing at the place they sleep. Not one per night. When the booking gives no check-in or check-out time, write it `all_day` from the arrival date to the leaving date, and list the times as something to confirm. |
| `meal` | A meal with a time: a reservation, or a meal the group has decided on | |
| `activity` | Something the group does: a tour, a museum, a hike, a show, a day trip | |
| `plan` | Something to get done that isn't an outing: collect tickets, pay a balance, return the car, pack | |

Any other kind is refused.

## Times

A wrong time is the one mistake here that makes someone miss a plane, so the tools take times the way a booking
prints them:

- `starts` and `ends` are **local clock times, written `YYYY-MM-DDTHH:MM`,** exactly as the confirmation shows
  them. Never convert them yourself, and never send a UTC time or a number.
- `tz` is the **IANA zone the event starts in** (`America/New_York`). When an event ends in another zone (a
  flight, an overnight train across a border), `end_tz` is the zone it ends in, and `ends` is the local time
  there. The app shows each end in its own zone.
- `ends` is optional. Leave it off when the booking doesn't say. Don't invent one to make the day look tidy.
- `all_day: true` with dates only (`YYYY-MM-DD`) is for a thing with no clock time: "Market day", "Last day to
  cancel the hotel for free". Its `tz` may be left out: it takes the trip's time zone.
- An event must start on a day of the trip. One outside the trip's dates is refused with those dates in the error;
  this is what catches a wrong year or month. If the trip really got longer, change the trip's dates first.
  The same holds the other way: changing the trip's dates so that an event would fall outside them is refused,
  and the error names the first and last day that have events. Move or remove those events first, or keep the
  dates wide enough to hold them.
- A local time that doesn't exist in its zone, or happens twice (the hour a clock change skips or repeats), is
  refused with both readings; send the one the booking means with its offset (`2027-10-31T01:30+00:00`).

After you write, the result gives each event back with its weekday. Read it: "Fri 18:40" against the ticket is the
check.

## Title and detail

**`title`:** what happens, in a few words, as the group would say it: "Dinner at Tasca do Largo", "Train to Porto",
"Check in, Rua das Flores apartment". For a flight, the flight number and the two cities: "XY 204  Newark to
Lisbon". No dates or times in a title: the app shows them, and a title that repeats them goes stale when the time
changes.

**`detail`:** what someone needs at that moment that the title, time and place don't already say. The plan's own page
shows it, opened from its card, so the first sentence carries the most important thing. One to three sentences:

- **the booking:** whose name it's under, for how many, the reference when the person gave you one. The name is
  the one the booking itself shows, as the person gave it to you (the desk will ask for it); a first name is
  enough. Don't go looking for it, and don't add anyone's phone number or ID to it;
- **what to bring or have ready:** the original passport, the printed ticket, cash for the balance;
- **money:** paid in full, or what's due, in which currency, and how it can be paid;
- **the deadline hiding inside it:** "kitchen closes 15:30, so this is a one-hour lunch", "bag drop closes 60
  minutes before departure", "last train back is 23:10";
- **what goes wrong if you don't know:** "check in at the operating airline's desk, not the one on the ticket",
  "the entrance on the square is for groups; individuals enter on the side street".

Leave `detail` empty when there's nothing to add. Don't describe the place there (that's the place's card), and
don't write tips of the kind every guidebook has.

## Places

An event that happens somewhere points at a place with `place_id`. That gives its card the map, the directions,
the opening hours and what's nearby. Write the place first (`get_places_guide`), then the event, and use the same
id you gave the place.

- A flight points at the airport it **lands** at, a train or bus at the station it **leaves** from (where the
  group has to be).
- A stay points at the lodging's place. A meal points at the restaurant. A day trip points at its main stop.
- A `plan` with no location (pack, check in online) has no place.

## What goes in, and what stays out

Goes in:

- everything booked or timed: flights, stays, trains, tours, reservations, tickets with an entry time;
- the fixed points the day turns on: when the apartment has to be left, when the rental car is due back;
- what the group has decided to do on a day, even without a time (as an all-day event, or at the time they said);
- things to get done that have a deadline.

Stays out:

- filler to make a day look full: "Free time", "Breakfast", "Explore the old town". A gap in the day is useful: the
  app shows it, and people talk about it in the chat;
- suggestions the group hasn't chosen. Those are places (with a good `why`), and the person picks. When the person
  asks you to plan (the trip, a day), the plan they asked for is what they chose: it goes in, as events at its places;
- anything you inferred and nobody confirmed, written as if it were booked. A tentative plan in the itinerary says
  so in each event's `detail` ("Not booked yet").

## Check each day before you write it

Go through the day in order, the way the group will live it:

- **Does each time match its source?** A time copied from a spreadsheet or a message gets "Confirm against the
  booking." in its `detail` until the person has confirmed it.
- **Is the place open then?** Use the weekday `get_trip` gives for that date and the place's own hours. Look for
  the public holidays and local closing days that fall inside the trip: a holiday can close banks, museums and
  half the restaurants in one go.
- **Can they get from each event to the next?** Count the real transfer: getting out of an airport, across town at
  that hour, up the hill. If it's tight, say so in the later event's `detail`.
- **Do the zones line up on travel days?** A flight's `end_tz` and the next event's `tz` should be the same zone.
- **Is there a gap between leaving one stay and getting into the next,** or between check-out and a late
  departure? Say what happens to the bags, and add a luggage-storage place if they'll need one.
- **Is there a last one?** The last train, the last cable car down, the last entry slot.
- **Is anyone left without what they need the day before something demanding** (an early start, a long hike, a
  flight)? That belongs in the earlier day's `detail`, not as a new event.

When a check turns up something you can't settle, don't settle it by guessing. Write the event with what's known
and tell the person.

## Writing, changing, removing

- `put_events` takes a batch. One call is one change and one undo, so batch what belongs together: a whole day, or
  the whole trip on the first sitting.
- A call takes at most 200 events, and a trip holds at most 2,000. A trip with more than 200 to write goes in
  several calls, a few days each.
- The `id` is yours to choose (lowercase letters, digits, hyphens; unique in this trip). Sending an id that exists
  changes that event. So before adding, `list_events` and reuse what's there: a moved dinner is the same event with
  a new time, and its notes stay on it.
- `remove_events` is for what's really gone (a canceled booking). Tell the person what you removed.
- Don't rewrite events a person made by hand to match your style. Change them only for what you were asked.

```json example:put_events
{
  "trip_id": "TRIP_ID",
  "summary": "Added the flight out, the Lisbon stay and Saturday's lunch",
  "events": [
    {
      "id": "flight-out",
      "kind": "flight",
      "title": "XY 204  Newark to Lisbon",
      "starts": "2027-05-07T18:40", "tz": "America/New_York",
      "ends": "2027-05-08T06:35", "end_tz": "Europe/Lisbon",
      "place_id": "lisbon-airport",
      "detail": "Sold by XY, flown by another airline: check in at the operating airline's desk. Bag drop closes 60 minutes before departure."
    },
    {
      "id": "stay-lisbon",
      "kind": "lodging",
      "title": "Alfama apartment",
      "starts": "2027-05-08T15:00", "ends": "2027-05-12T11:00", "tz": "Europe/Lisbon",
      "place_id": "stay-lisbon",
      "detail": "Check-in from 15:00, and the flight lands at 06:35: bags go to the luggage storage by the station until then. Paid in full."
    },
    {
      "id": "lunch-tasca",
      "kind": "meal",
      "title": "Lunch at Tasca do Largo",
      "starts": "2027-05-08T13:30", "tz": "Europe/Lisbon",
      "place_id": "tasca-do-largo",
      "detail": "Table for 5 at 13:30. Time is from the group's spreadsheet. Confirm against the booking. Kitchen closes 15:00 on Saturdays."
    }
  ]
}
```

## After writing

Read the trip back (`list_events`) and check the order of each day with its weekdays. Then tell the person, day by
day and briefly: what's in, what you left out and why, and which times they still need to confirm.
