# Shared helpers for deploy/*.sh. Sourced, not executed.
# shellcheck shell=bash disable=SC2034
APP_DIR=${APP_DIR:-/opt/slop-or-not/app}
ENV_FILE=${ENV_FILE:-/etc/slop-or-not/app.env}
DATA_DIR=${DATA_DIR:-/data}
DB=$DATA_DIR/game.sqlite
MARKER=$DATA_DIR/.slop-or-not-volume
NODE=${NODE:-/usr/local/bin/node}
# setup.sh installs node/npm in /usr/local/bin, which sudo's secure_path omits on
# Oracle Linux; npm's '#!/usr/bin/env node' shebang also needs node on PATH.
export PATH="${NODE%/*}:$PATH"

log() { printf '[%s] %s\n' "${0##*/}" "$*"; }
die() {
  printf '[%s] ERROR: %s\n' "${0##*/}" "$*" >&2
  exit 1
}

# Read one KEY=value from the env file without sourcing it (values may contain
# shell metacharacters). Values must be unquoted, as in .env.example.
envval() {
  local line
  line=$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1) || true
  printf '%s' "${line#*=}"
}

# Run the backup helper with the app's credentials (node parses the env file).
tool() { "$NODE" --env-file="$ENV_FILE" "$APP_DIR/deploy/backup-tool.mjs" "$@"; }

# Optional dead-man's-switch ping (e.g. Healthchecks.io). $1 = URL, $2 = suffix ("", "/fail", "/start").
ping_url() {
  [[ -n $1 ]] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "$1$2" || log "health ping to monitor failed (ignored)"
}

# Wait until /health answers, using the app's own port.
wait_healthy() {
  local port url i
  port=$(envval PORT)
  url="http://127.0.0.1:${port:-3000}/health"
  for i in $(seq 1 30); do
    if curl -fsS -m 5 "$url" >/dev/null 2>&1; then
      log "healthy: $(curl -fsS -m 5 "$url")"
      return 0
    fi
    sleep 2
  done
  journalctl -u slop-or-not -n 30 --no-pager >&2 || true
  die "app did not become healthy at $url (attempt $i)"
}
