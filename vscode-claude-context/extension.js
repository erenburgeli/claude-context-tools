const vscode = require("vscode");
const reader = require("./lib/reader");

const cfg = () => vscode.workspace.getConfiguration("claudeContext");

/** Label of the focused editor tab if it is a webview (a Claude panel is one), else "". */
function activeTabLabel() {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return tab && tab.input instanceof vscode.TabInputWebview ? tab.label : "";
}

async function collect() {
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const live = await reader.liveSessions({ includeTerminal: cfg().get("includeTerminalSessions") });
  const snaps = await Promise.all(live.map((s) => reader.snapshot(s).catch(() => null)));
  // The tab label is the session title, so that is how a card is tied to the focused tab.
  const focused = activeTabLabel();
  return snaps
    .filter((s) => s && (cfg().get("showAllWorkspaces") || !folders.length || reader.inWorkspace(s.cwd, folders)))
    .map((s) => ({ ...s, active: !!focused && s.title === focused }))
    .sort((a, b) => b.active - a.active || b.lastActive - a.lastActive);
}

/** One-line text for the status bar, most important pieces first. */
function barText(s) {
  return `$(hubot) ${s.model}${s.effort ? ` · ${s.effort}` : ""}  $(pulse) ${s.pct}%/${s.window / 1000}k` +
    (s.agents ? `  $(organization) ${s.agents}` : "");
}

function tooltip(s) {
  return [s.title, `${s.dir}${s.git ? `  (${s.git})` : ""}`, `context ${s.tokens.toLocaleString()} / ${s.window.toLocaleString()} tokens`,
    `session ${reader.duration(s.started)}`, s.aws && `AWS ${s.aws}`, s.version && `Claude v${s.version}`]
    .filter(Boolean).join("\n");
}

class SessionsView {
  constructor() { this.view = undefined; this.latest = []; }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    view.webview.onDidReceiveMessage((m) => m.ready && this.push());
    view.onDidChangeVisibility(() => view.visible && this.push());
  }
  update(sessions) { this.latest = sessions; this.push(); }
  push() {
    if (this.view && this.view.visible) this.view.webview.postMessage({ sessions: this.latest, now: Date.now() });
  }
}

function html() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:8px}
.card{border:1px solid var(--vscode-panel-border);border-radius:4px;padding:6px 8px;margin-bottom:6px}
.card.active{border:1px solid var(--vscode-focusBorder);border-left:5px solid var(--vscode-focusBorder);background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);box-shadow:0 0 0 1px var(--vscode-focusBorder)}
.card.active .dim{color:inherit;opacity:.85}
.badge{float:right;margin-left:6px;padding:0 6px;border-radius:8px;font-size:.75em;font-weight:700;letter-spacing:.04em;background:var(--vscode-focusBorder);color:var(--vscode-editor-background)}
.head{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dim{color:var(--vscode-descriptionForeground)}
.row{display:flex;justify-content:space-between;gap:8px;margin-top:2px;font-size:.9em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ctx{display:flex;align-items:center;gap:6px;margin-top:4px;font-size:.9em}
.bar{flex:1;height:4px;background:var(--vscode-input-background);border-radius:2px;position:relative}
.fill{position:absolute;left:0;top:0;height:4px;border-radius:2px;background:var(--vscode-progressBar-background)}
.warn .fill{background:var(--vscode-editorWarning-foreground)}.crit .fill{background:var(--vscode-editorError-foreground)}
</style></head><body><div id="root" class="dim">No Claude Code session in this window.</div><script>
const vscode=acquireVsCodeApi();
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function dur(start,now){const s=start?Math.floor((now-start)/1000):0,h=Math.floor(s/3600),m=Math.floor(s%3600/60);
 if(h>=48)return Math.floor(h/24)+"d"+h%24+"h";return h?h+"h"+m+"m":m+"m"+String(s%60).padStart(2,"0")+"s"}
window.addEventListener("message",({data:{sessions,now}})=>{
 document.getElementById("root").className="";
 document.getElementById("root").innerHTML=sessions.length?sessions.map(s=>{
  const lvl=s.pct>=90?"crit":s.pct>=70?"warn":"";
  return '<div class="card '+(s.active?"active":"")+'" title="'+esc(Math.round(s.tokens/1000)+'k / '+s.window/1000+'k tokens')+'">'
  +'<div class="head">'+(s.active?'<span class="badge">THIS TAB</span>':"")+esc(s.title||s.dir)+'</div>'
  +'<div class="row dim"><span>'+esc(s.model)+(s.effort?' · '+esc(s.effort):"")+' · '+esc(s.dir)+(s.git?' · '+esc(s.git):"")+'</span></div>'
  +'<div class="ctx"><div class="bar '+lvl+'"><div class="fill" style="width:'+s.pct+'%"></div></div><span>'+s.pct+'%</span></div>'
  +'<div class="row dim"><span>'+dur(s.started,now)+(s.agents?' · '+s.agents+' agent'+(s.agents>1?"s":""):"")+'</span>'
  +'<span>'+(s.aws?esc(s.aws)+' · ':"")+(s.version?'v'+esc(s.version):"")+'</span></div></div>'}).join("")
  :'No Claude Code session in this window.';
 if(!sessions.length)document.getElementById("root").className="dim";
});
vscode.postMessage({ready:true});
</script></body></html>`;
}

function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  item.command = "claudeContext.focus";
  const view = new SessionsView();
  context.subscriptions.push(
    item,
    vscode.window.registerWebviewViewProvider("claudeContext.sessions", view),
    vscode.commands.registerCommand("claudeContext.focus", () => vscode.commands.executeCommand("claudeContext.sessions.focus")),
  );

  let busy = false;
  const tick = async () => {
    if (busy) return; // a slow git/ps must not stack ticks
    busy = true;
    try {
      const sessions = await collect();
      view.update(sessions);
      if (sessions.length) {
        item.text = barText(sessions[0]);
        item.tooltip = tooltip(sessions[0]);
        item.show();
      } else {
        item.hide();
      }
    } finally {
      busy = false;
    }
  };

  let timer;
  const schedule = () => {
    clearInterval(timer);
    timer = setInterval(tick, Math.max(1, cfg().get("refreshSeconds")) * 1000);
  };
  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    vscode.window.tabGroups.onDidChangeTabs(() => tick()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => tick()),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("claudeContext") && (schedule(), tick())),
  );
  schedule();
  tick();
}

module.exports = { activate, deactivate() {} };
