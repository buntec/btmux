#!/usr/bin/env bash
set -euo pipefail

REPO="buntec/btmux"
BINARY="btmux"
INSTALL_DIR="${BTMUX_INSTALL_DIR:-}"

# Detect platform
OS=$(uname -s)
ARCH=$(uname -m)

case "$OS-$ARCH" in
  Darwin-arm64)   TARGET="aarch64-apple-darwin" ;;
  Linux-x86_64)   TARGET="x86_64-unknown-linux-gnu" ;;
  Linux-aarch64)  TARGET="aarch64-unknown-linux-gnu" ;;
  *)
    echo "error: unsupported platform: $OS $ARCH" >&2
    exit 1
    ;;
esac

# Resolve install directory: ~/.local/bin (user-writable, no sudo needed).
if [ -z "$INSTALL_DIR" ]; then
  INSTALL_DIR="$HOME/.local/bin"
fi

# Fetch the latest release tag
echo "Fetching latest btmux release..."
TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep '"tag_name"' \
  | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')

if [ -z "$TAG" ]; then
  echo "error: could not determine latest release tag" >&2
  exit 1
fi

echo "Latest release: $TAG"

URL="https://github.com/$REPO/releases/download/$TAG/$BINARY-$TARGET"

# Download
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

echo "Downloading $BINARY-$TARGET..."
curl -fSL "$URL" -o "$TMP"
chmod +x "$TMP"

# Install
mkdir -p "$INSTALL_DIR"
mv "$TMP" "$INSTALL_DIR/$BINARY"

echo "Installed btmux $TAG to $INSTALL_DIR/$BINARY"

# Warn if install dir is not on PATH
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "warning: $INSTALL_DIR is not on your PATH."
    echo "Add the following to your shell profile and restart your terminal:"
    echo ""
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    echo ""
    ;;
esac

# Register as a background service
"$INSTALL_DIR/$BINARY" install
