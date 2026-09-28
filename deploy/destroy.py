"""Remove SyncKv while preserving its persistent data and prepared backups."""

import os

from pyinfra.operations import files, server, systemd

SERVICE = "synckv"
UNIT = f"{SERVICE}.service"
PORT = int(os.environ.get("SERVICE_PORT", "8787"))

server.shell(
    name="Remove the private SyncKv Tailscale Serve route",
    commands=(
        f"if tailscale serve status --json | grep -Fq 'http://127.0.0.1:{PORT}'; then "
        "tailscale serve --https=443 off; fi"
    ),
    _sudo=True,
)
systemd.service(
    name="Stop and disable SyncKv",
    service=UNIT,
    running=False,
    enabled=False,
    _sudo=True,
)
unit = files.file(
    name="Remove the SyncKv systemd unit",
    path=f"/etc/systemd/system/{UNIT}",
    present=False,
    _sudo=True,
)
systemd.daemon_reload(name="Reload systemd", _if=lambda: unit.changed, _sudo=True)
files.directory(
    name="Remove replaceable SyncKv application files",
    path=f"/srv/apps/{SERVICE}",
    present=False,
    recursive=True,
    _sudo=True,
)
for path in (
    f"/etc/{SERVICE}/{SERVICE}.env",
    f"/etc/restic/paths.d/{SERVICE}.conf",
    f"/etc/restic/hooks.d/{SERVICE}.sh",
    f"/etc/caddy/apps/{SERVICE}.caddy",
):
    files.file(name=f"Remove {path}", path=path, present=False, _sudo=True)
files.directory(name="Remove the empty SyncKv configuration directory", path=f"/etc/{SERVICE}", present=False, _sudo=True)
server.shell(
    name="Confirm SyncKv persistent data was preserved",
    commands=[
        f"test -d /srv/data/{SERVICE}",
        f"test -d /srv/backups/{SERVICE}",
    ],
    _sudo=True,
)
