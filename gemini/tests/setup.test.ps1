# Isolated bootstrap test: no network, npm installation, or report data. Windows only.
# Run it from Windows PowerShell 5.1, the engine user PCs run setup with:
#     powershell -NoProfile -ExecutionPolicy Bypass -File tests\setup.test.ps1
$ErrorActionPreference = 'Stop'
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    Write-Host 'SKIP: setup.test.ps1 needs Windows (robocopy.exe, powershell.exe, .cmd shims). Run it on Windows, preferably from Windows PowerShell 5.1.' -ForegroundColor Yellow
    exit 0
}

# The engine program, never the host process (under PowerShell ISE that is powershell_ise.exe).
$shell = if ($PSVersionTable.PSEdition -eq 'Core') { Join-Path $PSHOME 'pwsh.exe' } else { Join-Path $PSHOME 'powershell.exe' }
if (-not (Test-Path -LiteralPath $shell -PathType Leaf)) { throw "PowerShell program not found: $shell" }
Write-Host "Testing setup with $shell (PowerShell $($PSVersionTable.PSVersion))" -ForegroundColor Cyan

$sourceGemini = Split-Path $PSScriptRoot -Parent
$tempDir = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempParent = $tempDir.TrimEnd('\', '/')
$testRoot = Join-Path $tempDir ('html-converter-setup-test-' + [guid]::NewGuid().ToString('N'))
$testRootFull = [System.IO.Path]::GetFullPath($testRoot)
if (-not $testRootFull.StartsWith($tempParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unsafe setup test directory.'
}
$priorPath = $env:PATH
$tempFixtures = @()

# Runs a child PowerShell with extra environment variables; stderr lines come back marked 'STDERR: '.
function Invoke-Child {
    param([string[]]$Arguments, [hashtable]$Environment = @{})
    $saved = @{}
    foreach ($key in $Environment.Keys) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], 'Process')
    }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $shell @Arguments 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { 'STDERR: ' + $_.Exception.Message } else { [string]$_ }
        })
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
        foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
    }
    return [pscustomobject]@{ ExitCode = $code; Lines = $lines; Text = ($lines -join "`n") }
}

function Assert-Test {
    param([bool]$Condition, [string]$Message, $Result = $null)
    if ($Condition) { return }
    if ($Result) { Write-Host $Result.Text }
    throw $Message
}

# Zips a folder like GitHub does (<root>/...) plus extra entries whose names never touch the disk,
# so paths longer than MAX_PATH and unsafe names can be tested.
function New-TestArchive {
    param([string]$ZipPath, [string]$SourceRoot, [hashtable]$ExtraEntries = @{})
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
    $rootFull = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\', '/')
    $rootName = Split-Path $rootFull -Leaf
    $zip = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in @(Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force)) {
            $relative = $file.FullName.Substring($rootFull.Length + 1).Replace('\', '/')
            [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, "$rootName/$relative")
        }
        foreach ($name in $ExtraEntries.Keys) {
            $writer = New-Object System.IO.StreamWriter($zip.CreateEntry($name).Open())
            try { $writer.Write([string]$ExtraEntries[$name]) } finally { $writer.Dispose() }
        }
    } finally {
        $zip.Dispose()
    }
}

function Get-SetupTempFolders {
    @(Get-ChildItem -LiteralPath $tempDir -Directory -Force -Filter 'hc-*' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^hc-[0-9a-f]{8}$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'html_converter-setup.tmp')) } |
        ForEach-Object { $_.FullName })
}

function New-TempFixture {
    param([string]$Name, [bool]$WithMarker, [int]$AgeHours)
    $path = Join-Path $tempDir $Name
    New-Item -ItemType Directory -Path (Join-Path $path 'gemini') -Force | Out-Null
    if ($WithMarker) { Set-Content -LiteralPath (Join-Path $path 'html_converter-setup.tmp') -Value 'test' }
    [System.IO.Directory]::SetLastWriteTimeUtc($path, [DateTime]::UtcNow.AddHours(-$AgeHours))
    $script:tempFixtures += $path
    return $path
}

