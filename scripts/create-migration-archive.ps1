[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceDirectory,

    [Parameter(Mandatory = $true)]
    [string]$OutputFile
)

$ErrorActionPreference = 'Stop'
$archive = $null
$inputArchive = $null
$outputArchive = $null
$outputStream = $null
$ownsWorkOutput = $false
$ownsNormalizationOutput = $false
$completedSuccessfully = $false
$normalizationPath = $null

function Test-FullyQualifiedPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [System.IO.Path]::IsPathRooted($Value)) {
        return $false
    }
    # Windows PowerShell runs on .NET Framework, where Path.IsPathFullyQualified
    # is not always available. A drive-rooted or UNC path is the equivalent rule.
    return $Value -match '^[A-Za-z]:[\\/]' -or
        $Value -match '^[\\/]{2}[^\\/]+[\\/]+[^\\/]+'
}

function Assert-SafeSourceTree([string]$Root) {
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($Root)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($directory)) {
            $attributes = [System.IO.File]::GetAttributes($entry)
            if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "SourceDirectory contains a reparse point, symbolic link, or junction: $entry"
            }
            if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
                $pending.Push($entry)
            } elseif (-not [System.IO.File]::Exists($entry)) {
                throw "SourceDirectory contains a special entry: $entry"
            }
        }
    }
}

function Close-Resources([object[]]$Resources) {
    $firstError = $null
    foreach ($resource in $Resources) {
        if ($null -eq $resource) {
            continue
        }
        try {
            $resource.Dispose()
        } catch {
            if ($null -eq $firstError) {
                $firstError = $_.Exception
            }
        }
    }
    return $firstError
}

