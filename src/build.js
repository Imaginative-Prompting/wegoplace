// The build this Worker is: the same word as public/sw.js's VERSION and every page's <meta name="wgp-build">
// (scripts/sw_version_check.mjs holds the three equal, so a shell change that bumps VERSION bumps this too).
// The MCP says it as its serverInfo.version (src/mcp/server.js), so a client's view of the connection names the build
// it connected to.
export const BUILD = "v173";
