#!/usr/bin/env python3
"""
uia - read-only UI Automation access for screenctl, through ctypes COM vtable calls.

  elements(hwnd, max_nodes=3000, timeout_s=2.0) -> (list[dict], truncated: bool)
  find(hwnd, text, control=None, exact=False, max_nodes=3000, timeout_s=2.0)
        -> (list[dict], truncated: bool)
  hit_test(x, y, runtime_id, max_up=12) -> bool

Each element dict: {"name", "value", "control", "automation_id",
                    "rect": (left, top, right, bottom) in screen px,
                    "enabled", "offscreen", "runtime_id": tuple[int, ...],
                    "is_password": bool}.   value is "" when is_password is true.

`truncated` is true when the result may be incomplete: more nodes than max_nodes, the
deadline cut a walk short, the walker depth cap was hit, or FindAllBuildCache timed out and
the walker fallback ran (it can finish the tree, but the caller cannot tell).

READ-ONLY: this module reads cached properties only (hit_test reads one
live RuntimeId per ancestor). It never invokes a pattern, never calls SetFocus, never sets
a value. The client object is created from CLSID_CUIAutomation8 (the only class that
implements IUIAutomation2; the older CLSID_CUIAutomation answers E_NOINTERFACE to that
QueryInterface) with the older class as the fallback. When
IUIAutomation2 is there, AutoSetFocus is switched OFF as an extra guard (its default is ON)
and the Connection/Transaction timeouts are set from the REMAINING budget of the call; the
values are read back through the getter slots (see _diagnose()). On the fallback class those
settings cannot be applied and the defaults stay (AutoSetFocus matters only to pattern
calls, which this module never makes).

How it works: CoCreateInstance(CUIAutomation8) -> ElementFromHandle -> ONE
FindAllBuildCache(TreeScope_Descendants, TrueCondition, CacheRequest) so every property
arrives in a single cross-process round trip. If that call fails, a TreeWalker walk
bounded by max_nodes and timeout_s is used instead (partial results on a timeout).

Threading: every call runs on its OWN short-lived worker thread that initializes COM as
MTA, so the caller's thread needs no COM setup and its apartment is never touched.

Time bound (measured against a window whose thread stopped pumping messages): the caller
waits at most timeout_s + 0.3 s IN TOTAL for elements() and find() (one budget shared by the
FindAllBuildCache attempt and the TreeWalker fallback; the fallback gets only what is left),
and at most timeout_s + 0.3 s for hit_test(). While the first worker is still before the
window element at the 60% mark of timeout_s, the caller keeps waiting on THAT worker (no
walker is started: it would block on the same provider) until it answers or the whole
budget is spent; a provider that answers inside the budget therefore gives the full list.
A hung provider ends in Unavailable (never in a partial list) after at most that long.
This is a bound on the CALLER only. An abandoned worker cannot be canceled by us: its
daemon thread (up to 2 per elements() call, 1 per hit_test()) stays alive until the
provider call returns, then cleans up its COM objects. Against a hung cross-process
window: with IUIAutomation2 in force the Transaction timeout (the remaining budget in ms)
ends the stalled provider call from the inside, so the call fails at about timeout_s, no
worker outlives it and nothing stacks; on the fallback class (no IUIAutomation2) the call
ends at timeout_s + 0.3 s and each abandoned worker lives until the window pumps again,
so repeated calls stack workers.
A hung hit_test raises Unavailable in both cases (ElementFromPoint answers UIA_E_TIMEOUT).

Coordinates are returned in the calling PROCESS's DPI context; screenctl makes the process
per-monitor DPI aware at import, which makes them physical pixels like its own geometry.

Vtable slot numbers below count IUnknown (0 QueryInterface, 1 AddRef, 2 Release). Source of
every IID, CLSID, property id and slot order: the Windows SDK header UIAutomationClient.h
(Vtbl structs, in declaration order).
"""

from __future__ import annotations

import ctypes
import threading
import time
from ctypes import wintypes

if ctypes.sizeof(ctypes.c_void_p) != 8:          # VARIANT layout below assumes 64-bit
    raise ImportError("uia.py needs 64-bit Python")


class Unavailable(Exception):
    """UI Automation could not be used; str(e) is the reason."""


