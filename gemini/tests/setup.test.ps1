# Isolated installer test. Uses a synthetic local ZIP; no network, npm, or report data.
$ErrorActionPreference = 'Stop'
$geminiSource = Split-Path $PSScriptRoot -Parent
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
    foreach ($file in @('setup.ps1', 'package.json', 'package-lock.json')) {
        Copy-Item -LiteralPath (Join-Path $geminiSource $file) -Destination (Join-Path $installed $file)
        Copy-Item -LiteralPath (Join-Path $geminiSource $file) -Destination (Join-Path $archiveGemini $file)
    }
    Add-Content -LiteralPath (Join-Path $archiveGemini 'setup.ps1') -Value '# New installer version for self-relaunch test.'
    Set-Content -LiteralPath (Join-Path $installed 'README.md') -Value 'old code'
    Set-Content -LiteralPath (Join-Path $archiveGemini 'README.md') -Value 'updated code'
    Set-Content -LiteralPath (Join-Path $installed '.env') -Value 'PG_PASSWORD=keep-this-private'
    Set-Content -LiteralPath (Join-Path $archiveGemini '.env') -Value 'PG_PASSWORD=must-not-copy'
    foreach ($relative in @('input/report.pbip', 'output/dynamic/report.html', 'work/notes.txt', 'node_modules/pg/package.json')) {
        $target = Join-Path $installed $relative
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        Set-Content -LiteralPath $target -Value "preserve $relative"
    }
    foreach ($relative in @('input/archive-only.pbip', 'output/dynamic/archive-only.html', 'work/archive-only.txt', 'node_modules/archive-only/package.json')) {
        $target = Join-Path $archiveGemini $relative
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        Set-Content -LiteralPath $target -Value 'must not copy'
    }
    $zipPath = Join-Path $testRoot 'update.zip'
    Compress-Archive -LiteralPath (Join-Path $testRoot 'html_converter-test') -DestinationPath $zipPath
    & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installed 'setup.ps1') -ArchivePath $zipPath -NoRun
    if ($LASTEXITCODE -ne 0) { throw "setup.ps1 exited $LASTEXITCODE" }
    if ((Get-Content -LiteralPath (Join-Path $installed 'README.md') -Raw).Trim() -ne 'updated code') { throw 'Code was not updated.' }
    if ((Get-Content -LiteralPath (Join-Path $installed '.env') -Raw).Trim() -ne 'PG_PASSWORD=keep-this-private') { throw '.env was modified.' }
    foreach ($relative in @('input/report.pbip', 'output/dynamic/report.html', 'work/notes.txt', 'node_modules/pg/package.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $installed $relative))) { throw "Protected file was removed: $relative" }
    }
    foreach ($relative in @('input/archive-only.pbip', 'output/dynamic/archive-only.html', 'work/archive-only.txt', 'node_modules/archive-only/package.json')) {
        if (Test-Path -LiteralPath (Join-Path $installed $relative)) { throw "Protected folder was overwritten: $relative" }
    }
    if (Get-ChildItem -LiteralPath $installed -Directory -Filter '.setup-temp-*') { throw 'Temporary update directory was not cleaned up.' }
    $npmCalled = Join-Path $testRoot 'npm-called.txt'
    $fakeNpm = Join-Path $testRoot 'npm.cmd'
    Set-Content -LiteralPath $fakeNpm -Value "@echo off`r`necho %* > `"$npmCalled`"`r`n"
    $priorPath = $env:PATH
    try {
        $env:PATH = "$testRoot$([System.IO.Path]::PathSeparator)$priorPath"
        & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installed 'setup.ps1') -ArchivePath $zipPath
        if ($LASTEXITCODE -ne 0) { throw "setup.ps1 launch exited $LASTEXITCODE" }
    } finally { $env:PATH = $priorPath }
    if ((Get-Content -LiteralPath $npmCalled -Raw).Trim() -ne 'start') { throw 'setup.ps1 did not run npm start.' }
    Write-Host 'setup.ps1 isolated update test passed.' -ForegroundColor Green
} finally {
    if (Test-Path -LiteralPath $testRootFull) {
        if (-not $testRootFull.StartsWith($tempParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe setup test cleanup path.' }
        Remove-Item -LiteralPath $testRootFull -Recurse -Force
    }
}
