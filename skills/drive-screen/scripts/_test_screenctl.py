#!/usr/bin/env python3
"""Tests that need no screen, no focus, and no permission grants.

These cover the parts that decide correctness without touching the desktop:
PNG encoding and introspection, the coordinate arithmetic that turns a
screenshot pixel into a click, the click-guard geometry, transcript
interpretation on synthetic records, the key tables, and two source-level
invariants this build enforces (ASCII-only sources, no screen-region capture).
With HARNESS_LIVE_TESTS=1 it also replays the transcript checks over your 40
newest real transcripts under ~/.claude/projects; a plain run reads nothing
outside this repo.

  python _test_screenctl.py

For the input path (focus, type, paste, key, click) run _smoke_windows.py --live: it
takes the keyboard for about fifteen seconds, so it is a separate, deliberate run.
"""

from __future__ import annotations

import os
import pathlib
import struct
import sys
import tempfile
import zlib

sys.dont_write_bytecode = True      # keep __pycache__ out of the skill folder
HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))
import screenctl as sc          # noqa: E402
import session_watch as sw      # noqa: E402

FAILURES: list[str] = []
CHECKS = 0


def check(name: str, got, want) -> None:
    global CHECKS
    CHECKS += 1
    if got != want:
        FAILURES.append(f"{name}: got {got!r}, wanted {want!r}")


def truthy(name: str, got) -> None:
    global CHECKS
    CHECKS += 1
    if not got:
        FAILURES.append(f"{name}: expected truthy, got {got!r}")


# --------------------------------------------------------------------------
# PNG: introspection of a foreign PNG, and our own encoder
# --------------------------------------------------------------------------

def make_png(path: str, w: int, h: int, solid: bool) -> None:
    """Write a real RGB PNG the way a third-party tool might: one flat color, or noisy rows."""
    rows = bytearray()
    for y in range(h):
        rows.append(0)                                   # filter byte
        for x in range(w):
            v = 128 if solid else (x * 7 + y * 13) % 251
            rows += bytes((v, (v * 3) % 256, (v * 5) % 256))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(bytes(rows), 6)))
        f.write(chunk(b"IEND", b""))


_tmpdir = tempfile.TemporaryDirectory()
tmp = _tmpdir.name
solid, noisy = f"{tmp}/solid.png", f"{tmp}/noisy.png"
make_png(solid, 200, 120, solid=True)
make_png(noisy, 200, 120, solid=False)

check("png_size reads IHDR", sc.png_size(solid), (200, 120))
check("png_size on a non-PNG", sc.png_size(__file__), (0, 0))

# A capture that comes back as a wall of one color is a window that did not
# render. It has to fire on a flat image and must not fire on a real screen, or
# it either misses the failure or cries wolf every shot.
check("blank detector fires on a flat RGB image", sc.looks_blank(solid), True)
check("blank detector ignores real content", sc.looks_blank(noisy), False)
check("blank detector survives a non-PNG", sc.looks_blank(__file__), False)

# Our own encoder: BGRA in, RGBA PNG out, channels swapped, alpha forced opaque.
# A 3x2 image with distinct pixels proves the swap and the row layout; a solid
# one proves the blank detector works on what `shot` actually writes (upstream's
# byte-sampling heuristic only fired on grays once the PNG had four channels).
px = [(1, 2, 3, 0), (10, 20, 30, 0), (100, 110, 120, 7),
      (200, 201, 202, 0), (0, 0, 0, 0), (255, 254, 253, 1)]
bgra = b"".join(bytes(p) for p in px)
png = sc.encode_png_bgra(3, 2, bgra)
ours = f"{tmp}/ours.png"
open(ours, "wb").write(png)
check("our PNG reports its size", sc.png_size(ours), (3, 2))
# Decode it back by hand: IDAT is the third chunk (IHDR, IDAT, IEND).
pos = 8 + 12 + 13
n = struct.unpack(">I", png[pos:pos + 4])[0]
raw = zlib.decompress(png[pos + 8:pos + 8 + n])
check("row 0 is filter 0 then RGBA pixels",
      raw[:13], bytes([0, 3, 2, 1, 255, 30, 20, 10, 255, 120, 110, 100, 255]))
check("row 1 follows with its own filter byte",
      raw[13:26], bytes([0, 202, 201, 200, 255, 0, 0, 0, 255, 253, 254, 255, 255]))
check("our 6-color image is not blank", sc.looks_blank(ours), False)

flat = f"{tmp}/flat.png"
open(flat, "wb").write(sc.encode_png_bgra(64, 48, bytes((40, 30, 20, 0)) * (64 * 48)))
check("our flat RGBA capture reads as blank", sc.looks_blank(flat), True)

try:
    sc.encode_png_bgra(4, 4, b"\x00" * 10)
    FAILURES.append("encoder accepted a short buffer")
except ValueError:
    pass
CHECKS += 1


# --------------------------------------------------------------------------
# Coordinate arithmetic: the mapping a caller performs from `shot` output
# --------------------------------------------------------------------------

def to_screen(origin: int, px: float, scale: float) -> int:
    return round(origin + px / scale)


# A window on the primary monitor, captured at native size.
check("native scale, primary monitor", to_screen(0, 640, 1.0), 640)
# Second monitor, downscaled capture.
check("downscaled, second monitor", to_screen(1000, 60, 0.5), 1120)
# A monitor LEFT of primary has negative x, so origins are negative and
# the arithmetic has to keep working through zero rather than clamping.
check("negative-origin monitor", to_screen(-1200, 100, 1.0), -1100)
check("negative origin, downscaled", to_screen(-1200, 400, 0.5), -400)
check("negative origin, crossing zero", to_screen(-100, 400, 1.0), 300)
check("2x scaled display maps back to points", to_screen(0, 1000, 2.0), 500)

# Minimized windows park at -32000 on Windows and must be flagged, not treated as
# a real target, or a click computed from that geometry goes nowhere.
truthy("minimized flagged", sc.Win("1", "t", -32000, -32000, 160, 28).minimized)
check("negative-monitor window is not 'minimized'",
      sc.Win("1", "t", -1100, 0, 800, 600).minimized, False)

# Click guard geometry: inside is half-open on the far edges.
w = sc.Win("1", "t", -1100, 100, 800, 600)
check("origin pixel is inside", w.contains(-1100, 100), True)
check("last pixel is inside", w.contains(-1100 + 799, 100 + 599), True)
check("one past the right edge is outside", w.contains(-1100 + 800, 300), False)
check("above the top edge is outside", w.contains(-1000, 99), False)

check("norm strips CRLF and trailing newlines", sc.norm("a\r\nb\r\n\n"), "a\nb")

# Fullscreen gate: focus escalation (thread attach, ALT tap) is refused when the
# window in front is fullscreen-sized (a video, a presentation, a game), because
# both would deliver input to that window instead of the target. The shapes
# below are synthetic: a primary monitor plus one monitor to its left.
primary = (0, 0, 1000, 800)
left = (-1200, 0, 0, 900)
check("fullscreen app covers its monitor", sc.covers_monitor((0, 0, 1000, 800), primary), True)
check("maximized window overhangs the frame and stops at the taskbar",
      sc.covers_monitor((-8, -8, 1008, 760), primary), False)
check("desktop spanning all monitors is not one monitor",
      sc.covers_monitor((-1200, 0, 1000, 900), primary), False)
check("fullscreen on a left monitor", sc.covers_monitor(left, left), True)
check("ordinary window is not fullscreen",
      sc.covers_monitor((-1100, 100, -300, 700), left), False)


# --------------------------------------------------------------------------
# Transcript interpretation, replayed over every real transcript found locally
# --------------------------------------------------------------------------

def rec(t, blocks=None, sub=None):
    d = {"type": t}
    if sub:
        d["subtype"] = sub
    if blocks is not None:
        d["message"] = {"content": blocks}
    return d


done = [rec("user", [{"type": "text", "text": "hi"}]),
        rec("assistant", [{"type": "text", "text": "ok"}]),
        rec("system", sub="turn_duration")]
open_turn = done + [rec("user", [{"type": "text", "text": "do a thing"}])]
tool_round = done + [
    rec("assistant", [{"type": "tool_use", "id": "x", "name": "Bash",
                       "input": {"command": "ls"}}]),
    rec("user", [{"type": "tool_result", "tool_use_id": "x"}]),
    rec("system", sub="turn_duration")]

both_markers = done + [rec("system", sub="stop_hook_summary"), rec("system", sub="turn_duration")]
hook_only = done[:2] + [rec("system", sub="stop_hook_summary")]
two_turns = both_markers + [rec("user", [{"type": "text", "text": "again"}]),
                            rec("assistant", [{"type": "text", "text": "done"}]),
                            rec("system", sub="stop_hook_summary"),
                            rec("system", sub="turn_duration")]
check("one turn_duration is one turn", len(sw.turn_ends(done)), 1)
check("adjacent stop_hook_summary + turn_duration count once", len(sw.turn_ends(both_markers)), 1)
check("stop_hook_summary alone marks a turn end", len(sw.turn_ends(hook_only)), 1)
check("two turns with both markers each count as two", len(sw.turn_ends(two_turns)), 2)
check("hook-only end closes the turn", sw.turn_in_flight(hook_only), False)

check("closed turn is not in flight", sw.turn_in_flight(done), False)
check("new prompt opens the turn", sw.turn_in_flight(open_turn), True)
check("a tool_result is not a new prompt", sw.turn_in_flight(tool_round), False)
check("empty transcript is not in flight", sw.turn_in_flight([]), False)
check("junk records do not crash it",
      sw.turn_in_flight([{"nope": 1}, rec("assistant")]), False)

# Path mangling: every non-alphanumeric becomes a hyphen. Getting this wrong means
# the directory is never found and the error blames the wrong thing.
check("drive letter and separators", sw.mangle(r"C:\Users\me\proj"), "C--Users-me-proj")
truthy("spaces and parens survive", "-" in sw.mangle(r"C:\Users\me\my proj (v2)"))
check("no non-alphanumerics remain",
      any(not (c.isalnum() or c == "-") for c in sw.mangle(r"C:\a b.c(d)\e")), False)

# Opt-in (HARNESS_LIVE_TESTS=1): replay against your real transcripts. The point
# is that nothing crashes on shapes not anticipated, and that a transcript ending
# in a completed turn is never reported as open. Off by default so a plain run
# reads nothing outside this repo; failures name a transcript by index, not file.
root = pathlib.Path.home() / ".claude" / "projects"
live = os.environ.get("HARNESS_LIVE_TESTS") == "1"
files = (sorted(root.glob("*/*.jsonl"), key=lambda q: q.stat().st_mtime)[-40:]
         if live and root.is_dir() else [])
replayed = closed_ok = 0
for n, f in enumerate(files, 1):
    try:
        recs = sw.records(f)
    except Exception as e:                                  # pragma: no cover
        FAILURES.append(f"records() crashed on transcript #{n}: {e}")
        continue
    if not recs:
        continue
    replayed += 1
    try:
        in_flight = sw.turn_in_flight(recs)
        sw.pending_tool_details(recs)
        sw.assistant_texts(recs)
        sw.tool_reads(recs, 0)
    except Exception as e:                                  # pragma: no cover
        FAILURES.append(f"parsing crashed on transcript #{n}: {e}")
        continue
    # The invariant that matters: if a turn completed AFTER the newest user
    # prompt, the turn is closed. This is the exact judgment that was wrong
    # upstream once, when a quiet transcript was read as finished while a
    # permission prompt sat on screen.
    ends = sw.turn_ends(recs)
    last_prompt = max(
        (i for i, d in enumerate(recs)
         if d.get("type") == "user"
         and not any(isinstance(c, dict) and c.get("type") == "tool_result"
                     for c in sw._content(d))),
        default=-1)
    if ends and last_prompt >= 0 and ends[-1] > last_prompt:
        CHECKS += 1
        if in_flight:
            FAILURES.append(f"transcript #{n}: a turn completed after the last prompt "
                            f"but it reads as in flight")
        else:
            closed_ok += 1

if live:
    print(f"replayed {replayed} real transcripts "
          f"({closed_ok} with a completed final turn, all read as closed)")
else:
    print("skipped the real-transcript replay (set HARNESS_LIVE_TESTS=1 to run it)")


# --------------------------------------------------------------------------
# Key tables
# --------------------------------------------------------------------------

for name in ("enter", "esc", "tab", "backtick", "pagedown", "f5", "f10", "ctrl",
             "shift", "win", "insert"):
    truthy(f"key name {name!r} is mapped", name in sc.VK)
