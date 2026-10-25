# When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Text landed in the wrong place | Focus stolen mid-run | Screenshot, send `esc`, re-focus, retry. Do not blind-send more keys |
| `AMBIGUOUS` | Title matches several windows | Longer title, or `--id`. Two windows of one app often share a title exactly, and then only `--id` can separate them |
| `FOCUS_FAILED` | Another app holds the foreground | Retry once; if the message names a fullscreen window (a video, a presentation), nothing was tried against it: ask the user to close it or window it |
| `FOCUS_LOST_MIDSEND` | Focus moved while a long `type` was still going out | The message says how many characters landed. Screenshot before retrying: re-sending the whole string duplicates the part that arrived. Prefer `paste` |
| `FOCUS_LOST` | Focus moved between the focus check and the paste chord | Nothing was pasted and the clipboard was restored. Retry |
| `INPUT_BLOCKED` | Windows refused the input: the target runs elevated (as administrator) and the driver does not, or BlockInput is active | The message says what was delivered. Run the driver elevated, or drive an unelevated window |
| `CURSOR_MOVE_FAILED` | The pointer did not land on the requested point (off the virtual screen, or pinned) | Nothing was clicked. Recompute the point from a fresh `shot` |
| `CLIPBOARD_MISMATCH` | Clipboard rewritten under us | Retry. Nothing was pasted. A clipboard manager or sync tool is the usual cause |
| `CLIPBOARD_BUSY` | Another app holds the clipboard open | Retry in a moment. Nothing was pasted |
| `CLIPBOARD_PREVIOUS_NOT_TEXT` | The user's clipboard held an image or files | The paste went ahead; their clipboard now holds the payload. Tell them |
| Garbled typed text | `type` used for special characters | Use `paste` |
| `CLICK_OUTSIDE` | Coordinates not inside the window | Re-read `WINDOW_ORIGIN` and `IMAGE_SCALE` from the last `shot` and redo the arithmetic |
| `CLICK_COVERED` | Another process's window sits on that pixel | Use keys, or have the user move the overlay. It is not in the screenshot by design |
| Clicks land consistently offset | Image scale ignored | Use `IMAGE_SCALE` from the `shot` output |
| Capture WARNING: one flat color | The window did not render (fullscreen, minimized, protected) | Do not read the image. Restore or window the app, re-shot |
| `MINIMIZED` | `--no-focus` on a minimized window | Drop `--no-focus`, or `focus` it first |
| `INTERNAL_ERROR` | The tool itself crashed (rare; a retry usually succeeds) | Anything printed above it did happen; nothing after it was sent. The traceback is in `~/.claude/screenctl/actions.log` (or under `SCREENCTL_STATE_DIR`). Retry once, then report that log line |
| `wait` returns 2 with `RUNNING` | A tool call is still executing | Not a prompt. Wait again or screenshot; do not send keys |
| `wait` returns 2 with `BLOCKED` | Turn open, nothing executing | What a permission prompt looks like. Screenshot, read the command, answer deliberately |
| `wait` returns 1 | Timeout, or no transcript for the session | The agent is probably still working. Screenshot before concluding anything |
| `NO_SESSION` | `--session` arrived empty (an unset shell variable) | Pass the UUID literally; shell variables do not persist between tool calls here |
| `NO_SESSION_DIR` | Session never started, or started elsewhere | Check the terminal's working directory |

To recover a text box in an unknown state: `esc` to dismiss dialogs, then `ctrl+a`
and `delete`. Blind backspaces are a last resort and have made things worse.

## Tokens printed by `run`

A `run` prints the existing token of any refusal inside a step (the rows above), then
`RUN_STOPPED`. Tokens new with `run`:

