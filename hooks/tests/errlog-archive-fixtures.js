'use strict';
// Fixtures for tools/errlog-archive.js, the error-logger head+tail clip and credential masking, and the text pins on
// skills/wrap/SKILL.md + skills/wrap/reference.md.
// Run: node hooks/tests/errlog-archive-fixtures.js   (paths resolve from __dirname)
//
// Every log row here is SYNTHETIC: session ids, paths and error strings are made up to have the
// SHAPE of real ones (a Node ENOENT with a mangled drive path, a JSON.parse of an XML body,
// a PowerShell parser error). The 30-day figures in section 4 are counted by hand from the rows
// built in the case itself, independent of the tool's code. The sandbox (log dirs and a fake HOME
// for error-logger) lives in hooks/tests/.tmp-errlog-archive and is removed at the end.
//
// Old-state behavior, for the record: a wholesale `cat live >> archived` plus `rm live` is the
// opposite of what the section 1 cases (foreign rows survive) describe, and an error-logger that
// kept the first 1500 chars only fails section 7.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TOOL = path.join(__dirname, '..', '..', 'tools', 'errlog-archive.js');
const LOGGER = path.join(__dirname, '..', 'error-logger.js');
const SKILL = path.join(__dirname, '..', '..', 'skills', 'wrap', 'SKILL.md');
const WRAP_REF = path.join(__dirname, '..', '..', 'skills', 'wrap', 'reference.md');
const SANDBOX = path.join(__dirname, '.tmp-errlog-archive');
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}

const NOW_ISO = '2026-01-15T12:00:00.000Z';
const NOW = Date.parse(NOW_ISO);
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';

let pass = 0, fail = 0;
const out = [];
function chk(name, ok, detail) {
  if (ok) { pass++; out.push('PASS  ' + name); } else { fail++; out.push('FAIL  ' + name + '  [' + detail + ']'); }
}

const row = (sid, ageMs, f) => JSON.stringify(Object.assign({
  ts: new Date(NOW - ageMs).toISOString(), event: 'PostToolUseFailure', tool_name: 'Bash', kind: 'tool_failure',
  session_id: sid, cwd: 'C:/Users/you/project', command: 'npm test', exit_code: 1, stderr: 'Exit code 1\nplain failure',
}, f || {}));

let seq = 0;
// Builds a log dir; live/arch are arrays of raw lines (or null = no such file). Returns helpers.
function mk(live, arch, opts) {
  const dir = path.join(SANDBOX, 'd' + (++seq));
  fs.mkdirSync(dir, { recursive: true });
  const lf = path.join(dir, 'bash-errors.jsonl');
  const af = path.join(dir, 'bash-errors.archived.jsonl');
  if (live) fs.writeFileSync(lf, live.join('\n') + (live.length ? '\n' : ''));
  if (arch) fs.writeFileSync(af, arch.join('\n') + (opts && opts.noNl ? '' : '\n'));
  return {
    dir, lf, af,
    live: () => (fs.existsSync(lf) ? fs.readFileSync(lf, 'utf8') : null),
    arch: () => (fs.existsSync(af) ? fs.readFileSync(af, 'utf8') : null),
    run: (args) => {
      const r = spawnSync(process.execPath, [TOOL].concat(args, ['--dir', dir, '--now', NOW_ISO]), { encoding: 'utf8', timeout: 20000 });
      return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
    },
  };
}
const lines = (s) => (s === null ? null : s.split('\n').filter(Boolean));

