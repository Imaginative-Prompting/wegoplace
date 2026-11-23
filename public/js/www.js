// The first thing every page of the app runs, at a www. address (www.wegoplace.com). The site
// answers there in full, for a phone whose app was added from there: its saved changes, its copy
// of the trip and its sign-in live under that address, and sending it elsewhere would strand them
// and throw the Home Screen app out of its own window. Anyone else is sent to the same page at
// the address without www., before anything here registers a worker or keeps a key, so a first
// visit leaves nothing behind that would make the next one stay.
//
// It stays when:
//   - it is running as the installed app (from the Home Screen, or a desktop's installed app);
//   - this address's service worker already controls the page (the app was opened here before);
//   - this address keeps anything in localStorage (the app, old or new, has run here).
// A classic script, loaded first in <head> and synchronously, so nothing after it has run yet.

(function () {
  var host = location.hostname;
  if (host.indexOf("www.") !== 0) return;
  var stay = false;
  try {
    stay = ["standalone", "fullscreen", "minimal-ui"].some(function (mode) { return matchMedia("(display-mode: " + mode + ")").matches; })
      || navigator.standalone === true;
  } catch (e) { /* no matchMedia: not the installed app */ }
  if (!stay) try { stay = !!(navigator.serviceWorker && navigator.serviceWorker.controller); } catch (e) { /* none */ }
  if (!stay) try { stay = localStorage.length > 0; } catch (e) { /* storage refused: nothing kept here */ }
  if (stay) return;
  // Stop this page before anything after this script is read, then go.
  try { window.stop(); } catch (e) { /* the navigation below replaces it anyway */ }
  location.replace(location.protocol + "//" + host.slice(4) + (location.port ? ":" + location.port : "")
    + location.pathname + location.search + location.hash);
})();

(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__wgpPressInit) return;
  window.__wgpPressInit = true;

  var SEL = "a[href],button,[role=\"button\"],[role=\"radio\"],[role=\"checkbox\"],[role=\"tab\"],[role=\"menuitem\"],summary," +
    ".card-tap,.ds-row--interactive,.ag-card,.ag-stay,.ag-gaplink,.ag-after,.ag-pill,.ag-pk-i,.ag-talk,.ag-b-addr," +
    ".pl-row,.pl-link,.sp-row,.sp-person,.sp-pickrow,.sp-dayrow,.sp-bal,.mel-row,.me-cell,.cg-look,.cg-chip," +
    ".mp-pin,.mp-cluster,.mp-hub,.mp-ctrl,.mp-peek,.mp-grab,.mp-x";
  var DELAY = 90;
  var SLOP = 8;
  var activeEl = null;
  var timer = 0;
  var pid = null;
  var sx = 0;
  var sy = 0;
  var cancelled = false;

  function isDisabled(el) {
    return !!(el.disabled || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("disabled"));
  }

  function pick(node) {
    var e = node && node.nodeType === 1 ? node : node && node.parentElement;
    var el = e && e.closest ? e.closest(SEL) : null;
    return el && !isDisabled(el) ? el : null;
  }

  function clear() {
    if (timer) { clearTimeout(timer); timer = 0; }
    if (activeEl) { activeEl.removeAttribute("data-press"); activeEl = null; }
    pid = null;
  }

  function cancel() {
    cancelled = true;
    clear();
  }

  document.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse") return;
    if (e.button && e.button !== 0) return;
    var el = pick(e.target);
    if (!el) return;
    clear();
    pid = e.pointerId;
    sx = e.clientX;
    sy = e.clientY;
    cancelled = false;
    timer = setTimeout(function () {
      timer = 0;
      if (!cancelled && el.isConnected && !isDisabled(el)) {
        activeEl = el;
        el.setAttribute("data-press", "1");
      }
    }, DELAY);
  }, { capture: true, passive: true });

  document.addEventListener("pointermove", function (e) {
    if (pid === null || e.pointerId !== pid) return;
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > SLOP) cancel();
  }, { capture: true, passive: true });

  document.addEventListener("touchmove", function () {
    if (timer || activeEl) cancel();
  }, { capture: true, passive: true });

  window.addEventListener("scroll", function () {
    if (timer || activeEl) cancel();
  }, { capture: true, passive: true });

  document.addEventListener("scroll", function () {
    if (timer || activeEl) cancel();
  }, { capture: true, passive: true });

  document.addEventListener("pointerup", cancel, { capture: true, passive: true });
  document.addEventListener("pointercancel", cancel, { capture: true, passive: true });
  document.addEventListener("touchend", cancel, { capture: true, passive: true });
  document.addEventListener("touchcancel", cancel, { capture: true, passive: true });
  window.addEventListener("blur", cancel, { capture: true, passive: true });
  document.addEventListener("visibilitychange", cancel, { capture: true, passive: true });
})();
