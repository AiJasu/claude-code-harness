#!/usr/bin/env python3
"""
ocr - Windows.Media.Ocr from ctypes (WinRT through combase.dll), no PowerShell.

  available() -> (ok, language tag or the reason)
  recognize_bgra(width, height, bgra, lang=None, timeout_s=None)
        -> [{"text", "rect": (x, y, w, h)}, ...]     (timeout_s: see its docstring; Timeout is
                                                      a subclass of Unavailable)
  text_of(lines) -> "\n".join of the line texts

READ-ONLY and local: the pixels you pass in are copied into a SoftwareBitmap, recognized,
and released. Nothing is written, nothing leaves the machine (the OCR engine is the
on-device Windows.Media.Ocr component).

Chain per call (each step's interface slot is cited at the call; source for every IID and
slot order: the Windows SDK winrt headers, windows.media.ocr.h and the others named below):
  RoGetActivationFactory(Windows.Media.Ocr.OcrEngine) -> IOcrEngineStatics
    -> TryCreateFromUserProfileLanguages (or TryCreateFromLanguage) -> IOcrEngine
  RoGetActivationFactory(Windows.Security.Cryptography.CryptographicBuffer)
    -> CreateFromByteArray(bgra) -> IBuffer
  RoGetActivationFactory(Windows.Graphics.Imaging.SoftwareBitmap) -> ISoftwareBitmapStatics
    -> CreateCopyWithAlphaFromBuffer(buffer, Bgra8, w, h, Ignore) -> ISoftwareBitmap
  IOcrEngine.RecognizeAsync(bitmap) -> IAsyncOperation<OcrResult>, polled through IAsyncInfo
    -> GetResults -> IOcrResult.Lines -> IOcrLine.Words -> IOcrWord.BoundingRect

Threading: every call runs on its own short-lived worker thread that calls
RoInitialize(MULTITHREADED), so the caller's thread needs no WinRT setup. Slot numbers count
IUnknown (0-2) and IInspectable (3 GetIids, 4 GetRuntimeClassName, 5 GetTrustLevel).
"""

from __future__ import annotations

import ctypes
import threading
import time

if ctypes.sizeof(ctypes.c_void_p) != 8:
    raise ImportError("ocr.py needs 64-bit Python")


class Unavailable(Exception):
    """OCR cannot run here; str(e) is the reason."""


class Timeout(Unavailable):
    """A time limit ran out (the async poll or the worker wait); str(e) says which limit."""


# ---- ctypes setup (the only import-time work) -----------------------------------------
_combase = ctypes.WinDLL("combase")
_VP = ctypes.c_void_p
_U32 = ctypes.c_uint32
_combase.RoInitialize.argtypes = [ctypes.c_int]
_combase.RoInitialize.restype = ctypes.c_long
_combase.RoUninitialize.argtypes = []
_combase.RoGetActivationFactory.argtypes = [_VP, _VP, _VP]
_combase.RoGetActivationFactory.restype = ctypes.c_long
_combase.WindowsCreateString.argtypes = [ctypes.c_wchar_p, _U32, _VP]
_combase.WindowsCreateString.restype = ctypes.c_long
_combase.WindowsDeleteString.argtypes = [_VP]
_combase.WindowsDeleteString.restype = ctypes.c_long
_combase.WindowsGetStringRawBuffer.argtypes = [_VP, _VP]
_combase.WindowsGetStringRawBuffer.restype = _VP


class _GUID(ctypes.Structure):
    _fields_ = [("a", ctypes.c_ulong), ("b", ctypes.c_ushort), ("c", ctypes.c_ushort),
                ("d", ctypes.c_ubyte * 8)]


def _guid(text: str) -> _GUID:
    import uuid
    u = uuid.UUID(text)
    g = _GUID()
    g.a, g.b, g.c = u.time_low, u.time_mid, u.time_hi_version
    for i, byte in enumerate(u.bytes[8:]):
        g.d[i] = byte
    return g


class _Rect(ctypes.Structure):          # Windows.Foundation.Rect: X, Y, Width, Height (float32)
    _fields_ = [("x", ctypes.c_float), ("y", ctypes.c_float),
                ("w", ctypes.c_float), ("h", ctypes.c_float)]


# IIDs (winrt headers). Interface -> header
_IID_IOcrEngineStatics = "5bffa85a-3384-3540-9940-699120d428a8"      # windows.media.ocr.h
_IID_ISoftwareBitmapStatics = "df0385db-672f-4a9d-806e-c2442f343e86"  # windows.graphics.imaging.h
_IID_ICryptographicBufferStatics = "320b7e22-3cb0-4cdf-8663-1d28910065eb"  # windows.security.cryptography.h
_IID_ILanguageFactory = "9b0252ac-0c27-44f8-b792-9793fb66c63e"       # windows.globalization.h
_IID_ILanguage = "ea79a752-f7c2-4265-b1bd-c4dec4e4f080"              # windows.globalization.h
_IID_IAsyncInfo = "00000036-0000-0000-C000-000000000046"             # asyncinfo.h

