# html_converter-live-setup
# Downloaded and executed by the stable setup.ps1 launcher.
# Downloads the latest public GitHub archive, merges code into this gemini folder,
# preserves local data/credentials, installs dependencies if needed, then runs npm start.
# Administrator privileges are deliberately not required.
param(
    [switch]$NoRun,
    [string]$ArchivePath,
    [switch]$SkipUpdate,
    [string]$CommitSha
)

$ErrorActionPreference = 'Stop'
# The progress bar makes Invoke-WebRequest many times slower in Windows PowerShell 5.1.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repository = 'datap0nd/html_converter'
$GeminiDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
$UserAgent = 'html_converter-setup'
$Headers = @{ 'User-Agent' = $UserAgent }
$TempRoot = $null
$SelectedPageScope = if ($env:HC_PAGE_SCOPE) { $env:HC_PAGE_SCOPE } else { 'Prompt' }

function Assert-ChildPath {
    param([string]$Parent, [string]$Child)
    $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    $childFull = [System.IO.Path]::GetFullPath($Child)
    if (-not $childFull.StartsWith($parentFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe temporary path outside gemini folder: $childFull"
    }
}

function Test-ConverterArchive {
    param([string]$Path)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        if ($entries | Where-Object { $_ -match '(^|/)\.\.(/|$)' -or $_ -match '^/' -or $_ -match '^[A-Za-z]:' }) {
            throw 'Archive contains an unsafe path.'
        }
        $roots = @($entries | Where-Object { $_ -match '^[^/]+/gemini/package\.json$' } | ForEach-Object { ($_ -split '/')[0] })
        if ($roots.Count -ne 1) { throw 'Archive does not contain exactly one gemini/package.json.' }
        $rootName = $roots[0]
        if ($entries -notcontains "$rootName/gemini/live-setup.ps1") { throw 'Archive is missing gemini/live-setup.ps1.' }
        return $rootName
    } finally {
        $archive.Dispose()
    }
}

function Invoke-ArchiveDownload {
    param([string]$Uri, [string]$Destination, [int]$MaxAttempts = 10, [int]$DelaySeconds = 5)
    $lastError = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            Write-Host "  Download attempt $attempt of $MaxAttempts..." -ForegroundColor DarkGray
            Invoke-WebRequest -Uri $Uri -OutFile $Destination -Headers $Headers -UseBasicParsing -TimeoutSec 120
            $rootName = Test-ConverterArchive -Path $Destination
            return $rootName
        } catch {
            $lastError = $_.Exception.Message
            Write-Host "  Attempt $attempt failed: $lastError" -ForegroundColor Yellow
            if ($attempt -lt $MaxAttempts) {
                Write-Host "  Corporate proxy may be transient. Retrying in $DelaySeconds seconds..." -ForegroundColor DarkGray
                Start-Sleep -Seconds $DelaySeconds
            }
        }
    }
    throw "Download failed after $MaxAttempts attempts. Last error: $lastError"
}

function Get-LatestCommit {
    $cacheBuster = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $apiHeaders = @{
        'User-Agent' = $UserAgent
        'Accept' = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'Cache-Control' = 'no-cache, no-store'
        'Pragma' = 'no-cache'
    }
    $lastError = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $sha = [string](Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/commits/main?nocache=$cacheBuster-$attempt" -Headers $apiHeaders -TimeoutSec 30).sha
            if ($sha -notmatch '^[0-9a-fA-F]{40}$') { throw 'GitHub returned an invalid main commit.' }
            return $sha.ToLowerInvariant()
        } catch {
            $lastError = $_.Exception.Message
            if ($attempt -lt 3) { Start-Sleep -Seconds ($attempt * 2) }
        }
    }
    Write-Host "  WARNING: Could not resolve GitHub main: $lastError" -ForegroundColor Yellow
    Write-Host '  The branch download will use a unique cache-busting URL.' -ForegroundColor Yellow
    return $null
}

# Runs a native program and shows every output line as it arrives.
# Windows PowerShell turns native stderr into terminating errors when
# $ErrorActionPreference is Stop and output is redirected (as setup.ps1 does),
# so stderr is folded into normal output here and only the exit code decides.
function Invoke-NativeLogged {
    param([string]$FilePath, [string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @Arguments 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host $_.Exception.Message } else { Write-Host $_ }
        }
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Get-NodeCommand {
    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) {
        throw 'Node.js was not found. Install Node.js 20 LTS or newer from https://nodejs.org (per-user install is fine), open a NEW PowerShell window, and rerun .\setup.ps1.'
    }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $version = [string](& $node.Source --version 2>$null) } finally { $ErrorActionPreference = $previous }
    if ($version -match '^v(\d+)\.' -and [int]$Matches[1] -lt 20) {
        throw "Node.js $version is too old. Install Node.js 20 LTS or newer from https://nodejs.org, open a NEW PowerShell window, and rerun .\setup.ps1."
    }
    Write-Host "Node.js $version at $($node.Source)" -ForegroundColor DarkGray
    return $node.Source
}

