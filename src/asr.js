/**
 * asr.js —— 耳朵
 *
 * sherpa-onnx + SenseVoiceSmall（int8，228MB）。纯 CPU：
 * 5.6 秒音频 0.2 秒出结果（RTF 0.04），模型加载 1.3 秒。
 *
 * 它还能顺手给出语种、情绪、是不是人声，这些后面可以用来调表情。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const SAMPLE_RATE = 16000

function create({ dir, log = console.log, numThreads = 4, language = 'auto' } = {}) {  let sherpa = null
  let recognizer = null
  let state = 'idle' // idle | loading | ready | failed
  let lastError = ''

  function modelPath() {
    for (const name of ['model.int8.onnx', 'model.onnx']) {
      const p = path.join(dir, name)
      if (fs.existsSync(p)) return p
    }
    return null
  }

  function init() {
    if (state === 'ready') return true
    if (state === 'failed') return false
    if (state === 'loading') return false
    state = 'loading'

    const t = Date.now()
    try {
      sherpa = require('sherpa-onnx-node')
    } catch (e) {
      state = 'failed'
      lastError = 'sherpa-onnx-node 没装好：' + e.message
      log('[asr]', lastError)
      return false
    }

    const model = modelPath()
    const tokens = path.join(dir, 'tokens.txt')
    if (!model || !fs.existsSync(tokens)) {
      state = 'failed'
      lastError = `模型不全（${dir}）`
      log('[asr]', lastError)
      return false
    }

    try {
      recognizer = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          senseVoice: { model, language, useInverseTextNormalization: 1 },
          tokens,
          numThreads,
          provider: 'cpu',
          debug: 0,
        },
      })
      state = 'ready'
      log(`[asr] 就绪 ${((Date.now() - t) / 1000).toFixed(2)}s (${path.basename(model)})`)
      return true
    } catch (e) {
      state = 'failed'
      lastError = e.message
      log('[asr] 初始化失败:', e.message)
      return false
    }
  }

  /** 提前把模型读进内存，免得第一句话等 1.3 秒 */
  function warmup() {
    if (state === 'idle') setTimeout(init, 0)
    return state
  }

  /**
   * @param {Float32Array} samples 16kHz 单声道
   * @returns {{ok:boolean, text?:string, lang?:string, emotion?:string, ms?:number, error?:string}}
   */
  function transcribe(samples) {
    if (!samples || samples.length === 0) return { ok: false, error: '没有音频' }
    if (samples.length < SAMPLE_RATE * 0.25) return { ok: false, error: '太短' }
    if (!init()) return { ok: false, error: lastError || '模型未就绪' }

    const t = Date.now()
    try {
      const stream = recognizer.createStream()
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
      recognizer.decode(stream)
      const r = recognizer.getResult(stream)
      const text = String(r.text || '').trim()
      const ms = Date.now() - t
      if (!text) return { ok: false, error: '没听清', ms }
      return {
        ok: true,
        text,
        lang: r.lang || '',
        emotion: r.emotion || '',
        ms,
      }
    } catch (e) {
      log('[asr] 识别失败:', e.message)
      return { ok: false, error: e.message }
    }
  }

  return {
    init,
    warmup,
    transcribe,
    get status() { return { state, error: lastError, dir } },
  }
}

/** 读 wav，自检用（不需要走麦克风） */
function readWave(p) {
  const s = require('sherpa-onnx-node')
  return s.readWave(p)
}

module.exports = { create, readWave, SAMPLE_RATE }
