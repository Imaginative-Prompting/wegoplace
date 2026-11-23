-- 0044: when Stripe will end a subscription (its cancel_at), beside the flag. A subscription on flexible billing,
-- cancelled in the Portal to the end of what's paid for, comes as cancel_at (a time) with cancel_at_period_end false;
-- an older one comes as the flag alone. src/billing/plan.js reads both: the plan ends at cancel_at when it's set, else
-- at the period's end when the flag is.
--   billing_subscriptions.cancel_at   seconds; NULL when the subscription renews (or ends only by the flag).
-- A column with no default that only the new Worker reads: an old Worker reads past it, so it may go before the deploy.
ALTER TABLE billing_subscriptions ADD COLUMN cancel_at INTEGER;
