@echo off
:: 提示：推荐使用 admin-start.cmd 启动带有崩溃自动拉起与备份守护的管理服务；本脚本仅供前台直连调试
cls
echo =======================================================
echo          Linkey Chat Server Starting...
echo =======================================================

start http://localhost:3000

where node >nul 2>nul
if %errorlevel% equ 0 (
    node src/server.js
) else if exist "%APPDATA%\Antigravity\bin\agy-node.cmd" (
    "%APPDATA%\Antigravity\bin\agy-node.cmd" src/server.js
) else (
    echo [ERROR] Node.js was not found. Install Node.js 24 or newer first.
)

pause
