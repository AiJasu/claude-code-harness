#!/usr/bin/env python3
"""Live smoke test of the INPUT path: focus, type, paste, key, click, scroll, shot.

It opens its OWN window (a Tk text box titled SCREENCTL-SMOKE-<pid>), drives it
through screenctl.py exactly as an agent would, and verifies every primitive
deterministically by copying the widget's text back through the clipboard, not
by looking at pixels. It closes only the window it opened and restores the
clipboard it found.

It takes the keyboard and mouse for about fifteen seconds. Run it only when the
screen is yours to give; do not type or move the mouse while it runs. Without
--live it only prints what it would do and exits 2.

  python _smoke_windows.py --live

The action log goes to a temp folder (SCREENCTL_STATE_DIR) that is removed at the
end, so the real ~/.claude/screenctl/actions.log is left alone.

Exit 0 = every primitive verified. Exit 1 = a step failed; the report says which.
Exit 2 = not run (no --live).
"""

from __future__ import annotations

import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True      # keep __pycache__ out of the skill folder
HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))
import screenctl as sc          # noqa: E402

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", newline="\n")
    except Exception:
        pass

TITLE = f"SCREENCTL-SMOKE-{os.getpid()}"

# The child window. Tk's Text widget is a plain input box: typed punctuation
# arrives as typed (a rich editor would mangle it), Ctrl+C copies the selection
# and Ctrl+V pastes. Ctrl+A is bound to select-all, which Tk does not do by
# default.
CHILD = r"""
import sys, tkinter as tk
root = tk.Tk()
root.title(sys.argv[1])
root.geometry("640x400+120+120")
t = tk.Text(root, font=("Consolas", 14), undo=False)
t.pack(fill="both", expand=True)
def select_all(e):
    t.tag_add("sel", "1.0", "end-1c"); t.mark_set("insert", "end-1c"); return "break"
t.bind("<Control-a>", select_all)
t.focus_set()
root.mainloop()
"""

TYPED = "screenctl smoke typed 0123456789 test+^%~(){}[] end"
PASTED = ("line one\nline two: test+^%~(){}[] 123\nline three caf" + chr(0xE9)
          + " " + chr(0x2605) + " " + chr(0x1F680))

results: list[tuple[str, bool, str]] = []


