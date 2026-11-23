# Packing

Packing in WeGoPlace is one set of things per person, seen through the trip's **lists**. You suggest **starters**,
the items worth packing for this particular trip; each person adds the starters to their own list with one tap and
then edits them freely. The group also has one shared list for things only one of them needs to bring.

Your job is to make the suggestions specific to this trip. A list that would fit any trip is a list nobody needs
help with. Read `get_trip_guide` first if you haven't. Every example here is invented.

## How it's built

- **A list** is a packing context with a name: most trips need exactly one. A second list is for a trip inside the
  trip, where some things go and others stay behind: three days of hiking between huts in the middle of a city trip,
  a sailing week, a festival weekend reached by train. Each list is ticked on its own: packing something for one list
  doesn't mark it packed for the other.
- **A list is packed once, or it is for the day.** A list that is packed once is the suitcase: ticked one time,
  before leaving. A list for the day is what people take when they head out; it starts unticked every morning, and
  the app shows it at the top of that day in the itinerary as "Pack for today" (below).
- **An item** is the thing itself, and it is **on** some of the trip's lists (`on`: their keys). An item that isn't on
  a list isn't carried on that leg; when that list is open, the app shows it under "Not on this list". A laptop that
  stays in the hotel during the hike is on the first list and not on the second.
- **A starter** is a suggested item with the lists it's on. Starters are never added to anyone's list for them.
- **How many:** a trip has at most 10 lists and 200 starters. A person's own items hold at most 300, and so do the
  group's. A list well short of these is the one people finish.

`get_packing` returns the lists, the starters, the person's own items and the group's shared items, each item and
starter with the lists it's on (`on`) and its ticks.

## Setting the lists

**A new trip already has one list:** "Leaving home" (`leaving-home`). `get_packing` shows it; read it before you write.
Rename it to fit the trip if that helps people. Don't add a second list beside it for the same journey.

Add a second list only when the itinerary has a leg where what people carry changes, and name it after that leg.

If `get_packing` shows that people already have items, don't restructure the lists unless the person asks: add to
them. A trip keeps at least one list: rename the last one instead of removing it.

`set_packing_lists` adds and changes. A list you leave out stays as it is, so send only what you mean to add or change.

```json example:set_packing_lists
{
  "trip_id": "TRIP_ID",
  "summary": "Named the packing list for the flight out",
  "lists": [
    { "key": "leaving-home", "name": "Flying out" }
  ]
}
```

That call renamed the list (a key stays what it was; the name is what people see).

Removing is its own explicit step, and only when the person asked for it: put `"remove": true` on the list. It is
refused while anyone's items are on it or a starter is, and the refusal says how many: take those off it first (and
change the starters that are on it), or tell the person why it stays.

```json example:set_packing_lists
{
  "trip_id": "TRIP_ID",
  "summary": "The hike is off: removed its packing list",
  "lists": [
    { "key": "hut-hike", "remove": true }
  ]
}
```

## A list for the day

A day list answers one question at the door: "do I have everything for today?" It is not a second suitcase. Make
one when the trip has days out where forgetting something costs the day.

- **One list for every day** holds what is the same each time the group goes out, and only what this trip makes
  worth checking: the transit card, the water bottle, the power bank, a copy of the passport while the original
  stays in the safe. Leave out what nobody forgets (a phone, a wallet) unless this trip gives it a twist.
- **A list for named dates** holds what one day needs and the others don't. Read the itinerary for that day first:
  every line comes from an event on it. A boat trip that stops to swim, a hut with no card reader, a museum that
  refuses bags over a size, a dinner with a dress code.
- Don't repeat the every-day list's lines on a dated list. The app shows both on that day.
- Say why in the note, with the time or the place it comes from, the way starters do.
- Keep it to what a person can check standing at the door. If it keeps growing, those lines belong on the
  packed-once list.
