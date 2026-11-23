-- 0046: the plan given to an account by the site's operator, recorded as what it is: no subscription, no Stripe, no
-- billing cycle (src/billing/plan.js grantOf, entitlement). A live grant (revoked_at NULL) gives the account the plan's
-- room and, on the trips it hosts, the assistant, whether or not the site sells the plan. Written only by the operator's
-- tool (tools/plan-grant.mjs), which takes the account explicitly; read-only to the app.
--   plan_grants.user_id      the account (one grant at most; a revoked one is granted again by the tool)
--   plan_grants.granted_at   seconds
--   plan_grants.reason       the operator's words for why, shown to nobody but the account's own export
--   plan_grants.revoked_at   seconds; NULL while the grant holds
-- Gone with the account (src/accounts/delete.js, BILLING_TABLES). A new table only the new Worker reads: it may go
-- before the deploy.
CREATE TABLE plan_grants (
  user_id TEXT PRIMARY KEY,
  granted_at INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  revoked_at INTEGER
);
