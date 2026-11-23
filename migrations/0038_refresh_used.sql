-- 0038: refresh tokens redeemed, so one used twice is told (src/mcp/oauth.js serveOAuth; checks/mcp-security, rule
-- refresh-replay). Each is kept by its hash, with the hash of the one it was traded for; a token presented again is a
-- replay and disconnects its app, but for the one asked again at once (its answer lost) while the newer is unused.
-- Swept with revoked_grants, past the refresh tokens' lifetime. (0037 is the limits sweep's.)
CREATE TABLE oauth_refresh_used (
  token_hash TEXT PRIMARY KEY,       -- sha256 of the refresh token presented (never the token)
  grant_hash TEXT NOT NULL,          -- its connection, as revoked_grants keeps it
  used_at INTEGER NOT NULL,          -- when it was first traded, in seconds
  successor_hash TEXT NOT NULL       -- sha256 of the refresh token it was traded for
);
CREATE INDEX oauth_refresh_used_by_time ON oauth_refresh_used (used_at);