# Letters and digits map through ord(); punctuation must be named instead,
# because a bare '`' has no virtual key code and a backtick inside double
# quotes is command substitution in most shells.
check("backtick is VK_OEM_3", sc.VK["backtick"], 0xC0)

# wScan is 16 bits and carries a UTF-16 code unit. Passing a code point
# straight in truncates every astral character: a rocket (U+1F680) arrived
# as U+F680, a private-use glyph, with no error. BMP characters have one
# unit and always worked, which is why it went unnoticed. The probe characters
# are built from code points so this file stays ASCII.
check("BMP character is one unit", sc._utf16_units(chr(0xE9)), [0xE9])
check("CJK is one unit", sc._utf16_units(chr(0x65E5)), [0x65E5])
check("astral character is a surrogate PAIR", sc._utf16_units(chr(0x1F680)),
      [0xD83D, 0xDE80])
for u in sc._utf16_units(chr(0x1F680)) + sc._utf16_units(chr(0x2605)):
    CHECKS += 1
    if not 0 <= u <= 0xFFFF:
        FAILURES.append(f"code unit {u:#x} does not fit in a 16-bit wScan")


# --------------------------------------------------------------------------
# Source invariants this build enforces
# --------------------------------------------------------------------------

# 1. Every file in the skill is pure ASCII (CLAUDE.md: no emoji or Unicode icons
#    in code or docs; special characters are built from code points).
skill_root = HERE.parent
for p in sorted(skill_root.rglob("*")):
    if p.is_file() and p.suffix in (".py", ".md"):
        data = p.read_bytes()
        bad = [i for i, b in enumerate(data) if b > 127]
        CHECKS += 1
        if bad:
            line = data[:bad[0]].count(b"\n") + 1
            FAILURES.append(f"{p.relative_to(skill_root)} has a non-ASCII byte at line {line}")

# 2. No screen-region capture. A grab of the screen rectangle copies whatever is
#    in front of the target, which leaks another application's content; the
#    capture must stay a render of the window's own surface.
src = pathlib.Path(sc.__file__).read_text(encoding="utf-8")
check("no CopyFromScreen call", "CopyFromScreen(" in src, False)
check("no BitBlt from the screen", "BitBlt(" in src, False)
check("no PowerShell subprocess", ("powershell.exe" in src.lower()) or ("pwsh" in src.lower()), False)
truthy("capture uses PrintWindow", "PrintWindow" in src)
# The same scan covers the UI Automation and OCR modules `run` imports: no screen
# grab, no PowerShell, and no subprocess at all.
for mod_name in ("screenctl.py", "uia.py", "ocr.py"):
    msrc = (HERE / mod_name).read_text(encoding="utf-8")
    low = msrc.lower()
    check(f"{mod_name}: no CopyFromScreen", "CopyFromScreen(" in msrc, False)
    check(f"{mod_name}: no BitBlt", "BitBlt(" in msrc, False)
    check(f"{mod_name}: no PowerShell exe", "powershell.exe" in low or "pwsh" in low, False)
    check(f"{mod_name}: no subprocess import", "import subprocess" in msrc or "from subprocess" in msrc, False)


# ==========================================================================
# run plans, region, focus polling, start-up
# ==========================================================================

import contextlib       # noqa: E402
import io               # noqa: E402
import json             # noqa: E402
import os               # noqa: E402
import subprocess       # noqa: E402
import time             # noqa: E402
import types            # noqa: E402

STATE = os.path.join(tmp, "state")          # run.lock, actions.log and fail shots land here
os.makedirs(STATE)
sc.STATE_DIR = STATE
sc.LOG = os.path.join(STATE, "actions.log")
SCRIPT = str(HERE / "screenctl.py")
# The CLI subprocesses get the same temp state dir, so no test writes the real ~/.claude/screenctl/.
PYENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", SCREENCTL_STATE_DIR=STATE)


@contextlib.contextmanager
def patched(**kw):
    old = {k: getattr(sc, k) for k in kw}
    try:
        for k, v in kw.items():
            setattr(sc, k, v)
        yield
    finally:
        for k, v in old.items():
            setattr(sc, k, v)


def run_capture(fn, *args):
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            rc = fn(*args)
    except SystemExit as e:
        rc = ("exit", e.code)
    return rc, buf.getvalue()


class Clock:
    """A fake clock: sleep() advances it, so wait loops run instantly and exactly."""

    def __init__(self):
        self.now = 0.0
        self.slept = []

    def sleep(self, s):
        self.slept.append(round(s, 6))
        self.now += s

    def clock(self):
        return self.now


REAL = {n: getattr(sc, n) for n in ("act_key", "act_type", "act_paste", "act_click", "act_click_uia",
                                    "act_scroll", "act_shot", "focus", "_refuse_if_covered",
                                    "send_chord", "type_text")}


# --- region arithmetic -------------------------------------------------------

rw = sc.Win("1", "t", 100, 200, 800, 600)
g = sc.region_geometry(rw, (10, 20, 400, 300), 200)
check("region: scale is image width over region width", g["scale"], 0.5)
check("region: origin is window origin plus the offset", g["origin"], (110, 220))
g = sc.region_geometry(rw, None, 640)
check("no region: scale is image width over window width", g["scale"], 0.8)
check("no region: origin is the window origin", g["origin"], (100, 200))
check("region exactly the window is allowed", sc.region_geometry(rw, (0, 0, 800, 600), 800)["scale"], 1.0)
for bad in ((700, 0, 200, 10), (-1, 0, 10, 10), (0, 590, 10, 11), (0, 0, 801, 10)):
    rc, out = run_capture(sc.region_geometry, rw, bad)
    check(f"region {bad} is REGION_OUTSIDE", (rc, out.startswith("REGION_OUTSIDE:")), (("exit", 1), True))
check("parse_region", sc.parse_region("1,2,30,40"), (1, 2, 30, 40))
for bad in ("1,2,3", "a,b,c,d", "1,2,0,4", "1,2,3,-4"):
    rc, out = run_capture(sc.parse_region, bad)
    check(f"parse_region {bad!r} is BAD_REGION", out.startswith("BAD_REGION:"), True)

# act_shot prints the region arithmetic (capture patched: it writes a PNG of the size the
# real capture would produce, 400 wide region downscaled to 200 and 800 to 640).
shot_calls = []


def fake_capture(win, out, max_width, region=None):
    shot_calls.append(region)
    rwid = region[2] if region else win.w
    rhei = region[3] if region else win.h
    tw = min(rwid, max_width) if max_width else rwid
    th = max(1, round(rhei * tw / rwid))
    open(out, "wb").write(sc.encode_png_bgra(tw, th, bytes((i * 7) % 256 for i in range(tw * th * 4))))


shot_ns = types.SimpleNamespace(title=None, id="1", out=f"{tmp}/s.png", no_focus=True, max_width=200,
                                region="10,20,400,300", settle=0)
with patched(resolve=lambda t, w=None: rw, capture=fake_capture):
    rc, out = run_capture(sc.act_shot, shot_ns)
truthy("shot region: WINDOW_ORIGIN adds the offset", "WINDOW_ORIGIN: 110,220    IMAGE_SCALE: 0.5000" in out)
truthy("shot region: REGION line", "REGION: 10,20,400,300 of the window" in out)
shot_ns.region = None
shot_ns.max_width = 640
with patched(resolve=lambda t, w=None: rw, capture=fake_capture):
    rc, out = run_capture(sc.act_shot, shot_ns)
truthy("shot no region: origin and scale as before", "WINDOW_ORIGIN: 100,200    IMAGE_SCALE: 0.8000" in out)
check("shot no region: no REGION line", "REGION:" in out, False)
shot_calls.clear()
shot_ns.region = "700,0,200,10"
with patched(resolve=lambda t, w=None: rw, capture=fake_capture):
    rc, out = run_capture(sc.act_shot, shot_ns)
check("shot region outside refuses before capturing", (out.startswith("REGION_OUTSIDE"), shot_calls), (True, []))

# PNG at level 1 is still a valid PNG that decodes to the same rows.
png = sc.encode_png_bgra(300, 200, bytes((i * 31) % 256 for i in range(300 * 200 * 4)))
pos = 8 + 12 + 13
nn = struct.unpack(">I", png[pos:pos + 4])[0]
rows = zlib.decompress(png[pos + 8:pos + 8 + nn])
check("PNG: decoded size is rows of 1 + 4w bytes", len(rows), 200 * (1 + 300 * 4))

# --- frames --------------------------------------------------------------------

zero = bytes(64 * 64 * 4)
quarter = bytearray(zero)
for yy in range(0, 64, 16):                       # 4 sampled rows
    for xx in range(0, 64, 8):                    # of 8 sampled columns each: 32 of 64
        quarter[(yy * 64 + xx) * 4] = 255
check("sig_diff identical", sc.sig_diff(sc.frame_sig(64, 64, zero), sc.frame_sig(64, 64, zero)), 0.0)
check("sig_diff half the samples", sc.sig_diff(sc.frame_sig(64, 64, zero),
                                               sc.frame_sig(64, 64, bytes(quarter))), 0.5)
alpha = bytearray(zero)
alpha[3::4] = b"\xff" * (64 * 64)
check("sig_diff ignores alpha", sc.sig_diff(sc.frame_sig(64, 64, zero), sc.frame_sig(64, 64, bytes(alpha))), 0.0)
check("sig_diff of a resized frame is 1.0",
      sc.sig_diff(sc.frame_sig(64, 64, zero), sc.frame_sig(32, 32, bytes(32 * 32 * 4))), 1.0)

# --- chords --------------------------------------------------------------------

check("parse_chord", sc.parse_chord("ctrl+shift+p"), [0x11, 0x10, 0x50])
try:
    sc.parse_chord("ctrl+foo")
    FAILURES.append("parse_chord accepted an unknown name")
except sc.BadKey:
    pass
CHECKS += 1
with patched(_send=lambda evs: FAILURES.append("send_chord sent for a bad key")):
    rc, out = run_capture(sc.send_chord, "ctrl+foo")
check("send_chord BAD_KEY message is unchanged", out.splitlines()[0], "BAD_KEY: unknown key 'foo' in 'ctrl+foo'")
check("name key strips accelerators, case and space", sc._name_key("  &Save  "), "save")


# --- plan validation: every rejection sends nothing ---------------------------------

class Env:
    """Everything `run` touches, faked and counted. A call that sends, focuses or captures is
    recorded in .calls; a rejected plan must leave it empty."""

    def __init__(self, title="App"):
        self.clk = Clock()
        self.calls = []
        self.title = title
        self.alive = True
        self.win = sc.Win("4242", "App - Old", 100, 100, 800, 600)
        self.windows = [self.win]
        self.hooks = {}
        self.shots = []
        self.fuia = FakeUia()
        self.frames = []
        self.on_frame = None

    def rec(self, name, ret=None):
        def f(*a, **k):
            self.calls.append(name)
            return ret
        return f

    def act(self, name, line):
        def f(a):
            self.calls.append(name)
            print(line(a))
            hook = self.hooks.get(name)
            if hook:
                hook(a)
        return f

    def focus(self, title, settle=0.45, wid=None, unlock=True):
        self.calls.append("focus")
        self.unlock_seen = unlock
        print(f"FOCUS_OK: {self.win.title}")
        return self.win

    def act_shot(self, a):
        self.calls.append("act_shot")
        self.shots.append(a)
        print(f"SHOT: {a.out}  100x80  (no focus change)")
        print("WINDOW_ORIGIN: 100,100    IMAGE_SCALE: 1.0000")
        print("To click what you see at image pixel (px,py), pass:")

    def grab(self, win, region=None, max_width=0):
        self.calls.append("grab_bgra")
        if self.on_frame:
            return self.on_frame(len(self.calls))
        return 64, 64, zero

    def lazy(self, name):
        if name == "uia":
            return self.fuia
        raise ImportError(name)

    def patches(self):
        p = dict(_sleep=self.clk.sleep, _clock=self.clk.clock,
                 list_windows=lambda include_cloaked=False: list(self.windows),
                 resolve=lambda t, w=None: self.win, _is_window=lambda h: self.alive,
                 _win_of=lambda h: self.win if self.alive else None, _title_of=lambda h: self.title,
                 focus=self.focus, act_shot=self.act_shot, grab_bgra=self.grab,
                 act_key=self.act("act_key", lambda a: f"SENT: {a.keys}"),
                 act_type=self.act("act_type", lambda a: f"TYPED {len(a.text)} chars (no Enter sent)"),
                 act_paste=self.act("act_paste", lambda a: f"PASTED {len(a.text)} chars"),
                 act_click=self.act("act_click", lambda a: f"CLICKED {a.x},{a.y}"),
                 act_click_uia=self.act("act_click_uia", lambda a: f"CLICKED_UIA: {a.name}"),
                 act_scroll=self.act("act_scroll", lambda a: f"SCROLLED {a.amount}"),
                 _lazy_module=self.lazy, _ocr_ready=lambda: (True, "en-US"))
        for n in ("_send", "_keybd_event", "place_cursor", "set_clipboard", "capture",
                  "raise_window", "force_foreground", "unlock_foreground"):
            p[n] = self.rec(n, True if n in ("raise_window", "force_foreground") else None)
        return p


