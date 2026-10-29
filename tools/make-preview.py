"""
把几个状态的透明截图拼成一张预览图，用来一眼看完整套状态切换。
用法: python tools/make-preview.py snapshots/final preview.png
"""
import sys
import os
from PIL import Image, ImageDraw, ImageFont

src = sys.argv[1] if len(sys.argv) > 1 else "snapshots/final"
out = sys.argv[2] if len(sys.argv) > 2 else "preview.png"

states = [
    ("idle", "待机 · 呼吸 + 眨眼"),
    ("listening", "按住 Alt · 歪头在听"),
    ("thinking", "思考 · 身体微颤"),
    ("speaking", "开口 · 气泡逐字"),
]

imgs = []
for key, label in states:
    p = os.path.join(src, f"{key}.png")
    if os.path.exists(p):
        imgs.append((Image.open(p).convert("RGBA"), label))

if not imgs:
    raise SystemExit("no snapshots found in " + src)

W, H = imgs[0][0].size
MARGIN, GAP, LABEL_H = 30, 14, 52

cw = MARGIN * 2 + W * len(imgs) + GAP * (len(imgs) - 1)
ch = MARGIN * 2 + H + LABEL_H

# 竖向渐变底：从深蓝到近黑，像一张深夜桌面
bg = Image.new("RGB", (cw, ch))
d = ImageDraw.Draw(bg)
for y in range(ch):
    t = y / max(1, ch - 1)
    r = int(22 + 8 * (1 - t))
    g = int(29 + 10 * (1 - t))
    b = int(42 + 22 * (1 - t))
    d.line([(0, y), (cw, y)], fill=(r, g, b))

font = None
for cand in [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhl.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]:
    if os.path.exists(cand):
        try:
            font = ImageFont.truetype(cand, 17)
            break
        except OSError:
            pass
if font is None:
    font = ImageFont.load_default()

x = MARGIN
for img, label in imgs:
    bg.paste(img, (x, MARGIN), img)
    tw = d.textlength(label, font=font)
    d.text((x + (W - tw) / 2, MARGIN + H + 14), label, font=font, fill=(200, 214, 235))
    x += W + GAP

bg.save(out)
print("wrote", out, bg.size)
