// The gate's planted lingerer (WGP_GATE_PLANT=linger, scripts/gate.mjs): a "check" that prints its tally and then never
// exits, as a harness does that catches its error and leaves its browser's socket open. The gate must end it and mark
// it red ("finished but didn't exit"). It opens nothing: an interval is what keeps it alive.
console.log("the planted lingerer: everything it looked at is fine");
console.log("\n1 passed, 0 failed");
setInterval(() => {}, 60000);
