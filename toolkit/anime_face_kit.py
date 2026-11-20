"""Anime Facial Texture Extraction & Halo-Safe Expression Synthesis Helpers.

Provides reusable building blocks for projecting original 2D anime illustration faces onto
3D sprite-stacked heads and painting clean alternate expressions (blink, happy arc, wink,
deadpan jitome, smug smirk, fierce battle shout) WITHOUT warm-skin white-halo artifacts.
"""
import numpy as np


def finalize_face_texture(
    rgb_hi: np.ndarray,
    skin_rgb: tuple[float, float, float] = (254.0, 234.0, 227.0),
    cool_white_lum: float = 228.0,
    sat_boost: float = 1.18,
) -> tuple[np.ndarray, np.ndarray]:
    """Compute final (rgb_uint8, feature_weight_float32) from a clean expression canvas.

    CRITICAL ANTI-HALO RULE:
    Cool-white highlight boosting is strictly restricted to `b >= r - 6` so warm peach skin
    painted over closed/blinking eyes NEVER receives a false white highlight halo!
    """
    arr = rgb_hi.astype(np.float32).copy()
    skin = np.array(skin_rgb, dtype=np.float32)

    # Distance from uniform skin tone defines facial feature weight (eyes, brows, mouth, blush)
    diff = np.linalg.norm(arr - skin[None, None, :], axis=-1)
    feat = np.clip((diff - 7.0) / 22.0, 0.0, 1.0).astype(np.float32)

    # Boost crisp anime saturation slightly on painted features
    mean = arr.mean(axis=-1, keepdims=True)
    boosted = np.clip(mean + (arr - mean) * sat_boost, 0.0, 255.0)
    arr = arr * (1.0 - feat[..., None]) + boosted * feat[..., None]

    # Halo-safe cool-white glint boost (NEVER touches warm peach skin where r > b + 6!)
    lum = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
    is_cool_white = (lum > cool_white_lum) & (arr[..., 2] >= arr[..., 0] - 6.0) & (feat > 0.25)
    arr[is_cool_white] = np.clip(arr[is_cool_white] * 1.06 + 8.0, 0.0, 255.0)

    return np.clip(arr, 0, 255).astype(np.uint8), feat


def paint_happy_arc_eye(
    img: np.ndarray,
    UU: np.ndarray,
    ZZ: np.ndarray,
    cx: float,
    cz: float,
    skin_rgb=(254.0, 234.0, 227.0),
    lash_rgb=(32.0, 28.0, 56.0),
    rx: float = 5.4,
    ry: float = 5.0,
):
    """Replace an open anime eye region with a cheerful upward curved (^ ^) arc."""
    du = UU - cx
    clear = ((du / rx) ** 2 + ((ZZ - cz) / ry) ** 2) <= 1.0
    img[clear] = np.array(skin_rgb, dtype=np.float32)
    z_arc = cz + 1.2 - 0.19 * (du ** 2)
    arc = (np.abs(du) <= rx * 0.80) & (np.abs(ZZ - z_arc) <= 0.88)
    img[arc] = np.array(lash_rgb, dtype=np.float32)


def paint_jitome_lid(
    img: np.ndarray,
    UU: np.ndarray,
    ZZ: np.ndarray,
    cx: float,
    cz: float,
    skin_rgb=(254.0, 234.0, 227.0),
    lid_rgb=(28.0, 32.0, 68.0),
    brow_rgb=(218.0, 128.0, 134.0),
):
    """Paint flat deadpan half-lidded anime 'jitome' eyelid + tiny flat brow."""
    du = UU - cx
    in_eye = ((du / 5.7) ** 2 + ((ZZ - cz) / 5.3) ** 2) <= 1.0
    lid_z = cz + 1.65 - 0.015 * (du ** 2)
    img[in_eye & (ZZ > lid_z + 0.72)] = np.array(skin_rgb, dtype=np.float32)
    img[in_eye & (ZZ >= lid_z - 0.85) & (ZZ <= lid_z + 0.72) & (np.abs(du) <= 4.9)] = np.array(lid_rgb, dtype=np.float32)
    brow = (np.abs(du) <= 1.9) & (np.abs(ZZ - (cz + 5.8)) <= 0.58)
    img[brow] = np.array(brow_rgb, dtype=np.float32)


def add_rosy_blush(
    img: np.ndarray,
    UU: np.ndarray,
    ZZ: np.ndarray,
    cheek_x: float = 9.5,
    cheek_z: float = 90.2,
    strength: float = 0.30,
    blush_rgb=(255.0, 148.0, 162.0),
):
    """Softly blend cute anime cheek blush onto both cheeks."""
    blush = np.array(blush_rgb, dtype=np.float32)
    for sign in (-1.0, +1.0):
        d2 = ((UU - sign * cheek_x) / 3.6) ** 2 + ((ZZ - cheek_z) / 2.2) ** 2
        w = np.clip(1.0 - d2, 0.0, 1.0) * strength
        img[...] = img * (1.0 - w[..., None]) + blush * w[..., None]
