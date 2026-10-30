/**
 * 验证 Electron 的 Node 环境里 WebSocket 能不能用（连 CDP 并收回复）。
 * 用法：先用 Edge 起一个调试端口，再在 Electron 下跑这个。
 */
'use strict'

const PORT = Number(process.env.CDP_PORT || 9355)
const base = `http://127.0.0.1:${PORT}`

;(async () => {
  console.log('node', process.versions.node, '| electron', process.versions.electron || '(无)')
  console.log('WebSocket 类型:', typeof WebSocket)

  const list = await (await fetch(base + '/json/list')).json()
  const t = list.find((x) => x.type === 'page')
  if (!t) throw new Error('没有 page target')

  const ws = new WebSocket(t.webSocketDebuggerUrl)
  const events = []

  ws.addEventListener('open', () => console.log('WS open'))
  ws.addEventListener('close', (e) => console.log('WS close', e.code, e.reason))
  ws.addEventListener('error', () => console.log('WS error'))
  ws.addEventListener('message', (ev) => {
    const type = typeof ev.data
    const ctor = ev.data && ev.data.constructor && ev.data.constructor.name
    events.push({ type, ctor, len: ev.data && (ev.data.length || ev.data.byteLength) })
    console.log('message:', type, ctor, 'len=', ev.data && (ev.data.length || ev.data.byteLength))
  })

  await new Promise((r, j) => {
    ws.addEventListener('open', r)
    ws.addEventListener('error', () => j(new Error('open 失败')))
    setTimeout(() => j(new Error('open 超时')), 5000)
  })

  ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }))
  console.log('已发送 Page.enable')

  await new Promise((r) => setTimeout(r, 4000))
  console.log('收到事件数:', events.length)
  console.log(events.length ? 'WS_OK' : 'WS_NO_REPLY')
  ws.close()
  process.exit(0)
})().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