function Get-ArchiveViaBrowser {
    param([string]$Destination, [string]$Url)
    $browser = Get-Command msedge.exe -ErrorAction SilentlyContinue
    if (-not $browser) { throw 'Edge is unavailable for the browser download fallback.' }
    $downloadsDir = Join-Path $env:USERPROFILE 'Downloads'
    $started = (Get-Date).ToUniversalTime()
    Write-Host '  Trying Edge download fallback...' -ForegroundColor Yellow
    Start-Process -FilePath $browser.Source -ArgumentList $Url
    for ($elapsed = 0; $elapsed -lt 300; $elapsed += 3) {
        Start-Sleep -Seconds 3
        $candidates = @(Get-ChildItem -LiteralPath $downloadsDir -Filter 'html_converter*.zip' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending)
        foreach ($item in $candidates) {
            if ($item.LastWriteTimeUtc -lt $started.AddSeconds(-2)) { continue }
            if (Test-Path -LiteralPath "$($item.FullName).crdownload") { continue }
            if (Test-Path -LiteralPath "$($item.FullName).partial") { continue }
            try {
                $rootName = Test-ConverterArchive -Path $item.FullName
                Copy-Item -LiteralPath $item.FullName -Destination $Destination -Force
                return $rootName
            } catch {
                # Edge may still be writing the archive; keep waiting.
            }
        }
    }
    throw "Edge did not produce a valid archive within five minutes. Save the repo ZIP and rerun with -ArchivePath <zip path>."
}

