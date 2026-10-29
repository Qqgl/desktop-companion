/**
 * hotkey.js —— 全局「按住 Alt 说话」
 *
 * Electron 的 globalShortcut 注册不了「单按一个修饰键」，也没有 keyup 事件，
 * 所以这里用底层键盘钩子自己判定：
 *
 *   按下 Alt → 起 120ms 计时
 *     ├─ 期间按了任何别的键（Alt+Tab 之类）→ 判定为快捷键，放弃
 *     └─ 120ms 到点且 Alt 还按着 → 开始聆听
 *   松开 Alt → 结束
 *
 * 顺带还能拿到全局 mouseup，用来修复「鼠标松在窗口外」的拖拽卡死问题。
 */
'use strict'

let uIOhook = null
let UiohookKey = null
let loaded = false

function load() {
  if (loaded) return !!uIOhook
  loaded = true
  try {
    const lib = require('uiohook-napi')
    uIOhook = lib.uIOhook
    UiohookKey = lib.UiohookKey
    return true
  } catch (e) {
    console.warn('[hotkey] 底层键盘钩子不可用（PTT 会退化）:', e.message)
    return false
  }
}

const THRESHOLD_MS = 120

function start({ onStart, onStop, onMouseUp } = {}) {
  if (!load()) return false

  const ALT_KEYS = new Set(
    [UiohookKey.Alt, UiohookKey.AltRight].filter((k) => typeof k === 'number')
  )

  let armed = false      // Alt 已按下，正在等 120ms
  let active = false     // 真的在聆听
  let cancelled = false
  let timer = null

  const clearTimer = () => {
    if (timer) { clearTimeout(timer); timer = null }
  }

  const stop = () => {
    if (!active) return
    active = false
    clearTimer()
    try { onStop && onStop() } catch (e) { console.error(e) }
  }

  uIOhook.on('keydown', (e) => {
    const isAlt = ALT_KEYS.has(e.keycode)

    if (isAlt) {
      if (active || armed) return          // 长按产生的重复 keydown，忽略
      armed = true
      cancelled = false
      clearTimer()
      timer = setTimeout(() => {
        timer = null
        if (armed && !cancelled) {
          armed = false
          active = true
          try { onStart && onStart() } catch (err) { console.error(err) }
        }
      }, THRESHOLD_MS)
      return
    }

    // Alt 按着的时候按了别的键：这是组合快捷键，不是说话
    if (armed) {
      cancelled = true
      armed = false
      clearTimer()
    } else if (active) {
      // 已经在听的时候按别的键，也当作想中断
      stop()
    }
  })

  uIOhook.on('keyup', (e) => {
    if (!ALT_KEYS.has(e.keycode)) return
    clearTimer()
    armed = false
    stop()
  })

  uIOhook.on('mouseup', () => {
    try { onMouseUp && onMouseUp() } catch (e) { /* 忽略 */ }
  })

  uIOhook.start()
  console.log('[hotkey] 全局钩子已启动，按住 Alt 说话')
  return true
}

function stopAll() {
  if (uIOhook) {
    try { uIOhook.stop() } catch { /* 已经停了 */ }
  }
}

module.exports = { start, stopAll, THRESHOLD_MS }
