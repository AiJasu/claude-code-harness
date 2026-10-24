'use strict';
// Fixtures for context-nudge.js's above-2x-threshold escalation and absent-user detection.
// Below 800K, job 1's wording is the bucket-0/bucket-1+ tiers; the unconditional wording and the
// absent-user clause apply at/above 800K (bucket 4+), and the 'auto' request-kind classification
// (job 2) is what computes it. Run:
//   node hooks/tests/context-nudge-fixtures.js
//
// Every case runs the real HOOK over stdin and asserts the exact string the model receives on
// hookSpecificOutput.additionalContext - the one channel that reaches it. The hook is stateful
// per session (bucket + a short history of prior nudges' request-kind classification), so cases
// within a section are SEQUENCES; HOME is sandboxed per section so a run can never disturb a live
// session's counters.
//
// Case 1 is a synthetic five-nudge sequence of rising context readings: the first four ride a
// task-notification-resumed turn and the fifth rides a typed /compact. Case 1f asserts the
// absent-user clause does NOT fire on that typed turn: the streak test must include the
// CURRENT turn's classification, which for a typed prompt is 'other', not 'auto'.
//
// Section 6 covers job 3 (the short-prompt shape line), section 7 the threshold that follows the
// configured autoCompactWindow.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'context-nudge.js');

function freshHome(tag) {
  const dir = path.join(__dirname, '.fakehome-cn-' + tag);
  // PURGE, don't just create: the hook is stateful per session and writes
  // <home>/.claude/.context-nudge-<session>.json and .last-prompt-<session>.json. Without this
  // the dir survives between RUNS and a later run inherits an earlier run's bucket/history.
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

function writeTranscript(home, tokens) {
  const p = path.join(home, 'transcript.jsonl');
  const line = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', usage: { cache_read_input_tokens: tokens, input_tokens: 0 } },
  });
  fs.writeFileSync(p, line + '\n');
  return p;
}

const TASK_NOTIFICATION_PROMPT = '<task-notification>\n<task-id>task01</task-id>\n' +
  '<status>completed</status>\n<summary>Dynamic workflow completed</summary>\n</task-notification>';

