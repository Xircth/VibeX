#!/usr/bin/env bash
set -euo pipefail

executable="${1:?usage: smoke-linux-desktop.sh <executable>}"
if [[ ! -x "$executable" ]]; then
  echo "Desktop executable is missing or not executable: $executable" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace="$(cd "$script_dir/.." && pwd)"
executable_dir="$(cd "$(dirname "$executable")" && pwd)"
cef_runtime="$workspace/target/cef-runtime/linux"
export LD_LIBRARY_PATH="${cef_runtime}:${executable_dir}:${workspace}/target/release${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"

log_file="${RUNNER_TEMP:-/tmp}/vibex-linux-startup.log"
set +e
GDK_BACKEND=wayland timeout --signal=TERM 10s xvfb-run -a "$executable" >"$log_file" 2>&1
exit_code=$?
set -e

if [[ "$exit_code" -ne 124 && "$exit_code" -ne 143 ]]; then
  cat "$log_file"
  echo "VibeX exited during the Linux XWayland startup smoke test (code $exit_code)." >&2
  exit 1
fi

