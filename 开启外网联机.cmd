@echo off
chcp 65001 >nul
title Linkey - 外网穿透联机服务 (Cloudflare Tunnel)
echo ============================================================
echo        Linkey - 广域网外网联机一键启动器
echo ============================================================
echo.
echo 正在启动安全穿透隧道 (提供全球 HTTPS/WSS 加速访问)...
echo.

if not exist "cloudflared.exe" (
    echo [信息] 未找到 cloudflared.exe，正在尝试自动下载...
    curl.exe -L -k -o cloudflared.exe "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    if errorlevel 1 (
        echo [错误] cloudflared.exe 下载失败，请手动下载后放到本目录。
        pause
        exit /b 1
    )
)

rem ---- 查找可用的 Node 运行时: 优先 PATH, 其次 Antigravity 内置运行时 ----
set "NODE_CMD="
where node >nul 2>nul && set "NODE_CMD=node"
if not defined NODE_CMD (
    if exist "%APPDATA%\Antigravity\bin\agy-node.cmd" set "NODE_CMD=%APPDATA%\Antigravity\bin\agy-node.cmd"
)
if not defined NODE_CMD (
    echo [错误] 未找到 Node.js 运行时。请安装 Node.js 22+ 或 Antigravity IDE。
    pause
    exit /b 1
)

echo ------------------------------------------------------------

%NODE_CMD% scripts\tunnel-start.mjs
pause
