#!/usr/bin/env python3
"""Registers the "Claude Context" iTerm2 Toolbelt tool and publishes the focused pane's cwd.

Needs the iTerm2 Python API enabled (Settings > General > Magic) and `pip install iterm2`.
"""
import asyncio
import os

import iterm2

PORT = int(os.environ.get("CLAUDE_TOOLBELT_PORT", "8765"))
STATE_DIR = os.path.expanduser("~/.claude-toolbelt")
FOCUS_FILE = os.path.join(STATE_DIR, "focus")
ACTIVATE_FILE = os.path.join(STATE_DIR, "activate")


async def write_focus(connection):
    """Write the focused pane's TTY (e.g. ttys006) for server.py to highlight; empty when iTerm2 isn't frontmost."""
    app = await iterm2.async_get_app(connection)
    window = app.current_terminal_window
    session = window.current_tab.current_session if window and window.current_tab else None
    tty = await session.async_get_variable("tty") if session else ""
    with open(FOCUS_FILE, "w") as f:
        f.write(os.path.basename(tty or ""))


async def track_focus(connection):
    await write_focus(connection)
    async with iterm2.FocusMonitor(connection) as monitor:
        while True:
            update = await monitor.async_get_next_update()
            if update.application_active is False:
                open(FOCUS_FILE, "w").close()
            else:
                await write_focus(connection)


async def serve_activate(connection):
    """Bring the pane whose TTY server.py wrote to ACTIVATE_FILE to the front."""
    while True:
        await asyncio.sleep(0.3)
        try:
            with open(ACTIVATE_FILE) as f:
                tty = f.read().strip()
            os.remove(ACTIVATE_FILE)
        except OSError:
            continue
        app = await iterm2.async_get_app(connection)
        for window in app.terminal_windows:
            for tab in window.tabs:
                for session in tab.sessions:
                    if os.path.basename(await session.async_get_variable("tty") or "") == tty:
                        await app.async_activate(raise_all_windows=False, ignoring_other_apps=True)
                        await session.async_activate(select_tab=True, order_window_front=True)


async def main(connection):
    await iterm2.tool.async_register_web_view_tool(
        connection, "Claude Context", "dev.claude.toolbelt", True, f"http://127.0.0.1:{PORT}/")
    await asyncio.gather(track_focus(connection), serve_activate(connection))


if __name__ == "__main__":
    os.makedirs(STATE_DIR, exist_ok=True)
    iterm2.run_forever(main)
