/**
 * autostart.js —— 开机自启（现在走启动文件夹，不再用注册表）
 *
 * 注册表 Run 项那条路试过了：重启后进程根本没起来，连一行日志都没留。
 * 现在的链路是：
 *
 *   启动文件夹/桌面伴侣.lnk → wscript → tools/launch.vbs → 等 10 秒 → electron --boot
 *
 * 好处：延迟启动（避开登录风暴）、无黑框、并且能在「任务管理器 → 启动应用」里看见。
 * 具体实现都在 shortcut.js。
 */
'use strict'

const shortcut = require('./shortcut')

const BOOT_FLAG = '--boot'

function isEnabled() {
  return shortcut.isStartupEnabled()
}

function setEnabled(on) {
  if (on) shortcut.removeLegacyRunKey() // 顺手清掉旧的注册表项，避免重复启动
  return shortcut.setStartupEnabled(on)
}

/** 这次是不是被开机启动拉起来的 */
function wasOpenedAtLogin() {
  return process.argv.includes(BOOT_FLAG)
}

function describe() {
  return shortcut.describe()
}

module.exports = { isEnabled, setEnabled, wasOpenedAtLogin, describe, BOOT_FLAG }
