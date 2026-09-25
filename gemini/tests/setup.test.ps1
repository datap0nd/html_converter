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

    $nodeCalled = Join-Path $testRoot 'node-called.txt'
    # A fake node.cmd first on PATH: answers the version probe and records the converter command line.
    Set-Content -LiteralPath (Join-Path $testRoot 'node.cmd') -Value "@echo off`r`nif `"%~1`"==`"--version`" (`r`n  echo v22.0.0`r`n  exit /b 0`r`n)`r`necho %* > `"$nodeCalled`"`r`necho converter stderr line 1>&2`r`nexit /b 0`r`n"
    $priorPath = $env:PATH
    try {
        $env:PATH = "$testRoot$([System.IO.Path]::PathSeparator)$priorPath"
        $env:HC_PAGE_SCOPE = 'All'
        & $shell -NoProfile -ExecutionPolicy Bypass -File $bootstrap -LiveScriptPath $liveSource -ArchivePath $zipPath -NoPause
        if ($LASTEXITCODE -ne 0) { throw "Launch setup exited $LASTEXITCODE" }
    } finally {
        $env:PATH = $priorPath
        Remove-Item Env:HC_PAGE_SCOPE -ErrorAction SilentlyContinue
    }
    $called = (Get-Content -LiteralPath $nodeCalled -Raw).Trim()
    if ($called -notmatch 'start-live-report\.mjs' -or $called -match 'page-limit') { throw "setup.ps1 did not run the full converter: $called" }
    try {
        $env:PATH = "$testRoot$([System.IO.Path]::PathSeparator)$priorPath"
        $env:HC_PAGE_SCOPE = 'First2'
        & $shell -NoProfile -ExecutionPolicy Bypass -File $bootstrap -LiveScriptPath $liveSource -ArchivePath $zipPath -NoPause
        if ($LASTEXITCODE -ne 0) { throw "First2 setup exited $LASTEXITCODE" }
    } finally {
        $env:PATH = $priorPath
        Remove-Item Env:HC_PAGE_SCOPE -ErrorAction SilentlyContinue
    }
    if ((Get-Content -LiteralPath $nodeCalled -Raw).Trim() -notmatch 'start-live-report\.mjs --page-limit 2') { throw 'First2 setup did not pass the page limit to the converter.' }
    $latestLog = (Get-Content -LiteralPath (Join-Path $installed 'logs/latest.txt') -Raw).Trim()
    if (-not (Test-Path -LiteralPath $latestLog)) { throw 'Persistent setup log missing.' }
    $logText = Get-Content -LiteralPath $latestLog -Raw
    if ($logText -notmatch 'Starting Gemini report reconstruction' -or $logText -notmatch 'Setup finished successfully') { throw 'Setup log lacks execution outcome.' }
    if ($logText -notmatch 'converter stderr line') { throw 'Converter stderr was not shown or it aborted setup.' }

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
