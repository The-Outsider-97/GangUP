"""Small geometry toolkit for SLAI reasoning (terrain is static, public information)."""
from __future__ import annotations

import math

Rect = dict  # {x0,y0,x1,y1}


def dist(a: dict, b: dict) -> float:
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def point_in_rect(x: float, y: float, r: Rect, pad: float = 0.0) -> bool:
    return r["x0"] - pad <= x <= r["x1"] + pad and r["y0"] - pad <= y <= r["y1"] + pad


def is_free(terrain: dict, x: float, y: float, pad: float = 0.5) -> bool:
    if x < pad or y < pad or x > terrain["width"] - pad or y > terrain["height"] - pad:
        return False
    return not any(point_in_rect(x, y, r, pad) for r in terrain["obstacles"])


def segment_hits_rect(x0: float, y0: float, x1: float, y1: float, r: Rect) -> bool:
    """Liang–Barsky segment/rectangle test."""
    dx, dy = x1 - x0, y1 - y0
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, x0 - r["x0"]), (dx, r["x1"] - x0), (-dy, y0 - r["y0"]), (dy, r["y1"] - y0)):
        if abs(p) < 1e-12:
            if q < 0:
                return False
        else:
            t = q / p
            if p < 0:
                if t > t1:
                    return False
                t0 = max(t0, t)
            else:
                if t < t0:
                    return False
                t1 = min(t1, t)
    return True


def line_of_sight_clear(terrain: dict, a: dict, b: dict) -> bool:
    return not any(segment_hits_rect(a["x"], a["y"], b["x"], b["y"], r) for r in terrain["obstacles"])


def nearest_free(terrain: dict, x: float, y: float, pad: float = 0.6, max_r: float = 8.0) -> tuple[float, float]:
    if is_free(terrain, x, y, pad):
        return x, y
    best, bd = (clamp(x, 1, terrain["width"] - 1), clamp(y, 1, terrain["height"] - 1)), 1e9
    r = 0.5
    while r <= max_r:
        for k in range(24):
            a = 2 * math.pi * k / 24
            px, py = x + math.cos(a) * r, y + math.sin(a) * r
            if is_free(terrain, px, py, pad):
                d = math.hypot(px - x, py - y)
                if d < bd:
                    best, bd = (px, py), d
        if bd < 1e9:
            return best
        r += 0.5
    return best


def cover_point(terrain: dict, threat: dict, near: dict, search: float = 14.0) -> tuple[float, float] | None:
    """A free point near `near` whose line to `threat` is blocked by cover (a defensible position)."""
    best, bd = None, 1e9
    for ring in (3.0, 6.0, 9.0, 12.0):
        if ring > search:
            break
        for k in range(16):
            a = 2 * math.pi * k / 16
            px, py = near["x"] + math.cos(a) * ring, near["y"] + math.sin(a) * ring
            if not is_free(terrain, px, py, 0.8):
                continue
            if not line_of_sight_clear(terrain, {"x": px, "y": py}, threat):
                d = math.hypot(px - near["x"], py - near["y"])
                if d < bd:
                    best, bd = (px, py), d
        if best:
            return best
    return best
