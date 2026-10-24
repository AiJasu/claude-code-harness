---
name: best
description: Take the best next step - execute the previous report's Pending list, decide what is yours to decide, report a new one
disable-model-invocation: true
---

# Best: take the best next step

Invoked after a report, usually one ending in `Pending:`. It means: **do what you judge best with
that Pending list - execute it**. The job is getting each item DONE, not reporting why it is not; a
turn that ends with every item unchanged and a "say go" is the failure. It is not a prompt to find
work, and it widens nothing - unless the user names a goal (below). It runs under the `Pending:`
contract in CLAUDE.md Autonomy: listed items are pre-authorized as far as they are repo-local and
reversible, unlisted work waits for the next `Pending:`, the always-stop set holds, and you stop
when the list is drained.

This body is re-injected on every `/best`, so it holds the hot path only. `reference.md` beside it
holds the cold procedures - read the named section when a case below points there.

Arguments, when given: `$ARGUMENTS`. Treat them as an override on the list - a narrowing ("just the
tests"), a veto ("skip the deploy one"), or an order ("second one first"). A veto wins over every
rule below; never run something the invocation just canceled. Say in one clause how you read it.

**A goal argument** has an end condition ("until nothing is left to optimize X", "as low as
possible"). It is the user's standing goal, so it is the request itself: a lever that serves it is
inside scope, never self-extension, and Pending draining is not the stop. Before round 1 read
reference.md "Goal argument" (exit contract, lever ledger, stop rule) and follow it.

## Step 0 - recover the list

The input is the LAST assistant reply's `Pending:` and `Need from you:` lists. In context, use them
verbatim. Compacted or a new session: recover from the transcript tail, then `HANDOFF.md` /
`ACTION_PLAN.md` / the report that turn named. Never reconstruct a list from a general memory of
what felt unfinished. Nothing recoverable: reference.md "No Pending list" (one cheap pass, one named
candidate or "state is clean" - never invented work).

## Step 1 - decide what is actually yours

`/best` is the go for repo-local drift. It IS the explicit fix/apply request that a "drift is
reported, never applied" rule waits for - that rule governs check / diagnose / explain turns, and a
`/best` turn is an execute turn - but system state stays in the always-stop set, and harness files
follow the CLAUDE.md harness-edit rule (the user's own words naming the change). Take every
`Need from you:` item and sort it once:

- **Reversible** - yours when it is repo-local (files inside the current project, a local commit)
  and has a revert path you can name. Decide it, apply it, say which way and why in a clause.
  Handing a reversible item back a second time is the failure.
- **Always-stop** - exactly the CLAUDE.md Autonomy always-stop set, nothing added: outward-facing
  actions (push, PR, merge, deploy, publishing, spending money, a message or form leaving the
  machine), irreversible ones (history rewriting, deleting data), persistent system state outside
  the project (admin shell, registry, services, scheduled tasks, global tool config, a signed-in
  browser session, clicks on the desktop), anything the guard blocks, and anything that would
  change what the user originally requested. A change the user would feel mid-session (restarting
  a dev server or database they are working against right now) counts as outward-facing. Give a
  one-line recommendation and hold; a list that is all always-stop handed back whole IS the
  correct `/best`.

A chained `/best` on the list you just wrote runs its one-turn-old reversible items (the user read
them: contract clause 1); an item that widens the ORIGINAL request, or an always-stop item, is held
with a recommendation. The user's goal argument is inside the request.

## Step 2 - re-check anything stale

A list from before this session describes a tree that has moved (sibling sessions, drifted patches,
vanished scratch paths). Confirm each item still applies; diffs and patches get a clean dry-run
before any real apply. Say what drifted.

## Step 3 - order it, in one line

Rank by: unblocks the rest, then rots if delayed, then cheap-and-reversible, then high cost of
being wrong (last, most verification). Same-file items go in one pass. State the order first.

## Step 4 - execute, without self-extending

- **Never self-extend** (a lever serving the user's goal argument is not extension: it runs now).
  What you discover mid-turn goes in the NEXT `Pending:`.
- **An item is not done until its own named check passes.** Getting it green is still the item, but
  inside the item's own footprint: the moment the fix reaches a file the item never named, stop and
  write it into `Pending:`.
- **Pre-authorization covers the work this task owns.** Commit it locally; push only under the
  grant CLAUDE.md Autonomy names. Never commit a tree someone else dirtied, or edits you did not
  make and cannot explain; never stash (the stack is shared).
- **A guard block or auto-mode classifier denial is final for that item.** Report it with the exact
  command and target under `Need from you:`, then move to the next item. Never reshape the command,
  re-route it through another tool, or hand back a script that performs the denied write. A failing
  item stops itself, the rest runs, and the report says which stopped and why.
- **An item bigger than its one line** gets a v1 that satisfies it as written plus a line on what
  was left out.
- **A Pending item that is a workflow run: launch it with the Workflow tool** - this skill is the
  opt-in it asks for. State its size in counts, launch by `scriptPath`, explicit models. A denial
  ([Create Unsafe Agents]) is a classifier denial like any other: write the run's items to a file
  in the project so the next session need not regenerate them, then report the denial under
  `Need from you:` with that path.
- **A still-running item** (background workflow, push, scheduled agent) gets ONE non-blocking check -
  no foreground sleep, no blocking wait, no third read of the same journal - then report it done or
  carry it forward unchanged.
- **A deliberate user choice is not drift**, unless a report already named changing it, with a
  reason, in `Pending:`: then `/best` on that list is the go.

Drop an item that is wrong, unsafe or already done, and say why.

## Step 5 - verify in proportion

Run each item's named check and READ its output; a check whose output you did not read may not be
cited. Mechanical applies get deterministic checks, never a critic panel. When a check fails,
establish whether YOUR change caused it (compare to the pre-change state) before attributing it.

## Step 6 - report in the standing shape

The answer in 1-4 lines, then `Pending:`, then `Need from you:`. No recap of the list, no per-item
walkthrough, no headers; detail goes in the diff or report file, named by path. It must carry what
got drained and what its check said, what you decided on the user's behalf, and what you
deliberately did not do. Write `Pending:` so the next `/best` runs it without re-deriving anything.
An item that only waits for a background task's completion notice stays OUT of `Pending:`: say in
the answer that the run resumes on that notice, so no chained `/best` is invited with nothing to
do. Then stop.
