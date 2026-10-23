#!/usr/bin/env sh
#
# Install the VibeX Host family (vibex-server, vibex-mcp, vibex-workflow-mcp
# and the web bundle) from a GitHub Release.
#
# The desktop app is not installed by this script; it ships as a Tauri
# installer with its own updater. Coding agents are not installed either —
# they live in your own environment (ADR-0060).
#
#   curl -fsSL https://raw.githubusercontent.com/Xircth/VibeX/master/install.sh | sh
#
# Environment:
#   VIBEX_VERSION      Install this version instead of the latest release.
#   VIBEX_PLATFORM     Override platform detection (e.g. linux-x86_64).
#   VIBEX_GITHUB_REPO        Source repository. Default Xircth/VibeX.
#   VIBEX_HOST_FAMILY_BASE   Override the download origin (no trailing slash).
#   VIBEX_DOWNLOAD_MIRRORS   Space-separated URL prefixes tried after GitHub.
#   VIBEX_INSTALL_DIR        Where the `vibex` launcher goes. Default ~/.local/bin.
#   VIBEX_PRINT_PLAN         Print the resolved platform and URLs, then exit.

set -eu

DEFAULT_REPO="Xircth/VibeX"
REPO="${VIBEX_GITHUB_REPO:-$DEFAULT_REPO}"
CACHE_ROOT="${HOME}/.vibex/host-family"
INSTALL_DIR="${VIBEX_INSTALL_DIR:-${HOME}/.local/bin}"
# Kept in step with npx-cli/bin/release-assets.js by scripts/release-assets.test.js.
SUPPORTED_PLATFORMS="linux-x86_64 linux-aarch64 darwin-aarch64 windows-x86_64 windows-aarch64"

TEMP_DIR=""

fail() {
    printf 'error: %s\n' "$1" >&2
    exit 1
}

cleanup() {
    if [ -n "$TEMP_DIR" ]; then
        rm -rf "$TEMP_DIR"
    fi
}
trap cleanup EXIT INT TERM

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "$1 is required but was not found"
}

detect_platform() {
    if [ -n "${VIBEX_PLATFORM:-}" ]; then
        printf '%s' "$VIBEX_PLATFORM"
        return
    fi

    os=$(uname -s | tr '[:upper:]' '[:lower:]')
    case "$os" in
        linux) os="linux" ;;
        darwin) os="darwin" ;;
        *) fail "unsupported operating system: $(uname -s). Supported: ${SUPPORTED_PLATFORMS}" ;;
    esac

    machine=$(uname -m | tr '[:upper:]' '[:lower:]')
    case "$machine" in
        x86_64 | amd64) arch="x86_64" ;;
        arm64 | aarch64) arch="aarch64" ;;
        *) fail "unsupported architecture: $(uname -m). Supported: ${SUPPORTED_PLATFORMS}" ;;
    esac

    printf '%s-%s' "$os" "$arch"
}

assert_supported_platform() {
    for candidate in $SUPPORTED_PLATFORMS; do
        [ "$candidate" = "$1" ] && return 0
    done
    fail "unsupported platform: $1. Supported: ${SUPPORTED_PLATFORMS}"
}

mirror_prefixes() {
    if [ -n "${VIBEX_DOWNLOAD_MIRRORS:-}" ]; then
        printf '%s\n' $VIBEX_DOWNLOAD_MIRRORS
        return
    fi
    printf '%s\n' 'https://ghfast.top/' 'https://ghproxy.net/' 'https://mirror.ghproxy.com/'
}

candidate_urls() {
    url="$1"
    printf '%s\n' "$url"
    if [ -n "${VIBEX_HOST_FAMILY_BASE:-}" ]; then
        return
    fi
    for prefix in $(mirror_prefixes); do
        case "$prefix" in
            */) printf '%s%s\n' "$prefix" "$url" ;;
            *) printf '%s/%s\n' "$prefix" "$url" ;;
        esac
    done
}

latest_tag() {
    page="https://github.com/${REPO}/releases/latest"
    for url in $(candidate_urls "$page"); do
        tag=$(curl -4 -sSI --connect-timeout 15 --max-time 20 "$url" 2>/dev/null |
            tr -d '\r' |
            sed -n 's/^[Ll]ocation: .*\/releases\/tag\/\([^[:space:]]*\).*/\1/p' |
            head -n 1)
        if [ -n "$tag" ]; then
            printf '%s' "$tag"
            return 0
        fi
        tag=$(curl -4 -fsSL --connect-timeout 15 --max-time 30 "$url" 2>/dev/null |
            sed -n 's/.*\/releases\/tag\/\(v[0-9][^"<>[:space:]]*\).*/\1/p' |
            head -n 1)
        if [ -n "$tag" ]; then
            printf '%s' "$tag"
            return 0
        fi
    done
    return 1
}

# Both the archive digest and the per-file SHA256SUMS inside it are checked.
# There is deliberately no flag to skip either: a mismatch means the bytes are
# not the published release, and installing them anyway defers the problem to
# runtime.
# GitHub release assets redirect to release-assets.githubusercontent.com (Azure).
# ICMP to github.com can succeed while that HTTPS hop stalls at 0 bytes.
curl_get() {
    curl -4 -fL --http1.1 -sS \
        --connect-timeout 15 \
        --speed-limit 1024 --speed-time 15 \
        --max-time 600 \
        -o "$2" -w 'downloaded %{size_download} bytes\n' \
        "$1"
}

