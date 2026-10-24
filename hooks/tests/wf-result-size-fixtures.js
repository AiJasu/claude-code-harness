'use strict';
// Fixtures for the wf-result-size check in wf-concurrency.js, plus (section 7) the relaunch ledger.
// Run: node hooks/tests/wf-result-size-fixtures.js (from the harness root)
//
// Every case runs the REAL hook over stdin (a synthetic wf_*.json run file under a sandboxed
// HOME) and asserts the exact string that would reach the model on
// hookSpecificOutput.additionalContext - the one channel that does.
//
// Payload content in every fixture run file is SYNTHETIC FILLER - the check only depends on
// JSON.stringify(run.result).length, so filler proves the same thing report text would. The
// sizes below are synthetic round figures: two large positive results and one tiny negative one.
//
// HOOK is overridable so this suite can be pointed at a staged copy; unset, it resolves the
// normal way (the real hook next to this tests/ dir).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOOK = process.env.WF_CONCURRENCY_HOOK || path.join(__dirname, '..', 'wf-concurrency.js');
// The slot cap follows the core count; the section 7 packing figures derive from it.
const { SLOT_CAP } = require(HOOK);
const FAKEHOME = path.join(__dirname, '.fakehome-wrs');
const PROJ = path.join(FAKEHOME, 'proj');
fs.mkdirSync(PROJ, { recursive: true });
// The hook's SEEN file lives at <home>/.claude/.wf-concurrency-seen.json and is written with a
// plain writeFileSync (no mkdir) - the parent dir must exist BEFORE the first call, or every
// write fails open (silently) and dedup across calls (case 6) can never be exercised.
fs.mkdirSync(path.join(FAKEHOME, '.claude'), { recursive: true });
try { fs.unlinkSync(path.join(FAKEHOME, '.claude', '.wf-concurrency-seen.json')); } catch (_) {}
try { fs.unlinkSync(path.join(FAKEHOME, '.claude', '.wf-slots-ledger.json')); } catch (_) {}

let pass = 0, fail = 0;
const lines = [];
function check(name, problems, note) {
  if (problems.length) { fail++; lines.push('FAIL  ' + name + '  [' + problems.join('; ') + ']'); }
  else { pass++; lines.push('PASS  ' + name + (note ? '  note="' + note.slice(0, 90) + '..."' : '')); }
}

// Writes ONE run file into a fresh session's workflows/ dir and fires the hook's Stop event for it.
// filler: a string of that exact length (synthetic, never real content).
let seq = 0;
function fireRun(sessionId, run) {
  seq++;
  const sid = sessionId + '-' + seq;
  const dir = path.join(PROJ, sid, 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'wf_test.json'), JSON.stringify(run));
  fs.writeFileSync(path.join(PROJ, sid + '.jsonl'), '');
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ transcript_path: path.join(PROJ, sid + '.jsonl'), session_id: sid }),
    env: { ...process.env, HOME: FAKEHOME, USERPROFILE: FAKEHOME },
    encoding: 'utf8',
    timeout: 10000,
  });
  let ctx = null;
  try { ctx = JSON.parse(res.stdout || 'null'); } catch (_) {}
  return {
    status: res.status,
    stderr: (res.stderr || '').trim(),
    note: (ctx && ctx.hookSpecificOutput && ctx.hookSpecificOutput.additionalContext) || '',
  };
}
function expect(name, r, opts) {
  const p = [];
  if (r.status !== 0) p.push('expected exit 0, got ' + r.status + ' stderr=' + r.stderr.slice(0, 80));
  for (const w of opts.want || []) if (!r.note.includes(w)) p.push('missing "' + w + '"');
  for (const d of opts.deny || []) if (r.note.includes(d)) p.push('unexpected "' + d + '"');
  if (opts.silent && r.note) p.push('expected no note, got "' + r.note.slice(0, 70) + '"');
  check(name, p, r.note);
}
const filler = (n) => 'x'.repeat(n);
const smallRun = (extra) => ({ status: 'completed', workflowName: 'w', result: { ok: true }, ...extra });

// --- 1. fires on an oversized result (synthetic sizes) ------------------------------------------
expect('1a fires at ~60k chars',
  fireRun('s1a', { status: 'completed', workflowName: 'big-report', result: { report: filler(60000) } }),
  { want: ['wf-result-size: big-report returned 60k chars', 'Over the 2000-char target'] });

expect('1b fires at ~100k chars',
  fireRun('s1b', { status: 'completed', workflowName: 'bigger-report', result: { report: filler(100000) } }),
  { want: ['wf-result-size: bigger-report returned 100k chars'] });

// --- 2. silent on a small result ----------------------------------------------------------------
expect('2a silent on a short summary object',
  fireRun('s2a', { status: 'completed', workflowName: 'small-summary', result: { items: 2, done: true } }),
  { deny: ['wf-result-size'] });

// --- 3. threshold pinned in both directions: > floor fires, at-floor does not -------------------
expect('3a exactly 2000 chars of JSON is silent (not-greater-than floor)',
  fireRun('s3a', { status: 'completed', workflowName: 'w', result: { s: filler(1992) } }), // JSON.stringify == 2000 chars exactly
  { deny: ['wf-result-size'] });
expect('3b 2001 chars fires (one over floor)',
  fireRun('s3b', { status: 'completed', workflowName: 'w', result: { s: filler(1993) } }), // JSON.stringify == 2001 chars
  { want: ['wf-result-size'] });

// --- 4. runs still in progress are never scored ---------------------------------------------------
expect('4a a "running" run is silent regardless of result size',
  fireRun('s4a', { status: 'running', workflowName: 'w', result: { s: filler(50000) } }),
  { silent: true });

