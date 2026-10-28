#!/usr/bin/env python3
"""Local panel for the iTerm2 Toolbelt: context window + agent types for live Claude Code sessions."""
import glob
import html
import json
import os
import re
import subprocess
import time
import zlib
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("CLAUDE_TOOLBELT_PORT", "8765"))
ROOT = os.path.expanduser("~/.claude/projects")
SESSIONS_DIR = os.path.expanduser("~/.claude/sessions")
SETTINGS_FILE = os.path.expanduser("~/.claude/settings.json")
STATE_DIR = os.path.expanduser("~/.claude-toolbelt")
FOCUS_FILE = os.path.join(STATE_DIR, "focus")
ACTIVATE_FILE = os.path.join(STATE_DIR, "activate")
ACTIVE_SECS = 600
SUBAGENT_ACTIVE_SECS = 120


_scan_cache = {}
_one_m_cache = (0, set())


def one_m_models():
    """Model ids that ~/.claude/settings.json configures with a [1m] suffix (1M-token context).

    Transcripts record the bare model id (no [1m]), so this is the only per-model signal available.
    """
    global _one_m_cache
    try:
        mtime = os.path.getmtime(SETTINGS_FILE)
        if _one_m_cache[0] != mtime:
            with open(SETTINGS_FILE) as f:
                env = json.load(f).get("env", {})
            models = {m for v in env.values() if isinstance(v, str)
                      for m in re.findall(r"(claude-[a-z0-9-]+?)\[1m\]", v)}
            _one_m_cache = (mtime, models)
    except (OSError, ValueError):
        pass
    return _one_m_cache[1]


def scan_transcript(path):
    """(tokens, model, cwd, title) from the newest entries of a transcript.

    Tokens/model/cwd come from the last main-chain assistant message; the title is the last
    custom-title (a /rename) or, failing that, the last ai-title. Large tool results can sit
    between the end of the file and those entries, so the search window grows until both are found.
    """
    mtime = os.path.getmtime(path)
    if _scan_cache.get(path, (0,))[0] == mtime:
        return _scan_cache[path][1]
    size = os.path.getsize(path)
    window = 256 * 1024
    while True:
        with open(path, "rb") as f:
            f.seek(max(0, size - window))
            lines = f.read().decode("utf-8", "ignore").splitlines()
        usage, custom, ai = None, "", ""
        for line in reversed(lines):
            if usage is None and '"usage"' in line:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("type") == "assistant" and not d.get("isSidechain"):
                    usage = d
            elif not custom and line.startswith('{"type":"custom-title"'):
                custom = json.loads(line).get("customTitle", "")
            elif not ai and line.startswith('{"type":"ai-title"'):
                ai = json.loads(line).get("aiTitle", "")
            if usage and custom:
                break
        if (usage and (custom or ai)) or window >= size:
            break
        window *= 4
    tokens, model, cwd = 0, "?", ""
    if usage:
        u = usage["message"]["usage"]
        tokens = (u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
                  + u.get("cache_read_input_tokens", 0))
        model, cwd = usage["message"].get("model", "?"), usage.get("cwd", "")
    result = (tokens, model, cwd, custom or ai)
    _scan_cache[path] = (mtime, result)
    return result


def session_ttys():
    """({sessionId: tty}, {tty: sessionId}) for interactive claude processes attached to a terminal.

    When several sessions share a TTY the most recently started one wins the reverse lookup.
    """
    out = subprocess.run(["ps", "-axo", "pid=,tty="], capture_output=True, text=True).stdout
    rows = (line.split(None, 1) for line in out.splitlines())
    pid_tty = {pid: tty.strip() for pid, tty in (r for r in rows if len(r) == 2)}
    procs = []
    for path in glob.glob(f"{SESSIONS_DIR}/*.json"):
        try:
            with open(path) as f:
                info = json.load(f)
        except (OSError, ValueError):
            continue
        tty = pid_tty.get(str(info.get("pid")), "??")
        if info.get("kind") == "interactive" and tty != "??":
            procs.append((info.get("startedAt", 0), info.get("sessionId", ""), tty))
    procs.sort()
    return {sid: tty for _, sid, tty in procs}, {tty: sid for _, sid, tty in procs}


