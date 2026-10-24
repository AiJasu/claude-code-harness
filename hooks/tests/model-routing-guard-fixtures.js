'use strict';
// Fixtures for model-routing-guard.js: the blocking model rule (regression) plus the
// non-blocking checks LOOP (loop exit contract), VERIFY (right-size verification), RETURN
// (oversized workflow return) and the Agent-call EFFORT note.
// Run: node hooks/tests/model-routing-guard-fixtures.js (from the harness root)
//
// Every case runs through HOOK MODE rather than --scan, so what is asserted is the exact string
// the model receives on hookSpecificOutput.additionalContext - the one channel that reaches it.
//
// The MENTION-ONLY cases are the reason this suite exists. Both new checks read masked source,
// so a prompt that talks about a loop, or an agent whose prompt says "verify", must not trip
// them. Shipping a pattern rule without that case is exactly how the grep -P layer blocked a
// command that was merely searching for its own flag.
const { spawnSync } = require('child_process');
const path = require('path');

const fs = require('fs');
const os = require('os');
const HOOK = path.join(__dirname, '..', 'model-routing-guard.js');
// The workflow slot cap, computed from the machine and written out here rather than read from
// the hook, so a ledger note that hardcodes it fails the LEDGER cases below instead of agreeing
// with itself. Passes on any core count.
const CAP = Math.min(16, Math.max(2, os.cpus().length - 2));
const CWD = 'C:/Users/you/projects/app';
// The ScheduleWakeup cases write a tick ledger into ~/.claude; sandbox HOME so a test run can
// never disturb a live loop's counters.
const FAKEHOME = path.join(__dirname, '.fakehome-mrg');
fs.mkdirSync(path.join(FAKEHOME, '.claude'), { recursive: true });
try { fs.unlinkSync(path.join(FAKEHOME, '.claude', '.loop-ticks.json')); } catch (_) {}
try { fs.unlinkSync(path.join(FAKEHOME, '.claude', '.wf-ledger-spoken.json')); } catch (_) {}

function call(payload) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
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

function run(script) {
  return call({ tool_name: 'Workflow', session_id: 't1', cwd: CWD, tool_input: { script } });
}
function tick(session, input) {
  return call({ tool_name: 'ScheduleWakeup', session_id: session, cwd: CWD, tool_input: input });
}

const META = "export const meta = { name: 'fx', description: 'fixture' }\n";
const OPUS = "{ model: 'opus', effort: 'high' }";
const SONNET = "{ model: 'sonnet', effort: 'medium' }";

const cases = [];
// want/deny are substrings of the additionalContext note; blocks assert exit 2 instead.
function T(name, script, opts) { cases.push({ name, script: META + script, ...opts }); }

// --- the blocking rule still blocks (regression) ---------------------------------------------
T('BLOCK agent() with no model', "await agent('do a thing', { effort: 'low' })", { block: true });

// --- LOOP: unbounded agent loops --------------------------------------------------------------
T('LOOP flags while(!passed) around agent()',
  "let passed = false\n" +
  "while (!passed) {\n" +
  "  const r = await agent('critique the page', " + OPUS + ")\n" +
  "  passed = r.ok\n" +
  "}\n",
  { want: ['loop smell'] });

T('LOOP flags while(true) around agent()',
  "while (true) {\n" +
  "  const r = await agent('another round', " + OPUS + ")\n" +
  "  if (r.done) break\n" +
  "}\n",
  { want: ['loop smell'] });

T('LOOP flags do/while around agent()',
  "let ok = false\n" +
  "do {\n" +
  "  const r = await agent('judge it', " + OPUS + ")\n" +
  "  ok = r.ok\n" +
  "} while (!ok)\n",
  { want: ['loop smell'] });

T('LOOP silent on a round cap',
  "let dry = 0\n" +
  "while (dry < 2) {\n" +
  "  const r = await agent('find more bugs', " + OPUS + ")\n" +
  "  if (!r.bugs.length) dry++\n" +
  "}\n",
  { deny: ['loop smell'] });

T('LOOP silent on a budget guard',
  "while (budget.total && budget.remaining() > 50000) {\n" +
  "  await agent('find more bugs', " + OPUS + ")\n" +
  "}\n",
  { deny: ['loop smell'] });

