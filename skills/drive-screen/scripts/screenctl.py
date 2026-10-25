#!/usr/bin/env python3
"""
screenctl - deterministic screen-control primitives for a coding agent, Windows build.

One file, no third-party packages: user32/gdi32/dwmapi through ctypes. Adapted from
coleam00/skills drive-screen (MIT); the macOS and Linux backends were dropped because
they were never exercised, and the capture and clipboard paths were rewritten
(see CAPTURE and CLIPBOARD below).

The one design rule, and the reason this is a checked-in script rather than shell
improvised per run: EVERY action that sends input re-verifies the foreground window
first, and exits non-zero instead of sending. Keystrokes go wherever focus is. An
unverified send during stolen focus types into the wrong application, and by the
time anyone can see that happened, it already has.

  screenctl.py doctor                       # run this FIRST on a new machine
  screenctl.py list
  screenctl.py find   --title "myapp"
  screenctl.py focus  --title "..."
  screenctl.py shot   --title "..." --out C:/x/a.png [--no-focus]
  screenctl.py type   --title "..." --text "claude"
  screenctl.py paste  --title "..." (--file f | --text t)
  screenctl.py key    --title "..." --keys enter
  screenctl.py click  --title "..." --x 850 --y 730 [--double|--right]
  screenctl.py scroll --title "..." --amount -3
  screenctl.py run    --title "..." --plan '[{"key": "ctrl+t", "expect": {"title": "New Tab"}}]'

`run` executes a short plan (at most 30 steps, one target window) in ONE call: every
sending step goes through the same checks as the subcommand of the same name, may carry
an `expect` that is verified from text (title, UI Automation, OCR, pixel change) before
the next step, and the run stops at the first failure with a screenshot of the window.

Exit codes: 0 ok, 1 refused (not found / ambiguous / focus unconfirmed / bad input / a
run that failed or stopped). A command-line usage error (argparse) exits 2.

CAPTURE. `shot` renders the window's OWN content through PrintWindow
(PW_RENDERFULLCONTENT), never a copy of the screen region. A screen-region grab
(Graphics.CopyFromScreen, BitBlt from the screen DC) copies whatever is IN FRONT of
the target, so a covered window yields another application's private content into
the transcript, which is unsafe. The trade-off is that an
overlay sitting on top of the target is NOT in the image, so `click` verifies with
WindowFromPoint that the pixel it is about to hit belongs to the target's process,
and refuses otherwise. A screenshot no longer needs focus: `shot --no-focus` reads a
background window without touching the user's session.

CLIPBOARD. Read and written through the Win32 clipboard API in-process: exact
Unicode, no PowerShell subprocess, and a non-text clipboard (an image, files) is
detected so the restore step never overwrites it with an empty string.

Every run appends one line per action to ~/.claude/screenctl/actions.log, so a run
that went wrong is inspectable afterwards instead of being reconstructed from memory.
Set SCREENCTL_STATE_DIR to put the log, the run lock, `run`'s failure screenshots
(and autodrive's prompt screenshots) somewhere else; the smoke tests point it at a
temp folder.
"""

from __future__ import annotations

import argparse
import os
import struct
import sys
import time
import zlib

# No __pycache__ in the skill folder, also for the lazily imported uia / ocr modules.
sys.dont_write_bytecode = True

# sys.platform, not platform.system(): the latter queries WMI and imports socket,
# which cost more than the rest of start-up together. datetime, dataclasses,
# platform and traceback are imported where they are used, for the same reason.
if sys.platform != "win32":
    print("UNSUPPORTED_OS: this build of screenctl drives Windows only.")
    print("  The upstream skill (coleam00/skills, drive-screen) has macOS and X11 backends.")
    sys.exit(1)

import ctypes                          # noqa: E402
from ctypes import wintypes            # noqa: E402

STATE_DIR = (os.environ.get("SCREENCTL_STATE_DIR")
             or os.path.join(os.path.expanduser("~"), ".claude", "screenctl"))
LOG = os.path.join(STATE_DIR, "actions.log")

# Clock and sleep as module names so the tests can run the wait loops on a fake clock.
_sleep = time.sleep
_clock = time.monotonic

# Window titles routinely contain emoji and box-drawing characters. On Windows
# stdout defaults to cp1252 when redirected, and one bullet in a browser tab title
# crashes the whole command. Fix it before anything can print.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", newline="\n")
    except Exception:
        pass


def log(msg: str) -> None:
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S")      # same shape as isoformat(timespec="seconds")
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{stamp}\t{msg}\n")
    except Exception:
        pass  # logging must never be the reason an action fails


def die(code: str, msg: str, extra: list[str] | None = None, indent: str = "  ") -> None:
    """Fail with a stable, machine-readable first token, then prose.

    The caller is a language model. A failure it cannot classify is a failure it
    improvises around, and improvising around a focus failure is exactly how
    keystrokes end up in the wrong window.
    """
    log(f"FAIL {code}: {msg}")
    print(f"{code}: {msg}")
    for line in extra or []:
        print(f"{indent}{line}")
    sys.exit(1)


class Win:
    """A visible top-level window. Plain class (importing dataclasses slows start-up)."""

    __slots__ = ("id", "title", "x", "y", "w", "h")

    def __init__(self, id: str, title: str, x: int, y: int, w: int, h: int):
        self.id = id          # HWND as a decimal string: printable and comparable
        self.title = title
        self.x, self.y, self.w, self.h = x, y, w, h

    def __repr__(self) -> str:
        return (f"Win(id={self.id!r}, title={self.title!r}, x={self.x}, y={self.y}, "
                f"w={self.w}, h={self.h})")

    def __eq__(self, other) -> bool:
        return isinstance(other, Win) and (self.id, self.title, self.x, self.y, self.w, self.h) == \
            (other.id, other.title, other.x, other.y, other.w, other.h)

    __hash__ = None

    @property
    def minimized(self) -> bool:
        # Windows parks minimized windows at -32000,-32000. The geometry looks
        # perfectly valid, so a click computed from it silently goes nowhere.
        return self.x <= -30000 or self.y <= -30000

    @property
    def hwnd(self) -> int:
        return int(self.id)

    def contains(self, x: int, y: int) -> bool:
        return self.x <= x < self.x + self.w and self.y <= y < self.y + self.h

    def line(self) -> str:
        return (f"{self.id}\t{self.x},{self.y} {self.w}x{self.h}\t{self.title}"
                f"{'  [minimized]' if self.minimized else ''}")


# --------------------------------------------------------------------------
# PNG: encode our own captures, and introspect any PNG we are handed.
# --------------------------------------------------------------------------

def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))


def encode_png_bgra(w: int, h: int, bgra: bytes) -> bytes:
    """Top-down 32bpp BGRA (what a DIB section hands back) to an RGBA PNG.

    No per-pixel Python loop: the channel swap and the alpha fill are extended
    slice assignments, which run in C. Alpha is forced opaque because GDI does not
    maintain it and PrintWindow leaves it at zero for most windows, which would
    render the whole capture invisible.
    """
    n = w * h
    if len(bgra) < n * 4:
        raise ValueError(f"expected {n * 4} bytes, got {len(bgra)}")
    buf = bytearray(bgra[:n * 4])
    buf[0::4] = bgra[2:n * 4:4]
    buf[2::4] = bgra[0:n * 4:4]
    buf[3::4] = b"\xff" * n
    stride = w * 4
    raw = b"".join(b"\x00" + buf[y * stride:(y + 1) * stride] for y in range(h))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", ihdr)
            + _png_chunk(b"IDAT", zlib.compress(raw, 1)) + _png_chunk(b"IEND", b""))
    # Level 1, not 6: roughly half the encode time on a typical UI frame for a file
    # only a few percent larger. The size does not change what the image costs to read.


def _png_chunks(path: str, cap: int = 6_000_000):
    """Yield (kind, data) for the chunks of a PNG, stopping after `cap` IDAT bytes."""
    seen = 0
    with open(path, "rb") as f:
        if f.read(8) != b"\x89PNG\r\n\x1a\n":
            return
        while True:
            head = f.read(8)
            if len(head) < 8:
                return
            length, kind = struct.unpack(">I4s", head)
            data = f.read(length)
            f.read(4)                       # CRC
            yield kind, data
            if kind == b"IDAT":
                seen += length
                if seen > cap:
                    return
            if kind == b"IEND":
                return


def png_size(path: str) -> tuple[int, int]:
    """Width and height straight out of the IHDR chunk.

    The captured file is measured rather than predicted, which is what makes the
    coordinate mapping correct on a scaled display without special-casing it.
    """
    try:
        for kind, data in _png_chunks(path):
            if kind == b"IHDR":
                return struct.unpack(">II", data[:8])
            break
    except Exception:
        pass
    return (0, 0)


