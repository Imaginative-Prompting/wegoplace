-- Why a shared board stopped being shared (model §8), so its maker can see it the next time they
-- look: 'maker' (its maker revoked it; also the host revoking their own), 'host' (the trip's host
-- revoked someone else's), 'memory' (a memory on it was deleted, on its own or with its owner's
-- account). NULL while it is shared, and on boards revoked before this column: nobody recorded
-- why then.
--
-- Applied as ONE file after 0020 (ALTER TABLE … ADD COLUMN has no IF NOT EXISTS: a second
-- application fails and changes nothing).
ALTER TABLE collage_shares ADD COLUMN revoked_why TEXT CHECK (revoked_why IN ('maker', 'host', 'memory'));
