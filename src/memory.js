/**
 * memory.js —— 记忆
 *
 * 三层，跟人差不多：
 *   1. 短期：本次会话最近几轮（brain.js 里维护）
 *   2. 情节：所有对话按时间存成 jsonl，可以翻旧账
 *   3. 事实：从对话里抽出来的「关于你」的句子，带权重
 *
 * 检索用的是字符二元组重合度 + 时间衰减，不是向量库。
 * 理由很实际：记忆量在几百条这个量级，向量检索是杀鸡用牛刀，
 * 而且上向量就等于上原生依赖，这台机器装不动。
 *
 * 存储是纯文本（jsonl + json），可以直接打开看、直接删。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MAX_TURNS = 400
const MAX_FACTS = 120
const RELEVANCE_MIN = 0.12
const DAY = 86400e3

// ------------------------------------------------------------ 文本相似度

/** 中文按二元组切，英文/数字按词切 */
function shingles(text) {
  const s = String(text || '')
  const set = new Set()
  const cjk = s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  for (let i = 0; i < cjk.length - 1; i++) set.add(cjk.slice(i, i + 2))
  const words = s.toLowerCase().match(/[a-z0-9_]{2,}/g) || []
  for (const w of words) set.add(w)
  return set
}

/** 余弦式的重合度，0~1 */
function similarity(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / Math.sqrt(a.size * b.size)
}

const oneLine = (s, n = 60) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

