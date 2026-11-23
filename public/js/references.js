// A trip's reference list: short notes the whole group needs at hand that belong to no day and no place (money and ATMs,
// emergency numbers, the embassy, a door code, the host's phone). Read, added to, changed and removed by anyone on the
// trip, as plans are; kept on the phone with the rest of the trip, so it opens with no signal (store.js "references").
//
// THE BUTTON mirrors the +, lighter: a round tonal button (the app's fill, a hairline edge) on the +'s centre line at the
// bottom LEFT, on exactly the screens that draw a + (body[data-fab="1"], which router.js sets from the + itself: one rule,
// so the two can't disagree). It is not a .fab, so it never counts as one. The bottom-left is the dock's (the one Back,
// the Offline pill: styles.css .dock), and the Back keeps its place: when the dock shows anything, the button stands on
// top of it (styles.css .rf-fab).
//
// THE SHEET lists the items as rows: the title (its whole row opens the item, a pencil its sign), then the text with
// its line breaks, where a phone number and a web address (https) are tappable and nothing else is rich. "+ Add" at the
// top beside the title. An item's form is a sheet over the list (Save at its top; Remove inside it, asked in place).
// Empty, one line says what the list is for.

import { openSheet } from "./sheet.js";
import { uid } from "./util.js";
import { toast } from "./toast.js";
import { REFERENCE_TEXT_MAX, REFERENCE_TITLE_MAX, REFERENCES_MAX } from "./shared/limits.js";

const ICON = {
  // A book open at a page: the trip's reference.
  book: '<path d="M4 5.5c2.6-1 5.3-1 8 .7 2.7-1.7 5.4-1.7 8-.7v13c-2.6-1-5.3-1-8 .7-2.7-1.7-5.4-1.7-8-.7v-13Z"/><path d="M12 6.2v13"/>',
  pencil: '<path d="M4.5 19.5h3.6L19 8.6 15.4 5 4.5 15.9v3.6Z"/><path d="m13.4 7 3.6 3.6"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.7 7l.8 11.4A1.6 1.6 0 0 0 9.1 20h5.8a1.6 1.6 0 0 0 1.6-1.6L17.3 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
const svg = (name) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

// The numbers people dial in an emergency, which are too short to be found as phone numbers by their length.
const SHORT = new Set(["112", "911", "999", "000", "110", "119", "118", "100", "101", "102", "108", "113", "117", "122", "133", "144", "190", "192", "193"]);
const LINKS = /https:\/\/[^\s<>"]+|\+?\d[\d ().-]*\d/g;

/** A piece of text as nodes: a web address (https) and a phone number tappable, everything else as it is. */
export function linked(text) {
  const out = [];
  let at = 0;
  for (const m of String(text).matchAll(LINKS)) {
    let found = m[0];
    let href = null;
    if (found.startsWith("https://")) {
      found = found.replace(/[.,;:!?)\]]+$/, "");
      try { href = new URL(found).href; } catch { href = null; }
    } else {
      const digits = found.replace(/\D/g, "");
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(found);
      const phone = !iso && digits.length <= 15 && (found.startsWith("+") ? digits.length >= 7 : digits.length >= 8 || SHORT.has(found));
      if (phone) href = `tel:${found.startsWith("+") ? "+" : ""}${digits}`;
    }
    if (!href) continue;
    if (m.index > at) out.push(document.createTextNode(String(text).slice(at, m.index)));
    const a = document.createElement("a");
    a.href = href;
    a.textContent = found;
    if (href.startsWith("https:")) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
    out.push(a);
    at = m.index + found.length;
  }
  if (at < String(text).length) out.push(document.createTextNode(String(text).slice(at)));
  return out;
}

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.filter(Boolean));
  return node;
}

