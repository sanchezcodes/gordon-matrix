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
