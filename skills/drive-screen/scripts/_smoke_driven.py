#!/usr/bin/env python3
"""One-command test of the driven-session loop.

Opens a titled Windows Terminal window in --repo, starts a Claude Code session in it
with the documented launch line (inherited env cleared, session id and model named,
manual permission mode), sends one prompt that needs a Write permission, lets
autodrive stop at that prompt, approves it ONCE after checking that the transcript
names exactly the expected file, waits for the turn through session_watch, verifies
the file, then closes the session and the window it opened and deletes the file.

It takes the keyboard for the whole run (a few minutes) and starts a billed session
with your real ~/.claude config (settings, hooks, CLAUDE.md, MCP servers all load),
so it needs an explicit handover and refuses to run without --yes-billed-session.
--repo must be a directory Claude Code already trusts (no trust dialog) and must not
carry an allow rule for Write, or no prompt appears and the autodrive half of the
loop is not exercised.

  python _smoke_driven.py --repo C:/Users/you/projects/scratch-repo --yes-billed-session [--model opus] [--keep]

Screenshots and the screenctl action log (SCREENCTL_STATE_DIR) go to a temp folder
that is removed on success and kept on failure or with --keep.

Exit 0 = every step verified. 3 = stopped for a human (the prompt on screen could not
be matched to the expected Write; nothing was approved). Any other non-zero = a step
failed or the run was refused; the report says which, and whatever was opened is
closed on the way out.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

sys.dont_write_bytecode = True      # keep __pycache__ out of the skill folder
HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))
import screenctl as sc          # noqa: E402
import session_watch as sw      # noqa: E402

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", newline="\n")
    except Exception:
        pass

TITLE = f"DRIVE-SMOKE-{os.getpid()}"
FILE = "drive-test.txt"
LINE = "drive-test-ok"
PROMPT = (f"Create a file named {FILE} in this directory containing the single line: {LINE}. "
          "Use the Write tool. Do nothing else and do not run any commands.")

results: list[tuple[str, bool, str]] = []


def step(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  ' + detail) if detail else ''}", flush=True)
    return ok


def run(script: str, *args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    return subprocess.run([sys.executable, str(HERE / script), *args], capture_output=True,
                          text=True, encoding="utf-8", errors="replace", env=env)


def first(r: subprocess.CompletedProcess) -> str:
    text = (r.stdout or r.stderr).strip()
    return text.splitlines()[0][:110] if text else ""


def window_id(title: str) -> str | None:
    for w in sc.list_windows():
        if w.title.startswith(title):
            return w.id
    return None


def transcript(repo: str, sid: str):
    """The session's transcript path, or None while it does not exist yet."""
    sw.PIN = sid
    try:
        return sw.latest(repo)
    except SystemExit:
        return None


def driven_process_count(sid: str) -> int:
    r = subprocess.run(
        ["pwsh", "-NoProfile", "-Command",
         "(Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | "
         f"Where-Object {{ $_.CommandLine -like '*{sid}*' }} | Measure-Object).Count"],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    try:
        return int((r.stdout or "").strip())
    except ValueError:
        return -1               # unknown reads as alive, never as gone


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Live test of the driven-session loop. Takes the keyboard for a few "
                    "minutes and starts a BILLED Claude Code session that loads your real "
                    "~/.claude config (settings, hooks, CLAUDE.md, MCP servers).")
    ap.add_argument("--repo", required=True, help="trusted throwaway directory for the session")
    ap.add_argument("--model", default="opus")
    ap.add_argument("--keep", action="store_true",
                    help="leave the created file and the screenshot folder in place")
    ap.add_argument("--yes-billed-session", action="store_true",
                    help="required: confirms you accept a billed session with your real config")
    a = ap.parse_args()
    if not a.yes_billed_session:
        print("This test opens a Windows Terminal window, takes the keyboard for a few minutes,")
        print("and starts a billed Claude Code session with your real ~/.claude config")
        print("(settings, hooks, CLAUDE.md, MCP servers). It writes and deletes one file in --repo.")
        print("Re-run with --yes-billed-session to go ahead.")
        return 2
    repo = os.path.abspath(a.repo)
    if not os.path.isdir(repo):
        print(f"NO_REPO: {repo}")
        return 2

    shots = os.path.join(tempfile.gettempdir(), TITLE)
    os.makedirs(shots, exist_ok=True)
    state = os.path.join(shots, "screenctl-state")
    os.environ["SCREENCTL_STATE_DIR"] = state       # inherited by every run() child
    sc.STATE_DIR, sc.LOG = state, os.path.join(state, "actions.log")
    code = run_live(a, repo, shots)
    if code == 0 and not a.keep:
        shutil.rmtree(shots, ignore_errors=True)
    else:
        print(f"screenshots and action log kept in {shots}")
    return code


