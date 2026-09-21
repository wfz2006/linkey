$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop)
$ShortcutPath = Join-Path $DesktopPath "Linkey 服务端管理系统.lnk"
$TargetPath = "d:\software\dist\Linkey-服务端管理系统.exe"

if (Test-Path $TargetPath) {
    $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = $TargetPath
    $Shortcut.WorkingDirectory = "d:\software"
    $Shortcut.Description = "Linkey 服务端与后台管理桌面软件"
    $Shortcut.Save()
    Write-Host "[SUCCESS] 桌面快捷方式已成功创建: $ShortcutPath"
} else {
    Write-Warning "未找到目标文件: $TargetPath"
}
