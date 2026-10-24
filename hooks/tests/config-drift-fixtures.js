'use strict';
// Fixtures for config-drift-check.js's MODEL arm, against the LIVE hook.
// Run: node hooks/tests/config-drift-fixtures.js
//
// What it pins, beyond the plain cases:
//   1. An ABSENT model key must be visible: picking the "(default)" entry in /model DELETES the
//      key rather than writing it.
//   2. An explicitly EMPTY CLAUDE_MODEL_PIN is an opt-out (`??`, not `||`).
//   3. Baseline and escalation are independent rules - see the hook header.
//
// Cases assert the SHIPPED behavior and, where a case pins a change, that the OLD predicate
// would have behaved differently on the same input. A fixture that passes under both versions
// pins nothing.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'config-drift-check.js');
const SANDBOX = path.join(__dirname, '.fakehome-cdc');
// The hook's cwd lives OUTSIDE this checkout: the sandbox sits inside the repo, and a repo-local
// core.hooksPath on the checkout would otherwise make the hooksPath arm speak on a "clean" run.
const CWD = path.join(os.tmpdir(), 'claude-cdc-fixture-cwd');
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5[1m]';

fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });
fs.mkdirSync(CWD, { recursive: true });

// keepLedger=true skips the clear below, for the (a) ratchet cases further down that need
// several consecutive calls to share one ledger, the way real consecutive SessionStarts would.
// Every other case in this file calls run() with keepLedger omitted, so the consecutive-sighting
// counter cannot leak state between unrelated cases: each one starts as an isolated sighting 1.
// stdin = a SessionStart payload object for arm (a2); omitted, the hook reads empty stdin.
function run(settings, pin, keepLedger, stdin) {
  if (!keepLedger) {
    try { fs.unlinkSync(path.join(SANDBOX, '.claude', '.config-drift-seen.json')); } catch (_) {}
  }
  const file = path.join(SANDBOX, '.claude', 'settings.json');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  const env = { ...process.env, HOME: SANDBOX, USERPROFILE: SANDBOX };
  if (pin === undefined) delete env.CLAUDE_MODEL_PIN;
  else env.CLAUDE_MODEL_PIN = pin;
  const res = spawnSync(process.execPath, [HOOK], {
    cwd: CWD,                        // no .git above it, so the hooksPath arm stays quiet
    env,
    encoding: 'utf8',
    timeout: 10000,
    input: stdin === undefined ? undefined : JSON.stringify(stdin),
  });
  // Scope to the model arm; a bare sandbox legitimately trips other checks.
  return (res.stdout || '').split('\n').filter((l) => /model (pin|default)/i.test(l)).join(' | ');
}

// The earlier single-rule predicate, for the pins-the-change assertions.
function oldPredicateFires(settings) {
  return !!(settings && settings.model && !String(settings.model).startsWith(OPUS));
}

let pass = 0;
let fail = 0;
function T(name, actual, expect) {
  const ok = expect instanceof RegExp ? expect.test(actual) : actual === expect;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got: ${JSON.stringify(actual)}`}`);
  ok ? pass++ : fail++;
}

const noKey = { env: {} };
const opus = { model: OPUS, env: {} };
const fable = { model: FABLE, env: {} };
// What `/model fable` actually persists: the bare alias, not a "claude-fable-..." id.
const fableBare = { model: 'fable', env: {} };
const haiku = { model: 'claude-haiku-4-5-20251001', env: {} };
const sonnet = { model: 'claude-sonnet-5', env: {} };
const future = { model: 'claude-opus-9-20990101', env: {} };

// --- Rule (a): escalation leak. Fires on every baseline, because Fable is per-session only. ---
T('(a) fable saved as default -> warns, baseline default', run(fable, undefined), /ESCALATION tier/);
T('(a) fable saved as default -> warns, baseline pinned', run(fable, OPUS), /ESCALATION tier/);
T('(a) the warning names the per-session remedy', run(fable, undefined), /per-session/);
T('(a) fable is NOT reported as a missing pin', run(fable, OPUS), /^(?!.*ABSENT).*$/);
T('(a) BARE "fable" (what /model --save actually writes) -> warns ESCALATION, baseline default',
  run(fableBare, undefined), /ESCALATION tier/);
