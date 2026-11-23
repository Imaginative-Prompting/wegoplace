// The service worker's part of push notifications (src/push/routes.js sends them). sw.js loads this
// with importScripts, so it is a classic script: no import, no export.
//
// A message arrives as Declarative Web Push's JSON ({ web_push, notification, wgp }). Safari 18.4 and
// later can show it with no service worker at all; here it is shown by hand, with what only a worker
// can add: one notification per trip (a newer message replaces it, `tag`), and the action that mutes
// the trip's chat from the lock screen.
//
//   tap the notification   the trip's chat, in a window of the app that is already open if there is one
//   "Mute this trip"       PUT /api/trips/<trip>/chat/mute {muted: true}, as the person (their cookie);
//                          the chat's header shows it muted, and it can be unmuted there

/* global self, clients */

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const n = data.notification || {};
  const w = data.wgp || {};
  const options = {
    body: typeof n.body === "string" ? n.body : "",
    tag: w.tag || undefined,
    renotify: !!w.tag,
    icon: "/icons/icon-192.e2026552.png",
    badge: "/icons/icon-192.e2026552.png",
    lang: n.lang || "en",
    dir: n.dir || "auto",
    data: { url: n.navigate || "/", mute: w.mute || null, trip: w.trip || null },
    actions: w.mute ? [{ action: "mute", title: "Mute this trip" }] : [],
  };
  event.waitUntil(self.registration.showNotification(typeof n.title === "string" && n.title ? n.title : "WeGoPlace", options));
});

self.addEventListener("notificationclick", (event) => {
  const d = event.notification.data || {};
  event.notification.close();
  if (event.action === "mute" && d.mute) {
    event.waitUntil(fetch(d.mute, {
      method: "PUT", credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ muted: true }),
    }).catch(() => {}));
    return;
  }
  const url = new URL(d.url || "/", self.location.origin);
  // Only this site's own pages: what a notification carries came from the server, and stays here.
  if (url.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const open = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const same = open.find((c) => new URL(c.url).pathname === url.pathname);
    if (same) {
      await same.focus();
      if (new URL(same.url).hash !== url.hash) await same.navigate(url.href).catch(() => {});
      return;
    }
    await clients.openWindow(url.href);
  })());
});

// A subscription the browser replaced on its own (it rotates keys now and then): the page that next
// opens says so to the server (public/js/push.js keeps it current); nothing to do here without a page.
