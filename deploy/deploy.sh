#!/usr/bin/env bash
# First deploy and every update: check out a ref, install production deps,
# take a local pre-deploy snapshot, restart, and wait for /health.
#
#   sudo /opt/slop-or-not/app/deploy/deploy.sh          # latest origin/main
#   sudo /opt/slop-or-not/app/deploy/deploy.sh v1.2.3   # a tag, branch or commit
#
# Rollback: re-run with the previous commit (printed below); restore the
# pre-deploy snapshot only if a migration must be undone.
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"

[[ $EUID -eq 0 ]] || die 'run as root (sudo).'
[[ -f $ENV_FILE ]] || die "$ENV_FILE missing: copy deploy/app.env.example there and fill it in."
[[ -f $MARKER ]] || die "$DATA_DIR not provisioned: run deploy/setup.sh (and attach the volume) first."
grep -qE '^APP_ORIGIN=https://' "$ENV_FILE" || die 'APP_ORIGIN in the env file must be the public https:// origin.'

ref=${1:-origin/main}
previous=$(git -C "$APP_DIR" rev-parse HEAD)
git -C "$APP_DIR" fetch --quiet --tags origin
git -C "$APP_DIR" checkout --quiet --detach "$ref"
sha=$(git -C "$APP_DIR" rev-parse HEAD)
log "deploying $sha (previous: $previous)"

# Re-install units in case this commit changed them.
install -m 0644 "$APP_DIR"/deploy/systemd/*.service "$APP_DIR"/deploy/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload

(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
# Fail before restarting if sharp's native arm64 binary did not install.
(cd "$APP_DIR" && "$NODE" --input-type=module -e "import sharp from 'sharp'; console.log('sharp ok, libvips', sharp.versions.vips)")

printf 'GIT_SHA=%s\n' "$sha" >/etc/slop-or-not/version.env

if [[ -f $DB ]]; then
  snapdir=$DATA_DIR/pre-deploy
  install -d -m 0750 -o "$(stat -c %U "$DATA_DIR")" -g "$(stat -c %G "$DATA_DIR")" "$snapdir"
  runuser -u "$(stat -c %U "$DATA_DIR")" -- "$APP_DIR/deploy/backup.sh" --local "$snapdir"
  # Keep the 5 newest local pre-deploy snapshots.
  find "$snapdir" -name 'game-*.sqlite.gz' -printf '%f\n' | sort -r | tail -n +6 |
    while read -r f; do rm -f "$snapdir/$f"; done
fi

systemctl enable slop-or-not
systemctl restart slop-or-not
wait_healthy
log "deployed $sha"
