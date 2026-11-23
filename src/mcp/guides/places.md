# Place cards and what's nearby

A place is somewhere on the trip's map with a card: where the group sleeps, the restaurant they booked, the
pharmacy two minutes from the apartment. People open these cards standing on a street, often offline, to decide
whether to walk there now. A card has to be right, and it has to say why it's on this group's list.

There are two jobs here. First, the places the trip is built around, which come from the bookings. Second, what's
near them, which you research. Read `get_trip_guide` first if you haven't. Every example here is invented.

## A place's fields

Only `id`, `name`, `kind`, `subkind` and `why` are required. Every other field is left out when you don't have it
from a source. An empty field is honest; a guessed one sends someone to the wrong door.

| Field | What goes in it |
|---|---|
| `id` | Yours to choose: lowercase letters, digits, hyphens; unique in this trip. Sending an id that exists changes that place. |
| `name` | The name the group will look for and say. |
| `name_local` | What the sign says and what to show a driver, in the local language and script, when that differs from `name`. |
| `kind`, `subkind` | Why they'd go (one of the seven kinds) and what it is (a subkind from the app's list). Both below. |
| `area` | The id of the area it's in (a neighborhood when the city has them). |
| `lat`, `lng` | From a map source or a geocoder, for this exact place. They must fall inside the bounds of the place's area or its parent, or the place is refused. If you couldn't confirm where it is, leave both out: the card then says the location isn't confirmed. Never send 0, never a city's center, never a guess. |
| `address` | As it's written locally: what a driver or a map search needs. |
| `address_note` | How to find the door once you're on the street: "Unmarked green door between the bakery and the tile shop; ring 2B." |
| `why` | One sentence: why this place is on this group's list (below). |
| `notes` | What they need to know to use it (below). |
| `hours` | Opening hours you confirmed, in the format below. |
| `phone` | International format, `+351 21 000 0000`. From the place's own site or listing. |
| `website` | The place's own site, and only if you loaded it and it works. |
| `price_level` | 1 to 4, relative to the destination: 1 is cheap for there, 4 is a splurge for there. Only when you know. |
| `rating`, `rating_count` | Both or neither, and only from a source you read in this conversation, named in `source`. Never from memory. |
| `tags` | Up to six short tags (below). |
| `is_anchor` | `true` for a place the trip is built around (next section). |
| `near_anchor`, `walk_minutes` | The anchor this place is near, and the walk from that anchor's door in minutes (below). |
| `elevation_m` | Meters above sea level, only where height matters to the group: a pass, a summit, a town high enough to feel. |
| `checkout` | Lodging only: the steps for leaving, in order, each a short `title` and an optional `detail`. From the host's own instructions. |
| `confidence` | `high`, `medium` or `low` (below). |
| `source` | Where the facts came from: the booking, the place's site, the map source. Addresses of pages you read. |

When a place is read back, a field that was never given is `null` (`rating`, `rating_count`, `price_level`), except
`walk_minutes` and `elevation_m`, where `0` means not given: a real zero (right next door, at sea level) can't be told
apart from it yet. So never tell a person a place is 0 minutes away or at sea level from these two: say nothing about
them unless the number is above 0.

**The kind says why the group would go there.** It decides which filter the place is under and its color. The
seven: `lodging` (where they sleep), `food` (where they'd eat), `drink` (where they'd go for the drink), `sight`
(something to see), `activity` (something to do), `transit` (how they arrive, leave and get around), `practical`
(everything that keeps the trip running: cash, pharmacy, medical, groceries, laundry, phone, luggage storage, gear,
toilets, police).

**The subkind says what the place is.** It decides the icon and the word on the row. It comes from the app's list,
below, and is chosen separately from the kind: a market the group will eat at is `food` + `market`, one they'd walk
through for the look of it is `sight` + `market`, and the one where they'll buy groceries is `practical` +
`market`. A beach to swim at is `activity` + `beach`; a beach to look at from the road is `sight` + `beach`. Choose
the kind by asking what this group will do there. Don't pair them carelessly: `food` + `pharmacy` is accepted and
looks wrong on the map.