# ---- ctypes setup (the only import-time work) -----------------------------------------
_ole32 = ctypes.WinDLL("ole32")
_oleaut32 = ctypes.WinDLL("oleaut32")
_ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
_ole32.CoInitializeEx.restype = ctypes.c_long
_ole32.CoUninitialize.argtypes = []
_ole32.CoCreateInstance.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD,
                                    ctypes.c_void_p, ctypes.c_void_p]
_ole32.CoCreateInstance.restype = ctypes.c_long
_oleaut32.SysFreeString.argtypes = [ctypes.c_void_p]
_oleaut32.VariantClear.argtypes = [ctypes.c_void_p]
_oleaut32.VariantClear.restype = ctypes.c_long
_oleaut32.SafeArrayGetLBound.argtypes = [ctypes.c_void_p, wintypes.UINT, ctypes.c_void_p]
_oleaut32.SafeArrayGetLBound.restype = ctypes.c_long
_oleaut32.SafeArrayGetUBound.argtypes = [ctypes.c_void_p, wintypes.UINT, ctypes.c_void_p]
_oleaut32.SafeArrayGetUBound.restype = ctypes.c_long
_oleaut32.SafeArrayAccessData.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
_oleaut32.SafeArrayAccessData.restype = ctypes.c_long
_oleaut32.SafeArrayUnaccessData.argtypes = [ctypes.c_void_p]
_oleaut32.SafeArrayUnaccessData.restype = ctypes.c_long
_oleaut32.SafeArrayDestroy.argtypes = [ctypes.c_void_p]
_oleaut32.SafeArrayDestroy.restype = ctypes.c_long

_RPC_E_CHANGED_MODE = -2147417850          # 0x80010106: the thread already has another apartment
_UIA_E_TIMEOUT = 0x80131505 - (1 << 32)    # UIAutomationCoreApi.h (COR_E_TIMEOUT), as a signed HRESULT


class _GUID(ctypes.Structure):
    _fields_ = [("a", ctypes.c_ulong), ("b", ctypes.c_ushort), ("c", ctypes.c_ushort),
                ("d", ctypes.c_ubyte * 8)]


def _guid(text: str) -> _GUID:
    import uuid                      # tiny; kept out of the import path
    u = uuid.UUID(text)
    g = _GUID()
    g.a, g.b, g.c = u.time_low, u.time_mid, u.time_hi_version
    for i, byte in enumerate(u.bytes[8:]):
        g.d[i] = byte
    return g


class _VARIANT(ctypes.Structure):
    # 24 bytes on x64: vt + 3 reserved words + a 16-byte union (BRECORD is two pointers).
    _fields_ = [("vt", ctypes.c_ushort), ("r1", ctypes.c_ushort), ("r2", ctypes.c_ushort),
                ("r3", ctypes.c_ushort), ("data", ctypes.c_ubyte * 16)]


class _RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class _POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


VT_BSTR = 8
VT_ARRAY_I4 = 0x2003                        # VT_ARRAY | VT_I4 (RuntimeId)

# CLSID_CUIAutomation8 (UIAutomationClient.h, class CUIAutomation8 declared with
# DECLSPEC_UUID e22ad333-...), CLSID_CUIAutomation, IID_IUIAutomation,
# IID_IUIAutomation2 (its MIDL_INTERFACE). Only CUIAutomation8 answers QueryInterface
# for IUIAutomation2 (E_NOINTERFACE from the older class).
_CLSID_CUIAutomation8 = "e22ad333-b25f-460c-83d0-0581107395c9"
_CLSID_CUIAutomation = "ff48dba4-60ef-4201-aa87-54103eef594e"
_IID_IUIAutomation = "30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"
_IID_IUIAutomation2 = "34723aff-0c9d-49d0-9896-7ab52df8cd8a"

# property ids (UIAutomationClient.h UIA_*PropertyId)
_P_RUNTIME_ID = 30000
_P_BOUNDING_RECT = 30001
_P_CONTROL_TYPE = 30003
_P_NAME = 30005
_P_IS_ENABLED = 30010
_P_AUTOMATION_ID = 30011
_P_IS_PASSWORD = 30019
_P_IS_OFFSCREEN = 30022
_P_VALUE_VALUE = 30045

