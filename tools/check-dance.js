// 律动的数值体检：平滑度 + 滞后（用基频相位量，互相关在近反相时会测反）
const vm = require('vm'), fs = require('fs')
const ctx = { window: {}, console, Math, Date, performance: { now: () => Date.now() } }
ctx.globalThis = ctx
vm.createContext(ctx)
vm.runInContext(fs.readFileSync('src/renderer/rig.js', 'utf8'), ctx)
const Rig = ctx.window.Rig || ctx.Rig

const BPM = Number(process.argv[2]) || 88
const rig = new Rig()
rig.update(1 / 60)
rig.startDance({ bpm: BPM, seconds: 60 })

const dt = 1 / 60
const y = [], hx = [], tl = [], tilt = []
for (let i = 0; i < 900; i++) {
  rig.update(dt)
  y.push(rig.floatY)
  hx.push(rig.headX.value)
  tl.push(rig.tailAngleOut)
  tilt.push(rig.lockL.value)
}

let maxD2 = 0
for (let i = 1; i < y.length - 1; i++) {
  const d2 = Math.abs(y[i + 1] - 2 * y[i] + y[i - 1])
  if (d2 > maxD2) maxD2 = d2
}
const range = (a) => Math.max(...a) - Math.min(...a)

/** 在给定频率上取 DFT 相位（弧度） */
function phaseAt(arr, freq, from = 200, to = 800) {
  let re = 0, im = 0
  for (let i = from; i < to; i++) {
    const a = (2 * Math.PI * freq * i) / 60
    re += arr[i] * Math.cos(a)
    im -= arr[i] * Math.sin(a)
  }
  return { phase: Math.atan2(im, re), mag: Math.hypot(re, im) }
}

const fBeat = BPM / 60          // 每拍一次的起伏
const fSway = BPM / 120         // 两拍一次的重心

const headPhase = phaseAt(hx, fSway)
const tailPhase = phaseAt(tl, fSway)
// 相位差 → 时间差（负相位差表示落后）
let dphi = headPhase.phase - tailPhase.phase
while (dphi > Math.PI) dphi -= 2 * Math.PI
while (dphi < -Math.PI) dphi += 2 * Math.PI
const lagMs = (dphi / (2 * Math.PI * fSway)) * 1000

const dipPhase = phaseAt(y, fBeat)
const tiltPhase = phaseAt(tilt, fSway)

console.log(`BPM ${BPM}，一拍 ${Math.round(60000 / BPM)}ms`)
console.log('上下幅度:', range(y).toFixed(1) + 'px', '| 每帧最大二阶差分:', maxD2.toFixed(4), '(越小越顺)')
console.log('左右幅度:', range(hx).toFixed(1) + 'px | 尾巴:', range(tl).toFixed(1) + '° | 头发:', range(tilt).toFixed(1))
console.log('尾巴落后重心:', Math.round(lagMs) + 'ms', `(${(Math.abs(lagMs) / (60000 / BPM)).toFixed(2)} 拍)`)
console.log('上下起伏主频:', fBeat.toFixed(2) + 'Hz', '幅度', (dipPhase.mag / 300).toFixed(1), '| 重心主频:', fSway.toFixed(2) + 'Hz', '幅度', (headPhase.mag / 300).toFixed(1))
