# -*- coding: utf-8 -*-
"""
把尾巴绕支点旋转几个角度，和身体合成，检查掩膜是否露馅。

这一步比看遮罩本身可靠：掩膜边缘差几像素肉眼很难判断，
但一旦旋转起来，多带的袖口会甩出去、少带的部分会露出空隙。
"""
from PIL import Image
import os

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CH = os.path.join(PROJ, "assets", "character")

body = Image.open(os.path.join(CH, "layers", "01_body.png")).convert("RGBA")
tail = Image.open(os.path.join(CH, "layers", "tail.png")).convert("RGBA")

# 尾巴与身体连接处：手肘内侧、肩甲下方
PIVOT = (205, 480)


def rotate_about(img, deg, pivot):
    """绕 pivot 旋转，保持画布尺寸"""
    return img.rotate(deg, resample=Image.BICUBIC, center=pivot)


def compose(deg):
    out = Image.new("RGBA", body.size, (0, 0, 0, 0))
    # 尾巴在身体后面：静止时被手臂挡住
    out.alpha_composite(rotate_about(tail, deg, PIVOT))
    out.alpha_composite(body)
    return out


BOX = (0, 300, 340, 960)
frames = [-8, 0, 8]
w = BOX[2] - BOX[0]
h = BOX[3] - BOX[1]

canvas = Image.new("RGBA", (w * len(frames) + 12 * (len(frames) - 1), h), (40, 44, 56, 255))
for i, deg in enumerate(frames):
    fr = compose(deg).crop(BOX)
    canvas.alpha_composite(fr, (i * (w + 12), 0))
    from PIL import ImageDraw
    ImageDraw.Draw(canvas).text((i * (w + 12) + 6, 6), f"{deg:+d}deg", fill=(120, 255, 160, 255))

# 支点标记
from PIL import ImageDraw
d = ImageDraw.Draw(canvas)
for i in range(len(frames)):
    px = i * (w + 12) + (PIVOT[0] - BOX[0])
    py = PIVOT[1] - BOX[1]
    d.ellipse([px - 3, py - 3, px + 3, py + 3], fill=(255, 210, 60, 255))

os.makedirs(os.path.join(PROJ, "work"), exist_ok=True)
canvas.convert("RGB").save(os.path.join(PROJ, "work", "tail_rotate_test.png"))
print("pivot", PIVOT, "->", os.path.join("work", "tail_rotate_test.png"))
