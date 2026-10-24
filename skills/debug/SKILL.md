---
name: debug
description: Root-cause a bug, test failure, crash, performance anomaly, or any unexpected behavior before proposing a fix. Use whenever a symptom appears - a failing test, a stack trace, a hang, a wrong number, a "why is this slow", a fix that did not work - and especially when the cause seems obvious or a previous fix already failed. Enforces investigation before mitigation and calibrated diagnosis language.
---

# Debug: cause before fix

Adapted from the `systematic-debugging` skill in obra/superpowers (MIT), fused with a
diagnosis-voice rule for calibrated confidence language.

## The rule

NO FIX BEFORE A ROOT CAUSE THAT A MEASUREMENT COULD HAVE KILLED.

A symptom fix is a failure even when the symptom goes away. Applies hardest exactly where it
feels least needed: under time pressure, when the cause looks obvious, and after a previous
fix already failed.

## Phase 1 - Investigate

- Read the error whole: message, stack, line numbers, exit code. Not the first line.
- Reproduce it deliberately and write down the steps. A bug you cannot summon, you cannot fix.
- Check what changed: `git diff`, `git log` since it last worked, dependency and config drift.
- In a multi-component path, instrument each boundary and find which one the data goes wrong at.
- Trace backward from the error to the origin of the bad value.

## Phase 2 - Compare against something that works

- Find the nearest working case in this same codebase.
- Read the working implementation completely, not the part that looks relevant.
- List every difference: code, config, environment, ordering, permissions, encoding.

## Phase 3 - Hypothesis

- State one hypothesis, with the reason, and the measurement that would FALSIFY it.
- Test with the smallest isolated change that discriminates. Do not stack changes.
- If it survives, say so with the measurement. If it dies, form a new hypothesis - never widen
  the old one to fit.
- Any change shipped only to TEST a hypothesis states its revert-or-confirm condition in the
  same message, and is deleted or A/B'd rather than left armed: an experiment left in place
  quietly becomes standing policy, even against a cause already fixed elsewhere.

## Phase 4 - Fix

- Write the failing test first where a test is possible.
- One fix, at the root. Verify the symptom is gone AND nothing else broke.
- Three failed fixes means the model of the system is wrong. Stop fixing; question the design.

## Diagnosis voice

Open with the confidence, not the conclusion: "Likely X (medium) - the measurement that would
kill it is Y". "Found it", "the real problem" and "fixed" are reserved for after the falsifying
measurement returned. A hedged body under a certain headline still reads as certain.

Before calling a number normal, write the expected magnitude and the ratio. Anything above ~3x
a written expectation is the lead, not the baseline. Known baselines on Windows: ~1-2 live
`bash.exe` per active session; a Bash tool call under ~1s of preamble (`~/.claude/shell-latency.json`,
written at SessionStart).

## Stop and restart Phase 1 if

- A solution is being proposed and no measurement has been read yet.
- Two changes are going in at once.
- Something is assumed rather than checked ("it must be the cache").
- This is the fourth fix attempt.

## Rationalizations that are not exemptions

"No time" - guess-and-check is the slower path, measured in user round-trips.
"It's simple" - simple bugs have root causes too, and they are cheap to find.
"The fix worked" - if the cause was never named, what worked is unknown and will return.

## Scope

This governs the ORDER of work, not its size. It does not authorize a verification fleet: the
right-size-verification HARD RULE in CLAUDE.md still applies, and a single-item bug gets one
reproduction and one measurement, not a panel.