T('LOOP silent on for-over-items',
  "const items = ['a', 'b']\n" +
  "for (let i = 0; i < items.length; i++) {\n" +
  "  await agent('handle ' + items[i], " + SONNET + ")\n" +
  "}\n",
  { deny: ['loop smell'] });

T('LOOP MENTION-ONLY: the pattern lives in a prompt string, not in code',
  "await agent('Refactor this snippet for me: while (true) { await agent(x) } - it never stops.', " + SONNET + ")\n" +
  "await agent('Write the fix into src/loop.js', " + SONNET + ")\n",
  { deny: ['loop smell'] });

// --- VERIFY: verification weight --------------------------------------------------------------
T('VERIFY flags a run that builds nothing',
  "await agent('audit the config', { model: 'opus', label: 'audit:config' })\n" +
  "await agent('review the error handling', { model: 'opus', label: 'review:errors' })\n" +
  "await agent('check the test coverage', { model: 'opus', label: 'verify:tests' })\n",
  { want: ['no build or apply stage'] });

T('VERIFY silent on a two-agent report (the note would prescribe what it already is)',
  "await agent('audit the config', { model: 'opus', label: 'audit:config' })\n" +
  "await agent('review the error handling', { model: 'opus', label: 'review:errors' })\n",
  { deny: ['verification smell'] });

T('VERIFY silent on a fan-out run: sites are not agents',
  "const claims = ['a', 'b', 'c']\n" +
  "await agent('draft the report', { model: 'opus', label: 'build:report' })\n" +
  "await parallel(claims.map((c) => () => agent('verify ' + c, { model: 'sonnet', label: 'verify:claim' })))\n" +
  "await agent('judge the votes', { model: 'opus', label: 'judge:roll-up' })\n",
  { deny: ['verification smell'] });

T('VERIFY flags one build against three verifiers',
  "await agent('write the patch', { model: 'sonnet', label: 'build:patch' })\n" +
  "await agent('refute it', { model: 'opus', label: 'verify:a' })\n" +
  "await agent('refute it again', { model: 'opus', label: 'verify:b' })\n" +
  "await agent('judge the refutations', { model: 'opus', label: 'judge:c' })\n",
  { want: ['at most ONE verify agent'] });

T('VERIFY silent when building outweighs checking',
  "await agent('write the data file', { model: 'sonnet', label: 'build:data' })\n" +
  "await agent('write the page', { model: 'sonnet', label: 'build:page' })\n" +
  "await agent('verify both parse', { model: 'sonnet', label: 'verify:parse' })\n",
  { deny: ['verification smell'] });

T('VERIFY MENTION-ONLY: label wins over a prompt that says verify',
  "await agent('Write the migration, then verify it parses and review your own diff.', " +
  "{ model: 'sonnet', label: 'build:migration' })\n" +
  "await agent('Write the second half the same way.', { model: 'sonnet', label: 'build:rest' })\n",
  { deny: ['verification smell'] });

// --- RETURN: the payload the completion notification carries -----------------------------------
// The silent cases are the shapes small returns use - a single field pick, a .map projection, a
// helper reduction - and the MENTION-ONLY case pins that prompt text cannot trip it.
const PAR = "const results = await parallel(['a', 'b'].map((x) => () => agent('research ' + x, " + SONNET + ")))\n";

T('RETURN flags a bare name fed by parallel()',
  PAR + "return results\n",
  { want: ['return smell'] });

T('RETURN flags an object holding a pushed collection',
  "const items = ['a', 'b']\nconst confirmed = []\n" +
  "for (let i = 0; i < items.length; i++) {\n" +
  "  const v = await agent('refute ' + items[i], " + SONNET + ")\n" +
  "  if (v) confirmed.push(v)\n" +
  "}\n" +
  "return { confirmed, count: confirmed.length }\n",
  { want: ['return smell'] });

T('RETURN flags JSON.stringify of agent output',
  "const out = await agent('write the report', " + SONNET + ")\nreturn JSON.stringify(out)\n",
  { want: ['return smell'] });

