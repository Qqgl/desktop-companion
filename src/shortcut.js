/**
 * shortcut.js —— 桌面快捷方式 / 启动文件夹
 *
 * 之前用注册表 Run 项做开机自启，重启后进程根本没起来（连日志都没有），
 * 最可能是开机瞬间桌面环境还没就绪，Chromium 初始化失败。
 * 现在改成：
 *
 *   启动文件夹里的 .lnk  →  wscript.exe  →  launch.vbs  →  等 10 秒  →  electron
 *
 * 多一层 .vbs 的好处：
 *   · 能延迟，避开开机风暴
 *   · 不弹黑框（wscript 无控制台）
 *   · 启动文件夹在「任务管理器 → 启动应用」里看得见，用户能自己管
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { run, q } = require('./winps')

const SHORTCUT_NAME = '桌面伴侣.lnk'
const BOOT_DELAY = 10 // 秒

function electron() {
  return require('electron')
}

function project() {
  return path.resolve(electron().app.getAppPath())
}

function iconPath() {
  const p = path.join(project(), 'assets', 'icon.ico')
  return fs.existsSync(p) ? p : process.execPath
}

function desktopDir() {
  try {
    return electron().app.getPath('desktop')
  } catch {
    return path.join(process.env.USERPROFILE || '', 'Desktop')
  }
}

function startupDir() {
  return path.join(
    process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'
  )
}

function desktopShortcutPath() {
  return path.join(desktopDir(), SHORTCUT_NAME)
}

function startupShortcutPath() {
  return path.join(startupDir(), SHORTCUT_NAME)
}

function launcherPath() {
  return path.join(project(), 'tools', 'launch.vbs')
}

/** 统一的启动批处理：负责把 Electron 的输出全部落盘 */
function runBatPath() {
  return path.join(project(), 'tools', 'run.bat')
}

const RUN_BAT = [
  '@echo off',
  'rem Desktop Companion launcher - generated automatically, do not edit.',
  'rem Runs Electron from the project root and captures everything it prints,',
  'rem so a silent crash still leaves a trace in logs\\console.log.',
  'rem %* forwards --boot when started from the Startup folder.',
  'rem',
  'rem Flags are not optional on this machine:',
  'rem   --no-sandbox          without it Chromium init dies with 0x80000003',
  'rem   --user-data-dir=...   the default APPDATA profile is not writable here',
  'rem                         (exit code -36861)',
  '',
  'cd /d "%~dp0.."',
  '',
  'set "LOG=logs\\console.log"',
  'if not exist "logs" mkdir "logs"',
  '',
  'echo. >> "%LOG%"',
  'echo ===== %DATE% %TIME%  args=[%*]  cwd=%CD% ===== >> "%LOG%"',
  '',
  'if exist "node_modules\\electron\\dist\\electron.exe" goto haveelectron',
  'echo ERROR: electron.exe not found under node_modules >> "%LOG%"',
  'exit /b 1',
  '',
  ':haveelectron',
  '"node_modules\\electron\\dist\\electron.exe" "." --no-sandbox --user-data-dir="%~dp0..\\data" %* >> "%LOG%" 2>&1',
  'echo ===== exit code %ERRORLEVEL% ===== >> "%LOG%"',
  '',
].join('\r\n')

function ensureRunBat() {
  const f = runBatPath()
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, RUN_BAT, 'ascii')
  return f
}

/**
 * 写启动脚本（.vbs）。
 *
 * 三个约束，都是踩出来的：
 *  1. 只能用 ASCII。中文注释用 'ascii' 编码写出去会变成 0x00 字节，
 *     文件变二进制垃圾，WSH 解析失败 —— 开机时连痕迹都没有。
 *  2. 先写日志再 Sleep，这样即使后面 Electron 起不来，也知道脚本执行过。
 *  3. 真正的启动交给 run.bat：.bat 的引号规则简单，还能顺便把
 *     Electron 的 stdout/stderr 重定向进 logs/console.log。
 */
