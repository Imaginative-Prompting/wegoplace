// The site's own address, for anything the app prints for someone else to use: an AI app's
// address, a join link, a shared board's link. It is the server's (GET /api/auth/config,
// `origin`: PUBLIC_ORIGIN), never this page's: a phone whose app lives at www.wegoplace.com still
// hands everyone https://wegoplace.com/… (src/accounts/util.js siteOrigins).
//
//   await siteOrigin()        "https://wegoplace.com"; with no answer, the one last heard here;
//                             null if this phone has never heard one
//   siteUrl(path)             the same, with a path: await siteUrl("/s/abc") (null as above)

import { within } from "./net.js";

const KEY = "wgp.site.origin";
let asked = null;

export function siteOrigin() {
  asked ??= (async () => {
    try {
      const origin = await within("GET", async (signal) => {
        const res = await fetch("/api/auth/config", { headers: { Accept: "application/json" }, credentials: "same-origin", signal });
        return res.ok ? (await res.json())?.origin : null;
      });
      if (typeof origin === "string" && /^https?:\/\/[^/]+$/.test(origin)) {
        try { localStorage.setItem(KEY, origin); } catch { /* private mode: asked again next time */ }
        return origin;
      }
    } catch { /* no signal: the one last heard */ }
    asked = null;                                    // ask again next time
    try { return localStorage.getItem(KEY); } catch { return null; }
  })();
  return asked;
}

export async function siteUrl(path) {
  const origin = await siteOrigin();
  return origin ? new URL(path, origin).href : null;
}