- A thing can be on more than one list: the water bottle that travels in the suitcase can also be on the day list.
  Day lists' starters work like any others: each person adds them with one tap, and the ticks are theirs, not yours.

```json example:set_packing_lists
{
  "trip_id": "TRIP_ID",
  "summary": "Add a list for every day out, and one for the boat day",
  "lists": [
    { "key": "day-out", "name": "Every day out", "repeat": "daily" },
    { "key": "boat-day", "name": "Boat day", "repeat": "daily", "dates": ["2027-05-14"] }
  ]
}
```

```json example:set_packing_starters
{
  "trip_id": "TRIP_ID",
  "summary": "What to check at the door: every day, and on the boat day",
  "starters": [
    { "scope": "person", "label": "Transit card", "category": "documents", "on": ["day-out"],
      "note": "The 7-day card from Monday: the machines at the stops don't take foreign cards." },
    { "scope": "person", "label": "Water bottle", "category": "gear", "on": ["leaving-home", "day-out"],
      "note": "The fountains in the old town are drinkable; no need to buy water." },
    { "scope": "person", "label": "Passport copy", "category": "documents", "on": ["day-out"],
      "note": "The original stays in the apartment safe." },
    { "scope": "person", "label": "Swimsuit and towel", "category": "clothes", "on": ["leaving-home", "boat-day"],
      "note": "The boat stops to swim at 14:00 and has no towels." },
    { "scope": "person", "label": "Cash, small notes", "category": "misc", "on": ["boat-day"],
      "note": "Lunch on the island is cash only." }
  ]
}
```

## What the starters are made from

Look these up for this trip. Don't recall them.

- **The weather where they'll be, when they'll be there.** Typical highs, lows and rain for those places in that
  month, from a climate source; an actual forecast only when the trip is within about ten days. Different stops
  can need different clothes: say which stop an item is for.
