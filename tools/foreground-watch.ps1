# foreground-watch.ps1
# 常驻侧车：每 1.5 秒输出一行「前台窗口 类名 左 上 宽 高」，给主进程判断是否全屏。
# 只做只读查询，不改任何系统状态。父进程退出后自行结束。

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
      if ([FG]::GetWindowRect($h, [ref]$r)) {
        $w = $r.Right - $r.Left
        $ht = $r.Bottom - $r.Top
        if ($w -gt 0 -and $ht -gt 0) {
          [void]$sb.Clear()
          [void][FG]::GetClassName($h, $sb, 256)
          $cls = $sb.ToString()
          [Console]::Out.WriteLine("$cls $($r.Left) $($r.Top) $w $ht")
          [Console]::Out.Flush()
        }
      }
    }
  } catch {
    # 单次失败不致命，继续循环
  }
  Start-Sleep -Milliseconds 1500
}
