# PC Hardware Monitor

[![CI](https://github.com/YousefAbdelnour/pc-hardware-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/YousefAbdelnour/pc-hardware-monitor/actions/workflows/ci.yml)

A Windows desktop hardware monitor built with Tauri, React, FastAPI, `psutil`, and LibreHardwareMonitor.

The app shows live CPU, GPU, RAM, VRAM, storage, motherboard, and fan telemetry in a desktop dashboard, then packages the whole experience into a native installer so it can be shared without running commands manually.

## Features

- Live desktop dashboard with WebSocket updates
- CPU, GPU, RAM, VRAM, storage, motherboard, and fan telemetry
- Fast fallback metrics from `psutil` while LibreHardwareMonitor warms up
- Thermal alerts and short history graphs
- Native Windows installer built with Tauri NSIS
- Hidden helper-process startup with clean shutdown handling

## Stack

- Frontend: React, Vite, Framer Motion, Lucide
- Desktop shell: Tauri 2
- Backend API: FastAPI + Uvicorn
- Hardware data: `psutil` + LibreHardwareMonitor
- Packaging: PyInstaller + Tauri bundle

## Project Structure

```text
.
|-- backend/                # FastAPI telemetry service and PyInstaller spec
|-- frontend/               # React UI and Tauri desktop shell
|   |-- src/                # Dashboard UI
|   `-- src-tauri/          # Native app wrapper, icons, resources, bundling config
`-- scripts/                # Helper scripts for release packaging
```

## How It Works

1. The Tauri app starts a hidden LibreHardwareMonitor process and a packaged FastAPI backend.
2. The backend combines quick system stats from `psutil` with richer sensor data from LibreHardwareMonitor.
3. The React UI connects to `ws://127.0.0.1:8000/ws` and renders the live dashboard.
4. During shutdown, the desktop app tears down the helper processes so nothing is left running in the background.

## Requirements

- Windows 10 or Windows 11
- Microsoft WebView2 runtime
- Node.js 20+
- Python 3.11+
- Rust stable with the MSVC toolchain
- Visual Studio Build Tools for Windows desktop compilation

## Install Dependencies

Install the backend tooling:

```powershell
python -m pip install -r .\backend\requirements-dev.txt
```

Install the frontend tooling:

```powershell
Set-Location .\frontend
npm install
Set-Location ..
```

## Run For Development

For normal UI iteration, run the backend and frontend separately:

```powershell
Set-Location .\backend
python .\main.py
```

In another terminal:

```powershell
Set-Location .\frontend
npm run dev
```

Then open `http://localhost:5173`.

## Build The Desktop Installer

Build the packaged backend sidecar:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-backend.ps1
```

Build the installer:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-installer.ps1
```

Installer output:

```text
frontend\src-tauri\target\release\bundle\nsis\PC Hardware Monitor_0.1.0_x64-setup.exe
```

## Quality Checks

The repository is set up for pull-request validation. Every PR should pass:

- Backend lint: `python -m ruff check backend`
- Backend syntax validation: `python -m py_compile .\backend\main.py .\backend\hardware.py`
- Frontend lint: `npm run lint`
- Frontend production build: `npm run build`
- Tauri desktop shell validation: `npm run tauri:check`

## Contribution Workflow

1. Create a branch from `main`.
2. Make your changes and run the quality checks above.
3. Push the branch and open a pull request.
4. Wait for CI to pass and review feedback to be addressed.
5. Squash merge the PR back into `main`.

Recommended GitHub settings for this repo:

- Protect `main`
- Require a pull request before merging
- Require the `backend-quality`, `frontend-quality`, and `tauri-quality` checks to pass
- Optionally require at least one approving review

## Publish To GitHub

1. Review the license files and adjust them if you want different permissions before making the repository public.
2. Create a new empty GitHub repository.
3. Initialize the local repo if needed:

   ```powershell
   git init -b main
   ```

4. Commit the project:

   ```powershell
   git add .
   git commit -m "Initial release"
   ```

5. Connect the remote and push:

   ```powershell
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```

6. Create a GitHub Release and upload the NSIS installer from the path above.

After the initial publish, switch to the pull-request workflow above instead of pushing directly to `main`.

## Licensing

This repository is intentionally **source-available, not open source**.

- Source code terms: [LICENSE.md](./LICENSE.md)
- Official app/release binary terms: [BINARY-USE-LICENSE.md](./BINARY-USE-LICENSE.md)
- Third-party bundled software notices: [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)

Important:

- A public GitHub repository still lets other GitHub users view the code, and GitHub may allow platform-level forks for public repos.
- If you want to completely prevent public source access, the repository must stay private and you should only publish releases/screenshots instead of the code.

## Notes

- This project is currently Windows-only because it depends on LibreHardwareMonitor and Tauri Windows packaging.
- The repo intentionally keeps generated binaries and build folders out of version control.
- If LibreHardwareMonitor takes a moment to warm up, the UI still shows the fast `psutil` metrics first and fills in the richer sensor data as soon as it becomes available.
