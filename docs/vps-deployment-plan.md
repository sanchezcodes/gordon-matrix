# Plan: Desplegar Gordon Matrix en Hostinger KVM 4 (Ubuntu 24.04 LTS)

## Contexto

El repositorio Gordon Matrix despliega un gateway de OpenClaw con arquitectura "privada por diseño" (sin puertos publicos, todo el trafico pasa por Cloudflare Tunnel). El objetivo es replicar esta misma arquitectura en un VPS Hostinger KVM 4 con Ubuntu 24.04 LTS, usando Docker Compose en lugar de Fly.io, un usuario dedicado `gordon` (no root), y **manteniendo los secretos en GitHub Secrets** (no en un .env en el servidor).

**Lo que NO cambia:** Dockerfile, docker-entrypoint.sh, sync-runtime-config.mjs, default-config.json.

**Lo que cambia:** Se agrega `docker-compose.yml`, un nuevo workflow `deploy-vps.yml`, un servicio systemd, y un script de backup.

---

## Fast path checklist

Si quieres el setup mas rapido y confiable:

1. Configurar el VPS (pasos 1-8 de la seccion de setup).
2. Agregar secretos a GitHub Actions (`VPS_*`, gateway token, tunnel token, y al menos una provider key). Para webhooks, tambien agregar `OPENCLAW_HOOKS_TOKEN`.
3. Deploy con workflow input `reset_config=true` (primer deploy o cuando cambies auth/channel config).
4. Abrir tu hostname de Cloudflare, luego pair el browser/device una vez si lo pide.
5. Re-deploy despues con `reset_config=false` para updates normales.
6. Para Discord, agregar `DISCORD_BOT_TOKEN` y `DISCORD_GUILD_ID` (opcionalmente `DISCORD_CHANNEL_ID`) para que el startup auto-configure Discord con open guild-channel policy y un default channel entry.

---

## Archivos a crear/modificar en el repo

### 1. `docker-compose.yml` (reemplaza fly.toml)

```yaml
services:
  openclaw:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        OPENCLAW_VERSION: ${OPENCLAW_VERSION:-main}
    container_name: gordon-matrix
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - OPENCLAW_PREFER_PNPM=1
      - OPENCLAW_STATE_DIR=/data
      - NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=4096}
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - CLOUDFLARE_TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}
      - OPENAI_API_KEY=${OPENAI_API_KEY:-}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
      - GEMINI_API_KEY=${GEMINI_API_KEY:-}
      - OPENCLAW_HOOKS_TOKEN=${OPENCLAW_HOOKS_TOKEN:-}
      - OPENCLAW_HOOKS_PATH=${OPENCLAW_HOOKS_PATH:-}
      - OPENCLAW_HOOKS_ALLOWED_AGENT_IDS=${OPENCLAW_HOOKS_ALLOWED_AGENT_IDS:-}
      - DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN:-}
      - DISCORD_GUILD_ID=${DISCORD_GUILD_ID:-}
      - DISCORD_CHANNEL_ID=${DISCORD_CHANNEL_ID:-}
      - OPENCLAW_CONTROL_UI_ALLOW_INSECURE_AUTH=${OPENCLAW_CONTROL_UI_ALLOW_INSECURE_AUTH:-false}
      - RESET_CONFIG=${RESET_CONFIG:-false}
    volumes:
      - /opt/gordon-matrix/data:/data
    # SIN ports: - arquitectura privada (igual que fly.toml sin [http_service])
    deploy:
      resources:
        limits:
          cpus: "3.0"
          memory: 6G
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000').then(r=>process.exit(r.ok||r.status===401?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
    logging:
      driver: "journald"
      options:
        tag: "gordon-matrix"
```

**Seguridad clave:** No hay `ports:` mapping. El puerto 3000 solo existe dentro del contenedor. `cloudflared` corre dentro del mismo contenedor y hace tunnel a Cloudflare.

### 2. `.github/workflows/deploy-vps.yml` (nuevo workflow de deploy)

