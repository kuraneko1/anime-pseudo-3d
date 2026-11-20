"""Array-Backend-Agnostic 3D SDF Sculpting & 3-Step Anime Cel Shading (CuPy GPU + NumPy CPU Fallback).

Automatically uses NVIDIA CuPy GPU acceleration (~40x faster for 128-160 slice anime models)
and falls back seamlessly to NumPy CPU when CuPy or a CUDA GPU is unavailable.

Canonical Coordinate Convention:
  - Volume array layout from `make_grid(W, L, H)`: shape `(H, L, W)` indexed `[z, y, x]`.
  - `+X`: viewer-right in FRONT view | `+Y`: forward toward FRONT camera | `+Z`: upward.
  - Use `vol_zyx_to_yxz(vol)` when passing `(H, L, W, 4)` volumes into `multiview_fitter.render_multiview_fit_qa`.
"""
import math
import os
import numpy as np

USE_GPU = False
xp = np
if os.environ.get("ANIME_3D_FORCE_CPU", "0") != "1":
    try:
        import cupy as _cp
        if _cp.cuda.runtime.getDeviceCount() > 0:
            xp = _cp
            USE_GPU = True
    except Exception:
        xp = np
        USE_GPU = False


def to_numpy(arr) -> np.ndarray:
    """Convert a CuPy or NumPy array safely to a NumPy array."""
    if USE_GPU and hasattr(arr, "get"):
        return arr.get()
    return np.asarray(arr)


def vol_zyx_to_yxz(vol: np.ndarray) -> np.ndarray:
    """Transpose canonical GPU SDF volume `(Z, Y, X, 4)` -> `(Y, X, Z, 4)` for multiview QA overlays."""
    arr = to_numpy(vol)
    if arr.ndim == 4:
        return np.transpose(arr, (1, 2, 0, 3))
    if arr.ndim == 3:
        return np.transpose(arr, (1, 2, 0))
    raise ValueError(f"Expected 3D or 4D volume, got shape {arr.shape}")


def make_grid(W: int, L: int, H: int, y_offset: float = 0.0):
    """Create canonical 3D voxel coordinate grids (X, Y, Z) of shape `(H, L, W)` with +Y forward and +Z up."""
    zz, yy, xx = xp.mgrid[0:H, 0:L, 0:W].astype(xp.float32)
    X = xx - (W - 1) / 2.0
    Y = yy - (L - 1) / 2.0 - y_offset
    Z = zz + 0.5
    return X, Y, Z


def safe_pow(base, exp: float):
    """Float32 GPU-safe non-negative power (`max(0, base) ** exp`).

    Prevents silent NaN geometry truncation when float32 rounding produces tiny negative values
    such as `sin(pi) = -8.74e-8` raised to a fractional exponent!
    """
    return xp.maximum(0.0, base) ** exp


def safe_sin_pow(t, exp: float):
    """Float32 GPU-safe `max(0, sin(clamp(t, 0, 1) * pi)) ** exp` for smooth tapered body/limb profiles."""
    tc = xp.clip(t, 0.0, 1.0)
    return xp.maximum(0.0, xp.sin(tc * math.pi)) ** exp


def smin(a, b, k: float):
    h = xp.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1.0 - h) + a * h - k * h * (1.0 - h)


def smax(a, b, k: float):
    return -smin(-a, -b, k)


def sd_sphere(X, Y, Z, cx: float, cy: float, cz: float, r: float):
    return xp.sqrt((X - cx) ** 2 + (Y - cy) ** 2 + (Z - cz) ** 2) - r


def sd_ellipsoid(X, Y, Z, cx: float, cy: float, cz: float, rx: float, ry: float, rz: float):
    px = (X - cx) / rx
    py = (Y - cy) / ry
    pz = (Z - cz) / rz
    k0 = xp.sqrt(px * px + py * py + pz * pz) + 1e-8
    k1 = xp.sqrt((px / rx) ** 2 + (py / ry) ** 2 + (pz / rz) ** 2) + 1e-8
    return k0 * (k0 - 1.0) / k1


def sd_capsule(X, Y, Z, ax: float, ay: float, az: float, bx: float, by: float, bz: float,
               r0: float, r1: float | None = None):
    pax, pay, paz = X - ax, Y - ay, Z - az
    bax, bay, baz = bx - ax, by - ay, bz - az
    ba_len2 = bax * bax + bay * bay + baz * baz + 1e-8
    h = xp.clip((pax * bax + pay * bay + paz * baz) / ba_len2, 0.0, 1.0)
    dx = pax - bax * h
    dy = pay - bay * h
    dz = paz - baz * h
    r = r0 if r1 is None else (r0 + (r1 - r0) * h)
    return xp.sqrt(dx * dx + dy * dy + dz * dz) - r


