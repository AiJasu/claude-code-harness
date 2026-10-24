// Helper for the /critic-loop skill: owns WHERE a generated critic-loop prompt lives on disk, so
// the skill never has to spell the per-project slug itself. A slug the skill got slightly wrong
// would put the file somewhere the SessionStart listing in hooks/handoff-surface.js never looks,
// and the failure is silent - the prompt just never resurfaces. Hence one script computing it.
//
//   node save.js --path "<task words>"   -> creates the project dir, prints the target .md path
//   node save.js --list                  -> one launch line per pending prompt in this project
//   node save.js --launch [file]         -> the launch line for one prompt (default: the newest)
//   node save.js --done <file>           -> moves one into done/ beside it
//
// Layout: ~/.claude/critic-loop/<cwd-slug>/          pending prompts (what the SessionStart hook lists)
//         ~/.claude/critic-loop/<cwd-slug>/done/     finished ones, kept for reference
//
// The slug transform (every non-alphanumeric char -> '-', matching the harness's own
// ~/.claude/projects/<slug> naming) is duplicated in hooks/handoff-surface.js on purpose - two
// tiny copies beat a require() across the hooks/skills boundary. Keep the two in step.

const fs = require('fs');
const path = require('path');
const os = require('os');

const projectDir = () =>
  path.join(os.homedir(), '.claude', 'critic-loop', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));

function taskSlug(words) {
  const s = String(words || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s.slice(0, 48).replace(/-+$/, '')) || 'prompt';
}

function label(file) {
  try {
    const m = fs.readFileSync(file, 'utf8').slice(0, 600).match(/^task:[ \t]*(.+)$/m);
    if (m) {
      const t = m[1].replace(/\s+/g, ' ').trim();
      if (t.length <= 120) return t;
      // Over the label budget: cut at the last space within the first 121 characters (so a word
      // ending exactly at 120 stays whole) and mark the cut, so the pasted launch line never ends
      // mid-word. One huge token with no space in that window falls back to the hard cut.
      const sp = t.slice(0, 121).lastIndexOf(' ');
      return t.slice(0, sp > 0 ? sp : 120) + '...';
    }
  } catch (_) { /* unreadable/headerless -> the filename is label enough */ }
  return '';
}

// The one line a fresh session needs to start the run. It is generated HERE, from the path this
// same script computed, so what gets pasted cannot drift from where the prompt really is. A
// launch line kept only as chat text goes stale as soon as the prompt file is edited.
function launchLine(full) {
  const p = full.replace(/\\/g, '/');
  const l = label(full);
  const save = path.join(os.homedir(), '.claude', 'skills', 'critic-loop', 'save.js').replace(/\\/g, '/');
  return 'Run the critic-loop prompt in ' + p + ': read the file; the text after its frontmatter is ' +
    'the whole prompt' + (l ? ' (' + l + ')' : '') + '. Once the run is over, archive it with: node ' +
    save + ' --done ' + p;
}

function pending(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch (_) {
    return [];
  }
}

const argv = process.argv.slice(2);
const mode = argv[0];

if (mode === '--path') {
  const dir = projectDir();
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const base = day + '-' + taskSlug(argv.slice(1).join(' '));
  let file = path.join(dir, base + '.md');
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, base + '-' + n + '.md');
  process.stdout.write(file + '\n');
} else if (mode === '--list') {
  const dir = projectDir();
  const files = pending(dir);
  if (!files.length) {
    process.stdout.write('no pending critic-loop prompts for ' + process.cwd() + '\n');
  } else {
    // One launch sentence per pending file, not a bare path listing: the sentence carries the
    // path and the label anyway, so every row can be pasted as it stands.
    for (const f of files) process.stdout.write(launchLine(path.join(dir, f)) + '\n');
  }
} else if (mode === '--launch') {
  // With a file (absolute, or a bare name resolved against this project's dir), that one. With
  // no argument, the newest pending prompt - names start with the date, so sort order is age
  // order. Exactly one line out, so the reply can carry it verbatim.
  const dir = projectDir();
  let file = argv[1];
  if (file) {
    file = path.isAbsolute(file) ? file : path.join(dir, file);
  } else {
    const files = pending(dir);
    file = files.length ? path.join(dir, files[files.length - 1]) : null;
  }
  if (!file) {
    process.stdout.write('no pending critic-loop prompts for ' + process.cwd() + '\n');
  } else if (!fs.existsSync(file)) {
    process.stderr.write('critic-loop save.js --launch: no such file: ' + file + '\n');
    process.exit(1);
  } else {
    process.stdout.write(launchLine(file) + '\n');
  }
} else if (mode === '--done') {
  const target = argv[1];
  if (!target) {
    process.stderr.write('critic-loop save.js --done needs a file path\n');
    process.exit(2);
  }
  // Resolve a bare filename against THIS project's dir, but honor a full path as given: the
  // session that ran a prompt may have ended up in a cwd other than the prompt's project.
  const file = path.isAbsolute(target) ? target : path.join(projectDir(), target);
  // Only prompts this script manages: --done moves a file, so a stray path must not move anything else.
  const rel = path.relative(path.join(os.homedir(), '.claude', 'critic-loop'), path.resolve(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    process.stderr.write('critic-loop save.js --done: not under ~/.claude/critic-loop/: ' + file + '\n');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    process.stderr.write('critic-loop save.js --done: no such file: ' + file + '\n');
    process.exit(1);
  }
  const doneDir = path.join(path.dirname(file), 'done');
  fs.mkdirSync(doneDir, { recursive: true });
  let dest = path.join(doneDir, path.basename(file));
  for (let n = 2; fs.existsSync(dest); n++) {
    dest = path.join(doneDir, path.basename(file, '.md') + '-' + n + '.md');
  }
  fs.renameSync(file, dest);
  process.stdout.write('archived -> ' + dest + '\n');
} else {
  process.stderr.write(
    'usage: node save.js --path "<task words>" | --list | --launch [file] | --done <file>\n'
  );
  process.exit(2);
}