def looks_blank(path: str) -> bool:
    """True if the image is almost certainly one flat color.

    A capture that comes back as a wall of one color is not a screen: it is a
    window that refused to render (an exclusive-fullscreen app, a minimized
    window, a protected surface). The danger is that nothing errors, so a picture
    of nothing gets reasoned about. This decodes the PNG far enough to sample
    real pixels (8-bit, unfiltered rows, which is what this script writes and what
    the test fixtures write) and counts distinct colors. Unknown layouts return
    False: never block a capture on the checker not understanding it.
    """
    try:
        w = h = 0
        channels = 0
        idat = bytearray()
        for kind, data in _png_chunks(path):
            if kind == b"IHDR":
                w, h, depth, ctype = struct.unpack(">IIBB", data[:10])
                channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(ctype, 0)
                if depth != 8 or not channels or not w or not h:
                    return False
            elif kind == b"IDAT":
                idat += data
        if not idat:
            return False
        stride = 1 + w * channels
        raw = zlib.decompressobj().decompress(bytes(idat), stride * min(h, 2000))
        rows = len(raw) // stride
        if rows == 0:
            return False
        colors: set[bytes] = set()
        step_y = max(1, rows // 64)
        step_x = max(1, w // 64)
        px = min(3, channels)
        for y in range(0, rows, step_y):
            row = raw[y * stride:(y + 1) * stride]
            if row[0] != 0:
                return False                # filtered row: cannot judge cheaply
            for x in range(0, w, step_x):
                o = 1 + x * channels
                colors.add(bytes(row[o:o + px]))
                if len(colors) > 2:
                    return False
        return True
    except Exception:
        return False


# ==========================================================================
# Win32
# ==========================================================================

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
dwmapi = ctypes.WinDLL("dwmapi", use_last_error=True)

# MUST run before any measurement. A DPI-unaware process is handed VIRTUALIZED
# coordinates on a scaled display: window rects come back in logical pixels, a
# capture is a stretched blur, and a coordinate read off that capture maps to
# the wrong physical point. At 100% scaling nothing changes, which is exactly
# why this bug ships: it is invisible to whoever wrote it and breaks on a scaled display.
# https://learn.microsoft.com/en-us/windows/win32/hidpi/setting-the-default-dpi-awareness-for-a-process
try:
    user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    user32.SetProcessDpiAwarenessContext.restype = wintypes.BOOL
    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # PER_MONITOR_AWARE_V2
except Exception:
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass

HWND, HDC, DWORD, UINT, BOOL = (wintypes.HWND, wintypes.HDC, wintypes.DWORD,
                                wintypes.UINT, wintypes.BOOL)
WNDENUMPROC = ctypes.WINFUNCTYPE(BOOL, HWND, wintypes.LPARAM)

# Handles are 64-bit. Leaving argtypes at the ctypes default (int) works only
# because Windows keeps HWND values inside 32 bits in practice; spell them out.
user32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
user32.IsWindowVisible.argtypes = [HWND]
user32.IsIconic.argtypes = [HWND]
user32.GetWindowTextLengthW.argtypes = [HWND]
user32.GetWindowTextW.argtypes = [HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowRect.argtypes = [HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetForegroundWindow.restype = HWND
user32.SetForegroundWindow.argtypes = [HWND]
user32.SetForegroundWindow.restype = BOOL
user32.IsWindow.argtypes = [HWND]
user32.IsWindow.restype = BOOL
user32.BringWindowToTop.argtypes = [HWND]
user32.ShowWindow.argtypes = [HWND, ctypes.c_int]
user32.GetAncestor.argtypes = [HWND, UINT]
user32.GetAncestor.restype = HWND
user32.WindowFromPoint.argtypes = [wintypes.POINT]
user32.WindowFromPoint.restype = HWND
user32.GetWindowThreadProcessId.argtypes = [HWND, ctypes.POINTER(DWORD)]
user32.GetWindowThreadProcessId.restype = DWORD
user32.AttachThreadInput.argtypes = [DWORD, DWORD, BOOL]
user32.PrintWindow.argtypes = [HWND, HDC, UINT]
user32.PrintWindow.restype = BOOL
user32.GetDC.argtypes = [HWND]
user32.GetDC.restype = HDC
user32.ReleaseDC.argtypes = [HWND, HDC]
user32.OpenClipboard.argtypes = [HWND]
user32.GetClipboardData.argtypes = [UINT]
user32.GetClipboardData.restype = wintypes.HANDLE
user32.SetClipboardData.argtypes = [UINT, wintypes.HANDLE]
user32.SetClipboardData.restype = wintypes.HANDLE
user32.IsClipboardFormatAvailable.argtypes = [UINT]
user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
user32.SetCursorPos.restype = BOOL
user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
user32.GetCursorPos.restype = BOOL
user32.GetThreadDpiAwarenessContext.restype = ctypes.c_void_p
user32.GetAwarenessFromDpiAwarenessContext.argtypes = [ctypes.c_void_p]
user32.GetAwarenessFromDpiAwarenessContext.restype = ctypes.c_int
kernel32.GetCurrentThreadId.restype = DWORD
kernel32.GlobalAlloc.argtypes = [UINT, ctypes.c_size_t]
kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalSize.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalSize.restype = ctypes.c_size_t
gdi32.GdiFlush.restype = BOOL
gdi32.CreateCompatibleDC.argtypes = [HDC]
gdi32.CreateCompatibleDC.restype = HDC
gdi32.DeleteDC.argtypes = [HDC]
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.SelectObject.argtypes = [HDC, wintypes.HGDIOBJ]
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.SetStretchBltMode.argtypes = [HDC, ctypes.c_int]
gdi32.SetBrushOrgEx.argtypes = [HDC, ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
gdi32.StretchBlt.argtypes = [HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                             HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                             DWORD]
dwmapi.DwmGetWindowAttribute.argtypes = [HWND, DWORD, ctypes.c_void_p, DWORD]


class _MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", DWORD), ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT), ("dwFlags", DWORD)]


user32.MonitorFromWindow.argtypes = [HWND, DWORD]
user32.MonitorFromWindow.restype = wintypes.HMONITOR
user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(_MONITORINFO)]
user32.GetMonitorInfoW.restype = BOOL


def covers_monitor(win_rect: tuple, mon_rect: tuple) -> bool:
    """True when a window's rectangle IS its monitor's rectangle.

    That is the shape of a fullscreen app (video, presentation, game). A
    maximized window is not it: its frame overhangs the monitor by the border
    width and it stops at the taskbar, and the desktop window spans every
    monitor at once.
    """
    return tuple(win_rect) == tuple(mon_rect)


def fullscreen_foreground() -> Win | None:
    """The foreground window if it is fullscreen-sized, else None."""
    h = int(user32.GetForegroundWindow() or 0)
    if not h:
        return None
    r = wintypes.RECT()
    user32.GetWindowRect(h, ctypes.byref(r))
    mi = _MONITORINFO(cbSize=ctypes.sizeof(_MONITORINFO))
    hmon = user32.MonitorFromWindow(h, 2)                  # MONITOR_DEFAULTTONEAREST
    if not hmon or not user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
        return None
    m = mi.rcMonitor
    if covers_monitor((r.left, r.top, r.right, r.bottom), (m.left, m.top, m.right, m.bottom)):
        return Win(str(h), _title_of(h), r.left, r.top, r.right - r.left, r.bottom - r.top)
    return None


def _title_of(hwnd: int) -> str:
    n = user32.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def _cloaked(hwnd: int) -> bool:
    # Windows 10/11 keep dozens of "visible" top-level windows that are not on
    # any screen: suspended UWP apps, windows on another virtual desktop, the
    # text-input host. They carry real titles (Settings, Calculator, Mail), so
    # they make an honest title AMBIGUOUS and a focus attempt FOCUS_FAILED for a
    # window the user cannot even see. DWM flags them as cloaked.
    v = DWORD(0)
    r = dwmapi.DwmGetWindowAttribute(hwnd, 14, ctypes.byref(v), 4)  # DWMWA_CLOAKED
    return r == 0 and v.value != 0


def list_windows(include_cloaked: bool = False) -> list[Win]:
    out: list[Win] = []

    def cb(hwnd, _l):
        if user32.IsWindowVisible(hwnd) and (t := _title_of(hwnd)):
            if not include_cloaked and _cloaked(hwnd):
                return True
            r = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            w, h = r.right - r.left, r.bottom - r.top
            if w > 0 and h > 0:
                out.append(Win(str(int(hwnd)), t, r.left, r.top, w, h))
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return out


def foreground_id() -> str:
    return str(int(user32.GetForegroundWindow() or 0))


def same_window(win: Win) -> bool:
    return foreground_id() == win.id


def _pid_of(hwnd: int) -> int:
    pid = DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def root_window_at(x: int, y: int) -> int:
    """The TOP-LEVEL window that a click at screen point (x, y) would hit.

    WindowFromPoint skips hidden, disabled and click-through (WS_EX_TRANSPARENT)
    windows, so it answers the actual question: what receives this click.
    """
    h = user32.WindowFromPoint(wintypes.POINT(int(x), int(y)))
    if not h:
        return 0
    return int(user32.GetAncestor(h, 2) or h)        # GA_ROOT


def _is_window(hwnd: int) -> bool:
    return bool(user32.IsWindow(hwnd))


def raise_window(win: Win) -> bool:
    """Ask for the foreground; returns SetForegroundWindow's answer (False = refused)."""
    h = win.hwnd
    # SW_RESTORE only for a MINIMIZED window. Upstream restored unconditionally,
    # and SW_RESTORE on a maximized window un-maximizes it: focusing a maximized
    # editor shrank it to its last floating size on every action.
    if user32.IsIconic(h):
        user32.ShowWindow(h, 9)          # SW_RESTORE
    return bool(user32.SetForegroundWindow(h))


def force_foreground(win: Win) -> bool:
    # Microsoft documents SetForegroundWindow as refusable: a process may only
    # take the foreground under a specific list of conditions, one being that it
    # is attached to the thread that owns the current foreground window. Attach
    # to that thread (and the target's) for the duration of one request. This is
    # what AutoHotkey's WinActivate does, and it has no visible side effect.
    # https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow
    cur = kernel32.GetCurrentThreadId()
    tids = set()
    for h in (int(user32.GetForegroundWindow() or 0), win.hwnd):
        if h:
            t = user32.GetWindowThreadProcessId(h, None)
            if t and t != cur:
                tids.add(t)
    for t in tids:
        user32.AttachThreadInput(cur, t, True)
    try:
        if user32.IsIconic(win.hwnd):
            user32.ShowWindow(win.hwnd, 9)
        user32.BringWindowToTop(win.hwnd)
        return bool(user32.SetForegroundWindow(win.hwnd))
    finally:
        for t in tids:
            user32.AttachThreadInput(cur, t, False)


def _keybd_event(vk: int, flags: int) -> None:
    user32.keybd_event(vk, 0, flags, 0)


def unlock_foreground() -> None:
    # Last resort. A synthetic ALT tap satisfies the "received the last input
    # event" condition, but the tap itself lands in the CURRENT foreground app,
    # and in Explorer and many classic apps a bare ALT toggles the menu bar.
    # That is why the thread-attach route above runs first. `run` never uses it.
    _keybd_event(0x12, 0)                      # VK_MENU down
    _keybd_event(0x12, 0x0002)                 # VK_MENU up


# --- input -----------------------------------------------------------------
# SendInput, not SendKeys. Microsoft's own docs call SendKeys "susceptible to
# timing issues" and warn it "could yield unpredictable results" on non-US
# keyboards. It also parses its argument as a mini-language where + ^ % ~ ( )
# { } [ ] are control characters, so every literal string needs escaping and a
# miss silently sends a chord instead of text. SendInput with KEYEVENTF_UNICODE
# sends the character itself and has no grammar to get wrong.
# https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.sendkeys

class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class _UNION(ctypes.Union):
    _fields_ = [("ki", _KEYBDINPUT), ("mi", _MOUSEINPUT)]


class _INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _UNION)]


_KEYUP, _UNICODE = 0x0002, 0x0004

user32.SendInput.argtypes = [UINT, ctypes.POINTER(_INPUT), ctypes.c_int]
user32.SendInput.restype = UINT


class InputBlocked(Exception):
    """SendInput inserted fewer events than asked.

    That happens when the foreground window belongs to a process of higher
    integrity than this one (an elevated terminal, an installer) or BlockInput
    is active. The focus check still passes, because that window really is in
    front, so without this the send would be reported as a success that
    delivered nothing.
    """

VK = {"enter": 0x0D, "return": 0x0D, "tab": 0x09, "esc": 0x1B, "escape": 0x1B,
      "space": 0x20, "backspace": 0x08, "delete": 0x2E, "insert": 0x2D,
      "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
      "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
      "ctrl": 0x11, "shift": 0x10, "alt": 0x12, "win": 0x5B,
      "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75,
      "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
      # Punctuation needs naming. A bare "`" would fall through to ord() below,
      # which is right for letters and digits (VK_A really is ord('A')) and
      # wrong for everything else. Backtick is here because an editor's
      # new-terminal shortcut needs it, and because a backtick inside double
      # quotes is command substitution in most shells, so it has to be
      # spellable as a word anyway.
      "backtick": 0xC0, "grave": 0xC0, "minus": 0xBD, "equals": 0xBB,
      "comma": 0xBC, "period": 0xBE, "slash": 0xBF, "semicolon": 0xBA}


def _send(evs: list) -> None:
    arr = (_INPUT * len(evs))(*evs)
    n = user32.SendInput(len(evs), arr, ctypes.sizeof(_INPUT))
    if n != len(evs):
        raise InputBlocked(f"Windows accepted {n} of {len(evs)} input events "
                           f"(error {ctypes.get_last_error()})")


def _die_input_blocked(e: InputBlocked, sent: str = "Nothing more was sent.") -> None:
    die("INPUT_BLOCKED", str(e),
        [sent,
         "The usual cause: the target window belongs to a process running elevated",
         "(as administrator) and this one is not, so Windows drops the input (UIPI).",
         "Run the driver elevated, or drive an unelevated window."])


def _mouse_ev(flags: int, data: int = 0):
    i = _INPUT(type=0)
    i.u.mi = _MOUSEINPUT(0, 0, data & 0xFFFFFFFF, flags, 0, None)
    return i


def _key_ev(vk: int, up: bool):
    i = _INPUT(type=1)
    i.u.ki = _KEYBDINPUT(vk, 0, _KEYUP if up else 0, 0, None)
    return i


def _char_ev(unit: int, up: bool):
    # wScan is a WORD. It carries a UTF-16 CODE UNIT, not a code point.
    i = _INPUT(type=1)
    i.u.ki = _KEYBDINPUT(0, unit, _UNICODE | (_KEYUP if up else 0), 0, None)
    return i


def _utf16_units(ch: str) -> list[int]:
    """The UTF-16 code units of one character: two for anything astral.

    Passing ord(ch) straight into the 16-bit wScan field silently truncates
    every character above U+FFFF. Measured live upstream: typing a rocket
    (U+1F680) delivered U+F680, a private-use glyph, with no error and no
    warning. Everything in the Basic Multilingual Plane has one unit and was
    always fine, which is exactly why this survived.
    """
    b = ch.encode("utf-16-le")
    return [int.from_bytes(b[i:i + 2], "little") for i in range(0, len(b), 2)]


def type_text(text: str, delay: float = 0.012) -> None:
    # One character per SendInput call, with a delay between them.
    #
    # Batching the whole string into one call is faster and looks correct:
    # SendInput reports every event accepted and sets no error. The characters
    # still arrive wrong. Measured upstream on Windows 11 Notepad, sending
    # 'test+^%~(){}[] 123' as one 36-event batch produced 'test+^%~(333333333'.
    # The events reach the input queue; the receiving application cannot keep
    # up with them. 12ms matches xdotool's default and Anthropic's computer-use
    # reference implementation.
    for ch in text:
        # A surrogate pair has to reach the application as two adjacent events
        # or it is not composed back into one character, so the units of a
        # single character go out together: at most four events per call.
        evs = []
        for unit in _utf16_units(ch):
            evs += [_char_ev(unit, False), _char_ev(unit, True)]
        _send(evs)
        _sleep(delay)


class BadKey(Exception):
    """A name in a chord that is neither in VK nor a single character."""


def chord_parts(keys: str) -> list[str]:
    return [k.strip().lower() for k in keys.split("+") if k.strip()]


# A bare punctuation character is NOT its ASCII value as a virtual key ('-' as 0x2D is
# VK_INSERT, '[' is VK_LWIN, '_' is VK_SLEEP): these are the OEM keys, by name.
_OEM_VK = {"-": 0xBD, ".": 0xBE, "/": 0xBF, ",": 0xBC, ";": 0xBA, "=": 0xBB, "`": 0xC0,
           "[": 0xDB, "]": 0xDD, "\\": 0xDC, "'": 0xDE}
_KEY_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"
_OEM_CHAR = {v: k for k, v in _OEM_VK.items()}


def parse_chord(keys: str) -> list[int]:
    """Virtual-key codes of a chord; raises BadKey for anything else. No input is sent.

    A single character is a key only when it is a-z or 0-9 (VK_A really is ord('A'))
    or one of the OEM punctuation keys above; every other character is BadKey, and
    so is a chord with an empty part ('+' alone, 'ctrl+'), which names no key.
    """
    try:
        raw = keys.split("+")
        for p in raw:
            if not p.isascii():              # before lower(): U+212A (Kelvin sign) lowers to 'k'
                raise BadKey(p)
        parts = [k.strip().lower() for k in raw]
        if not parts or "" in parts:
            raise BadKey(keys)
        codes = []
        for p in parts:
            if p in VK:
                codes.append(VK[p])
            elif p in _OEM_VK:
                codes.append(_OEM_VK[p])
            elif len(p) == 1 and p in _KEY_CHARS:
                codes.append(ord(p.upper()))
            else:
                raise BadKey(p)
        return codes
    except BadKey:
        raise
    except Exception as e:                                   # noqa: BLE001
        raise BadKey(str(keys)) from e


def send_chord(keys: str) -> None:
    try:
        codes = parse_chord(keys)
    except BadKey as e:
        die("BAD_KEY", f"unknown key {e.args[0]!r} in {keys!r}",
            ["Known names: " + ", ".join(sorted(VK))])
    _send([_key_ev(c, False) for c in codes] +
          [_key_ev(c, True) for c in reversed(codes)])


def place_cursor(x: int, y: int) -> None:
    """Move the pointer and PROVE it landed. SetCursorPos clamps to the virtual
    screen and returns quietly, and a pinned cursor stays put, so the pixel the
    guard checked and the pixel that gets the button are only the same if this
    reads back the requested point."""
    user32.SetCursorPos(int(x), int(y))
    _sleep(0.12)
    p = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(p))
    if (p.x, p.y) != (int(x), int(y)):
        die("CURSOR_MOVE_FAILED", f"asked for ({x},{y}); the cursor is at ({p.x},{p.y}).",
            ["The point is off the virtual screen, or something is pinning the",
             "cursor. Nothing was clicked."])


def press(button: str = "left", double: bool = False) -> None:
    down, up = {"left": (0x0002, 0x0004), "right": (0x0008, 0x0010)}[button]
    for i in range(2 if double else 1):
        _send([_mouse_ev(down)])
        _sleep(0.06)
        _send([_mouse_ev(up)])
        if i == 0 and double:
            _sleep(0.05)


def scroll(win: Win, amount: int) -> None:
    # The wheel goes to the window under the POINTER, not to the focused
    # window. Focusing alone is not enough, and the failure is silent and
    # doubly wrong: the target does not move, and whatever the mouse happens
    # to be sitting over scrolls instead. Measured upstream: a scroll aimed at
    # a text window went to a window on a different monitor.
    # The same two covered checks as a click: the wheel goes to the window under the
    # point, so an overlay of another process there would receive the scroll instead.
    cx, cy = win.x + win.w // 2, win.y + win.h // 2
    _refuse_if_covered(win, cx, cy, what="scrolled")
    place_cursor(cx, cy)
    _refuse_if_covered(win, cx, cy, what="scrolled")
    _send([_mouse_ev(0x0800, int(amount) * 120)])          # WHEEL


# --- clipboard ---------------------------------------------------------------

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002


def _open_clipboard() -> None:
    # Another application can hold the clipboard open for a few milliseconds
    # after it writes (clipboard managers and the terminal itself do). Retry
    # briefly instead of failing on the first contended attempt.
    for _ in range(20):
        if user32.OpenClipboard(None):
            return
        _sleep(0.03)
    die("CLIPBOARD_BUSY", "another application is holding the clipboard open.",
        ["Nothing was pasted. Retry in a moment."])


def clipboard_state() -> tuple[str | None, bool]:
    """(text, has_content). text is None when the clipboard holds no text.

    The second value separates an empty clipboard from one holding an image or
    a file list: both read as "no text", and only the first may be restored by
    writing an empty string back.
    """
    _open_clipboard()
    try:
        count = user32.CountClipboardFormats()
        if not user32.IsClipboardFormatAvailable(CF_UNICODETEXT):
            return None, count > 0
        h = user32.GetClipboardData(CF_UNICODETEXT)
        if not h:
            return None, count > 0
        p = kernel32.GlobalLock(h)
        if not p:
            return None, count > 0
        try:
            size = kernel32.GlobalSize(h)
            # wstring_at stops at the first NUL; cap at the block size so a
            # block a writer forgot to terminate cannot run past its end.
            return ctypes.wstring_at(p, size // 2).split("\x00", 1)[0], True
        finally:
            kernel32.GlobalUnlock(h)
    finally:
        user32.CloseClipboard()


def get_clipboard() -> str:
    text, _ = clipboard_state()
    return text or ""


def set_clipboard(text: str) -> None:
    # CF_UNICODETEXT is CRLF by convention. Windows Terminal folds both forms to
    # CR on paste and Claude Code's input box accepts either, but a classic EDIT
    # control shows a lone LF as a box, so normalize on the way in; `paste`
    # compares normalized and says so in its success line. (Upstream had the
    # same effect: its payload went through a Python text-mode file, which
    # writes CRLF on Windows.)
    data = text.replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-16-le") + b"\x00\x00"
    _open_clipboard()
    try:
        user32.EmptyClipboard()
        h = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not h:
            die("CLIPBOARD_ALLOC", "GlobalAlloc failed")
        p = kernel32.GlobalLock(h)
        ctypes.memmove(p, data, len(data))
        kernel32.GlobalUnlock(h)
        if not user32.SetClipboardData(CF_UNICODETEXT, h):
            kernel32.GlobalFree(h)
            die("CLIPBOARD_WRITE", "SetClipboardData failed")
        # On success the system owns the block: do not free it.
    finally:
        user32.CloseClipboard()


PASTE_CHORD = "ctrl+v"


# --- capture -----------------------------------------------------------------

class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD),
                ("biCompression", DWORD), ("biSizeImage", DWORD),
                ("biXPelsPerMeter", wintypes.LONG), ("biYPelsPerMeter", wintypes.LONG),
                ("biClrUsed", DWORD), ("biClrImportant", DWORD)]


