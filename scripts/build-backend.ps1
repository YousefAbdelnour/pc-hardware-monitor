$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$backendDir = Join-Path $repoRoot "backend"
$frontendTauriDir = Join-Path $repoRoot "frontend\src-tauri"
$sidecarTarget = Join-Path $frontendTauriDir "binaries\pc-monitor-backend-x86_64-pc-windows-msvc.exe"

Push-Location $backendDir
try {
    python -m PyInstaller .\pc-monitor-backend.spec --noconfirm
}
finally {
    Pop-Location
}

New-Item -ItemType Directory -Path (Split-Path $sidecarTarget) -Force | Out-Null
Copy-Item (Join-Path $backendDir "dist\pc-monitor-backend.exe") $sidecarTarget -Force

Write-Host "Backend sidecar ready:" $sidecarTarget