// --- 1. only the named session's rows move --------------------------------------------------------
{
  const own1 = row(A, 5 * HOUR), own2 = row(A, 1 * HOUR), f1 = row(B, 2 * HOUR), f2 = row(C, 10 * DAY);
  const old = row(B, 40 * DAY);
  const d = mk([own1, f1, own2, f2], [old]);
  const r = d.run([A]);
  chk('1a exit 0 and the summary line counts 2 moved, 2 kept', r.code === 0 && /moved 2 \(own 2, stale 0\)\s+kept 2 \(2 other session\(s\), 0 unparseable\)/.test(r.out), r.out);
  chk('1b the live log keeps the foreign rows byte for byte, in order (a 10-day-old one too: no --stale)',
    d.live() === f1 + '\n' + f2 + '\n', JSON.stringify(d.live()));
  chk('1c the archive keeps what it had and gains exactly the own rows',
    d.arch() === old + '\n' + own1 + '\n' + own2 + '\n', JSON.stringify(d.arch()));
  chk('1d no temp file is left behind', fs.readdirSync(d.dir).every((f) => !f.includes('.tmp-')), fs.readdirSync(d.dir).join(','));
  const again = d.run([A]);
  chk('1e a rerun moves nothing and changes nothing', again.code === 0 && /nothing to move/.test(again.out) &&
    d.arch() === old + '\n' + own1 + '\n' + own2 + '\n' && d.live() === f1 + '\n' + f2 + '\n', again.out);
}
{
  const d = mk([row(A, HOUR), row(B, HOUR)], []);
  const r = d.run([A.slice(0, 8)]);
  chk('1f an 8-character prefix of the id is enough', r.code === 0 && /moved 1 \(own 1/.test(r.out) && lines(d.live()).length === 1, r.out);
}
{
  const d = mk([row(A, HOUR)], [row(B, DAY)]);
  const before = [d.live(), d.arch()];
  let ok = true, why = '';
  for (const args of [[], ['abc'], ['zzzzzzzz'], ['--stale'], [A, 'extra']]) {
    const r = d.run(args);
    if (r.code !== 2) { ok = false; why += ' args=' + JSON.stringify(args) + ' exit=' + r.code; }
  }
  chk('1g no id, a short id, a non-hex id or a stray argument exits 2 (an empty prefix would match every session)', ok, why);
  chk('1h ... and touches neither file', d.live() === before[0] && d.arch() === before[1], 'files changed');
}
{
  const own = row(A, HOUR);
  const d = mk(['not json {', own, '', row(B, 30 * HOUR, { ts: undefined })]);
  const r = d.run([A]);
  chk('1i an unparseable line and a row with no ts survive in the live log, untouched',
    r.code === 0 && d.live() === 'not json {\n' + row(B, 30 * HOUR, { ts: undefined }) + '\n' && d.arch() === own + '\n', r.out + JSON.stringify(d.live()));
}

// --- 2. --dry-run ---------------------------------------------------------------------------------
{
  const d = mk([row(A, HOUR, { stderr: "SyntaxError: Unexpected token '<', \"<?xml vers\"... is not valid JSON" }), row(B, HOUR)], [row(B, DAY)]);
  const before = [d.live(), d.arch()];
  const r = d.run([A, '--dry-run']);
  chk('2a --dry-run prints the table and the dry-run line', r.code === 0 && /html-as-json/.test(r.out) && /dry-run: nothing changed/.test(r.out), r.out);
  chk('2b --dry-run leaves both files byte-identical', d.live() === before[0] && d.arch() === before[1], 'files changed');
}

// --- 3. --stale: a row older than 24 h from another session ---------------------------------------
{
  const young = row(B, 23.98 * HOUR), oldR = row(B, 24.02 * HOUR), older = row(C, 5 * DAY), own = row(A, HOUR);
  const d0 = mk([young, oldR, older, own]);
  d0.run([A]);
  chk('3a without --stale, old foreign rows stay', d0.live() === young + '\n' + oldR + '\n' + older + '\n', JSON.stringify(d0.live()));
  const d = mk([young, oldR, older, own]);
  const r = d.run([A, '--stale']);
  chk('3b with --stale the 24.02 h and 5-day rows move, the 23.98 h row (a live sibling) stays',
    r.code === 0 && d.live() === young + '\n' && d.arch() === oldR + '\n' + older + '\n' + own + '\n', r.out + JSON.stringify(d.live()));
  chk('3c the summary splits own from stale', /moved 3 \(own 1, stale 2\)/.test(r.out), r.out);
}

// --- 4. the signature table against a hand count --------------------------------------------------
const HTML = "SyntaxError: Unexpected token '<', \"<?xml vers\"... is not valid JSON";
const MSYS = "Error: ENOENT: no such file or directory, open 'C:\\c\\Users\\you\\f.json'";
{
  // html-as-json: 3 own rows now (session A), 2 rows of session B 10 days ago, 1 row of session C 40 days
  // ago (outside the 30-day window) -> own 3, 30d rows 5, 30d sessions 2, REPEAT.
  // msys-path-node: 1 own row, nothing else -> own 1, 30d rows 1, 30d sessions 1, first.
  const d = mk(
    [row(A, HOUR, { stderr: HTML }), row(A, 2 * HOUR, { stderr: HTML }), row(A, 3 * HOUR, { stderr: HTML }), row(A, 4 * HOUR, { stderr: MSYS }), row(A, 5 * HOUR)],
    [row(B, 10 * DAY, { stderr: HTML }), row(B, 10 * DAY + HOUR, { stderr: HTML }), row(C, 40 * DAY, { stderr: HTML })]);
  const r = d.run([A, '--dry-run']);
  chk('4a html-as-json: own 3, stale 0, 30-day rows 5 (the 40-day one is out), 30-day sessions 2, REPEAT',
    /^html-as-json\s+3\s+0\s+5\s+2\s+REPEAT/m.test(r.out), r.out);
  chk('4b msys-path-node: own 1, 30-day rows 1, sessions 1, not a REPEAT', /^msys-path-node\s+1\s+0\s+1\s+1\s+first/m.test(r.out), r.out);
  chk('4c a signature absent from the moved rows is not listed', !/^regex-quoting/m.test(r.out), r.out);
  chk('4d the row with no known signature is counted as such', /no known signature: 1 \(triage by hand\)/.test(r.out), r.out);
}
{
  // Five rows of ONE session inside a retry loop are one incident, not a repeat.
  const rows = [1, 2, 3, 4, 5].map((i) => row(A, i * HOUR, { stderr: HTML }));
  const r = mk(rows).run([A, '--dry-run']);
  chk('4e five rows from one session: 30-day rows 5, sessions 1, first (a retry loop is one incident)',
    /^html-as-json\s+5\s+0\s+5\s+1\s+first/m.test(r.out), r.out);
}
{
  // A row held by BOTH files (an interrupted earlier run) is counted once and archived once.
  const dup = row(A, HOUR, { stderr: HTML });
  const d = mk([dup], [dup]);
  const r = d.run([A]);
  chk('4f a row already in the archive counts once and is not appended again',
    /^html-as-json\s+1\s+0\s+1\s+1\s+first/m.test(r.out) && d.arch() === dup + '\n' && d.live() === '', r.out + JSON.stringify([d.arch(), d.live()]));
}

// --- 5. file edge cases ---------------------------------------------------------------------------
{
  const own = row(A, HOUR);
  const d = mk([own], ['{"kept":"first row, no trailing newline"}'], { noNl: true });
  d.run([A]);
  chk('5a an archive with no final newline gets one before the appended row',
    d.arch() === '{"kept":"first row, no trailing newline"}\n' + own + '\n', JSON.stringify(d.arch()));
  const e = mk([own], null);
  e.run([A]);
  chk('5b a missing archive is created', e.arch() === own + '\n' && e.live() === '', JSON.stringify([e.arch(), e.live()]));
  const g = mk(null, [row(B, DAY)]);
  const r = g.run([A]);
  chk('5c a missing live log (a sibling archived it) is exit 0, said so, and creates nothing', r.code === 0 && /no live log/.test(r.out) && g.live() === null, r.out);
}

// --- 6. the signatures themselves: one fire and one near-miss each --------------------------------
{
  let classify;
  try { classify = require(TOOL).classify; } catch (_) { classify = () => 'tool missing'; }
  const cases = [
    ['heredoc-js', { command: "node - <<'EOF'\nconst r=/\\d+/;\nEOF", stderr: 'SyntaxError: Invalid regular expression: missing /' },
      { command: 'node - <<EOF\nconst r=/\\d+/;\nEOF', stderr: 'SyntaxError: Invalid regular expression: missing /' }, 'regex-quoting'],
    ['msys-path-node', { stderr: MSYS }, { stderr: "Error: ENOENT: no such file or directory, open 'C:\\Users\\you\\f.json'" }, null],
    ['regex-quoting', { command: 'node -e "..."', stderr: '[eval]:4\nSyntaxError: Invalid regular expression: missing /' },
      { command: 'node -e "..."', stderr: 'SyntaxError: Invalid regular expression: /a(/: Unterminated group' }, null],
    ['foreach-pipe', { stderr: '\x1b[31;1mParserError: An empty pipe element is not allowed.\x1b[0m' }, { stderr: "ParserError: Missing closing ')' in expression." }, null],
    ['html-as-json', { stderr: HTML }, { stderr: "SyntaxError: Unexpected token '}', \"{\"a\":1}}\" is not valid JSON" }, null],
    ['json-shape-guess', { stderr: "SyntaxError: Unexpected token '#', \"# Notes\\nsome\"... is not valid JSON" },
      { stderr: "SyntaxError: Unexpected token '}', \"{\"a\":1}}\" is not valid JSON" }, null],
    ['json-shape-guess', { stderr: 'TypeError: rows.forEach is not a function' },
      { stderr: 'TypeError: fs.readFileSynk is not a function' }, null],
    ['fmt-braces', { stderr: 'InvalidOperation: Error formatting a string: Input string was not in a correct format.' },
      { stderr: 'MethodInvocationException: Input string was not in a correct format.' }, null],
  ];
  for (const [id, fire, miss, missId] of cases) {
    chk('6 ' + id + ': fires', classify(fire) === id, 'got ' + classify(fire));
    chk('6 ' + id + ': near-miss ' + (missId ? 'lands on ' + missId + ' (first match wins, no double count)' : 'stays unmatched'),
      classify(miss) === missId, 'got ' + classify(miss));
  }
}

// --- 7. error-logger keeps the head AND the tail of a long output ---------------------------------
function logIt(errorText, command) {
  const home = path.join(SANDBOX, 'home' + (++seq));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const input = { tool_name: 'Bash', tool_input: { command: command || 'npm test' }, session_id: A, cwd: '/home/user/project', hook_event_name: 'PostToolUseFailure', error: errorText };
  const r = spawnSync(process.execPath, [LOGGER], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000, env: { ...process.env, USERPROFILE: home, HOME: home } });
  let e = null;
  try { e = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'bash-errors.jsonl'), 'utf8').trim()); } catch (_) { /* stays null */ }
  return { status: r.status, e };
}
{
  const cause = "Error: ENOENT: no such file or directory, open 'C:\\c\\Users\\you\\f.json'";
  const long = 'Exit code 1\n' + 'HEAD'.repeat(75) + 'mid line of a long stdout\n'.repeat(200) + cause;
  const r = logIt(long);
  chk('7a a long failed output keeps its LAST line (the cause) ...', r.status === 0 && r.e && r.e.stderr.endsWith(cause), r.e ? r.e.stderr.slice(-80) : 'no row');
  chk('7b ... and its first 300 characters', r.e && r.e.stderr.startsWith(long.slice(0, 300)), r.e ? r.e.stderr.slice(0, 40) : 'no row');
  chk('7c ... says how much it cut, and stays near the old 1500 cap (' + (r.e ? r.e.stderr.length : '?') + ')',
    r.e && r.e.stderr.includes('[' + (long.length - 1500) + ' chars cut]') && r.e.stderr.length < 1600, r.e ? r.e.stderr.length + '' : 'no row');
  const shortT = 'Exit code 2\nboom';
  const sr = logIt(shortT).e;
  chk('7d a short output is stored exactly', !!sr && sr.stderr === shortT, sr ? 'changed' : 'no row');
  const at = 'Exit code 1\n' + 'x'.repeat(1500 - 12);
  const ar = logIt(at).e;
  chk('7e exactly 1500 chars is stored exactly', at.length === 1500 && !!ar && ar.stderr === at, ar ? 'changed' : 'no row');
  const over = at + 'y';
  const o = logIt(over).e;
  chk('7f 1501 chars is clipped with the 1-char marker, tail kept', o && o.stderr.includes('[1 chars cut]') && o.stderr.endsWith('y'), o ? o.stderr.slice(-20) : 'no row');
}

