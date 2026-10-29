'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('companion', {
  /** 告诉主进程：现在鼠标是不是该穿透过去 */
  setIgnoreMouse: (v) => ipcRenderer.send('hit:set', !!v),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragEnd: () => ipcRenderer.send('drag:end'),
  hide: () => ipcRenderer.send('window:hide'),
  quit: () => ipcRenderer.send('app:quit'),
  refreshTray: () => ipcRenderer.send('tray:refresh'),
  assets: () => ipcRenderer.invoke('character:assets'),
  info: () => ipcRenderer.invoke('app:info'),
  /** 全局光标位置（窗口坐标系），鼠标在窗口外也会更新 */
  onCursor: (cb) => ipcRenderer.on('cursor:point', (_e, p) => cb(p)),
  /** 截图自检用：外部切换状态 */
  onState: (cb) => ipcRenderer.on('state:set', (_e, s) => cb(s)),
  /** 按住 Alt 说话：开始 / 结束 */
  onPttStart: (cb) => ipcRenderer.on('ptt:start', () => cb()),
  onPttStop: (cb) => ipcRenderer.on('ptt:stop', () => cb()),

  // ---------------- 对话 ----------------
  chatInfo: () => ipcRenderer.invoke('chat:info'),
  chat: (text) => ipcRenderer.invoke('chat:send', text),
  tts: (text) => ipcRenderer.invoke('tts:speak', text),
  onChatDelta: (cb) => ipcRenderer.on('chat:delta', (_e, d) => cb(d)),
  onChatDone: (cb) => ipcRenderer.on('chat:done', () => cb()),
  onChatError: (cb) => ipcRenderer.on('chat:error', (_e, m) => cb(m)),
  onInputToggle: (cb) => ipcRenderer.on('input:toggle', () => cb()),
  onAutoChat: (cb) => ipcRenderer.on('chat:auto', (_e, t) => cb(t)),
  focusWindow: () => ipcRenderer.send('window:focus'),

  // ---------------- 记忆 ----------------
  memoryStats: () => ipcRenderer.invoke('memory:stats'),
  memoryClear: () => ipcRenderer.invoke('memory:clear'),
  onGreeting: (cb) => ipcRenderer.on('memory:greeting', (_e, g) => cb(g)),
  onMemoryCleared: (cb) => ipcRenderer.on('memory:cleared', () => cb()),

  // ---------------- 耳朵 ----------------
  asrStatus: () => ipcRenderer.invoke('asr:status'),
  transcribe: (samples) => ipcRenderer.invoke('asr:transcribe', samples),
  onSimVoice: (cb) => ipcRenderer.on('ptt:sim', (_e, s) => cb(s)),

  // ---------------- 主动开口 ----------------
  onProactiveSay: (cb) => ipcRenderer.on('proactive:say', (_e, t) => cb(t)),
  onProactiveMuted: (cb) => ipcRenderer.on('proactive:muted', () => cb()),
})
