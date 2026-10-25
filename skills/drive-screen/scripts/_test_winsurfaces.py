#!/usr/bin/env python3
"""
Offline tests for uia.py and ocr.py. Safe to run anywhere: touches no window it did not create.

  PYTHONDONTWRITEBYTECODE=1 python _test_winsurfaces.py

- OCR: ASCII text rendered with GDI into a memory DC + DIB section (no window at all).
- UIA: a window THIS test creates (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, SW_SHOWNOACTIVATE,
  placed off the visible desktop, destroyed in a finally) with a BUTTON, a STATIC and an
  EDIT of known text. It lives on its own message-pump thread (UIA needs the owner thread
  to pump). The foreground window handle is asserted unchanged before and after (another
  process taking it mid-run is INCONCLUSIVE: that sub-test re-runs once, then exit 3).
No input is sent, no focus changed, no other window inspected.
"""

from __future__ import annotations

import ctypes
import os
import statistics
import subprocess
import sys
import threading
import time
from ctypes import wintypes

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

HWND = wintypes.HWND
HDC = wintypes.HDC
VP = ctypes.c_void_p

# per-monitor DPI aware, as screenctl does, so UIA rectangles are physical pixels
try:
    user32.SetProcessDpiAwarenessContext.argtypes = [VP]
    user32.SetProcessDpiAwarenessContext(VP(-4))
except Exception:
    pass

user32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR,
                                   wintypes.DWORD, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                   ctypes.c_int, HWND, VP, VP, VP]
user32.CreateWindowExW.restype = HWND
user32.DestroyWindow.argtypes = [HWND]
user32.DestroyWindow.restype = wintypes.BOOL
user32.IsWindow.argtypes = [HWND]
user32.IsWindow.restype = wintypes.BOOL
user32.ShowWindow.argtypes = [HWND, ctypes.c_int]
user32.GetForegroundWindow.restype = HWND
user32.GetWindowThreadProcessId.argtypes = [HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetClassNameW.argtypes = [HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowRect.argtypes = [HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), HWND, wintypes.UINT, wintypes.UINT]
user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
user32.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), HWND, wintypes.UINT, wintypes.UINT, wintypes.UINT]
user32.GetDC.argtypes = [HWND]
user32.GetDC.restype = HDC
gdi32.CreateCompatibleDC.argtypes = [HDC]
gdi32.CreateCompatibleDC.restype = HDC
gdi32.DeleteDC.argtypes = [HDC]
gdi32.DeleteObject.argtypes = [VP]
gdi32.SelectObject.argtypes = [HDC, VP]
gdi32.SelectObject.restype = VP
gdi32.SetBkMode.argtypes = [HDC, ctypes.c_int]
gdi32.SetTextColor.argtypes = [HDC, wintypes.DWORD]
gdi32.TextOutW.argtypes = [HDC, ctypes.c_int, ctypes.c_int, wintypes.LPCWSTR, ctypes.c_int]
gdi32.CreateFontW.argtypes = [ctypes.c_int] * 5 + [wintypes.DWORD] * 8 + [wintypes.LPCWSTR]
gdi32.CreateFontW.restype = VP
gdi32.CreateDIBSection.argtypes = [HDC, VP, wintypes.UINT, VP, VP, wintypes.DWORD]
gdi32.CreateDIBSection.restype = VP

WS_POPUP, WS_CHILD, WS_VISIBLE = 0x80000000, 0x40000000, 0x10000000
WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW = 0x08000000, 0x00000080
ES_PASSWORD = 0x0020
SW_SHOWNOACTIVATE = 4
WM_QUIT = 0x0012
WM_APP_HANG = 0x8000 + 1                    # WM_APP + 1, a thread message this test defines
PM_NOREMOVE = 0

PASSED = 0
FAILED: list[str] = []
INCONCLUSIVE: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASSED
    if cond:
        PASSED += 1
        print(f"ok   {name}")
    else:
        FAILED.append(name)
        print(f"FAIL {name} {detail}")


def check_foreground(name: str, fg_before) -> None:
    """The test must never move the foreground. A change to a window of THIS process fails;
    a change to another process's window (the user switching windows mid-run) is
    INCONCLUSIVE, not a pass: main() re-runs that sub-test once. Pid and class only, no title."""
    fg = user32.GetForegroundWindow()
    if fg == fg_before:
        check(name, True)
        return
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(fg, ctypes.byref(pid))
    cls = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(fg, cls, 256)
    who = f"pid {pid.value}, class {cls.value or '?'}"
    if pid.value == os.getpid():
        check(name, False, f"a test-owned window took the foreground ({who})")
    else:
        INCONCLUSIVE.append(name)
        print(f"INCONCLUSIVE {name}: the foreground moved to another process ({who}); not a pass")


class _FakeUser32:
    """Just the three calls check_foreground makes, with a chosen foreground handle and owner."""
    def __init__(self, fg: int, pid: int) -> None:
        self.fg, self.pid = fg, pid

    def GetForegroundWindow(self) -> int:
        return self.fg

    def GetWindowThreadProcessId(self, hwnd, pid_ref) -> int:
        pid_ref._obj.value = self.pid
        return 1

    def GetClassNameW(self, hwnd, buf, n) -> int:
        buf.value = "FakeClass"
        return 9


