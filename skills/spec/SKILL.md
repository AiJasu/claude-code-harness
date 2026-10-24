---
name: spec
description: Turn a rough feature idea into a precise SPEC.md by interviewing the user first. Use for any non-trivial or multi-file feature before implementing - interview, then write a self-contained spec, then implement in a fresh session. Skip for one-line changes.
disable-model-invocation: true
---

# Spec: interview, then write SPEC.md

Goal: convert the user's rough idea into a precise, self-contained spec - so implementation
happens against a written target, not a moving one. Based on the Claude Code "let Claude
interview you" pattern.

The idea to spec: $ARGUMENTS

## Steps

1. **Interview using the `AskUserQuestion` tool.** Ask about the things the user probably
   has not pinned down yet: technical approach, data/state, UI/UX, edge cases, failure
   modes, out-of-scope boundaries, and trade-offs. Do NOT ask obvious questions - dig into
   the hard parts. Keep going (multiple rounds if needed) until the design is unambiguous.
   Prefer concrete option sets with a recommended default over open-ended questions.
   Include a blind spot pass: surface unknown unknowns - risks and questions the user has
   not thought to ask - and fold them into the interview.

2. **Read the relevant code first** if this touches an existing codebase, so the spec names
   real files, interfaces, and patterns rather than inventing them.

3. **Write `SPEC.md`** at the project root. Make it self-contained:
   - One-paragraph goal.
   - The files/interfaces/modules involved (named, with paths).
   - The approach, step by step.
   - Edge cases and how each is handled.
   - Explicitly **out of scope**.
   - An **end-to-end verification step** that proves the feature works (a test to run, a
     command, a screenshot to compare) - so the implementing session can gate completion
     on actually running that step, not on "looks done".

4. **Tell the user** the spec is written and recommend starting a **fresh session** to
   implement it (clean context focused on execution). Do not start implementing in this
   session unless the user explicitly asks.
