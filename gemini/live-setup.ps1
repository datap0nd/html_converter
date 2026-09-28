# html_converter-live-setup
# Downloaded and executed by the stable setup.ps1 launcher.
# Downloads the latest public GitHub archive, merges code into this gemini folder,
# preserves local data/credentials, installs dependencies if needed, then starts the converter.
# Administrator privileges are deliberately not required.
param(
    [switch]$NoRun,
    [string]$ArchivePath,
    [switch]$SkipUpdate,
    [string]$CommitSha
)

# THIS SCRIPT MUST NEVER WRITE TO STDERR.
# setup.ps1 is excluded from updates, so existing PCs keep an older launcher that runs this script as
#     $ErrorActionPreference = 'Stop'
#     & powershell.exe -File live-setup.ps1 2>&1 | ForEach-Object { Write-Host $_ }
# In Windows PowerShell 5.1 the first line this process writes to stderr becomes a terminating error
# in that launcher: setup aborts and the real message is lost. Therefore, in this script:
#   - .NET's error writer points at stdout (next line), so PowerShell's own error output lands there;
#   - every native program (robocopy, npm, node) runs through Invoke-NativeLogged, which folds its
#     stderr into Write-Host output; a browser is started through ShellExecute (Start-Process), which
#     does not hand it this script's stdio pipes;
#   - messages use Write-Host only (never Write-Warning, Write-Error, Write-Verbose, Write-Information);
#   - every failure is caught (try/catch below, or the trap), printed with Write-Host, and exits 1;
#   - cleanup never throws.
try { [Console]::SetError([Console]::Out) } catch { }