def el(name, control="Button", rect=(150, 150, 250, 180), enabled=True, offscreen=False, rid=(1, 2), value=""):
    return {"name": name, "value": value, "control": control, "automation_id": "", "rect": rect,
            "enabled": enabled, "offscreen": offscreen, "runtime_id": rid, "is_password": False}


class FakeUia:
    class Unavailable(Exception):
        pass

    def __init__(self):
        self.elements = []
        self.truncated = False
        self.hit = True
        self.finds = []
        self.hits = []
        self.tmos = []             # the timeout_s each find / hit_test call was given
        self.after = None         # callable() -> extra elements that appear once true

    def find(self, hwnd, text, control=None, exact=False, **kw):
        self.finds.append((text, control, exact))
        self.tmos.append(kw.get("timeout_s"))
        out = []
        for e in self.elements:
            if control and e["control"].lower() != control.lower():
                continue
            if exact:
                ok = sc._name_key(e["name"]) == sc._name_key(text)
            else:
                ok = text.lower() in (e["name"] + e["value"]).lower()
            if ok:
                out.append(e)
        return out, self.truncated

    def hit_test(self, x, y, rid, max_up=12, **kw):
        self.hits.append((x, y, rid))
        self.tmos.append(kw.get("timeout_s"))
        return self.hit


def run_ns(plan, **kw):
    text = plan if isinstance(plan, str) else json.dumps(plan)
    d = dict(plan=text, plan_file=None, title="app", id=None, fail_shot=f"{tmp}/fail.png", dry_run=False)
    d.update(kw)
    return types.SimpleNamespace(**d)


def do_run(plan, env=None, extra=None, **kw):
    env = env or Env()
    p = env.patches()
    p.update(extra or {})
    with patched(**p):
        rc, out = run_capture(sc.run_plan, run_ns(plan, **kw))
    return env, rc, out


INVALID = {
    "malformed JSON": ("{not json", "BAD_JSON", None),
    "not an array": ({"key": "a"}, "BAD_PLAN", None),
    "empty plan": ([], "BAD_PLAN", None),
    "31 steps": ([{"key": "a"}] * 31, "TOO_MANY_STEPS", None),
    "unknown key": ([{"key": "a"}, {"focus": True, "bogus": 1}], "UNKNOWN_KEY", 2),
    "two action keys": ([{"key": "a", "type": "b"}], "BAD_STEP", 1),
    "no action key": ([{"expect": {"title": "x"}}], "BAD_STEP", 1),
    "option of another action": ([{"key": "a", "double": True}], "UNKNOWN_KEY", 1),
    "newline in type": ([{"type": "a\nb"}], "NEWLINE_IN_TYPE", 1),
    "carriage return in type": ([{"type": "a\rb"}], "NEWLINE_IN_TYPE", 1),
    "sleep over 3.0": ([{"sleep": 3.5}], "BAD_STEP", 1),
    "sleep zero": ([{"sleep": 0}], "BAD_STEP", 1),
    "timeout over 30": ([{"key": "a", "expect": {"title": "x"}, "timeout": 31}], "BAD_TIMEOUT", 1),
    "timeout without expect": ([{"key": "a", "timeout": 2}], "UNKNOWN_KEY", 1),
    "bad key name": ([{"key": "ctrl+foo"}], "BAD_KEY", 1),
    "empty chord": ([{"key": "+"}], "BAD_KEY", 1),
    "empty text": ([{"type": ""}], "EMPTY_TEXT", 1),
    "empty paste": ([{"paste": ""}], "EMPTY_TEXT", 1),
    "empty paste_file": ([{"paste_file": f"{tmp}/empty.txt"}], "EMPTY_TEXT", 1),
    "control character in type (ESC)": ([{"type": "a" + chr(0x1B) + "b"}], "CONTROL_IN_TYPE", 1),
    "control character in type (BS)": ([{"type": chr(8)}], "CONTROL_IN_TYPE", 1),
    "control character in type (NUL)": ([{"type": "a" + chr(0)}], "CONTROL_IN_TYPE", 1),
    "DEL in type": ([{"type": "a" + chr(0x7F)}], "CONTROL_IN_TYPE", 1),
    "key underscore": ([{"key": "_"}], "BAD_KEY", 1),
    "key open brace": ([{"key": "{"}], "BAD_KEY", 1),
    "key less-than": ([{"key": "<"}], "BAD_KEY", 1),
    "key sharp s (two letters when upper-cased)": ([{"key": chr(0xDF)}], "BAD_KEY", 1),
    "key non-ASCII letter": ([{"key": chr(0xE9)}], "BAD_KEY", 1),
    "key plus after ctrl": ([{"key": "ctrl++"}], "BAD_KEY", 1),
    "key not a string": ([{"key": 5}], "EMPTY_TEXT", 1),
    "enter after an unverified type and a key": ([{"type": "rm -rf build"}, {"key": "end"}, {"key": "enter"}],
                                                 "ENTER_UNVERIFIED", 3),
    "enter after an unverified type and a scroll": ([{"type": "rm -rf build"}, {"scroll": 1}, {"key": "enter"}],
                                                    "ENTER_UNVERIFIED", 3),
    "enter after an unverified type and a click_uia": ([{"type": "x"}, {"click_uia": {"name": "Go"}},
                                                        {"key": "enter"}], "ENTER_UNVERIFIED", 3),
    "slash payload, unverified, key between": ([{"paste": "/exit"}, {"key": "end"}, {"key": "enter"}],
                                               "ENTER_UNVERIFIED", 3),
    "slash payload, verified, key between, no wait": ([{"paste": "/exit", "expect": {"uia": "exit"}},
                                                       {"key": "end"}, {"key": "enter"}], "SLASH_WAIT", 3),
    "enter after a decoy uia expect on a key": ([{"type": "rm -rf build"},
                                                 {"key": "end", "expect": {"uia": "Terminal"}},
                                                 {"key": "enter"}], "ENTER_UNVERIFIED", 3),
    "enter after a decoy ocr wait": ([{"paste": "rm -rf build"}, {"wait": {"ocr": "Terminal"}},
                                      {"key": "enter"}], "ENTER_UNVERIFIED", 3),
    "ctrl+m after an unverified type": ([{"type": "rm -rf build"}, {"key": "ctrl+m"}], "ENTER_UNVERIFIED", 2),
    "ctrl+j after an unverified type": ([{"type": "rm -rf build"}, {"key": "ctrl+j"}], "ENTER_UNVERIFIED", 2),
    "ctrl+o (bash accept-line) after an unverified type": ([{"type": "rm -rf build"}, {"key": "ctrl+o"}], "ENTER_UNVERIFIED", 2),
    "enter after a title wait is not a read-back": ([{"type": "x"}, {"wait": {"title": "x"}}, {"key": "enter"}],
                                                    "ENTER_UNVERIFIED", 3),
    "enter after a run of single printable keys": ([{"key": c} for c in ("r", "m", "space", "-", "r", "f")]
                                                   + [{"key": "enter"}], "ENTER_UNVERIFIED", 7),
    "enter after a digit key": ([{"key": "5"}, {"key": "enter"}], "ENTER_UNVERIFIED", 2),
    "enter after a space key": ([{"key": "space"}, {"key": "enter"}], "ENTER_UNVERIFIED", 2),
    "ctrl+m after a run of single keys": ([{"key": "l"}, {"key": "s"}, {"key": "ctrl+m"}], "ENTER_UNVERIFIED", 3),
    "single keys with a decoy read-back": ([{"key": "r"}, {"key": "m"}, {"wait": {"uia": "Terminal"}},
                                            {"key": "enter"}], "ENTER_UNVERIFIED", 4),
    "slash typed by single keys needs the wait": ([{"key": "/"}, {"key": "e"}, {"key": "x"},
                                                   {"wait": {"uia": "/ex"}}, {"key": "enter"}], "SLASH_WAIT", 5),
    "chord text:a multi-key chord types (r+m)": ([{"key": "r+m"}, {"key": "enter"}], "ENTER_UNVERIFIED", 2),
    "chord text:one chord that types and presses Enter (l+s+enter)": ([{"key": "l+s+enter"}], "ENTER_UNVERIFIED", 1),
    "chord text:a shift chord types (shift+1)": ([{"key": "shift+1"}, {"key": "enter"}], "ENTER_UNVERIFIED", 2),
    "chord text:a shift chord is text even with a read-back of other text": (
        [{"key": "shift+1"}, {"wait": {"uia": "Terminal"}}, {"key": "enter"}], "ENTER_UNVERIFIED", 3),
    "split slash:a key slash then a verified type, no wait": ([{"key": "/"}, {"type": "exit", "expect": {"uia": "exit"}},
                                                           {"key": "enter"}], "SLASH_WAIT", 3),
    "split slash:a type slash then a verified type, no wait": ([{"type": "/"}, {"type": "exit", "expect": {"uia": "exit"}},
                                                            {"key": "enter"}], "SLASH_WAIT", 3),
    "split slash:a type slash then single keys, no wait": ([{"type": "/"}, {"key": "e"}, {"key": "x"}, {"key": "i"},
                                                        {"key": "t", "expect": {"uia": "exit"}},
                                                        {"key": "enter"}], "SLASH_WAIT", 6),
    "split slash:a split slash payload with a scroll between": ([{"key": "/"}, {"scroll": 1},
                                                             {"type": "exit", "expect": {"uia": "exit"}},
                                                             {"key": "enter"}], "SLASH_WAIT", 4),
    "split slash:a shift key first may be a slash": ([{"key": "shift+7"}, {"type": "x", "expect": {"uia": "x"}},
                                                  {"key": "enter"}], "SLASH_WAIT", 3),
    "read-back step:an expect on a step between text and Enter is not a read-back": (
        [{"type": "hello"}, {"key": "end", "expect": {"uia": "hello"}}, {"key": "enter"}], "ENTER_UNVERIFIED", 3),
    "read-back step:an ocr expect on a step between is not a read-back": (
        [{"paste": "hello"}, {"scroll": 1, "expect": {"ocr": "hello"}}, {"key": "enter"}], "ENTER_UNVERIFIED", 3),
    "missing paste_file": ([{"paste_file": f"{tmp}/no-such-file.txt"}], "BAD_FILE", 1),
    "key Kelvin sign": ([{"key": chr(0x212A)}], "BAD_KEY", 1),
    "key ctrl+Kelvin sign": ([{"key": "ctrl+" + chr(0x212A)}], "BAD_KEY", 1),
    "paste_file not UTF-8": ([{"paste_file": f"{tmp}/latin1.txt"}], "BAD_FILE", 1),
    "scroll as a string": ([{"scroll": "3"}], "BAD_STEP", 1),
    "scroll zero": ([{"scroll": 0}], "BAD_STEP", 1),
    "scroll a bool": ([{"scroll": True}], "BAD_STEP", 1),
    "click one coordinate": ([{"click": [1]}], "BAD_STEP", 1),
    "click a float": ([{"click": [1.5, 2]}], "BAD_STEP", 1),
    "click bad button": ([{"click": [1, 2], "button": "middle"}], "BAD_STEP", 1),
    "click_uia extra key": ([{"click_uia": {"name": "Save", "bogus": 1}}], "BAD_STEP", 1),
    "click_uia empty name": ([{"click_uia": {"name": " "}}], "EMPTY_TEXT", 1),
    "expect on sleep": ([{"sleep": 1, "expect": {"title": "x"}}], "BAD_STEP", 1),
    "expect on wait": ([{"wait": {"title": "x"}, "expect": {"title": "y"}}], "BAD_STEP", 1),
    "expect on shot": ([{"shot": "a.png", "expect": {"title": "x"}}], "BAD_STEP", 1),
    "two condition keys": ([{"key": "a", "expect": {"title": "x", "uia": "y"}}], "BAD_CONDITION", 1),
    "region on a title condition": ([{"key": "a", "expect": {"title": "x", "region": [0, 0, 1, 1]}}],
                                    "UNKNOWN_KEY", 1),
    "bad region": ([{"wait": {"changed": True, "region": [0, 0, 0, 5]}}], "BAD_REGION", 1),
    "min_fraction 1.5": ([{"wait": {"changed": True, "min_fraction": 1.5}}], "BAD_CONDITION", 1),
    "stable 0.05": ([{"wait": {"stable": 0.05}}], "BAD_CONDITION", 1),
    "stable longer than its timeout": ([{"wait": {"stable": 5}, "timeout": 4}], "BAD_TIMEOUT", 1),
    "shot settle 3": ([{"shot": "a.png", "settle": 3}], "BAD_STEP", 1),
    "shot region w=0": ([{"shot": "a.png", "region": [0, 0, 0, 4]}], "BAD_REGION", 1),
    "shot max_width negative": ([{"shot": "a.png", "max_width": -1}], "BAD_STEP", 1),
    "click after a type": ([{"type": "a"}, {"click": [150, 150]}], "STALE_CLICK", 2),
    "click after a focusing shot": ([{"shot": "a.png"}, {"click": [150, 150]}], "STALE_CLICK", 2),
    "second coordinate click": ([{"click": [150, 150]}, {"click": [160, 160]}], "STALE_CLICK", 2),
    "enter after an unverified type": ([{"type": "hello"}, {"key": "enter"}], "ENTER_UNVERIFIED", 2),
    "ctrl+enter after paste": ([{"paste": "hello"}, {"key": "ctrl+enter"}], "ENTER_UNVERIFIED", 2),
    "enter, expect text not in the payload": ([{"type": "hello", "expect": {"uia": "bye"}},
                                               {"key": "enter"}], "ENTER_UNVERIFIED", 2),
    "enter, expect kind title": ([{"type": "hello", "expect": {"title": "hello"}},
                                  {"key": "enter"}], "ENTER_UNVERIFIED", 2),
    "slash payload without the wait": ([{"paste": "/help", "expect": {"uia": "help"}},
                                        {"key": "enter"}], "SLASH_WAIT", 2),
    "slash payload, short sleep": ([{"paste": "/help", "expect": {"uia": "help"}}, {"sleep": 2.5},
                                    {"key": "enter"}], "SLASH_WAIT", 3),
    "run too long": ([{"key": "a", "expect": {"title": "x"}, "timeout": 30}] * 5, "RUN_TOO_LONG", None),
    "no target for a key": ([{"key": "a"}], "NO_TARGET", 1),
}
open(f"{tmp}/latin1.txt", "wb").write(b"caf\xe9")
open(f"{tmp}/empty.txt", "wb").write(b"")
for label, (plan, token, step) in INVALID.items():
    env = Env()
    kw = {"title": None} if token == "NO_TARGET" else {}
    env, rc, out = do_run(plan, env, **kw)
    first = out.splitlines()[0] if out else ""
    want_step = "-" if step is None else str(step)
    check(f"invalid plan [{label}]: PLAN_INVALID with step and token",
          (rc, first.startswith(f"PLAN_INVALID: step {want_step}: {token}")), (1, True))
    check(f"invalid plan [{label}]: nothing sent, focused or captured", env.calls, [])
