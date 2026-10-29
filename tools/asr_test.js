/**
 * SenseVoice 识别自检（不需要 Electron，也不需要麦克风）
 *   node tools/asr_test.js [wav路径]
 * 用官方的 zh.wav 验证整条链路。
 */
'use strict'

const path = require('node:path')
const fs = require('node:fs')
const sherpa = require('sherpa-onnx-node')

const ROOT = path.join(__dirname, '..')
const MODEL_DIR = path.join(ROOT, '..', '.asr-models', 'sense-voice')

const wav = process.argv[2] || path.join(MODEL_DIR, 'zh.wav')

function findModel() {
  const cands = [
    path.join(MODEL_DIR, 'model.int8.onnx'),
    path.join(MODEL_DIR, 'model.onnx'),
  ]
  for (const c of cands) if (fs.existsSync(c)) return c
  throw new Error('找不到 SenseVoice 模型')
}

;(async () => {
  const t0 = Date.now()
  const model = findModel()
  const tokens = path.join(MODEL_DIR, 'tokens.txt')

  console.log('[1] 加载模型', path.basename(model), (fs.statSync(model).size / 1048576).toFixed(1), 'MB')

  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model,
        language: 'auto',
        useInverseTextNormalization: 1,
      },
      tokens,
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
    },
  })
  console.log(`[2] 就绪 ${((Date.now() - t0) / 1000).toFixed(2)}s`)

  const wave = sherpa.readWave(wav)
  console.log(`[3] ${path.basename(wav)} ${wave.sampleRate}Hz ${(wave.samples.length / wave.sampleRate).toFixed(2)}s`)

  const t1 = Date.now()
  const stream = recognizer.createStream()
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples })
  recognizer.decode(stream)
  const res = recognizer.getResult(stream)
  const dt = (Date.now() - t1) / 1000

  console.log(`[4] 识别 ${dt.toFixed(2)}s  (音频 ${(wave.samples.length / wave.sampleRate).toFixed(2)}s, RTF ${(dt / (wave.samples.length / wave.sampleRate)).toFixed(2)})`)
  console.log('[5] 结果:', JSON.stringify(res))
  console.log('[6] 文本:', res.text || '(空)')
})().catch((e) => {
  console.error('失败:', e && (e.stack || e.message))
  process.exit(1)
})