def test_foreground_logic() -> None:
    """check_foreground and _run_all's re-run / exit codes against a fake foreground: no window,
    no Win32 call. The real counters are saved and restored around it."""
    global user32, PASSED
    import contextlib
    import io
    real, saved = user32, (PASSED, FAILED[:], INCONCLUSIVE[:])
    other, own = os.getpid() + 1, os.getpid()
    results: dict[str, bool] = {}
    calls: list[int] = []

    def state():
        return PASSED, FAILED[:], INCONCLUSIVE[:]

    def reset():
        global PASSED
        PASSED = 0
        FAILED.clear()
        INCONCLUSIVE.clear()
        calls.clear()

    def flaky():                                    # another process once, then unchanged
        calls.append(1)
        check("flaky body", True)
        check_foreground("f", 7 if len(calls) > 1 else 6)

    def stuck():                                    # another process every time
        calls.append(1)
        check_foreground("s", 6)

    try:
        with contextlib.redirect_stdout(io.StringIO()):
            reset(); user32 = _FakeUser32(7, other); check_foreground("x", 7)
            results["unchanged handle passes"] = state() == (1, [], [])
            reset(); check_foreground("x", 6)
            results["another process's window is INCONCLUSIVE, not a fail"] = state() == (0, [], ["x"])
            reset(); user32 = _FakeUser32(7, own); check_foreground("x", 6)
            results["a test-owned window FAILS"] = state() == (0, ["x"], [])
            reset(); user32 = _FakeUser32(7, other); rc = _run_all((flaky,))
            results["inconclusive then unchanged: re-run once, exit 0, first run's passes dropped"] = \
                (rc, len(calls)) + state() == (0, 2, 2, [], [])
            reset(); rc = _run_all((stuck,))
            results["inconclusive twice: exit 3"] = (rc, len(calls)) + state() == (3, 2, 0, [], ["s"])
            reset(); user32 = _FakeUser32(7, own); rc = _run_all((lambda: check_foreground("o", 6),))
            results["a test-owned window: exit 1, no re-run"] = (rc,) + state() == (1, 0, ["o"], [])
    finally:
        user32 = real
        PASSED, FAILED[:], INCONCLUSIVE[:] = saved
    for name, ok in results.items():
        check(f"foreground logic (fake): {name}", ok)
    check("foreground logic (fake): all 6 cases ran", len(results) == 6, str(len(results)))


def timings(label: str, fn, n: int = 5):
    ms = []
    result = None
    for _ in range(n):
        t = time.perf_counter()
        result = fn()
        ms.append((time.perf_counter() - t) * 1000)
    print(f"TIMING {label}: median {statistics.median(ms):.1f} ms  min {min(ms):.1f}  max {max(ms):.1f}  (n={n})")
    return result, statistics.median(ms)


# ---------------------------------------------------------------------------
# GDI rendering into a memory DC (no window)
# ---------------------------------------------------------------------------

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD),
                ("biCompression", wintypes.DWORD), ("biSizeImage", wintypes.DWORD),
                ("biXPelsPerMeter", ctypes.c_long), ("biYPelsPerMeter", ctypes.c_long),
                ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]


def render_text(lines: list[str], width: int, height: int, font_px: int = 64) -> bytes:
    """Black ASCII text on white, returned as top-down BGRA bytes."""
    hdc = gdi32.CreateCompatibleDC(None)
    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth, bi.biHeight = width, -height          # negative = top-down
    bi.biPlanes, bi.biBitCount = 1, 32
    bits = VP()
    bmp = gdi32.CreateDIBSection(hdc, ctypes.byref(bi), 0, ctypes.byref(bits), None, 0)
    font = 0
    try:
        old_bmp = gdi32.SelectObject(hdc, bmp)
        ctypes.memset(bits, 0xFF, width * height * 4)            # white, alpha 255
        font = gdi32.CreateFontW(-font_px, 0, 0, 0, 400, 0, 0, 0, 0, 0, 0, 4, 0, "Arial")
        old_font = gdi32.SelectObject(hdc, font)
        gdi32.SetBkMode(hdc, 1)                                  # TRANSPARENT
        gdi32.SetTextColor(hdc, 0)
        for i, line in enumerate(lines):
            gdi32.TextOutW(hdc, 20, 10 + i * (font_px + 24), line, len(line))
        gdi32.SelectObject(hdc, old_font)
        gdi32.SelectObject(hdc, old_bmp)
        return ctypes.string_at(bits, width * height * 4)
    finally:
        if font:
            gdi32.DeleteObject(font)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(hdc)


def squash(s: str) -> str:
    return "".join(s.lower().split())