check("no lock file after a rejected plan", os.path.exists(sc._lock_path()), False)

# Valid plans (the examples of the spec) and the rules' positive sides.
for label, plan in {
    "click double": [{"click": [850, 730], "double": True}],
    "shot region": [{"shot": "C:/x/a.png", "no_focus": True, "region": [0, 0, 800, 200]}],
    "type with expect": [{"type": "hello", "expect": {"uia": "hello"}}],
    "wait changed": [{"wait": {"changed": True, "min_fraction": 0.02}, "timeout": 5}],
    "click after focus and a no_focus shot": [{"focus": True}, {"shot": "a.png", "no_focus": True},
                                              {"click": [150, 150]}],
    "enter verified by uia": [{"type": "hello", "expect": {"uia": "hell"}}, {"key": "enter"}],
    "enter verified by ocr": [{"paste": "hello", "expect": {"ocr": "hello"}}, {"key": "enter"}],
    "enter after a click needs nothing": [{"click": [150, 150]}, {"key": "enter"}],
    "slash payload with a 3 s sleep": [{"paste": "/help", "expect": {"uia": "help"}}, {"sleep": 3.0},
                                       {"key": "enter"}],
    "slash payload with a stable wait": [{"paste": "/help", "expect": {"uia": "help"}},
                                         {"wait": {"stable": 3.0}}, {"key": "enter"}],
    "click_uia anywhere": [{"key": "a"}, {"click_uia": {"name": "Save", "control": "Button"}}],
    "30 steps": [{"key": "a"}] * 30,
    "whitespace-only paste": [{"paste": "   "}],
    "whitespace-only type": [{"type": " "}],
    "tab in type": [{"type": "a" + chr(9) + "b"}],
    "punctuation keys": [{"key": "ctrl+-"}, {"key": "["}, {"key": "ctrl+shift+/"}, {"key": "ctrl+;"}],
    "type, uia read-back after a key, then enter": [{"type": "hello"}, {"key": "end"},
                                                    {"wait": {"uia": "hello"}}, {"key": "enter"}],
    "type, ocr read-back, then ctrl+m": [{"type": "hello"}, {"wait": {"ocr": "hello"}}, {"key": "ctrl+m"}],
    "ctrl+m with nothing typed before it": [{"key": "ctrl+m"}],
    "slash payload, verified by a wait, with the 3 s sleep": [{"paste": "/exit"}, {"wait": {"uia": "exit"}},
                                                              {"sleep": 3.0}, {"key": "enter"}],
    "single keys, read back by a wait, then enter": [{"key": "l"}, {"key": "s"}, {"wait": {"uia": "ls"}},
                                                     {"key": "enter"}],
    "slash by single keys, read back, 3 s sleep, enter": [{"key": "/"}, {"key": "e"}, {"key": "x"},
                                                          {"wait": {"uia": "/ex"}}, {"sleep": 3.0},
                                                          {"key": "enter"}],
    "enter after modified and named keys needs nothing": [{"key": "ctrl+a"}, {"key": "tab"}, {"key": "shift+tab"},
                                                          {"key": "alt+f4"}, {"key": "enter"}],
    "read-back step:enter verified by an expect on the text step": [{"type": "hello", "expect": {"uia": "hello"}},
                                                             {"key": "end"}, {"key": "enter"}],
    "read-back step:enter verified by a wait after a key": [{"type": "hello"}, {"key": "end"},
                                                     {"wait": {"ocr": "hello"}}, {"key": "enter"}],
    "split slash:a split slash payload with the 3 s wait": [{"key": "/"}, {"type": "exit", "expect": {"uia": "exit"}},
                                                        {"sleep": 3.0}, {"key": "enter"}],
    "split slash:a slash that an earlier Enter already submitted": [{"paste": "/help", "expect": {"uia": "help"}},
                                                                {"sleep": 3.0}, {"key": "enter"},
                                                                {"type": "ok", "expect": {"uia": "ok"}},
                                                                {"key": "enter"}],
    "chord text:ctrl chords are not text before a plain Enter": [{"key": "ctrl+shift+p"}, {"scroll": 1},
                                                              {"key": "enter"}],
}.items():
    env, rc, out = do_run(plan, dry_run=True)
    check(f"valid plan [{label}] passes a dry run", (rc, "DRY_RUN_OK" in out), (0, True))
    check(f"valid plan [{label}]: a dry run touches nothing", [c for c in env.calls if c != "act_shot"], [])
    check(f"valid plan [{label}]: a dry run captures no shot", env.shots, [])
env, rc, out = do_run([{"key": "a"}], dry_run=True)
truthy("dry run prints the RUN line with the cap", out.startswith("RUN: 1 steps, target 4242\t"))
truthy("dry run: cap is 1.5 s for one sending step", ", cap 1.5 s" in out)

# --- the run loop ---------------------------------------------------------------

# A fully passing plan; the key action changes the title, which is what the expect waits for.
env = Env()
env.hooks["act_key"] = lambda a: setattr(env, "title", "New Tab")
env.windows = [env.win]
env, rc, out = do_run([{"key": "ctrl+t", "expect": {"title": "New Tab"}}, {"type": "hi"},
                       {"shot": f"{tmp}/p.png", "no_focus": True}], env)
lines = out.splitlines()
check("run ok: exit code", rc, 0)
truthy("run ok: RUN line", lines[0].startswith("RUN: 3 steps, target 4242\t"))
truthy("run ok: STEP line joins the act lines and the expect",
       lines[1].startswith("STEP 1/3 OK key ctrl+t (") and
       " | FOCUS_OK: App - Old | SENT: ctrl+t | expect title \"New Tab\" ok (" in lines[1])
truthy("run ok: type keeps the delivered character count",
       "TYPED 2 chars (no Enter sent)" in lines[2] and lines[2].startswith("STEP 2/3 OK type ("))
truthy("run ok: a shot step prints its act lines on their own lines",
       lines[3].startswith("STEP 3/3 OK shot ") and lines[4].startswith("SHOT: ")
       and lines[5].startswith("WINDOW_ORIGIN:"))
truthy("run ok: RUN_OK", lines[-1].startswith("RUN_OK 3 steps in "))
check("run ok: every sending step focused without the ALT tap", env.unlock_seen, False)
check("run ok: no lock file left", os.path.exists(sc._lock_path()), False)
truthy("run ok: actions.log has the RUN start and end", "RUN end ok 3 steps" in open(sc.LOG).read())

# Stop at the first failure, attach a shot, list the steps not run, never run later steps.
env = Env()
env, rc, out = do_run([{"key": "a"}, {"type": "x", "expect": {"uia": "Saved"}, "timeout": 1.0},
                       {"key": "b"}, {"key": "c"}], env)
lines = out.splitlines()
check("failed expect: exit 1", rc, 1)
truthy("failed expect: the sent step is shown", any(ln.startswith("STEP 2/4 SENT type | ") for ln in lines))
check("failed expect: RUN_FAILED shape",
      [ln for ln in lines if ln.startswith("RUN_FAILED")],
      ['RUN_FAILED step=2/4 action=type expect=uia: no element contains "Saved" after 1.0 s'])
truthy("failed expect: FAIL_SHOT line", any(ln.startswith("FAIL_SHOT: ") for ln in lines))
truthy("failed expect: WINDOW_ORIGIN line from the fail shot", any(ln.startswith("WINDOW_ORIGIN:") for ln in lines))
check("failed expect: NOT_RUN", lines[-1], "NOT_RUN: steps 3-4")
check("failed expect: later steps never ran", env.calls.count("act_key"), 1)
check("failed expect: the fail shot is a no-focus capture, once",
      [(s.no_focus, s.out) for s in env.shots], [(True, f"{tmp}/fail.png")])
check("failed expect: polled until the timeout on the fake clock", round(env.clk.now, 1), 1.0 + 0.0)
check("failed expect: the lock is released", os.path.exists(sc._lock_path()), False)

# Failure at the last step prints NOT_RUN: none; a wait that fails reports expect=<kind>.
env, rc, out = do_run([{"wait": {"window": "Nothing"}, "timeout": 0.5}])
truthy("failed wait: RUN_FAILED names the window condition",
       'RUN_FAILED step=1/1 action=wait expect=window: no window opened since the run started has a title '
       'containing "Nothing" after 0.5 s' in out)
check("failed wait: NOT_RUN none", out.splitlines()[-1], "NOT_RUN: none")

# EXPECT_ALREADY_TRUE: nothing is sent for that step.
env = Env(title="New Tab")
env, rc, out = do_run([{"key": "ctrl+t", "expect": {"title": "New Tab"}}, {"key": "x"}], env)
truthy("already true: reported as RUN_FAILED", "RUN_FAILED step=1/2 action=key expect=title: EXPECT_ALREADY_TRUE" in out)
check("already true: the key was never sent", env.calls.count("act_key"), 0)
check("already true: the later step never ran", "NOT_RUN: steps 2-2" in out, True)
check("already true: no STEP line (nothing was sent)", "STEP 1/2" in out, False)

# A refusal inside a step: the die() output verbatim, RUN_STOPPED, shot, NOT_RUN.
env = Env()


def refuse(a):
    sc.die("FOCUS_LOST_MIDSEND", "sent 3 of 10 characters, then the foreground became 'x'.",
           ["All 3 characters sent reached the target."])


env.hooks["act_type"] = refuse
env, rc, out = do_run([{"type": "0123456789"}, {"key": "b"}], env)
lines = out.splitlines()
truthy("refusal: die text is verbatim, indented lines included",
       "FOCUS_LOST_MIDSEND: sent 3 of 10 characters, then the foreground became 'x'.\n"
       "  All 3 characters sent reached the target.\n" in out)
truthy("refusal: RUN_STOPPED", "RUN_STOPPED step=1/2" in lines)
check("refusal: NOT_RUN", lines[-1], "NOT_RUN: steps 2-2")
check("refusal: exit 1 and the fail shot was taken", (rc, len(env.shots)), (1, 1))

