@echo off
cd /d "%~dp0"
title AgentCodeGUI - INSTALL
echo.
echo   Installing dependencies (npm install)...
echo.
call npm install
if errorlevel 1 (
  echo.
  echo   [install FAILED] check the errors above.
  pause
  exit /b 1
)
echo.
echo   Ensuring Electron binary (self-heal; skips if already installed)...
echo.
REM npm의 postinstall이 ignore-scripts 등으로 건너뛰어도 electron 바이너리가
REM 확실히 깔리도록 직접 한 번 더 호출한다(idempotent — 이미 있으면 즉시 skip).
call node scripts\fetch-electron.cjs
if errorlevel 1 (
  echo.
  echo   [electron fetch FAILED] check the errors above.
) else (
  echo.
  echo   [install OK] now run dev.bat
)
pause
