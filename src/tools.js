/**
 * tools.js —— 她的手
 *
 * 模型只会输出文字。要让它"动手"，必须给她一组工具，让她自己决定调哪个、传什么参数。
 * 这里定义工具的描述（给模型看的 JSON Schema）和执行器（真干活的部分）。
 *
 * 安全边界（重要）：
 *   · open_url 只允许 http/https，不许 file:// 和 javascript:
 *   · open_app 只认白名单里的几个程序，不接受任意命令行
 *   · open_folder 只打开真实存在的目录
 * 宁可少给她几个能力，也不让她能执行任意命令 —— 她现在能读记忆、
 * 能把你说的每句话存下来，一旦被诱导执行命令，损失不可控。
 */
'use strict'

const fs = require('node:fs')
const { execFile } = require('node:child_process')

// ------------------------------------------------------------ 白名单

/** 只允许这几个程序，按 key 匹配，不接受路径和参数 */
const APPS = {
  notepad: 'notepad.exe',
  calc: 'calc.exe',
  paint: 'mspaint.exe',
  explorer: 'explorer.exe',
  taskmgr: 'taskmgr.exe',
}

// ------------------------------------------------------------ 网页抓取

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const MAX_BYTES = 3 * 1024 * 1024
const MAX_TEXT = 3000

/** HTML → 纯文本。不追求完美，够模型读懂就行。 */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n) || 32))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

/** 只允许公网 http/https，挡掉本机地址 */
function checkFetchUrl(raw) {
  let u
  try {
    u = new URL(String(raw || '').trim())
  } catch {
    return { ok: false, error: '不是合法的网址' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `只允许 http/https，收到 ${u.protocol}` }
  }
  const host = u.hostname.toLowerCase()
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return { ok: false, error: '不允许访问本机或内网地址' }
  }
  return { ok: true, url: u.toString() }
}

async function fetchPage(url, timeoutMs = 12000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const buf = Buffer.from(await res.arrayBuffer())
  const slice = buf.subarray(0, MAX_BYTES)
  const ctype = res.headers.get('content-type') || ''
  let charset = 'utf-8'
  const m = ctype.match(/charset=([\w-]+)/i)
  if (m) charset = m[1].toLowerCase()

  // 有些中文站还是 gbk，Node 的 TextDecoder 认识 'gbk'
  let text
  try {
    text = new TextDecoder(charset === 'gb2312' ? 'gbk' : charset).decode(slice)
  } catch {
    text = new TextDecoder('utf-8').decode(slice)
  }
  return { html: text, finalUrl: res.url || url }
}

/** Bing 结果页 → [{title, url, snippet}] */
function parseBing(html) {
  const out = []
  const blocks = html.match(/<li[^>]*class="[^"]*b_algo[^"]*"[\s\S]*?<\/li>/gi) || []

  for (const b of blocks) {
    const h2 = b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
    const href = b.match(/<a[^>]+href="([^"]+)"/i)
    const snip = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    if (!h2 || !href) continue

    let link = href[1]
    // Bing 有时给的是自己的跳转链接，把真实地址从 u=a1<base64> 里解出来
    if (link.includes('bing.com/ck/a')) {
      const u = link.match(/[?&]u=a1([^&]+)/)
      if (u) {
        try {
          const b64 = u[1].replace(/-/g, '+').replace(/_/g, '/')
          const decoded = Buffer.from(b64, 'base64').toString('utf8')
          if (/^https?:\/\//.test(decoded)) link = decoded
        } catch { /* 解不出来就用原链接 */ }
      }
    }

    out.push({
      title: htmlToText(h2[1]).slice(0, 120),
      url: link,
      snippet: snip ? htmlToText(snip[1]).slice(0, 240) : '',
    })
    if (out.length >= 5) break
  }
  return out
}

// ------------------------------------------------------------ 给模型看的定义

const DEFS = [
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: '在默认浏览器里打开一个网址。用户说"打开某个网站"时用。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整网址，必须以 http:// 或 https:// 开头' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        '在网上搜索，返回几条结果的标题和摘要（不会打开浏览器）。' +
        '用户问新闻、天气、价格、谁是谁这类需要联网才知道的事，先用它。' +
        '拿到结果后直接用自己的话回答，不要念链接。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description:
        '把一个网页的正文抓下来读。搜索结果摘要不够时，挑一条 url 再抓。' +
        '返回的是纯文本，可能比较长，只挑和问题相关的部分说。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓的网址，http/https' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_app',
      description: `启动本机的一个常用程序。可选：${Object.keys(APPS).join(' / ')}。`,
      parameters: {
        type: 'object',
        properties: {
          app: { type: 'string', enum: Object.keys(APPS), description: '程序名' },
        },
        required: ['app'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_folder',
      description: '在文件资源管理器里打开一个文件夹。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件夹的绝对路径' },
        },
        required: ['path'],
      },
    },
  },
]