T('(a) BARE "fable" -> warns ESCALATION, baseline pinned', run(fableBare, OPUS), /ESCALATION tier/);
// Pins the change: the OLD /^claude-fable/i regex does not match the bare alias, so on the old
// hook this case fell through to rule (b)'s generic PINNED message instead.
T('OLD /^claude-fable/i did NOT match the bare alias (this is the bug being fixed)',
  /^claude-fable/i.test('fable'), false);
T('NEW /fable/i matches the bare alias', /fable/i.test('fable'), true);

// --- Rule (b): baseline. 'default' means the key is EXPECTED to be absent, so ANY key is drift.
// Tested against the intended state, not against a list of bad model ids - so a model nobody has
// heard of yet is caught on the same line as the ones that exist today.
T('(b) default baseline + no key -> silent (the shipped state)', run(noKey, undefined), '');
T('(b) default baseline + opus pinned -> warns PINNED', run(opus, undefined), /PINNED but the baseline/);
T('(b) default baseline + haiku pinned -> warns (was silent before)', run(haiku, undefined), /PINNED but the baseline/);
T('(b) default baseline + sonnet pinned -> warns', run(sonnet, undefined), /PINNED but the baseline/);
T('(b) default baseline + an unknown future id -> warns, no tier list to update', run(future, undefined), /PINNED but the baseline/);
T('(b) PINNED warning names the /model remedy that deletes the key', run(haiku, undefined), /deletes the key/);
T('(b) pinned baseline + no key -> warns ABSENT', run(noKey, OPUS), /model pin ABSENT/);
T('(b) ABSENT warning names the /model default-entry cause', run(noKey, OPUS), /\(default\)/);
T('(b) pinned baseline + matching key -> silent', run(opus, OPUS), '');
T('(b) re-baseline to sonnet -> opus now reported as drift', run(opus, 'claude-sonnet-5'), /drifted/);

// --- Opt-out: an explicitly empty value disables BOTH rules, as the header promises. ---
T('opt-out: empty pin silences the absent case', run(noKey, ''), '');
T('opt-out: empty pin silences even the fable case', run(fable, ''), '');

// --- Rule (a2): Fable as the RESOLVED default with no key. The /model Default row can follow the
// last saved pick, so the key is gone while new sessions still start on Fable. Pins the change
// structurally: before this arm the hook never read stdin, so EVERY case below was silent on the
// old hook - including the first, the one the arm exists for.
const startFable = { source: 'startup', model: 'claude-fable-5-1' };
T('(a2) startup + no key + session on Fable -> warns', run(noKey, undefined, false, startFable),
  /resolves to the ESCALATION tier/);
T('(a2) startup + no key + session on Opus -> silent', run(noKey, undefined, false,
  { source: 'startup', model: 'claude-opus-5-5' }), '');
T('(a2) resume + no key + session on Fable -> silent (may be a per-session /model fable)',
  run(noKey, undefined, false, { source: 'resume', model: 'claude-fable-5-1' }), '');
T('(a2) startup payload without a model field -> silent', run(noKey, undefined, false,
  { source: 'startup' }), '');
T('(a2) startup + fable KEY + session on Fable -> one ESCALATION line, not two',
  run(fable, undefined, false, startFable), /^(?!.*resolves to).*ESCALATION tier[^|]*$/);
T('(a2) opt-out: empty pin silences it too', run(noKey, '', false, startFable), '');

// --- Pins the change: the old single-rule predicate cannot produce these results. ---
T('OLD predicate was SILENT on the absent case', oldPredicateFires(noKey), false);
T('OLD predicate fired on fable (rule (a) preserves this)', oldPredicateFires(fable), true);
T('OLD predicate silent on opus (unchanged)', oldPredicateFires(opus), false);