El workflow hace SSH nativo al VPS y exporta los secretos de GitHub como env vars en el shell remoto (via heredoc sin comillas). Docker Compose los lee del entorno del shell. Los secretos quedan solo en la memoria de Docker (internamente en `/var/lib/docker/`, solo accesible por root). Sin archivos intermedios, sin dependencias de terceros.

```yaml
name: Deploy to VPS

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      reset_config:
        description: "Reset config to default"
        required: false
        type: boolean
        default: false
      openclaw_version:
        description: "OpenClaw version (main, tag, or commit SHA)"
        required: false
        type: string
        default: "main"

jobs:
  deploy:
    name: Deploy OpenClaw to VPS
    runs-on: ubuntu-latest
    concurrency: deploy-group
    permissions:
      contents: read
    steps:
      - name: Validate required secrets
        run: |
          set -euo pipefail
          [ -n "${OPENCLAW_GATEWAY_TOKEN}" ] || { echo "Missing: OPENCLAW_GATEWAY_TOKEN"; exit 1; }
          [ -n "${CLOUDFLARE_TUNNEL_TOKEN}" ] || { echo "Missing: CLOUDFLARE_TUNNEL_TOKEN"; exit 1; }
          [ -n "${VPS_HOST}" ] || { echo "Missing: VPS_HOST"; exit 1; }
          [ -n "${VPS_SSH_KEY}" ] || { echo "Missing: VPS_SSH_KEY"; exit 1; }
          if [ -z "${ANTHROPIC_API_KEY}" ] && [ -z "${OPENAI_API_KEY}" ] && [ -z "${GEMINI_API_KEY}" ]; then
            echo "Set at least one provider key"; exit 1
          fi
        env:
          OPENCLAW_GATEWAY_TOKEN: ${{ secrets.OPENCLAW_GATEWAY_TOKEN }}
          CLOUDFLARE_TUNNEL_TOKEN: ${{ secrets.CLOUDFLARE_TUNNEL_TOKEN }}
          VPS_HOST: ${{ secrets.VPS_HOST }}
          VPS_SSH_KEY: ${{ secrets.VPS_SSH_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}

      - name: Deploy via SSH
        run: |
          set -euo pipefail
          mkdir -p ~/.ssh
          echo "${VPS_SSH_KEY}" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          ssh -o StrictHostKeyChecking=no -i ~/.ssh/deploy_key \
            -p ${VPS_SSH_PORT:-22} gordon@${VPS_HOST} bash -s << EOF
          set -euo pipefail
          export OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN}"
          export CLOUDFLARE_TUNNEL_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN}"
          export OPENAI_API_KEY="${OPENAI_API_KEY}"
          export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}"
          export GEMINI_API_KEY="${GEMINI_API_KEY}"
          export OPENCLAW_HOOKS_TOKEN="${OPENCLAW_HOOKS_TOKEN}"
          export OPENCLAW_HOOKS_PATH="${OPENCLAW_HOOKS_PATH}"
          export OPENCLAW_HOOKS_ALLOWED_AGENT_IDS="${OPENCLAW_HOOKS_ALLOWED_AGENT_IDS}"
          export DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN}"
          export DISCORD_GUILD_ID="${DISCORD_GUILD_ID}"
          export DISCORD_CHANNEL_ID="${DISCORD_CHANNEL_ID}"
          export OPENCLAW_CONTROL_UI_ALLOW_INSECURE_AUTH="${OPENCLAW_CONTROL_UI_ALLOW_INSECURE_AUTH}"
          export RESET_CONFIG="${RESET_CONFIG}"
          export OPENCLAW_VERSION="${OPENCLAW_VERSION}"
          export NODE_OPTIONS="--max-old-space-size=4096"

          cd /opt/gordon-matrix/app
          git pull origin main
          docker compose up -d --build --remove-orphans
          docker ps --filter name=gordon-matrix --format "table {{.Names}}\t{{.Status}}"
          EOF
          rm -f ~/.ssh/deploy_key
        env:
          VPS_HOST: ${{ secrets.VPS_HOST }}
          VPS_SSH_KEY: ${{ secrets.VPS_SSH_KEY }}
          VPS_SSH_PORT: ${{ secrets.VPS_SSH_PORT }}
          OPENCLAW_GATEWAY_TOKEN: ${{ secrets.OPENCLAW_GATEWAY_TOKEN }}
          CLOUDFLARE_TUNNEL_TOKEN: ${{ secrets.CLOUDFLARE_TUNNEL_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          OPENCLAW_HOOKS_TOKEN: ${{ secrets.OPENCLAW_HOOKS_TOKEN }}
          OPENCLAW_HOOKS_PATH: ${{ secrets.OPENCLAW_HOOKS_PATH }}
          OPENCLAW_HOOKS_ALLOWED_AGENT_IDS: ${{ secrets.OPENCLAW_HOOKS_ALLOWED_AGENT_IDS }}
          DISCORD_BOT_TOKEN: ${{ secrets.DISCORD_BOT_TOKEN }}
          DISCORD_GUILD_ID: ${{ secrets.DISCORD_GUILD_ID }}
          DISCORD_CHANNEL_ID: ${{ secrets.DISCORD_CHANNEL_ID }}
          OPENCLAW_CONTROL_UI_ALLOW_INSECURE_AUTH: ${{ secrets.OPENCLAW_CONTROL_UI_ALLOW_INSECURE_AUTH || 'false' }}
          RESET_CONFIG: ${{ inputs.reset_config || 'false' }}
          OPENCLAW_VERSION: ${{ inputs.openclaw_version || 'main' }}

      - name: Log warnings
        run: |
          [ -n "${OPENCLAW_HOOKS_TOKEN}" ] || echo "::notice::Webhooks disabled (OPENCLAW_HOOKS_TOKEN not set)"
          if [ -n "${DISCORD_BOT_TOKEN}" ] && [ -z "${DISCORD_GUILD_ID}" ]; then
            echo "::warning::Discord auto-wiring skipped (DISCORD_GUILD_ID missing)"
          fi
        env:
          OPENCLAW_HOOKS_TOKEN: ${{ secrets.OPENCLAW_HOOKS_TOKEN }}
          DISCORD_BOT_TOKEN: ${{ secrets.DISCORD_BOT_TOKEN }}
          DISCORD_GUILD_ID: ${{ secrets.DISCORD_GUILD_ID }}
```

