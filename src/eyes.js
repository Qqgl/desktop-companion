/**
 * eyes.js —— 眼睛
 *
 * 用户说「帮我看看屏幕上这个报错」时才看。**绝不自动截图**：
 * 截图会包含屏幕上的全部内容（聊天记录、密码、别人的消息），
 * 而且要发给第三方接口。所以只有一次明确的工具调用才会触发。
 *
 * 实现上和 brain 解耦：视觉可以用不同的 model / baseURL / key，
 * 默认沿用 brain 的设置（DeepSeek 这两个接口都认）。
 */
'use strict'

const MAX_EDGE = 1280

/** 视觉配置：没单独配就沿用大脑的 */
function visionConfig(cfg) {
  const v = cfg.vision || {}
  const b = cfg.brain || {}
  return {
    enabled: v.enabled !== false,
    baseURL: v.baseURL || b.baseURL,
    model: v.model || b.model,
    apiKey: v.apiKey || b.apiKey,
    maxWidth: Number(v.maxWidth) || MAX_EDGE,
    timeoutMs: Number(v.timeoutMs) || 30000,
  }
}

function endpoint(baseURL) {
  const base = String(baseURL || '').replace(/\/+$/, '')
  if (base.endsWith('/chat/completions')) return base
  return base + '/chat/completions'
}

/**
 * 截一张当前主屏。返回 { jpeg: Buffer, width, height }。
 * desktopCapturer 只能在主进程用，所以这里延迟 require。
 */
async function captureScreen(maxWidth = MAX_EDGE) {
  const { desktopCapturer, screen } = require('electron')
  const display = screen.getPrimaryDisplay()
  const { width, height } = display.size
  const scale = Math.min(1, maxWidth / width)
  const tw = Math.max(1, Math.round(width * scale))
  const th = Math.max(1, Math.round(height * scale))

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: tw, height: th },
    fetchWindowIcons: false,
  })
  if (!sources.length) throw new Error('没有拿到屏幕')

  const img = sources[0].thumbnail
  if (!img || img.isEmpty()) throw new Error('截出来是空的')

  const size = img.getSize()
  return { jpeg: img.toJPEG(82), width: size.width, height: size.height, display: sources[0].name }
}

/**
 * 看屏幕并回答。question 是用户的原话，直接交给视觉模型。
 * @returns {Promise<{ok:boolean, said:string}>}
 */
async function look(question, cfg, log = console.log, { saveTo = null } = {}) {
  const v = visionConfig(cfg)
  if (!v.enabled) return { ok: false, said: '主人没给我装眼睛' }
  if (!v.apiKey) return { ok: false, said: '没有配置视觉模型的 key' }

  let shot
  const t0 = Date.now()
  try {
    shot = await captureScreen(v.maxWidth)
  } catch (e) {
    log('[eyes] 截图失败', e.message)
    return { ok: false, said: `截图失败：${e.message}` }
  }

  // 自检用：把真正发出去的那张图存下来
  if (saveTo) {
    try {
      require('node:fs').writeFileSync(saveTo, shot.jpeg)
      log('[eyes] 截图已存', saveTo)
    } catch (e) {
      log('[eyes] 存图失败', e.message)
    }
  }

  const b64 = shot.jpeg.toString('base64')
  log('[eyes] 截图', `${shot.width}x${shot.height}`, `${Math.round(shot.jpeg.length / 1024)}KB`)

  const ask =
    `用户正在看着自己的屏幕，问：「${String(question || '屏幕上有什么').slice(0, 200)}」\n` +
    '下面是这一屏的截图。请只用中文回答他问的那件事，说清楚看到的内容；' +
    '看不出来的就说看不出来，不要猜，不要编造。回答控制在三句话内。'

  let res
  try {
    res = await fetch(endpoint(v.baseURL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${v.apiKey}` },
      body: JSON.stringify({
        model: v.model,
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: ask },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(v.timeoutMs),
    })
  } catch (e) {
    log('[eyes] 请求失败', e.message)
    return { ok: false, said: `看的时候出错了：${e.message}` }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    log('[eyes] HTTP', res.status, body.slice(0, 200))
    return { ok: false, said: `看图失败：HTTP ${res.status}` }
  }

  const j = await res.json().catch(() => null)
  const msg = j && j.choices && j.choices[0] && j.choices[0].message
  const text = msg && (msg.content || msg.reasoning_content)
  if (!text) {
    log('[eyes] 返回里没有文字', JSON.stringify(j).slice(0, 200))
    return { ok: false, said: '看到了但说不出话' }
  }

  log('[eyes]', `${Date.now() - t0}ms`, JSON.stringify(String(text).slice(0, 60)))
  return { ok: true, said: String(text).trim() }
}

module.exports = { look, captureScreen, visionConfig }
