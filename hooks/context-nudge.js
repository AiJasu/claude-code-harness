// UserPromptSubmit hook. Three jobs, all cheap, all fail-open (always exit 0):
//
//   1. CONTEXT SIZE: read the last assistant usage block in this session's transcript and, once
//      the live context passes THRESHOLD (the auto-compact fire point, autoCompactWindow - 33000;
//      400K when no window is configured), ride one line along on the user's next prompt -
//      "if this starts a new deliverable, run /wrap -c first and tell the user to type the /compact
//      line it prints" (the model cannot run /compact itself; /wrap prints it only with -c).
//      Deliberately NOT a Stop hook:
//      a Stop hook's additionalContext continues the conversation for one more full-context
//      turn, which is self-defeating for a context-cost nudge. Fires at most once per 100K of
//      further growth.
//      The scan stops at the last compact_boundary record instead of reading past it: right
//      after a compaction there is no post-compaction usage record yet (usage lands on the
//      assistant's reply, which has not happened when THIS hook runs), so reading past the
//      boundary would report the pre-compaction number as if it still stood. Stopping there
//      also clears the per-session bucket file, so growth after a compaction is judged against
//      a fresh baseline instead of the pre-compaction bucket.
//      Past the first nudge, the wording escalates: bucket 0 (the first 100K past THRESHOLD)
//      keeps the original /wrap line; bucket 1+ says the next milestone does not start in this window and
//      names what the model itself can do about it, since the user may not be at the keyboard
//      to act on the unescalated line.
//      ABOVE 2x THRESHOLD, the remedy changes again: nudges often land on
//      task-notification turns, not a typed prompt - there is no one there to act on them. Past
//      2x the note drops the bucket 1+ wording and gives a remedy the model can run alone: stop
//      pulling large artifacts into this context (route screenshots/big reads through a subagent
//      that returns a verdict) and hand the next milestone to a fresh headless turn with
//      HANDOFF.md as the state. It also names the absent user: only when the last 2 nudges AND
//      this turn were all classified 'auto' (a task-notification, not a typed prompt) does the
//      note say so - the CURRENT turn is part of that streak, so a human typing anything at all
//      right now (even just /compact) is never told nobody is there.
//
//   2. REQUEST KIND: record whether this turn's request is a CHECK (check/diagnose/explain/
//      verify/look/why/status), an AUTO turn (the harness resuming a task-notification, not a
//      typed prompt) or something else, in ~/.claude/.last-prompt-<session>.json. guard-hook.js
//      reads the 'check' classification to warn when a durable-state change is about to happen
//      inside a turn the user only asked to have inspected; job 1 above reads the 'auto'
//      classification's history to tell an unattended run from an attended one. Only the
//      CLASSIFICATION and a timestamp are stored - never the prompt text.
//
//   3. SHORT-PROMPT SHAPE: reply-lint.js's reply-style note lands AFTER a long reply and does not
//      reliably change the next one. Once this session holds 2+ reply-style notes in reply-lint's
//      own counter (~/.claude/.reply-lint-repeat.json, read only - reply-lint stays its one
//      writer) and the typed prompt is short by reply-lint's own test (SHORT_PROMPT, DEPTH, not a
//      slash command; keep both in step with reply-lint.js), one line rides along BEFORE the
//      reply. It names the character cap (MAX_CHARS) as well as the line count, and when
//      reply-lint's heartbeat (~/.claude/.reply-lint-seen.json, read only) last ran in THIS
//      session it quotes that reply's size, so the figure is in front of the model before it
//      writes, not after.
//
// Output contract: hookSpecificOutput.additionalContext on stdout is the one channel that
// reaches the model; stderr on exit 0 is user-display only.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

// THRESHOLD follows the auto-compact fire point (window - 33000) so the size arm never sits above
// the auto trigger, where it could not fire at all. The window is resolved the way
// config-drift-check.js resolves it (env var, then the settings.json env block, then the
// top-level key). No window configured, or an unusable value: a fixed 400000.
const AUTO_COMPACT_MARGIN = 33000;
const DEFAULT_THRESHOLD = 400000;
function nudgeThreshold() {
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8').replace(/^[^{]+/, '')) || {};
  } catch (_) { /* unreadable settings: env var or default below */ }
  const raw = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ||
    (settings.env && settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) || settings.autoCompactWindow;
  const win = Number(raw);
  return Number.isFinite(win) && win > 2 * AUTO_COMPACT_MARGIN ? win - AUTO_COMPACT_MARGIN : DEFAULT_THRESHOLD;
}
const THRESHOLD = nudgeThreshold(); // tokens of live context before the first nudge
const STEP = 100000;        // one further nudge per this much growth
const DOUBLE = THRESHOLD * 2; // past here the remedy stops assuming a person is present
const ABSENT_STREAK = 2;    // this many PRIOR nudges, plus this turn, all 'auto' => name the absent user
const TAIL_BYTES = 512 * 1024;