class _BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", _BITMAPINFOHEADER), ("bmiColors", DWORD * 3)]


gdi32.CreateDIBSection.argtypes = [HDC, ctypes.POINTER(_BITMAPINFO), UINT,
                                   ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, DWORD]
gdi32.CreateDIBSection.restype = wintypes.HBITMAP


class _DIB:
    """A top-down 32bpp DIB section selected into its own memory DC."""

    def __init__(self, screen_dc, w: int, h: int):
        bmi = _BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth = w
        bmi.bmiHeader.biHeight = -h          # negative = top-down rows
        bmi.bmiHeader.biPlanes = 1
        bmi.bmiHeader.biBitCount = 32
        self.bits = ctypes.c_void_p()
        self.w, self.h = w, h
        self.dc = gdi32.CreateCompatibleDC(screen_dc)
        self.bmp = gdi32.CreateDIBSection(screen_dc, ctypes.byref(bmi), 0,
                                          ctypes.byref(self.bits), None, 0)
        if not self.dc or not self.bmp:
            self.close()
            die("CAPTURE_FAILED", f"could not allocate a {w}x{h} bitmap")
        self.old = gdi32.SelectObject(self.dc, self.bmp)

    def bytes(self) -> bytes:
        # GDI batches drawing on the calling thread; CreateDIBSection's remarks
        # require a flush before the bits are read, or the buffer can be read
        # half-drawn with no error.
        gdi32.GdiFlush()
        return ctypes.string_at(self.bits, self.w * self.h * 4)

    def close(self) -> None:
        if getattr(self, "old", None):
            gdi32.SelectObject(self.dc, self.old)
        if getattr(self, "bmp", None):
            gdi32.DeleteObject(self.bmp)
        if getattr(self, "dc", None):
            gdi32.DeleteDC(self.dc)
        self.old = self.bmp = self.dc = None


def parse_region(text: str) -> tuple[int, int, int, int]:
    """'x,y,w,h' (window pixels) to a tuple; BAD_REGION when it is not four integers, w,h > 0."""
    try:
        x, y, w, h = (int(p) for p in text.replace(" ", "").split(","))
    except ValueError:
        die("BAD_REGION", f"--region wants x,y,w,h as four integers, got {text!r}")
    if w <= 0 or h <= 0:
        die("BAD_REGION", f"--region width and height must be positive, got {text!r}")
    return x, y, w, h


def region_geometry(win: Win, region, iw: int | None = None) -> dict:
    """Pure arithmetic of a region shot: REGION_OUTSIDE check, origin and scale.

    region is window-relative physical pixels (x, y, w, h). The crop is taken
    first and only then downscaled to `iw` pixels wide, so IMAGE_SCALE is
    image width over REGION width and WINDOW_ORIGIN is the window origin plus
    the region offset: the printed click arithmetic stays right.
    """
    if region is None:
        return {"x": 0, "y": 0, "w": win.w, "h": win.h, "origin": (win.x, win.y),
                "scale": (iw / win.w if (iw and win.w) else 1.0)}
    x, y, w, h = region
    if x < 0 or y < 0 or x + w > win.w or y + h > win.h:
        die("REGION_OUTSIDE", f"region {x},{y},{w},{h} is not inside the {win.w}x{win.h} window.",
            ["Regions are window-relative physical pixels: 0,0 is the window's top-left."])
    return {"x": x, "y": y, "w": w, "h": h, "origin": (win.x + x, win.y + y),
            "scale": (iw / w if iw else 1.0)}


def grab_bgra(win: Win, region=None, max_width: int = 0) -> tuple[int, int, bytes]:
    """Render the window's own content: (width, height, top-down BGRA bytes).

    PrintWindow with PW_RENDERFULLCONTENT (Windows 8.1+) asks DWM for the
    window's composed surface, so DirectX and browser windows render too, and
    the window does not have to be in front. What it cannot do is render an
    exclusive-fullscreen app or a minimized window: those come back flat, and
    act_shot says so rather than handing the picture over. Never a
    screen-region grab. `region` crops first, then `max_width` downscales.
    """
    g = region_geometry(win, region)
    rx, ry, rw, rh = g["x"], g["y"], g["w"], g["h"]
    w, h = win.w, win.h
    tw = min(rw, max_width) if max_width else rw
    th = max(1, round(rh * tw / rw))
    screen = user32.GetDC(None)
    full = small = None
    try:
        full = _DIB(screen, w, h)
        ok = user32.PrintWindow(win.hwnd, full.dc, 2)        # PW_RENDERFULLCONTENT
        if not ok:
            ok = user32.PrintWindow(win.hwnd, full.dc, 0)
        if not ok:
            die("CAPTURE_FAILED", f"PrintWindow refused {win.title!r} "
                f"(error {ctypes.get_last_error()})")
        if (tw, th, rx, ry) == (w, h, 0, 0):
            return w, h, full.bytes()
        small = _DIB(screen, tw, th)
        gdi32.SetStretchBltMode(small.dc, 4)                 # HALFTONE: averaged
        gdi32.SetBrushOrgEx(small.dc, 0, 0, None)
        gdi32.StretchBlt(small.dc, 0, 0, tw, th, full.dc, rx, ry, rw, rh, 0x00CC0020)
        return tw, th, small.bytes()
    finally:
        for d in (small, full):
            if d:
                d.close()
        user32.ReleaseDC(None, screen)


def capture(win: Win, out: str, max_width: int, region=None) -> None:
    """Render the window's own content to a PNG (see grab_bgra)."""
    tw, th, bgra = grab_bgra(win, region, max_width)
    png = encode_png_bgra(tw, th, bgra)
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    with open(out, "wb") as f:
        f.write(png)


# ==========================================================================
# Resolve, verify, act
# ==========================================================================

def resolve(title: str, wid: str | None = None) -> Win:
    """Return the ONE window matching, or refuse.

    Refusing on ambiguity is the point. Editor titles read
    '<project> - <file>', so 'myapp' also matches 'myapp-old'. Taking the
    first hit silently drives the wrong window, and that only becomes visible
    after the keystrokes have landed.

    `wid` is the escape hatch for when a title is genuinely unusable: an
    application that renames its own window to something generic mid-run, or two
    windows that really do share a name. A handle is exact and cannot drift, but
    it does not survive the window being closed and reopened, so titles stay the
    default and this is for when they stop working.
    """
    if wid:
        # An explicit handle bypasses the cloaked filter the way it bypasses
        # title matching: `list --all` printed it, so it must resolve.
        for w in list_windows(include_cloaked=True):
            if w.id == wid:
                return w
        die("NO_SUCH_ID", f"no visible window has id {wid!r}",
            ["Handles change when a window is closed and reopened.",
             "Run `screenctl.py list` for the current ones."])
    if not title:
        die("NO_TITLE", "--title (or --id) is required for this action")
    hits = [w for w in list_windows() if title.lower() in w.title.lower()]
    if not hits:
        die("NOT_FOUND", f"no visible window title contains {title!r}",
            ["Run `screenctl.py list` to see what is actually open."])
    if len(hits) > 1:
        die("AMBIGUOUS", f"{title!r} matches {len(hits)} visible windows. Refusing.",
            [w.line() for w in hits] +
            ["Pass a longer --title that matches exactly one, or pass --id with",
             "the handle from the first column above.",
             # Two windows of the same app routinely carry the SAME title, and
             # then no title is long enough to separate them.
             "--id is the only way to separate windows whose titles are equal."])
    return hits[0]


def _rect_of(hwnd: int):
    r = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return None
    return (r.left, r.top, r.right, r.bottom)


FOCUS_POLL = 0.015       # seconds between foreground checks while a switch settles
FOCUS_FLOOR = 0.15       # least time after a request before returning (see _wait_focused)


