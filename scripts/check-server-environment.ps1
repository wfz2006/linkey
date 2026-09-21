param([switch]$DeepMigrationCheck)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$failed = $false

function Resolve-MigrationFile([string]$Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or $Relative -match '[:\\]' -or
        $Relative.StartsWith('/') -or $Relative -match '(^|/)\.\.?(/|$)' -or $Relative.Contains('//')) {
        throw "迁移清单含有非法相对路径: $Relative"
    }
    $target = $projectRoot
    foreach ($part in $Relative.Split('/')) {
        $target = Join-Path $target $part
        $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "迁移文件不能为链接: $Relative" }
    }
    $full = [IO.Path]::GetFullPath($target)
    $prefix = [IO.Path]::GetFullPath($projectRoot).TrimEnd('\') + '\'
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "迁移文件路径无效: $Relative" }
    return $full
}

function Get-MigrationHash([string]$File) {
    $stream = $null
    $algorithm = $null
    try {
        $stream = [IO.File]::OpenRead($File)
        $algorithm = [Security.Cryptography.SHA256]::Create()
        return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $algorithm) { $algorithm.Dispose() }
    }
}

function Test-MigrationEntry($Entry, [bool]$HashRequired) {
    if ($null -eq $Entry -or $Entry.path -isnot [string] -or
        $Entry.sha256 -isnot [string] -or $Entry.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or
        ($Entry.size -isnot [int] -and $Entry.size -isnot [long]) -or $Entry.size -lt 0) {
        throw '迁移清单文件条目格式无效'
    }
    $file = Resolve-MigrationFile $Entry.path
    if ((Get-Item -LiteralPath $file).Length -ne $Entry.size) { throw "迁移文件大小不符: $($Entry.path)" }
    if ($HashRequired -and (Get-MigrationHash $file) -ne $Entry.sha256) {
        throw "迁移文件 SHA256 不符: $($Entry.path)"
    }
}

if (Test-Path -LiteralPath (Join-Path $projectRoot '迁移清单.json')) {
    try {
        $manifestPath = Resolve-MigrationFile '迁移清单.json'
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $date = [DateTimeOffset]::MinValue
        $exportedAtValid = ($manifest.exportedAt -is [DateTime] -or $manifest.exportedAt -is [DateTimeOffset])
        if ($manifest.exportedAt -is [string]) {
            $exportedAtValid = [DateTimeOffset]::TryParse($manifest.exportedAt, [ref]$date)
        }
        if (($manifest.formatVersion -isnot [int] -and $manifest.formatVersion -isnot [long]) -or $manifest.formatVersion -ne 1 -or
            $manifest.linkeyVersion -isnot [string] -or [string]::IsNullOrWhiteSpace($manifest.linkeyVersion) -or
            -not $exportedAtValid -or
            $manifest.hasAdminPassword -isnot [bool] -or $manifest.attachments -isnot [array] -or
            ($manifest.attachmentCount -isnot [int] -and $manifest.attachmentCount -isnot [long]) -or
            ($manifest.attachmentBytes -isnot [int] -and $manifest.attachmentBytes -isnot [long]) -or
            $manifest.attachmentCount -ne $manifest.attachments.Count -or $manifest.attachmentBytes -lt 0 -or
            $manifest.database.path -cne 'qq_chat.db') { throw '迁移清单结构或版本无效' }
        Test-MigrationEntry $manifest.database $true
        $seen = @{}
        [long]$total = 0
        foreach ($entry in $manifest.attachments) {
            if ($entry.path -isnot [string] -or -not $entry.path.StartsWith('uploads/', [StringComparison]::Ordinal) -or
                $seen.ContainsKey($entry.path)) { throw '迁移附件路径无效或重复' }
            $seen[$entry.path] = $true
            Test-MigrationEntry $entry ([bool]$DeepMigrationCheck)
            $total += $entry.size
        }
        if ($total -ne $manifest.attachmentBytes) { throw '迁移附件总大小不符' }
        Write-Host '[通过] 迁移数据库及附件校验完成。'
    } catch {
        Write-Host "[迁移校验失败] $($_.Exception.Message)"
        Write-Host '此清单用于首次启动前验证；运行后数据库发生变化属于正常情况，请勿覆盖已有数据。'
        $failed = $true
    }
}

Write-Host '============================================================'
Write-Host '       Linkey 全新服务器环境检查'
Write-Host '============================================================'

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
    $nodeVersion = & node --version
    if ($nodeVersion -match '^v(\d+)') {
        $nodeMajor = [int]$Matches[1]
        if ($nodeMajor -lt 24) {
            Write-Host "[版本过低] 当前 Node.js: $nodeVersion；本项目需要 Node.js 24 或更高版本。"
            $failed = $true
        } else {
            Write-Host "[通过] Node.js: $nodeVersion"
        }
    } else {
        Write-Host "[异常] 无法识别 Node.js 版本: $nodeVersion"
        $failed = $true
    }
} else {
    Write-Host '[缺少] 未找到 Node.js，请先安装 Node.js 24 或更高版本。'
    $failed = $true
}

$requiredFiles = @(
    'package.json',
    'src\server.js',
    'admin\admin.js',
    'public\index.html',
    'Linkey-服务端管理系统.exe'
)

foreach ($relative in $requiredFiles) {
    $target = Join-Path $projectRoot $relative
    if (Test-Path -LiteralPath $target -PathType Leaf) {
        Write-Host "[通过] 文件: $relative"
    } else {
        Write-Host "[缺少] 文件: $relative"
        $failed = $true
    }
}

foreach ($port in 3000, 3001) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    if ($listener) {
        Write-Host "[提示] 端口 $port 已被占用，启动前请关闭对应程序。"
    } else {
        Write-Host "[通过] 端口 $port 当前可用。"
    }
}

if ($failed) {
    Write-Host '检查未通过，请根据上面的提示补齐环境或文件。'
    exit 1
}

Write-Host '检查通过，可以双击“Linkey-服务端管理系统.exe”启动。'
exit 0
