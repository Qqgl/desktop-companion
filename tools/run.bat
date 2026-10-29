@echo off
rem Desktop Companion launcher - generated automatically, do not edit.
rem Runs Electron from the project root and captures everything it prints,
rem so a silent crash still leaves a trace in logs\console.log.
rem %* forwards --boot when started from the Startup folder.
rem
rem Flags are not optional on this machine:
rem   --no-sandbox          without it Chromium init dies with 0x80000003
rem   --user-data-dir=...   the default %%APPDATA%% profile is not writable here
rem                         (exit code -36861)

cd /d "%~dp0.."

set "LOG=logs\console.log"
if not exist "logs" mkdir "logs"

echo. >> "%LOG%"
echo ===== %DATE% %TIME%  args=[%*]  cwd=%CD% ===== >> "%LOG%"

if exist "node_modules\electron\dist\electron.exe" goto haveelectron
echo ERROR: electron.exe not found under node_modules >> "%LOG%"
exit /b 1

:haveelectron
"node_modules\electron\dist\electron.exe" "." --no-sandbox --user-data-dir="%~dp0..\data" %* >> "%LOG%" 2>&1
echo ===== exit code %ERRORLEVEL% ===== >> "%LOG%"
