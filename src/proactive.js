/**
 * proactive.js —— 主动开口的护栏
 *
 * 「室友型」最难的不是会说话，是知道什么时候闭嘴。
 * 这个模块不产生内容，只做一件事：决定现在能不能开口。
 *
 * 默认极保守 ——
 *   · 每天最多 2 次
 *   · 距上次对话至少 40 分钟
 *   · 两次主动至少隔 3 小时
 *   · 23:30–08:00 完全静默
 *   · 你在全屏（游戏/会议）或勿扰时闭嘴
 *   · 你刚离开（空闲 > 2 分钟）时不说话
 *   · 说一次「嘘」，当天永久闭嘴
 *
 * 而且真的没什么可说的时候，它就不说 —— 宁可一天不吭声。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const DEFAULTS = {
  enabled: true,
  maxPerDay: 2,
  minGapMs: 40 * 60e3,        // 距上次对话
  minSpeechGapMs: 3 * 3600e3, // 距上次主动开口
  quietFrom: 23.5,            // 23:30
  quietTo: 8,                 // 08:00
  breakAfterMs: 75 * 60e3,    // 连续在电脑前 75 分钟
  awayAfterSec: 120,          // 空闲超过 2 分钟算离开
  breakIdleSec: 600,          // 空闲超过 10 分钟算休息过
}

const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

class Proactive {
  constructor(file, opts = {}, log = console.log) {
    this.file = file
    this.cfg = { ...DEFAULTS, ...opts }
    this.log = log
    this.state = {
      day: dayKey(),
      count: 0,
      mutedDay: '',       // 说「嘘」的那天
      lastSpeechAt: 0,
      lastInteractionAt: Date.now(),
      lastBreakAt: Date.now(),
    }
    this.load()
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.state = { ...this.state, ...j }
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
    } catch { /* 第一次 */ }
    return this
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 1))
    } catch (e) {
      this.log('[proactive] 保存失败:', e.message)
    }
  }

  /** 说一次「嘘」→ 当天闭嘴 */
  mute(now = Date.now()) {
    this.state.mutedDay = dayKey(new Date(now))
    this.save()
    this.log('[proactive] 用户要求闭嘴，今天不说了')
  }

  /** 每次对话都调一下，重置「多久没说话」 */
  noteInteraction(now = Date.now()) {
    this.state.lastInteractionAt = now
    this.state.lastBreakAt = now
    this.save()
  }

  isQuiet(now = Date.now()) {
    const h = new Date(now).getHours() + new Date(now).getMinutes() / 60
    const { quietFrom: f, quietTo: t } = this.cfg
    return f > t ? (h >= f || h < t) : (h >= f && h < t)
  }

  /** 跨天重置 */
  rollDay(now = Date.now()) {
    const d = dayKey(new Date(now))
    if (this.state.day !== d) {
      this.state.day = d
      this.state.count = 0
      this.save()
    }
  }

  /**
   * @param {number} now
   * @param {{idleSec:number, fullscreen?:boolean, dnd?:boolean, busy?:boolean}} ctx
   * @returns {{kind:'speak', text:string, reason:string}|null}
   */
  decide(now, ctx = {}) {
    const c = this.cfg
    if (!c.enabled) return null

    this.rollDay(now)

    const today = dayKey(new Date(now))
    if (this.state.mutedDay === today) return null

    if (ctx.dnd || ctx.fullscreen || ctx.busy) return null
    if (this.isQuiet(now)) return null

    const idle = Number(ctx.idleSec || 0)

    // 离开过 10 分钟 = 休息过了，连续计时重来
    if (idle > c.breakIdleSec) {
      this.state.lastBreakAt = now
      this.save()
      return null
    }

    // 人不在座位上，别对着空气说话
    if (idle > c.awayAfterSec) return null

    if (now - this.state.lastInteractionAt < c.minGapMs) return null
    if (now - this.state.lastSpeechAt < c.minSpeechGapMs) return null
    if (this.state.count >= c.maxPerDay) return null

    // ---- 到这儿才允许开口，而且只在真有话说的时候 ----

    const sitting = now - this.state.lastBreakAt
    if (sitting >= c.breakAfterMs) {
      return this.fire(now, '你坐了挺久了，起来走两步。', `连续 ${Math.round(sitting / 60000)} 分钟`)
    }

    const h = new Date(now).getHours()
    if (h >= 23 || h < 2) {
      return this.fire(now, '这个点了。明天再弄吧。', '深夜')
    }

    // 没有像样的理由，就不吭声。安静比搭话更像陪伴。
    return null
  }

  fire(now, text, reason) {
    this.state.count += 1
    this.state.lastSpeechAt = now
    this.save()
    return { kind: 'speak', text, reason }
  }

  stats() {
    return {
      today: this.state.count,
      max: this.cfg.maxPerDay,
      muted: this.state.mutedDay === dayKey(),
      quiet: this.isQuiet(),
    }
  }
}

module.exports = { Proactive, DEFAULTS, dayKey }
