#!/usr/bin/env python3
"""Draws the stopwatch app icons as PNGs (no dependencies). Run: npm run icons"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
BG = (11, 13, 16)
ACCENT = (255, 90, 31)
WHITE = (242, 244, 247)
SS = 3  # supersampling per axis


def dist_to_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def shade(x, y, scale):
    """Colour at normalised coords (0..1). `scale` shrinks the glyph for maskable icons."""
    cx, cy = 0.5, 0.53
    u, v = (x - 0.5) / scale + 0.5, (y - 0.5) / scale + 0.5
    r = math.hypot(u - cx, v - cy)
    angle = math.radians(-50)  # hand points to ~2 o'clock
    hx, hy = cx + 0.2 * math.sin(-angle), cy - 0.2 * math.cos(-angle)

    if r < 0.04:
        return WHITE
    if dist_to_segment(u, v, cx, cy, hx, hy) < 0.028:
        return WHITE
    if abs(r - 0.29) < 0.045:
        return ACCENT
    if 0.44 < u < 0.56 and 0.13 < v < 0.21:  # crown
        return ACCENT
    if 0.47 < u < 0.53 and 0.19 < v < 0.25:  # stem
        return ACCENT
    return BG


def render(size, scale=1.0):
    rows = bytearray()
    for py in range(size):
        rows.append(0)  # filter: none
        for px in range(size):
            acc = [0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, scale)
                    acc[0] += c[0]
                    acc[1] += c[1]
                    acc[2] += c[2]
            n = SS * SS
            rows.extend((acc[0] // n, acc[1] // n, acc[2] // n))
    return bytes(rows)


def png(size, raw):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    targets = {
        "apple-touch-icon.png": (180, 1.0),
        "icon-192.png": (192, 1.0),
        "icon-512.png": (512, 1.0),
        "icon-maskable-512.png": (512, 0.78),  # keep glyph inside the safe zone
    }
    for name, (size, scale) in targets.items():
        (OUT / name).write_bytes(png(size, render(size, scale)))
        print("wrote", OUT / name)


if __name__ == "__main__":
    main()
