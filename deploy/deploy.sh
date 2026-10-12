#!/usr/bin/env bash
# Build, migrate and restart on the VPS.
#
#   ./deploy/deploy.sh          # build, migrate, restart
#   ./deploy/deploy.sh --pull   # git pull first
#
# Migrations run before the new container serves traffic, and a backup is taken
# before they run — a failed migration on the only copy of the data is how a
# deployment becomes an outage.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "missing .env — copy deploy/env.production.example"; exit 1; }

if [ "${1:-}" = "--pull" ]; then
  echo "→ pulling"
  git pull --ff-only
fi

echo "→ building frontend"
corepack pnpm install --frozen-lockfile=false
corepack pnpm --filter @workspace/whatsapp-blast run build
# Emptied in place, never removed: the web container bind-mounts this folder,
# and a folder deleted and recreated is a different one — nginx kept serving
# the old, empty one and the home page failed with a redirect loop.
mkdir -p deploy/www && find deploy/www -mindepth 1 -delete
cp -r artifacts/whatsapp-blast/dist/public/. deploy/www/

echo "→ starting database"
docker compose up -d db
until docker compose exec -T db pg_isready -U "${POSTGRES_USER:-wam}" >/dev/null 2>&1; do sleep 1; done

# Only meaningful once there is data to lose; harmless on a fresh install.
if docker compose exec -T db psql -U "${POSTGRES_USER:-wam}" -d "${POSTGRES_DB:-whatsapp_marketer}" -tAc \
     "select 1 from information_schema.tables where table_name='users'" 2>/dev/null | grep -q 1; then
  echo "→ backup before migrating"
  mkdir -p deploy/backups
  docker compose exec -T db pg_dump -U "${POSTGRES_USER:-wam}" -d "${POSTGRES_DB:-whatsapp_marketer}" \
    --no-owner --no-acl | gzip > "deploy/backups/pre-deploy-$(date +%Y%m%d-%H%M%S).sql.gz"
fi

echo "→ migrations"
for f in lib/db/migrations/*.sql; do
  echo "   $(basename "$f")"
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-wam}" \
    -d "${POSTGRES_DB:-whatsapp_marketer}" < "$f" >/dev/null
done

echo "→ building and restarting the app"
docker compose build api
docker compose up -d --no-deps api web

echo "→ waiting for health"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1/api/healthz >/dev/null 2>&1; then
    echo "✅ deployed and healthy"
    docker compose ps
    exit 0
  fi
  sleep 2
done

echo "❌ did not come up healthy — last 40 lines:" >&2
docker compose logs --tail 40 api >&2
exit 1