def test_ocr() -> None:
    import ocr
    ok, info = ocr.available()
    check("ocr.available returns (bool, str)", isinstance(ok, bool) and isinstance(info, str) and info != "", repr((ok, info)))
    print(f"INFO ocr.available -> {ok}, language tag or reason: {info}")
    if not ok:
        print(f"SKIP ocr: engine unavailable here ({info}); rendering checks are skipped, not failed")
    check("ocr.available is stable (cached)", ocr.available() == (ok, info))
    check("ocr.Unavailable is an Exception", issubclass(ocr.Unavailable, Exception))
    check("ocr.text_of joins lines", ocr.text_of([{"text": "a", "rect": (0, 0, 1, 1)}, {"text": "b", "rect": (0, 0, 1, 1)}]) == "a\nb")
    check("ocr.text_of empty", ocr.text_of([]) == "")
    try:
        ocr.recognize_bgra(4, 4, b"\x00" * 10)
        check("recognize_bgra rejects a wrong-size buffer", False)
    except ValueError:
        check("recognize_bgra rejects a wrong-size buffer", True)
    if not ok:
        try:
            ocr.recognize_bgra(4, 4, b"\x00" * 64)
            check("recognize_bgra raises Unavailable when not available", False)
        except ocr.Unavailable:
            check("recognize_bgra raises Unavailable when not available", True)
        print("SKIP ocr rendering checks: OCR unavailable here")
        return
    w, h = 1000, 260
    img = render_text(["Hello World 1234", "Screen Control"], w, h)
    check("rendered image has ink (not blank)", img.count(b"\x00\x00\x00") > 1000)
    lines, _ = timings("ocr.recognize_bgra 1000x260", lambda: ocr.recognize_bgra(w, h, img))
    text = squash(ocr.text_of(lines))
    check("OCR finds 'hello'", "hello" in text, text)
    check("OCR finds 'world'", "world" in text, text)
    check("OCR finds '1234'", "1234" in text, text)
    check("OCR finds the second line", "screencontrol" in text, text)
    check("OCR line count is 2", len(lines) == 2, str(len(lines)))
    if lines:
        first = lines[0]
        check("line dict shape", set(first) == {"text", "rect"} and len(first["rect"]) == 4)
        x, y, rw, rh = first["rect"]
        check("line rect lies inside the image", 0 <= x and 0 <= y and rw > 0 and rh > 0 and x + rw <= w and y + rh <= h, str(first["rect"]))
    if len(lines) >= 2:
        check("lines are in reading order", lines[0]["rect"][1] < lines[1]["rect"][1])
    big_w, big_h = 2000, 1000                         # a large synthetic frame (20 rows of 48 px fit)
    big = render_text(["Large Frame Check"], big_w, big_h)
    lines2, _ = timings("ocr.recognize_bgra 2000x1000", lambda: ocr.recognize_bgra(big_w, big_h, big), n=3)
    check("OCR finds text in a 2000x1000 frame", "largeframe" in squash(ocr.text_of(lines2)))
    dense = render_text([f"Row {i} the quick brown fox jumps over the lazy dog 0123456789" for i in range(20)],
                        big_w, big_h, font_px=24)
    lines4, _ = timings("ocr.recognize_bgra 2000x1000 dense (20 lines)", lambda: ocr.recognize_bgra(big_w, big_h, dense), n=3)
    check("dense frame: at least 18 of 20 lines recognized", len(lines4) >= 18, str(len(lines4)))
    check("dense frame: last row text found", "row19thequick" in squash(ocr.text_of(lines4)))
    tag = info
    lines3 = ocr.recognize_bgra(w, h, img, lang=tag)
    check("explicit lang tag works", "hello" in squash(ocr.text_of(lines3)))
    try:
        ocr.recognize_bgra(w, h, img, lang="zz-invalid-tag-999")
        check("bad language tag raises Unavailable", False)
    except ocr.Unavailable:
        check("bad language tag raises Unavailable", True)
    try:
        ocr.recognize_bgra(20000, 1, b"\x00" * (20000 * 4))
        check("oversized image raises ValueError", False)
    except ValueError:
        check("oversized image raises ValueError", True)
    t0 = time.perf_counter()
    try:
        ocr._run_on_worker(lambda: time.sleep(1.0), 0.2)
        check("a stuck OCR worker raises Unavailable", False)
    except ocr.Unavailable as e:
        check("a stuck OCR worker raises Unavailable within the limit", time.perf_counter() - t0 < 0.6)
        check("...and it is the Timeout subclass", isinstance(e, ocr.Timeout))
    # recognize_bgra(timeout_s=): None keeps the defaults, a number caps poll and worker wait
    check("ocr.Timeout is an Unavailable", issubclass(ocr.Timeout, ocr.Unavailable))
    check("timeout_s works on a normal call", "hello" in squash(ocr.text_of(ocr.recognize_bgra(w, h, img, timeout_s=5.0))))
    check("timeout_s below the 0.5 s floor still completes a normal call",
          "hello" in squash(ocr.text_of(ocr.recognize_bgra(w, h, img, timeout_s=0.01))))
    real_rec = ocr._recognize
    ocr._recognize = lambda *a, **kw: time.sleep(2.0)
    try:
        t0 = time.perf_counter()
        try:
            ocr.recognize_bgra(w, h, img, timeout_s=0.6)
            check("a stuck recognize_bgra(timeout_s=0.6) raises Timeout", False)
        except ocr.Timeout:
            took = time.perf_counter() - t0
            check("a stuck recognize_bgra(timeout_s=0.6) raises Timeout", True)
            check("...after about timeout_s + 0.25 s, not the 20 s default", 0.5 <= took < 0.6 + 0.25 + 0.2, f"{took:.2f} s")
        t0 = time.perf_counter()
        try:
            ocr.recognize_bgra(w, h, img, timeout_s=0.0)
            check("timeout_s=0 is floored to 0.5 s", False, "no Timeout raised")
        except ocr.Timeout:
            took = time.perf_counter() - t0
            check("timeout_s=0 is floored to 0.5 s", 0.4 <= took < 0.5 + 0.25 + 0.2, f"{took:.2f} s")
    finally:
        ocr._recognize = real_rec
    time.sleep(2.0)                                   # let the two abandoned fake workers end
    blank = bytes([255]) * (200 * 100 * 4)
    check("blank image gives no lines", ocr.recognize_bgra(200, 100, blank) == [])


# ---------------------------------------------------------------------------
# UIA against a window this test owns
# ---------------------------------------------------------------------------

