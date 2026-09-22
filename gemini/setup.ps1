# html_converter setup/update. Run from PowerShell: .\setup.ps1
# Downloads the latest public GitHub archive, merges code into this gemini folder,
# preserves local data/credentials, installs dependencies if needed, then runs npm start.
# Administrator privileges are deliberately not required.
param(
    [switch]$NoRun,
    [string]$ArchivePath,
    [switch]$SkipUpdate
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repository = 'datap0nd/html_converter'
$GeminiDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
$SetupPath = Join-Path $GeminiDir 'setup.ps1'
$UserAgent = 'html_converter-setup'
$Headers = @{ 'User-Agent' = $UserAgent }
$TempRoot = $null

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
        if ($entries -notcontains "$rootName/gemini/setup.ps1") { throw 'Archive is missing gemini/setup.ps1.' }
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
    $apiHeaders = @{
        'User-Agent' = $UserAgent
        'Accept' = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
    }
    $lastError = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $sha = [string](Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/commits/main" -Headers $apiHeaders -TimeoutSec 30).sha
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
    Write-Host "html_converter setup: $GeminiDir" -ForegroundColor Cyan
    if (-not $SkipUpdate) {
        $beforeHash = (Get-FileHash -LiteralPath $SetupPath -Algorithm SHA256).Hash
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
            $sha = Get-LatestCommit
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
        Write-Host 'Merging new code; preserving .env, input, output, work, and node_modules...' -ForegroundColor Cyan
        & robocopy.exe $sourceGemini $GeminiDir /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP /XD input output work node_modules /XF .env | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "Code merge failed (robocopy exit code $LASTEXITCODE)." }
        $afterLockHash = if (Test-Path -LiteralPath $lockPath) { (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash } else { '' }
        $needsDependencies = $beforeLockHash -ne $afterLockHash -or -not (Test-Path -LiteralPath (Join-Path $GeminiDir 'node_modules/pg/package.json'))
        $afterHash = (Get-FileHash -LiteralPath $SetupPath -Algorithm SHA256).Hash

        if ($afterHash -ne $beforeHash) {
            Write-Host 'setup.ps1 was updated; continuing with the new version...' -ForegroundColor Yellow
            $shell = (Get-Process -Id $PID).Path
            $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $SetupPath, '-SkipUpdate')
            if ($NoRun) { $args += '-NoRun' }
            $env:HC_SETUP_INSTALL_DEPS = if ($needsDependencies) { '1' } else { '0' }
            & $shell @args
            exit $LASTEXITCODE
        }
    } else {
        $needsDependencies = $env:HC_SETUP_INSTALL_DEPS -eq '1'
    }

    if ($needsDependencies) {
        Write-Host 'Installing Node dependencies...' -ForegroundColor Cyan
        Push-Location $GeminiDir
        try {
            & npm.cmd install --ignore-scripts --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit code $LASTEXITCODE)." }
        } finally { Pop-Location }
    }
    if ($NoRun) {
        Write-Host 'Update complete. Run .\setup.ps1 to update and start, or npm start to start now.' -ForegroundColor Green
    } else {
        Write-Host 'Starting the live HTML converter (Ctrl+C to stop)...' -ForegroundColor Green
        Push-Location $GeminiDir
        try {
            & npm.cmd start
            if ($LASTEXITCODE -ne 0) { throw "npm start failed (exit code $LASTEXITCODE)." }
        } finally { Pop-Location }
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
