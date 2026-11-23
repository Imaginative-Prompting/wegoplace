#!/usr/bin/env python3
"""WeGoPlace's wordmark, mark and app icon, drawn by code (second version, 19 Nov 2026).

Small chunky hikers doing different things on and through bold round letters: one hangs off a
rope, one scrambles over an e, one strides across a gap, one sits in the P like a window, one
leaps, one naps in the last e. The icon is a wide W with three of them inside its own bounds.

    python3 art/make_logo.py --site            # the files the site serves (below), into public/, then
                                               # tools/icon-names.mjs: the icons under names made from their bytes
    python3 art/make_logo.py --site DIR        # the same into DIR (how scripts/logo_check.mjs compares)
    python3 art/make_logo.py [palette …]       # the whole set on every ground, with rig.json, into art/out

The site's files:
    public/img/wordmark.svg   the wordmark, no ground, its colours the page's: --logo-letter, --logo-figure,
                              --logo-shade, --logo-pack, --logo-rope, and --logo-ground for the gap that lifts
                              a hiker off a letter (styles.css sets them for light and dark; void's are the
                              fallbacks)
    public/img/mark.svg       the W and its hikers, the same way
    public/img/icon.svg       the app icon on void, a 1024 square
    public/icons/icon-512.png, icon-192.png, icon-180.png (an iPhone's Home Screen)
    public/favicon.ico        16, 32 and 48: the W and the flag-planter alone
    public/logo/wordmark-data.json   the wordmark's letters and counters, for the hikers' player
                              (public/js/hikers-player.js); public/logo/idle-60.json, the loop it plays,
                              is keyed on rig.json by hand and copied in, not drawn here

Units: the capital height is 100, the baseline is y = 0, y grows downward.
Angles: degrees, 0 = right, 90 = down (clockwise on screen).
"""
import json
import math
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"            # the whole set; art/out is not kept in git

# ── the letters ──────────────────────────────────────────────────────────────────────────
STROKE = 17.5
H = STROKE / 2
CAP, XH, OVER = 100.0, 72.0, 1.0
TOP, BASE = -(CAP - H), -H
R_LOW, CY_LOW = (XH + 2 * OVER - STROKE) / 2, -(XH / 2)
R_CAP, CY_CAP = (CAP + 2 * OVER - STROKE) / 2, -(CAP / 2)
W_HALF, W_PEAK = 31.0, 0.70          # half a V's width; how high the middle peak comes


def pt(cx, cy, r, deg):
    a = math.radians(deg)
    return (cx + r * math.cos(a), cy + r * math.sin(a))


def arc_pts(cx, cy, r, a0, a1, n=72):
    return [pt(cx, cy, r, a0 + (a1 - a0) * i / n) for i in range(n + 1)]


def letter_W():
    a, peak = W_HALF, -(CAP * W_PEAK - H)
    p = [(H, TOP), (H + a, BASE), (H + 2 * a, peak), (H + 3 * a, BASE), (H + 4 * a, TOP)]
    return {"segs": [p], "width": 4 * a + STROKE, "nodes": p}


def letter_e():
    cx, cy, r = H + R_LOW, CY_LOW, R_LOW
    bar = [(cx - r, cy), (cx + r, cy)]
    return {"segs": [bar + arc_pts(cx, cy, r, 0, -318)[1:]], "width": 2 * r + STROKE, "c": (cx, cy), "r": r}


def letter_o():
    cx, cy, r = H + R_LOW, CY_LOW, R_LOW
    return {"segs": [arc_pts(cx, cy, r, 0, -360, 96)], "width": 2 * r + STROKE, "c": (cx, cy), "r": r, "closed": True}


def letter_c():
    cx, cy, r = H + R_LOW, CY_LOW, R_LOW
    seg = arc_pts(cx, cy, r, -46, -314)
    return {"segs": [seg], "width": seg[0][0] + H, "c": (cx, cy), "r": r}


def letter_a():
    cx, cy, r = H + R_LOW, CY_LOW, R_LOW
    stem = [(cx + r, -(XH - H)), (cx + r, BASE)]
    return {"segs": [arc_pts(cx, cy, r, 0, -360, 96), stem], "width": 2 * r + STROKE, "c": (cx, cy), "r": r}


def letter_l():
    return {"segs": [[(H, TOP), (H, BASE)]], "width": STROKE, "c": (H, CY_CAP), "r": 0}


def letter_P():
    rb, run = 25.0, 16.0
    x0 = H
    bowl = arc_pts(x0 + run, TOP + rb, rb, -90, 90, 48)
    seg = [(x0, BASE), (x0, TOP), (x0 + run, TOP)] + bowl[1:] + [(x0, TOP + 2 * rb)]
    return {"segs": [seg], "width": run + rb + STROKE, "c": (x0 + run, TOP + rb), "r": rb}


def letter_G():
    cx, cy, r = H + R_CAP, CY_CAP, R_CAP
    seg = arc_pts(cx, cy, r, -42, -360, 96) + [(cx + 4, cy)]
    return {"segs": [seg], "width": 2 * r + STROKE, "c": (cx, cy), "r": r}


WORD = [("W", letter_W), ("e", letter_e), ("G", letter_G), ("o", letter_o), ("P", letter_P),
        ("l", letter_l), ("a", letter_a), ("c", letter_c), ("e2", letter_e)]
# The space after each letter, by eye; the two word spaces are wider than a letter space.
GAPS = {"W": 4.0, "e": 23.0, "G": 10.0, "o": 24.0, "P": 11.0, "l": 12.0, "a": 10.0, "c": 8.0, "e2": 0.0}


def lay_out(word=WORD):
    x, out = 0.0, {}
    for name, make in word:
        L = make()
        L["name"], L["x"] = name, x
        shift = lambda p: (p[0] + x, p[1])
        L["segs"] = [[shift(p) for p in s] for s in L["segs"]]
        if "c" in L:
            L["c"] = shift(L["c"])
        if "nodes" in L:
            L["nodes"] = [shift(p) for p in L["nodes"]]
        out[name] = L
        x += L["width"] + GAPS.get(name, 0.0)
    return out, x


def dense(seg, step=0.5):
    pts = []
    for (x0, y0), (x1, y1) in zip(seg, seg[1:]):
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / step))
        pts += [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(n)]
    pts.append(seg[-1])
    return pts


