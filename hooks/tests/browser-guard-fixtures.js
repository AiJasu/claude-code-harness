'use strict';
// Fixtures for browser-guard.js. Run: node ~/.claude/hooks/tests/browser-guard-fixtures.js
//
// Guards against a hole where job 2 was evaluated only inside the mutating-action branch, so
// screenshots - most of the bytes of a long console drive - never reached it. A hook with no
// suite cannot tell "found nothing" from "never ran".
//
// Every case drives the REAL hook over stdin under a sandboxed HOME and asserts the exact string
// on hookSpecificOutput.additionalContext, or the exit-2 block on stderr. The hook is stateful per
// session (last host + a call count in ~/.claude/.browser-host-<session>.json), so the sections
// below are SEQUENCES and each uses its own session id.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'browser-guard.js');
const FAKEHOME = path.join(__dirname, '.fakehome-bg');

function freshHome() {
  // PURGE: the count and the cached host survive between RUNS otherwise, and case 1 would start
  // at call 15 instead of call 1 on the second run.
  try { fs.rmSync(FAKEHOME, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(path.join(FAKEHOME, '.claude'), { recursive: true });
}
freshHome();

function call(sid, tool, toolInput) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      session_id: sid,
      tool_name: 'mcp__claude-in-chrome__' + tool,
      tool_input: toolInput,
    }),
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

// Shorthands for the three call shapes a console drive is made of.
const nav = (sid, url) => call(sid, 'navigate', { url });
const shot = (sid) => call(sid, 'computer', { action: 'screenshot' });
const click = (sid) => call(sid, 'computer', { action: 'left_click', coordinate: [10, 10] });

let pass = 0, fail = 0;
const lines = [];
function T(name, r, opts) {
  const p = [];
  const want = opts.want || [];
  const wantNot = opts.wantNot || [];
  if (opts.exitCode !== undefined && r.status !== opts.exitCode) p.push('exit ' + r.status);
  if (opts.exitCode === undefined && r.status !== 0) p.push('expected exit 0, got ' + r.status);
  const hay = opts.onStderr ? r.stderr : r.note;
  for (const w of want) if (!hay.includes(w)) p.push('missing "' + w + '"');
  for (const w of wantNot) if (hay.includes(w)) p.push('unexpected "' + w + '"');
  if (opts.silent && r.note) p.push('expected no note, got "' + r.note.slice(0, 70) + '"');
  if (p.length) { fail++; lines.push('FAIL  ' + name + '  [' + p.join('; ') + ']'); }
  else { pass++; lines.push('PASS  ' + name); }
}

const PANEL = 'authenticated account panel';
const VOLUME = 'Finish this drive in a FOREGROUND subagent';
const SENSITIVE = 'https://github.com/settings/tokens';

// --- 1. the original behavior, calls 1-3 -----------------------------------------------------
{
  const sid = 'bg-early';
  T('1a navigate onto a sensitive host is itself mutating and warns (call 1)',
    nav(sid, SENSITIVE), { want: [PANEL], wantNot: [VOLUME] });
  T('1b a click at call 2 keeps the original wording',
    click(sid), { want: [PANEL], wantNot: [VOLUME] });
  T('1c a screenshot at call 3 still says nothing - unchanged below the threshold',
    shot(sid), { silent: true });
}

// --- 2. the volume note: the 4th call, and screenshots reaching it -----------------------------
{
  const sid = 'bg-volume';
  nav(sid, SENSITIVE); click(sid); click(sid);
  T('2a call 4 REPLACES the panel text with the volume note',
    click(sid), { want: [VOLUME, '4 browser calls'], wantNot: ['screenshot the current state'] });
  T('2b the replacement still carries the credential-field warning it replaced',
    click(sid), { want: [VOLUME, 'credential-display field', '5 browser calls'] });
}
{
  // One navigate then nothing but screenshots: non-mutating calls must still be counted.
  const sid = 'bg-shots';
  nav(sid, SENSITIVE);
  T('2c screenshot at call 2 is silent (below the threshold, non-mutating)', shot(sid), { silent: true });
  shot(sid);
  T('2d a SCREENSHOT-ONLY sequence reaches the volume note at call 4',
    shot(sid), { want: [VOLUME, '4 browser calls'] });
}

// --- 3. a non-sensitive host never counts and never speaks ------------------------------------
{
  const sid = 'bg-plain';
  let last = nav(sid, 'https://example.com/docs/page');
  T('3a navigate onto an ordinary host is silent', last, { silent: true });
  for (let i = 0; i < 6; i++) last = click(sid);
  T('3b still silent after 7 calls - the count is per sensitive host, not per call', last, { silent: true });
}

// --- 4. the count is per session --------------------------------------------------------------
{
  const sid = 'bg-second';
  T('4a a different session starts back at call 1',
    nav(sid, SENSITIVE), { want: [PANEL], wantNot: [VOLUME] });
}

// --- 5. host/path matching regressions -------
{
  T('5a github.com/settings matches as a host+path prefix',
    nav('bg-gh', 'https://github.com/settings/tokens'), { want: [PANEL] });
  T('5b github.com elsewhere does not',
    nav('bg-gh2', 'https://github.com/anthropics/claude-code'), { silent: true });
  T('5c a redirector carrying the token in its QUERY never warns - it would name the wrong host',
    nav('bg-redir', 'https://example.com/go?next=github.com/settings'), { silent: true });
  T('5d a bare-host entry (a cloud console) warns on its host alone',
    nav('bg-host', 'https://portal.azure.com/#home'), { want: [PANEL] });
}