def _wait_focused(win: Win, accepted: bool, settle: float, t_request: float) -> bool:
    """True once `win` is the foreground window.

    A request SetForegroundWindow REFUSED (accepted False) gets ONE check and no
    wait: waiting out the full settle for a refusal to change its mind costs about
    half a second per switch. An accepted request is polled every 15 ms for up
    to `settle`; once the switch is seen the call still holds until FOCUS_FLOOR after the request,
    because an application restores its internal control focus while it
    activates and a keystroke sent that early can be dropped.

    A window that STARTED minimized (win.minimized) must also have left the
    parked -32000 position, with the same rectangle across two reads 15 ms
    apart, before it counts: the foreground flips before the restore finishes.
    """
    deadline = t_request + (settle if accepted else 0.0)
    prev = None
    while True:
        if same_window(win):
            if not win.minimized:
                break
            r = _rect_of(win.hwnd)
            if r is not None and r[0] > -30000 and r[1] > -30000 and r == prev:
                break
            prev = r
        if _clock() >= deadline:
            return False
        _sleep(FOCUS_POLL)
    rest = t_request + FOCUS_FLOOR - _clock()
    if rest > 0:
        _sleep(rest)
    return True


def focus(title: str, settle: float = 0.45, wid: str | None = None, unlock: bool = True) -> Win:
    """Focus, then PROVE it by comparing window IDENTITY, not title text.

    Comparing the foreground window's title against the requested substring passes
    whenever some other window happens to share that substring. Resolution above
    has already earned an exact handle, so identity is stricter and free.

    `unlock=False` (what `run` passes) drops the last-resort ALT tap: plain
    request, then the thread attach, then FOCUS_FAILED.
    """
    win = resolve(title, wid)
    if same_window(win):
        log(f"FOCUS(already) {win.title}")
        print(f"FOCUS_OK: {win.title}")
        return win

    t0 = _clock()
    if _wait_focused(win, raise_window(win), settle, t0):
        log(f"FOCUS {win.title}")
        print(f"FOCUS_OK: {win.title}")
        return resolve(title, wid)      # re-read geometry after the restore

    # Both escalations below touch whatever is in front: the thread attach
    # links this input queue to that window's thread, and the ALT tap is an
    # injected keystroke delivered to it. A fullscreen-sized foreground window
    # is an app the user is watching (a video, a presentation, a game), so
    # neither is attempted against one. Refuse instead, and say why.
    fs = fullscreen_foreground()
    if fs and fs.id != win.id:
        die("FOCUS_FAILED",
            f"wanted {win.title!r}; the foreground is a fullscreen window {fs.title!r}.",
            ["Nothing was sent, and nothing was tried against that window: no thread",
             "attach and no ALT tap, since both would deliver input to it rather",
             "than to the target.",
             "Switch it to windowed mode or close it, then retry."])

    t0 = _clock()
    if _wait_focused(win, force_foreground(win), settle, t0):
        log(f"FOCUS(attach) {win.title}")
        print(f"FOCUS_OK (after thread attach): {win.title}")
        return resolve(title, wid)

    if unlock:
        unlock_foreground()
        t0 = _clock()
        if _wait_focused(win, raise_window(win), settle, t0):
            log(f"FOCUS(unlock) {win.title}")
            print(f"FOCUS_OK (after unlock): {win.title}")
            return resolve(title, wid)

    fg = next((w for w in list_windows() if w.id == foreground_id()), None)
    die("FOCUS_FAILED",
        f"wanted {win.title!r}, foreground is {(fg.title if fg else 'unknown')!r}.",
        ["Nothing was sent.",
         "A fullscreen or exclusive-mode application (a game, a presentation, a",
         "system dialog) can hold the foreground against every request, by design.",
         "Switch it to windowed mode or close it, then retry."])
    raise AssertionError("unreachable")


# Focus is re-checked before EVERY character while typing. The check is
# GetForegroundWindow(), an in-process call costing microseconds against a 12ms
# per-character delay, so the guarantee is exact: no character is sent without
# focus having just been confirmed. `paste` has no such window: it is one
# atomic operation.
TYPE_CHUNK = 1


def _die_focus_lost(sent: int, total: int) -> None:
    fg = next((w for w in list_windows() if w.id == foreground_id()), None)
    where = f"{(fg.title if fg else 'unknown')!r}"
    die("FOCUS_LOST_MIDSEND",
        f"sent {sent} of {total} characters, then the foreground became {where}.",
        [f"All {sent} characters sent reached the target; each one was",
         "sent with focus confirmed immediately beforehand.",
         f"The remaining {total - sent} were not sent anywhere.",
         "Screenshot before retrying: re-sending the whole string would",
         "duplicate whatever already landed.",
         "For anything this long, prefer `paste`: it is one atomic operation."])


def _focus_a(a) -> Win:
    """The act functions' focus: the CLI's full escalation, or run's (no ALT tap)."""
    return focus(a.title, wid=a.id, unlock=getattr(a, "unlock", True))


def act_shot(a) -> None:
    region = getattr(a, "region", None)
    if isinstance(region, str):
        region = parse_region(region)
    if a.no_focus:
        win = resolve(a.title, a.id)
        if win.minimized:
            die("MINIMIZED", f"{win.title!r} is minimized; a minimized window renders nothing.",
                ["Drop --no-focus so `shot` restores and focuses it first."])
    else:
        win = _focus_a(a)
        _sleep(a.settle)      # let the UI settle before capturing it
    region_geometry(win, region)          # REGION_OUTSIDE before anything is rendered
    capture(win, a.out, a.max_width, region)
    iw, ih = png_size(a.out)
    if iw == 0:
        die("CAPTURE_FAILED", f"{a.out} is not a readable PNG")
    if looks_blank(a.out):
        print("WARNING: the capture is one flat color. The window did not render:")
        print("  an exclusive-fullscreen app, a minimized window, or a protected surface.")
        print("  Do not reason about this image. Fix the capture first.")
    g = region_geometry(win, region, iw)
    scale = g["scale"]
    ox, oy = g["origin"]
    log(f"SHOT {a.out} {iw}x{ih} scale={scale:.4f} win={win.title}")
    print(f"SHOT: {a.out}  {iw}x{ih}{'  (no focus change)' if a.no_focus else ''}")
    print(f"WINDOW_ORIGIN: {ox},{oy}    IMAGE_SCALE: {scale:.4f}")
    if region:
        print(f"REGION: {region[0]},{region[1]},{region[2]},{region[3]} of the window")
    print("To click what you see at image pixel (px,py), pass:")
    print(f"  --x {ox} + px/{scale:.4f}    --y {oy} + py/{scale:.4f}")
    if abs(scale - 1.0) > 0.01:
        print("  The scale is not 1. The image is not in screen pixels; divide.")
    print("The image is the window's own content: anything floating ON TOP of it")
    print("(an overlay, a topmost tool window) is not shown. `click` checks for that.")


def control_char(text: str):
    """The first character `type` must refuse: a control character other than TAB, or DEL."""
    return next((c for c in text if (ord(c) < 0x20 and c != "\t") or ord(c) == 0x7F), None)


def act_type(a) -> None:
    if "\n" in a.text or "\r" in a.text:
        die("NEWLINE_IN_TYPE", "refusing: --text contains a newline.",
            ["In a full-screen terminal UI a newline SUBMITS, so the first line",
             "would be sent as a prompt and the rest typed into whatever follows.",
             "Use `paste` for anything multi-line."])
    bad = control_char(a.text)
    if bad is not None:
        die("CONTROL_IN_TYPE", f"refusing: --text contains the control character U+{ord(bad):04X}.",
            ["Typed as Unicode input, a control character reaches some applications as",
             "Escape, Backspace or Enter. Nothing was sent. Use `key` for those."])
    win = _focus_a(a)

    # Focus is checked once, before the send. That check goes STALE while a long
    # string is still going out, because typing is a stream of separate events
    # and each one lands wherever the foreground is at that instant. Measured
    # upstream: a 200-character send with a window stealing focus 1.5s in
    # delivered 92 characters to the target, sent the other 108 somewhere else,
    # and still printed "TYPED 200 chars". So re-verify before every character
    # and stop at the first loss.
    chunks = [a.text[i:i + TYPE_CHUNK] for i in range(0, len(a.text), TYPE_CHUNK)]
    sent = 0
    for n, piece in enumerate(chunks):
        if n and not same_window(win):
            _die_focus_lost(sent, len(a.text))
        try:
            type_text(piece)
        except InputBlocked as e:
            _die_input_blocked(e, f"{sent} of {len(a.text)} characters were delivered "
                                  f"before Windows refused the rest.")
        sent += len(piece)

    _sleep(0.25)
    # The last chunk is unverified until now, so the success line below would
    # otherwise be a claim about events nobody confirmed arrived.
    if not same_window(win):
        _die_focus_lost(sent, len(a.text))

    log(f"TYPE {len(a.text)} chars into {win.title!r}")
    print(f"TYPED {len(a.text)} chars (no Enter sent)")


def norm(s: str) -> str:
    return s.replace("\r\n", "\n").rstrip("\n")


def act_paste(a) -> None:
    if a.file:
        if not os.path.exists(a.file):
            die("NO_FILE", a.file)
        payload = open(a.file, encoding="utf-8").read()
    elif a.text is not None:
        payload = a.text
    else:
        die("NO_PAYLOAD", "paste needs --file or --text")

    # Prove the target BEFORE touching the clipboard: a NOT_FOUND, AMBIGUOUS or
    # FOCUS_FAILED after the write would leave the payload on the clipboard.
    win = _focus_a(a)

    # The clipboard belongs to the human. Borrow it and give it back, on every
    # exit path: die() raises SystemExit, and the finally below runs through it.
    saved, had_content = clipboard_state()
    restore = not a.keep_clipboard and (saved is not None or not had_content)
    if saved is None and had_content and not a.keep_clipboard:
        print("CLIPBOARD_PREVIOUS_NOT_TEXT: the clipboard held an image or files,")
        print("  which this tool cannot put back. It will hold the payload afterwards.")

    try:
        set_clipboard(payload)
        _sleep(0.1)

        # Compare normalized. A round trip through the OS clipboard routinely
        # adds or drops one trailing newline, and a strict compare turns a paste
        # that would have worked into a refusal.
        if norm(get_clipboard()) != norm(payload):
            die("CLIPBOARD_MISMATCH", "the clipboard did not take the payload.",
                ["Nothing was pasted. Retry; if it repeats, another application is",
                 "rewriting the clipboard (a clipboard manager, a sync tool)."])
        if not same_window(win):
            fg = next((w for w in list_windows() if w.id == foreground_id()), None)
            die("FOCUS_LOST", f"the foreground became {(fg.title if fg else 'unknown')!r} "
                "between focusing and pasting.", ["Nothing was pasted."])
        try:
            send_chord(PASTE_CHORD)
        except InputBlocked as e:
            _die_input_blocked(e, "Nothing was pasted.")
        _sleep(0.6)
        log(f"PASTE {len(payload)} chars into {win.title!r}")
        print(f"PASTED {len(payload)} chars (line endings as CRLF; no Enter sent)")
    finally:
        if restore:
            try:
                set_clipboard(saved if saved is not None else "")
                print("CLIPBOARD_RESTORED")
            except SystemExit:
                print("CLIPBOARD_RESTORE_FAILED (the payload is still on the clipboard)")


def _refuse_if_covered(win: Win, x: int, y: int, what: str = "clicked") -> None:
    root = root_window_at(x, y)
    if not root:
        die("CLICK_COVERED", f"({x},{y}) is inside {win.title!r} but no window receives a "
            "click there (off the desktop, or a window is being destroyed).",
            [f"Nothing was {what}. Screenshot again and recompute the point."])
    if _pid_of(root) != _pid_of(win.hwnd):
        cover = _title_of(root) or f"hwnd {root}"
        die("CLICK_COVERED", f"({x},{y}) would hit {cover!r}, not {win.title!r}.",
            [f"Nothing was {what}.",
             "Something is floating on top of the target at that point (an overlay,",
             "a topmost tool window). It is not in the screenshot because the",
             "screenshot is the target's own content. Move or close it, or use keys."])


def _click_checked(a, win: Win, x: int, y: int, also_before_press=None) -> None:
    """The one click path: contains, covered check, pointer, covered check, press.

    The screenshot shows the window's own content, not what is stacked on top
    of it. Ask the OS what actually receives a click at this point; a popup,
    menu or dialog of the SAME process is fine (that is how menus work), any
    other process means an overlay is covering the target, and NO window
    means the point is off the desktop. Checked twice: once now, once after
    the pointer has provably arrived, right before the button goes down.
    `also_before_press` is an extra check `click_uia` adds after the second look.
    """
    if not win.contains(x, y):
        die("CLICK_OUTSIDE", f"({x},{y}) is outside {win.title!r} "
            f"at {win.x},{win.y} {win.w}x{win.h}.",
            ["Screenshot again and redo the WINDOW_ORIGIN / IMAGE_SCALE arithmetic."])
    _refuse_if_covered(win, x, y)
    place_cursor(x, y)
    _refuse_if_covered(win, x, y)
    if also_before_press:
        also_before_press()
    try:
        press("right" if a.right else "left", a.double)
    except InputBlocked as e:
        _die_input_blocked(e, "Nothing was clicked.")


def act_click(a) -> None:
    win = _focus_a(a)
    _click_checked(a, win, a.x, a.y)
    log(f"CLICK {a.x},{a.y} in {win.title!r}")
    print(f"CLICKED {a.x},{a.y}"
          f"{' (double)' if a.double else ''}{' (right)' if a.right else ''}")
    if not getattr(a, "quiet", False):             # advice for a CLI caller; `run` says it once
        print("Screenshot again before the next click. Any click can move the layout,")
        print("and coordinates from a stale image land somewhere else entirely.")


