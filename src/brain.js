/**
 * brain.js —— 大脑
 *
 * 统一接口：brain.stream(text) 是一个 async generator，逐段吐出文字。
 * 之所以用 generator 而不是回调，是为了让「流式打字 → 分句配音」这条链写得直白。
 *
 * provider:
 *   mock      —— 没配 key 时的本地假大脑，规则应答，但走的是同一条链路
 *   deepseek  —— 官方 API（OpenAI 兼容）
 *   openai    —— 任意 OpenAI 兼容端点
 *   ollama    —— 本地模型，baseURL 填 http://127.0.0.1:11434/v1
 */
'use strict'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 取最近 N 条历史发给模型。
 *
 * 关键：**不能以 tool 消息开头**。
 * 工具调用是「assistant(tool_calls) → tool(结果)」成对出现的，
 * 如果按条数截断时正好把 assistant 那条切掉，只剩一条孤立的 tool，
 * API 会直接 400：Messages with role 'tool' must be a response to a preceding
 * message with 'tool_calls'。
 */
function tailForApi(history, max) {
  let start = Math.max(0, history.length - max)
  while (start < history.length && history[start].role === 'tool') start++
  return history.slice(start)
}

// 工具定义：只有主进程注入了 execTool 时才会真的发给模型
const TOOLS = require('./tools').DEFS

function endpoint(baseURL) {
  const base = String(baseURL || '').replace(/\/+$/, '')
  if (base.endsWith('/chat/completions')) return base
  return base + '/chat/completions'
}

class RemoteBrain {
  constructor(cfg, log, opts = {}) {
    this.cfg = cfg
    this.log = log
    this.history = []
    this.name = cfg.brain.provider
    this.execTool = opts.execTool || null   // 由主进程注入，真正"动手"的地方
  }

  async *stream(userText, opts = {}) {
    const b = this.cfg.brain
    this.history.push({ role: 'user', content: userText })
    const system = composeSystem(b, this.cfg.persona, opts.context)

    // 最多跑 4 轮：她可以「调工具 → 看结果 → 再说一句」，
    // 但要有上限，否则模型可能自己跟自己无限循环。
    for (let round = 0; round < 4; round++) {
      const { text, calls } = yield* this.round(system)

      if (!calls.length) {
        this.history.push({ role: 'assistant', content: text })
        break
      }

      // 有工具调用：先把这句话（通常很短，比如"我打开浏览器"）记下来
      this.history.push({
        role: 'assistant',
        content: text || null,
        tool_calls: calls,
      })

      for (const c of calls) {
        let args = {}
        try {
          args = JSON.parse(c.function.arguments || '{}')
        } catch {
          args = {}
        }

        let said = '工具没有执行'
        if (this.execTool) {
          try {
            const r = await this.execTool(c.function.name, args)
            said = (r && (r.said || (r.ok ? '完成' : '失败'))) || '完成'
          } catch (e) {
            said = `执行出错：${e.message}`
          }
        }
        this.log('[tool]', c.function.name, '->', said)
        this.history.push({ role: 'tool', tool_call_id: c.id, content: said })
      }
    }

    if (this.history.length > 12) this.history = this.history.slice(-12)
  }