class Ink:
    """Where the letters are, so feet and hands can be put on their edges."""

    def __init__(self, letters):
        self.pts = [p for L in letters.values() for s in L["segs"] for p in dense(s)]

    def top(self, x):
        best = None
        for px, py in self.pts:
            dx = abs(px - x)
            if dx <= H:
                y = py - math.sqrt(H * H - dx * dx)
                if best is None or y < best:
                    best = y
        return best

    def clearance(self, p, r=0.0):
        return min(math.hypot(px - p[0], py - p[1]) for px, py in self.pts) - H - r

    def rest(self, x, r):
        """The lowest point above the letters at x where a round end of radius r only touches."""
        y = self.top(x) - r
        while self.clearance((x, y), r) < 0:
            y -= 0.05
        return (x, y)


def path_d(seg, closed=False):
    return "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in seg) + (" Z" if closed else "")


# ── the hikers ───────────────────────────────────────────────────────────────────────────
FIG = {"head_r": 6.6, "torso": 10.0, "torso_w": 7.4, "limb_w": 4.7,
       "upper_arm": 7.8, "forearm": 7.4, "thigh": 8.2, "shin": 7.8, "foot": 3.4,
       "pack": {"w": 7.0, "h": 10.4, "r": 2.4}, "rope_w": 1.9, "pole_w": 1.9, "gap": 1.4}


def ik(a, b, l1, l2, bend):
    dx, dy = b[0] - a[0], b[1] - a[1]
    d = math.hypot(dx, dy) or 1e-6
    reach = max(abs(l1 - l2) + 1e-4, min(d, l1 + l2 - 1e-4))
    cos_a = (l1 * l1 + reach * reach - l2 * l2) / (2 * l1 * reach)
    ang = math.atan2(dy, dx) + bend * math.acos(max(-1.0, min(1.0, cos_a)))
    mid = (a[0] + l1 * math.cos(ang), a[1] + l1 * math.sin(ang))
    return mid, (a[0] + dx / d * reach, a[1] + dy / d * reach)


def limb(root, spec, l1, l2):
    """A two-bone limb: {"to": point, "bend": ±1} reaches for a point; {"a": (upper, lower)} is posed by angle."""
    if "to" in spec:
        return ik(root, spec["to"], l1, l2, spec.get("bend", 1))
    u, lo = (math.radians(v) for v in spec["a"][:2])
    mid = (root[0] + l1 * math.cos(u), root[1] + l1 * math.sin(u))
    return mid, (mid[0] + l2 * math.cos(lo), mid[1] + l2 * math.sin(lo))


def place(pose, k=1.0):
    """Where the chest and the head are for a pose's pelvis, lean and head tilt."""
    f = FIG
    hip = pose["hip"]
    lean = math.radians(pose.get("lean", 0.0))          # 0 = upright; positive leans to the right
    chest = (hip[0] + f["torso"] * k * math.sin(lean), hip[1] - f["torso"] * k * math.cos(lean))
    tilt = lean + math.radians(pose.get("head", 0.0))
    hr = f["head_r"] * k
    head = (chest[0] + hr * 0.92 * math.sin(tilt), chest[1] - hr * 0.92 * math.cos(tilt))
    return chest, head


def figure(pose, k=1.0):
    f = FIG
    hip = pose["hip"]
    chest, head = place(pose, k)
    face = pose.get("face", 1)
    J = {"pelvis": hip, "chest": chest, "neck": chest, "head": head}
    for name, root, l1, l2 in (("arm_n", chest, "upper_arm", "forearm"), ("arm_f", chest, "upper_arm", "forearm"),
                               ("leg_n", hip, "thigh", "shin"), ("leg_f", hip, "thigh", "shin")):
        spec = pose[name]
        mid, end = limb(root, spec, f[l1] * k, f[l2] * k)
        if name.startswith("leg"):
            foot = spec["a"][2] if "a" in spec and len(spec["a"]) > 2 else spec.get("foot", 0.0 if face > 0 else 180.0)
            fa = math.radians(foot)
            toe = (end[0] + f["foot"] * k * math.cos(fa), end[1] + f["foot"] * k * math.sin(fa))
            J[name] = (root, mid, end, toe)
        else:
            J[name] = (root, mid, end)
    return J


def elbow_and_raise(J, arm):
    s_, e, h = J[arm][:3]
    v1, v2 = (s_[0] - e[0], s_[1] - e[1]), (h[0] - e[0], h[1] - e[1])
    cosang = (v1[0] * v2[0] + v1[1] * v2[1]) / ((math.hypot(*v1) * math.hypot(*v2)) or 1e-9)
    elbow = math.degrees(math.acos(max(-1.0, min(1.0, cosang))))
    raised = math.degrees(math.atan2(-(h[1] - s_[1]), abs(h[0] - s_[0]) or 1e-9))
    return round(elbow, 1), round(raised, 1)


def ang(a_, b_):
    return round(math.degrees(math.atan2(b_[1] - a_[1], b_[0] - a_[0])), 1)


LIMITS = {"knee": (0, 150), "elbow": (-150, 0), "hip": (-120, 45), "shoulder": (-200, 110), "neck": (-40, 40),
          "ankle": (-70, 95)}


def norm(a):
    while a > 180:
        a -= 360
    while a <= -180:
        a += 360
    return a


def check_joints(name, J, face):
    """Knees and elbows only fold the way they do on a body: a knee back, an elbow forward."""
    for leg in ("leg_n", "leg_f"):
        h_, kn, an = J[leg][:3]
        flex = norm(ang(kn, an) - ang(h_, kn)) * face
        if not (LIMITS["knee"][0] - 4 <= flex <= LIMITS["knee"][1] + 4):
            raise SystemExit(f"{name}: {leg}'s knee folds {flex:.0f} degrees, outside {LIMITS['knee']}")
        an_, toe = J[leg][2], J[leg][3]
        ankle = norm(ang(an_, toe) - (ang(kn, an) - 90)) * face
        if not (LIMITS["ankle"][0] - 2 <= ankle <= LIMITS["ankle"][1] + 2):
            raise SystemExit(f"{name}: {leg}'s ankle is at {ankle:.0f} degrees, outside {LIMITS['ankle']}")
    torso = ang(J["pelvis"], J["chest"])
    for arm in ("arm_n", "arm_f"):
        sh, el, ha = J[arm]
        flex = norm(ang(el, ha) - ang(sh, el)) * face
        if not (LIMITS["elbow"][0] - 4 <= flex <= LIMITS["elbow"][1] + 4):
            raise SystemExit(f"{name}: {arm}'s elbow folds {flex:.0f} degrees, outside {LIMITS['elbow']}")
        shoulder = norm(ang(sh, el) - (torso + 180)) * face
        if not (LIMITS["shoulder"][0] - 2 <= shoulder <= LIMITS["shoulder"][1] + 2):
            raise SystemExit(f"{name}: {arm}'s shoulder is at {shoulder:.0f} degrees, outside {LIMITS['shoulder']}")


