'use strict'
/**
 * 桌面伴侣 · 主进程
 *
 * 负责所有「窗口与系统」相关的脏活：
 *  · 透明、无边框、置顶、不进任务栏/Alt+Tab
 *  · 位置持久化（贴屏幕右下、脚踩任务栏上沿）
 *  · 逐区域鼠标穿透（渲染进程算命中，这里执行）
 *  · 全屏前台应用检测 → 自动隐身
 *  · 托盘菜单、单实例、截图自检
 *  · 对话 / 语音 / 记忆 / 工具调用的接线
 */

const {
  app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage,
  globalShortcut, shell, session, powerMonitor,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const hotkey = require('./hotkey')
const config = require('./config')
const brainModule = require('./brain')
const voice = require('./voice')
const { Memory } = require('./memory')
const asrModule = require('./asr')
const vadModule = require('./vad')
const { Proactive } = require('./proactive')
const autostart = require('./autostart')
const shortcut = require('./shortcut')
const toolRunner = require('./tools')
const eyesModule = require('./eyes')

// 桌宠会自己开口，不需要用户手势
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// ---------------------------------------------------------------- 日志

const LOG_DIR = path.join(__dirname, '..', 'logs')

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(path.join(LOG_DIR, 'main.log'), line + '\n')
  } catch { /* 日志失败不能影响运行 */ }
  if (process.stdout.writable) console.log(line)
}

process.on('uncaughtException', (e) => {
  log('UNCAUGHT', (e && (e.stack || e.message)) || String(e))
  app.exit(1)
})
process.on('unhandledRejection', (e) => {
  log('UNHANDLED_REJECTION', (e && (e.stack || e.message)) || String(e))
})

// 进程一启动就留痕：开机自启到底有没有把进程拉起来，看这一行。
// 放在最前面，是因为如果 Electron 初始化阶段就挂了，后面的日志都不会有。
try {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.appendFileSync(
    path.join(LOG_DIR, 'boot.log'),
    `[${new Date().toISOString()}] pid=${process.pid} cwd=${process.cwd()} argv=${process.argv.slice(1).join(' ')}\n`
  )
} catch { /* 写不了就算了 */ }

// ---------------------------------------------------------------- 常量

const WIN_W = 360
const WIN_H = 620

const argv = process.argv.slice(1)
const hasFlag = (f) => argv.includes(f)
const flagValue = (f, def) => {
  const hit = argv.find((a) => a === f || a.startsWith(f + '='))
  if (!hit) return def
  const eq = hit.indexOf('=')
  return eq === -1 ? true : hit.slice(eq + 1)
}

const IS_SNAPSHOT = hasFlag('--snapshot')
const SNAPSHOT_OUT = flagValue('--out', path.join(process.cwd(), 'snapshot.png'))
const BG_MODE = flagValue('--bg', null)
const FORCE_STATE = flagValue('--state', null)
const DEBUG = hasFlag('--hitbox')
const NO_WATCH = hasFlag('--no-watch') || IS_SNAPSHOT

/** 自检用的注入文本。中文走命令行会被 cmd 转成乱码，所以支持从文件读。 */
function readChatText() {
  const inline = flagValue('--chat', null)
  if (inline) return String(inline)
  const file = flagValue('--chatfile', null)
  if (file && typeof file === 'string') {
    try {
      return fs.readFileSync(file, 'utf8').trim()
    } catch (e) {
      log('[chatfile]', e.message)
    }
  }
  return null
}

const CHAT_TEXT = readChatText()
const VOICE_WAV = flagValue('--voice', null)

// ---------------------------------------------------------------- 状态

let win = null
let tray = null
let watcher = null
let dnd = false
let hiddenByFullscreen = false

let cfg = null
let brain = null
let memory = null
let asr = null
let vad = null
let proactive = null
let chatting = false

let savedPos = null

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json')

function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (Number.isFinite(j.x) && Number.isFinite(j.y)) savedPos = { x: j.x, y: j.y }
    if (typeof j.dnd === 'boolean') dnd = j.dnd
  } catch { /* 首次启动 */ }
}

function saveState() {
  try {
    const b = win ? win.getBounds() : null
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ x: b ? b.x : savedPos && savedPos.x, y: b ? b.y : savedPos && savedPos.y, dnd }, null, 2)
    )
  } catch (e) {
    console.error('[state] 保存失败', e)
  }
}

