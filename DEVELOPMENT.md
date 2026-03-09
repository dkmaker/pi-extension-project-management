# Development Setup

## Prerequisites

- [pi coding agent](https://github.com/nicobrinkkemper/pi-coding-agent) installed

## Local Development Mode

By default, pi loads extensions from git packages. For local development, run the setup script to symlink the repo's source files directly into pi's extension directory:

```bash
bash scripts/enable_dev_mode.sh
```

This will:

1. Create `.pi/extensions/project-management/` with symlinks to all `.ts` files in the repo root
2. Remove any git package reference from `.pi/settings.json`
3. Clean up the `.pi/git/` folder if present

After running the script, restart pi and it will load your local source files. Any edits to the `.ts` files are picked up on the next pi restart.

## Project Structure

```
*.ts                  # Extension source files
scripts/              # Development scripts
  enable_dev_mode.sh  # Set up local dev symlinks
.pi/
  settings.json       # Pi settings (no git package in dev mode)
  extensions/         # Symlinked extensions (gitignored)
```
