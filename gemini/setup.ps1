# Stable html_converter launcher. Routine updates belong in live-setup.ps1.
# Run from PowerShell: .\setup.ps1
param(
    [switch]$NoRun,
    [string]$ArchivePath,
    [switch]$SkipUpdate,       # Compatibility with the previous self-updating installer.
    [switch]$NoPause,          # For unattended/test runs.
    [string]$LiveScriptPath    # Optional approved local fallback/test input.
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
# Corporate proxies that require Windows sign-in answer 407 unless the default credentials are sent.
try {
    $defaultProxy = [System.Net.WebRequest]::DefaultWebProxy
    if ($defaultProxy) { $defaultProxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials }
} catch { }
$geminiDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
$logsDir = Join-Path $geminiDir 'logs'
$liveScript = Join-Path $geminiDir 'live-setup.ps1'
$repository = 'datap0nd/html_converter'
$userAgent = 'html_converter-setup'
$exitCode = 0
$transcriptStarted = $false
$candidate = $null
$logPath = $null
if ($SkipUpdate) { $NoPause = $true }

function Assert-LiveScript {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Live setup script not found: $Path" }
    $info = Get-Item -LiteralPath $Path -Force
    if ($info.Length -lt 100 -or $info.Length -gt 262144) { throw 'Live setup script has an unexpected size.' }
    $firstLine = Get-Content -LiteralPath $Path -TotalCount 1
    if ($firstLine -ne '# html_converter-live-setup') { throw 'Downloaded content is not the expected live-setup.ps1.' }
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count) { throw "Downloaded live-setup.ps1 has invalid PowerShell syntax: $($errors[0].Message)" }
}

# The PowerShell engine program, never the host process: under PowerShell ISE the host is
# powershell_ise.exe, which would open live-setup.ps1 in an editor instead of running it.
function Get-PowerShellPath {
    $names = if ($PSVersionTable.PSEdition -eq 'Core') { @('pwsh.exe', 'pwsh') } else { @('powershell.exe') }
    foreach ($name in $names) {
        $candidatePath = Join-Path $PSHOME $name
        if (Test-Path -LiteralPath $candidatePath -PathType Leaf) { return $candidatePath }
    }
    throw "Could not find $($names[0]) in $PSHOME."
}

function Get-LatestCommit {
    $cacheBuster = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $headers = @{
        'User-Agent' = $userAgent
        'Accept' = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'Cache-Control' = 'no-cache, no-store'
        'Pragma' = 'no-cache'
    }
    $lastError = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $sha = [string](Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/commits/main?nocache=$cacheBuster-$attempt" -Headers $headers -TimeoutSec 30).sha
            if ($sha -notmatch '^[0-9a-fA-F]{40}$') { throw 'GitHub returned an invalid commit SHA.' }
            return $sha.ToLowerInvariant()
        } catch {
            $lastError = $_.Exception.Message
            if ($attempt -lt 3) { Start-Sleep -Seconds ($attempt * 2) }
        }
    }
    Write-Host "Could not resolve a pinned commit: $lastError" -ForegroundColor Yellow
    Write-Host 'Trying main with a cache-busting URL.' -ForegroundColor Yellow
    return $null
}

function Get-RemoteLiveScript {
    param([string]$Destination, [string]$CommitSha)
    $ref = if ($CommitSha) { $CommitSha } else { 'main' }
    $cacheBuster = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $rawUrl = "https://raw.githubusercontent.com/$repository/$ref/gemini/live-setup.ps1?nocache=$cacheBuster"
    $headers = @{ 'User-Agent' = $userAgent }
    $lastError = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Write-Host "Downloading live-setup.ps1 (attempt $attempt of 3)..." -ForegroundColor DarkGray
            Invoke-WebRequest -Uri $rawUrl -OutFile $Destination -UseBasicParsing -Headers $headers -TimeoutSec 60
            Assert-LiveScript -Path $Destination
            return
        } catch {
            $lastError = $_.Exception.Message
            if ($attempt -lt 3) { Start-Sleep -Seconds (2 * $attempt) }
        }
    }
    Write-Host "Raw GitHub download failed: $lastError" -ForegroundColor Yellow
    Write-Host 'Trying GitHub Contents API for the same live script...' -ForegroundColor Yellow
    $apiHeaders = @{
        'User-Agent' = $userAgent
        'Accept' = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
    }
    $apiUrl = "https://api.github.com/repos/$repository/contents/gemini/live-setup.ps1?ref=$ref&nocache=$cacheBuster"
    $response = Invoke-RestMethod -Uri $apiUrl -Headers $apiHeaders -TimeoutSec 60
    if ($response.encoding -ne 'base64' -or -not $response.content) { throw 'GitHub Contents API did not return the live script.' }
    $bytes = [Convert]::FromBase64String(($response.content -replace '\s', ''))
    [System.IO.File]::WriteAllBytes($Destination, $bytes)
    Assert-LiveScript -Path $Destination
}

