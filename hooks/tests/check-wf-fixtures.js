// Fixtures for tools/check-wf.js, the workflow validator gotchas.md mandates.
//
// The case that matters is 2: a workflow whose `export const meta` is preceded by a comment. The
// anchored-regex strip this tool replaces failed exactly there, and reported "Unexpected token
// 'export'" for a perfectly good file - so this suite pins that the brace matcher accepts it.
// Case 6 pins the other half: a top-level `return`, which is legal in a workflow body and which
// `node --check` rejects, must PASS here.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TOOL = path.join(__dirname, '..', '..', 'tools', 'check-wf.js');
const TMP = path.join(__dirname, '.check-wf-tmp');
fs.mkdirSync(TMP, { recursive: true });

const META = [
  'export const meta = {',
  "  name: 'fixture',",
  "  description: 'fixture workflow',",
  "  phases: [{ title: 'One' }],",
  '};',
].join('\n');

function run(name, body) {
  const f = path.join(TMP, name + '.js');
  fs.writeFileSync(f, body, 'utf8');
  const res = spawnSync(process.execPath, [TOOL, f], { encoding: 'utf8', timeout: 20000 });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

const cases = [];
function T(name, want, body, mustSay) { cases.push({ name, want, body, mustSay }); }

T('1 a plain good workflow passes', 'OK',
  META + "\nphase('One');\nconst r = await agent('do a thing', { model: 'sonnet', effort: 'low' });\nlog(String(r).length);\n");

T('2 meta preceded by a comment passes (the anchored-regex trap)', 'OK',
  "// A leading comment. The anchored regex missed the meta block here and every such file then\n" +
  "// reported Unexpected token 'export'.\n" + META + "\nphase('One');\nlog('ok');\n");

T('3 a syntax error is reported as one', 'FAIL',
  META + "\nphase('One'\nlog('missing paren');\n", 'does not compile');

T('4 Date.now() is caught', 'FAIL',
  META + "\nconst t = Date.now();\nlog(String(t));\n", 'Date.now');

T('5 require() is caught', 'FAIL',
  META + "\nconst fs2 = require('fs');\nlog('x');\n", 'require is undefined');

T('6 a top-level return passes (node --check would reject it)', 'OK',
  META + "\nif (!args) return { skipped: true };\nlog('ran');\n");

T('7 a missing meta block is reported', 'FAIL',
  "phase('One');\nlog('no meta here');\n", 'no `export const meta');

T('8 a mention inside a comment does not fail the file', 'OK',
  META + "\n// Date.now() is unavailable here, which is why the timestamp arrives through args.\nlog('ok');\n");

let passed = 0;
let failed = 0;
for (const c of cases) {
  const r = run(c.name.replace(/[^a-z0-9]+/gi, '-'), c.body);
  const got = r.code === 0 ? 'OK' : 'FAIL';
  const saidIt = !c.mustSay || r.out.includes(c.mustSay);
  if (got === c.want && saidIt) {
    passed++;
    console.log('PASS  ' + c.name);
  } else {
    failed++;
    console.log('FAIL  ' + c.name + '  want=' + c.want + ' got=' + got +
      (c.mustSay && !saidIt ? ' (expected the report to mention "' + c.mustSay + '")' : ''));
    console.log('      ' + r.out.trim().split('\n').join('\n      '));
  }
}

// Opt-in (HARNESS_LIVE_TESTS=1): also run the tool over the saved workflows installed under
// ~/.claude/workflows - a green fixture set over synthetic files says nothing about real ones.
// Off by default so a plain run reads nothing outside this repo.
const WF = path.join(os.homedir(), '.claude', 'workflows');
let live = [];
if (process.env.HARNESS_LIVE_TESTS === '1') {
  try { live = fs.readdirSync(WF).filter((f) => f.endsWith('.js')).map((f) => path.join(WF, f)); } catch (_) { live = []; }
}
if (process.env.HARNESS_LIVE_TESTS !== '1') {
  console.log('SKIP  9 saved-workflow check (set HARNESS_LIVE_TESTS=1 to run it)');
} else if (live.length) {
  const res = spawnSync(process.execPath, [TOOL, ...live], { encoding: 'utf8', timeout: 60000 });
  const ok = res.status === 0;
  if (ok) { passed++; console.log('PASS  9 the ' + live.length + ' saved workflows all validate'); }
  else { failed++; console.log('FAIL  9 a saved workflow does not validate\n      ' + (res.stdout || '').trim().split('\n').join('\n      ')); }
} else {
  console.log('SKIP  9 no saved workflows found to validate');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed of ' + (passed + failed) + ' cases');
process.exit(failed ? 1 : 0);
