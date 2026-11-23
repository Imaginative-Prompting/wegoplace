// "Invite people": one tap makes a join link (LINK_DAYS_DEFAULT days, up to LINK_USES_DEFAULT people) and opens a sheet
// that hands it on: Share (the phone's own share sheet) and Copy. Asking for how long and how many first was two choices
// nobody had a reason to make; they are on People and settings, under "Link settings", with every link made so far.
//
//   openInvite({ tripId, tripName, onClose, onSettings })    anyone on the trip (POST /api/trips/<id>/links: any member)
//
// onSettings: on People and settings itself, "Links and how long they work" closes the sheet and opens Link settings
// there (its address is the page already open).
//
// The share is a second tap, on purpose: a phone lets a page open its share sheet only straight from a tap, and the
// link is made over the network first. The link is at the site's own address (site.js), never this page's.
import { openSheet } from "./sheet.js";
import { fetchWithin } from "./net.js";
import { siteUrl } from "./site.js";
import { LINK_DAYS_DEFAULT, LINK_USES_DEFAULT } from "./shared/limits.js";

let open = null;

export function openInvite({ tripId, tripName = "", onClose = null, onSettings = null } = {}) {
  if (open || !tripId) return open;
  const body = document.createElement("div");
  body.className = "ds iv-sheet";
  body.innerHTML = `
    <p class="ds-body iv-say" role="status" aria-live="polite">Making a link…</p>
    <div class="iv-made" hidden>
      <input class="ds-input iv-url" type="text" readonly aria-label="The link to join">
      <div class="iv-acts">
        <button type="button" class="ds-button ds-button--white ds-button--lg iv-share" hidden>Share</button>
        <button type="button" class="ds-button ds-button--gray ds-button--lg iv-copy">Copy</button>
      </div>
      <p class="ds-meta iv-fine">Anyone with it can join for ${LINK_DAYS_DEFAULT} days, up to ${LINK_USES_DEFAULT} people. No account needed.
        <a href="/trips/${encodeURIComponent(tripId)}">Links and how long they work</a></p>
    </div>`;
  ensureStyles();
  const $ = (sel) => body.querySelector(sel);
  const say = (text, kind = "") => { const p = $(".iv-say"); p.textContent = text; p.dataset.kind = kind; p.hidden = !text; };
  let toSettings = false;            // closed by "Links and how long they work": Link settings opens once the sheet is gone
  const sheet = openSheet({ title: "Invite people", contentEl: body, dragFrom: "handle", onClose: () => {
    open = null;
    if (typeof onClose === "function") onClose();
    if (toSettings) onSettings();
  } });
  open = sheet;
  if (typeof onSettings === "function") {
    $(".iv-fine a").addEventListener("click", (ev) => { ev.preventDefault(); toSettings = true; sheet.close(); });
  }

  (async () => {
    let res;
    try {
      res = await fetchWithin(`/api/trips/${encodeURIComponent(tripId)}/links`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: LINK_DAYS_DEFAULT, uses: LINK_USES_DEFAULT }),
      });
    } catch {
      say("No connection, so no link was made. Try again with signal.", "err");
      return;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.link) {
      const why = json.reason ? json.reason.charAt(0).toUpperCase() + json.reason.slice(1) + "." : "The link couldn't be made. Try again.";
      say(why.replace(/\.\.$/, "."), "err");
      return;
    }
    const url = await siteUrl(json.link.url);
    if (!url) { say("The link is made, but this phone couldn't reach the site for its address. Open People and settings to copy it.", "err"); return; }
    say("");
    $(".iv-url").value = url;
    $(".iv-made").hidden = false;
    const share = $(".iv-share");
    share.hidden = !navigator.share;
    share.addEventListener("click", async () => {
      try { await navigator.share({ title: tripName, text: `Join “${tripName}” on WeGoPlace`, url }); }
      catch { /* closed without sharing: nothing to say */ }
    });
    $(".iv-copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(url); say("Copied."); }
      catch { $(".iv-url").select(); say("This browser didn't let the page copy it. It's selected in the box: copy it from there."); }
    });
    (navigator.share ? share : $(".iv-copy")).focus({ preventScroll: true });
  })();
  return sheet;
}

function ensureStyles() {
  if (document.getElementById("iv-styles")) return;
  const s = document.createElement("style");
  s.id = "iv-styles";
  s.textContent = `
.iv-sheet{display:grid;gap:var(--sp-3,12px);padding-bottom:var(--sp-2,8px)}
.iv-say{margin:0;color:var(--ink-2)}
.iv-say[data-kind="err"]{color:var(--ink-1)}
.iv-made{display:grid;gap:var(--sp-3,12px)}
.iv-made[hidden]{display:none}
.iv-url{width:100%;font-family:var(--type-mono);font-size:var(--size-14)}
.iv-acts{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:var(--sp-2,8px)}
.iv-fine{margin:0}
.iv-fine a{color:var(--ink-1)}`;
  document.head.append(s);
}