def sd_cylinder_z(X, Y, Z, cx: float, cy: float, z0: float, z1: float,
                  r0: float, r1: float | None = None):
    h_frac = xp.clip((Z - z0) / max(z1 - z0, 1e-6), 0.0, 1.0)
    r = r0 if r1 is None else (r0 + (r1 - r0) * h_frac)
    d_rad = xp.sqrt((X - cx) ** 2 + (Y - cy) ** 2) - r
    d_z = xp.maximum(z0 - Z, Z - z1)
    return xp.maximum(d_rad, d_z)


def sd_box(X, Y, Z, cx: float, cy: float, cz: float, hx: float, hy: float, hz: float, round_r: float = 0.0):
    qx = xp.abs(X - cx) - (hx - round_r)
    qy = xp.abs(Y - cy) - (hy - round_r)
    qz = xp.abs(Z - cz) - (hz - round_r)
    outside = xp.sqrt(xp.maximum(qx, 0.0) ** 2 + xp.maximum(qy, 0.0) ** 2 + xp.maximum(qz, 0.0) ** 2)
    inside = xp.minimum(xp.maximum(qx, xp.maximum(qy, qz)), 0.0)
    return outside + inside - round_r


def sd_elliptic_cone_z(X, Y, Z, cx, cy, z0, z1, rx0, ry0, rx1, ry1,
                       wave_n: int = 0, wave_amp: float = 0.0, wave_phase: float = 0.0):
    t = xp.clip((Z - z0) / max(z1 - z0, 1e-6), 0.0, 1.0)
    rx = rx0 + (rx1 - rx0) * t
    ry = ry0 + (ry1 - ry0) * t
    dx = X - cx
    dy = Y - cy
    if wave_n > 0 and wave_amp != 0.0:
        ang = xp.arctan2(dy, dx)
        w = 1.0 + wave_amp * xp.cos(wave_n * ang + wave_phase)
        rx = rx * w
        ry = ry * w
    r_norm = xp.sqrt((dx / rx) ** 2 + (dy / ry) ** 2)
    r_avg = 0.5 * (rx + ry)
    d_rad = (r_norm - 1.0) * r_avg
    d_z = xp.maximum(z0 - Z, Z - z1)
    return xp.maximum(d_rad, d_z)


def sd_bone_chain(X, Y, Z, joints, radii, smooth_k: float = 2.0):
    d = None
    for i in range(len(joints) - 1):
        ax, ay, az = joints[i]
        bx, by, bz = joints[i + 1]
        seg = sd_capsule(X, Y, Z, ax, ay, az, bx, by, bz, radii[i], radii[i + 1])
        d = seg if d is None else smin(d, seg, smooth_k)
    return d


def sd_chain(X, Y, Z, pts, k: float = 1.5, x_mirror: bool = False):
    px = xp.abs(X) if x_mirror else X
    joints = [(p[0], p[1], p[2]) for p in pts]
    radii = [p[3] for p in pts]
    return sd_bone_chain(px, Y, Z, joints, radii, smooth_k=k)


def sd_polyline(X, Y, Z, pts, radius: float = 1.4):
    """Build a crisp constant-radius 3D cord/strap/rope/ribbon tube along a polyline of `(x, y, z)` points."""
    d = None
    for i in range(len(pts) - 1):
        ax, ay, az = pts[i]
        bx, by, bz = pts[i + 1]
        seg = sd_capsule(X, Y, Z, ax, ay, az, bx, by, bz, radius, radius)
        d = seg if d is None else xp.minimum(d, seg)
    return d


def sdf_indent_bulge(
    d_base,
    d_strap,
    cinch_depth: float = 2.4,
    cinch_width: float = 2.7,
    puff_amp: float = 1.6,
    puff_start: float = 2.3,
    puff_span: float = 3.6,
    mask=1.0,
):
    """Sculpt realistic 3D surface indentation under tight cords/belts/straps + plump cushion bulge between them.

    Transforms flat cylinders into tactile plush/fabric/anatomical 3D forms without any pasted 2D textures!
    """
    cinch = cinch_depth * xp.exp(-((d_strap / max(cinch_width, 1e-4)) ** 2))
    puff = puff_amp * xp.clip((d_strap - puff_start) / max(puff_span, 1e-4), 0.0, 1.0)
    return d_base + (cinch - puff) * mask


