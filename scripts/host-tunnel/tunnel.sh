#!/bin/sh
# VibeX public tunnel installer. POSIX sh. Safe to pipe: curl -fsSL https://vibex.xforever.xin/tunnel.sh | sh
set -eu

TOKEN=""
PORT=""
BIND="0.0.0.0"
PY_URL="https://vibex.xforever.xin/tunnel.py"
MODE="install"

usage() {
  echo "usage: sh tunnel.sh -t <token> -p <port> [--bind 0.0.0.0]" >&2
  echo "       sh tunnel.sh status" >&2
  exit 2
}

if [ "${1:-}" = "status" ]; then
  MODE="status"
  shift
fi

while [ "${#}" -gt 0 ]; do
  case "${1}" in
    -t|--token)
      [ "${#}" -ge 2 ] || usage
      TOKEN="${2}"
      shift 2
      ;;
    -p|--port)
      [ "${#}" -ge 2 ] || usage
      PORT="${2}"
      shift 2
      ;;
    --bind)
      [ "${#}" -ge 2 ] || usage
      BIND="${2}"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "unknown argument: ${1}" >&2
      usage
      ;;
  esac
done

if [ "${MODE}" = "install" ]; then
  [ -n "${TOKEN}" ] || usage
  [ -n "${PORT}" ] || usage
  case "${PORT}" in
    *[!0-9]*|"") echo "port must be a number" >&2; exit 2 ;;
  esac
  if [ "${PORT}" -lt 1 ] || [ "${PORT}" -gt 65535 ]; then
    echo "port must be between 1 and 65535" >&2
    exit 2
  fi
  if [ "${PORT}" -lt 1024 ] && [ "$(id -u)" -ne 0 ]; then
    echo "port ${PORT} requires root; rerun with sudo" >&2
    exit 1
  fi
fi

download() {
  url="${1}"
  dest="${2}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "${url}" -o "${dest}"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "${dest}" "${url}"
  else
    echo "need curl or wget" >&2
    exit 1
  fi
}

install_python() {
  if [ "$(id -u)" -ne 0 ]; then
    return 1
  fi
  if command -v apt-get >/dev/null 2>&1; then
    apt-get install -y python3 >/dev/null 2>&1 || {
      apt-get update -y
      apt-get install -y python3
    }
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y python3
  elif command -v yum >/dev/null 2>&1; then
    yum install -y python3
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache python3
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm python
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install python3
  else
    return 1
  fi
}

resolve_python() {
  if command -v python3 >/dev/null 2>&1; then
    command -v python3
    return 0
  fi
  if command -v python >/dev/null 2>&1; then
    if python -c 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)' >/dev/null 2>&1; then
      command -v python
      return 0
    fi
  fi
  if [ "${MODE}" = "status" ]; then
    return 1
  fi
  install_python || true
  if command -v python3 >/dev/null 2>&1; then
    command -v python3
    return 0
  fi
  echo "need Python 3" >&2
  exit 1
}

connection_name() {
  name="$(uname -n 2>/dev/null || true)"
  name="${name%%.*}"
  [ -n "${name}" ] || name="vibex"
  printf '%s\n' "${name}"
}

public_ip() {
  ipaddr=""
  if command -v hostname >/dev/null 2>&1; then
    ipaddr="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  if [ -z "${ipaddr}" ] && command -v ip >/dev/null 2>&1; then
    ipaddr="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{
      for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }
    }')"
  fi
  if [ -z "${ipaddr}" ] && command -v ifconfig >/dev/null 2>&1; then
    ipaddr="$(ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" { print $2; exit }')"
  fi
  printf '%s\n' "${ipaddr}"
}

host_state_raw() {
  if [ -f "${CONFDIR}/host" ]; then
    tr -d '\n' < "${CONFDIR}/host"
  else
    printf '%s' "waiting"
  fi
}

host_state_label() {
  case "${1}" in
    connected) printf '%s\n' "已接入" ;;
    *) printf '%s\n' "等待接入" ;;
  esac
}

service_state_label() {
  case "${1}" in
    running) printf '%s\n' "运行中" ;;
    starting) printf '%s\n' "启动中" ;;
    failed) printf '%s\n' "失败" ;;
    *) printf '%s\n' "已停止" ;;
  esac
}

port_listening() {
  port="${1}"
  [ -n "${port}" ] || return 1
  if [ -n "${PYTHON:-}" ]; then
    "${PYTHON}" - "${port}" <<'PY'
import socket
import sys

sock = socket.socket()
sock.settimeout(0.4)
try:
    sock.connect(("127.0.0.1", int(sys.argv[1])))
except Exception:
    sys.exit(1)
finally:
    sock.close()
PY
    return $?
  fi
  return 1
}

