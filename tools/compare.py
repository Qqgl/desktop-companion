"""把几张抠好的图并排放在棋盘格上，同一高度，方便比较边缘质量。"""
import sys
from PIL import Image, ImageDraw, ImageFont

paths = sys.argv[2:]
out = sys.argv[1]

H = 560
imgs = []
for p in paths:
    im = Image.open(p).convert("RGBA")
    s = H / im.height
    im = im.resize((max(1, int(im.width * s)), H), Image.Resampling.LANCZOS)
    imgs.append((im, p.split("\\")[-1]))

gap = 16
pad = 18
W = sum(i.width for i, _ in imgs) + gap * (len(imgs) - 1) + pad * 2
canvas = Image.new("RGB", (W, H + pad * 2 + 26), (24, 30, 42))
d = ImageDraw.Draw(canvas)

font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 15)

x = pad
for im, name in imgs:
    # 棋盘格
    S = 12
    tile = Image.new("RGBA", im.size, (0, 0, 0, 0))
    td = ImageDraw.Draw(tile)
    for y in range(0, im.height, S):
        for xx in range(0, im.width, S):
            c = (226, 232, 240, 255) if ((xx // S) + (y // S)) % 2 == 0 else (196, 205, 218, 255)
            td.rectangle([xx, y, xx + S - 1, y + S - 1], fill=c)
    tile.alpha_composite(im)
    canvas.paste(tile.convert("RGB"), (x, pad))
    d.text((x + 2, pad + H + 4), name, font=font, fill=(190, 205, 225))
    x += im.width + gap

canvas.save(out)
print("wrote", out, canvas.size)
