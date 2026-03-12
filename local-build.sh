#!/bin/bash

set -e  # Exit on any error

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

# Map architecture names
case "$ARCH" in
  x86_64)
    ARCH="x64"
    ;;
  arm64|aarch64)
    ARCH="arm64"
    ;;
  *)
    echo "⚠️  Warning: Unknown architecture $ARCH, using as-is"
    ;;
esac

# Map OS names
case "$OS" in
  linux)
    OS="linux"
    ;;
  darwin)
    OS="macos"
    ;;
  *)
    echo "⚠️  Warning: Unknown OS $OS, using as-is"
    ;;
esac

PLATFORM="${OS}-${ARCH}"

# Set CARGO_TARGET_DIR if not defined
if [ -z "$CARGO_TARGET_DIR" ]; then
  CARGO_TARGET_DIR="target"
fi

echo "🔍 Detected platform: $PLATFORM"
echo "🔧 Using target directory: $CARGO_TARGET_DIR"

# Set API base URL for remote features
export VK_SHARED_API_BASE="https://api.vibekanban.com"
export VITE_VK_SHARED_API_BASE="https://api.vibekanban.com"

echo "🧹 Cleaning previous builds..."
rm -rf npx-cli/dist
mkdir -p npx-cli/dist/$PLATFORM

echo "🔨 Building frontend..."
(cd frontend && npm run build)

echo "🔨 Building Rust binaries..."
cargo build --release --manifest-path Cargo.toml
cargo build --release --bin mcp_task_server --manifest-path Cargo.toml

echo "📦 Creating distribution package..."

# Copy the main binary
cp ${CARGO_TARGET_DIR}/release/server vibe-ultra
zip -q vibe-ultra.zip vibe-ultra
rm -f vibe-ultra 
mv vibe-ultra.zip npx-cli/dist/$PLATFORM/vibe-ultra.zip

# Copy the MCP binary
cp ${CARGO_TARGET_DIR}/release/mcp_task_server vibe-ultra-mcp
zip -q vibe-ultra-mcp.zip vibe-ultra-mcp
rm -f vibe-ultra-mcp
mv vibe-ultra-mcp.zip npx-cli/dist/$PLATFORM/vibe-ultra-mcp.zip

# Copy the Review CLI binary
cp ${CARGO_TARGET_DIR}/release/review vibe-ultra-review
zip -q vibe-ultra-review.zip vibe-ultra-review
rm -f vibe-ultra-review
mv vibe-ultra-review.zip npx-cli/dist/$PLATFORM/vibe-ultra-review.zip

echo "✅ Build complete!"
echo "📁 Files created:"
echo "   - npx-cli/dist/$PLATFORM/vibe-ultra.zip"
echo "   - npx-cli/dist/$PLATFORM/vibe-ultra-mcp.zip"
echo "   - npx-cli/dist/$PLATFORM/vibe-ultra-review.zip"
echo ""
echo "🚀 To test locally, run:"
echo "   cd npx-cli && node bin/cli.js"