/** 默认位置：主屏工作区右下角，窗口底边贴着任务栏上沿 */
function defaultPosition() {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: Math.round(workArea.x + workArea.width - WIN_W - 40),
    y: Math.round(workArea.y + workArea.height - WIN_H),
  }
}

/** 把位置夹回可见工作区，避免拔掉副屏后窗口跑到屏幕外 */
function clampToScreen(x, y) {
  const displays = screen.getAllDisplays()
  const inside = displays.some((d) => {
    const a = d.workArea
    const cx = x + WIN_W / 2
    const cy = y + WIN_H / 2
    return cx > a.x && cx < a.x + a.width && cy > a.y && cy < a.y + a.height
  })
  return inside ? { x, y } : defaultPosition()
}

// ---------------------------------------------------------------- 窗口

function createWindow() {
  const pos = savedPos ? clampToScreen(savedPos.x, savedPos.y) : defaultPosition()

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,        // 位置由主进程接管，避免和命中测试打架
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,     // 同时让 Windows 加 WS_EX_TOOLWINDOW，从 Alt+Tab 消失
    alwaysOnTop: true,
    acceptFirstMouse: true,
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      devTools: !IS_SNAPSHOT,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })

  const query = {}
  if (BG_MODE) query.bg = BG_MODE
  if (FORCE_STATE) query.state = FORCE_STATE
  if (DEBUG) query.debug = '1'

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query })

  win.once('ready-to-show', () => win.showInactive())  // showInactive：不抢焦点

  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  win.on('moved', () => {
    if (!dragTimer) saveState()
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

// ---------------------------------------------------------------- 托盘

function trayIcon() {
  const p = path.join(__dirname, '..', 'assets', 'tray.png')
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p)
    if (!img.isEmpty()) return img
  }
  return nativeImage.createEmpty()
}

/** 她叫什么（没配就返回空串） */
function personaName() {
  return (cfg && cfg.persona && cfg.persona.name) || ''
}

/** 工具执行器：真正"动手"的地方在 tools.js，这里提供 electron 的 shell 和眼睛 */
function execTool(name, args) {
  const eyes = {
    look: (question) => eyesModule.look(question, cfg, log),
  }
  return toolRunner.run(name, args, { shell, log, eyes })
}

/** 改了 config.json 之后不用重启，托盘里点一下就行 */
function reloadConfig() {
  try {
    cfg = config.load(path.join(__dirname, '..'), log)
    brain = brainModule.createBrain(cfg, log, { execTool })

    // 改名了就把旧称呼从记忆里清掉（和启动时同一套逻辑）
    if (memory) {
      const r = memory.syncPersonaName(cfg.persona.name)
      if (r.changed) {
        log('[memory] 改名:', r.from || '(未设置)', '->', r.to,
          `(清掉 ${r.facts} 条事实 / ${r.turns} 轮对话)`)
      }
    }

    log('[config] 重新加载 -> persona =', JSON.stringify(cfg.persona), '| brain =', brain.name)

    if (tray) {
      tray.setToolTip(personaName() || '桌面伴侣')
      refreshTrayMenu()
    }
    if (win && !win.isDestroyed()) {
      const who = personaName()
      win.webContents.send('proactive:say', who ? `我是${who}。` : '配置读好了。')
    }
  } catch (e) {
    log('[config] 重载失败:', e.message)
  }
}

function buildTray() {
  tray = new Tray(trayIcon())
  tray.setToolTip(personaName() || '桌面伴侣')
  refreshTrayMenu()
  tray.on('click', () => toggleVisible())
  tray.on('double-click', () => recenter())
}

