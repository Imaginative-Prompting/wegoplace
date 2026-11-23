#!/usr/bin/env python3
"""Generate the PWA / home-screen icons into public/icons/ and public/favicon.ico.

Run:  python3 scripts/gen_icons.py     (needs Pillow; nothing at runtime needs it)

Why a generator and not a checked-in export: the icon is drawn from the same palette as
styles.css, so when --accent or --ground moves the icon moves with it instead of drifting
into a colour the app no longer uses.

The artwork is deliberately full-bleed. iOS masks apple-touch-icon into a squircle and
Android maskable crops to a circle, so a transparent or padded PNG shows a white/grey
corner ring on one platform or the other. Full bleed + content inside the maskable safe
circle (checked by assert below, not by eye) means ONE pair of files serves
purpose "any maskable" on both platforms.

Read at 32px too: the whole composition has to survive being a favicon, which is why it is
four flat shapes — sky, sun, dark ridge, cream peak — and not a detailed scene.
"""

import math
import os

from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")

# Palette lifted from public/styles.css. The sky is the app's owned hue (--accent #b3400e)
# shaded light-to-dark; the peak is light --ground; the sun is dark-theme --warn, which is
# the gold that stays separable from the sienna for a red-green colour-blind viewer — the
# same reason styles.css uses gold instead of red.
SKY_TOP = (211, 90, 23)
SKY_BOTTOM = (122, 40, 6)
SUN = (232, 180, 74)
RIDGE = (98, 30, 4)
PEAK = (246, 241, 232)
PEAK_SHADE = (217, 207, 188)
FORE = (58, 17, 2)

# Normalised coordinates (0..1, y down). Everything the eye needs — sun and the main apex —
# sits inside the maskable safe circle: centre (.5,.5), radius .4.
SUN_C, SUN_R = (0.660, 0.290), 0.105
BACK_RIDGE = [(0.32, 1.05), (0.665, 0.400), (1.05, 1.05)]
PEAK_APEX = (0.305, 0.300)
# Apex well left of the base midpoint on purpose: a symmetric triangle reads as a pyramid,
# and this is Peru, not Giza. The steep left face and long right ridge are the silhouette.
FRONT_PEAK = [(-0.05, 1.05), PEAK_APEX, (0.82, 1.05)]
FRONT_SHADE = [PEAK_APEX, (0.82, 1.05), (PEAK_APEX[0], 1.05)]
FOREGROUND = [(-0.05, 0.885), (0.26, 0.840), (0.56, 0.900), (0.84, 0.845), (1.05, 0.880),
              (1.05, 1.05), (-0.05, 1.05)]

SAFE_R = 0.40


def check_safe_zone():
    """Android's maskable crop keeps only the centre 80% circle. Assert rather than trust
    the eye: a decapitated peak only shows up on someone else's phone, after install."""
    def d(p):
        return math.hypot(p[0] - 0.5, p[1] - 0.5)
    assert d(SUN_C) + SUN_R <= SAFE_R, f"sun escapes the maskable safe circle: {d(SUN_C) + SUN_R:.3f}"
    assert d(PEAK_APEX) <= SAFE_R, f"peak apex escapes the maskable safe circle: {d(PEAK_APEX):.3f}"
    assert d(BACK_RIDGE[1]) <= SAFE_R, "back ridge apex escapes the maskable safe circle"


def draw(size):
    """Render the icon at `size` px. Drawn at 4x and downsampled because PIL's polygon
    fill is hard-edged; the supersample is what keeps the peak edge from stair-stepping."""
    ss = 4
    n = size * ss
    img = Image.new("RGB", (n, n), SKY_TOP)
    d = ImageDraw.Draw(img)

    # Vertical sky gradient, one row at a time. n is at most 2048 rows, so this is cheap
    # and avoids pulling in numpy for a nine-line lerp.
    for y in range(n):
        t = y / (n - 1)
        d.line([(0, y), (n, y)],
               fill=tuple(round(a + (b - a) * t) for a, b in zip(SKY_TOP, SKY_BOTTOM)))

    def px(p):
        return (p[0] * n, p[1] * n)

    cx, cy = px(SUN_C)
    r = SUN_R * n
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=SUN)

    d.polygon([px(p) for p in BACK_RIDGE], fill=RIDGE)
    d.polygon([px(p) for p in FRONT_PEAK], fill=PEAK)
    # The right face one step darker: at 512px it reads as a lit face and a shaded face,
    # at 32px it just reads as a peak. Both are the intended result.
    d.polygon([px(p) for p in FRONT_SHADE], fill=PEAK_SHADE)
    d.polygon([px(p) for p in FOREGROUND], fill=FORE)

    return img.resize((size, size), Image.LANCZOS)


def main():
    check_safe_zone()
    icons = os.path.join(OUT, "icons")
    os.makedirs(icons, exist_ok=True)

    for size in (192, 512):
        p = os.path.join(icons, f"icon-{size}.png")
        draw(size).save(p, "PNG", optimize=True)
        print(p, os.path.getsize(p), "bytes")

    # One .ico carrying 16/32/48 — Pillow renders all three from the largest supplied image,
    # so hand it a 48 rather than letting it squeeze a 512 down to 16 (mush).
    p = os.path.join(OUT, "favicon.ico")
    draw(48).save(p, "ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    print(p, os.path.getsize(p), "bytes")


if __name__ == "__main__":
    main()