### 3. `backup.sh` (script de backup)

```bash
#!/usr/bin/env bash
set -euo pipefail
BACKUP_DIR="/opt/gordon-matrix/backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
tar czf "${BACKUP_DIR}/data-${TIMESTAMP}.tar.gz" -C /opt/gordon-matrix data
find "${BACKUP_DIR}" -name "data-*.tar.gz" -mtime +30 -delete
echo "[$(date)] Backup done: data-${TIMESTAMP}.tar.gz"
```

---

## Prerequisitos

- VPS Hostinger KVM 4 con Ubuntu 24.04 LTS
- Cloudflare Zero Trust account
- Tunnel creado en Cloudflare con un tunnel token
- OpenClaw model provider API key(s)

Docs utiles:

- OpenClaw Docker install: <https://docs.openclaw.ai/install/docker>
- OpenClaw Control UI: <https://docs.openclaw.ai/web/control-ui>
- Cloudflare Tunnel: <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/>
- Cloudflare Access policies: <https://developers.cloudflare.com/cloudflare-one/access-controls/policies/>

---

## Configurar Cloudflare Tunnel ingress

Apunta tu tunnel hostname al proceso OpenClaw dentro del contenedor Docker:

- Service target: `http://127.0.0.1:3000`

Luego protege ese hostname con una Access application y una Allow policy para tus usuarios/grupos.

Notas:

- Access es deny-by-default.
- Evita `Bypass` permanente para superficies admin internas.

---

