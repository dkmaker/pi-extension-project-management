# Agent Notes

## Development Setup

Run `./run_pi_dev_mode.sh` to start pi in dev mode with an isolated home directory (`~/.pi_dev_extension-project-management`), loading the local extension source directly. Additional extensions can be configured in `dev_additional_extensions.json`.

## Scripts

- `run_pi_dev_mode.sh` — Starts pi with local `.ts` source and isolated config, plus additional extensions (file-rules, pi-docs).
- `devmode.ts` — Shows a rotating DEVMODE banner when running in dev mode, warns if running from source without dev mode.