# An unexpected exception: INTERNAL_ERROR, RUN_STOPPED, shot, NOT_RUN.
env = Env()
env.hooks["act_key"] = lambda a: (_ for _ in ()).throw(RuntimeError("boom"))
env, rc, out = do_run([{"key": "a"}, {"key": "b"}], env)
truthy("internal error: INTERNAL_ERROR line", "INTERNAL_ERROR: RuntimeError: boom" in out)
truthy("internal error: RUN_STOPPED and NOT_RUN", "RUN_STOPPED step=1/2" in out and out.splitlines()[-1] == "NOT_RUN: steps 2-2")
truthy("internal error: traceback in actions.log", "INTERNAL_ERROR" in open(sc.LOG).read())

# paste: the clipboard is restored on a refusal inside the run.
env = Env()
clip = {"text": "old"}
sets = []


def fake_set(t):
    sets.append(t)
    clip["text"] = t


extra = dict(act_paste=REAL["act_paste"], clipboard_state=lambda: (clip["text"], True),
             get_clipboard=lambda: clip["text"], set_clipboard=fake_set, same_window=lambda w: False,
             foreground_id=lambda: "1", send_chord=lambda k: env.calls.append("send_chord"))
env, rc, out = do_run([{"paste": "payload text"}, {"key": "b"}], env, extra)
check("paste refusal: payload then the old text were written", sets, ["payload text", "old"])
truthy("paste refusal: FOCUS_LOST then CLIPBOARD_RESTORED in the captured output",
       out.index("FOCUS_LOST:") < out.index("CLIPBOARD_RESTORED") < out.index("RUN_STOPPED"))
check("paste refusal: nothing was pasted", env.calls.count("send_chord"), 0)

# paste_file: the content read at validation is what gets pasted.
open(f"{tmp}/payload.txt", "w", encoding="utf-8").write("from the file")
env = Env()
got = []
env.hooks["act_paste"] = lambda a: got.append((a.text, a.file, a.keep_clipboard))
env, rc, out = do_run([{"paste_file": f"{tmp}/payload.txt"}], env)
check("paste_file: pasted text is the file content", got, [("from the file", None, False)])

# The delays: an expect replaces key's 0.3 s and ONLY that.
env = Env()
extra = dict(act_key=REAL["act_key"], send_chord=lambda k: setattr(env, "title", "T"))
env, rc, out = do_run([{"key": "x", "expect": {"title": "T"}}], env, extra)
check("key with an expect: no 0.3 s sleep", (rc, 0.3 in env.clk.slept), (0, False))
env = Env()
extra = dict(act_key=REAL["act_key"], send_chord=lambda k: None)
env, rc, out = do_run([{"key": "x"}], env, extra)
check("key without an expect keeps its 0.3 s", (rc, 0.3 in env.clk.slept), (0, True))

env = Env()
extra = dict(act_type=REAL["act_type"], type_text=lambda s: env.fuia.elements.append(el("ab", "Edit")),
             same_window=lambda w: True)
env, rc, out = do_run([{"type": "ab", "expect": {"uia": "ab"}}], env, extra)
check("type with an expect keeps its 0.25 s", (rc, 0.25 in env.clk.slept), (0, True))

env = Env()
clip = {"text": "old"}
sets = []
extra = dict(act_paste=REAL["act_paste"], clipboard_state=lambda: (clip["text"], True),
             get_clipboard=lambda: clip["text"], set_clipboard=fake_set, same_window=lambda w: True,
             send_chord=lambda k: env.fuia.elements.append(el("payload", "Text")))
env, rc, out = do_run([{"paste": "payload", "expect": {"uia": "payload"}}], env, extra)
check("paste with an expect keeps its 0.1 s and 0.6 s", (rc, 0.1 in env.clk.slept, 0.6 in env.clk.slept),
      (0, True, True))
truthy("paste with an expect: clipboard restored", sets[-1] == "old" and "CLIPBOARD_RESTORED" in out)

# changed / stable conditions on a fake frame source.
q = bytes(quarter)
env = Env()
env.on_frame = lambda n: (64, 64, zero if n <= 2 else q)        # baseline (call 1), then the poll
env, rc, out = do_run([{"key": "a", "expect": {"changed": True}}], env)
check("changed: the baseline comes before the send, true once 50% of samples differ", (rc, env.calls[:3]),
      (0, ["focus", "grab_bgra", "act_key"]))
env = Env()
env.on_frame = lambda n: (64, 64, zero if n <= 2 else q)
env, rc, out = do_run([{"key": "a", "expect": {"changed": True, "min_fraction": 0.6}, "timeout": 0.5}], env)
truthy("changed: below min_fraction fails with the percentages",
       "expect=changed: the window changed by 50.00% of sampled pixels; needs more than 60.00% after 0.5 s" in out)
env = Env()
env, rc, out = do_run([{"wait": {"stable": 0.5}}], env)
check("stable: unchanged frames pass once held for the time", (rc, 0.5 <= env.clk.now <= 0.7), (0, True))
env = Env()
env.on_frame = lambda n: (64, 64, zero if n % 2 else q)
env, rc, out = do_run([{"wait": {"stable": 0.5}}], env)
truthy("stable: a changing window fails at the timeout (stable secs + 3)",
       "expect=stable: the window kept changing after 3.5 s" in out)

# window / window_gone: only windows that did not exist at the start count.
env = Env()
old = sc.Win("1", "Notes", 0, 0, 10, 10)
new1 = sc.Win("2", "Notes - new", 0, 0, 10, 10)
env.windows = [env.win, old]


def opens(a):
    env.windows.append(new1)


env.hooks["act_key"] = opens
env, rc, out = do_run([{"key": "ctrl+n", "expect": {"window": "Notes"}}], env)
truthy("window: the pre-existing window is ignored, the new one printed",
       rc == 0 and "WINDOW: 2\t0,0 10x10\tNotes - new" in out)
env = Env()
env.windows = [env.win, old]
env.hooks["act_key"] = lambda a: env.windows.extend([new1, sc.Win("3", "Notes - other", 0, 0, 10, 10)])
env, rc, out = do_run([{"key": "ctrl+n", "expect": {"window": "Notes"}}], env)
truthy("window: two new matches are AMBIGUOUS with CANDIDATE lines then RUN_STOPPED",
       "AMBIGUOUS: 2 windows" in out and out.count("\nCANDIDATE: ") == 2 and "RUN_STOPPED step=1/1" in out)
env = Env()
env.windows = [env.win, old]
env.hooks["act_key"] = lambda a: env.windows.remove(old)
env, rc, out = do_run([{"key": "ctrl+w", "expect": {"window_gone": "Notes"}}], env)
check("window_gone", rc, 0)

# A target-less run: only window waits and sleeps; it resolves, focuses and captures nothing.
env = Env()
env, rc, out = do_run([{"wait": {"window": "Later"}, "timeout": 0.3}, {"sleep": 0.5}], env, title=None)
truthy("target-less run: RUN line says no target and the wait fails cleanly",
       out.startswith("RUN: 2 steps, no target (waits only)") and "RUN_FAILED step=1/2 action=wait" in out)
check("target-less run: no focus, no capture, no shot", env.calls, [])
check("target-less run: FAIL_SHOT is skipped", "FAIL_SHOT: skipped (this run has no target window)" in out, True)
env = Env()
env.windows = [env.win]


def late_sleep(s, _orig=env.clk.sleep):
    _orig(s)
    if not any(w.id == "7" for w in env.windows) and env.clk.now >= 0.2:
        env.windows.append(sc.Win("7", "Later app", 0, 0, 5, 5))


env, rc, out = do_run([{"wait": {"window": "Later"}, "timeout": 2.0}], env, {"_sleep": late_sleep}, title=None)
truthy("target-less run: a window that opens during the run satisfies the wait and prints WINDOW:",
       rc == 0 and "WINDOW: 7\t0,0 5x5\tLater app" in out)

# The handle is checked before every step.
env = Env()
env.hooks["act_key"] = lambda a: setattr(env, "alive", False)
env, rc, out = do_run([{"key": "a"}, {"key": "b"}], env)
truthy("vanished handle: NO_SUCH_ID then RUN_STOPPED before step 2",
       "NO_SUCH_ID: window 4242 is gone." in out and "RUN_STOPPED step=2/2" in out
       and env.calls.count("act_key") == 1)
truthy("vanished handle: the fail shot is skipped", "FAIL_SHOT: skipped (the window is gone)" in out)

# --- the run lock -----------------------------------------------------------------

seen = {}
env = Env()
env.hooks["act_key"] = lambda a: seen.update(exists=os.path.exists(sc._lock_path()),
                                              pid=open(sc._lock_path()).read())
env, rc, out = do_run([{"key": "a"}], env)
check("lock: held during the run with the pid, gone after", (seen, os.path.exists(sc._lock_path())),
      ({"exists": True, "pid": str(os.getpid())}, False))
open(sc._lock_path(), "w").write(str(os.getppid()))             # a live process: our parent
rc, out = run_capture(sc._refuse_if_busy)
check("lock: a live other pid refuses with BUSY", (rc, out.splitlines()[0]),
      (("exit", 1), f"BUSY: a run (pid {os.getppid()}) is sending input"))
env, rc, out = do_run([{"key": "a"}])
check("lock: a second run is refused and sends nothing", (rc, out.startswith("BUSY:"), env.calls), (("exit", 1), True, []))
child = subprocess.Popen([sys.executable, "-c", "pass"])
child.wait()
open(sc._lock_path(), "w").write(str(child.pid))
rc, out = run_capture(sc._refuse_if_busy)
check("lock: a dead pid is stale, removed, not a refusal", (rc, os.path.exists(sc._lock_path())), (None, False))
open(sc._lock_path(), "w").write(str(os.getpid()))
check("lock: our own pid is not a refusal", run_capture(sc._refuse_if_busy)[0], None)
os.remove(sc._lock_path())
# The CLI sending subcommands refuse while a run holds the lock; read-only ones do not.
open(sc._lock_path(), "w").write(str(os.getppid()))
for argv in (["key", "--title", "x", "--keys", "enter"], ["type", "--title", "x", "--text", "a"],
             ["click", "--title", "x", "--x", "1", "--y", "2"], ["scroll", "--title", "x"],
             ["focus", "--title", "x"], ["paste", "--title", "x", "--text", "a"],
             ["shot", "--title", "x", "--out", f"{tmp}/z.png"]):
    env = Env()
    old_argv = sys.argv
    sys.argv = ["screenctl.py"] + argv
    try:
        with patched(**env.patches()):
            rc, out = run_capture(sc.main)
    finally:
        sys.argv = old_argv
    check(f"lock: CLI {argv[0]} is refused while a run sends", (out.startswith("BUSY:"), env.calls), (True, []))
for argv in (["list"], ["shot", "--title", "x", "--out", f"{tmp}/z.png", "--no-focus"]):
    env = Env()
    old_argv = sys.argv
    sys.argv = ["screenctl.py"] + argv
    try:
        with patched(**env.patches()):
            rc, out = run_capture(sc.main)
    finally:
        sys.argv = old_argv
    check(f"lock: read-only CLI {' '.join(argv[:1])} ignores the lock", out.startswith("BUSY:"), False)
os.remove(sc._lock_path())

# --- focus: polling, floor, refusal, no ALT tap ----------------------------------------

fw = sc.Win("4242", "T", 0, 0, 100, 100)


def focus_env(same_seq, raise_ret=True, force_ret=True, fullscreen=None, rects=None, win=fw):
    clk = Clock()
    seq = list(same_seq)
    calls = []

    def same(w):
        return seq.pop(0) if len(seq) > 1 else seq[0]

    p = dict(_sleep=clk.sleep, _clock=clk.clock, resolve=lambda t, wid=None: win, same_window=same,
             raise_window=lambda w: (calls.append("raise"), raise_ret)[1],
             force_foreground=lambda w: (calls.append("force"), force_ret)[1],
             _keybd_event=lambda vk, fl: calls.append("keybd"),
             fullscreen_foreground=lambda: fullscreen, list_windows=lambda include_cloaked=False: [],
             foreground_id=lambda: "0")
    if rects is not None:
        rs = list(rects)
        p["_rect_of"] = lambda h: (calls.append("rect"), rs.pop(0) if len(rs) > 1 else rs[0])[1]
    return clk, calls, p


clk, calls, p = focus_env([False, False, False, True])
with patched(**p):
    rc, out = run_capture(sc.focus, None, 0.45, "4242")
