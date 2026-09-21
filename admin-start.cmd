@echo off
setlocal enabledelayedexpansion
title Linkey Admin Supervisor Launcher

cd /d "%~dp0"

:: 1. Resolve Node Executable
set "NODE_EXE=node"
where node >nul 2>nul
if %errorlevel% neq 0 (
  if exist "%APPDATA%\Antigravity\bin\agy-node.cmd" (
    set "NODE_EXE=%APPDATA%\Antigravity\bin\agy-node.cmd"
  ) else (
    echo [ERROR] Node.js was not found. Install Node.js 24 or newer first.
    pause
    exit /b 1
  )
)

:: 2. Check if Admin (Port 3001) is already running (Idempotent)
powershell -NoProfile -Command "if (Test-NetConnection -ComputerName 127.0.0.1 -Port 3001 -InformationLevel Quiet -WarningAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>nul
if %errorlevel% equ 0 (
  echo [INFO] Linkey Admin is already running on port 3001.
  echo - Web Dashboard: http://localhost:3001
  echo - Main App     : http://localhost:3000
  exit /b 0
)

:: 3. Launch Admin Supervisor Daemon in Background
echo [STARTING] Launching Linkey Admin Supervisor on port 3001...
start "Linkey-Admin" /min "!NODE_EXE!" admin\admin.js

timeout /t 2 >nul
echo [SUCCESS] Linkey Admin has started!
echo - Web Dashboard: http://localhost:3001
echo - Main App     : http://localhost:3000