// RESUMPTION arm. The size nudge above only looks at SIZE, and by the time size is the problem
// the money is spent: a session wrapped with HANDOFF.md written, then picked up again days later
// for an entirely new deliverable, re-reads the whole carried transcript on every turn.
//
// So this arm watches the ONE moment the cost is still fully avoidable: the first typed prompt of
// a session that is being picked up again. Two independent entry signals (a long gap since the
// last turn, or a wrap already in the tail), a floor well under THRESHOLD, and once per session.
// Deliberately capped BELOW THRESHOLD so it can never double up with the size nudge, which leaves
// that path byte-identical.
const RESUME_GAP_MS = 6 * 3600 * 1000;   // "yesterday's session", not a lunch break
const RESUME_MIN_TOKENS = 150000;        // under this the carried transcript is not worth a line
const WRAP_SKILL = /"skill"\s*:\s*"wrap"/;

const CHECK_VERB = /^\s*(?:please\s+)?(?:can\s+you\s+)?(?:check|diagnose|explain|verify|look|inspect|review|audit|why|what|status|show|list|read|compare)\b/i;
// The harness resumes a task-notification by handing its XML block back as this turn's "prompt" -
// no user typed anything. Anchored to the start (after whitespace) the same way CHECK_VERB is.
const TASK_NOTIFICATION = /^\s*<task-notification\b/i;

// Job 3. MAX_CHARS, SHORT_PROMPT and DEPTH are copies of reply-lint.js's constants of the same
// names: a prompt it would lint is exactly a prompt this job pre-warns, against the same cap.
// REPEAT_TTL_MS mirrors its idle-session expiry.
const MAX_CHARS = 900;
const SHORT_PROMPT = 400;
const DEPTH = /in detail|detailed|break ?down|explain|walk me through|draft|write (?:me )?(?:a|an|the)|spec\b|guide\b|audit|full (?:report|list|break ?down|rundown)|list (?:everything|all)\b/i;
const REPEAT_STATE = path.join(HOME, '.claude', '.reply-lint-repeat.json');
const LINT_SEEN = path.join(HOME, '.claude', '.reply-lint-seen.json');
const REPEAT_TTL_MS = 24 * 60 * 60 * 1000;
const SHAPE_AFTER = 2;      // reply-style notes this session before the pre-reply line starts

function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

// Returns { tokens, compacted }. compacted is true when the most recent relevant tail record,
// scanning backward, is a compact_boundary and no usage record has been logged since - the live
// number is unknown (treated as 0, below threshold) rather than the stale pre-compaction one.
function liveContext(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l) continue;
    if (l.indexOf('compact_boundary') !== -1) {
      try {
        const rec = JSON.parse(l);
        if (rec.type === 'system' && rec.subtype === 'compact_boundary') return { tokens: 0, compacted: true };
      } catch (_) { /* partial line at the tail boundary */ }
    }
    if (l.indexOf('cache_read_input_tokens') === -1) continue;
    try {
      const u = (JSON.parse(l).message || {}).usage || {};
      const n = (u.cache_read_input_tokens || 0) + (u.input_tokens || 0);
      if (n > 0) return { tokens: n, compacted: false };
    } catch (_) { /* partial line at the tail boundary */ }
  }
  return { tokens: 0, compacted: false };
}

// Milliseconds since the newest assistant record in the tail, or null when none carries a
// parseable timestamp - in which case the gap signal simply does not vote (the wrap signal still
// can). Never guesses an age: an unknown gap must not read as a fresh session OR a stale one.
function lastAssistantAgeMs(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l || l.indexOf('"assistant"') === -1) continue;
    try {
      const rec = JSON.parse(l);
      if (!rec.message || rec.message.role !== 'assistant' || !rec.timestamp) continue;
      const t = Date.parse(rec.timestamp);
      if (!isNaN(t)) return Date.now() - t;
    } catch (_) { /* partial line at the tail boundary */ }
  }
  return null;
}

