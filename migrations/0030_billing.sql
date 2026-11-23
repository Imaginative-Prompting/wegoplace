-- The plan (docs/model.md §20): an account's monthly or yearly subscription, through Stripe.
-- Stripe's signed webhook is the one source of who has it (src/billing/plan.js); a subscription
-- is never taken from an event, always read back from Stripe and written as it is now. Nothing
-- here is used, or shown, unless the site switches the plan on and sets its keys (planOffered).
-- Times are seconds, as everywhere else here.

-- Every account that has started a Checkout has one Stripe customer, made once, so whatever it
-- buys is in its Portal and ends with it.
CREATE TABLE billing_customers (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  customer TEXT NOT NULL UNIQUE,     -- Stripe's cus_…
  created_at INTEGER NOT NULL,
  checkout_at INTEGER                -- the last Checkout started (one may still be open for a day)
);

-- Each subscription as Stripe last said it was. synced_at: when Stripe was read; a write from an
-- older read never replaces one from a newer, so events handled at once can't put back what
-- Stripe had already changed.
CREATE TABLE billing_subscriptions (
  id TEXT PRIMARY KEY,               -- Stripe's sub_…
  user_id TEXT NOT NULL REFERENCES users(id),
  customer TEXT NOT NULL,
  status TEXT NOT NULL,              -- Stripe's: active, past_due, canceled, unpaid, incomplete, …
  interval TEXT,                     -- month | year
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  held INTEGER NOT NULL DEFAULT 0,   -- 1 while a dispute of the customer's is open: the assistant holds
  ended_at INTEGER,
  ended_reason TEXT,                 -- refunded | dispute_lost | null (Stripe's own ending)
  updated_at INTEGER NOT NULL,
  synced_at INTEGER                  -- milliseconds: when Stripe was read (two reads in one second still ordered)
);
CREATE INDEX billing_subscriptions_user ON billing_subscriptions (user_id, updated_at);
CREATE INDEX billing_subscriptions_customer ON billing_subscriptions (customer);

-- Each webhook event once: received, then done once handled (an event not done is handled again
-- when Stripe sends it again).
CREATE TABLE billing_events (
  id TEXT PRIMARY KEY,               -- Stripe's evt_…
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  done_at INTEGER
);

-- Disputes, as Stripe last said: while any of a customer's is open its subscriptions are held.
CREATE TABLE billing_disputes (
  id TEXT PRIMARY KEY,               -- Stripe's du_…
  customer TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX billing_disputes_customer ON billing_disputes (customer, status);