def act_key(a) -> None:
    win = _focus_a(a)
    try:
        send_chord(a.keys)
    except InputBlocked as e:
        _die_input_blocked(e, "The chord was not delivered.")
    if getattr(a, "delay", True):
        _sleep(0.3)
    log(f"KEY {a.keys} into {win.title!r}")
    print(f"SENT: {a.keys}")


def act_scroll(a) -> None:
    win = _focus_a(a)
    try:
        scroll(win, a.amount)
    except InputBlocked as e:
        _die_input_blocked(e, "Nothing was scrolled.")
    log(f"SCROLL {a.amount} in {win.title!r}")
    print(f"SCROLLED {a.amount}")


def _name_key(s: str) -> str:
    """Accelerator markers stripped, trimmed, case-folded: how click_uia compares names."""
    return s.replace("&", "").strip().lower()


def _lazy_module(name: str):
    """Import uia / ocr from this script's folder, only when `run` needs them."""
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    return __import__(name)


def act_click_uia(a) -> None:
    """Click the ONE UI Automation element whose NAME equals a.name (read-only tree,
    real pointer click through the same checked path as `click`)."""
    uia = _lazy_module("uia")
    win = _focus_a(a)
    try:
        found, truncated = uia.find(win.hwnd, a.name, a.control, exact=True,
                                    timeout_s=getattr(a, "timeout_s", 2.0))
    except uia.Unavailable as e:
        die("UIA_UNAVAILABLE", str(e), ["Nothing was clicked. Use a coordinate click after a screenshot."])
    if truncated:
        die("UIA_TRUNCATED", "the UI Automation tree was cut short (too large or too slow),"
            " so a missing or unique match cannot be trusted.",
            ["Nothing was clicked. Use a coordinate click after a screenshot."])
    want = _name_key(a.name)
    cands = []
    for el in found:
        l, t, r, b = el["rect"]
        cx, cy = (l + r) // 2, (t + b) // 2
        if (_name_key(el["name"]) != want or el.get("offscreen") or not el.get("enabled", True)
                or r <= l or b <= t or not win.contains(cx, cy)):
            continue
        cands.append((el, cx, cy))
    if not cands:
        die("UIA_NOT_FOUND", f"no clickable element is named {a.name!r}"
            f"{' (control ' + a.control + ')' if a.control else ''}.",
            ["Nothing was clicked. Offscreen, disabled and zero-size elements are skipped."])
    if len(cands) > 1:
        lines = [f'CANDIDATE: {el["control"]} "{el["name"]}" rect={el["rect"][0]},{el["rect"][1]},'
                 f'{el["rect"][2]},{el["rect"][3]}' for el, _, _ in cands[:10]]
        die("AMBIGUOUS", f"{a.name!r} names {len(cands)} elements. Refusing; pass `control` "
            "to separate them, or click by coordinates.", lines, indent="")
    el, cx, cy = cands[0]

    def same_element() -> None:
        try:
            hit = uia.hit_test(cx, cy, el["runtime_id"], timeout_s=getattr(a, "timeout_s", 2.0))
        except uia.Unavailable as e:
            die("UIA_UNAVAILABLE", str(e), ["Nothing was clicked."])
        if not hit:
            die("CLICK_UIA_MISMATCH", f"the element under ({cx},{cy}) is not the {el['control']}"
                f" {a.name!r} that was found.",
                ["Nothing was clicked. The layout changed between the lookup and the click."])

    _click_checked(a, win, cx, cy, also_before_press=same_element)
    log(f"CLICK_UIA {a.name!r} at {cx},{cy} in {win.title!r}")
    print(f"CLICKED {cx},{cy}{' (double)' if a.double else ''}{' (right)' if a.right else ''}")
    print(f'CLICKED_UIA: {el["control"]} "{el["name"]}"')


def act_doctor(a) -> None:
    """Prove the environment works before a run depends on it.

    Nothing here changes focus: the capture probe renders the window that is
    already in front, and the clipboard probe puts back what it found.
    """
    import platform
    print(f"os:      {platform.platform()}")
    print(f"python:  {sys.version.split()[0]}")
    print(f"log:     {LOG}")
    ok = True

    aw = user32.GetAwarenessFromDpiAwarenessContext(user32.GetThreadDpiAwarenessContext())
    print(f"dpi_awareness: {aw}   (2 = per-monitor aware, which is what we want)")
    ok &= (aw == 2)

    try:
        wins = list_windows()
        cloaked = len(list_windows(include_cloaked=True)) - len(wins)
        print(f"windows_visible: {len(wins)}   (plus {cloaked} cloaked, hidden from `list`)")
        ok &= len(wins) > 0
    except SystemExit:
        raise
    except Exception as e:
        print(f"windows_visible: FAILED ({e})")
        ok = False

    try:
        before, had = clipboard_state()
        if before is None and had:
            # An image or a file list cannot be put back, so it is not touched.
            print("clipboard_roundtrip: skipped (the clipboard holds an image or files;"
                  " not overwriting it)")
        else:
            # Non-ASCII on purpose, built from code points so the source stays
            # ASCII: an accented e, a black star, three CJK characters and an
            # astral rocket (a surrogate pair, which exercises a different path).
            probe = ("screenctl-doctor caf" + chr(0xE9) + " " + chr(0x2605) + " "
                     + chr(0x65E5) + chr(0x672C) + chr(0x8A9E) + " " + chr(0x1F680))
            set_clipboard(probe)
            rt = get_clipboard() == probe
            set_clipboard(before if before is not None else "")
            restored = "restored" if before is not None else "was empty"
            print(f"clipboard_roundtrip: {'ok' if rt else 'FAILED (text corrupted)'}  ({restored})")
            ok &= rt
    except SystemExit:
        print("clipboard_roundtrip: FAILED")
        ok = False

    # A capture of the window that is already frontmost proves the screenshot
    # path end to end without stealing focus from anything. It is whatever the
    # user has in front, which they did not name: say so, so the image is
    # deleted unread when it is not the driver's to look at.
    if a.out:
        print("screenshot probe renders the CURRENT FOREGROUND window; delete it unread")
        print("  unless the user handed over the screen.")
        try:
            fid = foreground_id()
            fw = next((w for w in list_windows() if w.id == fid), None)
            if fw:
                capture(fw, a.out, a.max_width)
                iw, ih = png_size(a.out)
                blank = looks_blank(a.out)
                print(f"screenshot: {a.out} {iw}x{ih} of {fw.title!r}"
                      f"{'  LOOKS BLANK - the window did not render' if blank else ''}")
                ok &= (iw > 0 and not blank)
            else:
                print("screenshot: skipped (no resolvable foreground window)")
        except SystemExit:
            print("screenshot: FAILED")
            ok = False

    print("DOCTOR_OK" if ok else "DOCTOR_PROBLEMS - fix the lines above before driving")
    sys.exit(0 if ok else 1)


# ==========================================================================
# run: a plan of actions, a text check after each, one tool call
# ==========================================================================
#
# Every sending step is the same code path as the subcommand of the same name
# (focus, then the act_* function), so the checks that make the CLI safe are the
# checks the plan gets: CLICK_COVERED twice, per-character focus checks in type,
# clipboard borrow-and-restore in paste, the fullscreen refusal in focus. What
# `run` adds is a whole-plan validation before the first step, a text `expect`
# after a step in place of a screenshot Read, and a stop at the first failure.

MAX_STEPS = 30
SLEEP_MAX = 3.0
RUN_CAP = 100.0                 # seconds; a plan whose worst case is longer is refused
DEFAULT_TIMEOUT = 3.0
MAX_TIMEOUT = 30.0
DEADLINE_GRACE = 0.05           # timer slack only: the cap itself funds every step (_step_cost)
RUN_LOCK_STALE = 600.0         # a lock file older than this is stale whatever its pid says

_SEND_ACTIONS = ("key", "type", "paste", "paste_file", "click", "click_uia", "scroll")
_ACTIONS = ("focus", "shot", "wait", "sleep") + _SEND_ACTIONS
_ACTION_OPTS = {"click": ("button", "double"),
                "shot": ("no_focus", "max_width", "region", "settle")}
_COND_KINDS = ("title", "window", "window_gone", "uia", "ocr", "changed", "stable")
_TARGET_KINDS = ("title", "uia", "ocr", "changed", "stable")        # these read the target window
_WINDOW_KINDS = ("window", "window_gone")


class PlanError(Exception):
    """A plan problem; `step` is the 1-based step number, or None for the whole plan."""

    def __init__(self, step, msg: str):
        super().__init__(msg)
        self.step = step


class _ExpectFailed(Exception):
    def __init__(self, reason: str, sent: bool = True, kind: str | None = None):
        super().__init__(reason)
        self.sent = sent
        self.kind = kind                # the condition kind to name, when it is not the step's own


def _bad(i, token: str, msg: str):
    raise PlanError(i, f"{token}: {msg}")


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _plan_region(i, v, what: str) -> tuple:
    if (not isinstance(v, (list, tuple)) or len(v) != 4 or not all(_is_int(n) for n in v)
            or v[2] <= 0 or v[3] <= 0):
        _bad(i, "BAD_REGION", f"{what} must be [x, y, w, h] integers with w and h above 0")
    return tuple(v)


def _text_field(i, v, what: str, payload: bool = False) -> str:
    """A text field. Names, paths and condition text must have content (strip()); a
    `payload` (what type and paste send) refuses only the empty string, because
    whitespace-only text is something a person can mean to type."""
    if not isinstance(v, str) or not (v if payload else v.strip()):
        _bad(i, "EMPTY_TEXT", f"{what} must be a non-empty string")
    return v


def _parse_cond(i, c, what: str) -> dict:
    if not isinstance(c, dict):
        _bad(i, "BAD_CONDITION", f"{what} must be an object with exactly one of "
             + ", ".join(_COND_KINDS))
    kinds = [k for k in c if k in _COND_KINDS]
    if len(kinds) != 1:
        _bad(i, "BAD_CONDITION", f"{what} needs exactly one of " + ", ".join(_COND_KINDS))
    kind = kinds[0]
    allowed = {kind}
    if kind in ("ocr", "changed", "stable"):
        allowed.add("region")
    if kind == "changed":
        allowed.add("min_fraction")
    for k in c:
        if k not in allowed:
            _bad(i, "UNKNOWN_KEY", f"{what} has the key {k!r}, which {kind!r} does not take")
    cond = {"kind": kind, "text": None, "region": None, "min_fraction": 0.005, "secs": 0.0}
    v = c[kind]
    if kind == "changed":
        if v is not True:
            _bad(i, "BAD_CONDITION", "changed takes true")
    elif kind == "stable":
        if not _is_num(v) or not 0.1 <= v <= MAX_TIMEOUT:
            _bad(i, "BAD_CONDITION", f"stable takes seconds from 0.1 to {MAX_TIMEOUT:g}")
        cond["secs"] = float(v)
    else:
        cond["text"] = _text_field(i, v, f"{what} {kind}")
    if "region" in c:
        cond["region"] = _plan_region(i, c["region"], f"{what} region")
    if "min_fraction" in c:
        f = c["min_fraction"]
        if not _is_num(f) or not 0 < f < 1:
            _bad(i, "BAD_CONDITION", "min_fraction must be a number above 0 and below 1")
        cond["min_fraction"] = float(f)
    return cond


def _default_timeout(cond: dict) -> float:
    # A stable wait of N seconds needs N seconds before it can possibly pass.
    return cond["secs"] + DEFAULT_TIMEOUT if cond["kind"] == "stable" else DEFAULT_TIMEOUT


