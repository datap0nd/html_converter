# Runs DAX queries against Power BI Desktop's local Analysis Services engine (the model
# of a report open in Desktop) and writes the results as JSON. Started by the converter
# (scripts/pbi-desktop.mjs); it prints progress lines and never writes to stderr.
#
# Request (JSON): { ports: [n], tables: [model table names], queries: [{ id, dax }],
#                   timeoutSeconds, toolsDir, allowDownload }
# Result  (JSON): { ok, adomd, port, instances: [{ port, tables, matched, error }],
#                   results: [{ id, columns, rows, ms, error }], error }
#
# The ADOMD.NET client library comes from Power BI Desktop's own folder when possible,
# else another installed tool (DAX Studio, Tabular Editor, SSMS, the GAC), else the
# Microsoft.AnalysisServices.AdomdClient NuGet package, downloaded once into toolsDir.
param(
    [Parameter(Mandatory = $true)][string]$RequestFile,
    [Parameter(Mandatory = $true)][string]$ResultFile
)

try { [Console]::SetError([Console]::Out) } catch { }
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Invariant = [System.Globalization.CultureInfo]::InvariantCulture

# ---------- JSON output (culture-independent, dates as ISO text) ----------

function ConvertTo-JsonString {
    param([string]$Text)
    if ($null -eq $Text) { return 'null' }
    if ($Text -notmatch '[\x00-\x1f"\\\u2028\u2029]') { return '"' + $Text + '"' }
    $builder = New-Object System.Text.StringBuilder ($Text.Length + 2)
    [void]$builder.Append('"')
    foreach ($ch in $Text.ToCharArray()) {
        $code = [int]$ch
        if ($ch -eq '"') { [void]$builder.Append('\"') }
        elseif ($ch -eq '\') { [void]$builder.Append('\\') }
        elseif ($code -lt 32 -or $code -eq 0x2028 -or $code -eq 0x2029) { [void]$builder.Append('\u').Append($code.ToString('x4', $Invariant)) }
        else { [void]$builder.Append($ch) }
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function ConvertTo-JsonValue {
    param($Value)
    if ($null -eq $Value -or $Value -is [System.DBNull]) { return 'null' }
    if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
    if ($Value -is [datetime]) { return ConvertTo-JsonString $Value.ToString('yyyy-MM-ddTHH:mm:ss.fff', $Invariant) }
    if ($Value -is [double] -or $Value -is [single]) {
        $number = [double]$Value
        if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) { return 'null' }
        return $number.ToString('R', $Invariant)
    }
    if ($Value -is [decimal] -or $Value -is [int] -or $Value -is [long] -or $Value -is [int16] -or $Value -is [byte] -or $Value -is [sbyte] -or $Value -is [uint16] -or $Value -is [uint32] -or $Value -is [uint64]) {
        return $Value.ToString($Invariant)
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $parts = foreach ($key in $Value.Keys) { (ConvertTo-JsonString ([string]$key)) + ':' + (ConvertTo-JsonValue $Value[$key]) }
        return '{' + ($parts -join ',') + '}'
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        $parts = foreach ($item in $Value) { ConvertTo-JsonValue $item }
        return '[' + ($parts -join ',') + ']'
    }
    return ConvertTo-JsonString ([string]$Value)
}

function Save-Result {
    param($Result)
    $text = ConvertTo-JsonValue $Result
    [System.IO.File]::WriteAllText($ResultFile, $text, (New-Object System.Text.UTF8Encoding $false))
}

# ---------- the ADOMD.NET client ----------

function Get-AdomdCandidates {
    param($Request)
    $list = New-Object System.Collections.Generic.List[string]
    $names = @('Microsoft.PowerBI.AdomdClient.dll', 'Microsoft.AnalysisServices.AdomdClient.dll')
    if ($Request.toolsDir -and (Test-Path -LiteralPath $Request.toolsDir)) {
        foreach ($file in Get-ChildItem -LiteralPath $Request.toolsDir -Recurse -Filter '*AdomdClient.dll' -ErrorAction SilentlyContinue) { $list.Add($file.FullName) }
    }
    $bases = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432) | Where-Object { $_ } | Select-Object -Unique
    foreach ($base in $bases) {
        foreach ($folder in @('Microsoft Power BI Desktop\bin', 'Microsoft Power BI Desktop RS\bin', 'DAX Studio\bin', 'DAX Studio', 'Tabular Editor 3', 'Tabular Editor')) {
            foreach ($name in $names) { $list.Add((Join-Path (Join-Path $base $folder) $name)) }
        }
    }
    try {
        foreach ($package in @(Get-AppxPackage -Name '*PowerBIDesktop*' -ErrorAction SilentlyContinue)) {
            foreach ($name in $names) { $list.Add((Join-Path (Join-Path $package.InstallLocation 'bin') $name)) }
        }
    } catch { }
    foreach ($gac in @("$env:WINDIR\Microsoft.NET\assembly\GAC_MSIL\Microsoft.AnalysisServices.AdomdClient", "$env:WINDIR\assembly\GAC_MSIL\Microsoft.AnalysisServices.AdomdClient")) {
        if (Test-Path -LiteralPath $gac) {
            foreach ($file in Get-ChildItem -LiteralPath $gac -Recurse -Filter 'Microsoft.AnalysisServices.AdomdClient.dll' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending) { $list.Add($file.FullName) }
        }
    }
    return @($list | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -Unique)
}

function Get-ConnectionType {
    param([string]$Path)
    $assembly = [System.Reflection.Assembly]::LoadFrom($Path)
    $type = $assembly.GetType('Microsoft.AnalysisServices.AdomdClient.AdomdConnection', $false)
    if ($type) { return $type }
    $types = @()
    try { $types = $assembly.GetTypes() } catch [System.Reflection.ReflectionTypeLoadException] { $types = @($_.Exception.Types | Where-Object { $_ }) }
    return $types | Where-Object { $_.Name -eq 'AdomdConnection' } | Select-Object -First 1
}

function Install-AdomdPackage {
    param([string]$ToolsDir)
    Write-Host '[pbi] No ADOMD.NET client found on this PC; downloading the Microsoft.AnalysisServices.AdomdClient package from nuget.org (once)...'
    [void][System.IO.Directory]::CreateDirectory($ToolsDir)
    $package = Join-Path $ToolsDir 'adomd.nupkg'
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    try {
        $proxy = [System.Net.WebRequest]::DefaultWebProxy
        if ($proxy) { $proxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials }
    } catch { }
    Invoke-WebRequest -Uri 'https://www.nuget.org/api/v2/package/Microsoft.AnalysisServices.AdomdClient.retail.amd64' -OutFile $package -UseBasicParsing -TimeoutSec 120
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($package)
    try {
        $entries = @($zip.Entries | Where-Object { $_.FullName -match '^lib/net4[0-9.]*/[^/]+\.dll$' })
        if (-not $entries.Count) { throw 'The downloaded package has no .NET Framework library.' }
        foreach ($entry in $entries) {
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $ToolsDir $entry.Name), $true)
        }
    } finally { $zip.Dispose() }
    Remove-Item -LiteralPath $package -Force -ErrorAction SilentlyContinue
}