class TestWindow(threading.Thread):
    """Creates the off-desktop window on its own thread and pumps messages until stopped."""

    def __init__(self, x: int = -20000, y: int = -20000) -> None:
        super().__init__(daemon=True)
        self.ready = threading.Event()
        self.error = ""
        self.tid = 0
        self.x, self.y = x, y
        self.hang_s = 0.0
        self.top = self.button = self.static = self.edit = self.pw_label = self.pw_edit = 0
        self.destroyed = False

    def hang(self, seconds: float) -> None:
        """Make the owner thread stop pumping messages for `seconds` (a hung app)."""
        self.hang_s = seconds
        user32.PostThreadMessageW(self.tid, WM_APP_HANG, 0, 0)

    def run(self) -> None:
        self.tid = kernel32.GetCurrentThreadId()
        msg = wintypes.MSG()
        user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_NOREMOVE)   # create the queue
        try:
            ex = WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
            self.top = user32.CreateWindowExW(ex, "STATIC", "ws-test-window", WS_POPUP,
                                              self.x, self.y, 360, 210, None, None, None, None)
            if not self.top:
                self.error = f"CreateWindowExW failed ({ctypes.get_last_error()})"
                return
            self.button = user32.CreateWindowExW(0, "BUTTON", "Save Probe", WS_CHILD | WS_VISIBLE,
                                                 10, 10, 120, 32, self.top, None, None, None)
            self.static = user32.CreateWindowExW(0, "STATIC", "Marker Text Alpha", WS_CHILD | WS_VISIBLE,
                                                 10, 60, 200, 24, self.top, None, None, None)
            self.edit = user32.CreateWindowExW(0, "EDIT", "valueprobe", WS_CHILD | WS_VISIBLE,
                                               10, 100, 200, 24, self.top, None, None, None)
            self.pw_label = user32.CreateWindowExW(0, "STATIC", "Secret Label", WS_CHILD | WS_VISIBLE,
                                                   10, 134, 200, 20, self.top, None, None, None)
            self.pw_edit = user32.CreateWindowExW(0, "EDIT", "pwprobe987", WS_CHILD | WS_VISIBLE | ES_PASSWORD,
                                                  10, 160, 200, 24, self.top, None, None, None)
            user32.ShowWindow(self.top, SW_SHOWNOACTIVATE)
            self.ready.set()
            while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                if msg.message == WM_APP_HANG and not msg.hWnd:
                    time.sleep(self.hang_s)         # not pumping: UIA calls into this window stall
                    continue
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
        finally:
            if self.top:
                user32.DestroyWindow(self.top)      # destroys the children too
                self.destroyed = not user32.IsWindow(self.top)
            self.ready.set()

    def stop(self) -> None:
        if self.tid:
            user32.PostThreadMessageW(self.tid, WM_QUIT, 0, 0)
        self.join(5.0)


def screen_rect(hwnd: int) -> tuple:
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return (r.left, r.top, r.right, r.bottom)