_RPC_E_CHANGED_MODE = -2147417850      # 0x80010106
_BGRA8 = 87           # BitmapPixelFormat_Bgra8
_ALPHA_IGNORE = 2      # BitmapAlphaMode_Ignore (OcrEngine accepts Premultiplied or Ignore)
_STATUS_STARTED, _STATUS_COMPLETED, _STATUS_CANCELED, _STATUS_ERROR = 0, 1, 2, 3

_PROTOS: dict = {}


def _call(obj: int, slot: int, argtypes: tuple, *args) -> int:
    proto = _PROTOS.get(argtypes)
    if proto is None:
        proto = ctypes.WINFUNCTYPE(ctypes.c_long, _VP, *argtypes)
        _PROTOS[argtypes] = proto
    vtbl = ctypes.cast(_VP(obj), ctypes.POINTER(_VP))[0]
    entry = ctypes.cast(_VP(vtbl), ctypes.POINTER(_VP))[slot]
    return proto(entry)(obj, *args)


def _check(hr: int, what: str) -> None:
    if hr < 0:
        raise Unavailable(f"{what} failed (HRESULT 0x{hr & 0xFFFFFFFF:08X})")


class _Refs:
    """Everything a call acquires; close() releases it in reverse order."""

    def __init__(self) -> None:
        self.items: list[int] = []

    def take(self, ptr) -> int:
        ptr = int(ptr or 0)
        if ptr:
            self.items.append(ptr)
        return ptr

    def close(self) -> None:
        for ptr in reversed(self.items):
            try:
                _call(ptr, 2, ())                                # IUnknown::Release
            except Exception:
                pass
        self.items.clear()


def _hstr(text: str) -> int:
    h = _VP()
    _check(_combase.WindowsCreateString(text, len(text), ctypes.byref(h)), "WindowsCreateString")
    return h.value


def _from_hstr(h: int, delete: bool = True) -> str:
    if not h:
        return ""
    try:
        n = _U32(0)
        buf = _combase.WindowsGetStringRawBuffer(h, ctypes.byref(n))
        return ctypes.wstring_at(buf, n.value) if buf else ""
    finally:
        if delete:
            _combase.WindowsDeleteString(h)


def _factory(refs: _Refs, class_name: str, iid: str) -> int:
    name = _hstr(class_name)
    try:
        out = _VP()
        g = _guid(iid)
        hr = _combase.RoGetActivationFactory(name, ctypes.byref(g), ctypes.byref(out))
    finally:
        _combase.WindowsDeleteString(name)
    _check(hr, f"RoGetActivationFactory({class_name})")
    return refs.take(out.value)


def _make_engine(refs: _Refs, statics: int, lang: str | None) -> int:
    """IOcrEngine for `lang`, or the user-profile languages, or en-US as a last resort."""
    engine = _VP()
    if lang is None:
        # IOcrEngineStatics slot 10 TryCreateFromUserProfileLanguages(**engine)
        _check(_call(statics, 10, (_VP,), ctypes.byref(engine)), "TryCreateFromUserProfileLanguages")
        if engine.value:
            return refs.take(engine.value)
        lang = "en-US"
    fac = _factory(refs, "Windows.Globalization.Language", _IID_ILanguageFactory)
    tag = _hstr(lang)
    language = _VP()
    try:
        # ILanguageFactory slot 6 CreateLanguage(HSTRING tag, **ILanguage)
        _check(_call(fac, 6, (_VP, _VP), tag, ctypes.byref(language)), "CreateLanguage")
    finally:
        _combase.WindowsDeleteString(tag)
    lang_p = refs.take(language.value)
    # IOcrEngineStatics slot 9 TryCreateFromLanguage(ILanguage*, **engine)
    _check(_call(statics, 9, (_VP, _VP), lang_p, ctypes.byref(engine)), "TryCreateFromLanguage")
    if not engine.value:
        raise Unavailable(f"no OCR language pack installed for {lang!r}")
    return refs.take(engine.value)


def _engine_tag(refs: _Refs, engine: int) -> str:
    lang = _VP()
    # IOcrEngine slot 7 get_RecognizerLanguage(**ILanguage)
    _check(_call(engine, 7, (_VP,), ctypes.byref(lang)), "get_RecognizerLanguage")
    lang_p = refs.take(lang.value)
    h = _VP()
    # ILanguage slot 6 get_LanguageTag(*HSTRING)
    _check(_call(lang_p, 6, (_VP,), ctypes.byref(h)), "get_LanguageTag")
    return _from_hstr(h.value)