T('RETURN flags a spread of agent output',
  "const merged = await agent('merge the parts', " + SONNET + ")\nreturn { ...merged, round: 2 }\n",
  { want: ['return smell'] });

T('RETURN flags null-guarded fields kept in an accumulator',
  PAR + "const out = {}\n" +
  "for (let i = 0; i < results.length; i++) {\n" +
  "  const r = results[i] || {}\n" +
  "  out['k' + i] = { headline: r.research && r.research.headline || null }\n" +
  "}\n" +
  "return out\n",
  { want: ['return smell'] });

T('RETURN flags agent output passed through a lenient parser',
  "const parse = (t) => { try { return JSON.parse(t) } catch (_) { return { report: t } } }\n" +
  "const raw = await agent('find bugs', " + SONNET + ")\n" +
  "const findings = parse(raw)\n" +
  "return findings\n",
  { want: ['return smell'] });

T('RETURN silent on a headline: a path, counts and a computed flag',
  PAR + "return { report: 'C:/x/report.md', found: results.length, ok: results.filter(Boolean).length === 2 }\n",
  { deny: ['return smell'] });

T('RETURN silent on single field picks of agent output',
  "const synth = await agent('synthesize', " + SONNET + ")\nreturn { verdict: synth.verdict, path: synth.path }\n",
  { deny: ['return smell'] });

T('RETURN silent on a .map field projection',
  PAR + "return results.map((r) => ({ id: r.id, ok: r.ok }))\n",
  { deny: ['return smell'] });

// A map that hands each item back is raw, not a projection.
T('RETURN flags a pass-through .map with a null fallback',
  PAR + "return { results: results.map((r, i) => r || { key: 'k' + i, summary: 'NULL' }) }\n",
  { want: ['return smell'] });

T('RETURN flags a pass-through .map with ?? and wrapping parens',
  PAR + "return results.map(r => (r ?? null))\n",
  { want: ['return smell'] });

T('RETURN silent on a .map field pick with a fallback',
  PAR + "return results.map((r) => r.summary || 'none')\n",
  { deny: ['return smell'] });

T('RETURN silent on a helper reduction',
  "const out = await agent('review', " + SONNET + ")\n" +
  "const brief = (x) => String(x).slice(0, 200)\n" +
  "return { brief: brief(out) }\n",
  { deny: ['return smell'] });

T('RETURN silent on a return inside a nested function',
  PAR + "function pick() { return results }\nreturn { count: results.length }\n",
  { deny: ['return smell'] });

T('RETURN silent on a path a save agent returned',
  PAR + "const saved = await agent('Write the report to a file, return its path', " + SONNET + ")\n" +
  "const reportPath = saved\n" +
  "return { reportPath, found: results.length }\n",
  { deny: ['return smell'] });

T('RETURN judges only the last top-level return: a keep-the-results fallback stays silent',
  PAR + "const saved = await agent('Write the report to a file', " + SONNET + ")\n" +
  "if (!saved) return results\n" +
  "return { found: results.length }\n",
  { deny: ['return smell'] });

T('RETURN MENTION-ONLY: return results inside a prompt string',
  "await agent('When done, return results as JSON and return out in full.', " + SONNET + ")\n" +
  "return { done: true }\n",
  { deny: ['return smell'] });

// --- masking bugs that silently DISARM the blocking rule ----------------------------------------
//
// maskCode() decides regex-vs-divide from the last non-space CODE character, but it never
// updated that character when a string or template CLOSED. So in `"10" / 2` the `/` was read as
// the start of a regex literal (lastCode was still the `=`), and everything from there to the end
// of the line was blanked - including an agent() call sharing that line. A blanked agent() call
// is an invisible one: the HARD RULE stops blocking and nothing says so.
T('MASK: a divide after a string literal must not blank the rest of the line',
  "const half = \"10\" / 2; await agent('go', { effort: 'low' })\n",
  { block: true });

