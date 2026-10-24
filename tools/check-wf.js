// Validate a Workflow script the way the runtime will load it.
//
//   node ~/.claude/tools/check-wf.js <file.js> [more.js ...]
//
// Why this exists, and why `node --check` is the wrong tool: a workflow body runs inside an
// AsyncFunction, so a top-level `return` is LEGAL there and `node --check` rejects it. The body is
// also compiled with eight injected names and without `process` or `require`, so a script that
// parses fine can still die at launch.
//
// The `export const meta` block is stripped by BRACE MATCHING from its first `{`. An anchored
// regex (/^export const meta = \{[\s\S]*?\n\};/) is wrong: a file with a leading comment fails
// to match, the whole file is then compiled with `export` still in it, and EVERY such workflow
// reports "Unexpected token 'export'" - which reads exactly like broken code.
//
// Exit 0 when every file passes, 1 otherwise. Model routing is NOT checked here; that is
// hooks/model-routing-guard.js --scan <file>.
const fs = require('fs');

const ARGS = ['args', 'budget', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow'];
// Each of these throws or is undefined inside a workflow body. Timestamps and paths come in
// through `args`; vary a prompt by its index rather than by a random number.
const FORBIDDEN = [
  [/\bDate\.now\s*\(/, 'Date.now() throws inside a workflow body - pass a timestamp in through args'],
  [/\bMath\.random\s*\(/, 'Math.random() throws inside a workflow body - vary by index instead'],
  [/\bnew\s+Date\s*\(\s*\)/, 'argless new Date() throws inside a workflow body - pass the date in through args'],
  [/\bprocess\s*\./, 'process is undefined inside a workflow body - pass environment values in through args'],
  [/\brequire\s*\(/, 'require is undefined inside a workflow body'],
];

function stripMeta(src) {
  const at = src.indexOf('export const meta');
  if (at === -1) return { body: src, found: false };
  const open = src.indexOf('{', at);
  if (open === -1) return { body: src, found: false };
  let depth = 0;
  let inStr = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const after = src.slice(i + 1).replace(/^\s*;?/, '');
        return { body: src.slice(0, at) + '\n' + after, found: true };
      }
    }
  }
  return { body: src, found: false, unbalanced: true };
}

function checkFile(file) {
  const problems = [];
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) { return { file, ok: false, problems: ['unreadable: ' + e.message] }; }

  const meta = stripMeta(src);
  if (!meta.found) {
    problems.push(meta.unbalanced
      ? 'export const meta block never closes (unbalanced braces)'
      : 'no `export const meta = {...}` block - the runtime requires one, as a pure literal');
  }

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    new AsyncFunction(...ARGS, meta.body);
  } catch (e) {
    problems.push('body does not compile: ' + e.message);
  }

  // Line-anchored so the scan reports where, and so a mention inside this file's own comments in a
  // scanned workflow is still reported - a false positive here costs one line of justification,
  // a miss costs a launch.
  meta.body.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    for (const [re, why] of FORBIDDEN) {
      if (re.test(line)) problems.push('L' + (i + 1) + ': ' + why);
    }
  });

  return { file, ok: problems.length === 0, problems };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node check-wf.js <workflow.js> [more.js ...]');
  process.exit(2);
}
let bad = 0;
for (const f of files) {
  const r = checkFile(f);
  if (r.ok) {
    console.log('OK   ' + r.file);
  } else {
    bad++;
    console.log('FAIL ' + r.file);
    for (const p of r.problems) console.log('       ' + p);
  }
}
console.log(files.length - bad + ' passed, ' + bad + ' failed of ' + files.length);
process.exit(bad ? 1 : 0);