// 「你就叫音乐」「你的名字叫银月」「以后叫你小银」这类断言
// 「名字」两个字可有可无 —— 中文里「你就叫X」比「你的名字叫X」更常见
const NAME_ASSERT = /(?:你|她的?)(?:的)?(?:名字?)?\s*(?:就)?\s*(?:是|叫|改叫|改成)\s*[「"'“]?([\u4e00-\u9fa5A-Za-z0-9]{1,8})/
// 她自己说话时会用「我」，所以助手那一侧单独放开这个代词
const NAME_ASSERT_SELF = /(?:我|你|她的?)(?:的)?(?:名字?)?\s*(?:就)?\s*(?:是|叫|改叫|改成)\s*[「"'“]?([\u4e00-\u9fa5A-Za-z0-9]{1,8})/
const QUESTION_WORD = /什么|啥|谁|哪|怎么|多少|怎样|如何|吗|呢/

// ------------------------------------------------------------ 事实抽取

/**
 * 从用户说的话里抽「可记住」的事。
 * 刻意保守：宁可漏，也不要把废话塞进记忆里 —— 记忆里全是垃圾，
 * 比没有记忆更像智障。
 */
const EXTRACTORS = [
  { re: /我叫\s*([^\s，。！？,!?]{1,12})/, make: (m) => ({ text: `用户叫 ${m[1]}`, tags: ['profile'], weight: 3 }) },
  { re: /我(?:是|在)\s*([^\s，。！？,!?]{1,10})(?:工作|上班|读书|上学)/, make: (m) => ({ text: `用户在${m[1]}工作`, tags: ['profile'], weight: 2 }) },
  { re: /我(?:很|超|特别)?(?:喜欢|爱)\s*([^，。！？,!?]{1,20})/, make: (m) => ({ text: `用户喜欢 ${m[1].trim()}`, tags: ['pref'], weight: 2 }) },
  { re: /我(?:很|超|特别)?(?:讨厌|不喜欢|受不了)\s*([^，。！？,!?]{1,20})/, make: (m) => ({ text: `用户不喜欢 ${m[1].trim()}`, tags: ['pref'], weight: 2 }) },
  { re: /我(?:在做|在搞|在开发|在写)\s*([^，。！？,!?]{1,24})/, make: (m) => ({ text: `用户在做 ${m[1].trim()}`, tags: ['project'], weight: 3 }) },
  { re: /记住[：:，,\s]*([\s\S]{2,80})/, make: (m) => ({ text: oneLine(m[1], 60), tags: ['explicit'], weight: 5 }) },
]

/** 疑问词/占位词：抽出来的东西要是长这样，说明抽歪了，宁可不要 */
const BAD_CAPTURE = /什么|啥|谁|哪|多少|怎么|怎样|如何|吗|呢|[？?]/

function extractFacts(text) {
  const out = []
  for (const ex of EXTRACTORS) {
    const m = String(text || '').match(ex.re)
    if (!m) continue
    const f = ex.make(m)
    if (!f.text || f.text.length < 4) continue
    // 「你还记得我叫什么吗」会把「什么吗」抓成名字 —— 用户明确要求记住的除外
    const isExplicit = (f.tags || []).includes('explicit')
    if (!isExplicit && BAD_CAPTURE.test(f.text)) continue
    out.push(f)
  }
  return out
}

// ------------------------------------------------------------ Memory

class Memory {
  constructor(dir, log = console.log) {
    this.dir = dir
    this.log = log
    this.turns = []
    this.facts = []
    this.meta = { firstSeen: 0, lastSeen: 0, sessions: 0, lastTopic: '' }
    this._saveTimer = null
    this._dirty = false
  }

  // ---------------- 持久化 ----------------

  file(name) { return path.join(this.dir, name) }

  load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
    } catch { /* 已经存在 */ }

    try {
      const raw = fs.readFileSync(this.file('meta.json'), 'utf8')
      this.meta = { ...this.meta, ...JSON.parse(raw) }
    } catch { /* 第一次 */ }

    try {
      const raw = fs.readFileSync(this.file('facts.json'), 'utf8')
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) this.facts = arr.filter((f) => f && f.text)
    } catch { /* 没有 */ }

    try {
      const raw = fs.readFileSync(this.file('turns.jsonl'), 'utf8')
      this.turns = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line) } catch { return null }
        })
        .filter(Boolean)
    } catch { /* 没有 */ }

    const now = Date.now()
    if (!this.meta.firstSeen) this.meta.firstSeen = now
    this.meta.sessions = (this.meta.sessions || 0) + 1
    this.gapMs = this.meta.lastSeen ? now - this.meta.lastSeen : 0
    this.meta.lastSeen = now

    this.log(`[memory] 载入 ${this.turns.length} 轮对话 / ${this.facts.length} 条事实 / 第 ${this.meta.sessions} 次见面`)
    return this
  }

  markDirty() {
    this._dirty = true
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      if (this._dirty) this.flush()
    }, 1200)
  }

  flush() {
    this._dirty = false
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      this.trim()
      fs.writeFileSync(this.file('facts.json'), JSON.stringify(this.facts, null, 1))
      fs.writeFileSync(this.file('turns.jsonl'), this.turns.map((t) => JSON.stringify(t)).join('\n') + '\n')
      fs.writeFileSync(this.file('meta.json'), JSON.stringify(this.meta, null, 1))
    } catch (e) {
      this.log('[memory] 写入失败:', e.message)
    }
  }

  trim() {
    if (this.turns.length > MAX_TURNS) this.turns = this.turns.slice(-MAX_TURNS)
    if (this.facts.length > MAX_FACTS) {
      // 留权重高、时间新的
      this.facts.sort((a, b) => (b.weight || 1) * 1e6 + b.ts - ((a.weight || 1) * 1e6 + a.ts))
      this.facts = this.facts.slice(0, MAX_FACTS)
    }
  }

  // ---------------- 写入 ----------------

  addTurn(role, text) {
    const t = String(text || '').trim()
    if (!t) return
    this.turns.push({ ts: Date.now(), role, text: oneLine(t, 400) })
    if (role === 'user') this.meta.lastTopic = oneLine(t, 80)
    this.markDirty()
  }

  /** @returns {number} 新记住几条 */
  learn(userText) {
    const found = extractFacts(userText)
    let added = 0
    for (const f of found) {
      this.addFact(f.text, f)
      added++
    }
    return added
  }

  addFact(text, { tags = [], weight = 1 } = {}) {
    const now = Date.now()
    const sh = shingles(text)

    // 已经记过类似的，就更新时间和权重，不重复存
    for (const f of this.facts) {
      if (similarity(sh, shingles(f.text)) > 0.82) {
        f.ts = now
        f.weight = Math.max(f.weight || 1, weight)
        f.hits = (f.hits || 0) + 1
        this.markDirty()
        return f
      }
    }

    const f = { id: `f${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, tags, weight, ts: now, hits: 0 }
    this.facts.push(f)
    this.markDirty()
    return f
  }

  // ---------------- 检索 ----------------

  /**
   * 按当前话题挑最相关的事实。
   *
   * 打分不是「共现多少个二元组」，而是「这句话里**有意义的词**被命中了多少」：
   * 先把只出现在记忆里、没出现在记忆里的查询词分开，只用有意义的那些算覆盖率。
   * 否则中文短句里那些虚词会把分母撑爆，明明该想起「喜欢二次元」也捞不上来。
   *
   * profile 类（名字、职业）总是带上，因为几乎任何对话都用得上。
   */
  recall(query, k = 5) {
    if (!this.facts.length) return []

    const q = shingles(query)
    const now = Date.now()

    // 文档频率：哪些词是「记忆里真的存在」的
    const factSets = this.facts.map((f) => shingles(f.text))
    const df = new Map()
    for (const s of factSets) for (const t of s) df.set(t, (df.get(t) || 0) + 1)

    const meaningful = [...q].filter((t) => df.has(t))
    // 只命中一个词就全算对，太便宜了；用词数做阻尼
    const damp = Math.min(1, meaningful.length / 3)

    const scored = this.facts.map((f, i) => {
      const set = factSets[i]
      const matched = meaningful.filter((t) => set.has(t)).length
      const coverage = meaningful.length ? matched / meaningful.length : 0
      const rel = coverage * damp

      const ageDays = (now - (f.ts || now)) / DAY
      const freshness = Math.exp(-ageDays / 45)
      const tags = f.tags || []
      const base = tags.includes('profile') ? 0.35 : 0
      const score = rel * 2 + (f.weight || 1) * 0.12 + freshness * 0.25 + base

      return { f, score, rel, tags }
    })

    return scored
      .filter((s) => s.rel > RELEVANCE_MIN || s.tags.includes('profile') || s.tags.includes('explicit'))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((s) => s.f)
  }

  /** 最近几轮里，用户说过的话（跨会话用） */
  recentUserTurns(n = 2, skipLast = 0) {
    const users = this.turns.filter((t) => t.role === 'user')
    const end = users.length - skipLast
    return users.slice(Math.max(0, end - n), end)
  }

  // ---------------- 改名 ----------------

  /**
   * 名字变了就把旧称呼相关的记忆清掉。
   *
   * 为什么需要这个：跟她说过「你就叫音乐」之后，那句话会作为「明确指令」存进事实、
   * 也会留在对话历史里。等你把配置改成「银月」，她就会在两种说法之间反复横跳 ——
   * 系统提示说银月，记忆里却一直有人叫她音乐。
   *
   * @returns {{changed:boolean, from?:string, to?:string, facts?:number, turns?:number}}
   */
  syncPersonaName(name) {
    const clean = String(name || '').trim()
    if (!clean) return { changed: false }

    const prev = this.meta.personaName || ''
    if (prev === clean) return { changed: false }

    this.meta.personaName = clean

    // 注意：prev 为空也要清。
    // 「先在对话里随口起个名，之后才在 config 里正式定名」是最常见的路径，
    // 这时候 prev 是空的，但记忆里已经有旧名字了。
    const r = this.purgeNameConflicts(clean)
    this.markDirty()
    return { changed: true, from: prev, to: clean, facts: r.facts, turns: r.turns }
  }

  /** 删掉「叫她别的名字」的事实和对话 */
  purgeNameConflicts(newName) {
    const claimOf = (text, allowSelf) => {
      const m = String(text || '').match(allowSelf ? NAME_ASSERT_SELF : NAME_ASSERT)
      if (!m) return null
      const claimed = m[1].trim()
      if (QUESTION_WORD.test(claimed)) return null   // 疑问句不算
      return claimed
    }
    const isStale = (text, allowSelf) => {
      const c = claimOf(text, allowSelf)
      return !!c && c !== newName
    }

    // 事实都是「用户……」的第三人称记录，只认「你/她」的说法
    const f0 = this.facts.length
    this.facts = this.facts.filter((f) => !isStale(f.text, false))

    // 对话里：用户说的只认「你」，她自己说的才认「我」
    // （否则「我叫小周」这种用户自我介绍会被误删）
    const t0 = this.turns.length
    this.turns = this.turns.filter((t) => !isStale(t.text, t.role === 'assistant'))

    return { facts: f0 - this.facts.length, turns: t0 - this.turns.length }
  }

  /** 给大脑拼一段上下文。没有值得说的就返回空串，别硬凑。 */
  buildContext(query, { maxChars = 700 } = {}) {
    const facts = this.recall(query, 5)
    const lines = []

    if (facts.length) {
      lines.push('【你记得关于 ta 的事】')
      for (const f of facts) lines.push(`- ${f.text}`)
    }

    const older = this.turns.length > 6 ? this.recentUserTurns(2, 2) : []
    if (older.length) {
      lines.push('【之前聊过】')
      for (const t of older) lines.push(`- ${oneLine(t.text, 40)}（${relTime(t.ts)}）`)
    }

    if (!lines.length) return ''

    let out = lines.join('\n')
    if (out.length > maxChars) out = out.slice(0, maxChars) + '…'
    return out + '\n（自然地带出来就好，不要逐条复述，也别假装记得没提过的事。）'
  }

  // ---------------- 见面打招呼 ----------------

  /** 隔了一段时间再见面，用它记得的东西开个头。没有就不出声。 */
  greeting(now = Date.now()) {
    const gap = now - (this.meta.lastSeen || now)
    if (gap < 5 * 3600e3) return null

    const days = Math.round(gap / DAY * 10) / 10
    const topic = this.meta.lastTopic
    const nameFact = this.facts.find((f) => /用户叫/.test(f.text))
    const who = nameFact ? nameFact.text.replace('用户叫', '').trim() : ''

    if (days >= 3 && topic) {
      return `${who ? who + '，' : ''}好久不见。上次你说「${oneLine(topic, 18)}」，后来怎么样了？`
    }
    if (topic) return `${who ? who + '，' : ''}你回来了。刚才还在想你那句「${oneLine(topic, 16)}」。`
    return `${who ? who + '，' : ''}你回来了。`
  }

  stats() {
    return {
      turns: this.turns.length,
      facts: this.facts.length,
      sessions: this.meta.sessions || 0,
      firstSeen: this.meta.firstSeen || 0,
      lastSeen: this.meta.lastSeen || 0,
      topFacts: this.facts.slice(-6).map((f) => f.text),
    }
  }

  /** 忘掉一切（用户要求时） */
  clear() {
    this.turns = []
    this.facts = []
    this.meta = { firstSeen: Date.now(), lastSeen: Date.now(), sessions: 1, lastTopic: '' }
    this.flush()
  }
}

function relTime(ts) {
  const d = Date.now() - ts
  if (d < 3600e3) return `${Math.max(1, Math.round(d / 60e3))} 分钟前`
  if (d < DAY) return `${Math.round(d / 3600e3)} 小时前`
  return `${Math.round(d / DAY)} 天前`
}

module.exports = { Memory, extractFacts, similarity, shingles, relTime }