function Resolve-Adomd {
    param($Request)
    $tried = New-Object System.Collections.Generic.List[string]
    for ($pass = 1; $pass -le 2; $pass++) {
        foreach ($path in Get-AdomdCandidates $Request) {
            try {
                $type = Get-ConnectionType $path
                if ($type) { return @{ type = $type; path = $path } }
                $tried.Add("$path (no AdomdConnection type)")
            } catch {
                $tried.Add("$path ($($_.Exception.Message))")
            }
        }
        if ($pass -eq 1) {
            if (-not $Request.allowDownload -or -not $Request.toolsDir) { break }
            try { Install-AdomdPackage $Request.toolsDir } catch { $tried.Add("nuget.org download ($($_.Exception.Message))"); break }
        }
    }
    $detail = if ($tried.Count) { " Tried: $($tried -join '; ')" } else { '' }
    throw "No usable ADOMD.NET client library (Microsoft.AnalysisServices.AdomdClient.dll) was found.$detail"
}

function Invoke-Query {
    param($Connection, [string]$Dax, [int]$TimeoutSeconds)
    $command = $Connection.CreateCommand()
    $command.CommandText = $Dax
    try { $command.CommandTimeout = $TimeoutSeconds } catch { }
    $reader = $command.ExecuteReader()
    try {
        $columns = @(for ($i = 0; $i -lt $reader.FieldCount; $i++) { $reader.GetName($i) })
        $rows = New-Object System.Collections.Generic.List[object]
        while ($reader.Read()) {
            $values = New-Object 'object[]' $reader.FieldCount
            [void]$reader.GetValues($values)
            $rows.Add($values)
        }
        return @{ columns = $columns; rows = $rows }
    } finally { $reader.Close() }
}