service_status() {
  if command -v systemctl >/dev/null 2>&1 && [ -f /etc/systemd/system/vibex-tunnel.service ]; then
    case "$(systemctl is-active vibex-tunnel 2>/dev/null || true)" in
      active) printf '%s\n' "running"; return ;;
      failed) printf '%s\n' "failed"; return ;;
      activating|reloading) printf '%s\n' "starting"; return ;;
    esac
  fi
  if [ -f "${CONFDIR}/tunnel.pid" ]; then
    pid="$(tr -d '\n' < "${CONFDIR}/tunnel.pid")"
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
      if port_listening "${PORT}"; then
        printf '%s\n' "running"
      else
        printf '%s\n' "starting"
      fi
      return
    fi
  fi
  if port_listening "${PORT}"; then
    printf '%s\n' "running"
    return
  fi
  printf '%s\n' "stopped"
}

wait_until_up() {
  n=0
  while [ "${n}" -lt 5 ]; do
    if port_listening "${PORT}"; then
      return 0
    fi
    n=$((n + 1))
    sleep 1
  done
  return 1
}

print_report() {
  wait_until_up || true
  name="$(connection_name)"
  state="$(service_status)"
  host="$(host_state_label "$(host_state_raw)")"
  ipaddr="$(public_ip)"
  printf '\n'
  printf '%s\n' "连接"
  printf '  连接名称    %s\n' "${name}"
  printf '  端口        %s\n' "${PORT}"
  printf '  服务名称    %s\n' "vibex-tunnel"
  printf '  服务状态    %s\n' "$(service_state_label "${state}")"
  printf '  监听        %s\n' "${BIND}:${PORT}"
  if [ -n "${ipaddr}" ]; then
    printf '  公网入口    %s\n' "http://${ipaddr}:${PORT}"
  fi
  printf '  本机 Host   %s\n' "${host}"
  printf '\n'
}

if [ "$(id -u)" -eq 0 ]; then
  LIBDIR="/usr/local/lib/vibex-tunnel"
  CONFDIR="/etc/vibex-tunnel"
  LOGFILE="/var/log/vibex-tunnel.log"
else
  LIBDIR="${HOME}/.vibex-tunnel"
  CONFDIR="${HOME}/.vibex-tunnel"
  LOGFILE="${HOME}/.vibex-tunnel/tunnel.log"
fi

PYTHON="$(resolve_python || true)"

if [ "${MODE}" = "status" ]; then
  if [ -z "${PORT}" ] && [ -f "${CONFDIR}/port" ]; then
    PORT="$(tr -d '\n' < "${CONFDIR}/port")"
  fi
  if [ -f "${CONFDIR}/bind" ]; then
    BIND="$(tr -d '\n' < "${CONFDIR}/bind")"
  fi
  if [ -z "${PORT}" ]; then
    echo "tunnel is not installed" >&2
    exit 1
  fi
  print_report
  exit 0
fi

mkdir -p "${LIBDIR}" "${CONFDIR}"
download "${PY_URL}" "${LIBDIR}/server.py"
chmod 755 "${LIBDIR}/server.py"
umask 077
printf '%s\n' "${TOKEN}" > "${CONFDIR}/token"
printf '%s\n' "${PORT}" > "${CONFDIR}/port"
printf '%s\n' "${BIND}" > "${CONFDIR}/bind"
printf '%s\n' "waiting" > "${CONFDIR}/host"

START_CMD="${PYTHON} ${LIBDIR}/server.py --token ${TOKEN} --port ${PORT} --bind ${BIND} --status-file ${CONFDIR}/host"

if command -v systemctl >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ] && [ -d /etc/systemd/system ]; then
  cat > /etc/systemd/system/vibex-tunnel.service <<EOF
[Unit]
Description=VibeX public tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${START_CMD}
Restart=always
RestartSec=2
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable vibex-tunnel >/dev/null 2>&1 || true
  systemctl restart vibex-tunnel
  print_report
  exit 0
fi

if command -v launchctl >/dev/null 2>&1 && [ "$(uname -s)" = "Darwin" ]; then
  PLIST="${HOME}/Library/LaunchAgents/com.vibex.tunnel.plist"
  mkdir -p "${HOME}/Library/LaunchAgents"
  cat > "${PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.vibex.tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PYTHON}</string>
    <string>${LIBDIR}/server.py</string>
    <string>--token</string>
    <string>${TOKEN}</string>
    <string>--port</string>
    <string>${PORT}</string>
    <string>--bind</string>
    <string>${BIND}</string>
    <string>--status-file</string>
    <string>${CONFDIR}/host</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOGFILE}</string>
  <key>StandardErrorPath</key><string>${LOGFILE}</string>
</dict>
</plist>
EOF
  launchctl unload "${PLIST}" >/dev/null 2>&1 || true
  launchctl load "${PLIST}"
  print_report
  exit 0
fi

mkdir -p "$(dirname "${LOGFILE}")"
if [ -f "${CONFDIR}/tunnel.pid" ]; then
  old_pid="$(cat "${CONFDIR}/tunnel.pid" 2>/dev/null || true)"
  if [ -n "${old_pid}" ] && kill -0 "${old_pid}" 2>/dev/null; then
    kill "${old_pid}" 2>/dev/null || true
  fi
fi
# shellcheck disable=SC2086
nohup ${START_CMD} >>"${LOGFILE}" 2>&1 &
echo $! > "${CONFDIR}/tunnel.pid"
print_report
