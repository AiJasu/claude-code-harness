---
name: guard-off
description: Lift the guards for this session - the opt-in /careful and /freeze, plus the always-on catastrophic-command / secret-exfil blocks. The secret-WRITE scan stays active and cannot be turned off here. Use when a guard is blocking legitimate work (e.g. an intentional git reset --hard or force-push).
disable-model-invocation: true
allowed-tools: Bash, PowerShell
---

Lift the guards for this session. Run, substituting `<session-id>` with THIS session's UUID
(the UUID directory segment in your scratchpad path, e.g. `...\<session-uuid>\scratchpad`).
Do NOT omit `--session` here unless you truly cannot determine the id - omitting it lifts
the guards for ALL parallel sessions, not just this one:

```bash
node ~/.claude/hooks/guard-ctl.js off --session <session-id>
```

Confirm to the user that this suspends, until a new session starts: `/careful`, `/freeze`, and
the always-on blocks (catastrophic commands like `git reset --hard` / force-push / `rm -rf ~` /
`rm -rf` of an unresolved variable, and the secret-file-to-network exfil block). The always-on
**secret-write scan stays active** (it still blocks writing high-confidence secrets into
tracked files). All of this re-arms automatically when a new session starts.

Auto mode: this lifts the HOOK only. The classifier still judges
the retry - a force-push, `git reset --hard` or recursive delete of existing files goes through only
when the user's own message names the exact command and its target, and a credential sent anywhere
but its own service's API is a hard deny no message clears. Say so in the same confirmation and ask
the user to name the action.
