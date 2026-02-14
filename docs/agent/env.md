# Agent environment reference

## Runtime model

- Main process: `node dist/index.js gateway run --allow-unconfigured --port 3000 --bind auto`
- Entrypoint: `/app/docker-entrypoint.sh`

## Key environment variables

- `OPENCLAW_STATE_DIR` (default: `/data`)
- `OPENCLAW_WORKSPACE_DIR` (default: `${OPENCLAW_STATE_DIR}/workspace`)
- `OPENCLAW_CONFIG_FILE` (set by entrypoint to `${OPENCLAW_STATE_DIR}/openclaw.json`)
- `OPENCLAW_HOOKS_TOKEN` (when set, enables top-level `hooks` config at startup)
- `OPENCLAW_HOOKS_PATH` (default: `/hooks`)
- `OPENCLAW_HOOKS_ALLOWED_AGENT_IDS` (comma-separated allowlist; default: `*`)
- `TELEGRAM_BOT_TOKEN` (when set, enables Telegram channel auto-wiring at startup)
- `GOG_ACCOUNT` (when set, enables Gmail auto-wiring at startup via hooks.gmail)
- `GOG_KEYRING_PASSWORD` (encrypts file-based keyring for OAuth token storage)
- `GOG_KEYRING_BACKEND` (default: `file` — required for headless Docker)
- `GOG_CONFIG_DIR` (default: `/data/gog` — persists credentials across rebuilds)
