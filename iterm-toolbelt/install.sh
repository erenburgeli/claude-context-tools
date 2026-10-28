#!/usr/bin/env bash
# Put `claude-toolbelt` on the PATH (symlink into ~/bin), then run the guided setup.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/bin}"

mkdir -p "$BIN_DIR"
chmod +x "$HERE/claude-toolbelt"
ln -sf "$HERE/claude-toolbelt" "$BIN_DIR/claude-toolbelt"
echo "Linked claude-toolbelt -> $BIN_DIR/claude-toolbelt"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: $BIN_DIR is not on your PATH; add: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

exec "$HERE/claude-toolbelt" setup