def _parse_step(i: int, s) -> dict:
    if not isinstance(s, dict):
        _bad(i, "BAD_STEP", "a step must be a JSON object")
    acts = [k for k in s if k in _ACTIONS]
    if len(acts) > 1:
        _bad(i, "BAD_STEP", "a step has exactly one action key, got " + ", ".join(acts))
    if not acts:
        unknown = [k for k in s if k not in ("expect", "timeout")]
        _bad(i, "UNKNOWN_KEY" if unknown else "BAD_STEP",
             f"unknown key {unknown[0]!r}" if unknown else "a step needs an action key")
    action = acts[0]
    allowed = {action, "expect", "timeout"} | set(_ACTION_OPTS.get(action, ()))
    for k in s:
        if k not in allowed:
            _bad(i, "UNKNOWN_KEY", f"the key {k!r} is not valid on a {action!r} step")
    v = s[action]
    opts: dict = {}
    payload = None
    if action == "focus":
        if v is not True:
            _bad(i, "BAD_STEP", "focus takes true")
    elif action == "key":
        _text_field(i, v, "key")
        try:
            codes = parse_chord(v)
        except BadKey as e:
            _bad(i, "BAD_KEY", f"unknown key {e.args[0]!r} in {v!r}")
        if not codes:
            _bad(i, "BAD_KEY", f"{v!r} names no key")
    elif action in ("type", "paste"):
        _text_field(i, v, action, payload=True)
        if action == "type" and ("\n" in v or "\r" in v):
            _bad(i, "NEWLINE_IN_TYPE", "type refuses a newline (it can submit); use paste")
        if action == "type" and control_char(v) is not None:
            _bad(i, "CONTROL_IN_TYPE", "type refuses control characters other than TAB; use key")
        payload = v
    elif action == "paste_file":
        _text_field(i, v, "paste_file")
        try:
            with open(v, encoding="utf-8") as f:
                payload = f.read()
        except (OSError, ValueError) as e:
            _bad(i, "BAD_FILE", f"cannot read {v!r} as UTF-8 text ({type(e).__name__})")
        if not payload:
            _bad(i, "EMPTY_TEXT", f"{v!r} is empty")
    elif action == "click":
        if not isinstance(v, (list, tuple)) or len(v) != 2 or not all(_is_int(n) for n in v):
            _bad(i, "BAD_STEP", "click takes [x, y] integers")
        v = tuple(v)
        if "button" in s:
            if s["button"] not in ("left", "right"):
                _bad(i, "BAD_STEP", 'button must be "left" or "right"')
            opts["button"] = s["button"]
        if "double" in s:
            if not isinstance(s["double"], bool):
                _bad(i, "BAD_STEP", "double must be true or false")
            opts["double"] = s["double"]
    elif action == "click_uia":
        if (not isinstance(v, dict) or set(v) - {"name", "control"} or "name" not in v):
            _bad(i, "BAD_STEP", 'click_uia takes {"name": str, "control": str (optional)}')
        _text_field(i, v["name"], "click_uia name")
        if "control" in v:
            _text_field(i, v["control"], "click_uia control")
    elif action == "scroll":
        if not _is_int(v) or v == 0:
            _bad(i, "BAD_STEP", "scroll takes a non-zero integer")
    elif action == "sleep":
        if not _is_num(v) or not 0 < v <= SLEEP_MAX:
            _bad(i, "BAD_STEP", f"sleep takes seconds above 0 and at most {SLEEP_MAX:g}; prefer wait")
        v = float(v)
    elif action == "shot":
        _text_field(i, v, "shot")
        if "no_focus" in s:
            if not isinstance(s["no_focus"], bool):
                _bad(i, "BAD_STEP", "no_focus must be true or false")
            opts["no_focus"] = s["no_focus"]
        if "max_width" in s:
            if not _is_int(s["max_width"]) or s["max_width"] < 0:
                _bad(i, "BAD_STEP", "max_width must be an integer of 0 or more")
            opts["max_width"] = s["max_width"]
        if "region" in s:
            opts["region"] = _plan_region(i, s["region"], "shot region")
        if "settle" in s:
            if not _is_num(s["settle"]) or not 0 <= s["settle"] <= 2:
                _bad(i, "BAD_STEP", "settle must be seconds from 0 to 2")
            opts["settle"] = float(s["settle"])
    elif action == "wait":
        v = _parse_cond(i, v, "wait")
    expect = None
    if "expect" in s:
        if action in ("wait", "sleep", "shot"):
            _bad(i, "BAD_STEP", f"a {action!r} step takes no expect")
        expect = _parse_cond(i, s["expect"], "expect")
    timeout = None
    if "timeout" in s:
        if expect is None and action != "wait":
            _bad(i, "UNKNOWN_KEY", "timeout needs an expect (or a wait step)")
        t = s["timeout"]
        if not _is_num(t) or not 0 < t <= MAX_TIMEOUT:
            _bad(i, "BAD_TIMEOUT", f"timeout must be seconds above 0 and at most {MAX_TIMEOUT:g}")
        timeout = float(t)
    cond = v if action == "wait" else expect
    if cond is not None:
        if timeout is None:
            timeout = _default_timeout(cond)
        elif cond["kind"] == "stable" and timeout < cond["secs"]:
            _bad(i, "BAD_TIMEOUT", f"timeout {timeout:g} s is shorter than the stable time "
                 f"{cond['secs']:g} s")
    return {"i": i, "action": action, "value": v, "opts": opts, "expect": expect,
            "timeout": timeout, "payload": payload}


def parse_plan(text: str) -> list:
    import json
    try:
        raw = json.loads(text)
    except ValueError as e:
        raise PlanError(None, f"BAD_JSON: {e}")
    if not isinstance(raw, list) or not raw:
        raise PlanError(None, "BAD_PLAN: the plan must be a non-empty JSON array of steps")
    if len(raw) > MAX_STEPS:
        raise PlanError(None, f"TOO_MANY_STEPS: {len(raw)} steps; the limit is {MAX_STEPS}")
    return [_parse_step(i, s) for i, s in enumerate(raw, 1)]


def _look_cost(kind: str, t: float) -> float:
    """Seconds one pre-send look of this kind may take when it is given `t` (what _tmo hands
    it: the step's timeout or 2.0, never under 0.3): a UIA call t + 0.3 s, an OCR read
    max(0.5, t) + 0.25 s, a title read nothing worth funding."""
    t = max(0.3, t)
    if kind == "uia":
        return t + 0.3
    if kind == "ocr":
        return max(0.5, t) + 0.25
    return 0.0


_POLL_TAIL = {"uia": 0.3 + 0.3, "ocr": 0.5 + 0.25}   # floor + grace of a read cut to 0.3 s by _tmo


def _step_cost(st: dict) -> float:
    """Seconds one step may take: the ONE figure behind both the printed cap (plan_cap)
    and the run deadline (a step is not started when it no longer fits). Expect/wait
    timeout + sleep + typing + 1.5 s for a focus or a sending step; a focusing shot
    costs its settle (a maximum) + 0.5 s of capture, a no_focus shot 1.0 s. A step that
    looks before it sends (the expect's pre-check, the read-back waits check_plan recorded
    in pre_waits, the find + hit_test of click_uia) also pays for those looks."""
    a = st["action"]
    if a == "sleep":
        return st["value"]
    total = 0.0
    if st["expect"] is not None or a == "wait":
        total += st["timeout"]
        # the poll's last UIA/OCR read may start just before the timeout; _tmo cuts it to
        # what is left, so it overruns by at most its floor and grace
        kind = (st["value"] if a == "wait" else st["expect"])["kind"]
        total += _POLL_TAIL.get(kind, 0.0)
    if a == "type":
        total += len(st["value"]) * 0.012
    if a == "focus" or a in _SEND_ACTIONS:
        total += 1.5
    if a == "shot":
        total += 1.0 if st["opts"].get("no_focus") else st["opts"].get("settle", 1.0) + 0.5
    if a != "wait":
        t = st["timeout"] or 2.0
        if st["expect"] is not None:
            total += _look_cost(st["expect"]["kind"], t)
        for wc in st.get("pre_waits") or ():
            total += _look_cost(wc["kind"], t)
        if a == "click_uia":
            total += 2 * _look_cost("uia", t)
    return total


def plan_cap(steps: list) -> float:
    """Worst-case seconds of the whole plan: the sum of _step_cost."""
    return sum(_step_cost(st) for st in steps)


def _is_enter(chord: str) -> bool:
    """Enter, or the control chords a terminal reads as Enter (ctrl+m is CR, ctrl+j is LF,
    ctrl+o is readline's accept-line-and-get-next in bash)."""
    parts = chord_parts(chord)
    return any(p in ("enter", "return") for p in parts) or \
        ("ctrl" in parts and any(p in ("m", "j", "o") for p in parts))


_UNKNOWN_CHAR = "\x00"          # a character a shift chord types: which one depends on the layout


def _key_text(st: dict):
    """The text a `key` step types, else None: a chord with a printable key (a-z, 0-9, an OEM
    punctuation key, space) and no ctrl/alt/win types those keys, in order ('r+m' types
    'rm'). Under shift the character is unknown (_UNKNOWN_CHAR: no read-back text can be
    part of it, and it counts as a possible '/'). Such a step is text for the Enter check."""
    if st["action"] != "key":
        return None
    parts = chord_parts(st["value"])
    if any(p in ("ctrl", "alt", "win") for p in parts):
        return None
    out = []
    for p in parts:
        code = parse_chord(p)[0]
        if 0x30 <= code <= 0x39 or 0x41 <= code <= 0x5A:
            out.append(chr(code).lower())
        elif code == 0x20:
            out.append(" ")
        elif code in _OEM_CHAR:
            out.append(_OEM_CHAR[code])
    if not out:
        return None
    return _UNKNOWN_CHAR * len(out) if "shift" in parts else "".join(out)


def _text_of(st: dict):
    """The text a step puts into the focused field (type, paste, paste_file, a typing chord), else None."""
    if st["action"] in ("type", "paste", "paste_file"):
        return st["payload"]
    return _key_text(st)


def _ocr_ready() -> tuple:
    try:
        return _lazy_module("ocr").available()
    except Exception as e:                                   # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


def check_plan(steps: list, has_target: bool) -> float:
    """Whole-plan rules; returns the cap. Raises PlanError. Sends nothing."""
    if not has_target:
        for st in steps:
            ok = st["action"] == "sleep" or (st["action"] == "wait"
                                             and st["value"]["kind"] in _WINDOW_KINDS)
            if not ok:
                raise PlanError(st["i"], "NO_TARGET: this step needs a target window; pass "
                                "--title or --id (only wait window / window_gone and sleep "
                                "run without one)")
    clean = True            # every earlier step is a focus or a no_focus shot
    for st in steps:
        if st["action"] == "click":
            if not clean:
                raise PlanError(st["i"], "STALE_CLICK: a coordinate click is valid only when "
                                "every earlier step is a focus or a no_focus shot; read a "
                                "fresh screenshot and put the click in its own run")
        if not (st["action"] == "focus" or (st["action"] == "shot" and st["opts"].get("no_focus"))):
            clean = False
    for n, st in enumerate(steps):
        if st["action"] != "key" or not _is_enter(st["value"]):
            continue
        if _key_text(st) is not None:
            # One step that types and submits ('l+s+enter'): nothing can read the text back.
            raise PlanError(st["i"], "ENTER_UNVERIFIED: a chord that types a key and presses Enter "
                            "in one step cannot be read back; type the text first, verify it, "
                            "then send Enter as its own step")
        # Walk back to the text this Enter would submit: a type/paste/paste_file, or a run
        # of adjacent typing `key` steps (they type, so they are text too).
        # Steps that send no text (a key without Enter, a scroll, a click) do not reset
        # the check. The verified points are an expect ON the text step, or a uia/ocr `wait`
        # after it, whose text is part of the payload; an expect on a step between is
        # pre-checked after the text landed (it could only fail) and a decoy proves nothing.
        k, seen = n - 1, []
        while k >= 0:
            p = steps[k]
            if _text_of(p) is not None:
                break
            c = p["value"] if p["action"] == "wait" else None
            if c is not None and c["kind"] in ("uia", "ocr"):
                seen.append(c)
            k -= 1
        if k < 0:
            continue
        first = k
        if steps[k]["action"] == "key":
            while first > 0 and steps[first - 1]["action"] == "key" and _key_text(steps[first - 1]) is not None:
                first -= 1
            run = steps[first:k + 1]
            payload = "".join(_key_text(s) for s in run)
        else:
            run, payload = [steps[k]], steps[k]["payload"]
        own = [s["expect"] for s in run if s["expect"] and s["expect"]["kind"] in ("uia", "ocr")
               and s["expect"]["text"] and s["expect"]["text"] in payload]
        waits = [c for c in seen if c["text"] and c["text"] in payload]
        if not own and not waits:
            raise PlanError(st["i"], "ENTER_UNVERIFIED: Enter after type/paste needs that step to "
                            "carry an expect of kind uia or ocr whose text is part of what it "
                            "typed (or a uia/ocr wait after it); otherwise put Enter in a "
                            "separate run after reading a screenshot")
        if not own:
            # The read-back is a wait: it counts only if it was NOT already true before the
            # text was sent, so the run checks it before the text's first step sends.
            have = run[0].setdefault("pre_waits", [])
            have.extend(c for c in waits if not any(c is h for h in have))
        # The command menu opens on a '/' that STARTS the input: join every adjacent text step
        # back to the first one (an earlier Enter ends the input); an unknown char may be '/'.
        joined = [_text_of(steps[k])]
        j = k - 1
        while j >= 0 and not (steps[j]["action"] == "key" and _is_enter(steps[j]["value"])):
            t = _text_of(steps[j])
            if t is not None:
                joined.append(t)
            j -= 1
        if "".join(reversed(joined)).startswith(("/", _UNKNOWN_CHAR)):
            between = steps[k + 1:n]
            if not any((b["action"] == "sleep" and b["value"] >= 3.0)
                       or (b["action"] == "wait" and b["value"]["kind"] == "stable"
                           and b["value"]["secs"] >= 3.0) for b in between):
                raise PlanError(st["i"], "SLASH_WAIT: text starting with / (or with a shifted key, "
                                "which may be /) needs a sleep or a wait stable of at least 3.0 s between it and Enter (the "
                                "command menu opens late)")
    for st in steps:
        conds = [c for c in (st["expect"], st["value"] if st["action"] == "wait" else None) if c]
        if any(c["kind"] == "ocr" for c in conds):
            ok, why = _ocr_ready()
            if not ok:
                raise PlanError(st["i"], f"OCR_UNAVAILABLE: {why}")
    cap = plan_cap(steps)
    if cap > RUN_CAP:
        raise PlanError(None, f"RUN_TOO_LONG: worst case {cap:.0f} s is over the {RUN_CAP:.0f} s "
                        "limit; split the plan")
    return cap


