$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host '========================================================' -ForegroundColor Cyan
Write-Host '       Linkey 全套客户端与安装包一键生成器' -ForegroundColor Green
Write-Host '========================================================' -ForegroundColor Cyan

python scripts/build_all.py
if ($LASTEXITCODE -ne 0) {
    throw "Linkey 构建失败，退出代码: $LASTEXITCODE"
}
