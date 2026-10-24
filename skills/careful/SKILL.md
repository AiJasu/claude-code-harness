---
name: careful
description: Arm the /careful guard for this session - block destructive shell commands (rm -rf, git push --force, git reset --hard, DROP TABLE, Remove-Item -Recurse -Force, shred, find -delete). Use before risky cleanup, migrations, or when working near production. Lift with /guard-off.
disable-model-invocation: true
allowed-tools: Bash, PowerShell
---

Arm the session-scoped `/careful` guard. The PreToolUse `guard-hook.js` will then hard-block
destructive shell commands until `/guard-off` (or a new session, which resets guards).

Run, substituting `<session-id>` with THIS session's UUID (the UUID directory segment in
your scratchpad path, e.g. `...\<session-uuid>\scratchpad`; if you cannot determine it,
omit `--session` - the guard then applies to all sessions until a new session starts):

```bash
node ~/.claude/hooks/guard-ctl.js careful --session <session-id>
```

Then confirm to the user that destructive commands are now blocked, and that `/guard-off`
lifts the guard. Do not disable it yourself unless the user asks.
