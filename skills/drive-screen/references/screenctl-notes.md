# screenctl notes

Long-form behind the SKILL.md tables: input evidence, window arranging, coordinate math,
capture, and the detail of `run`.

## Scripts

All in `~/.claude/skills/drive-screen/scripts/`.

| Script | Purpose |
|---|---|
| `screenctl.py` | Window discovery, focus, typing, pasting, keys, clicks, scrolling, screenshots, `run` plans |
| `uia.py`, `ocr.py` | Read-only UI Automation and Windows OCR, imported lazily by `run` only |
| `session_watch.py` | Reads a driven Claude Code session's transcript: is it done, what did it say, what did it touch |
| `autodrive.py` | Runs a driven session to the end of a turn, answering its permission prompts and stopping on anything that needs a human |
| `shot-hwnd.py` | Trap 11 helper: render one window's own surface to a PNG by handle |
| `_test_screenctl.py`, `_test_autodrive.py`, `_test_winsurfaces.py` | Offline tests, no screen needed (`_test_winsurfaces.py` makes its own tiny non-activating window). Run after editing anything |
| `_smoke_windows.py --live [--at X,Y]` | Live test of the input path in a window it opens itself. Takes the keyboard for ~15 s; without `--live` it only prints what it would do |
| `_smoke_driven.py --repo <trusted throwaway dir> --yes-billed-session` | Live test of the whole driven-session loop: launch, prompt, autodrive stop, one approval, wait, verify, close. Takes the keyboard for a few minutes and starts a billed session that loads your real `~/.claude` config; refuses to run without the flag |

Run the offline `_test_*.py` after editing anything; the two smoke tests are handover only.

## paste versus type

Use `paste`, not `type`, for anything that must arrive verbatim. Pasting is one
atomic operation; typing is a stream of synthetic keystrokes that a busy
application can drop or reorder. `paste` proves the target window first, then
borrows the clipboard and puts back what was there on every exit path, success
or refusal. If the clipboard held an image or files it says
`CLIPBOARD_PREVIOUS_NOT_TEXT` and cannot put that back; warn the user. Line
endings go out as CRLF, the Windows clipboard convention; terminals fold both
forms to Enter and the success line says so.

That is not theoretical. Upstream typed `test+^%~(){}[] 123` into Windows 11
Notepad and got `test+^%~(333333333` on one run and no brackets at all on
another, while the same string typed into a terminal arrived perfectly, and
pasting it into Notepad arrived perfectly. Terminals and plain input boxes take
typed input fine. Rich editors with a formatting layer mangle it, differently
each time. Paste into anything that is not a terminal.

A long `type` is not atomic, and the tool says so. Focus is confirmed before
every character. If focus moves mid-string the send stops with
`FOCUS_LOST_MIDSEND` and reports how many characters actually landed, instead of
reporting success for keystrokes that went somewhere else. Typing costs about
15ms per character, so 500 characters is eight seconds against under a second for
a `paste` of any length. Use `paste`.

`type` and `paste` never press Enter. Sending text and submitting it are
separate steps so you can screenshot in between and confirm the right thing is
about to be submitted. This prevents most mis-submits. In a `run` plan the same
holds, and the tool enforces it as `ENTER_UNVERIFIED` (see below).

## Targeting by id

An application can rename its own window mid-run: a terminal launched as
`DRIVE-TEST` became `claude` the moment a session started in it, then
`Claude Code`, then the session's own summary of what it was doing. The rule:
list, then a unique title; `--id` from a fresh list when the title is ambiguous or
the app renames itself (re-list after any window close). Handles do not survive the
window closing. A `run` resolves the target once to a handle and re-checks it exists
before every step.

## Arranging windows

There is no `move` action, and arranging windows is a keyboard job. Nothing here
resizes or repositions a window directly, by design: dragging is the least reliable
thing a screen driver can do. Use the window manager instead, in this order, because
it is two steps and the order matters.

| Goal | Send | Note |
|---|---|---|
| Put a window on another monitor | `win+shift+left` / `win+shift+right` | Moves it, and RESTORES its unsnapped size. Do this first |
| Snap it within that monitor | `win+left` / `win+right` | Half the screen. `win+up` maximizes |

Snapping first and moving second undoes the snap, which is why the order is
written down. Confirm the layout with `list`: a monitor to the left of the primary
has negative x, and a scaled display reports physical pixels while `shot` prints a
scale under 1. Negative coordinates are normal, not an error.

## Screenshot coordinates