// ------------------------------------------------------------ 执行

function checkUrl(raw) {
  let u
  try {
    u = new URL(String(raw || '').trim())
  } catch {
    return { ok: false, error: '不是合法的网址' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `只允许 http/https，收到 ${u.protocol}` }
  }
  return { ok: true, url: u.toString() }
}

/**
 * @returns {Promise<{ok:boolean, said:string}>} said 是要回给模型的结果描述
 */
async function run(name, args, { shell, log = console.log } = {}) {
  const a = args || {}
  log('[tool]', name, JSON.stringify(a))

  try {
    if (name === 'open_url') {
      const c = checkUrl(a.url)
      if (!c.ok) return { ok: false, said: `打不开：${c.error}` }
      await shell.openExternal(c.url)
      return { ok: true, said: `已在浏览器打开 ${c.url}` }
    }

    if (name === 'search_web') {
      const q = String(a.query || '').trim()
      if (!q) return { ok: false, said: '没有搜索词' }

      try {
        const { html } = await fetchPage('https://www.bing.com/search?q=' + encodeURIComponent(q))
        const list = parseBing(html)
        if (!list.length) {
          // 抓不到结果就退回"打开浏览器"，至少用户还能自己看
          await shell.openExternal('https://www.bing.com/search?q=' + encodeURIComponent(q))
          return { ok: false, said: '搜索结果抓不下来，已经帮你在浏览器打开了' }
        }
        const text = list
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`)
          .join('\n')
        return { ok: true, said: `搜到 ${list.length} 条：\n${text}` }
      } catch (e) {
        await shell.openExternal('https://www.bing.com/search?q=' + encodeURIComponent(q))
        return { ok: false, said: `搜索失败（${e.message}），已在浏览器打开` }
      }
    }

    if (name === 'fetch_url') {
      const c = checkFetchUrl(a.url)
      if (!c.ok) return { ok: false, said: `抓不了：${c.error}` }

      try {
        const { html, finalUrl } = await fetchPage(c.url)
        const text = htmlToText(html).slice(0, MAX_TEXT)
        if (text.length < 40) return { ok: false, said: '这个页面几乎没有可读文字' }
        return { ok: true, said: `来自 ${finalUrl}\n\n${text}` }
      } catch (e) {
        return { ok: false, said: `抓取失败：${e.message}` }
      }
    }

    if (name === 'open_app') {
      const exe = APPS[String(a.app || '').toLowerCase()]
      if (!exe) return { ok: false, said: `这个程序不在允许列表里（只有 ${Object.keys(APPS).join('/')}）` }

      // 不能"发射后不管"：spawn 失败（比如任务管理器需要管理员权限）是异步回来的，
      // 立刻返回「已启动」等于骗模型也骗用户。等一小会儿看有没有立刻报错。
      const err = await new Promise((resolve) => {
        let settled = false
        try {
          execFile(exe, { windowsHide: false }, (e) => {
            if (settled) return
            settled = true
            resolve(e || null)
          })
        } catch (e) {
          if (!settled) {
            settled = true
            resolve(e)
          }
          return
        }
        // 正常启动时回调不会立刻触发，900ms 内没报错就当成功
        setTimeout(() => {
          if (!settled) {
            settled = true
            resolve(null)
          }
        }, 900)
      })

      if (err) {
        const code = err.code || ''
        const hint = /EACCES|EPERM/.test(code) ? '（这个程序需要管理员权限）' : ''
        log('[tool] 启动失败', a.app, code || err.message)
        return { ok: false, said: `启动 ${a.app} 失败：${code || err.message}${hint}` }
      }
      return { ok: true, said: `已启动 ${a.app}` }
    }

    if (name === 'open_folder') {
      const p = String(a.path || '').trim()
      if (!p || !fs.existsSync(p)) return { ok: false, said: '这个路径不存在' }
      if (!fs.statSync(p).isDirectory()) return { ok: false, said: '这不是文件夹' }
      await shell.openPath(p)
      return { ok: true, said: `已打开文件夹 ${p}` }
    }

    return { ok: false, said: `没有这个工具：${name}` }
  } catch (e) {
    log('[tool] 执行失败', e.message)
    return { ok: false, said: `执行出错：${e.message}` }
  }
}

module.exports = { DEFS, run, APPS }
