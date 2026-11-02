# foreground-watch.ps1
# 常驻侧车：每 1.5 秒输出一行「类名 左 上 宽 高 有无标题栏」，给主进程判断是否全屏。
# 只做只读查询，不改任何系统状态。父进程退出后自行结束。
#
# 为什么不用 GetWindowRect：
#   Windows 11 的最大化窗口会在四周各外扩 8px（不可见的调整边框），
#   GetWindowRect 返回的矩形比屏幕还大 —— 于是"任何最大化窗口"都会被
#   误判成全屏，桌宠就被藏起来了。用户必须最小化窗口才能再看到她。
#
# 改用 DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS) 拿**可见**边界：
#   最大化的窗口 → 可见边界正好是工作区（不含任务栏），比屏幕矮，不算全屏
#   真全屏的游戏/视频 → 可见边界铺满整块屏幕，算全屏
# 再附带一个"有没有标题栏"的信号作为兜底（全屏通常没有 WS_CAPTION）。

$ErrorActionPreference = 'Stop'

try {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class FG {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    public const int GWL_STYLE = -16;
    public const int WS_CAPTION = 0x00C00000;

    /** 可见边界；DWM 不可用时退回 GetWindowRect */
    public static bool GetVisibleRect(IntPtr h, out RECT r) {
        int hr = DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT)));
        if (hr != 0) return GetWindowRect(h, out r);
        if (r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0) return GetWindowRect(h, out r);
        return true;
    }

    /** 有没有标题栏：全屏应用通常没有 */
    public static bool HasCaption(IntPtr h) {
        return (GetWindowLong(h, GWL_STYLE) & WS_CAPTION) == WS_CAPTION;
    }
}
'@
} catch {
  try {
    $_.Exception.ToString() | Out-File -FilePath (Join-Path $PSScriptRoot 'watch-error.log') -Append -Encoding utf8
  } catch { }
  exit 1
}

$sb = New-Object System.Text.StringBuilder 256

while ($true) {
  try {
    $h = [FG]::GetForegroundWindow()
    if ($h -ne [IntPtr]::Zero) {
      $r = New-Object FG+RECT
      if ([FG]::GetVisibleRect($h, [ref]$r)) {
        $w = $r.Right - $r.Left
        $ht = $r.Bottom - $r.Top
        if ($w -gt 0 -and $ht -gt 0) {
          [void]$sb.Clear()
          [void][FG]::GetClassName($h, $sb, 256)
          $cls = $sb.ToString()
          $cap = if ([FG]::HasCaption($h)) { 1 } else { 0 }
          [Console]::Out.WriteLine("$cls $($r.Left) $($r.Top) $w $ht $cap")
          [Console]::Out.Flush()
        }
      }
    }
  } catch {
    # 单次失败不致命，继续循环
  }
  Start-Sleep -Milliseconds 1500
}