def check_arms(name, J, holding=()):
    """No hiker holds a straight arm raised in the open: that silhouette reads as a salute. An arm on a rope,
    a pole or a letter is holding something and is exempt only when the pose says what it holds."""
    for arm in ("arm_n", "arm_f"):
        if arm in holding:
            continue
        elbow, raised = elbow_and_raise(J, arm)
        if elbow >= 150 and 10 <= raised <= 70:
            raise SystemExit(f"{name}: {arm} is straight ({elbow}) and raised {raised} degrees; bend the elbow")


def figure_svg(name, pose, C, k=1.0):
    """One hiker as SVG, in two pieces: what is drawn behind the letters and what is drawn in front of them."""
    f = FIG
    J = figure(pose, k)
    check_arms(name, J, pose.get("holding", ()))
    face = pose.get("face", 1)
    check_joints(name, J, face)
    lean = pose.get("lean", 0.0)
    lw, tw, hr, g = f["limb_w"] * k, f["torso_w"] * k, f["head_r"] * k, f["gap"] * k
    col = pose.get("color", C["figure"])
    shade = pose.get("shade", C["shade"])
    packc = pose.get("pack_color", C["pack"])
    parts = []                                           # (label, kind, geometry, width, color), back to front
    if pose.get("legs", True):
        parts.append(("leg_f", "path", path_d(J["leg_f"]), lw, shade))
    parts.append(("arm_f", "path", path_d(J["arm_f"]), lw, shade))
    if pose.get("pack", True):
        pk = f["pack"]
        w, h, r = pk["w"] * k, pk["h"] * k, pk["r"] * k
        mx, my = (J["pelvis"][0] + J["chest"][0]) / 2, (J["pelvis"][1] + J["chest"][1]) / 2
        ca, sa = math.cos(math.radians(lean)), math.sin(math.radians(lean))
        off = -face * (tw / 2 + w / 2 - 1.6 * k)
        cx, cy = mx + off * ca + 1.0 * k * sa, my + off * sa - 1.0 * k * ca
        parts.append(("pack", "rect", (cx - w / 2, cy - h / 2, w, h, r, lean, cx, cy), 0, packc))
    parts.append(("torso", "path", path_d([J["pelvis"], J["chest"]]), tw, col))
    if pose.get("legs", True):
        parts.append(("leg_n", "path", path_d(J["leg_n"]), lw, col))
    parts.append(("head", "circle", (J["head"][0], J["head"][1], hr), 0, col))
    if "binoculars" in pose:
        (x0, y0), (x1, y1) = pose["binoculars"]
        parts.append(("binoculars", "path", path_d([(x0, y0), (x1, y1)]), 3.3 * k, packc))
    parts.append(("arm_n", "path", path_d(J["arm_n"]), lw, col))

    front_only = set(pose.get("front_parts", ()))
    behind = pose.get("layer", "front") == "behind"

    def draw(sel, knock=True):
        chosen = [p_ for p_ in parts if sel(p_[0])]
        if not chosen:
            return ""
        out = []
        if knock:                                        # the gap that lifts a hiker off whatever is behind
            out.append('<g data-layer="knockout">')
            for _l, kind, geo, w, _c in chosen:
                if kind == "path":
                    out.append(f'<path d="{geo}" stroke="{C["ground"]}" stroke-width="{w + 2 * g:.2f}" stroke-linecap="round" '
                               f'stroke-linejoin="round" fill="none"/>')
                elif kind == "circle":
                    out.append(f'<circle cx="{geo[0]:.2f}" cy="{geo[1]:.2f}" r="{geo[2] + g:.2f}" fill="{C["ground"]}"/>')
                else:
                    x, y, w_, h_, r, rot, cx, cy = geo
                    out.append(f'<rect x="{x - g:.2f}" y="{y - g:.2f}" width="{w_ + 2 * g:.2f}" height="{h_ + 2 * g:.2f}" '
                               f'rx="{r + g:.2f}" fill="{C["ground"]}" transform="rotate({rot:.1f} {cx:.2f} {cy:.2f})"/>')
            out.append("</g>")
        for label, kind, geo, w, c in chosen:
            if kind == "path":
                if label == "arm_n":                     # a rim, so an arm across the body still reads
                    out.append(f'<path d="{geo}" stroke="{shade}" stroke-width="{w + 1.5 * k:.2f}" stroke-linecap="round" '
                               f'stroke-linejoin="round" fill="none" data-limb="arm_n-rim"/>')
                out.append(f'<path data-limb="{label}" d="{geo}" stroke="{c}" stroke-width="{w:.2f}" stroke-linecap="round" '
                           f'stroke-linejoin="round" fill="none"/>')
            elif kind == "circle":
                out.append(f'<circle data-limb="head" cx="{geo[0]:.2f}" cy="{geo[1]:.2f}" r="{geo[2]:.2f}" fill="{c}"/>')
            else:
                x, y, w_, h_, r, rot, cx, cy = geo
                out.append(f'<rect data-limb="pack" x="{x:.2f}" y="{y:.2f}" width="{w_:.2f}" height="{h_:.2f}" '
                           f'rx="{r:.2f}" fill="{c}" transform="rotate({rot:.1f} {cx:.2f} {cy:.2f})"/>')
        return "\n".join(out)

    if behind:
        clip = f' clip-path="url(#{pose["clip"]})"' if pose.get("clip") else ""
        back = f'<g id="{name}-behind" data-figure="{name}"{clip}>' + draw(lambda l: l not in front_only, knock=False) + "</g>"
        front = f'<g id="{name}" data-figure="{name}">' + draw(lambda l: l in front_only) + "</g>"
    else:
        back = ""
        front = f'<g id="{name}" data-figure="{name}">' + draw(lambda l: True) + "</g>"

    rnd = lambda p_: [round(p_[0], 2), round(p_[1], 2)]
    bones = {"torso": ang(J["pelvis"], J["chest"]), "head": ang(J["chest"], J["head"])}
    for limb_, names in (("arm_n", ("upper_arm_n", "forearm_n")), ("arm_f", ("upper_arm_f", "forearm_f")),
                         ("leg_n", ("thigh_n", "shin_n", "foot_n")), ("leg_f", ("thigh_f", "shin_f", "foot_f"))):
        pts = J[limb_]
        for i, bn in enumerate(names):
            bones[bn] = ang(pts[i], pts[i + 1])
    near, far = ("r", "l") if face > 0 else ("l", "r")
    sd = {"n": near, "f": far}
    named = {"pelvis": rnd(J["pelvis"]), "chest": rnd(J["chest"]), "neck": rnd(J["chest"]), "head": rnd(J["head"])}
    for s_ in ("n", "f"):
        x = sd[s_]
        named.update({f"shoulder_{x}": rnd(J[f"arm_{s_}"][0]), f"elbow_{x}": rnd(J[f"arm_{s_}"][1]), f"hand_{x}": rnd(J[f"arm_{s_}"][2]),
                      f"hip_{x}": rnd(J[f"leg_{s_}"][0]), f"knee_{x}": rnd(J[f"leg_{s_}"][1]), f"ankle_{x}": rnd(J[f"leg_{s_}"][2]),
                      f"toe_{x}": rnd(J[f"leg_{s_}"][3])})
    limb_name = {"arm_n": f"hand_{near}", "arm_f": f"hand_{far}", "leg_n": f"ankle_{near}", "leg_f": f"ankle_{far}"}
    pins = {limb_name[l]: {"at": rnd(pose[l]["to"]), "to": pose.get("pinned_to", {}).get(l, ""),
                           "kind": "grip" if l.startswith("arm") else "contact"}
            for l in ("arm_n", "arm_f", "leg_n", "leg_f") if "to" in pose[l]}
    bones_lr = {}
    for bn, v in bones.items():
        bones_lr[bn[:-2] + "_" + sd[bn[-1]] if bn[-2:] in ("_n", "_f") else bn] = v
    data = {"name": name, "scale": k, "face": face, "near": near, "view": "side", "does": pose.get("does", ""),
            "pelvis": rnd(J["pelvis"]), "bone_angles": bones_lr, "joints_lr": named,
            "joints": {"pelvis": rnd(J["pelvis"]), "chest": rnd(J["chest"]), "head": rnd(J["head"]),
                       "elbow_n": rnd(J["arm_n"][1]), "hand_n": rnd(J["arm_n"][2]),
                       "elbow_f": rnd(J["arm_f"][1]), "hand_f": rnd(J["arm_f"][2]),
                       "knee_n": rnd(J["leg_n"][1]), "ankle_n": rnd(J["leg_n"][2]), "toe_n": rnd(J["leg_n"][3]),
                       "knee_f": rnd(J["leg_f"][1]), "ankle_f": rnd(J["leg_f"][2]), "toe_f": rnd(J["leg_f"][3])},
            "pins": pins,
            "layer": pose.get("layer", "front"), "clip": pose.get("clip"), "parts_in_front": sorted(front_only),
            "legs_drawn": pose.get("legs", True), "pack": pose.get("pack", True),
            "binoculars": [rnd(q) for q in pose["binoculars"]] if "binoculars" in pose else None,
            "arms": {a_: dict(zip(("elbow", "raised"), elbow_and_raise(J, a_))) for a_ in ("arm_n", "arm_f")},
            "holding": list(pose.get("holding", ()))}
    return back, front, data, J


