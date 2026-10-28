#!/usr/bin/env bash
# Put `claude-statusbar` on the PATH (symlink into ~/bin), then run the guided setup.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/bin}"

mkdir -p "$BIN_DIR"
chmod +x "$HERE/claude-statusbar"
ln -sf "$HERE/claude-statusbar" "$BIN_DIR/claude-statusbar"
echo "Linked claude-statusbar -> $BIN_DIR/claude-statusbar"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: $BIN_DIR is not on your PATH; add: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

exec "$HERE/claude-statusbar" setup