// The options-object check only accepted `model:`. ES6 shorthand - `{ model, effort }`, the
// natural spelling when the tier comes from args - was reported as "options object has no model
// key" and BLOCKED. A false block is the expensive direction for this hook: it stops a correctly
// routed launch and the only remedy on offer is to add a key that is already there.
T('SHORTHAND: { model } satisfies the blocking rule',
  "const model = 'sonnet'\nawait agent('go', { model, effort: 'low' })\n",
  { silent: true });

T('SHORTHAND MENTION-ONLY: the word model in the PROMPT does not satisfy the rule',
  "await agent('explain the model, then stop', { effort: 'low' })\n",
  { block: true });

// The `[:,}]` widening that let shorthand through went one step too far: it also accepted `model`
// as a VALUE. `{ label: model }`, `{ tools: model }` and a template `${model}` all satisfied
// "has an explicit model" while setting none - a fail-open of the single guarantee this hook
// exists to enforce, and the expensive direction (a silent Fable fan-out).
// KEY POSITION is what the rule means: `model` preceded by `{` or `,`, never by a colon, and
// never by the `{` of a `${` interpolation.
T('VALUE-POSITION: { label: model } does not satisfy the rule',
  "const model = 'sonnet'\nawait agent('go', { label: model, effort: 'low' })\n",
  { block: true });

T('VALUE-POSITION: { tools: model } does not satisfy the rule',
  "const model = ['Read']\nawait agent('go', { tools: model })\n",
  { block: true });

T('VALUE-POSITION: a template ${model} interpolation does not satisfy the rule',
  "const model = 'sonnet'\nawait agent('go', { label: `${model}`, effort: 'low' })\n",
  { block: true });

T('SHORTHAND: trailing { effort, model } still passes (regression)',
  "const model = 'sonnet'\nconst effort = 'low'\nawait agent('go', { effort, model })\n",
  { silent: true });

T('SHORTHAND: a quoted key "model": still passes (regression)',
  "await agent('go', { 'model': 'sonnet', effort: 'low' })\n",
  { silent: true });

// The key-position anchor must survive the spellings real scripts use, or it just moves the
// false-block back where the shorthand fix found it.
T('KEY-POSITION: spread then shorthand passes',
  "const model = 'sonnet'\nconst defaults = { effort: 'low' }\nawait agent('go', { ...defaults, model })\n",
  { silent: true });

T('KEY-POSITION: multiline opts with a comment before the key passes',
  "await agent('go', {\n  // tier chosen per stage\n  model: 'sonnet',\n  effort: 'xhigh',\n})\n",
  { silent: true });

// --- silence on an ordinary well-formed workflow ----------------------------------------------
T('SILENT on a small bounded build workflow',
  "phase('Build')\n" +
  "const spec = await agent('write the contract', { model: 'opus', effort: 'high', label: 'spec' })\n" +
  "await agent('write the data file from the spec', { model: 'sonnet', effort: 'xhigh', label: 'build:data' })\n",
  { silent: true });

// --- Agent / Task calls: the model block and the EFFORT note ----------------------------------
// The input shapes below use the Agent tool_use keys (description, subagent_type, model, prompt,
// run_in_background); the text is synthetic. A hook without the note is silent on every one of
// the "fires" cases.
// Each case gets its own session: the note speaks once per session.
function A(name, input, opts) { cases.push({ name, agent: input, session: 'agent-' + cases.length, ...opts }); }
const AGENT = { description: 'Review the page', subagent_type: 'general-purpose', prompt: 'Review the page.' };

A('AGENT BLOCK: no model still blocks (regression, effort named does not rescue it)',
  { ...AGENT, effort: 'high' }, { block: true });
A('AGENT: a fork with no model and no effort is exempt and silent',
  { description: 'Fork', subagent_type: 'fork', prompt: 'Carry on.' }, { silent: true });
A('AGENT EFFORT: model opus and no effort -> non-blocking note',
  { ...AGENT, model: 'opus', run_in_background: true },
  { want: ['names a model but no effort', 'non-blocking'] });
A('AGENT EFFORT: the note says what to pass and when to leave it unset',
  { ...AGENT, model: 'opus' },
  { want: ['effort: high', 'medium', 'leave it unset only when'] });
A('AGENT EFFORT: model sonnet and no effort -> note too',
  { ...AGENT, model: 'sonnet', subagent_type: 'Explore' }, { want: ['names a model but no effort'] });