function refreshTrayMenu() {
  if (!tray) return
  const visible = win ? win.isVisible() : false
  const menu = Menu.buildFromTemplate([
    { label: visible ? '让它躲起来' : '叫它出来', click: () => toggleVisible() },
    { type: 'separator' },
    {
      label: '开机自启（延迟 10 秒）',
      type: 'checkbox',
      checked: autostart.isEnabled(),
      click: (item) => {
        const ok = autostart.setEnabled(item.checked)
        log('[autostart]', item.checked ? '开启' : '关闭', '->', ok, JSON.stringify(autostart.describe()))
        refreshTrayMenu()
      },
    },
    {
      label: '创建桌面快捷方式',
      click: () => {
        const ok = shortcut.createDesktopShortcut()
        log('[shortcut] 桌面快捷方式 ->', ok, JSON.stringify(shortcut.describe()))
        if (win && !win.isDestroyed()) {
          win.webContents.send('proactive:say', ok ? '桌面快捷方式放好了。' : '快捷方式没建成，看看日志。')
        }
      },
    },
    {
      label: '打盹（勿扰）',
      type: 'checkbox',
      checked: dnd,
      click: (item) => {
        dnd = item.checked
        applyDnd()
        saveState()
      },
    },
    { label: '回到右下角', click: () => recenter() },
    {
      label: '主动开口',
      submenu: [
        {
          label: proactive
            ? `今天 ${proactive.stats().today}/${proactive.stats().max}` +
              (proactive.stats().muted ? ' · 已闭嘴' : '') +
              (proactive.stats().quiet ? ' · 静默时段' : '')
            : '未启用',
          enabled: false,
        },
        { type: 'separator' },
        {
          label: '今天别说话',
          click: () => {
            if (!proactive) return
            proactive.mute()
            refreshTrayMenu()
            if (win && !win.isDestroyed()) win.webContents.send('proactive:muted')
          },
        },
      ],
    },
    {
      label: '记忆',
      submenu: [
        {
          label: memory
            ? `记住 ${memory.stats().facts} 条 · ${memory.stats().turns} 轮对话`
            : '未启用',
          enabled: false,
        },
        { type: 'separator' },
        {
          label: '忘掉聊过的事…',
          click: () => {
            if (!memory) return
            memory.clear()
            log('[memory] 已清空')
            if (win && !win.isDestroyed()) win.webContents.send('memory:cleared')
            refreshTrayMenu()
          },
        },
      ],
    },
    { type: 'separator' },
    { label: '重新读取 config.json', click: () => reloadConfig() },
    {
      label: '打开立绘文件夹',
      click: () => shell.openPath(path.join(__dirname, '..', 'assets', 'character')),
    },
    { label: '开发者工具', click: () => win && win.webContents.openDevTools({ mode: 'detach' }) },
    { type: 'separator' },
    { label: '退出', click: () => quit() },
  ])
  tray.setContextMenu(menu)
}

function applyDnd() {
  if (!win) return
  if (dnd) win.hide()
  else if (!hiddenByFullscreen) win.showInactive()
  refreshTrayMenu()
}

function toggleVisible() {
  if (!win) return
  if (win.isVisible()) win.hide()
  else {
    win.showInactive()
    recenterIfOffscreen()
  }
  refreshTrayMenu()
}

function recenterIfOffscreen() {
  if (!win) return
  const b = win.getBounds()
  const p = clampToScreen(b.x, b.y)
  if (p.x !== b.x || p.y !== b.y) win.setPosition(p.x, p.y)
}

function recenter() {
  if (!win) return
  const p = defaultPosition()
  win.setPosition(p.x, p.y)
  if (!win.isVisible()) win.showInactive()
  saveState()
  refreshTrayMenu()
}

// ---------------------------------------------------------------- 拖动

let dragTimer = null
let dragOffset = null

function startDrag() {
  if (!win || dragTimer) return
  const b = win.getBounds()
  const c = screen.getCursorScreenPoint()
  dragOffset = { dx: c.x - b.x, dy: c.y - b.y }

  let last = c
  let still = 0
  dragTimer = setInterval(() => {
    if (!win) return stopDrag()
    const cur = screen.getCursorScreenPoint()
    win.setPosition(Math.round(cur.x - dragOffset.dx), Math.round(cur.y - dragOffset.dy))
    // 兜底：鼠标松在窗口外时收不到 mouseup，用「一段时间不动」结束拖动
    if (cur.x === last.x && cur.y === last.y) {
      still += 16
      if (still > 220) stopDrag()
    } else {
      still = 0
      last = cur
    }
  }, 16)
}

function stopDrag() {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
  dragOffset = null
  saveState()
  recenterIfOffscreen()
}

// ---------------------------------------------------------------- 全局光标