_TREESCOPE_DESCENDANTS = 4
_MODE_NONE, _MODE_FULL = 0, 1             # AutomationElementMode

_CONTROL_NAMES = {
    50000: "Button", 50001: "Calendar", 50002: "CheckBox", 50003: "ComboBox", 50004: "Edit",
    50005: "Hyperlink", 50006: "Image", 50007: "ListItem", 50008: "List", 50009: "Menu",
    50010: "MenuBar", 50011: "MenuItem", 50012: "ProgressBar", 50013: "RadioButton",
    50014: "ScrollBar", 50015: "Slider", 50016: "Spinner", 50017: "StatusBar", 50018: "Tab",
    50019: "TabItem", 50020: "Text", 50021: "ToolBar", 50022: "ToolTip", 50023: "Tree",
    50024: "TreeItem", 50025: "Custom", 50026: "Group", 50027: "Thumb", 50028: "DataGrid",
    50029: "DataItem", 50030: "Document", 50031: "SplitButton", 50032: "Window",
    50033: "Pane", 50034: "Header", 50035: "HeaderItem", 50036: "Table", 50037: "TitleBar",
    50038: "Separator", 50039: "SemanticZoom", 50040: "AppBar",
}

# ---- COM vtable plumbing ----------------------------------------------------------------
_PROTOS: dict = {}


def _fn(obj: int, slot: int, argtypes: tuple):
    key = argtypes
    proto = _PROTOS.get(key)
    if proto is None:
        proto = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, *argtypes)
        _PROTOS[key] = proto
    vtbl = ctypes.cast(ctypes.c_void_p(obj), ctypes.POINTER(ctypes.c_void_p))[0]
    entry = ctypes.cast(ctypes.c_void_p(vtbl), ctypes.POINTER(ctypes.c_void_p))[slot]
    return proto(entry)


_VP = ctypes.c_void_p
_INT = ctypes.c_int


def _call(obj: int, slot: int, argtypes: tuple, *args) -> int:
    return _fn(obj, slot, argtypes)(obj, *args)


def _check(hr: int, what: str) -> None:
    if hr < 0:
        raise Unavailable(f"{what} failed (HRESULT 0x{hr & 0xFFFFFFFF:08X})")


def _release(obj) -> None:
    if obj:
        try:
            _call(obj, 2, ())                                  # IUnknown::Release
        except Exception:
            pass


def _bstr(ptr: int) -> str:
    if not ptr:
        return ""
    try:
        return ctypes.wstring_at(ptr)
    finally:
        _oleaut32.SysFreeString(ptr)


class _Session:
    """One IUIAutomation client plus the objects derived from it; close() releases all."""

    def __init__(self) -> None:
        self.owned: list[int] = []
        self.auto = 0
        self.cr = 0
        self.settings: dict = {}            # what _open() found / applied (see _diagnose)

    def take(self, ptr) -> int:
        ptr = int(ptr or 0)
        if ptr:
            self.owned.append(ptr)
        return ptr

    def drop(self, ptr: int) -> None:
        if ptr in self.owned:
            self.owned.remove(ptr)
        _release(ptr)

    def close(self) -> None:
        for ptr in reversed(self.owned):
            _release(ptr)
        self.owned.clear()


def _co_init() -> bool:
    """COINIT_MULTITHREADED. Returns True when this call must be balanced by CoUninitialize
    (S_OK and S_FALSE both count); False on RPC_E_CHANGED_MODE (the thread already has an
    apartment of its own, which we use as it is and do not uninitialize)."""
    hr = _ole32.CoInitializeEx(None, 0)
    if hr == _RPC_E_CHANGED_MODE:
        return False
    if hr < 0:
        raise Unavailable(f"CoInitializeEx failed (HRESULT 0x{hr & 0xFFFFFFFF:08X})")
    return True


def _safearray_ints(psa: int) -> tuple:
    """The int32 elements of a one-dimensional SAFEARRAY (a RuntimeId)."""
    if not psa:
        return ()
    lo, hi = ctypes.c_long(0), ctypes.c_long(-1)
    if _oleaut32.SafeArrayGetLBound(psa, 1, ctypes.byref(lo)) < 0:
        return ()
    if _oleaut32.SafeArrayGetUBound(psa, 1, ctypes.byref(hi)) < 0:
        return ()
    n = hi.value - lo.value + 1
    if n <= 0 or n > 64:
        return ()
    data = ctypes.c_void_p()
    if _oleaut32.SafeArrayAccessData(psa, ctypes.byref(data)) < 0 or not data.value:
        return ()
    try:
        return tuple(ctypes.cast(data, ctypes.POINTER(ctypes.c_int32))[i] for i in range(n))
    finally:
        _oleaut32.SafeArrayUnaccessData(psa)


