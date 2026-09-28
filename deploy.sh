#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$ROOT_DIR/deploy"
VPS_PROJECT="${VPS_PROJECT:-$HOME/projects/vps}"
PYINFRA="${PYINFRA:-$VPS_PROJECT/.venv/bin/pyinfra}"
TARGET_ARCH="${TARGET_ARCH:-amd64}"

if [[ -f "$DEPLOY_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$DEPLOY_DIR/.env"
    set +a
fi
if [[ "$TARGET_ARCH" != amd64 && "$TARGET_ARCH" != arm64 ]]; then
    echo "TARGET_ARCH must be amd64 or arm64" >&2
    exit 1
fi
if [[ ! -x "$PYINFRA" ]]; then
    echo "pyinfra was not found at $PYINFRA; set VPS_PROJECT or PYINFRA" >&2
    exit 1
fi

artifact_dir="$(mktemp -d)"
cleanup() { rm -rf "$artifact_dir"; }
trap cleanup EXIT

cd "$ROOT_DIR"
npm ci
npm run build
npm --prefix server/admin ci
npm --prefix server/admin run build
mkdir -p "$artifact_dir/admin"
cp -a server/admin/dist/. "$artifact_dir/admin/"
(
    cd server
    CGO_ENABLED=0 GOOS=linux GOARCH="$TARGET_ARCH" go build -trimpath -ldflags='-s -w' -o "$artifact_dir/synckv" ./cmd/synckv
)
chmod 0755 "$artifact_dir/synckv"

export DEPLOY_ARTIFACT_DIR="$artifact_dir"
export SERVICE_PORT="${SERVICE_PORT:-8787}"
"$PYINFRA" "$DEPLOY_DIR/inventory.py" "$DEPLOY_DIR/deploy.py" "$@"
