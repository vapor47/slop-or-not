#!/usr/bin/env bash
# Daily SQLite backup to R2: online backup (includes WAL) -> integrity check ->
# gzip -> upload under BACKUP_PREFIX (default backups/) -> keep the newest BACKUP_KEEP.
# Runs from slop-or-not-backup.timer as the app user; safe to run by hand:
#   sudo -u slop /opt/slop-or-not/app/deploy/backup.sh            # snapshot + upload + prune
#   sudo -u slop /opt/slop-or-not/app/deploy/backup.sh --local DIR # snapshot only, no R2 ops
#
# Optional env (in /etc/slop-or-not/app.env): BACKUP_KEEP (default 14),
# BACKUP_PREFIX, BACKUP_S3_* (separate credentials), BACKUP_HEALTHCHECK_URL.
# TODO(phase-g-quota): count these R2 ops/bytes in the app's quota ledger; see backup-tool.mjs.
# -E so the ERR trap (failure ping) also fires inside functions.
set -Eeuo pipefail
# shellcheck source=deploy/lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"

hc=$(envval BACKUP_HEALTHCHECK_URL)
fail() {
  ping_url "$hc" /fail
  die "$@"
}
[[ -f $MARKER ]] || fail "$DATA_DIR is not the provisioned volume (no marker); refusing to back up."
[[ -f $DB ]] || fail "no database at $DB"

if [[ ${1:-} == --local ]]; then
  dir=${2:?usage: backup.sh --local DIR}
  out="$dir/game-$(date -u +%Y%m%dT%H%M%SZ).sqlite.gz"
  tool snapshot "$DB" "$out"
  log "local snapshot: $out"
  exit 0
fi

exec 9>"$DATA_DIR/.backup.lock"
flock -n 9 || die 'another backup is running'

keep=$(envval BACKUP_KEEP)
keep=${keep:-14}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
trap 'ping_url "$hc" /fail' ERR

tool snapshot "$DB" "$work/game.sqlite.gz"
tool upload "$work/game.sqlite.gz"
tool prune "$keep"
ping_url "$hc" ""
log 'backup complete'
