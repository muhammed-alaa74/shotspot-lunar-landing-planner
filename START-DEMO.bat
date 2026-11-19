@echo off
setlocal
cd /d "%~dp0"

echo SHOTSPOT Judge Edition
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.12+ LTS is required. Install it, then run this launcher again.
  pause
  exit /b 1
)

if "%PORT%"=="" (
  node scripts\serve.mjs
) else (
  node scripts\serve.mjs %PORT%
)

echo.
pause