def step(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  ' + detail) if detail else ''}")


def ctl(*args: str) -> subprocess.CompletedProcess:
    r = subprocess.run([sys.executable, str(HERE / "screenctl.py"), *args],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r


def widget_text(wid: str) -> str:
    """Select all, copy, read the clipboard: what the widget really holds."""
    ctl("key", "--id", wid, "--keys", "ctrl+a")
    time.sleep(0.15)
    ctl("key", "--id", wid, "--keys", "ctrl+c")
    time.sleep(0.25)
    return sc.norm(sc.get_clipboard())


PLAN = """This live test will, for about fifteen seconds:
  - open its own Tk window titled SCREENCTL-SMOKE-<pid>
  - take the keyboard and mouse: focus, type, paste, press keys, click and scroll in that window
  - overwrite the clipboard (a text clipboard is put back at the end)
  - write one screenshot to the temp folder and delete it
Do not type or move the mouse while it runs.
Re-run with --live to go ahead."""


def main() -> int:
    if "--live" not in sys.argv[1:]:
        print(PLAN)
        return 2
    state = tempfile.mkdtemp(prefix="screenctl-smoke-state-")
    os.environ["SCREENCTL_STATE_DIR"] = state       # inherited by every ctl() child
    sc.STATE_DIR, sc.LOG = state, os.path.join(state, "actions.log")
    try:
        return run_live()
    finally:
        shutil.rmtree(state, ignore_errors=True)


def run_live() -> int:
    saved, had = sc.clipboard_state()
    if saved is None and had:
        print("The clipboard holds something that is not text (an image, files).")
        print("This test overwrites the clipboard and cannot put that back.")
        try:
            answer = input("Type yes to continue and lose it, anything else to abort: ")
        except EOFError:
            answer = ""
        if answer.strip().lower() != "yes":
            print("aborted; copy some text to the clipboard first")
            return 1

    child = subprocess.Popen([sys.executable, "-c", CHILD, TITLE])
    wid = None
    try:
        for _ in range(60):
            hit = [w for w in sc.list_windows() if w.title == TITLE]
            if hit:
                wid = hit[0].id
                break
            time.sleep(0.25)
        step("child window appears in list", wid is not None, TITLE)
        if not wid:
            return 1
        time.sleep(0.6)

        r = ctl("focus", "--id", wid)
        step("focus by id", r.returncode == 0 and "FOCUS_OK" in r.stdout, r.stdout.strip()[:80])

        r = ctl("type", "--id", wid, "--text", TYPED)
        ok = r.returncode == 0 and f"TYPED {len(TYPED)} chars" in r.stdout
        step("type reports the full length", ok, r.stdout.strip()[:80])
        got = widget_text(wid)
        step("typed text arrived verbatim", got == TYPED, f"got {got!r}" if got != TYPED else "")

        shot = os.path.join(tempfile.gettempdir(), f"{TITLE}.png")
        r = ctl("shot", "--id", wid, "--out", shot, "--settle", "0.3")
        w, h = sc.png_size(shot) if os.path.exists(shot) else (0, 0)
        step("shot writes a real, non-blank PNG",
             r.returncode == 0 and w > 0 and not sc.looks_blank(shot) and "WARNING" not in r.stdout,
             f"{w}x{h} {shot}")
        # The printed scale must be the image width over the window width, on
        # whatever display scaling the machine runs.
        shot_win = sc.resolve("", wid)
        m = re.search(r"IMAGE_SCALE: ([0-9.]+)", r.stdout)
        want = f"{w / shot_win.w:.4f}" if shot_win.w else ""
        got_scale = m.group(1) if m else None
        step("shot reports IMAGE_SCALE = image width / window width",
             got_scale == want, f"printed {got_scale}, computed {want}")

        # Clear the box: select-all then Delete. The next check proves it
        # (the paste must equal the payload alone, not typed+pasted).
        ctl("key", "--id", wid, "--keys", "ctrl+a")
        r = ctl("key", "--id", wid, "--keys", "delete")
        step("key delete accepted", r.returncode == 0 and "SENT: delete" in r.stdout)

        r = ctl("paste", "--id", wid, "--text", PASTED)
        ok = r.returncode == 0 and "PASTED" in r.stdout and "CLIPBOARD_RESTORED" in r.stdout
        step("paste reports success and restores the clipboard", ok, r.stdout.strip()[:80])
        got = widget_text(wid)
        step("pasted multi-line non-ASCII text arrived verbatim (replacing the typed text)",
             got == sc.norm(PASTED), f"got {got!r}" if got != sc.norm(PASTED) else "")

        win = sc.resolve("", wid)
        r = ctl("click", "--id", wid, "--x", str(win.x + 40), "--y", str(win.y + 60))
        step("click inside the window is allowed", r.returncode == 0 and "CLICKED" in r.stdout,
             r.stdout.strip()[:80])
        # After a click near the top-left of the text, typing one character lands
        # somewhere inside line one, so the text grows by exactly that character.
        ctl("type", "--id", wid, "--text", "Z")
        got = widget_text(wid)
        step("click moved the caret: a typed character landed inside the text",
             len(got) == len(sc.norm(PASTED)) + 1 and "Z" in got and got != sc.norm(PASTED) + "Z",
             f"len {len(got)} vs {len(sc.norm(PASTED)) + 1}")

        r = ctl("click", "--id", wid, "--x", str(win.x - 50), "--y", str(win.y + 60))
        step("click outside the window is refused", r.returncode == 1 and "CLICK_OUTSIDE" in r.stdout,
             r.stdout.strip()[:60])

        r = ctl("scroll", "--id", wid, "--amount", "-2")
        step("scroll accepted", r.returncode == 0 and "SCROLLED" in r.stdout)

        r = ctl("type", "--id", wid, "--text", "a\nb")
        step("type refuses a newline", r.returncode == 1 and "NEWLINE_IN_TYPE" in r.stdout)

        r = ctl("key", "--id", wid, "--keys", "ctrl+nosuchkey")
        step("key refuses an unknown name", r.returncode == 1 and "BAD_KEY" in r.stdout)

        try:
            os.unlink(shot)
        except OSError:
            pass
    finally:
        child.terminate()
        try:
            child.wait(timeout=5)
        except Exception:
            child.kill()
        if saved is not None:
            sc.set_clipboard(saved)
            print("clipboard restored")
        elif not had:
            sc.set_clipboard("")

    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)} of {len(results)} steps passed")
    if failed:
        print("FAILED: " + "; ".join(failed))
        return 1
    print("SMOKE_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
