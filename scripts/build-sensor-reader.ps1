$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$projectPath = Join-Path $repoRoot "sensor-reader\Monitor.SensorReader.csproj"
$outputDir = Join-Path $repoRoot "frontend\src-tauri\resources\sensor-reader"
$localDotnet = Join-Path $env:USERPROFILE ".dotnet\dotnet.exe"

function Test-DotnetSdk {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Candidate
    )

    try {
        $sdks = & $Candidate --list-sdks 2>$null
        return $LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace(($sdks -join "").Trim())
    }
    catch {
        return $false
    }
}

$dotnetCandidates = @()

if (Test-Path $localDotnet) {
    $dotnetCandidates += $localDotnet
}

$systemDotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if ($systemDotnet) {
    $dotnetCandidates += $systemDotnet.Source
}

$dotnet = $dotnetCandidates |
    Select-Object -Unique |
    Where-Object { Test-DotnetSdk -Candidate $_ } |
    Select-Object -First 1

if (-not $dotnet) {
    throw "dotnet was not found. Install the .NET 8 SDK first."
}

if (Test-Path $outputDir) {
    Get-ChildItem -LiteralPath $outputDir | Remove-Item -Recurse -Force
}
else {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

& $dotnet build $projectPath `
    -c Release `
    -p:DebugType=None `
    -p:DebugSymbols=false `
    -o $outputDir

if ($LASTEXITCODE -ne 0) {
    throw "dotnet build failed with exit code $LASTEXITCODE."
}

Write-Host "Sensor reader ready:" (Join-Path $outputDir "monitor-sensor-reader.exe")
