# -*- coding: utf-8 -*-
"""给某一层叠加坐标网格，用来肉眼定位尾巴边界"""
from PIL import Image, ImageDraw
import sys, os

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(PROJ, "assets", "character", "layers", "01.png")
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(PROJ, "work", "grid01.png")
step = int(sys.argv[3]) if len(sys.argv) > 3 else 50

im = Image.open(src).convert("RGBA")
w, h = im.size

bg = Image.new("RGBA", (w, h), (40, 44, 56, 255))
bg.alpha_composite(im)

d = ImageDraw.Draw(bg)
for x in range(0, w, step):
    major = (x % (step * 2) == 0)
    d.line([(x, 0), (x, h)], fill=(90, 200, 120, 120) if major else (70, 80, 100, 90), width=1)
    if major:
        d.text((x + 2, 2), str(x), fill=(150, 255, 180, 255))
for y in range(0, h, step):
    major = (y % (step * 2) == 0)
    d.line([(0, y), (w, y)], fill=(90, 200, 120, 120) if major else (70, 80, 100, 90), width=1)
    if major:
        d.text((2, y + 1), str(y), fill=(150, 255, 180, 255))

os.makedirs(os.path.dirname(out), exist_ok=True)
bg.convert("RGB").save(out)
print("saved", out, w, "x", h)
