#!/usr/bin/env bash
# One-time setup of an Ubuntu 24.04 host (e.g. EC2 t3.micro) for Nightshift.
#
#   curl -fsSLO https://raw.githubusercontent.com/<owner>/<repo>/main/infra/deploy/bootstrap.sh
#   sudo bash bootstrap.sh https://github.com/<owner>/<repo>.git nightshift-demo.duckdns.org
#
# Installs Docker Engine + compose plugin (official apt repo), adds SWAP_GB (default 1) GB swap
# when RAM < 2 GB,
# clones the repo to /opt/nightshift/app, creates /opt/nightshift/env/*.env from the templates
# (chmod 600, random secrets generated, never printed) and installs the DuckDNS cron job.
# Safe to re-run: existing env files and swap are left alone.
set -euo pipefail

REPO_URL="${1:?usage: sudo bash bootstrap.sh <repo-https-url> <domain>}"
DOMAIN="${2:?usage: sudo bash bootstrap.sh <repo-https-url> <domain>}"
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
[[ $DOMAIN =~ ^[a-z0-9.-]+$ ]] || { echo "domain looks wrong: $DOMAIN" >&2; exit 1; }

OWNER="${SUDO_USER:-ubuntu}"
BASE=/opt/nightshift
APP="$BASE/app"
ENV_DIR="$BASE/env"

step() { printf '\n==> %s\n' "$*"; }

step "Swap"
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
# 1 GB is enough when up.sh pulls the GHCR images; SWAP_GB=2 to build alexa-sim on the host.
SWAP_GB=${SWAP_GB:-1}
[[ $SWAP_GB =~ ^[1-8]$ ]] || { echo "SWAP_GB must be 1-8" >&2; exit 1; }
if (( mem_kb < 2000000 )) && ! swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
  fallocate -l "${SWAP_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "$SWAP_GB GB swap enabled"
else
  echo "not needed or already on"
fi

step "Docker Engine (official apt repository)"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git cron
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck source=/dev/null
  codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $codename stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker >/dev/null
usermod -aG docker "$OWNER"
docker --version && docker compose version

step "Repository -> $APP"
install -d -o "$OWNER" -g "$OWNER" -m 755 "$BASE"
if [[ -d "$APP/.git" ]]; then
  echo "already cloned (update with infra/deploy/update.sh)"
else
  sudo -u "$OWNER" git clone --quiet "$REPO_URL" "$APP"
fi

step "Env files -> $ENV_DIR (chmod 600, owner $OWNER)"
install -d -o "$OWNER" -g "$OWNER" -m 700 "$ENV_DIR"
rand() { openssl rand -base64 33 | tr '+/' '-_' | tr -d '=\n'; }
demo_token=$(rand)
webhook_token=$(rand)
# An existing demo token wins, so nightshift.env and demo.env always match.
for f in nightshift demo alexa; do
  existing=$(sed -n 's/^DEMO_ADMIN_TOKEN=//p' "$ENV_DIR/$f.env" 2>/dev/null || true)
  [[ -n $existing && $existing != __* ]] && demo_token=$existing
done
for name in nightshift demo caddy duckdns alexa deploy; do
  target="$ENV_DIR/$name.env"
  if [[ -e $target ]]; then
    echo "$name.env exists, left as is"
    continue
  fi
  (
    umask 077
    sed -e "s/__DOMAIN__/$DOMAIN/g" \
      -e "s/__SUBDOMAIN__/${DOMAIN%.duckdns.org}/g" \
      -e "s/__DEMO_ADMIN_TOKEN__/$demo_token/g" \
      -e "s/__WEBHOOK_TOKEN__/$webhook_token/g" \
      "$APP/infra/deploy/env/$name.env.example" > "$target"
  )
  chown "$OWNER:$OWNER" "$target"
  chmod 600 "$target"
  echo "$name.env created"
done

step "DuckDNS cron (every 5 min, logs OK/KO to /var/log/duckdns.log)"
cat > /etc/cron.d/nightshift-duckdns <<CRON
*/5 * * * * root $APP/infra/deploy/duckdns.sh >/dev/null 2>&1
CRON
chmod 644 /etc/cron.d/nightshift-duckdns
systemctl enable --now cron >/dev/null

cat <<NEXT

Done. Next (as $OWNER, after logging out and in again for the docker group):
  1. Fill the empty values:  nano $ENV_DIR/nightshift.env  (and caddy.env, duckdns.env)
  2. Point DNS:              sudo $APP/infra/deploy/duckdns.sh
  3. Start everything:       $APP/infra/deploy/up.sh
NEXT
