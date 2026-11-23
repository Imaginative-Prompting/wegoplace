// /report (report.html): Report a bug for someone who isn't signed in, through the same form as More's (report-form.js),
// sent without the session cookie: it names no one, even on a device that is signed in. The screen it names is the page
// of this site the person came from (its path alone: the sign-in page, say), or this page's own.

import { reportForm } from "./report-form.js";

// The pages that link here, by the names people know them by.
const NAMES = { "/login": "Sign in", "/login/new": "Sign in", "/report": "Report a bug" };

function cameFrom() {
  try {
    const from = new URL(document.referrer);
    if (from.origin === location.origin && from.pathname !== location.pathname) return from.pathname;
  } catch { /* no referrer */ }
  return location.pathname;
}

const screenAddress = cameFrom();
const form = reportForm({ screenAddress, screenName: NAMES[screenAddress] ?? "", withAccount: false });
document.getElementById("rp-form").replaceChildren(form.el);
