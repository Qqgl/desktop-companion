/**
 * CDP 可行性验证：拉起一个独立的 Edge（专用配置目录），用 DevTools Protocol 打开页面并读标题。
 * 不依赖任何第三方库 —— Node 22+ 自带全局 WebSocket。
 */
'use strict'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9333
const PROFILE = path.join(os.tmpdir(), 'dc-browser-spike')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJSON(url, method = 'GET') {
  const r = await fetch(url, { method })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`)
  return r.json()
}

async function waitReady(timeoutMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await getJSON(`http://127.0.0.1:${PORT}/json/version`)
      return v
    } catch {
      await sleep(300)
    }
  }
  throw new Error('CDP 端口没起来')
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()

  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res())
    ws.addEventListener('error', (e) => rej(new Error('WS 错误: ' + (e.message || 'unknown'))))
  })

  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      pending.set(myId, { resolve, reject })
      ws.send(JSON.stringify({ id: myId, method, params }))
    })

  return { ready, send, close: () => ws.close() }
}

;(async () => {
  fs.mkdirSync(PROFILE, { recursive: true })

  console.log('启动 Edge...')
  const child = spawn(EDGE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeSidebarV2',
    'about:blank',
  ], { detached: false, stdio: 'ignore' })

  child.on('exit', (c) => console.log('Edge 退出', c))

  const ver = await waitReady()
  console.log('CDP 就绪:', ver.Browser)

  // 新建标签页（新版需要 PUT）
  let target
  try {
    target = await getJSON(`http://127.0.0.1:${PORT}/json/new?about:blank`, 'PUT')
  } catch {
    target = await getJSON(`http://127.0.0.1:${PORT}/json/new?about:blank`)
  }
  console.log('新标签:', target.id, target.type)

  const page = cdp(target.webSocketDebuggerUrl)
  await page.ready

  await page.send('Page.enable')
  await page.send('Page.navigate', { url: 'https://example.com' })
  await sleep(2500)

  const title = await page.send('Runtime.evaluate', {
    expression: 'document.title',
    returnByValue: true,
  })
  const text = await page.send('Runtime.evaluate', {
    expression: 'document.body.innerText.slice(0,200)',
    returnByValue: true,
  })
  console.log('标题:', title.result.value)
  console.log('正文:', JSON.stringify(text.result.value))
  console.log('SPIKE_OK')

  page.close()
  try { child.kill() } catch { /* 已退出 */ }
  process.exit(0)
})().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