// extraEnv / hookPath are for the THRESHOLD cases (section 7). The window env var is blanked by
// default so a value in the runner's own environment cannot move the threshold under cases 1-6.
function call(home, sid, prompt, tokens, extraEnv, hookPath) {
  const transcriptPath = writeTranscript(home, tokens);
  const payload = { session_id: sid, prompt, transcript_path: transcriptPath };
  const res = spawnSync(process.execPath, [hookPath || HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '', ...(extraEnv || {}), HOME: home, USERPROFILE: home },
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

function lastPromptKind(home, sid) {
  try {
    const f = path.join(home, '.claude', `.last-prompt-${sid}.json`);
    return JSON.parse(fs.readFileSync(f, 'utf8')).kind;
  } catch (_) { return null; }
}

let pass = 0, fail = 0;
const lines = [];
function check(name, problems, note) {
  if (problems.length) { fail++; lines.push('FAIL  ' + name + '  [' + problems.join('; ') + ']'); }
  else { pass++; lines.push('PASS  ' + name + (note ? '  note="' + note.slice(0, 70) + '..."' : '')); }
}
function expect(name, r, opts) {
  const p = [];
  if (r.status !== 0) p.push('expected exit 0, got ' + r.status + ' stderr=' + r.stderr.slice(0, 80));
  for (const w of opts.want || []) if (!r.note.includes(w)) p.push('missing "' + w + '"');
  for (const w of opts.wantNot || []) if (r.note.includes(w)) p.push('unexpected "' + w + '"');
  if (opts.silent && r.note) p.push('expected no note, got "' + r.note.slice(0, 80) + '"');
  if (opts.exact !== undefined && r.note !== opts.exact) p.push('note did not match exactly');
  check(name, p, r.note);
}

const OLD_WORDING = 'If this request starts a new deliverable, run /wrap -c first and tell the user ' +
  'to type the /compact line it prints (the model cannot run /compact); every further turn ' +
  're-reads all of it.';
// Bucket-1+ (500-799K) wording - only used below 800K.
const TIER1_MARK = 'the next milestone does not start in this window';
const DOUBLE_MARK = 'over 2x the nudge threshold';
const ABSENT_MARK = 'nobody is here to type /compact';

// --- 1. five-nudge sequence rising through the tiers (synthetic token counts) -----------------
{
  const home = freshHome('1');
  const sid = 'seq-a';

  const r1 = call(home, sid, TASK_NOTIFICATION_PROMPT, 450000);
  expect('1a bucket0 (450K, task-notification) keeps the ORIGINAL wording exactly',
    r1, { exact: 'context ~450K tokens. ' + OLD_WORDING });
  check('1a-kind job 2 classified this turn "auto"',
    lastPromptKind(home, sid) === 'auto' ? [] : ['kind was ' + lastPromptKind(home, sid)], '');

  expect('1b same bucket0 (460K) stays silent', call(home, sid, TASK_NOTIFICATION_PROMPT, 460000),
    { silent: true });

  expect('1c bucket1 (550K, task-notification) gets the tier-1 wording (500-799K, below 2x)',
    call(home, sid, TASK_NOTIFICATION_PROMPT, 550000),
    { want: [TIER1_MARK], wantNot: [OLD_WORDING, DOUBLE_MARK, ABSENT_MARK] });

  expect('1d bucket2 (650K, task-notification) still tier-1 wording (below 2x)',
    call(home, sid, TASK_NOTIFICATION_PROMPT, 650000),
    { want: [TIER1_MARK], wantNot: [OLD_WORDING, DOUBLE_MARK, ABSENT_MARK] });

  expect('1e bucket3 (750K, task-notification) still tier-1 wording (below 2x)',
    call(home, sid, TASK_NOTIFICATION_PROMPT, 750000),
    { want: [TIER1_MARK], wantNot: [OLD_WORDING, DOUBLE_MARK, ABSENT_MARK] });

  // A typed /compact with guidance text.
  const compactPrompt = '/compact Durable record is in HANDOFF.md. Keep the open task list.';
  expect('1f bucket4 (850K, a typed /compact) fires the UNCONDITIONAL over-2x wording ' +
    'but WITHOUT the absent-user clause - this turn is the user typing, classified \'other\' not ' +
    '\'auto\', even though buckets 2 and 3 both rode task-notification turns',
    call(home, sid, compactPrompt, 850000),
    { want: [DOUBLE_MARK], wantNot: [ABSENT_MARK, OLD_WORDING, TIER1_MARK] });

  expect('1g repeat inside bucket4 (850000 again) stays silent', call(home, sid, compactPrompt, 850000),
    { silent: true });
}

// --- 2. false-positive guard: a user present the whole way never gets the absent-user clause ---
{
  const home = freshHome('2');
  const sid = 'attended';

  expect('2a bucket0 (450K, typed prompt) original wording',
    call(home, sid, 'check the build status please', 450000),
    { want: [OLD_WORDING] });
  check('2a-kind job 2 classified this turn "check", not "auto"',
    lastPromptKind(home, sid) === 'check' ? [] : ['kind was ' + lastPromptKind(home, sid)], '');

  expect('2b bucket1 (550K, typed prompt) tier-1 wording (same as an auto turn would get)',
    call(home, sid, 'continue with the plan', 550000),
    { want: [TIER1_MARK], wantNot: [OLD_WORDING] });

  expect('2c bucket4 (850K, typed prompt, first firing above 2x) fires the unconditional wording ' +
    'but WITHOUT the absent-user clause - the two prior nudges rode typed turns, not auto ones',
    call(home, sid, 'keep going with the next step', 850000),
    { want: [DOUBLE_MARK], wantNot: [ABSENT_MARK] });
}

// --- 3. one auto turn is not a streak: ABSENT_STREAK is 2, not 1 -------------------------------
{
  const home = freshHome('3');
  const sid = 'mixed';

  call(home, sid, 'start the build', 450000);                       // bucket0, other
  call(home, sid, TASK_NOTIFICATION_PROMPT, 550000);                    // bucket1, auto (only 1)
  expect('3a bucket4 (850K) after only ONE prior auto nudge stays without the absent-user clause',
    call(home, sid, TASK_NOTIFICATION_PROMPT, 850000),
    { want: [DOUBLE_MARK], wantNot: [ABSENT_MARK] });
}

// --- 4. malformed stdin fails open --------------------------------------------------------------
{
  const home = freshHome('4');
  const res = spawnSync(process.execPath, [HOOK], {
    input: 'not json {{{',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    timeout: 10000,
  });
  check('4a malformed stdin -> exit 0, no output',
    (res.status !== 0 ? ['expected exit 0, got ' + res.status] : []).concat((res.stdout || '').trim() ? ['expected empty stdout'] : []), '');
}

// --- 5. RESUMPTION arm -------------------------------------------------------------------------
// Synthetic shape: a session wrapped at ~300K with HANDOFF.md written, never compacted, and a new
// deliverable started in the same transcript days later. These cases pin the arm that fires on
// turn 1 of the resumed work instead of waiting for the size nudge.
//
// Case 5f is the required proof that the OLD rule would have been silent on this input and stays
// authoritative on its own: at 450K only the size wording appears, because the resume arm is capped
// strictly below THRESHOLD and the two can never double up.
function writeResumeTranscript(home, tokens, ageHours, wrapped) {
  const p = path.join(home, 'transcript.jsonl');
  const stamp = new Date(Date.now() - ageHours * 3600 * 1000).toISOString();
  const rows = [];
  if (wrapped) {
    rows.push(JSON.stringify({
      type: 'assistant', timestamp: stamp,
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'wrap' } }] },
    }));
  }
  rows.push(JSON.stringify({
    type: 'assistant', timestamp: stamp,
    message: { role: 'assistant', usage: { cache_read_input_tokens: tokens, input_tokens: 0 } },
  }));
  fs.writeFileSync(p, rows.join('\n') + '\n');
  return p;
}

