@echo off
setlocal
cd /d "%~dp0"
python -m osnova.cli forge %*
exit /b %ERRORLEVEL%
