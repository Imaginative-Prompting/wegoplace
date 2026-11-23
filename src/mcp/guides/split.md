# Split

Split is how a group keeps track of who paid for what. Someone adds a line when money is spent (what it was, how
much, who paid, who's sharing it), and the app works out who owes whom. Groups use it more than anything else in
the app, because adding a line takes a few seconds.

You can add lines for the person you act for, and tell them what the balances are. This is money between friends:
a wrong line causes an argument. Read `get_trip_guide` first if you haven't. Every example here is invented.

## What a purchase is

| Field | What goes in it |
|---|---|
| `description` | What was bought, as the group would say it: "Dinner at Tasca do Largo", "Taxi from the airport". Up to 200 characters. |
| `amount` | What was paid, as text with the currency's own decimals: `"86.40"`, `"1200"` for a currency with none. Never a rounded or converted number. |
| `currency` | The ISO code of the money that was handed over or charged at the till: the currency printed on the receipt. |
| `paid_by` | The one person whose money left. Not necessarily the person you act for: "Sam got the taxi" is a purchase paid by Sam. A bill two people paid is two purchases. |
| `split` | Who shares it, and how (below). |
| `spent_on` | The day it was spent, `YYYY-MM-DD`. Left out, it is today. "The taxi yesterday" is yesterday's date. |
| `event_id`, `place_id` | Optional: the event or place it belongs to, when that's obvious (the dinner that's on the itinerary). It only saves typing later. |
| `note` | Optional: anything worth remembering about it. Up to 1,000 characters. |

A trip holds at most 5,000 purchases and payments together.

**What is stored is what was paid.** A meal that cost 45 euros is 45 euros forever. The app shows each person their
balance in their own currency, using the latest exchange rate it has, and that figure moves a little as rates move.
Don't convert amounts yourself, and don't store a card statement's converted figure in place of the receipt's.

## Who shares it

- **Evenly:** `{ "mode": "even", "people": [member ids] }`. Each person counts once.
- **By weight:** `{ "mode": "weight", "weights": { member id: whole number } }`. Two people sharing a room and one
  alone is weights 1, 1 and 2 for the room's cost if the single paid double; "the kids count half" is 2 for each
  adult and 1 for each child.
- **Exact amounts:** `{ "mode": "exact", "amounts": { member id: "8.00" } }`, each person with what they owe, as
  text like `amount`. The amounts must add up to the total exactly, or the purchase is refused with the
  difference.

Even and by weight, the app shares out the odd cents by its own fixed rule. Don't work the shares out yourself and
send them as exact amounts: use exact amounts only when the person gives you amounts.

If the person says who's in, use that. If they don't say, split it evenly among everyone on the trip, and say so in
your reply ("split evenly between the five of you") so that a wrong guess is caught at once. Someone who has left
the trip can still be on a purchase from when they were there.

## From a receipt

When the person shows you a receipt or a bill:

- Read the **total that was actually paid:** with tax, service and tip. If the tip was added in cash, ask what it
  was, or record what the receipt shows and say that the tip isn't in it.
- Read the **currency** and the **date** off the receipt. Don't assume the trip's main currency.
- If they want it **by what each person had,** add up each person's items, then share the tax, service and tip in
  the same proportions. Round each person to the currency's smallest unit, and put what's left over (a cent or
  two) on the person who paid. Say who got it. Then use exact amounts.
- If a line on the receipt is unclear, or the numbers don't add up to the total, ask. Don't make it fit.

## What you can and can't do

- You can add a purchase, and change or remove one **that the person you act for added or paid for.** Other
  people's lines are theirs: a change to one is refused. If the person thinks someone else's line is wrong, they
  tell that person.
- **To change a purchase, send it again with the same id:** its amount, currency and split every time (together
  they are one fact), and whatever else changes. What you leave out of `description`, `note`, `spent_on`,
  `event_id` and `place_id` stays as it was. A purchase can't become a payment, or a payment a purchase: that is a
  new line with another id.
- You never invent a purchase or a payment to "balance things out". A line exists because money moved.
- Before adding, look at the trip's recent purchases (`get_split`): the person may already have added it, or
  someone else may have. Two lines for one dinner is the most common mistake.

## When someone pays someone back

A **payment** is one person handing another money to settle what they owe. It is not spending: it moves the two
people's balances and changes nothing else. Record one with `put_payment` when the person tells you the money
changed hands ("I sent Sam the 40 I owed", "Ana paid me back in cash").

