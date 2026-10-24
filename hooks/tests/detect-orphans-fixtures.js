'use strict';
// Fixtures for detect-orphans.js: a listener this session launched itself gets no "possibly a
// sibling's" note, and a restart of the same server on the same port with a new pid does not fire
// again.
// Run: node hooks/tests/detect-orphans-fixtures.js
//
// Every case runs the REAL hook over stdin with a sandboxed HOME/USERPROFILE (so the report goes to
// a fake ~/.claude, never the real orphan-report.txt) and a synthetic listener list handed in through
// DETECT_ORPHANS_LISTENERS_JSON, so no case reads the machine's ports. Process names, ports, pids,
// paths and script bodies are SYNTHETIC; they reproduce the shapes the hook must handle (a server
// started through a launcher script that then exits, restarted on the same port).
//
// DETECT_ORPHANS_HOOK points the suite at a staged copy; unset, it runs the hook next to tests/.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOOK = process.env.DETECT_ORPHANS_HOOK || path.join(__dirname, '..', 'detect-orphans.js');
const FAKEHOME = path.join(__dirname, '.fakehome-orphans');
const PROJ = path.join(FAKEHOME, 'proj');
const REPORT = path.join(FAKEHOME, '.claude', 'orphan-report.txt');
fs.mkdirSync(path.join(PROJ, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(FAKEHOME, '.claude'), { recursive: true });
fs.writeFileSync(path.join(PROJ, 'scripts', 'serve.ps1'),
  "Start-Process -FilePath .\\bin\\demo-server.exe -ArgumentList '--port 8080' -WindowStyle Hidden\n");
fs.writeFileSync(path.join(PROJ, 'scripts', 'lint.ps1'), "Write-Host 'nothing listens here'\n");

let pass = 0, fail = 0;
const lines = [];
function check(name, problems, note) {
  if (problems.length) { fail++; lines.push('FAIL  ' + name + '  [' + problems.join('; ') + ']'); }
  else { pass++; lines.push('PASS  ' + name + (note ? '  note="' + note.slice(0, 90) + '..."' : '')); }
}

const NEW = () => new Date(Date.now() + 60000).toISOString(); // after the transcript's birth
const OLD = () => new Date(Date.now() - 3600000).toISOString(); // before it
const shell = (name, command, extra) => ({ type: 'assistant', cwd: PROJ,
  message: { content: [{ type: 'tool_use', name, input: { command, ...extra } }] } });

// One hook run: a fresh transcript file (unique name, so NTFS tunneling cannot hand it an old
// birthtime) holding the given records, and the given listener list.
let seq = 0;
function fire(records, listeners, opts) {
  seq++;
  if (!(opts && opts.keepReport)) { try { fs.unlinkSync(REPORT); } catch (_) {} }
  const tp = path.join(PROJ, `t${seq}-${process.pid}.jsonl`);
  fs.writeFileSync(tp, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ transcript_path: tp, session_id: 'fixture0' + seq, hook_event_name: 'Stop' }),
    // opts.kill turns the kill path on. Safe only because the fake-listener seam makes the hook
    // record "would kill" instead of calling taskkill on the synthetic pids.
    env: { ...process.env, HOME: FAKEHOME, USERPROFILE: FAKEHOME,
      DETECT_ORPHANS_LISTENERS_JSON: JSON.stringify(listeners), CLAUDE_KILL_ORPHANS: opts && opts.kill ? '1' : '' },
    encoding: 'utf8',
    timeout: 10000,
  });
  let ctx = null;
  try { ctx = JSON.parse(res.stdout || 'null'); } catch (_) {}
  let report = '';
  try { report = fs.readFileSync(REPORT, 'utf8'); } catch (_) {}
  return {
    status: res.status,
    stderr: (res.stderr || '').trim(),
    note: (ctx && ctx.hookSpecificOutput && ctx.hookSpecificOutput.additionalContext) || '',
    report,
  };
}
function expect(name, r, opts) {
  const p = [];
  if (r.status !== 0) p.push('expected exit 0, got ' + r.status + ' stderr=' + r.stderr.slice(0, 80));
  for (const w of opts.want || []) if (!r.note.includes(w)) p.push('missing "' + w + '"');
  for (const d of opts.deny || []) if (r.note.includes(d)) p.push('unexpected "' + d + '"');
  for (const w of opts.reportWant || []) if (!r.report.includes(w)) p.push('report missing "' + w + '"');
  for (const d of opts.reportDeny || []) if (r.report.includes(d)) p.push('report has "' + d + '"');
  if (opts.silent && r.note) p.push('expected no note, got "' + r.note.slice(0, 70) + '"');
  check(name, p, r.note);
}

