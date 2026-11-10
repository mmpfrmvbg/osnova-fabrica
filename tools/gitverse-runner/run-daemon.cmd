@echo off
setlocal
cd /d "%~dp0"

rem Keep one daemon per .runner registration; a second one competes for jobs.
powershell -NoProfile -Command "if (Get-Process act_runner_windows_amd64 -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo runner already running
  exit /b 0
)

".bin\act_runner_windows_amd64.exe" daemon
exit /b %ERRORLEVEL%
