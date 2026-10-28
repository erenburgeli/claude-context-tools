#!/usr/bin/env python3
"""Registers the "Claude Context" iTerm2 status bar component.

The component is bound to its own pane's TTY and shows the Claude Code session running there: model,
effort, directory, git state, context usage, session age, subagents, AWS profile and version. It only
reads local files Claude already writes (~/.claude/sessions and the transcripts under ~/.claude/projects).

Needs the iTerm2 Python API enabled (Settings > General > Magic) and `pip install iterm2`.
"""
import asyncio
import glob
import json
import os
import re
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import iterm2

CONFIG_DIR = os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude"))
PROJECTS_DIR = os.path.join(CONFIG_DIR, "projects")
SESSIONS_DIR = os.path.join(CONFIG_DIR, "sessions")
SETTINGS_FILE = os.path.join(CONFIG_DIR, "settings.json")
STATE_DIR = os.path.expanduser("~/.claude-statusbar")
SUBAGENT_ACTIVE_SECS = 120
COMPONENT_ID = "dev.claude.statusbar"

_cache = {}
_scans = {}
_pool = ThreadPoolExecutor(max_workers=4)
_inflight = set()
_lock = threading.Lock()


def _refresh(key, fn):
    try:
        _cache[key] = (time.time(), fn())
    finally:
        with _lock:
            _inflight.discard(key)


def cached(key, ttl, fn, default=None):
    """fn() memoized for `ttl` seconds.

    With a `default`, fn runs in the background and the last value (or the default) is returned at once:
    iTerm2 times a component call out after a few seconds, and ps/git can take longer than that here.
    """
    hit = _cache.get(key)
    fresh = hit and time.time() - hit[0] < ttl
    if default is None:
        if fresh:
            return hit[1]
        value = _cache[key] = (time.time(), fn())
        return value[1]
    if not fresh:
        with _lock:
            start = key not in _inflight
            _inflight.add(key)
        if start:
            _pool.submit(_refresh, key, fn)
    return hit[1] if hit else default


