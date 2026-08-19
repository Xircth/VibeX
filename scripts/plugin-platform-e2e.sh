#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

echo "== plugin-cli templates =="
pnpm --filter @vibex/plugin-cli exec node -e "import('./dist/cli.js')" >/dev/null 2>&1 || true
pnpm --filter @vibex/plugin-cli test

echo "== official package inspect =="
cargo test -p plugins bundled --offline -- --test-threads=2

echo "== Isolated + official MCP =="
cargo test -p plugins isolated_spawn official_mcp --offline -- --test-threads=1

echo "== toolchain =="
pnpm --filter @vibex/plugin-cli exec node dist/cli.js toolchain | grep -q hostVersion

echo "== protocol fixture =="
test -f packages/plugin-contract/fixtures/protocol/initialize-activate-ping.jsonl
test -f packages/plugin-contract/isolated/node.darwin.syscalls
test -f assets/plugins/index/official.v1.json

echo "plugin-platform e2e gate passed"