- **What the itinerary has them doing.** A hike, a swim, a boat, a bike day, a dinner with a dress code (from the
  restaurant's own site), a place of worship that asks for covered shoulders or knees (from its own site).
- **What the luggage allows.** The cabin-bag size and weight on the airline's own page for their fare; the liquids
  rule at their airports; an operator's limits ("the porters carry at most 7 kg for you, sleeping bag included").
  A limit goes in the note of the starter it's about, with where it comes from.
- **What the stays provide.** A washing machine, towels, a hairdryer, bedding: from the listing. On a long trip
  with a washing machine, they pack for the days between washes.
- **Documents.** What they need to get in and get around: passport validity, a visa or an entry authorization, a
  driving permit for the rental car, proof of insurance, tickets that must be printed, an ID that must be the
  original. These depend on the passports they hold, so ask, and take the rule from the official source (the
  destination's immigration site, their own government's travel advice). Name the source in the note. If you
  couldn't confirm a rule, the note says "check on" and names where.
- **Power:** the plug type and the voltage there, when they differ from home.
- **Money:** cash the itinerary calls for (a balance paid in bills, tips, markets), in which currency.
- **Health:** "Personal medication" is one line, and it's theirs to fill. For anything the destination calls for
  (altitude, malaria areas, vaccinations), point them to a travel clinic or official health advice in the note.
  Don't name medicines or doses in a starter: starters are suggested to the whole group. When the person's own
  notes name what they bring and they ask for it on their list, that goes on their OWN list (`put_packing_items`,
  which only they see), in their words.
- **The group's `interests`:** an allergy card in the local language, what a baby needs, what someone working on the
  trip needs.

## Writing good starters

The starters are the whole suggested list for this trip: the obvious things and the specific ones.

`set_packing_starters` adds and changes, like the lists: a starter is found by its `scope` and `label`, one you
leave out stays as it is, and one leaves only when you send it with `"remove": true`. So send the starters you
mean to add or change, not the whole set again.

| Field | What goes in it |
|---|---|
| `scope` | `person` (everyone packs their own) or `group` (one is enough for all: a first-aid kit, a power strip, the printed tickets, a deck of cards). |
| `label` | The thing, in a few words: "Rain jacket", "Shoes with grip". Not a sentence. |
| `category` | One of `clothes`, `documents`, `electronics`, `toiletries`, `gear`, `meds`, `misc`. |
| `note` | Why it's on this trip's list, or the limit that applies: "Lisbon's sidewalks are polished stone and steep; smooth soles slip when it rains." Empty for the obvious things. |
| `qty` | Only when a fact of the trip sets the number: "2" passport photos the operator asks for. Otherwise leave it out: "Shirts" is a line they fill in; "Shirts ×5" is your opinion. |
| `on` | The lists it's on, by their keys. Leave a list out and the item isn't carried on it. |

- **The obvious things are plain lines:** "Shirts", "Underwear", "Toiletries", "Phone charger". No note, no number.
  They're there so nobody has to type them.
- **The specific things carry the reason.** If you can't say why this trip needs it, it's not a starter.
- **Say where a thing has to be** when it matters, in the note: what they need while moving stays with them, even
  if it's "camp gear"; passports, cash and anything irreplaceable never go in a bag that leaves their sight ("On
  you, not in the checked bag").
- **Things to buy or collect there** go on the list too, with the note saying where: "Rent at the trailhead shop",
  "Buy in Porto: liquids over 100 ml can't fly in a carry-on".
- No brand names and no shopping links unless the person asked for them.
- Aim for a list a person would finish: usually 25 to 50 starters for a person, 5 to 15 for the group.

```json example:set_packing_starters
{
  "trip_id": "TRIP_ID",
  "summary": "Suggested packing for nine days of carry-on travel in Lisbon and Porto",
  "starters": [
    { "scope": "person", "label": "Passport", "category": "documents", "on": ["leaving-home"],
      "note": "Entry rules depend on your passport: check your government's travel advice for Portugal." },
    { "scope": "person", "label": "Shirts", "category": "clothes", "on": ["leaving-home"] },
    { "scope": "person", "label": "Shoes with grip", "category": "clothes", "on": ["leaving-home"],
      "note": "Lisbon's sidewalks are polished stone and steep; smooth soles slip when it rains. Wear them on the plane to save space." },
    { "scope": "person", "label": "Light rain jacket", "category": "clothes", "on": ["leaving-home"],
      "note": "For Porto, the wetter of the two cities in May." },
    { "scope": "person", "label": "Liquids bag", "category": "toiletries", "on": ["leaving-home"],
      "note": "Carry-on only: every liquid at 100 ml or less, in one clear bag, where you can reach it at security." },
    { "scope": "person", "label": "Allergy card in Portuguese", "category": "documents", "on": ["leaving-home"],
      "note": "For the shellfish allergy: a card to show the waiter before ordering." },
    { "scope": "person", "label": "Personal medication", "category": "meds", "on": ["leaving-home"] },
    { "scope": "group", "label": "Plug adapters", "category": "electronics", "on": ["leaving-home"],
      "note": "Portugal uses type F sockets at 230 V. Two adapters and one power strip cover five people." },
    { "scope": "group", "label": "Laundry detergent sheets", "category": "misc", "on": ["leaving-home"],
      "note": "One wash in Porto: the apartment there has a machine." }
  ]
}
```

## A person's own list, and the group's

When the person asks you to put things on their own list ("add my camera gear"), `put_packing_items` adds them to
that person's list, or to the group's shared list when they say it's for everyone. The fields are a starter's, with
`on` for the trip's lists it's on. An item you change keeps its lists unless you send `on`.

- You can't add to, change or tick anyone else's list.
- Don't tick things off. Ticking is the person saying "it's packed".
- Read their list first and don't add what's already there under another name.

## When the trip changes

A new activity, a change of season or a different airline changes what's worth packing. Add or change the starters
that the change touches, and say what changed. People who already added the old starters keep their own lists as
they are: tell the person what to add or drop by hand.
