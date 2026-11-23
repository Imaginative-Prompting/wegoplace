// Your account's "Your picture": your face as everyone on your trips sees it, and the one sheet where it is made: your
// color (its ground), your drawing on it or your initials, nothing else.
//
//   PATCH  /api/me { note_color?, initials? }               -> { me }   your color and your initials (src/api/me.js)
//   PUT    /api/me/avatar { drawing: <base64url bytes> } -> { me }   the picture, in place of the initials
//   DELETE /api/me/avatar                                  -> { me }   back to the initials
//   (src/accounts/avatar.js; the bytes are shared/avatar.js's, the same module the server checks them with)
//
// The pad opens in a sheet whose circle is your face (public/ds/pad.js). Save sends what changed: the color and the
// initials first (one PATCH), then the picture (fitted to the format's ceiling) or, with nothing drawn, back to the
// initials; then the big circle travels up into the face on this card. Under reduced motion the circle doesn't
// travel: the face takes the picture with its short cross-fade. A save that fails part way says so and keeps the
// sheet open with what is on the pad; what did save is kept.
//
// This page opens with signal (it is the server's, never stood in for offline), so a save is sent at once, under the
// app's write limit (net.js): one with no answer says so and keeps the drawing on the pad to try again.
import { faceHtml, initialsOf as initialsOfName, setFaceDrawing } from "../ds/avatar.js";
import { pictureSvg } from "../ds/drawing.js";
import { mountPad } from "../ds/pad.js";
import { fit, toB64url } from "./shared/avatar.js";
import { forgetPicture, pictureInto, pictureOf, rememberPicture } from "./pictures.js";
import { openSheet } from "./sheet.js";
import { call, messages } from "./auth.js";

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The circle on the pad travels up into the face on the card (320 ms, the standard curve), then is gone. */
function fly(fromEl, toEl, drawing) {
  if (!fromEl || !toEl || reduced()) return Promise.resolve();
  const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
  if (!a.width || !b.width) return Promise.resolve();
  const el = document.createElement("div");
  el.className = "ds ac-pic-fly";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = pictureSvg(drawing);
  // The colours of the face it lands in (avatar.css), so the circle in flight is the picture as it will sit there.
  const into = getComputedStyle(toEl);
  for (const v of ["--ds-pic-ground", "--ds-pic-ink"]) el.style.setProperty(v, into.getPropertyValue(v).trim());
  Object.assign(el.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` });
  document.body.append(el);
  const cs = getComputedStyle(el);
  const duration = parseFloat(cs.getPropertyValue("--dur-320")) || 320;
  const easing = cs.getPropertyValue("--ease-standard").trim() || "ease";
  const done = el.animate(
    [{ transform: "none" }, { transform: `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${b.width / a.width})` }],
    { duration, easing, fill: "forwards" },
  ).finished;
  return done.then(() => el, () => el);
}

/**
 * Paints the card for `user` (/api/me's answer: its note_colors are the colors offered) and wires its button.
 * `onUser(me)` hears each change, so the page keeps one copy of who is signed in.
 */
export function paintPicture(card, user, { detail = null, onUser = () => {} } = {}) {
  const $ = (sel) => card.querySelector(sel);
  const faceHost = $("[data-pic-face]"), btn = $("[data-pic-open]");
  const said = messages($("[data-pic-msg]"), detail);
  const colors = Array.isArray(user.note_colors) ? user.note_colors : [];
  let me = user;

  const paint = () => {
    faceHost.innerHTML = faceHtml({ name: me.name, initials: me.initials, size: 96, me: true, color: me.note_color });
    pictureInto(faceHost.firstElementChild, me.avatar || "");
    btn.textContent = me.avatar ? "Change your picture" : "Draw your picture";
  };
  paint();

  btn.addEventListener("click", async () => {
    said.clear();
    const current = me.avatar ? await pictureOf(me.avatar) : null;
    const body = document.createElement("div");
    body.className = "ac-pic-sheet";
    const padHost = document.createElement("div");
    const msgBox = document.createElement("p");
    msgBox.className = "lg-msg";
    msgBox.setAttribute("role", "status");
    msgBox.setAttribute("aria-live", "polite");
    msgBox.hidden = true;
    msgBox.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"></svg><span></span>';
    body.append(padHost, msgBox);
    const inSheet = messages(msgBox, detail);
    let pad = null;
    const sheet = openSheet({ title: "Your picture", contentEl: body, dragFrom: "handle", onClose: () => pad && pad.destroy() });

    const keep = (out) => {
      const before = me.avatar;
      // The server's answer is the whole of who is signed in: a picture taken away is a key that is no longer there,
      // which a merge would keep.
      me = (out && out.me) || me;
      if (before && before !== me.avatar) forgetPicture(before);
      onUser(me);
    };
    // Sends what changed, in order; false (with the reason said in the sheet) at the first that fails.
    async function save({ drawing, color, initials }) {
      inSheet.clear();
      pad.busy(true);
      try {
        const patch = {};
        if (color && color !== me.note_color) patch.note_color = color;
        const nowInitials = String(me.initials || initialsOfName(me.name)).toUpperCase();
        if (initials && initials !== nowInitials) patch.initials = initials;
        if (Object.keys(patch).length) keep(await call("PATCH", "/api/me", patch));
        if (drawing) {
          const f = fit(drawing);
          if (!f) { inSheet.say("This picture can't be saved. Draw it again.", "err"); pad.busy(false); return null; }
          const out = await call("PUT", "/api/me/avatar", { drawing: toB64url(f.bytes) });
          keep(out);
          if (me.avatar) rememberPicture(me.avatar, f.drawing);
          return { drawing: f.drawing };
        }
        if (me.avatar) keep(await call("DELETE", "/api/me/avatar"));
        return { drawing: null };
      } catch (e) {
        if (e && e.code === "offline") inSheet.say("Couldn't save: no connection. Try again.", "err");
        else inSheet.fail(e);
        pad.busy(false);
        paint();                       // what did save shows on the card
        return null;
      }
    }

    pad = mountPad(padHost, {
      drawing: current,
      colors,
      color: me.note_color,
      initials: me.initials,
      name: me.name,
      hasPicture: !!me.avatar,
      fit: (d) => fit(d),
      onSave: async (wanted) => {
        const done = await save(wanted);
        if (!done) return;
        if (!done.drawing) { sheet.close(); paint(); said.say("Saved. The people on your trips see it the next time their trip opens.", "ok"); return; }
        // The face takes its new color under the circle about to arrive, then the circle, then the circle goes.
        paint();
        const from = padHost.querySelector("canvas"), face = faceHost.firstElementChild;
        const flying = fly(from, face, done.drawing);
        sheet.close();
        const el = await flying;
        setFaceDrawing(face, done.drawing);
        face.dataset.pic = me.avatar || "";
        if (el) requestAnimationFrame(() => el.remove());
        said.say("Saved. People on your trips see your picture in place of your initials.", "ok");
      },
      onInitials: async ({ color, initials }) => {
        if (!(await save({ drawing: null, color, initials }))) return;
        sheet.close();
        paint();
        said.say("Back to your initials.", "ok");
      },
    });
  });

  return { user: () => me };
}