function writeLauncher(file, delaySec, { boot = true } = {}) {
  const bat = ensureRunBat()
  const marker = path.join(project(), 'logs', 'boot.log')
  const lines = [
    "' Desktop Companion launcher - generated automatically, do not edit.",
    "' ASCII only. Runs run.bat hidden; run.bat captures Electron's output.",
    'Option Explicit',
    'Dim sh, fso, f',
    'Set sh = CreateObject("WScript.Shell")',
    "' Leave a trace first: even if Electron fails, we know this ran.",
    'On Error Resume Next',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `Set f = fso.OpenTextFile("${marker}", 8, True)`,
    'If Err.Number = 0 Then',
    `  f.WriteLine Now & "  launcher fired, delay ${delaySec}s"`,
    '  f.Close',
    'End If',
    'On Error Goto 0',
    `WScript.Sleep ${Math.max(0, delaySec) * 1000}`,
    // 用 cmd /c 调 .bat，而不是让 Shell 去"打开"它 ——
    // 直接 ShellExecute 一个 .bat 会弹「无法验证发布者」的安全警告。
    `cmdLine = "cmd /c """ & "${bat}" & """"${boot ? ' & " --boot"' : ''}`,
    'sh.Run cmdLine, 0, False',
    '',
  ]
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.join('\r\n'), 'ascii')
  return file
}

function launcherNowPath() {
  return path.join(project(), 'tools', 'launch-now.vbs')
}

function createLnk(lnkPath, target, args, workdir, desc) {
  fs.mkdirSync(path.dirname(lnkPath), { recursive: true })
  if (fs.existsSync(lnkPath)) fs.rmSync(lnkPath, { force: true })

  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$s = $ws.CreateShortcut('${q(lnkPath)}')`,
    `$s.TargetPath = '${q(target)}'`,
    `$s.Arguments = '${q(args)}'`,
    `$s.WorkingDirectory = '${q(workdir)}'`,
    `$s.IconLocation = '${q(iconPath())}'`,
    `$s.Description = '${q(desc)}'`,
    '$s.WindowStyle = 1',
    '$s.Save()',
  ].join('\n')

  try {
    run(script)
  } catch (e) {
    console.warn('[shortcut] 创建失败:', lnkPath, '->', e.message)
    return false
  }
  return fs.existsSync(lnkPath)
}

/**
 * 桌面快捷方式：双击就开，不延迟。
 *
 * 目标不是 electron.exe，而是 wscript.exe + 一个 .vbs。
 * 原因：直接指向未签名的 electron.exe 会触发 SmartScreen「已保护你的电脑」，
 * 用户点了「仍要运行」也未必真能起来（实测没起来，且连日志都没有）。
 * 指向系统自带的 wscript，点击时不会被拦，再由脚本去拉起 Electron。
 */
function createDesktopShortcut() {
  writeLauncher(launcherNowPath(), 0, { boot: false })
  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')
  return createLnk(
    desktopShortcutPath(),
    wscript,
    `"${launcherNowPath()}"`,
    project(),
    '桌面伴侣'
  )
}

/** 启动文件夹快捷方式：开机延迟 10 秒拉起 */
function createStartupShortcut(delaySec = BOOT_DELAY) {
  writeLauncher(launcherPath(), delaySec)
  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')
  return createLnk(
    startupShortcutPath(),
    wscript,
    `"${launcherPath()}"`,
    project(),
    '桌面伴侣（开机启动）'
  )
}

function isStartupEnabled() {
  try {
    return fs.existsSync(startupShortcutPath())
  } catch {
    return false
  }
}

function setStartupEnabled(on) {
  try {
    if (on) return createStartupShortcut()
    const p = startupShortcutPath()
    if (fs.existsSync(p)) fs.rmSync(p, { force: true })
    return false
  } catch (e) {
    console.warn('[shortcut] 设置启动项失败:', e.message)
    return false
  }
}

/** 清掉早期版本写进注册表的那条 Run 项，避免重复启动 */
function removeLegacyRunKey() {
  try {
    run(
      "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' " +
        "-Name 'DesktopCompanion' -Force -ErrorAction SilentlyContinue"
    )
    return true
  } catch {
    return false
  }
}

function describe() {
  return {
    desktop: desktopShortcutPath(),
    desktopExists: fs.existsSync(desktopShortcutPath()),
    startup: startupShortcutPath(),
    startupExists: isStartupEnabled(),
    launcher: launcherPath(),
    icon: iconPath(),
  }
}

module.exports = {
  createDesktopShortcut,
  createStartupShortcut,
  isStartupEnabled,
  setStartupEnabled,
  removeLegacyRunKey,
  writeLauncher,
  describe,
  BOOT_DELAY,
  SHORTCUT_NAME,
}
