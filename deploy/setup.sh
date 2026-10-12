#!/usr/bin/env bash
# Idempotent provisioning for a fresh Ubuntu 24.04 or Oracle Linux 9 ARM64 VM
# (Oracle Cloud Always Free, Ampere A1). Safe to re-run at any time: it only
# installs what is missing, never reformats a volume that has a filesystem and
# never overwrites /etc/slop-or-not/app.env.
#
# Usage (as root, from a checkout at $APP_DIR):
#   sudo /opt/slop-or-not/app/deploy/setup.sh
#
# Environment overrides:
#   DATA_DEVICE       block device for /data (default /dev/oracleoci/oraclevdb,
#                     the consistent device path of the first attached volume).
#                     Set to "none" to keep data on the boot volume (not advised).
#   DATA_DEVICE_WAIT  seconds to wait for the device to appear (default 0;
#                     cloud-init uses 900 so a volume attached after launch is picked up).
#   NODE_MAJOR        Node.js major version (default 24).
#   INSTALL_CLOUDFLARED  "true" (default) to install cloudflared from Cloudflare's repo.
set -euo pipefail

APP_USER=${APP_USER:-slop}
APP_ROOT=${APP_ROOT:-/opt/slop-or-not}
APP_DIR=${APP_DIR:-$APP_ROOT/app}
ETC_DIR=/etc/slop-or-not
DATA_DIR=/data
MARKER=$DATA_DIR/.slop-or-not-volume
DATA_DEVICE=${DATA_DEVICE:-/dev/oracleoci/oraclevdb}
DATA_DEVICE_WAIT=${DATA_DEVICE_WAIT:-0}
NODE_MAJOR=${NODE_MAJOR:-24}
INSTALL_CLOUDFLARED=${INSTALL_CLOUDFLARED:-true}

