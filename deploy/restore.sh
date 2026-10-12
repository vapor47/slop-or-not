#!/usr/bin/env bash
# Restore the SQLite database from an R2 backup (or a local .sqlite.gz file).
#
#   sudo restore.sh list                       # show available backups
#   sudo restore.sh latest                     # restore newest backup into /data
#   sudo restore.sh backups/game-...sqlite.gz  # restore a specific key
#   sudo restore.sh ./game-....sqlite.gz       # restore a local file
#   sudo restore.sh latest --to /tmp/drill     # drill: download + verify only, prod untouched
#
# A live restore stops the app, moves the current database and its -wal/-shm
# aside to /data/pre-restore-<timestamp>/, installs the backup, and restarts.
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"

[[ $EUID -eq 0 ]] || die 'run as root (sudo).'
src=${1:?usage: restore.sh list|latest|<key>|<file.sqlite.gz> [--to DIR]}
[[ -f $ENV_FILE ]] || die "$ENV_FILE missing: install it first (credentials are needed to reach R2)."
APP_USER=$(stat -c %U "$DATA_DIR" 2>/dev/null || echo slop)

# On a rebuilt VM the restore may run before the first deploy: install deps.
if [[ ! -d $APP_DIR/node_modules/@aws-sdk/client-s3 ]]; then
  log 'installing production dependencies'
  (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
fi

if [[ $src == list ]]; then
  tool list
  exit 0
fi

target=$DATA_DIR
if [[ ${2:-} == --to ]]; then
  target=${3:?--to needs a directory}
  mkdir -p "$target"
fi

work=$(mktemp -d)
chmod 0755 "$work"
trap 'rm -rf "$work"' EXIT
if [[ -f $src ]]; then
  cp "$src" "$work/backup.sqlite.gz"
else
  tool fetch "$src" "$work/backup.sqlite.gz"
fi
tool verify "$work/backup.sqlite.gz"
gunzip -c "$work/backup.sqlite.gz" >"$work/game.sqlite"

if [[ $target != "$DATA_DIR" ]]; then
  install -m 0640 "$work/game.sqlite" "$target/game.sqlite"
  log "drill: verified copy written to $target/game.sqlite (production untouched)"
  exit 0
fi

[[ -f $MARKER ]] || die "$DATA_DIR is not the provisioned volume (no marker). Run deploy/setup.sh first."
# Never move the database while the app might still be writing it.
if systemctl cat slop-or-not.service >/dev/null 2>&1; then
  systemctl stop slop-or-not || die 'could not stop slop-or-not; database left untouched.'
  state=$(systemctl is-active slop-or-not || true)
  [[ $state == inactive || $state == failed ]] ||
    die "slop-or-not is still '$state' after stop; database left untouched."
else
  log 'slop-or-not.service not installed (first-time recovery); nothing to stop.'
fi
if pgrep -u "$APP_USER" -f 'src/main.ts' >/dev/null; then
  die "an app process is still running as $APP_USER; database left untouched."
fi
if compgen -G "$DB*" >/dev/null; then
  aside="$DATA_DIR/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$aside"
  mv "$DB"* "$aside"/
  log "previous database moved to $aside (delete it once the restore is confirmed)"
fi
install -m 0640 -o "$APP_USER" -g "$APP_USER" "$work/game.sqlite" "$DB"
if [[ -f /etc/systemd/system/slop-or-not.service ]]; then
  systemctl enable --now slop-or-not
  wait_healthy
fi
log 'restore complete'
