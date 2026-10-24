'use strict';
// Fixtures for wf-concurrency.js. Run: node hooks/tests/wf-concurrency-fixtures.js (from the harness root)
//
// The hook has two whole-run gates and a third serial-phase gate; the point of the third is that a
// run can sit INSIDE both averages while half its wall clock is a two-agent tail, so the two
// whole-run gates need pinning too.
//
// Every case drives the REAL hook over stdin in hook mode under a sandboxed HOME, against a
// synthetic run.json in the workflows/ directory the hook derives from transcript_path. Hook mode
// is used rather than the standalone table because the note TEXT - the thing that reaches the
// model - exists only there.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'wf-concurrency.js');
// The workflow slot cap, computed HERE from the machine rather than read from the hook, so a hook
// that hardcodes it fails every note assertion below instead of agreeing with itself. Written out,
// not imported. The concurrency floor is an absolute 3 slots, so the fixed agent counts below hold
// on any core count.
const CAP = Math.min(16, Math.max(2, os.cpus().length - 2));
const FAKEHOME = path.join(__dirname, '.fakehome-wfc');
const SANDBOX = path.join(__dirname, '.fakeproj-wfc');

// PURGE both: the seen-ledger keys on session id and would silence every case on a second run.
for (const d of [FAKEHOME, SANDBOX]) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
}
fs.mkdirSync(path.join(FAKEHOME, '.claude'), { recursive: true });

const MIN = 60000;
let seq = 0;
let lastRunFile = '';

// agents: [{ phase, startMin, durMin, label }]
function runNote(agents, opts) {
  const o = opts || {};
  const tag = 'case' + (++seq);
  const dir = path.join(SANDBOX, tag);
  const wfDir = path.join(dir, 'sess', 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  const run = {
    runId: o.name || ('wf_' + tag),
    workflowName: o.name || ('wf_' + tag),
    status: 'completed',
    scriptPath: 'C:/x/' + tag + '.js',
    workflowProgress: agents.map((a, i) => ({
      type: 'workflow_agent',
      agentId: 'a' + i,
      label: a.label || ('agent' + i),
      phaseTitle: a.phase,
      startedAt: a.startMin * MIN,
      durationMs: a.durMin * MIN,
      toolCalls: a.calls || 10,
      tokens: 1000,
    })),
  };
  lastRunFile = path.join(wfDir, 'wf_' + tag + '.json');
  fs.writeFileSync(lastRunFile, JSON.stringify(run));

  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      session_id: 'wfc-' + tag,
      transcript_path: path.join(dir, 'sess.jsonl'),
    }),
    env: { ...process.env, HOME: FAKEHOME, USERPROFILE: FAKEHOME },
    encoding: 'utf8',
    timeout: 15000,
  });
  let ctx = null;
  try { ctx = JSON.parse(res.stdout || 'null'); } catch (_) {}
  return {
    status: res.status,
    note: (ctx && ctx.hookSpecificOutput && ctx.hookSpecificOutput.additionalContext) || '',
  };
}

let pass = 0, fail = 0;
const lines = [];
function T(name, r, opts) {
  const p = [];
  if (r.status !== 0) p.push('expected exit 0, got ' + r.status);
  for (const w of (opts.want || [])) if (!r.note.includes(w)) p.push('missing "' + w + '"');
  for (const w of (opts.wantNot || [])) if (r.note.includes(w)) p.push('unexpected "' + w + '"');
  if (opts.silent && r.note) p.push('expected no note, got "' + r.note.slice(0, 90) + '"');
  if (p.length) { fail++; lines.push('FAIL  ' + name + '  [' + p.join('; ') + ']'); }
  else { pass++; lines.push('PASS  ' + name); }
}

const par = (n, phase, durMin) => Array.from({ length: n }, () => ({ phase, startMin: 0, durMin }));

// --- 1. the serial-tail shape: inside BOTH old gates, a two-agent tail across a third of the run --------
// 5 agents in parallel for 0-40min, then Critic runs two agents back to back, 40-50 and 50-60.
// Computed: agentMs = 5*40 + 10 + 10 = 220 over a 60min run -> 3.7 slots, and 20 of 60min
// single-agent -> 33%. BOTH old gates are silent there (floors are 3.0 slots and 50%), which is
// what makes this the threshold pin and not merely a rule test.
const GAP_RUN = [
  ...par(5, 'Review', 40),
  { phase: 'Critic', startMin: 40, durMin: 10, label: 'critic:a' },
  { phase: 'Critic', startMin: 50, durMin: 10, label: 'critic:b' },
];
{
  const r = runNote(GAP_RUN, { name: 'gap-run' });
  T('1a the two OLD gates would have been silent - the note prints 3.7of<cap> and 33%',
    r, { want: ['3.7of' + CAP + ' slots', '33% single-agent'] });
  T('1b and the new clause fires anyway, naming the phase and its share',
    r, { want: ['serial tail "Critic"', '2 agent(s)', '20.0min', '33% of the run'] });
}

// --- 2. a well-packed run stays silent under all three -------------------------------------------
{
  T('2a six parallel agents, one phase: silent',
    runNote(par(6, 'Build', 30)), { silent: true });
}
{
  // The threshold's other side: a genuine two-agent phase, below the share floor. 6min of a 36min
  // run is 17%. If this fired, the gate would be "any narrow phase", not "a serial tail".
  T('2b a two-agent phase holding only 17% of the run does NOT fire',
    runNote([
      ...par(6, 'Build', 30),
      { phase: 'Gate', startMin: 30, durMin: 6 },
      { phase: 'Gate', startMin: 30, durMin: 6 },
    ]), { silent: true });
}

