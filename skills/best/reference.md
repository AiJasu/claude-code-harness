# /best reference - cold procedures

Read only the section SKILL.md points at. SKILL.md is re-injected on every `/best`, so anything used
in a minority of runs lives here. Nothing in this file overrides SKILL.md or CLAUDE.md.

## Goal argument

A goal argument has an end condition ("until there is nothing left to optimize X", "as low as
possible", "keep going until Y"). It is the user's standing goal, so it is the request itself: a
lever that serves it is inside scope, never self-extension. Without this, the same goal typed on
several `/best` runs stops each time the Pending list drains.

- Before round 1, in the same clause as your reading, write the exit contract: what counts as done
  (the user's number if they gave one), the hard stop (6 levers this turn, or every row closed),
  and the ledger path.
- Keep a lever ledger in a file beside the project's HANDOFF or HISTORY (a scratchpad dies at
  compaction): line 1 the goal verbatim, then rows `lever | tested | measured delta | why stopped`.
  Seed rows from the goal, not only from Pending.
- Pending draining is not the stop. Run the next untested reversible lever in this turn. Stop only
  when every open row is user-hands, always-stop, or a measured delta inside the run-to-run spread,
  or the hard stop trips. The report names the ledger path and puts its untested rows under
  `Pending:`, so a bare `/best` carries on and the user never retypes the goal.
- A measured gain toward the goal is built, not argued down as too small to matter: give the
  number, ship it if reversible; the user judges whether it matters.
- The goal typed again means the last turn stopped early: continue from the ledger and reopen any
  row closed by a recommendation instead of a measurement. Never write "nothing left" while a row
  is untested.

## Chained /best

The user will often run `/best` again on the list you just wrote - a list whose only review was
the user reading it. That review is enough (contract clause 1: a `Pending:` item the user has seen
is pre-authorized as far as it is repo-local and reversible), so a one-turn-old reversible item
runs. What the chain must not become is a
self-triggering loop: an item that widens the ORIGINAL request, or an always-stop item, is surfaced
with a recommendation and held - the chain never manufactures scope, it only drains what the last
turn found inside the request. The user's goal argument is inside the request.

An idle chain still costs a body injection plus a full-context turn. So a report keeps items that
only wait for a background task's completion notice out of `Pending:` (SKILL.md Step 6), and an
idle `/best` answers in one line.

## No Pending list

An extension of the contract, so keep it tight. Spend one cheap pass on real state: uncommitted
work in THIS task's own files, a failing check, a SessionStart drift warning, a background task
that finished and was never acted on, an open row in this project's own docs.

Name the single best candidate and why it beats the others. Do it only if it is reversible, inside
the current project, and clearly within the user's request in THIS session; otherwise name it and
ask. If state is clean, say so in one line - that is a complete answer to `/best`, and inventing
work to fill the silence is the failure this paragraph exists to prevent.

## Anti-patterns

- Handing back a reversible decision that was yours to make - or deciding an irreversible one
  because handing it back felt like failure.
- Handing the SAME reversible item back on consecutive `/best` runs with a "say go" attached: a
  `/best` on a list whose only item is "say go for X" is the go for X, unless X is in the
  always-stop set.
- Working around a guard block or classifier denial: a reshaped command, another tool, or a script
  handed to the user that performs the denied write. A denial is final - report the exact command
  and target under `Need from you:` and stop that item.
- Running an item the invocation's own arguments vetoed.
- Closing a goal argument on a judgment that a gain is too small instead of a measurement.
- Doing the interesting item instead of the blocking one.
- A report longer than the work.
