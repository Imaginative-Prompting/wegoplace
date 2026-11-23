// toast.js — the one transient message.
//
// A sentence that appears above the tab bar for five seconds and fades: a write the server
// refused, a save that failed, a link that points at nothing. It never blocks and never takes
// a tap (the node is pointer-events: none in styles.css).
//
// ONE node, ONE pair of timers, ONE function, for the whole app. There used to be five
// copies: the shell's, two screens with a node of their own and two more driving the shell's
// node with timers of their own. Each copy hid the node with a second timer once its fade
// had run, and only one of the five stopped that timer when a new message arrived. The cost:
// a message that landed during the fifth of a second another was fading in was hidden by the
// old one's timer, for good. A refusal the person never saw is a change that silently did
// not happen. scripts/toast_check.mjs times a message into that fade, and fails when any
// other file under public/ touches the node or keeps a toast of its own.
//
// The node is the shell's (`<div id="toast" class="toast" role="status" aria-live="polite">`
// in index.html), there from the first paint so a screen reader is already listening when
// the first message arrives. A page without one gets one made the same way.
//
// MESSAGES THAT ARRIVE TOGETHER ARE SHOWN TOGETHER. A message used to replace whatever was
// showing, at once. When two refusals come back in the same moment (a queue of writes sent
// after an hour with no signal), the first was on screen for a few milliseconds: the same
// harm as the timer above, by another road. Now a message that arrives within a second and a
// half of the last one joins it, each sentence on a line of its own, the newest lowest, three
// at most (the oldest goes). The five seconds start again from the newest, so every line gets
// its full time. A message that arrives later than that replaces what is showing, as before.
//
// ONE KIND OF MESSAGE STAYS UNTIL IT IS TAPPED: toastHold(). Five seconds is not "said" for
// something that will not be said again (a change made before the app was updated that was
// not carried over: js/old-queue.js). Those lines sit at the top of the same node with an OK
// button, the node takes taps while it holds them (class `toast-held`), and ordinary messages
// come and go beneath them on their own five seconds.
//
// No imports. State: the two timers, the lines on screen, when the newest arrived, and the
// lines being held.

const SHOW_MS = 5000;
const SHOW_ACTION_MS = 8000;
// A little longer than the fade in styles.css (`.toast`, var(--dur), 220ms): the node is
// hidden only once it can no longer be seen.
const FADE_MS = 240;

// Messages this close together are shown together, and no more than this many of them.
const GROUP_MS = 1500;
const MAX_LINES = 3;

let fadeTimer = null;   // ends the five seconds
let hideTimer = null;   // hides the node when the fade has run
let lines = [];         // the passing sentences on screen, oldest first
let action = null;      // optional { label, onClick } button on the current passing toast
let lastAt = 0;         // when the newest of them arrived (performance.now())
let held = [];          // the sentences that stay until tapped
let onLetGo = null;     // called once when they are tapped away

function stopTimers() {
  clearTimeout(fadeTimer);
  clearTimeout(hideTimer);
}

function node() {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.hidden = true;
    document.body.append(el);
  }
  if (!el.dataset.taps) {
    el.dataset.taps = "1";
    el.addEventListener("click", (ev) => {
      if (ev.target && ev.target.closest && ev.target.closest(".toast-act")) {
        ev.stopPropagation();
        triggerAction(el);
        return;
      }
      if (held.length) letGo(el);
    });
  }
  return el;
}

const lineNode = (text, cls) => {
  const line = document.createElement("div");
  line.className = cls;
  line.textContent = text;
  return line;
};

function draw(el) {
  const kids = held.map((t) => lineNode(t, "toast-line toast-kept"));
  if (held.length) {
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "toast-ok";
    ok.textContent = "OK";
    kids.push(ok);
  }
  if (action && lines.length) {
    const row = document.createElement("div");
    row.className = "toast-row";
    row.append(lineNode(lines[0], "toast-line"));
    const act = document.createElement("button");
    act.type = "button";
    act.className = "toast-act";
    act.textContent = action.label;
    row.append(act);
    kids.push(row);
  } else {
    kids.push(...lines.map((t) => lineNode(t, "toast-line")));
  }
  el.replaceChildren(...kids);
  el.classList.toggle("toast-held", held.length > 0);
  el.classList.toggle("toast-has-action", !!(action && lines.length));
}

function show(el) {
  clearTimeout(hideTimer);
  el.hidden = false;
  void el.offsetHeight;
  el.classList.add("toast-in");
}

function fade(el) {
  el.classList.remove("toast-in", "toast-has-action");
  hideTimer = setTimeout(() => {
    el.hidden = true;
    el.classList.remove("toast-held", "toast-has-action");
    if (!held.length && !lines.length) el.replaceChildren();   // nothing left in it to be read by anything
  }, FADE_MS);
}

function triggerAction(el) {
  if (!action) return;
  const fn = action.onClick;
  action = null;
  lines = [];
  stopTimers();
  if (held.length) draw(el); else fade(el);
  try { fn(); } catch (e) { console.error("[toast] action threw", e); }
}

function letGo(el) {
  held = [];
  const done = onLetGo;
  onLetGo = null;
  if (lines.length) draw(el); else fade(el);
  if (done) { try { done(); } catch (e) { console.error("[toast] onLetGo threw", e); } }
}

/**
 * Show one sentence for five seconds (eight when an action button is offered). It joins a message
 * that arrived in the last second and a half unless either carries an action; lines being held stay.
 * @param {string} msg
 * @param {{ action?: { label: string, onClick: () => void }, label?: string, onClick?: () => void }} [opts]
 */
export function toast(msg, opts) {
  const text = String(msg == null ? "" : msg).trim();
  if (!text) return;
  const raw = opts && typeof opts === "object"
    ? (opts.action && typeof opts.action === "object" ? opts.action : opts)
    : null;
  const label = raw && typeof raw.label === "string" ? raw.label.trim() : "";
  const onClick = raw && typeof raw.onClick === "function" ? raw.onClick : null;
  const nextAct = label && onClick ? { label, onClick } : null;
  const el = node();
  stopTimers();
  const now = performance.now();
  const showing = !el.hidden && el.classList.contains("toast-in") && lines.length > 0;
  if (nextAct) {
    lines = [text];
    action = nextAct;
  } else if (showing && !action && now - lastAt <= GROUP_MS) {
    if (!lines.includes(text)) lines.push(text);        // the same sentence twice is said once
    if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  } else {
    lines = [text];
    action = null;
  }
  lastAt = now;
  draw(el);
  show(el);
  fadeTimer = setTimeout(() => {
    lines = [];
    action = null;
    if (held.length) draw(el); else fade(el);
  }, action ? SHOW_ACTION_MS : SHOW_MS);
}

/**
 * Show sentences that stay until the person taps the message (or its OK). Called again while
 * some are held, the new set replaces them. An empty set holds nothing.
 * @param {string[]} msgs
 * @param {{ onLetGo?: () => void }} [opts]  called once when they are tapped away
 */
export function toastHold(msgs, { onLetGo: done } = {}) {
  const texts = (Array.isArray(msgs) ? msgs : [msgs]).map((m) => String(m == null ? "" : m).trim()).filter(Boolean);
  if (!texts.length) return;
  const el = node();
  held = texts;
  onLetGo = typeof done === "function" ? done : null;
  draw(el);
  show(el);
}
