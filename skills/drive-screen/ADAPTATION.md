# Adaptation notes

Source: coleam00/skills `.claude/skills/drive-screen` (MIT). This is the attribution for the
upstream work; this copy is adapted for Windows 10/11 with Python 3.x (Windows Terminal, PowerShell
7 as the default profile). Everything below is a deliberate difference from upstream, with the
reason. Upstream license: MIT, Copyright (c) 2026 Cole Medin; full text in
THIRD_PARTY_NOTICES.md at the repo root. Upstream behavior that was kept is not listed.

## Dropped
- macOS and Linux/X11 backends. Keeping them would have forced blind edits to code that was never
  exercised (their JXA separator was a non-ASCII control character, which the ASCII rule forbids).

## Capture (screenctl.py)
- `shot` renders the window's own surface with `PrintWindow(PW_RENDERFULLCONTENT)` into a DIB
  section, downscales with `StretchBlt` HALFTONE, and encodes the PNG in pure Python. Upstream
  used PowerShell 5.1 `Graphics.CopyFromScreen` of the window rectangle, which copies whatever is
  in front of the target (a covered window yields another app's private content). Side effects: no
  PowerShell start per shot, a background window can be captured without focus (`--no-focus`), an
  off-screen part renders, and an overlay on top of the target is NOT in the image.
- Because overlays are invisible, `click` asks `WindowFromPoint` / `GetAncestor(GA_ROOT)` which
  process owns the pixel, twice (before and after the pointer provably arrived), and refuses with
  `CLICK_COVERED` for another process or for no window at all. Same-process popups (menus,
  dialogs) pass. Upstream's answer was "notice the overlay in the image".
- `looks_blank` decodes real pixels and counts colors. Upstream sampled raw bytes, which only
  fired on grays once the PNG had four channels.
- `GdiFlush` before reading DIB bits (CreateDIBSection remarks).

## Clipboard
- Read and written through the Win32 clipboard API in-process. Upstream shelled out to
  `powershell.exe` (5.1) twice per paste, with a temp file to dodge console-encoding mojibake.
- A non-text clipboard (image, files) is detected: `doctor` skips its round trip instead of
  destroying it, `paste` warns `CLIPBOARD_PREVIOUS_NOT_TEXT`. An empty clipboard is restored to
  empty (upstream left the payload behind).
- `paste` proves the target window BEFORE writing the clipboard and restores it in a `finally`,
  so a refusal after the write (mismatch, focus lost, input blocked) never leaves the payload on
  the user's clipboard. Upstream restored only on the success path.
- Line endings go out as CRLF (Windows convention). Upstream had the same effect by accident: its
  payload went through a Python text-mode file, which writes CRLF on Windows. Kept deliberately;
  the success line says so.

## Focus and input
- `SW_RESTORE` only when the window is minimized. Upstream restored unconditionally, which
  un-maximizes a maximized window on every action.
- Foreground escalation: plain request, then `AttachThreadInput` to the foreground and target
  threads (AutoHotkey's method, no visible side effect), then upstream's ALT tap last: a bare ALT
  toggles the menu bar in Explorer and many classic apps.
- Fullscreen gate: when the window in front is fullscreen-sized (its rectangle equals its
  monitor's), the thread attach and the ALT tap are not attempted and `focus` refuses. Both would
  deliver input to the fullscreen app in front (a video, a presentation, a game) instead of the
  target; a refusal costs nothing. Maximized windows and the desktop do not match the shape.
- `SendInput`'s return value is checked. Input to an elevated window is silently dropped by UIPI
  while the focus check still passes; upstream printed `TYPED N chars` for keystrokes that never
  arrived. Now `INPUT_BLOCKED`, with how much was delivered.
- Mouse goes through `SendInput` too (`mouse_event` is superseded and returns nothing), and the
  pointer position is read back before a button goes down (`CURSOR_MOVE_FAILED`).
- `list` hides DWM-cloaked windows (suspended UWP apps, other virtual desktops): they carry real
  titles and made honest titles AMBIGUOUS and focus attempts FOCUS_FAILED for windows nobody can
  see. `list --all` shows them; `--id` resolves them either way.

## session_watch.py
- Both `turn_duration` and `stop_hook_summary` mark a turn end, collapsed so a turn counts once.
- An empty `--session` (an unset shell variable) is refused (`NO_SESSION`) instead of silently
  following the newest transcript.
- Documented: mid-turn narration text is not persisted by the version tested; only the first and
  the final text of a turn are. `last` is the last completed turn's report.

## autodrive.py
- Prompt screenshots use `--no-focus` (fallback to a focusing shot only on `MINIMIZED`), so a
  `--dry-run` on an unattended machine does not pull the foreground.
- Refuse list: `format` matched `npm run format` (now needs a drive letter); `curl | tee | bash`
  bypassed the pipe rule (now any later pipe stage); an unfiltered `DELETE FROM` was laundered by
  a `WHERE` in a later statement (lookahead stops at `;` or a quote); `kill` matched
  `build:kill-port` (now a command token). A read-only search as the whole command
  (`grep -rn "rm -rf" src/`) is not refused. Added: ufw/sshd, Windows service, registry and
  scheduled-task writes.
- Prompt screenshots default to `~/.claude/screenctl/prompts/`; the action log is
  `~/.claude/screenctl/actions.log` (upstream: `~/.screenctl`, and a folder inside the skill).
  `SCREENCTL_STATE_DIR` moves both; the smoke tests point it at a temp folder.
- An uncaught exception fails as `INTERNAL_ERROR` with the traceback appended to the action log,
  and actions targeted by `--id` log the resolved window title instead of `None`.

## Docs
- Rewritten for Windows: `wt.exe` instead of tmux, headless `claude -p` as the no-screen route,
  the PowerShell form of the env-clearing launch line, explicit `--model` on every driven session,
  literal paths and a literal UUID instead of shell variables (shell state does not persist between
  tool calls), monitor layout with negative x, editor title shape.
- Corrected from upstream: the `wait` exit-2 troubleshooting row said the opposite of the code
  (RUNNING = a tool executing is NOT a prompt; BLOCKED is); exit 1 documented for both tools;
  `doctor --out` captures the current foreground window, so it is not a no-handover action.

## Tests
- `_test_screenctl.py`: PNG encoder round trip, click-guard geometry, turn-end collapsing, ASCII
  invariant over every source and doc, no screen-region capture, no PowerShell subprocess.
- `_test_autodrive.py`: the false positives and bypasses above, plus the Windows additions.
- `_smoke_windows.py --live` (new): live input-path test in a Tk window it opens itself, verified
  through the clipboard, not pixels. Without `--live` it prints its plan and exits 2.
- `_smoke_driven.py --repo <trusted dir> --yes-billed-session` (new): the driven-session loop as
  one command, in a billed session with the real `~/.claude` config; it refuses without the flag. It
  approves the one prompt only when the transcript names the exact Write it asked for; otherwise
  it stops with the screenshot for a human (exit 3). It taught traps 9 and 10 in SKILL.md (Enter
  too soon after a pasted slash command; stray terminal bytes in the shell line after the REPL
  exits, so `esc` before `exit`). It takes the keyboard, so run it only with an explicit handover.

## Verified
Offline suites green; `doctor` green (DPI awareness, clipboard round trip with non-ASCII restored,
cloaked windows filtered); no-focus captures of a DirectX terminal, a browser window and a native
app all non-blank; `find` refusals (NOT_FOUND, AMBIGUOUS, MINIMIZED); `session_watch`
dir/mark/last/reads/wait against real transcripts; `--id` on a cloaked handle; empty `--session`
guards.

Driven session, run on a throwaway trusted directory: `wt.exe -w new --title DRIVE-TEST
--suppressApplicationTitle` opened the window; the PowerShell launch line (env cleared,
`--session-id`, an explicit `--model`, `--permission-mode manual`) started the session with the
input box ready; the prompt asked for one `Write`; `autodrive --dry-run --idle 12` stopped with
exit 3 at the permission prompt, with a no-focus screenshot and the transcript hint naming the
Write; one `key enter` approved it; `session_watch wait` returned TURN_COMPLETE with the final
message; `last`, `reads` and `mark` agreed; `/exit` then `exit` closed the session and the window.
Findings folded into the docs: the transcript file is created at the first prompt, not at launch;
the pending tool_use was visible before approval on that version; piping the tool's output into a
first-line filter kills it after the action was sent (SKILL.md trap 9).

Input path: `_smoke_windows.py` passed every step. The plain SetForegroundWindow request was
refused and focus landed through the AttachThreadInput escalation, without reaching the ALT tap;
typed punctuation and a pasted multi-line non-ASCII payload both arrived verbatim in a plain Tk
text box; the click guard allowed the inside point and refused the outside one; the user's text
clipboard was restored.

## Run plans, UI Automation and OCR

Goal: less wall clock and fewer model turns per task, with every hard rule, trap and safety
check kept. Deliberate changes:

- `run` (new): a validated plan of up to 30 steps in one call, each sending step
  focus-verified as before, with `title`/`uia`/`ocr`/`window`/`changed` expects and waits.
  Reason: most of a task's span is model time, and each input action used to cost a call, a
  screenshot and a turn; one call and one result replace them. Whole-plan validation refuses
  Enter (or ctrl+m / ctrl+j / ctrl+o) after text nobody read back (`ENTER_UNVERIFIED`; a typing
  `key` chord counts as text), a slash command sent without a wait (`SLASH_WAIT`), an expect or
  read-back wait already true before its send (`EXPECT_ALREADY_TRUE`) or unprovable on a
  cut-short UIA tree (`EXPECT_UNPROVABLE`); the printed cap is an enforced deadline
  (`RUN_STOPPED DEADLINE`), funded step by step; a run lock (`BUSY`) stops two senders at once.
  Inside `run` focus never uses the ALT tap (it is an injected keystroke that goes to whatever
  window is in front), and a step's `expect` replaces `key`'s fixed 0.3 s post-send wait.
- Input hardening, CLI and plan alike: a single-character key name is only `a-z`, `0-9` or a
  named OEM punctuation key (an unmapped character could otherwise land on an unrelated virtual
  key such as Sleep or the Windows key); `type` refuses control characters (`CONTROL_IN_TYPE`);
  `scroll` gets the covered-point check `click` has.
- `uia.py` / `ocr.py` (new): read-only UI Automation and Windows OCR through ctypes, imported
  lazily by `run` only, so no new package. `click_uia` clicks by exact element name, refuses on
  ambiguity or truncation, and checks the element under the point (`hit_test`) before pressing.
  UIA uses `CLSID_CUIAutomation8` so the IUIAutomation2 timeouts are really in force (the old
  class silently ignored them); every UIA/OCR call is bounded by its step's time left.
- Focus: escalate to the thread attach at once when the plain foreground request is refused,
  identity poll every 15 ms, 0.15 s floor, so a typical switch returns in a fraction of the old
  fixed wait.
- `shot --region`: crop before the downscale (`REGION_OUTSIDE` if not inside the window), so
  dense content is readable without paying for a bigger image.
- Start-up trims and zlib level 1 for the PNG: faster `list` and PNG encode.
- SKILL.md split: the operative line of every rule and trap stays in SKILL.md; detail moved to
  references/ (rules.md, traps.md, troubleshooting.md, screenctl-notes.md).
- `_smoke_windows.py --at X,Y`: place the live test window at a chosen screen position.
- Kept unchanged on purpose: PrintWindow capture, the owning-process click check, `shot`'s fixed
  1.0 s settle (a stable-frame early exit can capture before a slow dialog opens), `paste`'s
  0.1/0.6 s, `type`'s 12 ms per character, `click`'s 0.12 s pointer settle, the fullscreen
  refusal (screenctl cannot tell which fullscreen app is in front or whether it tolerates
  injected input).
- Not done: a local vision model, an MCP server, a long-lived helper process.