`shot` captures the window, so the image origin is the window's top-left corner,
and the image is usually scaled. Every `shot` prints `WINDOW_ORIGIN` and
`IMAGE_SCALE` and the arithmetic to convert. Do the arithmetic. A scaled display
makes the image a different size from the screen, and ignoring that puts every
click in the wrong place by a consistent, confusing margin.

Screenshots are downscaled to 1280px wide by default, which keeps each look cheap
(a native-resolution image costs several times as much). For dense content - small
text, a dense diagram - pass a larger `--max-width`, or crop with
`--region x,y,w,h` (window-relative physical pixels, cropped BEFORE the downscale):
`IMAGE_SCALE = image_width / region_w`, `WINDOW_ORIGIN = window origin + (x, y)`, a
`REGION: x,y,w,h of the window` line is printed, and a region not fully inside the
window is refused `REGION_OUTSIDE`. The printed click arithmetic stays right; `click`
still checks the whole window rectangle (`CLICK_OUTSIDE`).

## Capture: the window's own surface

A screenshot is rendered through PrintWindow, not copied off the screen, so a
background window can be read with `--no-focus`, an off-screen or covered window
still renders, and nothing that is NOT that window ever ends up in the image (a
screen-region grab would copy whatever is in front, which can leak another app's
private content). The flip side: an overlay floating on top of the target is not in
the picture. `click` handles that by asking the OS which process owns the pixel it is
about to hit and refusing with `CLICK_COVERED` if it is not the target's (checked
twice, before and after the pointer is placed). A minimized or exclusive-fullscreen
window renders nothing; `shot` prints a WARNING that the capture is one flat color,
and that image must not be reasoned about.

## run: detail

Target and ordering:
- The target is resolved once (`NOT_FOUND` / `AMBIGUOUS` as for any command). Before
  every step the handle is checked with `IsWindow`; gone = `NO_SUCH_ID` + `RUN_STOPPED`.
- Before anything runs the whole plan is validated (PLAN_INVALID sends nothing): step
  count (30), key sets and types of every field, newline or `\r` in `type`, empty
  strings (`type` and `paste` text refuse only the empty string; names, paths and
  condition text are also stripped), a control character other than TAB or U+007F in
  `type` (`CONTROL_IN_TYPE`), `sleep` over 3.0, `timeout` over 30 (`BAD_TIMEOUT`), every
  `key` chord parsed with the same table as `send_chord` (single characters: `a-z`,
  `0-9` and the named OEM punctuation keys only; anything else, and any part that is
  not ASCII (checked before lower-casing, so the Kelvin sign is not a `k`), is `BAD_KEY`),
  `paste_file` read once (missing or not UTF-8 is invalid, and
  the content read then is what gets pasted), an `expect` on a `wait`, `sleep` or `shot`
  step (a `focus` step may carry one), a
  coordinate `click` after anything but `focus` or a `no_focus` shot (`STALE_CLICK`),
  `ENTER_UNVERIFIED`, `SLASH_WAIT`, `ocr` where OCR is unavailable, and the whole-run
  cap (over 100 s is `RUN_TOO_LONG`). One cost function per step feeds both the printed
  cap and the deadline check: expect or wait timeout, a `sleep`, `type` length x 0.012 s,
  1.5 s for a `focus` or sending step, and for a `shot` its settle (a maximum) + 0.5 s
  of capture (1.0 s with `no_focus`); plus the pre-send look of a step with a
  `title`/`uia`/`ocr` expect or a read-back `wait` (its timeout, + 0.3 s for UI Automation;
  OCR max(0.5, T) + 0.25 s) and a `click_uia`'s find + hit_test; and for a `uia`/`ocr`
  expect or wait, the poll's last read (each read inside a poll gets only the poll's time
  left, so it overruns by at most 0.6 s for UI Automation, 0.75 s for OCR).
- The printed `cap` IS the run deadline. Before each step, if elapsed time plus that
  step's own cost would pass the cap (0.05 s of timer slack aside), the run stops with
  `RUN_STOPPED DEADLINE` and that step is not sent; a plan of focusing shots that each
  take settle + 0.4 s is never stopped while within its printed cap. UI Automation and
  OCR calls get `timeout_s = min(step timeout, time left)`. A single blocked call can
  overrun that bound, so give the Bash call the cap + 30 s: read the cap from `--dry-run`
  (same RUN line), or set the Bash timeout to 130000 ms.