$ErrorActionPreference = 'Stop'
# The progress bar makes Invoke-WebRequest many times slower in Windows PowerShell 5.1.
$ProgressPreference = 'SilentlyContinue'
# Last line of defence for anything that fails outside the try/catch at the bottom.
trap {
    Write-Host "SETUP FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
# Corporate proxies that require Windows sign-in answer 407 unless the default credentials are sent.
try {
    $defaultProxy = [System.Net.WebRequest]::DefaultWebProxy
    if ($defaultProxy) { $defaultProxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials }
} catch { }

$Repository = 'datap0nd/html_converter'
$GeminiDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
$UserAgent = 'html_converter-setup'
$Headers = @{ 'User-Agent' = $UserAgent }
# Downloads and unpacking happen in a short folder under TEMP: %TEMP%\hc-<8 hex>.
$TempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$TempPattern = '^hc-[0-9a-f]{8}$'
$TempMarkerName = 'html_converter-setup.tmp'
$TempRoot = $null
# Windows PowerShell 5.1 uses .NET Framework legacy paths: no folder of 248+ characters (MAX_PATH).
$MaxPathLength = 248
# Development-only folders that are never installed on user PCs (tests/ has very long fixture paths).
$SkipArchiveFolders = @('tests')
$SelectedPageScope = if ($env:HC_PAGE_SCOPE) { $env:HC_PAGE_SCOPE } else { 'Prompt' }
$script:NativeKeyLines = New-Object System.Collections.Generic.List[string]
$script:NativeTail = New-Object System.Collections.Generic.List[string]
$script:NativeFullLog = $null
$script:FailureDetails = @()
$script:ConverterLog = $null
$script:ConverterRan = $false

function Assert-ChildPath {
    param([string]$Parent, [string]$Child)
    $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    $childFull = [System.IO.Path]::GetFullPath($Child)
    if (-not $childFull.StartsWith($parentFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe path outside ${parentFull}: $childFull"
    }
}

# Zip entry names that could escape the destination or address a device are refused.
function Test-SafeEntryName {
    param([string]$Name)
    $normalized = $Name.Replace('\', '/')
    if ($normalized.StartsWith('/') -or $normalized.Contains(':')) { return $false }
    $invalid = [System.IO.Path]::GetInvalidFileNameChars()
    foreach ($segment in $normalized.Split('/')) {
        if ($segment.Length -eq 0) { continue }
        if ($segment -eq '..' -or $segment -eq '.') { return $false }
        if ($segment.IndexOfAny($invalid) -ge 0) { return $false }
        if ($segment -match '^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$') { return $false }
    }
    return $true
}

function Test-ConverterArchive {
    param([string]$Path)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        foreach ($entry in $entries) {
            if (-not (Test-SafeEntryName -Name $entry)) { throw "Archive contains an unsafe path: $entry" }
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

# Unpacks only <root>/gemini/ (without development-only folders) into $Destination, entry by entry.
# Expand-Archive is not used: it unpacks the whole repository under <root>\, and the test fixtures'
# paths are longer than Windows PowerShell 5.1 can create, so it failed on every PC.
function Expand-ConverterArchive {
    param([string]$ZipPath, [string]$Destination, [string]$RootName)
    try { Add-Type -AssemblyName System.IO.Compression } catch { }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $prefix = "$RootName/gemini/"
    $separator = [System.IO.Path]::DirectorySeparatorChar
    $destinationFull = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\', '/')
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        # Check every entry and plan every target before anything is written.
        $plan = New-Object System.Collections.Generic.List[object]
        $skipped = 0
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if (-not (Test-SafeEntryName -Name $name)) { throw "Archive contains an unsafe path: $name" }
            if (-not $name.StartsWith($prefix, [System.StringComparison]::Ordinal)) { continue }
            $relative = $name.Substring($prefix.Length).Trim('/')
            if ($relative.Length -eq 0) { continue }
            if ($SkipArchiveFolders -contains $relative.Split('/')[0]) { $skipped++; continue }
            $target = [System.IO.Path]::GetFullPath($destinationFull + $separator + $relative.Replace('/', $separator))
            Assert-ChildPath -Parent $destinationFull -Child $target
            if ($target.Length -ge $MaxPathLength) {
                throw ("Cannot unpack the update: '$target' would be $($target.Length) characters long, and Windows PowerShell 5.1 " +
                    "cannot create paths of $MaxPathLength characters or more. The temporary folder '$destinationFull' is too deep. " +
                    "Use a shorter TEMP folder for this window and rerun, for example:  New-Item -ItemType Directory -Force C:\hc\tmp; " +
                    "`$env:TEMP = 'C:\hc\tmp'; .\setup.ps1")
            }
            $plan.Add([pscustomobject]@{ Entry = $entry; Target = $target; IsDirectory = $name.EndsWith('/') })
        }
        $files = @($plan | Where-Object { -not $_.IsDirectory })
        if ($files.Count -eq 0) { throw 'The archive contains no gemini files to install.' }
        [void][System.IO.Directory]::CreateDirectory($destinationFull)
        foreach ($item in $plan) {
            if ($item.IsDirectory) {
                [void][System.IO.Directory]::CreateDirectory($item.Target)
                continue
            }
            [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($item.Target))
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($item.Entry, $item.Target, $true)
        }
        return [pscustomobject]@{ Files = $files.Count; Skipped = $skipped }
    } finally {
        $archive.Dispose()
    }
}

# Deletes a temporary folder only if it sits directly in $Parent and its name matches $Pattern.
# Never throws: a locked file (antivirus, OneDrive) must not turn a finished setup into a failure.
function Remove-TempFolder {
    param([string]$Path, [string]$Parent, [string]$Pattern)
    try {
        $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
        $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
        $actualParent = ([string][System.IO.Path]::GetDirectoryName($full)).TrimEnd('\', '/')
        if (-not $actualParent.Equals($parentFull, [System.StringComparison]::OrdinalIgnoreCase) -or [System.IO.Path]::GetFileName($full) -notmatch $Pattern) {
            Write-Host "  Note: left $full in place (not a setup temporary folder)." -ForegroundColor DarkGray
            return
        }
        if (-not (Test-Path -LiteralPath $full)) { return }
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            try {
                Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
                return
            } catch {
                if ($attempt -eq 3) { throw }
                Start-Sleep -Seconds 1
            }
        }
    } catch {
        Write-Host "  Note: could not delete the temporary folder $Path ($($_.Exception.Message)). It is safe to delete it by hand." -ForegroundColor DarkGray
    }
}

# Removes folders left behind by interrupted runs (Ctrl+C, closed window). Never fatal.
function Clear-StaleSetupTemp {
    $cutoff = (Get-Date).ToUniversalTime().AddHours(-1)
    try {
        # Older versions unpacked inside the gemini folder.
        $oldPattern = '^\.setup-temp-[0-9a-fA-F]{32}$'
        $old = @(Get-ChildItem -LiteralPath $GeminiDir -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $oldPattern -and $_.LastWriteTimeUtc -lt $cutoff })
        foreach ($dir in $old) {
            Write-Host "  Removing an old temporary folder: $($dir.FullName)" -ForegroundColor DarkGray
            Remove-TempFolder -Path $dir.FullName -Parent $GeminiDir -Pattern $oldPattern
        }
        $stale = @(Get-ChildItem -LiteralPath $TempBase -Directory -Force -Filter 'hc-*' -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -match $TempPattern -and $_.LastWriteTimeUtc -lt $cutoff -and (Test-Path -LiteralPath (Join-Path $_.FullName $TempMarkerName))
        })
        foreach ($dir in $stale) { Remove-TempFolder -Path $dir.FullName -Parent $TempBase -Pattern $TempPattern }
    } catch {
        Write-Host "  Note: skipped cleaning old temporary folders ($($_.Exception.Message))." -ForegroundColor DarkGray
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
# Windows PowerShell turns native stderr into terminating errors when $ErrorActionPreference is
# Stop and output is redirected (as every setup.ps1 launcher does), so stderr is folded into normal
# output here and only the exit code decides. Key lines are kept for the final failure summary.
# -Quiet keeps the lines without printing them.
function Invoke-NativeLogged {
    param([string]$FilePath, [string[]]$Arguments, [switch]$Quiet)
    # Resolve first: a missing program would otherwise be reported on stderr instead of as an error here.
    if ([System.IO.Path]::IsPathRooted($FilePath)) {
        if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { throw "Program not found: $FilePath" }
        $program = $FilePath
    } else {
        $command = Get-Command -Name $FilePath -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $command) { throw "Program not found on PATH: $FilePath" }
        $program = $command.Source
    }
    $script:NativeKeyLines.Clear()
    $script:NativeTail.Clear()
    $script:NativeFullLog = $null
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $program @Arguments 2>&1 | ForEach-Object {
            $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ }
            if (-not $Quiet) { Write-Host $line }
            $trimmed = $line.Trim()
            if ($trimmed) {
                if ($trimmed -match 'CONVERSION STOPPED|What to do:|\[selftest\] FAILED|ERROR \d+ \(0x') { $script:NativeKeyLines.Add($trimmed) }
                if ($trimmed -match 'Full log:\s*(.+)$') { $script:NativeFullLog = $Matches[1].Trim() }
                $script:NativeTail.Add($trimmed)
                if ($script:NativeTail.Count -gt 8) { $script:NativeTail.RemoveAt(0) }
            }
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

# True when this Node.js accepts --use-system-ca (trust the Windows certificate store).
function Test-NodeSystemCa {
    param([string]$NodePath)
    try {
        $probeExit = Invoke-NativeLogged -FilePath $NodePath -Arguments @('--use-system-ca', '-e', '0') -Quiet
        return ($probeExit -eq 0)
    } catch {
        return $false
    }
}

# The converter log of THIS run, or $null. The pointer file may be missing, empty, or left by an
# earlier run when node stopped before the converter started logging.
function Get-ConverterLogPath {
    param([datetime]$Since)
    try {
        if ($script:NativeFullLog -and (Test-Path -LiteralPath $script:NativeFullLog -PathType Leaf)) { return $script:NativeFullLog }
        $pointer = Join-Path (Join-Path $GeminiDir 'logs') 'latest-converter-log.txt'
        if (-not (Test-Path -LiteralPath $pointer -PathType Leaf)) { return $null }
        if ((Get-Item -LiteralPath $pointer -Force).LastWriteTime -lt $Since) { return $null }
        # node writes UTF-8; without -Encoding, Windows PowerShell reads ANSI and garbles non-ASCII paths.
        $line = Get-Content -LiteralPath $pointer -TotalCount 1 -Encoding UTF8
        if ($null -eq $line) { return $null }
        $line = ([string]$line).Trim()
        if ($line) { return $line }
        return $null
    } catch {
        return $null
    }
}

function Find-Edge {
    # Edge is not on PATH on a standard install; look where its installers put it.
    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
        if ($base) { $candidates.Add((Join-Path $base 'Microsoft\Edge\Application\msedge.exe')) }
    }
    foreach ($key in @('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe')) {
        try {
            $registered = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).'(default)'
            if ($registered) { $candidates.Add(([string]$registered).Trim('"')) }
        } catch { }
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $onPath = Get-Command msedge.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { return $onPath.Source }
    return $null
}

function Get-DownloadFolders {
    $folders = New-Object System.Collections.Generic.List[string]
    try {
        # The real Downloads folder (it may be redirected, e.g. to OneDrive or a network share).
        $shellFolders = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction Stop
        $configured = $shellFolders.'{374DE290-123F-4565-9164-39C4925E467B}'
        if ($configured) { $folders.Add([Environment]::ExpandEnvironmentVariables([string]$configured)) }
    } catch { }
    if ($env:USERPROFILE) { $folders.Add((Join-Path $env:USERPROFILE 'Downloads')) }
    return @($folders | Select-Object -Unique)
}

function Get-ArchiveViaBrowser {
    param([string]$Destination, [string]$Url)
    $manual = "Download $Url in a browser, then rerun setup with the FULL path of the saved file, for example: .\setup.ps1 -ArchivePath `"$HOME\Downloads\html_converter-main.zip`""
    $downloadFolders = @(Get-DownloadFolders)
    $started = (Get-Date).ToUniversalTime()
    $edge = Find-Edge
    try {
        # Start-Process uses ShellExecute: the browser does not get this script's stdout/stderr pipes.
        if ($edge) {
            Write-Host "  Trying the Edge download fallback ($edge)..." -ForegroundColor Yellow
            Start-Process -FilePath $edge -ArgumentList ('"' + $Url + '"')
        } else {
            Write-Host '  Edge was not found; opening the download in the default browser...' -ForegroundColor Yellow
            Start-Process -FilePath $Url
        }
    } catch {
        throw "The browser download fallback could not start a browser ($($_.Exception.Message)). $manual"
    }
    Write-Host "  Waiting up to five minutes for html_converter*.zip in: $($downloadFolders -join '; ')" -ForegroundColor DarkGray
    for ($elapsed = 0; $elapsed -lt 300; $elapsed += 3) {
        Start-Sleep -Seconds 3
        $found = foreach ($folder in $downloadFolders) { Get-ChildItem -LiteralPath $folder -Filter 'html_converter*.zip' -File -ErrorAction SilentlyContinue }
        $candidates = @($found | Sort-Object LastWriteTimeUtc -Descending)
        foreach ($item in $candidates) {
            if ($item.LastWriteTimeUtc -lt $started.AddSeconds(-2)) { continue }
            if (Test-Path -LiteralPath "$($item.FullName).crdownload") { continue }
            if (Test-Path -LiteralPath "$($item.FullName).partial") { continue }
            try {
                $rootName = Test-ConverterArchive -Path $item.FullName
                Copy-Item -LiteralPath $item.FullName -Destination $Destination -Force
                return $rootName
            } catch {
                # The browser may still be writing the archive; keep waiting.
            }
        }
    }
    throw "The browser did not produce a valid archive within five minutes. $manual"
}

# The last lines of a failed run. Old launchers always add a generic 'live-setup.ps1 exited with
# code 1' line after this, so the reason and the log to send must be right here.
function Write-FailureSummary {
    param([string]$Message)
    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Red
    Write-Host "SETUP FAILED: $Message" -ForegroundColor Red
    foreach ($line in @($script:FailureDetails)) {
        if ($line) { Write-Host "  $line" -ForegroundColor Red }
    }
    if ($script:ConverterLog) {
        Write-Host "Converter log (send this file when asking for help): $($script:ConverterLog)" -ForegroundColor Yellow
    } elseif ($script:ConverterRan) {
        Write-Host 'Node.js stopped before the converter wrote a log for this run; the lines above are all the output there is.' -ForegroundColor Yellow
    }
    Write-Host '============================================================' -ForegroundColor Red
}

$exitCode = 0
$failureMessage = $null
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
            Write-Host '  [3] Self-test this PC (no Gemini quota, no report data; about 1 minute)'
            $choice = $null
            for ($attempt = 1; $attempt -le 5 -and -not $choice; $attempt++) {
                try {
                    $answer = Read-Host 'Choose 1, 2 or 3 [default: 1]'
                } catch {
                    # No usable console input (for example a non-interactive host): take the default.
                    Write-Host "  Cannot read an answer here ($($_.Exception.Message)); using 1." -ForegroundColor Yellow
                    $answer = '1'
                }
                # Redirected input at its end returns nothing; that also means the default.
                if ([string]::IsNullOrWhiteSpace($answer)) { $answer = '1' }
                $answer = ([string]$answer).Trim()
                if ($answer -in @('1', '2', '3')) { $choice = $answer } else { Write-Host '  Please type 1, 2 or 3.' -ForegroundColor Yellow }
            }
            if (-not $choice) {
                $choice = '1'
                Write-Host '  No valid answer; using 1.' -ForegroundColor Yellow
            }
            $SelectedPageScope = switch ($choice) { '1' { 'First2' } '2' { 'All' } default { 'SelfTest' } }
        }
        if ($SelectedPageScope -notin @('First2', 'All', 'SelfTest')) { throw 'HC_PAGE_SCOPE must be First2, All, or SelfTest.' }
        Write-Host "Selected conversion scope: $SelectedPageScope" -ForegroundColor Cyan
    }
    Write-Host "html_converter live setup: $GeminiDir" -ForegroundColor Cyan
    foreach ($oneDrive in @($env:OneDrive, $env:OneDriveCommercial, $env:OneDriveConsumer)) {
        if ($oneDrive -and $GeminiDir.StartsWith($oneDrive.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            Write-Host 'Note: this folder is inside OneDrive. If files are reported as locked or in use, move the html_converter folder to a local folder such as C:\hc.' -ForegroundColor Yellow
            break
        }
    }
    Clear-StaleSetupTemp

    if (-not $SkipUpdate) {
        $lockPath = Join-Path $GeminiDir 'package-lock.json'
        $beforeLockHash = if (Test-Path -LiteralPath $lockPath) { (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash } else { '' }
        $TempRoot = Join-Path $TempBase ('hc-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        [void][System.IO.Directory]::CreateDirectory($TempRoot)
        [System.IO.File]::WriteAllText((Join-Path $TempRoot $TempMarkerName), "html_converter setup temporary folder; safe to delete.`r`n")
        $zipPath = Join-Path $TempRoot 'update.zip'
        $extractPath = Join-Path $TempRoot 'gemini'

        if ($ArchivePath) {
            # Relative paths are relative to the PowerShell location, not the process directory.
            $localArchive = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ArchivePath)
            if (-not (Test-Path -LiteralPath $localArchive -PathType Leaf)) {
                throw "Archive not found: $localArchive. Give the full path of the .zip, for example: .\setup.ps1 -ArchivePath `"$HOME\Downloads\html_converter-main.zip`""
            }
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

        $unpacked = Expand-ConverterArchive -ZipPath $zipPath -Destination $extractPath -RootName $archiveRoot
        Write-Host "  Unpacked $($unpacked.Files) files (left out $($unpacked.Skipped) development-only test entries)." -ForegroundColor DarkGray
        if (-not (Test-Path -LiteralPath (Join-Path $extractPath 'package.json'))) { throw 'Extracted archive is missing gemini/package.json.' }
        Write-Host 'Merging new code; preserving setup.ps1, .env, input, output, work, logs, and node_modules...' -ForegroundColor Cyan
        # /NFL /NDL /NJH /NJS /NP keep a successful copy silent; failures still print the file and the Windows error.
        $robocopyArgs = @($extractPath, $GeminiDir, '/E', '/R:5', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
            '/XD', 'input', 'output', 'work', 'logs', 'node_modules', '/XF', '.env', 'setup.ps1')
        $copyExit = Invoke-NativeLogged -FilePath 'robocopy.exe' -Arguments $robocopyArgs
        if ($copyExit -ge 8) {
            $script:FailureDetails = @($script:NativeKeyLines)
            throw ("Code merge failed (robocopy exit code $copyExit); the ERROR lines name the file that could not be written. " +
                'Close other html_converter windows, editors, and File Explorer previews of this folder, then rerun .\setup.ps1. ' +
                'If the folder is inside OneDrive, move html_converter to a local folder such as C:\hc.')
        }
        # Delete the temporary copy now: a server stopped with Ctrl+C never reaches the cleanup at the end.
        Remove-TempFolder -Path $TempRoot -Parent $TempBase -Pattern $TempPattern
        $TempRoot = $null
        $afterLockHash = if (Test-Path -LiteralPath $lockPath) { (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash } else { '' }
        $needsDependencies = $beforeLockHash -ne $afterLockHash -or -not (Test-Path -LiteralPath (Join-Path $GeminiDir 'node_modules/pg/package.json'))
    } else {
        $needsDependencies = $env:HC_SETUP_INSTALL_DEPS -eq '1'
    }

    $nodePath = $null
    if ($needsDependencies -or -not $NoRun) { $nodePath = Get-NodeCommand }
    if ($needsDependencies) {
        Write-Host 'Installing Node dependencies...' -ForegroundColor Cyan
        $npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $npm) { $npm = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
        if (-not $npm) { throw 'npm was not found next to Node.js. Reinstall Node.js 20 LTS or newer, open a NEW PowerShell window, and rerun .\setup.ps1.' }
        Push-Location -LiteralPath $GeminiDir
        try {
            $installExit = Invoke-NativeLogged -FilePath $npm.Source -Arguments @('install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel', 'error')
        } finally { Pop-Location }
        if ($installExit -ne 0) {
            $script:FailureDetails = @($script:NativeTail)
            throw "npm install failed (exit code $installExit). Check proxy/npm registry access (npm config get registry), then rerun .\setup.ps1."
        }
    }
    if ($NoRun) {
        Write-Host 'Update complete. Run .\setup.ps1 to update and start, or npm start to start now.' -ForegroundColor Green
    } else {
        if (-not (Get-Command gemini -ErrorAction SilentlyContinue)) {
            Write-Host 'WARNING: gemini was not found on PATH. Install it with: npm install -g @google/gemini-cli   then run gemini once to sign in.' -ForegroundColor Yellow
        }
        $nodeArguments = @('--no-warnings')
        # Trust the Windows certificate store (corporate TLS inspection, internal PostgreSQL CAs) when this Node.js can.
        if (Test-NodeSystemCa -NodePath $nodePath) {
            $nodeArguments += '--use-system-ca'
            Write-Host 'Windows certificate store: used (node --use-system-ca), so certificates this PC trusts are accepted.' -ForegroundColor DarkGray
        } else {
            Write-Host 'Windows certificate store: not used (this Node.js has no --use-system-ca; Node.js 22.15 or newer adds it). On a certificate error, set NODE_EXTRA_CA_CERTS to the corporate root certificate.' -ForegroundColor DarkGray
        }
        $scriptsDir = Join-Path $GeminiDir 'scripts'
        if ($SelectedPageScope -eq 'SelfTest') {
            Write-Host 'Running the offline self-test with this PC''s Node.js and Gemini CLI against a mock Gemini API...' -ForegroundColor Cyan
            $nodeArguments += (Join-Path $scriptsDir 'selftest.mjs')
        } else {
            Write-Host 'Starting Gemini report reconstruction and live HTML server (Ctrl+C to stop)...' -ForegroundColor Green
            Write-Host 'Progress is printed live below and saved under gemini\logs.' -ForegroundColor DarkGray
            $nodeArguments += (Join-Path $scriptsDir 'start-live-report.mjs')
            if ($SelectedPageScope -eq 'First2') { $nodeArguments += @('--page-limit', '2') }
            $script:ConverterRan = $true
        }
        $runStart = (Get-Date).AddSeconds(-2)
        Push-Location -LiteralPath $GeminiDir
        try {
            $converterExit = Invoke-NativeLogged -FilePath $nodePath -Arguments $nodeArguments
        } finally { Pop-Location }
        # 130 / 0xC000013A: the report server was stopped with Ctrl+C. PowerShell normally stops this
        # script together with node, so this branch is only a fallback; nothing depends on it.
        if ($SelectedPageScope -eq 'SelfTest' -and $converterExit -eq 0) {
            Write-Host 'Self-test passed. Run .\setup.ps1 again and choose 1 or 2 to convert your report.' -ForegroundColor Green
        } elseif ($converterExit -in @(130, -1073741510, 3221225786)) {
            Write-Host 'Report server stopped.' -ForegroundColor Cyan
        } elseif ($converterExit -ne 0) {
            $script:FailureDetails = if ($script:NativeKeyLines.Count) { @($script:NativeKeyLines) } else { @($script:NativeTail) }
            if ($SelectedPageScope -eq 'SelfTest') { throw "Self-test failed (exit code $converterExit). Its logs are under gemini\logs\selftest-*." }
            $script:ConverterLog = Get-ConverterLogPath -Since $runStart
            throw "Report conversion stopped (exit code $converterExit)."
        }
    }
} catch {
    $exitCode = 1
    $failureMessage = $_.Exception.Message
} finally {
    if ($TempRoot) { Remove-TempFolder -Path $TempRoot -Parent $TempBase -Pattern $TempPattern }
}
if ($failureMessage) { Write-FailureSummary -Message $failureMessage }
exit $exitCode