## Pasos de setup en el VPS (una sola vez)

### Paso 1: Crear usuario `gordon`
```bash
sudo adduser --home /opt/gordon-matrix --shell /bin/bash gordon
sudo usermod -aG docker gordon
```
Nota: necesita shell `/bin/bash` para que GitHub Actions pueda hacer SSH. Se protege con SSH key-only (sin password).

### Paso 2: Configurar SSH key-only para `gordon`
```bash
sudo mkdir -p /opt/gordon-matrix/.ssh
# Agregar la clave publica correspondiente a VPS_SSH_KEY
sudo tee /opt/gordon-matrix/.ssh/authorized_keys <<< "ssh-ed25519 AAAA..."
sudo chown -R gordon:gordon /opt/gordon-matrix/.ssh
sudo chmod 700 /opt/gordon-matrix/.ssh
sudo chmod 600 /opt/gordon-matrix/.ssh/authorized_keys
```

### Paso 3: Instalar Docker Engine
Docker CE + docker-compose-plugin desde el repo oficial de Docker para Ubuntu 24.04.

### Paso 4: Crear estructura de directorios
```bash
sudo mkdir -p /opt/gordon-matrix/{data,backups}
sudo chown -R gordon:gordon /opt/gordon-matrix
sudo chmod 700 /opt/gordon-matrix/data
```

### Paso 5: Clonar repo
```bash
sudo -u gordon git clone https://github.com/sanchezcodes/gordon-matrix.git /opt/gordon-matrix/app
```

### Paso 6: Servicio systemd

Archivo: `/etc/systemd/system/gordon-matrix.service`
```ini
[Unit]
Description=Gordon Matrix (OpenClaw Gateway)
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=gordon
Group=gordon
WorkingDirectory=/opt/gordon-matrix/app
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
```

Nota: El systemd service NO necesita .env — solo reinicia el contenedor que Docker ya tiene configurado con las env vars del ultimo deploy.

```bash
sudo systemctl daemon-reload
sudo systemctl enable gordon-matrix.service
```

### Paso 7: Firewall (UFW)
Verificar que solo estan abiertos SSH (22), HTTP (80), HTTPS (443). El puerto 3000 NO se expone.

### Paso 8: Backup automatico (cron)
```bash
sudo crontab -u gordon -e
# Agregar:
0 3 * * * /opt/gordon-matrix/app/backup.sh >> /opt/gordon-matrix/backups/backup.log 2>&1
```

---

## GitHub Actions secrets

### Secretos requeridos

- `VPS_HOST` — IP o hostname del VPS
- `VPS_SSH_KEY` — clave privada SSH (ed25519) para el usuario `gordon`
- `OPENCLAW_GATEWAY_TOKEN`
- al menos una provider key:
  - `ANTHROPIC_API_KEY`
  - `OPENAI_API_KEY`
  - o `GEMINI_API_KEY`
- `CLOUDFLARE_TUNNEL_TOKEN`

### Secretos opcionales

- `VPS_SSH_PORT` (si no es 22)
- `OPENCLAW_HOOKS_TOKEN` (requerido solo para habilitar webhooks)
- `OPENCLAW_HOOKS_PATH` (default: `/hooks`)
- `OPENCLAW_HOOKS_ALLOWED_AGENT_IDS` (default: `*`)
- `DISCORD_BOT_TOKEN`
- `DISCORD_GUILD_ID`
- `DISCORD_CHANNEL_ID` (default: `general` cuando Discord se auto-configura)
- `OPENCLAW_CONTROL_UI_ALLOW_INSECURE_AUTH` (default: `false` en cada deploy)

### Startup auto-wiring behaviors

Estos comportamientos son del Docker image (identicos a Fly.io):

- Provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) crean entries `auth.profiles.*:default` cuando no existen.
- Startup asegura que los agentes `main` y `hooks` existan; usar `hooks` como target default para webhook workloads.
- Cuando `OPENCLAW_HOOKS_TOKEN` esta set, startup habilita top-level `hooks`, escribe el shared token, y mantiene webhook path/agent allowlist alineados con env defaults (`/hooks`, `*`).
- Startup selecciona `agents.defaults.model.primary` de los providers disponibles (prioridad: OpenAI, luego Anthropic, luego Google) y mantiene fallbacks alineados.
- Cuando `DISCORD_BOT_TOKEN` y `DISCORD_GUILD_ID` estan set, startup habilita Discord plugin/binding, configura `channels.discord.groupPolicy="open"`, habilita wildcard channel access, y crea un default channel key (`DISCORD_CHANNEL_ID` o `general`).

### Secret value cookbook

| Secret | Requerido? | Ejemplo | Como obtenerlo | Default si opcional |
|---|---|---|---|---|
| `VPS_HOST` | Si | `203.0.113.10` | IP de tu VPS Hostinger | n/a |
| `VPS_SSH_KEY` | Si | `-----BEGIN OPENSSH...` | `ssh-keygen -t ed25519` | n/a |
| `VPS_SSH_PORT` | No | `22` | Puerto SSH del VPS | `22` |
| `OPENCLAW_GATEWAY_TOKEN` | Si | `f0f57a7f...` (64 hex chars) | `openssl rand -hex 32` | n/a |
| `CLOUDFLARE_TUNNEL_TOKEN` | Si | `eyJhIjoi...` | Cloudflare Zero Trust tunnel dashboard, o `cloudflared tunnel token <tunnel-name>` | n/a |
| `OPENCLAW_HOOKS_TOKEN` | No (Si para webhooks) | `c0ffeec0...` (64 hex chars) | `openssl rand -hex 32` | Unset (webhooks disabled) |
| `OPENCLAW_HOOKS_PATH` | No | `/hooks` | Override opcional para webhook base path | `/hooks` |
| `OPENCLAW_HOOKS_ALLOWED_AGENT_IDS` | No | `*` o `main` o `main,hooks` | Allowlist explicito de `agentId` | `*` |
| `ANTHROPIC_API_KEY` | Una provider key requerida | `sk-ant-...` | Anthropic Console | Unset |
| `OPENAI_API_KEY` | Una provider key requerida | `sk-proj-...` | OpenAI API keys page | Unset |
| `GEMINI_API_KEY` | Una provider key requerida | `AIza...` | Google AI Studio / Google Cloud credentials | Unset |
| `DISCORD_BOT_TOKEN` | No | `MTA...` | Discord Developer Portal → Bot token | Unset |
| `DISCORD_GUILD_ID` | No | `123456789012345678` | Discord Developer Mode → copy server ID | Unset |
| `DISCORD_CHANNEL_ID` | No | `123456789012345678` | Discord Developer Mode → copy channel ID | `general` |
| `OPENCLAW_CONTROL_UI_ALLOW_INSECURE_AUTH` | No | `false` (recomendado) o `true` | Usar `true` solo cuando intencionalmente quieras token-only auth sin pairing | `false` enforced por workflow |

---

## Deploy

Deploy con push a `main`, o manualmente ejecutar el workflow **Deploy to VPS**.

### Flujo de deploy

```
Push a main → GitHub Actions → SSH nativo al VPS como gordon →
  git pull → docker compose up --build (env vars via SSH) →
  container corriendo con secretos en memoria Docker
```

**Los secretos nunca tocan el disco del VPS.** GitHub Actions los exporta como env vars en la sesion SSH, Docker Compose los lee del entorno del shell, y Docker los almacena internamente en `/var/lib/docker/` (solo accesible por root).

### Manual workflow inputs

- `openclaw_version`:
  - `main` (default)
  - tag especifico o commit SHA
- `reset_config`:
  - usar `true` para forzar un `/data/openclaw.json` fresco en startup
  - usar `false` para deploys normales

Recomendado para primer setup: ejecutar una vez con `reset_config=true`.

---

## Caddy: sin cambios