const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  let out = '';
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const session = String(input.session_id || 'unknown').replace(/[^\w.-]/g, '_');
    const promptText = String(input.prompt || '');
    const promptKind = TASK_NOTIFICATION.test(promptText) ? 'auto'
      : (CHECK_VERB.test(promptText) ? 'check' : 'other');

    // 2. request kind (classification only, never the text)
    try {
      fs.writeFileSync(path.join(HOME, '.claude', `.last-prompt-${session}.json`),
        JSON.stringify({ ts: Date.now(), kind: promptKind }));
    } catch (_) {}

    // 3. short-prompt shape (counter read only; a missing or broken file stays silent)
    try {
      const p = promptText.trim();
      if (promptKind !== 'auto' && p && p.length <= SHORT_PROMPT && !DEPTH.test(p) && !p.startsWith('/')) {
        const all = JSON.parse(fs.readFileSync(REPEAT_STATE, 'utf8')) || {};
        const s = all[String(input.session_id || '')];
        const n = s && typeof s['reply-style'] === 'number' ? s['reply-style'] : 0;
        if (n >= SHAPE_AFTER && typeof s._last === 'number' && Date.now() - s._last <= REPEAT_TTL_MS) {
          let last = '';
          try {
            const seen = JSON.parse(fs.readFileSync(LINT_SEEN, 'utf8')) || {};
            if (seen._lastSession === input.session_id && typeof seen.chars === 'number') {
              last = ` The last reply here was ${seen.chars} chars.`;
            }
          } catch (_) {}
          out += (out ? '\n' : '') + `short prompt, and ${n} replies in this session already broke the ` +
            'terse shape: answer in at most 4 lines, one short sentence each - no table, no headers, ' +
            'no bold labels - then only a non-empty "Pending:" and "Need from you:", and keep the whole ' +
            `reply, both lists included, under ${MAX_CHARS} characters. Full paths and commands go in a ` +
            'file named once, not into bullets.' + last;
        }
      }
    } catch (_) {}

    // 1. context size
    if (input.transcript_path && fs.existsSync(input.transcript_path)) {
      const tail = readTail(input.transcript_path);
      const lines = tail.split('\n');
      const { tokens: ctx, compacted } = liveContext(lines);
      const stateFile = path.join(HOME, '.claude', `.context-nudge-${session}.json`);

      // 1b. RESUMPTION. Strictly below THRESHOLD, so the size path below is untouched.
      // Only a typed prompt counts: an 'auto' turn is the harness resuming a task-notification,
      // and the decision this note asks for - start the next deliverable somewhere else - is one
      // only a person at the keyboard can make.
      if (!compacted && ctx >= RESUME_MIN_TOKENS && ctx < THRESHOLD && promptKind !== 'auto') {
        const resumeFile = path.join(HOME, '.claude', `.context-resume-${session}.json`);
        if (!fs.existsSync(resumeFile)) {
          const age = lastAssistantAgeMs(lines);
          const stale = age !== null && age >= RESUME_GAP_MS;
          const wrapped = WRAP_SKILL.test(tail);
          if (stale || wrapped) {
            try { fs.writeFileSync(resumeFile, JSON.stringify({ ts: Date.now() })); } catch (_) {}
            const why = stale
              ? `the previous turn here was about ${Math.round(age / 3600000)}h ago`
              : 'this session has already been wrapped';
            out += (out ? '\n' : '') +
              `context ~${Math.round(ctx / 1000)}K tokens and ${why}. Every turn taken here ` +
              're-reads the whole carried transcript first, so carrying on is free only for the ' +
              'SAME piece of work. The FIRST LINE of this reply must be one of exactly two: ' +
              '"Same work as before the gap" or "New work: suggest the user runs /clear and ' +
              'restarts from HANDOFF.md (run /wrap first if HANDOFF.md is stale)". ' +
              'HANDOFF.md is the durable record.';
          }
        }
      }

      if (compacted) {
        // No post-compaction usage record yet: the old bucket belongs to a window that no
        // longer exists. Clear it so growth after this point is judged from a fresh baseline.
        try { fs.unlinkSync(stateFile); } catch (_) {}
      } else if (ctx >= THRESHOLD) {
        const bucket = Math.floor((ctx - THRESHOLD) / STEP);
        let last = -1;
        let history = [];
        try {
          const prior = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          last = prior.bucket;
          if (Array.isArray(prior.history)) history = prior.history;
        } catch (_) {}
        if (bucket > last) {
          // Absent-user signal: the PRIOR nudges AND this turn all rode a task-notification -
          // a human typing anything at all right now (even just /compact) proves the user is
          // present, regardless of what the history of earlier turns says.
          const priorAbsent = promptKind === 'auto' && history.length >= ABSENT_STREAK &&
            history.slice(-ABSENT_STREAK).every((k) => k === 'auto');
          history = history.concat([promptKind]).slice(-8);
          try { fs.writeFileSync(stateFile, JSON.stringify({ bucket, history, ts: Date.now() })); } catch (_) {}
          const k = Math.round(ctx / 1000);
          let note;
          if (ctx >= DOUBLE) {
            note = `context ~${k}K tokens, over 2x the nudge threshold. Do not wait for a person: ` +
              'stop pulling large artifacts (screenshots, big file reads) into this context - read ' +
              'them in a subagent that returns a verdict - and hand the next milestone to a fresh ' +
              'headless turn with HANDOFF.md as the state; print this context figure at the top of ' +
              'the next report so an absent user sees it on return.';
            if (priorAbsent) {
              note += ` The last ${ABSENT_STREAK} nudges and this turn all rode turns with no user ` +
                'prompt in between - nobody is here to type /compact.';
            }
          } else if (bucket === 0) {
            note = `context ~${k}K tokens. If this request starts a new deliverable, run /wrap -c first ` +
              'and tell the user to type the /compact line it prints (the model cannot run ' +
              '/compact); every further turn re-reads all of it.';
          } else {
            note = `context ~${k}K tokens - the next milestone does not start in this window. Write ` +
              'HANDOFF.md and hand it to a subagent or a fresh headless turn now; until then, ' +
              "read files with Grep or Read's offset/limit instead of whole files.";
          }
          // Append: a shape note from job 3 or a resume note from 1b must not be clobbered.
          out += (out ? '\n' : '') + note;
        }
      }
    }
  } catch (_) { /* fail open */ }

  if (out) {
    try {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: out },
      }));
    } catch (_) {}
  }
  process.exit(0);
});
