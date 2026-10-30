/**
 * config.js —— 读配置
 *
 * 优先级：config.json > 环境变量 > 内置默认值。
 * apiKey 支持写 "${DEEPSEEK_API_KEY}" 这种占位符，从环境变量取，避免把 key 提交进仓库。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const DEFAULTS = {
  persona: {
    name: '',          // 她叫什么
    userTitle: '',     // 她怎么称呼你
  },
  brain: {
    provider: 'mock',                       // mock | deepseek | openai | ollama | 任意 OpenAI 兼容
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',
    temperature: 0.85,
    maxTokens: 400,
    systemPrompt:
      '你是一只住在用户桌面上的小助手，形象是个二次元小姑娘。说话短、口语、有点自己的小脾气，' +
      '不用敬语，不列清单，不用客服腔，一次最多三句话。你知道自己只是一张二维图片，偶尔拿这个自嘲。',
  },
  voice: {
    enabled: true,
    voice: 'zh-CN-XiaoyiNeural',
    rate: '+6%',
    pitch: '+4Hz',
    volume: '+0%',
  },
  asr: {
    enabled: true,
    modelDir: '',           // 留空则自动找 .asr-models/sense-voice
    numThreads: 4,
    language: 'auto',       // auto | zh | en | ja | ko | yue
  },
  vision: {
    enabled: true,
    // 留空就沿用 brain 的 baseURL / model / apiKey（DeepSeek 两个接口都认）
    baseURL: '',
    model: '',
    apiKey: '',
    maxWidth: 1280,         // 截图长边上限，越大越贵越慢
    timeoutMs: 30000,
  },
}

function expandEnv(value) {
  if (typeof value !== 'string') return value
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] || '')
}

/**
 * 机器级的私密配置：%APPDATA%\desktop-companion\secrets.json
 *
 * API key 不应该躺在项目目录里 —— 那里迟早会被 git 提交。
 * 这个文件在用户配置目录，跟仓库无关，也不会被 .gitignore 之外的东西碰到。
 *
 * 结构：
 *   { "brain": { "apiKey": "sk-..." } }
 */
function secretsPath() {
  const base = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
  return path.join(base, 'desktop-companion', 'secrets.json')
}

function loadSecrets(log) {
  try {
    const p = secretsPath()
    if (!fs.existsSync(p)) return {}
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    log('[config] secrets.json 读取失败:', e.message)
    return {}
  }
}

function load(rootDir, log = console.log) {
  const file = path.join(rootDir, 'config.json')
  let user = {}
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') log('[config] 解析失败，用默认值:', e.message)
  }

  const cfg = {
    persona: { ...DEFAULTS.persona, ...(user.persona || {}) },
    brain: { ...DEFAULTS.brain, ...(user.brain || {}) },
    voice: { ...DEFAULTS.voice, ...(user.voice || {}) },
    asr: { ...DEFAULTS.asr, ...(user.asr || {}) },
    vision: { ...DEFAULTS.vision, ...(user.vision || {}) },
  }
  cfg.brain.apiKey = expandEnv(cfg.brain.apiKey)

  // config.json 里没写 key 时，从机器级的 secrets.json 取。
  // 反过来：config.json 里显式写了，就以它为准（方便临时覆盖）。
  if (!cfg.brain.apiKey) {
    const secrets = loadSecrets(log)
    const fromSecrets = secrets && secrets.brain && secrets.brain.apiKey
    if (fromSecrets) cfg.brain.apiKey = expandEnv(String(fromSecrets))
    cfg.secretsPath = secretsPath()
  }

  cfg.file = file
  return cfg
}

module.exports = { load, DEFAULTS, secretsPath }