const demo = (pid, port) => ({ Port: port || 8080, ProcId: pid, Name: 'demo-server', Started: NEW(),
  Cmd: `"${PROJ}\\bin\\demo-server.exe" --config demo.toml --port ${port || 8080}` });
const nodeSrv = (pid, script) => ({ Port: 5173, ProcId: pid, Name: 'node', Started: NEW(),
  Cmd: `"C:\\Program Files\\nodejs\\node.exe" ${PROJ}\\${script}` });
const SIBLING = 'possibly by a sibling session';

// --- 1. launched here: no note, but the report still names it for /wrap's orphan check ----------
expect('1a Start-Process of a launcher script whose text starts the server -> silent',
  fire([shell('PowerShell', "Start-Process powershell -ArgumentList '-File', 'scripts\\serve.ps1'")], [demo(7101)]),
  { silent: true, reportWant: ['demo-server  port(s) 8080', 'launched by session'] });

expect('1b exe named directly in a run_in_background Bash call -> silent',
  fire([shell('Bash', './bin/demo-server.exe --port 8080', { run_in_background: true })], [demo(7102)]),
  { silent: true, reportWant: ['launched by session'] });

expect('1c Git Bash /c/ path to the launcher script resolves -> silent',
  fire([shell('Bash', `powershell -File ${PROJ.replace(/^([A-Za-z]):\\/, (m, d) => '/' + d.toLowerCase() + '/').replace(/\\/g, '/')}/scripts/serve.ps1`)],
    [demo(7103)]),
  { silent: true });

// --- 2. not launched here: the note stays --------------------------------------------------------
expect('2a same listener, transcript with no launch -> sibling note kept',
  fire([shell('PowerShell', 'git status --short')], [demo(7201)]),
  { want: ['demo-server pid 7201 on 8080', SIBLING, 'say in your reply why it stays'],
    reportWant: ['started during session'] });

expect('2b a script ran but its text does not start the server -> sibling note kept',
  fire([shell('PowerShell', '& .\\scripts\\lint.ps1')], [demo(7202)]),
  { want: [SIBLING] });

expect('2c the exe named only by a non-shell tool (Read) does not count -> sibling note kept',
  fire([{ type: 'assistant', cwd: PROJ, message: { content: [{ type: 'tool_use', name: 'Read',
    input: { file_path: PROJ + '\\bin\\demo-server.exe' } }] } }], [demo(7203)]),
  { want: [SIBLING] });

expect('2d a longer name containing the exe name is not a match -> sibling note kept',
  fire([shell('Bash', 'my-demo-server-wrapper --help')], [demo(7204)]),
  { want: [SIBLING] });

// --- 3. signature by name+ports, not pid ------------------------------------------------------
fire([shell('PowerShell', 'git status --short')], [demo(7301)]);
expect('3a restart of the same server on the same port (new pid) does not fire again',
  fire([shell('PowerShell', 'git status --short')], [demo(7302)], { keepReport: true }),
  { silent: true, reportWant: ['# sig demo-server:8080'], reportDeny: ['# sig 7302'] });

expect('3b same name on a different port is a change -> fires',
  fire([shell('PowerShell', 'git status --short')], [demo(7303, 8081)], { keepReport: true }),
  { want: ['demo-server pid 7303 on 8081', SIBLING] });

// --- 4. interpreters: the bare name is no evidence, the script it runs is -----------------------
expect('4a node server, session ran a different node script -> sibling note kept',
  fire([shell('Bash', 'node other.js')], [nodeSrv(7401, 'server.js')]),
  { want: ['node pid 7401 on 5173', SIBLING] });

expect('4b node server, session ran that script in the background -> silent',
  fire([shell('Bash', 'node server.js', { run_in_background: true })], [nodeSrv(7402, 'server.js')]),
  { silent: true });

expect('4c python with no script on its command line, session ran python -> sibling note kept',
  fire([shell('Bash', 'python -c "print(1)"')],
    [{ Port: 8000, ProcId: 7403, Name: 'python', Started: NEW(), Cmd: 'python.exe -m http.server 8000' }]),
  { want: ['python pid 7403 on 8000', SIBLING] });

// --- 5. mixed set: only the stray is named ---------------------------------------------------
expect('5a launched demo-server + stray node -> note names only the node pid',
  fire([shell('PowerShell', "Start-Process powershell -ArgumentList '-File', 'scripts\\serve.ps1'")],
    [demo(7501), nodeSrv(7502, 'server.js')]),
  { want: ['node pid 7502', SIBLING], deny: ['demo-server pid 7501'] });