def test_uia() -> None:
    import uia
    check("uia.Unavailable is an Exception", issubclass(uia.Unavailable, Exception))
    fg_before = user32.GetForegroundWindow()
    win = TestWindow()
    win.start()
    try:
        win.ready.wait(5.0)
        check("test window created", bool(win.top) and not win.error, win.error)
        if not win.top:
            return
        time.sleep(0.15)                                          # let it paint / register
        res, _ = timings("uia.elements (FindAllBuildCache)", lambda: uia.elements(win.top))
        check("elements returns (list, truncated)", isinstance(res, tuple) and len(res) == 2
              and isinstance(res[0], list) and res[1] is False, repr(res)[:200])
        els, trunc = res
        check("elements returns a non-empty list of dicts", len(els) >= 3, str(len(els)))
        check("a small window is not flagged truncated", trunc is False)
        keys = {"name", "value", "control", "automation_id", "rect", "enabled", "offscreen",
                "runtime_id", "is_password"}
        check("element dict has exactly the contract keys", all(set(e) == keys for e in els))
        check("element types", all(isinstance(e["name"], str) and isinstance(e["value"], str)
                                   and isinstance(e["control"], str) and isinstance(e["automation_id"], str)
                                   and len(e["rect"]) == 4 and isinstance(e["enabled"], bool)
                                   and isinstance(e["offscreen"], bool) and isinstance(e["is_password"], bool)
                                   and isinstance(e["runtime_id"], tuple)
                                   and all(isinstance(v, int) for v in e["runtime_id"]) for e in els))
        check("every element has a non-empty runtime_id", all(len(e["runtime_id"]) >= 1 for e in els))
        check("runtime_ids are unique in the window", len({e["runtime_id"] for e in els}) == len(els))
        (hits, ftrunc), _ = timings("uia.find Button 'save probe'", lambda: uia.find(win.top, "save probe", "Button"))
        check("find returns (list, truncated=False)", ftrunc is False)
        check("find returns exactly the button", len(hits) == 1, str(hits))
        if hits:
            b = hits[0]
            check("button control type is Button", b["control"] == "Button", b["control"])
            check("button is enabled", b["enabled"] is True)
            want = screen_rect(win.button)
            got = b["rect"]
            check("button rect matches GetWindowRect within 2 px",
                  all(abs(g - w) <= 2 for g, w in zip(got, want)), f"uia={got} win32={want}")
            bw, bh = got[2] - got[0], got[3] - got[1]
            check("button rect is sane (positive, 120x32 +-2)", abs(bw - 120) <= 2 and abs(bh - 32) <= 2, f"{bw}x{bh}")
        check("find is case-insensitive", len(uia.find(win.top, "SAVE PROBE")[0]) == 1)
        check("find with the wrong control type is empty", uia.find(win.top, "save probe", "Edit")[0] == [])
        check("find control match is case-insensitive", len(uia.find(win.top, "save probe", "bUtToN")[0]) == 1)
        marks = uia.find(win.top, "marker text", "Text")[0]
        check("static text found by name", len(marks) == 1 and marks[0]["control"] == "Text", str(marks))
        # MSAA labels the EDIT after the STATIC that precedes it, so the unfiltered search sees both
        check("unfiltered find sees the label and the edit it labels",
              sorted(e["control"] for e in uia.find(win.top, "marker text")[0]) == ["Edit", "Text"])
        check("find with no match is empty", uia.find(win.top, "no-such-element-xyz")[0] == [])
        # exact=True: NAME only, case-insensitive, trimmed, '&' removed, never a substring
        check("exact find rejects a substring", uia.find(win.top, "save", exact=True)[0] == [])
        check("exact find accepts the full name, any case",
              len(uia.find(win.top, "SAVE probe", exact=True)[0]) == 1)
        check("exact find trims and ignores '&' in the query",
              len(uia.find(win.top, "  &Save Probe ", exact=True)[0]) == 1)
        check("exact find does not match on value", uia.find(win.top, "valueprobe", exact=True)[0] == [])
        check("substring find matches on value", len(uia.find(win.top, "valueprobe", exact=False)[0]) >= 1)
        check("exact find with control filter", len(uia.find(win.top, "save probe", "Button", exact=True)[0]) == 1)
        vals = [e for e in els if e["control"] == "Edit" and e["value"] == "valueprobe"]
        check("edit control with the known value present", len(vals) == 1, str([(e["control"], e["value"]) for e in els]))
        if vals:
            check("edit Value property read", vals[0]["value"] == "valueprobe", repr(vals[0]["value"]))
            check("edit is not a password field", vals[0]["is_password"] is False)
            check("find matches on value", len(uia.find(win.top, "valueprob")[0]) >= 1)
        pws = [e for e in els if e["is_password"]]
        check("exactly one password element is reported", len(pws) == 1, str([(e["control"], e["is_password"]) for e in els]))
        if pws:
            check("password element value is blanked", pws[0]["value"] == "", repr(pws[0]["value"]))
        check("the password text appears nowhere in the elements",
              not any("pwprobe987" in (e["name"] + e["value"] + e["automation_id"]) for e in els))
        check("find never returns the password text", uia.find(win.top, "pwprobe987")[0] == [])
        (walk, wtrunc), _ = timings("uia.elements (TreeWalker fallback)", lambda: uia.elements(win.top, method="walk"))
        check("walker path returns the same element set",
              sorted((e["name"], e["control"]) for e in walk) == sorted((e["name"], e["control"]) for e in els),
              f"{len(walk)} vs {len(els)}")
        check("walker path is not truncated on a small window", wtrunc is False)
        check("walker runtime_ids equal the findall ones",
              {e["runtime_id"] for e in walk} == {e["runtime_id"] for e in els})
        one, one_t = uia.elements(win.top, max_nodes=1)
        check("max_nodes bounds the result (findall)", len(one) == 1)
        check("max_nodes smaller than the tree sets truncated (findall)", one_t is True)
        one, one_t = uia.elements(win.top, max_nodes=1, method="walk")
        check("max_nodes bounds the result (walker)", len(one) == 1)
        check("max_nodes smaller than the tree sets truncated (walker)", one_t is True)
        full, full_t = uia.elements(win.top, max_nodes=len(els))
        check("max_nodes equal to the tree size is not truncated (findall)", len(full) == len(els) and full_t is False)
        full, full_t = uia.elements(win.top, max_nodes=len(els), method="walk")
        check("max_nodes equal to the tree size is not truncated (walker)", len(full) == len(els) and full_t is False)
        ft = uia.find(win.top, "save probe", max_nodes=1)[1]
        check("find passes the truncated flag through", ft is True)

        # hit_test: read-only ElementFromPoint at the button center / elsewhere
        if hits:
            b = hits[0]
            cx, cy = (b["rect"][0] + b["rect"][2]) // 2, (b["rect"][1] + b["rect"][3]) // 2
            ht, _ = timings("uia.hit_test button center", lambda: uia.hit_test(cx, cy, b["runtime_id"]), n=5)
            check("hit_test true on the button center", ht is True)
            other = marks[0]["rect"] if marks else None
            if other:
                ox, oy = (other[0] + other[2]) // 2, (other[1] + other[3]) // 2
                check("hit_test false on another element's center", uia.hit_test(ox, oy, b["runtime_id"]) is False)
                check("hit_test true for the other element on its own center",
                      uia.hit_test(ox, oy, marks[0]["runtime_id"]) is True)
            wl, wt, wr, wb = screen_rect(win.top)
            check("hit_test false on a point outside the window",
                  uia.hit_test(wr + 400, wb + 400, b["runtime_id"]) is False)
            check("hit_test false for an empty runtime_id", uia.hit_test(cx, cy, ()) is False)
            check("hit_test false for a made-up runtime_id", uia.hit_test(cx, cy, (42, 999999, 1)) is False)
            check("hit_test max_up=0 still matches the element itself",
                  uia.hit_test(cx, cy, b["runtime_id"], max_up=0) is True)

        # COM apartment handling: tolerate S_FALSE and RPC_E_CHANGED_MODE, balance only our own init
        ole32 = ctypes.WinDLL("ole32")
        ole32.CoInitializeEx.argtypes = [VP, wintypes.DWORD]
        ole32.CoInitializeEx.restype = ctypes.c_long
        ole32.CoUninitialize.argtypes = []
        box: dict = {}

        def apartments() -> None:
            ole32.CoInitializeEx(None, 2)                  # this thread is an STA already
            box["sta"] = uia._co_init()                    # RPC_E_CHANGED_MODE -> False, no uninit needed
            ole32.CoUninitialize()
            ole32.CoInitializeEx(None, 0)                  # MTA, then our call returns S_FALSE
            box["mta_false"] = uia._co_init()
            ole32.CoUninitialize()                         # balances _co_init's S_FALSE
            ole32.CoUninitialize()                         # balances the first init
        t = threading.Thread(target=apartments)
        t.start()
        t.join(5)
        check("_co_init reports False when the thread has another apartment", box.get("sta") is False, str(box))
        check("_co_init reports True (balance it) on S_FALSE", box.get("mta_false") is True, str(box))
        # a stuck FindAllBuildCache must degrade to the walker, not hang or fail
        # (the worker reaches the stage "have the window element", then FindAllBuildCache
        # stalls: only the search step is slowed, so the fallback is allowed)
        real_findall = uia._collect_findall

        def slow_findall(*a, **kw):
            time.sleep(1.5)
            return real_findall(*a, **kw)
        uia._collect_findall = slow_findall
        try:
            t0 = time.perf_counter()
            fb, fb_trunc = uia.elements(win.top, timeout_s=0.3)
            took = time.perf_counter() - t0
        finally:
            uia._collect_findall = real_findall
        check("a findall timeout falls back to the walker with results", len(fb) == len(els), f"{len(fb)} vs {len(els)}")
        check("a findall timeout marks the result truncated", fb_trunc is True)
        check("the fallback stays inside ONE budget of timeout_s + 0.3 s (+0.15 slack)",
              took < 0.3 + 0.3 + 0.15, f"{took:.2f} s")
        check("the fallback ran on the remaining budget, not a fresh one (well under 2 x)", took < 0.45, f"{took:.2f} s")
        # a worker stuck BEFORE the window element: no walker fallback, Unavailable at once
        real_open = uia._open

        def slow_open(*a, **kw):
            time.sleep(1.5)
            return real_open(*a, **kw)
        uia._open = slow_open
        try:
            t0 = time.perf_counter()
            try:
                uia.elements(win.top, timeout_s=0.5)
                stuck_raised = False
            except uia.Unavailable:
                stuck_raised = True
            took = time.perf_counter() - t0
        finally:
            uia._open = real_open
        check("a worker stuck before ElementFromHandle raises Unavailable (no fallback)", stuck_raised)
        check("...within timeout_s + 0.3 s", took < 0.5 + 0.3 + 0.15, f"{took:.2f} s")
        check("...after waiting on that worker for the whole budget (not at the 60% mark)", took >= 0.5 + 0.3 - 0.05,
              f"{took:.2f} s")
        # the same stall, but the worker answers inside the budget: the full list, no walker
        stall = {"s": 0.7}

        def short_open(*a, **kw):
            time.sleep(stall["s"])
            return real_open(*a, **kw)
        uia._open = short_open
        try:
            t0 = time.perf_counter()
            late, late_trunc = uia.elements(win.top, timeout_s=1.0)
            took = time.perf_counter() - t0
        finally:
            uia._open = real_open
        check("a worker that answers after the 60% mark but inside the budget gives the full list",
              len(late) == len(els) and late_trunc is False, f"{len(late)} vs {len(els)} truncated={late_trunc}")
        check("...within timeout_s + 0.3 s and not before the stall ended", 0.65 <= took < 1.0 + 0.3 + 0.15,
              f"{took:.2f} s")
        # past the window element, FindAllBuildCache needs 0.7 x T and the walker (as on a big
        # tree) is slower still: the first worker's full answer must win, not the walker's partial
        real_walk = uia._collect_walk

        def late_findall(*a, **kw):
            time.sleep(0.7)
            return real_findall(*a, **kw)

        def slow_walk(*a, **kw):
            time.sleep(0.4)
            return real_walk(*a, **kw)
        uia._collect_findall, uia._collect_walk = late_findall, slow_walk
        try:
            t0 = time.perf_counter()
            race, race_trunc = uia.elements(win.top, timeout_s=1.0)
            took = time.perf_counter() - t0
        finally:
            uia._collect_findall, uia._collect_walk = real_findall, real_walk
        check("a findall that lands after the 60% mark but before the walker gives the full list",
              len(race) == len(els) and race_trunc is False, f"{len(race)} vs {len(els)} truncated={race_trunc}")
        check("...within T + 0.3 s and not before findall ended", 0.65 <= took < 1.0 + 0.3 + 0.15, f"{took:.2f} s")
        # IUIAutomation2 really is in force (CLSID_CUIAutomation8), read back through the getter slots
        info = uia._diagnose(1.0)
        check("client object comes from CUIAutomation8", info.get("clsid") == "CUIAutomation8", str(info))
        check("QueryInterface(IUIAutomation2) succeeded", info.get("iuia2") is True, str(info))
        check("AutoSetFocus reads back FALSE", info.get("auto_set_focus") == 0, str(info))
        check("TransactionTimeout reads back from the remaining budget (<= 1000 ms, > 800 ms)",
              800 < info.get("transaction_ms", -1) <= 1000, str(info))
        check("ConnectionTimeout reads back from the remaining budget",
              800 < info.get("connection_ms", -1) <= 1000, str(info))
        check("the timeouts follow the budget given", 400 < uia._diagnose(0.5)["transaction_ms"] <= 500)
        real_clsid = uia._CLSID_CUIAutomation8
        uia._CLSID_CUIAutomation8 = "11111111-1111-1111-1111-111111111111"      # not registered
        try:
            old = uia._diagnose(1.0)
            old_els, _ = uia.elements(win.top)
        finally:
            uia._CLSID_CUIAutomation8 = real_clsid
        check("fallback to CUIAutomation when CUIAutomation8 cannot be created", old.get("clsid") == "CUIAutomation", str(old))
        check("...the fallback class has no IUIAutomation2, and that is reported", old.get("iuia2") is False, str(old))
        check("...and elements() still works on the fallback class", len(old_els) == len(els))
        time.sleep(1.6)                                   # let the abandoned test workers finish
    finally:
        win.stop()
    check("test window destroyed", win.destroyed)
    try:
        uia.elements(win.top)            # our own, now destroyed, handle
        check("destroyed handle raises Unavailable", False)
    except uia.Unavailable:
        check("destroyed handle raises Unavailable", True)
    check_foreground("foreground window unchanged", fg_before)


