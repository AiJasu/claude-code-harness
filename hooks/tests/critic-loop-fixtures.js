'use strict';
// Fixtures for the /critic-loop skill: skills/critic-loop/save.js and two contracts in
// skills/critic-loop/SKILL.md. Run from the repo root:
//   node hooks/tests/critic-loop-fixtures.js
//
// Launch line: the one thing the user wants after /critic-loop is a line to paste into a fresh
// session. save.js GENERATES it from the same path it computed, so it cannot drift from where the
// prompt really is; a hand-typed copy goes stale the moment the prompt file is edited.
//
// Live-system boundary: the BOUNDARIES bullet reads the live-interaction boundary out of the
// TARGET project's CLAUDE.md or memory, the way the deploy sentence beside it does, and keeps
// "audits of live systems are read-only" only as the fallback. Asserted flatly from the skill, the
// restriction would come back in every generated prompt even after the user lifted it.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SKILLDIR = path.join(__dirname, '..', '..', 'skills', 'critic-loop');
const SAVE = path.join(SKILLDIR, 'save.js');
const SKILL_MD = path.join(SKILLDIR, 'SKILL.md');
const SANDBOX = path.join(__dirname, '.fakehome-critic-loop');

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

let seq = 0;
function project() {
  const dir = path.join(SANDBOX, 'proj' + (++seq));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function save(cwd, args) {
  const res = spawnSync(process.execPath, [SAVE].concat(args), {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, HOME: SANDBOX, USERPROFILE: SANDBOX },
  });
  return { status: res.status, out: res.stdout || '', err: res.stderr || '' };
}

// Creates a pending prompt the way the skill does: --path for the location, then the file.
function addPrompt(cwd, words, task) {
  const p = save(cwd, ['--path', words]).out.trim();
  fs.writeFileSync(p, '---\ntask: ' + task + '\ncreated: 2000-01-01\nproject: ' + cwd + '\n---\n\nthe prompt body\n');
  return p;
}

const lines = (s) => s.split('\n').filter((l) => l.trim().length > 0);

let pass = 0, fail = 0;
const out = [];
function T(name, got, opts) {
  const o = opts || {};
  const p = [];
  if (o.status !== undefined && got.status !== o.status) p.push('expected exit ' + o.status + ', got ' + got.status);
  for (const w of (o.want || [])) if (!got.out.includes(w)) p.push('missing "' + w + '"');
  for (const w of (o.wantNot || [])) if (got.out.includes(w)) p.push('unexpected "' + w + '"');
  if (o.lineCount !== undefined) {
    const n = lines(got.out).length;
    if (n !== o.lineCount) p.push('expected ' + o.lineCount + ' line(s), got ' + n);
  }
  if (p.length) { fail++; out.push('FAIL  ' + name + '  [' + p.join('; ') + ']'); }
  else { pass++; out.push('PASS  ' + name); }
}

// --- 1. the launch line --------------------------------------------------------------------
{
  const cwd = project();
  const file = addPrompt(cwd, 'redesign the page', 'redesign the settings page');

  const r = save(cwd, ['--launch']);
  T('1a --launch prints exactly ONE line', r, { status: 0, lineCount: 1 });
  // What makes it pasteable into a session that has never seen this project: the absolute path,
  // what the file IS, and how to archive it afterwards.
  T('1b the line names the prompt file, what it is, and the archive command',
    r, { want: [file.replace(/\\/g, '/'), 'after its frontmatter is the whole prompt', '--done ' + file.replace(/\\/g, '/')] });
  T('1c the line carries the task label, so two pending prompts are told apart',
    r, { want: ['redesign the settings page'] });
  T('1d forward slashes only - the line is pasted into a shell and a bash path eats backslashes',
    { status: 0, out: r.out.indexOf('\\') === -1 ? 'clean' : 'backslash at ' + r.out.indexOf('\\') },
    { want: ['clean'] });

  // The path save.js prints is the ONLY path the SessionStart listing looks under; if --launch
  // named anything else the prompt would resurface at SessionStart and the pasted line would 404.
  T('1e --launch names the same file --path created', r, { want: [file.replace(/\\/g, '/')] });
}

