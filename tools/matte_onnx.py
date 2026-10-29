"""
直接跑 ONNX 的抠图（绕开 rembg：它的 import 链在这台机器上要 4 分钟以上）

预处理完全照 rembg 的 DisSession 复刻：
  缩放 1024x1024 → 除以该图最大像素值 → 减 mean (0.485,0.456,0.406) → CHW → float32
输出取第 0 通道，min-max 归一化回 0..255，再缩回原尺寸。

  python -u tools/matte_onnx.py 输入.png 输出.png
"""
import os
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)


def find_model():
    cands = [
        os.environ.get("U2NET_HOME") and os.path.join(os.environ["U2NET_HOME"], "isnet-anime.onnx"),
        os.path.join(ROOT, "..", ".rembg-models", "isnet-anime.onnx"),
        os.path.join(ROOT, ".rembg-models", "isnet-anime.onnx"),
    ]
    for c in cands:
        if c and os.path.exists(c):
            return os.path.abspath(c)
    raise SystemExit("找不到 isnet-anime.onnx，先跑 tools/dl.js 下载")


MODEL = find_model()

P = lambda *a: print(*a, flush=True)


def load_session():
    t = time.time()
    so = ort.SessionOptions()
    so.intra_op_num_threads = max(2, (os.cpu_count() or 4) // 2)
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess = ort.InferenceSession(MODEL, sess_options=so, providers=["CPUExecutionProvider"])
    P(f"[model] 加载 {time.time()-t:.2f}s, 输入名={sess.get_inputs()[0].name}, 尺寸={sess.get_inputs()[0].shape}")
    return sess


def matte(sess, img, size=1024):
    t = time.time()
    im = img.convert("RGB").resize((size, size), Image.Resampling.LANCZOS)
    a = np.asarray(im, dtype=np.float32)
    a = a / max(float(a.max()), 1e-6)          # rembg 的怪癖：按最大像素值归一，不是 255
    a = (a - MEAN) / 1.0
    a = a.transpose(2, 0, 1)[None, ...]

    out = sess.run(None, {sess.get_inputs()[0].name: a})[0]
    pred = out[:, 0, :, :]
    mi, ma = float(pred.min()), float(pred.max())
    pred = (pred - mi) / (ma - mi + 1e-6)
    P(f"[infer] {time.time()-t:.2f}s")

    mask = Image.fromarray((pred[0] * 255).astype(np.uint8), "L")
    mask = mask.resize(img.size, Image.Resampling.LANCZOS)
    return mask


def refine(mask, feather=0.7, gamma=1.7):
    """
    细一点：
    - gamma 压掉背景上那层半透明的灰雾（ISNet 在虚化背景上的通病）
    - 抹掉零星噪点，边缘轻微羽化，避免毛发边缘出现硬锯齿
    """
    arr = np.asarray(mask, dtype=np.float32) / 255.0
    arr = np.power(np.clip(arr, 0, 1), gamma) * 255.0
    arr[arr < 12] = 0.0
    arr[arr > 248] = 255.0
    m = Image.fromarray(arr.astype(np.uint8), "L")
    if feather:
        m = m.filter(ImageFilter.GaussianBlur(feather))
    return m


def main():
    src, dst = sys.argv[1], sys.argv[2]
    t0 = time.time()

    img = Image.open(src).convert("RGBA")
    P(f"[in] {src} {img.size}")

    sess = load_session()
    mask = refine(matte(sess, img))

    out = img.copy()
    out.putalpha(mask)

    # 裁到主体外框（留一点边），否则透明留白会把角色缩得很小
    bbox = mask.point(lambda v: 255 if v > 16 else 0).getbbox()
    P(f"[bbox] {bbox}")
    if bbox:
        pad = 6
        box = (max(0, bbox[0] - pad), max(0, bbox[1] - pad),
               min(out.width, bbox[2] + pad), min(out.height, bbox[3] + pad))
        out = out.crop(box)

    os.makedirs(os.path.dirname(os.path.abspath(dst)) or ".", exist_ok=True)
    out.save(dst)

    alpha = out.split()[-1]
    hist = alpha.histogram()
    total = out.width * out.height
    P(f"[out] {dst} {out.size}  {sum(hist[250:])/total:.1%} 不透明 / {sum(hist[:5])/total:.1%} 全透明")

    # 棋盘格预览
    prev = Image.new("RGBA", out.size, (0, 0, 0, 0))
    S = 20
    for y in range(0, out.height, S):
        for x in range(0, out.width, S):
            c = (236, 240, 246, 255) if ((x // S) + (y // S)) % 2 == 0 else (208, 215, 226, 255)
            prev.paste(c, (x, y, min(x + S, out.width), min(y + S, out.height)))
    prev.alpha_composite(out)
    prev.thumbnail((640, 1200))
    pp = os.path.splitext(dst)[0] + "-preview.png"
    prev.convert("RGB").save(pp)
    P(f"[preview] {pp}")
    P(f"[done] {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