def test_uia_hung() -> None:
    """A window whose owner thread stops pumping: the caller must get Unavailable inside the
    documented bound (timeout_s + 0.3 s) for elements and find; a stall of about 0.8 x T gives the
    full list (hit_test is in test_hit_test_hung)."""
    import uia
    fg_before = user32.GetForegroundWindow()
    win = TestWindow(-32000, -32000)                 # parked off-screen, non-activating
    win.start()
    hang_s = 3.0
    try:
        win.ready.wait(5.0)
        check("hung-test window created", bool(win.top) and not win.error, win.error)
        if not win.top:
            return
        time.sleep(0.15)
        good = uia.elements(win.top)[0]
        check("the window answers before it hangs", len(good) >= 3, str(len(good)))
        t_hang = time.perf_counter()
        win.hang(hang_s)
        time.sleep(0.1)
        timeout_s = 0.5
        bound = timeout_s + 0.3
        t0 = time.perf_counter()
        try:
            uia.elements(win.top, timeout_s=timeout_s)
            raised = False
        except uia.Unavailable:
            raised = True
        took = time.perf_counter() - t0
        check("elements() on a hung window raises Unavailable (no partial list)", raised)
        check(f"...within the stated bound timeout_s + 0.3 = {bound:.1f} s (+0.15 slack)",
              took < bound + 0.15, f"{took:.2f} s")
        print(f"TIMING hung window elements(timeout_s={timeout_s}): {took * 1000:.0f} ms")
        t0 = time.perf_counter()
        try:
            uia.find(win.top, "save probe", timeout_s=timeout_s)
            raised = False
        except uia.Unavailable:
            raised = True
        took = time.perf_counter() - t0
        check("find() on a hung window raises Unavailable", raised)
        check("...within the same bound", took < bound + 0.15, f"{took:.2f} s")
        left = hang_s - (time.perf_counter() - t_hang) + 0.3
        if left > 0:
            time.sleep(left)                           # the window pumps again
        # a short wait: the abandoned workers finish once the provider answers again
        again = uia.elements(win.top)[0]
        check("after the window resumes, elements() works again", len(again) == len(good), f"{len(again)} vs {len(good)}")
        # A stall of about 0.8 x T (past the 60% mark, inside the budget) must still
        # give the FULL list inside T + 0.3 s: the caller keeps waiting on the first worker
        t_s = 1.0
        win.hang(0.9)
        time.sleep(0.1)                                # the owner thread now has about 0.8 s of stall left
        t0 = time.perf_counter()
        late, late_trunc = uia.elements(win.top, timeout_s=t_s)
        took = time.perf_counter() - t0
        check("a window that stops pumping for about 0.8 x T returns the full list",
              len(late) == len(good) and late_trunc is False, f"{len(late)} vs {len(good)} truncated={late_trunc}")
        check("...within T + 0.3 s (+0.15 slack)", took < t_s + 0.3 + 0.15, f"{took:.2f} s")
        check("...and the call really waited through the stall (not a vacuous pass)", took >= 0.5, f"{took:.2f} s")
        print(f"TIMING hung window, stall 0.8 x T (T={t_s}): elements() returned the full list in {took * 1000:.0f} ms")
        time.sleep(0.3)
    finally:
        win.stop()
    check("hung-test window destroyed", win.destroyed)
    check_foreground("foreground window unchanged (hung window test)", fg_before)


