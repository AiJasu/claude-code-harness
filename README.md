# claude-code-harness

## How to install

Give Claude Code this prompt:

> Install the Claude Code harness from https://github.com/AiJasu/claude-code-harness: clone it to
> ~/claude-code-harness, then follow the "Install steps for Claude" section of its README.

Claude checks your setup, shows you what will change ([Before you install](#before-you-install)),
backs up your files, and asks before it replaces or merges anything of yours. The steps it follows
are in [Install steps for Claude](#install-steps-for-claude).

## About

A ready-made setup for Claude Code: global instructions, hooks that enforce them, skills for the
start and end of a session, and a terse output style.

The idea behind it: a rule in `CLAUDE.md` is a request, a hook is a guarantee. Where a rule kept
getting broken, a hook now checks it. Dangerous cases are blocked, the rest get a warning, and most
hooks have a test suite.

## What you get

- **A safety guard** that blocks catastrophic commands (`rm -rf /`, force-push, disk formatting),
  secrets written into files, and secrets sent off the machine. It also keeps your account email out
  of web requests.
- **Model routing for subagents.** Every subagent and workflow call must name its model, so fan-out
  work never silently runs on the most expensive one.
- **Short replies.** The answer first, then only a `Pending:` and a `Need from you:` list.
- **Session skills:** `/prime` to start, `/wrap` to save notes and commit at the end, `/best` to run
  the pending list from the last reply, plus `/plan`, `/spec`, `/execute`, `/debug`, `/commit` and
  `/security-scan`.
- **Warnings that catch drift:** settings changed behind your back, dev servers left running, the
  context window filling up, over-long replies.
- **A status line** with context, rate-limit and cost gauges.

## Before you install

This setup changes how Claude Code behaves. Read these points first:

- Replies become short. Ask for detail when you want it, or remove the output style.
- Claude commits its own work locally without asking. It asks before it pushes, opens a PR or
  merges (unless a project's own `CLAUDE.md` grants that), and always before it deploys or changes
  anything outside the project (system settings, services, your browser, your desktop).
- Subagent calls without an explicit model are blocked.
- Some commands are blocked outright. A blocked command stops, and Claude tells you which rule
  blocked it.
- Commit messages and PR bodies never carry AI attribution.
- It was developed on Windows 11 with Git Bash and PowerShell 7. See [Platform notes](#platform-notes).

Everything is plain text and plain Node.js. Read the hooks before you install them: they run on
every tool call.

## Requirements

- Claude Code, a current release.
- Node.js 18 or newer on `PATH`.
- On Windows: Git Bash (Claude Code's default shell for hooks). PowerShell 7 is optional.
- Python 3 for `/drive-screen` only (Windows only).

The two guard hooks fail closed (`"onFailure": "block"`): if `node` is missing or a guard cannot
start, tool calls are blocked until you fix it. Hook commands use `$HOME`; if your hook shell does
not expand it, replace it with the absolute path to your home folder.

## Install steps for Claude

Claude: when a user asks you to install this harness, follow these steps in order. Never overwrite
a file of the user's without asking first. (Someone installing without Claude can run the same
steps by hand.)

1. **Check and confirm.** Run `node --version` (18 or newer is required) and, on Windows, check
   that Git Bash is installed. Show the user the [Before you install](#before-you-install) list and
   wait for their go before you change anything.
2. **Clone to a separate folder**, never into `~/.claude`: that folder holds the user's login
   credentials and transcripts, and must never go under git with a remote. Skip this if the repo
   is already cloned.

   ```sh
   git clone https://github.com/AiJasu/claude-code-harness ~/claude-code-harness
   cd ~/claude-code-harness
   ```

3. **Back up** the user's files and list their skills:

   ```sh
   mkdir -p ~/.claude
   cp ~/.claude/CLAUDE.md ~/.claude/CLAUDE.md.bak 2>/dev/null
   cp ~/.claude/settings.json ~/.claude/settings.json.bak 2>/dev/null
   ls ~/.claude/skills 2>/dev/null
   ```

4. **Copy the runtime folders.** This repo ships these skills: `best`, `careful`, `commit`,
   `critic-loop`, `debug`, `drive-screen`, `execute`, `freeze`, `guard-off`, `handoff`, `plan`,
   `prime`, `security-scan`, `spec`, `wrap`. If the list from step 3 has any of these names, ask the
   user whether to replace theirs or keep it; for a kept one, copy the skills one by one and leave
   that name out. With no clash:

   ```sh
   cp -r hooks skills agents tools output-styles gotchas.md ~/.claude/
   ```

5. **Add the instructions.** If there is no `~/.claude/CLAUDE.md`, copy ours:
   `cp CLAUDE.md ~/.claude/CLAUDE.md`. If there is one, do not overwrite it: show the user the
   sections of ours, merge only the ones they pick, and keep their own rules. Keep our last line,
   `@~/.claude/gotchas.md`, which loads the gotchas file.
6. **Wire the hooks.** If there is no `~/.claude/settings.json`, copy the example:
   `cp settings.example.json ~/.claude/settings.json`. If there is one, merge these keys from
   `settings.example.json` and keep everything else, then show the user the merged file and write
   it only after they agree:

   | Key | How to merge |
   |-----|--------------|
   | `hooks` | Append each entry to the matching event list. Keep the user's own hooks. |
   | `permissions.deny` | Append the entries. |
   | `statusLine`, `subagentStatusLine` | Take ours, unless the user wants to keep theirs. |
   | `attribution`, `outputStyle`, `autoCompactWindow` | Take ours, unless the user set them on purpose. |

   If the user's settings pin a default model (a `model` key), also add `CLAUDE_MODEL_PIN` with
   that value to the `env` block (see [Configuration](#configuration)), or the drift check will
   remind them about the pin at every start.
7. **Finish.** Report which files you copied, merged or skipped, then tell the user to restart
   Claude Code and run `/hooks` to see what loaded.

## Configuration

Optional environment variables. Set them in the `env` block of `settings.json` or in your shell.

| Variable | Effect |
|----------|--------|
| `CLAUDE_MODEL_PIN` | What the drift check expects for the default model. Unset: no `model` key in settings. A model id: that model. Empty: model checks off. |
| `CLAUDE_EXPECT_DEFAULT_MODE` | A permission mode, such as `auto`. The drift check warns when your default mode differs. |
| `CLAUDE_MCP_ALLOW` | Comma-separated MCP server names the drift check accepts. Any other server gets a warning. |
| `CLAUDE_KILL_ORPHANS` | `1`: at session end, stop the JS dev servers this session launched. Default: report only. |
| `CLAUDE_SHELL_CANARY_MS` | Shell-latency warning threshold in milliseconds (default 2000). |
| `CLAUDE_STATUSLINE_ASCII` | `1`: plain ASCII status line, for fonts without block characters. |
| `CLAUDE_STATUSLINE_BAR` | `blocks`: draw gauges with block characters instead of background color. |
| `NO_COLOR` | Status line without color. |

To turn off a single hook, delete its entry from `settings.json`. To get normal-length replies back,
remove `outputStyle` (or pick another style with `/output-style`).

## What is in here

| Path | What it is |
|------|------------|
| `CLAUDE.md` | Global instructions: scope discipline, verification depth, subagent and model routing, process lifecycle, autonomy limits. |
| `gotchas.md` | Short list of learned pitfalls (Windows shells, PowerShell, Claude Code). Loaded by `CLAUDE.md`, maintained by `/wrap`. |
| `output-styles/terse.md` | The "Terse" output style. |
| `settings.example.json` | Hook wiring, Read-tool denials for secret files, status line, output style, empty commit/PR attribution. |
| `hooks/` | The hooks, plus two helpers: `guard-ctl.js` (behind the guard skills) and `statusline-lib.js`. |
| `hooks/tests/` | One test suite per hook family. |
| `skills/` | 15 skills. |
| `agents/lean-worker.md` | A subagent for mechanical workflow stages. It loads no `CLAUDE.md`, so it starts cheaply. |
| `tools/check-wf.js` | Validator for Claude Code workflow scripts. |
| `tools/errlog-archive.js` | Used by `/wrap`: archives one session's rows of the error log and flags traps that keep recurring. |

### Hooks

| Hook | Event | What it does |
|------|-------|--------------|
| `guard-hook.js` | PreToolUse | Blocks secret writes, catastrophic commands and secret exfiltration. Keeps your account email out of web fetches, searches and browser form input. Powers `/careful`, `/freeze` and `/guard-off`. |
| `browser-guard.js` | PreToolUse (Chrome tools) | Logs state-changing browser actions and warns on sensitive sites (consoles, billing, account settings). |
| `model-routing-guard.js` | PreToolUse (Agent, Workflow) | Blocks subagent and workflow calls that name no model. Notes a call that names no effort. |
| `poll-guard.js` | PreToolUse | Notes repeated polling of a background task's output. |
| `context-nudge.js` | UserPromptSubmit | Warns as the context grows toward your auto-compact window. |
| `skill-nudge.js` | UserPromptSubmit | Points to an installed skill that covers the request. |
| `reply-lint.js` | Stop | Flags over-long replies, emoji, completion claims that name nothing left unchecked, unexplained internal codes, an unmentioned guard block, and misused `Need from you:` items. |
| `wf-concurrency.js` | Stop | Measures workflow slot usage and oversized workflow results. |
| `detect-orphans.js` | Stop, SessionEnd | Reports dev servers and port listeners left running (Windows). |
| `session-start.js` | SessionStart | Daily backup of the rules files, cleanup of old state files, the list of files to re-read after compaction, and a shell-latency check. |
| `handoff-surface.js` | SessionStart | Shows the project's `HANDOFF.md` (framed as untrusted notes), pending `/critic-loop` prompts, and error-log rows no `/wrap` has handled. |
| `config-drift-check.js` | SessionStart | Warns on settings drift: unknown MCP servers, hooks from outside `~/.claude/hooks`, API endpoint or proxy overrides, model and effort defaults. |
| `pre-compact-guidance.js` | PreCompact | Tells the compactor what to keep. |
| `worktree-brief.js` | PostToolUse (EnterWorktree) | A short brief on the rules inside a git worktree. |
| `error-logger.js` | PostToolUseFailure | Logs failed shell calls for `/wrap` to learn from. |
| `statusline.js`, `subagent-statusline.js` | Status line | Context, rate-limit and cost gauges. |

### Skills

| Skill | Use it to |
|-------|-----------|
| `/prime` | Load a project's context at the start of a session. |
| `/handoff`, `/wrap` | Write the session notes; `/wrap` also commits, and pushes only with `-p` or a project grant. |
| `/plan`, `/spec`, `/execute` | Plan a change, write the spec, then build it. |
| `/commit` | Make a clean commit. |
| `/debug` | Find the root cause before fixing. |
| `/security-scan` | Threat-model review, each finding checked by an independent agent. |
| `/best` | Run the `Pending:` list from the last reply. |
| `/critic-loop` | Turn a task into a saved build-and-critique loop prompt. |
| `/careful`, `/freeze`, `/guard-off` | Switch guard modes. |
| `/drive-screen` | Control the Windows desktop (windows, keys, clicks, screenshots). |

## Privacy and local files

No hook makes a network request. The hooks keep small files under `~/.claude`:

- `bash-errors.jsonl` - failed shell commands and their errors, with common credential shapes
  masked (URL logins, password and token flags, auth headers). `/wrap` moves its rows to
  `bash-errors.archived.jsonl`, which is kept until you delete it.
- `guard-blocks.jsonl` - which guard rule fired (a hash of the command, not the command).
- `browser-actions.log` - time, tool and host of state-changing browser actions. No typed text.
- `backups/rules/` - daily copies of your instruction and settings files, kept 14 days.
- `orphan-report.txt`, `shell-latency.json`, a status-line git cache in `.statusline-git/`, and
  small per-session state files.

Two skills keep files there too: `/drive-screen` writes an action log and screenshots under
`screenctl/`, and `/critic-loop` saves its generated prompts under `critic-loop/`.

These sit next to the transcripts Claude Code already keeps there. The `permissions.deny` list stops
the Read tool from opening common secret files. It does not cover shell commands; the guard's
secret-exfiltration block is the backstop there.

## Platform notes

- Developed and tested on Windows 11 with Git Bash and PowerShell 7.
- On macOS and Linux the hooks should run (they are plain Node.js), but that is untested. Known
  differences: `detect-orphans.js` does nothing there, the guard's checks for Git Bash quirks apply
  on Windows only, `/drive-screen` is Windows only, and much of `gotchas.md` is Windows-specific.
- If your Claude Code setup has no `model` parameter on the Agent tool, remove the
  `model-routing-guard.js` entry: it would block every subagent call.

## Tests

From the repo folder (or `~/.claude` after installing):

```sh
for f in hooks/tests/*-fixtures.js; do node "$f" > /dev/null || echo "FAIL $f"; done
```

No output means every suite passed. The suites create sandbox folders next to themselves
(`hooks/tests/.fakehome*` and similar, all gitignored) and never touch your real `~/.claude`. Two
optional cases read it to test against real input (your saved workflows, your recent transcripts):
set `HARNESS_LIVE_TESTS=1`.

## Uninstall

1. Remove the entries you merged from `~/.claude/settings.json` (or restore `settings.json.bak`).
2. Restore `~/.claude/CLAUDE.md.bak`, or delete the sections you added.
3. Delete the files you copied: every path this repo has under `hooks/`, `agents/`, `tools/` and
   `output-styles/`, plus `gotchas.md` and the skills listed in step 4 of the install. Files of your
   own in those folders stay.

## License

MIT, see [LICENSE](LICENSE). `skills/debug` and `skills/drive-screen` are adapted from MIT projects;
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
