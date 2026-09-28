"""Inventory for the SyncKv service deployment."""

import os

host = os.environ.get("VPS_HOST")
if not host:
    raise RuntimeError("Set VPS_HOST to the VPS Tailscale name or IP address")

host_data = {
    "ssh_user": os.environ.get("VPS_SSH_USER", "deploy"),
    "ssh_port": int(os.environ.get("VPS_SSH_PORT", "22")),
}
if ssh_key := os.environ.get("VPS_SSH_KEY"):
    host_data["ssh_key"] = os.path.expanduser(ssh_key)

hosts = [(host, host_data)]
