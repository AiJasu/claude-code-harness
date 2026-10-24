'use strict';
// PreCompact hook: supply the compaction summarizer with standing KEEP/DROP instructions when the
// compaction is AUTOMATIC.
//
// WHY THIS EXISTS. `/compact <text>` passes <text> to the summarizer as custom instructions; the
// /wrap skill exists partly to hand the user a tailored line to type. Automatic compaction passes
// NONE, and the record carries `trigger:"auto"`. This hook stops the automatic path from
// summarizing with no instructions at the exact times nobody is watching.
//
// THE CHANNEL IS STDOUT, RAW. PreCompact is not the additionalContext contract the other hooks
// use: the CLI collects each hook's trimmed stdout, joins the non-empty ones with a blank line,
// and concatenates the result onto whatever the user typed (`newCustomInstructions`). So this file
// prints the instructions themselves as plain text - no JSON wrapper, which would be injected
// verbatim into the summarizer prompt.
//
// IT MUST NEVER BLOCK. A PreCompact hook that blocks leaves the session UNCOMPACTED ("compaction
// blocked by PreCompact hook; continuing uncompacted"), which at an auto-compact threshold is the
// worst possible failure - the window is already full. Everything here is wrapped and exits 0.
//
// SILENT ON A TYPED /compact, deliberately. A manual compaction either carries the user's own
// instructions or is a bare one they chose to type; either way they are present and the standing
// text would only dilute theirs. Missing/unknown trigger is treated as manual for the same reason.
//
// STOPPING RULE: this is an instruction injector, not a detector, so it has no false-positive rate
// to calibrate - the only measurable failure is the summary getting WORSE. If a post-auto-compact
// session is seen to have lost something this text explicitly asks to keep, fix the text; if a
// summary is seen to have kept bulk this text asks to drop, cut the offending bullet. Two such and
// delete the hook. Check: hooks/tests/pre-compact-guidance-fixtures.js.

const fs = require('fs');
const path = require('path');

// Kept comfortably under any per-hook output cap and cheap against a compaction request that is
// by definition already near the window. The fixture pins it.
const MAX_CHARS = 4000;

function handoffPointer(cwd) {
  try {
    const p = path.join(cwd, 'HANDOFF.md');
    if (fs.existsSync(p)) return p.replace(/\\/g, '/');
  } catch (_) { /* unreadable cwd -> generic wording below */ }
  return null;
}

try {
  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}') || {}; } catch (_) { payload = {}; }

  if (String(payload.trigger || '') !== 'auto') process.exit(0);

  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const hf = handoffPointer(cwd);
  const durable = hf
    ? 'Anything already written to ' + hf + ' - name the file instead of repeating it.'
    : 'Anything already written to a durable notes file in the project - name the file instead of repeating it.';

  const text = [
    'This compaction is AUTOMATIC: the window filled and nobody typed /compact, so no human-written',
    'instructions exist for this one. Apply the standing ones below.',
    '',
    'PRESERVE:',
    '- The active goal and exactly where it stands, including which item of a Pending list is mid-flight.',
    '- Files opened for edit and their current on-disk state, and any change made but not yet verified.',
    '- Exact commands and invocations confirmed to work on THIS machine this session - full paths and',
    '  flags - plus any environment quirk discovered: a version pin, a path that needed quoting, a tool',
    '  that failed and what replaced it.',
    '- Decisions taken and the reason, wherever that reason is not yet written into code, a comment or',
    '  a notes file.',
    '- Approaches tried and dropped: what was tried, what it did, and that it is not to be retried.',
    '- Corrections and preferences the user stated this session, in their own terms.',
    '- Background work still running - a workflow, a push, a scheduled agent - and what it was started',
    '  for, so it is not abandoned or double-started.',
    '- The immediate next action.',
    '',
    'DROP:',
    '- Bodies of files already read: keep the path and what it established, not the text.',
    '- Superseded drafts of code that was later rewritten.',
    '- Verbose tool output - build and test logs, directory listings, raw git output, fixture PASS lists',
    '  - keeping only the number or verdict that was read off them.',
    '- Debugging detours that were resolved, and exploration that did not pan out.',
    '- ' + durable,
    '',
    'Write the summary so the next turn can act without re-reading what was dropped: any number, path',
    'or command that would otherwise have to be re-derived belongs in PRESERVE.',
    '',
  ].join('\n');

  process.stdout.write(text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text);
} catch (_) { /* fail open - never block a compaction */ }
process.exit(0);