A('AGENT EFFORT: model opus with effort high is silent (near miss)',
  { ...AGENT, model: 'opus', effort: 'high' }, { silent: true });
A('AGENT EFFORT: model sonnet with effort medium is silent (near miss)',
  { ...AGENT, model: 'sonnet', effort: 'medium' }, { silent: true });
A('AGENT EFFORT: the note is addressed to the model, not only the user (additionalContext)',
  { ...AGENT, model: 'opus' }, { want: ['model-routing-guard'] });
cases.push({
  name: 'AGENT EFFORT: the Task spelling of the tool gets the same note',
  tool: 'Task', session: 'agent-task', agent: { ...AGENT, model: 'opus' }, want: ['names a model but no effort'],
});
// Once per session: a parallel batch of calls must not get one copy each. A hook that spoke on
// every call fails the second case below.
A('AGENT EFFORT ONCE: first effort-less call in a session speaks',
  { ...AGENT, model: 'sonnet' }, { session: 'batch', want: ['names a model but no effort', 'once per session'] });
A('AGENT EFFORT ONCE: second effort-less call in the SAME session is silent (a parallel batch)',
  { ...AGENT, model: 'sonnet' }, { session: 'batch', silent: true });
A('AGENT EFFORT ONCE: a different session speaks again',
  { ...AGENT, model: 'sonnet' }, { session: 'batch-2', want: ['names a model but no effort'] });
A('AGENT BLOCK: no model still blocks after the session was already told about effort',
  { ...AGENT }, { session: 'batch', block: true });

let pass = 0, fail = 0;
const lines = [];
for (const c of cases) {
  const r = c.agent
    ? call({ tool_name: c.tool || 'Agent', session_id: c.session, cwd: CWD, tool_input: c.agent })
    : run(c.script);
  const problems = [];
  if (c.block) {
    if (r.status !== 2) problems.push('expected exit 2, got ' + r.status);
  } else {
    if (r.status !== 0) problems.push('expected exit 0, got ' + r.status + ' stderr=' + r.stderr.slice(0, 80));
    for (const w of c.want || []) if (!r.note.includes(w)) problems.push('missing "' + w + '"');
    for (const d of c.deny || []) if (r.note.includes(d)) problems.push('unexpected "' + d + '"');
    if (c.silent && r.note) problems.push('expected no note, got "' + r.note.slice(0, 70) + '"');
  }
  if (problems.length) { fail++; lines.push('FAIL  ' + c.name + '  [' + problems.join('; ') + ']'); }
  else { pass++; lines.push('PASS  ' + c.name + (r.note ? '  note="' + r.note.slice(0, 60) + '..."' : '')); }
}

// --- ScheduleWakeup: the loop exit contract the script scan cannot see -------------------------
// Sequences, not single calls: what is under test is what the ledger accumulates across ticks.
const seq = [];
function S(name, session, ticks, expect) { seq.push({ name, session, ticks, expect }); }

const WORK = { noop: false, delaySeconds: 600, prompt: '/loop x', reason: 'r' };
const IDLE = { noop: true, delaySeconds: 1800, prompt: '/loop x', reason: 'r' };

S('one idle tick is not a violation', 'a', [IDLE], { deny: ['exit contract'] });
S('two consecutive idle ticks end the loop', 'b', [IDLE, IDLE], { want: ['consecutive idle ticks'] });
S('productive tick resets the idle streak', 'c', [IDLE, WORK, IDLE], { deny: ['exit contract'] });
S('fifth re-arm asks for the hard stop', 'd', [WORK, WORK, WORK, WORK, WORK], { want: ['re-armed 5 times'] });
S('sixth re-arm stays quiet (every fifth, not every one after)', 'e',
  [WORK, WORK, WORK, WORK, WORK, WORK], { deny: ['re-armed'] });
S('stop:true clears the ledger', 'f',
  [WORK, WORK, WORK, WORK, { stop: true }, WORK], { deny: ['exit contract'] });

