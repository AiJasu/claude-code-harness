'use strict';
// Worktree command-shape brief.
//
// WHY. The Bash tool refuses a set of command shapes inside a git worktree that work everywhere
// else. Documenting them in a notes file is not enough: sessions only read it after the
// refusals have already happened. So this adds no rule - it delivers the text at the moment it
// becomes true.
//
// TWO ENTRY POINTS, one text:
//   - session-start.js requires this module and calls noteFor() when the session's cwd is already
//     inside a worktree (a session launched there, or resumed into one).
//   - registered directly as a PostToolUse hook on EnterWorktree, for a session that enters one
//     mid-flight, where no SessionStart fires.
// Both are once per session (plus once more after each compaction, which drops the first copy
// from context), enforced by the shared ledger below rather than by structure: the
// two surfaces cannot normally both fire (EnterWorktree refuses "Already in a worktree session"),
// but a hook note that repeats is noise.
//
// STOPPING RULE: the brief is a delivery, not a detector, so its failure mode is noise. If a
// session is seen taking one of these refusals ANYWAY after reading it, the text is wrong - fix
// the clause rather than adding one. If the cwd test is seen firing outside a real worktree
// (any path with a `worktrees` segment matches, deliberately loose), narrow it to `.claude/
// worktrees` and say so here. Check: hooks/tests/worktree-brief-fixtures.js.
//
// Shape (6) and re-delivery after a compaction were added under this rule. Shape (5) is NOT
// widened - a refused `git -C <main checkout> merge` is already answered by the landing sentence.

const fs = require('fs');
const path = require('path');
const os = require('os');

const LEDGER = path.join(os.homedir(), '.claude', '.worktree-brief.json');
const TTL_MS = 7 * 24 * 3600 * 1000;

// The six shapes below are the ones that most often cost a call.
const BRIEF =
  'WORKTREE SESSION: the cwd is inside a git worktree, where the Bash tool refuses shapes that ' +
  'work everywhere else. The six that most often cost a call: (1) any `&&`/`;` chain that NAMES ' +
  'git - lexically, so `npm version X --no-git-tag-version` is refused for its FLAG; (2) a script ' +
  'run behind a redirect or pipe (`bash build.sh > log`) - run it ALONE with run_in_background, ' +
  'which names the log for you; (3) heredocs, `for` loops and `| head`/`| tail` - Write tool for ' +
  'files, unrolled loops; (4) a command whose NAME is a quoted path (a native exe) - run those ' +
  'through the PowerShell tool; (5) ANY shell command naming a SIBLING worktree\'s path, ' +
  'read-only or not, including `git -C`, `cd`, `ls` and `sed -n`; (6) shell arithmetic `$(( ))`, a ' +
  '`${VAR:-x}` default or a `$(...)` substitution in any command that also names git (refused as ' +
  '"too complex") - compute the value first, or use the PowerShell tool, and run git as a plain ' +
  'command. Subagents inherit all of it. ' +
  'Landing is ExitWorktree `keep`, then `git merge --ff-only` in the main checkout, then remove ' +
  'the worktree. Watch for the `git worktree remove` CRLF trap and for the EnterWorktree cwd ' +
  'reset after a skill.';

// Deliberately loose: the harness puts session worktrees under <repo>/.claude/worktrees/<name>,
// but a hand-made one elsewhere bites identically. A false positive costs one paragraph.
function inWorktree(cwd) {
  return /[\\/]worktrees[\\/]/i.test(String(cwd || ''));
}

// afterCompact: a SessionStart with source 'compact' means the earlier copy is gone from context,
// so the ledger entry is refreshed and the brief goes out again (once per compaction).
function alreadyToldThisSession(sessionId, afterCompact) {
  if (!sessionId) return false; // no id -> cannot dedupe; speaking once beats never speaking
  let data = {};
  try { data = JSON.parse(fs.readFileSync(LEDGER, 'utf8')) || {}; } catch (_) { data = {}; }
  const now = Date.now();
  const seen = data[sessionId];
  // GC while we are here: entries outlive the sessions that wrote them, and nothing else owns
  // this file. Same shape as guard-hook.js's .guard-notes.json.
  for (const k of Object.keys(data)) {
    if (typeof data[k] !== 'number' || now - data[k] > TTL_MS) delete data[k];
  }
  if (!afterCompact && typeof seen === 'number' && now - seen <= TTL_MS) {
    try { fs.writeFileSync(LEDGER, JSON.stringify(data)); } catch (_) {}
    return true;
  }
  data[sessionId] = now;
  try { fs.writeFileSync(LEDGER, JSON.stringify(data)); } catch (_) {}
  return false;
}

// Returns the brief, or '' when this is not a worktree cwd or the session already has it.
function noteFor(cwd, sessionId, source) {
  try {
    if (!inWorktree(cwd)) return '';
    if (alreadyToldThisSession(sessionId, source === 'compact')) return '';
    return BRIEF;
  } catch (_) {
    return ''; // fail open - a missing brief costs a refusal, a throwing hook costs the call
  }
}

module.exports = { BRIEF, inWorktree, noteFor };

// --- PostToolUse entry point (matcher: EnterWorktree) -------------------------------------------
if (require.main === module) {
  const chunks = [];
  process.stdin.on('data', (d) => chunks.push(d));
  process.stdin.on('end', () => {
    try {
      let payload = {};
      try { payload = JSON.parse(Buffer.concat(chunks).toString() || '{}') || {}; } catch (_) {}
      if (String(payload.tool_name || '') === 'EnterWorktree') {
        // The call itself is the event: entering a worktree IS the condition, whatever cwd the
        // payload still carries (it is the pre-call one).
        if (!alreadyToldThisSession(payload.session_id || null)) {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: BRIEF },
          }) + '\n');
        }
      }
    } catch (_) { /* fail open */ }
    process.exit(0);
  });
}
