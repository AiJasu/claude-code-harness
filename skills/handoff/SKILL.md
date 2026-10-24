---
name: handoff
description: Write a session handoff document for continuity
disable-model-invocation: true
---

# Session Handoff

Before ending a session or hitting context limits, externalize your working state to `HANDOFF.md` in the project root.

## Template

```markdown
# Handoff

## Resume here
{First concrete action on resuming: the file, the command, the check.}

## Where things stand
- Build: {green/red}
- Tests: {pass count / total, names of any failing}
- Branch: {name}
- Working tree: {clean, or what is uncommitted}

## In flight
- [ ] {open task -- file paths and what is left}
- Blocked by: {if anything}

## Aim
{The original objective, one or two sentences}

## Done so far
- [x] {task}
- [x] {task}

## Decisions
- {Choice}: {why it beat the alternatives}

## Tried and dropped
- {Approach}: {why it failed, so nobody retries it}

## Touched files
- `path/to/file` -- {what changed and why}
```

The resume sections go FIRST: `hooks/handoff-surface.js` surfaces Resume here / Where things stand /
In flight ahead of the rest at SessionStart, and a reader who stops early should stop after the
part that matters.

## Rules
- Stay under ~100 lines
- Name exact file paths, never vague areas
- Never skip Tried and dropped -- it is what stops a later session repeating a failed approach
- Reference paths instead of pasting file contents
- Start with the action to take, not a recap
- If a plan file exists, point at it rather than copying it
