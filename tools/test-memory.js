/**
 * 记忆模块的离线自检（不需要 Electron）
 *   node tools/test-memory.js
 * 结果写到 memory-test.log（UTF-8，避免控制台编码把中文搞成乱码）
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { Memory, extractFacts, similarity, shingles } = require('../src/memory')

const dir = path.join(__dirname, '..', '.tmp-memory-test')
fs.rmSync(dir, { recursive: true, force: true })

const lines = []
const log = (...a) => lines.push(a.join(' '))
let pass = 0
let fail = 0

function check(name, cond, extra = '') {
  if (cond) { pass++; log(`  PASS  ${name}`) }
  else { fail++; log(`  FAIL  ${name} ${extra}`) }
}

// ---------------------------------------------------------------- 1. 抽取

log('== 1. 事实抽取 ==')
const cases = [
  ['我叫小周', '用户叫 小周'],
  ['我在字节工作', '在字节'],
  ['我特别喜欢二次元立绘', '用户喜欢'],
  ['我讨厌别人叫我老板', '用户不喜欢'],
  ['我在做桌面AI助手这个项目', '用户在做'],
  ['记住：我周一到周四晚上有空', '周一到周四'],
  ['今天天气不错', null],
  ['这个函数为什么一直报错', null],
  ['你还记得我叫什么吗？', null],
  ['你知道我喜欢什么吗', null],
]

for (const [text, expect] of cases) {
  const facts = extractFacts(text)
  const joined = facts.map((f) => f.text).join(' | ')
  if (expect === null) {
    check(`「${text}」不该被记住`, facts.length === 0, `得到: ${joined}`)
  } else {
    check(`「${text}」→ 记住「${expect}」`, joined.includes(expect), `得到: ${joined}`)
  }
}

// ---------------------------------------------------------------- 2. 相似度

log('\n== 2. 相似度 ==')
const a = shingles('用户喜欢二次元立绘')
check('同一句相似度接近 1', similarity(a, shingles('用户喜欢二次元立绘')) > 0.99)
check('相近句相似度偏高', similarity(a, shingles('用户非常喜欢二次元立绘')) > 0.4)
check('无关句相似度接近 0', similarity(a, shingles('明天要下雨了记得带伞')) < 0.1)

// ---------------------------------------------------------------- 3. 学习与检索

log('\n== 3. 学习与检索 ==')
const m = new Memory(dir, log).load()

const convo = [
  ['user', '我叫小周'],
  ['assistant', '小周。记住了。'],
  ['user', '我在做桌面AI助手，卡在分层那步'],
  ['assistant', '分层确实烦。'],
  ['user', '我特别喜欢二次元立绘，尤其是白毛的'],
  ['assistant', '白毛控。'],
  ['user', '我讨厌别人叫我老板'],
  ['assistant', '行，不叫。'],
  ['user', '今天好累'],
]
for (const [role, text] of convo) {
  m.addTurn(role, text)
  if (role === 'user') m.learn(text)
}

log(`  学到 ${m.facts.length} 条事实:`)
for (const f of m.facts) log(`    - ${f.text}  (weight=${f.weight}, tags=${f.tags.join(',')})`)
check('事实数量合理（不多不少）', m.facts.length >= 3 && m.facts.length <= 5, `实际 ${m.facts.length}`)

log('\n  recall("你还记得我喜欢什么吗")')
const r1 = m.recall('你还记得我喜欢什么吗')
r1.forEach((f) => log(`    · ${f.text}`))
check('能想起「喜欢二次元」', r1.some((f) => f.text.includes('喜欢') && f.text.includes('二次元')))
check('名字这类 profile 总会被带出来', r1.some((f) => f.text.includes('小周')))

log('\n  recall("老板今天又催进度了")')
const r2 = m.recall('老板今天又催进度了')
r2.forEach((f) => log(`    · ${f.text}`))
check('聊到老板能想起「不喜欢被叫老板」', r2.some((f) => f.text.includes('老板')))

log('\n  recall("今天晚饭吃什么")（无关话题）')
const r3 = m.recall('今天晚饭吃什么')
r3.forEach((f) => log(`    · ${f.text}`))
check('无关话题不该翻出一堆记忆', r3.length <= 3, `实际 ${r3.length}`)

// ---------------------------------------------------------------- 4. 上下文拼装

log('\n== 4. buildContext ==')
const ctx = m.buildContext('你还记得我喜欢什么吗')
log(ctx)
check('包含记忆段落', ctx.includes('【你记得关于 ta 的事】'))
check('包含之前聊过的内容', ctx.includes('【之前聊过】'))
check('长度受控', ctx.length < 800, `${ctx.length} 字`)

const empty = new Memory(path.join(dir, 'empty'), log).load()
check('没有记忆时返回空串（不硬凑）', empty.buildContext('你好') === '')

// ---------------------------------------------------------------- 5. 持久化

log('\n== 5. 持久化 ==')
m.flush()
const m2 = new Memory(dir, log).load()
check('重开后对话还在', m2.turns.length === m.turns.length)
check('重开后事实还在', m2.facts.length === m.facts.length)
check('重开后事实内容一致', m2.facts.map((f) => f.text).join() === m.facts.map((f) => f.text).join())

// ---------------------------------------------------------------- 6. 打招呼

log('\n== 6. 隔了很久再见面 ==')
const now = Date.now()
m2.meta.lastSeen = now - 3 * 86400e3
const g = m2.greeting(now)
log(`  greeting -> ${g}`)
check('隔三天会提上次的话题', !!g && g.includes('上次'))
check('会带上名字', !!g && g.includes('小周'))

m2.meta.lastSeen = now - 60e3
check('刚离开一分钟就不啰嗦', m2.greeting(now) === null)

// ---------------------------------------------------------------- 7. 遗忘

log('\n== 7. 忘掉 ==')
m2.clear()
check('clear 后对话清空', m2.turns.length === 0)
check('clear 后事实清空', m2.facts.length === 0)
const m3 = new Memory(dir, log).load()
check('clear 落盘了', m3.facts.length === 0 && m3.turns.length === 0)

// ---------------------------------------------------------------- 8. 改名

log('\n== 8. 改名时清理旧称呼 ==')
{
  const d2 = path.join(dir, 'rename')
  const m = new Memory(d2, log).load()

  // 场景：先在对话里随口起了名，之后才在 config 里正式定名
  m.addTurn('user', '以后你的名字就叫银月，银是金银的银')
  m.addFact('以后你的名字就叫银月', { tags: ['explicit'], weight: 5 })
  m.addTurn('user', '你记住以后你不是什么图片，你就叫音乐。')
  m.addFact('以后你就叫音乐', { tags: ['explicit'], weight: 5 })
  m.addTurn('assistant', '行，那我就叫音乐。')
  m.addTurn('user', '你叫什么？')          // 疑问句，不该被当成改名

  check('清理前有 2 条命名事实', m.facts.length === 2, `实际 ${m.facts.length}`)
  check('清理前有 4 轮对话', m.turns.length === 4, `实际 ${m.turns.length}`)

  const r = m.syncPersonaName('小银')
  log(`  改名结果: ${JSON.stringify(r)}`)
  check('识别出改名', r.changed === true)
  check('清掉了旧名字的事实', r.facts >= 2, `清了 ${r.facts} 条`)
  check('清掉了旧名字的对话', r.turns >= 2, `清了 ${r.turns} 轮`)
  check('事实里不再有银月/音乐', m.facts.every((f) => !/银月|音乐/.test(f.text)),
    m.facts.map((f) => f.text).join('|'))
  check('对话里不再有银月/音乐，但疑问句保留',
    m.turns.every((t) => !/银月|音乐/.test(t.text)) && m.turns.some((t) => t.text === '你叫什么？'),
    m.turns.map((t) => t.text).join('|'))

  const r2 = m.syncPersonaName('小银')
  check('名字没变就不动', r2.changed === false)
}

// ---------------------------------------------------------------- 汇总

log(`\n===== ${pass} passed, ${fail} failed =====`)
fs.writeFileSync(path.join(__dirname, '..', 'memory-test.log'), lines.join('\n') + '\n', 'utf8')
fs.rmSync(dir, { recursive: true, force: true })
console.log(`memory test: ${pass} passed, ${fail} failed  -> memory-test.log`)
process.exit(fail ? 1 : 0)