check("focus: an accepted request is polled every 15 ms, then held to the 0.15 s floor",
      (clk.slept, round(clk.now, 3), calls), ([0.015, 0.015, 0.12], 0.15, ["raise"]))
check("focus: prints FOCUS_OK as before", out, "FOCUS_OK: T\n")
clk, calls, p = focus_env([False, False, True], raise_ret=False)
with patched(**p):
    rc, out = run_capture(sc.focus, None, 0.45, "4242")
check("focus: a refused request escalates at once, no 0.45 s wait", (clk.slept, calls), ([0.15], ["raise", "force"]))
truthy("focus: the attach success line is unchanged", "FOCUS_OK (after thread attach): T" in out)
clk, calls, p = focus_env([False], raise_ret=False, force_ret=False)
with patched(**p):
    rc, out = run_capture(sc.focus, None, 0.45, "4242")
check("focus: the CLI still falls back to the ALT tap (down and up)", (rc, calls.count("keybd")),
      (("exit", 1), 2))
check("focus: CLI refusal text", out.startswith("FOCUS_FAILED: wanted 'T', foreground is 'unknown'."), True)
clk, calls, p = focus_env([False], raise_ret=False, force_ret=False)
with patched(**p):
    rc, out = run_capture(sc.focus, None, 0.45, "4242", False)
check("focus: unlock=False never taps ALT",
      (rc, calls.count("keybd"), calls), (("exit", 1), 0, ["raise", "force"]))
clk, calls, p = focus_env([False], fullscreen=sc.Win("9", "Player", 0, 0, 10, 10))
with patched(**p):
    rc, out = run_capture(sc.focus, None, 0.45, "4242")
check("focus: a fullscreen foreground refuses before the thread attach or the ALT tap",
      (rc, "force" in calls, "keybd" in calls), (("exit", 1), False, False))
mw = sc.Win("4242", "T", -32000, -32000, 160, 28)
clk, calls, p = focus_env([False, True], win=mw, rects=[(-32000, -32000, -31840, -31972),
                                                          (100, 100, 900, 700), (100, 100, 900, 700)])
with patched(**p):
    rc, out = run_capture(sc.focus, None, 0.45, "4242")
check("focus: a restored window must hold a real rectangle across two reads",
      (calls.count("rect"), clk.slept[:2]), (3, [0.015, 0.015]))

# The no-ALT-tap rule at the run level: a window that never takes focus fails without one ALT tap.
clk, calls, p = focus_env([False], raise_ret=False, force_ret=False)
p.update(_is_window=lambda h: True, _win_of=lambda h: None, act_key=REAL["act_key"],
         send_chord=lambda k: calls.append("send_chord"), resolve=lambda t, wid=None: fw)
with patched(**p):
    rc, out = run_capture(sc.run_plan, run_ns([{"key": "ctrl+t"}], title="app"))
check("run: a focus that fails sends nothing and taps no ALT", (calls.count("keybd"), calls.count("send_chord")), (0, 0))
truthy("run: FOCUS_FAILED, RUN_STOPPED, NOT_RUN: none", "FOCUS_FAILED:" in out and "RUN_STOPPED step=1/1" in out
       and out.splitlines()[-1] == "NOT_RUN: none")

# --- click_uia -----------------------------------------------------------------------

def uia_click(elements, hit=True, truncated=False, name="Save", control=None, covered_fail=False):
    env = Env()
    env.fuia.elements = elements
    env.fuia.hit = hit
    env.fuia.truncated = truncated
    order = []

    def covered(win, x, y):
        order.append("covered")

    p = dict(_lazy_module=env.lazy, focus=env.focus, _refuse_if_covered=covered,
             place_cursor=lambda x, y: order.append(("place", x, y)),
             press=lambda b, d: order.append(("press", b, d)))
    a = types.SimpleNamespace(title=None, id="4242", unlock=False, quiet=True, name=name, control=control,
                              right=False, double=False)
    with patched(**p):
        rc, out = run_capture(REAL["act_click_uia"], a)
    return env, rc, out, order


env, rc, out, order = uia_click([el("Save")])
check("click_uia: order is covered, place, covered, hit_test, press",
      order, ["covered", ("place", 200, 165), "covered", ("press", "left", False)])
check("click_uia: hit_test got the element's runtime id", env.fuia.hits, [(200, 165, (1, 2))])
check("click_uia: find was exact", env.fuia.finds, [("Save", None, True)])
truthy("click_uia: CLICKED line", "CLICKED 200,165" in out and 'CLICKED_UIA: Button "Save"' in out)
env, rc, out, order = uia_click([el("Save as"), el("&SAVE")])
check("click_uia: a substring is not a match, an accelerator marker is stripped",
      (rc, ("press", "left", False) in order), (None, True))
env, rc, out, order = uia_click([el("Save", rid=(1,)), el("Save", rid=(2,), rect=(300, 150, 400, 180))])
check("click_uia: two matches are AMBIGUOUS with CANDIDATE lines, no click",
      (rc, "\nAMBIGUOUS: " in out, out.count("\nCANDIDATE: Button \"Save\" rect="),
       any(isinstance(o, tuple) and o[0] == "press" for o in order)), (("exit", 1), True, 2, False))
env, rc, out, order = uia_click([el("Save", offscreen=True), el("Save", enabled=False),
                                 el("Save", rect=(10, 10, 10, 40)), el("Save", rect=(5000, 5000, 5100, 5100)),
                                 el("Save", rid=(9,))])
check("click_uia: offscreen, disabled, empty and out-of-window elements are skipped",
      (rc, env.fuia.hits), (None, [(200, 165, (9,))]))
env, rc, out, order = uia_click([])
check("click_uia: no match is UIA_NOT_FOUND", (rc, "\nUIA_NOT_FOUND: " in out, order), (("exit", 1), True, []))
env, rc, out, order = uia_click([el("Save")], truncated=True)
check("click_uia: a truncated tree is UIA_TRUNCATED", (rc, "\nUIA_TRUNCATED: " in out, order), (("exit", 1), True, []))
env, rc, out, order = uia_click([el("Save")], hit=False)
check("click_uia: a hit_test mismatch is CLICK_UIA_MISMATCH and presses nothing",
      (rc, "\nCLICK_UIA_MISMATCH: " in out, ("press", "left", False) in order), (("exit", 1), True, False))
env, rc, out, order = uia_click([el("Save", "Edit"), el("Save", "Button", rid=(7,))], control="Button")
check("click_uia: control is passed to find", env.fuia.finds, [("Save", "Button", True)])

# --- the coordinate click keeps its checked path ---------------------------------------

def coord_click(x, y):
    order = []
    cenv = Env()
    p = dict(focus=cenv.focus, _refuse_if_covered=lambda win, px, py: order.append("covered"),
             place_cursor=lambda px, py: order.append(("place", px, py)),
             press=lambda b, d: order.append(("press", b, d)))
    a = types.SimpleNamespace(title=None, id="4242", unlock=False, quiet=True, x=x, y=y, right=False, double=False)
    with patched(**p):
        rc, out = run_capture(REAL["act_click"], a)
    return rc, out, order


rc, out, order = coord_click(300, 300)
check("click: covered, place, covered, press", order, ["covered", ("place", 300, 300), "covered", ("press", "left", False)])
truthy("click: CLICKED line, and no advice lines when run drives it", "CLICKED 300,300" in out and "Screenshot again" not in out)
rc, out, order = coord_click(5000, 5000)
check("click outside the window: CLICK_OUTSIDE before any check", (rc, "\nCLICK_OUTSIDE: " in out, order),
      (("exit", 1), True, []))

# --- start-up and bytecode ----------------------------------------------------------

probe = ("import sys; sys.path.insert(0, %r); import screenctl; "
         "print(sorted(m for m in ('uia', 'ocr', 'dataclasses', 'platform', 'traceback', 'datetime', 'socket') "
         "if m in sys.modules))" % str(HERE))
r = subprocess.run([sys.executable, "-B", "-c", probe], capture_output=True, text=True, env=PYENV)
check("import screenctl pulls in none of uia, ocr, dataclasses, platform, traceback, datetime, socket",
      r.stdout.strip(), "[]")
pyc_before = sorted(p.name for p in (HERE / "__pycache__").glob("*")) if (HERE / "__pycache__").exists() else []
probe2 = ("import sys; sys.path.insert(0, %r); import screenctl as sc; sc._lazy_module('uia'); "
          "sc._lazy_module('ocr'); print('both')" % str(HERE))
r = subprocess.run([sys.executable, "-B", "-c", probe2], capture_output=True, text=True, env=PYENV)
pyc_after = sorted(p.name for p in (HERE / "__pycache__").glob("*")) if (HERE / "__pycache__").exists() else []
check("the lazy imports of uia and ocr work", r.stdout.strip(), "both")
check("importing screenctl, uia and ocr leaves no new __pycache__ file", pyc_after, pyc_before)

# --- the CLI ---------------------------------------------------------------------------

def cli(*args):
    r = subprocess.run([sys.executable, "-B", SCRIPT, *args], capture_output=True, text=True,
                       encoding="utf-8", env=PYENV)
    return r.returncode, r.stdout


rc, out = cli("run", "--plan", '[{"wait": {"window_gone": "zz-no-such-window-zz"}}]', "--dry-run")
check("CLI run --dry-run on a target-less plan", (rc, "DRY_RUN_OK" in out), (0, True))
rc, out = cli("run", "--plan", '[{"key": "a"}]')
check("CLI run: PLAN_INVALID exits 1", (rc, out.startswith("PLAN_INVALID: step 1: NO_TARGET")), (1, True))
rc, out = cli("run", "--dry-run")
check("CLI run without a plan is NO_PLAN, exit 1", (rc, out.startswith("NO_PLAN:")), (1, True))
rc, out = cli("run", "--plan", "[]", "--plan-file", "x")
check("CLI run with both plan flags is NO_PLAN", (rc, out.startswith("NO_PLAN:")), (1, True))
rc, out = cli("run", "--bogus-flag")
check("CLI run usage error keeps argparse's exit 2", rc, 2)
open(f"{tmp}/plan.json", "w", encoding="utf-8-sig").write('[{"sleep": 0.5}]')
rc, out = cli("run", "--plan-file", f"{tmp}/plan.json", "--dry-run")
check("CLI run --plan-file (BOM tolerated)", (rc, "DRY_RUN_OK" in out), (0, True))
rc, out = cli("run", "--plan-file", f"{tmp}/missing.json", "--dry-run")
check("CLI run --plan-file missing", (rc, out.startswith("PLAN_INVALID: step -: BAD_FILE")), (1, True))
rc, out = cli("run", "--plan", '[{"sleep": 0.5}]', "--title", "zz-no-such-window-zz", "--dry-run")
check("CLI run resolves the target read-only: NOT_FOUND", (rc, out.startswith("NOT_FOUND:")), (1, True))
rc, out = cli("key", "--title", "zz-no-such-window-zz", "--keys", "_")
check("CLI key with a punctuation character that is no key: BAD_KEY or NOT_FOUND, never a send",
      (rc, out.startswith("BAD_KEY:") or out.startswith("NOT_FOUND:")), (1, True))


# ==========================================================================
# punctuation keys, Enter look-back, run deadline, EXPECT_UNPROVABLE,
# CONTROL_IN_TYPE, the empty lock file, scroll's covered check, doctor and BUSY
# ==========================================================================

# --- a single character is a key only as [a-z0-9] or a named OEM key --------
check("parse_chord: '-' is VK_OEM_MINUS (not VK_INSERT)", sc.parse_chord("-"), [0xBD])
check("parse_chord: ctrl+- is ctrl and VK_OEM_MINUS", sc.parse_chord("ctrl+-"), [0x11, 0xBD])
check("parse_chord: '[' is VK_OEM_4 (not VK_LWIN)", sc.parse_chord("["), [0xDB])
for ch, vk in zip("-./,;=`[]\\'", (0xBD, 0xBE, 0xBF, 0xBC, 0xBA, 0xBB, 0xC0, 0xDB, 0xDD, 0xDC, 0xDE)):
    check(f"parse_chord: OEM key {ch!r}", sc.parse_chord(ch), [vk])
check("parse_chord: letters and digits keep their ASCII virtual keys", sc.parse_chord("a+Z+9"), [0x41, 0x5A, 0x39])
check("parse_chord: the named punctuation keys are unchanged", sc.parse_chord("minus+slash"), [0xBD, 0xBF])
for bad in ("_", "{", "}", "<", ">", "|", "~", chr(0xDF), chr(0xE9), chr(0x2014), "+", "ctrl+", "ctrl++", "",
            "a b", "ctrl+_", chr(0x212A), "ctrl+" + chr(0x212A), chr(0x130), chr(0xFF41)):
    try:
        sc.parse_chord(bad)
        FAILURES.append(f"parse_chord accepted {bad!r}")
    except sc.BadKey:
        pass
    except Exception as e:                                   # noqa: BLE001
        FAILURES.append(f"parse_chord({bad!r}) raised {type(e).__name__}, not BadKey")
    CHECKS += 1
