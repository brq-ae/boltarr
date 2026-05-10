# Contributing to Boltarr

## Reporting bugs

Open a [GitHub issue](https://github.com/brq-ae/boltarr/issues) with:
- What you did
- What you expected to happen
- What actually happened
- Your deployment method (Docker, bare metal, Proxmox LXC, etc.)

## Suggesting features

Open an issue with the `enhancement` label. Describe the problem you're trying to solve, not just the solution — context helps evaluate whether it fits the project's scope.

## Submitting code

1. Fork the repo and create a branch from `master`
2. Make your changes
3. Test locally with `bash run.sh`
4. Open a pull request with a clear description of what and why

## Project structure

- `backend/` — FastAPI app (Python)
- `frontend/` — vanilla JS/CSS, no build step
- `data/` — SQLite database and config (gitignored)

No build pipeline, no framework — changes to `frontend/` are live on save.
