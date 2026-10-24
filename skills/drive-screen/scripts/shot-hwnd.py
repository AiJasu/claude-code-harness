"""Render ONE window's own surface (PrintWindow) to a PNG. Usage: shot-hwnd.py <hwnd> <out.png>
Never a screen-region grab: only the named window's content is drawn."""
import sys
import ctypes
from ctypes import wintypes

hwnd = int(sys.argv[1])
out = sys.argv[2]
user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
r = wintypes.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(r))
w, h = r.right - r.left, r.bottom - r.top
if w <= 0 or h <= 0:
    print('EMPTY_RECT')
    sys.exit(1)
hdc = user32.GetWindowDC(hwnd)
mdc = gdi32.CreateCompatibleDC(hdc)
bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
gdi32.SelectObject(mdc, bmp)
PW_RENDERFULLCONTENT = 2
ok = user32.PrintWindow(hwnd, mdc, PW_RENDERFULLCONTENT)


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [('biSize', wintypes.DWORD), ('biWidth', ctypes.c_long), ('biHeight', ctypes.c_long),
                ('biPlanes', wintypes.WORD), ('biBitCount', wintypes.WORD), ('biCompression', wintypes.DWORD),
                ('biSizeImage', wintypes.DWORD), ('biXPelsPerMeter', ctypes.c_long), ('biYPelsPerMeter', ctypes.c_long),
                ('biClrUsed', wintypes.DWORD), ('biClrImportant', wintypes.DWORD)]


bi = BITMAPINFOHEADER()
bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
bi.biWidth = w
bi.biHeight = -h
bi.biPlanes = 1
bi.biBitCount = 32
buf = ctypes.create_string_buffer(w * h * 4)
gdi32.GetDIBits(mdc, bmp, 0, h, buf, ctypes.byref(bi), 0)
gdi32.DeleteObject(bmp)
gdi32.DeleteDC(mdc)
user32.ReleaseDC(hwnd, hdc)
import struct
import zlib

raw = buf.raw
rows = bytearray()
for y in range(h):
    rows.append(0)
    row = raw[y * w * 4:(y + 1) * w * 4]
    # BGRA -> RGB
    for x in range(w):
        b, g, rr = row[x * 4], row[x * 4 + 1], row[x * 4 + 2]
        rows.extend((rr, g, b))


def chunk(tag, data):
    c = struct.pack('>I', len(data)) + tag + data
    return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)


png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(bytes(rows), 6)) + chunk(b'IEND', b'')
with open(out, 'wb') as f:
    f.write(png)
print('SHOT %s %dx%d printwindow=%d' % (out, w, h, ok))
