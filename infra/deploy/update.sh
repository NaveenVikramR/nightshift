#!/usr/bin/env bash
# Pull the latest main, rebuild, migrate, restart and health-check.
#   /opt/nightshift/app/infra/deploy/update.sh
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
before=$(git -C "$APP" rev-parse --short HEAD)
git -C "$APP" pull --ff-only --quiet
after=$(git -C "$APP" rev-parse --short HEAD)
echo "==> $before -> $after"
exec "$APP/infra/deploy/up.sh"
