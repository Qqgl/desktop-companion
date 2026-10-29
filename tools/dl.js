/**
 * 下载模型权重。PowerShell 的 TLS 栈在这台机器上拿不到凭证、curl 的 schannel 也一样，
 * 但 Node 自带的 fetch（OpenSSL + 自己的 CA 包）能过。
 *
 *   node tools/dl.js <url> <输出路径>
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const url = process.argv[2]
const out = process.argv[3]

if (!url || !out) {
  console.error('用法: node tools/dl.js <url> <输出路径>')
  process.exit(2)
}

;(async () => {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })

  const t0 = Date.now()
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText}`)
    process.exit(1)
  }

  const total = Number(res.headers.get('content-length') || 0)
  let got = 0
  let lastPrint = 0

  const src = Readable.fromWeb(res.body)
  src.on('data', (chunk) => {
    got += chunk.length
    const now = Date.now()
    if (now - lastPrint > 2000) {
      lastPrint = now
      const pct = total ? ((got / total) * 100).toFixed(1) + '%' : ''
      const mb = (got / 1048576).toFixed(1)
      console.log(`  ${mb} MB ${pct}`)
    }
  })

  await pipeline(src, fs.createWriteStream(out))

  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`done: ${out}  ${(got / 1048576).toFixed(1)} MB in ${secs}s`)
})().catch((e) => {
  console.error('下载失败:', e.message)
  process.exit(1)
})
