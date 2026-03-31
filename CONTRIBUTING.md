# Contributing

## Branching

- Keep `main` release-ready.
- Create a short-lived feature branch for every change.
- Open a pull request instead of pushing directly to `main`.

## Local Checks

Run these before opening a PR:

```powershell
python -m pip install -r .\backend\requirements-dev.txt
python -m ruff check .\backend
python -m py_compile .\backend\main.py .\backend\hardware.py

Set-Location .\frontend
npm ci
npm run lint
npm run build
npm run tauri:check
Set-Location ..
```

## Pull Requests

- Keep PRs focused on one change.
- Include screenshots for UI changes when helpful.
- Link related issues.
- Wait for CI to pass before merging.
- Prefer squash merges to keep history clean.

## Recommended GitHub Rules

To keep the repository interview-ready and team-friendly, enable these rules on `main`:

- Require pull requests before merging
- Require the CI checks in `.github/workflows/ci.yml`
- Prevent direct pushes
- Optionally require at least one approving review
