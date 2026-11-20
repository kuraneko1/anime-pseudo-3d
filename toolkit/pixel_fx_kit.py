"""100% Pure Pixel-Art FX, Shadow, Ground Ring & 16x16 UI Icon Generator.

Eliminates smooth vector Canvas primitives and OS Unicode emojis by baking crisp pixel-art RGBA PNGs.
"""
import math
import os
import numpy as np
from PIL import Image


def save_rgba(arr: np.ndarray, path: str):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    Image.fromarray(arr, "RGBA").save(path)


def add_pixel_outline(arr: np.ndarray, col=(16, 12, 30, 255)) -> np.ndarray:
    out = arr.copy()
    m = arr[..., 3] > 0
    p = np.pad(m, 1)
    ring = (~m) & (p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:])
    out[ring] = col
    return out


def draw_pattern(rows: list[str], palette: dict[str, tuple[int, int, int, int]]) -> np.ndarray:
    h, w = len(rows), len(rows[0])
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch in palette:
                arr[y, x] = palette[ch]
    return arr


def make_dithered_shadow(rx: int = 34, ry: int = 24, rgb=(14, 22, 48), core_alpha: int = 112, edge_alpha: int = 68) -> np.ndarray:
    w, h = rx * 2 + 2, ry * 2 + 2
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    cx, cy = w // 2, h // 2
    for y in range(h):
        for x in range(w):
            d = ((x - cx) / max(1, rx)) ** 2 + ((y - cy) / max(1, ry)) ** 2
            if d <= 0.72:
                arr[y, x] = (*rgb, core_alpha)
            elif d <= 1.0 and ((x + y) % 2 == 0):
                arr[y, x] = (*rgb, edge_alpha)
    return arr


def make_stepped_ring(size: int = 132, radius: float = 60.0, main_rgb=(78, 174, 240), hi_rgb=(186, 234, 255), fill_rgba=(56, 140, 214, 28)) -> np.ndarray:
    arr = np.zeros((size, size, 4), dtype=np.uint8)
    cx = cy = size / 2.0 - 0.5
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - cx, y - cy)
            if d <= radius - 2.5:
                if fill_rgba is not None and (x % 3 == 0) and (y % 3 == 0):
                    arr[y, x] = fill_rgba
            elif d <= radius - 0.8:
                arr[y, x] = (*main_rgb, 200)
            elif d <= radius + 0.8:
                arr[y, x] = (*hi_rgb, 240) if ((x ^ y) & 2) else (*main_rgb, 225)
    return arr


def make_slash_frames(width: int = 84, height: int = 44, core_rgb=(245, 254, 255), mid_rgb=(72, 206, 255), out_rgb=(36, 86, 228), count: int = 4) -> list[np.ndarray]:
    frames = []
    cx, cy = width * 0.34, height * 0.5
    for f in range(count):
        arr = np.zeros((height, width, 4), dtype=np.uint8)
        outer_r = 22 + f * 6.5
        inner_r = 13 + f * 8.0
        for y in range(height):
            for x in range(width):
                dx = (x - cx) * 0.72
                dy = (y - cy) * 1.12
                d = math.hypot(dx, dy)
                ang = math.atan2(dy, dx)
                if abs(ang) < 1.25 - f * 0.08 and inner_r <= d <= outer_r:
                    t = (d - inner_r) / max(1.0, outer_r - inner_r)
                    if t > 0.70:
                        arr[y, x] = (*core_rgb, 255)
                    elif t > 0.25:
                        arr[y, x] = (*mid_rgb, 245)
                    elif (x + y) % 2 == 0:
                        arr[y, x] = (*out_rgb, 215)
        frames.append(add_pixel_outline(arr, (*out_rgb, 220)))
    return frames


def make_spark_frames(core_rgb=(255, 255, 255), glow_rgb=(253, 224, 71)) -> list[np.ndarray]:
    pal = {"W": (*core_rgb, 255), "Y": (*glow_rgb, 255)}
    patterns = [
        [
            ".....WW.....", ".....WW.....", "....WYYW....", "..W.WYYW.W..",
            "..WWYYYYWW..", "WWYYYYYYYYWW", "WWYYYYYYYYWW", "..WWYYYYWW..",
            "..W.WYYW.W..", "....WYYW....", ".....WW.....", ".....WW.....",
        ],
        [
            ".....YY.....", "............", "..Y......Y..", "....Y..Y....",
            "............", "Y..........Y", "Y..........Y", "............",
            "....Y..Y....", "..Y......Y..", "............", ".....YY.....",
        ],
    ]
    return [draw_pattern(rows, pal) for rows in patterns]