Caddy sigue manejando otros servicios. OpenClaw se accede exclusivamente por Cloudflare Tunnel.

---

## Validar despues de deploy

```bash
docker ps --filter name=gordon-matrix          # container running
ss -tlnp | grep 3000                            # debe estar vacio (no expuesto al host)
docker logs gordon-matrix 2>&1 | grep tunnel    # tunnel conectado
docker exec gordon-matrix curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000
```

Expected signs:

- OpenClaw gateway started en puerto `3000`
- cloudflared started con tu tunnel token
- si `OPENCLAW_HOOKS_TOKEN` esta set, `/hooks/wake` y `/hooks/agent` estan habilitados

Luego abrir tu hostname protegido por Cloudflare y autenticarse con Access.

### Validar webhook endpoint por Cloudflare Tunnel

Si configuraste `OPENCLAW_HOOKS_TOKEN`, test desde cualquier cliente con acceso a internet:

```bash
curl -X POST "https://<your-hostname>/hooks/wake" \
  -H "CF-Access-Client-Id: <your-access-service-token-id>" \
  -H "CF-Access-Client-Secret: <your-access-service-token-secret>" \
  -H "Authorization: Bearer <OPENCLAW_HOOKS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"text":"Webhook test from Cloudflare","mode":"now"}'
```

Y para un agent run aislado:

```bash
curl -X POST "https://<your-hostname>/hooks/agent" \
  -H "CF-Access-Client-Id: <your-access-service-token-id>" \
  -H "CF-Access-Client-Secret: <your-access-service-token-secret>" \
  -H "Authorization: Bearer <OPENCLAW_HOOKS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"message":"Summarize recent alerts","name":"Webhook","agentId":"hooks","wakeMode":"now"}'
```

Session behavior notes:

- `/hooks/agent` ya usa un `sessionKey` random fresco por llamada cuando `sessionKey` se omite.
- Para webhook events no relacionados (como emails independientes), omitir `sessionKey` para que cada run quede aislado.
- Solo usar un `sessionKey` estable cuando intencionalmente quieras continuidad multi-turn (por ejemplo, una key por email thread).

### Primera conexion remota al Control UI (pairing esperado)

Si el Control UI muestra `disconnected (1008): pairing required`, es esperado para dispositivos nuevos.

Aprobar el pending device request desde dentro del contenedor:

```bash
docker exec -it gordon-matrix sh
npx openclaw devices list
npx openclaw devices approve <request-id>
```

Luego refrescar la UI y conectar de nuevo.

### Channel y provider sanity check

Ejecutar desde el VPS despues del deploy:

```bash
docker exec gordon-matrix npx openclaw status --deep
docker exec gordon-matrix npx openclaw channels list
```

Si `channels list` no muestra channels o auth providers, revisar secretos y hacer un deploy con `reset_config=true`.

---

## Operaciones

### Ver logs

```bash
docker logs gordon-matrix                       # logs del contenedor
docker logs gordon-matrix --tail 100 -f         # follow ultimas 100 lineas
journalctl -t gordon-matrix                     # via journald (logging driver)
```

### Shell en el contenedor

```bash
docker exec -it gordon-matrix sh
```

### Inspeccionar config

```bash
docker exec gordon-matrix sh -c 'head -240 /data/openclaw.json'
```

### Restart contenedor

```bash
cd /opt/gordon-matrix/app && docker compose restart
# O via systemd:
sudo systemctl restart gordon-matrix
```

### Ejecutar comandos one-shot

```bash
docker exec gordon-matrix npx openclaw status --deep
docker exec gordon-matrix npx openclaw channels list
docker exec gordon-matrix npx openclaw gateway health --url ws://127.0.0.1:3000 --token "$OPENCLAW_GATEWAY_TOKEN"
```

---

## Troubleshooting

### Tunnel not reachable

- Confirmar que `CLOUDFLARE_TUNNEL_TOKEN` esta presente en GitHub Secrets y se hizo redeploy.
- Confirmar tunnel ingress target es `http://127.0.0.1:3000`.
- Revisar Cloudflare Zero Trust dashboard para connector health.

