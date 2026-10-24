'use strict';
// Fixtures for handoff-surface.js. Run: node hooks/tests/handoff-surface-fixtures.js
//
// The hook injects the opening of a project's HANDOFF.md at SessionStart. This pins the 6000-char
// slice, the size clause, and the untrusted-data framing the injection depends on for safety.
// Section 5 pins errlogNote, the untriaged error-log line.
//
// Every case runs with HOME/USERPROFILE pointed at its own fake home (so no case reads the real
// ~/.claude/critic-loop or bash-errors.jsonl) and CLAUDE_CODE_ENTRYPOINT=cli, so the result does not
// depend on whether the suite itself was launched from a headless session.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'handoff-surface.js');
const SANDBOX = path.join(__dirname, '.fakeproj-hs');

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}

let seq = 0;
function runWith(lines, opts) {
  const o = opts || {};
  const dir = path.join(SANDBOX, 'p' + (++seq));
  fs.mkdirSync(dir, { recursive: true });
  if (lines !== null) {
    const body = ['# Handoff', ''].concat(
      Array.from({ length: Math.max(0, lines - 2) }, (_, i) => '- line ' + (i + 1) + ' of the notes')
    ).join('\n');
    fs.writeFileSync(path.join(dir, 'HANDOFF.md'), body);
  }
  if (o.body) fs.writeFileSync(path.join(dir, 'HANDOFF.md'), o.body);
  const input = { cwd: o.cwd || dir };
  if (o.source) input.source = o.source;
  if (o.sessionId) input.session_id = o.sessionId;
  if (o.transcriptAgeVsHandoff !== undefined) {
    // Positive = transcript written AFTER the handoff (an unchanged resume); negative = before.
    const tp = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(tp, '{}\n');
    const base = Date.now() / 1000 - 3600;
    fs.utimesSync(path.join(dir, 'HANDOFF.md'), base, base);
    fs.utimesSync(tp, base + o.transcriptAgeVsHandoff, base + o.transcriptAgeVsHandoff);
    input.transcript_path = tp;
  }
  // A fake home per case. o.errlog is the raw text of its bash-errors.jsonl (absent -> no file);
  // o.entrypoint overrides CLAUDE_CODE_ENTRYPOINT (default 'cli', the interactive value).
  const box = path.join(SANDBOX, 'h' + seq);
  fs.mkdirSync(path.join(box, '.claude'), { recursive: true });
  if (o.errlog !== undefined) fs.writeFileSync(path.join(box, '.claude', 'bash-errors.jsonl'), o.errlog);
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, HOME: box, USERPROFILE: box, CLAUDE_CODE_ENTRYPOINT: o.entrypoint || 'cli' },
    timeout: 10000,
  });
  return { status: res.status, out: res.stdout || '' };
}

// A 7K HANDOFF whose "## Resume here" starts past byte 6000 - the shape the old first-6000 slice
// surfaced without its next steps.
const filler = (tag, n) => Array.from({ length: n }, (_, i) => '- ' + tag + ' note ' + (i + 1) + ' of the older record').join('\n');
const LATE_NEXT = ['# Handoff', '', '## Aim', filler('aim', 110), '', '## Done so far', filler('done', 110), '',
  '## Resume here', '- NEXT-STEP-MARKER: run the resume check first', '',
  '## Where things stand', '- STATE-MARKER: tests green', ''].join('\n');

let pass = 0, fail = 0;
const out = [];
function T(name, r, opts) {
  const p = [];
  if (r.status !== 0) p.push('expected exit 0, got ' + r.status);
  for (const w of (opts.want || [])) if (!r.out.includes(w)) p.push('missing "' + w + '"');
  for (const w of (opts.wantNot || [])) if (r.out.includes(w)) p.push('unexpected "' + w + '"');
  if (opts.empty && r.out !== '') p.push('expected NO output, got ' + r.out.length + ' chars');
  if (opts.maxLen !== undefined && r.out.length > opts.maxLen) p.push('emitted ' + r.out.length + ' chars, cap ' + opts.maxLen);
  if (p.length) { fail++; out.push('FAIL  ' + name + '  [' + p.join('; ') + ']'); }
  else { pass++; out.push('PASS  ' + name); }
}

