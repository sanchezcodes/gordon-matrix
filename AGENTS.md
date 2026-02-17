# Gordon Matrix

Production-ready VPS deployment template for [OpenClaw](https://openclaw.ai/) — an open-source AI agent platform. Packages OpenClaw as a self-hosted service behind Cloudflare Zero Trust with automated CI/CD, multi-provider LLM routing, and Discord/Telegram/Gmail integrations.

## Tech Stack

Docker, Node.js 22, Bun 1.2.2, Go 1.25, pnpm, Cloudflare Tunnel, GitHub Actions, systemd, GPG

## File Index

| File | Lines | What it does |
|------|------:|--------------|
| `scripts/sync-runtime-config.mjs` | 868 | Core logic: idempotent reconciler that syncs env vars into OpenClaw's JSON config — provider detection, model selection, tiered routing, channel auto-wiring, webhook setup |
| `docker-entrypoint.sh` | 116 | Container startup orchestrator: trims tokens, starts Cloudflare Tunnel, creates persistent dirs, runs sync script, execs OpenClaw gateway |
| `Dockerfile` | 78 | Multi-stage build: stage 1 compiles gogcli (Go), stage 2 builds Node 22 runtime with OpenClaw, Bun, cloudflared, ripgrep |
| `docker-compose.yml` | 67 | VPS orchestration: no exposed ports, 3 CPU / 6 GB limit, journald logging, env vars from shell, health checks |
| `.github/workflows/deploy-vps.yml` | 164 | CI/CD pipeline: validates secrets, SSH deploys to VPS, passes secrets as env vars (never touches disk) |
| `default-config.json` | 90 | OpenClaw config template: primary/fallback models, two agents (`main` + `hooks`), gateway port 3000, disabled hooks/webhooks |
| `backup.sh` | 22 | Daily cron job: creates GPG-encrypted tar.gz of `/data`, rotates backups older than 30 days |
| `onboarding-and-operations.md` | 603 | Full ops runbook: prerequisites, VPS setup, SSH hardening, Docker, systemd, Cloudflare tunnel, GitHub secrets, Gmail |
| `docs/repository-deep-dive.md` | ~370 | Architecture reference: component breakdown, security model, mermaid diagrams (startup, request flow) |
| `docs/vps-deployment-plan.md` | ~614 | Deployment specifications (Spanish): Docker Compose config, workflow, secrets cookbook, troubleshooting |
| `docs/agent/readme.md` | ~20 | Agent runtime playbook: gateway process, first checks, bounded log reads, available CLI tools |
| `docs/agent/env.md` | ~25 | Env vars reference for the in-container agent: runtime model, state dir, workspace, hooks, Gmail, PATH |
| `README.md` | 72 | Quick-start guide: project overview, security model, checklist, agent bootstrap prompts |

## Key Patterns

- **12-factor config**: all settings from env vars, never `.env` files on disk
- **Secrets flow**: GitHub Secrets → SSH env vars → Docker internal memory — never written to VPS disk
- **Idempotent startup**: `sync-runtime-config.mjs` converges safely on every restart, additive only
- **Safe-by-default**: features stay disabled unless their tokens are present; removing a token disables the feature
- **No exposed ports**: Cloudflare Tunnel only (outbound), gateway binds to loopback
- **Non-root container**: runs as user `node` (uid 1000), `/data` at mode 700
- **Two agents**: `main` (Discord/Telegram bindings) and `hooks` (webhook workloads)
- **Tiered model routing**: heartbeat (cheapest: Groq) → subagents (mid: OpenRouter/Groq) → primary (best available)
- **Sandbox always off**: no Docker socket inside the container, so sandbox mode is forced off

## Common Tasks

| Task | Files to read |
|------|---------------|
| Change LLM models or add a provider | `scripts/sync-runtime-config.mjs`, `default-config.json` |
| Add a new integration/channel | `scripts/sync-runtime-config.mjs`, `default-config.json` |
| Modify container startup | `docker-entrypoint.sh` |
| Change build dependencies or OpenClaw version | `Dockerfile` |
| Update CI/CD pipeline or add secrets | `.github/workflows/deploy-vps.yml` |
| Change resource limits or Docker config | `docker-compose.yml` |
| Troubleshoot deployment or VPS setup | `onboarding-and-operations.md` |
| Understand architecture or request flow | `docs/repository-deep-dive.md` |

## Build & Deploy

```bash
# Local build and run
docker compose up -d --build

# View logs
docker logs gordon-matrix --tail 200

# Deploy to VPS (automated)
git push origin main  # triggers .github/workflows/deploy-vps.yml

# Manual deploy with options
# Use GitHub Actions "Run workflow" with inputs:
#   reset_config: true/false
#   openclaw_version: tag or SHA (default: main)
#   gog_version: semantic version without v prefix (default: 0.11.0)
```

## Key Env Vars

| Variable | Required | Purpose |
|----------|:--------:|---------|
| `OPENCLAW_GATEWAY_TOKEN` | yes | Gateway auth + Control UI access |
| `CLOUDFLARE_TUNNEL_TOKEN` | yes | Outbound-only tunnel |
| `OPENAI_API_KEY` | 1+ provider | LLM provider |
| `ANTHROPIC_API_KEY` | 1+ provider | LLM provider |
| `GEMINI_API_KEY` | 1+ provider | LLM provider |
| `GROQ_API_KEY` | optional | Heartbeat/subagent tier (cheapest) |
| `OPENROUTER_API_KEY` | optional | Subagent tier (mid-cost) |
| `DISCORD_BOT_TOKEN` | optional | Discord integration (needs `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID`) |
| `TELEGRAM_BOT_TOKEN` | optional | Telegram integration |
| `OPENCLAW_HOOKS_TOKEN` | optional | Webhook authentication |
| `GOG_ACCOUNT` | optional | Gmail integration (needs `GOG_KEYRING_PASSWORD`) |
| `BRAVE_API_KEY` / `PERPLEXITY_API_KEY` | optional | Web search capability |