// --- 2. --list, one line per pending file ---------------------------------------------------
{
  const cwd = project();
  T('2a --list on a project with nothing pending says so and prints one line',
    save(cwd, ['--list']), { status: 0, lineCount: 1, want: ['no pending critic-loop prompts'] });

  addPrompt(cwd, 'first task', 'the first task');
  T('2b one pending -> one line', save(cwd, ['--list']), { status: 0, lineCount: 1 });

  const second = addPrompt(cwd, 'second task', 'the second task');
  const r = save(cwd, ['--list']);
  T('2c two pending -> two lines, each a launch sentence',
    r, { status: 0, lineCount: 2, want: ['the first task', 'the second task', 'Run the critic-loop prompt in'] });

  // No argument means the newest, and names sort by the date they carry.
  T('2d --launch with no argument picks the newest pending prompt',
    save(cwd, ['--launch']), { status: 0, lineCount: 1, want: [second.replace(/\\/g, '/')] });
  T('2e --launch takes a bare filename, resolved against this project',
    save(cwd, ['--launch', path.basename(second)]), { status: 0, lineCount: 1, want: [second.replace(/\\/g, '/')] });
  T('2f --launch on a file that does not exist exits 1 rather than printing a bad line',
    save(cwd, ['--launch', 'nope.md']), { status: 1, out: '' });
}

// --- 3. --done still archives, and the listing goes quiet again ------------------------------
{
  const cwd = project();
  const file = addPrompt(cwd, 'archive me', 'a task to archive');
  T('3a --done moves the file into done/', save(cwd, ['--done', file]), { status: 0, want: ['archived -> '] });
  T('3b after archiving, --list is back to the empty message',
    save(cwd, ['--list']), { status: 0, lineCount: 1, want: ['no pending critic-loop prompts'] });
  T('3c after archiving, --launch says the same rather than naming a done/ file',
    save(cwd, ['--launch']), { status: 0, lineCount: 1, want: ['no pending critic-loop prompts'], wantNot: ['done'] });
}

// --- 3a2. --done moves only files under ~/.claude/critic-loop/ ------------------------------
// The old --done renamed any path it was handed into a done/ beside it.
{
  const cwd = project();
  const outside = path.join(SANDBOX, 'outside.md');
  const sibling = path.join(SANDBOX, '.claude', 'critic-loop-evil', 'x.md');
  fs.mkdirSync(path.dirname(sibling), { recursive: true });
  for (const f of [outside, sibling]) fs.writeFileSync(f, 'not a critic-loop prompt\n');
  for (const [label, f] of [['a file outside the critic-loop dir', outside], ['a sibling dir sharing the name prefix', sibling]]) {
    const r = save(cwd, ['--done', f]);
    const untouched = fs.existsSync(f) && !fs.existsSync(path.join(path.dirname(f), 'done'));
    T('3a2 --done refuses ' + label + ' and moves nothing',
      { status: r.status, out: untouched && /not under/.test(r.err) ? 'refused' : 'moved or no message: ' + r.out + r.err },
      { status: 1, want: ['refused'] });
  }
}