// --- Heartbeat. This hook is silent on a clean config, so "ran and found nothing" and "the
// SessionStart wiring never invoked it" would look identical. The ledger is DELETED before each
// run below, so a passing case proves THIS run wrote it - a leftover from an earlier run would
// prove nothing.
const BEAT = path.join(SANDBOX, '.claude', '.config-drift-seen.json');
function beatAfter(settings, pin) {
  try { fs.unlinkSync(BEAT); } catch (_) {}
  run(settings, pin);
  try { return JSON.parse(fs.readFileSync(BEAT, 'utf8')); } catch (_) { return null; }
}
{
  // "Clean" also needs the auto-compact surface set (noKey's bare `env: {}` trips it on its own,
  // see the auto-compact block below).
  const cleanSettings = { env: {}, autoCompactWindow: 300000, permissions: { defaultMode: 'auto' } };
  const clean = beatAfter(cleanSettings, undefined);
  T('heartbeat: written on a CLEAN run', !!clean && typeof clean._lastFired === 'string', true);
  T('heartbeat: clean run records zero warnings', clean && clean.warnings, 0);
  T('heartbeat: _lastFired parses as a date', !!clean && !isNaN(Date.parse(clean._lastFired)), true);
  const noisy = beatAfter(fable, undefined);   // rule (a) fires
  T('heartbeat: written on a WARNING run too', !!noisy && typeof noisy._lastFired === 'string', true);
  T('heartbeat: warning run counts at least one', !!noisy && noisy.warnings >= 1, true);
  T('heartbeat: names the arm, not the payload', !!noisy && Array.isArray(noisy.arms) && noisy.arms.length >= 1, true);
  // The ledger must never carry the settings values the warning text quotes.
  T('heartbeat: does not leak the model id', !!noisy && !JSON.stringify(noisy.arms).includes(FABLE), true);
}

// --- (a) ESCALATION RATCHET ---------------------------------------------------------------------
// Detection is proven by the rule-(a) cases above; this block proves that a repeated sighting
// eventually becomes an ask instead of repeating the same passive line forever. Calls
// use keepLedger=true so consecutive invocations share one ledger, as consecutive real
// SessionStarts would.
{
  const clearBeat = () => { try { fs.unlinkSync(BEAT); } catch (_) {} };
  clearBeat();

  const first = run(fable, undefined, true);
  T('ratchet: sighting 1 is the plain warning', /ESCALATION tier/.test(first), true);
  T('ratchet: sighting 1 does not carry the act-instruction', /ACT ON/.test(first), false);

  const second = run(fable, undefined, true);
  T('ratchet: sighting 2 upgrades to the act-instruction', /ACT ON/.test(second), true);
  T('ratchet: sighting 2 names the consecutive count', /2 consecutive sessions/.test(second), true);

  const thirdImmediate = run(fable, undefined, true);
  T('ratchet: sighting 3, inside the 7-day cooldown, is silent', thirdImmediate, '');

  // Age the ledger's escalation timestamp past the cooldown window instead of waiting on a real clock.
  const beat = JSON.parse(fs.readFileSync(BEAT, 'utf8'));
  beat.escalation.lastEscalatedIso = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(BEAT, JSON.stringify(beat, null, 2));
  const fourth = run(fable, undefined, true);
  T('ratchet: speaks again once the cooldown has elapsed', /ACT ON/.test(fourth), true);
  T('ratchet: the re-fire names the true running count, not a reset', /4 consecutive sessions/.test(fourth), true);
  T('ratchet: the ledger never carries the model id', !JSON.stringify(JSON.parse(fs.readFileSync(BEAT, 'utf8')).escalation).includes(FABLE), true);

  clearBeat();
  const resetFirst = run(fable, undefined, true);
  T('ratchet: a cleared ledger starts back at sighting 1', /ESCALATION tier/.test(resetFirst) && !/ACT ON/.test(resetFirst), true);

  // A session where the tier clears in between (e.g. /model back to default) must reset the
  // streak, so a LATER reappearance is sighting 1 again rather than resuming a stale count.
  run(opus, undefined, true);
  const afterClear = run(fable, undefined, true);
  T('ratchet: the count resets once the tier clears in between', /ESCALATION tier/.test(afterClear) && !/ACT ON/.test(afterClear), true);

  clearBeat();
}

