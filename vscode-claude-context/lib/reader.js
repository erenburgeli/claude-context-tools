// Reads the local files Claude Code already writes (sessions, transcripts, settings) and turns them into
// per-session snapshots. Port of iterm-claude-statusbar/statusbar.py, minus the TTY mapping.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const SESSIONS_DIR = path.join(CONFIG_DIR, "sessions");
const PROJECTS_DIR = path.join(CONFIG_DIR, "projects");
const SETTINGS_FILE = path.join(CONFIG_DIR, "settings.json");
const SUBAGENT_ACTIVE_MS = 120_000;

const scans = new Map();
const transcriptPaths = new Map();
const memo = new Map();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function run(cmd, args) {
  return new Promise((resolve) =>
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? null : stdout)));
}

/** fn() memoized per key for ttlMs; concurrent callers share one in-flight promise. */
function cached(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = Promise.resolve(fn());
  memo.set(key, { at: Date.now(), value });
  return value;
}

/** settings.json, re-read only when its mtime changes. */
let settingsCache = { mtimeMs: -1, value: {} };
function settings() {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(SETTINGS_FILE).mtimeMs; } catch { /* no settings file */ }
  if (mtimeMs !== settingsCache.mtimeMs) settingsCache = { mtimeMs, value: readJson(SETTINGS_FILE) };
  return settingsCache.value;
}

/** Model ids that settings.json configures with a [1m] suffix; transcripts record the bare id. */
function oneMModels() {
  const env = settings().env || {};
  const found = new Set();
  for (const v of Object.values(env)) {
    if (typeof v !== "string") continue;
    for (const m of v.matchAll(/(claude-[a-z0-9-]+?)\[1m\]/g)) found.add(m[1]);
  }
  return found;
}

function configuredDefaults() {
  const cfg = settings();
  let model = cfg.model || "";
  model = (cfg.env || {})[`ANTHROPIC_DEFAULT_${model.toUpperCase()}_MODEL`] || model;
  return { model: model.split("anthropic.").pop() || "?", effort: cfg.effortLevel || "" };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Live sessions from ~/.claude/sessions. A stale file whose pid was recycled is dropped by the comm check. */
async function liveSessions({ includeTerminal = false } = {}) {
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json")); } catch { return []; }
  const candidates = files
    .map((f) => readJson(path.join(SESSIONS_DIR, f)))
    .filter((s) => s.sessionId && s.pid && s.kind === "interactive" && pidAlive(s.pid)
      && (includeTerminal || s.entrypoint === "claude-vscode"));
  if (!candidates.length) return [];
  const ps = (await run("ps", ["-axo", "pid=,comm="])) || "";
  const claudePids = new Set(ps.split("\n").filter((l) => /claude/.test(l)).map((l) => l.trim().split(/\s+/)[0]));
  return candidates.filter((s) => claudePids.has(String(s.pid)));
}

function startedAt(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(32 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const m = /"timestamp":"([^"]+)"/.exec(buf.toString("utf8", 0, n));
    const t = m ? Date.parse(m[1]) : NaN;
    return Number.isNaN(t) ? 0 : t;
  } finally {
    fs.closeSync(fd);
  }
}

function transcriptPath(sid) {
  const known = transcriptPaths.get(sid);
  if (known && fs.existsSync(known)) return known;
  try {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, dir, `${sid}.jsonl`);
      if (fs.existsSync(p)) {
        transcriptPaths.set(sid, p);
        return p;
      }
    }
  } catch { /* no projects dir yet */ }
  return null;
}

/**
 * Tokens, model, version, effort, start time and cwd from the last main-chain assistant message.
 * Large tool results can sit after it, so the search window grows until it is found. Cached by mtime.
 */
function scanTranscript(file) {
  const { mtimeMs, size } = fs.statSync(file);
  const hit = scans.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.result;
  let windowBytes = 256 * 1024;
  let last = null;
  for (;;) {
    const start = Math.max(0, size - windowBytes);
    const fd = fs.openSync(file, "r");
    let text;
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"usage"')) continue;
      try {
        const d = JSON.parse(lines[i]);
        if (d.type === "assistant" && !d.isSidechain) {
          last = d;
          break;
        }
      } catch { /* partial first line of the window, or a write in progress */ }
    }
    if (last || windowBytes >= size) break;
    windowBytes *= 4;
  }
  const result = { tokens: 0, model: "?", version: "", effort: "", started: startedAt(file), cwd: "" };
  if (last) {
    const u = last.message.usage;
    result.tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    result.model = last.message.model || "?";
    result.version = last.version || "";
    result.effort = last.effort || "";
    result.cwd = last.cwd || "";
  }
  scans.set(file, { mtimeMs, result });
  return result;
}

const titles = new Map();
const TITLE_RE = /"type":"(custom-title|ai-title)","(?:customTitle|aiTitle)":"((?:[^"\\]|\\.)*)"/g;

/**
 * The tab name: the last /rename title if there is one, else the last auto-generated one. Titles are appended
 * all through a transcript, so only the bytes added since the previous call are scanned.
 */
