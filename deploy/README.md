# Private HTTPS SyncKv deployment

This deployment follows the conventions in `~/projects/vps`: pyinfra manages a
non-root systemd service, replaceable files live in `/srv/apps`, persistent state
lives in `/srv/data`, and Restic receives an application-prepared snapshot.

SyncKv listens only on `127.0.0.1:8787`. Tailscale Serve terminates trusted HTTPS and
makes it available only inside the tailnet at:

```text
https://racknerd-vps.tail8692b.ts.net
```

There is no SyncKv Caddy fragment, public DNS route, Funnel, or non-loopback
application listener. No UFW application-port exception is required.

## Deploy

```sh
cp deploy/.env.example deploy/.env
# Review VPS_HOST and TARGET_ARCH.
chmod 600 deploy/.env
./deploy.sh
```

`deploy.sh` performs clean local npm builds, builds a static Linux Go binary, and then
runs the VPS project's pyinfra installation. Optional variables are `VPS_PROJECT`,
`PYINFRA`, `VPS_SSH_USER`, `VPS_SSH_KEY`, `VPS_SSH_PORT`, `SERVICE_PORT`,
`TARGET_ARCH` (`amd64` or `arm64`), and `MAX_BLOB_BYTES`.

The deployment discovers the node's current `*.ts.net` name instead of embedding it
in configuration. It configures `tailscale serve`, sets CORS to that exact HTTPS
origin, and refuses a non-Tailscale address or name.

The remote layout is:

```text
/srv/apps/synckv/synckv          replaceable binary
/srv/apps/synckv/admin/dist      replaceable admin bundle
/srv/data/synckv/synckv.sqlite  persistent JSON/blob data
/etc/synckv/synckv.env          generated loopback configuration
```

Verification checks the loopback-only socket, local health, private HTTPS health,
Serve's proxy target, disabled Funnel status, and the absence of a Caddy route.
Consider a Tailscale ACL restricting this node's HTTPS endpoint to the users/devices
that need SyncKv. SyncKv itself intentionally has no authentication.

## Operations

```sh
ssh deploy@racknerd-vps 'sudo systemctl status synckv'
ssh deploy@racknerd-vps 'sudo journalctl -u synckv -f'
ssh deploy@racknerd-vps 'sudo tailscale serve status'
curl https://racknerd-vps.tail8692b.ts.net/health
```

Open `https://racknerd-vps.tail8692b.ts.net/admin/` from a tailnet-connected browser.

## Backups and restore

The Restic hook briefly stops SyncKv, archives all of `/srv/data/synckv`, atomically
places the archive at `/srv/backups/synckv/synckv-data.tar.gz`, and starts the service
again. Stopping avoids copying SQLite and its WAL in an inconsistent state.

To restore, deploy a compatible SyncKv binary, stop `synckv.service`, replace the
contents of `/srv/data/synckv` from the prepared archive, restore ownership to
`synckv:synckv`, and start the service.

## Remove

Removal disables the Tailscale Serve HTTPS route and systemd unit while preserving
persistent data and prepared backups:

```sh
VPS_HOST=racknerd-vps \
  ~/projects/vps/.venv/bin/pyinfra deploy/inventory.py deploy/destroy.py
```
