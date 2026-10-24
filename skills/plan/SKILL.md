---
name: plan
description: Create a structured implementation plan for a feature or task
disable-model-invocation: true
---

# Plan

Create a thorough implementation plan before writing code.

## Process

1. **Clarify requirements.** Restate the task in your own words; pin down success criteria,
   scope boundaries (what is explicitly out), and affected areas of the codebase.
2. **Research.** Map the current architecture in affected areas, existing patterns and
   conventions to follow, related tests and validation approaches, and recent git history.
   Use parallel Explore subagents when the areas are wide and independent; read directly when
   a few files settle it. Fetch external docs if the task involves unfamiliar
   APIs, libraries, or protocols (check versions and breaking changes). Finish with a blind
   spot pass: explicitly list the unknown unknowns - assumptions, unfamiliar subsystems,
   hidden couplings that could invalidate the plan - and resolve or flag each in the plan.
3. **Design.** Prefer the simplest approach that fits existing patterns. Note what could
   break and the rollback path, cross-cutting concerns (auth, logging, error handling, concurrency), and
   let dependencies dictate implementation order.
4. **Write the plan** to a project-appropriate location (e.g. `docs/plans/`,
   `.claude/plans/`, or project root) as `{kebab-case-name}.md`:

```markdown
# {Feature/Task Name}

## Goal
1-2 sentences.

## Tasks
Ordered list with dependencies noted. Schema/data changes first.
Each task should be small enough to validate independently.

## Files to create/modify
List with brief rationale for each.

## Validation
- How to verify each task
- What tests to add or run
- Build/lint/type-check commands

## Risks & rollback
- What could go wrong
- How to revert if needed
- Blast radius of the change
```

5. **Report the plan location and ask for approval** before implementation.