/**
 * 每 90ms 把全局光标位置（窗口内坐标）推给渲染进程。
 * 这样鼠标在窗口外时她也会转头 —— 窗口只有 360x620，靠 DOM 事件做不到。
 */
function startCursorBeacon() {
  if (!win) return
  setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return
    const b = win.getBounds()
    const c = screen.getCursorScreenPoint()
    win.webContents.send('cursor:point', { x: c.x - b.x, y: c.y - b.y })
  }, 90)
}

// ---------------------------------------------------------------- 全屏检测

/**
 * 用一个常驻 PowerShell 侧车读前台窗口矩形，避免每次都拉起新进程。
 * 任何环节失败都只是退化成「没有自动隐身」，不影响主功能。
 */
function startFullscreenWatch() {
  if (NO_WATCH) return
  const script = path.join(__dirname, '..', 'tools', 'foreground-watch.ps1')
  if (!fs.existsSync(script)) return

  // PowerShell 的 Add-Type 会往 TEMP 写临时文件，某些环境会把这里拦掉
  const psTmp = path.join(__dirname, '..', 'logs', 'ps-tmp')
  try {
    fs.mkdirSync(psTmp, { recursive: true })
  } catch { /* 用系统默认 */ }

  try {
    watcher = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TEMP: psTmp, TMP: psTmp },
    })
  } catch (e) {
    console.warn('[watch] 启动失败，跳过自动隐身', e.message)
    return
  }

  let buf = ''
  log('watch spawned pid=', watcher.pid)

  watcher.stderr.on('data', (c) => log('[watch:stderr]', c.toString().trim().slice(0, 300)))

  watcher.stdout.on('data', (chunk) => {
    buf += chunk.toString()
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) handleForegroundLine(line)
    }
  })

  watcher.on('error', (e) => console.warn('[watch] error', e.message))
  watcher.on('exit', (code, signal) => {
    log('watch exited', code, signal)
    watcher = null
    if (!app.isQuitting && !NO_WATCH) {
      setTimeout(() => {
        if (!watcher && !app.isQuitting) startFullscreenWatch()
      }, 5000)
    }
  })
}

function handleForegroundLine(line) {
  // 协议: "类名 左 上 宽 高"
  const parts = line.split(/\s+/)
  if (parts.length !== 5) return
  const cls = parts[0]
  // 桌面本身、任务栏、壁纸宿主不算「全屏应用」
  if (/^(Progman|WorkerW|Shell_TrayWnd|Shell_SecondaryTrayWnd|Windows\.UI\.Core\.CoreWindow)$/i.test(cls)) return

  const [l, t, w, h] = parts.slice(1).map(Number)
  if ([l, t, w, h].some((n) => !Number.isFinite(n))) return
  if (w <= 0 || h <= 0) return

  const cx = l + w / 2
  const cy = t + h / 2
  const disp = screen.getAllDisplays().find((d) => {
    const b = d.bounds
    return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height
  }) || screen.getPrimaryDisplay()

  const scale = disp.scaleFactor || 1
  const dw = disp.bounds.width * scale
  const dh = disp.bounds.height * scale
  const covers = w >= dw - 8 && h >= dh - 8

  if (covers && !hiddenByFullscreen && !IS_SNAPSHOT) {
    hiddenByFullscreen = true
    if (win && !dnd) win.hide()
  } else if (!covers && hiddenByFullscreen) {
    hiddenByFullscreen = false
    if (win && !dnd && win.isVisible() === false) win.showInactive()
  }
}

// ---------------------------------------------------------------- IPC