  /** 一轮请求。边流边吐字，同时把 tool_calls 攒起来。 */
  async *round(system) {
    const b = this.cfg.brain
    const messages = [{ role: 'system', content: system }, ...tailForApi(this.history, 10)]

    const headers = { 'Content-Type': 'application/json' }
    if (b.apiKey) headers.Authorization = `Bearer ${b.apiKey}`

    const body = {
      model: b.model,
      messages,
      stream: true,
      temperature: Number(b.temperature) || 0.8,
      max_tokens: Number(b.maxTokens) || 400,
    }
    if (this.execTool && TOOLS.length) body.tools = TOOLS

    let res
    try {
      res = await fetch(endpoint(b.baseURL), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        // 必须有超时。曾经因为漏了它，工具返回一大段网页正文后，
        // 跟着的那次请求静默卡死 6 分钟，整个应用看起来"没反应"。
        signal: AbortSignal.timeout(Number(b.timeoutMs) || 45000),
      })
    } catch (e) {
      const timeout = e && (e.name === 'AbortError' || e.name === 'TimeoutError')
      throw new Error(timeout ? `模型 ${Math.round((Number(b.timeoutMs) || 45000) / 1000)} 秒没有响应` : `连不上 ${b.baseURL}：${e.message}`)
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${errBody.slice(0, 200)}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let text = ''
    const acc = {}

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line || !line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue

        try {
          const j = JSON.parse(payload)
          const delta = j.choices && j.choices[0] && j.choices[0].delta
          if (!delta) continue

          if (delta.content) {
            text += delta.content
            yield delta.content
          }

          // 工具调用是分片到达的，按 index 拼
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0
              if (!acc[i]) {
                acc[i] = { id: '', type: 'function', function: { name: '', arguments: '' } }
              }
              const slot = acc[i]
              if (tc.id) slot.id = tc.id
              if (tc.function && tc.function.name) slot.function.name += tc.function.name
              if (tc.function && tc.function.arguments) slot.function.arguments += tc.function.arguments
            }
          }
        } catch {
          // 半行 JSON，等下一次拼接
        }
      }
    }

    const calls = Object.values(acc).filter((c) => c.function && c.function.name)
    return { text, calls }
  }
}

/** 把记忆里的第三人称事实，改写成对用户说话的口吻 */
function prettify(s) {
  return String(s)
    .replace(/^用户叫\s*/, '你叫')
    .replace(/^用户喜欢\s*/, '你喜欢')
    .replace(/^用户不喜欢\s*/, '你不喜欢')
    .replace(/^用户在做\s*/, '你在做')
    .replace(/^用户在(.+?)工作$/, '你在$1工作')
}

class MockBrain {
  constructor(cfg, log, reason) {
    this.cfg = cfg
    this.log = log
    this.reason = reason
    this.name = 'mock'
  }