function sessionTitle(file) {
  const size = fs.statSync(file).size;
  let t = titles.get(file);
  if (!t || size < t.offset) t = { offset: 0, custom: "", ai: "" };
  if (size > t.offset) {
    const fd = fs.openSync(file, "r");
    let text;
    try {
      const buf = Buffer.alloc(size - t.offset);
      fs.readSync(fd, buf, 0, buf.length, t.offset);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    const complete = text.slice(0, text.lastIndexOf("\n") + 1); // a line still being written is picked up next time
    for (const m of complete.matchAll(TITLE_RE)) {
      try { t[m[1] === "custom-title" ? "custom" : "ai"] = JSON.parse(`"${m[2]}"`); } catch { /* malformed escape */ }
    }
    t.offset += Buffer.byteLength(complete);
  }
  titles.set(file, t);
  return t.custom || t.ai;
}

function activeSubagents(file) {
  const dir = path.join(file.slice(0, -".jsonl".length), "subagents");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".meta.json")); } catch { return 0; }
  const now = Date.now();
  return names.filter((n) => {
    try {
      return now - fs.statSync(path.join(dir, n.replace(/\.meta\.json$/, ".jsonl"))).mtimeMs < SUBAGENT_ACTIVE_MS;
    } catch {
      return false;
    }
  }).length;
}

/** 'branch +staged ~modified ?untracked ↑ahead ↓behind', or '' outside a repo. One `git status` call. */
function gitState(cwd) {
  if (!cwd) return Promise.resolve("");
  return cached(`git:${cwd}`, 5000, async () => {
    const out = await run("git", ["-C", cwd, "--no-optional-locks", "status", "--porcelain=v2", "--branch"]);
    if (out === null) return "";
    let branch = "", oid = "", ahead = 0, behind = 0, staged = 0, modified = 0, untracked = 0;
    for (const line of out.split("\n")) {
      if (line.startsWith("# branch.head ")) branch = line.split(" ").slice(2).join(" ");
      else if (line.startsWith("# branch.oid ")) oid = line.split(" ")[2].slice(0, 7);
      else if (line.startsWith("# branch.ab ")) {
        const [a, b] = line.split(" ").slice(2, 4);
        ahead = parseInt(a, 10);
        behind = -parseInt(b, 10);
      } else if (line.startsWith("?")) untracked++;
      else if ("12u".includes(line[0] || "-")) {
        const xy = line.split(" ")[1];
        if (xy[0] !== ".") staged++;
        if (xy[1] !== ".") modified++;
      }
    }
    const parts = [branch === "(detached)" ? `detached@${oid}` : branch];
    for (const [sign, n] of [["+", staged], ["~", modified], ["?", untracked], ["↑", ahead], ["↓", behind]]) {
      if (n) parts.push(`${sign}${n}`);
    }
    return parts.join(" ");
  });
}

/** AWS_PROFILE from the claude process environment (same-user `ps eww`), or ''. */
function awsProfile(pid) {
  return cached(`aws:${pid}`, 10_000, async () => {
    const env = (await run("ps", ["eww", "-o", "command=", "-p", String(pid)])) || "";
    const m = /\bAWS_PROFILE=(\S+)/.exec(env);
    return m ? m[1] : "";
  });
}

/** claude-opus-5-5-20260101 -> opus-5-5 */
function shortModel(model) {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function contextWindow(tokens, model) {
  const bare = model.replace(/\[1m\]$/, "");
  return tokens > 200_000 || model.endsWith("[1m]") || oneMModels().has(bare) ? 1_000_000 : 200_000;
}

/** Everything the UI needs for one session. */
async function snapshot(info) {
  let cwd = info.cwd || "";
  let model, effort, tokens, version, started, agents, lastActive, title = "";
  const file = transcriptPath(info.sessionId);
  if (file) {
    const scan = scanTranscript(file);
    ({ tokens, model, version, effort, started } = scan);
    cwd = scan.cwd || cwd; // the transcript tracks `cd`s; the session record only has the start dir
    agents = activeSubagents(file);
    title = sessionTitle(file);
    lastActive = fs.statSync(file).mtimeMs;
  } else { // no message sent yet, so no transcript: fall back to the configured defaults
    ({ model, effort } = configuredDefaults());
    tokens = 0;
    version = info.version || "";
    started = info.startedAt || 0;
    agents = 0;
    lastActive = info.startedAt || 0;
  }
  const window = contextWindow(tokens, model);
  const [git, aws] = await Promise.all([gitState(cwd), awsProfile(info.pid)]);
  return {
    sessionId: info.sessionId,
    title,
    entrypoint: info.entrypoint || "",
    model: shortModel(model.replace(/\[1m\]$/, "")),
    effort,
    cwd,
    dir: path.basename(cwd),
    git,
    tokens,
    window,
    pct: Math.min(100, Math.round((100 * tokens) / window)),
    started,
    agents,
    aws,
    version,
    lastActive,
  };
}

function duration(startedMs, now = Date.now()) {
  const secs = startedMs ? Math.floor((now - startedMs) / 1000) : 0;
  const h = Math.floor(secs / 3600);
  const rem = secs % 3600;
  if (h >= 48) return `${Math.floor(h / 24)}d${h % 24}h`;
  const mm = Math.floor(rem / 60);
  return h ? `${h}h${mm}m` : `${mm}m${String(rem % 60).padStart(2, "0")}s`;
}

/** True when cwd is a workspace folder or inside one. */
function inWorkspace(cwd, folders) {
  return folders.some((f) => cwd === f || cwd.startsWith(f.endsWith(path.sep) ? f : f + path.sep));
}

module.exports = { liveSessions, snapshot, duration, inWorkspace, shortModel, scanTranscript, contextWindow, sessionTitle };
