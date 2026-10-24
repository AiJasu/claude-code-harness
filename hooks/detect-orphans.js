#!/usr/bin/env node
// SessionEnd hook: detect dev-server / port-binding processes that may have been left running.
//
// Makes the global CLAUDE.md "Process lifecycle" rule self-checking instead of something
// Claude has to remember: at session end it scans for listeners on common dev ports and for
// known dev-server process names, records a snapshot to ~/.claude/orphan-report.txt, and
// prints a one-line summary.
//
// DETECTION is the default and is non-destructive (it never kills the user's own long-running
// processes: long-running servers, long-running apps, databases, etc.). Killing is OPT-IN via env
// CLAUDE_KILL_ORPHANS=1, and even then only a conservative subset of JS dev servers (the things
// Claude actually spawns and forgets) that THIS session's own commands launched is killed --
// every other runtime is report-only, since a long-running process there is as likely to be
// deliberate as forgotten, and a sibling session's server is never this session's to kill.
// Windows only (listeners come from Get-NetTCPConnection); elsewhere it exits 0 silently. Fail-open.
//
// DELIVERY: the notice goes out as hookSpecificOutput.additionalContext on stdout (the one
// channel that reaches the model) with a stderr copy for the human. A stderr-only notice on
// exit 0 is user-display only and never reaches Claude.
// It also fires only when the orphan set CHANGES, and says which processes started during THIS
// session, so a notice means "you left this", not "something is listening somewhere".
//
// LAUNCHED HERE: a listener this session's own Bash/PowerShell calls started - the command names
// its exe or its script, or runs a launcher script whose text does - is recorded in the report
// (for /wrap's orphan check) but gets no note. This keeps a server the session started on purpose
// from drawing a note every turn, and keying the signature by name+ports (not pid) keeps a restart
// quiet.
// Fixtures: node hooks/tests/detect-orphans-fixtures.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPORT = path.join(os.homedir(), '.claude', 'orphan-report.txt');

// Dev ports commonly bound by spawned-and-forgotten servers (web dev servers, local tooling).
const DEV_PORTS = new Set([
  3000, 3001, 4000, 4173, 5000, 5173, 5174,
  8000, 8080, 8081, 8888, 9000, 9090,
]);
// Process names that signal a dev server/watcher (lowercased, no extension).
const DEV_NAMES = new Set([
  'node', 'vite', 'next', 'nodemon', 'webpack', 'esbuild', 'deno', 'bun',
  'ts-node', 'tsx', 'cargo', 'python',
]);
// Only these are safe to auto-kill when opted in -- JS dev servers Claude spawns. The other
// DEV_NAMES entries are detected and reported, never killed.
const KILLABLE = new Set([
  'node', 'vite', 'next', 'nodemon', 'webpack', 'esbuild', 'deno', 'bun', 'ts-node', 'tsx',
]);
// Interpreters and shells: a session names these in most commands, so the bare name is no
// evidence of a launch. Only the script the process runs (from its command line) counts.
const GENERIC = new Set([
  'node', 'python', 'python3', 'pythonw', 'py', 'bun', 'deno', 'cargo',
  'powershell', 'pwsh', 'cmd', 'java', 'dotnet',
]);

function listListeners() {
  // Fixture seam: the suite hands in the listener list instead of reading the live machine.
  if (process.env.DETECT_ORPHANS_LISTENERS_JSON) {
    const fake = JSON.parse(process.env.DETECT_ORPHANS_LISTENERS_JSON);
    return Array.isArray(fake) ? fake : [fake];
  }
  // Windows PowerShell 5.1 is always present; -NoProfile so a user profile never loads.
  // StartTime is what separates a process THIS session spawned from someone else's server;
  // the command line (one CIM query for all listener pids) is what ties it to a launch command.
  const ps = [
    '$l = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)',
    '$ids = @($l | ForEach-Object { [int]$_.OwningProcess } | Where-Object { $_ -gt 4 } | Sort-Object -Unique)',
    '$cmdLines = @{}',
    "if ($ids.Count) { Get-CimInstance Win32_Process -Filter (($ids | ForEach-Object { 'ProcessId=' + $_ }) -join ' OR ') " +
      '-ErrorAction SilentlyContinue | ForEach-Object { $cmdLines[[int]$_.ProcessId] = $_.CommandLine } }',
    '$l | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; ' +
      '[PSCustomObject]@{ Port = $_.LocalPort; ProcId = $_.OwningProcess; Name = $p.ProcessName; ' +
      "Started = $(try { $p.StartTime.ToString('o') } catch { $null }); Cmd = $cmdLines[[int]$_.OwningProcess] } } | " +
      'ConvertTo-Json -Compress',
  ].join('; ');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true,
  });
  if (!out || !out.trim()) return [];
  let parsed = JSON.parse(out);
  if (!Array.isArray(parsed)) parsed = [parsed];
  return parsed;
}