function wireIpc() {
  ipcMain.on('hit:set', (_e, ignore) => {
    if (win) win.setIgnoreMouseEvents(!!ignore, { forward: true })
  })

  ipcMain.on('drag:start', () => startDrag())
  ipcMain.on('drag:end', () => stopDrag())

  ipcMain.on('window:hide', () => {
    if (win) win.hide()
    refreshTrayMenu()
  })
  ipcMain.on('window:recenter', () => recenter())

  ipcMain.on('app:quit', () => quit())

  // 打开输入框时要能接键盘：先把窗口提到前台
  ipcMain.on('window:focus', () => {
    if (!win) return
    win.setIgnoreMouseEvents(false)
    win.show()
    win.focus()
  })

  ipcMain.on('tray:refresh', () => refreshTrayMenu())

  ipcMain.handle('app:info', () => ({
    versions: process.versions,
    dnd,
    bounds: win ? win.getBounds() : null,
    scale: screen.getPrimaryDisplay().scaleFactor,
  }))

  // ---------------- 记忆 ----------------

  ipcMain.handle('memory:stats', () => (memory ? memory.stats() : null))

  ipcMain.handle('memory:clear', () => {
    if (!memory) return false
    memory.clear()
    log('[memory] 用户要求忘掉一切')
    if (win && !win.isDestroyed()) win.webContents.send('memory:cleared')
    refreshTrayMenu()
    return true
  })

  // ---------------- 耳朵 ----------------

  ipcMain.handle('asr:status', () => ({
    enabled: cfg.asr.enabled,
    ...(asr ? asr.status : { state: 'none' }),
  }))

  ipcMain.handle('asr:transcribe', (_e, samples) => {
    if (!cfg.asr.enabled) return { ok: false, error: '耳朵没开' }
    if (!asr) return { ok: false, error: '耳朵没起来' }

    // 先把静音剪掉：两端空白只会拖慢识别、并诱使模型瞎猜
    const v = vad ? vad.trim(samples) : { ok: true, samples, speechMs: 0, totalMs: 0, cut: false }
    if (!v.ok) {
      log('[vad]', v.error, `(语音 ${v.speechMs}ms / 共 ${v.totalMs}ms)`)
      return { ok: false, error: v.error }
    }

    const r = asr.transcribe(v.samples)
    const trim = v.cut ? `，剪掉 ${v.totalMs - v.speechMs}ms 静音` : ''
    log('[asr]', r.ok ? `${r.text}  (${r.ms}ms${trim})` : `失败: ${r.error}`)
    return { ...r, speechMs: v.speechMs, totalMs: v.totalMs, cut: v.cut }
  })

  // ---------------- 对话 ----------------

  ipcMain.handle('chat:info', () => ({
    provider: brain ? brain.name : 'none',
    mock: !brain || brain.name === 'mock',
    voice: cfg.voice.enabled ? cfg.voice.voice : null,
    configFile: cfg.file,
    persona: cfg.persona,
  }))

  ipcMain.handle('chat:send', async (_e, text) => {
    const t = String(text || '').trim().slice(0, 2000)
    if (!t || !brain) return { ok: false, error: 'empty' }
    if (chatting) return { ok: false, error: 'busy' }

    if (proactive) proactive.noteInteraction()

    // 「嘘」是硬指令：当天不再主动开口，也不用麻烦大脑
    if (/^(嘘|闭嘴|安静|别说话|不要说话|shut\s*up|stop\s*talk)/i.test(t)) {
      if (proactive) proactive.mute()
      if (memory) {
        memory.addTurn('user', t)
        memory.addTurn('assistant', '好，今天不说了。')
      }
      refreshTrayMenu()
      if (win && !win.isDestroyed()) win.webContents.send('proactive:muted')
      return { ok: true, muted: true }
    }

    chatting = true
    const context = memory ? memory.buildContext(t) : ''
    let full = ''
    const t0 = Date.now()
    try {
      for await (const delta of brain.stream(t, { context })) {
        full += delta
        if (win && !win.isDestroyed()) win.webContents.send('chat:delta', delta)
      }

      if (memory) {
        memory.addTurn('user', t)
        memory.addTurn('assistant', full)
        const learned = memory.learn(t)
        if (learned) log('[memory] 学到', learned, '条')
      }

      log('[chat] 回复完成', full.length, '字', `${Date.now() - t0}ms`)
      if (win && !win.isDestroyed()) win.webContents.send('chat:done')
      return { ok: true }
    } catch (err) {
      log('[chat] error', err.message)
      if (win && !win.isDestroyed()) win.webContents.send('chat:error', err.message)
      return { ok: false, error: err.message }
    } finally {
      chatting = false
    }
  })

  // 一句一句合成。失败返回 null，渲染端就只显示气泡不出声。
  ipcMain.handle('tts:speak', async (_e, text) => {
    const t0 = Date.now()
    const buf = await voice.synthesize(String(text || ''), cfg.voice, log)
    log('[tts]', buf ? `${buf.length} 字节` : '失败', `${Date.now() - t0}ms`, JSON.stringify(String(text || '').slice(0, 14)))
    return buf || null
  })

  // 立绘资产探测：先看有没有分层 manifest，再看有没有单图
  ipcMain.handle('character:assets', () => {
    const dir = path.join(__dirname, '..', 'assets', 'character')
    try {
      if (fs.existsSync(path.join(dir, 'manifest.json'))) {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
        return { mode: 'layered', manifest, dir: toFileUrl(dir) }
      }
      if (fs.existsSync(path.join(dir, 'base.png'))) {
        return { mode: 'single', url: toFileUrl(path.join(dir, 'base.png')), dir: toFileUrl(dir) }
      }
    } catch (e) {
      console.error('[assets]', e)
    }
    return { mode: 'placeholder', dir: toFileUrl(dir) }
  })
}

