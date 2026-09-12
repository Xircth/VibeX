#!/bin/sh
# Exercises public-entry selection in tunnel.sh without installing.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck disable=SC1091
TUNNEL_SH_LIB=1
# shellcheck source=./tunnel.sh
. "${ROOT}/tunnel.sh"

fail() {
  echo "FAIL: ${1}" >&2
  exit 1
}

is_public_ipv4 "103.236.98.173" || fail "public IPv4 should be accepted"
is_public_ipv4 "8.8.8.8" || fail "public IPv4 should be accepted"
is_public_ipv4 "172.16.0.178" && fail "RFC1918 172.16/12 should be rejected"
is_public_ipv4 "192.168.1.1" && fail "RFC1918 192.168/16 should be rejected"
is_public_ipv4 "10.0.0.4" && fail "RFC1918 10/8 should be rejected"
is_public_ipv4 "127.0.0.1" && fail "loopback should be rejected"
is_public_ipv4 "169.254.1.1" && fail "link-local should be rejected"

HOST="103.236.98.173"
ipaddr="$(public_ip)"
[ "${ipaddr}" = "103.236.98.173" ] || fail "preferred host should win, got ${ipaddr}"

stubdir="$(mktemp -d)"
cleanup() { rm -rf "${stubdir}"; }
trap cleanup EXIT

write_stub() {
  name="${1}"
  body="${2}"
  printf '%s\n' "#!/bin/sh" "${body}" > "${stubdir}/${name}"
  chmod +x "${stubdir}/${name}"
}

write_stub hostname 'if [ "${1:-}" = "-I" ]; then printf "%s\n" "172.16.0.178 10.0.0.4"; exit 0; fi; printf "%s\n" testhost'
write_stub ip 'exit 1'
write_stub ifconfig 'exit 1'
write_stub curl 'exit 1'
write_stub wget 'exit 1'

HOST=""
ipaddr="$(PATH="${stubdir}:${PATH}" public_ip)"
[ -z "${ipaddr}" ] || fail "private-only interfaces should not become the public entry, got ${ipaddr}"

write_stub hostname 'if [ "${1:-}" = "-I" ]; then printf "%s\n" "172.16.0.178 103.236.98.173"; exit 0; fi; printf "%s\n" testhost'
HOST=""
ipaddr="$(PATH="${stubdir}:${PATH}" public_ip)"
[ "${ipaddr}" = "103.236.98.173" ] || fail "should skip private IPs, got ${ipaddr}"

help_text="$(sh "${ROOT}/tunnel.sh" --help 2>&1 || true)"
printf '%s\n' "${help_text}" | grep -q '\[-h <public-host>\]' || fail "usage should mention -h public-host"

echo "ok"