if (process.platform !== 'win32' && !process.env.DETECT_ORPHANS_LISTENERS_JSON) process.exit(0);

// This session's start time: anything already listening before it belongs to someone else.
// The transcript file is created when the session starts, so its birthtime is the marker.
let payload = {};
try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (_) {}
const SESSION = String(payload.session_id || '').slice(0, 8) || 'unknown';
let sessionStart = 0;
try {
  const st = fs.statSync(payload.transcript_path);
  sessionStart = st.birthtimeMs || st.ctimeMs || 0;
} catch (_) {}

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// The name as a whole word: demo-server matches "demo-server.exe" and "\demo-server",
// not "my-demo-server"; server.js matches "C:\p\server.js", not "myserver.js".
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (s) => new RegExp('(^|[^\\w.-])' + esc(s) + '(?![\\w-])', 'i');
const SCRIPT_RE = /[^\s'"`;|&<>(),=]+\.(?:ps1|psm1|bat|cmd|sh|py|js|mjs|cjs|ts)\b/gi;
const scriptTokens = (s) => String(s || '').match(SCRIPT_RE) || [];

// Every Bash/PowerShell command this session ran (background ones included), with its cwd.
// Read lazily: only a listener that started after the session began needs it.
let shellCalls = null;
function sessionShellCalls() {
  if (shellCalls) return shellCalls;
  shellCalls = [];
  let text = '';
  try { text = fs.readFileSync(payload.transcript_path, 'utf8'); } catch (_) { return shellCalls; }
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    const content = rec && rec.type === 'assistant' && rec.message && rec.message.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c && c.type === 'tool_use' && (c.name === 'Bash' || c.name === 'PowerShell') &&
          c.input && typeof c.input.command === 'string') {
        shellCalls.push({ command: c.input.command, cwd: rec.cwd || '', background: !!c.input.run_in_background });
      }
    }
  }
  return shellCalls;
}

