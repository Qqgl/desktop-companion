/**
 * browser.js —— 她的手伸进浏览器
 *
 * 用 Chrome DevTools Protocol 驱动一个**独立的 Edge 实例**（专用配置目录），
 * 不依赖任何第三方库：Node 22+ 自带全局 WebSocket。
 *
 * 为什么不接用户日常那个浏览器：
 *   1. 要接管它就得让它带 --remote-debugging-port 启动，等于把整台浏览器的遥控器交出去
 *   2. 共用配置目录会和用户抢锁，Chrome 会直接拒绝启动
 *   独立实例的代价是"没登录过"，但那正好也是安全边界：够不着你的账号。
 *   需要登录的站点，在那个窗口里登一次，配置目录会记住。
 *
 * 能力：打开页面、读正文、按文字点击、填表单、截图。
 * 安全：只允许 http/https；每次操作都有超时；页面文本有长度上限。
 */
'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const DEFAULT_PORT = 9333
const MAX_TEXT = 2500

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findEdge() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
  return candidates.find((p) => p && fs.existsSync(p)) || null
}

/** 极简 CDP 客户端 */
function connect(wsUrl, log) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('连不上调试端口')))
  })

  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    const slot = msg.id && pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)
    if (msg.error) slot.reject(new Error(msg.error.message || 'CDP 错误'))
    else slot.resolve(msg.result)
  })

  ws.addEventListener('close', () => {
    for (const s of pending.values()) s.reject(new Error('调试连接断开了'))
    pending.clear()
  })

  const send = (method, params = {}, timeoutMs = 20000) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} 超时`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      ws.send(JSON.stringify({ id, method, params }))
    })

  return { ready, send, close: () => { try { ws.close() } catch { /* 已关 */ } } }
}

class Browser {
  constructor({ profileDir, port = DEFAULT_PORT, log = console.log } = {}) {
    this.port = port
    // 必须绝对路径：相对路径会被 Edge 忽略，于是它挂到用户已在运行的实例上，
    // 调试端口永远不会开 —— 表现就是"Edge 起来了但端口没响应"。
    this.profileDir = path.resolve(profileDir || path.join(os.tmpdir(), 'desktop-companion-browser'))
    this.log = log
    this.child = null
    this.page = null
    this.targetId = null
    this.edge = findEdge()
  }

  get base() {
    return `http://127.0.0.1:${this.port}`
  }

  async api(pathname, method = 'GET') {
    const r = await fetch(this.base + pathname, { method })
    if (!r.ok) throw new Error(`HTTP ${r.status} ${pathname}`)
    const t = await r.text()
    try {
      return JSON.parse(t)
    } catch {
      return t
    }
  }

  async launch() {
    if (!this.edge) throw new Error('这台机器上没找到 Edge')
    fs.mkdirSync(this.profileDir, { recursive: true })

    this.log('[browser] 启动 Edge，调试端口', this.port)

    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeSidebarV2',
      '--window-size=1200,820',
      'about:blank',
    ]

    // 两种启动方式，谁成算谁的。
    //
    // 首选 PowerShell 的 Start-Process：它是外部进程拉起的，不受 Electron
    // Job 对象和环境变量影响 —— 实测这条路上 CDP 完全正常。
    // 但有些受限环境（比如我在调试时用的沙箱）会禁止 Electron 的子进程
    // 启动 PowerShell，那就退回 Node 的 spawn。
    try {
      const { run: psRun, q } = require('./winps')
      // 注意：必须把参数拼成**一整个字符串**，并且给含空格的自己加双引号。
      // PowerShell 的 -ArgumentList 收到数组时不会帮你加引号，
      // 于是 --user-data-dir=D:\...\DSH Desktop\... 会在空格处被劈开，
      // Edge 把后半截当成"要打开的路径" —— 表现就是浏览器打开的是项目目录。
      const argLine = args
        .map((a) => (/\s/.test(a) ? `"${a}"` : a))
        .join(' ')
      psRun(`Start-Process -FilePath '${q(this.edge)}' -ArgumentList '${q(argLine)}' -WindowStyle Normal`)
      await this.waitCdp(9000)
      this.mode = 'ps'
      return
    } catch (e) {
      this.log('[browser] PowerShell 启动没成功，改用直接 spawn:', e.message)
    }

    const env = { ...process.env }
    for (const k of Object.keys(env)) {
      if (/^(ELECTRON_|CHROME_|GOOGLE_|NODE_OPTIONS$)/i.test(k)) delete env[k]
    }
    this.child = spawn(this.edge, args, { stdio: 'ignore', detached: true, env })
    this.child.unref()
    this.child.on('error', (err) => this.log('[browser] Edge 启动失败', err.message))
    this.mode = 'spawn'
    await this.waitCdp()
  }

  /** 等 CDP 端口可用 */
  async waitCdp(timeoutMs = 25000) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      try {
        const v = await this.api('/json/version')
        this.log('[browser] CDP 就绪', v.Browser)
        return v
      } catch {
        await sleep(300)
      }
    }
    throw new Error('Edge 起来了但调试端口没响应')
  }

  /** 确保有一个可用的 page target */
  async attach() {
    if (this.page) {
      try {
        await this.page.send('Runtime.evaluate', { expression: '1', returnByValue: true }, 3000)
        return this.page
      } catch {
        this.log('[browser] 旧连接不可用，重建')
        this.page.close()
        this.page = null
      }
    }

    if (!this.child) await this.launch()
    await this.waitCdp()

    // 注意：不要复用 Edge 启动时自带的那个标签页 ——
    // 它在初始化过程中会被替换掉，连上去以后 Page.enable 会一直不返回。
    // 永远自己开一个标签，最稳。
    let target = null
    if (this.targetId) {
      const list = await this.api('/json/list').catch(() => [])
      target = (Array.isArray(list) ? list : []).find((t) => t.id === this.targetId && t.type === 'page')
    }
    if (!target) {
      try {
        target = await this.api('/json/new?about:blank', 'PUT')
      } catch {
        target = await this.api('/json/new?about:blank')
      }
    }
    if (!target || !target.webSocketDebuggerUrl) throw new Error('拿不到页面调试地址')

    this.targetId = target.id
    this.page = connect(target.webSocketDebuggerUrl, this.log)
    await this.page.ready
    await this.page.send('Page.enable', {}, 15000)
    return this.page
  }

  async eval(expression, timeoutMs = 20000) {
    const page = await this.attach()
    const r = await page.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs)
    if (r && r.exceptionDetails) {
      const msg = r.exceptionDetails.exception && r.exceptionDetails.exception.description
      throw new Error((msg || '页面脚本出错').split('\n')[0])
    }
    return r && r.result ? r.result.value : undefined
  }

  /** 打开网址并等它加载完 */
  async goto(url) {
    const u = new URL(String(url))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只允许 http/https')

    const page = await this.attach()
    await page.send('Page.navigate', { url: u.toString() }, 30000)

    // 等 readyState complete，最多 20 秒
    const t0 = Date.now()
    let state = ''
    while (Date.now() - t0 < 20000) {
      await sleep(250)
      try {
        state = await this.eval('document.readyState', 4000)
      } catch {
        continue
      }
      if (state === 'complete') break
    }
    await sleep(300)   // 给前端框架一点渲染时间

    const info = await this.eval(`(() => ({
      url: location.href,
      title: document.title,
      text: (document.body && document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, ${MAX_TEXT}),
    }))()`)
    return { ...info, state }
  }

  async read() {
    return this.eval(`(() => ({
      url: location.href,
      title: document.title,
      text: (document.body && document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, ${MAX_TEXT}),
    }))()`)
  }

  /** 按可见文字点击 */
  async click(text) {
    const needle = String(text || '').trim()
    if (!needle) throw new Error('没说要点什么')

    const res = await this.eval(`(() => {
      const needle = ${JSON.stringify(needle)}
      const clickable = 'a,button,[role="button"],input[type="submit"],input[type="button"],summary,label,li,td,span,div'
      const all = Array.from(document.querySelectorAll(clickable))
      const hit = all.find((e) => {
        const s = (e.innerText || e.value || '').trim()
        if (!s || !s.includes(needle)) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      if (!hit) return { ok: false, why: '页面上没有这段文字' }
      hit.scrollIntoView({ block: 'center' })
      hit.click()
      return { ok: true, what: (hit.innerText || hit.value || '').trim().slice(0, 40), tag: hit.tagName }
    })()`)

    if (!res || !res.ok) throw new Error(res && res.why ? res.why : '没找到可点的元素')
    await sleep(1200)
    return res
  }

  /** 填表单：按占位符 / label / name 找输入框 */
  async type(hint, value) {
    const res = await this.eval(`(() => {
      const hint = ${JSON.stringify(String(hint || ''))}.toLowerCase()
      const value = ${JSON.stringify(String(value ?? ''))}
      const fields = Array.from(document.querySelectorAll('input, textarea'))
        .filter((el) => !['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(el.type))

      const score = (el) => {
        const hay = [
          el.placeholder, el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('title'),
        ].filter(Boolean).join(' ').toLowerCase()
        if (hay.includes(hint)) return 3
        const lab = el.closest('label')
        if (lab && (lab.innerText || '').toLowerCase().includes(hint)) return 2
        return 0
      }

      let best = null, bestScore = 0
      for (const el of fields) {
        const s = score(el)
        if (s > bestScore) { best = el; bestScore = s }
      }
      if (!best && fields.length === 1) { best = fields[0]; bestScore = 1 }
      if (!best) return { ok: false, why: '没找到对应的输入框' }

      best.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
                      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
      setter.set.call(best, value)
      best.dispatchEvent(new Event('input', { bubbles: true }))
      best.dispatchEvent(new Event('change', { bubbles: true }))

      return { ok: true, target: best.name || best.id || best.placeholder || best.tagName }
    })()`)

    if (!res || !res.ok) throw new Error(res && res.why ? res.why : '填不进去')
    return res
  }

  /** 回车（搜索框常用的提交方式） */
  async pressEnter() {
    const page = await this.attach()
    const key = {
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    }
    await page.send('Input.dispatchKeyEvent', key)
    await page.send('Input.dispatchKeyEvent', { ...key, type: 'keyUp' })
    await sleep(1200)
    return { ok: true }
  }

  async screenshot(outPath) {
    const page = await this.attach()
    const r = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 })
    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, Buffer.from(r.data, 'base64'))
    }
    return { ok: true, path: outPath, bytes: Math.round((r.data.length * 3) / 4) }
  }

  close() {
    if (this.page) this.page.close()
    this.page = null

    // Edge 是 cmd 拉起来的，不在我们的进程树里，只能走 CDP 让它自己关。
    // 关不掉也无所谓 —— 下次启动会复用同一个实例和端口。
    fetch(`${this.base}/json/version`)
      .then((r) => r.json())
      .then((v) => {
        if (!v || !v.webSocketDebuggerUrl) return
        const b = connect(v.webSocketDebuggerUrl, this.log)
        return b.ready.then(() => b.send('Browser.close', {}, 3000)).catch(() => {})
      })
      .catch(() => { /* 没在跑 */ })

    this.child = null
  }
}

module.exports = { Browser, findEdge, DEFAULT_PORT, MAX_TEXT }