def _run_on_worker(fn, limit_s: float):
    box: dict = {}

    def run() -> None:
        hr = _combase.RoInitialize(1)                            # RO_INIT_MULTITHREADED
        # S_OK and S_FALSE are balanced by RoUninitialize; RPC_E_CHANGED_MODE means the thread
        # already has another apartment, used as it is and NOT uninitialized.
        if hr != _RPC_E_CHANGED_MODE and hr < 0:
            box["e"] = Unavailable(f"RoInitialize failed (HRESULT 0x{hr & 0xFFFFFFFF:08X})")
            return
        try:
            box["r"] = fn()
        except BaseException as e:                               # noqa: BLE001
            box["e"] = e
        finally:
            if hr != _RPC_E_CHANGED_MODE:
                _combase.RoUninitialize()

    t = threading.Thread(target=run, name="ocr-worker", daemon=True)
    t.start()
    t.join(limit_s)
    if t.is_alive():
        raise Timeout(f"OCR did not finish within {limit_s:.1f} s")
    if "e" in box:
        e = box["e"]
        if isinstance(e, (Unavailable, ValueError)):
            raise e
        raise Unavailable(f"OCR error: {type(e).__name__}: {e}")
    return box["r"]


_AVAILABLE: tuple | None = None


def available() -> tuple[bool, str]:
    """(True, language tag of the engine that would be used) or (False, reason). Cached."""
    global _AVAILABLE
    if _AVAILABLE is None:
        def probe() -> tuple[bool, str]:
            refs = _Refs()
            try:
                statics = _factory(refs, "Windows.Media.Ocr.OcrEngine", _IID_IOcrEngineStatics)
                engine = _make_engine(refs, statics, None)
                return True, _engine_tag(refs, engine)
            finally:
                refs.close()
        try:
            _AVAILABLE = _run_on_worker(probe, 10.0)
        except Unavailable as e:
            _AVAILABLE = (False, str(e))
    return _AVAILABLE


def _recognize(width: int, height: int, bgra: bytes, lang: str | None, limit_s: float) -> list[dict]:
    t_start = time.perf_counter()
    refs = _Refs()
    try:
        statics = _factory(refs, "Windows.Media.Ocr.OcrEngine", _IID_IOcrEngineStatics)
        maxdim = _U32(0)
        # IOcrEngineStatics slot 6 get_MaxImageDimension(*uint32)
        _check(_call(statics, 6, (_VP,), ctypes.byref(maxdim)), "get_MaxImageDimension")
        if width > maxdim.value or height > maxdim.value:
            raise ValueError(f"image {width}x{height} exceeds the OCR maximum dimension {maxdim.value}")
        engine = _make_engine(refs, statics, lang)

        crypto = _factory(refs, "Windows.Security.Cryptography.CryptographicBuffer",
                          _IID_ICryptographicBufferStatics)
        ibuf = _VP()
        # ICryptographicBufferStatics slot 9 CreateFromByteArray(uint32 length, byte*, **IBuffer)
        _check(_call(crypto, 9, (_U32, ctypes.c_char_p, _VP), len(bgra), bgra, ctypes.byref(ibuf)),
               "CreateFromByteArray")
        ibuf_p = refs.take(ibuf.value)

        sbs = _factory(refs, "Windows.Graphics.Imaging.SoftwareBitmap", _IID_ISoftwareBitmapStatics)
        bmp = _VP()
        # ISoftwareBitmapStatics slot 10 CreateCopyWithAlphaFromBuffer(IBuffer*, format, w, h,
        # alphaMode, **ISoftwareBitmap)
        _check(_call(sbs, 10, (_VP, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, _VP),
                     ibuf_p, _BGRA8, width, height, _ALPHA_IGNORE, ctypes.byref(bmp)),
               "CreateCopyWithAlphaFromBuffer")
        bmp_p = refs.take(bmp.value)

        op = _VP()
        # IOcrEngine slot 6 RecognizeAsync(ISoftwareBitmap*, **IAsyncOperation<OcrResult>)
        _check(_call(engine, 6, (_VP, _VP), bmp_p, ctypes.byref(op)), "RecognizeAsync")
        op_p = refs.take(op.value)
        info = _VP()
        g = _guid(_IID_IAsyncInfo)
        _check(_call(op_p, 0, (_VP, _VP), ctypes.byref(g), ctypes.byref(info)), "QueryInterface(IAsyncInfo)")
        info_p = refs.take(info.value)
        deadline = t_start + limit_s
        status = ctypes.c_int(_STATUS_STARTED)
        while True:
            # IAsyncInfo slot 7 get_Status(*AsyncStatus)
            _check(_call(info_p, 7, (_VP,), ctypes.byref(status)), "IAsyncInfo.get_Status")
            if status.value != _STATUS_STARTED:
                break
            if time.perf_counter() > deadline:
                _call(info_p, 9, ())                              # IAsyncInfo slot 9 Cancel
                raise Timeout(f"RecognizeAsync did not complete within {limit_s:.1f} s")
            time.sleep(0.001)
        if status.value != _STATUS_COMPLETED:
            code = ctypes.c_long(0)
            _call(info_p, 8, (_VP,), ctypes.byref(code))          # slot 8 get_ErrorCode
            raise Unavailable(f"RecognizeAsync ended with status {status.value} (HRESULT 0x{code.value & 0xFFFFFFFF:08X})")
        res = _VP()
        # IAsyncOperation<T> slot 8 GetResults(**T)  (6 put_Completed, 7 get_Completed)
        _check(_call(op_p, 8, (_VP,), ctypes.byref(res)), "GetResults")
        res_p = refs.take(res.value)
        lines_v = _VP()
        # IOcrResult slot 6 get_Lines(**IVectorView<OcrLine>)
        _check(_call(res_p, 6, (_VP,), ctypes.byref(lines_v)), "get_Lines")
        lines_p = refs.take(lines_v.value)
        out: list[dict] = []
        for line in _each(refs, lines_p):
            h = _VP()
            _check(_call(line, 7, (_VP,), ctypes.byref(h)), "OcrLine.get_Text")   # IOcrLine slot 7
            text = _from_hstr(h.value)
            words_v = _VP()
            _check(_call(line, 6, (_VP,), ctypes.byref(words_v)), "OcrLine.get_Words")  # IOcrLine slot 6
            words_p = refs.take(words_v.value)
            x0 = y0 = 1e9
            x1 = y1 = -1e9
            for word in _each(refs, words_p):
                r = _Rect()
                _check(_call(word, 6, (_VP,), ctypes.byref(r)), "OcrWord.get_BoundingRect")  # IOcrWord slot 6
                x0, y0 = min(x0, r.x), min(y0, r.y)
                x1, y1 = max(x1, r.x + r.w), max(y1, r.y + r.h)
            rect = (0, 0, 0, 0) if x1 < x0 else (int(x0), int(y0), int(round(x1 - x0)), int(round(y1 - y0)))
            out.append({"text": text, "rect": rect})
        return out
    finally:
        refs.close()