// Text of a script a session command ran (start-all.ps1, serve.py), so a launcher that starts
// the server indirectly still ties it to this session. Git Bash /c/... paths are mapped back.
const scriptCache = new Map();
function scriptText(token, cwd) {
  let p = token.replace(/^\/([a-z])\//i, '$1:/');
  p = path.resolve(cwd || '.', p);
  if (scriptCache.has(p)) return scriptCache.get(p);
  let text = null;
  if (scriptCache.size < 50) {
    try { if (fs.statSync(p).size < 512 * 1024) text = fs.readFileSync(p, 'utf8'); } catch (_) {}
  }
  scriptCache.set(p, text);
  return text;
}

// Words that run the next script or exe (`node server.js`, `Start-Process -FilePath x.exe`).
const LAUNCHERS = new Set([
  'node', 'nodejs', 'npx', 'npm', 'pnpm', 'yarn', 'deno', 'bun', 'bunx', 'run', 'exec', 'python',
  'python3', 'pythonw', 'py', 'uv', 'tsx', 'ts-node', 'nodemon', 'bash', 'sh', 'powershell', 'pwsh',
  'cmd', 'start-process', 'saps', 'start', 'call', 'nohup', '&', '.',
]);
// A name in LAUNCH position in some command segment: the first word, or preceded only by launcher
// words, flags and X=Y prefixes. A mere mention (cat server.js, git add server.js) is no launch:
// with CLAUDE_KILL_ORPHANS on, counting one would kill a sibling session's server.
function launches(text, re) {
  for (const seg of String(text).split(/&&|\|\||[;|\r\n]/)) {
    const words = seg.trim().split(/\s+/);
    const i = words.findIndex((w) => re.test(w));
    if (i < 0) continue;
    const ok = words.slice(0, i).every((w) => {
      const t = w.replace(/^['"(]+|['",)]+$/g, '').toLowerCase();
      return !t || t.startsWith('-') || /^\w+=/.test(t) || LAUNCHERS.has(path.win32.basename(t).replace(/\.exe$/, ''));
    });
    if (ok) return true;
  }
  return false;
}

function launchedHere(p) {
  try {
    const calls = sessionShellCalls();
    if (!calls.length) return false;
    const res = scriptTokens(p.cmd).map((t) => wordRe(path.win32.basename(t)));
    if (!GENERIC.has(p.name)) res.push(wordRe(p.name));
    if (!res.length) return false;
    for (const c of calls) {
      // A run_in_background call is itself a launch, so any mention of the name there counts.
      if (res.some((r) => (c.background ? r.test(c.command) : launches(c.command, r)))) return true;
      for (const tok of scriptTokens(c.command)) {
        if (!c.background && !launches(c.command, wordRe(path.win32.basename(tok)))) continue;
        const text = scriptText(tok, c.cwd);
        if (text && res.some((r) => launches(text, r))) return true;
      }
    }
  } catch (_) {}
  return false;
}

try {
  const listeners = listListeners();
  const seen = new Map(); // pid -> { pid, name, started, cmd, ports:Set }
  for (const l of listeners) {
    const name = (l.Name || '').toLowerCase();
    const port = Number(l.Port);
    const pid = Number(l.ProcId);
    if (!pid) continue;
    const isDev = DEV_NAMES.has(name) || DEV_PORTS.has(port);
    if (!isDev) continue;
    if (!seen.has(pid)) {
      seen.set(pid, { pid, name, started: Date.parse(l.Started || '') || 0, cmd: l.Cmd || '', ports: new Set() });
    }
    seen.get(pid).ports.add(port);
  }

  const found = [...seen.values()];
  const stamp = new Date().toISOString();

  if (!found.length) {
    fs.writeFileSync(REPORT, `[${stamp}] no dev-server orphans detected at session end.\n`);
    process.exit(0);
  }

  const kill = /^(1|true|yes)$/i.test(process.env.CLAUDE_KILL_ORPHANS || '');
  const mine = (p) => !sessionStart || !p.started || p.started >= sessionStart;
  const launched = new Set(found.filter((p) => mine(p) && launchedHere(p)));
  const portList = (p) => [...p.ports].sort((a, b) => a - b).join(',');
  const lines = found.map((p) => {
    const killable = KILLABLE.has(p.name);
    const owner = !mine(p) ? 'another session'
      : launched.has(p) ? `launched by session ${SESSION}` : `started during session ${SESSION}`;
    return `  pid ${p.pid}  ${p.name}  port(s) ${portList(p)}  since ${p.started ? hhmm(p.started) : '?'} ` +
      `(${owner})${killable ? '' : '  [protected - not auto-killed]'}`;
  });

  let killedNote = '';
  if (kill) {
    // Fixture listeners carry synthetic pids that may belong to real processes: never taskkill
    // them, only record what would have been killed.
    const fake = !!process.env.DETECT_ORPHANS_LISTENERS_JSON;
    const killed = [];
    for (const p of found) {
      if (!launched.has(p) || !KILLABLE.has(p.name)) continue;
      try {
        if (!fake) execFileSync('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { timeout: 5000, windowsHide: true });
        killed.push(`${p.name}(${p.pid})`);
      } catch (_) { /* already gone or access denied */ }
    }
    killedNote = killed.length
      ? `\nCLAUDE_KILL_ORPHANS on -> ${fake ? 'would kill (fake listeners)' : 'killed'}: ${killed.join(', ')}`
      : `\nCLAUDE_KILL_ORPHANS on -> nothing killable that this session launched.`;
  } else {
    killedNote = `\n(detection only; set CLAUDE_KILL_ORPHANS=1 to auto-kill the JS dev servers this session launched.)`;
  }

  // Signature of the current orphan set: fire only on a state CHANGE, not every turn
  // (a notice that repeats unchanged trains the reader to ignore it). Keyed by name+ports,
  // not pid, so a restart of the same server on the same port is not a change.
  const sig = [...new Set(found.map((p) => `${p.name}:${portList(p).replace(/,/g, '+')}`))].sort().join(',');
  let prevSig = '';
  try { prevSig = (/^# sig (.*)$/m.exec(fs.readFileSync(REPORT, 'utf8')) || [])[1] || ''; } catch (_) {}

  fs.writeFileSync(REPORT,
    `# sig ${sig}\n[${stamp}] possible dev-server orphans still listening:\n${lines.join('\n')}${killedNote}\n`);
  if (sig === prevSig) process.exit(0);

  // The payload goes IN the message, not behind a filename, and only for processes this
  // session could have started - a listener older than the session belongs to someone else.
  // One this session launched itself is in the report above and needs no note.
  const ours = found.filter(mine);
  const strays = ours.filter((p) => !launched.has(p));
  if (ours.length && !strays.length) process.exit(0);
  const say = (strays.length ? strays : found).slice(0, 3).map((p) =>
    `${p.name} pid ${p.pid} on ${portList(p)}` + (p.started ? ` since ${hhmm(p.started)}` : '')).join('; ');
  const msg = strays.length
    ? `detect-orphans: ${say} - started after this session (${SESSION}) began, but no shell command in ` +
      'its transcript launched it, so possibly by a sibling session. Kill only a pid your own tool output ' +
      'shows you launched - auto mode blocks killing a job this session did not create - before closing, ' +
      'or say in your reply why it stays.'
    : `detect-orphans: ${say} - all predate this session, so they belong to another session; ` +
      'nothing to clean up here.';
  // additionalContext on stdout is the ONE channel that reaches the model; the stderr copy is
  // for the human. A hook that wants Claude to act cannot speak on stderr alone.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: payload.hook_event_name || 'Stop', additionalContext: msg },
  }));
  process.stderr.write(msg + '\n');
} catch (_) {
  // fail-open: never block session teardown
}
process.exit(0);
