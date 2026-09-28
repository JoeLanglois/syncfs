# Tailnet-only SyncKv deployment

This deployment follows the conventions in `~/projects/vps`: pyinfra manages a
non-root systemd service, replaceable files live in `/srv/apps`, persistent state
lives in `/srv/data`, and Restic receives an application-prepared snapshot.

SyncKv deliberately has no Caddy fragment or public DNS route. The process binds the
VPS's exact Tailscale IPv4 address, never `0.0.0.0`, loopback, or a public address.
Clients use `http://racknerd-vps:8787` while connected to the same tailnet; Tailscale
provides transport encryption.

## One-time firewall configuration

The global VPS provisioner owns UFW. Re-provision the machine with the private port
allowed only on `tailscale0`:

```sh
cd ~/projects/vps
TAILSCALE_TCP_PORTS=8787 VPS_HOST=racknerd-vps ./provision.sh
```

This does not create a public `8787/tcp` rule. The SyncKv deployment refuses to
continue if the interface-scoped rule is absent.

Consider a Tailscale ACL restricting the VPS and port 8787 to the users/devices that
need SyncKv. SyncKv itself intentionally has no authentication.

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

The remote layout is:

```text
/srv/apps/synckv/synckv          replaceable binary
/srv/apps/synckv/admin/dist      replaceable admin bundle
/srv/data/synckv/synckv.sqlite  persistent JSON/blob data
/etc/synckv/synckv.env          generated tailnet-only configuration
```

The deploy verifies the UFW rule, service health through the Tailscale address, the
exact socket binding, and the absence of a Caddy route.

## Operations

```sh
ssh deploy@racknerd-vps 'sudo systemctl status synckv'
ssh deploy@racknerd-vps 'sudo journalctl -u synckv -f'
curl http://racknerd-vps:8787/health
```

Open `http://racknerd-vps:8787/admin/` from a tailnet-connected browser.

## Backups and restore

The Restic hook briefly stops SyncKv, archives all of `/srv/data/synckv`, atomically
places the archive at `/srv/backups/synckv/synckv-data.tar.gz`, and starts the service
again. Stopping avoids copying SQLite and its WAL in an inconsistent state.

To restore, deploy a compatible SyncKv binary, stop `synckv.service`, replace the
contents of `/srv/data/synckv` from the prepared archive, restore ownership to
`synckv:synckv`, and start the service.

## Remove

Removal preserves persistent data and prepared backups:

```sh
VPS_HOST=racknerd-vps \
  ~/projects/vps/.venv/bin/pyinfra deploy/inventory.py deploy/destroy.py
```

Remove port 8787 from `TAILSCALE_TCP_PORTS` during a later global provisioning run if
no other private service uses it. Existing UFW rules are not automatically deleted by
omitting the variable; remove an obsolete rule explicitly and verify access before
changing firewall policy.