for (const s of seq) {
  let last = { note: '', status: 0 };
  for (const t of s.ticks) last = tick(s.session, t);
  const problems = [];
  if (last.status !== 0) problems.push('expected exit 0, got ' + last.status);
  for (const w of s.expect.want || []) if (!last.note.includes(w)) problems.push('missing "' + w + '"');
  for (const d of s.expect.deny || []) if (last.note.includes(d)) problems.push('unexpected "' + d + '"');
  if (problems.length) { fail++; lines.push('FAIL  ' + s.name + '  [' + problems.join('; ') + ']'); }
  else { pass++; lines.push('PASS  ' + s.name + (last.note ? '  note="' + last.note.slice(0, 55) + '..."' : '')); }
}

// --- relaunch-packing ledger ---------------------------------------------------------------------
// wf-concurrency.js writes ~/.claude/.wf-slots-ledger.json, one entry per completed run keyed by
// its (normalized) scriptPath, recorded before ITS OWN MIN_AGENTS/MIN_RUN_MS gate. This hook reads
// it at the NEXT launch of that same script and quotes the prior measurement back before the run
// starts - the only place a warning can land ahead of a relaunch, since a Stop hook cannot.
// The floor is an absolute 3 slots; the cap shown beside it is CAP above. Slot values are synthetic.
// The hook speaks at most once per script per session and remembers that in a file; a run of this
// suite must start from an empty memory or its second run would find every note spent.
try { fs.unlinkSync(path.join(FAKEHOME, '.claude', '.wf-ledger-spoken.json')); } catch (_) {}
const LEDGER_PATH = path.join(FAKEHOME, '.claude', '.wf-slots-ledger.json');
const SCRIPT_DIR = path.join(__dirname, '.fixture-scripts-mrg');
fs.mkdirSync(SCRIPT_DIR, { recursive: true });
function writeLedgerFixture(entries) { fs.writeFileSync(LEDGER_PATH, JSON.stringify(entries)); }
function normForTest(p) { return String(p).replace(/\\/g, '/').toLowerCase(); }
function scriptFile(name) {
  const f = path.join(SCRIPT_DIR, name); // path.join uses the OS separator - backslashes here,
  fs.writeFileSync(f, META + "await agent('write the data file', " + SONNET + ")\n"); // matching a real Windows launch
  return f;
}
function runPath(scriptPath, session) {
  return call({ tool_name: 'Workflow', session_id: session || 't1', cwd: CWD, tool_input: { scriptPath } });
}

const ledgerCases = [];
function L(name, scriptName, ledgerEntries, expect) {
  const f = scriptFile(scriptName);
  writeLedgerFixture(ledgerEntries(f));
  ledgerCases.push({ name, r: runPath(f), expect });
}

L('LEDGER (a) an under-3-slot entry quotes the recorded slots, the live cap and longest-agent minutes',
  'ledger-a.js',
  (f) => ({ [normForTest(f)]: { slots: 1.5, runMin: 40, agentCount: 3, longestMin: 40 } }),
  { want: ['wf-slots-ledger', '1.5 of ' + CAP + ' slots', 'longest 40min', '3-slot packing floor'] });

L('LEDGER (b) an entry at 3 slots or better stays silent',
  'ledger-b.js',
  (f) => ({ [normForTest(f)]: { slots: 4.5, runMin: 120, agentCount: 30, longestMin: 30 } }),
  { deny: ['wf-slots-ledger'] });

L('LEDGER (c) a first launch with no entry says nothing about slots',
  'ledger-c.js',
  () => ({}),
  { deny: ['wf-slots-ledger'] });

L("LEDGER (e) a backslash-recorded path matches this launch's own (backslash) scriptPath",
  'ledger-e.js',
  (f) => ({ [normForTest(f)]: { slots: 1.0, runMin: 40, agentCount: 3, longestMin: 40 } }),
  { want: ['wf-slots-ledger', '1 of ' + CAP + ' slots'] });

// A run with 1-2 agents can never reach the 3-slot floor, so the note would tell the model to
// widen a phase that has no more items to run in it. (f) and (g) are shapes a hook without that
// clause spoke on; (h) is the near miss that must keep speaking.
L('LEDGER (f) a 1-agent entry at 1 of the slots stays silent',
  'ledger-f.js',
  (f) => ({ [normForTest(f)]: { slots: 1.0, runMin: 30, agentCount: 1, longestMin: 30 } }),
  { deny: ['wf-slots-ledger'] });

