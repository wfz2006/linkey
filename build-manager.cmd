@echo off
chcp 65001 >nul
echo [Linkey] 正在编译 Linkey 服务端与管理系统桌面软件...
if not exist dist mkdir dist
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe /win32icon:app.ico /out:"dist\Linkey-服务端管理系统.exe" /r:System.Windows.Forms.dll,System.Drawing.dll,System.dll,System.Web.Extensions.dll src_manager\FastQQServerManager.cs
if %ERRORLEVEL% equ 0 (
    echo [SUCCESS] 编译完成: dist\Linkey-服务端管理系统.exe
    powershell -ExecutionPolicy Bypass -File scripts\create_desktop_shortcut.ps1
) else (
    echo [ERROR] 编译失败！
)
pause