  compose(text, context) {
    const t = (text || '').trim()
    const now = new Date()
    const hhmm = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`

    // 被问到「记不记得」时，直接从记忆上下文里捞两条念出来 —— 让假大脑也能演示记忆
    if (/记得|上次|我叫什么|我是谁|我之前/.test(t) && context) {
      const facts = context
        .split('\n')
        .filter((l) => l.startsWith('- '))
        .slice(0, 2)
        .map((l) => prettify(l.slice(2).replace(/（.*?）/g, '').trim()))
      if (facts.length) return `记得。${facts.join('，')}。`
    }

    if (/^(hi|hello|hey|你好|嗨|哈喽|在吗|在么)/i.test(t)) {
      return '在。你这声喊得我头发都翘起来了。'
    }
    if (/你是谁|你叫什么|名字/.test(t)) {
      const p = this.cfg.persona || {}
      if (p.name) {
        return `我叫${p.name}。${p.userTitle ? p.userTitle + '，' : ''}记好，别叫错了。`
      }
      return '一张会说话的画。名字还没定，你想叫什么叫什么。'
    }
    if (/几点|时间|日期/.test(t)) {
      return `现在 ${hhmm}。又忘了看表？`
    }
    if (/天气|下雨|冷|热不热/.test(t)) {
      return '我住在这块屏幕里，外面什么样得你告诉我。'
    }
    if (/累|困|烦|难过|焦虑|压力/.test(t)) {
      return '那就先别干了。我在这儿坐着，不吵你。'
    }
    if (/能做什么|功能|会什么|帮我/.test(t)) {
      return '现在只会陪你聊两句。等你的图到了，我就能转头看你了。'
    }
    if (/图|立绘|形象|长什么样/.test(t)) {
      return '图还在你脑子里吧。记得早点画完，我等得起。'
    }
    if (/谢谢|感谢|thx/.test(t)) {
      return '嗯。'
    }
    if (/没用|笨|傻|垃圾/.test(t)) {
      return '我确实只是一张 png。但你也没好到哪去，你还在跟 png 吵架。'
    }
    if (!t) return '……你在打字吗？'

    const echoes = [
      `「${t.slice(0, 12)}」—— 记下了。`,
      `嗯，你说这个的时候，我在努力理解。`,
      `这话我接不住，但我听懂了语气。`,
    ]
    return echoes[Math.floor(Math.random() * echoes.length)] + '（大脑还没接上，先这样）'
  }

  async *stream(text, opts = {}) {
    const reply = this.compose(text, opts.context)
    for (const ch of reply) {
      await sleep(24)
      yield ch
    }
  }
}

/**
 * 拼系统提示：身份（名字、称呼）+ 性格设定 + 记忆上下文。
 *
 * 名字和称呼单独放在 config.json 的 persona 里，而不是硬写进 systemPrompt ——
 * 这样以后改名、换称呼只改两个字段，不会跟性格描述糊在一起。
 */
function composeSystem(b, persona = {}, context = '') {
  const p = persona || {}
  const bits = []
  if (p.name) bits.push(`你叫「${p.name}」。`)
  if (p.userTitle) bits.push(`你称呼用户为「${p.userTitle}」，日常对话里就这么叫他。`)
  if (p.name) bits.push(`有人问你叫什么，就答「${p.name}」。`)

  const head = bits.length ? bits.join('') + '\n\n' : ''
  const ability =
    '你能真的动手：联网搜索、抓取网页正文、看用户的屏幕、打开网页、启动几个常用程序（记事本/计算器/画图/任务管理器）、打开文件夹。' +
    '用户让你打开什么就直接调用工具去做，不要只说「好的我帮你打开」然后什么都不发生。\n' +
    '用户让你「看看屏幕上 / 这报错什么意思」时，用 look_at_screen。**只在用户明确要求时才看**，不要自己想看就看。\n' +
    '用户让你「查一下 / 搜一下 / 念给我听」时：先 search_web；如果只是几条摘要不够回答，' +
    '挑最相关的一条用 fetch_url 抓正文，然后用两三句话把重点转述出来。' +
    '转述时绝对不要念网址、不要念列表编号，就像在跟人说话一样把事说清楚。\n' +
    '做不到的事就直说做不到，别硬编。\n\n'
  const tail = context ? '\n\n' + context : ''
  return head + ability + (b.systemPrompt || '') + tail
}

function createBrain(cfg, log, opts = {}) {
  const b = cfg.brain
  let provider = String(b.provider || 'mock').toLowerCase()

  // 便利：config 里 provider 还是 mock、但 apiKey 已经填了 —— 说明用户想用真的，
  // 直接把 provider 当成配置里的默认后端，省得再改第二个地方。
  if (provider === 'mock' && b.apiKey) {
    provider = /deepseek/i.test(b.baseURL) ? 'deepseek' : 'openai'
    log(`[brain] provider 是 mock 但填了 apiKey，按 ${provider} 走`)
  }

  if (provider === 'mock') {
    return new MockBrain(cfg, log, 'provider=mock')
  }
  // ollama 不需要 key，其它远端 provider 没 key 就退回假大脑
  if (!b.apiKey && provider !== 'ollama' && !/127\.0\.0\.1|localhost/.test(b.baseURL)) {
    log('[brain] 没有配置 apiKey，退回本地假大脑')
    return new MockBrain(cfg, log, 'missing-key')
  }
  // 把解析后的 provider 写回去：RemoteBrain 的 name 取自配置，
  // 不覆盖的话「mock + key」会被误报成 mock，启动提示也跟着错。
  const resolved = { ...cfg, brain: { ...b, provider } }
  return new RemoteBrain(resolved, log, opts)
}

module.exports = { createBrain, tailForApi }