// --- 7g-7h. error-logger masks credential shapes in the command and the output ------------------------
// The old logger stored both verbatim. Every secret here is fake, built from parts; each near miss
// must come through unchanged.
{
  const fakePw = ['fake', 'pw', '77'].join('');
  const fakeTok = ['example', 'tok', '88'].join('-');
  const redactCases = [
    ['URL userinfo', 'git clone https://someone:' + fakePw + '@git.example.com/r.git'],
    ['curl -u user:pass', 'curl -u someone:' + fakePw + ' https://api.example.com'],
    ['--password=x', 'tool login --password=' + fakePw],
    ['--password x', 'tool login --password ' + fakePw],
    ['mysql glued -p', 'mysql -u root -p' + fakePw + ' appdb'],
    ['Authorization header', 'curl -H "Authorization: Bearer ' + fakeTok + '" https://api.example.com'],
    ['key=value', 'API_KEY=' + fakeTok + ' npm run deploy'],
    ['token= in a query', 'curl "https://api.example.com/x?access_token=' + fakeTok + '&page=2"'],
    ['quoted export', 'export GITHUB_TOKEN="' + fakeTok + '"'],
    ['quoted --password=', "tool login --password='" + fakePw + "'"],
    ['quoted -u', 'curl -u "someone:' + fakePw + '" https://api.example.com'],
    // Round 2: shapes the first pass missed.
    ['userinfo with no colon', 'git clone https://' + fakeTok + '@git.example.com/r.git'],
    ['AWS-style *_ACCESS_KEY=', 'AWS_SECRET_ACCESS_KEY=' + fakeTok + ' aws s3 ls'],
    ['PowerShell $env: with spaces around =', '$env:GITHUB_TOKEN = "' + fakeTok + '"'],
    ['--token X (space form)', 'cli publish --token ' + fakeTok],
    ['--api-key X (space form)', 'cli publish --api-key ' + fakeTok],
    ['docker login -p X', 'docker login -u someone -p ' + fakePw + ' registry.example.com'],
    ['X-Api-Key header', 'curl -H "X-Api-Key: ' + fakeTok + '" https://api.example.com'],
    ['Authorization with no scheme word', "curl -H 'Authorization: " + fakeTok + "' https://api.example.com"],
  ];
  for (const [label, cmd] of redactCases) {
    const e = logIt('Exit code 1\nfailed: ' + cmd, cmd).e;
    const secret = cmd.includes(fakePw) ? fakePw : fakeTok;
    chk('7g ' + label + ': masked in command and stderr', !!e && !e.command.includes(secret) && !e.stderr.includes(secret) &&
      e.command.includes('[REDACTED]'), e ? e.command : 'no row');
  }
  const nearMiss = [
    'curl https://localhost:8443/health',
    'ssh -p2222 host.example',
    'mkdir -p build && tar -pxf a.tar',
    'python train.py tokenizer=bert',
    'git push -u origin main',
    'mysql -P3306 -u root appdb',
  ];
  for (const cmd of nearMiss) {
    const e = logIt('Exit code 1\n' + cmd, cmd).e;
    chk('7h near miss stays intact: ' + cmd, !!e && e.command === cmd && e.stderr === 'Exit code 1\n' + cmd, e ? e.command : 'no row');
  }
}

