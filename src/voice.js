/**
 * voice.js —— 嗓子
 *
 * 用 Edge 的在线朗读接口（微软那套免费音色），拿到 mp3 直接丢给渲染进程播。
 * 选它是因为：中文音色里 zh-CN-XiaoyiNeural 是活泼少女音，免费、延迟低、
 * 而且不需要本地 GPU —— 这台机器没显卡。
 *
 * 失败一律返回 null，让上层安静地退化成「只有气泡没有声音」。
 */
'use strict'

let lib = null

/**
 * 合成必须串行。
 *
 * 渲染端会"预取"下一句（这句还在播，下一句就开始合），如果两句同时
 * 往同一个 WebSocket 上发 toStream，回来的音频会互相串 —— 实测两句
 * 只差 52ms 完成，内容对得上纯属运气。
 * 串起来之后：当前句合成 ~1.3s（含握手）、后续句 ~0.4s，
 * 而一句播放要 2~3s，所以下一句总能在播完前就绪，预取效果不减。
 */
let chain = Promise.resolve()
function serialize(fn) {
  const next = chain.then(fn, fn)
  chain = next.then(() => {}, () => {})
  return next
}

/** 预热：把连接建好，别让第一句话替握手买单 */
async function warmup(vcfg, log = console.log) {
  if (!vcfg || vcfg.enabled === false) return false
  try {
    await getTts(vcfg, log)
    log('[voice] 连接已预热')
    return true
  } catch (e) {
    log('[voice] 预热失败:', e.message)
    return false
  }
}
let shared = null
let sharedKey = ''

function loadLib() {
  if (lib !== null) return lib
  try {
    lib = require('msedge-tts')
  } catch (e) {
    console.warn('[voice] msedge-tts 没装好，静音模式:', e.message)
    lib = false
  }
  return lib
}

function dropShared() {
  if (shared) {
    try { shared.close() } catch { /* 已经断了 */ }
  }
  shared = null
  sharedKey = ''
}

async function getTts(vcfg, log) {
  const m = loadLib()
  if (!m) return null

  const key = [vcfg.voice, vcfg.rate, vcfg.pitch, vcfg.volume].join('|')
  if (shared && sharedKey === key) return shared

  dropShared()
  const inst = new m.MsEdgeTTS()
  await inst.setMetadata(
    vcfg.voice || 'zh-CN-XiaoyiNeural',
    m.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
  )
  shared = inst
  sharedKey = key
  return shared
}

/** 把 markdown 符号、代码、表情清掉，否则会被念出来 */
function sanitize(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[*_#>~|]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/**
 * @returns {Promise<Buffer|null>} mp3 字节；失败返回 null
 */
async function synthesize(text, vcfg, log = console.log) {
  if (!vcfg || vcfg.enabled === false) return null
  const clean = sanitize(text)
  if (!clean) return null

  return serialize(async () => {
    let tts
    try {
      tts = await getTts(vcfg, log)
    } catch (e) {
      log('[voice] 连接失败:', e.message)
      dropShared()
      return null
    }
    if (!tts) return null

    try {
      const opts = {}
      if (vcfg.rate) opts.rate = vcfg.rate
      if (vcfg.pitch) opts.pitch = vcfg.pitch
      if (vcfg.volume) opts.volume = vcfg.volume

      const out = tts.toStream(clean, opts)
      const stream = out && out.audioStream ? out.audioStream : out
      if (!stream || typeof stream.on !== 'function') throw new Error('toStream 没返回流')

      const chunks = []
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('合成超时 12s')), 12000)
        const done = () => { clearTimeout(timer); resolve() }
        stream.on('data', (c) => chunks.push(Buffer.from(c)))
        stream.on('end', done)
        stream.on('close', done)
        stream.on('error', (e) => { clearTimeout(timer); reject(e) })
      })

      const buf = Buffer.concat(chunks)
      if (buf.length < 800) throw new Error(`音频太短（${buf.length} 字节），可能失败了`)
      return buf
    } catch (e) {
      log('[voice] 合成失败:', e.message)
      // 连接可能已经坏了，下次重建
      dropShared()
      return null
    }
  })
}

module.exports = { synthesize, sanitize, warmup }
