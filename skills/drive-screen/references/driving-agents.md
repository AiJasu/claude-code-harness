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
summary of the current task). Even with it, take the handle from `list` once and
target by `--id`.

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

Re-resolve the window before each step. Do not cache a handle across a long run
unless the title is genuinely unusable (see `--id` in `SKILL.md`).

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