def _open(sess: _Session, remaining_s: float, cache: bool = True) -> None:
    """Create the client, apply the IUIAutomation2 settings, build the cache request.
    `remaining_s` is what is left of the caller's budget for this call; the provider
    timeouts are sized from it. sess.settings records what is actually in force."""
    iid = _guid(_IID_IUIAutomation)
    hr = -1
    out = ctypes.c_void_p()
    created = ""
    for label, text in (("CUIAutomation8", _CLSID_CUIAutomation8),
                        ("CUIAutomation", _CLSID_CUIAutomation)):
        out = ctypes.c_void_p()
        clsid = _guid(text)
        hr = _ole32.CoCreateInstance(ctypes.byref(clsid), None, 1, ctypes.byref(iid),
                                     ctypes.byref(out))        # CLSCTX_INPROC_SERVER
        if hr >= 0 and out.value:
            created = label
            break
    if not created:
        raise Unavailable(f"CoCreateInstance(CUIAutomation8 and CUIAutomation) failed "
                          f"(HRESULT 0x{hr & 0xFFFFFFFF:08X})")
    sess.auto = sess.take(out.value)
    sess.settings = {"clsid": created, "iuia2": False}
    # Optional IUIAutomation2 (slot 58 get_AutoSetFocus, 59 put_AutoSetFocus, 60 get / 61 put
    # ConnectionTimeout, 62 get / 63 put TransactionTimeout): never auto-set focus, and size
    # both provider timeouts from the REMAINING budget. Failure here is not an error (the
    # older class has no IUIAutomation2); the values are read back so a silent failure shows.
    out2 = ctypes.c_void_p()
    iid2 = _guid(_IID_IUIAutomation2)
    hr = _call(sess.auto, 0, (_VP, _VP), ctypes.byref(iid2), ctypes.byref(out2))  # IUnknown 0 QueryInterface
    if hr >= 0 and out2.value:
        a2 = out2.value
        ms = max(100, int(remaining_s * 1000))
        _call(a2, 59, (_INT,), 0)                  # IUIAutomation2::put_AutoSetFocus(FALSE)
        _call(a2, 61, (wintypes.DWORD,), ms)       # IUIAutomation2::put_ConnectionTimeout
        _call(a2, 63, (wintypes.DWORD,), ms)       # IUIAutomation2::put_TransactionTimeout
        focus, conn, txn = ctypes.c_int(-1), ctypes.c_ulong(0), ctypes.c_ulong(0)
        _call(a2, 58, (_VP,), ctypes.byref(focus))  # IUIAutomation2::get_AutoSetFocus
        _call(a2, 60, (_VP,), ctypes.byref(conn))   # IUIAutomation2::get_ConnectionTimeout
        _call(a2, 62, (_VP,), ctypes.byref(txn))    # IUIAutomation2::get_TransactionTimeout
        _release(a2)
        sess.settings.update(iuia2=True, auto_set_focus=focus.value,
                             connection_ms=conn.value, transaction_ms=txn.value)
    if not cache:
        return
    # IUIAutomation slot 20 CreateCacheRequest
    out = ctypes.c_void_p()
    _check(_call(sess.auto, 20, (_VP,), ctypes.byref(out)), "CreateCacheRequest")
    sess.cr = sess.take(out.value)
    for pid in (_P_NAME, _P_VALUE_VALUE, _P_CONTROL_TYPE, _P_AUTOMATION_ID,
                _P_BOUNDING_RECT, _P_IS_ENABLED, _P_IS_OFFSCREEN, _P_IS_PASSWORD,
                _P_RUNTIME_ID):
        _check(_call(sess.cr, 3, (_INT,), pid), "CacheRequest.AddProperty")  # IUIAutomationCacheRequest 3 AddProperty