| Field | What goes in it |
|---|---|
| `from` | The person whose money left. |
| `to` | The person who received it. Never the same person. |
| `amount`, `currency` | What was handed over, as for a purchase: the real amount in the real currency. |
| `paid_on` | The day, `YYYY-MM-DD`. Left out, it is today. |

A payment has no description, no split and no event or place: sending one is refused.

- **"I covered Sam's ticket" is a purchase** (a ticket was bought: paid by them, shared by Sam alone). **"I paid
  Sam back" is a payment.** If you can't tell which the person means, ask. The difference is whether it counts as
  money the trip spent.
- **A suggested transfer is not a payment.** `get_split` suggests who should pay whom to settle each currency.
  Nothing has been paid until the person says so. Never record the suggestions as payments because they'd bring
  the balances to zero.
- A **part payment** is fine: record what was actually handed over. The rest stays owed.
- Record it in the currency that was handed over. Where the app adds two currencies together at today's rate, a
  small balance can show again later when the rate moves. That's honest; don't add a payment to tidy it.
- You can change or remove a payment that the person you act for added, made or received. Anyone else's is theirs.

## Telling them where things stand

`get_split` returns every purchase and every payment and, in `by_currency`, for each currency on its own: each
person's `paid`, their `share`, what they've `paid_back` and `got_back`, their `balance` (positive: they are owed),
and the `transfers` that would settle that currency in the fewest moves. Answer "who owes whom" from what it returns. Don't redo the
arithmetic yourself: the app shares out odd cents by a fixed rule, and your own sums will differ from what
everyone sees on their phone. A person's "paid" and "share" count purchases only; what they've paid back or got
back is given apart.

Each purchase comes back as `put_purchase` takes it: its `amount` as text, and its `split` with its mode (an even
split and one by weight where every weight is 1 are the same split, and read back as even). `put_purchase` and
`put_payment` answer with the row in that same shape.

The tool never adds two currencies together. The app's Split screen also shows one combined figure in each
person's own currency at the day's rate; if the person wants that single number, give each currency's figure and
tell them the combined one is on that screen.

After you add or change a line, say it back in one sentence with the amount, the currency, who paid and who's
sharing: "Added: dinner at Tasca do Largo, 86.40 EUR, paid by Sam, split evenly between the five of you."

```json example:put_purchase
{
  "trip_id": "TRIP_ID",
  "summary": "Added Saturday's lunch, paid by Sam, split five ways",
  "purchase": {
    "id": "lunch-tasca",
    "description": "Lunch at Tasca do Largo",
    "amount": "86.40",
    "currency": "EUR",
    "paid_by": "MEMBER_ID_OF_SAM",
    "spent_on": "2027-05-08",
    "event_id": "lunch-tasca",
    "split": { "mode": "even", "people": ["MEMBER_ID_1", "MEMBER_ID_2", "MEMBER_ID_3", "MEMBER_ID_4", "MEMBER_ID_OF_SAM"] }
  }
}
```

```json example:put_purchase
{
  "trip_id": "TRIP_ID",
  "summary": "Added the taxi from the airport, by what each owes",
  "purchase": {
    "id": "taxi-airport",
    "description": "Taxi from the airport",
    "amount": "24.00",
    "currency": "EUR",
    "paid_by": "MEMBER_ID_1",
    "split": { "mode": "exact", "amounts": { "MEMBER_ID_1": "8.00", "MEMBER_ID_2": "8.00", "MEMBER_ID_3": "8.00" } }
  }
}
```

```json example:put_purchase
{
  "trip_id": "TRIP_ID",
  "summary": "Added the apartment, the big room counting double",
  "purchase": {
    "id": "apartment-porto",
    "description": "Apartment in Porto, three nights",
    "amount": "410.00",
    "currency": "EUR",
    "paid_by": "MEMBER_ID_2",
    "spent_on": "2027-05-10",
    "split": { "mode": "weight", "weights": { "MEMBER_ID_1": 1, "MEMBER_ID_2": 2, "MEMBER_ID_3": 1 } }
  }
}
```

```json example:put_payment
{
  "trip_id": "TRIP_ID",
  "summary": "Recorded that Ana paid Sam back 40 euros",
  "payment": {
    "id": "ana-sam-0509",
    "from": "MEMBER_ID_OF_ANA",
    "to": "MEMBER_ID_OF_SAM",
    "amount": "40.00",
    "currency": "EUR",
    "paid_on": "2027-05-09"
  }
}
```