function callResume(home, sid, prompt, tokens, ageHours, wrapped) {
  const transcriptPath = writeResumeTranscript(home, tokens, ageHours, wrapped);
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: sid, prompt, transcript_path: transcriptPath }),
    env: { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '', HOME: home, USERPROFILE: home },
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

const RESUME_MARK = 'HANDOFF.md is the durable record';
// The reply's first line is dictated, not left to "say so". SAME_LINE and NEW_LINE are the two
// fixed phrases; OLD_RESUME_CONDITIONAL is the looser wording, which pins the change - a hook that
// carried it would carry neither fixed phrase.
const SAME_LINE = '"Same work as before the gap"';
const NEW_LINE = '"New work: suggest the user runs /clear and restarts from HANDOFF.md (run /wrap first if HANDOFF.md is stale)"';
const OLD_RESUME_CONDITIONAL = 'If it starts a new one, say so';
{
  const home = freshHome('5');

  expect('5a resume shape: 300K, wrapped, resumed 3 days later on a typed prompt -> fires',
    callResume(home, 'res-a', 'now start on the export step', 300000, 72, true),
    { want: [RESUME_MARK, '~300K tokens', 'h ago'] });
  expect('5a2 a long gap and a new bug typed: the note dictates the first line, both fixed phrases ' +
    'present and the old conditional gone',
    callResume(home, 'res-a2', 'new bug: the upload dialog loses the selection', 320000, 400, false),
    { want: [RESUME_MARK, 'FIRST LINE', SAME_LINE, NEW_LINE, '~320K tokens', '400h ago'],
      wantNot: [OLD_RESUME_CONDITIONAL] });
  expect('5b the same session is nudged ONCE, not on every later prompt',
    callResume(home, 'res-a', 'and what about the retry path', 310000, 72, true),
    { silent: true });

  expect('5c a wrap in the tail fires it even with no time gap at all',
    callResume(home, 'res-c', 'next: the settings page', 200000, 0.05, true),
    { want: [RESUME_MARK, 'already been wrapped'] });

  expect('5d same-day, no wrap, no gap -> silent (the case that must not cost a line)',
    callResume(home, 'res-d', 'next: the settings page', 200000, 0.05, false),
    { silent: true });
  expect('5e below the 150K floor a 3-day gap is not worth a note',
    callResume(home, 'res-e', 'picking this back up', 140000, 72, true),
    { silent: true });

  expect('5f at 450K the SIZE nudge speaks and the resume arm does not - the 400K path is untouched',
    callResume(home, 'res-f', 'picking this back up', 450000, 72, true),
    { want: [OLD_WORDING], wantNot: [RESUME_MARK] });

  expect('5g an auto turn never gets it - only a person can decide to start somewhere else',
    callResume(home, 'res-g', TASK_NOTIFICATION_PROMPT, 300000, 72, true),
    { silent: true });
}

