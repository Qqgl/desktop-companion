/**
 * rig.js —— 角色的「骨架 + 神经」
 *
 * 只算状态，不画东西。所有部件的位置最终都由这里输出的数值决定，
 * 所以换立绘（占位 / 单图 / 分层）都不需要动这里。
 *
 * 核心是弹簧：头一动，头发晚半拍跟上来，这是「活」与「贴纸」的分界线。
 */
(function () {
  'use strict'

  const TAU = Math.PI * 2
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
  const lerp = (a, b, t) => a + (b - a) * t
  const easeOut = (t) => 1 - Math.pow(1 - t, 3)
  const rand = (a, b) => a + Math.random() * (b - a)

  /** 阻尼弹簧（半隐式欧拉） */
  class Spring {
    constructor({ k = 170, d = 18, v = 0 } = {}) {
      this.k = k
      this.d = d
      this.value = v
      this.target = v
      this.vel = 0
    }
    step(dt) {
      const a = (this.target - this.value) * this.k - this.vel * this.d
      this.vel += a * dt
      this.value += this.vel * dt
      return this.value
    }
  }

  /** 每个状态的「姿态目标」。切换状态时数值慢慢滑过去，不会瞬移。 */
  const POSES = {
    idle:      { lean: 0.00, tilt: 0.00, eye: 1.00, glow: 0.00, bob: 1.00 },
    listening: { lean: 0.85, tilt: -0.85, eye: 1.07, glow: 1.00, bob: 0.55 },
    thinking:  { lean: 0.30, tilt: 0.45, eye: 0.88, glow: 0.35, bob: 0.70 },
    speaking:  { lean: 0.45, tilt: 0.10, eye: 1.00, glow: 0.50, bob: 1.25 },
    quiet:     { lean: -0.55, tilt: 0.30, eye: 0.55, glow: 0.00, bob: 0.35 },
  }

  const BLINK_DUR = 0.26

  class Rig {
    constructor() {
      this.t = 0
      this.state = 'idle'

      // ---- 姿态弹簧
      this.lean = new Spring({ k: 80, d: 14 })
      this.tilt = new Spring({ k: 95, d: 15 })
      this.eyeScale = new Spring({ k: 120, d: 16, v: 1 })
      this.glow = new Spring({ k: 55, d: 12 })
      this.bobRate = new Spring({ k: 40, d: 12, v: 1 })

      // ---- 头部（跟随注视）
      this.headX = new Spring({ k: 150, d: 17 })
      this.headY = new Spring({ k: 150, d: 17 })

      // ---- 头发：刚度低、阻尼小 → 明显的滞后与回弹
      this.hairX = new Spring({ k: 42, d: 5.2 })
      this.lockL = new Spring({ k: 58, d: 6.0 })
      this.lockR = new Spring({ k: 58, d: 6.0 })
      this.ahoge = new Spring({ k: 34, d: 4.2 })

      // 尾巴 / 外侧头发：一根更软、略欠阻尼的弹簧。
      // 关键是「静止时归位、移动时滞后」——如果只是加固定位移，
      // 尾巴会永久比脸飘得更远，反而违反视差规律。
      // k=30 d=6.5 → 阻尼比 0.59，过冲约 10%，0.7 秒收住；再软就成果冻了。
      this.tailX = new Spring({ k: 30, d: 6.5 })
      // 尾巴的独立摆角（度）。k 刻意压得很低：一根有重量的尾巴，
      // 应该比头慢 150ms 左右才轮到它跟上，快了就像贴纸。
      this.tailAngle = new Spring({ k: 13, d: 3.2 })

      // ---- 表情
      this.eyeOpen = 1
      this.mouthOpen = 0
      this.speakLevel = 0
      this.listenLevel = 0     // 麦克风输入电平，用来让光晕跟着你的声音呼吸

      // ---- 注视
      this.look = { x: 0, y: 0 }          // 目标，-1..1
      this.pupil = { x: 0, y: 0 }         // 平滑后
      this.lookIdleAt = 0                 // 鼠标静止多久了
      this.idleLook = { x: 0, y: 0 }

      // ---- 眨眼
      this.blinkActive = false
      this.blinkPhase = 0
      this.blinkChain = 0
      this.nextBlinkAt = rand(1.6, 3.4)

      // ---- 呼吸 / 漂浮 / 微颤
      this.breath = 0
      this.floatY = 0
      this.jitter = { x: 0, y: 0 }

      this.setPoseTargets('idle', true)
    }

    setState(name) {
      if (!POSES[name] || name === this.state) return
      this.state = name
      this.setPoseTargets(name, false)
      if (name === 'quiet') this.nextBlinkAt = this.t + rand(1.2, 2.0)
    }

    setPoseTargets(name, immediate) {
      const p = POSES[name] || POSES.idle
      this.lean.target = p.lean
      this.tilt.target = p.tilt
      this.eyeScale.target = p.eye
      this.glow.target = p.glow
      this.bobRate.target = p.bob
      if (immediate) {
        for (const s of [this.lean, this.tilt, this.eyeScale, this.glow, this.bobRate]) {
          s.value = s.target
          s.vel = 0
        }
      }
    }

    /** 外部（鼠标 / 后续的头像追踪）驱动注视 */
    setLook(x, y) {
      this.look.x = clamp(x, -1, 1)
      this.look.y = clamp(y, -1, 1)
      this.lookIdleAt = 0
    }

    update(dt) {
      this.t += dt
      const t = this.t

      // ---------- 注视平滑：鼠标不动时让他自己随便看看 ----------
      this.lookIdleAt += dt
      if (this.lookIdleAt > 3.5) {
        const wander = 0.55
        const nx = Math.sin(t * 0.55) * wander
        const ny = Math.sin(t * 0.37 + 1.7) * 0.35
        this.idleLook.x = lerp(this.idleLook.x, nx, 1 - Math.exp(-dt * 0.9))
        this.idleLook.y = lerp(this.idleLook.y, ny, 1 - Math.exp(-dt * 0.9))
      } else {
        this.idleLook.x = lerp(this.idleLook.x, this.look.x, 1 - Math.exp(-dt * 3))
        this.idleLook.y = lerp(this.idleLook.y, this.look.y, 1 - Math.exp(-dt * 3))
      }
      const lx = this.lookIdleAt > 3.5 ? this.idleLook.x : this.look.x
      const ly = this.lookIdleAt > 3.5 ? this.idleLook.y : this.look.y
      this.pupil.x = lerp(this.pupil.x, lx, 1 - Math.exp(-dt * 9))
      this.pupil.y = lerp(this.pupil.y, ly, 1 - Math.exp(-dt * 9))

      // ---------- 姿态 ----------
      this.lean.step(dt)
      this.tilt.step(dt)
      this.eyeScale.step(dt)
      this.glow.step(dt)
      this.bobRate.step(dt)

      const bob = this.bobRate.value

      // 呼吸：吸气比呼气快一点，用非对称曲线更像活物
      const raw = (Math.sin(t * TAU / 4.2 * bob) + 1) / 2
      this.breath = Math.pow(raw, 1.35) * 2 - 1

      // 漂浮：聆听时几乎不动，说话时起伏大一点
      const floatAmp = this.state === 'listening' ? 1.1 : 2.6
      this.floatY = Math.sin(t * TAU / (5.6 / bob)) * floatAmp + 2.2 + this.lean.value * 1.6

      // 思考时的高频微颤
      if (this.state === 'thinking') {
        this.jitter.x = Math.sin(t * 21.7) * 0.55
        this.jitter.y = Math.cos(t * 18.3) * 0.4
      } else {
        this.jitter.x = lerp(this.jitter.x, 0, 1 - Math.exp(-dt * 6))
        this.jitter.y = lerp(this.jitter.y, 0, 1 - Math.exp(-dt * 6))
      }

      // ---------- 头部跟随 ----------
      const lookGain = this.state === 'listening' ? 7.5 : 6.5
      this.headX.target = lx * lookGain + this.jitter.x
      this.headY.target = ly * 3.2 + this.jitter.y + this.lean.value * 1.2
      this.headX.step(dt)
      this.headY.step(dt)

      // ---------- 头发：滞后 + 跟随 ----------
      // 目标取头部位置的放大值，刚度低 → 天然滞后半拍
      this.hairX.target = lx * 5.0
      this.lockL.target = lx * 9.0 - this.tilt.value * 6
      this.lockR.target = lx * 4.0 - this.tilt.value * 6
      this.ahoge.target = lx * 11.5 + Math.sin(t * 2.3) * 1.4
      this.tailX.target = lx * 4.6 + Math.sin(t * 1.7 + 1.1) * 0.8
      // 尾巴的摆角（度）。刚度刻意比 hairX 更低：它比整个人慢半拍，
      // 才会有"重量"感；跟随方向与头部相反，因为尾巴拖在后面。
      this.tailAngle.target =
        -lx * 2.6 +
        Math.sin(t * 1.15 + 0.6) * 1.15 +
        Math.sin(t * 0.43) * 0.5
      this.hairX.step(dt)
      this.lockL.step(dt)
      this.lockR.step(dt)
      this.ahoge.step(dt)
      this.tailX.step(dt)
      this.tailAngle.step(dt)

      // ---------- 眨眼 ----------
      this.updateBlink(dt)

      // ---------- 嘴 ----------
      let mouthTarget = 0
      if (this.state === 'speaking') {
        if (this.speakLevel > 0.02) {
          // 有真实音频包络就直接用，口型跟着声音走
          mouthTarget = this.speakLevel
        } else {
          // 没有声音（静音模式/合成失败）时用伪音节，至少嘴在动
          const syllable = Math.sin(t * 11.3) * 0.5 + 0.5
          const gate = Math.sin(t * 3.1) > -0.35 ? 1 : 0.12
          mouthTarget = (0.18 + syllable * 0.75) * gate
        }
      } else if (this.state === 'listening') {
        mouthTarget = 0.06
      }
      this.mouthOpen = lerp(this.mouthOpen, clamp(mouthTarget, 0, 1), 1 - Math.exp(-dt * 22))
    }

    updateBlink(dt) {
      if (!this.blinkActive && this.t >= this.nextBlinkAt) {
        this.blinkActive = true
        this.blinkPhase = 0
        // 20% 概率连眨两下
        this.blinkChain = Math.random() < 0.2 ? 1 : 0
      }

      if (this.blinkActive) {
        this.blinkPhase += dt
        const p = this.blinkPhase / BLINK_DUR
        let open
        if (p < 0.34) open = 1 - easeOut(p / 0.34) * 0.96
        else if (p < 0.52) open = 0.04
        else if (p < 1) open = 0.04 + easeOut((p - 0.52) / 0.48) * 0.96
        else open = 1

        if (p >= 1) {
          this.blinkActive = false
          if (this.blinkChain > 0) {
            this.blinkChain--
            this.nextBlinkAt = this.t + 0.12
          } else {
            const sleepy = this.state === 'quiet'
            this.nextBlinkAt = this.t + rand(sleepy ? 2.2 : 3.0, sleepy ? 4.5 : 7.0)
          }
        }
        this.eyeOpen = open
      } else {
        this.eyeOpen = lerp(this.eyeOpen, 1, 1 - Math.exp(-dt * 18))
      }

      // 打盹时半闭眼
      if (this.state === 'quiet') {
        this.eyeOpen *= 0.62
      }
      this.eyeOpen = clamp(this.eyeOpen, 0.02, 1) * this.eyeScale.value
    }
  }

  window.Rig = Rig
  window.Spring = Spring
})()