def _read(el: int) -> dict:
    """Read the cached properties of one element (IUIAutomationElement slots)."""
    p = ctypes.c_void_p()
    _call(el, 55, (_VP,), ctypes.byref(p))                     # get_CachedName
    name = _bstr(p.value)
    p = ctypes.c_void_p()
    _call(el, 61, (_VP,), ctypes.byref(p))                     # get_CachedAutomationId
    auto_id = _bstr(p.value)
    ctl = ctypes.c_int(0)
    _call(el, 53, (_VP,), ctypes.byref(ctl))                   # get_CachedControlType
    rect = _RECT()
    _call(el, 75, (_VP,), ctypes.byref(rect))                  # get_CachedBoundingRectangle
    en = ctypes.c_int(0)
    _call(el, 60, (_VP,), ctypes.byref(en))                    # get_CachedIsEnabled
    off = ctypes.c_int(0)
    _call(el, 70, (_VP,), ctypes.byref(off))                   # get_CachedIsOffscreen
    pw = ctypes.c_int(0)
    _call(el, 67, (_VP,), ctypes.byref(pw))                    # get_CachedIsPassword
    is_password = bool(pw.value)
    var = _VARIANT()
    value = ""
    if not is_password:                                         # never even read a password value
        hr = _call(el, 12, (_INT, _VP), _P_VALUE_VALUE, ctypes.byref(var))  # GetCachedPropertyValue
        if hr >= 0:
            if var.vt == VT_BSTR:
                bptr = ctypes.c_void_p.from_buffer(var.data).value
                value = ctypes.wstring_at(bptr) if bptr else ""
            _oleaut32.VariantClear(ctypes.byref(var))          # frees the BSTR / unknown
    rid: tuple = ()
    var = _VARIANT()
    hr = _call(el, 12, (_INT, _VP), _P_RUNTIME_ID, ctypes.byref(var))   # GetCachedPropertyValue
    if hr >= 0:
        if var.vt == VT_ARRAY_I4:
            rid = _safearray_ints(ctypes.c_void_p.from_buffer(var.data).value)
        _oleaut32.VariantClear(ctypes.byref(var))              # destroys the SAFEARRAY
    return {"name": name, "value": value,
            "control": _CONTROL_NAMES.get(ctl.value, f"Control{ctl.value}"),
            "automation_id": auto_id,
            "rect": (rect.left, rect.top, rect.right, rect.bottom),
            "enabled": bool(en.value), "offscreen": bool(off.value),
            "runtime_id": rid, "is_password": is_password}


def _collect_findall(sess: _Session, root: int, max_nodes: int, deadline: float) -> tuple:
    # IUIAutomationCacheRequest slot 11 put_AutomationElementMode: no live references needed
    _check(_call(sess.cr, 11, (_INT,), _MODE_NONE), "put_AutomationElementMode")
    cond = ctypes.c_void_p()
    # IUIAutomation slot 21 CreateTrueCondition(**condition)
    _check(_call(sess.auto, 21, (_VP,), ctypes.byref(cond)), "CreateTrueCondition")
    cond_p = sess.take(cond.value)
    arr = ctypes.c_void_p()
    # IUIAutomationElement slot 8 FindAllBuildCache(scope, condition, cacheRequest, **array)
    hr = _call(root, 8, (_INT, _VP, _VP, _VP), _TREESCOPE_DESCENDANTS, cond_p, sess.cr,
               ctypes.byref(arr))
    _check(hr, "FindAllBuildCache")
    arr_p = sess.take(arr.value)
    if not arr_p:
        return [], False
    n = ctypes.c_int(0)
    _check(_call(arr_p, 3, (_VP,), ctypes.byref(n)), "ElementArray.get_Length")  # IUIAutomationElementArray 3
    out: list[dict] = []
    truncated = n.value > max_nodes
    for i in range(min(n.value, max_nodes)):
        if time.perf_counter() > deadline:
            truncated = True
            break
        el = ctypes.c_void_p()
        if _call(arr_p, 4, (_INT, _VP), i, ctypes.byref(el)) < 0 or not el.value:  # GetElement
            continue
        try:
            out.append(_read(el.value))
        finally:
            _release(el.value)
    return out, truncated