// --- 6. SHORT-PROMPT SHAPE (job 3) --------------------------------------------------------------
// reply-lint.js owns .reply-lint-repeat.json; these cases seed it by hand. Context stays at 1K so
// job 1 is silent and every note below is job 3's alone. 6b is the no-job proof: one reply-style
// note (below SHAPE_AFTER) gets nothing, as every count would without this job.
const SHAPE_MARK = 'already broke the terse shape';
const LAST_MARK = 'The last reply here was';
// reply-lint.js's heartbeat, seeded by hand like the counter.
function seedSeen(home, sid, chars) {
  fs.writeFileSync(path.join(home, '.claude', '.reply-lint-seen.json'),
    JSON.stringify({ _lastFired: new Date().toISOString(), _lastSession: sid, chars, lines: 9 }));
}
function seedRepeat(home, sid, n, ageMs) {
  const all = { [sid]: { _last: Date.now() - (ageMs || 0), 'reply-style': n } };
  fs.writeFileSync(path.join(home, '.claude', '.reply-lint-repeat.json'), JSON.stringify(all));
}
const SHORT_ASK = 'is the cache fix still applied?';
{
  const home = freshHome('6');
  seedRepeat(home, 'shape-a', 2);
  expect('6a 2 reply-style notes + a short typed prompt -> the pre-reply line',
    call(home, 'shape-a', SHORT_ASK, 1000),
    { want: [SHAPE_MARK, '2 replies', 'at most 4 lines', '900 characters'], wantNot: [LAST_MARK] });
  seedRepeat(home, 'shape-b', 1);
  expect('6b 1 note is below SHAPE_AFTER -> silent',
    call(home, 'shape-b', SHORT_ASK, 1000), { silent: true });
  seedRepeat(home, 'shape-c', 5);
  expect('6c a depth word exempts the prompt, as reply-lint does -> silent',
    call(home, 'shape-c', 'explain how the ledger works in detail', 1000), { silent: true });
  seedRepeat(home, 'shape-d', 5);
  expect('6d a slash command is exempt -> silent',
    call(home, 'shape-d', '/best', 1000), { silent: true });
  seedRepeat(home, 'shape-e', 5);
  expect('6e a task-notification turn is exempt -> silent',
    call(home, 'shape-e', TASK_NOTIFICATION_PROMPT, 1000), { silent: true });
  seedRepeat(home, 'shape-f', 5, 25 * 60 * 60 * 1000);
  expect('6f a count idle past the 24h expiry -> silent',
    call(home, 'shape-f', SHORT_ASK, 1000), { silent: true });
  seedRepeat(home, 'shape-g', 3);
  expect('6g a long prompt (over 400 chars) is exempt -> silent',
    call(home, 'shape-g', 'x '.repeat(220), 1000), { silent: true });
  seedRepeat(home, 'shape-h', 3);
  seedSeen(home, 'shape-h', 1500);
  expect('6h the heartbeat last ran in THIS session -> the line quotes that reply\'s size',
    call(home, 'shape-h', SHORT_ASK, 1000),
    { want: [SHAPE_MARK, '900 characters', LAST_MARK + ' 1500 chars'] });
  seedRepeat(home, 'shape-i', 3);
  seedSeen(home, 'some-other-session', 1500);
  expect('6i the heartbeat belongs to another session -> no size clause',
    call(home, 'shape-i', SHORT_ASK, 1000),
    { want: [SHAPE_MARK], wantNot: [LAST_MARK, '1500'] });
}

