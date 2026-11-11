#!/usr/bin/env bash
set -euo pipefail

LISTEN_PORT="${VIBEX_RELAY_PORT:-17890}"
INSTALL_BIN="/usr/local/bin/vibex-relay-server"
STATE_DIR="/var/lib/vibex-relay"
SERVICE_FILE="/etc/systemd/system/vibex-relay.service"

echo "==> [1/4] Preparing directories and kernel limits..."
sudo mkdir -p "${STATE_DIR}"

if [ -f "Cargo.toml" ] && [ -d "crates/relay-server" ]; then
  echo "==> [2/4] Building vibex-relay-server (release)..."
  cargo build --release -p relay-server --bin vibex-relay-server
  sudo install -m 0755 target/release/vibex-relay-server "${INSTALL_BIN}"
elif [ -f "./vibex-relay-server" ]; then
  echo "==> [2/4] Installing prebuilt vibex-relay-server..."
  sudo install -m 0755 ./vibex-relay-server "${INSTALL_BIN}"
else
  echo "Error: Neither Cargo workspace nor ./vibex-relay-server binary found in current directory." >&2
  exit 1
fi

echo "==> [3/4] Writing systemd unit ${SERVICE_FILE}..."
sudo tee "${SERVICE_FILE}" >/dev/null <<EOF
[Unit]
Description=VibeX Multi-Tenant Cloud Relay & Rendezvous Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${STATE_DIR}
Environment="RUST_LOG=info"
Environment="VIBEX_RELAY_LISTEN=0.0.0.0:${LISTEN_PORT}"
Environment="VIBEX_RELAY_TOKEN_STORE=${STATE_DIR}/tokens.json"
ExecStart=${INSTALL_BIN}
Restart=always
RestartSec=2
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

echo "==> [4/4] Starting and enabling vibex-relay.service..."
sudo systemctl daemon-reload
sudo systemctl enable --now vibex-relay.service
sleep 1
sudo systemctl --no-pager --full status vibex-relay.service

echo ""
echo "✅ VibeX Relay Server is live on 0.0.0.0:${LISTEN_PORT}"
echo "   Health check: curl -s http://127.0.0.1:${LISTEN_PORT}/health"