function toFileUrl(p) {
  return 'file:///' + path.resolve(p).replace(/\\/g, '/').replace(/ /g, '%20')
}

// ---------------------------------------------------------------- 生命周期

function quit() {
  app.isQuitting = true
  saveState()
  if (dragTimer) clearInterval(dragTimer)
  hotkey.stopAll()
  if (watcher) {
    try { watcher.kill() } catch { /* 已经没了 */ }
  }
  if (tray) {
    tray.destroy()
    tray = null
  }
  app.quit()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      win.showInactive()
      refreshTrayMenu()
    }
  })

  app.whenReady().then(async () => {
    log('app ready, argv=', process.argv.join(' '))

    // 桌宠要自己开麦，权限直接放行（只放 media，别的一概拒绝）
    try {
      session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
        cb(permission === 'media' || permission === 'audioCapture')
      })
      session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
        permission === 'media' || permission === 'audioCapture')
    } catch (e) {
      log('[perm]', e.message)
    }

    cfg = config.load(path.join(__dirname, '..'), log)
    brain = brainModule.createBrain(cfg, log, { execTool })
    memory = new Memory(path.join(__dirname, '..', 'memory'), log).load()

    // 改了 persona.name 就把旧称呼相关的记忆清掉，
    // 否则她会在「系统提示说我叫银月」和「记忆里有人叫我音乐」之间反复横跳
    const rename = memory.syncPersonaName(cfg.persona.name)
    if (rename.changed) {
      log('[memory] 改名:', rename.from || '(未设置)', '->', rename.to,
        `(清掉 ${rename.facts} 条事实 / ${rename.turns} 轮对话)`)
    }

    // ASR 模型目录：配置里没写就自动找项目内 / 工作区顶层
    const asrDir = cfg.asr.modelDir
      ? path.resolve(__dirname, '..', cfg.asr.modelDir)
      : [
          path.join(__dirname, '..', '.asr-models', 'sense-voice'),
          path.join(__dirname, '..', '..', '.asr-models', 'sense-voice'),
        ].find((p) => fs.existsSync(p)) || path.join(__dirname, '..', '.asr-models', 'sense-voice')

    asr = asrModule.create({
      dir: asrDir,
      log,
      numThreads: cfg.asr.numThreads,
      language: cfg.asr.language,
    })

    vad = vadModule.create({ dir: asrDir, log })
    proactive = new Proactive(path.join(__dirname, '..', 'memory', 'proactive.json'), {}, log)

    log('brain =', brain.name, '| voice =', cfg.voice.enabled ? cfg.voice.voice : 'off')
    log('asr =', cfg.asr.enabled ? asrDir : 'off', '| persona =', personaName() || '(未设置)')

    // 自检用：--shortcuts 一次性把桌面和启动文件夹的快捷方式都建出来
    if (hasFlag('--shortcuts')) {
      const d = shortcut.createDesktopShortcut()
      const s = shortcut.createStartupShortcut()
      log('[shortcut] 创建结果 desktop=', d, 'startup=', s, JSON.stringify(shortcut.describe()))
      if (IS_SNAPSHOT) {
        app.isQuitting = true
        app.exit(0)
        return
      }
    }

    // 自检用：--autostart=on / off 直接改开机自启
    const autoFlag = flagValue('--autostart', null)
    if (autoFlag !== null && autoFlag !== undefined) {
      const on = /^(on|true|1)$/i.test(String(autoFlag))
      const ok = autostart.setEnabled(on)
      log('[autostart]', on ? '开启' : '关闭', '->', ok, JSON.stringify(autostart.describe()))
      if (IS_SNAPSHOT) {
        app.isQuitting = true
        app.exit(0)
        return
      }
    }

    // 自检用：--eyes="问题" 截一张屏交给视觉模型，回答打到日志后退出
    if (hasFlag('--eyes')) {
      const q = flagValue('--eyes', '屏幕上有什么')
      const question = typeof q === 'string' ? q : '屏幕上有什么'
      const r = await eyesModule.look(question, cfg, log, {
        saveTo: path.join(__dirname, '..', 'work', 'eyes.jpg'),
      })
      log('[eyes] 结果 ok=', r.ok, '|', r.said)
      app.isQuitting = true
      app.exit(0)
      return
    }

    loadState()
    createWindow()
    log('window created')
    wireIpc()

    const atLogin = autostart.wasOpenedAtLogin()
    if (atLogin) log('[autostart] 这次是开机拉起来的')

    // 隔了一段时间再见面，用它记得的东西开个头
    if (!IS_SNAPSHOT || hasFlag('--greet')) {
      setTimeout(() => {
        if (!memory || !win || win.isDestroyed()) return
        const g = memory.greeting()
        if (g) {
          log('[memory] 打招呼:', g)
          win.webContents.send('memory:greeting', g)
        }
      }, 2800)
    }

    // 后台把 ASR 模型读进来。开机那会儿磁盘和 CPU 都在忙，让它晚点再吃 228MB。
    if (!IS_SNAPSHOT && cfg.asr.enabled) {
      const delay = atLogin ? 20000 : 2500
      setTimeout(() => log('asr warmup ->', asr.warmup()), delay)
    }

    // 每分钟问一次「现在能不能开口」。它自己会拒绝绝大部分时候。
    if (!IS_SNAPSHOT && proactive) {
      setInterval(() => {
        if (!win || win.isDestroyed()) return
        const action = proactive.decide(Date.now(), {
          idleSec: powerMonitor.getSystemIdleTime(),
          fullscreen: hiddenByFullscreen,
          dnd,
          busy: chatting,
        })
        if (action) {
          log('[proactive]', action.reason, '->', action.text)
          win.webContents.send('proactive:say', action.text)
          refreshTrayMenu()
        }
      }, 60e3)
    }

    if (!IS_SNAPSHOT) {
      buildTray()
      startCursorBeacon()
      startFullscreenWatch()

      const hookOk = hotkey.start({
        onStart: () => { if (win) win.webContents.send('ptt:start') },
        onStop: () => { if (win) win.webContents.send('ptt:stop') },
        // 全局 mouseup：鼠标松在窗口外时也能正确结束拖拽
        onMouseUp: () => { if (dragTimer) stopDrag() },
      })
      log('hotkey started:', hookOk)

      globalShortcut.register('CommandOrControl+Alt+Q', () => quit())

      // 随时唤起：Ctrl+Alt+Space 直接弹出输入框
      const okSummon = globalShortcut.register('Control+Alt+Space', () => {
        if (!win) return
        win.showInactive()
        win.webContents.send('input:toggle')
        win.setIgnoreMouseEvents(false)
        win.focus()
      })
      log('summon shortcut registered:', okSummon)

      log('tray + watch started')

      // 冒烟测试：真的以「托盘常驻」的方式跑起来，几秒后自己退出并汇报
      if (hasFlag('--smoke')) {
        setTimeout(() => {
          log('SMOKE tray=', !!tray, 'watcher=', !!watcher, 'visible=', win && win.isVisible())
          quit()
        }, 5000)
      }
    } else {
      runSnapshot()
    }
  })

  app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ })
  app.on('before-quit', () => {
    app.isQuitting = true
    saveState()
  })
}

