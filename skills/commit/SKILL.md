---
name: commit
description: Create a meaningful commit with conventional format
disable-model-invocation: true
allowed-tools: Bash, PowerShell, Read, Grep, Glob
---

# Commit

Review the working tree (status, full diff, untracked files) and produce one well-formed
commit for the current work.

Format:

```
tag(scope): concise description of what changed

Why this change was made -- context not obvious from the diff.
```

- Conventional tag (`feat`/`fix`/`refactor`/`docs`/`test`/`chore`/`perf`); first line under
  72 characters.
- The body explains WHY, not WHAT (the diff shows what).
- Stage only files relevant to the current task. Never stage `.env`/credential files or
  large binaries.
- If AI context files were modified (`.claude/rules/`, `.claude/skills/`, `CLAUDE.md`), add a
  Context section so the AI layer's evolution is visible in git history:

```
feat(auth): add token rotation

Previous tokens never expired, creating a security risk for long-running sessions.

Context:
- Added the token rotation convention to CLAUDE.md
```
