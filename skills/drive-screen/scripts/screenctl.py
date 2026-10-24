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

Exit codes: 0 ok, 1 refused (not found / ambiguous / focus unconfirmed / bad input).

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
Set SCREENCTL_STATE_DIR to put the log (and autodrive's prompt screenshots)
somewhere else; the smoke tests point it at a temp folder.
"""

from __future__ import annotations

import argparse
import datetime
import os
import platform
import struct
import sys
import time
import traceback
import zlib
from dataclasses import dataclass

if platform.system() != "Windows":
    print("UNSUPPORTED_OS: this build of screenctl drives Windows only.")
    print("  The upstream skill (coleam00/skills, drive-screen) has macOS and X11 backends.")
    sys.exit(1)

import ctypes                          # noqa: E402
from ctypes import wintypes            # noqa: E402

STATE_DIR = (os.environ.get("SCREENCTL_STATE_DIR")
             or os.path.join(os.path.expanduser("~"), ".claude", "screenctl"))
LOG = os.path.join(STATE_DIR, "actions.log")

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
        stamp = datetime.datetime.now().isoformat(timespec="seconds")
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{stamp}\t{msg}\n")
    except Exception:
        pass  # logging must never be the reason an action fails


def die(code: str, msg: str, extra: list[str] | None = None) -> None:
    """Fail with a stable, machine-readable first token, then prose.

    The caller is a language model. A failure it cannot classify is a failure it
    improvises around, and improvising around a focus failure is exactly how
    keystrokes end up in the wrong window.
    """
    log(f"FAIL {code}: {msg}")
    print(f"{code}: {msg}")
    for line in extra or []:
        print(f"  {line}")
    sys.exit(1)


@dataclass
class Win:
    id: str          # HWND as a decimal string: printable and comparable
    title: str
    x: int
    y: int
    w: int
    h: int

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
            + _png_chunk(b"IDAT", zlib.compress(raw, 6)) + _png_chunk(b"IEND", b""))


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


def raise_window(win: Win) -> None:
    h = win.hwnd
    # SW_RESTORE only for a MINIMIZED window. Upstream restored unconditionally,
    # and SW_RESTORE on a maximized window un-maximizes it: focusing a maximized
    # editor shrank it to its last floating size on every action.
    if user32.IsIconic(h):
        user32.ShowWindow(h, 9)          # SW_RESTORE
    user32.SetForegroundWindow(h)


def force_foreground(win: Win) -> None:
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
        user32.SetForegroundWindow(win.hwnd)
    finally:
        for t in tids:
            user32.AttachThreadInput(cur, t, False)


def unlock_foreground() -> None:
    # Last resort. A synthetic ALT tap satisfies the "received the last input
    # event" condition, but the tap itself lands in the CURRENT foreground app,
    # and in Explorer and many classic apps a bare ALT toggles the menu bar.
    # That is why the thread-attach route above runs first.
    user32.keybd_event(0x12, 0, 0, 0)          # VK_MENU down
    user32.keybd_event(0x12, 0, 0x0002, 0)     # VK_MENU up


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
        time.sleep(delay)


def send_chord(keys: str) -> None:
    parts = [k.strip().lower() for k in keys.split("+") if k.strip()]
    codes = []
    for p in parts:
        if p in VK:
            codes.append(VK[p])
        elif len(p) == 1:
            codes.append(ord(p.upper()))
        else:
            die("BAD_KEY", f"unknown key {p!r} in {keys!r}",
                ["Known names: " + ", ".join(sorted(VK))])
    _send([_key_ev(c, False) for c in codes] +
          [_key_ev(c, True) for c in reversed(codes)])


def place_cursor(x: int, y: int) -> None:
    """Move the pointer and PROVE it landed. SetCursorPos clamps to the virtual
    screen and returns quietly, and a pinned cursor stays put, so the pixel the
    guard checked and the pixel that gets the button are only the same if this
    reads back the requested point."""
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.12)
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
        time.sleep(0.06)
        _send([_mouse_ev(up)])
        if i == 0 and double:
            time.sleep(0.05)


def scroll(win: Win, amount: int) -> None:
    # The wheel goes to the window under the POINTER, not to the focused
    # window. Focusing alone is not enough, and the failure is silent and
    # doubly wrong: the target does not move, and whatever the mouse happens
    # to be sitting over scrolls instead. Measured upstream: a scroll aimed at
    # a text window went to a window on a different monitor.
    place_cursor(win.x + win.w // 2, win.y + win.h // 2)
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
        time.sleep(0.03)
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


def capture(win: Win, out: str, max_width: int) -> None:
    """Render the window's own content to a PNG. Never a screen-region grab.

    PrintWindow with PW_RENDERFULLCONTENT (Windows 8.1+) asks DWM for the
    window's composed surface, so DirectX and browser windows render too, and
    the window does not have to be in front. What it cannot do is render an
    exclusive-fullscreen app or a minimized window: those come back flat, and
    act_shot says so rather than handing the picture over.
    """
    w, h = win.w, win.h
    tw = min(w, max_width) if max_width else w
    th = max(1, round(h * tw / w))
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
        if tw != w:
            small = _DIB(screen, tw, th)
            gdi32.SetStretchBltMode(small.dc, 4)             # HALFTONE: averaged
            gdi32.SetBrushOrgEx(small.dc, 0, 0, None)
            gdi32.StretchBlt(small.dc, 0, 0, tw, th, full.dc, 0, 0, w, h, 0x00CC0020)
            png = encode_png_bgra(tw, th, small.bytes())
        else:
            png = encode_png_bgra(w, h, full.bytes())
    finally:
        for d in (small, full):
            if d:
                d.close()
        user32.ReleaseDC(None, screen)
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


def focus(title: str, settle: float = 0.45, wid: str | None = None) -> Win:
    """Focus, then PROVE it by comparing window IDENTITY, not title text.

    Comparing the foreground window's title against the requested substring passes
    whenever some other window happens to share that substring. Resolution above
    has already earned an exact handle, so identity is stricter and free.
    """
    win = resolve(title, wid)
    if same_window(win):
        log(f"FOCUS(already) {win.title}")
        print(f"FOCUS_OK: {win.title}")
        return win

    raise_window(win)
    time.sleep(settle)
    if same_window(win):
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

    force_foreground(win)
    time.sleep(settle)
    if same_window(win):
        log(f"FOCUS(attach) {win.title}")
        print(f"FOCUS_OK (after thread attach): {win.title}")
        return resolve(title, wid)

    unlock_foreground()
    raise_window(win)
    time.sleep(settle)
    if same_window(win):
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


def act_shot(a) -> None:
    if a.no_focus:
        win = resolve(a.title, a.id)
        if win.minimized:
            die("MINIMIZED", f"{win.title!r} is minimized; a minimized window renders nothing.",
                ["Drop --no-focus so `shot` restores and focuses it first."])
    else:
        win = focus(a.title, wid=a.id)
        time.sleep(a.settle)      # let the UI settle before capturing it
    capture(win, a.out, a.max_width)
    iw, ih = png_size(a.out)
    if iw == 0:
        die("CAPTURE_FAILED", f"{a.out} is not a readable PNG")
    if looks_blank(a.out):
        print("WARNING: the capture is one flat color. The window did not render:")
        print("  an exclusive-fullscreen app, a minimized window, or a protected surface.")
        print("  Do not reason about this image. Fix the capture first.")
    scale = iw / win.w if win.w else 1.0
    log(f"SHOT {a.out} {iw}x{ih} scale={scale:.4f} win={win.title}")
    print(f"SHOT: {a.out}  {iw}x{ih}{'  (no focus change)' if a.no_focus else ''}")
    print(f"WINDOW_ORIGIN: {win.x},{win.y}    IMAGE_SCALE: {scale:.4f}")
    print("To click what you see at image pixel (px,py), pass:")
    print(f"  --x {win.x} + px/{scale:.4f}    --y {win.y} + py/{scale:.4f}")
    if abs(scale - 1.0) > 0.01:
        print("  The scale is not 1. The image is not in screen pixels; divide.")
    print("The image is the window's own content: anything floating ON TOP of it")
    print("(an overlay, a topmost tool window) is not shown. `click` checks for that.")


def act_type(a) -> None:
    if "\n" in a.text or "\r" in a.text:
        die("NEWLINE_IN_TYPE", "refusing: --text contains a newline.",
            ["In a full-screen terminal UI a newline SUBMITS, so the first line",
             "would be sent as a prompt and the rest typed into whatever follows.",
             "Use `paste` for anything multi-line."])
    win = focus(a.title, wid=a.id)

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

    time.sleep(0.25)
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
    win = focus(a.title, wid=a.id)

    # The clipboard belongs to the human. Borrow it and give it back, on every
    # exit path: die() raises SystemExit, and the finally below runs through it.
    saved, had_content = clipboard_state()
    restore = not a.keep_clipboard and (saved is not None or not had_content)
    if saved is None and had_content and not a.keep_clipboard:
        print("CLIPBOARD_PREVIOUS_NOT_TEXT: the clipboard held an image or files,")
        print("  which this tool cannot put back. It will hold the payload afterwards.")

    try:
        set_clipboard(payload)
        time.sleep(0.1)

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
        time.sleep(0.6)
        log(f"PASTE {len(payload)} chars into {win.title!r}")
        print(f"PASTED {len(payload)} chars (line endings as CRLF; no Enter sent)")
    finally:
        if restore:
            try:
                set_clipboard(saved if saved is not None else "")
                print("CLIPBOARD_RESTORED")
            except SystemExit:
                print("CLIPBOARD_RESTORE_FAILED (the payload is still on the clipboard)")


def _refuse_if_covered(win: Win, x: int, y: int) -> None:
    root = root_window_at(x, y)
    if not root:
        die("CLICK_COVERED", f"({x},{y}) is inside {win.title!r} but no window receives a "
            "click there (off the desktop, or a window is being destroyed).",
            ["Nothing was clicked. Screenshot again and recompute the point."])
    if _pid_of(root) != _pid_of(win.hwnd):
        cover = _title_of(root) or f"hwnd {root}"
        die("CLICK_COVERED", f"({x},{y}) would hit {cover!r}, not {win.title!r}.",
            ["Something is floating on top of the target at that point (an overlay,",
             "a topmost tool window). It is not in the screenshot because the",
             "screenshot is the target's own content. Move or close it, or use keys."])


def act_click(a) -> None:
    win = focus(a.title, wid=a.id)
    if not win.contains(a.x, a.y):
        die("CLICK_OUTSIDE", f"({a.x},{a.y}) is outside {win.title!r} "
            f"at {win.x},{win.y} {win.w}x{win.h}.",
            ["Screenshot again and redo the WINDOW_ORIGIN / IMAGE_SCALE arithmetic."])
    # The screenshot shows the window's own content, not what is stacked on top
    # of it. Ask the OS what actually receives a click at this point; a popup,
    # menu or dialog of the SAME process is fine (that is how menus work), any
    # other process means an overlay is covering the target, and NO window
    # means the point is off the desktop. Checked twice: once now, once after
    # the pointer has provably arrived, right before the button goes down.
    _refuse_if_covered(win, a.x, a.y)
    place_cursor(a.x, a.y)
    _refuse_if_covered(win, a.x, a.y)
    try:
        press("right" if a.right else "left", a.double)
    except InputBlocked as e:
        _die_input_blocked(e, "Nothing was clicked.")
    log(f"CLICK {a.x},{a.y} in {win.title!r}")
    print(f"CLICKED {a.x},{a.y}"
          f"{' (double)' if a.double else ''}{' (right)' if a.right else ''}")
    print("Screenshot again before the next click. Any click can move the layout,")
    print("and coordinates from a stale image land somewhere else entirely.")


def act_doctor(a) -> None:
    """Prove the environment works before a run depends on it.

    Nothing here changes focus: the capture probe renders the window that is
    already in front, and the clipboard probe puts back what it found.
    """
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


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", choices=["doctor", "list", "find", "focus", "shot",
                                       "type", "paste", "key", "click", "scroll"])
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
    a = ap.parse_args()

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
        win = focus(a.title, wid=a.id)
        try:
            send_chord(a.keys)
        except InputBlocked as e:
            _die_input_blocked(e, "The chord was not delivered.")
        time.sleep(0.3)
        log(f"KEY {a.keys} into {win.title!r}")
        print(f"SENT: {a.keys}")
    elif a.action == "click":
        if a.x is None or a.y is None:
            die("NO_COORDS", "--x and --y are required for click")
        act_click(a)
    elif a.action == "scroll":
        win = focus(a.title, wid=a.id)
        try:
            scroll(win, a.amount)
        except InputBlocked as e:
            _die_input_blocked(e, "Nothing was scrolled.")
        log(f"SCROLL {a.amount} in {win.title!r}")
        print(f"SCROLLED {a.amount}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        # A crash must still fail with a stable first token, and the traceback
        # must survive the caller's output handling (a filtering pipe can drop
        # most frames). The log keeps the whole thing.
        log("FAIL INTERNAL_ERROR: " + traceback.format_exc().rstrip().replace("\n", " | "))
        die("INTERNAL_ERROR", f"{type(e).__name__}: {e}",
            [f"The full traceback was appended to {LOG}.",
             "Anything the action printed above this line did happen; nothing",
             "after the crash was sent. Retry once; if it repeats, report the log line."])
