#!/usr/bin/env bash
# Point <subdomain>.duckdns.org at this host's public IP. Run by cron every 5 min
# (/etc/cron.d/nightshift-duckdns, installed by bootstrap.sh) or by hand with sudo.
# The token is passed to curl on stdin (not in argv, so `ps` can't show it) and
# never logged; the log only has the time and DuckDNS's OK/KO answer.
set -euo pipefail
ENV_FILE="${NIGHTSHIFT_ENV_DIR:-/opt/nightshift/env}/duckdns.env"
LOG=/var/log/duckdns.log

sub=$(sed -n 's/^DUCKDNS_SUBDOMAIN=//p' "$ENV_FILE" | tail -1)
token=$(sed -n 's/^DUCKDNS_TOKEN=//p' "$ENV_FILE" | tail -1)
if [[ -z $sub || -z $token || $sub == __* ]]; then
  echo "$(date -Is) skipped: DUCKDNS_SUBDOMAIN or DUCKDNS_TOKEN empty" | tee -a "$LOG" >&2
  exit 1
fi

# Empty ip= lets DuckDNS use the address the request comes from.
answer=$(printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&ip="\n' "$sub" "$token" |
  curl -sS --max-time 15 -K - || echo "request failed")
echo "$(date -Is) $sub: $answer" >> "$LOG"
[[ $answer == OK ]] || { echo "duckdns: $answer" >&2; exit 1; }
echo "duckdns: OK"