```text list:place_subkinds
lodging: hotel, hostel, apartment, campsite, cabin
food: restaurant, cafe, bakery, ice_cream, street_food, market
drink: bar, winery, brewery
sight: viewpoint, museum, ruin, church, temple, mosque, synagogue, shrine, castle, landmark, plaza, park, beach, nature, mountain, town, bridge, zoo
activity: tour, cooking_class, hike, boat_trip, adventure, water_sport, snow_sport, show, spa, shopping, theme_park
transit: airport, train_station, bus_station, metro, ferry, taxi, car_rental, parking, cable_car, trailhead, border, ticket_office
practical: atm, money_exchange, pharmacy, clinic, hospital, dentist, police, embassy, supermarket, convenience, water, laundry, sim, luggage_storage, outdoor_gear, hardware, fuel, toilets, shower, tourist_office
```

The word before each colon is only where the subkind usually belongs. What some of them cover: `apartment` is any
rented home; `cabin` takes mountain huts and lodges; `castle` takes palaces; `park` takes gardens; `nature` is a
waterfall, a lake, a cave, a canyon; `mountain` is a peak, a pass, a volcano; `town` is a village, an old town, a
neighborhood or a street worth the walk; `zoo` takes aquariums and wildlife reserves; `show` is theater, music or a
match; `spa` takes baths and hot springs; `metro` takes trams; `ferry` takes piers and ports; `cable_car` takes
funiculars and gondolas; `adventure` is anything with a harness, a helmet or an engine; `water` is drinking water to
refill; `sim` is where to get a phone plan. A place of worship that is none of the five listed is a `landmark`.

A subkind that isn't on the list is refused, and the error carries the list. Pick the closest one. The cuisine and
anything else about flavor goes in `tags`.

## Part one: the places the trip is built around

These are the **anchors:** where the group sleeps, where they arrive and leave, everything they've booked, and
whatever they came for. Mark them `is_anchor: true`. They come before the itinerary, because events point at them.

- Take them **from the bookings.** A booking's address, name and times beat anything you find elsewhere. If your
  research disagrees with the booking (the map shows the restaurant on another street), keep the booking's fact and
  tell the person.
- **Lodging:** the address exactly as the host wrote it (when what you were given has none, write the card
  without one and list it for the person to add: don't look up the address of a private stay); in `address_note`,
  how to find the door and get in; in
  `notes`, what the group will ask each other all week (which floor, whether there's a lift, a washing machine,
  where the bags can wait before check-in); in `checkout`, the host's leaving steps.
- **Arrivals and departures:** the airport, the station, the pier, as `transit`. In `notes`, what gets a group
  out of it: where taxis and trains leave from, what the ride to the stay costs when the operator publishes it.
- **Booked things:** the restaurant, the tour's meeting point, the venue. The meeting point is the place, not the
  company's office, unless they meet at the office.
- Never overwrite an anchor's booking facts with research later. Add to them.

## Part two: what's near them

Nearby places are what make the map useful on the day: what the group needs, and what they'd love, within reach of
where they already are. This is research, in five steps. Work one area at a time.

### 1. Decide what to look for

Read the trip's `interests` first, and the itinerary. Two sets come out of them.

**What this trip needs.** Think from this list, and keep only what this group and this trip call for:

- **cash:** an ATM that takes foreign cards near each stay; a place to change money where cash rules; more where
  the itinerary has cash-only days (markets, rural stops, a tour balance paid in bills);
- **pharmacy:** the nearest to each stay, and one that's open late or all night in each city;
- **medical help:** the nearest emergency room to each stay, and a clinic used to visitors where there is one;
- **groceries and water:** a supermarket near each stay, and somewhere that's open early or late if the itinerary
  has an early start or a late arrival;
- **laundry:** on trips of about a week or more, or when the group packs light;
- **phone:** where to get a SIM or an eSIM top-up, when the group is abroad;
- **luggage storage:** wherever there's a gap between leaving one bed and reaching the next, or before a late
  departure;
- **getting around:** the stations, stops, taxi ranks and rental desks they'll really use;
- **gear and repairs:** for what they're doing (an outdoor shop before a hike, a bike shop on a cycling trip);
- **anything the group's own needs make necessary:** whatever `interests` names (formula, a gluten-free bakery,
  step-free routes, a place to work).