# --- the run lock: one sending run at a time -----------------------------------

def _lock_path() -> str:
    return os.path.join(STATE_DIR, "run.lock")


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    kernel32.OpenProcess.argtypes = [DWORD, BOOL, DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(DWORD)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    h = kernel32.OpenProcess(0x1000, False, pid)          # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return ctypes.get_last_error() == 5               # access denied: it exists
    try:
        code = DWORD(0)
        return bool(kernel32.GetExitCodeProcess(h, ctypes.byref(code))) and code.value == 259
    finally:
        kernel32.CloseHandle(h)


_LOCK_STARTING = -1             # an empty lock file: its creator has not written its pid yet
LOCK_EMPTY_WAIT = 2.0           # how long an empty lock is waited for before it is a refusal


def _judge_lock(p: str):
    """(exists, holder) for the lock file at `p`: holder is a live pid, _LOCK_STARTING for an
    empty file younger than RUN_LOCK_STALE (its creator is between O_EXCL and writing its
    pid: treating it as stale would let two runs send at once), or None when stale (a
    non-empty lock with a dead or unreadable pid, or any lock older than RUN_LOCK_STALE)."""
    try:
        age = time.time() - os.stat(p).st_mtime
    except OSError:
        return False, None
    try:
        with open(p, encoding="ascii") as f:
            text = f.read().strip()
        pid = int(text) if text else _LOCK_STARTING
    except (OSError, ValueError):
        pid = 0
    if pid == _LOCK_STARTING and age < RUN_LOCK_STALE:
        return True, pid
    if pid > 0 and age < RUN_LOCK_STALE and _pid_alive(pid):
        return True, pid
    return True, None


def _lock_holder() -> int | None:
    """Pid of a live run holding the lock (or _LOCK_STARTING, see _judge_lock); None when
    there is none. A stale lock is evicted ATOMICALLY: it is renamed to a name only this
    process knows, then judged again and removed, so two processes that both found the
    same stale file cannot both delete it (one rename wins); if what was renamed turns out
    to be a live lock another run put there in between, it is renamed back."""
    p = _lock_path()
    exists, holder = _judge_lock(p)
    if holder is not None or not exists:
        return holder
    mine = f"{p}.stale-{os.getpid()}-{time.time_ns()}"
    try:
        os.replace(p, mine)
    except OSError:
        return None                          # another process evicted or replaced it first
    exists, holder = _judge_lock(mine)
    if holder is None:
        try:
            os.remove(mine)
        except OSError:
            pass
        return None
    try:
        os.rename(mine, p)                   # fails (does not overwrite) when a new lock exists
    except OSError:
        try:
            os.remove(mine)                  # a lock is at p already: this run is refused anyway
        except OSError:
            pass
    return holder


def _refuse_if_busy() -> None:
    t0 = _clock()
    pid = _lock_holder()
    while pid == _LOCK_STARTING and _clock() - t0 < LOCK_EMPTY_WAIT:     # a run is starting
        _sleep(0.05)
        pid = _lock_holder()
    if pid and pid != os.getpid():
        who = f"pid {pid}" if pid > 0 else "starting up"
        die("BUSY", f"a run ({who}) is sending input",
            ["Wait for it to finish (RUN_OK / RUN_FAILED / RUN_STOPPED) before sending anything."])


def _acquire_run_lock() -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    for _ in range(3):
        _refuse_if_busy()
        if _lock_holder() == os.getpid():
            return
        try:
            fd = os.open(_lock_path(), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            continue
        with os.fdopen(fd, "w", encoding="ascii") as f:
            f.write(str(os.getpid()))
        return
    die("BUSY", "could not take the run lock")


def _release_run_lock() -> None:
    try:
        with open(_lock_path(), encoding="ascii") as f:
            mine = f.read().strip() == str(os.getpid())
        if mine:
            os.remove(_lock_path())
    except OSError:
        pass


# --- reading the target: frames and conditions ----------------------------------

class _Run:
    """State of one run: the one target window, the window snapshot, the last matched window."""

    def __init__(self, win, snap):
        self.win = win
        self.hwnd = win.hwnd if win else None
        self.hid = win.id if win else None
        self.snap = snap
        self.matched = None
        self.deadline = None        # absolute _clock() time the run must be over by (the printed cap)
        self.step_tmo = None        # the running step's own timeout, if it has one
        self.poll_end = None        # absolute _clock() time the running poll ends, while polling


def _tmo(ctx: _Run) -> float:
    """timeout_s for a UI Automation / OCR call inside a step: the step's own timeout
    (2 s when it has none), cut to the time left in the run and, inside a poll, to the time
    left in the poll, never under 0.3 s."""
    t = ctx.step_tmo or 2.0
    if ctx.deadline is not None:
        t = min(t, ctx.deadline - _clock())
    if ctx.poll_end is not None:
        t = min(t, ctx.poll_end - _clock())
    return max(0.3, t)


def _win_of(hwnd: int):
    """The window with this handle as a fresh Win (None when it is gone)."""
    if not _is_window(hwnd):
        return None
    r = _rect_of(hwnd)
    if r is None:
        return None
    return Win(str(hwnd), _title_of(hwnd), r[0], r[1], r[2] - r[0], r[3] - r[1])


def _read_frame(ctx: _Run, region):
    win = _win_of(ctx.hwnd)
    if win is None:
        die("NO_SUCH_ID", f"window {ctx.hid} is gone.", ["Handles change when a window is closed and reopened."])
    if win.minimized:
        raise _ExpectFailed("the window is minimized; nothing renders to read")
    return grab_bgra(win, region, 0)


def frame_sig(w: int, h: int, bgra: bytes, step: int = 8) -> tuple:
    """Every 8th pixel in x and y of a BGRA frame, as one bytes object per sampled row."""
    mv = memoryview(bgra).cast("I")
    return (w, h, [mv[y * w:(y + 1) * w:step].tobytes() for y in range(0, h, step)])


def sig_diff(a: tuple, b: tuple) -> float:
    """Fraction of sampled pixels whose color differs (alpha ignored); 1.0 if the size changed."""
    if a[:2] != b[:2]:
        return 1.0
    total = diff = 0
    for ra, rb in zip(a[2], b[2]):
        n = len(ra) // 4
        total += n
        if ra != rb:
            ua, ub = struct.unpack(f"<{n}I", ra), struct.unpack(f"<{n}I", rb)
            diff += sum(1 for p, q in zip(ua, ub) if (p ^ q) & 0xFFFFFF)
    return diff / total if total else 0.0


def _quote(cond: dict) -> str:
    if cond["kind"] == "stable":
        return f"stable {cond['secs']:g}"
    if cond["text"] is not None:
        return f'{cond["kind"]} "{cond["text"]}"'
    return cond["kind"]


def _cond_check(ctx: _Run, cond: dict, state: dict) -> tuple:
    """One look at a condition: (true now, why not). `state` carries baselines between looks."""
    k, text = cond["kind"], cond["text"]
    if k == "title":
        t = _title_of(ctx.hwnd)
        return text.lower() in t.lower(), f'the title is "{t}", which does not contain "{text}"'
    if k in _WINDOW_KINDS:
        hits = [w for w in list_windows() if text.lower() in w.title.lower()]
        if k == "window_gone":
            return not hits, f'a visible window title still contains "{text}"'
        hits = [w for w in hits if w.id not in (ctx.snap or ())]
        if len(hits) > 1:
            die("AMBIGUOUS", f"{len(hits)} windows that did not exist when the run started match "
                f"{text!r}. Refusing.", ["CANDIDATE: " + w.line() for w in hits[:10]], indent="")
        if hits:
            ctx.matched = hits[0]
            return True, ""
        return False, f'no window opened since the run started has a title containing "{text}"'
    if k == "uia":
        uia = _lazy_module("uia")
        try:
            found, truncated = uia.find(ctx.hwnd, text, timeout_s=_tmo(ctx))
        except uia.Unavailable as e:
            raise _ExpectFailed(f"UI Automation unavailable: {e}")
        state["truncated"] = truncated
        return bool(found), (f'no element contains "{text}"'
                             + (" (the UI Automation tree was cut short)" if truncated else ""))
    if k == "ocr":
        ocr = _lazy_module("ocr")
        w, h, bgra = _read_frame(ctx, cond["region"])
        try:
            lines = ocr.recognize_bgra(w, h, bgra, timeout_s=_tmo(ctx))
        except (ocr.Unavailable, ValueError) as e:
            raise _ExpectFailed(f"OCR failed: {e}")
        got = " ".join(ocr.text_of(lines).split()).lower()
        return " ".join(text.split()).lower() in got, f'the OCR text does not contain "{text}"'
    w, h, bgra = _read_frame(ctx, cond["region"])
    sig = frame_sig(w, h, bgra)
    if k == "changed":
        if state.get("base") is None:
            state["base"] = sig                  # a `wait` takes its baseline at its first look
            return False, "the window has not changed"
        d = sig_diff(sig, state["base"])
        return d > cond["min_fraction"], (f"the window changed by {d * 100:.2f}% of sampled "
                                          f"pixels; needs more than {cond['min_fraction'] * 100:.2f}%")
    # stable: identical samples, held for cond["secs"]
    now = _clock()
    if state.get("last") is None or sig_diff(sig, state["last"]) > 0:
        state["last"], state["since"] = sig, now
        return False, "the window kept changing"
    return now - state["since"] >= cond["secs"], "the window kept changing"


def _poll(ctx: _Run, cond: dict, timeout: float, state: dict) -> tuple:
    """Look every 100 ms (OCR 300 ms) until true or `timeout`: (ok, why not, seconds)."""
    t0 = _clock()
    interval = 0.3 if cond["kind"] == "ocr" else 0.1
    ctx.poll_end = t0 + timeout     # a read started late gets only what is left (_tmo)
    try:
        while True:
            ok, why = _cond_check(ctx, cond, state)
            elapsed = _clock() - t0
            if ok:
                return True, "", elapsed
            if elapsed >= timeout:
                return False, why, elapsed
            _sleep(max(0.0, min(interval, timeout - elapsed)))
    finally:
        ctx.poll_end = None


# --- one step ------------------------------------------------------------------

def _step_ns(ctx: _Run, **kw):
    import types
    return types.SimpleNamespace(title=None, id=ctx.hid, unlock=False, quiet=True, **kw)


def _do_action(ctx: _Run, st: dict) -> None:
    a, v, o = st["action"], st["value"], st["opts"]
    if a == "key":
        act_key(_step_ns(ctx, keys=v, delay=st["expect"] is None))     # an expect replaces the 0.3 s
    elif a == "type":
        act_type(_step_ns(ctx, text=v))
    elif a in ("paste", "paste_file"):
        act_paste(_step_ns(ctx, text=st["payload"], file=None, keep_clipboard=False))
    elif a == "click":
        act_click(_step_ns(ctx, x=v[0], y=v[1], right=o.get("button") == "right",
                           double=bool(o.get("double"))))
    elif a == "click_uia":
        act_click_uia(_step_ns(ctx, name=v["name"], control=v.get("control"),
                               right=False, double=False, timeout_s=_tmo(ctx)))
    elif a == "scroll":
        act_scroll(_step_ns(ctx, amount=v))
    elif a == "shot":
        act_shot(_step_ns(ctx, out=v, no_focus=bool(o.get("no_focus")),
                          max_width=o.get("max_width", 1280), region=o.get("region"),
                          settle=o.get("settle", 1.0)))


def _precheck(ctx: _Run, cond: dict, what: str) -> None:
    """Look at a condition BEFORE the step sends: true already proves nothing, and a cut-short
    UIA read cannot say it is absent. Raises _ExpectFailed with sent=False."""
    pre: dict = {}
    try:
        already, _ = _cond_check(ctx, cond, pre)
    except _ExpectFailed as e:
        e.sent, e.kind = False, cond["kind"]
        raise
    if already:
        raise _ExpectFailed(f"EXPECT_ALREADY_TRUE: {what} was true before the step "
                            "sent anything, so it proves nothing; nothing was sent for "
                            "this step. Rewrite " + ("the expect." if what == "the expect"
                                                     else "the plan so the text is absent first."),
                            sent=False, kind=cond["kind"])
    if pre.get("truncated"):
        raise _ExpectFailed("EXPECT_UNPROVABLE: the UI Automation tree was cut short before "
                            f"the step, so 'not there yet' cannot be trusted and {what} "
                            "could pass on text that was already on screen; nothing was "
                            "sent for this step. Use a smaller target or an ocr expect.",
                            sent=False, kind=cond["kind"])


def _exec_step(ctx: _Run, st: dict) -> dict:
    """Run one step: focus, pre-check, baseline, act, expect. Prints into the caller's
    capture. Raises _ExpectFailed for a failed or void expect, SystemExit via die()."""
    a, ex = st["action"], st["expect"]
    res = {"act_secs": 0.0, "expect_secs": None, "cond": None}
    ctx.step_tmo = st["timeout"]
    t0 = _clock()
    if a == "sleep":
        _sleep(st["value"])
        res["act_secs"] = _clock() - t0
        return res
    cond = st["value"] if a == "wait" else None
    if ctx.hwnd is not None and (a != "wait" or cond["kind"] in _TARGET_KINDS):
        if not _is_window(ctx.hwnd):
            die("NO_SUCH_ID", f"window {ctx.hid} is gone.",
                ["Handles change when a window is closed and reopened."])
    if a == "wait":
        ok, why, secs = _poll(ctx, cond, st["timeout"], {})
        res.update(act_secs=secs, cond=cond)
        if not ok:
            raise _ExpectFailed(f"{why} after {st['timeout']:.1f} s")
        return res
    if a == "focus" or a in _SEND_ACTIONS:
        ctx.win = focus(None, wid=ctx.hid, unlock=False)
    state: dict = {}
    for wc in st.get("pre_waits") or ():          # a later wait is this text's read-back (check_plan)
        _precheck(ctx, wc, "the read-back wait " + _quote(wc))
    if ex is not None:
        if ex["kind"] in ("title", "uia", "ocr"):
            _precheck(ctx, ex, "the expect")
        elif ex["kind"] == "changed":
            w, h, bgra = _read_frame(ctx, ex["region"])
            state["base"] = frame_sig(w, h, bgra)
    if a != "focus":
        _do_action(ctx, st)
    res["act_secs"] = _clock() - t0
    if ex is not None:
        ok, why, secs = _poll(ctx, ex, st["timeout"], state)
        res.update(expect_secs=secs, cond=ex)
        if not ok:
            raise _ExpectFailed(f"{why} after {st['timeout']:.1f} s")
    return res


def _desc(st: dict) -> str:
    a, v, o = st["action"], st["value"], st["opts"]
    if a == "key":
        return f"key {v}"
    if a == "click":
        return f"click {v[0]},{v[1]}" + (" double" if o.get("double") else "") + \
            (" right" if o.get("button") == "right" else "")
    if a == "click_uia":
        return f'click_uia "{v["name"]}"'
    if a == "scroll":
        return f"scroll {v}"
    if a == "shot":
        return f"shot {v}"
    if a == "wait":
        return f"wait {_quote(v)}"
    if a == "sleep":
        return f"sleep {v:g}"
    return a


def _log_desc(st: dict) -> str:
    """_desc for actions.log: a uia/ocr wait is often the read-back of typed text, so it logs
    the text's length only, as TYPE and PASTE log a count."""
    v = st["value"]
    if st["action"] == "wait" and v["kind"] in ("uia", "ocr") and v.get("text") is not None:
        return f'wait {v["kind"]} ({len(v["text"])} chars)'
    return _desc(st)


def _join_lines(text: str) -> list:
    out: list = []
    for ln in text.splitlines():
        if ln.strip() and (not out or out[-1] != ln.strip()):      # run's pre-focus and the act's repeat
            out.append(ln.strip())
    return out


def _fail_shot(ctx: _Run, path: str) -> None:
    """The window's own content (PrintWindow, never a screen grab), without re-focusing."""
    import contextlib
    import io
    if ctx.hwnd is None:
        print("FAIL_SHOT: skipped (this run has no target window)")
        return
    win = _win_of(ctx.hwnd)
    if win is None:
        print("FAIL_SHOT: skipped (the window is gone)")
        return
    if win.minimized:
        print("FAIL_SHOT: skipped (the window is minimized)")
        return
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            act_shot(_step_ns(ctx, out=path, no_focus=True, max_width=1280, region=None, settle=0))
    except SystemExit:
        first = buf.getvalue().strip().splitlines()[:1]
        print(f"FAIL_SHOT: skipped ({first[0] if first else 'capture refused'})")
        return
    warn = False
    for ln in buf.getvalue().splitlines():
        if ln.startswith("SHOT: "):
            print("FAIL_SHOT: " + ln[6:].replace("  (no focus change)", ""))
        elif ln.startswith("WINDOW_ORIGIN:"):
            print(ln)
        elif ln.startswith("WARNING"):
            warn = True
            print(ln)
        elif warn and ln.startswith("  "):
            print(ln)
        elif ln.startswith("To click"):
            warn = False


def run_plan(a) -> int:
    """`screenctl.py run`: returns the exit code. Output contract: SKILL.md / the module doc."""
    import contextlib
    import io
    if bool(a.plan) == bool(a.plan_file):
        die("NO_PLAN", "run needs exactly one of --plan or --plan-file")
    text = a.plan
    if a.plan_file:
        try:
            with open(a.plan_file, encoding="utf-8-sig") as f:
                text = f.read()
        except (OSError, ValueError) as e:
            print(f"PLAN_INVALID: step -: BAD_FILE: cannot read the plan file ({type(e).__name__})")
            return 1
    has_target = bool(a.title or a.id)
    try:
        steps = parse_plan(text)
        cap = check_plan(steps, has_target)
    except PlanError as e:
        print(f"PLAN_INVALID: step {e.step if e.step else '-'}: {e}")
        log(f"PLAN_INVALID step={e.step}: {e}")
        return 1
    n = len(steps)
    win = resolve(a.title, a.id) if has_target else None            # NOT_FOUND / AMBIGUOUS refuse here
    head = (f"RUN: {n} steps, target {win.line()}, cap {cap:.1f} s" if win
            else f"RUN: {n} steps, no target (waits only), cap {cap:.1f} s")
    if a.dry_run:
        print(head)
        for st in steps:
            print(f"STEP {st['i']}/{n} {_desc(st)}"
                  + (f" | expect {_quote(st['expect'])} within {st['timeout']:g} s" if st["expect"] else ""))
        print("DRY_RUN_OK: validated; nothing was focused, sent or captured")
        return 0
    uses_window = any(c and c["kind"] in _WINDOW_KINDS for st in steps
                      for c in (st["expect"], st["value"] if st["action"] == "wait" else None))
    snap = {w.id for w in list_windows()} if uses_window else None
    ctx = _Run(win, snap)
    fail_path = a.fail_shot or os.path.join(STATE_DIR, "run", f"fail-{os.getpid()}.png")
    _acquire_run_lock()                       # BUSY here means another run is sending: no RUN line
    print(head)
    t_run = _clock()
    ctx.deadline = t_run + cap                # the printed cap IS the run deadline
    log(f"RUN start {n} steps target={win.title!r}" if win else f"RUN start {n} steps no target")
    try:
        for st in steps:
            i = st["i"]
            need = _step_cost(st)
            left = ctx.deadline - _clock()
            if need > left + DEADLINE_GRACE:  # not started: nothing of this step was sent
                print(f"DEADLINE: step {i} may need {need:.1f} s and {max(0.0, left):.1f} s of the "
                      f"{cap:.1f} s cap are left. It was not sent.")
                print(f"RUN_STOPPED DEADLINE step={i}/{n}")
                _fail_shot(ctx, fail_path)
                print(f"NOT_RUN: steps {i}-{n}")
                log(f"RUN end deadline before step {i}/{n}")
                return 1
            buf = io.StringIO()
            outcome, res, err = "ok", None, None
            try:
                with contextlib.redirect_stdout(buf):
                    res = _exec_step(ctx, st)
            except SystemExit:
                outcome = "stopped"
            except _ExpectFailed as e:
                outcome, err = "failed", e
            except Exception as e:                                  # noqa: BLE001
                import traceback
                outcome, err = "internal", e
                log("FAIL INTERNAL_ERROR: " + traceback.format_exc().rstrip().replace("\n", " | "))
            lines = _join_lines(buf.getvalue())
            d = _desc(st)
            if outcome == "ok":
                secs = f"({res['act_secs']:.2f} s)"
                if st["action"] == "shot":
                    print(f"STEP {i}/{n} OK {d} {secs}")
                    for ln in buf.getvalue().splitlines():
                        print(ln)
                else:
                    parts = [f"STEP {i}/{n} OK {d} {secs}"] + lines
                    if res["expect_secs"] is not None and st["action"] != "wait":
                        parts.append(f"expect {_quote(res['cond'])} ok ({res['expect_secs']:.2f} s)")
                    print(" | ".join(parts))
                if res["cond"] and res["cond"]["kind"] == "window" and ctx.matched:
                    print("WINDOW: " + ctx.matched.line())
                log(f"RUN_STEP {i}/{n} OK {_log_desc(st)}")
                continue
            if outcome == "failed":
                if err.sent and st["action"] not in ("wait", "sleep"):
                    print(" | ".join([f"STEP {i}/{n} SENT {d}"] + lines))
                cond = st["value"] if st["action"] == "wait" else st["expect"]
                kind = err.kind or (cond["kind"] if cond else "?")
                print(f"RUN_FAILED step={i}/{n} action={st['action']} expect={kind}: {err}")
            elif outcome == "stopped":
                text_out = buf.getvalue().rstrip("\n")
                if text_out:
                    print(text_out)
                print(f"RUN_STOPPED step={i}/{n}")
            else:
                if lines:
                    print(" | ".join(lines))
                print(f"INTERNAL_ERROR: {type(err).__name__}: {err}")
                print(f"  The traceback was appended to {LOG}.")
                print(f"RUN_STOPPED step={i}/{n}")
            _fail_shot(ctx, fail_path)
            print(f"NOT_RUN: steps {i + 1}-{n}" if i < n else "NOT_RUN: none")
            log(f"RUN end {outcome} at step {i}/{n}")
            return 1
        print(f"RUN_OK {n} steps in {_clock() - t_run:.2f} s")
        log(f"RUN end ok {n} steps")
        return 0
    finally:
        _release_run_lock()


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", choices=["doctor", "list", "find", "focus", "shot",
                                       "type", "paste", "key", "click", "scroll", "run"])
    ap.add_argument("--title")
    ap.add_argument("--id", help="target a window by handle from `list`, for when a "
                                 "title is ambiguous or the app renames its own window")
    ap.add_argument("--text")
    ap.add_argument("--file")
    ap.add_argument("--keys")
    ap.add_argument("--out")
    ap.add_argument("--x", type=int)
    ap.add_argument("--y", type=int)
    ap.add_argument("--amount", type=int, default=-3)
    ap.add_argument("--settle", type=float, default=1.0,
                    help="seconds to wait after focusing before capturing, so the "
                         "UI has finished animating. Anthropic's own reference "
                         "implementation hardcodes 2.0s for the same reason.")
    ap.add_argument("--max-width", type=int, default=1280,
                    help="downscale the capture to this width (0 = native). "
                         "Anthropic's computer-use guidance puts accuracy 'consistently "
                         "poor' above roughly this size, and a native-resolution window "
                         "costs several times the tokens to read no better.")
    ap.add_argument("--no-focus", action="store_true",
                    help="for shot: capture the window's content without focusing it")
    ap.add_argument("--all", action="store_true",
                    help="for list: include cloaked (off-screen, suspended) windows")
    ap.add_argument("--double", action="store_true")
    ap.add_argument("--right", action="store_true")
    ap.add_argument("--keep-clipboard", action="store_true",
                    help="do not restore the user's clipboard after a paste")
    ap.add_argument("--region", help="for shot: x,y,w,h in window pixels (relative to the "
                                     "window's top-left, physical); crop first, then downscale")
    ap.add_argument("--plan", help="for run: the plan as inline JSON (an array of steps)")
    ap.add_argument("--plan-file", help="for run: read the plan from a file (long payloads)")
    ap.add_argument("--fail-shot", help="for run: where the failure screenshot goes "
                                        "(default <state dir>/run/fail-<pid>.png; the state dir is "
                                        "~/.claude/screenctl unless SCREENCTL_STATE_DIR is set)")
    ap.add_argument("--dry-run", action="store_true",
                    help="for run: validate and print the steps; focus, send and capture nothing")
    a = ap.parse_args()

    # A run owns the keyboard and mouse for its whole life: anything else that sends
    # input or moves focus waits for it (read-only subcommands ignore the lock).
    if a.action in ("doctor", "focus", "type", "paste", "key", "click", "scroll") or \
            (a.action == "shot" and not a.no_focus):
        _refuse_if_busy()

    if a.action == "run":
        return run_plan(a)
    if a.action == "doctor":
        act_doctor(a)
    elif a.action == "list":
        for w in list_windows(include_cloaked=a.all):
            print(w.line())
    elif a.action == "find":
        print(resolve(a.title, a.id).line())
    elif a.action == "focus":
        focus(a.title, wid=a.id)
    elif a.action == "shot":
        if not a.out:
            die("NO_OUT", "--out is required for shot")
        act_shot(a)
    elif a.action == "type":
        if a.text is None:
            die("NO_TEXT", "--text is required for type")
        act_type(a)
    elif a.action == "paste":
        act_paste(a)
    elif a.action == "key":
        if not a.keys:
            die("NO_KEYS", "--keys is required, e.g. enter, esc, ctrl+shift+p")
        act_key(a)
    elif a.action == "click":
        if a.x is None or a.y is None:
            die("NO_COORDS", "--x and --y are required for click")
        act_click(a)
    elif a.action == "scroll":
        act_scroll(a)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        # A crash must still fail with a stable first token, and the traceback
        # must survive the caller's output handling (a filtering pipe can drop
        # most frames). The log keeps the whole thing.
        import traceback
        log("FAIL INTERNAL_ERROR: " + traceback.format_exc().rstrip().replace("\n", " | "))
        die("INTERNAL_ERROR", f"{type(e).__name__}: {e}",
            [f"The full traceback was appended to {LOG}.",
             "Anything the action printed above this line did happen; nothing",
             "after the crash was sent. Retry once; if it repeats, report the log line."])