const SIZE = 'SIZE: this HANDOFF.md is';
const FRAME = 'UNTRUSTED-HANDOFF-DATA';

// --- 1. the threshold, both sides ---------------------------------------------------------------
T('1a a 300-line HANDOFF injects with NO size clause',
  runWith(300), { want: [FRAME, 'first 6000 characters'], wantNot: [SIZE] });
T('1b a 996-line HANDOFF names its line count',
  runWith(996), { want: [SIZE, '996 lines', 'rotate it at the next /wrap'] });
// The threshold pin CLAUDE.md asks for: 400 is the boundary, so 401 speaks and 400 does not.
T('1c exactly 400 lines is silent',
  runWith(400), { wantNot: [SIZE] });
T('1d 401 lines speaks',
  runWith(401), { want: [SIZE, '401 lines'] });

// --- 2. the injection itself is unchanged -------------------------------------------------------
{
  const r = runWith(996);
  T('2a the untrusted-data framing still wraps the body both ends',
    r, { want: ['<<<UNTRUSTED-HANDOFF-DATA', '<<<END-UNTRUSTED-HANDOFF-DATA>>>'] });
  // 6000 chars of body plus the framing; the hook-output cap is 10k, so this is the headroom
  // check the comment in the hook argues for.
  const big = r.out.length;
  T('2b the whole emission stays well under the 10k hook-output cap',
    { status: 0, out: big < 10000 ? 'ok' : 'emitted ' + big + ' chars' }, { want: ['ok'] });
}

// --- 3. no HANDOFF.md at all --------------------------------------------------------------------
T('3a a project with no HANDOFF.md emits no handoff block',
  runWith(null), { wantNot: [FRAME, SIZE] });

// --- 4. next steps first, resume and compact ----------------------------------------------------
{
  const pos = LATE_NEXT.indexOf('## Resume here');
  T('4a fixture sanity: Resume here starts past byte 6000 (' + pos + ') in a ' + LATE_NEXT.length + '-char file',
    { status: 0, out: pos > 6000 && LATE_NEXT.length > 7000 ? 'ok' : 'bad' }, { want: ['ok'] });
  const r = runWith(null, { body: LATE_NEXT });
  const nextAt = r.out.indexOf('NEXT-STEP-MARKER');
  const aimAt = r.out.indexOf('## Aim');
  T('4b startup shows a late Resume here, and ahead of the older sections',
    { status: r.status, out: nextAt > 0 && (aimAt < 0 || nextAt < aimAt) ? 'ok' : 'next=' + nextAt + ' aim=' + aimAt },
    { want: ['ok'] });
  const endAt = r.out.indexOf('<<<END-UNTRUSTED-HANDOFF-DATA>>>');
  const skipAt = r.out.indexOf('Sections not shown');
  T('4c what did not fit is named, inside the untrusted frame',
    { status: r.status, out: skipAt > 0 && skipAt < endAt && /Done so far/.test(r.out.slice(skipAt, endAt)) ? 'ok' : 'skip=' + skipAt + ' end=' + endAt },
    { want: ['ok'] });
  T('4d an unchanged resume emits no handoff block',
    runWith(null, { body: LATE_NEXT, source: 'resume', transcriptAgeVsHandoff: 60 }), { wantNot: [FRAME] });
  T('4e a resume after the handoff changed re-injects it',
    runWith(null, { body: LATE_NEXT, source: 'resume', transcriptAgeVsHandoff: -60 }), { want: [FRAME, 'NEXT-STEP-MARKER'] });
  const c = runWith(null, { body: LATE_NEXT, source: 'compact' });
  T('4f compact re-surfaces only the next steps, under 3.5K in all (' + c.out.length + ' chars)',
    { status: c.status, out: c.out.length <= 3500 ? c.out : 'too long' },
    { want: ['NEXT-STEP-MARKER', 'STATE-MARKER', 'Next-step sections only'], wantNot: ['## Aim', 'aim note 1 '] });
}

