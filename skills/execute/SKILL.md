---
name: execute
description: Execute an implementation plan step by step
disable-model-invocation: true
---

# Execute Plan

Implement a plan file methodically with validation at each step.

## Input
Path to a plan file, or a description of which plan to execute.

## Process

1. **Read the entire plan first** - all tasks, their order, dependencies, and validation
   requirements - before writing any code.
2. **Verify clean state** (`git status`, recent log): working tree clean, correct branch.
   If there are uncommitted changes, ask before proceeding.
3. **Implement in dependency order**, running the relevant validation (type-check, lint,
   tests) after each task and fixing failures immediately - don't accumulate them.
4. **Full validation** at the end: the project's complete suite (type check, lint, tests,
   build - CLAUDE.md has the commands).
5. **Report**: tasks completed against the plan, files created or modified, validation
   results, any deviations from the plan and why, follow-up work needed.
