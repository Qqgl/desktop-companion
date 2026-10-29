/**
 * 生成托盘图标（纯 Node + zlib，不依赖任何图形库）
 * 输出 assets/tray.png 与 assets/tray@2x.png
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

// ---------- 最小 PNG 编码器 ----------

const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- 画一个「小家伙」的头 ----------

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  const R = size * 0.46

  const put = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    const sa = a / 255
    const da = px[i + 3] / 255
    const outA = sa + da * (1 - sa)
    if (outA <= 0) return
    px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / outA)
    px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / outA)
    px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / outA)
    px[i + 3] = Math.round(outA * 255)
  }

  // 反锯齿圆
  const circle = (cx, cy, rad, col) => {
    for (let y = Math.floor(cy - rad - 2); y <= cy + rad + 2; y++) {
      for (let x = Math.floor(cx - rad - 2); x <= cx + rad + 2; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        const a = Math.max(0, Math.min(1, rad - d + 0.5))
        if (a > 0) put(x, y, col[0], col[1], col[2], a * (col[3] ?? 255))
      }
    }
  }

  // 头：冷白渐变
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c)
      const a = Math.max(0, Math.min(1, R - d + 0.6))
      if (a <= 0) continue
      const t = clamp01((y - (c - R)) / (2 * R))
      const r = Math.round(246 - t * 46)
      const g = Math.round(249 - t * 38)
      const b = Math.round(255 - t * 24)
      put(x, y, r, g, b, a * 255)
    }
  }

  // 描边
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c)
      const edge = Math.abs(d - R)
      if (edge < 0.9) {
        const a = Math.max(0, Math.min(1, 0.9 - edge + 0.5))
        put(x, y, 43, 51, 72, a * 255)
      }
    }
  }

  // 眼睛
  const eyeR = size * 0.105
  circle(c - size * 0.175, c + size * 0.06, eyeR, [43, 51, 72, 255])
  circle(c + size * 0.175, c + size * 0.06, eyeR, [43, 51, 72, 255])
  circle(c - size * 0.175 + eyeR * 0.35, c + size * 0.06 - eyeR * 0.4, eyeR * 0.34, [255, 255, 255, 255])
  circle(c + size * 0.175 + eyeR * 0.35, c + size * 0.06 - eyeR * 0.4, eyeR * 0.34, [255, 255, 255, 255])

  // 腮红
  circle(c - size * 0.30, c + size * 0.20, size * 0.075, [255, 150, 150, 120])
  circle(c + size * 0.30, c + size * 0.20, size * 0.075, [255, 150, 150, 120])

  return px
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

const outDir = path.join(__dirname, '..', 'assets')
fs.mkdirSync(outDir, { recursive: true })

for (const [size, name] of [[16, 'tray.png'], [32, 'tray@2x.png']]) {
  const png = encodePNG(size, size, drawIcon(size))
  fs.writeFileSync(path.join(outDir, name), png)
  console.log('wrote', name, png.length, 'bytes')
}

// 快捷方式图标：打包成 .ico 前先出这些尺寸
for (const size of [16, 24, 32, 48, 64, 128, 256]) {
  const png = encodePNG(size, size, drawIcon(size))
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png)
  console.log('wrote', `icon-${size}.png`, png.length, 'bytes')
}