// --- 5. the untriaged error-log line (errlogNote) ----------------------------------------------
// Rows are synthetic; the stderr filler proves row text is never echoed. runWith(null, ...) means no
// HANDOFF.md and no critic-loop dir in the fake home, so `empty` really is the whole emission. The
// rule under test: a row older than 24 h from ANOTHER session means that session ended without /wrap.
{
  const HOUR = 3600 * 1000;
  const ELSE = '11111111-1111-1111-1111-111111111111';
  const ELSE2 = '22222222-2222-2222-2222-222222222222';
  const ME = '33333333-3333-3333-3333-333333333333';
  const LEAK = 'ROWTEXT-MUST-NOT-LEAK';
  const row = (sid, ageMs, drop) => {
    const o = { ts: new Date(Date.now() - ageMs).toISOString(), event: 'PostToolUseFailure', tool_name: 'Bash',
      kind: 'tool_failure', session_id: sid, cwd: 'x', command: 'x', exit_code: 1, stderr: LEAK };
    if (drop) delete o[drop];
    return JSON.stringify(o) + '\n';
  };

  T('5a no error log is silent', runWith(null, {}), { empty: true });
  T('5b a 23 h row from another session is silent (it may belong to a live sibling)',
    runWith(null, { errlog: row(ELSE, 23 * HOUR) }), { empty: true });
  // The threshold pin: 24 h is the boundary, so 23.98 h is silent and 24.02 h speaks.
  T('5c just under 24 h is silent', runWith(null, { errlog: row(ELSE, 23.98 * HOUR) }), { empty: true });
  T('5d just over 24 h speaks, with counts and the archive command, and never echoes row text',
    runWith(null, { errlog: row(ELSE, 24.02 * HOUR) }),
    { want: ['holds 1 untriaged row(s) from 1 session(s) that ended without /wrap', 'errlog-archive.js', '--stale'],
      wantNot: [LEAK], maxLen: 600 });

  const oldest = new Date(Date.now() - 60 * HOUR).toISOString().slice(0, 10);
  const mixed = row(ELSE, 60 * HOUR) + row(ELSE, 30 * HOUR) + row(ELSE2, 48 * HOUR) + row(ME, 50 * HOUR) + row(ELSE2, 2 * HOUR);
  T('5e counts rows and sessions, skips this session and the young row, names the oldest date',
    runWith(null, { errlog: mixed, sessionId: ME }),
    { want: ['holds 3 untriaged row(s) from 2 session(s)', 'oldest ' + oldest] });
  T('5f without the session id in the payload nothing is excluded',
    runWith(null, { errlog: mixed }), { want: ['holds 4 untriaged row(s) from 3 session(s)'] });

  const OLD = row(ELSE, 30 * HOUR);
  T('5g a compact is silent', runWith(null, { errlog: OLD, source: 'compact' }), { empty: true });
  T('5h a headless entrypoint (sdk-cli) is silent', runWith(null, { errlog: OLD, entrypoint: 'sdk-cli' }), { empty: true });
  T('5i a resume still speaks', runWith(null, { errlog: OLD, source: 'resume' }), { want: ['holds 1 untriaged row(s)'] });
  T('5j an unparseable line and a row with no ts are skipped, not a crash',
    runWith(null, { errlog: 'not json {\n' + row(ELSE, 30 * HOUR, 'ts') + OLD }),
    { want: ['holds 1 untriaged row(s) from 1 session(s)'] });
  {
    const r = runWith(996, { errlog: OLD });
    T('5k the line rides alongside the handoff block, total under 10k (' + r.out.length + ')',
      r, { want: [FRAME, SIZE, 'holds 1 untriaged row(s)'], maxLen: 9999 });
  }
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed of ' + (pass + fail) + ' cases');
process.exitCode = fail > 0 ? 1 : 0;