def line_svg(name, pts, color, width, C, prop):
    d = path_d(pts)
    g = FIG["gap"]
    return (f'<g id="{name}" data-prop="{prop}"><path d="{d}" stroke="{C["ground"]}" stroke-width="{width + 2 * g:.2f}" '
            f'stroke-linecap="round" fill="none"/><path d="{d}" stroke="{color}" stroke-width="{width:.2f}" '
            f'stroke-linecap="round" fill="none"/></g>')


# ── colors ───────────────────────────────────────────────────────────────────────────────
PALETTES = {
    # Void first: the app's default dark ground.
    "void": {"ground": "#000000", "letter": "#f1efea", "figure": "#FF8A3D", "shade": "#D2611B", "pack": "#35C9B8",
             "rope": "#F2C27A"},
    "void-mono": {"ground": "#000000", "letter": "#f1efea", "figure": "#a7a49c", "shade": "#75726a", "pack": "#f7f6f2",
                  "rope": "#56544d"},
    "dusk": {"ground": "#182442", "letter": "#FFF5E1", "figure": "#FF8A3D", "shade": "#D2611B", "pack": "#35C9B8",
             "rope": "#F2C27A"},
    "sunrise": {"ground": "#F26A2E", "letter": "#FFF8EC", "figure": "#1B2748", "shade": "#0E1730", "pack": "#FFD25A",
                "rope": "#FFE7B8"},
    "ocean": {"ground": "#0F4C81", "letter": "#FFFFFF", "figure": "#FFC53D", "shade": "#D99A12", "pack": "#FF6B4A",
              "rope": "#BFE3FF"},
    "plum": {"ground": "#2B1B4D", "letter": "#FFF6E6", "figure": "#FFB23E", "shade": "#D4871A", "pack": "#FF7A9C",
             "rope": "#E9D2FF"},
    "paper": {"ground": "#FBF3E4", "letter": "#1B2748", "figure": "#F2702A", "shade": "#C4521A", "pack": "#1FA89A",
              "rope": "#B88A4A"},
}
# One color each, for the "friends" option: a colorblind-safe set (after Okabe and Ito), far limbs a shade down.
FRIENDS = [("#FF8A3D", "#D2611B"), ("#56B4E9", "#2F86BD"), ("#F0D43A", "#C2A51C"), ("#3DD6A3", "#1FA67A"),
           ("#F2A0C4", "#C96F99"), ("#B9A2FF", "#8C72DB")]


def letters_svg(letters, C):
    out = ['<g id="letters">']
    for L in letters.values():
        d = " ".join(path_d(s, closed=L.get("closed", False) and i == 0) for i, s in enumerate(L["segs"]))
        out.append(f'<path id="letter-{L["name"]}" d="{d}" stroke="{C["letter"]}" stroke-width="{STROKE}" '
                   f'stroke-linecap="round" stroke-linejoin="round" fill="none"/>')
    out.append("</g>")
    return "\n".join(out)


# ── what each hiker is doing ─────────────────────────────────────────────────────────────
def hips_over(px, feet, reach, frac=0.95):
    """The highest the pelvis can sit at px with every foot still within the leg's reach."""
    return max(f_[1] - math.sqrt(max(0.0, (frac * reach) ** 2 - (f_[0] - px) ** 2)) for f_ in feet)


