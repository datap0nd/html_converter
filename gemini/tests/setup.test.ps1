# Isolated bootstrap test: no network, npm installation, or report data.
$ErrorActionPreference = 'Stop'
$sourceGemini = Split-Path $PSScriptRoot -Parent
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('html-converter-setup-test-' + [guid]::NewGuid().ToString('N'))
$testRootFull = [System.IO.Path]::GetFullPath($testRoot)
$tempParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
if (-not $testRootFull.StartsWith($tempParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unsafe setup test directory.'
}

try {
    $installed = Join-Path $testRoot 'installed/gemini'
    $archiveGemini = Join-Path $testRoot 'html_converter-test/gemini'
    foreach ($dir in @($installed, $archiveGemini)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    foreach ($file in @('setup.ps1', 'live-setup.ps1', 'package.json', 'package-lock.json')) {
        Copy-Item -LiteralPath (Join-Path $sourceGemini $file) -Destination (Join-Path $installed $file)
        Copy-Item -LiteralPath (Join-Path $sourceGemini $file) -Destination (Join-Path $archiveGemini $file)
    }
    Add-Content -LiteralPath (Join-Path $archiveGemini 'setup.ps1') -Value '# Must not replace the stable bootstrap.'
    $bootstrapHash = (Get-FileHash -LiteralPath (Join-Path $installed 'setup.ps1') -Algorithm SHA256).Hash
    Set-Content -LiteralPath (Join-Path $installed 'README.md') -Value 'old code'
    Set-Content -LiteralPath (Join-Path $archiveGemini 'README.md') -Value 'updated code'
    Set-Content -LiteralPath (Join-Path $installed '.env') -Value 'PG_PASSWORD=keep-this-private'
    Set-Content -LiteralPath (Join-Path $archiveGemini '.env') -Value 'PG_PASSWORD=must-not-copy'
    foreach ($relative in @('input/report.pbip', 'output/dynamic/report.html', 'work/notes.txt', 'logs/old.log', 'node_modules/pg/package.json')) {
        $target = Join-Path $installed $relative
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        Set-Content -LiteralPath $target -Value "preserve $relative"
    }
    foreach ($relative in @('input/archive-only.pbip', 'output/dynamic/archive-only.html', 'work/archive-only.txt', 'logs/archive-only.log', 'node_modules/archive-only/package.json')) {
        $target = Join-Path $archiveGemini $relative
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        Set-Content -LiteralPath $target -Value 'must not copy'
    }
    $zipPath = Join-Path $testRoot 'update.zip'
    Compress-Archive -LiteralPath (Join-Path $testRoot 'html_converter-test') -DestinationPath $zipPath
    $bootstrap = Join-Path $installed 'setup.ps1'
    $liveSource = Join-Path $archiveGemini 'live-setup.ps1'
    $shell = (Get-Process -Id $PID).Path

    & $shell -NoProfile -ExecutionPolicy Bypass -File $bootstrap -ArchivePath $zipPath -NoRun -NoPause
    if ($LASTEXITCODE -ne 0) { throw "NoRun setup exited $LASTEXITCODE" }
    if ((Get-Content -LiteralPath (Join-Path $installed 'README.md') -Raw).Trim() -ne 'updated code') { throw 'Code was not updated.' }
    if ((Get-Content -LiteralPath (Join-Path $installed '.env') -Raw).Trim() -ne 'PG_PASSWORD=keep-this-private') { throw '.env was modified.' }
    if ((Get-FileHash -LiteralPath $bootstrap -Algorithm SHA256).Hash -ne $bootstrapHash) { throw 'Stable setup.ps1 was replaced.' }
    foreach ($relative in @('input/report.pbip', 'output/dynamic/report.html', 'work/notes.txt', 'logs/old.log', 'node_modules/pg/package.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $installed $relative))) { throw "Protected file was removed: $relative" }
    }
    foreach ($relative in @('input/archive-only.pbip', 'output/dynamic/archive-only.html', 'work/archive-only.txt', 'logs/archive-only.log', 'node_modules/archive-only/package.json')) {
        if (Test-Path -LiteralPath (Join-Path $installed $relative)) { throw "Protected folder was overwritten: $relative" }
    }
    if (Get-ChildItem -LiteralPath $installed -Directory -Filter '.setup-temp-*') { throw 'Temporary update directory was not cleaned up.' }

    $npmCalled = Join-Path $testRoot 'npm-called.txt'
    Set-Content -LiteralPath (Join-Path $testRoot 'npm.cmd') -Value "@echo off`r`necho %* > `"$npmCalled`"`r`n"
    $priorPath = $env:PATH
    try {
        $env:PATH = "$testRoot$([System.IO.Path]::PathSeparator)$priorPath"
        & $shell -NoProfile -ExecutionPolicy Bypass -File $bootstrap -LiveScriptPath $liveSource -ArchivePath $zipPath -NoPause
        if ($LASTEXITCODE -ne 0) { throw "Launch setup exited $LASTEXITCODE" }
    } finally { $env:PATH = $priorPath }
    if ((Get-Content -LiteralPath $npmCalled -Raw).Trim() -ne 'start') { throw 'setup.ps1 did not run npm start.' }
    $latestLog = (Get-Content -LiteralPath (Join-Path $installed 'logs/latest.txt') -Raw).Trim()
    if (-not (Test-Path -LiteralPath $latestLog)) { throw 'Persistent setup log missing.' }
    $logText = Get-Content -LiteralPath $latestLog -Raw
    if ($logText -notmatch 'Starting the live HTML converter' -or $logText -notmatch 'Setup finished successfully') { throw 'Setup log lacks execution outcome.' }

    $env:HC_SETUP_INSTALL_DEPS = '0'
    try {
        & $shell -NoProfile -ExecutionPolicy Bypass -File $bootstrap -SkipUpdate -NoRun
        if ($LASTEXITCODE -ne 0) { throw "Legacy compatibility exited $LASTEXITCODE" }
    } finally { Remove-Item Env:HC_SETUP_INSTALL_DEPS -ErrorAction SilentlyContinue }

    $badLive = Join-Path $testRoot 'bad-live.ps1'
    Set-Content -LiteralPath $badLive -Value '# not the expected script'
    & $shell -NoProfile -ExecutionPolicy Bypass -File $bootstrap -LiveScriptPath $badLive -NoRun -NoPause
    if ($LASTEXITCODE -eq 0) { throw 'Invalid live script was accepted.' }
    $failureLog = (Get-Content -LiteralPath (Join-Path $installed 'logs/latest.txt') -Raw).Trim()
    if ((Get-Content -LiteralPath $failureLog -Raw) -notmatch 'SETUP FAILED') { throw 'Failure was not logged.' }
    Write-Host 'setup.ps1 bootstrap test passed.' -ForegroundColor Green
} finally {
    if (Test-Path -LiteralPath $testRootFull) {
        if (-not $testRootFull.StartsWith($tempParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe setup test cleanup path.' }
        Remove-Item -LiteralPath $testRootFull -Recurse -Force
    }
}