- `ENTER_UNVERIFIED`: a `key` chord that is or contains `enter` (or `ctrl+m`/`ctrl+j`,
  which are Enter in a terminal, and `ctrl+o`, bash readline's accept-line), whose nearest earlier TEXT step is `type`/`paste`/`paste_file`, is
  invalid unless that step has an `expect` of kind `uia` or `ocr` whose text is a
  non-empty substring of the payload. A `key` chord whose parts include a printable key
  (`a-z`, `0-9`, an OEM punctuation key, space) and no ctrl/alt/win types, so it is TEXT
  (with shift its characters are unknown and still need the read-back); a chord holding
  both a printable key and Enter is itself `ENTER_UNVERIFIED`. The look-back skips the
  other non-text sending steps (`key` without Enter, `scroll`, `click_uia`, a coordinate
  `click`) and stops only at a verified point: a `uia`/`ocr` expect ON the text step, or a
  `uia`/`ocr` `wait` after it, whose text is part of the payload. An expect on a step
  between the text and the Enter does not count (it is checked after the text landed, so
  it could only fail). A read-back `wait` is checked BEFORE the text step sends, like an
  `expect` (already true = `EXPECT_ALREADY_TRUE`, a cut-short UIA tree =
  `EXPECT_UNPROVABLE`, nothing sent). `SLASH_WAIT`: when the joined text of the adjacent
  text steps starts with `/` (typed, pasted or keyed; an unknown first character from a
  shift chord counts as a possible `/`), a `sleep` or `wait` `stable` of at least 3.0 s
  must sit between it and the Enter (trap 10).
- Each sending step: focus (inside `run` without the ALT tap: plain request, then the
  thread attach unless the foreground is fullscreen, then `FOCUS_FAILED`), the
  `title`/`uia`/`ocr` expect is evaluated once (already true = `EXPECT_ALREADY_TRUE`,
  nothing sent), the act runs through the same code and checks as the CLI subcommand,
  then the expect polls every 100 ms (OCR every 300 ms) until true or its timeout. The
  only post-action delay an `expect` replaces is `key`'s 0.3 s; `type`'s 0.25 s,
  `paste`'s 0.1/0.6 s and `click`'s timings stay.
- A sending step is never retried; no key outside the plan is ever pressed. A
  `SystemExit` or other exception inside a step is caught (`INTERNAL_ERROR: type: msg`,
  traceback in `actions.log`), `finally` paths such as the clipboard restore still run,
  then `RUN_STOPPED`, the fail shot and `NOT_RUN`.
- The fail shot is a `--no-focus` style capture of the window's own content (never a
  screen grab, never re-focuses after a focus failure; skipped with a note when the
  window is minimized). Default path `<state dir>/run/fail-<pid>.png`; the state dir is
  `~/.claude/screenctl/` unless `SCREENCTL_STATE_DIR` is set.
- A run (a target-less one too) holds `<state dir>/run.lock` (its pid) for its
  whole life; `doctor`, `focus`, `type`, `paste`, `key`, `click`, `scroll` and a focusing
  `shot`, CLI or `run`, refuse with `BUSY` while that pid is alive. Read-only
  subcommands (`list`, `find`, `shot --no-focus`) ignore it. A lock is stale, and removed,
  when its pid is dead or it is older than 600 s; an EMPTY lock younger than 2 s counts
  as held (retry up to 2 s, then `BUSY`). Eviction is atomic: the suspect lock is renamed
  to a name only the evicting process owns, judged there, and removed only if still stale
  (one process wins a given stale file; a live one is renamed back and reported `BUSY`).
  Never background a run or overlap it with another screenctl call.
- `stable N` defaults to a timeout of N + 3 s (a `timeout` below N is `BAD_TIMEOUT`);
  every other condition defaults to 3 s; the maximum is 30 s. `scroll` (CLI and plan)
  runs the same before-and-after covered-pixel check as `click`. A coordinate `click`
  step in a run prints no re-screenshot advice. A plan `shot` step prints the same lines
  as the CLI `shot` (`SHOT`, `WINDOW_ORIGIN`, `IMAGE_SCALE` and the click arithmetic):
  use them for a later coordinate click.
- `EXPECT_UNPROVABLE`: when the UI Automation read for the pre-send check was cut short,
  the step fails before sending, because "not there yet" cannot be trusted.

Conditions:
- `window` compares against a snapshot of window handles taken at run start: it matches
  only handles absent from it (a window new since run start; 2+ new matches is
  `AMBIGUOUS`). `window_gone` checks every visible window, old or new: it passes when no
  title contains the text.
  They can resolve without a target (a target-less run holds only `window`/`window_gone`
  waits and `sleep`; it resolves nothing, sends nothing, captures nothing).
