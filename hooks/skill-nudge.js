#!/usr/bin/env node
// skill-nudge.js - UserPromptSubmit WARN-ONLY nudge when the user asks for something an
// INSTALLED skill already does and the session is about to hand-author the pipeline instead.
//
// Reason it exists: a session can hand-author a large review workflow even though the installed
// security-scan skill already ships that review-then-verify shape. Prose in the skill index did
// not prevent it, so a hook nudges instead.
//
// SHIPPED WITH ONE ENTRY, ON PURPOSE. Only security-scan has a recorded case of the miss it
// prevents. A code-review or deep-research trigger would be a word-matching rule that has caught
// nothing yet and can still misfire (a UserPromptSubmit hook cannot see a model-initiated
// review). Add an entry to TRIGGERS only after a prompt that needed it has actually been seen.
//
// Detection is positive-evidence only: a review/audit VERB and the security DOMAIN within one
// clause. An unforeseen phrasing goes silent instead of wrong.
//
// Suppressed three ways: the skill already appears in the bounded transcript tail (same 512KB
// read as context-nudge.js), the prompt is itself a slash command, or this
// session has already been nudged about that skill - one note per skill per session, never a
// repeat. Warn-only; never blocks; any internal error fails open on exit 0.
//
// Fixtures: node hooks/tests/skill-nudge-fixtures.js
//
// STOPPING RULE: the expected false positive is a prompt that DISCUSSES security work rather than
// asking for it ("what did the security review find", "the audit is already done"). On the first
// such false positive in live use, tighten the pattern; on the second, delete this hook and its
// settings.json entry - never a third carve-out.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const TAIL_BYTES = 512 * 1024;

// name: the skill to name in the note.
// test: what must be in the prompt for it to fire.
// why:  the skill's own one-line whenToUse, quoted from its SKILL.md description.
const TRIGGERS = [
  {
    name: 'security-scan',
    test: /\b(?:security[- ]?(?:review|audit|scan|assessment|pass)|(?:review|audit|check|look at|go over)[^.\n]{0,60}\bsecurity[- ]?wise|(?:review|audit|check)[^.\n]{0,60}\bfor\b[^.\n]{0,40}\bvulnerab|threat[- ]?model|pen(?:etration)?[- ]?test)/i,
    why: 'threat-model-driven security review of a codebase or diff, with each finding verified by an independent agent before it is reported',
  },
];

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

// TRIGGERS is exported so a test or scoring script can score prompts against the table that
// actually runs rather than a copy of it. The stdin wiring below is guarded so a require() reads
// the table without the hook hanging on a stdin that never ends.
module.exports = { TRIGGERS };

function main() {
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const prompt = String(input.prompt || '');
    // A slash command is already a skill invocation - nudging one to use a skill is noise.
    if (!prompt.trim() || prompt.trim().startsWith('/')) process.exit(0);

    const hit = TRIGGERS.find((t) => t.test.test(prompt));
    if (!hit) process.exit(0);

    let tail = '';
    if (input.transcript_path && fs.existsSync(input.transcript_path)) {
      try { tail = readTail(input.transcript_path); } catch (_) {}
    }
    // Already used this session: the nudge has nothing to add.
    if (new RegExp('"skill"\\s*:\\s*"' + hit.name + '"').test(tail)) process.exit(0);

    const session = String(input.session_id || 'unknown').replace(/[^\w.-]/g, '_');
    const stateFile = path.join(HOME, '.claude', `.skill-nudge-${session}.json`);
    let nudged = [];
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (s && Array.isArray(s.nudged)) nudged = s.nudged;
    } catch (_) { /* first turn this session */ }
    if (nudged.includes(hit.name)) process.exit(0);

    try {
      fs.writeFileSync(stateFile, JSON.stringify({ nudged: nudged.concat(hit.name) }));
    } catch (_) {}

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'skill-nudge: the installed `' + hit.name + '` skill covers this request - ' +
          hit.why + '. Invoke it rather than hand-authoring a pipeline for the same shape. ' +
          'This note is warn-only and appears once per session.',
      },
    }));
  } catch (_) { /* fail open */ }
  process.exit(0);
});
}

if (require.main === module) main();
