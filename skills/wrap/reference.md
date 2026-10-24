# Wrap reference - the cold steps

skills/wrap/SKILL.md names each step below by its heading and says when to read it. Steps 2b, 2c
and 3b live here so the hot body stays well under the size cut that a post-compaction re-attach
applies to a skill body.

## Step 2b - Distill new gotchas from the error log

Turn this session's mistakes into durable rules so they are not repeated. Work from the
`bash-errors.jsonl` lines read in Step 1 (skip this step entirely if there were none).

1. Filter to GENUINE mistakes - a wrong command/format/path that you then retried a
   different way and got working. Discard the noise: legit test/build failures, `grep`/
   `rg` exiting 1 on no match, intentional existence probes, user-aborted commands,
   auto-mode classifier denials (a judgment about the action, not a wrong command: a rule that
   routes around one is a bypass recipe, which gotchas.md already forbids), network blips. A
   failure only counts if the correct approach is knowable (you saw the working retry this
   session, or the stderr states the fix).
   Then run `node ~/.claude/tools/errlog-archive.js <session_id> --dry-run` (the id is the UUID
   directory in your scratchpad path; add `--stale` when SessionStart named untriaged rows from
   sessions that ended without /wrap). It counts the rows by known-trap signature and shows each
   one's 30-day count across both logs. A row that matches a rule already in gotchas.md is
   COUNTED, not dismissed as "already covered": a signature marked REPEAT (2+ sessions in 30
   days) means that rule is not holding, so write "convert <signature> to a hook, or fix where its
   rule is read" under Resume here in HANDOFF.md (the wrap's reply is one line) instead of writing
   another rule.
2. For each real one, write a single-line rule in the form "correct way - the wrong way it
   replaces" (e.g. "Use `2>/dev/null` in the Bash tool, not `2>$null` - that is PowerShell
   syntax and errors with `ambiguous redirect`").
3. Route each rule to the right home - this is what keeps the always-on context lean:
   - PROJECT-SCOPED rules (only bite in one repo/app: its deploy, its build system, its
     domain) -> append to THAT PROJECT's CLAUDE.md, not the global file.
   - Rare one-off recipes (an op you would only redo months later) do not earn an always-on
     line: skip them, or put them in the project's CLAUDE.md when they belong to one project.
   - Only genuinely CROSS-CUTTING machine-wide rules -> Read `~/.claude/gotchas.md`, dedup
     against what is already there (merge, don't duplicate), and append under the right
     subsection AS A 1-3 LINE RULE (correct way + the wrong way it replaces). The incident
     narrative - dates, measurements, what it looked like, how many passes it burned - does
     NOT go into gotchas.md. gotchas.md is imported into every session, and rules in a
     sprawling file stop being followed: keep it within its line budget, and if your addition
     pushes past that, tighten or merge an existing entry in the same pass.
4. When this wrap rewrote or condensed an instruction file, verify per RULE, not per token: extract
   the bullet headings (lines matching `^- `) before and after, and print the headings in the old
   file with no counterpart in the new one. That list, or the word NONE, goes in the reply -
   never claim completeness ("every rule kept") without showing it.
5. Read the day's `~/.claude/guard-blocks.jsonl` the way you read the error log: name any entry
   that was a false positive in the wrap, with the loosening that fixes it, instead of leaving it
   inside a dead subagent. Its rows are keyed `ts` and `cmd_sha256_8`, never the command text -
   filtering on a field that is not there returns a silent zero that reads exactly like a clean day.
6. If `<scratchpad>/private-input.txt` exists, grep this session's scratchpad tree, its
   `jobs/<id>/tmp` and its `tasks/*.output` for any 24-character window of a non-comment line in
   it, list the hits and delete the derived copies.
7. Archive the processed rows so they do not re-distill next time: run
   `node ~/.claude/tools/errlog-archive.js <session_id>` with the same flags as the item 1 dry
   run. It moves ONLY this session's rows (with `--stale`, also rows older than 24 h from
   sessions that ended without /wrap) into `bash-errors.archived.jsonl`; a sibling session's
   fresh rows stay for its own wrap. Never append the whole live log to the archive and then
   delete it: that moves every other session's rows untriaged. When no row is left, the live log
   starts fresh. If nothing was worth keeping, still archive - a processed log is an empty slate.
   No removal verb is involved, so the guard hook has nothing to block.

