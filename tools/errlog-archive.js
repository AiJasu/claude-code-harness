// Archive ONE session's rows from the machine-wide error log, and say what keeps recurring.
//
//   node ~/.claude/tools/errlog-archive.js <session_id> [--stale] [--dry-run] [--dir <d>] [--now <iso>]
//
// Why this exists. Archiving the error log wholesale (`cat live >> archived` plus `rm live`) moves
// every row of every OTHER session into the archive untriaged, which is exactly what gotchas.md
// forbids ("archive only your own lines"). This moves only the rows of the session you name, by
// rewriting the live log through a temp file, so a sibling session's fresh rows stay for its own wrap.
//
//   --stale     also move rows OLDER THAN 24 h from other sessions: their session ended without
//               /wrap and nobody else will triage them (hooks/handoff-surface.js names them at
//               SessionStart). A younger foreign row may belong to a live sibling, so it stays.
//   --dry-run   print the table, change nothing. Run it BEFORE writing rules, then run it again
//               without the flag as the last step.
//
// The table lists, per known-trap signature present in the rows being moved: how many rows this
// call moves (own / stale), and the 30-day count across BOTH files (rows, distinct sessions).
// REPEAT = the trap hit 2+ sessions in 30 days, i.e. its existing rule is not holding: convert it
// to a hook or fix its placement instead of writing "already in gotchas.md" and moving on.
//
// A row is assigned to the FIRST signature that matches, so counts never double up. The
// signatures are lexical and deliberately few: each is a string the trap prints
// (hooks/tests/errlog-archive-fixtures.js pins one fire and one near-miss per entry).
// STOPPING RULE: the next false positive that needs a carve-out, delete that signature.
//
// Order of writes: archive first, live second. A crash between the two leaves a row in BOTH files
// (a rerun skips rows the archive already holds), never in neither.
// Exit 0 done, 1 the log changed under us or an IO error (nothing lost), 2 bad arguments.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY = 24 * 3600 * 1000;
const STALE_MS = DAY;
const WINDOW_MS = 30 * DAY;

const HEREDOC_QUOTED = /<<-?\s*(['"])[A-Za-z_]{2,}\1/;
const strip = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');

// id, where the rule lives, test(row, text). text = stderr with ANSI color removed.
const SIGNATURES = [
  { id: 'heredoc-js', rule: 'gotchas.md Windows/shell: heredocs are unsafe for scripts',
    test: (r, t) => HEREDOC_QUOTED.test(r.command || '') && (r.command || '').indexOf('\\') >= 0 &&
      /SyntaxError/.test(t) && !/is not valid JSON|Unexpected end of JSON/.test(t) },
  { id: 'msys-path-node', rule: 'gotchas.md Windows/shell: nested-shell quoting (MSYS /c/ path in node)',
    test: (r, t) => /\b[A-Za-z]:\\[a-z]\\[A-Za-z.]/.test(t) && /ENOENT|no such file|Cannot find/i.test(t) },
  { id: 'regex-quoting', rule: 'gotchas.md Windows/shell: nested-shell quoting (regex in node -e)',
    test: (r, t) => /Invalid regular expression: missing \//.test(t) },
  { id: 'foreach-pipe', rule: 'gotchas.md PowerShell language traps: foreach statement cannot feed a pipe',
    test: (r, t) => /An empty pipe element is not allowed/.test(t) },
  { id: 'html-as-json', rule: 'no gotchas rule (check status/content-type before JSON.parse)',
    test: (r, t) => /Unexpected token '<'/.test(t) },
  // A file or output that is not JSON at all (the FIRST character fails: a .md heading, a plain-text
  // line, "undefined"), or an array method called on an object: a JSON artifact's shape guessed
  // instead of looked at.
  { id: 'json-shape-guess', rule: 'gotchas.md Claude Code harness: tell agents a JSON artifact\'s SHAPE; head -c 300 before indexing',
    test: (r, t) => /Unexpected token '([^'])', "\1/.test(t) ||
      /\.(?:forEach|map|filter|find|some|every|reduce|flatMap|includes|join|slice|sort|push) is not a function/.test(t) },
  { id: 'fmt-braces', rule: 'no gotchas rule (PowerShell -f: pass every value as an argument, never a $var in the format string)',
    test: (r, t) => /Error formatting a string/.test(t) },
];

function classify(row) {
  const t = strip(row && row.stderr);
  for (const s of SIGNATURES) if (s.test(row || {}, t)) return s.id;
  return null;
}

function parseLines(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let row = null;
    try { const o = JSON.parse(raw); if (o && typeof o === 'object') row = o; } catch (_) { /* kept verbatim, never moved */ }
    out.push({ raw, row });
  }
  return out;
}

function readLog(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) {
    if (e.code === 'ENOENT') return { buf: Buffer.alloc(0), lines: [], missing: true };
    throw e;
  }
  return { buf, lines: parseLines(buf.toString('utf8')), missing: false };
}

