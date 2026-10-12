# Deploying Slop or Not on Oracle Cloud Always Free

This runbook covers running the app on one Oracle Cloud Infrastructure (OCI) **Always Free** Ampere A1 (ARM64) VM, with a Cloudflare Tunnel for HTTPS. Images stay in Cloudflare R2, AI runs on Cloudflare Workers AI, and SQLite backups go to R2.

**Goal: the project costs $0.** The OCI account must stay on Always Free. Never upgrade it to Pay-As-You-Go. See the [$0 checklist](#0-checklist).

Oracle may reclaim idle Always Free instances, so plan on the VM disappearing at some point. Daily backups, uptime alerts and a [rebuild procedure](#rebuild-after-reclamation-or-loss) (one command plus a restore) are part of the deployment, not extras.

```
guests ──HTTPS──> Cloudflare edge ──(outbound tunnel)── cloudflared ──> 127.0.0.1:3000 node (systemd)
                                                                              │
                                     /data (block volume): game.sqlite + WAL ─┘──> R2 slop/    (images)
                                     daily backup.sh ─────────────────────────────> R2 backups/ (SQLite)
```

Files in `deploy/`:

| File | Purpose |
|---|---|
| `cloud-init.yaml` | VM user-data: clones the repo and runs `setup.sh`. Contains no secrets |
| `setup.sh` | Idempotent root provisioning: packages, Node 24, the `slop` user, `/data` volume, journald, auto-updates, firewall check, cloudflared, systemd units |
| `deploy.sh` | First deploy and every update: check out a ref, `npm ci`, pre-deploy snapshot, restart, health check |
| `backup.sh` / `restore.sh` / `backup-tool.mjs` | SQLite online backup to R2 with retention; restore and restore drill |
| `logwatch.sh` | Alerts on recurring `*_failure` log events; also a "VM is alive" heartbeat |
| `systemd/` | App unit, tunnel unit, backup and logwatch timers |
| `app.env.example`, `tunnel.env.example` | Templates for `/etc/slop-or-not/*.env`. Never commit real values |

### Why systemd instead of Docker

Both would work. The repo's `Dockerfile` plus `--restart=always` is a valid alternative. systemd was chosen because:

- **Less to install and patch.** There is no container engine. Oracle Linux would also need podman/Docker setup.
- **Less memory and disk** on a small free VM.
- **Simple native modules.** `sharp` installs its prebuilt `linux-arm64` binary straight from `package-lock.json`, with no multi-arch image build.
- **Backups and restores touch files directly.** `backup.sh`/`restore.sh` act on `/data/game.sqlite` without `docker exec` or volume indirection.
- **journald gives logs for free**, with size caps and `journalctl` filtering.
- **`Restart=always` with `StartLimitIntervalSec=0` never gives up.** The 1 s job poller and the 60 s cleanup loop must stay alive. systemd hardening (`ProtectSystem=strict`, write access to `/data` only, no capabilities) gives container-like isolation.

## Oracle signup notes

- **Home region is permanent.** It can't be changed after signup, and Always Free compute only runs there. Choose a region where A1 capacity is actually available, preferably one close to you or your guests.
  - Popular regions often report "Out of capacity" for `VM.Standard.A1.Flex`.
  - If that happens, retry at a different time of day, or try another availability domain in the same region.
- **A card is required for identity verification.** Oracle may place a temporary authorization hold on it. A Free Tier account cannot be charged unless you upgrade it.
- **Don't upgrade to Pay-As-You-Go**, even if the console nudges you, for example to get capacity or remove the idle-reclamation policy. That puts the card in play for anything that exceeds Always Free limits.
- **The Always Free A1 allowance for Always Free tenancies is currently 1,500 OCPU-hours and 9,000 GB-hours per month, equivalent to 2 OCPU / 12 GB.** That is less than the older, widely quoted 4 OCPU / 24 GB. Check the [current limits](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) before sizing.
- **The 30-day trial credit ends.** Anything created outside Always Free during the trial is then stopped or deleted. Create only resources labelled "Always Free-eligible".

### Idle reclamation (why rebuilds must be fast)

Oracle considers an Always Free instance **idle** when, over 7 days, all of the following hold, and may then reclaim it:

- 95th-percentile CPU utilization is below 20%.
- Network utilization is below 20%.
- Memory utilization is below 20% (A1 shapes only).

This app is mostly idle, so assume it qualifies. The docs don't promise advance notice or say exactly what reclamation does to attached volumes. Treat the instance, and possibly its volumes, as disposable. R2 backups are the source of truth for recovery.

Because all three conditions must be true, a shape with **less memory** raises the memory-utilization percentage, which may keep the VM from counting as idle. Watch it in **Compute → Instance → Metrics → Memory Utilization**. Don't rely on it, and don't run synthetic load to dodge the policy; the mitigation is backups plus a fast rebuild.

## VM shape and storage sizing

| Resource | Choice | Notes |
|---|---|---|
| Shape | `VM.Standard.A1.Flex`, **1 OCPU, 2–4 GB RAM** | Plenty for one owner plus invited guests; sharp normalises one ≤10 MB upload at a time. Start at 2 GB, then resize if needed (flex shapes resize with a reboot). Stays well inside 2 OCPU / 12 GB |
| Image | Canonical Ubuntu 24.04 (aarch64) *or* Oracle Linux 9 (aarch64) | `setup.sh` handles both (apt/dnf). Ubuntu is the primary target |
| Boot volume | Default (~47 GB) | Counts toward the 200 GB Always Free block-storage total |
| Block volume | **50 GB**, attached as **paravirtualized**, device path `/dev/oracleoci/oraclevdb` | Mounted at `/data` (`DATA_DIR=/data`). Keeping data off the boot volume means a rebuilt VM can re-attach it if it survived. Boot + block stay under 200 GB |
| Network | VCN with a public subnet and a public IPv4 | Ingress security list: **TCP 22 only**, ideally restricted to your IP. With Cloudflare Tunnel, no HTTP(S) ingress is needed |

Don't create volume backup policies beyond the 5 free volume backups. R2 backups are the plan.

## HTTPS: Cloudflare Tunnel (preferred)

`cloudflared` runs as `slop-or-not-tunnel.service` and opens an **outbound-only** connection to Cloudflare. No inbound ports are opened, the VM's IP isn't exposed, and TLS certificates are handled by Cloudflare. The app listens on `127.0.0.1:3000` only.

**A named tunnel needs a domain whose DNS is on Cloudflare.** The app needs a stable `APP_ORIGIN`, because it rejects non-GET requests whose `Origin` header doesn't match exactly. Options:

| Option | Cost | Notes |
|---|---|---|
| Domain you already own, moved to Cloudflare DNS (free plan) | $0 | Best if you have one |
| [EU.org](https://nic.eu.org/) free domain (e.g. `slop.eu.org`) with Cloudflare nameservers | $0 | Long-standing nonprofit. Manual approval can take days to weeks |
| [DigitalPlat FreeDomain](https://domain.digitalplat.org/) (`*.dpdns.org`, `*.qzz.io`, …) with Cloudflare nameservers | $0 | Fast. Some of its suffixes have been suspended for abuse in the past, so check status before relying on it |
| Buy a domain (e.g. via Cloudflare Registrar, sold at cost) | ≈ $10/yr for `.com` | Most reliable, but **not $0**. Only with explicit owner approval |
| Quick tunnel (`*.trycloudflare.com`) | $0 | **Not usable.** The hostname is random and changes on every restart, which breaks `APP_ORIGIN` and cookies. It's also documented for testing only |

Before choosing a free domain, confirm that Cloudflare accepts it as a zone on the Free plan. It must be a registrable domain, because subdomain zones need Enterprise. Recommended order: a domain you already own, then EU.org, then DigitalPlat. If none of these work out, use the [Caddy alternative](#alternative-caddy--free-dynamic-dns-subdomain) with a free DuckDNS name.

Setup (Cloudflare dashboard → **Zero Trust → Networks → Tunnels**):

1. Create a tunnel (type *Cloudflared*) named `slop-or-not`, and copy its **token**.
2. Add a public hostname, e.g. `slop.example.com` → service `http://127.0.0.1:3000`.
3. On the VM, put the token in `/etc/slop-or-not/tunnel.env` (template: `deploy/tunnel.env.example`; root, mode 0600). Then:

   ```sh
   sudo systemctl enable --now slop-or-not-tunnel
   ```

   The token is passed through the environment file, not on the command line, so it doesn't appear in `ps`.

The tunnel service does **not** use `cloudflared service install`. That would embed the token in a generated unit file.

### Alternative: Caddy + free dynamic-DNS subdomain

If no Cloudflare-hosted domain is available, use [Caddy](https://caddyserver.com/), which fetches Let's Encrypt certificates automatically. Pair it with a free hostname such as `yourname.duckdns.org` from [DuckDNS](https://www.duckdns.org/) pointing at the VM's public IP; this costs $0. In outline:

1. Open TCP 80 and 443 in the VCN security list **and** on the host.
   - On Ubuntu, insert `ACCEPT` rules above Oracle's `REJECT` rule with `iptables -I INPUT ...`, then run `netfilter-persistent save`. Don't use ufw on Oracle's Ubuntu images.
   - On Oracle Linux, run `firewall-cmd --permanent --add-service={http,https}`.
2. Install Caddy from its apt/dnf repository and use a two-line `/etc/caddy/Caddyfile`:

   ```
   yourname.duckdns.org
   reverse_proxy 127.0.0.1:3000
   ```

3. Set `APP_ORIGIN=https://yourname.duckdns.org`.

Trade-offs: inbound ports are exposed, the VM's IP is public, and there is one more service to patch. Don't stop `slop-or-not-tunnel`; with no `tunnel.env` it simply isn't enabled.

## First deploy

1. **Create the instance** (console → Compute → Instances → Create):
   - Choose the shape, image and networking from the table above, and add your SSH public key.
   - Paste `deploy/cloud-init.yaml` under *Advanced options → Management → Initialization script*.
2. **Create and attach the block volume**: Block Storage → Create (50 GB, same availability domain). Then on the instance: *Attached block volumes → Attach*, choosing **Paravirtualized** and device path **`/dev/oracleoci/oraclevdb`**. Do this within about 15 minutes of launch; cloud-init waits for the device.
   - If you are late, just re-run `sudo /opt/slop-or-not/app/deploy/setup.sh` after attaching.
   - An empty volume is formatted ext4. A volume that already has a filesystem is **never** reformatted.
   If cloud-init wasn't pasted, bootstrap by hand:

   ```sh
   sudo git clone https://github.com/vapor47/slop-or-not.git /opt/slop-or-not/app
   sudo /opt/slop-or-not/app/deploy/setup.sh
   ```
3. **Watch provisioning**: `ssh ubuntu@<ip>` (`opc@<ip>` on Oracle Linux), then `sudo tail -f /var/log/slop-or-not-setup.log` until "setup finished". Check `findmnt /data`.
4. **Install secrets.** On your machine, generate the owner hash with `npm run password`. Fill in a copy of `deploy/app.env.example` (`APP_ORIGIN` must be the public `https://` hostname; R2 and Workers AI credentials as in the README), then:

   ```sh
   scp app.env ubuntu@<ip>:/tmp/app.env
   ssh ubuntu@<ip> 'sudo install -m 0640 -o root -g slop /tmp/app.env /etc/slop-or-not/app.env && rm /tmp/app.env'
   ```

   Add `/etc/slop-or-not/tunnel.env` the same way (`-m 0600 -o root -g root`).
5. **Deploy**: `sudo /opt/slop-or-not/app/deploy/setup.sh` (installs and enables the units now that the env files exist), then `sudo /opt/slop-or-not/app/deploy/deploy.sh`.
6. **Verify**:
   - `curl -s https://slop.example.com/health` should return `{"status":"ok","generationConfigured":true,"storageConfigured":true}`.
   - Log in as owner.
   - Run `sudo -u slop /opt/slop-or-not/app/deploy/backup.sh` once, then `sudo /opt/slop-or-not/app/deploy/restore.sh list`.
7. **Set up monitoring** (see [Health and alerting](#health-and-alerting)), then **do a restore drill**.

## Updates and redeploys

```sh
sudo /opt/slop-or-not/app/deploy/deploy.sh            # latest origin/main
sudo /opt/slop-or-not/app/deploy/deploy.sh <sha|tag>  # a specific version
```

`deploy.sh` does the following, in order:

1. Fetches the code and checks out the ref (detached HEAD).
2. Reinstalls the systemd units from that commit.
3. Runs `npm ci --omit=dev` and checks that sharp loads.
4. Writes `GIT_SHA` to `/etc/slop-or-not/version.env` for generation-run attribution. The app user can't run `git` on the root-owned checkout.
5. Takes a local pre-deploy snapshot to `/data/pre-deploy/` (newest 5 kept, no R2 operations).
6. Restarts the app and waits for `/health`. It logs the previous commit, so rollback is `deploy.sh <previous-sha>`.

Database migrations run on app start. If one must be undone, restore the pre-deploy snapshot with `restore.sh /data/pre-deploy/game-<ts>.sqlite.gz`.

**OS and runtime updates:**

- Security updates install automatically: unattended-upgrades on Ubuntu, including cloudflared from Cloudflare's repo, with a reboot at 04:30 when needed. On Oracle Linux, `dnf-automatic` applies security updates.
- Node.js is installed from the official tarball and is not auto-updated. Re-run `setup.sh` (for example monthly) to move to the latest Node 24.x; it restarts the app when the version changes.

## Backups

- **What**: `backup.sh` runs from `slop-or-not-backup.timer` daily at about 03:15, catching up after downtime. It runs as the `slop` user and:
  1. Takes a consistent copy of the live database with SQLite's **online backup API** (`node:sqlite` `backup()`), including data still in the WAL, while the app keeps running.
  2. Runs `PRAGMA integrity_check` and counts rows.
  3. Gzips the copy and uploads it to `s3://$S3_BUCKET/backups/game-<UTC>.sqlite.gz`.
  4. Deletes all but the newest `BACKUP_KEEP` (default 14).
- **Prefix**: `backups/` is outside `slop/`, so the 15-day `slop/` lifecycle rule doesn't touch it. **Don't add a lifecycle rule on `backups/`.** If backups ever stop, it would eventually delete every copy. Retention is handled by `prune`, which never keeps fewer than 3.
- **Safety**: The app unit and `backup.sh` refuse to run unless `/data/.slop-or-not-volume` exists. Without this, a failed volume mount could create an empty database, and its backups would push good copies out of retention.
- **Alert**: set `BACKUP_HEALTHCHECK_URL` to a [Healthchecks.io](https://healthchecks.io/) check (free Hobbyist plan) with a 1-day period and a few hours' grace. Success pings it; failure pings `/fail`; a missed run alerts on its own.
- **Separate credentials** (optional): `BACKUP_S3_*` lets backups use an R2 token scoped to the same bucket. Otherwise they reuse `S3_*`.

### Expected R2 usage

| Item | Per day | Per month | Free allowance |
|---|---|---|---|
| Class A (PutObject + ListObjectsV2 + DeleteObject) | ~3 | ~100 | 1,000,000 |
| Class B (GetObject) | 0 (only on restore/drill) | a handful | 10,000,000 |
| Stored bytes | — | `BACKUP_KEEP` × compressed DB size (e.g. 14 × 5 MB = 70 MB) | 10 GB (shared with images) |

The database grows over time because analytics are kept indefinitely. Check `restore.sh list` occasionally and lower `BACKUP_KEEP` if backups approach a meaningful share of the 10 GB.

> **TODO (Phase G quota ledger):** backup R2 operations are **not yet counted** by the app's quota gate (it is being built separately). Once it lands, route `backup-tool.mjs` uploads, lists, deletes and fetches through it, and count backup bytes against the stored-bytes cap. The TODO is marked `TODO(phase-g-quota)` in `deploy/backup-tool.mjs` and `deploy/backup.sh`.

### Restore

```sh
sudo /opt/slop-or-not/app/deploy/restore.sh list                    # available backups
sudo /opt/slop-or-not/app/deploy/restore.sh latest                  # newest R2 backup -> /data
sudo /opt/slop-or-not/app/deploy/restore.sh backups/game-20261012T031500Z.sqlite.gz
sudo /opt/slop-or-not/app/deploy/restore.sh /data/pre-deploy/game-<ts>.sqlite.gz
```

A live restore runs these steps:

1. Downloads the backup and verifies it (integrity check plus row counts).
2. Stops the app.
3. Moves the current `game.sqlite`, `-wal` and `-shm` to `/data/pre-restore-<ts>/`. Nothing is deleted.
4. Installs the backup, owned by `slop`.
5. Starts the app and waits for `/health`.

Delete the `pre-restore-*` directory once you're satisfied.

Images are not in the backup; they live in R2 under `slop/` and expire within 15 days anyway. Games whose images expired between the backup and the restore are cleaned up by the app's normal expiry.

### Restore drill (monthly, and after any backup change)

1. `sudo /opt/slop-or-not/app/deploy/restore.sh latest --to /tmp/drill`. This downloads the newest backup, runs `integrity_check` and prints per-table row counts; production is untouched.
2. Compare the counts with production:

   ```sh
   sudo -u slop sqlite3 /data/game.sqlite 'select count(*) from games'
   ```

   Expect at most a day's difference.
3. Check the backup's age in `restore.sh list`; it should be under about 26 h.
4. `sudo rm -rf /tmp/drill`.
5. Once per quarter, run a full drill on a throwaway VM. Follow the [rebuild procedure](#rebuild-after-reclamation-or-loss) and point `APP_ORIGIN`/the tunnel hostname at a test name. The drill VM must not touch production resources, so give it a modified `app.env`:
   - `DESCRIPTOR_TERMS_ACCEPTED=false`, so it spends no shared Workers AI neurons on pending jobs.
   - An empty `S3_BUCKET`, with the R2 credentials and bucket only in `BACKUP_S3_*`. `restore.sh` still works, but the app runs with no image store, so its cleanup never deletes production `slop/` images.
   - **After the last `setup.sh` run** (it re-enables the timer), stop its backups so it never uploads into the production prefix:

     ```sh
     sudo systemctl disable --now slop-or-not-backup.timer
     ```

   Terminate the drill VM and its volumes afterwards.

## Health and alerting

| What | Free tool | Setup |
|---|---|---|
| Site up, end to end (Cloudflare → tunnel → app) | [UptimeRobot](https://uptimerobot.com/) free: 50 monitors, 5-minute interval | **Keyword** monitor on `https://slop.example.com/health`, keyword `"status":"ok"`, email alert. Free plan is for non-commercial use only; this project qualifies |
| VM alive and logs clean | [Healthchecks.io](https://healthchecks.io/) free plan | Check with a 15-minute period and 30-minute grace; set `LOGWATCH_HEALTHCHECK_URL`. `logwatch.sh` pings every 15 minutes, or pings `/fail` when the last hour has `LOGWATCH_THRESHOLD`+ `worker_failure`, `cleanup_failure`, `processing_failure`, `metrics_failure` or `request_failure` events, 3+ restarts, or the app is down |
| Backups ran | Healthchecks.io | `BACKUP_HEALTHCHECK_URL`, 1-day period |

The free-plan limits above were checked in October 2026; verify them when you sign up. If UptimeRobot alerts while Healthchecks.io is quiet, the problem is in front of the VM (tunnel, DNS, Cloudflare). If both alert, the VM is down or reclaimed, so [rebuild](#rebuild-after-reclamation-or-loss).

Logs:

```sh
journalctl -u slop-or-not -f                        # live
journalctl -u slop-or-not --since today | grep '"event":'
journalctl -u slop-or-not-backup -n 50
```

journald is persistent, capped at 500 MB, and keeps one month of logs.

## Rebuild after reclamation (or loss)

Target: about 15 minutes, **one command plus a restore**.

1. Launch a new instance exactly as in [First deploy](#first-deploy) step 1, using the same cloud-init. That one action provisions everything.
2. **Volume**:
   - If the old block volume still exists (Block Storage → Block volumes), attach it to the new instance at `/dev/oracleoci/oraclevdb`. It is mounted as-is (never reformatted) and re-owned to the new `slop` user.
   - Otherwise create and attach a fresh 50 GB volume.
3. Copy `app.env` and `tunnel.env` back as in step 4. Keep an encrypted copy of both somewhere safe off the VM, for example a password manager.
4. If the old volume was **lost**, restore from R2:

   ```sh
   sudo /opt/slop-or-not/app/deploy/setup.sh
   sudo /opt/slop-or-not/app/deploy/restore.sh latest
   ```

   If the old volume **survived**, skip the restore; the database is already there.
5. Run `sudo /opt/slop-or-not/app/deploy/deploy.sh`.
6. Nothing changes in DNS or the tunnel. The tunnel token identifies the tunnel, not the VM. Check UptimeRobot and Healthchecks.io go green, then terminate the old instance if it still exists, and delete it along with its boot volume so it doesn't count against the 200 GB.

Data loss is bounded by the backup interval (≤ 24 h). Images newer than the backup remain in R2 under `slop/` but are unreferenced; the `slop/` lifecycle rule deletes them within 15 days.

## $0 checklist

Go through this list at setup and monthly:

**Oracle**
- [ ] Account is **Free Tier / Always Free**. Billing → Upgrade and Manage Payment must not show Pay-As-You-Go; never click upgrade.
- [ ] Only Always Free-eligible resources:
  - one `VM.Standard.A1.Flex` within **2 OCPU / 12 GB total**;
  - boot + block volumes **≤ 200 GB total**;
  - **≤ 5** volume backups;
  - no other shapes (apart from the Always Free `VM.Standard.E2.1.Micro`), no GPUs;
  - no paid load balancer (only the 10 Mbps flexible LB is free, and this setup needs none);
  - no paid object storage tier.
- [ ] No leftovers after a rebuild: terminated instances, orphaned boot volumes, reserved public IPs beyond the free one.
- [ ] Budget alert: Billing → Budgets → create a **$1** budget with an email alert at 1% / 100% actual spend. It is free and catches mistakes.
- [ ] Home region and availability domain unchanged; no resources created in other regions.

**Cloudflare**
- [ ] Workers on the **Free** plan, so Workers AI errors at the daily neuron cap instead of billing. R2 has a payment method on file, so its overages *are* billable; keep the `slop/` lifecycle rule and the backup retention (`BACKUP_KEEP`).
- [ ] Zero Trust on the **Free** plan; a Tunnel needs nothing paid.
- [ ] Billing notifications enabled for usage-based billing.
- [ ] Domain: $0 option chosen (owned, EU.org or DigitalPlat). A registrar renewal only with explicit approval.

**Monitoring**: UptimeRobot and Healthchecks.io on free plans; no paid add-ons.

## Troubleshooting

| Symptom | Check |
|---|---|
| App won't start, `ExecStartPre` fails | `/data` isn't mounted or provisioned. Run `findmnt /data`, attach the volume, re-run `setup.sh` |
| `Production requires OWNER_PASSWORD_HASH and an HTTPS APP_ORIGIN` | Fix `/etc/slop-or-not/app.env` |
| Owner actions fail with 403 "Request origin is not allowed" | `APP_ORIGIN` doesn't exactly match the public hostname (scheme, host, no trailing slash) |
| 502/1033 from Cloudflare | `systemctl status slop-or-not-tunnel`; check the public hostname maps to `http://127.0.0.1:3000` |
| `npm ci` builds sharp from source or sharp fails to load | Re-run `setup.sh` (build tools); confirm `uname -m` is `aarch64` and the lockfile includes `@img/sharp-linux-arm64` |
| Backup failed | `journalctl -u slop-or-not-backup -n 50`; check `S3_*`/`BACKUP_S3_*` and that the token can list the bucket |
