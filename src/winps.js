/**
 * winps.js —— 跑一小段 PowerShell
 *
 * 为什么不用 execFile('powershell', ['-Command', '...'])：
 * 我们的脚本里带引号、带空格路径、带中文，命令行转义会把它啃得面目全非
 * （之前 reg add 就是这么失败的）。-EncodedCommand 传 base64，
 * 完全不经过命令行解析，怎么写都安全。
 */
'use strict'

const { execFileSync } = require('node:child_process')

function run(script, { capture = false } = {}) {
  const b64 = Buffer.from(script, 'utf16le').toString('base64')
  let out
  try {
    out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', b64],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      }
    )
  } catch (e) {
    // 把 PowerShell 自己的报错捞出来，不然只能看到一个 "Command failed"
    const err = String((e && e.stderr) || '').trim() || e.message
    throw new Error(err.split('\n').filter(Boolean).slice(0, 3).join(' | '))
  }
  return capture ? String(out || '').trim() : ''
}

/** PowerShell 单引号字符串里，单引号要写成两个 */
const q = (s) => String(s).replace(/'/g, "''")

module.exports = { run, q }
