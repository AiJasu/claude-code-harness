// SessionStart dispatcher: one node spawn instead of several. Steps, each fail-open:
//   1. Daily snapshot of the rules files (CLAUDE.md, gotchas.md, settings.json)
//      into ~/.claude/backups/rules/<date>/, pruned at 14 days. FIRST, so a corrupted file is
//      captured before anything else touches it.
//   2. Guard state maintenance on .guard-state.json (session-keyed):
//      clear THIS session's entry (guards re-arm on start/resume), drop the legacy
//      'global' entry, GC entries older than 7 days (dead sessions). Other live sessions'
//      entries are left alone. A legacy flat-shape file is simply deleted.
//   3. GC of the per-session scratch files the hooks write, after 7 days untouched.
//   4. On a COMPACT-triggered start only: list the files this session wrote (Write/Edit tool
//      calls in the transcript), so a post-compaction answer re-reads them instead of
//      reconstructing them from what survived the summary.
//   5. Worktree command-shape brief, when the session starts inside a worktree.
//   6. Shell canary: time one trivial bash and one trivial pwsh call into
//      ~/.claude/shell-latency.json, and warn through additionalContext above 2s.
// handoff-surface.js and config-drift-check.js stay separate SessionStart hooks on purpose:
// they emit PLAIN-TEXT context, and this dispatcher's stdout must stay pure JSON.

const fs = require('fs');
const path = require('path');
const os = require('os');