try:
    sc.parse_chord(None)
    FAILURES.append("parse_chord accepted None")
except sc.BadKey:
    pass
except Exception as e:                                       # noqa: BLE001
    FAILURES.append(f"parse_chord(None) raised {type(e).__name__}, not BadKey")
CHECKS += 1
evs = []
with patched(_send=lambda e: evs.extend(e)):
    sc.send_chord("ctrl+-")
check("send_chord: ctrl+- sends ctrl and 0xBD down, then up in reverse",
      [(e.u.ki.wVk, e.u.ki.dwFlags) for e in evs],
      [(0x11, 0), (0xBD, 0), (0xBD, 2), (0x11, 2)])
evs.clear()
with patched(_send=lambda e: evs.extend(e)):
    sc.send_chord("[")
check("send_chord: '[' sends 0xDB and never VK_LWIN", sorted({e.u.ki.wVk for e in evs}), [0xDB])
for bad in ("_", "{", "<", chr(0xDF)):
    evs.clear()
    with patched(_send=lambda e: evs.extend(e)):
        rc, out = run_capture(sc.send_chord, bad)
    check(f"send_chord({bad!r}): BAD_KEY and nothing sent", (rc, out.startswith("BAD_KEY:"), evs), (("exit", 1), True, []))

# --- type refuses control characters, in the CLI path and in a plan ------------
for label, text, token in (("ESC", "a" + chr(0x1B), "CONTROL_IN_TYPE"), ("BS", chr(8), "CONTROL_IN_TYPE"),
                           ("NUL", chr(0), "CONTROL_IN_TYPE"), ("DEL", chr(0x7F), "CONTROL_IN_TYPE"),
                           ("newline then ESC", "\n" + chr(0x1B), "NEWLINE_IN_TYPE")):
    cenv = Env()
    ns = types.SimpleNamespace(title=None, id="4242", unlock=False, quiet=True, text=text)
    sent = []
    with patched(focus=cenv.focus, type_text=lambda s: sent.append(s), same_window=lambda w: True):
        rc, out = run_capture(REAL["act_type"], ns)
    check(f"act_type {label}: {token}, no focus, nothing typed",
          (rc, out.startswith(token + ":"), cenv.calls, sent), (("exit", 1), True, [], []))
cenv = Env()
sent = []
ns = types.SimpleNamespace(title=None, id="4242", unlock=False, quiet=True, text=" a" + chr(9) + "b ")
with patched(focus=cenv.focus, type_text=lambda s: sent.append(s), same_window=lambda w: True,
             _sleep=Clock().sleep):
    rc, out = run_capture(REAL["act_type"], ns)
check("act_type: spaces and TAB are typed", (rc, "".join(sent), "TYPED 5 chars" in out), (None, " a" + chr(9) + "b ", True))

# --- whitespace-only type / paste text is valid, empty is not -----------------------
env, rc, out = do_run([{"type": "   "}, {"paste": " "}])
check("whitespace-only type and paste run", (rc, env.calls.count("act_type"), env.calls.count("act_paste")), (0, 1, 1))

# --- EXPECT_UNPROVABLE -------------------------------------------------------------
env = Env()
env.fuia.truncated = True
env, rc, out = do_run([{"type": "hello", "expect": {"uia": "hello"}}, {"key": "b"}], env)
truthy("truncated pre-check: RUN_FAILED with EXPECT_UNPROVABLE",
       "RUN_FAILED step=1/2 action=type expect=uia: EXPECT_UNPROVABLE:" in out)
check("truncated pre-check: nothing sent, no STEP line, later step not run",
      (rc, env.calls.count("act_type"), "STEP 1/2" in out, "NOT_RUN: steps 2-2" in out), (1, 0, False, True))
env = Env()
env.fuia.truncated = False
env.hooks["act_type"] = lambda a: env.fuia.elements.append(el("hello", "Edit"))
env, rc, out = do_run([{"type": "hello", "expect": {"uia": "hello"}}], env)
check("complete pre-check: the step is sent and the expect passes", (rc, env.calls.count("act_type")), (0, 1))

# --- the printed cap is the run deadline; uia / ocr get the time left ----------------
env = Env()
env.hooks["act_key"] = lambda a: env.clk.sleep(10.0)                  # step 1 overruns the 3.0 s cap
env, rc, out = do_run([{"key": "a"}, {"key": "b"}], env)
lines = out.splitlines()
check("deadline: exit 1, step 2 never sent", (rc, env.calls.count("act_key")), (1, 1))
truthy("deadline: RUN_STOPPED DEADLINE names the step", "RUN_STOPPED DEADLINE step=2/2" in lines)
truthy("deadline: a DEADLINE line says it was not sent", any(ln.startswith("DEADLINE: step 2 ") and "not sent" in ln for ln in lines))
check("deadline: the step that did not start is in NOT_RUN", lines[-1], "NOT_RUN: steps 2-2")
check("deadline: a fail shot was taken and the lock released", (len(env.shots), os.path.exists(sc._lock_path())), (1, False))
check("deadline: no STEP 2 line", "STEP 2/2" in out, False)
for label, plan in (("a sleep equal to the cap", [{"sleep": 3.0}]),
                    ("a wait equal to the cap", [{"wait": {"window": "Never"}, "timeout": 0.3}])):
    env, rc, out = do_run(plan, title=None)
    check(f"deadline: {label} is not stopped by timer overhead", "DEADLINE" in out, False)
env = Env()
env.hooks["act_key"] = lambda a: env.clk.sleep(1.5)                    # each step takes exactly its cost
env, rc, out = do_run([{"key": "a"}, {"key": "b"}], env)
check("deadline: steps that take exactly their share of the cap all run", (rc, env.calls.count("act_key")), (0, 2))
env = Env()
env.hooks["act_key"] = lambda a: env.clk.sleep(1.6)                    # 0.1 s over its share: past the slack
env, rc, out = do_run([{"key": "a"}, {"key": "b"}], env)
check("deadline: a step that overran its share by more than the slack stops the next one",
      (rc, env.calls.count("act_key"), "RUN_STOPPED DEADLINE step=2/2" in out), (1, 1, True))
check("DEADLINE_GRACE is timer slack, under 0.1 s", sc.DEADLINE_GRACE < 0.1, True)
steps_cost = sc.parse_plan(json.dumps([
    {"sleep": 2}, {"wait": {"window": "x"}, "timeout": 4}, {"key": "a"},
    {"key": "a", "expect": {"title": "x"}, "timeout": 2}, {"shot": "a.png"},
    {"shot": "a.png", "no_focus": True}, {"type": "x" * 50}, {"shot": "a.png", "settle": 0},
    {"shot": "a.png", "settle": 2}, {"focus": True}]))
check("step cost: sleep, wait, sending step, expect, focusing shot, no_focus shot, type, settle 0 and 2, focus",
      [round(sc._step_cost(s), 3) for s in steps_cost],
      [2.0, 4.0, 1.5, 3.5, 1.5, 1.0, round(1.5 + 50 * 0.012, 3), 0.5, 2.5, 1.5])
check("plan_cap is the sum of the step costs (one accounting for cap and deadline)",
      round(sc.plan_cap(steps_cost), 3), round(sum(sc._step_cost(s) for s in steps_cost), 3))

# A plan of focusing shots that each take settle + 0.4 s is never stopped within its printed cap.
for n_shots, settle, took in ((12, 1.0, 1.4), (6, 1.0, 1.5), (4, 0.2, 0.6), (10, 2.0, 2.4)):
    env = Env()

    def slow_shot(a, _e=env, _took=took):
        _e.calls.append("act_shot")
        _e.shots.append(a)
        _e.clk.sleep(_took)
        print(f"SHOT: {a.out}  100x80")
        print("WINDOW_ORIGIN: 100,100    IMAGE_SCALE: 1.0000")

    plan = [{"shot": f"{tmp}/s{n}.png", "settle": settle} for n in range(n_shots)]
    env, rc, out = do_run(plan, env, {"act_shot": slow_shot})
    check(f"{n_shots} focusing shots at settle {settle} taking {took} s each: RUN_OK, none stopped",
          (rc, "DEADLINE" in out, out.splitlines()[-1].startswith(f"RUN_OK {n_shots} steps")),
          (0, False, True))
tctx = types.SimpleNamespace(step_tmo=None, deadline=None, poll_end=None)
check("uia timeout: 2 s when the step has none and no deadline", sc._tmo(tctx), 2.0)
tctx.step_tmo = 5.0
tctx.deadline = 11.2
with patched(_clock=lambda: 10.0):
    check("uia timeout: cut to the time left in the run", round(sc._tmo(tctx), 3), 1.2)
with patched(_clock=lambda: 11.1):
    check("uia timeout: never under 0.3 s", sc._tmo(tctx), 0.3)
tctx.step_tmo = 0.5
with patched(_clock=lambda: 0.0):
    check("uia timeout: not above the step's own timeout", sc._tmo(tctx), 0.5)
env = Env()
env.hooks["act_key"] = lambda a: env.fuia.elements.append(el("Saved", "Text"))
env, rc, out = do_run([{"key": "a", "expect": {"uia": "Saved"}, "timeout": 0.5}], env)
check("uia expect: the pre-check and the poll both get a timeout_s within the step's 0.5 s",
      (rc, len(env.fuia.tmos) >= 2, all(t is not None and 0.3 <= t <= 0.5 for t in env.fuia.tmos)), (0, True, True))
class FakeOcr:
    class Unavailable(Exception):
        pass

    def __init__(self):
        self.tmos = []
        self.text = ""

    def recognize_bgra(self, w, h, bgra, lang=None, timeout_s=None):
        self.tmos.append(timeout_s)
        return [{"text": self.text, "rect": (0, 0, 10, 10)}]

    def text_of(self, lines):
        return "\n".join(ln["text"] for ln in lines)


env = Env()
focr = FakeOcr()
env.lazy = lambda name: focr if name == "ocr" else env.fuia
env.hooks["act_key"] = lambda a: setattr(focr, "text", "Done saving")
env, rc, out = do_run([{"key": "a", "expect": {"ocr": "done"}, "timeout": 1.0}], env)
check("ocr expect: every recognize_bgra call gets a timeout_s within the step's 1.0 s",
      (rc, len(focr.tmos) >= 2, all(t is not None and 0.3 <= t <= 1.0 for t in focr.tmos)), (0, True, True))
env = Env()
env.fuia.elements = [el("Save")]
got = []
env.hooks["act_click_uia"] = lambda a: got.append(a.timeout_s)
env, rc, out = do_run([{"click_uia": {"name": "Save"}}], env)
check("click_uia step: timeout_s is passed to the act and is at most 2 s", (rc, len(got), 0.3 <= got[0] <= 2.0), (0, 1, True))
env, rc, out, order = uia_click([el("Save")])
check("click_uia from the CLI path: find and hit_test get the 2.0 s default", env.fuia.tmos, [2.0, 2.0])

# --- an empty lock file is a run that is still starting ------------------------------
clk2 = Clock()
open(sc._lock_path(), "w").close()
with patched(_sleep=clk2.sleep, _clock=clk2.clock):
    rc, out = run_capture(sc._refuse_if_busy)
check("empty fresh lock: BUSY after waiting about 2 s, file left alone",
      (rc, out.splitlines()[0], os.path.exists(sc._lock_path()), 1.9 <= clk2.now <= 2.2),
      (("exit", 1), "BUSY: a run (starting up) is sending input", True, True))
clk2 = Clock()
with patched(_sleep=clk2.sleep, _clock=clk2.clock):
    rc, out = run_capture(sc._acquire_run_lock)
check("empty fresh lock: a second run cannot take it", (rc, out.startswith("BUSY:"), open(sc._lock_path()).read()),
      (("exit", 1), True, ""))
clk2 = Clock()


def creator_writes(s, _c=clk2):
    _c.sleep(s)
    open(sc._lock_path(), "w").write(str(os.getppid()))


with patched(_sleep=creator_writes, _clock=clk2.clock):
    rc, out = run_capture(sc._refuse_if_busy)
check("empty lock that gets its pid while waited for: BUSY names the pid", out.splitlines()[0],
      f"BUSY: a run (pid {os.getppid()}) is sending input")
