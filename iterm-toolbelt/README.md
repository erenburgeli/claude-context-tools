# iTerm2 Toolbelt — Claude Context panel

A sidebar panel in iTerm2's Toolbelt that shows, for every live Claude Code session: project, model,
context-window usage bar, and the agent types of active subagents. The card for the focused iTerm2
pane is outlined. Click a card to jump to that session's iTerm2 pane (works across windows and tabs).

Useful when the Claude Code status line is unavailable (e.g. blocked by org policy): it needs no
hooks, it only reads the transcripts under `~/.claude/projects/`.

## Install

From the root of this repo, in an iTerm2 window:

```bash
iterm-toolbelt/install.sh
```

It links `claude-toolbelt` into `~/bin` (override with `BIN_DIR`), then walks you through four
steps, pausing after each so you can do the manual part:

1. **Press Enter** to install the `iterm2` Python package.
2. **Enable the API:** iTerm2 > Settings (Cmd+,) > General > Magic > tick **Enable Python API**, then press Enter.
3. **Press Enter** to start the panel in the background. If iTerm2 asks for permission, click Allow.
4. **Show the panel:** iTerm2 > View > Show Toolbelt, then View > **Claude Context** so it has a tick, then press Enter.

Re-run the walkthrough any time with `claude-toolbelt setup`.

## Use

```bash
claude-toolbelt start      # panel server + iTerm2 registration, detached in the background
claude-toolbelt status
claude-toolbelt logs -f    # or: logs server | logs iterm
claude-toolbelt stop
claude-toolbelt restart
```

`start`/`stop`/`restart` take `--only server` or `--only iterm`.

State lives in `~/.claude-toolbelt/` (`*.pid`, `*.log`, `focus`). Set `CLAUDE_TOOLBELT_PORT` to
change the default port 8765.

## How it works

- `server.py` serves an auto-refreshing HTML page on `127.0.0.1`. Context is
  `input + cache_creation + cache_read` tokens from the last main-chain assistant message in each
  transcript touched in the last 10 minutes. Subagent types come from `<session>/subagents/*.meta.json`.
- `register_tool.py` registers the page as a Toolbelt web-view tool through the iTerm2 Python API and
  writes the focused pane's TTY to `~/.claude-toolbelt/focus`; the server resolves it to a session id
  and outlines that card. Clicking a card POSTs to `/activate`; the server drops the session's TTY into
  `~/.claude-toolbelt/activate`, and `register_tool.py` picks it up and activates the matching pane.

## Limitations

- Transcripts record the bare model id (no `[1m]` suffix), so the window size is inferred: 1M if the
  model is configured with `[1m]` in `~/.claude/settings.json` `env`, or if usage already exceeds 200k;
  otherwise 200k. A session that picked a different window than its settings default (e.g. via `/model`)
  can show the wrong percentage.
- Usage comes from the last completed assistant message, so a card lags one message behind mid-turn.
- The "Claude Sessions" panel from an iTerm2 AutoLaunch `claude_monitor_tool.py`, if you have one, is a
  separate tool that needs Claude Code's statusline; this panel does not.
- Focus matching is exact: the focused pane's TTY is mapped to the `claude` process on it, whose
  `~/.claude/sessions/<pid>.json` names the session. Sessions with no TTY (e.g. the Cursor extension)
  are listed but never highlighted.
- Does not survive a reboot or logout; run `claude-toolbelt start` again.

## Troubleshooting

Start with `claude-toolbelt status`.

| Symptom | Cause / fix |
| --- | --- |
| Panel is blank white | The server isn't running (the Toolbelt just shows an empty page). `claude-toolbelt start`. |
| `start` says another `register_tool.py` is running | A copy started by hand, or an older install, holds the same tool id and may run old code. `claude-toolbelt restart --replace`. |
| `iterm: exited immediately` | `claude-toolbelt logs iterm`. Usually the iTerm2 Python API is off (Settings > General > Magic) or `iterm2` isn't installed (`claude-toolbelt setup`). |
| `server: ... does not respond` | Port 8765 is taken. Set `CLAUDE_TOOLBELT_PORT` and `restart`. |
| Context shows 0 or looks stale | Fixed by searching back through the transcript; if it persists, check that the session is active in the last 10 minutes. |
| A card isn't clickable or outlined | The session has no terminal (e.g. the Cursor extension), so there is no pane to switch to. |
| Registered tool vanished after quitting iTerm2 | `register_tool.py` holds the registration; run `claude-toolbelt restart`. |
