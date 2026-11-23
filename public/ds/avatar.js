// A person's mark, as the design system draws it (avatar.css): initials on gray, or the picture they drew, on its
// palette's ground. Either way a hairline ring, and the person's name as its label.
//
//   faceHtml({ name, initials, drawing, picture, size, me })   the markup, for a template
//     name      the person's name: the mark's label (role="img")
//     initials  what is drawn without a picture; from the name when not given
//     drawing   a picture already in hand (drawing.js's shape): drawn at once
//     picture   the hash of a stored picture: drawn when wakeFaces is handed a way to load it; the initials show until
//               then, and stay if it can't be had
//     size      24, 32 (the default), 44 or 96
//     me        your own mark, a step brighter
//   wakeFaces(root, load)   draws the stored pictures under root; load(hash) resolves to a drawing or null. A picture
//                           that arrives over initials already on screen comes in with a short cross-fade.

import { esc } from "../js/util.js";
import { checkDrawing, pictureSvg } from "./drawing.js";

const SIZES = new Set([24, 32, 44, 96]);
const HASH = /^[a-z0-9_-]{8,128}$/i;

export const PERSON_TONES = [
  "deep-blue", "amber", "mauve", "sky",
  "green", "sea", "teal", "moss",
  "sun", "rust", "coral", "leather",
  "cherry", "magenta", "violet", "indigo",
  "slate", "heather", "charcoal", "paper",
];

// Strictly 1-to-1 with NOTE_COLORS (src/api/trip.js); keys drop the leading hash so no raw colour sits outside tokens.css.
const COLOR_TO_TONE = {
  "0072b2": "deep-blue",
  "e69f00": "amber",
  "cc79a7": "mauve",
  "56b4e9": "sky",
  "009e73": "green",
  "4caf88": "sea",
  "0f9b9b": "teal",
  "8bc34a": "moss",
  "f0c808": "sun",
  "d55e00": "rust",
  "e8743b": "coral",
  "a8763e": "leather",
  "c2185b": "cherry",
  "b5179e": "magenta",
  "7b5bd6": "violet",
  "5b6abf": "indigo",
  "78909c": "slate",
  "6d6875": "heather",
  "2e2e2e": "charcoal",
  "e0e0e0": "paper",
};

/** Maps a stored users.note_color 1-to-1 to its --person-* token name, or "" when unset/unknown (stays neutral). */
export function personTone(color) {
  const key = String(color || "").trim().replace(/^#/, "").toLowerCase();
  if (Object.hasOwn(COLOR_TO_TONE, key)) return COLOR_TO_TONE[key];
  if (PERSON_TONES.includes(key)) return key;
  return "";
}

/**
 * The colours a person can wear, as the server offers them ([{ hex, name }], GET /api/me's note_colors), for a page with
 * no one signed in to ask (the design page). A page with a person uses the server's list.
 */
export function personColors() {
  return Object.entries(COLOR_TO_TONE).map(([key, tone]) => ({
    hex: `#${key.toUpperCase()}`,
    name: tone[0].toUpperCase() + tone.slice(1).replace(/-/g, " "),
  }));
}

/** Inline CSS variables for a person's own colour token, or "" when they have no colour yet. */
export function personVars(color) {
  const t = personTone(color);
  return t
    ? `--ds-person:var(--person-${t});--ds-person-bg:var(--person-${t}-bg);--ds-person-edge:var(--person-${t}-edge);--ds-person-on:var(--person-${t}-on)`
    : "";
}

/** Two letters from a name: the first of its first two words, or its first two letters. */
export function initialsOf(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const two = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
  return two.toUpperCase();
}

export function faceHtml({ name = "", initials, drawing = null, picture = null, size = 32, me = false, color = null, className = "", decorative = false, label = null } = {}) {
  const s = SIZES.has(size) ? size : 32;
  const extra = className ? `${esc(className)} ` : "";
  const cls = `${extra}ds-face${s !== 32 ? ` ds-face--${s}` : ""}${me ? " ds-face--me" : ""}`;
  const letters = esc(initials || initialsOf(name));
  const drawn = checkDrawing(drawing);
  const pic = drawn
    ? `<span class="ds-face-pic" data-ready>${pictureSvg(drawn)}</span>`
    : picture && HASH.test(picture) ? `<span class="ds-face-pic" data-face-hash="${esc(picture)}"></span>` : "";
  const t = personTone(color);
  const toneAttr = t ? ` data-person="${t}" style="${personVars(t)}"` : "";
  const a11y = decorative ? ` aria-hidden="true"` : ` role="img" aria-label="${esc(label != null ? label : (name || initials || ""))}"`;
  return `<span class="${cls}"${drawn ? " data-drawn" : ""}${toneAttr}${a11y}><span aria-hidden="true">${letters}</span>${pic}</span>`;
}

/** Puts a picture into a face already on screen (after "Use this picture"), or takes it out (null: initials). */
export function setFaceDrawing(face, drawing) {
  if (!face) return;
  const drawn = checkDrawing(drawing);
  let pic = face.querySelector(":scope > .ds-face-pic");
  if (!drawn) { pic?.remove(); face.removeAttribute("data-drawn"); return; }
  if (!pic) { pic = document.createElement("span"); pic.className = "ds-face-pic"; face.append(pic); }
  pic.removeAttribute("data-ready");
  pic.removeAttribute("data-face-hash");
  pic.innerHTML = pictureSvg(drawn);
  face.setAttribute("data-drawn", "");
  void pic.offsetWidth;               // so the cross-fade runs from the initials
  pic.setAttribute("data-ready", "");
}

export function wakeFaces(root = document, load = null) {
  if (typeof load !== "function") return;
  for (const pic of root.querySelectorAll(".ds-face-pic[data-face-hash]:not([data-loading])")) {
    pic.setAttribute("data-loading", "");
    Promise.resolve()
      .then(() => load(pic.getAttribute("data-face-hash")))
      .then((d) => { if (pic.isConnected && checkDrawing(d)) setFaceDrawing(pic.parentElement, d); }, () => {});
  }
}