def run_live(a: argparse.Namespace, repo: str, shots: str) -> int:
    sid = str(uuid.uuid4())
    target = os.path.join(repo, FILE)
    wid = None
    print(f"session {sid} in {repo}; screenshots in {shots}", flush=True)

    try:
        # 1. a terminal window with a title this script owns
        subprocess.Popen(["wt.exe", "-w", "new", "--title", TITLE,
                          "--suppressApplicationTitle", "-d", repo])
        for _ in range(40):
            time.sleep(0.5)
            if wid := window_id(TITLE):
                break
        if not step("terminal window appears in list", wid is not None, TITLE):
            return 2
        time.sleep(2.0)                                   # shell prompt renders

        # 2. the documented launch line (PowerShell profile)
        launch = ("$env:CLAUDECODE=$null; $env:CLAUDE_CODE_ENTRYPOINT=$null; "
                  "$env:CLAUDE_CODE_CHILD_SESSION=$null; "
                  f"claude --session-id {sid} --model {a.model} --permission-mode manual")
        r = run("screenctl.py", "paste", "--id", wid, "--text", launch)
        if not step("launch line pasted", r.returncode == 0 and "PASTED" in r.stdout, first(r)):
            return 2
        r = run("screenctl.py", "key", "--id", wid, "--keys", "enter")
        if not step("launch submitted", r.returncode == 0, first(r)):
            return 2

        # 3. the session is up when a capture of the window is not flat; the
        #    transcript does not exist until the first prompt, so it is no signal
        up = False
        launched = os.path.join(shots, "launched.png")
        for _ in range(20):
            time.sleep(1.5)
            r = run("screenctl.py", "shot", "--id", wid, "--no-focus", "--out", launched)
            if r.returncode == 0 and "WARNING" not in r.stdout:
                up = True
                break
        step("session window renders after launch", up, launched)
        step("no transcript before the first prompt (observed behavior)",
             transcript(repo, sid) is None)
        time.sleep(6.0)                                   # banner, hooks, input box

        # 4. one prompt, submitted separately from its paste
        r = run("screenctl.py", "paste", "--id", wid, "--text", PROMPT)
        if not step("prompt pasted", r.returncode == 0 and "PASTED" in r.stdout, first(r)):
            return 2
        run("screenctl.py", "shot", "--id", wid, "--out", os.path.join(shots, "before-submit.png"),
            "--settle", "0.3")
        r = run("screenctl.py", "key", "--id", wid, "--keys", "enter")
        if not step("prompt submitted", r.returncode == 0, first(r)):
            return 2
        path = None
        for _ in range(30):
            time.sleep(1.0)
            if path := transcript(repo, sid):
                break
        if not step("transcript appears after the first prompt", path is not None):
            return 2

        # 5. autodrive must stop at the permission prompt, not answer it
        r = run("autodrive.py", "--id", wid, "--repo", repo, "--session", sid, "--dry-run",
                "--idle", "12", "--poll", "2", "--timeout", "180", "--shot-dir", shots)
        stopped = r.returncode == 3 and "Screenshot:" in r.stdout
        step("autodrive --dry-run stops for a human at the prompt", stopped,
             f"exit {r.returncode}: {first(r)}")
        if not stopped:
            return 2

        # 6. approve ONCE, and only because the transcript names exactly the file
        #    this script asked for. A missing or different hint is a stop, not a
        #    guess: the screenshot is in `shots` for a human to read.
        pending = sw.pending_tool_details(sw.records(path))
        expected = [p for p in pending if p[0] == "Write" and p[1].lower().endswith(FILE)]
        if not step("transcript hint names the expected Write", bool(expected),
                    str(pending)[:120]):
            print(f"Not approving an unmatched prompt. Read {shots} and answer it yourself.")
            return 3
        r = run("screenctl.py", "key", "--id", wid, "--keys", "enter")
        step("approved once with Enter", r.returncode == 0, first(r))

        # 7. the turn closes, and the transcript says what happened
        r = run("session_watch.py", "wait", "--repo", repo, "--session", sid,
                "--idle", "12", "--poll", "2", "--timeout", "180")
        step("session_watch wait sees the turn complete",
             r.returncode == 0 and "TURN_COMPLETE" in r.stdout, first(r))
        r = run("session_watch.py", "reads", "--repo", repo, "--session", sid)
        step("reads shows the one Write", r.returncode == 0 and FILE in r.stdout
             and r.stdout.count("\n") <= 2, r.stdout.strip()[:100])
        r = run("session_watch.py", "last", "--repo", repo, "--session", sid)
        step("last returns the final message", r.returncode == 0 and FILE in r.stdout)

        # 8. the file the driven agent was asked for
        content = open(target, encoding="utf-8").read().strip() if os.path.exists(target) else None
        step("file exists with the requested line", content == LINE, repr(content))
    finally:
        if wid and window_id(TITLE):
            # A pasted slash command opens the command menu, and an Enter that
            # arrives before the menu has settled hits the wrong thing: measured
            # live, Enter about one second after pasting "/exit" left the session
            # running and a later "exit" was submitted as a prompt. Three seconds
            # of settle worked every time.
            run("screenctl.py", "paste", "--id", wid, "--text", "/exit")
            time.sleep(3.0)
            run("screenctl.py", "key", "--id", wid, "--keys", "enter")
            alive = True
            for _ in range(30):
                time.sleep(1.0)
                if driven_process_count(sid) == 0:
                    alive = False
                    break
            if alive:
                # Never type into a session that did not exit: "exit" would be a
                # prompt. Leave the window for a human, with a picture of it.
                left = os.path.join(shots, "still-alive.png")
                run("screenctl.py", "shot", "--id", wid, "--no-focus", "--out", left)
                step("session exited and the window closed", False,
                     f"the session is still running; window left open, see {left}")
            else:
                # When the REPL exits, the terminal answers its teardown queries
                # with a few bytes that land in the shell's input line (a couple of stray
                # characters), so a pasted "exit" could become "XXexit". Let them
                # arrive, clear the line with Escape (PSReadLine RevertLine),
                # then type.
                time.sleep(1.5)
                run("screenctl.py", "key", "--id", wid, "--keys", "esc")
                run("screenctl.py", "paste", "--id", wid, "--text", "exit")
                time.sleep(1.0)
                run("screenctl.py", "key", "--id", wid, "--keys", "enter")
                for _ in range(20):
                    time.sleep(0.5)
                    if not window_id(TITLE):
                        break
                step("session exited and the window closed", not window_id(TITLE))
        if not a.keep and os.path.exists(target):
            os.unlink(target)
            step("created file deleted", not os.path.exists(target))

    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)} of {len(results)} steps passed")
    if failed:
        print("FAILED: " + "; ".join(failed))
        return 1
    print("SMOKE_DRIVEN_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
