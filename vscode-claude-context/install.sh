#!/usr/bin/env bash
# Build the Claude Context extension and install it into VS Code and/or Cursor.
#
#   install.sh                 install into every editor found (VS Code and Cursor)
#   install.sh --code          VS Code only
#   install.sh --cursor        Cursor only
#   install.sh --build-only    just build the .vsix
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURSOR_APP_CLI="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"

want_code=1; want_cursor=1; build_only=0
for arg in "$@"; do
  case "$arg" in
    --code) want_cursor=0 ;;
    --cursor) want_code=0 ;;
    --build-only) build_only=1 ;;
    -h|--help) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

command -v npm >/dev/null || { echo "npm (Node.js) is required to build the extension" >&2; exit 1; }

cd "$HERE"
npm test --silent
npm run package --silent
VSIX="$(ls -t "$HERE"/claude-context-*.vsix | head -1)"
echo "Built $VSIX"
[ "$build_only" = 1 ] && exit 0

installed=0
install_into() { # name, cli
  echo "Installing into $1 ..."
  "$2" --install-extension "$VSIX" --force 2>&1 | grep -v -e DeprecationWarning -e trace-deprecation
  installed=$((installed + 1))
}

if [ "$want_code" = 1 ] && command -v code >/dev/null; then install_into "VS Code" code
elif [ "$want_code" = 1 ] && [ "$want_cursor" = 0 ]; then echo "'code' is not on PATH (VS Code: Cmd+Shift+P > 'Shell Command: Install code command in PATH')" >&2; fi

# The `cursor` on PATH can be the agent CLI, which cannot install extensions; prefer the app's bundled CLI.
if [ "$want_cursor" = 1 ]; then
  if [ -x "$CURSOR_APP_CLI" ]; then install_into "Cursor" "$CURSOR_APP_CLI"
  elif [ "$want_code" = 0 ]; then echo "Cursor.app not found in /Applications" >&2; fi
fi

if [ "$installed" = 0 ]; then
  echo "No editor CLI found. In your editor run 'Extensions: Install from VSIX...' and pick: $VSIX" >&2
  exit 1
fi
echo "Done. Reload each editor window (Cmd+Shift+P > 'Developer: Reload Window'); the Claude Context icon appears in the Activity Bar."