try {
    $installed = Join-Path $testRoot 'installed\gemini'
    $archiveGemini = Join-Path $testRoot 'html_converter-test\gemini'
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
    $protected = @('input/report.pbip', 'output/dynamic/report.html', 'work/notes.txt', 'logs/old.log', 'node_modules/pg/package.json')
    foreach ($relative in $protected) {
        $target = Join-Path $installed $relative
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        Set-Content -LiteralPath $target -Value "preserve $relative"
    }
    $archiveOnly = @('input/archive-only.pbip', 'output/dynamic/archive-only.html', 'work/archive-only.txt', 'logs/archive-only.log', 'node_modules/archive-only/package.json')
    foreach ($relative in $archiveOnly) {
        $target = Join-Path $archiveGemini $relative
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        Set-Content -LiteralPath $target -Value 'must not copy'
    }
    # Development-only files, one of them far beyond MAX_PATH once unpacked: they must be skipped.
    $long = 'x' * 60
    $zipPath = Join-Path $testRoot 'update.zip'
    New-TestArchive -ZipPath $zipPath -SourceRoot (Join-Path $testRoot 'html_converter-test') -ExtraEntries @{
        'html_converter-test/gemini/tests/support/dev-only.mjs' = 'export {};'
        "html_converter-test/gemini/tests/fixtures/$long/$long/$long/$long/visual.json" = '{}'
    }
    $bootstrap = Join-Path $installed 'setup.ps1'
    $installedLive = Join-Path $installed 'live-setup.ps1'
    $liveSource = Join-Path $archiveGemini 'live-setup.ps1'

    # Leftovers of interrupted runs: removed only when they are clearly ours and older than an hour.
    $oldInside = Join-Path $installed ('.setup-temp-' + ('0' * 32))
    New-Item -ItemType Directory -Path (Join-Path $oldInside 'extract') -Force | Out-Null
    [System.IO.Directory]::SetLastWriteTimeUtc($oldInside, [DateTime]::UtcNow.AddHours(-2))
    $suffix = [guid]::NewGuid().ToString('N')
    $staleOurs = New-TempFixture -Name ('hc-' + $suffix.Substring(0, 8)) -WithMarker $true -AgeHours 2
    $recentOurs = New-TempFixture -Name ('hc-' + $suffix.Substring(8, 8)) -WithMarker $true -AgeHours 0
    $staleForeign = New-TempFixture -Name ('hc-' + $suffix.Substring(16, 8)) -WithMarker $false -AgeHours 2
    $tempBefore = @(Get-SetupTempFolders)

    # 1. Update only, through the current launcher.
    $result = Invoke-Child -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-ArchivePath', $zipPath, '-NoRun', '-NoPause')
    Assert-Test ($result.ExitCode -eq 0) "NoRun setup exited $($result.ExitCode)" $result
    Assert-Test ($result.Text -notmatch 'STDERR: ') 'Setup wrote to stderr.' $result
    Assert-Test ((Get-Content -LiteralPath (Join-Path $installed 'README.md') -Raw).Trim() -eq 'updated code') 'Code was not updated.' $result
    Assert-Test ((Get-Content -LiteralPath (Join-Path $installed '.env') -Raw).Trim() -eq 'PG_PASSWORD=keep-this-private') '.env was modified.' $result
    Assert-Test ((Get-FileHash -LiteralPath $bootstrap -Algorithm SHA256).Hash -eq $bootstrapHash) 'Stable setup.ps1 was replaced.' $result
    foreach ($relative in $protected) {
        Assert-Test (Test-Path -LiteralPath (Join-Path $installed $relative)) "Protected file was removed: $relative" $result
    }
    foreach ($relative in $archiveOnly) {
        Assert-Test (-not (Test-Path -LiteralPath (Join-Path $installed $relative))) "Protected folder was overwritten: $relative" $result
    }
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $installed 'tests'))) 'Development-only tests/ was installed.' $result
    Assert-Test ($result.Text -match 'left out 2 development-only') 'The tests/ entries (one beyond MAX_PATH) were not skipped.' $result
    Assert-Test (-not (Get-ChildItem -LiteralPath $installed -Directory -Force -Filter '.setup-temp-*')) 'Old .setup-temp folder was not cleaned up.' $result
    Assert-Test (-not (Test-Path -LiteralPath $staleOurs)) 'Stale hc-* temp folder was not cleaned up.' $result
    Assert-Test (Test-Path -LiteralPath $recentOurs) 'A recent hc-* temp folder (possibly in use) was deleted.' $result
    Assert-Test (Test-Path -LiteralPath $staleForeign) 'An hc-* folder without the setup marker was deleted.' $result
    $leftover = @(Get-SetupTempFolders | Where-Object { $tempBefore -notcontains $_ })
    Assert-Test ($leftover.Count -eq 0) "Temporary update folder was not cleaned up: $($leftover -join ', ')" $result

    # A fake node.cmd first on PATH: answers the version and --use-system-ca probes, records the
    # converter command line, writes to stderr, and can fail like the converter does.
    $nodeCalled = Join-Path $testRoot 'node-called.txt'
    $pointer = Join-Path $installed 'logs\latest-converter-log.txt'
    $nodeCmd = @(
        '@echo off'
        'if "%~1"=="--version" ('
        '  echo v22.0.0'
        '  exit /b 0'
        ')'
        'if "%~1"=="--use-system-ca" ('
        '  if "%HC_FAKE_NO_SYSTEM_CA%"=="1" ('
        '    echo node: bad option: --use-system-ca 1>&2'
        '    exit /b 9'
        '  )'
        '  exit /b 0'
        ')'
        "echo %* > `"$nodeCalled`""
        'echo converter stderr line 1>&2'
        'if "%HC_FAKE_NODE_FAIL%"=="1" ('
        "  if `"%HC_FAKE_EMPTY_POINTER%`"==`"1`" type nul > `"$pointer`""
        '  echo 12:00:00 [01-interpret] ERROR: CONVERSION STOPPED at 01-interpret: fake stop reason'
        '  echo 12:00:00 [01-interpret] ERROR: What to do: fake remedy'
        '  if defined HC_FAKE_FULL_LOG echo 12:00:00 [01-interpret] ERROR: Full log: %HC_FAKE_FULL_LOG%'
        '  exit /b 1'
        ')'
        'echo converter stdout line'
        'exit /b 0'
    ) -join "`r`n"
    Set-Content -LiteralPath (Join-Path $testRoot 'node.cmd') -Value $nodeCmd
    $fakePath = "$testRoot;$priorPath"

    # 2. Full conversion through the current launcher.
    $result = Invoke-Child -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-LiveScriptPath', $liveSource, '-ArchivePath', $zipPath, '-NoPause') -Environment @{ PATH = $fakePath; HC_PAGE_SCOPE = 'All' }
    Assert-Test ($result.ExitCode -eq 0) "Launch setup exited $($result.ExitCode)" $result
    $called = (Get-Content -LiteralPath $nodeCalled -Raw).Trim()
    Assert-Test ($called -match 'start-live-report\.mjs' -and $called -notmatch 'page-limit') "setup.ps1 did not run the full converter: $called" $result
    Assert-Test ($called -match '--use-system-ca .*start-live-report\.mjs') "The converter did not get --use-system-ca before the script: $called" $result
    Assert-Test ($result.Text -match 'Windows certificate store: used') 'The certificate store line is missing.' $result
    Assert-Test ($result.Text -match 'converter stderr line') 'Converter stderr was not shown.' $result
    Assert-Test ($result.Text -notmatch 'STDERR: ') 'Setup wrote to stderr.' $result

    # 3. First two pages.
    $result = Invoke-Child -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-LiveScriptPath', $liveSource, '-ArchivePath', $zipPath, '-NoPause') -Environment @{ PATH = $fakePath; HC_PAGE_SCOPE = 'First2' }
    Assert-Test ($result.ExitCode -eq 0) "First2 setup exited $($result.ExitCode)" $result
    Assert-Test ((Get-Content -LiteralPath $nodeCalled -Raw).Trim() -match 'start-live-report\.mjs"? --page-limit 2') 'First2 setup did not pass the page limit to the converter.' $result
    $latestLog = (Get-Content -LiteralPath (Join-Path $installed 'logs/latest.txt') -Raw).Trim()
    Assert-Test (Test-Path -LiteralPath $latestLog) 'Persistent setup log missing.' $result
    $logText = Get-Content -LiteralPath $latestLog -Raw
    Assert-Test ($logText -match 'Starting Gemini report reconstruction' -and $logText -match 'Setup finished successfully') 'Setup log lacks execution outcome.' $result
    Assert-Test ($logText -match 'converter stderr line') 'Converter stderr was not shown or it aborted setup.' $result

    # 4. The launcher existing PCs still have (setup.ps1 is never updated): Stop + 2>&1 around the
    # child, so in Windows PowerShell 5.1 any stderr byte from live-setup.ps1 aborts it.
    $legacy = Join-Path $testRoot 'legacy-launcher.ps1'
    Set-Content -LiteralPath $legacy -Value @'
param([string]$Shell, [string]$LiveScript, [string]$ArchivePath)
$ErrorActionPreference = 'Stop'
try {
    & $Shell -NoProfile -ExecutionPolicy Bypass -File $LiveScript -ArchivePath $ArchivePath 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw "live-setup.ps1 exited with code $LASTEXITCODE." }
    Write-Host 'Setup finished successfully.'
} catch {
    Write-Host "SETUP FAILED: $($_.Exception.Message)"
    exit 1
}
exit 0
'@
    $legacyArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $legacy, '-Shell', $shell, '-LiveScript', $installedLive, '-ArchivePath', $zipPath)
    $result = Invoke-Child -Arguments $legacyArgs -Environment @{ PATH = $fakePath; HC_PAGE_SCOPE = 'First2' }
    Assert-Test ($result.ExitCode -eq 0 -and $result.Text -match 'Setup finished successfully' -and $result.Text -notmatch 'SETUP FAILED') 'The deployed launcher failed with the new live-setup.ps1.' $result

    # 5. live-setup.ps1 itself writes nothing to stderr, even when node does.
    $result = Invoke-Child -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installedLive, '-ArchivePath', $zipPath) -Environment @{ PATH = $fakePath; HC_PAGE_SCOPE = 'First2' }
    Assert-Test ($result.ExitCode -eq 0) "Direct live-setup run exited $($result.ExitCode)" $result
    Assert-Test ($result.Text -notmatch 'STDERR: ') 'live-setup.ps1 wrote to stderr.' $result

    # 6. Without --use-system-ca support the converter still runs, and the line says so.
    $result = Invoke-Child -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-SkipUpdate') -Environment @{ PATH = $fakePath; HC_PAGE_SCOPE = 'First2'; HC_FAKE_NO_SYSTEM_CA = '1' }
    Assert-Test ($result.ExitCode -eq 0) "No-system-CA run exited $($result.ExitCode)" $result
    Assert-Test ((Get-Content -LiteralPath $nodeCalled -Raw) -notmatch 'use-system-ca') 'An unsupported --use-system-ca was passed to the converter.' $result
    Assert-Test ($result.Text -match 'Windows certificate store: not used') 'The certificate store line is missing.' $result

    # 7. A failed conversion ends with the reason, not with a generic line. An empty pointer file
    # written during the run must not crash the log hint.
    Set-Content -LiteralPath $pointer -Value 'C:\stale-previous-run.log'
    [System.IO.File]::SetLastWriteTime($pointer, (Get-Date).AddDays(-1))
    $result = Invoke-Child -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-SkipUpdate') -Environment @{ PATH = $fakePath; HC_PAGE_SCOPE = 'First2'; HC_FAKE_NODE_FAIL = '1'; HC_FAKE_EMPTY_POINTER = '1' }
    Assert-Test ($result.ExitCode -ne 0) 'A failed conversion was reported as success.' $result
    Assert-Test ($result.Text -notmatch 'null-valued') 'An empty converter log pointer crashed the failure hint.' $result
    Assert-Test ($result.Text -match 'Setup stopped\. The reason is shown above\.' -and $result.Text -notmatch 'SETUP FAILED: live-setup\.ps1 exited') 'The launcher did not end with the short stop line.' $result
    Assert-Test ($result.Text -match 'Node.js stopped before the converter wrote a log') 'The missing-log note is missing.' $result
    $lines = @($result.Lines)
    $summary = [array]::LastIndexOf($lines, ($lines | Where-Object { $_ -match '^SETUP FAILED: Report conversion stopped' } | Select-Object -Last 1))
    Assert-Test ($summary -ge 0) 'The failure summary is missing.' $result
    $after = ($lines[$summary..($lines.Count - 1)] -join "`n")
    Assert-Test ($after -match 'fake stop reason' -and $after -match 'fake remedy') 'The failure summary does not repeat the reason.' $result
    Assert-Test ($result.Text -notmatch 'STDERR: ') 'Setup wrote to stderr.' $result

    # 8. The deployed launcher: live-setup's own summary (reason + this run's log, never a stale
    # one) comes right before the launcher's generic line.
    Set-Content -LiteralPath $pointer -Value 'C:\stale-previous-run.log'
    [System.IO.File]::SetLastWriteTime($pointer, (Get-Date).AddDays(-1))
    $fakeLog = Join-Path $testRoot 'converter-fake.log'
    Set-Content -LiteralPath $fakeLog -Value 'fake converter log'
    $result = Invoke-Child -Arguments $legacyArgs -Environment @{ PATH = $fakePath; HC_PAGE_SCOPE = 'First2'; HC_FAKE_NODE_FAIL = '1'; HC_FAKE_FULL_LOG = $fakeLog }
    Assert-Test ($result.ExitCode -ne 0) 'A failed conversion was reported as success by the deployed launcher.' $result
    Assert-Test ($result.Text -notmatch 'stale-previous-run') 'A previous run''s converter log was named.' $result
    $lines = @($result.Lines | Where-Object { $_.Trim() })
    $generic = [array]::IndexOf($lines, 'SETUP FAILED: live-setup.ps1 exited with code 1.')
    Assert-Test ($generic -gt 3) 'The deployed launcher did not print its generic line.' $result
    $before = ($lines[($generic - 5)..($generic - 1)] -join "`n")
    Assert-Test ($before -match 'fake stop reason' -and $before -match [regex]::Escape("Converter log (send this file when asking for help): $fakeLog")) 'The last lines before the generic line are not the reason and the log.' $result

    # 9. A relative -ArchivePath is relative to the PowerShell location, not the process directory.
    Push-Location -LiteralPath $installed
    try {
        $command = 'Set-Location -LiteralPath $env:HC_TEST_ROOT; & $env:HC_TEST_BOOTSTRAP -ArchivePath update.zip -NoRun -NoPause; exit $LASTEXITCODE'
        $result = Invoke-Child -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command) -Environment @{ HC_TEST_ROOT = $testRoot; HC_TEST_BOOTSTRAP = $bootstrap }
    } finally { Pop-Location }
    Assert-Test ($result.ExitCode -eq 0) "Relative -ArchivePath failed (exit $($result.ExitCode))." $result

    # 10. Compatibility with the previous self-updating installer.
    $result = Invoke-Child -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-SkipUpdate', '-NoRun') -Environment @{ HC_SETUP_INSTALL_DEPS = '0' }
    Assert-Test ($result.ExitCode -eq 0) "Legacy compatibility exited $($result.ExitCode)" $result

    # 11. An archive with a path that escapes the folder is refused and nothing is written outside.
    $escapeName = 'escaped-' + [guid]::NewGuid().ToString('N') + '.txt'
    $unsafeZip = Join-Path $testRoot 'unsafe.zip'
    New-TestArchive -ZipPath $unsafeZip -SourceRoot (Join-Path $testRoot 'html_converter-test') -ExtraEntries @{ "html_converter-test/gemini/../../$escapeName" = 'must not be written' }
    $result = Invoke-Child -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-ArchivePath', $unsafeZip, '-NoRun', '-NoPause')
    Assert-Test ($result.ExitCode -ne 0 -and $result.Text -match 'unsafe path') 'An archive with an unsafe path was accepted.' $result
    foreach ($place in @($tempDir, $testRoot, (Join-Path $testRoot 'installed'))) {
        Assert-Test (-not (Test-Path -LiteralPath (Join-Path $place $escapeName))) "An unsafe entry was written to $place." $result
    }

    # 12. An invalid live script is refused and the failure is logged.
    $badLive = Join-Path $testRoot 'bad-live.ps1'
    Set-Content -LiteralPath $badLive -Value '# not the expected script'
    $result = Invoke-Child -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-LiveScriptPath', $badLive, '-NoRun', '-NoPause')
    Assert-Test ($result.ExitCode -ne 0) 'Invalid live script was accepted.' $result
    $failureLog = (Get-Content -LiteralPath (Join-Path $installed 'logs/latest.txt') -Raw).Trim()
    Assert-Test ((Get-Content -LiteralPath $failureLog -Raw) -match 'SETUP FAILED') 'Failure was not logged.' $result
    Write-Host 'setup.ps1 bootstrap test passed.' -ForegroundColor Green
} finally {
    $env:PATH = $priorPath
    foreach ($fixture in $tempFixtures) {
        if ((Test-Path -LiteralPath $fixture) -and ([System.IO.Path]::GetFileName($fixture) -match '^hc-[0-9a-f]{8}$')) { Remove-Item -LiteralPath $fixture -Recurse -Force }
    }
    if (Test-Path -LiteralPath $testRootFull) {
        if (-not $testRootFull.StartsWith($tempParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe setup test cleanup path.' }
        Remove-Item -LiteralPath $testRootFull -Recurse -Force
    }
}
