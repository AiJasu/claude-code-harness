'use strict';
// Fixtures for pre-compact-guidance.js. Run:
//   node hooks/tests/pre-compact-guidance-fixtures.js
//
// The hook's whole value is that it speaks into an AUTOMATIC compaction and stays out of a typed
// one, so the trigger branch is what this pins hardest - a version that spoke on "manual" would
// append standing text after whatever the user typed, every time they compacted by hand.
//
// It also pins the two failure modes that would be invisible in use: a JSON wrapper reaching the
// summarizer as literal text (PreCompact reads raw stdout, not additionalContext), and any exit
// path other than 0 - a blocking PreCompact hook leaves the session UNCOMPACTED at a threshold
// where the window is already full.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'pre-compact-guidance.js');
const SANDBOX = path.join(__dirname, '.fakeproj-pcg');

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}

let seq = 0;
function project(withHandoff) {
  const dir = path.join(SANDBOX, 'p' + (++seq));
  fs.mkdirSync(dir, { recursive: true });
  if (withHandoff) fs.writeFileSync(path.join(dir, 'HANDOFF.md'), '# Handoff\n\n## Aim\nsomething\n');
  return dir;
}

function run(payload, input) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: input !== undefined ? input : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
  });
  return { status: res.status, out: res.stdout || '', err: res.stderr || '' };
}

let pass = 0, fail = 0;
const out = [];
function T(name, r, opts) {
  const o = opts || {};
  const p = [];
  if (r.status !== 0) p.push('expected exit 0, got ' + r.status);
  if (r.err && r.err.trim()) p.push('wrote to stderr: ' + r.err.trim().slice(0, 60));
  for (const w of (o.want || [])) if (!r.out.includes(w)) p.push('missing "' + w + '"');
  for (const w of (o.wantNot || [])) if (r.out.includes(w)) p.push('unexpected "' + w + '"');
  if (o.silent && r.out.trim()) p.push('expected silence, emitted ' + r.out.length + ' chars');
  if (p.length) { fail++; out.push('FAIL  ' + name + '  [' + p.join('; ') + ']'); }
  else { pass++; out.push('PASS  ' + name); }
}

const AUTO = 'This compaction is AUTOMATIC';
const KEEP = 'PRESERVE:';
const DROP = 'DROP:';

// --- 1. the trigger branch, both sides ----------------------------------------------------------
{
  const dir = project(false);
  T('1a trigger "auto" emits the standing instructions',
    run({ hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null, cwd: dir }),
    { want: [AUTO, KEEP, DROP, 'immediate next action'] });
  // The pin that matters: a typed /compact carries the user's own instructions (or is a bare one
  // they chose), and this text would be concatenated onto theirs. Silence is the whole point.
  T('1b trigger "manual" is silent - a typed /compact is never overridden',
    run({ hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: 'keep the numbers', cwd: dir }),
    { silent: true });
  T('1c a missing trigger is treated as manual, not auto',
    run({ hook_event_name: 'PreCompact', cwd: dir }), { silent: true });
  T('1d an unknown trigger value is treated as manual',
    run({ hook_event_name: 'PreCompact', trigger: 'refusal', cwd: dir }), { silent: true });
  // Documents the decision rather than assuming the CLI never does this: if an auto compaction
  // ever arrives carrying instructions, ours are appended after them, not suppressed.
  T('1e auto still speaks when custom_instructions is already populated',
    run({ hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: 'keep the sha', cwd: dir }),
    { want: [AUTO, KEEP] });
}

// --- 2. the durable-record pointer --------------------------------------------------------------
{
  const withH = project(true);
  const r = run({ hook_event_name: 'PreCompact', trigger: 'auto', cwd: withH });
  T('2a a project with a HANDOFF.md gets its absolute path named in the DROP list',
    r, { want: [withH.replace(/\\/g, '/') + '/HANDOFF.md', 'name the file instead of repeating it'] });
  T('2b a project without one falls back to generic wording, not a path that does not exist',
    run({ hook_event_name: 'PreCompact', trigger: 'auto', cwd: project(false) }),
    { want: ['a durable notes file in the project'], wantNot: ['HANDOFF.md'] });
}

// --- 3. the channel: raw text, never a JSON envelope --------------------------------------------
{
  const r = run({ hook_event_name: 'PreCompact', trigger: 'auto', cwd: project(false) });
  // PreCompact takes the hook's trimmed STDOUT as the custom instructions. A hookSpecificOutput
  // wrapper - the contract every other hook here uses - would be injected into the summarizer
  // prompt as literal JSON.
  T('3a stdout carries no JSON envelope',
    r, { wantNot: ['hookSpecificOutput', 'additionalContext', '{"'] });
  T('3b output is plain ASCII',
    { status: 0, out: /^[\x00-\x7F]*$/.test(r.out) ? 'ascii' : 'non-ascii at ' + r.out.search(/[^\x00-\x7F]/) },
    { want: ['ascii'] });
  T('3c the emission stays under the hook\'s own 4000-char cap',
    { status: 0, out: r.out.length <= 4000 ? 'ok' : 'emitted ' + r.out.length + ' chars' },
    { want: ['ok'] });
}

// --- 4. it can never block a compaction ---------------------------------------------------------
// A PreCompact hook that exits non-zero or writes stderr can leave the session uncompacted at the
// exact moment the window is full. Every malformed input still has to exit 0 and say nothing.
T('4a empty stdin exits 0 and is silent', run(null, ''), { silent: true });
T('4b non-JSON stdin exits 0 and is silent', run(null, 'not json at all'), { silent: true });
T('4c a JSON array instead of an object exits 0 and is silent', run(null, '[1,2,3]'), { silent: true });
T('4d "null" on stdin exits 0 and is silent', run(null, 'null'), { silent: true });
T('4e auto with a cwd that does not exist still emits, with the generic pointer',
  run({ hook_event_name: 'PreCompact', trigger: 'auto', cwd: 'C:/nope/does/not/exist' }),
  { want: [AUTO, 'a durable notes file in the project'] });
T('4f auto with no cwd at all still emits',
  run({ hook_event_name: 'PreCompact', trigger: 'auto' }), { want: [AUTO, KEEP] });

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed of ' + (pass + fail) + ' cases');
process.exitCode = fail > 0 ? 1 : 0;
