---
name: wrap
description: Parallel session wrap-up - update notes, commit locally (push only with -p / --push or a granted push); with -c / -compact also emit a tailored /compact
when_to_use: Only when the user asks for it - types /wrap, or asks Claude to run /wrap or wrap -c, even mid-task. Never on Claude's own initiative.
---

# Wrap: Parallel Session Handoff + Commit + Tailored Compact

End-of-session routine. Gather context in parallel, refresh the on-disk notes, commit the
session's work locally (when in a git repo), push it only under a push grant, and - only when
asked - emit a `/compact` instruction tailored to THIS session.

Arguments: `$ARGUMENTS`. COMPACT MODE is on only when they contain `-c`, `-compact` or
`--compact`. Compact mode off: skip Step 4 entirely and print only the "Session wrapped" line
in Step 5 - no Compact guidance block, no `/compact` line, no mention of compacting.
PUSH GRANT: the push and the worktree landing (Steps 3 and 3b) run only when the arguments contain
`-p` or `--push`, the user's own request covers this wrap's push ("wrap and push"), or the
project's CLAUDE.md grants pushing. An earlier push request in the session covered that push
only. Without a grant, commit locally and report the push command instead.

The flow is a small dependency graph, not a flat list. Run the independent parts
concurrently; the commit tail is sequential because each step consumes the previous
one's output.

```
Step 1  fan-out (parallel) -- history+summary --+
                           -- load .md files ---+-> Step 2 update .md -> Step 3 commit -> [push grant: 3b merge (worktree) -> push] -> Step 5 report (+ /compact with -c)
                           -- git status -------+
```

## Step 1 - Fan out (run these concurrently)

Issue the independent calls together. If the project is a git repo, put the git reads and
the local-file reads in a SINGLE message so they execute in parallel:

- **History** (git only): `git log --oneline -15` for recent context and `git diff --stat`
  for the session's uncommitted edits - what you are about to commit, so it matters most.
  Do NOT use a `HEAD~N..` range; it errors on repos with fewer than N commits.
  Only if the working diff is genuinely huge (hundreds of files) AND your own session memory
  was already compacted should you offload reading it to one `Agent` (`subagent_type:
  "Explore"`, `model: "sonnet"`) for a tight summary. Otherwise read inline - the main loop
  already holds the session context, so a subagent just adds a round-trip.
- **Uncommitted state** (git only): `git status --short` to see what this session left
  dirty.
- **Local notes**: Glob the project root for the notes files that exist - `HANDOFF.md`,
  `CHANGELOG.md`, `TODO.md`, and similar - then Read the ones found so they
  are loaded for updating. Do NOT create files that don't already exist except `HANDOFF.md`
  (which Step 2 always writes).
  Read `HANDOFF.md` whole only if it is under ~10KB; above that read its header/state block plus the
  sections you will rewrite (Read with `offset`/`limit`, or Grep the section headers first) - same
  for any project register file. A whole re-read of a file already read this session is re-charged
  on every later turn until the next compaction.
- **Error log**: Read `~/.claude/bash-errors.jsonl` if it exists - the failed Bash AND
  PowerShell calls logged by `hooks/error-logger.js` (each entry tagged with a `tool_name`
  field), raw material for Step 2b. Read it TAIL-style (the last ~40 entries) and filtered to
  THIS session's `session_id`, across BOTH `bash-errors.jsonl` and `bash-errors.archived.jsonl` -
  an absent live file means another session archived it, NOT that this session had no errors.
- **Orphan check**: read `~/.claude/orphan-report.txt` if it exists. If it names a live
  process THIS session started, kill it and say so in the wrap; if it belongs to another session,
  say that instead.

If the project is NOT a git repo: skip all git calls. Instead review which files you
created or edited this session and re-read any that changed significantly. Step 3 (commit)
is skipped entirely in this case.

## Step 2 - Update the on-disk notes

Fold the session's outcome into the notes, using the history summary and the loaded files.

Always write `HANDOFF.md` at the project root, using the /handoff skill's template - read
`~/.claude/skills/handoff/SKILL.md` for the canonical section list (Resume here /
Where things stand / In flight first, then Aim / Done so far / Decisions / Tried and dropped /
Touched files; sections with content only). Keep it under ~100 lines and factual, with exact
file paths rather than vague areas.

**ROTATE it when it has outgrown the cap.** Past ~400 lines or ~25KB, move everything but the
current session's sections into `HANDOFF-archive-<date>.md`, leave a one-line pointer at the top of HANDOFF.md,
and carry on. The ~100-line cap above is not self-enforcing, and a file read whole at several
times the cap costs that much context on every read. `handoff-surface.js` names the line count at
SessionStart when the file is over 400 lines, so the size is visible at the moment it matters;
this step is what makes it go back down.