download() {
    url="$1"
    dest="$2"
    for candidate in $(candidate_urls "$url"); do
        printf 'Downloading %s\n' "$candidate"
        if curl_get "$candidate" "$dest" && [ -s "$dest" ]; then
            return 0
        fi
        rm -f "$dest"
    done
    fail "could not download ${url}"
}

verify_digest() {
    file="$1"
    expected="$2"
    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$file" | cut -d' ' -f1)
    else
        actual=$(shasum -a 256 "$file" | cut -d' ' -f1)
    fi
    [ "$actual" = "$expected" ] ||
        fail "checksum mismatch for $(basename "$file"): expected ${expected}, got ${actual}"
}

verify_sha256sums() {
    root="$1"
    ( cd "$root" && grep -v '  SHA256SUMS$' SHA256SUMS > .vibex-verify-list || true )
    if [ ! -s "${root}/.vibex-verify-list" ]; then
        rm -f "${root}/.vibex-verify-list"
        fail "SHA256SUMS in the archive contained no checksums"
    fi
    if command -v sha256sum >/dev/null 2>&1; then
        ( cd "$root" && sha256sum --quiet --check .vibex-verify-list ) ||
            fail "the extracted Host family failed per-file verification"
    else
        ( cd "$root" && shasum -a 256 --status --check .vibex-verify-list ) ||
            fail "the extracted Host family failed per-file verification"
    fi
    rm -f "${root}/.vibex-verify-list"
}

write_launcher() {
    family_root="$1"
    mkdir -p "$INSTALL_DIR"
    launcher="${INSTALL_DIR}/vibex"
    cat > "$launcher" <<LAUNCHER
#!/bin/sh
if [ \$# -eq 0 ]; then
    exec "${family_root}/vibex-server" serve
fi
exec "${family_root}/vibex-server" "\$@"
LAUNCHER
    chmod +x "$launcher"
    printf '%s' "$launcher"
}

main() {
    require_command curl
    require_command tar

    platform=$(detect_platform)
    assert_supported_platform "$platform"

    if [ -n "${VIBEX_VERSION:-}" ]; then
        tag="v${VIBEX_VERSION#v}"
    else
        tag=$(latest_tag)
        [ -n "$tag" ] || fail "could not resolve the latest release of ${REPO}"
    fi
    version="${tag#v}"

    archive="VibeX-${version}-${platform}-server.tar.gz"
    if [ -n "${VIBEX_HOST_FAMILY_BASE:-}" ]; then
        base_url="${VIBEX_HOST_FAMILY_BASE%/}"
    else
        base_url="https://github.com/${REPO}/releases/download/${tag}"
    fi
    family_root="${CACHE_ROOT}/${tag}/${platform}/family"

    if [ -n "${VIBEX_PRINT_PLAN:-}" ]; then
        printf 'platform=%s\n' "$platform"
        printf 'tag=%s\n' "$tag"
        printf 'archive=%s\n' "$archive"
        printf 'archive_url=%s/%s\n' "$base_url" "$archive"
        printf 'checksum_url=%s/%s.sha256\n' "$base_url" "$archive"
        printf 'family_root=%s\n' "$family_root"
        return 0
    fi

    if [ -f "${family_root}/SHA256SUMS" ]; then
        printf 'VibeX Host family %s is already installed for %s.\n' "$tag" "$platform"
        verify_sha256sums "$family_root"
    else
        TEMP_DIR=$(mktemp -d)
        printf 'Downloading VibeX Host family %s for %s...\n' "$tag" "$platform"
        download "${base_url}/${archive}" "${TEMP_DIR}/${archive}"
        download "${base_url}/${archive}.sha256" "${TEMP_DIR}/${archive}.sha256"

        expected=$(cut -d' ' -f1 < "${TEMP_DIR}/${archive}.sha256")
        [ -n "$expected" ] || fail "the published checksum file for ${archive} was empty"
        verify_digest "${TEMP_DIR}/${archive}" "$expected"

        mkdir -p "${TEMP_DIR}/extract"
        tar -xzf "${TEMP_DIR}/${archive}" -C "${TEMP_DIR}/extract"

        unpacked="${TEMP_DIR}/extract/${platform}"
        [ -f "${unpacked}/SHA256SUMS" ] || unpacked="${TEMP_DIR}/extract"
        [ -f "${unpacked}/SHA256SUMS" ] ||
            fail "the archive did not contain SHA256SUMS"
        verify_sha256sums "$unpacked"

        rm -rf "$family_root"
        mkdir -p "$(dirname "$family_root")"
        mv "$unpacked" "$family_root"
    fi

    chmod +x "${family_root}/vibex-server" "${family_root}/vibex-mcp" \
        "${family_root}/vibex-workflow-mcp" 2>/dev/null || true

    launcher=$(write_launcher "$family_root")
    printf '\nInstalled VibeX Host family %s to %s\n' "$tag" "$family_root"
    printf 'Launcher: %s\n' "$launcher"

    case ":${PATH}:" in
        *":${INSTALL_DIR}:"*) printf '\nStart the Host with:\n  vibex\n' ;;
        *) printf '\nAdd %s to PATH, then start the Host:\n  export PATH="%s:$PATH"\n  vibex\n' \
            "$INSTALL_DIR" "$INSTALL_DIR" ;;
    esac
}

main "$@"