If no real lessons emerged, note that and move on - do not invent rules to fill the file.

## Step 2c - Distill process lessons and standing decisions (not from the error log)

Ask once: did this session change HOW the work was run, or identify a change it should have made
- stage ordering, agent sizing, a spec written up front, a cheap check that would have caught
what an expensive one did, a gate that never terminated? Any such lesson the user approved
in-session goes in this wrap: one or two lines into the project's CLAUDE.md, in the same rule +
wrong-way-it-replaces form gotchas.md uses. The global `~/.claude/CLAUDE.md` changes only when the
user's own words named that edit (CLAUDE.md harness-edit rule); otherwise propose the line in the
report.

Same pass for standing user decisions made this session. An authorization the user granted for one
action (a push, a deploy, a lifted constraint) is NOT persisted: it covered that action only. Write
one down as a standing rule only when the user explicitly asks for a standing rule; then paraphrase
it (no verbatim quotes), name the exact action and target it covers, and put it in the project's
CLAUDE.md - the global file only when the user asks for it to apply everywhere.

If there is neither, say so in the wrap output - the step is answered, never skipped silently.

## Step 3b - Land the branch if this session ran in a worktree

A worktree branch that never gets merged is invisible work: the main checkout, the next
session, and every other worktree all still see the old tree. So wrapping a worktree session
means landing it or leaving an exact record of how to land it, not just committing it.

Landing needs the PUSH GRANT from SKILL.md (`-p`/`--push`, a push the user asked for this
session, or the project's CLAUDE.md granting it). Without one, run steps 1-3 only (detect, find
the main checkout, check it is safe), skip steps 4-5, and write the UNMERGED WORKTREE record at
the end of this section with the exact merge command.

1. **Detect.** The session is in a worktree when `git rev-parse --git-dir` differs from
   `git rev-parse --git-common-dir` (cwd under `.claude/worktrees/` is the usual shape).
   If they match, this is the main checkout - skip the rest of this step.
2. **Find the main checkout.** `git worktree list --porcelain` - the FIRST entry is it.
   Never `cd` there; drive it with `git -C <main-checkout>` from where you are. If the isolation
   guard refuses the `-C` redirect (it does for EnterWorktree sessions), commit the branch in the
   worktree (and push it only under the push grant), ExitWorktree with `keep`, then run steps 3-5
   (4-5 under the push grant only) from the main checkout
   without `-C`, and remove the worktree afterwards (`git worktree remove`, `git branch -d`) once
   `main` contains its commits.
3. **Check it is safe to land.** `git -C <main> status --short --branch` and
   `git -C <main> diff --name-only <default-branch>..<session-branch>`. If the main checkout
   has uncommitted changes to a file the branch also touched, STOP and report - do not stash
   (the stash stack is shared with other sessions) and do not commit someone else's dirty
   working tree. Untracked files that the branch does not add are harmless; proceed.
4. **Merge (push grant only), fast-forward first:** `git -C <main> merge --ff-only <session-branch>`. If the
   default branch has moved on, fall back to a real merge (`git -C <main> merge
   <session-branch>`) only when the main checkout is clean. Resolve nothing blind: on a
   conflict, abort (`git -C <main> merge --abort`) and report which files collided.
   NEVER `reset --hard`, force, or rewrite the default branch to make this work.
5. **Push the landed branch, not the worktree branch (push grant only).** If a remote exists, the Step 3 push
   should run as `git -C <main> push` after the merge (the merged commits live on the default
   branch now). If there is no remote, the merge IS the landing - say so.
6. Leave the worktree itself in place. Exiting or deleting it is the user's call, and the
   session may still be using it.

Report the result concretely: fast-forwarded / merged / not landed (no push grant) / blocked and why. "Committed" is not
the same claim as "landed on <default-branch>" - do not blur them.

If the branch did not land, do BOTH: append a dated `UNMERGED WORKTREE: <branch> at <sha>, merge with
<exact command>` line to the MAIN CHECKOUT's HANDOFF.md, and name that file in the final message.
Never end a worktree session with the branch unmerged and no record outside the branch.
