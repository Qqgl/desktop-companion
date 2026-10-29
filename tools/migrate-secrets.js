/**
 * 一次性迁移：把 config.json 里的 API key 挪到机器级 secrets.json，然后把 config.json 里的值清空。
 * 全程不回显 key。
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const proj = path.join(__dirname, '..')
const cfgPath = path.join(proj, 'config.json')
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
const key = cfg.brain && cfg.brain.apiKey

if (!key) {
  console.log('config.json 里没有 key，可能已经迁移过了')
} else {
  const base = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
  const dir = path.join(base, 'desktop-companion')
  const secPath = path.join(dir, 'secrets.json')

  fs.mkdirSync(dir, { recursive: true })

  // 已存在就合并，别把别的机密冲掉
  let sec = {}
  try { sec = JSON.parse(fs.readFileSync(secPath, 'utf8')) } catch { /* 第一次 */ }
  sec.brain = { ...(sec.brain || {}), apiKey: key }
  fs.writeFileSync(secPath, JSON.stringify(sec, null, 2) + '\n', 'utf8')

  cfg.brain.apiKey = ''
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8')

  console.log('已迁移')
  console.log('  secrets.json ->', secPath, `(${fs.statSync(secPath).size} 字节)`)
  console.log('  config.json 里的 apiKey 已清空:', JSON.stringify(cfg.brain.apiKey))
}
