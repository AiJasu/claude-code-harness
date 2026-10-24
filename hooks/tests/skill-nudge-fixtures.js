'use strict';
// Fixtures for skill-nudge.js. Run: node hooks/tests/skill-nudge-fixtures.js
//
// What is asserted is the exact channel that reaches the model -
// hookSpecificOutput.additionalContext on stdout - never stderr, which is user-display only.
//
// Case 1 is a plain "look at this security-wise" request, the simplest shape the rule targets.
// A rule that misses it is useless.
//
// The three SILENT cases are the whole safety argument: already-used, slash command, and the
// second matching prompt of a session. A nudge that repeats is the hook-note repeat problem the
// guard's noteOnce ledger was built to stop; this one simply never speaks twice.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'skill-nudge.js');
const TRANSCRIPT = path.join(__dirname, '.tmp-skill-nudge.jsonl');
// Sandbox HOME: the hook writes a per-session ledger into ~/.claude and a fixture run must not
// leave synthetic session files in the live home.
const FAKEHOME = path.join(__dirname, '.fakehome-sn');
fs.mkdirSync(path.join(FAKEHOME, '.claude'), { recursive: true });
// Idempotent across repeated runs: the hook speaks once per session, so a ledger left by the
// previous run would silence every case and the suite would go red for no reason at all.
for (const f of fs.readdirSync(path.join(FAKEHOME, '.claude'))) {
  if (f.startsWith('.skill-nudge-')) {
    try { fs.unlinkSync(path.join(FAKEHOME, '.claude', f)); } catch (_) {}
  }
}

const BASE_PROMPT = 'go over the payment module security-wise and list the weak spots';

// A transcript tail with no Skill call in it, and one that already used security-scan.
const PLAIN_TAIL = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n';
const USED_TAIL = PLAIN_TAIL + JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'security-scan' } }] },
}) + '\n';

// Every case gets its OWN session id unless it opts into a shared one. Without this the
// once-per-session ledger makes cases 2..n silent for the wrong reason and the suite reads green
// while three real patterns are untested - which is the failure this guards against.
let seq = 0;
function call(prompt, opts) {
  const o = opts || {};
  fs.writeFileSync(TRANSCRIPT, o.tail || PLAIN_TAIL);
  const input = { prompt, transcript_path: TRANSCRIPT, session_id: o.sessionId || 'fixture-sn-' + (++seq) };
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    env: { ...process.env, HOME: FAKEHOME, USERPROFILE: FAKEHOME },
    encoding: 'utf8',
    timeout: 10000,
  });
  let ctx = null;
  try { ctx = JSON.parse(res.stdout || 'null'); } catch (_) {}
  return {
    status: res.status,
    note: (ctx && ctx.hookSpecificOutput && ctx.hookSpecificOutput.additionalContext) || '',
  };
}

const cases = [];
function T(name, prompt, opts) { cases.push({ name, prompt, ...opts }); }

// --- fires on the base prompt ------------------------------------------------------------------
T('fires on a "security-wise" review ask', BASE_PROMPT,
  { want: ['skill-nudge:', 'security-scan'] });

// --- fires on the other phrasings the pattern claims to cover ---------------------------------
T('fires on "do a security review of"', 'do a security review of the checkout service before we ship',
  { want: ['security-scan'] });
T('fires on an audit-for-vulnerabilities ask', 'audit the billing service for vulnerabilities',
  { want: ['security-scan'] });
T('fires on a threat-model ask', 'threat model the upload endpoint',
  { want: ['security-scan'] });

// --- silent: no skill domain in the prompt ----------------------------------------------------
T('silent on an ordinary prompt', 'the release went out, check the logs and report whether it took',
  { deny: ['skill-nudge:'] });
T('silent on a prompt that only mentions the word secure',
  'make sure the connection is secure enough for the report feed', { deny: ['skill-nudge:'] });

// --- silent: the skill is already in the transcript tail --------------------------------------
T('silent when security-scan was already invoked this session', BASE_PROMPT,
  { tail: USED_TAIL, deny: ['skill-nudge:'] });

// --- silent: a slash command is already a skill invocation ------------------------------------
T('silent on a slash command', '/security-scan the payment module',
  { deny: ['skill-nudge:'] });

// --- once per session --------------------------------------------------------------------------
// Idempotent across repeated runs: without clearing the ledger the first case below would read as
// the second and the pair would pass for the wrong reason.
const SESSION = 'fixture-skill-nudge-session';
try { fs.unlinkSync(path.join(FAKEHOME, '.claude', '.skill-nudge-' + SESSION + '.json')); } catch (_) {}
T('speaks on the first matching prompt of a session', BASE_PROMPT,
  { sessionId: SESSION, want: ['skill-nudge:'] });
T('SILENT on the second matching prompt of the same session',
  'also audit the settings page for vulnerabilities',
  { sessionId: SESSION, deny: ['skill-nudge:'] });

let pass = 0, fail = 0;
const lines = [];
for (const c of cases) {
  const r = call(c.prompt, { tail: c.tail, sessionId: c.sessionId });
  const problems = [];
  if (r.status !== 0) problems.push('exit ' + r.status);
  for (const w of c.want || []) if (!r.note.includes(w)) problems.push('missing "' + w + '"');
  for (const d of c.deny || []) if (r.note.includes(d)) problems.push('unexpected "' + d + '"');
  if (problems.length) { fail++; lines.push('FAIL  ' + c.name + '  [' + problems.join('; ') + ']  note="' + r.note + '"'); }
  else { pass++; lines.push('PASS  ' + c.name); }
}

try { fs.unlinkSync(TRANSCRIPT); } catch (_) {}
console.log(lines.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed of ' + (pass + fail) + ' cases');
process.exitCode = fail > 0 ? 1 : 0;