- `changed`: baseline capture is taken after the step's focus and immediately before its
  send; every 8th pixel in x and y is sampled; true when more than `min_fraction`
  (default 0.005) differ. `stable`: two samplings 100 ms apart identical, held for the
  requested seconds. `region` for `ocr`/`changed`/`stable` is the same window-relative
  x,y,w,h as `--region`. Only `title`, `uia`, `ocr`, `window` are evidence of state.
- `uia` is read-only: no UI Automation pattern is invoked (no Invoke, no SetValue, no
  SetFocus). An element flagged IsPassword prints `<password>`, never its value. The tree
  is bounded (3000 nodes, 2 s default); large windows (browsers, Electron) are unmeasured
  and may truncate. MSAA-proxied edit controls take their Name from the preceding label,
  so pass `control` to `click_uia`.
- `click_uia` order: focus, fresh find after focus, refuse on truncation
  (`UIA_TRUNCATED`), 0 matches fails, 2+ is `AMBIGUOUS` (up to 10 `CANDIDATE: <control>
  "<name>" rect=l,t,r,b` lines), `contains`, covered check, place the pointer, covered
  check again, then a hit-test that the element under the point is the match or a
  descendant (else `CLICK_UIA_MISMATCH`), then press. Names match exactly
  (case-insensitive, trimmed, `&` accelerator marks stripped); offscreen, disabled and
  empty-rectangle elements are skipped.
- `ocr`: Windows.Media.Ocr through ctypes (no PowerShell), in the
  user-profile OCR language (en-US as a last resort). It reads the target's own full-resolution capture. Where no OCR engine or language
  exists, `ocr` is `PLAN_INVALID`.
- Trap 11 popups (a browser's own prompt as a separate top-level window owned by the
  main window) are not part of the target's tree or capture: `shot-hwnd.py` by handle
  remains the route.

Output shapes (stable first tokens, so a caller can match on them):

    RUN: 3 steps, target <list line>, cap 10.0 s
    STEP 2/3 OK key ctrl+t (0.30 s) | FOCUS_OK: <title> | SENT: ctrl+t | expect title "New Tab" ok (0.10 s)
    RUN_OK 3 steps in 2.00 s
    STEP 3/3 SENT type | FOCUS_OK: <title> | TYPED 20 chars (no Enter sent)   (the action went out)
    RUN_FAILED step=3/3 action=type expect=uia: <reason>
    FAIL_SHOT: <path>  <w>x<h>      (then the shot's WINDOW_ORIGIN / IMAGE_SCALE lines)
    NOT_RUN: steps 4-5              (or NOT_RUN: none)
    RUN_STOPPED DEADLINE step=4/5   (the step was not sent; fail shot and NOT_RUN follow)

After `RUN_FAILED`, a `STEP n/m SENT` line means the failed step's own action WAS sent;
`EXPECT_ALREADY_TRUE` and `EXPECT_UNPROVABLE` mean it was not. After the fresh look, do
not repeat a SENT step.

Two-run patterns: (1) launch an app and run the target-less wait in ONE command
(`start X && MSYS_NO_PATHCONV=1 python ~/.claude/skills/drive-screen/scripts/screenctl.py run --plan '[{"wait":{"window":"<title>"},"timeout":20}]'`)
so the window is created after the run's start snapshot; a window that appeared between
two tool calls is in the snapshot and never matches. The run prints `WINDOW: <list
line>`; target the printed handle in the next run. On a timeout, `list` once and take
the handle before relaunching anything. (2) For a dialog that is its own top-level
window, end the first run with a `window` expect and target the printed handle in the
second.

Examples of valid steps: `{"click":[850,730],"double":true}`,
`{"shot":"C:/x/a.png","no_focus":true,"region":[0,0,800,200]}`,
`{"type":"hello","expect":{"uia":"hello"}}`,
`{"wait":{"changed":true,"min_fraction":0.02},"timeout":5}`.

Quoting: Git Bash wants single quotes around the JSON plus `MSYS_NO_PATHCONV=1`; a
payload holding a single quote goes through `--plan-file` (written with the Write tool).
The prefix is kept as a guard: a JSON plan starting with `[` arrived intact in the
tested shape, but the prefix guards against other MSYS triggers and bare-slash arguments.
Delays outside `run` that stay as they were (no live evidence to shorten them): `paste`
0.1 s and 0.6 s (the target reads the clipboard asynchronously), `type` 12 ms per
character, `click` 0.12 s pointer settle, `shot` 1.0 s settle after focusing.