def _collect_walk(sess: _Session, root: int, max_nodes: int, deadline: float) -> tuple:
    """Pre-order walk with the raw-view TreeWalker, one cached call per node. Reads one node
    past max_nodes to learn whether the tree continues (that extra node is dropped)."""
    _check(_call(sess.cr, 11, (_INT,), _MODE_FULL), "put_AutomationElementMode")
    walker = ctypes.c_void_p()
    _check(_call(sess.auto, 16, (_VP,), ctypes.byref(walker)), "get_RawViewWalker")  # IUIAutomation 16
    walker_p = sess.take(walker.value)
    out: list[dict] = []
    path: list[int] = []                    # owned ancestors
    cur = 0
    truncated = False

    def step(slot: int, el: int) -> int:
        # ITreeWalker slot 10 GetFirstChildElementBuildCache, 12 GetNextSiblingElementBuildCache
        res = ctypes.c_void_p()
        hr = _call(walker_p, slot, (_VP, _VP, _VP), el, sess.cr, ctypes.byref(res))
        return int(res.value or 0) if hr >= 0 else 0

    try:
        cur = step(10, root)
        depth_cap = 64
        while cur:
            out.append(_read(cur))
            if len(out) > max_nodes:
                out.pop()
                truncated = True
                break
            if time.perf_counter() > deadline:
                truncated = True
                break
            if len(path) >= depth_cap:
                truncated = True
            child = step(10, cur) if len(path) < depth_cap else 0
            if child:
                path.append(cur)
                cur = child
                continue
            while True:
                sib = step(12, cur)
                _release(cur)
                cur = 0
                if sib:
                    cur = sib
                    break
                if not path:
                    break
                cur = path.pop()
    finally:
        _release(cur)
        for anc in path:
            _release(anc)
    return out, truncated


_STAGE_START, _STAGE_OPENED, _STAGE_ROOT = 0, 1, 2     # how far a worker got (see elements())


def _elements_impl(hwnd: int, max_nodes: int, timeout_s: float, method: str,
                   prog: dict | None = None) -> tuple:
    """`prog`, if given, receives {"stage": ...} as the worker advances, so a caller that
    gave up on it can tell a worker stuck before the tree from one stuck inside the search."""
    need_uninit = _co_init()
    sess = _Session()
    try:
        deadline = time.perf_counter() + timeout_s
        _open(sess, deadline - time.perf_counter())
        if prog is not None:
            prog["stage"] = _STAGE_OPENED               # CreateCacheRequest done
        root = ctypes.c_void_p()
        # IUIAutomation slot 6 ElementFromHandle(UIA_HWND, **element)
        _check(_call(sess.auto, 6, (ctypes.c_void_p, _VP), ctypes.c_void_p(int(hwnd)),
                     ctypes.byref(root)), "ElementFromHandle")
        root_p = sess.take(root.value)
        if prog is not None:
            prog["stage"] = _STAGE_ROOT                 # ElementFromHandle returned
        if method == "walk":
            return _collect_walk(sess, root_p, max_nodes, deadline)
        try:
            return _collect_findall(sess, root_p, max_nodes, deadline)
        except Unavailable:
            return _collect_walk(sess, root_p, max_nodes, deadline)
    finally:
        sess.close()
        if need_uninit:
            _ole32.CoUninitialize()


class _Timeout(Unavailable):
    """The worker did not finish in time (the abandoned daemon thread cleans up on its own)."""


_GRACE_S = 0.3              # the caller waits timeout_s + this, in total, for any one call
_FINDALL_SHARE = 0.6        # of timeout_s: how long FindAllBuildCache gets before the walker takes over


def _spawn(fn) -> tuple:
    """Start fn on a daemon worker; returns (thread, box). box gets "r" or "e" when it ends."""
    box: dict = {}

    def run() -> None:
        try:
            box["r"] = fn()
        except BaseException as e:                              # noqa: BLE001
            box["e"] = e

    t = threading.Thread(target=run, name="uia-worker", daemon=True)
    t.start()
    return t, box


def _outcome(box: dict):
    """The finished worker's result, or its failure as Unavailable."""
    if "e" in box:
        e = box["e"]
        if isinstance(e, Unavailable):
            raise e
        raise Unavailable(f"UI Automation error: {type(e).__name__}: {e}")
    return box["r"]


