# Traps: full text

Each of these was hit live, and each fails quietly rather than loudly. SKILL.md carries
the one operative line per trap; the detail is here.

**1. The Bash tool rewrites arguments starting with `/`.** Under Git Bash,
sending `/exit` delivers `C:/Program Files/Git/exit`. Every slash command has
this shape, so `/compact`, `/context` and `/usage` are corrupted by default.
Prefix the send with `MSYS_NO_PATHCONV=1`, or send it from the PowerShell tool,
which does no such conversion. The tell is a character count that does not match
what you sent, which is why `type` and `paste` both report their length. This
applies to a `run --plan` too: the JSON is one command-line argument, and a
string inside it that starts with `/` is a path to MSYS unless the prefix is set
(or the plan comes from `--plan-file`). A JSON plan starting with `[` or `{`
usually arrives intact, but keep the prefix anyway: it guards against the other
MSYS triggers (or use `--plan-file` / the PowerShell tool).

**2. A nested agent session that writes no transcript.** A terminal spawned from
inside a Claude Code session inherits `CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE` and
`CLAUDE_CODE_ENTRYPOINT`. The child then either writes no transcript at all while
looking completely normal, so every readback silently returns nothing, or hangs at
startup with a rendered banner and no input box, which looks exactly like a broken
install. Clear all three before launching (both shell forms are in
`driving-agents.md`).

**3. Two driven sessions in one worktree collide.** Two of them edited the same
test file, one invalidating the other's baseline. Give each session its own
worktree, or make sure their tasks touch disjoint files.

**4. A fullscreen application can refuse to give up focus.** Windows may decline
a foreground request outright, and an app in exclusive fullscreen will hold it
against every attempt. `screenctl.py` tries a plain request, then a thread-attach
request, then one ALT tap, and then stops rather than typing into whatever is
actually in front. If the window in front is fullscreen-sized (a fullscreen
video, a presentation) it skips the two escalations entirely and refuses
with `FOCUS_FAILED`: the thread attach links input queues with that window's
thread and the ALT tap is an injected keystroke delivered to it. Never inject
input into a fullscreen app you did not open, and never work around this
refusal. The only fix is to close that app or put it in windowed mode. (Inside
`run` the focus variant has no ALT tap at all: plain request, then the thread
attach, then `FOCUS_FAILED`.)

**5. Do not bulk-select in a terminal tab list.** Clicking a tab puts focus on the
list, not the terminal, and a select-all followed by a delete there can destroy
every live session at once. Switch terminals with `ctrl+pageup`/`ctrl+pagedown`,
which never focuses the list. Sessions survive on disk either way and come back
with `claude --resume <uuid>`, but the terminals do not.

**6. `key --keys win` opens something this tool cannot close.** The Start menu is
a `CoreWindow`: it does not appear in `list`, so no action can target it, and
every action focuses a named window first, which is not how you dismiss it. The
machine is then stuck behind an open Start menu. There is almost never a reason
to press it - launch things with `start`, your editor's CLI launcher or `wt.exe`
instead.

**7. An always-on-top window is NOT in your screenshot but DOES take your clicks.**
The capture is the target's own surface, so an overlay (a topmost tool window)
never appears in it. `click` refuses with `CLICK_COVERED` when the
pixel belongs to another process; when that happens, use keys, or ask the user
to move the overlay. Never work around the refusal with a nearby coordinate.

**8. A minimized window renders nothing.** PrintWindow cannot draw a window that
is not laid out. `shot --no-focus` refuses with `MINIMIZED`; a plain `shot`
restores it first. An exclusive-fullscreen app is the same, and there `shot`
comes back flat and says so.

**9. Never pipe the tool's output into a first-line filter.** `| Select-Object
-First 1` or `| head -1` closes the tool's stdout after the first line and kills
it on its next print, AFTER the action was already sent: a `paste` can
deliver its payload, then die printing the success line, and the
caller reads the non-zero exit as a refusal and pastes again. Capture the
whole output into a variable or a file and read the tokens from that.

**10. A pasted slash command needs the command menu to settle before Enter.**
Pasting `/exit` (or any `/command`) into Claude Code opens its command menu;
an Enter about one second later hit the menu mid-filter, the session stayed
open, and the "exit" sent next became a prompt (the transcript shows the stray
letters glued to `exit`). Wait three seconds, or screenshot and see the highlighted entry,
before Enter; then confirm the session is gone (its `claude.exe` with the
session id disappears within a second) before typing anything else into that
terminal. And when the REPL exits, the terminal answers its teardown queries
with a few stray bytes that land in the shell's input line,
so a pasted `exit` can become `XXexit` and the window stayed open. Send `esc` to
clear the shell line before typing into it. In a plan this is enforced as
`SLASH_WAIT`: a `sleep` or `wait` `stable` of at least 3.0 s between the paste
and the Enter.

**11. A browser's own install or permission prompt can be a separate top-level
window.** It is untitled and owned by the main window, so `list` and a
main-window `shot` do not show it; `python ~/.claude/skills/drive-screen/scripts/shot-hwnd.py <hwnd> <out.png>`
renders one window by handle, and a click on it goes through the main window's
`--id` (same process, so `CLICK_COVERED` does not fire). `run` conditions (`uia`,
`ocr`, `window`) and `click_uia` act on the target's own tree and capture, so they
do NOT reach such a window.