// ---------------------------------------------------------------- 自检

/** 把气泡和状态机的真实 DOM 状态打出来，别靠猜 */
async function probeDom() {
  try {
    const info = await win.webContents.executeJavaScript(`(() => {
      const b = document.getElementById('bubble');
      const cs = getComputedStyle(b);
      const c = document.getElementById('composer');
      return {
        cls: b.className,
        opacity: cs.opacity,
        display: cs.display,
        transform: cs.transform,
        text: (b.textContent || '').slice(0, 30),
        composer: c.className,
        state: window.__comp ? window.__comp.rig.state : '?',
        mouth: window.__comp ? +window.__comp.rig.mouthOpen.toFixed(2) : -1,
      };
    })()`)
    log('[probe]', JSON.stringify(info))
  } catch (e) {
    log('[probe] 失败', e.message)
  }
}

/** 开发用：渲染若干状态后逐个截图再退出，方便在没有眼睛的环境里验收视觉 */
function runSnapshot() {
  const wait = Number(flagValue('--wait', 1500))
  const shots = String(flagValue('--shots', '') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const outDir = flagValue('--outdir', path.join(process.cwd(), 'snapshots'))
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  win.webContents.once('did-finish-load', () => {
    ;(async () => {
      try {
        fs.mkdirSync(outDir, { recursive: true })
        await sleep(400)

        // 自检：真的走一遍「渲染进程 → IPC → 大脑 → 流式回字」
        if (CHAT_TEXT) {
          win.webContents.send('chat:auto', CHAT_TEXT)
          await sleep(Number(flagValue('--chatwait', 2600)))
        }

        // 自检：塞一段 wav 进渲染进程，走「识别 → 大脑 → 气泡」整条链路
        if (VOICE_WAV) {
          try {
            log('[sim] 1 读 wav')
            const w = require('./wav').readWav(path.resolve(String(VOICE_WAV)))
            log('[sim] 2 样本数', w.samples.length, '@', w.sampleRate, 'Hz')

            // sherpa 的 samples 挂在 native 内存上，直接过 IPC 会被 Electron 拒绝
            const bytes = Buffer.allocUnsafe(w.samples.length * 4)
            for (let i = 0; i < w.samples.length; i++) bytes.writeFloatLE(w.samples[i], i * 4)
            log('[sim] 3 打包', bytes.length, '字节')

            win.webContents.send('ptt:sim', bytes)
            log('[sim] 4 已送入')
            await sleep(2600)
          } catch (e) {
            log('[sim] 失败', e.message)
          }
        }

        // 自检：假装护栏决定开口了，看看视觉长什么样
        if (hasFlag('--say')) {
          win.webContents.send('proactive:say', '你坐了挺久了，起来走两步。')
          await sleep(1500)
        }

        // 自检：先摆到一边稳定，再猛甩到另一边 —— 用来抓弹簧的滞后
        const preset = flagValue('--preset', null)
        if (preset && typeof preset === 'string') {
          const [px, py] = preset.split(',').map(Number)
          await win.webContents.executeJavaScript(
            `window.__comp && window.__comp.look(${px || 0}, ${py || 0})`
          )
          await sleep(900)
        }

        // 自检：强制一个注视方向，验证视差分层有没有真的在动
        const look = flagValue('--look', null)
        if (look && typeof look === 'string') {
          const [lx, ly] = look.split(',').map(Number)
          await win.webContents.executeJavaScript(
            `window.__comp && window.__comp.look(${lx || 0}, ${ly || 0})`
          )
          await sleep(Number(flagValue('--lookwait', 700)))
        }

        if (shots.length) {
          for (const st of shots) {
            // 走了对话自检就不要强制切状态，否则会把正在说话的气泡一起重置
            if (!CHAT_TEXT) win.webContents.send('state:set', st)
            await sleep(wait)
            if (CHAT_TEXT) await probeDom()
            const img = await win.capturePage()
            fs.writeFileSync(path.join(outDir, `${st}.png`), img.toPNG())
            log('snapshot', st)
          }
        } else {
          await sleep(wait)
          if (CHAT_TEXT) await probeDom()
          const img = await win.capturePage()
          fs.writeFileSync(SNAPSHOT_OUT, img.toPNG())
          log('snapshot', SNAPSHOT_OUT)
        }
      } catch (e) {
        log('snapshot failed', (e && (e.stack || e.message)) || String(e))
      } finally {
        app.isQuitting = true
        app.quit()
      }
    })()
  })

  win.webContents.on('console-message', (event) => {
    const level = event && event.level
    const message = event && event.message
    if (level === 'error' || level === 'warning' || level === 3) log('[renderer]', message)
  })
}
