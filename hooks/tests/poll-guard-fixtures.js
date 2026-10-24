'use strict';
// Fixtures for poll-guard.js - the warn-only nudge against re-reading an artifact that
// announces its own completion (running Workflow journal.jsonl, task .output, background
// build logs). Run: node hooks/tests/poll-guard-fixtures.js
//
// Every case runs the real HOOK over stdin and asserts the exact string the model receives on
// hookSpecificOutput.additionalContext - the one channel that reaches it. The hook is stateful,
// so the cases are SEQUENCES, not single calls; HOME is sandboxed so a run can never disturb a
// live session's counters.
//
// The window case injects timestamps by writing the state file directly (guard-test style) and
// pins the threshold in BOTH directions: the same two prior reads must be silent at 11 minutes
// and must fire at 2, or the case would go green without pinning anything.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'poll-guard.js');
const FAKEHOME = path.join(__dirname, '.fakehome-pg');
const STATE = path.join(FAKEHOME, '.claude', 'hooks', '.poll-guard-state.json');
fs.mkdirSync(path.dirname(STATE), { recursive: true });

const JOURNAL = 'C:/Users/you/.claude/tasks/wf_01/journal.jsonl';
const OUTPUT = 'C:/Users/you/.claude/tasks/task_01.output';
const BUILDLOG = 'C:/x/build.log';