def test_hit_test_hung() -> None:
    """hit_test against a window ElementFromPoint can reach (parked at -20000,-20000, where the
    plain test proved it answers), hung: Unavailable at timeout_s + 0.3 s."""
    import uia
    fg_before = user32.GetForegroundWindow()
    win = TestWindow(-20000, -20000)
    win.start()
    try:
        win.ready.wait(5.0)
        check("hit_test hung-window created", bool(win.top) and not win.error, win.error)
        if not win.top:
            return
        time.sleep(0.15)
        hits = uia.find(win.top, "save probe", "Button")[0]
        check("the second window's button is found", len(hits) == 1, str(len(hits)))
        if len(hits) != 1:
            return
        b = hits[0]
        cx, cy = (b["rect"][0] + b["rect"][2]) // 2, (b["rect"][1] + b["rect"][3]) // 2
        before = uia.hit_test(cx, cy, b["runtime_id"])
        check("hit_test(button center, button runtime_id) is True BEFORE the hang (the point reaches the window)",
              before is True)
        t_hang = time.perf_counter()
        hang_s = 2.5
        win.hang(hang_s)
        time.sleep(0.1)
        timeout_s = 0.5
        bound = timeout_s + 0.3
        t0 = time.perf_counter()
        try:
            res = uia.hit_test(cx, cy, b["runtime_id"], timeout_s=timeout_s)
            outcome = f"returned {res!r}"
            raised = False
        except uia.Unavailable as e:
            outcome, raised = f"raised {type(e).__name__}", True
        took = time.perf_counter() - t0
        print(f"INFO hung hit_test at the button center {outcome} in {took * 1000:.0f} ms")
        check("hit_test() on a hung window raises Unavailable (it does not report a false answer)", raised, outcome)
        check(f"...within timeout_s + 0.3 = {bound:.1f} s (+0.15 slack)", took < bound + 0.15, f"{took:.2f} s")
        check("...and not before it could have answered (waited about the budget)", took >= timeout_s * 0.8, f"{took:.2f} s")
        left = hang_s - (time.perf_counter() - t_hang) + 0.3
        if left > 0:
            time.sleep(left)
        check("after the window resumes, hit_test is True again",
              uia.hit_test(cx, cy, b["runtime_id"]) is True)
    finally:
        win.stop()
    check("hit_test hung window destroyed", win.destroyed)
    check_foreground("foreground window unchanged (hung hit_test)", fg_before)