def _in_thread(fn, wait_s: float):
    """Run fn on a daemon worker and wait at most wait_s for it (the exact caller-side bound)."""
    t, box = _spawn(fn)
    t.join(max(0.0, wait_s))
    if t.is_alive():
        raise _Timeout(f"UI Automation did not answer within {wait_s:.1f} s")
    return _outcome(box)


def _diagnose(timeout_s: float = 2.0) -> dict:
    """What a call would run with: {"clsid": "CUIAutomation8" | "CUIAutomation", "iuia2": bool,
    and, when iuia2, "auto_set_focus", "connection_ms", "transaction_ms" read back through the
    IUIAutomation2 getter slots}. Touches no window."""
    def impl() -> dict:
        need_uninit = _co_init()
        sess = _Session()
        try:
            _open(sess, float(timeout_s), cache=False)
            return dict(sess.settings)
        finally:
            sess.close()
            if need_uninit:
                _ole32.CoUninitialize()
    return _in_thread(impl, float(timeout_s) + _GRACE_S)


def elements(hwnd: int, max_nodes: int = 3000, timeout_s: float = 2.0,
             method: str = "findall") -> tuple:
    """(list of the descendant elements of the window `hwnd`, truncated). The window element
    itself is excluded.

    `method="walk"` forces the bounded TreeWalker path (also the automatic fallback when
    FindAllBuildCache fails inside the worker, or has not finished after 60% of timeout_s,
    at least 0.25 s).

    Time bound: ONE budget of timeout_s + 0.3 s covers everything. FindAllBuildCache gets the
    first 60% of timeout_s. If it is still running AND its worker got past ElementFromHandle,
    the walker runs on the REMAINING budget beside it: whichever ends first decides. The
    first worker's full answer is returned as is; the walker's is the nodes it reached
    (flagged truncated). If the first worker is still before the window element at that mark (a
    stalled provider), no walker is started (it would block on the same provider): the
    caller keeps waiting on THAT worker for the rest of the budget, and gets the full list
    if the provider answers in time, else Unavailable (at about timeout_s when the
    Transaction timeout fires, at the latest at timeout_s + 0.3 s). Abandoned
    workers (up to 2 per call) live on until their provider call returns.

    max_nodes truncates the result; FindAllBuildCache still fetches the whole subtree, so it
    bounds the work only on the walker path. Raises Unavailable if UIA cannot be used.
    """
    hwnd, max_nodes, timeout_s = int(hwnd), int(max_nodes), float(timeout_s)
    t0 = time.perf_counter()
    total = timeout_s + _GRACE_S
    prog: dict = {"stage": _STAGE_START}
    if method == "walk":
        return _in_thread(lambda: _elements_impl(hwnd, max_nodes, timeout_s, "walk"), total)
    first, box = _spawn(lambda: _elements_impl(hwnd, max_nodes, timeout_s, method, prog))
    first.join(min(total, max(timeout_s * _FINDALL_SHARE, 0.25)))
    if not first.is_alive():
        return _outcome(box)
    if prog["stage"] < _STAGE_ROOT:
        # stalled before the window element: keep waiting on THIS worker, start no walker
        first.join(max(0.0, total - (time.perf_counter() - t0)))
        if first.is_alive():
            raise _Timeout(f"UI Automation did not answer ({total:.1f} s budget; "
                           f"stuck before the window element)")
        return _outcome(box)
    left = total - (time.perf_counter() - t0)
    if left < 0.1:
        raise _Timeout(f"UI Automation did not answer within {total:.1f} s")
    # the walker's own deadline is what is left minus a little time to unwind. The first
    # worker keeps running: if its full FindAllBuildCache answer lands before the walker's,
    # that answer wins (a healthy window whose tree needs 0.6 x T to T is not cut short).
    walker, wbox = _spawn(lambda: _elements_impl(hwnd, max_nodes, max(0.05, left - 0.15), "walk"))
    end = t0 + total
    while True:
        if not first.is_alive() and "r" in box:
            return box["r"]
        if not walker.is_alive():
            els, _ = _outcome(wbox)
            return els, True
        now = time.perf_counter()
        if now >= end:
            raise _Timeout(f"UI Automation did not answer within {total:.1f} s")
        walker.join(min(0.02, end - now))