try {
    if (-not (Test-FullyQualifiedPath $SourceDirectory)) {
        throw 'SourceDirectory must be an absolute, fully qualified path'
    }
    if (-not (Test-FullyQualifiedPath $OutputFile)) {
        throw 'OutputFile must be an absolute, fully qualified path'
    }
    $resolvedSource = [System.IO.Path]::GetFullPath($SourceDirectory)
    $resolvedOutput = [System.IO.Path]::GetFullPath($OutputFile)

    if (-not [System.IO.Directory]::Exists($resolvedSource)) {
        throw "SourceDirectory is not an existing directory: $resolvedSource"
    }

    $sourceInfo = [System.IO.DirectoryInfo]::new($resolvedSource)
    if (($sourceInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "SourceDirectory cannot be a reparse point: $resolvedSource"
    }

    $isCompatPartial = $resolvedOutput.EndsWith('.zip.partial', [System.StringComparison]::OrdinalIgnoreCase)
    $isUniquePartial = [System.Text.RegularExpressions.Regex]::IsMatch(
        $resolvedOutput,
        '\.zip\.[A-Za-z0-9_-]{1,128}\.partial$',
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    $isPartial = $isCompatPartial -or $isUniquePartial
    $isFinalZip = $resolvedOutput.EndsWith('.zip', [System.StringComparison]::OrdinalIgnoreCase)
    if (-not $isPartial -and -not $isFinalZip) {
        throw 'OutputFile must end with .zip, .zip.partial, or .zip.<safe-id>.partial'
    }

    $finalOutput = if ($isCompatPartial) {
        $resolvedOutput.Substring(0, $resolvedOutput.Length - '.partial'.Length)
    } elseif ($isUniquePartial) {
        [System.Text.RegularExpressions.Regex]::Replace(
            $resolvedOutput,
            '(?i)(\.zip)\.[A-Za-z0-9_-]{1,128}\.partial$',
            '$1'
        )
    } else {
        $resolvedOutput
    }
    if ([System.IO.File]::Exists($finalOutput)) {
        throw "Completed ZIP already exists and will not be overwritten: $finalOutput"
    }

    $outputParent = [System.IO.Path]::GetDirectoryName($resolvedOutput)
    if ([string]::IsNullOrWhiteSpace($outputParent)) {
        throw 'OutputFile must have a parent directory'
    }
    [System.IO.Directory]::CreateDirectory($outputParent) | Out-Null
    $parentInfo = [System.IO.DirectoryInfo]::new($outputParent)
    if (($parentInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Output directory cannot be a reparse point: $outputParent"
    }

    if ([System.IO.File]::Exists($resolvedOutput) -or [System.IO.Directory]::Exists($resolvedOutput)) {
        throw "Requested archive output already exists and will not be overwritten: $resolvedOutput"
    }

    if ($isPartial) {
        $workOutput = $resolvedOutput
    } else {
        $workOutput = "$resolvedOutput.partial"
    }
    $normalizationPath = "$workOutput.normalize"
    if ([System.IO.File]::Exists($workOutput) -or
        [System.IO.Directory]::Exists($workOutput)) {
        throw "Archive work output already exists and will not be overwritten: $workOutput"
    }
    if ([System.IO.File]::Exists($normalizationPath) -or
        [System.IO.Directory]::Exists($normalizationPath)) {
        throw "Archive normalization output already exists and will not be overwritten: $normalizationPath"
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Assert-SafeSourceTree $resolvedSource
    $ownsWorkOutput = $true
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $resolvedSource,
        $workOutput,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )

    # Windows PowerShell's .NET Framework emits backslashes in ZIP entry names.
    # Rewrite the just-created archive once so the published ZIP uses portable
    # forward-slash paths and can be safely validated before release.
    $normalizedNames = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $inputArchive = [System.IO.Compression.ZipFile]::OpenRead($workOutput)
    $outputStream = [System.IO.FileStream]::new(
        $normalizationPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    $ownsNormalizationOutput = $true
    $outputArchive = [System.IO.Compression.ZipArchive]::new(
        $outputStream,
        [System.IO.Compression.ZipArchiveMode]::Create,
        $true
    )
    foreach ($sourceEntry in $inputArchive.Entries) {
        $normalizedName = $sourceEntry.FullName.Replace('\', '/')
        if ([string]::IsNullOrWhiteSpace($normalizedName)) {
            throw 'ZIP contains an empty entry name'
        }
        if ($normalizedName.StartsWith('/') -or $normalizedName.StartsWith('\')) {
            throw "ZIP contains an absolute entry: $normalizedName"
        }
        if ([System.IO.Path]::IsPathRooted($normalizedName) -or $normalizedName -match '^[A-Za-z]:') {
            throw "ZIP contains an absolute entry: $normalizedName"
        }
        if ($normalizedName.Split('/') -contains '..') {
            throw "ZIP contains a traversal entry: $normalizedName"
        }
        if (-not $normalizedNames.Add($normalizedName)) {
            throw "ZIP contains a duplicate entry: $normalizedName"
        }

        $targetEntry = $outputArchive.CreateEntry(
            $normalizedName,
            [System.IO.Compression.CompressionLevel]::Optimal
        )
        $targetEntry.LastWriteTime = $sourceEntry.LastWriteTime
        $sourceStream = $null
        $targetStream = $null
        $copyError = $null
        try {
            $sourceStream = $sourceEntry.Open()
            $targetStream = $targetEntry.Open()
            $sourceStream.CopyTo($targetStream)
        } catch {
            $copyError = $_.Exception
        }
        $closeError = Close-Resources -Resources @($targetStream, $sourceStream)
        if ($null -ne $copyError) {
            throw $copyError
        }
        if ($null -ne $closeError) {
            throw $closeError
        }
    }
    $closeError = Close-Resources -Resources @($outputArchive, $outputStream, $inputArchive)
    $outputArchive = $null
    $outputStream = $null
    $inputArchive = $null
    if ($null -ne $closeError) {
        throw $closeError
    }
    [System.IO.File]::Delete($workOutput)
    $ownsWorkOutput = $false
    [System.IO.File]::Move($normalizationPath, $workOutput)
    $ownsNormalizationOutput = $false
    $ownsWorkOutput = $true

    $outputInfo = [System.IO.FileInfo]::new($workOutput)
    if (-not $outputInfo.Exists -or ($outputInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Archive output is not a regular file: $workOutput"
    }

    $rootName = 'Linkey-' + [char]0x5B8C + [char]0x6574 + [char]0x6570 +
        [char]0x636E + [char]0x670D + [char]0x52A1 + [char]0x5668
    $manifestName = [string]([char]0x8FC1) + [char]0x79FB + [char]0x6E05 + [char]0x5355 + '.json'
    $checkerName = [string]([char]0x68C0) + [char]0x67E5 + [char]0x670D + [char]0x52A1 +
        [char]0x5668 + [char]0x73AF + [char]0x5883 + '.ps1'
    $requiredEntries = @(
        "$rootName/qq_chat.db",
        "$rootName/$manifestName",
        "$rootName/package.json",
        "$rootName/start.bat",
        "$rootName/$checkerName",
        "$rootName/scripts/create-migration-archive.ps1"
    )
    $seen = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $found = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::Ordinal
    )

    $archive = [System.IO.Compression.ZipFile]::OpenRead($workOutput)
    foreach ($entry in $archive.Entries) {
        $name = $entry.FullName
        if ([string]::IsNullOrWhiteSpace($name)) {
            throw 'ZIP contains an empty entry name'
        }
        if ($name.StartsWith('/') -or $name.StartsWith('\') -or $name.Contains('\')) {
            throw "ZIP contains an absolute or backslash entry: $name"
        }
        if ([System.IO.Path]::IsPathRooted($name) -or $name -match '^[A-Za-z]:') {
            throw "ZIP contains an absolute entry: $name"
        }
        $segments = $name.Split('/')
        if ($segments -contains '..') {
            throw "ZIP contains a traversal entry: $name"
        }
        if (-not $seen.Add($name)) {
            throw "ZIP contains a duplicate entry: $name"
        }
        [void]$found.Add($name)
    }

    foreach ($required in $requiredEntries) {
        if (-not $found.Contains($required)) {
            throw "ZIP is missing required entry: $required"
        }
    }

    $entryCount = $archive.Entries.Count
    $archive.Dispose()
    $archive = $null
    $outputInfo.Refresh()
    $outputSize = $outputInfo.Length
    if (-not $isPartial) {
        [System.IO.File]::Move($workOutput, $resolvedOutput)
    }
    $ownsWorkOutput = $false
    $result = [ordered]@{
        entryCount = $entryCount
        size = $outputSize
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
    $completedSuccessfully = $true
} catch {
    $failure = $_.Exception
    [void](Close-Resources -Resources @($outputArchive, $outputStream, $inputArchive, $archive))
    $outputArchive = $null
    $outputStream = $null
    $inputArchive = $null
    $archive = $null
    if ($ownsWorkOutput -and $null -ne $workOutput -and [System.IO.File]::Exists($workOutput)) {
        try { [System.IO.File]::Delete($workOutput) } catch { }
    }
    if ($ownsNormalizationOutput -and $null -ne $normalizationPath -and
        [System.IO.File]::Exists($normalizationPath)) {
        try { [System.IO.File]::Delete($normalizationPath) } catch { }
    }
    [Console]::Error.WriteLine($failure.Message)
    exit 1
} finally {
    [void](Close-Resources -Resources @($outputArchive, $outputStream, $inputArchive, $archive))
    if ($ownsWorkOutput -and -not $completedSuccessfully -and
        $null -ne $workOutput -and [System.IO.File]::Exists($workOutput)) {
        try { [System.IO.File]::Delete($workOutput) } catch { }
    }
    if ($ownsNormalizationOutput -and $null -ne $normalizationPath -and
        [System.IO.File]::Exists($normalizationPath)) {
        try { [System.IO.File]::Delete($normalizationPath) } catch { }
    }
}
