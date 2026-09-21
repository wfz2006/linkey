@echo off
setlocal enabledelayedexpansion
title Stop Linkey Admin and Main Server

cd /d "%~dp0"

echo [STOPPING] Terminating Linkey Main Server and Admin Daemon...

:: Kill node processes running admin or src/server.js
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING 2^>nul') do (
  echo Killing Admin process PID %%a...
  taskkill /F /PID %%a >nul 2^>nul
)

for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING 2^>nul') do (
  echo Killing Main app process PID %%a...
  taskkill /F /PID %%a >nul 2^>nul
)

echo [SUCCESS] Linkey Admin and Main Server have been stopped.
timeout /t 2 >nul
