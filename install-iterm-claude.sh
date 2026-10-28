#!/usr/bin/env bash
# One guided install for the iTerm2 Claude plugins: the Toolbelt panel (iterm-toolbelt) and/or the
# status bar component (iterm-claude-statusbar). Does the shared setup once, then asks which to install.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/bin}"

pause() { printf '\n%s\n  -> press Enter to continue (Ctrl-C to quit) ' "$1"; read -r _; }
ask() { local a; read -r -p "$1 [Y/n] " a; [[ "${a:-y}" != [nN]* ]]; }
link() { mkdir -p "$BIN_DIR"; chmod +x "$HERE/$1/$2"; ln -sf "$HERE/$1/$2" "$BIN_DIR/$2"; echo "Linked $2 -> $BIN_DIR/$2"; }

echo "iTerm2 Claude plugins: shared setup, then you pick what to install."

pause "Step 1: install the iTerm2 Python package (pip install iterm2)."
python3 -m pip install --quiet iterm2
echo "  done."

pause "Step 2: in iTerm2 open Settings (Cmd+,) > General > Magic and tick 'Enable Python API'. Do it now, then come back here."

echo
ask "Install the status bar component (per-pane session info)?" && STATUSBAR=1 || STATUSBAR=0
ask "Install the Toolbelt sidebar panel (all sessions at a glance)?" && TOOLBELT=1 || TOOLBELT=0

if [ "$STATUSBAR" = 1 ]; then
  link iterm-claude-statusbar claude-statusbar
  "$BIN_DIR/claude-statusbar" start
  ask "Start the status bar automatically with iTerm2?" && "$BIN_DIR/claude-statusbar" autostart on
fi
if [ "$TOOLBELT" = 1 ]; then
  link iterm-toolbelt claude-toolbelt
  "$BIN_DIR/claude-toolbelt" start
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: $BIN_DIR is not on your PATH; add: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

echo
echo "If iTerm2 asks for permission for the script, click Allow."
[ "$STATUSBAR" = 1 ] && echo "Status bar: iTerm2 > Settings > Profiles > Session > tick 'Status bar enabled' > Configure Status Bar, then drag 'Claude Context' into the Active Components area. Manage: claude-statusbar {start,stop,restart,status,logs,autostart}"
[ "$TOOLBELT" = 1 ] && echo "Toolbelt: iTerm2 > View > Show Toolbelt, then View > 'Claude Context' so it has a tick. Manage: claude-toolbelt {start,stop,restart,status,logs}"
exit 0