function call(payload, rawInput) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: rawInput !== undefined ? rawInput : JSON.stringify(payload),
    env: { ...process.env, HOME: FAKEHOME, USERPROFILE: FAKEHOME },
    encoding: 'utf8',
    timeout: 10000,
  });
  let ctx = null;
  try { ctx = JSON.parse(res.stdout || 'null'); } catch (_) {}
  return {
    status: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    note: (ctx && ctx.hookSpecificOutput && ctx.hookSpecificOutput.additionalContext) || '',
  };
}
// The note needs POSITIVE evidence in the session transcript that the target is a backgrounded
// task's output. Sections 1-7 use this default transcript, which holds a launch record for each
// target they read (the wf_01 Workflow, task_01, build.log); section 8 pins the evidence gate
// itself with transcripts of its own. tp === null sends no transcript_path at all.
const rec = (type, content) => ({ type, message: { role: type, content } });
const launchUse = (command) => rec('assistant', [{ type: 'tool_use', id: 'tu_bg', name: 'Bash', input: { command, run_in_background: true } }]);
const syncUse = (command) => rec('assistant', [{ type: 'tool_use', id: 'tu_sync', name: 'Bash', input: { command } }]);
const result = (text) => rec('user', [{ type: 'tool_result', tool_use_id: 'tu_bg', content: text }]);
function transcript(name, recs) {
  const p = path.join(FAKEHOME, name + '.jsonl');
  fs.writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
const EVIDENCE = transcript('evidence', [
  result('Workflow launched in background. Task ID: wfa1\nTranscript dir: C:\\Users\\you\\.claude\\tasks\\wf_01'),
  result('Command running in background with ID: task_01. Output is being written to: C:\\Users\\you\\.claude\\tasks\\task_01.output. You will be notified when it completes.'),
  launchUse('npm run build > C:/x/build.log 2>&1'),
]);
const withTp = (tp) => (tp === undefined ? EVIDENCE : tp);
const bash = (sid, command, tp) => call({ tool_name: 'Bash', session_id: sid, transcript_path: withTp(tp), tool_input: { command } });
const pwsh = (sid, command, tp) => call({ tool_name: 'PowerShell', session_id: sid, transcript_path: withTp(tp), tool_input: { command } });
const read = (sid, file_path, tp) => call({ tool_name: 'Read', session_id: sid, transcript_path: withTp(tp), tool_input: { file_path } });

function reset() { try { fs.unlinkSync(STATE); } catch (_) {} }
function stateRaw() { try { return fs.readFileSync(STATE, 'utf8'); } catch (_) { return ''; } }
// Inject prior reads at a chosen age, the way the guard fixtures seed .guard-state.json.
function seed(sid, target, agesMin) {
  const now = Date.now();
  const key = String(target).replace(/\\/g, '/').toLowerCase();
  const all = {};
  all[sid] = { last: now, targets: {} };
  all[sid].targets[key] = agesMin.map((m) => now - m * 60000);
  fs.writeFileSync(STATE, JSON.stringify(all));
}

let pass = 0, fail = 0;
const lines = [];
function check(name, problems, note) {
  if (problems.length) { fail++; lines.push('FAIL  ' + name + '  [' + problems.join('; ') + ']'); }
  else { pass++; lines.push('PASS  ' + name + (note ? '  note="' + note.slice(0, 62) + '..."' : '')); }
}
// r: a call result. want/deny are substrings; silent asserts an empty note.
function expect(name, r, opts) {
  const p = [];
  if (r.status !== 0) p.push('expected exit 0, got ' + r.status + ' stderr=' + r.stderr.slice(0, 80));
  for (const w of opts.want || []) if (!r.note.includes(w)) p.push('missing "' + w + '"');
  for (const d of opts.deny || []) if (r.note.includes(d)) p.push('unexpected "' + d + '"');
  if (opts.silent && r.note) p.push('expected no note, got "' + r.note.slice(0, 70) + '"');
  check(name, p, r.note);
}

// --- 1. three tails of the same running-Workflow journal ---------------------------------------
reset();
const TAIL_J = 'tail -n 40 ' + JOURNAL;
expect('1a first tail of journal.jsonl is silent', bash('s1', TAIL_J), { silent: true });
expect('1b second tail of journal.jsonl is silent', bash('s1', TAIL_J), { silent: true });
expect('1c third tail of journal.jsonl emits the note', bash('s1', TAIL_J),
  { want: ['poll-guard: 3rd read of journal.jsonl', 'arm ONE Monitor', 'warn-only'] });
expect('1d fourth tail keeps counting', bash('s1', TAIL_J), { want: ['4th read of journal.jsonl'] });

// --- 2. a task .output read twice vs a build log read three times ------------------------------
reset();
expect('2a first Read of tasks/*.output is silent', read('s2', OUTPUT), { silent: true });
expect('2b second Read of tasks/*.output is still silent', read('s2', OUTPUT), { silent: true });
const GC = 'Get-Content -Tail 2 ' + BUILDLOG;
expect('2c first Get-Content of build.log is silent', pwsh('s2', GC), { silent: true });
expect('2d second Get-Content of build.log is silent', pwsh('s2', GC), { silent: true });
expect('2e third Get-Content of build.log emits, naming the LOG not the .output', pwsh('s2', GC),
  { want: ['3rd read of build.log'], deny: ['.output'] });

// --- 3. a command with no poll target: silent, and the state file is untouched -----------------
reset();
bash('s3', TAIL_J); // put something in the file so "unchanged" is a real assertion
const before = stateRaw();
const r3 = bash('s3', 'npm test');
const p3 = [];
if (r3.status !== 0) p3.push('expected exit 0, got ' + r3.status);
if (r3.note) p3.push('expected no note, got "' + r3.note.slice(0, 60) + '"');
if (stateRaw() !== before) p3.push('state file changed');
if (!before) p3.push('precondition: state file was never written');
check('3 no poll target -> silent and state unchanged', p3, '');
// A producer that WRITES a log is not a poll, however many times it runs.
reset();
const BUILD = 'npm run build > build.log 2>&1';
bash('s3b', BUILD); bash('s3b', BUILD);
expect('3b redirect into build.log is not a read', bash('s3b', BUILD), { silent: true });

// --- 4. malformed stdin fails open -------------------------------------------------------------
const r4 = call(null, 'not json {{{');
check('4 malformed stdin -> exit 0, no output',
  (r4.status !== 0 ? ['expected exit 0, got ' + r4.status] : []).concat(r4.stdout ? ['expected empty stdout, got "' + r4.stdout.slice(0, 60) + '"'] : []), '');

// --- 5. two sessions counted separately --------------------------------------------------------
reset();
bash('sA', TAIL_J); bash('sA', TAIL_J);
expect('5a a different session starts its own count', bash('sB', TAIL_J), { silent: true });
expect('5b session A reaches 3 on its own reads', bash('sA', TAIL_J), { want: ['3rd read of journal.jsonl'] });
expect('5c session B is still only at 2', bash('sB', TAIL_J), { silent: true });
let keys = [];
try { keys = Object.keys(JSON.parse(stateRaw())); } catch (_) {}
check('5d state is session-keyed',
  (keys.includes('sA') && keys.includes('sB')) ? [] : ['expected sA and sB keys, got ' + JSON.stringify(keys)], '');

// --- 6. the 10-minute window, pinned in both directions ----------------------------------------
reset();
seed('s6', JOURNAL, [11, 12]); // retained (under 15 min) but outside the counting window
expect('6a two reads 11+ min ago do not count', bash('s6', TAIL_J), { silent: true });
reset();
seed('s6', JOURNAL, [2, 3]); // same two reads, inside the window -> this one is the 3rd
expect('6b the same two reads 2-3 min ago DO count', bash('s6', TAIL_J),
  { want: ['3rd read of journal.jsonl', 'in 3 min'] });

// --- 7. MENTION-ONLY: naming the path is not reading it ----------------------------------------
// An unanchored /journal\.jsonl/ would match a whole JSON payload that merely quotes such a
// path, and the blob would become the state key. Anchoring the pattern to the END of a
// path-shaped token is what this case pins.
reset();
const BLOB = 'node poll-guard.js --input \'{"tool_input":{"command":"tail C:/x/tasks/wf/journal.jsonl"}}\'';
bash('s7', BLOB); bash('s7', BLOB);
expect('7a a JSON blob quoting the path is not a read', bash('s7', BLOB), { silent: true });
const p7 = [];
let keys7 = [];
try { keys7 = Object.keys((JSON.parse(stateRaw()).s7 || { targets: {} }).targets); } catch (_) {}
if (keys7.length) p7.push('expected no target keys, got ' + JSON.stringify(keys7).slice(0, 90));
check('7b the blob never becomes a state key', p7, '');
// The same path as a bare argument still counts, or 7a would be pinning nothing.
reset();
bash('s7b', TAIL_J); bash('s7b', TAIL_J);
expect('7c the same path as a real argument DOES count', bash('s7b', TAIL_J),
  { want: ['3rd read of journal.jsonl'] });

// --- 8. EVIDENCE GATE: the repeated-read note speaks only for a backgrounded task -------------
// Cases 8a/8b are the two TRUE shapes (a run_in_background launch that redirects to a log; an
// auto-backgrounded timeout whose .output is read); 8c is the FALSE shape a count-only rule notes
// on, and 8c-pin proves it: the same input through a copy of the hook with the evidence gate cut
// out DOES fire, so the case pins the change and not just the new behavior.
const BG_JOB = 'node scripts/job.js > scripts/out/job.log 2>&1';
const TAIL_JOB = 'tail -n 5 scripts/out/job.log';
const AUTO_OUT = 'C:/Users/you/AppData/Local/Temp/claude/proj/sess1/tasks/task_auto7.output';
const T8A = transcript('t8a', [launchUse(BG_JOB), result('Command running in background with ID: task_bg1. Output is being written to: C:\\Users\\you\\AppData\\Local\\Temp\\claude\\proj\\sess1\\tasks\\task_bg1.output. You will be notified when it completes.')]);
const T8B = transcript('t8b', [syncUse('node scripts/slow.js'), result('Command did not complete within its 120s timeout and was moved to the background (ID: task_auto7). Output is being written to: C:\\Users\\you\\AppData\\Local\\Temp\\claude\\proj\\sess1\\tasks\\task_auto7.output. You will be notified when it completes.')]);
const T8C = transcript('t8c', [syncUse('node scripts/dryrun.js > scripts/out/dryrun.log 2>&1'), result('exit 0')]);
reset();
bash('s8a', TAIL_JOB, T8A); bash('s8a', TAIL_JOB, T8A);
expect('8a 3rd tail of a log the session launched with run_in_background emits',
  bash('s8a', TAIL_JOB, T8A), { want: ['poll-guard: 3rd read of job.log', 'warn-only'] });
reset();
read('s8b', AUTO_OUT, T8B); read('s8b', AUTO_OUT, T8B);
expect('8b 3rd Read of an auto-backgrounded call\'s .output emits',
  read('s8b', AUTO_OUT, T8B), { want: ['3rd read of task_auto7.output'] });

reset();
const TAIL_DRY = 'tail -n 20 scripts/out/dryrun.log';
bash('s8c', TAIL_DRY, T8C); bash('s8c', TAIL_DRY, T8C);
expect('8c 3rd tail of a log after SYNCHRONOUS runs is silent',
  bash('s8c', TAIL_DRY, T8C), { silent: true });
expect('8c2 ... and stays silent on the 4th', bash('s8c', TAIL_DRY, T8C), { silent: true });
{
  const src = fs.readFileSync(HOOK, 'utf8');
  const gate = '      if (!backgroundEvidence(input.transcript_path, needleOf(t.key))) continue;\n';
  const ungated = src.replace(gate, '');
  const OLD_HOOK = path.join(FAKEHOME, 'ungated-poll-guard.js');
  fs.writeFileSync(OLD_HOOK, ungated);
  const run = (cmd) => spawnSync(process.execPath, [OLD_HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', session_id: 's8pin', transcript_path: T8C, tool_input: { command: cmd } }),
    env: { ...process.env, HOME: FAKEHOME, USERPROFILE: FAKEHOME }, encoding: 'utf8', timeout: 10000,
  });
  reset();
  run(TAIL_DRY); run(TAIL_DRY);
  const r = run(TAIL_DRY);
  check('8c-pin the same 3 reads through the hook WITHOUT the evidence gate DO emit (a count-only rule\'s false positive)',
    (ungated === src ? ['pin failed: gate line not found'] : []).concat(/3rd read of dryrun\.log/.test(r.stdout || '') ? [] : ['ungated copy was silent']), '');
}

reset();
const TAIL_BUILD = 'tail -n 5 C:/x/build.log';
bash('s8d', TAIL_BUILD, null); bash('s8d', TAIL_BUILD, null);
expect('8d no transcript_path in the payload -> silent (no proof of a background task)',
  bash('s8d', TAIL_BUILD, null), { silent: true });
reset();
const MISSING = path.join(FAKEHOME, 'no-such-transcript.jsonl');
bash('s8e', TAIL_BUILD, MISSING); bash('s8e', TAIL_BUILD, MISSING);
expect('8e an unreadable transcript_path -> silent, exit 0', bash('s8e', TAIL_BUILD, MISSING), { silent: true });

// Evidence must name THIS target, as a launch: another file's launch, a plain mention in a result,
// and the model's own Read of the path (the poll itself) are all not evidence.
reset();
const T8F = transcript('t8f', [launchUse('node other.js > C:/x/other.log 2>&1'),
  result('wrote 40 lines to C:/x/build.log'),
  rec('assistant', [{ type: 'tool_use', id: 'tu_r', name: 'Read', input: { file_path: 'C:/x/build.log' } }])]);
bash('s8f', TAIL_BUILD, T8F); bash('s8f', TAIL_BUILD, T8F);
expect('8f a launch of another file, a result that merely names build.log, and the poll\'s own Read are not evidence',
  bash('s8f', TAIL_BUILD, T8F), { silent: true });

// Workflow journals: evidence is the wf_ run directory in a "launched in background" result.
reset();
const J77 = 'C:/Users/you/.claude/projects/p/s/subagents/workflows/wf_run77/journal.jsonl';
const TAIL_J77 = 'tail -n 40 ' + J77;
const T8G = transcript('t8g', [result('Workflow launched in background. Task ID: w1\nTranscript dir: C:\\Users\\you\\.claude\\projects\\p\\s\\subagents\\workflows\\wf_run77')]);
bash('s8g', TAIL_J77, T8G); bash('s8g', TAIL_J77, T8G);
expect('8g 3rd tail of the journal of a Workflow launched this session emits',
  bash('s8g', TAIL_J77, T8G), { want: ['3rd read of journal.jsonl'] });
reset();
bash('s8h', TAIL_J77, EVIDENCE); bash('s8h', TAIL_J77, EVIDENCE);
expect('8h ... but the journal of a run this session never launched (wf_01 only) is silent',
  bash('s8h', TAIL_J77, EVIDENCE), { silent: true });

console.log(lines.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed of ' + (pass + fail) + ' cases');
reset();
process.exitCode = fail > 0 ? 1 : 0;
