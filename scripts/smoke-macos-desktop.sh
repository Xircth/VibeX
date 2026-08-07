#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?usage: smoke-macos-desktop.sh <app-bundle>}"
executable="$app_path/Contents/MacOS/vibex"
if [[ ! -x "$executable" ]]; then
  echo "macOS app executable is missing: $executable" >&2
  exit 1
fi

log_file="${RUNNER_TEMP:-/tmp}/vibex-macos-startup.log"
"$executable" >"$log_file" 2>&1 &
app_pid=$!

cleanup() {
  if kill -0 "$app_pid" 2>/dev/null; then
    kill -TERM "$app_pid" 2>/dev/null || true
    for _ in {1..10}; do
      if ! kill -0 "$app_pid" 2>/dev/null; then
        break
      fi
      sleep 0.5
    done
    if kill -0 "$app_pid" 2>/dev/null; then
      kill -KILL "$app_pid" 2>/dev/null || true
    fi
    wait "$app_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

sleep 8
if ! kill -0 "$app_pid" 2>/dev/null; then
  cat "$log_file"
  echo "VibeX exited during the macOS startup smoke test." >&2
  exit 1
fi