def rappeller(W, k=1.0):
    """Climbing a rope looped over the W's left tip: one hand high, one low, a knee up, head back."""
    tip = W["nodes"][0]
    xr = tip[0] - H - 1.0
    chest = (xr - 7.6 * k, tip[1] + 35 * k)
    lean = -14
    up = (math.sin(math.radians(lean)), -math.cos(math.radians(lean)))
    hip = (chest[0] - FIG["torso"] * k * up[0], chest[1] - FIG["torso"] * k * up[1])
    pose = {"hip": hip, "face": 1, "lean": lean, "head": -20, "does": "climbing a rope looped over the W's tip",
            "arm_n": {"to": (xr, chest[1] - 12.2 * k), "bend": 1}, "arm_f": {"to": (xr, chest[1] - 5.5 * k), "bend": 1},
            "leg_n": {"a": (18, 104, 62)}, "leg_f": {"a": (98, 120, 62)}, "holding": ("arm_n", "arm_f"),
            "pinned_to": {"arm_n": "rope", "arm_f": "rope"}}
    loop = [pt(tip[0], tip[1], H + 1.0, a) for a in range(-55, -181, -9)]
    rope = loop + [(xr, tip[1] + 3), (xr, tip[1] + 60 * k)]
    return pose, rope


def flag_planter(W, ink, k=1.0):
    """Astride the W's middle peak, one hand on a flag planted beside it, the other on the hip."""
    px, py = W["nodes"][2]
    S = FIG["limb_w"] * k / 2
    fl, fr = ink.rest(px - 6.5 * k, S), ink.rest(px + 6.5 * k, S)
    reach = (FIG["thigh"] + FIG["shin"]) * k
    hip = (px, hips_over(px, (fl, fr), reach, 0.965))
    chest = (hip[0], hip[1] - FIG["torso"] * k)
    base_x = px + 12.5 * k
    base = (base_x, ink.top(base_x) + 1.0)
    top = (base_x + 1.2 * k, chest[1] - 19 * k)
    hand = (base_x + 0.35 * k, chest[1] - 1.5 * k)
    pose = {"hip": hip, "face": 1, "lean": 0, "head": 4, "does": "astride the W's middle peak, planting a flag",
            "arm_n": {"to": hand, "bend": 1}, "arm_f": {"a": (148, 42)},
            "leg_n": {"to": fr, "bend": -1, "foot": 38}, "leg_f": {"to": fl, "bend": -1, "foot": 126},
            "holding": ("arm_n",), "pinned_to": {"arm_n": "flag-pole", "leg_n": "W", "leg_f": "W"}}
    flag = [top, (top[0] + 13 * k, top[1] + 4.2 * k), (top[0] + 0.5 * k, top[1] + 8.4 * k)]
    return pose, [base, top], flag


def lookout(letter, x, ink, k=1.0):
    """Standing on a letter's top, leaning into a pair of binoculars held in both hands."""
    S = FIG["limb_w"] * k / 2
    back, front = ink.rest(x - 4.4 * k, S), ink.rest(x + 4.8 * k, S)
    reach = (FIG["thigh"] + FIG["shin"]) * k
    hip = (x - 0.4 * k, hips_over(x - 0.4 * k, (back, front), reach, 0.955))
    pose = {"hip": hip, "face": 1, "lean": 11, "head": -3, "does": f"on top of the {letter}, looking ahead through binoculars"}
    chest, head = place(pose, k)
    pose.update({"arm_n": {"to": (head[0] + 6.2 * k, head[1] + 1.1 * k), "bend": 1},
                 "arm_f": {"to": (head[0] + 8.6 * k, head[1] + 0.9 * k), "bend": 1},
                 "leg_n": {"to": front, "bend": -1, "foot": 8}, "leg_f": {"to": back, "bend": -1, "foot": -6},
                 "binoculars": ((head[0] + 4.4 * k, head[1] + 0.1 * k), (head[0] + 10.6 * k, head[1] - 0.6 * k)),
                 "holding": ("arm_n", "arm_f"),
                 "pinned_to": {"arm_n": "binoculars", "arm_f": "binoculars", "leg_n": letter, "leg_f": letter}})
    return pose


def window_hiker(P, k=1.0):
    """Behind the P, seen through its bowl as through a window: one forearm along the sill, the other hand waving."""
    cx, cy = P["c"]
    sill = cy + P["r"] - H
    chest = (cx + 2.6 * k, sill - 9.0 * k)
    hip = (chest[0], chest[1] + FIG["torso"] * k)
    return {"hip": hip, "face": 1, "lean": 0, "head": 9, "does": "behind the P, leaning on its bowl like a windowsill and waving",
            "arm_n": {"a": (134, 12)}, "arm_f": {"a": (-28, -80)},
            "leg_n": {"a": (88, 92, 0)}, "leg_f": {"a": (92, 96, 0)},
            "legs": False, "layer": "behind", "clip": "counter-P",
            "pinned_to": {"arm_n": "the P's sill"}}


def handstand(letter, x, ink, k=1.0):
    """A handstand on a letter's top: arms straight down to it, legs in the air, a little apart."""
    S = FIG["limb_w"] * k / 2
    hl, hr = ink.rest(x - 3.6 * k, S), ink.rest(x + 3.6 * k, S)
    arm = (FIG["upper_arm"] + FIG["forearm"]) * k
    chest = (x, min(hl[1], hr[1]) - math.sqrt((0.955 * arm) ** 2 - (3.6 * k) ** 2))
    lean = 174
    hip = (chest[0] - FIG["torso"] * k * math.sin(math.radians(lean)), chest[1] + FIG["torso"] * k * math.cos(math.radians(lean)))
    return {"hip": hip, "face": 1, "lean": lean, "head": 0, "does": f"doing a handstand on top of the {letter}",
            "arm_n": {"to": hr, "bend": 1}, "arm_f": {"to": hl, "bend": 1},
            "leg_n": {"a": (-68, -52, -56)}, "leg_f": {"a": (-120, -104, -150)},
            "holding": ("arm_n", "arm_f"), "pinned_to": {"arm_n": letter, "arm_f": letter}}


def ledge_sitter(G, k=1.0):
    """Sitting back on the G's bar, inside the letter: propped on both hands, one knee up, looking up."""
    S = FIG["limb_w"] * k / 2
    top = G["c"][1] - H
    x0 = G["c"][0] + 12.0 * k
    on = lambda x: (x, top - S)
    return {"hip": (x0, top - FIG["torso_w"] * k / 2), "face": 1, "lean": -28, "head": -8,
            "does": "sitting back on the G's bar, inside the letter, propped on both hands",
            "arm_n": {"to": on(x0 - 11.0 * k), "bend": 1}, "arm_f": {"to": on(x0 - 7.6 * k), "bend": 1},
            "leg_n": {"to": on(x0 + 10.2 * k), "bend": -1, "foot": -12}, "leg_f": {"to": on(x0 + 14.8 * k), "bend": -1, "foot": -4},
            "holding": ("arm_n", "arm_f"),
            "pinned_to": {"arm_n": "the G's bar", "arm_f": "the G's bar", "leg_n": "the G's bar", "leg_f": "the G's bar"}}


