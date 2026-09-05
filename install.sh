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

latest_tag() {
    curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" |
        sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
        head -n 1
}

# Both the archive digest and the per-file SHA256SUMS inside it are checked.
# There is deliberately no flag to skip either: a mismatch means the bytes are
# not the published release, and installing them anyway defers the problem to
# runtime.
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
#!/usr/bin/env sh
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
        curl -fSL --progress-bar "${base_url}/${archive}" -o "${TEMP_DIR}/${archive}" ||
            fail "could not download ${base_url}/${archive}"
        curl -fsSL "${base_url}/${archive}.sha256" -o "${TEMP_DIR}/${archive}.sha256" ||
            fail "could not download the checksum for ${archive}"

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
        *":${INSTALL_DIR}:"*) printf '\nRun `vibex` to start the server on http://127.0.0.1:17891\n' ;;
        *) printf '\nAdd %s to your PATH, then run `vibex`:\n  export PATH="%s:$PATH"\n' \
            "$INSTALL_DIR" "$INSTALL_DIR" ;;
    esac
}

main "$@"
