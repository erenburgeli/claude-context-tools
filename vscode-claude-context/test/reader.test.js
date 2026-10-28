const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ctx-"));
process.env.CLAUDE_CONFIG_DIR = root;
const reader = require("../lib/reader");

const assistant = (tokens, extra = {}) => JSON.stringify({
  type: "assistant", cwd: "/w/proj", version: "9.9.9", effort: "high", timestamp: "2026-01-01T00:00:00Z",
  message: { model: "claude-opus-5-5-20260101", usage: { input_tokens: tokens, cache_read_input_tokens: 10 } }, ...extra,
});

test("scanTranscript takes the last main-chain assistant message and skips sidechains", () => {
  const file = path.join(root, "t.jsonl");
  fs.writeFileSync(file, [assistant(100), assistant(500), assistant(9999, { isSidechain: true })].join("\n") + "\n");
  const r = reader.scanTranscript(file);
  assert.deepStrictEqual([r.tokens, r.effort, r.version, r.cwd], [510, "high", "9.9.9", "/w/proj"]);
  assert.strictEqual(r.started, Date.parse("2026-01-01T00:00:00Z"));
});

test("scanTranscript widens its window past a huge trailing line", () => {
  const file = path.join(root, "big.jsonl");
  fs.writeFileSync(file, [assistant(42), JSON.stringify({ type: "user", pad: "x".repeat(600 * 1024) })].join("\n") + "\n");
  assert.strictEqual(reader.scanTranscript(file).tokens, 52);
});

test("contextWindow goes to 1M above 200k tokens or with a [1m] suffix", () => {
  assert.strictEqual(reader.contextWindow(1000, "claude-opus-5-5"), 200_000);
  assert.strictEqual(reader.contextWindow(250_000, "claude-opus-5-5"), 1_000_000);
  assert.strictEqual(reader.contextWindow(1000, "claude-opus-5-5[1m]"), 1_000_000);
});

test("shortModel and duration format like the iTerm component", () => {
  assert.strictEqual(reader.shortModel("claude-opus-5-5-20260101"), "opus-5-5");
  assert.strictEqual(reader.duration(0), "0m00s");
  assert.strictEqual(reader.duration(1000, 1000 + 3 * 3600_000 + 5 * 60_000), "3h5m");
});

test("inWorkspace matches the folder and children, not sibling prefixes", () => {
  assert.ok(reader.inWorkspace("/w/adlc", ["/w/adlc"]));
  assert.ok(reader.inWorkspace("/w/adlc/sub", ["/w/adlc"]));
  assert.ok(!reader.inWorkspace("/w/adlc-other", ["/w/adlc"]));
});

test("liveSessions keeps only live extension sessions", async () => {
  fs.mkdirSync(path.join(root, "sessions"));
  const w = (n, o) => fs.writeFileSync(path.join(root, "sessions", `${n}.json`), JSON.stringify(o));
  w("a", { pid: 999999, sessionId: "dead", kind: "interactive", entrypoint: "claude-vscode" });
  w("b", { pid: process.pid, sessionId: "notclaude", kind: "interactive", entrypoint: "claude-vscode" });
  assert.deepStrictEqual(await reader.liveSessions(), []); // dead pid; live pid that is not a claude process
});

test("sessionTitle prefers the last /rename title and reads appended bytes incrementally", () => {
  const file = path.join(root, "titles.jsonl");
  const ai = (x) => JSON.stringify({ type: "ai-title", aiTitle: x, sessionId: "s" });
  fs.writeFileSync(file, [ai("First \"quoted\""), assistant(1)].join("\n") + "\n");
  assert.strictEqual(reader.sessionTitle(file), 'First "quoted"');
  fs.appendFileSync(file, JSON.stringify({ type: "custom-title", customTitle: "my-name", sessionId: "s" }) + "\n" + ai("Later ai") + "\n");
  assert.strictEqual(reader.sessionTitle(file), "my-name");
  fs.appendFileSync(file, JSON.stringify({ type: "custom-title", customTitle: "half-writ" })); // no newline yet
  assert.strictEqual(reader.sessionTitle(file), "my-name");
});