// --- 6. the opt-in allowlist still blocks -----------------------------------------------------
{
  fs.writeFileSync(path.join(FAKEHOME, '.claude', 'browser-write-allowlist.txt'), 'example.com\n');
  T('6a a state-changing call on an unlisted host is blocked with the host named',
    nav('bg-allow', 'https://github.com/settings/tokens'),
    { exitCode: 2, onStderr: true, want: ['browser-guard:', 'github.com'] });
  T('6b a listed host passes',
    nav('bg-allow2', 'https://example.com/anything'), { silent: true });
  try { fs.unlinkSync(path.join(FAKEHOME, '.claude', 'browser-write-allowlist.txt')); } catch (_) {}
}

// --- 7. the log is still state-changing calls ONLY, though the COUNT is every call -------------
{
  const sid = 'bg-log';
  nav(sid, SENSITIVE);
  shot(sid); shot(sid); shot(sid);
  let log = '';
  try { log = fs.readFileSync(path.join(FAKEHOME, '.claude', 'browser-actions.log'), 'utf8'); } catch (_) {}
  const mine = log.split('\n').filter((l) => l.includes(sid));
  T('7a three screenshots after one navigate leave exactly ONE log line',
    { status: 0, note: mine.length === 1 ? 'ok' : 'got ' + mine.length + ' lines', stderr: '' },
    { want: ['ok'] });
}

// --- 8. the host cache keeps origin+path, never the query or fragment ----------------------------
// The old hook cached the full navigated URL, so an OAuth code in a query string sat on disk.
{
  const sid = 'bg-query';
  const fakeCode = ['fake', 'code', '42'].join('-');
  nav(sid, SENSITIVE + '?code=' + fakeCode + '#frag-part');
  let raw = '';
  try { raw = fs.readFileSync(path.join(FAKEHOME, '.claude', '.browser-host-' + sid + '.json'), 'utf8'); } catch (_) {}
  T('8a the cached url has no query or fragment',
    // RESULT_OK, not 'ok': the failure text quotes the cached URL, and "tokens" contains "ok".
    { status: 0, note: raw && !raw.includes(fakeCode) && !raw.includes('frag-part') && raw.includes('"url":"' + SENSITIVE + '"') ? 'RESULT_OK' : 'cached: ' + raw, stderr: '' },
    { want: ['RESULT_OK'] });
  T('8b a later click still matches the cached path and warns', click(sid), { want: [PANEL] });
}
{
  // A URL with NO path: the old hostOf took everything up to the first "/", so the query,
  // fragment or user:pass@ became part of the cached and logged host.
  const fakeSecret = ['fake', 'secret', '43'].join('-');
  const cases = [
    ['8c bare host with a query', 'bg-q2', 'https://app.example.com?code=' + fakeSecret],
    ['8d bare host with a fragment', 'bg-f2', 'https://app.example.com#access=' + fakeSecret],
    ['8e userinfo before the host', 'bg-u2', 'https://someone:' + fakeSecret + '@app.example.com/home'],
  ];
  for (const [name, sid, url] of cases) {
    nav(sid, url);
    let raw = '';
    try { raw = fs.readFileSync(path.join(FAKEHOME, '.claude', '.browser-host-' + sid + '.json'), 'utf8'); } catch (_) {}
    let log = '';
    try { log = fs.readFileSync(path.join(FAKEHOME, '.claude', 'browser-actions.log'), 'utf8'); } catch (_) {}
    const logLine = log.split('\n').filter((l) => l.includes(sid)).join('\n');
    const okCache = raw.includes('"host":"app.example.com"') && !raw.includes(fakeSecret) && !raw.includes('someone');
    const okLog = / app\.example\.com$/.test(logLine) && !logLine.includes(fakeSecret);
    T(name + ': host is app.example.com and the secret is in neither the cache nor the log',
      { status: 0, note: okCache && okLog ? 'RESULT_OK' : 'cache: ' + raw + ' log: ' + logLine, stderr: '' },
      { want: ['RESULT_OK'] });
  }
}

// --- 9. session-start.js GCs this hook's per-session cache (and the other per-session files) ------
// Its old GC regex only knew .last-prompt-* and .context-nudge-*, so these piled up forever.
{
  const SS = path.join(__dirname, '..', 'session-start.js');
  const dir = path.join(FAKEHOME, '.claude');
  const old = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
  const aged = ['.browser-host-gc-old.json', '.context-resume-gc-old.json', '.skill-nudge-gc-old.json'];
  for (const f of aged.concat(['.browser-host-gc-fresh.json', '.config-drift-seen.json'])) fs.writeFileSync(path.join(dir, f), '{}');
  for (const f of aged.concat(['.config-drift-seen.json'])) fs.utimesSync(path.join(dir, f), old, old);
  const res = spawnSync(process.execPath, [SS], {
    input: JSON.stringify({ session_id: 'bg-gc', source: 'startup', cwd: FAKEHOME }),
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HOME: FAKEHOME, USERPROFILE: FAKEHOME },
  });
  const left = (f) => fs.existsSync(path.join(dir, f));
  T('9a aged .browser-host / .context-resume / .skill-nudge files are removed',
    { status: res.status, note: aged.filter(left).length ? 'kept: ' + aged.filter(left).join(', ') : 'RESULT_OK', stderr: '' },
    { want: ['RESULT_OK'] });
  T('9b a fresh .browser-host file and a non-session ledger are kept',
    { status: 0, note: left('.browser-host-gc-fresh.json') && left('.config-drift-seen.json') ? 'RESULT_OK' : 'deleted', stderr: '' },
    { want: ['RESULT_OK'] });
}

console.log(lines.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed of ' + (pass + fail) + ' cases');
process.exitCode = fail > 0 ? 1 : 0;