L('LEDGER (g) a 2-agent entry just under the floor stays silent',
  'ledger-g.js',
  (f) => ({ [normForTest(f)]: { slots: 0.99, runMin: 30, agentCount: 2, longestMin: 29 } }),
  { deny: ['wf-slots-ledger'] });

L('LEDGER (h) a 4-agent entry at 2.5 slots still speaks (near miss: more agents than the floor)',
  'ledger-h.js',
  (f) => ({ [normForTest(f)]: { slots: 2.5, runMin: 20, agentCount: 4, longestMin: 18 } }),
  { want: ['wf-slots-ledger', '2.5 of ' + CAP + ' slots'] });

// Speak once per script per session. Several launches of ONE script: the first speaks, a repeat in
// the same session is silent, another session is told again, and a launch that was silent for a
// different reason does not use up the one note.
{
  const f = scriptFile('ledger-i.js');
  const key = normForTest(f);
  const four = { slots: 2.5, runMin: 20, agentCount: 4, longestMin: 18 };
  writeLedgerFixture({ [key]: four });
  const first = runPath(f, 'sess-x');
  const again = runPath(f, 'sess-x');
  const other = runPath(f, 'sess-y');
  writeLedgerFixture({ [key]: { slots: 1.0, runMin: 5, agentCount: 1, longestMin: 5 } });
  const silentOne = runPath(f, 'sess-z');
  writeLedgerFixture({ [key]: four });
  const afterSilent = runPath(f, 'sess-z');
  ledgerCases.push(
    { name: 'LEDGER (i1) the first launch of a script in a session speaks', r: first,
      expect: { want: ['wf-slots-ledger'] } },
    { name: 'LEDGER (i2) a second launch of the same script in the same session is silent', r: again,
      expect: { deny: ['wf-slots-ledger'] } },
    { name: 'LEDGER (i3) the same script in another session is told again', r: other,
      expect: { want: ['wf-slots-ledger'] } },
    { name: 'LEDGER (i4) a launch silenced by a 1-agent entry does not spend the session note', r: silentOne,
      expect: { deny: ['wf-slots-ledger'] } },
    { name: 'LEDGER (i5) ...so a later 4-agent entry in that session still speaks', r: afterSilent,
      expect: { want: ['wf-slots-ledger'] } },
  );
}

// (d) an inline script carries no tool_input.scriptPath at all, so the ledger is never even
// consulted - proven by seeding an entry for a path the inline call could never supply.
{
  const f = scriptFile('ledger-d-unused.js');
  writeLedgerFixture({ [normForTest(f)]: { slots: 1.0, runMin: 40, agentCount: 3, longestMin: 40 } });
  ledgerCases.push({
    name: 'LEDGER (d) an inline script (no scriptPath) says nothing even with a matching entry on disk',
    r: run("await agent('write the data file', " + SONNET + ")\n"),
    expect: { deny: ['wf-slots-ledger'] },
  });
}

for (const c of ledgerCases) {
  const problems = [];
  if (c.r.status !== 0) problems.push('expected exit 0, got ' + c.r.status + ' stderr=' + c.r.stderr.slice(0, 80));
  for (const w of c.expect.want || []) if (!c.r.note.includes(w)) problems.push('missing "' + w + '"');
  for (const d of c.expect.deny || []) if (c.r.note.includes(d)) problems.push('unexpected "' + d + '"');
  if (problems.length) { fail++; lines.push('FAIL  ' + c.name + '  [' + problems.join('; ') + ']'); }
  else { pass++; lines.push('PASS  ' + c.name + (c.r.note ? '  note="' + c.r.note.slice(0, 70) + '..."' : '')); }
}
try { fs.rmSync(SCRIPT_DIR, { recursive: true, force: true }); } catch (_) {}

console.log(lines.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed of ' + (cases.length + seq.length + ledgerCases.length) + ' cases');

process.exitCode = fail > 0 ? 1 : 0;
