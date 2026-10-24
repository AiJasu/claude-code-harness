---
name: freeze
description: Arm the /freeze guard for this session - restrict all file writes (Write/Edit/MultiEdit) to one directory. Use while debugging or doing a scoped change to prevent edits leaking into unrelated files. Pass a directory or default to the current project root. Lift with /guard-off.
disable-model-invocation: true
allowed-tools: Bash, PowerShell
---

Arm the session-scoped `/freeze` guard. The PreToolUse `guard-hook.js` will then block any
file write outside the frozen directory until `/guard-off` (or a new session).

Freeze to `$ARGUMENTS` if given, otherwise to the current working directory. Run (substitute
the target; on PowerShell use the same args after `node`). Substitute `<session-id>` with
THIS session's UUID (the UUID directory segment in your scratchpad path); if you cannot
determine it, omit `--session` - the guard then applies to all sessions until the next
SessionStart:

```bash
# default: freeze to the current project dir
node ~/.claude/hooks/guard-ctl.js freeze --session <session-id>
# or an explicit directory:
# node ~/.claude/hooks/guard-ctl.js freeze "~/projects/app/src" --session <session-id>
```

Then tell the user which directory is frozen and that `/guard-off` lifts it. Note the guard
only covers Write/Edit/MultiEdit, not file writes done through shell redirection.