// --- 3. the old gates still work, unchanged -----------------------------------------------------
{
  // Four agents strictly back to back: 1.0 of <cap> slots, 100% single-agent. Both old gates fire.
  T('3a a fully serial run still fires on the old gates',
    runNote([
      { phase: 'A', startMin: 0, durMin: 15 },
      { phase: 'B', startMin: 15, durMin: 15 },
      { phase: 'C', startMin: 30, durMin: 15 },
      { phase: 'D', startMin: 45, durMin: 15 },
    ], { name: 'serial-run' }), { want: ['1.0of' + CAP + ' slots', '100% single-agent'] });
}
{
  // MIN_AGENTS is 3 and MIN_RUN_MS is 2 minutes: neither floor moved.
  T('3b a two-agent run is below MIN_AGENTS and says nothing',
    runNote([
      { phase: 'A', startMin: 0, durMin: 30 },
      { phase: 'B', startMin: 30, durMin: 30 },
    ]), { silent: true });
  T('3c a 90-second run is below MIN_RUN_MS and says nothing',
    runNote([
      { phase: 'A', startMin: 0, durMin: 0.5 },
      { phase: 'A', startMin: 0.5, durMin: 0.5 },
      { phase: 'B', startMin: 1, durMin: 0.5 },
    ]), { silent: true });
}

// --- 4. the conservative grouping rule ----------------------------------------------------------
{
  // No phaseTitle anywhere. All the agents group under ONE key, so there is no narrow phase and
  // the gate stays silent - it must NOT fall back to per-agent labels, which would make every long
  // agent its own "phase" and fire on runs the per-agent outlier clause already covers.
  const noPhase = GAP_RUN.map((a) => ({ startMin: a.startMin, durMin: a.durMin, label: a.label }));
  T('4a a run recording no phase titles never trips the serial gate',
    runNote(noPhase), { silent: true });
}
{
  // A single-agent phase counts (n <= 2), which is the straggler shape: one long critic alone at
  // the end of the run.
  T('4b a ONE-agent phase spanning a third of the run fires too',
    runNote([
      ...par(5, 'Review', 40),
      { phase: 'Judge', startMin: 40, durMin: 20, label: 'judge' },
    ]), { want: ['serial tail "Judge"', '1 agent(s)', '33% of the run'] });
}

// --- 4c. narrow but NOT starved ------------------------------------------------------------------
{
  // A shape the gate must not fire on: a 2-agent "Verify" phase spanning a third of the run WHILE
  // five other agents are live through the whole thing. The phase is narrow; the run is not
  // starved and never single-agent.
  T('4c a two-agent phase running INSIDE a busy window does not fire',
    runNote([
      ...par(5, 'Research', 30),
      { phase: 'Verify', startMin: 10, durMin: 10 },
      { phase: 'Verify', startMin: 10, durMin: 10 },
    ]), { silent: true });
}

// --- 5. the remedy sentence is still appended once ----------------------------------------------
{
  const r = runNote(GAP_RUN, { name: 'advice-run' });
  T('5a the note still ends in the one remedy sentence, not one per run',
    r, { want: ['two separate Workflow calls each get their own ' + CAP + ' slots'] });
}

// --- 6. long-agent check: threshold pinned from both sides -------------------------
// Six parallel agents keep the concurrency gates silent, so any note here is the long-agent one.
{
  const packed = (calls) => [0, 1, 2, 3, 4, 5].map((i) =>
    ({ phase: 'Build', startMin: 0, durMin: 30, label: 'build:' + i, calls: i === 0 ? calls : 10 }));
  T('6a an agent at 101 tool calls fires, naming it and its count',
    runNote(packed(101), { name: 'long-run' }),
    { want: ['wf-long-agent', 'long-run 1 agent(s)', '"build:0" 101 calls'] });
  T('6b an agent at exactly 100 tool calls stays silent (a 60 floor would have fired here)',
    runNote(packed(100)), { silent: true });
}

// --- 7. the slot cap is the live formula, not a constant -----------------------------------------
// The standalone table prints "concurrency X of <cap>". A hook still carrying a hardcoded constant
// prints the wrong cap on any machine where the formula gives another value, and fails here.
{
  runNote(GAP_RUN, { name: 'table-run' });
  const tbl = spawnSync(process.execPath, [HOOK, lastRunFile], {
    env: { ...process.env, HOME: FAKEHOME, USERPROFILE: FAKEHOME }, encoding: 'utf8', timeout: 15000,
  });
  T('7a the standalone table prints the cap computed from os.cpus(), not a constant',
    { status: tbl.status, note: tbl.stdout || '' }, { want: [' of ' + CAP + '  single-agent'] });
}
{
  // The floor stayed ABSOLUTE at 3 slots. Four parallel agents pack 4.0 slots; a floor derived
  // from the live cap (cap/2, e.g. 8 when the cap is 16) would flag this well-packed run.
  T('7b four parallel agents (4.0 slots) stay silent - the floor is not a fraction of the live cap',
    runNote(par(4, 'Build', 30)), { silent: true });
}

for (const d of [FAKEHOME, SANDBOX]) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
}
console.log(lines.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed of ' + (pass + fail) + ' cases');
process.exitCode = fail > 0 ? 1 : 0;
