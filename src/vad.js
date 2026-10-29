/**
 * vad.js —— 把录音里的静音剪掉
 *
 * 按住 Alt 说话时，前面等你想词的那两秒、说完后手还没松的那一秒，
 * 全都会被录进去。不剪掉的话：
 *   1. 识别变慢（虽然 SenseVoice 很快，但没必要）
 *   2. 更容易把环境噪声识别成一句莫名其妙的话
 *   3. 你不知道到底有没有录进去
 *
 * 用 Silero VAD（644KB）切出真正有人说话的片段，再拼起来送去识别。
 * 模型不存在时直接原样透传，不影响主流程。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const SR = 16000
const WINDOW = 512          // silero 要求的窗口
const MIN_SPEECH_MS = 250   // 短于这个就當作没说话

function create({ dir, log = console.log } = {}) {
  let sherpa = null
  let vad = null
  let state = 'idle' // idle | ready | failed

  function modelPath() {
    const cands = [
      path.join(dir, 'silero_vad.onnx'),
      path.join(dir, '..', 'silero_vad.onnx'),
    ]
    for (const p of cands) if (fs.existsSync(p)) return p
    return null
  }

  function init() {
    if (state === 'ready') return true
    if (state === 'failed') return false

    const model = modelPath()
    if (!model) {
      state = 'failed'
      log('[vad] 没找到 silero_vad.onnx，静音会原样送进识别')
      return false
    }

    try {
      sherpa = require('sherpa-onnx-node')
      vad = new sherpa.Vad(
        {
          sileroVad: {
            model,
            threshold: 0.5,
            minSpeechDuration: 0.25,
            minSilenceDuration: 0.35,
            maxSpeechDuration: 20,
            windowSize: WINDOW,
          },
          sampleRate: SR,
          numThreads: 1,
          provider: 'cpu',
          debug: 0,
        },
        60
      )
      state = 'ready'
      log('[vad] 就绪')
      return true
    } catch (e) {
      state = 'failed'
      log('[vad] 初始化失败:', e.message)
      return false
    }
  }

  /**
   * @param {Float32Array} samples 16kHz 单声道
   * @returns {{ok:boolean, samples:Float32Array, speechMs:number, totalMs:number, cut:boolean, error?:string}}
   */
  function trim(samples) {
    const totalMs = (samples.length / SR) * 1000
    const passthrough = { ok: true, samples, speechMs: Math.round(totalMs), totalMs: Math.round(totalMs), cut: false }

    if (!samples || samples.length < SR * 0.2) return { ...passthrough, ok: false, error: '太短' }
    if (!init()) return passthrough

    try {
      vad.reset()
      const parts = []
      let speechLen = 0

      for (let i = 0; i < samples.length; i += WINDOW) {
        const chunk = samples.subarray(i, Math.min(i + WINDOW, samples.length))
        // silero 要求整窗，尾巴补零
        const win = chunk.length === WINDOW ? chunk : padTo(chunk, WINDOW)
        vad.acceptWaveform(win)

        while (!vad.isEmpty()) {
          const seg = vad.front(false)   // false: 复制出一份普通数组
          if (seg && seg.samples && seg.samples.length) {
            parts.push(seg.samples)
            speechLen += seg.samples.length
          }
          vad.pop()
        }
      }

      vad.flush()
      while (!vad.isEmpty()) {
        const seg = vad.front(false)
        if (seg && seg.samples && seg.samples.length) {
          parts.push(seg.samples)
          speechLen += seg.samples.length
        }
        vad.pop()
      }

      const speechMs = Math.round((speechLen / SR) * 1000)
      if (speechMs < MIN_SPEECH_MS) {
        return { ok: false, samples: new Float32Array(0), speechMs, totalMs: Math.round(totalMs), cut: true, error: '没听到说话声' }
      }

      // 只有一段就不用再拷了
      let out
      if (parts.length === 1) {
        out = parts[0]
      } else {
        out = new Float32Array(speechLen)
        let o = 0
        for (const p of parts) { out.set(p, o); o += p.length }
      }

      return {
        ok: true,
        samples: out,
        speechMs,
        totalMs: Math.round(totalMs),
        cut: speechMs < totalMs - 150,
      }
    } catch (e) {
      log('[vad] 处理失败，原样透传:', e.message)
      return passthrough
    }
  }

  return { trim, init, get state() { return state } }
}

function padTo(arr, n) {
  const out = new Float32Array(n)
  out.set(arr)
  return out
}

module.exports = { create, SR }