def sd_anime_head(
    X, Y, Z,
    cx: float, cy: float, cz: float,
    rx: float, ry: float, rz: float,
    cheek_drop: float = 0.52,
    cheek_rx_ratio: float = 0.96,
    cheek_ry_ratio: float = 0.93,
    chin_tuck_y: float = 0.08,
    bevel_front_ratio: float = 0.86,
    bevel_z_ratio: float = 0.82,
    bevel_k: float | None = None,
):
    """Sculpt a cute anime/chibi head with soft round mochi cheeks and a cleanly tucked-in chin (zero underbite!).

    Prevents the classic 3D SDF 'jutting chin / underbite' defect caused by shifting lower-cheek or chin
    ellipsoids forward (+Y) past the cranium. Scales cleanly across both tall anime and SD chibi heads:
      1. Cranium + plump side cheeks stay aligned behind the forehead front plane (zero snout bulge).
      2. Lower jaw ellipsoid is tucked BACKWARD (`-Y`, `cy - chin_tuck_y * ry`) toward the neck.
      3. A tilted smooth-max chin bevel plane (`+0.68*(Y - y_lim) + 0.73*(z_turn - Z)`) softly rounds
         the front-bottom chin curve inward into the neck across 0°, 22°, 45°, 68°, and 90° profiles.
    """
    d_cranium = sd_ellipsoid(X, Y, Z, cx, cy, cz, rx, ry, rz)
    d_cheeks = sd_ellipsoid(
        X, Y, Z,
        cx, cy + 0.025 * ry, cz - cheek_drop * rz,
        rx * cheek_rx_ratio, ry * cheek_ry_ratio, rz * 0.51,
    )
    d_jaw_tuck = sd_ellipsoid(
        X, Y, Z,
        cx, cy - chin_tuck_y * ry, cz - 0.78 * rz,
        rx * 0.66, ry * 0.73, rz * 0.27,
    )
    d_head = smin(smin(d_cranium, d_cheeks, 0.21 * rz), d_jaw_tuck, 0.16 * rz)
    y_lim = cy + bevel_front_ratio * ry
    z_turn = cz - bevel_z_ratio * rz
    d_chin_bevel = (Y - y_lim) * 0.68 + (z_turn - Z) * 0.73
    kb = (0.20 * rz) if bevel_k is None else bevel_k
    return smax(d_head, d_chin_bevel, kb)


def rot_inv_xyz(X, Y, Z, px: float, py: float, pz: float,
                roll_deg: float = 0.0, pitch_deg: float = 0.0, yaw_deg: float = 0.0):
    """Inverse-rotate query coordinates around pivot (px, py, pz) to pose a rigid bone."""
    dx = X - px
    dy = Y - py
    dz = Z - pz
    if abs(yaw_deg) > 1e-4:
        a = -math.radians(yaw_deg)
        ca, sa = math.cos(a), math.sin(a)
        dx, dy = dx * ca + dy * sa, -dx * sa + dy * ca
    if abs(pitch_deg) > 1e-4:
        a = -math.radians(pitch_deg)
        ca, sa = math.cos(a), math.sin(a)
        dy, dz = dy * ca + dz * sa, -dy * sa + dz * ca
    if abs(roll_deg) > 1e-4:
        a = -math.radians(roll_deg)
        ca, sa = math.cos(a), math.sin(a)
        dx, dz = dx * ca + dz * sa, -dx * sa + dz * ca
    return dx + px, dy + py, dz + pz


def project_tilted_face(X, Y, Z, cy: float, cz: float, tilt_deg: float = 14.5):
    """Project 3D head coordinates onto a tilted anime facial plane to avoid squash foreshortening."""
    rad = math.radians(tilt_deg)
    dy = Y - cy
    dz = Z - cz
    u = X
    v = dz * math.cos(rad) - dy * math.sin(rad)
    fwd = dy * math.cos(rad) + dz * math.sin(rad)
    return u, v, fwd


def compute_normals(sdf):
    gz = xp.gradient(sdf, axis=0)
    gy = xp.gradient(sdf, axis=1)
    gx = xp.gradient(sdf, axis=2)
    nlen = xp.sqrt(gx * gx + gy * gy + gz * gz) + 1e-8
    return gx / nlen, gy / nlen, gz / nlen


def shade_cel_3step(base_rgb, hi_rgb, sh_rgb, deep_rgb, nx, ny, nz, ao=0.0,
                    light_dir=(-0.22, 0.38, 0.90)):
    """Crisp 3-step anime cel shading with soft ambient occlusion."""
    lx, ly, lz = light_dir
    ndotl = nx * lx + ny * ly + nz * lz - ao * 0.45
    out = xp.empty((*ndotl.shape, 3), dtype=xp.uint8)
    out[...] = xp.asarray(base_rgb, dtype=xp.uint8)
    out[ndotl > 0.52] = xp.asarray(hi_rgb, dtype=xp.uint8)
    out[ndotl < 0.06] = xp.asarray(sh_rgb, dtype=xp.uint8)
    out[ndotl < -0.38] = xp.asarray(deep_rgb, dtype=xp.uint8)
    return out


def shade_rgb_field(base_arr, hi_arr, sh_arr, deep_arr, nx, ny, nz, ao=0.0,
                    light_dir=(-0.22, 0.38, 0.90)):
    """3-step anime cel shading for spatially varying color fields (e.g. gradient hair)."""
    lx, ly, lz = light_dir
    ndotl = nx * lx + ny * ly + nz * lz - ao * 0.45
    out = base_arr.copy()
    out[ndotl > 0.50] = hi_arr[ndotl > 0.50]
    out[ndotl < 0.04] = sh_arr[ndotl < 0.04]
    out[ndotl < -0.38] = deep_arr[ndotl < -0.38]
    return out
