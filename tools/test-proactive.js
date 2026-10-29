/**
 * 主动开口护栏的离线自检（不需要 Electron）
 *   node tools/test-proactive.js
 * 结果写 proactive-test.log
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { Proactive, dayKey } = require('../src/proactive')

const file = path.join(__dirname, '..', '.tmp-proactive.json')
fs.rmSync(file, { force: true })

const lines = []
const log = (...a) => lines.push(a.join(' '))
let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; log(`  PASS  ${name}`) }
  else { fail++; log(`  FAIL  ${name}  ${extra}`) }
}

const MIN = 60e3
const H = 3600e3
const at = (h, m = 0) => {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

function fresh(now) {
  const p = new Proactive(file, {}, log)
  p.state = {
    day: dayKey(new Date(now)),
    count: 0,
    mutedDay: '',
    lastSpeechAt: 0,
    lastInteractionAt: now - 50 * MIN,
    lastBreakAt: now - 30 * MIN,
  }
  return p
}

// ---------------------------------------------------------------- 1. 基本节流

log('== 1. 节流 ==')
{
  const now = at(15, 0)
  const p = fresh(now)
  p.state.lastInteractionAt = now - 10 * MIN
  check('刚聊过不说话', p.decide(now, { idleSec: 5 }) === null)
}
{
  const now = at(15, 0)
  const p = fresh(now)
  p.state.lastBreakAt = now - 80 * MIN
  const d = p.decide(now, { idleSec: 8 })
  check('坐满 75 分钟会提醒', !!d && d.reason.includes('连续'), JSON.stringify(d))
  check('提醒文案是「起来走两步」', !!d && d.text.includes('走两步'))
  const d2 = p.decide(now + MIN, { idleSec: 8 })
  check('说完马上不再说', d2 === null)
}

// ---------------------------------------------------------------- 2. 上限

log('\n== 2. 每日上限 ==')
{
  const now = at(15, 0)
  const p = fresh(now)
  p.state.count = 2
  p.state.lastBreakAt = now - 90 * MIN
  check('用满 2 次就闭嘴', p.decide(now, { idleSec: 5 }) === null)
}

// ---------------------------------------------------------------- 3. 时机

log('\n== 3. 什么时候不开口 ==')
{
  const now = at(15, 0)
  const p = fresh(now)
  p.state.lastBreakAt = now - 90 * MIN
  check('人不在（空闲 3 分钟）', p.decide(now, { idleSec: 200 }) === null)
  check('勿扰', p.decide(now, { idleSec: 5, dnd: true }) === null)
  check('全屏', p.decide(now, { idleSec: 5, fullscreen: true }) === null)
  check('正忙', p.decide(now, { idleSec: 5, busy: true }) === null)
}
{
  // 休息过 10 分钟，连续计时归零
  const now = at(15, 0)
  const p = fresh(now)
  p.state.lastBreakAt = now - 90 * MIN
  const d = p.decide(now, { idleSec: 700 })
  check('离开过就重新计时', d === null)
  check('重新计时写回了 lastBreakAt', Math.abs(p.state.lastBreakAt - now) < 1000)
}

// ---------------------------------------------------------------- 4. 静默时段

log('\n== 4. 深夜静默 ==')
{
  for (const [h, m, want] of [[23, 40, true], [3, 0, true], [7, 59, true], [8, 0, false], [14, 0, false], [23, 20, false]]) {
    const p = new Proactive(file, {}, log)
    const now = at(h, m)
    check(`${h}:${String(m).padStart(2, '0')} ${want ? '应该' : '不该'}静默`, p.isQuiet(now) === want)
  }
}
{
  const now = at(23, 50)
  const p = fresh(now)
  p.state.lastBreakAt = now - 90 * MIN
  check('深夜即使坐久了也不说话', p.decide(now, { idleSec: 5 }) === null)
}

// ---------------------------------------------------------------- 5. 嘘

log('\n== 5. 说「嘘」 ==')
{
  const now = at(15, 0)
  const p = fresh(now)
  p.state.lastBreakAt = now - 90 * MIN
  p.mute(now)
  check('嘘之后当天不再开口', p.decide(now, { idleSec: 5 }) === null)
  check('stats 反映已静音', p.stats().muted === true)
}
{
  const now = at(15, 0)
  const p = fresh(now)
  p.state.mutedDay = dayKey(new Date(now - 24 * H))
  p.state.lastBreakAt = now - 90 * MIN
  check('第二天自动解除静音', !!p.decide(now, { idleSec: 5 }))
}

// ---------------------------------------------------------------- 6. 跨天

log('\n== 6. 跨天重置 ==')
{
  const now = at(15, 0)
  const p = fresh(now)
  p.state.count = 2
  p.state.day = dayKey(new Date(now - 24 * H))
  p.state.lastBreakAt = now - 90 * MIN
  const d = p.decide(now, { idleSec: 5 })
  check('新的一天配额恢复', !!d && p.state.count === 1)
}

// ---------------------------------------------------------------- 7. 落盘

log('\n== 7. 持久化 ==')
{
  const now = at(15, 0)
  const p = fresh(now)
  p.state.lastBreakAt = now - 90 * MIN
  p.decide(now, { idleSec: 5 })
  p.save()
  const p2 = new Proactive(file, {}, log).load()
  check('重开后次数还在', p2.state.count === 1)
}

log(`\n===== ${pass} passed, ${fail} failed =====`)
fs.writeFileSync(path.join(__dirname, '..', 'proactive-test.log'), lines.join('\n') + '\n', 'utf8')
fs.rmSync(file, { force: true })
console.log(`proactive test: ${pass} passed, ${fail} failed -> proactive-test.log`)
process.exit(fail ? 1 : 0)
