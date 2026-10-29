' Desktop Companion launcher - generated automatically, do not edit.
' ASCII only. Waits 10s, then runs run.bat through cmd /c.
Option Explicit
Dim sh, fso, f, logFile, bat, cmdLine
Set sh = CreateObject("WScript.Shell")
bat = "D:\software\AISoft\dsh\DSH Desktop\workspace\desktop-companion\tools\run.bat"
logFile = "D:\software\AISoft\dsh\DSH Desktop\workspace\desktop-companion\logs\boot.log"

On Error Resume Next
Set fso = CreateObject("Scripting.FileSystemObject")
Set f = fso.OpenTextFile(logFile, 8, True)
If Err.Number = 0 Then
  f.WriteLine Now & "  launcher fired, delay 10s"
  f.Close
End If
On Error Goto 0

WScript.Sleep 10000
cmdLine = "cmd /c """ & bat & """ --boot"
sh.Run cmdLine, 0, False
