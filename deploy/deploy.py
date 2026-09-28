"""Deploy SyncKv onto an already-provisioned, Tailscale-connected VPS."""

import io
import ipaddress
import os
from pathlib import Path

from pyinfra import host
from pyinfra.facts.server import Command
from pyinfra.operations import files, server, systemd

SERVICE = "synckv"
SERVICE_USER = "synckv"
PORT = int(os.environ.get("SERVICE_PORT", "8787"))
MAX_BLOB_BYTES = int(os.environ.get("MAX_BLOB_BYTES", str(100 << 20)))
DEPLOY_DIR = Path(__file__).resolve().parent
ARTIFACT_DIR = Path(os.environ.get("DEPLOY_ARTIFACT_DIR", ""))
BINARY = ARTIFACT_DIR / "synckv"
ADMIN_DIST = ARTIFACT_DIR / "admin"
APP_DIR = f"/srv/apps/{SERVICE}"
DATA_DIR = f"/srv/data/{SERVICE}"
BACKUP_DIR = f"/srv/backups/{SERVICE}"
ENV_PATH = f"/etc/{SERVICE}/{SERVICE}.env"

if not 1024 <= PORT <= 65535:
    raise RuntimeError("SERVICE_PORT must be between 1024 and 65535")
if MAX_BLOB_BYTES <= 0:
    raise RuntimeError("MAX_BLOB_BYTES must be positive")
if not BINARY.is_file() or not (ADMIN_DIST / "index.html").is_file():
    raise RuntimeError("Run deploy.sh so the Linux binary and admin bundle are built first")

tailnet_output = host.get_fact(Command, command="tailscale ip -4").strip().splitlines()
if len(tailnet_output) != 1:
    raise RuntimeError("The server must have exactly one Tailscale IPv4 address")
try:
    tailnet_ip = ipaddress.ip_address(tailnet_output[0])
except ValueError as error:
    raise RuntimeError("tailscale ip -4 returned an invalid address") from error
if tailnet_ip.version != 4 or tailnet_ip not in ipaddress.ip_network("100.64.0.0/10"):
    raise RuntimeError("Refusing to deploy: server address is not a Tailscale IPv4 address")
tailnet_address = str(tailnet_ip)

server.shell(
    name="Verify private deployment prerequisites",
    commands=[
        "systemctl is-active tailscaled.service >/dev/null",
        "tailscale status >/dev/null",
        "test -d /etc/restic/paths.d",
        "test -d /etc/restic/hooks.d",
        f"ufw status | grep -Eq '^{PORT}/tcp on tailscale0[[:space:]]+ALLOW'",
        f"test ! -e /etc/caddy/apps/{SERVICE}.caddy",
    ],
    _sudo=True,
)
server.group(name="Create the SyncKv group", group=SERVICE_USER, system=True, _sudo=True)
server.user(
    name="Create the SyncKv user",
    user=SERVICE_USER,
    system=True,
    group=SERVICE_USER,
    shell="/usr/sbin/nologin",
    home=DATA_DIR,
    create_home=False,
    _sudo=True,
)
for directory, owner, group, mode in (
    (APP_DIR, "root", SERVICE_USER, "0750"),
    (DATA_DIR, SERVICE_USER, SERVICE_USER, "0750"),
    (BACKUP_DIR, "root", "root", "0700"),
    (f"/etc/{SERVICE}", "root", SERVICE_USER, "0750"),
):
    files.directory(
        name=f"Create {directory}", path=directory, user=owner, group=group, mode=mode, _sudo=True
    )

binary = files.put(
    name="Deploy the SyncKv Linux binary",
    src=str(BINARY),
    dest=f"{APP_DIR}/synckv",
    user="root",
    group=SERVICE_USER,
    mode="0750",
    _sudo=True,
)
admin = files.sync(
    name="Deploy the built admin panel",
    src=str(ADMIN_DIST),
    dest=f"{APP_DIR}/admin/dist",
    user="root",
    group=SERVICE_USER,
    mode="0640",
    dir_mode="0750",
    delete=True,
    _sudo=True,
)
environment = files.put(
    name="Install the private SyncKv environment",
    src=io.StringIO(
        "\n".join(
            [
                f"HOST={tailnet_address}",
                f"PORT={PORT}",
                "STORAGE_BACKEND=sqlite",
                f"DATABASE_PATH={DATA_DIR}/synckv.sqlite",
                f"ADMIN_ROOT={APP_DIR}/admin/dist",
                f"MAX_BLOB_BYTES={MAX_BLOB_BYTES}",
                "CORS_ORIGIN=*",
                "",
            ]
        )
    ),
    dest=ENV_PATH,
    user="root",
    group=SERVICE_USER,
    mode="0640",
    _sudo=True,
)
unit = files.template(
    name="Install the SyncKv systemd unit",
    src=str(DEPLOY_DIR / "templates" / "synckv.service.j2"),
    dest=f"/etc/systemd/system/{SERVICE}.service",
    user="root",
    group="root",
    mode="0644",
    service=SERVICE,
    service_user=SERVICE_USER,
    app_dir=APP_DIR,
    data_dir=DATA_DIR,
    _sudo=True,
)
systemd.daemon_reload(name="Reload systemd after unit changes", _if=lambda: unit.changed, _sudo=True)
systemd.service(
    name="Restart SyncKv after deployment changes",
    service=f"{SERVICE}.service",
    restarted=True,
    _if=lambda: binary.changed or admin.changed or environment.changed or unit.changed,
    _sudo=True,
)
systemd.service(
    name="Enable and start SyncKv",
    service=f"{SERVICE}.service",
    running=True,
    enabled=True,
    _sudo=True,
)

backup_path = files.template(
    name="Register the SyncKv prepared backup with Restic",
    src=str(DEPLOY_DIR / "templates" / "restic-path.conf.j2"),
    dest=f"/etc/restic/paths.d/{SERVICE}.conf",
    user="root",
    group="root",
    mode="0644",
    backup_dir=BACKUP_DIR,
    _sudo=True,
)
backup_hook = files.template(
    name="Install the consistent SyncKv backup hook",
    src=str(DEPLOY_DIR / "templates" / "prepare-backup.sh.j2"),
    dest=f"/etc/restic/hooks.d/{SERVICE}.sh",
    user="root",
    group="root",
    mode="0750",
    service=SERVICE,
    data_dir=DATA_DIR,
    backup_dir=BACKUP_DIR,
    _sudo=True,
)

server.shell(
    name="Verify the tailnet-only SyncKv deployment",
    commands=[
        f"systemctl is-active {SERVICE}.service",
        (
            "for attempt in $(seq 1 20); do "
            f"curl --noproxy '*' --fail --silent --show-error http://{tailnet_address}:{PORT}/health "
            "&& exit 0; sleep 1; done; exit 1"
        ),
        f"test \"$(ss -H -ltn 'sport = :{PORT}' | wc -l)\" -eq 1",
        f"ss -H -ltn 'sport = :{PORT}' | awk '{{print $4}}' | grep -Fxq '{tailnet_address}:{PORT}'",
        f"! ss -H -ltn 'sport = :{PORT}' | awk '{{print $4}}' | grep -Eq '^(0\\.0\\.0\\.0|127\\.0\\.0\\.1|\\[::\\]|\\*):'",
        f"test ! -e /etc/caddy/apps/{SERVICE}.caddy",
    ],
    _sudo=True,
)
