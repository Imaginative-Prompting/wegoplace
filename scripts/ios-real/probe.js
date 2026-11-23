/* v7 OBSERVER. Injected into the page by the dev proxy so REAL iOS Safari can report numbers.
 * It only OBSERVES: no scrolling, no focus, no event synthesis, no API shadowing. Everything
 * it reports is produced by a real thumb on the simulator. */
(function () {
  if (window.__v7) return;
  const S = { imgLoads: 0, imgAdds: 0, errs: [], marks: [] };
  window.__v7 = S;

  document.addEventListener("load", (e) => {
    if (e.target && e.target.tagName === "IMG") { S.imgLoads++; }
  }, true);
  try {
    new MutationObserver((recs) => {
      for (const r of recs) for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === "IMG") S.imgAdds++;
        else if (n.querySelectorAll) S.imgAdds += n.querySelectorAll("img").length;
      }
    }).observe(document, { childList: true, subtree: true });
  } catch (e) { S.errs.push("mo:" + e.message); }
  window.addEventListener("error", (e) => { S.errs.push(String(e.message).slice(0, 200)); });

  function snap() {
    const v = document.getElementById("view");
    const vv = window.visualViewport;
    const strip = document.querySelector(".ag-strip");
    const ring = strip && strip.querySelector(".ag-ring");
    const here = strip ? [...strip.querySelectorAll(".ag-pill-here")].map(p => p.dataset.jump || p.dataset.day).join(",") : "";
    const active = document.activeElement;
    const shBody = document.querySelector(".sh-body");
    const packFirst = document.querySelector(".pk-item, .pk-row, .pk-group, #view .pk, #view section");
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    return {
      t: Math.round(performance.now()),
      q: location.search,          // stale tabs keep posting; this is what tells the runs apart
      hash: location.hash,
      viewTop: v ? Math.round(v.scrollTop) : null,
      viewH: v ? Math.round(v.clientHeight) : null,
      pageY: Math.round(window.scrollY),
      bodyTop: (document.body && document.body.style.top) || "",
      bodyPos: S.bodyPos,
      vv: vv ? { ot: +vv.offsetTop.toFixed(1), ol: +vv.offsetLeft.toFixed(1), h: +vv.height.toFixed(1), ps: +vv.pageTop.toFixed(1), sc: +vv.scale.toFixed(2) } : null,
      stripL: strip ? +strip.scrollLeft.toFixed(1) : null,
      ringL: ring ? Math.round(parseFloat(ring.style.left) || 0) : null,
      ringAnim: ring && ring.getAnimations ? ring.getAnimations().length : 0,
      here,
      imgs: document.querySelectorAll("img").length,
      imgLoads: S.imgLoads, imgAdds: S.imgAdds,
      active: active ? (active.tagName + (active.id ? "#" + active.id : "") + (active.className && typeof active.className === "string" ? "." + active.className.split(" ")[0] : "")) : null,
      shBodyTop: shBody ? Math.round(shBody.scrollTop) : null,
      shBodyMax: shBody ? Math.round(shBody.scrollHeight - shBody.clientHeight) : null,
      rects: { pack: r(packFirst), sheet: r(document.querySelector(".sh-root")), field: r(active && /INPUT|TEXTAREA/.test(active.tagName) ? active : null),
        panel: r(document.querySelector(".sh-sheet")) },
      // The drawer's own detent state. Observed only — the whole question for the drag rework is
      // whether the panel's HEIGHT moves continuously or in one step, and .sh-root's rect is the
      // full screen, so it cannot answer that.
      // A point inside the drawer's scrollport that is not a control, so a drag can be aimed at
      // real blank space instead of guessed at. Observation only: it reads geometry, it does not
      // touch anything.
      blank: (() => {
        const b = document.querySelector(".sh-body"); if (!b) return null;
        const SEL = "button,a[href],input,select,textarea,label,[role=button],[contenteditable=true]";
        const rr = b.getBoundingClientRect();
        const boxes = [...b.querySelectorAll(SEL)].map((e) => e.getBoundingClientRect());
        const clear = (x, y) => !boxes.some((q) =>
          x >= q.left - 2 && x <= q.right + 2 && y >= q.top - 2 && y <= q.bottom + 2);
        for (let y = Math.round(rr.top + 10); y < rr.bottom - 10; y++) {
          for (const fx of [0.5, 0.06, 0.94, 0.25, 0.75]) {
            const x = Math.round(rr.x + rr.width * fx);
            if (!clear(x, y)) continue;
            const el = document.elementFromPoint(x, y);
            if (el && b.contains(el) && !el.closest(SEL)) return [x, y];
          }
        }
        return null; })(),
      sh: (() => { const rt = document.querySelector(".sh-root"); if (!rt) return null;
        return { tall: rt.dataset.tall || "", lift: rt.dataset.lift || "",
          drag: rt.dataset.drag || "", settle: rt.dataset.settle || "",
          h: rt.style.getPropertyValue("--sh-h") || "" }; })(),
      errs: S.errs.slice(0, 5),
    };
  }
  S.snap = snap;

  let timer = null;
  function post(tag, rows) {
    try {
      fetch("/__v7log", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ tag, rows }) });
    } catch (e) {}
  }
  // Continuous sampler: one row per animation frame, flushed every 500ms. Passive.
  const buf = [];
  // ~33 Hz, NOT one sample per animation frame. Reading layout every frame would be an
  // observer that changes what it observes; 30ms is dense enough to catch a 300ms keyboard
  // rise and cheap enough that the scroller stays honest.
  // The probe is injected at the end of <head>, so document.body is null right now.
  const bodyPos = () => (document.body ? getComputedStyle(document.body).position : "");
  S.bodyPos = bodyPos();
  setInterval(() => { S.bodyPos = bodyPos(); }, 250);
  setInterval(() => { if (!S.on) return; try { buf.push(snap()); } catch (e) { S.snapErr = String(e && e.stack || e).slice(0,300); } }, 30);
  setInterval(() => { if (buf.length) { post("stream", buf.splice(0, buf.length)); } }, 500);
  S.on = true;
  // Also flush on every visualViewport change, since that is the keyboard talking.
  if (window.visualViewport) {
    const flag = (k) => () => { buf.push(Object.assign(snap(), { ev: k })); };
    window.visualViewport.addEventListener("resize", flag("vv:resize"));
    window.visualViewport.addEventListener("scroll", flag("vv:scroll"));
  }
  document.addEventListener("focusin", (e) => { buf.push(Object.assign(snap(), { ev: "focusin:" + (e.target.tagName || "") })); }, true);
  document.addEventListener("focusout", (e) => { buf.push(Object.assign(snap(), { ev: "focusout" })); }, true);
})();