// --- 5. combines with an existing concurrency-bad note without replacing it ---------------------
const bigAgents = Array.from({ length: 4 }, (_, i) => ({
  type: 'workflow_agent', startedAt: i * 600000, durationMs: 590000, label: 'a' + i, toolCalls: 5,
}));
expect('5a both notes present when a run is single-agent-slow AND returns a huge result',
  fireRun('s5a', { status: 'completed', workflowName: 'slow-and-huge', workflowProgress: bigAgents, result: { s: filler(20000) } }),
  { want: ['wf-concurrency: slow-and-huge', 'wf-result-size: slow-and-huge returned 20k chars'] });

// --- 6. a completed run is scored once; a second Stop for the same run file is silent -----------
{
  const dir = path.join(PROJ, 's6', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'wf_test.json'), JSON.stringify({ status: 'completed', workflowName: 'w', result: { s: filler(50000) } }));
  fs.writeFileSync(path.join(PROJ, 's6.jsonl'), '');
  const call = () => {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ transcript_path: path.join(PROJ, 's6.jsonl'), session_id: 's6' }),
      env: { ...process.env, HOME: FAKEHOME, USERPROFILE: FAKEHOME }, encoding: 'utf8', timeout: 10000,
    });
    let ctx = null;
    try { ctx = JSON.parse(res.stdout || 'null'); } catch (_) {}
    return (ctx && ctx.hookSpecificOutput && ctx.hookSpecificOutput.additionalContext) || '';
  };
  const first = call();
  const second = call();
  const p = [];
  if (!first.includes('wf-result-size')) p.push('expected the first Stop to fire, got "' + first.slice(0, 60) + '"');
  if (second) p.push('expected the second Stop on the same run file to be silent, got "' + second.slice(0, 60) + '"');
  check('6 a run file is scored once, not on every Stop', p, '');
}

// --- 7. relaunch ledger --------------------------------------------------------------------------
// wf-concurrency.js writes ~/.claude/.wf-slots-ledger.json for every completed run BEFORE the
// MIN_AGENTS/MIN_RUN_MS gate above, so model-routing-guard.js can quote a run's packing back at
// the NEXT launch of the same script even when that run was too small to ever earn a Stop note.
const LEDGER_PATH = path.join(FAKEHOME, '.claude', '.wf-slots-ledger.json');
function ledgerEntry(scriptPath) {
  let ledger = {};
  try { ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')) || {}; } catch (_) {}
  return ledger[scriptPath.replace(/\\/g, '/').toLowerCase()];
}

expect('7a a 1-agent run emits no wf-concurrency note (below report()\'s MIN_AGENTS floor)',
  fireRun('s7a', {
    status: 'completed', workflowName: 'solo-run',
    scriptPath: 'C:\\fake\\solo-run.js',
    workflowProgress: [{ type: 'workflow_agent', startedAt: 0, durationMs: 3000000, label: 'worker' }],
  }),
  { deny: ['wf-concurrency'] });
{
  const e = ledgerEntry('C:\\fake\\solo-run.js');
  const p = [];
  if (!e) p.push('no ledger entry written for the 1-agent run');
  else {
    if (e.agentCount !== 1) p.push('agentCount ' + e.agentCount + ' != 1');
    if (e.slots !== 1) p.push('slots ' + e.slots + ' != 1 (a solo run packs exactly one slot)');
    if (e.longestMin !== 50) p.push('longestMin ' + e.longestMin + ' != 50');
  }
  check('7b the same 1-agent run still writes a ledger entry (agentCount=1, slots=1, longest=50min)', p, e ? JSON.stringify(e) : '');
}

// well-packed: a full set of fully-overlapping agents (concurrency = the slot cap) - report()
// finds it acceptable (bad=false), so no wf-concurrency note, but the ledger still records it at
// the absolute 3-slot floor or better.
const wellPackedAgents = Array.from({ length: Math.max(3, SLOT_CAP) }, (_, i) => ({
  type: 'workflow_agent', startedAt: 0, durationMs: 600000, label: 'a' + i, toolCalls: 5,
}));
expect('7c a well-packed run is silent on wf-concurrency (acceptable packing)',
  fireRun('s7c', { status: 'completed', workflowName: 'well-packed', scriptPath: 'C:\\fake\\well-packed.js', workflowProgress: wellPackedAgents }),
  { deny: ['wf-concurrency'] });
{
  const e = ledgerEntry('C:\\fake\\well-packed.js');
  const p = [];
  if (!e) p.push('no ledger entry written for the well-packed run');
  else if (!(e.slots >= 3)) p.push('slots ' + e.slots + ' expected 3 or better (well-packed)');
  check('7d ledger entry for a well-packed run reads at least the 3-slot floor (the guard\'s silent case)', p, e ? JSON.stringify(e) : '');
}

// a still-running run is recorded by neither channel - report() and recordLedger() both gate on
// run.status, and a "running" run never reaches either.
expect('7e a running run is silent regardless of ledger data (regression of case 4a)',
  fireRun('s7e', { status: 'running', workflowName: 'w', scriptPath: 'C:\\fake\\still-running.js', workflowProgress: wellPackedAgents }),
  { silent: true });
{
  const e = ledgerEntry('C:\\fake\\still-running.js');
  check('7f a still-running run writes no ledger entry', e ? ['unexpected entry ' + JSON.stringify(e)] : [], '');
}

console.log(lines.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed of ' + (pass + fail) + ' cases');
try { fs.rmSync(FAKEHOME, { recursive: true, force: true }); } catch (_) {}
process.exitCode = fail > 0 ? 1 : 0;