def cast(letters, ink, which):
    """The hikers and their props, in drawing order."""
    out = []
    W = letters["W"]
    if which == "small":
        k = 1.45
    else:
        k = 1.0 if which == "wordmark" else 1.15
        p, rope = rappeller(W, k)
        out += [("rope", "rope", rope), ("rappeller", "figure", p)]
    p, pole, flag = flag_planter(W, ink, k)
    out += [("flag-pole", "pole", pole), ("flag", "flag", flag), ("flag-planter", "figure", p)]
    if which == "wordmark":
        out += [("ledge-sitter", "figure", ledge_sitter(letters["G"], k))]
        out += [("window-hiker", "figure", window_hiker(letters["P"], k))]
        out += [("handstand", "figure", handstand("a", letters["a"]["c"][0] - 2.0, ink, k))]
        out += [("lookout", "figure", lookout("e2", letters["e2"]["c"][0] + 5.0, ink, k))]
    elif which == "icon":
        out += [("handstand", "figure", handstand("W", W["nodes"][4][0], ink, k))]
    return out, k


def draw_cast(items, C, k, friends=False):
    behind, front, data, i = [], [], [], 0
    g = FIG["gap"] * k
    for name, kind, spec in items:
        if kind == "figure":
            pose = dict(spec)
            if friends:
                pose["color"], pose["shade"] = FRIENDS[i % len(FRIENDS)]
            i += 1
            b_, f_, d, _ = figure_svg(name, pose, C, k)
            if b_:
                behind.append(b_)
            front.append(f_)
            data.append(d)
        elif kind == "flag":
            d = path_d(spec, closed=True)
            front.append(f'<g id="{name}" data-prop="flag"><path d="{d}" fill="{C["ground"]}" stroke="{C["ground"]}" '
                         f'stroke-width="{2 * g + 1.6 * k:.2f}" stroke-linejoin="round"/><path d="{d}" fill="{C["pack"]}" '
                         f'stroke="{C["pack"]}" stroke-width="{1.6 * k:.2f}" stroke-linejoin="round"/></g>')
            data.append({"name": name, "prop": "flag", "path": [[round(x, 2), round(y, 2)] for x, y in spec],
                         "layer": "front", "fixed_to": "the top of flag-pole"})
        else:
            w = FIG["rope_w"] if kind == "rope" else FIG["pole_w"]
            front.append(line_svg(name, spec, C["rope"], w * k, C, kind))
            data.append({"name": name, "prop": kind, "path": [[round(x, 2), round(y, 2)] for x, y in spec],
                         "layer": "front", "width": round(w * k, 2)})
    return "\n".join(behind), "\n".join(front), data


def counters(letters):
    """The closed holes in the letters. A hiker on the behind layer is seen through them."""
    out = []
    for name, L in letters.items():
        if name == "P":
            cx, cy = L["c"]
            ri = L["r"] - H
            x_in = L["x"] + STROKE
            out.append(("counter-P", [(x_in, cy - ri), (cx, cy - ri)] + arc_pts(cx, cy, ri, -90, 90, 40)[1:] + [(x_in, cy + ri)]))
        elif name in ("o", "a"):
            cx, cy = L["c"]
            out.append((f"counter-{name}", arc_pts(cx, cy, L["r"] - H, 0, 360, 64)[:-1]))
        elif name in ("e", "e2"):
            cx, cy = L["c"]
            ri = L["r"] - H
            a0 = math.degrees(math.asin(H / ri))
            out.append((f"counter-{name}", arc_pts(cx, cy, ri, -a0, -(180 - a0), 48)))
    return out


def surfaces(letters):
    """Edges a hiker stands on, sits on or holds, as lines from left to right (or top to bottom)."""
    W, G, P = letters["W"], letters["G"], letters["P"]
    a, b = W["nodes"][0], W["nodes"][1]
    L = math.hypot(b[0] - a[0], b[1] - a[1])
    n = (-(b[1] - a[1]) / L * -1, (b[0] - a[0]) / L * -1)   # the outer side of the W's first stroke: down and to the left
    n = (-abs(n[0]), abs(n[1]))
    sill = P["c"][1] + P["r"] - H
    bar = G["c"][1] - H
    rnd = lambda q: [round(q[0], 2), round(q[1], 2)]
    return {"W-left-flank": [rnd((a[0] + n[0] * H, a[1] + n[1] * H)), rnd((b[0] + n[0] * H, b[1] + n[1] * H))],
            "P-sill": [rnd((P["x"] + STROKE, sill)), rnd((P["c"][0], sill))],
            "G-bar-top": [rnd((G["c"][0] + 4.0, bar)), rnd((G["c"][0] + G["r"], bar))]}


def defs_svg(letters):
    cs = counters(letters)
    return "<defs>" + "".join(f'<clipPath id="{n}"><path d="{path_d(p_, closed=True)}"/></clipPath>' for n, p_ in cs) + "</defs>", cs


def build_wordmark(C, friends=False, pad=12.0):
    letters, width = lay_out()
    ink = Ink(letters)
    items, k = cast(letters, ink, "wordmark")
    behind, front, data = draw_cast(items, C, k, friends)
    defs, cs = defs_svg(letters)
    top = -(CAP + 28)
    vb = (-pad - 12, top, width + 2 * pad + 12, -top + pad)
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb[0]:.2f} {vb[1]:.2f} {vb[2]:.2f} {vb[3]:.2f}" role="img" '
           f'aria-label="WeGoPlace">{defs}<rect x="{vb[0]:.2f}" y="{vb[1]:.2f}" width="{vb[2]:.2f}" height="{vb[3]:.2f}" '
           f'fill="{C["ground"]}"/>\n<g id="behind">\n{behind}\n</g>\n{letters_svg(letters, C)}\n'
           f'<g id="front">\n{front}\n</g></svg>\n')
    return svg, data, letters, ink, width, cs


def build_icon(C, friends=False, size=1024, small=False):
    """The W and its hikers in a square. small: the W and the flag-planter alone, for 48 px and under."""
    letters, width = lay_out([("W", letter_W)])
    ink = Ink(letters)
    items, k = cast(letters, ink, "small" if small else "icon")
    behind, front, data = draw_cast(items, C, k, friends)
    y0, y1 = (-(CAP + 46.0), 2.0) if small else (-(CAP + 40.0), 2.0)
    s = size * (0.72 if small else 0.68) / width            # the W itself is centered; the hikers reach into the margin
    tx, ty = (size - width * s) / 2, (size - (y1 - y0) * s) / 2 - y0 * s
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" role="img" aria-label="WeGoPlace">'
           f'<rect width="{size}" height="{size}" fill="{C["ground"]}"/><g transform="translate({tx:.2f} {ty:.2f}) '
           f'scale({s:.4f})">{letters_svg(letters, C)}\n<g id="front">\n{front}\n</g></g></svg>\n')
    return svg, data