def run(cmd):
    """stdout of cmd, or '' on failure; the timeout keeps one hung git/ps from pinning a background slot forever."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return None
    return r.stdout if r.returncode == 0 else None


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def settings():
    mtime = os.path.getmtime(SETTINGS_FILE) if os.path.exists(SETTINGS_FILE) else 0
    return cached(("settings", mtime), 3600, lambda: read_json(SETTINGS_FILE))


def one_m_models():
    """Model ids that settings.json configures with a [1m] suffix (1M-token context).

    Transcripts record the bare model id (no [1m]), so this is the only per-model signal available.
    """
    env = settings().get("env", {})
    return {m for v in env.values() if isinstance(v, str) for m in re.findall(r"(claude-[a-z0-9-]+?)\[1m\]", v)}


def configured_defaults():
    """(model id, effort) from settings.json, resolving aliases like "sonnet" via ANTHROPIC_DEFAULT_*_MODEL."""
    cfg = settings()
    model = cfg.get("model") or ""
    model = cfg.get("env", {}).get(f"ANTHROPIC_DEFAULT_{model.upper()}_MODEL", model)
    return model.split("anthropic.")[-1] or "?", cfg.get("effortLevel", "")


def sessions_by_tty():
    """{tty: session record} for interactive claude processes attached to a terminal.

    When several sessions share a TTY the most recently started one wins.
    """
    def compute():
        out = run(["ps", "-axo", "pid=,tty=,comm="]) or ""
        rows = (line.split(None, 2) for line in out.splitlines())
        # comm check: a stale session file whose pid was recycled must not show up on an unrelated process
        pid_tty = {r[0]: r[1] for r in rows if len(r) == 3 and "claude" in r[2]}
        found = []
        for path in glob.glob(f"{SESSIONS_DIR}/*.json"):
            info = read_json(path)
            tty = pid_tty.get(str(info.get("pid")), "??")
            if info.get("kind") == "interactive" and tty != "??":
                found.append((info.get("startedAt", 0), tty, info))
        return {tty: info for _, tty, info in sorted(found, key=lambda f: f[0])}
    return cached("ttys", 1.5, compute, default={})


def started_at(path):
    """Epoch seconds of the first timestamped entry in a transcript, or 0."""
    with open(path, "rb") as f:
        m = re.search(rb'"timestamp":"([^"]+)"', f.read(32 * 1024))
    try:
        return datetime.fromisoformat(m.group(1).decode().replace("Z", "+00:00")).timestamp() if m else 0
    except ValueError:
        return 0


def scan_transcript(path):
    """(tokens, model, version, effort, started, cwd) from the last main-chain assistant message of a transcript.

    Large tool results can sit between the end of the file and that message, so the search window grows
    until it is found. Cached by mtime.
    """
    mtime = os.path.getmtime(path)
    if _scans.get(path, (0,))[0] == mtime:
        return _scans[path][1]
    size = os.path.getsize(path)
    window = 256 * 1024
    usage = None
    while True:
        with open(path, "rb") as f:
            f.seek(max(0, size - window))
            lines = f.read().decode("utf-8", "ignore").splitlines()
        for line in reversed(lines):
            if '"usage"' in line:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("type") == "assistant" and not d.get("isSidechain"):
                    usage = d
                    break
        if usage or window >= size:
            break
        window *= 4
    result = (0, "?", "", "", started_at(path), "")
    if usage:
        u = usage["message"]["usage"]
        tokens = (u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
                  + u.get("cache_read_input_tokens", 0))
        result = (tokens, usage["message"].get("model", "?"), usage.get("version", ""),
                  usage.get("effort") or "", result[4], usage.get("cwd", ""))
    _scans[path] = (mtime, result)
    return result


def transcript_path(sid):
    return cached(("transcript", sid), 5, lambda: next(iter(glob.glob(f"{PROJECTS_DIR}/*/{sid}.jsonl")), None))


def active_subagents(path):
    """Number of subagents whose log was written recently, from <session>/subagents/*.meta.json."""
    now = time.time()
    count = 0
    for meta in glob.glob(f"{path[:-6]}/subagents/*.meta.json"):
        log = meta[: -len(".meta.json")] + ".jsonl"
        if os.path.exists(log) and now - os.path.getmtime(log) < SUBAGENT_ACTIVE_SECS:
            count += 1
    return count


def git_state(cwd):
    """'branch +staged ~modified ?untracked ↑ahead ↓behind', or '' outside a repo. One `git status` call."""
    def compute():
        out = run(["git", "-C", cwd, "--no-optional-locks", "status", "--porcelain=v2", "--branch"])
        if out is None:
            return ""
        branch, oid, ahead, behind = "", "", 0, 0
        staged = modified = untracked = 0
        for line in out.splitlines():
            if line.startswith("# branch.head "):
                branch = line.split(" ", 2)[2]
            elif line.startswith("# branch.oid "):
                oid = line.split(" ", 2)[2][:7]
            elif line.startswith("# branch.ab "):
                a, b = line.split()[2:4]
                ahead, behind = int(a), -int(b)
            elif line.startswith("?"):
                untracked += 1
            elif line[:1] in "12u":
                xy = line.split(" ", 2)[1]
                staged += xy[0] != "."
                modified += xy[1] != "."
        out = [f"detached@{oid}" if branch == "(detached)" else branch]
        for sign, n in (("+", staged), ("~", modified), ("?", untracked), ("↑", ahead), ("↓", behind)):
            if n:
                out.append(f"{sign}{n}")
        return " ".join(out)
    return cached(("git", cwd), 5, compute, default="") if cwd else ""


def aws_profile(pid):
    """AWS_PROFILE from the claude process environment (same-user `ps eww`), or ''."""
    def compute():
        env = run(["ps", "eww", "-o", "command=", "-p", str(pid)]) or ""
        m = re.search(r"\bAWS_PROFILE=(\S+)", env)
        return m.group(1) if m else ""
    return cached(("aws", pid), 10, compute, default="")


def short_model(model):
    """claude-opus-5-5-20260101 -> opus-5-5."""
    return re.sub(r"-\d{8}$", "", model.removeprefix("claude-"))


def duration(started):
    secs = int(time.time() - started) if started else 0
    h, rem = divmod(secs, 3600)
    if h >= 48:
        return f"{h // 24}d{h % 24}h"
    return f"{h}h{rem // 60}m" if h else f"{rem // 60}m{rem % 60:02d}s"


def summary(tty):
    """Status-bar strings (longest first) for the session on `tty`, or [] when none is running there.

    Emojis mark each piece, since a single component has a single color.
    """
    info = sessions_by_tty().get(tty)
    if not info:
        return []
    cwd = info.get("cwd", "")
    path = transcript_path(info.get("sessionId", ""))
    if path:
        tokens, model, version, effort, started, latest_cwd = scan_transcript(path)
        cwd = latest_cwd or cwd  # the transcript tracks `cd`s; the session record only has the start dir
        agents = active_subagents(path)
    else:  # no message sent yet, so no transcript: fall back to the configured defaults
        model, effort = configured_defaults()
        tokens, version, started, agents = 0, info.get("version", ""), info.get("startedAt", 0) / 1000, 0
    window = 1_000_000 if tokens > 200_000 or model in one_m_models() or model.endswith("[1m]") else 200_000
    model = short_model(re.sub(r"\[1m\]$", "", model))
    pct = min(100, round(100 * tokens / window))
    bar = "█" * (pct // 10) + "░" * (10 - pct // 10)
    git = git_state(cwd)
    aws = aws_profile(info.get("pid"))
    head = f"🤖 {model}" + (f" · {effort}" if effort else "")
    parts = {
        "dir": f"📁 {os.path.basename(cwd)}" if cwd else "",
        "git": f"🌿 {git}" if git else "",
        "agents": f"👥 {agents} agent{'s' if agents != 1 else ''}" if agents else "",
    }
    variants = [
        [head, parts["dir"], parts["git"], f"📊 {bar} {pct}%/{window // 1000}k", f"⏱ {duration(started)}",
         parts["agents"], f"☁️ {aws}" if aws else "", f"🏷 v{version}" if version else ""],
        [head, parts["dir"], parts["git"], f"📊 {pct}%", parts["agents"]],
        [f"📊 {pct}%", parts["agents"]],
    ]
    return [" | ".join(p for p in v if p) for v in variants]


async def main(connection):
    component = iterm2.StatusBarComponent(
        "Claude Context", "Model, effort, git, context usage and subagents of the Claude Code session on this pane",
        [], "🤖 opus-5-5 · high | 📁 adlc | 🌿 main | 📊 14%/1000k", 2, COMPONENT_ID)

    @iterm2.StatusBarRPC
    async def claude_context(knobs, tty=iterm2.Reference("tty")):
        # Returning a list lets iTerm2 pick the longest string that fits the available width.
        if not isinstance(tty, str):  # iTerm2 may call without the variable, leaving the Reference default
            return ""
        return await asyncio.to_thread(summary, os.path.basename(tty)) or ""

    sessions_by_tty()  # start the slow ps lookup now so the first poll already has data
    await component.async_register(connection, claude_context)


if __name__ == "__main__":
    os.makedirs(STATE_DIR, exist_ok=True)
    iterm2.run_forever(main)