// --- 7. THRESHOLD FOLLOWS autoCompactWindow ------------------------------------------------------
// A fixed 400K threshold sits ABOVE the auto-compact fire point (window - 33000) when the window is
// 400K, so the size arm could never fire. Each pin runs the SAME input through a copy of the hook
// whose THRESHOLD line is put back to a fixed 400000, so a case only counts if the fixed rule would
// have answered differently.
function oldFixedHook(home) {
  const src = fs.readFileSync(HOOK, 'utf8');
  const old = src.replace('const THRESHOLD = nudgeThreshold();', 'const THRESHOLD = 400000;');
  if (old === src) throw new Error('pin failed: THRESHOLD line not found in the hook');
  const p = path.join(home, 'old-fixed-threshold.js');
  fs.writeFileSync(p, old);
  return p;
}
const BOM = String.fromCharCode(0xFEFF);
function setWindow(home, obj, bom) {
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), (bom ? BOM : '') + JSON.stringify(obj));
}
const NEW_PROMPT = 'start on the next deliverable';
{
  const home = freshHome('7');
  const old = oldFixedHook(home);
  setWindow(home, { autoCompactWindow: 400000 });
  expect('7a window 400K: a 367,500 reading speaks - the fire point is 367,000',
    call(home, 't7a', NEW_PROMPT, 367500), { exact: 'context ~368K tokens. ' + OLD_WORDING });
  expect('7b ... and the fixed 400K is silent on that same input (this pins the change)',
    call(home, 't7b', NEW_PROMPT, 367500, null, old), { silent: true });
  expect('7c window 400K: 366,000 is below the auto trigger -> silent',
    call(home, 't7c', NEW_PROMPT, 366000), { silent: true });

  setWindow(home, { autoCompactWindow: 450000 });
  expect('7d window 450K: 410,000 is below the 417,000 auto trigger -> silent (no nudge below the trigger)',
    call(home, 't7d', NEW_PROMPT, 410000), { silent: true });
  expect('7e ... and the fixed 400K nudged there, 7,000 under the trigger (this pins the change)',
    call(home, 't7e', NEW_PROMPT, 410000, null, old), { want: [OLD_WORDING] });
  expect('7f window 450K: the 367,500 reading is silent',
    call(home, 't7f', NEW_PROMPT, 367500), { silent: true });
  expect('7g window 450K: 420,000 is past the 417,000 trigger -> speaks',
    call(home, 't7g', NEW_PROMPT, 420000), { want: [OLD_WORDING, '~420K'] });

  setWindow(home, { autoCompactWindow: 400000 });
  expect('7h the env var outranks the settings key (450K env, 400K key): 367,500 is silent',
    call(home, 't7h', NEW_PROMPT, 367500, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '450000' }), { silent: true });
  setWindow(home, { autoCompactWindow: 400000, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '450000' } });
  expect('7i the settings.json env block outranks the key too (config-drift-check.js order)',
    call(home, 't7i', NEW_PROMPT, 367500), { silent: true });
  setWindow(home, { autoCompactWindow: 400000 }, true);
  expect('7j a BOM in settings.json does not hide the window',
    call(home, 't7j', NEW_PROMPT, 367500), { want: [OLD_WORDING] });
  setWindow(home, { autoCompactWindow: 'soon' });
  expect('7k an unusable value falls back to the fixed 400K: 367,500 silent',
    call(home, 't7k', NEW_PROMPT, 367500), { silent: true });
  expect('7l ... and 410,000 speaks, exactly the fixed-400K behavior', call(home, 't7l', NEW_PROMPT, 410000), { want: [OLD_WORDING] });
  fs.unlinkSync(path.join(home, '.claude', 'settings.json'));
  expect('7m no settings.json at all keeps the fixed behavior: 367,500 silent',
    call(home, 't7m', NEW_PROMPT, 367500), { silent: true });

  // The resume arm stays strictly below THRESHOLD, so it must follow the derived value too: at
  // the 367,000 fire point a 3-day-old wrapped session gets the size line, never both.
  setWindow(home, { autoCompactWindow: 400000 });
  expect('7n window 400K: 367,500 + a 3-day gap -> the size line only, the resume arm does not double up',
    callResume(home, 't7n', 'picking this back up', 367500, 72, true),
    { want: [OLD_WORDING], wantNot: [RESUME_MARK] });
  expect('7o window 400K: 345,000 + a 3-day gap -> the resume arm still speaks',
    callResume(home, 't7o', 'picking this back up', 345000, 72, true), { want: [RESUME_MARK] });
}

console.log(lines.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed of ' + (pass + fail) + ' cases');
process.exitCode = fail > 0 ? 1 : 0;
