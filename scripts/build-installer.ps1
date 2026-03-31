$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$frontendDir = Join-Path $repoRoot "frontend"

# Always refresh the sidecar first so the installer bundles the latest backend changes.
& (Join-Path $PSScriptRoot "build-backend.ps1")

Push-Location $frontendDir
try {
    npm run tauri build
}
finally {
    Pop-Location
}

Write-Host "Installer ready at:" (Join-Path $frontendDir "src-tauri\target\release\bundle\nsis\PC Hardware Monitor_0.1.0_x64-setup.exe")