If a `CHANGELOG.md` exists, append a dated, summarized entry for this session in that file's
existing style. Do not restructure it; only add.

## Step 2b - Distill new gotchas from the error log

Skip when Step 1 found no error-log rows for this session. Otherwise Read `~/.claude/skills/wrap/reference.md` (section "Step 2b") and follow it, archive call included.

## Step 2c - Distill process lessons and standing decisions (not from the error log)

Every wrap: Read `~/.claude/skills/wrap/reference.md` (section "Step 2c"), answer its one question, and say in the wrap output when there was nothing to record.

## Step 3 - Commit, and start the push in the background if granted (git repos only)

Configured behavior: commit locally without asking; push only under the PUSH GRANT (top of this
file). Skip this entire step if not a git repo or if `git status --short` shows nothing to commit.

1. Stage only the files this session wrote, the updated notes included, by path:
   `git add <paths>`, never `git add -A`. A file another process dirtied (a sibling session's
   edit, a scheduled job's output) stays out of the commit and is named in the Step 5 report as
   left uncommitted.
2. Commit with a concise message summarizing the session's actual work (imperative subject
   line; short body if the session touched several things). Do NOT add Co-Authored-By /
   Claude-Session / any AI-attribution trailers - global CLAUDE.md rule, which overrides the
   harness default.
3. If on the default branch with no feature branch, that is fine - commit there only if the
   session was already working there; do not invent a branch at wrap time.
4. No PUSH GRANT: do not push. Note "committed locally; push with `git push`" for the Step 5
   report and go on.
   With a grant, start the push and do NOT wait on it: run `git push` (or `git push -u origin
   HEAD` if the branch has no upstream) with `run_in_background: true`, and record the bash_id.
   The push is the one network round-trip here; let it run while you synthesize the compact in
   Step 4 (compact mode) or go straight to Step 5.
   FIRST-PUSH STOP: when the remote has no refs yet (`git ls-remote --heads origin` prints
   nothing), this is the repo's first push. Do not push even with a grant: print the file list that
   would leave the machine (`git ls-files`) in the Step 5 report and hand the push to the user, per
   CLAUDE.md Scope discipline (before a repo's first push, print the file list and gitignore infra
   wrappers and working docs).
   If there is no remote configured, skip the push entirely (note locally-committed-only at
   the end).
5. For every repo OUTSIDE this project that the session wrote to, run `git -C <repo> rev-list --count
   @{u}..HEAD`: a non-zero count is stated in the reply with the exact push command; push it only
   when the user's grant names that repo. A guard block or classifier denial of such a push is
   final: report the exact command and stop, never retry. A repo with no upstream is
   reported, not treated as an error. Check it IS a repo first (`git -C <dir> rev-parse --git-dir`)
   and skip it silently when it is not. A local-only `~/.claude` repo (no remote, so `@{u}` errors
   there) belongs to Step 3c: this step never counts or pushes it.

Never skip hooks or signing. If a pre-commit hook fails, fix the underlying issue or report
it; do not bypass.

## Step 3c - Commit the harness repo (every wrap, git project or not)

Skip when `~/.claude` is not a git repo (`git -C ~/.claude rev-parse --git-dir` fails). Keeping it
as a local-only repo (no remote; a `.gitignore` that keeps credentials, dot-state, transcripts,
caches, logs, plugins and backups out) gives every harness edit a rollback point. Run this step
only when BOTH safety tests pass: `git -C ~/.claude remote` prints nothing, and
`~/.claude/.gitignore` exists and ignores the credentials file (`git -C ~/.claude check-ignore -q
.credentials.json` exits 0). If either fails, skip the step and say in the wrap output which test
failed. If both pass and
`git -C ~/.claude status --porcelain` prints anything, run `git -C ~/.claude add -A` and commit
with a one-line message naming this session's harness change, same no-attribution rule as Step 3.
`-A` is right here, unlike Step 3, because this repo never leaves the machine and each commit is
meant as a snapshot of the whole harness: files this session did not touch belong to a sibling
session, so name them in the message as "also: <files> from a sibling session", never leave them
out. Never push it, never count `@{u}`. Rollback: `git -C ~/.claude revert --no-edit <sha>` for a
whole commit, `git -C ~/.claude checkout <sha> -- <file>` for one file.

## Step 3b - Land the branch if this session ran in a worktree

