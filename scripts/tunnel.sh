#!/bin/sh
# Expose backchannel to remote callers via a Cloudflare quick tunnel.
set -eu

PORT="${BACKCHANNEL_PORT:-7777}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed." >&2
  echo "Install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)" >&2
  echo "or use tailscale instead:" >&2
  echo "  tailscale funnel ${PORT}" >&2
  exit 1
fi

exec cloudflared tunnel --url "http://127.0.0.1:${PORT}"