function usage(msg) {
  process.stderr.write((msg ? msg + '\n' : '') +
    'usage: node errlog-archive.js <session_id (8+ hex chars)> [--stale] [--dry-run] [--dir <d>] [--now <iso>]\n');
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  let sid = null, stale = false, dry = false;
  let dir = path.join(os.homedir(), '.claude');
  let now = Date.now();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stale') stale = true;
    else if (a === '--dry-run') dry = true;
    else if (a === '--dir') dir = argv[++i];
    else if (a === '--now') now = Date.parse(argv[++i]);
    else if (!sid && !a.startsWith('--')) sid = a;
    else usage('unknown argument: ' + a);
  }
  // 8+ hex chars: a shorter prefix could match another session, an empty one would match all of them
  // (the wholesale archive this tool replaces).
  if (!sid || !/^[0-9a-f-]{8,36}$/i.test(sid)) usage('need this session\'s id: 8 or more hex characters');
  if (!dir || !Number.isFinite(now)) usage('bad --dir or --now');
  sid = sid.toLowerCase();

  const liveFile = path.join(dir, 'bash-errors.jsonl');
  const archFile = path.join(dir, 'bash-errors.archived.jsonl');
  const live = readLog(liveFile);
  const arch = readLog(archFile);
  const archSet = new Set(arch.lines.map((l) => l.raw));

  const isOwn = (row) => !!row && typeof row.session_id === 'string' && row.session_id.toLowerCase().startsWith(sid);
  const isStale = (row) => {
    const t = row && typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
    return Number.isFinite(t) && now - t > STALE_MS;
  };
  const moved = [];
  const kept = [];
  for (const l of live.lines) {
    const own = isOwn(l.row);
    const old = stale && !own && isStale(l.row);
    if (own || old) moved.push({ raw: l.raw, row: l.row, kind: own ? 'own' : 'stale' });
    else kept.push(l);
  }

  // 30-day history across both files; duplicates (a row held by both after an interrupted run) count once.
  const seen = new Set();
  const stat = {};
  const bump = (id) => (stat[id] = stat[id] || { own: 0, stale: 0, rows: 0, sess: new Set() });
  for (const l of arch.lines.concat(live.lines)) {
    if (seen.has(l.raw)) continue;
    seen.add(l.raw);
    const t = l.row && typeof l.row.ts === 'string' ? Date.parse(l.row.ts) : NaN;
    if (!Number.isFinite(t) || now - t > WINDOW_MS || t > now + DAY) continue;
    const id = classify(l.row);
    if (!id) continue;
    const s = bump(id);
    s.rows++;
    s.sess.add(String(l.row.session_id));
  }
  let unmatched = 0;
  for (const m of moved) {
    const id = classify(m.row);
    if (id) bump(id)[m.kind]++;
    else unmatched++;
  }

  const keptSessions = new Set(kept.filter((l) => l.row).map((l) => String(l.row.session_id)));
  const keptBad = kept.filter((l) => !l.row).length;
  const ownN = moved.filter((m) => m.kind === 'own').length;
  console.log('errlog-archive: session ' + sid + '  live ' + live.lines.length + ' row(s)  moved ' + moved.length +
    ' (own ' + ownN + ', stale ' + (moved.length - ownN) + ')  kept ' + kept.length + ' (' + keptSessions.size +
    ' other session(s), ' + keptBad + ' unparseable)' + (live.missing ? '  [no live log: another session archived it]' : ''));

  const shown = SIGNATURES.filter((s) => stat[s.id] && (stat[s.id].own + stat[s.id].stale) > 0);
  if (shown.length) {
    console.log('signature         own stale  30d-rows 30d-sessions  status  rule');
    for (const s of shown) {
      const x = stat[s.id];
      console.log(s.id.padEnd(16) + String(x.own).padStart(5) + String(x.stale).padStart(6) + String(x.rows).padStart(10) +
        String(x.sess.size).padStart(13) + '  ' + (x.sess.size >= 2 ? 'REPEAT' : 'first ') + '  ' + s.rule);
    }
  }
  console.log('moved rows with no known signature: ' + unmatched + (unmatched ? ' (triage by hand)' : ''));

  if (dry) { console.log('dry-run: nothing changed'); return; }
  if (!moved.length) { console.log('nothing to move'); return; }

  try {
    // Re-read: a sibling may have appended (fine, the rows stay) or archived/rewritten the file (abort).
    const cur = fs.readFileSync(liveFile);
    if (cur.length < live.buf.length || !cur.subarray(0, live.buf.length).equals(live.buf)) {
      console.error('the live log changed under us; nothing was moved - rerun');
      process.exit(1);
    }
    const extra = cur.length > live.buf.length ? parseLines(cur.subarray(live.buf.length).toString('utf8')) : [];
    const keepRaw = kept.concat(extra).map((l) => l.raw);
    const add = moved.map((m) => m.raw).filter((r) => !archSet.has(r));
    if (add.length) {
      const nl = arch.buf.length > 0 && arch.buf[arch.buf.length - 1] !== 10 ? '\n' : '';
      fs.appendFileSync(archFile, nl + add.join('\n') + '\n');
    }
    const tmp = liveFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, keepRaw.length ? keepRaw.join('\n') + '\n' : '');
    try { fs.renameSync(tmp, liveFile); } catch (e) { try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ } throw e; }
    console.log('archived ' + add.length + ' row(s) to bash-errors.archived.jsonl; live log now ' + keepRaw.length + ' row(s)');
  } catch (e) {
    console.error('io error: ' + e.message + ' - rows already appended to the archive are skipped on a rerun');
    process.exit(1);
  }
}

module.exports = { classify, SIGNATURES };
if (require.main === module) main();
