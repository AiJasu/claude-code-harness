'use strict';
// Fixtures for worktree-brief.js. Run:
//   node hooks/tests/worktree-brief-fixtures.js
//
// Two entry points share one text and one
// once-per-session ledger, so what has to be pinned is: the cwd test both ways, the PostToolUse
// matcher arm, the dedupe (a note that repeats is noise) and its re-delivery after a compaction,
// and that the brief still NAMES the six refusal shapes it exists to deliver. A brief that fires
// correctly but has lost a clause is the failure mode nothing else would catch.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'worktree-brief.js');
const SANDBOX = path.join(__dirname, '.fakehome-wb');

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

const LEDGER = path.join(SANDBOX, '.claude', '.worktree-brief.json');
function resetLedger() { try { fs.unlinkSync(LEDGER); } catch (_) {} }

// The module half, driven in a child so the sandboxed HOME applies to os.homedir().
function noteFor(cwd, sessionId, source) {
  const src = 'const m=require(' + JSON.stringify(HOOK) + ');' +
    'process.stdout.write(m.noteFor(' + JSON.stringify(cwd) + ',' + JSON.stringify(sessionId) + ',' + JSON.stringify(source) + '));';
  const res = spawnSync(process.execPath, ['-e', src], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, HOME: SANDBOX, USERPROFILE: SANDBOX },
  });
  return { status: res.status, out: res.stdout || '', err: res.stderr || '' };
}

// The PostToolUse half, driven as the hook the settings.json entry runs.
function hook(payload) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, HOME: SANDBOX, USERPROFILE: SANDBOX },
  });
  return { status: res.status, out: res.stdout || '', err: res.stderr || '' };
}

let pass = 0, fail = 0;
const out = [];
function T(name, got, opts) {
  const o = opts || {};
  const p = [];
  if (got.status !== 0) p.push('expected exit 0, got ' + got.status);
  if (got.err && got.err.trim()) p.push('wrote to stderr: ' + got.err.trim().slice(0, 60));
  for (const w of (o.want || [])) if (!got.out.includes(w)) p.push('missing "' + w + '"');
  for (const w of (o.wantNot || [])) if (got.out.includes(w)) p.push('unexpected "' + w + '"');
  if (o.silent && got.out.trim()) p.push('expected silence, emitted ' + got.out.length + ' chars');
  if (p.length) { fail++; out.push('FAIL  ' + name + '  [' + p.join('; ') + ']'); }
  else { pass++; out.push('PASS  ' + name); }
}

const MARK = 'WORKTREE SESSION:';
const WT = 'C:/Users/you/projects/app/.claude/worktrees/feature-x';

// --- 1. the cwd test, both sides ----------------------------------------------------------------
resetLedger();
T('1a a cwd inside .claude/worktrees gets the brief', noteFor(WT, 's1'), { want: [MARK] });
resetLedger();
T('1b a normal project cwd is silent',
  noteFor('C:/Users/you/projects/app', 's2'), { silent: true });
resetLedger();
T('1c a path merely CONTAINING the word worktree (no segment) is silent',
  noteFor('C:/Users/you/projects/worktree-notes', 's3'), { silent: true });
resetLedger();
T('1d a hand-made worktrees dir outside .claude still counts - the refusals are identical',
  noteFor('C:/repos/proj/worktrees/feature-x', 's4'), { want: [MARK] });
resetLedger();
T('1e an empty cwd is silent rather than throwing', noteFor('', 's5'), { silent: true });

// --- 2. once per session ------------------------------------------------------------------------
{
  resetLedger();
  T('2a first call in a session speaks', noteFor(WT, 'dup'), { want: [MARK] });
  T('2b second call in the SAME session is silent', noteFor(WT, 'dup'), { silent: true });
  T('2c a different session still gets it', noteFor(WT, 'other'), { want: [MARK] });
  // The two entry points share the ledger, so entering a worktree after a worktree-cwd start
  // does not deliver the same paragraph twice.
  T('2d the PostToolUse half is suppressed by the module half in the same session',
    hook({ tool_name: 'EnterWorktree', session_id: 'dup' }), { silent: true });
}

// --- 3. the PostToolUse arm ---------------------------------------------------------------------
{
  resetLedger();
  const r = hook({ tool_name: 'EnterWorktree', session_id: 'pt1', cwd: 'C:/Users/you/projects/app' });
  // cwd is still the PRE-call one on this event, so the tool name has to be what triggers it.
  T('3a EnterWorktree fires even though the payload cwd is not yet a worktree',
    r, { want: [MARK, '"hookEventName":"PostToolUse"', 'additionalContext'] });
  T('3b a different tool is silent',
    hook({ tool_name: 'Bash', session_id: 'pt2' }), { silent: true });
  T('3c ExitWorktree is silent', hook({ tool_name: 'ExitWorktree', session_id: 'pt3' }), { silent: true });
  T('3d empty stdin exits 0 and is silent', hook({}), { silent: true });
}