def png(svg_path, out_path, width):
    subprocess.run(["rsvg-convert", "-w", str(width), str(svg_path), "-o", str(out_path)], check=True)


def rig(C):
    """Everything an animation needs, as data: the skeleton, each station's pose, the props, the letters."""
    svg, data, letters, ink, width, cs = build_wordmark(C)
    _i, idata = build_icon(C)
    f = FIG
    rope_path = [tuple(q) for q in next(d["path"] for d in data if d.get("prop") == "rope")]
    xs = [x / 2 for x in range(0, int(width * 2) + 1)]
    sky, run = [], []
    for x in xs:
        t = ink.top(x)
        if t is None:
            if run:
                sky.append(run)
                run = []
        else:
            run.append([round(x, 2), round(t, 2)])
    if run:
        sky.append(run)
    return {
        "units": "capital height = 100, baseline y = 0, y grows downward",
        "angles": "degrees; 0 = pointing right, 90 = pointing down (clockwise on screen); every bone angle is absolute",
        "skeleton": {
            "root": "pelvis (x, y)",
            "bones": {
                "torso": {"from": "pelvis", "to": "chest", "length": f["torso"], "width": f["torso_w"]},
                "head": {"from": "chest", "length": round(f["head_r"] * 0.92, 3), "radius": f["head_r"],
                         "note": "a filled circle whose center is that far from the chest along the head's angle"},
                "upper_arm_n": {"from": "chest", "length": f["upper_arm"], "width": f["limb_w"]},
                "forearm_n": {"from": "elbow_n", "length": f["forearm"], "width": f["limb_w"]},
                "upper_arm_f": {"from": "chest", "length": f["upper_arm"], "width": f["limb_w"]},
                "forearm_f": {"from": "elbow_f", "length": f["forearm"], "width": f["limb_w"]},
                "thigh_n": {"from": "pelvis", "length": f["thigh"], "width": f["limb_w"]},
                "shin_n": {"from": "knee_n", "length": f["shin"], "width": f["limb_w"]},
                "foot_n": {"from": "ankle_n", "length": f["foot"], "width": f["limb_w"]},
                "thigh_f": {"from": "pelvis", "length": f["thigh"], "width": f["limb_w"]},
                "shin_f": {"from": "knee_f", "length": f["shin"], "width": f["limb_w"]},
                "foot_f": {"from": "ankle_f", "length": f["foot"], "width": f["limb_w"]},
            },
            "sides": "_n is the side nearer the viewer, _f the far side; a hiker facing left is the same skeleton mirrored in x",
            "caps": "every bone is a stroke with round caps and round joins; lengths never change",
            "draw_order": ["leg_f", "arm_f", "pack", "torso", "leg_n", "head", "binoculars", "arm_n"],
            "far_side_color": "the shade; the near arm also carries a 0.75-unit rim of the shade so it reads across the body",
            "knockout": {"gap": f["gap"], "note": "in front of a letter, every part is first drawn that much larger in the ground color"},
            "pack": {**f["pack"], "note": "a rounded rectangle on the back of the torso, turned with it"},
            "scale": "all lengths and widths times a figure's scale (1 in the wordmark, 1.15 in the icon)",
        },
        "views": "Every station is seen from the side and every hiker faces right (face = +1, near side = r). Nobody turns: "
                 "there is no yaw. hip_l = hip_r = pelvis and shoulder_l = shoulder_r = chest.",
        "rest_pose": {"note": "standing, arms down; the reference for retargeting and for limits",
                      "bone_angles": {"torso": -90, "head": -90, "upper_arm_r": 96, "forearm_r": 84, "upper_arm_l": 84,
                                      "forearm_l": 76, "thigh_r": 90, "shin_r": 92, "foot_r": 0, "thigh_l": 90, "shin_l": 92,
                                      "foot_l": 0}},
        "limits": {"note": "relative angles in degrees for a hiker facing right (child bone's angle minus its parent's, "
                           "wrapped to -180..180); mirror the sign for one facing left",
                   "knee (shin - thigh)": list(LIMITS["knee"]), "elbow (forearm - upper arm)": list(LIMITS["elbow"]),
                   "hip (thigh - (torso + 180))": list(LIMITS["hip"]), "shoulder (upper arm - (torso + 180))": list(LIMITS["shoulder"]),
                   "neck (head - torso)": list(LIMITS["neck"]), "ankle (foot - (shin - 90))": list(LIMITS["ankle"])},
        "one_build": "All hikers share one build and one scale in the wordmark, and every hiker always wears a pack.",
        "rule": "No straight arm is ever held raised in the open (elbow 150 or more with the hand 10 to 70 degrees above the "
                "shoulder), in any frame. An arm on a rope, a pole, binoculars or a letter is holding something.",
        "layers": {"order": "back to front: hikers on the behind layer, the letters, then every other hiker and every prop",
                   "ink": "a letter's ink is its centerline stroked at its stroke width with round caps and round joins; "
                          "its hull is that ink plus its closed counters",
                   "behind": "a hiker on the behind layer is hidden by ink and seen through counters and past the letters' "
                             "edges, unless clip names one counter (the P's window), which hides everything outside it; "
                             "anything behind that drops below the baseline (y > 0) is gone",
                   "per_part": "a part listed in parts_in_front is drawn on the front layer while the rest stays behind",
                   "the_fall": "the lookout on the last e tips over and moves to the behind layer: seen through the e's eye "
                               "on the way down, gone below the baseline"},
        "knockout": {"width": f["gap"], "how": "the stills paint the widened outline in the ground color; on any other "
                     "backdrop make it a mask that cuts the widened outline out of the letters and of hikers further back"},
        "props": {
            "rope": {"station": "rappeller", "thickness": f["rope_w"], "anchor": "looped over the W's left tip (the first 15 "
                     "points of its path are the loop), then hanging free", "length": round(sum(math.hypot(q[0] - p_[0], q[1] - p_[1])
                     for p_, q in zip(rope_path, rope_path[1:])), 2), "rest_shape": [[round(x, 2), round(y, 2)] for x, y in rope_path],
                     "kind": "station prop: it stays; the newcomer grabs its free end"},
            "flag": {"station": "flag-planter", "pole": "flag-pole (base on the W's flank, top where the cloth is tied)",
                     "cloth": "the three points of flag, tied along the pole's top 8.4 units", "pole_thickness": f["pole_w"],
                     "kind": "station prop: it stays planted; the next hiker takes the pole"},
            "binoculars": {"station": "lookout", "length": 6.24, "thickness": 3.3, "color": "pack",
                           "held": "from head + (4.4, 0.1) to head + (10.6, -0.6) for a hiker facing right, both hands on it",
                           "set_down": {"on": "the top of the last e", "center": [round(letters["e2"]["c"][0] - 9.0, 2),
                                        round(ink.top(letters["e2"]["c"][0] - 9.0) - 1.65, 2)], "angle": -14},
                           "kind": "station prop: set down before leaving, picked up by the next hiker"},
            "pack": {"kind": "carried: every hiker wears one always"},
        },
        "surfaces": surfaces(letters),
        "stations": {"order": [d["name"] for d in data if "prop" not in d],
                     "note": "left to right; in the advance each hiker takes the next station's pose, the last leaves, a new one "
                             "takes the first"},
        "wordmark": {"width": round(width, 2), "figures_and_props": data,
                     "letters": [{"name": L["name"], "x": round(L["x"], 2), "width": round(L["width"], 2),
                                  "stroke": STROKE, "centerline": [[[round(x, 2), round(y, 2)] for x, y in seg] for seg in L["segs"]]}
                                 for L in letters.values()],
                     "top_edge": sky, "gaps_after": GAPS,
                     "counters": [{"id": n, "outline": [[round(x, 2), round(y, 2)] for x, y in p_]} for n, p_ in cs]},
        "icon": {"figures_and_props": idata, "note": "the W alone, its hikers at scale 1.15, in the W's own units"},
        "colors": {k_: v for k_, v in C.items()},
    }