// --- 3b. a task over 120 characters is cut on a word boundary and marked --------------------
// A hard slice(0, 120) would end the launch line's label in the middle of a word. The tasks below
// are synthetic; word i starts at index 7*i, so a hard cut at 120 would land one character into
// word17 and end the label on a lone "w".
{
  const launchLabel = (task, args) => {
    const cwd = project();
    addPrompt(cwd, 'long task', task);
    const r = save(cwd, args || ['--launch']);
    const m = /whole prompt \(([^)]*)\)\. Once the run is over/.exec(r.out);
    return { status: r.status, out: m ? m[1] : 'NO LABEL IN: ' + r.out };
  };
  const eq = (got, want) => ({ status: got.status, out: got.out === want ? 'equal' : 'got [' + got.out + '] want [' + want + ']' });
  const words = Array.from({ length: 40 }, (_, i) => 'word' + String(i).padStart(2, '0'));
  const long = words.join(' '); // 279 characters
  const cut = words.slice(0, 17).join(' ') + '...'; // 118 characters of whole words, then the mark

  T('3d a 279-character task is cut after its last whole word inside 120 characters, then "..."',
    eq(launchLabel(long), cut), { want: ['equal'] });
  const lab = launchLabel(long).out;
  T('3e the cut label never ends in a partial word: it is a prefix of the task followed by a space',
    { status: 0, out: lab.endsWith('...') && long.startsWith(lab.slice(0, -3) + ' ') && lab.length <= 123 ? 'whole-word' : 'bad: ' + lab },
    { want: ['whole-word'] });
  const t120 = 'abc '.repeat(29) + 'abcd'; // exactly 120 characters
  T('3f a task of exactly 120 characters is kept whole and gets no "..."',
    eq(launchLabel(t120), t120), { want: ['equal'] });
  T('3g a word that ends exactly at character 120 stays whole when more text follows',
    eq(launchLabel(t120 + ' tail words'), t120 + '...'), { want: ['equal'] });
  T('3h one character over the budget cuts back to the previous word, never mid-word',
    eq(launchLabel('abc '.repeat(29) + 'abcdx'), 'abc '.repeat(28) + 'abc...'), { want: ['equal'] });
  T('3i one 130-character token has no space to cut at, so it falls back to the hard cut plus "..."',
    eq(launchLabel('z'.repeat(130)), 'z'.repeat(120) + '...'), { want: ['equal'] });
  T('3j --list carries the same cut label as --launch',
    eq(launchLabel(long, ['--list']), cut), { want: ['equal'] });
}

// --- 4. the SKILL.md contracts ---------------------------------------------------------------
{
  // Whitespace-collapsed, so re-wrapping a paragraph cannot break a phrase check.
  const md = fs.readFileSync(SKILL_MD, 'utf8').replace(/\s+/g, ' ');
  const has = (s) => ({ status: 0, out: md.includes(s) ? 'found' : 'ABSENT' });

  // The Output step has to ALLOW the fourth line, or save.js --launch is a helper the skill is
  // still forbidden to use.
  T('4a Output step 3 allows a fourth reply line', has('most FOUR lines'), { want: ['found'] });
  T('4b Output step 3 names --launch as the source of it', has('save.js --launch'), { want: ['found'] });
  T('4c the old three-line cap is gone', has('at most three lines'), { want: ['ABSENT'] });

  // Deploys and live-system actions always need the user's own words: a line in the target
  // project's CLAUDE.md never turns them into autonomous steps of a generated prompt.
  T('4d BOUNDARIES carries a "Needs the user\'s own words:" line',
    has("headed `Needs the user's own words:`"), { want: ['found'] });
  T('4e audits of live systems are read-only, unconditionally',
    has('Audits of live systems are read-only'), { want: ['found'] });
  T('4f no live-system permission is read from the target project',
    has("TARGET project's own CLAUDE.md or memory"), { want: ['ABSENT'] });
  T('4g no standing deploy authorization is honored',
    has('records a standing deploy authorization'), { want: ['ABSENT'] });

  // Output step 3 pins the reply layout: a paste instruction, then the launch line alone in a
  // fenced block as the final element, so it is never lost at the end of a prose paragraph.
  T('4h Output step 3 puts a paste-after-/clear line before the launch line',
    has('Paste this after /clear:'), { want: ['found'] });
  T('4i Output step 3 puts the launch line alone in a fenced code block',
    has('in a fenced code block that holds nothing else'), { want: ['found'] });
  T('4j Output step 3 makes that block the end of the reply',
    has('closes the reply'), { want: ['found'] });
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed of ' + (pass + fail) + ' cases');
process.exitCode = fail > 0 ? 1 : 0;
