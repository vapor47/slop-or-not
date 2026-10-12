#!/usr/bin/env bash
# Every 15 minutes (slop-or-not-logwatch.timer): count structured failure events
# in the last hour of the app journal and report to a dead-man's-switch monitor.
#   - below threshold -> success ping (doubles as a "VM is alive" heartbeat:
#     if Oracle reclaims or stops the instance, the pings stop and you get alerted)
#   - at/above threshold -> /fail ping with a summary
# Configure LOGWATCH_HEALTHCHECK_URL (and optionally LOGWATCH_THRESHOLD, default 5)
# in /etc/slop-or-not/app.env. Without a URL it only logs.
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"

url=$(envval LOGWATCH_HEALTHCHECK_URL)
threshold=$(envval LOGWATCH_THRESHOLD)
threshold=${threshold:-5}
events='worker_failure|cleanup_failure|processing_failure|metrics_failure|request_failure'

summary=$(journalctl -u slop-or-not --since '-1h' -o cat --no-pager 2>/dev/null |
  grep -oE "\"event\":\"($events)\"" | sort | uniq -c | sort -rn || true)
total=$(awk '{s += $1} END {print s + 0}' <<<"$summary")
restarts=$(journalctl -u slop-or-not --since '-1h' -o cat --no-pager 2>/dev/null |
  grep -c 'Scheduled restart job' || true)

if ! systemctl is-active --quiet slop-or-not; then
  log 'app service is not active'
  total=$((total + threshold))
fi
log "last hour: $total failure events, $restarts restarts"
if ((total >= threshold || restarts >= 3)); then
  [[ -z $summary ]] || log "$summary"
  [[ -z $url ]] || curl -fsS -m 10 --retry 3 -o /dev/null --data-raw \
    "failures=$total restarts=$restarts $(tr '\n' ' ' <<<"$summary")" "$url/fail" || true
else
  ping_url "$url" ""
fi