try {
    if (-not (Test-Path -LiteralPath (Join-Path $GeminiDir 'package.json'))) {
        throw 'Run setup.ps1 from inside the html_converter/gemini folder.'
    }
    if (-not $NoRun) {
        if ($SelectedPageScope -eq 'Prompt') {
            Write-Host ''
            Write-Host 'What should this run convert?' -ForegroundColor Cyan
            Write-Host '  [1] First 2 report pages, end to end (test)' -ForegroundColor Green
            Write-Host '  [2] All report pages, end to end'
            do {
                $choice = Read-Host 'Choose 1 or 2 [default: 1]'
                if ([string]::IsNullOrWhiteSpace($choice)) { $choice = '1' }
            } until ($choice -in @('1', '2'))
            $SelectedPageScope = if ($choice -eq '1') { 'First2' } else { 'All' }
        }
        if ($SelectedPageScope -notin @('First2', 'All')) { throw 'HC_PAGE_SCOPE must be First2 or All.' }
        Write-Host "Selected conversion scope: $SelectedPageScope" -ForegroundColor Cyan
    }
    Write-Host "html_converter live setup: $GeminiDir" -ForegroundColor Cyan
    if (-not $SkipUpdate) {
        $lockPath = Join-Path $GeminiDir 'package-lock.json'
        $beforeLockHash = if (Test-Path -LiteralPath $lockPath) { (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash } else { '' }
        $TempRoot = Join-Path $GeminiDir ('.setup-temp-' + [guid]::NewGuid().ToString('N'))
        Assert-ChildPath -Parent $GeminiDir -Child $TempRoot
        New-Item -ItemType Directory -Path $TempRoot | Out-Null
        $zipPath = Join-Path $TempRoot 'update.zip'
        $extractPath = Join-Path $TempRoot 'extract'

        if ($ArchivePath) {
            $localArchive = [System.IO.Path]::GetFullPath($ArchivePath)
            if (-not (Test-Path -LiteralPath $localArchive -PathType Leaf)) { throw "Archive not found: $localArchive" }
            Copy-Item -LiteralPath $localArchive -Destination $zipPath
            $archiveRoot = Test-ConverterArchive -Path $zipPath
            Write-Host "Using local archive: $localArchive" -ForegroundColor Cyan
        } else {
            if ($CommitSha -and $CommitSha -notmatch '^[0-9a-fA-F]{40}$') { throw 'CommitSha must be an exact 40-character Git commit.' }
            $sha = if ($CommitSha) { $CommitSha.ToLowerInvariant() } else { Get-LatestCommit }
            if ($sha) { Write-Host "  Latest GitHub main commit: $sha" -ForegroundColor DarkGray }
            $cacheBuster = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
            $zipUrl = if ($sha) {
                "https://github.com/$Repository/archive/$sha.zip"
            } else {
                "https://github.com/$Repository/archive/refs/heads/main.zip?nocache=$cacheBuster"
            }
            Write-Host 'Downloading latest GitHub archive...' -ForegroundColor Cyan
            try {
                $archiveRoot = Invoke-ArchiveDownload -Uri $zipUrl -Destination $zipPath
                Write-Host '  Downloaded via PowerShell.' -ForegroundColor Green
            } catch {
                Write-Host "  Direct download failed: $($_.Exception.Message)" -ForegroundColor Yellow
                $archiveRoot = Get-ArchiveViaBrowser -Destination $zipPath -Url $zipUrl
            }
        }

        Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath
        $sourceGemini = Join-Path (Join-Path $extractPath $archiveRoot) 'gemini'
        if (-not (Test-Path -LiteralPath (Join-Path $sourceGemini 'package.json'))) { throw 'Extracted archive is missing gemini/package.json.' }
        Write-Host 'Merging new code; preserving setup.ps1, .env, input, output, work, logs, and node_modules...' -ForegroundColor Cyan
        & robocopy.exe $sourceGemini $GeminiDir /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP /XD input output work logs node_modules /XF .env setup.ps1 | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "Code merge failed (robocopy exit code $LASTEXITCODE)." }
        $afterLockHash = if (Test-Path -LiteralPath $lockPath) { (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash } else { '' }
        $needsDependencies = $beforeLockHash -ne $afterLockHash -or -not (Test-Path -LiteralPath (Join-Path $GeminiDir 'node_modules/pg/package.json'))
    } else {
        $needsDependencies = $env:HC_SETUP_INSTALL_DEPS -eq '1'
    }

    $nodePath = Get-NodeCommand
    if ($needsDependencies) {
        Write-Host 'Installing Node dependencies...' -ForegroundColor Cyan
        $npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $npm) { $npm = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
        if (-not $npm) { throw 'npm was not found next to Node.js. Reinstall Node.js 20 LTS or newer, open a NEW PowerShell window, and rerun .\setup.ps1.' }
        Push-Location $GeminiDir
        try {
            $installExit = Invoke-NativeLogged -FilePath $npm.Source -Arguments @('install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel', 'error')
            if ($installExit -ne 0) { throw "npm install failed (exit code $installExit). Check proxy/npm registry access (npm config get registry), then rerun .\setup.ps1." }
        } finally { Pop-Location }
    }
    if ($NoRun) {
        Write-Host 'Update complete. Run .\setup.ps1 to update and start, or npm start to start now.' -ForegroundColor Green
    } else {
        if (-not (Get-Command gemini -ErrorAction SilentlyContinue)) {
            Write-Host 'WARNING: gemini was not found on PATH. Install it with: npm install -g @google/gemini-cli   then run gemini once to sign in.' -ForegroundColor Yellow
        }
        Write-Host 'Starting Gemini report reconstruction and live HTML server (Ctrl+C to stop)...' -ForegroundColor Green
        Write-Host 'Progress is printed live below and saved under gemini\logs.' -ForegroundColor DarkGray
        $converterArgs = @('--no-warnings', (Join-Path (Join-Path $GeminiDir 'scripts') 'start-live-report.mjs'))
        if ($SelectedPageScope -eq 'First2') { $converterArgs += @('--page-limit', '2') }
        Push-Location $GeminiDir
        try {
            $converterExit = Invoke-NativeLogged -FilePath $nodePath -Arguments $converterArgs
        } finally { Pop-Location }
        # 130 / 0xC000013A: the report server was stopped with Ctrl+C.
        if ($converterExit -in @(130, -1073741510, 3221225786)) {
            Write-Host 'Report server stopped.' -ForegroundColor Cyan
        } elseif ($converterExit -ne 0) {
            $latest = Join-Path (Join-Path $GeminiDir 'logs') 'latest-converter-log.txt'
            $logHint = if (Test-Path -LiteralPath $latest) { " Converter log: $((Get-Content -LiteralPath $latest -TotalCount 1).Trim())" } else { '' }
            throw "Report conversion stopped (exit code $converterExit). The reason and what to do are printed above.$logHint"
        }
    }
} catch {
    Write-Host "SETUP FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($TempRoot -and (Test-Path -LiteralPath $TempRoot)) {
        Assert-ChildPath -Parent $GeminiDir -Child $TempRoot
        Remove-Item -LiteralPath $TempRoot -Recurse -Force
    }
}
