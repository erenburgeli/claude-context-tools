# Claude Context tools

See what each Claude Code session is doing (model, effort, git state, context usage, subagents) without a Claude Code status line or hooks. Every tool here only reads the local files Claude already writes (`~/.claude/sessions`, the transcripts under `~/.claude/projects`, `settings.json`). Nothing leaves your machine.

> [!IMPORTANT]
> ### 🙏 Built with David Levi
> **The iTerm2 status bar and the combined iTerm2 installer were built by David Levi.** Thanks, David!

| Tool | Where | What |
|---|---|---|
| [`iterm-claude-statusbar`](iterm-claude-statusbar) | iTerm2 status bar | Per-pane session info, right in the tab |
| [`iterm-toolbelt`](iterm-toolbelt) | iTerm2 Toolbelt sidebar | All live sessions at a glance; click a card to jump to its pane |
| [`vscode-claude-context`](vscode-claude-context) | VS Code / Cursor | Activity Bar sidebar and status bar item for the Claude extension's sessions |

## Claude Context in your iTerm2 status bar: session info at a glance, per tab, plus one installer for both iTerm2 plugins

By David Levi. Building on the Toolbelt panel (the foundation of all of this), the status bar is an alternative for anyone who wants each tab to show its own session info right in the tab, without opening a sidebar. There is a single installer for both, so you can pick the status bar, the Toolbelt panel, or both.

### What the status bar gives you

- A status bar per pane, bound to that pane's own Claude session, so every split and tab shows its own info and updates the moment you switch.
- Model with the effort level, directory, git state (branch, staged/modified/untracked, ahead/behind), a context bar with the window size, session age, running subagents, AWS profile and Claude version. It shortens itself when the pane is narrow.
- It works from the moment you start a session (before your first message it shows your configured defaults) and for idle sessions too.

```
🤖 sonnet-5-5 · medium | 📁 my-app | 🌿 main ~1 ?5 ↓3 | 📊 █░░░░░░░░░ 15%/1000k | ⏱ 27m09s | 👥 2 agents | ☁️ dev | 🏷 v2.1.296
```

Like the Toolbelt panel, it needs no hooks and no Claude Code status line. It only reads local files Claude already writes.

### Install (about 2 minutes)

```bash
git clone https://github.com/erenburgeli/claude-context-tools.git   # already cloned? git pull
cd claude-context-tools
./install-iterm-claude.sh
```

The installer does the shared setup once, then asks which of the status bar and the Toolbelt panel you want. The only manual part is ticking **Enable Python API** in iTerm2 → Settings → General → Magic. It also offers to start the status bar automatically with iTerm2, so you never have to launch it again.

Then show what you installed:

- **Status bar:** iTerm2 → Settings → Profiles → Session → tick Status bar enabled → Configure Status Bar, then drag Claude Context into the Active Components area.
- **Toolbelt panel:** iTerm2 → View → Show Toolbelt → Claude Context.

### 💡 Tips

- **Status bar at the bottom:** Settings → Appearance → General → Status bar location → Bottom. It applies to all profiles.
- **Match Claude Code's footer color:** the plugin can't set colors, iTerm2 does. Select Claude Context in the active components, choose Configure Component, and set its text color to `999999` (60% gray) to match the color of Claude Code's own footer.

### ⚠️ Known limits

iTerm2 only (macOS), Python 3.9+. Cost, lines changed and rate limits aren't shown, because Claude only gives those to a status line script. Before a session's first message, the model and effort come from your `settings.json` defaults, not necessarily what you chose with `/model`. The context window size is inferred from your `settings.json`, as in the Toolbelt panel. Autostart needs iTerm2's Python runtime (Scripts → Manage → Install Python Runtime).

## VS Code / Cursor sidebar

The same idea for the Claude Code extension in VS Code and Cursor: an Activity Bar sidebar with one card per Claude session (tab name, model and effort, git state, context usage, subagents), the card of the focused tab highlighted, plus a status bar item. It is a separate extension that reads the local files Claude already writes; it does not modify the Claude extension.

![Sidebar](vscode-claude-context/docs/sidebar.png)

```bash
vscode-claude-context/install.sh   # builds and installs into VS Code and Cursor; then reload the window
```

Needs Node.js. See [vscode-claude-context/README.md](vscode-claude-context/README.md) for options, settings and how sessions are matched.

## Credits

- iTerm2 Toolbelt panel and VS Code / Cursor extension: Eli Erenburg.
- iTerm2 status bar, the combined installer and the write-up above: **David Levi**.
