# -*- coding: utf-8 -*-
"""
从最底层里把尾巴切出来。

两个关键设计（都是踩过坑才定下来的）：

1. 尾巴必须是**完整**的一团毛。第一版沿手臂挖了个缺口，结果尾巴一旋转，
   那个手臂形状的空洞就跟着转，在 -8° 时变成一道黑带。
   所以手臂遮住的部分用左侧绒毛平移过来补上。

2. 身体层必须**保留手臂**。第二版把多边形整块从身体里扣掉，连手臂一起删了，
   于是尾巴转开的地方露出黑色背景。现在只扣掉绒毛，手臂原样留下。

绘制顺序：尾巴在身体**后面**。静止时被手臂挡住，摆动时从手臂后面探出来 —— 这才是狐尾该有的样子。
"""
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import os

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CH = os.path.join(PROJ, "assets", "character")
src = os.path.join(CH, "layers", "01.png")

POLY = [
    (0, 352), (55, 348), (115, 356), (160, 368), (190, 380), (205, 395),
    (206, 420), (204, 450), (200, 480), (196, 510), (190, 545), (182, 580),
    (172, 615), (158, 650), (142, 685), (124, 720), (104, 755), (84, 788),
    (62, 820), (40, 850), (20, 878), (8, 900), (0, 910),
]

im = Image.open(src).convert("RGBA")
w, h = im.size
px = im.load()

poly = Image.new("L", (w, h), 0)
ImageDraw.Draw(poly).polygon(POLY, fill=255)


def is_skin(r, g, b, a):
    """皮肤：偏红、偏亮。实测手臂像素约 (183,167,165)，差值只有 18/16，
    所以阈值必须放宽，不然一个都抓不到。"""
    return a > 40 and r > 120 and (r - b) > 12 and (r - g) > 8


def is_ribbon(r, g, b, a):
    return a > 40 and r > 100 and g < 80 and b < 80


# ---- 1. 找出多边形里的"外来物"（手臂、红丝带） ----
foreign = Image.new("L", (w, h), 0)
fp = foreign.load()
n_foreign = 0
for y in range(340, 930):
    for x in range(0, 206):
        if poly.getpixel((x, y)) < 128:
            continue
        r, g, b, a = px[x, y]
        if is_skin(r, g, b, a) or is_ribbon(r, g, b, a):
            fp[x, y] = 255
            n_foreign += 1

# 稍微扩张一点，避免留下皮肤色的描边
foreign = foreign.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(1))

# ---- 2. 尾巴 = 多边形整体，外来物用左侧绒毛填补 ----
tail = im.copy()
tp = tail.load()
patched = 0
for y in range(340, 930):
    for x in range(206):
        if foreign.getpixel((x, y)) < 96:
            continue
        done = False
        for shift in (38, 52, 26, 64, 78, 92):   # 由近到远找一段干净的毛
            sx = x - shift
            if sx < 0:
                continue
            sr, sg, sb, sa = px[sx, y]
            if sa < 48 or is_skin(sr, sg, sb, sa) or is_ribbon(sr, sg, sb, sa):
                continue
            if poly.getpixel((sx, y)) < 128:
                continue
            tp[x, y] = (sr, sg, sb, 255)
            patched += 1
            done = True
            break
        if not done:
            # 横向都取不到，就上下找一行
            for dy in (-40, 40, -70, 70):
                sy = y + dy
                if sy < 0 or sy >= h:
                    continue
                sr, sg, sb, sa = px[x, sy]
                if sa < 48 or is_skin(sr, sg, sb, sa) or is_ribbon(sr, sg, sb, sa):
                    continue
                tp[x, y] = (sr, sg, sb, 255)
                patched += 1
                done = True
                break
        if not done:
            tp[x, y] = (0, 0, 0, 0)

tail_alpha = ImageChops.multiply(tail.getchannel("A"), poly)

# ---- 3. 身体 = 原图减去"绒毛的外环"，但保留手臂和一小片衬底 ----
# 为什么要留衬底：尾巴一转，身体上被挖掉的那片就露出来了。
# 如果连衬底一起挖掉，转开的地方就是黑洞（这也是 -8° 那道斜黑带的真正原因）。
fur_only = ImageChops.subtract(poly, foreign).filter(ImageFilter.GaussianBlur(2))
backing = fur_only.filter(ImageFilter.MinFilter(31))   # 内缩约 15px 的衬底
remove = ImageChops.subtract(fur_only, backing)        # 只去掉外环
keep = ImageChops.invert(remove)
body = im.copy()
body.putalpha(ImageChops.multiply(im.getchannel("A"), keep))

tail.putalpha(tail_alpha)
tail.save(os.path.join(CH, "layers", "tail.png"))
body.save(os.path.join(CH, "layers", "01_body.png"))

print("外来物像素:", n_foreign, " 填补:", patched)
print("tail 像素:", sum(1 for p in tail.getchannel("A").get_flattened_data() if p > 8))
print("body 像素:", sum(1 for p in body.getchannel("A").get_flattened_data() if p > 8))