// --- 8. the wrap skill calls the tool and no longer does the wholesale cat/rm ---------------------
{
  // Steps 2b, 2c and 3b live in skills/wrap/reference.md (the hot SKILL.md body stays small), so
  // 8a-8c read the pair; 8d-8e pin the pointers and the moved headings.
  const hot = fs.existsSync(SKILL) ? fs.readFileSync(SKILL, 'utf8') : '';
  const ref = fs.existsSync(WRAP_REF) ? fs.readFileSync(WRAP_REF, 'utf8') : '';
  const s = hot + '\n' + ref;
  chk('8a wrap Step 2b names tools/errlog-archive.js', s.includes('tools/errlog-archive.js') && s.includes('--dry-run'), 'missing');
  chk('8b wrap no longer prescribes `cat live >> archived` / `rm live` for the whole log',
    !/cat [^\n|;&]*bash-errors\.jsonl >>/.test(s) && !/rm -f [^\n|;&]*bash-errors\.jsonl/.test(s), 'wholesale archive is back');
  chk('8c wrap tells the model a REPEAT signature is not "already covered"', /REPEAT/.test(s) && /COUNTED, not dismissed/.test(s), 'missing');
  chk('8d wrap SKILL.md points at reference.md from each of the three moved steps',
    (hot.match(/skills\/wrap\/reference\.md/g) || []).length >= 3, 'pointers: ' + (hot.match(/skills\/wrap\/reference\.md/g) || []).length);
  chk('8e wrap reference.md holds Steps 2b, 2c and 3b and the hot body no longer carries the archive call',
    /^## Step 2b /m.test(ref) && /^## Step 2c /m.test(ref) && /^## Step 3b /m.test(ref) && !hot.includes('tools/errlog-archive.js'),
    'moved steps missing or Step 2b grew back into SKILL.md');
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed of ' + (pass + fail) + ' cases');
process.exitCode = fail > 0 ? 1 : 0;
