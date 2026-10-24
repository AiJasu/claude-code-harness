---
name: prime
description: Load project context for a fresh session
disable-model-invocation: true
---

# Prime: Context Loader

Orient yourself in this project quickly, then give a concise summary. Gather in parallel:

1. **Structure**: language, framework, monorepo vs single repo, build system.
2. **Context layers**: check for `.claude/rules/` and `.claude/docs/` (CLAUDE.md is already
   loaded automatically).
3. **Handoff**: if `HANDOFF.md` exists, read it - a previous session left context. Verify it
   is still current against the git state it references; if the described work appears
   completed, tell the user the handoff looks stale and can be removed. Otherwise,
   prioritize its next steps.
   Read it whole only if it is under ~10KB; above that read its header/state block and Grep for the
   sections you need - a whole re-read is re-charged on every later turn until the next compaction.
4. **Git state**: current branch, recent commits, uncommitted changes.
5. **Dependencies and build**: package manager, lockfiles, build/test/lint commands.

Then summarize briefly:
- **Project**: what this is, language/framework, key directories
- **Where things stand**: branch, recent commits, uncommitted changes
- **Continuation**: what HANDOFF.md says (if present)
- **Build**: how to build, test, and lint
- **Ready**: confirm oriented and ready for tasks