def generate_standard_fx_and_ui_pack(assets_dir: str) -> dict:
    """Generate the standard pixel stage, elemental water/heart/spark FX sprites, and UI control icons."""
    os.makedirs(assets_dir, exist_ok=True)
    out = {}

    save_rgba(make_dithered_shadow(), os.path.join(assets_dir, "shadow_dither.png"))
    out["shadowDither"] = {"file": "assets/shadow_dither.png", "linear": True}

    save_rgba(make_stepped_ring(), os.path.join(assets_dir, "turntable_ring.png"))
    out["turntableRing"] = {"file": "assets/turntable_ring.png", "linear": True}

    # Water droplet, bubble, foam, heart, sparkles, slashes, wave ring
    drop = add_pixel_outline(draw_pattern([
        ".....CC.....", ".....CC.....", "....CWBC....", "....CWBB....",
        "...CWWBBB...", "...CWWBBB...", "..CWWBBBBB..", "..CBBBBBBB..",
        "..BBBBBBDB..", "...BBBBBDD..", "....BDDDD...", "............",
    ], {"W": (248, 253, 255, 255), "C": (118, 224, 255, 255), "B": (56, 146, 250, 255), "D": (32, 76, 198, 255)}), (18, 36, 102, 235))
    save_rgba(drop, os.path.join(assets_dir, "fx_droplet.png"))
    out["fxDroplet"] = {"file": "assets/fx_droplet.png"}

    bub = draw_pattern([
        "....CCCC....", "..CCWWWWCC..", ".CWWTTTTBBC.", ".CWTTTTTTBB.",
        "CCTTTTTTTTBB", "CCTTTTTTTTBB", "CBTTTTTTTTBB", "CBTTTTTTTTBB",
        ".BBTTTTTTBB.", ".CBBTTTTBBC.", "..BBBBBBBB..", "....BBBB....",
    ], {"W": (255, 255, 255, 255), "C": (152, 236, 255, 240), "B": (72, 168, 255, 220), "T": (130, 220, 255, 78)})
    save_rgba(bub, os.path.join(assets_dir, "fx_bubble.png"))
    out["fxBubble"] = {"file": "assets/fx_bubble.png"}

    foam = draw_pattern([
        "...CCCC...", "..CWWWWC..", ".CWWWWWWC.", "CWWWWWWWWB", "CWWWWWWWWB",
        "CWWWWWWCBB", ".CWWWWCBB.", "..CCCCBB..", "...BBBB...", "..........",
    ], {"W": (250, 254, 255, 245), "C": (172, 236, 255, 210), "B": (96, 188, 255, 165)})
    save_rgba(foam, os.path.join(assets_dir, "fx_foam.png"))
    out["fxFoam"] = {"file": "assets/fx_foam.png"}

    heart = add_pixel_outline(draw_pattern([
        "............", "..PPP..PPP..", ".PWWPPPPPPP.", ".PWWPPPPPPR.",
        ".PPPPPPPPPR.", "..PPPPPPPR..", "...PPPPPR...", "....PPPR....",
        ".....PR.....", "......R.....", "............", "............",
    ], {"W": (255, 238, 244, 255), "P": (255, 132, 174, 255), "R": (236, 72, 134, 255)}), (92, 22, 58, 255))
    save_rgba(heart, os.path.join(assets_dir, "fx_heart.png"))
    out["fxHeart"] = {"file": "assets/fx_heart.png"}

    for i, sp in enumerate(make_spark_frames()):
        save_rgba(sp, os.path.join(assets_dir, f"fx_spark_{i}.png"))
        out[f"fxSpark_{i}"] = {"file": f"assets/fx_spark_{i}.png"}

    for i, sl in enumerate(make_slash_frames()):
        save_rgba(sl, os.path.join(assets_dir, f"fx_slash_{i}.png"))
        out[f"fxSlash_{i}"] = {"file": f"assets/fx_slash_{i}.png"}

    wring = make_stepped_ring(size=128, radius=58.0, main_rgb=(64, 198, 255), hi_rgb=(228, 250, 255), fill_rgba=(77, 134, 255, 36))
    save_rgba(wring, os.path.join(assets_dir, "fx_wave_ring.png"))
    out["fxWaveRing"] = {"file": "assets/fx_wave_ring.png"}

    # Core pixel UI icons
    pal = {"K": (16, 20, 44, 255), "N": (46, 62, 128, 255), "B": (77, 107, 254, 255), "C": (118, 216, 255, 255), "W": (244, 248, 255, 255), "Y": (248, 208, 108, 255)}
    ui_icons = {
        "ico_brand": [
            "................", "......YY........", ".....YYYY.......", "....YYWWYY......",
            "..YYYYWWYYYY....", "...YYYYYYYY.....", "....YYWWYY......", "...YYBBBBYY.....",
            "..YBBBBBBBBY....", "..BBCWWWWCBB....", "..BBBBBBBBBB....", "...BBBBBBBB.....",
            "....CCCCCC......", "................", "................", "................",
        ],
        "ico_anim": [
            "................", "..YYYYYYYYYYYY..", "..YWW......WWY..", "..YW..CCCC..WY..",
            "..YW..CCWWC.WY..", "..YW..CCWWWCWY..", "..YW..CCWWWCWY..", "..YW..CCWWC.WY..",
            "..YW..CCCC..WY..", "..YWW......WWY..", "..YYYYYYYYYYYY..", "................",
            "..CC..CC..CC....", "................", "................", "................",
        ],
        "ico_cam": [
            "................", "................", ".....WWWWWW.....", "...WWCCCCCCWW...",
            "..WCCBBBBBBCCW..", ".WCBBCWWWWCBBCW.", ".WCBBCWKKWCBBCW.", ".WCBBCWWWWCBBCW.",
            "..WCCBBBBBBCCW..", "...WWCCCCCCWW...", ".....WWWWWW.....", "................",
            "................", "................", "................", "................",
        ],
        "ico_layers": [
            "................", "......WWWW......", "....WWCCCCWW....", "..WWCCCCCCCCWW..",
            "....WWCCCCWW....", "......WWWW......", "....BBBBBBBB....", "..BBCCCCCCCCBB..",
            "....BBBBBBBB....", "................", "....NNNNNNNN....", "..NNBBBBBBBBNN..",
            "....NNNNNNNN....", "................", "................", "................",
        ],
        "ico_outline": [
            "................", "..YYYYYYYYYYYY..", "..YWWWWWWWWWWY..", "..YW........WY..",
            "..YW..CCCC..WY..", "..YW.CCWWCC.WY..", "..YW.CWWWWC.WY..", "..YW.CWWWWC.WY..",
            "..YW.CCWWCC.WY..", "..YW..CCCC..WY..", "..YW........WY..", "..YWWWWWWWWWWY..",
            "..YYYYYYYYYYYY..", "................", "................", "................",
        ],
        "ico_theme": [
            "................", ".....WWWWWW.....", "...WWBBBBBBWW...", "..WBBYYBBCCBBW..",
            "..WBYYYYCCCCBW..", ".WBBBYYBBCCBBBW.", ".WBBBBBBBBBBBBW.", ".WBBWWBBBBBBBBW.",
            ".WBWWWWBBNNNBBW.", "..WBBWWBNNNNBW..", "..WBBBBBBNNBBW..", "...WWBBBBBBWW...",
            ".....WWWWWW.....", "................", "................", "................",
        ],
        "ico_reset": [
            "................", ".......WW.......", "......WYYW......", ".....WYYYYW.....",
            "....WYYYYYYW....", "...WYYYYYYYYW...", "..WWWWWWWWWWWW..", "....WCCCCCCW....",
            "....WCWWWWCW....", "....WCWNNWCW....", "....WCWNNWCW....", "....WCWNNWCW....",
            "....WWWWWWWW....", "................", "................", "................",
        ],
    }
    for name, rows in ui_icons.items():
        arr = add_pixel_outline(draw_pattern(rows, pal), (14, 18, 38, 255))
        save_rgba(arr, os.path.join(assets_dir, f"{name}.png"))
        out[name] = {"file": f"assets/{name}.png"}

    return out
