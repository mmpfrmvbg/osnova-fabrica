@echo off
setlocal
cd /d "%~dp0"
".bin\act_runner_windows_amd64.exe" daemon
exit /b %ERRORLEVEL%