log() { printf '[setup] %s\n' "$*"; }
warn() { printf '[setup] WARNING: %s\n' "$*" >&2; }
die() {
  printf '[setup] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || die 'run as root (sudo).'
[[ -f $APP_DIR/package.json ]] || die "no checkout at $APP_DIR (clone the repo there first)."

if command -v apt-get >/dev/null; then
  PKG=apt
elif command -v dnf >/dev/null; then
  PKG=dnf
else
  die 'unsupported distribution: need apt (Ubuntu) or dnf (Oracle Linux).'
fi

# --- Packages -----------------------------------------------------------------
# build-essential/python3/pkg-config are only a fallback: package-lock.json pins
# sharp's prebuilt @img/sharp-linux-arm64 (glibc) binaries, so npm ci normally
# compiles nothing. They let sharp build from source if a prebuilt is unavailable.
install_packages() {
  log "installing base packages ($PKG)"
  if [[ $PKG == apt ]]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q
    apt-get install -y -q ca-certificates curl git xz-utils build-essential python3 \
      pkg-config sqlite3 unattended-upgrades
  else
    dnf install -y -q ca-certificates curl git xz gcc gcc-c++ make python3 \
      pkgconf-pkg-config sqlite dnf-automatic firewalld
  fi
}

# --- Node.js (official tarball, checksum-verified, distro independent) ----------
install_node() {
  local arch current dist sums file
  case $(uname -m) in
    aarch64 | arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) die "unsupported CPU $(uname -m)" ;;
  esac
  dist="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  sums=$(curl -fsSL "$dist/SHASUMS256.txt")
  file=$(awk -v a="linux-$arch.tar.xz" '$2 ~ a"$" {print $2}' <<<"$sums" | head -n1)
  [[ -n $file ]] || die "could not find a Node $NODE_MAJOR build for linux-$arch"
  local version=${file%-linux-*}
  version=${version#node-}
  current=$(node --version 2>/dev/null || true)
  if [[ $current == "$version" ]]; then
    log "Node $current already installed"
    return
  fi
  log "installing Node $version (was: ${current:-none})"
  local tmp
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/$file" "$dist/$file"
  (cd "$tmp" && grep " $file\$" <<<"$sums" | sha256sum -c --quiet -)
  rm -rf "/opt/node-$version-linux-$arch"
  tar -xJf "$tmp/$file" -C /opt
  rm -rf "$tmp"
  for bin in node npm npx; do
    ln -sfn "/opt/node-$version-linux-$arch/bin/$bin" "/usr/local/bin/$bin"
  done
  # Restart the app (if running) so it picks up the new runtime.
  if systemctl is-active --quiet slop-or-not; then systemctl restart slop-or-not; fi
}

# --- App user -----------------------------------------------------------------
create_user() {
  if ! id "$APP_USER" >/dev/null 2>&1; then
    log "creating system user $APP_USER"
    useradd --system --home-dir /var/lib/slop-or-not --create-home \
      --shell /usr/sbin/nologin "$APP_USER"
  fi
  install -d -m 0750 -o root -g "$APP_USER" "$ETC_DIR"
}

# --- Persistent block volume at /data ------------------------------------------
mount_data() {
  if [[ $DATA_DEVICE == none ]]; then
    warn 'DATA_DEVICE=none: SQLite will live on the boot volume.'
    install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR"
    [[ -f $MARKER ]] || touch "$MARKER"
    return
  fi
  if mountpoint -q "$DATA_DIR"; then
    log "$DATA_DIR already mounted"
  else
    local waited=0
    while [[ ! -b $DATA_DEVICE && $waited -lt $DATA_DEVICE_WAIT ]]; do
      sleep 10
      waited=$((waited + 10))
    done
    if [[ ! -b $DATA_DEVICE ]]; then
      warn "$DATA_DEVICE not found. Attach the block volume (paravirtualized," \
        "device path $DATA_DEVICE) and re-run this script. The app will not start until then."
      return
    fi
    local dev
    dev=$(readlink -f "$DATA_DEVICE")
    # Only format a device with no filesystem signature. Never reformat.
    if ! blkid -p "$dev" >/dev/null 2>&1; then
      log "formatting empty volume $dev as ext4"
      mkfs.ext4 -q -L slopdata "$dev"
    fi
    local uuid
    uuid=$(blkid -s UUID -o value "$dev")
    [[ -n $uuid ]] || die "could not read filesystem UUID of $dev"
    install -d -m 0755 "$DATA_DIR"
    if ! grep -q "UUID=$uuid" /etc/fstab; then
      # _netdev is harmless for paravirtualized volumes and required for iSCSI ones.
      printf 'UUID=%s %s ext4 defaults,nofail,_netdev,noatime 0 2\n' "$uuid" "$DATA_DIR" >>/etc/fstab
      systemctl daemon-reload
    fi
    mount "$DATA_DIR"
    log "mounted $dev at $DATA_DIR"
  fi
  # A volume re-attached to a rebuilt VM may carry another UID; re-own it.
  chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
  chmod 0750 "$DATA_DIR"
  # Marker proves /data is the real volume; the app unit and backup.sh refuse
  # to run without it, so a failed mount can never produce (and back up) an
  # empty database that would push good backups out of retention.
  [[ -f $MARKER ]] || touch "$MARKER"
}

# --- Logs: journald with a size cap ---------------------------------------------
configure_journald() {
  install -d /etc/systemd/journald.conf.d
  cat >/etc/systemd/journald.conf.d/50-slop-or-not.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=500M
MaxRetentionSec=1month
EOF
  systemctl restart systemd-journald
}

# --- Automatic security updates -------------------------------------------------
configure_updates() {
  if [[ $PKG == apt ]]; then
    cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
    cat >/etc/apt/apt.conf.d/52slop-or-not-upgrades <<'EOF'
// Also keep cloudflared current; reboot for kernel updates in a quiet hour.
Unattended-Upgrade::Origins-Pattern { "site=pkg.cloudflare.com"; };
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF
    systemctl enable --now unattended-upgrades.service >/dev/null 2>&1 || true
  else
    local conf=/etc/dnf/automatic.conf
    sed -i -E 's/^upgrade_type *=.*/upgrade_type = security/; s/^apply_updates *=.*/apply_updates = yes/' "$conf"
    systemctl enable --now dnf-automatic.timer
  fi
}

# --- Host firewall: inbound SSH only ---------------------------------------------
# The app binds 127.0.0.1 and cloudflared connects outbound, so nothing but SSH
# needs to be reachable. Keep the VCN security list to TCP 22 as well.
configure_firewall() {
  if [[ $PKG == apt ]]; then
    # Oracle's Ubuntu images ship iptables rules (via netfilter-persistent) that
    # reject all inbound traffic except SSH. Do not enable ufw on these images;
    # Oracle advises against it because it conflicts with those rules.
    if iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT'; then
      log 'iptables: default Oracle rules present (inbound SSH only)'
    else
      warn 'no iptables REJECT rule found on INPUT; verify the host firewall manually.'
    fi
  else
    systemctl enable --now firewalld
    local port
    for port in $(firewall-cmd --permanent --list-ports); do
      warn "closing unexpected open port $port"
      firewall-cmd --permanent --remove-port="$port" >/dev/null
    done
    firewall-cmd --permanent --add-service=ssh >/dev/null
    firewall-cmd --reload >/dev/null
    log "firewalld services: $(firewall-cmd --list-services)"
  fi
}

# --- cloudflared (Cloudflare Tunnel) --------------------------------------------
install_cloudflared() {
  [[ $INSTALL_CLOUDFLARED == true ]] || return 0
  if ! command -v cloudflared >/dev/null; then
    log 'installing cloudflared'
    if [[ $PKG == apt ]]; then
      install -d -m 0755 /usr/share/keyrings
      curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
      echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
        >/etc/apt/sources.list.d/cloudflared.list
      apt-get update -q
      apt-get install -y -q cloudflared
    else
      curl -fsSL https://pkg.cloudflare.com/cloudflared.repo -o /etc/yum.repos.d/cloudflared.repo
      dnf install -y -q cloudflared
    fi
  fi
}

# --- systemd units -------------------------------------------------------------
install_units() {
  local unit
  for unit in "$APP_DIR"/deploy/systemd/*.service "$APP_DIR"/deploy/systemd/*.timer; do
    install -m 0644 "$unit" /etc/systemd/system/
  done
  systemctl daemon-reload
  # Timers are harmless before configuration: backup.sh refuses to run without the
  # provisioned volume and a database, and logwatch only logs without a URL.
  systemctl enable --now slop-or-not-backup.timer slop-or-not-logwatch.timer
  if [[ -f $ETC_DIR/app.env ]]; then
    chown root:"$APP_USER" "$ETC_DIR/app.env"
    chmod 0640 "$ETC_DIR/app.env"
    if [[ -f $MARKER ]]; then
      systemctl enable slop-or-not.service
    else
      warn "not enabling the app: $DATA_DIR is not provisioned yet."
    fi
  else
    warn "$ETC_DIR/app.env missing: copy deploy/app.env.example there, fill it in, then run deploy/deploy.sh."
  fi
  if [[ -f $ETC_DIR/tunnel.env ]]; then
    chmod 0600 "$ETC_DIR/tunnel.env"
    systemctl enable --now slop-or-not-tunnel.service
  else
    log "no $ETC_DIR/tunnel.env yet; tunnel not started (see docs/DEPLOY.md)."
  fi
}

install_packages
install_node
create_user
mount_data
configure_journald
configure_updates
configure_firewall
install_cloudflared
install_units
log "done. Next: $APP_DIR/deploy/deploy.sh (or restore.sh latest on a rebuild)."
