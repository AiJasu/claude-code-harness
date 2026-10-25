# Driving a real coding-agent session

How to start Claude Code sessions on Windows and steer them from outside,
plus the setup the primitives depend on. Read this with `SKILL.md`, which holds
the hard rules and the primitive reference. Everything below assumes Windows 10/11 with
Windows Terminal (default profile: PowerShell 7) and an editor or IDE such as
VS Code; `tmux` is not used.

- [First run](#first-run)
- [Choosing the surface](#choosing-the-surface)
- [Opening the editor on the right folder](#opening-the-editor-on-the-right-folder)
- [Starting a session](#starting-a-session)
- [Sending a prompt](#sending-a-prompt)
- [Waiting, and answering prompts](#waiting-and-answering-prompts)
- [session_watch.py in detail](#session_watchpy-in-detail)
- [autodrive.py in detail](#autodrivepy-in-detail)
- [Auditing what the agent actually did](#auditing-what-the-agent-actually-did)
- [Several sessions at once](#several-sessions-at-once)
- [Cleaning up](#cleaning-up)

---

## First run

```bash
python ~/.claude/skills/drive-screen/scripts/screenctl.py doctor
```

Without `--out` this touches nothing. Add `--out <file>` only after the user
has handed over the screen: the capture probe renders whatever window is in
front at that moment, which they did not name, and the file is theirs to keep
private.

Nothing to install: Python 3.x and the Win32 API are the whole dependency. Two
things the script handles that hand-written attempts usually do not:

- **DPI awareness is declared before anything is measured.** A DPI-unaware process
  is handed virtualized coordinates on a scaled display, so window rectangles,
  captures and cursor positions all quietly disagree with the real screen. At 100%
  scaling nothing changes, which is why this bug survives on a 100% primary
  monitor and breaks on a scaled one.
- **Input goes through SendInput, not SendKeys.** SendKeys is documented as
  "susceptible to timing issues" and treats `+ ^ % ~ ( ) { } [ ]` as control
  characters, so a missed escape silently sends a chord instead of text.

And two this build adds: captures are renders of the window's own surface (never
a screen grab, which would copy whatever is in front), and the clipboard is read
and written through the Win32 API in-process, so non-ASCII text round-trips
exactly and an image on the clipboard is detected rather than overwritten.

---

## Choosing the surface

**Headless, when the session does not need to be seen.** This should be the
default for driving an agent whose output you will read from a file anyway:

```bash
claude -p "Refactor the auth module" --model opus      # one turn, prints the result
```

A background job or the Agent tool covers a whole task. No focus, no keystrokes,
no screenshots, and the human keeps the machine.

**A dedicated Windows Terminal window,** when it must be visible and you want a
title you control exactly. This sidesteps IDE title collisions entirely:

```bash
wt.exe -w new --title "DEMO-1" --suppressApplicationTitle -d "C:/Users/you/projects/myapp"
```

Without `--suppressApplicationTitle` the title is overridden by whatever the
running program sets, and Claude Code sets it repeatedly (its own name, then a
summary of the current task). Even with it, the app may rename the window: target
by `--id` from a fresh `list` (re-list after any window close).

**The editor's terminal panel,** when the session must be visible as a real
working session. Several sessions stay visible at once and the window title is
stable enough to target. This is the highest-friction option and the one the
traps in `SKILL.md` are mostly about.

---

## Opening the editor on the right folder

```bash
code "C:/Users/you/projects/myapp"     # VS Code; other editors ship their own CLI launcher
```

Only some editors put a launcher on PATH; confirm the executable with
`Get-Command` before writing a step that depends on it.

Whether that opens a new window or reuses one is an editor setting; if the
editor asks, that dialog is the first thing to screenshot. Wait several seconds,
then confirm the window exists with `screenctl.py list` before targeting it.

**Editor titles carry the project name and the open file**, often joined by a
dash that may be non-ASCII, and the file part changes with every tab switch.
Target the project name alone and make it long enough to be unique:
`myapp`, never `my`. Confirm the exact shape with `list` on the day.

Targeting rule (as in `SKILL.md`): list, then a unique title; `--id` from a fresh
list when the title is ambiguous or the app renames itself (re-list after any window
close). A single `run` is different: it resolves its target once and holds that
handle for its own few seconds (at most 30 steps, under the printed cap), checking
before every step that the window still exists.

---

## Starting a session

Every command below spells the full path and the literal window title. Shell
variables do not survive between tool calls, so a
recipe that sets `S=` or `T=` in one call and uses it in the next runs with
empty strings and fails in confusing ways, or worse, quietly does something
else.

```bash
python ~/.claude/skills/drive-screen/scripts/screenctl.py key  --title "myapp" --keys ctrl+backtick   # VS Code: toggle the terminal panel (check your editor's keymap)
python ~/.claude/skills/drive-screen/scripts/screenctl.py shot --title "myapp" --out "$CLAUDE_JOB_DIR/tmp/t1.png"   # confirm it opened and has focus
```

A toggle-terminal shortcut usually focuses a terminal that is already open rather
than creating a new one; a new terminal is a separate shortcut or the `+` in the
panel's header (VS Code: `ctrl+shift+backtick`). Screenshot to see which
happened. Spell punctuation as a word: `backtick`, `minus`, `equals`, `comma`,
`period`, `slash`, `semicolon`.

Then launch, clearing the inherited environment (trap 2 in `SKILL.md`), **naming
the model**, and **assigning the session ID up front** rather than discovering it
afterwards. Generate the UUID in its own call and copy it LITERALLY into every
later command where `<UUID>` appears:

```bash
python -c "import uuid; print(uuid.uuid4())"
```

The default terminal is PowerShell, so the pasted line is PowerShell. From the
Bash tool, `\$` keeps the dollar signs literal inside double quotes; from the
PowerShell tool, put the whole `--text` value in single quotes instead.

```bash
python ~/.claude/skills/drive-screen/scripts/screenctl.py paste --title "myapp" --text "\$env:CLAUDECODE=\$null; \$env:CLAUDE_CODE_ENTRYPOINT=\$null; \$env:CLAUDE_CODE_CHILD_SESSION=\$null; claude --session-id <UUID> --model opus --permission-mode manual"
python ~/.claude/skills/drive-screen/scripts/screenctl.py shot  --title "myapp" --out "$CLAUDE_JOB_DIR/tmp/before-enter.png"    # read it
python ~/.claude/skills/drive-screen/scripts/screenctl.py key   --title "myapp" --keys enter
```

For a Git Bash terminal the pasted line is
`env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_CHILD_SESSION claude --session-id <UUID> --model opus --permission-mode manual`.

**Why `--model`:** a driven session inherits your settings.json default, which
may be a costlier tier than routine work needs. Name the model on the command
line, every launch, the same way every Agent call names it.

**Why the UUID up front:** knowing it before the session exists removes a whole
class of fragility. Listing the sessions directory before and after launch and
diffing it picks the wrong session whenever the baseline is empty or another
session writes at the same moment. Pass it to every `session_watch.py` and
`autodrive.py` call as `--session`. Both refuse an EMPTY `--session` with
`NO_SESSION` rather than falling back to the newest transcript, so an unset
variable fails loudly instead of watching the wrong session.

Then confirm the session is up with a screenshot, not with the transcript: on
the version tested the transcript file is created when the FIRST PROMPT is submitted,
not at launch (nothing on disk for a long while after a clean start, the file appeared
within a second of the first Enter). A screenshot showing the
banner and the input box is the launch check; `session_watch.py dir` is the
check after the first prompt:

```bash
python ~/.claude/skills/drive-screen/scripts/screenctl.py shot --title "myapp" --out "$CLAUDE_JOB_DIR/tmp/launched.png"
```

A brand-new project may show a workspace-trust dialog first, and any MCP servers
it declares are approved separately from that. Expect up to two prompts before
the first turn. A directory that never gets a transcript after the first prompt
means the terminal's working directory is not what you assumed: screenshot and
look.

The driven session runs your installed hooks: the guard hook blocks
catastrophic commands and secret exfiltration, the model-routing guard checks its
Agent calls, the reply lint runs on its replies. Nothing about being driven turns
those off, and nothing about driving should try to.

---

## Sending a prompt

Always paste, and keep submission separate:

```bash
python ~/.claude/skills/drive-screen/scripts/screenctl.py paste --title "myapp" --file "C:/Users/you/projects/myapp/prompts/round-1.md"
python ~/.claude/skills/drive-screen/scripts/screenctl.py shot  --title "myapp" --out "$CLAUDE_JOB_DIR/tmp/before-submit.png"   # read it, then:
python ~/.claude/skills/drive-screen/scripts/screenctl.py key   --title "myapp" --keys enter
```

Reading `before-submit.png` before pressing Enter is what stops a mangled or
half-pasted prompt from being submitted and quietly ruining a round. After the
first Enter, `session_watch.py dir --repo ... --session <UUID>` succeeds within
a second; that is the moment to take the `mark` baseline.

A slash command (`/compact`, `/exit`) sent from the Bash tool arrives as
`C:/Program Files/Git/compact` unless the call is prefixed `MSYS_NO_PATHCONV=1`;
the PowerShell tool needs no prefix. The reported character count is the tell.

---

## Waiting, and answering prompts

```bash
python ~/.claude/skills/drive-screen/scripts/session_watch.py mark --repo "C:/Users/you/projects/myapp" --session <UUID>                 # baseline
python ~/.claude/skills/drive-screen/scripts/session_watch.py wait --repo "C:/Users/you/projects/myapp" --session <UUID> --timeout 540   # blocks
```

Never estimate with a sleep. Turns run from seconds to many minutes, and a sleep
that is too short means the next keystrokes land mid-turn. `wait` has a natural
exit (the turn closes, or it times out), so it belongs in a foreground call with
a timeout at least as long as `--timeout`; anything longer than the tool's ten
minutes runs in the background and is polled through its log.

`wait` exits 2 when it finds the transcript quiet with the turn still open. That
is a permission prompt, a slow command, or thinking. Screenshot it, read which
command it is actually asking about, and only then answer.

**Answer with Enter, on the highlighted option.** Permission prompts are an
arrow-key selection confirmed with Enter, with Escape to decline.

Be deliberate about the "don't ask again" option, because it is not one thing. For
a Bash command it writes a permanent rule into the repository's local settings
file. For a file edit it lasts only until the session ends. Granting the first kind
unattended widens permissions past the end of the task.

---

## session_watch.py in detail

```bash
python ~/.claude/skills/drive-screen/scripts/session_watch.py <cmd> --repo <path-of-the-driven-session>
```

| Command | Returns |
|---|---|
| `dir` | Resolved transcript directory, newest file, subagent transcript count |
| `sessions` | Every session UUID in this project |
| `mark` | Record count and completed-turn count: the baseline to diff against |
| `wait` | Blocks until the turn genuinely ends, then prints the final message |
| `last` | The final message of the last completed turn, verbatim. Mid-turn narration is not persisted to the transcript (measured on the version tested), so during a turn this shows the previous turn's report or the turn's opening line |
| `reads --match X` | Every file the agent touched, filtered. Add `--all` for subagents |

`wait` exits 0 when the turn closes, 1 on timeout (the agent is probably still
working: screenshot, never send keys) and 2 when it goes quiet with the turn
still open. Exit 2 prints one of two tokens. `RUNNING` means a tool call is
still executing: a long command, or a dead process. Do not send keys; wait
again or screenshot. `BLOCKED` means the turn is open and nothing is executing,
which is what a waiting permission prompt looks like from the transcript, or
thinking.

The transcript cannot tell you which. Records are flushed asynchronously and the
flush lags the conversation. Upstream watched a live prompt twice on the same
version and got two different transcripts: once an unanswered tool_use naming the
exact command, once nothing at all, with the tool_use appearing only after
approval. On the version tested the pending Write WAS in the transcript while its
prompt sat on screen, so the hint is often available; it is still a hint about
what is being asked, never proof of what state the session is in. Screenshot
before answering anything.

A completed turn is not a finished task. If the driven agent dispatched a
subagent, it can close the turn while that work is still running. `wait` has
returned a completed turn whose entire content was "Explore agent is running,
I'll report back", with the actual answer two turns later. Read the final message
before acting on it; if it describes work in progress, call `wait` again.

`reads` audits a driven agent instead of trusting it. For a memory or recall
demo, `--match CLAUDE.md` settles whether the agent answered from context or
quietly re-read the file; if it re-read it, the round is void. Pass `--all`
whenever the agent might have used a subagent: subagents write separate
transcripts, and the parent's shows only that a Task was dispatched.

## autodrive.py in detail

```bash
python ~/.claude/skills/drive-screen/scripts/autodrive.py --id <hwnd> --repo <path> [--dry-run]
```

Answers the driven session's own permission prompts so a long turn can run while
nobody is watching. It answers prompts inside that session's terminal UI, and
cannot answer an operating-system dialog. Start with `--dry-run` on any new task:
it reports the first prompt and the exact command behind it, then stops without
sending anything. Three things make it safe enough to leave alone:

- **It stops for a human by default and screenshots what it stopped on** (into
  `~/.claude/screenctl/prompts/`, without taking focus unless the window is
  minimized). This is the protection; everything below is secondary.
- **It presses Enter, never a digit.** Enter takes the highlighted option, which
  is approve-once. The digit variant means stop asking, and for a Bash command
  that writes a permanent rule into the repository's settings file.
- **It refuses a list of commands** and hands back with the command printed:
  recursive deletes, force pushes, hard resets, `sudo`, piping the network into a
  shell, publishing, formatting, killing processes, destructive SQL, firewall or
  sshd changes, and Windows service, registry and scheduled-task writes. If the
  driven session runs a guard hook, the catastrophic subset is blocked before a
  prompt ever appears.

Do not rely on that refuse list. A pending permission prompt is usually not in
the transcript yet. Upstream measured this against a real `rm -rf` prompt sitting
on screen: 36 records, two completed `ls` calls, and no record of the command
being asked about; approving it took the file to 44 records and the `rm -rf`
appeared then. The command is generally written only after it is approved; across
six live prompts in one session it was readable for three of them. It is a race,
not a rule. So the refuse list is a second line that often cannot see the thing it
is filtering, and `autodrive` without `--approve-blind` will mostly just stop,
because the tool call it wants to read is not there: the safe outcome, and why the
screenshot exists.

`--approve-blind` is the flag that actually runs a turn unattended, and it is
exactly what it says: Enter on whatever is on screen, unread. Only for a task whose
worst case you have already accepted, in a throwaway worktree, with `--shot-dir` so
there is a record of what was approved. Under auto mode it also needs the user's own
message naming `--approve-blind` for this run (the classifier's Create Unsafe Agents
rule covers an agent loop with its approval gate disabled), and it is never used on
a driven session running in auto mode: there the prompts that reach the screen are
the classifier's escalations (ask rules, safety checks, the denial-limit fallback),
the last thing to approve unread.

It also stops if an approval produces no new transcript records, because a
keystroke that is not landing never starts landing by being repeated. Exit 0 is a
completed turn; 1 is a timeout with the agent still working (screenshot, do not
send keys); 2 is approvals not reaching the session, the prompt not being
photographable, or the approval cap; 3 is a deliberate stop for a human, including
a missing target or an empty `--session`. `python ~/.claude/skills/drive-screen/scripts/_test_autodrive.py` checks the
refuse list and the pending-call detection; run it after editing either.

---

## Auditing what the agent actually did

This is the reason to prefer transcripts over screenshots.

```bash
python ~/.claude/skills/drive-screen/scripts/session_watch.py reads --repo "C:/Users/you/projects/myapp" --session <UUID> --since <MARK> --match "CLAUDE.md"
python ~/.claude/skills/drive-screen/scripts/session_watch.py reads --repo "C:/Users/you/projects/myapp" --session <UUID> --all       # include subagents
```

For any recall or memory demo, the honest question is whether the agent answered
from context or re-read the source. `reads` settles it. If the file was read during
the answering turn, the round is void: say so and re-run rather than keeping a
result someone watching could take apart.

Pass `--all` whenever the driven session might have dispatched subagents. Their
work lands in a `subagents/` subdirectory, not in the parent transcript, so without
it a large part of what happened is simply invisible.

Two things to know about the transcript itself. Its format is explicitly internal
and can change in any release, so treat a missing field as a version difference
rather than a failure. And `/compact` keeps the same session and the same file,
condensing it in place; it is `/branch` and `--fork-session` that create a new one.

---

## Several sessions at once

Terminals inside one IDE window are not separately targetable by title, so
switching between them means clicking a tab, and tab positions shift as terminals
come and go. Prefer separate Windows Terminal windows with distinct titles whenever
sessions must be driven independently. Title targeting is deterministic; a click
at a remembered coordinate is not.

Each session writes its own transcript in the same project directory. Track them by
the UUID you assigned at launch, not by assuming the newest file is the one you
care about, and pass it as `--session <uuid>` everywhere. Give each its own
worktree (trap 3 in `SKILL.md`).

---

## Cleaning up

Leave the machine usable. Close only the terminals and windows you opened, restore
whatever was focused at the start, and tell the user the blackout is over and what
state things are in. If you left something running on purpose, say so and say why.

To close a session you started: paste `/exit`, wait three seconds for the command
menu to settle (trap 10 in `SKILL.md`), Enter, then confirm its process is gone
before pasting `exit` into the shell to close the window:

```bash
pwsh -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Where-Object { \$_.CommandLine -like '*<UUID>*' } | Measure-Object).Count"
```

A count that is not zero means `/exit` did not land; screenshot and look, never
type `exit` into a running session (it is submitted as a prompt). Once it is
zero, send `esc` to the terminal first: the REPL's teardown leaves stray bytes
in the shell's input line, and `exit` pasted behind them is not a command.