def sessions():
    now = time.time()
    out = []
    for p in glob.glob(f"{ROOT}/*/*.jsonl"):
        if now - os.path.getmtime(p) > ACTIVE_SECS:
            continue
        tokens, model, cwd, title = scan_transcript(p)
        window = 1_000_000 if tokens > 200_000 or model in one_m_models() else 200_000
        agents = []
        for m in glob.glob(f"{p[:-6]}/subagents/*.meta.json"):
            log = m[: -len(".meta.json")] + ".jsonl"
            if os.path.exists(log) and now - os.path.getmtime(log) < SUBAGENT_ACTIVE_SECS:
                with open(m) as f:
                    agents.append(json.load(f).get("agentType", "?"))
        out.append(dict(name=title or os.path.basename(cwd) or "?", cwd=os.path.basename(cwd),
                        sid=os.path.basename(p)[:-6], model=model, tokens=tokens,
                        window=window, agents=agents, mtime=os.path.getmtime(p)))
    return sorted(out, key=lambda s: -s["mtime"])


MODEL_HUES = {"opus": 285, "sonnet": 205, "haiku": 160}


def hue(name):
    """Stable 0-359 hue for a name, so an agent type keeps its color across refreshes."""
    return zlib.crc32(name.encode()) % 360


def pill(text, h):
    return (f"<span class=pill style='background:hsl({h},55%,26%);color:hsl({h},90%,84%)'>"
            f"{html.escape(text)}</span>")


def model_pill(model):
    """Bold pill colored by model family (opus/sonnet/haiku), else by name."""
    return pill(model, next((h for fam, h in MODEL_HUES.items() if fam in model), hue(model)))


def agent_pills(agents):
    """One bold colored pill per active subagent type, with a count when several run."""
    counts = Counter(agents)
    return "".join(pill(f"{a} ×{n}" if n > 1 else a, hue(a)) for a, n in counts.items()) \
        or "<small>no subagents</small>"


def render():
    cards = []
    sid_tty, tty_sid = session_ttys()
    try:
        with open(FOCUS_FILE) as f:
            focused = tty_sid.get(f.read().strip(), "")
    except OSError:
        focused = ""
    for s in sessions():
        pct = min(100, round(100 * s["tokens"] / s["window"]))
        color = "#4caf50" if pct < 60 else "#ffb300" if pct < 85 else "#e53935"
        cards.append(
            f"<div class='c{' on' if focused and s['sid'] == focused else ''}"
            f"{' click' if s['sid'] in sid_tty else ''}' data-sid='{s['sid']}'><b>{html.escape(s['name'])}</b>"
            f"<br>{model_pill(s['model'])} <small>{html.escape(s['cwd'])}</small>"
            f"<div class=bar><div style='width:{pct}%;background:{color}'></div></div>"
            f"{s['tokens'] // 1000}k / {s['window'] // 1000}k ({pct}%)<br>"
            f"{agent_pills(s['agents'])}</div>"
        )
    body = "".join(cards) or "<small>no active sessions</small>"
    return (
        "<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=3>"
        "<style>body{font:12px -apple-system,sans-serif;background:#1e1e1e;color:#ddd;margin:6px}"
        ".c{border:1px solid #444;border-radius:6px;padding:6px;margin-bottom:6px}"
        ".c.on{border-color:#4fc3f7;box-shadow:0 0 0 1px #4fc3f7;background:#26323a}"
        ".bar{height:8px;background:#444;border-radius:4px;margin:4px 0}"
        ".click{cursor:pointer}.click:hover{border-color:#888}"
        ".pill{display:inline-block;font-weight:700;font-size:11px;padding:1px 7px;border-radius:9px;"
        "margin:2px 4px 2px 0}"
        ".bar div{height:8px;border-radius:4px}small{color:#999}</style>" + body +
        "<script>document.addEventListener('click',e=>{const c=e.target.closest('.click');"
        "if(c)fetch('/activate?sid='+c.dataset.sid,{method:'POST'})})</script>"
    )


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        """Ask the registrar to bring the clicked session's iTerm2 pane to the front."""
        url = urlparse(self.path)
        tty = session_ttys()[0].get(parse_qs(url.query).get("sid", [""])[0])
        if url.path != "/activate" or not tty:
            self.send_response(404)
        else:
            with open(ACTIVATE_FILE, "w") as f:
                f.write(tty)
            self.send_response(204)
        self.end_headers()

    def do_GET(self):
        body = render().encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    os.makedirs(STATE_DIR, exist_ok=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
