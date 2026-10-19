#!/usr/bin/env bash
# Build and (re)start the production stack, apply DB migrations, then wait for
# https://<domain>/healthz. Run as the deploy user (in the docker group):
#   /opt/nightshift/app/infra/deploy/up.sh
# Never prints secret values; only the NAMES of settings that are still empty.
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export NIGHTSHIFT_ENV_DIR="${NIGHTSHIFT_ENV_DIR:-/opt/nightshift/env}"
COMPOSE=(docker compose -f "$APP/infra/docker-compose.prod.yml")
# One build at a time: a 1 GB instance runs out of memory building two images at once.
export COMPOSE_PARALLEL_LIMIT=1

value() { sed -n "s/^$2=//p" "$NIGHTSHIFT_ENV_DIR/$1.env" | tail -1; }

missing=()
require() {
  local file=$1; shift
  if [[ ! -r $NIGHTSHIFT_ENV_DIR/$file.env ]]; then
    missing+=("$file.env (file)")
    return 0
  fi
  for key in "$@"; do
    local v
    v=$(value "$file" "$key")
    if [[ -z $v || $v == __* || $v == '[]' ]]; then missing+=("$file.env: $key"); fi
  done
}
require nightshift ALLOWED_HOSTS ALLOWED_ORIGINS NIGHTSHIFT_TOKENS DATABASE_URL DEMO_ADMIN_TOKEN \
  ALERTMANAGER_WEBHOOK_TOKEN
require demo DEMO_ADMIN_TOKEN
require alexa ALLOWED_ORIGINS ALLOWED_HOSTS DEMO_ADMIN_TOKEN
require caddy DOMAIN ACME_EMAIL
if ((${#missing[@]})); then
  printf 'Fill these first (nano %s/<file>):\n' "$NIGHTSHIFT_ENV_DIR" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 1
fi
[[ -n $(value nightshift TELEGRAM_BOT_TOKEN) ]] || echo "note: TELEGRAM_BOT_TOKEN empty, no pushes"
[[ $(value nightshift DEMO_ADMIN_TOKEN) == "$(value demo DEMO_ADMIN_TOKEN)" ]] ||
  { echo "DEMO_ADMIN_TOKEN differs between nightshift.env and demo.env" >&2; exit 1; }
[[ $(value alexa DEMO_ADMIN_TOKEN) == "$(value demo DEMO_ADMIN_TOKEN)" ]] ||
  { echo "DEMO_ADMIN_TOKEN differs between alexa.env and demo.env" >&2; exit 1; }
DOMAIN=$(value caddy DOMAIN)

echo "==> Alertmanager webhook credentials file (readable by the alertmanager user only)"
secrets="$NIGHTSHIFT_ENV_DIR/alertmanager"
sudo install -d -m 0750 -o root -g 65534 "$secrets"
value nightshift ALERTMANAGER_WEBHOOK_TOKEN | tr -d '\n' | sudo tee "$secrets/webhook_token" >/dev/null
sudo chown root:65534 "$secrets/webhook_token"
sudo chmod 0440 "$secrets/webhook_token"

# Images: pulled from GHCR when deploy.env sets NIGHTSHIFT_IMAGE_PREFIX
# (e.g. ghcr.io/<owner>/nightshift, built by .github/workflows/images.yml), else built here.
if [[ -r $NIGHTSHIFT_ENV_DIR/deploy.env ]]; then
  NIGHTSHIFT_IMAGE_PREFIX=$(value deploy NIGHTSHIFT_IMAGE_PREFIX)
  NIGHTSHIFT_IMAGE_TAG=$(value deploy NIGHTSHIFT_IMAGE_TAG)
  export NIGHTSHIFT_IMAGE_PREFIX NIGHTSHIFT_IMAGE_TAG="${NIGHTSHIFT_IMAGE_TAG:-main}"
fi
if [[ -n ${NIGHTSHIFT_IMAGE_PREFIX:-} ]]; then
  echo "==> Pull images ($NIGHTSHIFT_IMAGE_PREFIX-*:$NIGHTSHIFT_IMAGE_TAG)"
  "${COMPOSE[@]}" --profile migrate pull migrate nightshift demo-target alexa-sim
else
  echo "==> Build images (sequential; a 1 GB host needs the 2 GB swap from bootstrap.sh for alexa-sim)"
  "${COMPOSE[@]}" build demo-target
  "${COMPOSE[@]}" build nightshift
  "${COMPOSE[@]}" --profile migrate build migrate
  "${COMPOSE[@]}" build alexa-sim
fi

echo "==> Database migrations"
"${COMPOSE[@]}" --profile migrate run --rm migrate

echo "==> Start"
"${COMPOSE[@]}" up -d --no-build --remove-orphans
docker image prune -f >/dev/null

echo "==> Waiting for https://$DOMAIN/healthz (first start includes getting the certificate)"
for _ in $(seq 1 40); do
  if [[ $(curl -fsS --max-time 5 "https://$DOMAIN/healthz" 2>/dev/null) == ok ]]; then
    echo "healthy: https://$DOMAIN/healthz"
    "${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
    exit 0
  fi
  sleep 6
done
echo "not healthy after 4 minutes; see: docker compose -f infra/docker-compose.prod.yml logs --tail=50" >&2
"${COMPOSE[@]}" ps
exit 1