def _each(refs: _Refs, vec: int):
    """Yield each element of an IVectorView<T> (slot 6 GetAt, 7 get_Size); refs own them."""
    n = _U32(0)
    _check(_call(vec, 7, (_VP,), ctypes.byref(n)), "IVectorView.get_Size")
    for i in range(n.value):
        item = _VP()
        _check(_call(vec, 6, (_U32, _VP), i, ctypes.byref(item)), "IVectorView.GetAt")
        yield refs.take(item.value)


def recognize_bgra(width: int, height: int, bgra: bytes, lang: str | None = None,
                   timeout_s: float | None = None) -> list[dict]:
    """OCR of a top-down 32-bit BGRA buffer. One dict per recognized line, in reading order:
    {"text": str, "rect": (x, y, w, h)} in image pixels. Raises Unavailable when the engine or
    a language pack is missing, ValueError for a bad buffer or an image above the engine's
    maximum dimension (OcrEngine.MaxImageDimension).

    Time limits. timeout_s=None keeps the defaults: the async RecognizeAsync poll gives up
    after 15 s (the operation is canceled) and the caller waits at most 20 s for the worker.
    A number caps both: the poll deadline is max(0.5, timeout_s) measured from the start of
    the call, and the caller waits at most that plus 0.25 s of grace for the worker to
    unwind. When the limit runs out the call raises `Timeout` (a subclass of Unavailable, so
    `except Unavailable` still catches it). A worker stuck inside a WinRT call that ignores
    Cancel is abandoned (daemon thread) and cleans up when the call returns."""
    width, height = int(width), int(height)
    if width <= 0 or height <= 0 or len(bgra) != width * height * 4:
        raise ValueError(f"bgra length {len(bgra)} does not match {width}x{height}x4")
    if timeout_s is None:
        poll_s, wait_s = 15.0, 20.0
    else:
        poll_s = max(0.5, float(timeout_s))
        wait_s = poll_s + 0.25
    return _run_on_worker(lambda: _recognize(width, height, bytes(bgra), lang, poll_s), wait_s)


def text_of(lines: list[dict]) -> str:
    return "\n".join(line["text"] for line in lines)