const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(Buffer.concat(chunks).toString() || '{}') || {}; } catch (_) {}
  const sessionId = payload.session_id || null;
  const source = payload.source || '';

  const notes = []; // -> hookSpecificOutput.additionalContext (the channel the model reads)

  // 1. Daily snapshot of the rules files. ~/.claude is usually not a git repo, and
  // file-history only covers files edited through Edit/Write in that session.
  // Lives under ~/.claude/backups/ in its own rules/ subdir, and the prune matches ONLY its
  // own dated directories, so the harness's .claude.json rotations in backups/ are never touched.
  try {
    const base = path.join(os.homedir(), '.claude');
    const snapRoot = path.join(base, 'backups', 'rules');
    const day = new Date().toISOString().slice(0, 10);
    const today = path.join(snapRoot, day);
    if (!fs.existsSync(today)) {
      fs.mkdirSync(today, { recursive: true });
      for (const f of ['CLAUDE.md', 'gotchas.md', 'settings.json']) {
        try { fs.copyFileSync(path.join(base, f), path.join(today, f)); } catch (_) {}
      }
      const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
      for (const d of fs.readdirSync(snapRoot)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d === day) continue;
        if (Date.parse(d) < cutoff) fs.rmSync(path.join(snapRoot, d), { recursive: true, force: true });
      }
    }
  } catch (_) { /* fail open */ }

  // 2. Guard state maintenance.
  try {
    const STATE = path.join(os.homedir(), '.claude', '.guard-state.json');
    const j = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (!j || typeof j !== 'object' || j.careful !== undefined || j.freeze !== undefined || j.off !== undefined) {
      fs.unlinkSync(STATE); // legacy flat shape: clear as before
    } else {
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      for (const k of Object.keys(j)) {
        if (k === 'global' || k === sessionId || !(j[k] && j[k].ts >= cutoff)) delete j[k];
      }
      if (Object.keys(j).length === 0) fs.unlinkSync(STATE);
      else fs.writeFileSync(STATE, JSON.stringify(j));
    }
  } catch (_) { /* absent file or parse error: nothing to maintain */ }

  // 3. GC the per-session scratch files: context-nudge.js (.last-prompt-<id>.json, read by
  // guard-hook.js; .context-nudge-<id>.json, the nudge bucket; .context-resume-<id>.json),
  // skill-nudge.js (.skill-nudge-<id>.json) and browser-guard.js (.browser-host-<id>.json).
  // Anything untouched for 7 days belongs to a session that is gone.
  try {
    const base = path.join(os.homedir(), '.claude');
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(base)) {
      if (!/^\.(?:last-prompt|context-nudge|context-resume|skill-nudge|browser-host)-.+\.json$/.test(f)) continue;
      const p = path.join(base, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (_) {}
    }
  } catch (_) { /* fail open */ }

  // 4. Compaction only: list the artifacts this session WROTE. After a compaction the details
  // are gone but the files are not, and answering from what is left of memory is how a claim
  // ends up asserting more than anything on disk supports.
  try {
    if (source === 'compact' && payload.transcript_path) {
      const fd = fs.openSync(payload.transcript_path, 'r');
      let text = '';
      try {
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, 2 * 1024 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        text = buf.toString('utf8');
      } finally { fs.closeSync(fd); }

      const paths = [];
      for (const line of text.split('\n')) {
        if (!line || line.indexOf('tool_use') === -1) continue;
        let rec;
        try { rec = JSON.parse(line); } catch (_) { continue; }
        const content = (rec.message && rec.message.content) || [];
        if (!Array.isArray(content)) continue;
        for (const b of content) {
          if (!b || b.type !== 'tool_use' || !/^(?:Write|Edit|MultiEdit|NotebookEdit)$/.test(b.name || '')) continue;
          const fp = (b.input && (b.input.file_path || b.input.notebook_path)) || '';
          if (fp && !paths.includes(fp)) paths.push(fp);
        }
      }
      if (paths.length) {
        const rank = (p) => (/\.(md|txt|json|csv)$/i.test(p) ? 0 : 1);
        const list = paths.reverse().sort((a, b) => rank(a) - rank(b)).slice(0, 20);
        notes.push('Artifacts this session produced - re-read before asserting any fact they cover; ' +
          'post-compaction memory is not a source:\n' + list.map((p) => '  ' + p).join('\n'));
      }
    }
  } catch (_) { /* fail open */ }

  // 5. Worktree command-shape brief. Only when this session's cwd is already inside a
  // worktree - a session launched or resumed there gets no EnterWorktree call, so the PostToolUse
  // half of worktree-brief.js never fires for it. The module owns the text and the once-per-
  // session ledger; both entry points share them. A compact-triggered start passes its source so
  // the module re-delivers the brief the compaction just dropped.
  try {
    const brief = require('./worktree-brief.js').noteFor(payload.cwd || process.cwd(), sessionId, source);
    if (brief) notes.push(brief);
  } catch (_) { /* fail open */ }

  // 6. Shell canary. A slow shell preamble costs much more per call under fan-out; one trivial
  // call each measures it, and the number is on disk for an agent fleet to read first.
  try {
    const { execFileSync } = require('child_process');
    const time = (exe, args) => {
      const t0 = Date.now();
      try {
        execFileSync(exe, args, { timeout: 8000, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
        return Date.now() - t0;
      } catch (_) { return -1; }
    };
    const bashExe = process.env.CLAUDE_CODE_GIT_BASH_PATH || 'bash';
    const lat = { ts: Date.now(), bash_ms: time(bashExe, ['-lc', ':']), pwsh_ms: time('pwsh', ['-NoProfile', '-c', '0']) };
    fs.writeFileSync(path.join(os.homedir(), '.claude', 'shell-latency.json'), JSON.stringify(lat));
    const slow = Math.max(lat.bash_ms, lat.pwsh_ms);
    if (slow > (Number(process.env.CLAUDE_SHELL_CANARY_MS) || 2000)) {
      notes.push(`SHELL CANARY: a trivial shell call took ${slow}ms (a healthy shell answers in a fraction of that). Check ` +
        'the newest ~/.claude/shell-snapshots/snapshot-bash-*.sh for a bloated shell preamble BEFORE running ' +
        'fan-out - fan-out multiplies shell latency by the agent count.');
    }
  } catch (_) { /* fail open */ }

  try {
    const out = { hookEventName: 'SessionStart' };
    if (notes.length) out.additionalContext = notes.join('\n');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: out }) + '\n');
  } catch (_) {}
  process.exit(0);
});