def _norm_name(text: str) -> str:
    """Case-insensitive, trimmed, accelerator markers (&) removed."""
    return text.replace("&", "").strip().lower()


def find(hwnd: int, text: str, control: str | None = None, exact: bool = False,
         max_nodes: int = 3000, timeout_s: float = 2.0) -> tuple:
    """(matching elements, truncated). exact=False: `text` is a case-insensitive substring of
    the name or the value. exact=True: the NAME alone equals `text` (case-insensitive,
    trimmed, '&' removed on both sides), never the value, never a substring. `control`, if
    given, must equal the control type name case-insensitively (e.g. "Button")."""
    ctl = control.lower() if control else None
    want = _norm_name(text) if exact else text.lower()
    hits = []
    els, truncated = elements(hwnd, max_nodes, timeout_s)
    for el in els:
        if ctl is not None and el["control"].lower() != ctl:
            continue
        if exact:
            if _norm_name(el["name"]) == want:
                hits.append(el)
        elif want in el["name"].lower() or want in el["value"].lower():
            hits.append(el)
    return hits, truncated


def _live_runtime_id(el: int) -> tuple:
    psa = ctypes.c_void_p()
    # IUIAutomationElement slot 4 GetRuntimeId(SAFEARRAY **)
    hr = _call(el, 4, (_VP,), ctypes.byref(psa))
    if hr == _UIA_E_TIMEOUT:
        raise Unavailable("GetRuntimeId timed out (UIA_E_TIMEOUT)")
    if hr < 0 or not psa.value:
        return ()
    try:
        return _safearray_ints(psa.value)
    finally:
        _oleaut32.SafeArrayDestroy(psa.value)


def _hit_impl(x: int, y: int, runtime_id: tuple, max_up: int, timeout_s: float) -> bool:
    need_uninit = _co_init()
    sess = _Session()
    try:
        _open(sess, timeout_s, cache=False)
        el = ctypes.c_void_p()
        # IUIAutomation slot 7 ElementFromPoint(POINT pt, **element); a point with no element
        # is simply "not the match"
        hr = _call(sess.auto, 7, (_POINT, _VP), _POINT(x, y), ctypes.byref(el))
        if hr == _UIA_E_TIMEOUT:
            # the provider did not answer inside the Transaction timeout: UIA could not
            # tell us what is under the pointer, which is not "nothing is there"
            raise Unavailable("ElementFromPoint timed out (UIA_E_TIMEOUT)")
        if hr < 0 or not el.value:
            return False
        cur = sess.take(el.value)
        walker = ctypes.c_void_p()
        _check(_call(sess.auto, 16, (_VP,), ctypes.byref(walker)), "get_RawViewWalker")  # IUIAutomation 16
        walker_p = sess.take(walker.value)
        for _ in range(max_up + 1):
            if _live_runtime_id(cur) == runtime_id:
                return True
            parent = ctypes.c_void_p()
            # IUIAutomationTreeWalker slot 3 GetParentElement(element, **parent)
            hr = _call(walker_p, 3, (_VP, _VP), cur, ctypes.byref(parent))
            if hr == _UIA_E_TIMEOUT:
                raise Unavailable("GetParentElement timed out (UIA_E_TIMEOUT)")
            if hr < 0 or not parent.value:
                return False
            cur = sess.take(parent.value)
        return False
    finally:
        sess.close()
        if need_uninit:
            _ole32.CoUninitialize()


def hit_test(x: int, y: int, runtime_id: tuple, max_up: int = 12,
             timeout_s: float = 2.0) -> bool:
    """Read-only ElementFromPoint at screen (x, y) (physical pixels in the caller's DPI
    context): True when that element, or one of its first `max_up` ancestors, has
    `runtime_id`. False for a point with no element. Raises Unavailable if UIA cannot be
    used, including when the provider under the point does not answer (ElementFromPoint
    UIA_E_TIMEOUT, or no answer by timeout_s + 0.3 s): "could not look" is not "nothing
    there". This is the check that the thing under the pointer is the element you meant."""
    rid = tuple(int(v) for v in runtime_id)
    if not rid:
        return False
    x, y, max_up, timeout_s = int(x), int(y), int(max_up), float(timeout_s)
    return _in_thread(lambda: _hit_impl(x, y, rid, max_up, timeout_s), timeout_s + _GRACE_S)
