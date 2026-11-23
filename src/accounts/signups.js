// New accounts, open or paused (the SIGNUPS var in wrangler.jsonc). Paused, no account is made
// anywhere: a passkey sign-up is refused at its first step, before the device is asked for a
// passkey, and a Google or GitHub sign-in nobody has used yet is told so instead of being
// offered an account. Everyone who has an account signs in as ever.

import { answer } from "./util.js";

export const signupsOpen = (env) => env.SIGNUPS !== "paused";

export const signupsPaused = () => answer({ error: "signups paused" }, 503, [], { "Retry-After": "300" });
