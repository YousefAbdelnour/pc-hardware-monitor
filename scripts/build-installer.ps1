$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$frontendDir = Join-Path $repoRoot "frontend"
$tauriConfigPath = Join-Path $frontendDir "src-tauri\tauri.conf.json"
$version = (Get-Content $tauriConfigPath | ConvertFrom-Json).version

# Always refresh the sidecar first so the installer bundles the latest backend changes.
& (Join-Path $PSScriptRoot "build-backend.ps1")

Push-Location $frontendDir
try {
    npm run tauri build
}
finally {
    Pop-Location
}

$installerDirectory = Join-Path $frontendDir "src-tauri\target\release\bundle\nsis"
$installerPath = Join-Path $installerDirectory "PC Hardware Monitor_${version}_x64-setup.exe"
Write-Host "Installer ready at:" $installerPath