def test_readonly_source() -> None:
    """The read-only invariant, checked on the SOURCE of uia.py: it calls COM by slot number,
    so a token scan cannot see a regression to SetFocus or a pattern getter."""
    import re
    src = open(os.path.join(HERE, "uia.py"), "r", encoding="ascii").read()
    # IUIAutomationElement slots, verified against UIAutomationClient.h IUIAutomationElementVtbl:
    # 4 GetRuntimeId, 8 FindAllBuildCache, 12 GetCachedPropertyValue, 53 get_CachedControlType,
    # 55 get_CachedName, 60 get_CachedIsEnabled, 61 get_CachedAutomationId, 67 get_CachedIsPassword,
    # 70 get_CachedIsOffscreen, 75 get_CachedBoundingRectangle (+ IUnknown 0/1/2)
    allowed = {0, 1, 2, 4, 8, 12, 53, 55, 60, 61, 67, 70, 75}
    forbidden = {3: "SetFocus", 14: "GetCurrentPatternAs", 15: "GetCachedPatternAs",
                 16: "GetCurrentPattern", 17: "GetCachedPattern"}
    calls = re.findall(r"\b_call\(\s*([A-Za-z_][A-Za-z_0-9.]*)\s*,\s*(\d+)\s*,", src)
    element_vars = {"el", "root", "root_p", "cur"}
    on_elements = [(v, int(s)) for v, s in calls if v in element_vars]
    check("uia.py makes _call()s on element variables (the scan sees something)", len(on_elements) >= 8, str(on_elements))
    bad = [(v, s) for v, s in on_elements if s not in allowed]
    check("every _call on an element variable uses an allowed read slot", not bad, str(bad))
    check("no _call on an element variable targets SetFocus (3) or a pattern getter",
          not any(s in forbidden for _, s in on_elements))
    # the walker's step() helper receives an element but calls the TreeWalker: its slots are 10 and 12
    steps = re.findall(r"\bstep\(\s*(\d+)\s*,", src)
    check("walker step() uses only slots 10 and 12 (GetFirstChild / GetNextSibling BuildCache)",
          steps and set(int(s) for s in steps) <= {10, 12}, str(steps))
    # no call on ANY object may use a pattern-getter or SetFocus slot unless it is a known non-element
    # object: cache request / element array / tree walker / IUIAutomation2 are listed explicitly
    non_element = {"sess.cr": {3, 11}, "arr_p": {3, 4}, "walker_p": {3}, "sess.auto": {0, 6, 7, 16, 20, 21},
                   "a2": {58, 59, 60, 61, 62, 63}, "obj": {2}}   # IUIAutomation2 getters 58/60/62, setters 59/61/63
    unknown = [(v, int(s)) for v, s in calls
               if v not in element_vars and (v not in non_element or int(s) not in non_element[v])]
    check("every other _call is on a known non-element object with a known slot", not unknown, str(unknown))
    check("no line of uia.py names SetFocus/SetValue/a pattern getter next to a _call",
          not re.search(r"\b(SetFocus|SetValue|GetCurrentPattern|GetCachedPattern)\b[^\n]*_call", src))
    # the regex above sees only literal slots: every other _call( / _fn( site must be listed on
    # purpose (the definitions, _call's own _fn use, and step()'s _call(walker_p, slot, ...))
    all_call = len(re.findall(r"\b_call\(", src))
    all_fn = len(re.findall(r"\b_fn\(", src))
    known_other_call = 2      # "def _call(" and step()'s "_call(walker_p, slot, ...)"
    known_fn = 2              # "def _fn(" and "return _fn(obj, slot, argtypes)" inside _call
    check("every _call( site is a literal-slot call or a listed one",
          all_call == len(calls) + known_other_call, f"{all_call} vs {len(calls)} + {known_other_call}")
    check("no _fn( call besides the listed ones", all_fn == known_fn, str(all_fn))


def test_imports() -> None:
    code = (
        "import sys, threading, time\n"
        "sys.dont_write_bytecode = True\n"
        "sys.path.insert(0, %r)\n"
        "t = time.perf_counter()\n"
        "import uia, ocr\n"
        "ms = (time.perf_counter() - t) * 1000\n"
        "bad = [m for m in ('screenctl', 'autodrive') if m in sys.modules]\n"
        "print(threading.active_count(), bad, '%%.1f' %% ms)\n"
    ) % HERE
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    p = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, timeout=30)
    out = p.stdout.strip()
    check("import uia, ocr succeeds", p.returncode == 0, p.stderr[-300:])
    parts = out.split(" ", 1)
    check("import starts no threads", parts[0] == "1", out)
    check("import pulls in no screenctl/autodrive", "[]" in out, out)
    print(f"TIMING import uia+ocr: {out.rsplit(' ', 1)[-1]} ms (subprocess)")
    banned = (b"CopyFromScreen", b"BitBlt", b"powershell.exe", b"pwsh", b"import subprocess", b"keybd_event",
              b"SendInput", b"mouse_event", b"SetCursorPos", b"SetForegroundWindow", b"AttachThreadInput")
    for name in ("uia.py", "ocr.py", "_test_winsurfaces.py"):
        data = open(os.path.join(HERE, name), "rb").read()
        check(f"{name} is ASCII only", all(b < 128 for b in data))
        if name != "_test_winsurfaces.py":
            check(f"{name} has no screen grab, no subprocess, no input or focus call",
                  not any(tok in data for tok in banned), str([t for t in banned if t in data]))


def _run_one(fn) -> None:
    try:
        fn()
    except Exception as e:                                        # noqa: BLE001
        import traceback
        traceback.print_exc()
        check(f"{fn.__name__} ran without an exception", False, f"{type(e).__name__}: {e}")


def test_no_pycache() -> None:
    check("no __pycache__ appeared in scripts/ after importing uia and ocr",
          not os.path.isdir(os.path.join(HERE, "__pycache__")))


def _run_all(fns) -> int:
    global PASSED
    for fn in fns:
        before, passed_before = len(INCONCLUSIVE), PASSED
        _run_one(fn)
        if len(INCONCLUSIVE) > before:
            del INCONCLUSIVE[before:]
            PASSED = passed_before                                # a first-run FAIL still stands
            print(f"re-running {fn.__name__} once: the foreground moved to another process during it")
            _run_one(fn)
    if FAILED:
        print(f"{len(FAILED)} FAILED of {PASSED + len(FAILED)}: " + "; ".join(FAILED))
        return 1
    if INCONCLUSIVE:
        print(f"INCONCLUSIVE (exit 3, not a pass): the foreground moved to another process again during: "
              + "; ".join(INCONCLUSIVE) + ". Re-run while nobody uses the desktop.")
        return 3
    print(f"all {PASSED} checks passed")
    return 0


def main() -> int:
    return _run_all((test_foreground_logic, test_imports, test_readonly_source, test_ocr, test_uia,
                     test_uia_hung, test_hit_test_hung, test_no_pycache))


if __name__ == "__main__":
    sys.exit(main())