/** The sheet: the list; an item's form opens as a sheet over it. `store` is the trip's (store.js). */
export function openReferences(store) {
  const body = h("div", { class: "rf ds" });
  // The sheet's action at the top beside its title, as every sheet of the app has it (sheet.js footEl).
  const foot = h("div", { class: "rf-foot ds" });
  let sheet = null;
  let formOpen = null;

  const solid = (words, attrs = {}) => h("button", { type: "button", class: "btn ds-button ds-button--white ds-button--sm", text: words, ...attrs });

  // The list from its top, the focus on its sheet (opened, and after an add).
  function atTop() {
    const opened = body.closest(".sh-sheet");
    if (opened) opened.focus({ preventScroll: true });
    const port = body.closest(".sh-body");
    if (port) port.scrollTop = 0;
  }

  function list() {
    const items = store.references();
    const full = items.length >= REFERENCES_MAX;
    const add = solid("+ Add", { class: "btn ds-button ds-button--white ds-button--sm rf-add", "aria-label": "Add to the list", disabled: full || null });
    add.addEventListener("click", () => form(null));
    foot.replaceChildren(add);
    if (!items.length) {
      body.replaceChildren(h("p", { class: "rf-empty", text: "Notes the whole group needs at hand: emergency numbers, the embassy, money and ATMs, a door code." }));
      return;
    }
    body.replaceChildren(
      h("ul", { class: "rf-list" }, ...items.map((r) => {
        // The whole title row opens the item (the pencil its sign); the text below, with its links, is only read.
        const open = h("button", { type: "button", class: "rf-open", "data-rf-change": r.id, "aria-label": `Change ${r.title}` },
          h("span", { class: "rf-title-t", text: r.title }), h("span", { class: "rf-pencil", html: svg("pencil") }));
        open.addEventListener("click", () => form(r));
        return h("li", { class: "rf-item", "data-rf": r.id },
          h("h3", { class: "rf-title" }, open),
          r.body ? h("p", { class: "rf-text" }, ...linked(r.body)) : null);
      })),
      full ? h("p", { class: "rf-full", text: `The list holds ${REFERENCES_MAX}: change or remove one to add another.` }) : null);
  }

  // One item's form, as its own sheet over the list (as the plan editor is over a plan's page): Save at its top, Remove
  // inside it, asked in place; the handle and the backdrop are the way back to the list.
  function form(r) {
    if (formOpen) return;
    let added = false;
    const title = h("input", { class: "ds-input ds-input--lg", id: "rf-title", type: "text", maxlength: String(REFERENCE_TITLE_MAX), autocomplete: "off", autocapitalize: "sentences", enterkeyhint: "next", placeholder: "Emergency numbers" });
    const text = h("textarea", { class: "ds-textarea", id: "rf-text", rows: "10", maxlength: String(REFERENCE_TEXT_MAX), autocapitalize: "sentences", placeholder: "Police, fire and ambulance: 112" });
    title.value = r?.title ?? "";
    text.value = r?.body ?? "";
    const said = h("p", { class: "rf-said", role: "alert" });
    const save = solid(r ? "Save" : "Add", { "data-rf-save": "" });
    const removeBox = r ? h("div", { class: "rf-remove" }) : null;
    const askRemove = (asking) => {
      if (!removeBox) return;
      if (!asking) {
        const b = h("button", { type: "button", class: "ds-button ds-button--red ds-button--block", "data-destroys": "", "data-rf-remove": r.id, text: "Remove from the list" });
        b.addEventListener("click", () => askRemove(true));
        removeBox.replaceChildren(b);
        return b;
      }
      const keep = h("button", { type: "button", class: "ds-button ds-button--gray", "data-rf-keep": r.id, text: "Keep it" });
      const yes = h("button", { type: "button", class: "ds-button ds-button--red", "data-destroys": "", "data-rf-yes": r.id, text: "Remove" });
      keep.addEventListener("click", () => askRemove(false).focus());
      yes.addEventListener("click", async () => {
        try { await store.deleteReference(r.id); } catch (e) { toast(String(e?.message || e)); }
        formOpen?.close();
      });
      removeBox.replaceChildren(h("p", { class: "rf-ask", text: `Remove “${r.title}” from the list?` }), h("div", { class: "rf-askrow" }, keep, yes));
      keep.focus();
      return keep;
    };
    askRemove(false);
    const f = h("form", { class: "rf-form ds", novalidate: true },
      h("div", { class: "ds-field" }, h("label", { class: "ds-label", for: "rf-title", text: "Title" }), title),
      h("div", { class: "ds-field" }, h("label", { class: "ds-label", for: "rf-text", text: "Text" }), text,
        h("p", { class: "ds-help", text: "Phone numbers and https addresses can be tapped." })),
      said, removeBox);
    const submit = async () => {
      const t = title.value.trim(), b = text.value.trim();
      if (!t) { said.textContent = "Give it a title."; title.focus(); return; }
      try {
        if (r) await store.updateReference(r.id, { title: t, body: b });
        else { await store.addReference(uid("rf"), { title: t, body: b }); added = true; }
        formOpen?.close();
      } catch (err) { said.textContent = String(err?.message || err); }
    };
    f.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
    save.addEventListener("click", submit);
    const fsave = h("div", { class: "rf-foot ds" }, save);
    formOpen = openSheet({
      title: r ? "Change item" : "Add to the list", contentEl: f, footEl: fsave, dragFrom: "handle", closeButton: false,
      onClose: () => {
        formOpen = null;
        list();
        // After an add, the list from its top; after a change, back on that item's row, where it was.
        if (added) atTop();
        else if (r) body.querySelector(`[data-rf-change="${CSS.escape(r.id)}"]`)?.focus({ preventScroll: true });
      },
    });
  }

  const off = store.on("change", () => { list(); });
  sheet = openSheet({ title: "Quick reference", contentEl: body, footEl: foot, onClose: () => { off(); formOpen?.close(); } });
  list();
  // It opens on the sheet itself, at the list's top, never on a link that dials: sheet.js's first focus goes to the
  // first item's link and scrolls to it while the sheet still slides in (22 Nov, a list of five opened 32 px down).
  atTop();
  return sheet;
}

/**
 * The button, once for the page, on the body in the dock's band (the router empties its fixed layer at every
 * navigation, and the button belongs to no one screen); shown where a + is drawn (styles.css .rf-fab).
 */
export function mountReferences({ store }) {
  if (document.querySelector(".rf-fab")) return;
  const btn = h("button", { type: "button", class: "rf-fab ds", "aria-label": "Quick reference", html: svg("book") });
  btn.addEventListener("click", () => openReferences(store));
  document.body.append(btn);
}