// --- 6. unchanged paths --------------------------------------------------------------------
expect('6a every listener predates the session -> the "all predate" note',
  fire([shell('PowerShell', 'git status')], [{ ...demo(7601), Started: OLD() }]),
  { want: ['all predate this session'], deny: [SIBLING], reportWant: ['another session'] });

expect('6b no listeners -> silent, report says none',
  fire([], []),
  { silent: true, reportWant: ['no dev-server orphans detected'] });

expect('6c a non-dev listener (unknown name, non-dev port) is ignored',
  fire([], [{ Port: 7123, ProcId: 7603, Name: 'other-app', Started: NEW(), Cmd: 'other-app.exe' }]),
  { silent: true, reportWant: ['no dev-server orphans detected'] });

expect('6d no transcript at all -> launch unknown, sibling note kept (fail-safe direction)',
  (() => {
    try { fs.unlinkSync(REPORT); } catch (_) {}
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: 'fixturenone', hook_event_name: 'Stop' }),
      env: { ...process.env, HOME: FAKEHOME, USERPROFILE: FAKEHOME,
        DETECT_ORPHANS_LISTENERS_JSON: JSON.stringify([demo(7604)]), CLAUDE_KILL_ORPHANS: '' },
      encoding: 'utf8', timeout: 10000,
    });
    let ctx = null;
    try { ctx = JSON.parse(res.stdout || 'null'); } catch (_) {}
    return { status: res.status, stderr: res.stderr || '', report: '',
      note: (ctx && ctx.hookSpecificOutput && ctx.hookSpecificOutput.additionalContext) || '' };
  })(),
  { want: [SIBLING] });

// --- 7. CLAUDE_KILL_ORPHANS kills only what THIS session launched --------------------------------
// The old loop went over every found listener, so a sibling session's node server (7702, 7703)
// was on the kill list too. The report's "would kill" line is the observable kill list.
expect('7a kill on: only the launched JS server is on the kill list; strays, older and protected are not',
  fire([shell('Bash', 'node server.js', { run_in_background: true })], [
    nodeSrv(7701, 'server.js'),
    nodeSrv(7702, 'other.js'),
    { ...nodeSrv(7703, 'server.js'), Started: OLD() },
    { Port: 8000, ProcId: 7704, Name: 'python', Started: NEW(), Cmd: `python.exe ${PROJ}\\server.js` },
  ], { kill: true }),
  { reportWant: ['would kill (fake listeners): node(7701)', 'pid 7704  python  port(s) 8000', '[protected'],
    reportDeny: ['node(7702)', 'node(7703)', 'python(7704)'] });

expect('7b kill on, nothing this session launched -> nothing killed',
  fire([shell('PowerShell', 'git status')], [nodeSrv(7705, 'server.js')], { kill: true }),
  { reportWant: ['nothing killable that this session launched'], reportDeny: ['node(7705)'] });

// --- 8. only a LAUNCH shape counts, not any mention of the script ---------------------------------
// The previous check took any mention of the name as a launch, so a session that only read or
// staged server.js "launched" a sibling's later node server.js and, with the kill switch on, killed it.
expect('8a session only cat-ed and git-added the script -> not launched, not on the kill list',
  fire([shell('Bash', 'cat server.js'), shell('PowerShell', 'git add server.js; git status')],
    [nodeSrv(7801, 'server.js')], { kill: true }),
  { want: ['node pid 7801', SIBLING], reportWant: ['started during session', 'nothing killable that this session launched'],
    reportDeny: ['node(7801)'] });

expect('8b a FOREGROUND launch after cd counts -> launched, on the kill list',
  fire([shell('Bash', 'cd proj && node --inspect server.js')], [nodeSrv(7802, 'server.js')], { kill: true }),
  { silent: true, reportWant: ['launched by session', 'would kill (fake listeners): node(7802)'] });

expect('8c a launcher script that only MENTIONS the exe (a comment) does not count',
  (() => {
    fs.writeFileSync(path.join(PROJ, 'scripts', 'notes.ps1'), "# demo-server.exe is started by serve.ps1, not here\nWrite-Host 'hi'\n");
    return fire([shell('PowerShell', '& .\\scripts\\notes.ps1')], [demo(7803)]);
  })(),
  { want: [SIBLING] });

for (const l of lines) console.log(l);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