// --- 4. the brief still says the things it exists to say ----------------------------------------
{
  resetLedger();
  const r = noteFor(WT, 'content');
  T('4a it names the first five shapes that cost calls (6 has its own section)', r, {
    want: [
      'NAMES git',            // 1 - the lexical chain ban, including the npm flag
      '--no-git-tag-version',
      'run_in_background',    // 2 - a script behind a redirect
      'heredocs',             // 3 - heredocs / for loops / head / tail
      'PowerShell tool',      // 4 - a quoted-path command name
      'SIBLING worktree',     // 5 - sibling paths, read-only or not
    ],
  });
  T('4b it names the landing sequence and the CRLF trap',
    r, { want: ['ExitWorktree `keep`', 'merge --ff-only', 'CRLF'] });
  T('4c it says subagents inherit the ban',
    r, { want: ['Subagents inherit'] });
  T('4d output is plain ASCII',
    { status: 0, out: /^[\x00-\x7F]*$/.test(r.out) ? 'ascii' : 'non-ascii', err: '' }, { want: ['ascii'] });
  T('4e the brief stays a paragraph, not a long recipe',
    { status: 0, out: r.out.length < 1600 ? 'ok' : 'brief is ' + r.out.length + ' chars', err: '' },
    { want: ['ok'] });
}

// --- 5. the ledger is self-maintaining ----------------------------------------------------------
{
  resetLedger();
  noteFor(WT, 'gc-fresh');
  const data = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  data['gc-stale'] = Date.now() - 8 * 24 * 3600 * 1000;
  fs.writeFileSync(LEDGER, JSON.stringify(data));
  noteFor(WT, 'gc-trigger');
  const after = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  T('5a an entry older than the 7-day TTL is dropped',
    { status: 0, out: 'gc-stale' in after ? 'still there' : 'gone', err: '' }, { want: ['gone'] });
  T('5b a fresh entry survives the GC',
    { status: 0, out: 'gc-fresh' in after ? 'kept' : 'LOST', err: '' }, { want: ['kept'] });
  // A session whose id the payload did not carry must still be told, every time, rather than
  // silently deduped against a missing key.
  resetLedger();
  T('5c a null session id speaks', noteFor(WT, null), { want: [MARK] });
  T('5d and speaks again - no id means no dedupe, which beats never speaking',
    noteFor(WT, null), { want: [MARK] });
}

// --- 6. the sixth shape ---------------------------------------------------------------------------
// Shell arithmetic with a ${VAR:-x} default inside $(( )), and commands that name git in a form the
// tool calls too complex. Shape (5) is untouched.
{
  resetLedger();
  const r = noteFor(WT, 'six');
  T('6a the brief names shell arithmetic, the ${VAR:-x} default and $(...) beside git', r, {
    want: ['(6) shell arithmetic', '$(( ))', '${VAR:-x}', '$(...)', 'also names git', 'too complex', 'PowerShell tool'],
  });
  T('6b shape 5 is not widened: it still names the SIBLING worktree, not the main checkout', r, {
    want: ['SIBLING worktree\'s path'], wantNot: ['main checkout\'s path', 'ANY other checkout'],
  });
  T('6c it says six, not five', r, { want: ['The six that'], wantNot: ['The five'] });
}

// --- 7. re-delivery after a compaction ------------------------------------------------------------
// The ledger is once per session, but a compaction drops the first copy from context; the
// SessionStart that follows it carries source 'compact'. 7b is the pin: before this change the
// same call was silent.
{
  resetLedger();
  T('7a first call in the session speaks', noteFor(WT, 'cmp', 'startup'), { want: [MARK] });
  T('7b a compact-triggered SessionStart in the SAME session speaks again', noteFor(WT, 'cmp', 'compact'), { want: [MARK] });
  T('7c ... and a plain call right after it is silent again', noteFor(WT, 'cmp', 'startup'), { silent: true });
  T('7d a resume or clear start in the same session stays silent', noteFor(WT, 'cmp', 'resume'), { silent: true });
  T('7e a second compaction re-delivers once more', noteFor(WT, 'cmp', 'compact'), { want: [MARK] });
  T('7f a compact start outside any worktree is silent', noteFor('C:/Users/you/projects/app', 'cmp2', 'compact'), { silent: true });
  T('7g a compact start with no session id still speaks', noteFor(WT, null, 'compact'), { want: [MARK] });
}

// --- 8. through the real SessionStart dispatcher --------------------------------------------------
// Proves session-start.js actually passes its payload source to the module. HOME is the sandbox;
// the dispatcher's other steps (rules snapshot, guard-state GC, shell canary) write only there.
{
  const SS = path.join(__dirname, '..', 'session-start.js');
  function dispatcher(sessionId, source) {
    const res = spawnSync(process.execPath, [SS], {
      input: JSON.stringify({ session_id: sessionId, source, cwd: WT }),
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, HOME: SANDBOX, USERPROFILE: SANDBOX },
    });
    let note = '';
    try { note = JSON.parse(res.stdout || 'null').hookSpecificOutput.additionalContext || ''; } catch (_) {}
    return { status: res.status, out: note, err: '' };
  }
  resetLedger();
  T('8a dispatcher, fresh worktree session, source startup -> the brief', dispatcher('e2e', 'startup'), { want: [MARK, '(6) shell arithmetic'] });
  T('8b dispatcher, same session, source startup again -> silent', dispatcher('e2e', 'startup'), { wantNot: [MARK] });
  T('8c dispatcher, same session, source compact -> the brief again', dispatcher('e2e', 'compact'), { want: [MARK] });
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed of ' + (pass + fail) + ' cases');
process.exitCode = fail > 0 ? 1 : 0;