| Token | Meaning | Fix |
|---|---|---|
| `PLAN_INVALID: step n: <REASON>: ...` | Validation failed before anything ran (`step -` for whole-plan problems). Nothing was focused, sent or captured. Reasons: `BAD_JSON`, `BAD_FILE` (plan or `paste_file` unreadable), `BAD_STEP` (wrong type or value for the action), `UNKNOWN_KEY`, `BAD_KEY`, `BAD_TIMEOUT` (over 30 s, or a `stable` timeout shorter than its seconds), `BAD_REGION`, `BAD_CONDITION`, `EMPTY_TEXT`, `NEWLINE_IN_TYPE`, `CONTROL_IN_TYPE`, `STALE_CLICK`, `ENTER_UNVERIFIED`, `SLASH_WAIT`, `RUN_TOO_LONG`, `OCR_UNAVAILABLE`, `NO_TARGET` (a step other than a `window`/`window_gone` wait or `sleep` in a run with no `--title`/`--id`), `TOO_MANY_STEPS` (over 30), `BAD_PLAN` (not a non-empty JSON array) | Fix the plan named in the reason and re-run |
| `NO_PLAN` | `run` got neither or both of `--plan` and `--plan-file` (exit 1, a plain refusal, not `PLAN_INVALID`) | Pass exactly one of `--plan` / `--plan-file` |
| `UNKNOWN_KEY`, `BAD_KEY` | A step has a key outside its allowed set, or a `key` chord the key table does not know. Single characters are keys only as `a-z`, `0-9` or the OEM punctuation keys `- . / , ; = [ ] \ '` and `` ` `` (or the words `backtick`, `minus`, `equals`, `comma`, `period`, `slash`, `semicolon`); `_ { } < +` alone, non-ASCII and empty parts (`ctrl+`) are `BAD_KEY` | Check the step table in SKILL.md; spell the key as a word |
| `CONTROL_IN_TYPE` | `type` text (CLI or plan) holds a control character other than TAB, or U+007F. Nothing was sent; typed as Unicode input such a character can arrive as Escape, Backspace or Enter | Use `key` for those, or `paste` |
| `ENTER_UNVERIFIED` | `key enter` (or a chord holding `enter`, `ctrl+m`, `ctrl+j`, `ctrl+o`) after text (`type`/`paste`/`paste_file`, or a `key` chord that types) with no `uia`/`ocr` read-back of the payload: an expect ON the text step or a `wait` after it (an expect on a step in between does not count). A chord holding a printable key and Enter is refused outright. The look-back skips non-text sending steps (`key` without Enter, `scroll`, `click_uia`, a coordinate `click`) | Add the read-back, or split the Enter into a separate run after a screenshot Read |
| `SLASH_WAIT` | Text whose joined adjacent text steps start with `/` (typed, pasted or keyed) with no 3.0 s `sleep` or `stable` wait before the Enter (trap 10) | Add the wait |
| `STALE_CLICK` | A coordinate `click` after any step other than `focus` or `shot` with `no_focus` | Move the click to the start of the plan, or use `click_uia`, or split into two runs |
| `RUN_TOO_LONG` | The computed whole-run cap is over 100 s | Split the plan |
| `EXPECT_ALREADY_TRUE` | A `title`/`uia`/`ocr` expect, or a `uia`/`ocr` `wait` that serves as the read-back of a payload before Enter, was true before the step's send; nothing was sent for that step | The plan would prove nothing: pick an expect that is false before the action |
| `EXPECT_UNPROVABLE` | The UI Automation tree was cut short before the step, so "not there yet" cannot be trusted (the expect could pass on text already on screen). Nothing was sent for that step | Use an `ocr` expect, a `title` expect, or a smaller target |
| `RUN_FAILED step=..` | The expect or wait timed out. `FAIL_SHOT` shows the window. A `STEP n/m SENT` line before it means the failed step's own action WAS sent (`EXPECT_ALREADY_TRUE` and `EXPECT_UNPROVABLE` mean it was not) | Read the shot. Steps before this one WERE sent: continue from here after a fresh look, never re-run the whole plan, and do not repeat a SENT step |
| `RUN_STOPPED step=..` | A refusal or an internal error inside a step | As the token above it says; then the same continue-from-here rule |
| `RUN_STOPPED DEADLINE step=..` | The next step's own cost (timeout, sleep, typing time, 1.5 s per sending step, settle + 0.5 s per focusing shot) would pass the printed `cap`; that step was NOT sent. A fail shot and `NOT_RUN` follow | Take a fresh look, then run the rest as a new plan. Set the Bash timeout to the printed cap + 30 s (cap from `--dry-run`, or 130000 ms), which covers one blocked OCR or UI Automation call |
| `UIA_NOT_FOUND` | `click_uia`: no enabled, on-screen element has that exact name (and `control`). Nothing was clicked | Coordinate `click` after a `shot`, or keys |
| `UIA_UNAVAILABLE` | UI Automation could not be created or read for this window. Nothing was clicked | Coordinate `click` after a `shot`, or keys |
| `NO_SUCH_ID` | The target handle vanished before a step (the window closed) | Re-resolve with `list` in a new call |
| `AMBIGUOUS` + `CANDIDATE:` lines | `click_uia` or a `window` condition matched 2+ elements/windows | Pass `control`, a longer name, or a more specific title |
| `UIA_TRUNCATED` | The UI Automation tree was larger than the node or time bound; `click_uia` refuses to click on a partial tree | Use a coordinate `click` after a shot, or keys |
| `CLICK_UIA_MISMATCH` | The element under the pointer is not the matched element | Something moved or covers it: shot, then decide |
| `REGION_OUTSIDE` | A `--region` or plan `region` is not fully inside the window | Recompute from `WINDOW_ORIGIN` / the window size |
| `BUSY: a run (pid N) is sending input` | A `run` (even a target-less one) holds `run.lock` in `~/.claude/screenctl/` (or `SCREENCTL_STATE_DIR`); `doctor`, `focus`, `type`, `paste`, `key`, `click`, `scroll` and a focusing `shot` refuse it too | Wait for it; never run two in parallel. A lock whose pid is dead is removed automatically, so is any lock older than 600 s; an empty lock younger than 2 s counts as held |