BEFORE Step 3's push, compare `git rev-parse --git-dir` with `git rev-parse --git-common-dir`. Equal: main checkout, skip. Different: Read `~/.claude/skills/wrap/reference.md` (section "Step 3b") and follow it. Landing (the merge into the default branch) needs the same PUSH GRANT as the push; without one, write the exact merge command into the main checkout's HANDOFF.md and the Step 5 report. With a grant, the push then runs from the main checkout after the merge.

## Step 4 - Synthesize the tailored compact guidance (compact mode only, while any push runs)

HANDOFF.md is the durable record for a FUTURE cold start. The compact guidance you build
here has a different job: preserve the live in-context working memory needed to keep going
in THIS thread, and drop the bulk that is recoverable or already in HANDOFF.md. It is
printed as part of the Step 5 report (NOT folded into the `/compact` command line), where
the compaction summarizer reads it directly from context.

Do a real KEEP/DROP pass over what actually happened. Be concrete - name the specific
files, commands, and abandoned approaches, not generic categories. Specificity is what makes the
summarizer keep the right things.

**KEEP (live working memory):**
- The active goal and exactly where it stands right now
- Files mid-edit and their current uncommitted state
- Exact commands / invocations confirmed to work on this machine
- Environment quirks discovered this session (paths, flags, version pins)
- Decisions and rationale not yet written into code or HANDOFF
- Approaches tried and dropped - what NOT to retry
- User preferences or corrections stated this session
- Unresolved questions and the immediate next action

**DROP (recoverable or noise):**
- Full contents of files already read - reference the path instead
- Superseded code drafts later rewritten
- Verbose tool output: build/test logs, directory listings, raw git output
- Debugging detours that were resolved
- Exploration that did not pan out
- Anything already durably captured in HANDOFF.md (point at it, don't repeat it)

**Adaptive aggressiveness:** if most of the session is finished work or noise, discard
hard. If the work is fragile and mid-flight, keep the fragile bits even when small.

## Step 5 - Collect the push result and output

If Step 3 started a push, collect it before reporting - never claim "pushed" until its exit
is confirmed. If it succeeded, note the commit short-sha and that it pushed. If it was
rejected (non-fast-forward), do NOT force - report the rejection; the commit stays put.
With no push grant, say committed locally and give the push command. If there was no remote,
say committed-locally. If not a git repo, say notes-written-only.
If Step 3b ran, state the landing too - merged into `<default-branch>` (fast-forward or
merge commit), not landed for lack of a push grant (with the merge command), or blocked and why.

Before printing, run the claim check over your own message: every claim names the check that
established it, and a claim with no check is dropped rather than softened.

Compact mode OFF (the default): print only this line and stop:

Session wrapped. HANDOFF.md updated{, committed as `<short-sha>` and pushed / , committed locally as `<short-sha>`; push with `git push` / , committed locally (no remote) / ; no git repo, notes written}{, merged into `<default-branch>` / , not landed; merge with `<command>` (in HANDOFF.md) - worktree sessions only}.

Compact mode ON (`-c` / `-compact`): print exactly this with the bracketed parts replaced by
your synthesized specifics:

---
Session wrapped. HANDOFF.md updated{, committed as `<short-sha>` and pushed / , committed locally as `<short-sha>`; push with `git push` / , committed locally (no remote) / ; no git repo, notes written}{, merged into `<default-branch>` / , not landed; merge with `<command>` (in HANDOFF.md) - worktree sessions only}.

Compact guidance (the summarizer reads this from context - specific and tight):
- PRESERVE: [in-flight goal + exact state]; [files mid-edit and their uncommitted state]; [commands/env quirks confirmed this session]; [decisions + rationale not yet in code or HANDOFF]; [approaches dropped, not to retry]; [user preferences stated this session]; [immediate next action]
- DROP: [the specific big files/logs/tool output from this session]; superseded drafts; resolved debugging; exploration that did not pan out; anything already in HANDOFF.md

Run this to compress context:

`/compact Durable record is in HANDOFF.md. Apply the PRESERVE and DROP lists from the "Compact guidance" block in the final /wrap message.`

---

The `/compact` line must stay EXACTLY as written above: one short line, no newlines, no
session-specific detail folded in. A paste over 800 characters or more than 2 lines
collapses into a "[Pasted text #N +M lines]" placeholder (documented threshold, Claude Code
terminal configuration docs), and a slash command inside a collapsed paste does not trigger
(no setting disables the collapsing). The tailored specifics travel via the Compact guidance
block, which is already in the context the summarizer reads - not via the command itself.
(User-side fallback for any long command: TYPE `/compact ` first, then paste the rest - a typed
`/` parses normally and the paste expands into the argument.)

Do NOT run /compact yourself - it is a built-in command only the user can invoke.