def main():
    OUT.mkdir(exist_ok=True)
    names = [a for a in sys.argv[1:] if not a.startswith("-")] or list(PALETTES)
    (OUT / "rig.json").write_text(json.dumps(rig(PALETTES[names[0]]), indent=1))
    for name in names:
        C = PALETTES[name]
        for friends in (False, True):
            tag = name + ("-friends" if friends else "")
            svg, data, letters, ink, width, cs = build_wordmark(C, friends)
            (OUT / f"wordmark-{tag}.svg").write_text(svg)
            png(OUT / f"wordmark-{tag}.svg", OUT / f"wordmark-{tag}.png", 1800)
            icon, idata = build_icon(C, friends)
            (OUT / f"icon-{tag}.svg").write_text(icon)
            for px in (512, 64):
                png(OUT / f"icon-{tag}.svg", OUT / f"icon-{tag}-{px}.png", px)
            small, _ = build_icon(C, friends, small=True)
            (OUT / f"icon-small-{tag}.svg").write_text(small)
            png(OUT / f"icon-small-{tag}.svg", OUT / f"icon-small-{tag}-32.png", 32)
    print("wrote", OUT)


# ── the site's files ─────────────────────────────────────────────────────────────────────────
# Void's colours behind the page's own variables, so one drawing serves every page and theme.
APP = {k: f"var(--logo-{'ground' if k == 'ground' else k}, {v})" for k, v in PALETTES["void"].items()}
REPO = HERE.parent


def _no_ground(svg):
    """The drawing without its ground rectangle: on a page, the page is the ground."""
    import re
    return re.sub(r'<rect (?:x="[^"]*" y="[^"]*" )?width="[^"]*" height="[^"]*" fill="var\(--logo-ground, [^)]*\)"/>', "", svg, count=1)


def _ico(pngs, out_path):
    """A .ico of PNG images (every browser since 2008 reads PNG entries), sizes from each file's header."""
    import struct
    blobs = [Path(q).read_bytes() for q in pngs]
    dims = [struct.unpack(">II", b[16:24]) for b in blobs]
    head = struct.pack("<HHH", 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    entries = b""
    for b, (w, h) in zip(blobs, dims):
        entries += struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(b), offset)
        offset += len(b)
    Path(out_path).write_bytes(head + entries + b"".join(blobs))


def write_site(pub):
    import tempfile
    for sub in ("img", "icons"):
        (pub / sub).mkdir(parents=True, exist_ok=True)
    (pub / "img" / "wordmark.svg").write_text(_no_ground(build_wordmark(APP)[0]))
    (pub / "img" / "mark.svg").write_text(_no_ground(build_icon(APP)[0]))
    import re
    svg, _data, _letters, _ink, _width, cs = build_wordmark(APP)
    vb = re.search(r'viewBox="([^"]+)"', svg).group(1)
    word = {"viewBox": vb, "letterStroke": STROKE,
            "letters": [{"id": i, "d": d} for i, d in re.findall(r'<path id="(letter-[^"]+)" d="([^"]+)"', svg)],
            "counters": [{"id": n, "outline": [[round(x, 2), round(y, 2)] for x, y in p_]} for n, p_ in cs]}
    (pub / "logo").mkdir(exist_ok=True)
    (pub / "logo" / "wordmark-data.json").write_text(json.dumps(word))
    icon, _ = build_icon(PALETTES["void"])
    (pub / "img" / "icon.svg").write_text(icon)
    for px in (512, 192, 180):
        png(pub / "img" / "icon.svg", pub / "icons" / f"icon-{px}.png", px)
    with tempfile.TemporaryDirectory() as tmp:
        small = Path(tmp) / "icon-small.svg"
        small.write_text(build_icon(PALETTES["void"], small=True)[0])
        sizes = []
        for px in (16, 32, 48):
            png(small, Path(tmp) / f"favicon-{px}.png", px)
            sizes.append(Path(tmp) / f"favicon-{px}.png")
        _ico(sizes, pub / "favicon.ico")
    print("wrote the site's wordmark, mark, icon, icons and favicon into", pub)


if __name__ == "__main__":
    if "--site" in sys.argv:
        i = sys.argv.index("--site")
        target = Path(sys.argv[i + 1]) if len(sys.argv) > i + 1 else REPO / "public"
        code = write_site(target)
        # Into the site itself: the icons under names made from their bytes, and every reference pointed at them
        # (tools/icon-names.mjs). Into another folder (a check comparing what this draws), only the files.
        if not code and target.resolve() == (REPO / "public").resolve():
            code = subprocess.run(["node", str(REPO / "tools" / "icon-names.mjs")], check=False).returncode
        sys.exit(code)
    sys.exit(main())
