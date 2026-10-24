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


# --------------------------------------------------------------------------

_tmpdir.cleanup()
if FAILURES:
    print(f"\nFAILED {len(FAILURES)} of {CHECKS}:")
    for f in FAILURES:
        print("  " + f)
    sys.exit(1)
print(f"all {CHECKS} checks passed")