### Webhook calls fail

- Confirmar que `OPENCLAW_HOOKS_TOKEN` esta en GitHub Secrets y se hizo redeploy si se agrego recientemente.
- Confirmar que el request incluye Cloudflare Access service-token headers y un valid OpenClaw hook token (`Authorization: Bearer <OPENCLAW_HOOKS_TOKEN>`).
- Confirmar que el webhook path coincide con tu config (`/hooks` por default, o `OPENCLAW_HOOKS_PATH` override).
- Si llamas `/hooks/agent` con `agentId`, confirmar que esta incluido en `OPENCLAW_HOOKS_ALLOWED_AGENT_IDS` (o usar `*`).

### Discord not responding

- Confirmar que `DISCORD_BOT_TOKEN` esta en GitHub Secrets.
- Confirmar que `DISCORD_GUILD_ID` coincide con el target Discord server.
- Opcionalmente configurar `DISCORD_CHANNEL_ID` para seed tu default channel key preferido (sino `general`).
- Confirmar que `/data/openclaw.json` incluye los Discord plugin/channel entries auto-configurados despues del startup.
- Verificar gateway reachability:

```bash
docker exec gordon-matrix npx openclaw gateway probe
docker exec gordon-matrix npx openclaw status --deep
docker exec gordon-matrix npx openclaw gateway health --url ws://127.0.0.1:3000 --token "$OPENCLAW_GATEWAY_TOKEN"
```

- Si health/probe reporta `connect ECONNREFUSED`, start en foreground mode:

```bash
docker exec gordon-matrix npx openclaw gateway run --allow-unconfigured --port 3000 --bind auto
```

- Re-check channels:

```bash
docker exec gordon-matrix npx openclaw channels list
docker exec gordon-matrix npx openclaw status
```

- Si intencionalmente usas `--force`, asegurar que `lsof` esta instalado en la imagen.

### Control UI auth issues

- Verificar que `OPENCLAW_GATEWAY_TOKEN` esta set.
- Si ves `disconnected (1008): pairing required`, ejecutar:

```bash
docker exec -it gordon-matrix sh
npx openclaw devices list
npx openclaw devices approve <request-id>
```

- Solo usar `OPENCLAW_CONTROL_UI_ALLOW_INSECURE_AUTH=true` cuando intencionalmente aceptes token-only auth behavior.

### Gateway lock file issue

```bash
docker exec gordon-matrix rm -f /data/gateway.*.lock
```

### Config reset behavior

- Usar workflow input `reset_config=true` para un deploy cuando sea necesario.
- Deploys subsecuentes deben mantenerlo en `false`.

---

## Seguridad: Fly.io vs VPS

| Capa | Fly.io | VPS (este plan) |
|------|--------|-----------------|
| Red | Sin `[http_service]` | Sin `ports:` en compose |
| Ingress | Cloudflare Tunnel | Cloudflare Tunnel (igual) |
| Secretos | GitHub Secrets → Fly vault | GitHub Secrets → SSH env vars → Docker internamente |
| Proceso | Fly microVM | Docker + usuario `gordon` |
| Acceso | Cloudflare Zero Trust | Cloudflare Zero Trust (igual) |

---

## Agent bootstrap prompts

Al abrir una sesion de agente dentro del contenedor, prompts utiles:

1. `Read /app/docs/agent/readme.md and /app/docs/agent/env.md, then summarize key paths and runtime conventions.`
2. `Use bounded log reads to diagnose gateway startup and identify the first fatal event.`
3. `Check gateway health and channel status, then summarize any blocking errors.`

---

## Archivos criticos existentes (no se modifican)

- `Dockerfile` — build del contenedor
- `docker-entrypoint.sh` — startup: tunnel, dirs, config sync, gateway
- `scripts/sync-runtime-config.mjs` — reconciliacion env → JSON config
- `default-config.json` — template de configuracion
