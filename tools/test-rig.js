/**
 * 弹簧响应的数值自检（不需要渲染，不需要 Electron）
 *   node tools/test-rig.js
 *
 * 验证：把注视方向从最左猛甩到最右，
 *   头要立刻跟上；尾巴要滞后、过冲一点点、然后在半秒左右收住。
 *
 * 注意尾巴的目标本身带一个慢摆动（idle 时的自然摇摆），
 * 所以不能拿固定值当基准，要比较「实际值 vs 当帧目标」的跟踪误差。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'rig.js'), 'utf8')
const sandbox = { window: {}, Math, console, performance: { now: () => Date.now() } }
vm.createContext(sandbox)
vm.runInContext(code, sandbox)

const Rig = sandbox.window.Rig
const rig = new Rig()
const DT = 1 / 60
const step = (n) => { for (let i = 0; i < n; i++) rig.update(DT) }

// 先在最左边稳住
rig.setLook(-1, 0)
step(240)

// 猛甩到右边
rig.setLook(1, 0)

const trace = []
for (let i = 0; i < 150; i++) {
  rig.update(DT)
  trace.push({
    ms: Math.round((i + 1) * DT * 1000),
    head: rig.headX.value, headT: rig.headX.target,
    tail: rig.tailX.value, tailT: rig.tailX.target,
  })
}

const at = (ms) => trace.find((t) => t.ms >= ms) || trace[trace.length - 1]
const lag = (t) => t.tailT - t.tail          // 尾巴落后目标多少（正数=还没跟上）
const peak = trace.reduce((a, b) => (b.tail - b.tailT > a.tail - a.tailT ? b : a))
const peakOver = peak.tail - peak.tailT

// 收住时间：从某一刻起，后续的跟踪误差都 < 0.25px
let settleAt = null
for (let i = trace.length - 1; i >= 0; i--) {
  if (Math.abs(lag(trace[i])) < 0.25) settleAt = trace[i].ms
  else break
}

console.log('  时间     头/目标        尾巴/目标       尾巴落后')
for (const ms of [50, 100, 150, 200, 300, 500, 800, 1200, 2000]) {
  const t = at(ms)
  if (!t) continue
  console.log(
    `  ${String(t.ms).padStart(4)}ms  ${t.head.toFixed(2).padStart(6)}/${t.headT.toFixed(2).padStart(5)}` +
    `   ${t.tail.toFixed(2).padStart(6)}/${t.tailT.toFixed(2).padStart(5)}` +
    `   ${lag(t) > 0.05 ? lag(t).toFixed(2).padStart(5) + 'px' : '   跟上'}`
  )
}
console.log('')
console.log(`尾巴最大过冲 ${peakOver.toFixed(2)}px，收住用时 ${settleAt}ms`)

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + '  ' + extra) }
}

const t100 = at(100)
const t200 = at(200)

check('头在 300ms 内基本到位', Math.abs(at(300).head - at(300).headT) < 0.8,
  `头 ${at(300).head.toFixed(2)} / 目标 ${at(300).headT.toFixed(2)}`)
check('100ms 时尾巴明显落后', lag(t100) > 1.5, `${lag(t100).toFixed(2)}px`)
check('尾巴有跟随惯性（过冲）', peakOver > 0.1, `${peakOver.toFixed(2)}px`)
check('过冲不夸张（< 8px）', peakOver < 8, `${peakOver.toFixed(2)}px`)
check('500ms 时尾巴已跟上（< 1px）', Math.abs(lag(at(500))) < 1, `${lag(at(500)).toFixed(2)}px`)
check('头几乎不过冲（< 0.6px）', Math.max(...trace.map((t) => t.head - t.headT)) < 0.6,
  `最大 ${Math.max(...trace.map((t) => t.head - t.headT)).toFixed(2)}px`)

// 反方向对称
rig.setLook(-1, 0)
step(300)
check('往左甩尾巴也到位', rig.tailX.value < rig.tailX.target - 0.5 || Math.abs(rig.tailX.value - rig.tailX.target) < 0.5,
  `${rig.tailX.value.toFixed(2)} / ${rig.tailX.target.toFixed(2)}`)

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