// --- (c) AUTO-COMPACT WINDOW --------------------------------------------------------------------
// Case 1 pins neither surface set. Case 2 pins the supported settings.json key as silent, cases
// 3-4 the target boundary from both sides, case 5 a non-numeric env value. Cases 6-7 pin the
// env var's precedence over the settings key both ways, matching the CLI's own resolver order:
// an env var that is itself bad wins even over a good settings key, and vice versa.
{
  function acRun(settings) {
    const file = path.join(SANDBOX, '.claude', 'settings.json');
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
    const env = { ...process.env, HOME: SANDBOX, USERPROFILE: SANDBOX, CLAUDE_MODEL_PIN: '' };
    const res = spawnSync(process.execPath, [HOOK], { cwd: CWD, env, encoding: 'utf8', timeout: 10000 });
    return (res.stdout || '').split('\n').filter((l) => /AUTO_COMPACT_WINDOW|autoCompactWindow/.test(l)).join(' | ');
  }

  T('(c) neither surface set -> warns',
    acRun({ env: {} }), /Neither the settings\.json/);
  T('(c) settings.json autoCompactWindow: 300000 -> silent',
    acRun({ autoCompactWindow: 300000, env: {} }), '');
  T('(c) settings.json autoCompactWindow: 400000 -> silent (at the target boundary)',
    acRun({ autoCompactWindow: 400000, env: {} }), '');
  T('(c) settings.json autoCompactWindow: 500000 -> warns, above target',
    acRun({ autoCompactWindow: 500000, env: {} }), /above the 400000 target/);
  T('(c) env var non-numeric -> warns rather than silently passing',
    acRun({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'auto' } }), /above the 400000 target/);
  T('(c) env var takes precedence: bad env (500000) over a good settings key (300000) -> still warns',
    acRun({ autoCompactWindow: 300000, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' } }), /above the 400000 target/);
  T('(c) env var takes precedence: good env (300000) over a bad settings key (900000) -> silent',
    acRun({ autoCompactWindow: 900000, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' } }), '');
}

// --- (d) AUTO MODE ------------------------------------------------------------------------------
// Case 1 pins defaultMode auto with no autoMode block as silent.
{
  function amRun(settings, expectMode) {
    const file = path.join(SANDBOX, '.claude', 'settings.json');
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
    const env = { ...process.env, HOME: SANDBOX, USERPROFILE: SANDBOX, CLAUDE_MODEL_PIN: '' };
    delete env.CLAUDE_EXPECT_DEFAULT_MODE;
    if (expectMode !== undefined) env.CLAUDE_EXPECT_DEFAULT_MODE = expectMode;
    const res = spawnSync(process.execPath, [HOOK], { cwd: CWD, env, encoding: 'utf8', timeout: 10000 });
    return (res.stdout || '').split('\n').filter((l) => /autoMode\.|defaultMode/.test(l)).join(' | ');
  }
  const auto = { permissions: { defaultMode: 'auto' }, env: {} };
  T('(d) defaultMode auto, no autoMode block -> silent', amRun(auto), '');
  T('(d) autoMode lists that keep "$defaults" -> silent',
    amRun({ ...auto, autoMode: { allow: ['$defaults', 'x'], environment: ['$defaults', 'y'] } }), '');
  T('(d) autoMode.environment without "$defaults" -> warns REPLACES',
    amRun({ ...auto, autoMode: { environment: ['only mine'] } }), /autoMode\.environment .*REPLACES/);
  T('(d) empty autoMode list -> silent (an empty list replaces nothing)',
    amRun({ ...auto, autoMode: { allow: [] } }), '');
  T('(d) defaultMode bypassPermissions -> warns', amRun({ permissions: { defaultMode: 'bypassPermissions' }, env: {} }),
    /defaultMode .* is bypassPermissions: every permission prompt is skipped/);
  T('(d) defaultMode bypassPermissions warns even when it is the expected mode',
    amRun({ permissions: { defaultMode: 'bypassPermissions' }, env: {} }, 'bypassPermissions'), /is bypassPermissions/);
  // The mode is the user's pick: no expectation set means no warning (the earlier hook expected
  // auto for everyone and warned here).
  T('(d) defaultMode unset, no CLAUDE_EXPECT_DEFAULT_MODE -> silent', amRun({ env: {} }), '');
  T('(d) defaultMode default, no CLAUDE_EXPECT_DEFAULT_MODE -> silent', amRun({ permissions: { defaultMode: 'default' }, env: {} }), '');
  T('(d) defaultMode unset, CLAUDE_EXPECT_DEFAULT_MODE=auto -> warns', amRun({ env: {} }, 'auto'),
    /defaultMode .* is unset, not auto \(CLAUDE_EXPECT_DEFAULT_MODE\)/);
  T('(d) defaultMode auto, CLAUDE_EXPECT_DEFAULT_MODE=auto -> silent', amRun(auto, 'auto'), '');
}

// --- MCP servers --------------------------------------------------------------------------------
// Any server in ~/.claude.json warns unless CLAUDE_MCP_ALLOW names it. Names below are invented.
{
  const CJ = path.join(SANDBOX, '.claude.json');
  function mcpRun(claudeJson, allow) {
    fs.writeFileSync(path.join(SANDBOX, '.claude', 'settings.json'), JSON.stringify({ env: {} }, null, 2));
    fs.writeFileSync(CJ, JSON.stringify(claudeJson, null, 2));
    const env = { ...process.env, HOME: SANDBOX, USERPROFILE: SANDBOX, CLAUDE_MODEL_PIN: '' };
    delete env.CLAUDE_MCP_ALLOW;
    if (allow !== undefined) env.CLAUDE_MCP_ALLOW = allow;
    const res = spawnSync(process.execPath, [HOOK], { cwd: CWD, env, encoding: 'utf8', timeout: 10000 });
    return (res.stdout || '').split('\n').filter((l) => /MCP server/.test(l)).join(' | ');
  }
  const two = { mcpServers: { 'notes-server': {}, 'files-server': {} }, projects: { '/work/app': { mcpServers: { 'db-server': {} } } } };
  T('mcp: no servers -> silent', mcpRun({}), '');
  T('mcp: unlisted servers -> warns, naming each', mcpRun(two), /top-level: notes-server, files-server .*\/work\/app: db-server/);
  T('mcp: allow list removes the named ones only', mcpRun(two, 'notes-server, db-server'), /top-level: files-server$/);
  T('mcp: every server allowed -> silent', mcpRun(two, 'notes-server,files-server,db-server'), '');
  try { fs.unlinkSync(CJ); } catch (_) {}
}

// --- Env and helper VALUES never reach the output ------------------------------------------------
// The old hook printed `${k}=${value}` and the helper command line. Values are fake, built from parts.
{
  function envRun(settings) {
    fs.writeFileSync(path.join(SANDBOX, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
    const env = { ...process.env, HOME: SANDBOX, USERPROFILE: SANDBOX, CLAUDE_MODEL_PIN: '' };
    const res = spawnSync(process.execPath, [HOOK], { cwd: CWD, env, encoding: 'utf8', timeout: 10000 });
    return res.stdout || '';
  }
  const fakeAuthValue = ['fake', 'auth', 'value', '0000'].join('-');
  const fakeProxyPass = ['example', 'pass', '1111'].join('');
  const fakeHelperCmd = 'echo ' + ['fake', 'helper', 'out'].join('-');
  const out = envRun({
    env: { ANTHROPIC_AUTH_TOKEN: fakeAuthValue, HTTPS_PROXY: 'http://user:' + fakeProxyPass + '@proxy.example:8080' },
    apiKeyHelper: fakeHelperCmd,
  });
  const lines = out.split('\n').filter((l) => /env in|command-executing/.test(l)).join(' | ');
  T('values: each flagged env key is named', /ANTHROPIC_AUTH_TOKEN is set/.test(lines) && /HTTPS_PROXY is set/.test(lines), true);
  T('values: the helper key is named', /command-executing key apiKeyHelper is set/.test(lines), true);
  T('values: no env value or helper command anywhere in the output',
    [fakeAuthValue, fakeProxyPass, 'proxy.example', 'fake-helper-out'].some((v) => out.includes(v)), false);

  // Unfamiliar hook and statusLine commands: the event and what runs, never the command line
  // (the previous hook printed it whole, token and all).
  const fakeArgValue = ['fake', 'arg', 'value', '2222'].join('-');
  const hookOut = envRun({
    env: {},
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /opt/tools/audit-hook.js --key ' + fakeArgValue }] }] },
    statusLine: { type: 'command', command: 'bash -c "curl -s https://status.example/?t=' + fakeArgValue + '"' },
  });
  const hookLines = hookOut.split('\n').filter((l) => /unfamiliar/.test(l)).join(' | ');
  T('commands: the hook warning names the event and the script it runs',
    /unfamiliar hook command under PreToolUse in user settings\.json: runs audit-hook\.js/.test(hookLines), true);
  T('commands: the statusLine warning names what runs', /unfamiliar statusLine command in user settings\.json: runs bash/.test(hookLines), true);
  T('commands: no argument value or URL from either command reaches the output',
    [fakeArgValue, 'status.example', '/opt/tools'].some((v) => hookOut.includes(v)), false);
}

// --- (e) SAVED EFFORT vs TOP-LEVEL EFFORT -------------------------------------------------------
// The settings shape is the CLI's (a top-level effortLevel plus per-model entries that /effort
// writes); the values are synthetic. The hook before this arm read neither key, so case 1 and the
// re-arm cases are the ones it fails. Every other case is a near miss that must stay silent.
{
  function efRun(settings, keepLedger) {
    if (!keepLedger) { try { fs.unlinkSync(BEAT); } catch (_) {} }
    fs.writeFileSync(path.join(SANDBOX, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
    const env = { ...process.env, HOME: SANDBOX, USERPROFILE: SANDBOX, CLAUDE_MODEL_PIN: '' };
    const res = spawnSync(process.execPath, [HOOK], { cwd: CWD, env, encoding: 'utf8', timeout: 10000 });
    return {
      status: res.status,
      out: (res.stdout || '').split('\n').filter((l) => /effortLevel mismatch/.test(l)).join(' | '),
    };
  }
  const EF = (top, models) => ({ env: {}, effortLevel: top, modelSettings: models });
  const mixed = { 'claude-opus-5': { effortLevel: 'medium' }, 'claude-opus-5-5': { effortLevel: 'xhigh' } };

  const first = efRun(EF('medium', mixed));
  T('(e) top-level medium + a saved xhigh -> warns, exit 0', first.status + '|' + /effortLevel mismatch/.test(first.out), '0|true');
  T('(e) the line names the top-level value and the differing model entry',
    /top-level effortLevel is medium .*claude-opus-5-5=xhigh/.test(first.out), true);
  T('(e) the model entry that agrees with the top level is not listed', /claude-opus-5=medium/.test(first.out), false);
  T('(e) the line says a plain Agent call without effort inherits it', /plain Agent call that names a model but no effort inherits/.test(first.out), true);
  T('(e) the line says report only and never to reset the keys', /report only/.test(first.out) && /never rewrite them/.test(first.out), true);
  T('(e) the line is one line', first.out.includes(' | '), false);

  T('(e) all values equal -> silent', efRun(EF('medium', { 'claude-opus-5': { effortLevel: 'medium' } })).out, '');
  T('(e) no modelSettings at all -> silent', efRun({ env: {}, effortLevel: 'medium' }).out, '');
  T('(e) a saved level but no top-level effortLevel -> silent (no baseline to differ from)',
    efRun({ env: {}, modelSettings: mixed }).out, '');
  T('(e) malformed entries (null, a string, a number level) -> silent, exit 0',
    (() => { const r = efRun(EF('medium', { a: null, b: 'xhigh', c: { effortLevel: 5 }, d: {} })); return r.status + '|' + r.out; })(), '0|');

  // Once per change of the values, through the heartbeat ledger (keepLedger so runs share it).
  efRun(EF('medium', mixed));                                  // speaks, records the signature
  T('(e) a second consecutive run with the same values is silent', efRun(EF('medium', mixed), true).out, '');
  T('(e) a third is silent too (a ratchet, not a nag)', efRun(EF('medium', mixed), true).out, '');
  T('(e) a CHANGED saved level speaks again',
    /claude-opus-5-5=high/.test(efRun(EF('medium', { 'claude-opus-5-5': { effortLevel: 'high' } }), true).out), true);
  T('(e) a changed top-level value speaks again',
    /top-level effortLevel is low/.test(efRun(EF('low', { 'claude-opus-5-5': { effortLevel: 'high' } }), true).out), true);
  efRun(EF('medium', { 'claude-opus-5-5': { effortLevel: 'medium' } }), true);      // values agree again
  T('(e) after the values agree again the same mismatch re-arms and speaks',
    /effortLevel mismatch/.test(efRun(EF('medium', mixed), true).out), true);

  // The heartbeat carries a hash, never the model id or the level (config-drift-seen.json).
  efRun(EF('medium', mixed));
  const beatRaw = fs.readFileSync(BEAT, 'utf8');
  const beat = JSON.parse(beatRaw);
  T('(e) the heartbeat holds a 12-char signature', !!beat.effort && /^[0-9a-f]{12}$/.test(beat.effort.sig), true);
  T('(e) the heartbeat leaks neither the model id nor the saved level',
    beatRaw.includes('claude-opus-5-5') || beatRaw.includes('xhigh'), false);
  T('(e) the arms label is the leading clause only', beat.arms.includes('effortLevel mismatch (report only)'), true);
  efRun(EF('medium', { 'claude-opus-5-5': { effortLevel: 'medium' } }));
  T('(e) a clean run clears the signature', JSON.parse(fs.readFileSync(BEAT, 'utf8')).effort.sig, null);
}

try { fs.rmSync(CWD, { recursive: true, force: true }); } catch (_) {}
console.log(`\n${pass} passed, ${fail} failed of ${pass + fail}`);
process.exitCode = fail > 0 ? 1 : 0;