# ---------- main ----------

$result = [ordered]@{ ok = $false; adomd = $null; port = $null; instances = @(); results = @(); error = $null }
try {
    $request = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $timeout = if ($request.timeoutSeconds) { [int]$request.timeoutSeconds } else { 120 }
    $adomd = Resolve-Adomd $request
    $result.adomd = $adomd.path
    Write-Host "[pbi] ADOMD.NET client: $($adomd.path)"

    # Several Desktop windows may be open: use the model whose tables match this report.
    $wanted = @($request.tables | ForEach-Object { ([string]$_).ToLowerInvariant() })
    $instances = New-Object System.Collections.Generic.List[object]
    $best = $null
    foreach ($port in @($request.ports)) {
        $entry = [ordered]@{ port = [int]$port; tables = @(); matched = 0; error = $null }
        $connection = $null
        try {
            $connection = [System.Activator]::CreateInstance($adomd.type)
            $connection.ConnectionString = "Data Source=localhost:$port;"
            $connection.Open()
            $tables = Invoke-Query $connection 'SELECT [Name] FROM $SYSTEM.TMSCHEMA_TABLES' 30
            $entry.tables = @($tables.rows | ForEach-Object { [string]$_[0] })
            $entry.matched = @($entry.tables | Where-Object { $wanted -contains $_.ToLowerInvariant() }).Count
            Write-Host "[pbi] Power BI Desktop model on port ${port}: $($entry.tables.Count) table(s), $($entry.matched) of $($wanted.Count) of this report's tables."
            if (-not $best -or $entry.matched -gt $best.matched) {
                if ($best -and $best.connection) { try { $best.connection.Close() } catch { } }
                $best = @{ port = [int]$port; matched = $entry.matched; connection = $connection }
                $connection = $null
            }
        } catch {
            $entry.error = $_.Exception.Message
            Write-Host "[pbi] Port ${port}: $($_.Exception.Message)"
        } finally {
            if ($connection) { try { $connection.Close() } catch { } }
        }
        $instances.Add($entry)
    }
    $result.instances = $instances
    if (-not $best -or $best.matched -eq 0) {
        throw 'No open Power BI Desktop model has this report''s tables. Open the report''s .pbip in Power BI Desktop and keep it open.'
    }
    $result.port = $best.port
    $results = New-Object System.Collections.Generic.List[object]
    $index = 0
    foreach ($query in @($request.queries)) {
        $index++
        $started = [DateTime]::UtcNow
        $item = [ordered]@{ id = $query.id; columns = @(); rows = @(); ms = 0; error = $null }
        try {
            $data = Invoke-Query $best.connection ([string]$query.dax) $timeout
            $item.columns = $data.columns
            $item.rows = $data.rows
        } catch {
            $item.error = $_.Exception.Message
        }
        $item.ms = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
        $status = if ($item.error) { "ERROR: $($item.error)" } else { "$(@($item.rows).Count) row(s)" }
        Write-Host "[pbi] [$index/$(@($request.queries).Count)] $($query.id): $status in $($item.ms) ms"
        $results.Add($item)
    }
    try { $best.connection.Close() } catch { }
    $result.results = $results
    $result.ok = $true
} catch {
    $result.error = $_.Exception.Message
    Write-Host "[pbi] $($_.Exception.Message)"
}
Save-Result $result
exit 0
