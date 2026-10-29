"""
把 gen-icons.js 生成的多尺寸 PNG 打包成一个 .ico。
  python tools/make_ico.py
"""
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")

sizes = [16, 24, 32, 48, 64, 128, 256]
imgs = []
for s in sizes:
    p = os.path.join(ASSETS, f"icon-{s}.png")
    if not os.path.exists(p):
        print("缺少", p, "先跑 node tools/gen-icons.js")
        sys.exit(1)
    imgs.append(Image.open(p).convert("RGBA"))

out = os.path.join(ASSETS, "icon.ico")
# PIL 会自动把 sizes 里的每张写进 ico
imgs[-1].save(out, format="ICO", sizes=[(i.width, i.height) for i in imgs])
print("wrote", out, os.path.getsize(out), "bytes")

# 生成完后把中间 PNG 删掉，只留 .ico
for s in sizes:
    os.remove(os.path.join(ASSETS, f"icon-{s}.png"))
print("cleaned intermediate pngs")
