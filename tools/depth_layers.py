"""
按深度把立绘切成若干层，用来做真正的 2.5D 视差。

流程：
  1. Depth Anything V2 (ONNX) 出深度图
  2. 只在角色内部归一化（透明区域不参与）
  3. 按深度分位切成 N 层（每层像素数差不多）
  4. 每层 alpha 向外膨胀一点 —— 视差移动时相邻层会错开，不膨胀就会露出缝
  5. 导出同尺寸 RGBA + manifest.json（直接用 app 里的 LayeredCharacter）

  python -u tools/depth_layers.py 输入抠图.png 输出目录 [层数]
"""
import json
import os
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageChops, ImageFilter
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = lambda *a: print(*a, flush=True)

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def find_depth_model():
    for c in [
        os.path.join(ROOT, "..", ".depth-models", "depth-v2-small.onnx"),
        os.path.join(ROOT, ".depth-models", "depth-v2-small.onnx"),
    ]:
        if os.path.exists(c):
            return os.path.abspath(c)
    raise SystemExit("找不到深度模型，先跑 tools/dl.js 下载")


def load_sess():
    so = ort.SessionOptions()
    so.intra_op_num_threads = max(2, (os.cpu_count() or 4) // 2)
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    s = ort.InferenceSession(find_depth_model(), sess_options=so, providers=["CPUExecutionProvider"])
    shape = s.get_inputs()[0].shape
    P(f"[depth] 输入 {shape}")
    return s, s.get_inputs()[0].name


def infer_depth(sess, name, rgb):
    """rgb: PIL RGB。返回与输入同尺寸的 float32 深度（越大越近）"""
    w, h = rgb.size
    # 保持长宽比，边长取 14 的倍数（这个模型要求）
    th = 518
    tw = int(round(w * th / h))
    tw = max(14, (tw // 14) * 14)
    inp = rgb.resize((tw, th), Image.Resampling.BICUBIC)
    a = np.asarray(inp, dtype=np.float32) / 255.0
    a = (a - MEAN) / STD
    a = a.transpose(2, 0, 1)[None, ...].astype(np.float32)

    # 模型若是固定尺寸，就退回 518x518
    t = time.time()
    try:
        out = sess.run(None, {name: a})[0]
    except Exception as e:
        P(f"    动态尺寸失败({e}), 退回 518x518")
        inp = rgb.resize((518, 518), Image.Resampling.BICUBIC)
        a = np.asarray(inp, dtype=np.float32) / 255.0
        a = ((a - MEAN) / STD).transpose(2, 0, 1)[None, ...].astype(np.float32)
        out = sess.run(None, {name: a})[0]
    P(f"[depth] 推理 {time.time()-t:.2f}s, 输出 {out.shape}")

    d = np.squeeze(out).astype(np.float32)
    # cv2 装不上（numpy 2.x 与 cv2 4.8 的 ABI 打架），用 PIL 的浮点模式重采样
    d = np.asarray(Image.fromarray(d, mode="F").resize((w, h), Image.Resampling.BICUBIC))
    return d


def main():
    src = sys.argv[1]
    outdir = sys.argv[2]
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 6

    t0 = time.time()
    im = Image.open(src).convert("RGBA")

    # 统一缩到高 1100，够 2x 屏显示，也能让图层文件小一点
    target_h = 1100
    if im.height > target_h:
        w = int(round(im.width * target_h / im.height))
        im = im.resize((w, target_h), Image.Resampling.LANCZOS)
    P(f"[size] {im.size}")

    rgb = Image.new("RGB", im.size, (128, 128, 128))
    rgb.paste(im, (0, 0), im)

    sess, name = load_sess()
    depth = infer_depth(sess, name, rgb)

    alpha = np.asarray(im.split()[-1], dtype=np.float32) / 255.0
    mask = alpha > 0.35
    if mask.sum() < 1000:
        raise SystemExit("前景太小，检查抠图")

    # 只看角色内部的深度分布，用 2%~98% 分位拉伸，避免极值把整张图压扁
    vals = depth[mask]
    lo, hi = np.percentile(vals, 2), np.percentile(vals, 98)
    dn = np.clip((depth - lo) / max(hi - lo, 1e-6), 0, 1)
    P(f"[depth] 角色内范围 {lo:.2f}~{hi:.2f}")

    # 分位切层：每层像素数接近，避免某层只有几百个像素
    edges = np.quantile(dn[mask], np.linspace(0, 1, n + 1))
    edges[0], edges[-1] = -1e9, 1e9
    P(f"[layers] {n} 层, 边界 {np.round(edges[1:-1], 3).tolist()}")

    os.makedirs(outdir, exist_ok=True)
    rgba = np.asarray(im, dtype=np.uint8)
    R = 14  # 膨胀半径（像素），要盖住最大视差位移

    manifest_layers = []
    for k in range(n):
        band = mask & (dn >= edges[k]) & (dn < edges[k + 1])
        if band.sum() < 200:
            P(f"    band {k}: 太小, 跳过")
            continue

        # 膨胀只为了「视差移动时相邻层不露缝」。
        # 注意必须用硬边（不羽化）＋乘以原始 alpha：
        # 如果用羽化的 mask 去截 alpha，几层半透明叠在一起会变成一层灰雾。
        d = ndimage.maximum_filter(band.astype(np.uint8), size=2 * R + 1)
        a = (rgba[:, :, 3].astype(np.float32) * (d > 0)).astype(np.uint8)

        layer = rgba.copy()
        layer[:, :, 3] = a
        fn = f"{k + 1:02d}.png"
        Image.fromarray(layer, "RGBA").save(os.path.join(outdir, fn))

        # 越近的层视差越大：最远 0.12，最近 1.15
        par = 0.12 + (1.03 * k / max(1, n - 1))

        # 越远的层越"软"：给它挂一点弹簧滞后。
        # 尾巴和外侧头发都在最远的几层里，这样头一转，它们会慢半拍跟上。
        # 头顶和胸口（最近层）保持 0 —— 那些地方一晃就假。
        sway = round(max(0.0, 1.25 * (1 - k / max(1, n - 1)) - 0.15), 3)

        manifest_layers.append({
            "file": f"{os.path.basename(outdir)}/{fn}",
            "parallax": round(par, 3),
            "sway": sway,
            "tilt": 0.0,
            "_fill": int(band.sum()),
        })
        P(f"    band {k}: {band.sum():>7} px, parallax={par:.2f}, sway={sway:.2f}")

    # 一层柔和的投影垫在最底下：浅色壁纸上没这个，白头发会糊成一片
    sh = Image.fromarray((alpha * 255).astype(np.uint8), "L")
    sh = sh.filter(ImageFilter.GaussianBlur(16))
    # 注意不能用 ImageChops.offset：它会环绕，把画布底部的身体卷到头顶，出现一条横线
    shifted = Image.new("L", im.size, 0)
    shifted.paste(sh, (2, 9))
    sa = (np.asarray(shifted, dtype=np.float32) * 0.5).astype(np.uint8)
    shadow = np.zeros((im.height, im.width, 4), np.uint8)
    shadow[:, :, 0], shadow[:, :, 1], shadow[:, :, 2] = 8, 12, 20
    shadow[:, :, 3] = sa
    Image.fromarray(shadow, "RGBA").save(os.path.join(outdir, "00_shadow.png"))
    manifest_layers.insert(0, {"file": f"{os.path.basename(outdir)}/00_shadow.png",
                               "parallax": 0.0, "sway": 0.0, "tilt": 0.0})

    for L in manifest_layers:
        L.pop("_fill", None)

    manifest = {
        "canvas": {"width": im.width, "height": im.height},
        "fit": {"height": 424, "bottom": 630},
        "shadow": False,     # 半身像脚下没有地面，别画那圈影子
        "layers": manifest_layers,
    }
    # manifest 放在 assets/character/ 下（上一层），file 里已经带了 layers/ 前缀
    mpath = os.path.join(os.path.dirname(os.path.abspath(outdir)), "manifest.json")
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    P(f"[manifest] {mpath}")

    # 调试图：每层一种颜色
    dbg = np.zeros((im.height, im.width, 3), dtype=np.uint8)
    palette = [
        (70, 80, 110), (90, 130, 190), (110, 170, 150),
        (200, 160, 90), (220, 120, 110), (240, 200, 150),
        (180, 140, 210), (140, 200, 220),
    ]
    bands = []
    for k in range(n):
        bands.append(mask & (dn >= edges[k]) & (dn < edges[k + 1]))
    for k, b in enumerate(bands):
        dbg[b] = palette[k % len(palette)]
    Image.fromarray(dbg).save(os.path.join(outdir, "_bands.png"))

    # 深度图
    dv = (dn * 255).astype(np.uint8)
    dv[~mask] = 0
    Image.fromarray(dv, "L").save(os.path.join(outdir, "_depth.png"))

    P(f"[done] {time.time()-t0:.1f}s -> {outdir}")


if __name__ == "__main__":
    main()