function Get-LiveScriptFromArchive {
    param([string]$ArchivePath, [string]$Destination)
    $archiveFile = [System.IO.Path]::GetFullPath($ArchivePath)
    if (-not (Test-Path -LiteralPath $archiveFile -PathType Leaf)) { throw "Archive not found: $archiveFile" }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($archiveFile)
    try {
        $found = @($archive.Entries | Where-Object { $_.FullName.Replace('\', '/') -match '^[^/]+/gemini/live-setup\.ps1$' })
        if ($found.Count -ne 1) { throw 'Archive must contain exactly one gemini/live-setup.ps1.' }
        $inputStream = $found[0].Open()
        try {
            $outputStream = [System.IO.File]::Create($Destination)
            try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
        } finally { $inputStream.Dispose() }
    } finally { $archive.Dispose() }
    Assert-LiveScript -Path $Destination
}

try {
    [void][System.IO.Directory]::CreateDirectory($logsDir)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $logPath = Join-Path $logsDir "setup-$stamp-$PID.log"
    Set-Content -LiteralPath (Join-Path $logsDir 'latest.txt') -Value $logPath
    try {
        Start-Transcript -LiteralPath $logPath -Force | Out-Null
        $transcriptStarted = $true
        Write-Host "html_converter setup log: $logPath" -ForegroundColor Cyan
    } catch {
        Write-Host "Note: the setup log could not be started ($($_.Exception.Message)); continuing without it." -ForegroundColor Yellow
    }
    if (-not (Test-Path -LiteralPath (Join-Path $geminiDir 'package.json'))) {
        throw 'Run setup.ps1 from the html_converter/gemini folder.'
    }
    if ($Host.Name -eq 'Windows PowerShell ISE Host') {
        throw 'Run setup.ps1 from a normal PowerShell window, not PowerShell ISE: open Windows PowerShell, cd to this gemini folder, and run .\setup.ps1'
    }
    # Relative paths are relative to the PowerShell location ($PWD), not the process directory that
    # [IO.Path]::GetFullPath uses; the child gets absolute paths.
    if ($ArchivePath) { $ArchivePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ArchivePath) }
    if ($LiveScriptPath) { $LiveScriptPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($LiveScriptPath) }

    if ($SkipUpdate) {
        Write-Host 'Continuing the update started by the previous installer.' -ForegroundColor Cyan
        Assert-LiveScript -Path $liveScript
    } elseif ($LiveScriptPath) {
        $approvedPath = [System.IO.Path]::GetFullPath($LiveScriptPath)
        Assert-LiveScript -Path $approvedPath
        if ($approvedPath -ne [System.IO.Path]::GetFullPath($liveScript)) {
            Copy-Item -LiteralPath $approvedPath -Destination $liveScript -Force
        }
        Write-Host "Using approved local live script: $approvedPath" -ForegroundColor Cyan
    } elseif ($ArchivePath) {
        $candidate = Join-Path $logsDir ('.live-setup-' + [guid]::NewGuid().ToString('N') + '.ps1')
        Get-LiveScriptFromArchive -ArchivePath $ArchivePath -Destination $candidate
        Copy-Item -LiteralPath $candidate -Destination $liveScript -Force
        Write-Host 'Using live-setup.ps1 from the supplied local archive.' -ForegroundColor Cyan
    } else {
        $sha = Get-LatestCommit
        if ($sha) { Write-Host "Latest GitHub commit: $sha" -ForegroundColor DarkGray }
        $candidate = Join-Path $logsDir ('.live-setup-' + [guid]::NewGuid().ToString('N') + '.ps1')
        try {
            Get-RemoteLiveScript -Destination $candidate -CommitSha $sha
            Copy-Item -LiteralPath $candidate -Destination $liveScript -Force
            Write-Host 'Fetched current live-setup.ps1 from GitHub.' -ForegroundColor Green
        } catch {
            if (-not (Test-Path -LiteralPath $liveScript)) { throw }
            Assert-LiveScript -Path $liveScript
            Write-Host "Could not fetch live-setup.ps1: $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host 'Using the previously installed live script; it will still attempt the latest repo archive.' -ForegroundColor Yellow
            $sha = $null
        }
    }

    $shell = Get-PowerShellPath
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $liveScript)
    if ($NoRun) { $arguments += '-NoRun' }
    if ($ArchivePath) { $arguments += @('-ArchivePath', $ArchivePath) }
    if ($SkipUpdate) { $arguments += '-SkipUpdate' }
    if ($sha -and -not $ArchivePath -and -not $SkipUpdate) { $arguments += @('-CommitSha', $sha) }
    # Native stderr must not become a terminating error under 'Stop' in Windows PowerShell 5.1.
    # The child's colours are lost in the pipe, so failures and warnings are coloured again here.
    $ErrorActionPreference = 'Continue'
    try {
        & $shell @arguments 2>&1 | ForEach-Object {
            $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ }
            if ($line -match '^\s*SETUP FAILED|CONVERSION STOPPED|ERROR:|ERROR \d+ \(0x') {
                Write-Host $line -ForegroundColor Red
            } elseif ($line -match 'WARNING') {
                Write-Host $line -ForegroundColor Yellow
            } else {
                Write-Host $line
            }
        }
        $childExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = 'Stop'
    }
    if ($childExit -ne 0) {
        # live-setup.ps1 already printed the reason and the log to send as its last lines.
        $exitCode = 1
        Write-Host 'Setup stopped. The reason is shown above.' -ForegroundColor Red
    } else {
        Write-Host 'Setup finished successfully.' -ForegroundColor Green
    }
} catch {
    $exitCode = 1
    Write-Host "SETUP FAILED: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    # Cleanup must never turn a result into a different one or skip the log and the pause.
    if ($candidate) {
        try {
            if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate -Force -ErrorAction Stop }
        } catch {
            Write-Host "Note: could not delete $candidate ($($_.Exception.Message))." -ForegroundColor DarkGray
        }
    }
    if ($transcriptStarted) {
        Write-Host "Full setup log: $logPath" -ForegroundColor Cyan
        try { Stop-Transcript | Out-Null } catch { }
        Write-Host "Log saved: $logPath" -ForegroundColor Cyan
    }
    if (-not $NoPause) {
        try { [void](Read-Host 'Press Enter to close this window') } catch { }
    }
}
exit $exitCode