**What this group would love.** From `interests`, in their proportions: if food is the point, most of the list is
food; if they said "no museums unless it rains", add two good rainy-day museums and no more. Include what they
asked for by name. Leave out what they said they don't want, however famous.

**Around what.** Around each stay first (an easy walk from the door), then around each booked thing (where to wait
beforehand, where to go after), then along the route of a day trip.

When the person asks for something particular ("find climbing gyms near the hotel", "more places like the first
café"), that request is the brief, and it wins over this list.

### 2. Find candidates

Search near the anchor, not "the best of" the city: places listed as a city's best are rarely the ones a few minutes
from this group's door.

- Search in the local language as well as the group's. The place's own site and local listings are usually in it.
- Use **map data** (OpenStreetMap or another map source you can query) to find what exists within reach of the
  anchor, and to get each place's coordinates and address.
- Use **the place's own website** for hours, prices, booking and what it is.
- Use **official sites** (the transport operator, the city, the museum, the park authority) for tickets, schedules
  and closures.
- Use recent independent writing to learn what's worth the walk. Don't copy its sentences.

### 3. Check every candidate

Check each as if someone else had written it and you were looking for the mistake. These are the mistakes this
step most often finds:

- **It's gone.** Closed for good, moved, or renamed. Look for a sign of life from the past year. An official site
  that no longer loads is a warning: lower the confidence and say so in `notes`.
- **The hours are wrong.** "Closed Mondays" on a place that's open; "lunch only" on a place that serves dinner.
  Take hours from the place's own site. Then hold them against the trip's own days, using the weekdays `get_trip`
  gives: is it open on the day they'd go? Does a public holiday or a seasonal closure fall inside the trip?
- **The pin is wrong.** The coordinates belong to a different branch, the street's midpoint or the city's center.
  The address and the coordinates must agree with each other.
- **The fact the place is on the list for can't be confirmed.** If a clinic is listed because its emergency room
  never closes, that is the fact to confirm. If you can't, the card says so, and the confidence drops.
- **A name was made up.** A branch name, a "terminal 2", a department. Use the operator's own words.
- **A number has no source.** Ratings, prices, ticket fees and walking times that nobody published. Leave them
  out.
- **The area is wrong.** A place over the line in the next district goes in that area, or in the city's own area.

What you couldn't confirm stays off the card as a fact and goes into `notes` as a thing to confirm.

### 4. Look for the gaps

Now go through the itinerary as the group will live it, day by day and hour by hour, and ask what they'll need that
isn't on the map yet:

- They land at 06:35 and can't check in until 15:00. Where do the bags go? What's open for breakfast at 07:30?
- The second day is a Sunday or a public holiday. What's open for food, for cash, for anything?
- They get in at 23:00. What's still open near the door?
- Tomorrow is the long hike or the early train. Where do they buy water and food tonight?
- Someone needs a pharmacy at 22:00. Is there one on the map that's open?
- A booked dinner ends at 23:00 across town. How do they get back?

Add what's missing, checked the same way.

### 5. Write

`put_places` takes a batch. Send one area per call, so each area is one change the group can read and undo:
"Added 22 places around the Alfama apartment: 9 practical, 8 food, 3 drink, 2 sights". Before adding, `list_places`
for that area and reuse the ids that exist; a result that warns of a possible duplicate (a new place a few meters
from an existing one) means read both and keep one. A call takes at most 200 places: an area with more goes in
several calls.

Then tell the person what you added, in a few lines, and what you left out and why. Ask whether they want more of
anything before you start the next area.

## `why` and `notes`

These two fields are what make a card worth opening.

**`why`** is one sentence saying why this place earned its slot for this group. It names something from their
`interests`, their itinerary or where they'll be. The test: if the sentence could sit on another place's card, or
on this card in another group's trip, rewrite it.

- No: "Popular local restaurant with great food and a cozy atmosphere."
- Yes: "Two minutes downhill from the apartment and open from 07:00, so it's where coffee happens before the
  three early starts."
- Yes: "The only pharmacy within a walk of the apartment that's open on the Sunday you arrive."

**`notes`** is what they need to know to use the place, in a few short sentences: cash only or cards; book ahead
and how; which entrance; how long it takes; what the strict vegetarian can eat here; that the walk back is uphill.
Checkable things, not atmosphere. When something on the card isn't confirmed, `notes` says so plainly and first:
"Hours not confirmed: check before you walk over."

If you can't write a specific `why`, the place doesn't belong on the list.

## Hours

The app reads `hours` to show whether a place is open right now, so the field holds only hours you confirmed, in
one format:

- days are `Mon Tue Wed Thu Fri Sat Sun`; a run is `Mon-Fri`; a list is `Mon, Wed, Fri`; every day is `Daily`;
- times are 24-hour, `09:00-18:00`; two windows in a day are separated by a comma; a window that ends after
  midnight is written as it is, `18:00-02:00`;
- day groups are separated by a semicolon; days you don't name are closed;
- a place that never closes is `24 hours`.

```
Tue-Sat 12:30-15:00, 19:00-23:00; Sun 12:30-16:00
```

Nothing else goes in the field: no "about", no "usually", no seasons, no holidays, no remarks. Hours in any other
form are refused with this format in the error. When you only know roughly, or the hours change with the season,
leave `hours` out and write what you know in `notes`. A wrong "Open" badge sends someone across a city for nothing.
Hours you found only on a map listing or a directory (not the place's own site) go the same way: leave `hours`
out, and write them in `notes` with where they came from and that they aren't confirmed.

## Walking times

`near_anchor` is the id of the anchor this place is near; `walk_minutes` is the walk from that anchor's door, in
whole minutes. The app shows it when someone asks what's near that anchor.

- It's the walk a person would really do: along streets, at an easy pace, with the hills and the stairs.
- If all you have is the straight-line distance, take the meters, multiply by 1.3, divide by 75, and round up. Then
  add for a climb. That is an estimate; when the way back is steep, say so in `notes`.
- For something long (a promenade, a park, a trail), measure to the entrance nearest the anchor, and name that
  entrance in `address_note`.
- If it's more than about 30 minutes on foot, or the way isn't walkable (a highway, another town), leave
  `walk_minutes` out and write how to get there in `notes`: "15 minutes by taxi from the apartment."

## Confidence and source

- **`high`:** you confirmed that it exists and is operating, and its address, its location and the fact it's on the
  list for, from the place's own site or from two sources that don't copy each other.
- **`medium`:** one good source, or one thing left unconfirmed, named in `notes`.
- **`low`:** you couldn't confirm that it's still there, where it is, or the fact it's on the list for. The card
  shows a warning. Use it for a place worth knowing about anyway, never to pad the list.

`source` names what you read: the pages, the map source, "the booking". It's how the next AI, or the person, checks
you.

## Tags

Up to six, lowercase, words joined by hyphens. Use these where they apply, so the same fact is always the same tag:
`cash-only`, `cards-ok`, `reserve-ahead`, `walk-in`, `free`, `ticketed`, `bring-id`, `indoor`, `outdoor`,
`open-early`, `open-late`, `kid-friendly`, `step-free`, `stairs`, `uphill-return`, `vegetarian-ok`, `vegan-ok`,
`gluten-free-ok`, `wifi`. Add the cuisine or the specialty in a word or two (`seafood`, `natural-wine`). How well
a fact was checked is never a tag: that is `confidence`.

## How many

Enough that the map answers the group's questions, and no more. As a starting point around each stay: the needs
first (usually 8 to 15 places), then 10 to 25 the group would love. A day-trip destination takes 5 to 12. A trip
with five well-chosen places is a good trip in the app. When the person wants more of something, add more of that.

A trip holds at most 2,000 places, and every phone on the trip keeps them all. A trip near that has too many to
read: before adding more, keep the places the group would miss and remove the rest, and tell the person which.

## When you can't look things up

If this conversation has no way to search the web or query a map, say so before you start. You can still:

- write the anchors from the bookings;
- write places the person names, with what they tell you;
- suggest candidates from memory in the conversation, for the person to check. If they want one on the map
  unchecked, write it with `confidence: low`, no `hours`, `phone`, `price_level` or `rating`, coordinates only if
  the person gives you a map link, and `notes` that begins "Not checked: confirm it's still open."

## Keeping cards current

Hours and closures change. When a trip is within two weeks, or the person asks, re-check the places they're likely
to use (the ones on the itinerary and nearest each stay) and change the rows. A place that has closed for good is
removed with `remove_places`, and you say so. Before you replace a `why` or `notes`, read what's there: keep
anything a person wrote into it.

```json example:put_places
{
  "trip_id": "TRIP_ID",
  "summary": "Added the Alfama apartment and three places near it",
  "places": [
    {
      "id": "stay-lisbon",
      "name": "Alfama apartment",
      "kind": "lodging", "subkind": "apartment",
      "area": "alfama",
      "lat": 38.7121, "lng": -9.1302,
      "address": "Rua do Exemplo 14, 2.º Esq., 1100-000 Lisboa",
      "address_note": "Green door between the bakery and the tile shop; ring 2 Esq. Second floor, no lift.",
      "why": "Home for the four Lisbon nights.",
      "notes": "Check-in from 15:00, check-out by 11:00. Washing machine in the kitchen. Bags can't be left before check-in.",
      "checkout": [
        { "title": "Take the trash down", "detail": "Bins are on the corner, to the left of the door." },
        { "title": "Leave both keys on the kitchen table" },
        { "title": "Pull the door shut", "detail": "It locks itself." }
      ],
      "is_anchor": true,
      "confidence": "high",
      "source": "The booking confirmation and the host's message"
    },
    {
      "id": "cafe-da-esquina",
      "name": "Café da Esquina",
      "kind": "food", "subkind": "cafe",
      "area": "alfama",
      "lat": 38.7117, "lng": -9.1296,
      "address": "Largo do Exemplo 3, 1100-000 Lisboa",
      "why": "Two minutes downhill from the apartment and open from 07:00, so it's where coffee happens before the early starts.",
      "notes": "Counter service, cards from 5 euros. Oat milk on request. The climb back is short and steep.",
      "hours": "Mon-Sat 07:00-19:00; Sun 08:00-14:00",
      "price_level": 1,
      "tags": ["open-early", "cards-ok", "vegetarian-ok", "uphill-return"],
      "near_anchor": "stay-lisbon", "walk_minutes": 2,
      "confidence": "high",
      "source": "https://cafedaesquina.example/ (hours, payment); OpenStreetMap (address, location)"
    },
    {
      "id": "farmacia-do-largo",
      "name": "Farmácia do Largo",
      "kind": "practical", "subkind": "pharmacy",
      "area": "alfama",
      "lat": 38.7109, "lng": -9.1311,
      "address": "Rua da Amostra 41, 1100-000 Lisboa",
      "why": "The nearest pharmacy to the apartment, and open on the Saturday you arrive.",
      "notes": "Closed Sundays. The city's on-duty pharmacy list is posted on its door every evening.",
      "hours": "Mon-Fri 09:00-19:30; Sat 09:00-13:00",
      "tags": ["cards-ok"],
      "near_anchor": "stay-lisbon", "walk_minutes": 4,
      "confidence": "high",
      "source": "https://farmaciadolargo.example/ (hours); OpenStreetMap (address, location)"
    },
    {
      "id": "luggage-santa-apolonia",
      "name": "Luggage storage at the station",
      "kind": "practical", "subkind": "luggage_storage",
      "area": "alfama",
      "lat": 38.7139, "lng": -9.1225,
      "address": "Santa Apolónia station, ground floor",
      "address_note": "Left of the ticket hall as you enter from the river side.",
      "why": "Where the bags wait on arrival day, between landing at 06:35 and check-in at 15:00.",
      "notes": "Opening hours and prices not confirmed: the operator's page didn't load. Check before you go; bring coins in case the lockers take only those.",
      "near_anchor": "stay-lisbon", "walk_minutes": 11,
      "confidence": "medium",
      "source": "OpenStreetMap (location); the station's page lists the service without hours"
    }
  ]
}
```
