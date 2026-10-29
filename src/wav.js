/**
 * 读 WAV —— 自己解析，不用 sherpa 的 readWave。
 * 原因：sherpa 的 readWave 在 Electron 主进程里会抛
 * "External buffers are not allowed"（它内部碰到 native 内存），而在纯 Node 里正常。
 * 我们只需要 16k 单声道 Float32，自己解析反而干净。
 */
'use strict'

const fs = require('node:fs')

function readWav(file, targetRate = 16000) {
  const b = fs.readFileSync(file)
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 WAV')

  let off = 12
  let fmt = null
  let dataOff = -1
  let dataLen = 0

  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = {
        format: b.readUInt16LE(off + 8),
        channels: b.readUInt16LE(off + 10),
        sampleRate: b.readUInt32LE(off + 12),
        bits: b.readUInt16LE(off + 22),
      }
    } else if (id === 'data') {
      dataOff = off + 8
      dataLen = Math.min(size, b.length - dataOff)
      break
    }
    off += 8 + size + (size % 2)
  }

  if (!fmt || dataOff < 0) throw new Error('WAV 缺 fmt/data 块')
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw new Error(`只处理 16bit PCM，收到 format=${fmt.format} bits=${fmt.bits}`)
  }

  const frames = Math.floor(dataLen / 2 / fmt.channels)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let v = 0
    for (let c = 0; c < fmt.channels; c++) {
      v += b.readInt16LE(dataOff + (i * fmt.channels + c) * 2)
    }
    out[i] = v / fmt.channels / 32768
  }

  // 线性重采样到目标采样率
  if (fmt.sampleRate !== targetRate && frames > 0) {
    const ratio = fmt.sampleRate / targetRate
    const n = Math.floor(frames / ratio)
    const res = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = i * ratio
      const i0 = Math.floor(x)
      const i1 = Math.min(frames - 1, i0 + 1)
      const t = x - i0
      res[i] = out[i0] * (1 - t) + out[i1] * t
    }
    return { samples: res, sampleRate: targetRate }
  }

  return { samples: out, sampleRate: fmt.sampleRate }
}

module.exports = { readWav }