open(sc._lock_path(), "w").close()
old_t = time.time() - 700
os.utime(sc._lock_path(), (old_t, old_t))
check("empty lock older than 600 s is stale and removed", (sc._lock_holder(), os.path.exists(sc._lock_path())), (None, False))
open(sc._lock_path(), "w").write("not a pid")
check("lock with garbage content is stale and removed", (sc._lock_holder(), os.path.exists(sc._lock_path())), (None, False))
open(sc._lock_path(), "w").write(str(os.getppid()))
os.utime(sc._lock_path(), (old_t, old_t))
check("lock with a live pid but older than 600 s is stale", (sc._lock_holder(), os.path.exists(sc._lock_path())), (None, False))

# --- doctor is refused while a run sends -------------------------------------------------
open(sc._lock_path(), "w").write(str(os.getppid()))
env = Env()
old_argv = sys.argv
sys.argv = ["screenctl.py", "doctor"]
try:
    with patched(act_doctor=lambda a: env.calls.append("doctor"), **env.patches()):
        rc, out = run_capture(sc.main)
finally:
    sys.argv = old_argv
check("doctor: BUSY while a run sends, and it did not run", (out.startswith("BUSY:"), env.calls), (True, []))
os.remove(sc._lock_path())

# --- scroll has the same two covered checks as a click ---------------------------------
sw_win = sc.Win("4242", "T", 100, 100, 800, 600)
order = []
with patched(_refuse_if_covered=lambda win, x, y, what="clicked": order.append(("covered", x, y, what)),
             place_cursor=lambda x, y: order.append(("place", x, y)),
             _send=lambda evs: order.append(("send", len(evs)))):
    sc.scroll(sw_win, -3)
check("scroll: covered, place, covered, then the wheel",
      order, [("covered", 500, 400, "scrolled"), ("place", 500, 400), ("covered", 500, 400, "scrolled"), ("send", 1)])
order = []
with patched(root_window_at=lambda x, y: 77, _pid_of=lambda h: h, _title_of=lambda h: "Overlay",
             place_cursor=lambda x, y: order.append("place"), _send=lambda evs: order.append("send")):
    rc, out = run_capture(sc.scroll, sw_win, -3)
check("scroll: a window of another process on the point refuses before the pointer moves",
      (rc, out.startswith("CLICK_COVERED:"), "Nothing was scrolled." in out, order), (("exit", 1), True, True, []))
order = []
seq = iter([4242, 77])                                  # clear before the pointer moves, covered after
with patched(root_window_at=lambda x, y: next(seq), _pid_of=lambda h: h, _title_of=lambda h: "Overlay",
             place_cursor=lambda x, y: order.append("place"), _send=lambda evs: order.append("send")):
    rc, out = run_capture(sc.scroll, sw_win, -3)
check("scroll: covered after the pointer arrived refuses before the wheel", (rc, order), (("exit", 1), ["place"]))

# --- a wait that is the read-back for typed text is checked before the text is sent --------------
PASTE_PLAN = [{"paste": "/exit"}, {"wait": {"uia": "exit"}}, {"sleep": 3.0}, {"key": "enter"}]
TYPE_PLAN = [{"type": "rm -rf build"}, {"wait": {"uia": "r"}}, {"key": "enter"}]
OCR_PLAN = [{"type": "rm -rf build"}, {"wait": {"ocr": "build"}}, {"key": "ctrl+m"}]
KEYS_PLAN = [{"key": "l"}, {"key": "s"}, {"wait": {"uia": "ls"}}, {"key": "enter"}]
for label, plan, act, pre_el, post_el in (
        ("paste + uia wait", PASTE_PLAN, "act_paste", el("Exit", "MenuItem"), el("/exit", "Edit")),
        ("type + one-letter uia wait", TYPE_PLAN, "act_type", el("Terminal", "Window"), el("rm -rf build", "Edit")),
        ("single keys + uia wait", KEYS_PLAN, "act_key", el("ls output", "Text"), el("ls", "Edit"))):
    env = Env()
    env.fuia.elements = [pre_el]
    env, rc, out = do_run(plan, env)
    check(f"{label}: text already on screen stops the step before it sends",
          (rc, env.calls.count(act), env.calls.count("act_key") if act != "act_key" else 0,
           "RUN_FAILED step=1/" in out and "EXPECT_ALREADY_TRUE" in out and "the read-back wait" in out,
           "STEP 1/" in out, "NOT_RUN: steps 2-" in out), (1, 0, 0, True, False, True))
    env = Env()
    env.hooks[act] = lambda a, _e=env, _p=post_el: _e.fuia.elements.append(_p)      # absent before, there after the send
    env, rc, out = do_run(plan, env)
    check(f"{label}: passes when the text appears only after the send, Enter then sent",
          (rc, env.calls.count(act) >= 1, env.calls.count("act_key") >= 1, "RUN_OK" in out), (0, True, True, True))
env = Env()
focr = FakeOcr()
focr.text = "build output"
env.lazy = lambda name: focr if name == "ocr" else env.fuia
env, rc, out = do_run(OCR_PLAN, env)
check("type + ocr wait: text already on screen stops before the type, nothing sent",
      (rc, env.calls.count("act_type"), env.calls.count("act_key"), "action=type expect=ocr: EXPECT_ALREADY_TRUE" in out),
      (1, 0, 0, True))
env = Env()
focr = FakeOcr()
env.lazy = lambda name: focr if name == "ocr" else env.fuia
env.hooks["act_type"] = lambda a: setattr(focr, "text", "rm -rf build")
env, rc, out = do_run(OCR_PLAN, env)
check("type + ocr wait: passes when the text appears only after the type", (rc, env.calls.count("act_key")), (0, 1))
env = Env()
env.fuia.truncated = True
env, rc, out = do_run(PASTE_PLAN, env)
check("truncated UIA read before the paste: EXPECT_UNPROVABLE, nothing sent",
      (rc, env.calls.count("act_paste"), "action=paste expect=uia: EXPECT_UNPROVABLE" in out), (1, 0, True))
# A wait that only repeats the step's own verified expect is not pre-checked (the expect already is).
env = Env()
env.fuia.elements = [el("Terminal", "Window")]
env.hooks["act_type"] = lambda a: env.fuia.elements.append(el("hello", "Edit"))
env, rc, out = do_run([{"type": "hello", "expect": {"uia": "hello"}}, {"wait": {"uia": "hello"}},
                       {"key": "enter"}], env)
check("own expect verifies: the extra wait adds no pre-check", (rc, env.calls.count("act_key")), (0, 1))
# check_plan records the wait on the FIRST step of a key run.
recorded = sc.parse_plan(json.dumps(KEYS_PLAN))
with patched(_ocr_ready=lambda: (True, "en-US")):
    sc.check_plan(recorded, True)
check("check_plan: the read-back wait is recorded on the first key of the run",
      ([bool(s.get("pre_waits")) for s in recorded]), [True, False, False, False])
check("action log: a uia/ocr wait logs its text's length, never the text",
      [sc._log_desc(s) for s in sc.parse_plan(json.dumps(OCR_PLAN + TYPE_PLAN[1:2]))],
      ["type", "wait ocr (5 chars)", "key ctrl+m", "wait uia (1 chars)"])

# --- the pre-send look is funded by the step cost (and so by the printed cap) ------------------------
costed = sc.parse_plan(json.dumps([
    {"key": "a", "expect": {"uia": "x"}}, {"key": "a", "expect": {"ocr": "x"}, "timeout": 1},
    {"key": "a", "expect": {"title": "x"}, "timeout": 2}, {"click_uia": {"name": "Save"}},
    {"click_uia": {"name": "Save"}, "expect": {"title": "x"}, "timeout": 1}, {"focus": True, "expect": {"uia": "x"}, "timeout": 0.5},
    {"wait": {"uia": "x"}, "timeout": 2}]))
check("step cost with pre-send looks and the poll's last read (uia +0.6, ocr +0.75): uia expect, ocr expect, "
      "title expect, click_uia, click_uia + title, focus + uia, uia wait",
      [round(sc._step_cost(s), 3) for s in costed],
      [8.4, 4.5, 3.5, 6.1, 1.5 + 1.0 + 2 * 1.3, round(1.5 + 0.5 + 0.8 + 0.6, 3), 2.6])
paste_steps = sc.parse_plan(json.dumps(PASTE_PLAN))
sc.check_plan(paste_steps, True)
check("pre_waits are costed on the text step: paste 1.5 + uia look 2.0 + 0.3, wait 3 + 0.6, sleep 3, enter 1.5",
      [round(sc._step_cost(s), 3) for s in paste_steps], [3.8, 3.6, 3.0, 1.5])
# Inside a poll, a UIA/OCR read gets only what is left of the poll (floor 0.3 s)
_ctx = sc._Run(None, None)
_ctx.step_tmo = 3.0
_ctx.poll_end = sc._clock() + 0.5
_t_in_poll = sc._tmo(_ctx)
_ctx.poll_end = sc._clock() - 1.0
_t_late = sc._tmo(_ctx)
_ctx.poll_end = None
check("_tmo inside a poll is cut to the poll's time left, never under 0.3 s; outside a poll the step timeout",
      (0.3 <= _t_in_poll <= 0.5, _t_late, sc._tmo(_ctx)), (True, 0.3, 3.0))
check("plan_cap equals the sum of the step costs, pre-send looks included",
      round(sc.plan_cap(paste_steps), 3), round(sum(sc._step_cost(s) for s in paste_steps), 3))
env = Env()
sent_at = {}
appear = {"t": None}
n_find = {"n": 0}
plain_find = env.fuia.find


def slow_find(hwnd, text, control=None, exact=False, **kw):
    n_find["n"] += 1
    if n_find["n"] == 1:
        env.clk.sleep(1.0)                              # the pre-check of the read-back wait takes 1.0 s
    if appear["t"] is not None and env.clk.now >= appear["t"] and not env.fuia.elements:
        env.fuia.elements.append(el("/exit", "Edit"))
    return plain_find(hwnd, text, control, exact, **kw)


def slow_paste(a):
    env.clk.sleep(0.8)
    appear["t"] = env.clk.now + 2.9                      # the text shows 2.9 s after the paste
    env.calls.append("slow")


env.fuia.find = slow_find
env.hooks["act_paste"] = slow_paste
env.hooks["act_key"] = lambda a: sent_at.setdefault("enter", env.clk.now)
env, rc, out = do_run(PASTE_PLAN, env)
check("pre-send look: the read-back plan with a 1.0 s pre-check runs to RUN_OK and sends Enter",
      (rc, "DEADLINE" in out, env.calls.count("act_key"), out.splitlines()[-1].startswith("RUN_OK 4 steps")),
      (0, False, 1, True))
truthy("pre-send look: Enter went out later than a cap without the pre-send allowance (9.0 s) would have "
       "allowed (cap - 1.5 s = 7.5 s)",
       sent_at["enter"] > 7.5)
env = Env()
env, rc, out = do_run([{"click_uia": {"name": "Save"}}, {"key": "a"}], env, dry_run=True)
truthy("pre-send look: a dry run prints the cap with the click_uia allowance (6.1 + 1.5 = 7.6 s)", ", cap 7.6 s" in out)

# --- stale-lock eviction is atomic ---------------------------------------------------------------
real_alive = sc._pid_alive
n_alive = {"n": 0}


def racing_alive(pid):
    """First call: the suspect file is stale; at that moment another run replaces it with its own live lock."""
    n_alive["n"] += 1
    if n_alive["n"] == 1:
        tmp_new = sc._lock_path() + ".new"
        open(tmp_new, "w").write(str(os.getppid()))
        os.replace(tmp_new, sc._lock_path())
        return False
    return real_alive(pid)


open(sc._lock_path(), "w").write("4000000")
with patched(_pid_alive=racing_alive):
    holder = sc._lock_holder()
check("stale eviction race: the live lock another run just wrote is not deleted",
      (holder, open(sc._lock_path()).read(), [f for f in os.listdir(sc.STATE_DIR) if ".stale-" in f]),
      (os.getppid(), str(os.getppid()), []))
os.remove(sc._lock_path())
open(sc._lock_path(), "w").write("4000000")
with patched(_pid_alive=lambda pid: False):
    check("stale lock: evicted, no holder, no leftover file",
          (sc._lock_holder(), os.path.exists(sc._lock_path()), [f for f in os.listdir(sc.STATE_DIR) if ".stale-" in f]),
          (None, False, []))
check("no lock at all: no holder", sc._lock_holder(), None)


# --------------------------------------------------------------------------

_tmpdir.cleanup()
if FAILURES:
    print(f"\nFAILED {len(FAILURES)} of {CHECKS}:")
    for f in FAILURES:
        print("  " + f)
    sys.exit(1)
print(f"all {CHECKS} checks passed")
