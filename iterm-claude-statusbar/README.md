# iterm-claude-statusbar

An iTerm2 status bar component, "Claude Context", that shows the Claude Code session running in each pane. It is bound to its own pane's TTY, so every tab and split shows its own session and updates the moment you switch.

```
🤖 sonnet-5-5 · medium | 📁 my-app | 🌿 main ~1 ?5 ↓3 | 📊 █░░░░░░░░░ 15%/1000k | ⏱ 27m09s | 👥 2 agents | ☁️ dev | 🏷 v2.1.296
```

Model with effort level, directory, git state (branch, staged/modified/untracked, ahead/behind), context usage with the window size, session age, running subagents, AWS profile and Claude version. It shortens itself when the pane is narrow (down to `📊 15%`), and is empty on panes without a Claude session.

It needs no hooks and no Claude Code status line: it only reads the local files Claude already writes (`~/.claude/sessions` and the transcripts under `~/.claude/projects`). Before a session's first message there is no transcript yet, so the model and effort come from your `settings.json` defaults.

## Install

```
./install.sh   # links claude-statusbar into ~/bin and runs the guided setup
```

The only manual step is ticking Enable Python API in iTerm2 > Settings > General > Magic. Then show the component: Settings > Profiles > Session > tick Status bar enabled > Configure Status Bar, and drag Claude Context into the Active Components area.

Manage with `claude-statusbar {start,stop,restart,status,logs,autostart}`.

## Tips

- **Status bar at the bottom:** Settings > Appearance > General > Status bar location > Bottom (applies to all profiles).
- **Match Claude Code's footer color:** the plugin can't set colors, iTerm2 does. Select Claude Context in the active components, choose Configure Component, and set its text color to `999999` (60% gray) to match the color of Claude Code's own footer.

## Limitations

- iTerm2 on macOS only; Python 3.9+; `git` on the PATH.
- Cost, lines changed and rate limits aren't shown: Claude Code only passes them to a status line script, they are not in the transcripts.
- The context window size is inferred: 1M if the model is configured with `[1m]` in `settings.json` `env` or usage already exceeds 200k, otherwise 200k.
- Without autostart it does not survive a reboot or iTerm2 restart; run `claude-statusbar start` again. The installer offers autostart, which links the script into iTerm2's AutoLaunch folder; `claude-statusbar autostart off` removes it. Autostart needs iTerm2's Python runtime (Scripts > Manage > Install Python Runtime).

Configuration: `CLAUDE_CONFIG_DIR` (default `~/.claude`). State and logs live in `~/.claude-statusbar/`.

Built on the transcript-reading approach of `../iterm-toolbelt`.
