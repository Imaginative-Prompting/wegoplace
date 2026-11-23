"""The bake-off's import fixtures, made from the made-up planning document (tools/bakeoff/documents/amsterdam-draft.md):
a text PDF (read by toMarkdown) and a photo of the printed page (read by the site's model). Nothing in them is real
but the public places the document names. Deterministic: the same bytes every run (fixed seed, fixed dates), on macOS
(its Arial; reportlab 5.1 and Pillow 13). Made again only with tools/assistant-bakeoff.mjs FIXTURES' hashes changed too:

  python3 -I tools/bakeoff/make_import_fixtures.py tools/bakeoff/documents/amsterdam-draft.md tools/bakeoff/documents
"""
import random, sys
from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from PIL import Image, ImageDraw, ImageFont, ImageFilter

src, out = Path(sys.argv[1]), Path(sys.argv[2])
lines = src.read_text(encoding="utf-8").splitlines()

# The PDF: the document's lines as typed, one page, an invariant creation date so the bytes don't change.
pdfmetrics.registerFont(TTFont("Arial", "/System/Library/Fonts/Supplemental/Arial.ttf"))
pdf = out / "amsterdam-draft.pdf"
c = canvas.Canvas(str(pdf), pagesize=A4, invariant=1)
c.setTitle("AMS long wknd (draft 3)"); c.setAuthor("A. Example"); c.setSubject("")
w, h = A4
y = h - 60
for line in lines:
    size = 15 if line.startswith("# ") else 12.5 if line.startswith("## ") else 10.5
    c.setFont("Arial", size)
    text = line.lstrip("# ").replace("—", "-")
    # Wrap long lines at the page's width.
    words, row = text.split(" "), ""
    for word in words:
        trial = (row + " " + word).strip()
        if pdfmetrics.stringWidth(trial, "Arial", size) > w - 100:
            c.drawString(50, y, row); y -= size * 1.45; row = word
        else:
            row = trial
    c.drawString(50, y, row)
    y -= size * (1.9 if line.startswith("#") else 1.45)
c.showPage(); c.save()

# The photo: the printed page photographed a little crooked, on a grey desk, with paper grain and a soft blur.
rnd = random.Random(20261120)
W, H = 1240, 1754
page = Image.new("L", (W, H), 246)
d = ImageDraw.Draw(page)
regular = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 30)
big = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 44)
y = 110
for line in lines:
    f = big if line.startswith("#") else regular
    text = line.lstrip("# ")
    row = ""
    for word in text.split(" "):
        trial = (row + " " + word).strip()
        if d.textlength(trial, font=f) > W - 200:
            d.text((100, y), row, fill=28, font=f); y += 44; row = word
        else:
            row = trial
    d.text((100, y), row, fill=28, font=f)
    y += 62 if line.startswith("#") else 44
for _ in range(9000):  # paper grain
    x, yy = rnd.randrange(W), rnd.randrange(H)
    d.point((x, yy), fill=rnd.randrange(215, 250))
desk = Image.new("L", (1500, 2000), 118)
desk.paste(page.rotate(2.2, resample=Image.BICUBIC, expand=True, fillcolor=118), (90, 70))
photo = desk.filter(ImageFilter.GaussianBlur(0.9)).convert("RGB")
photo.save(out / "amsterdam-draft-photo.jpg", quality=82, optimize=True)
print("made", pdf.stat().st_size, (out / "amsterdam-draft-photo.jpg").stat().st_size)
