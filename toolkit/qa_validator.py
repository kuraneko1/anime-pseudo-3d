"""Automated Pre-Bake & Post-Bake QA Validator, Lossless WebP Exporter, and 3D QA Sheet Renderer."""
import math
import os
import numpy as np
from PIL import Image


def validate_motion_poses(poses: list, max_downward_pitch_deg: float = 15.0) -> list[str]:
    """Pre-bake mathematical QA for 24-FPS cyclic PoseFrame lists.

    Checks:
      1. Loop seam continuity between final frame and frame 0
      2. Face visibility guard: warns if `torso_pitch + head_pitch` tilts face too far downward
      3. Excessive root bob that could risk top-border clipping on 160-slice anime grids
    """
    warnings = []
    if len(poses) < 2:
        return warnings

    p0, p_last = poses[0], poses[-1]
    if abs(p0.root_bob - p_last.root_bob) > 2.2:
        warnings.append(f"[{p0.motion_id}] Loop seam jump in root_bob: F0={p0.root_bob:.2f} vs F{len(poses)-1}={p_last.root_bob:.2f}")
    if abs(p0.torso_pitch - p_last.torso_pitch) > 5.0:
        warnings.append(f"[{p0.motion_id}] Loop seam jump in torso_pitch: F0={p0.torso_pitch:.1f} vs F{len(poses)-1}={p_last.torso_pitch:.1f}")

    for p in poses:
        total_face_down = p.torso_pitch + p.head_pitch
        if total_face_down > max_downward_pitch_deg:
            warnings.append(
                f"[{p.motion_id} F{p.frame_idx:02d}] Face tilted down {total_face_down:.1f} deg "
                f"(torso {p.torso_pitch:.1f} + head {p.head_pitch:.1f}); counter-pitch head negative!"
            )
        if p.root_bob > 9.5:
            warnings.append(f"[{p.motion_id} F{p.frame_idx:02d}] High root_bob={p.root_bob:.2f} risks ceiling clip")
    return warnings


def assert_no_border_clipping(vol: np.ndarray, label: str = "frame", check_bottom: bool = False):
    """Assert zero occupied alpha voxels touch outer volume boundaries."""
    a = vol[..., 3] > 0
    hits = {}
    if a[:, :, 0].any():
        hits["x_min"] = int(a[:, :, 0].sum())
    if a[:, :, -1].any():
        hits["x_max"] = int(a[:, :, -1].sum())
    if a[:, 0, :].any():
        hits["y_min"] = int(a[:, 0, :].sum())
    if a[:, -1, :].any():
        hits["y_max"] = int(a[:, -1, :].sum())
    if a[-1, :, :].any():
        hits["z_max"] = int(a[-1, :, :].sum())
    if check_bottom and a[0, :, :].any():
        hits["z_min"] = int(a[0, :, :].sum())
    if hits:
        raise ValueError(f"Border clipping detected in '{label}': {hits}")


def save_tiled_webp(vol: np.ndarray, path: str, cols: int = 16):
    """Save (H, L, W, 4) voxel slices as a GPU-safe lossless WebP tiled atlas."""
    H, L, W, _ = vol.shape
    rows = int(math.ceil(H / cols))
    atlas = np.zeros((rows * L, cols * W, 4), dtype=np.uint8)
    for z in range(H):
        r, c = z // cols, z % cols
        atlas[r * L:(r + 1) * L, c * W:(c + 1) * W] = vol[z]
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    Image.fromarray(atlas, "RGBA").save(path, format="WEBP", lossless=True, quality=100, method=4)


def render_stack_angle(
    vol: np.ndarray,
    angle_deg: float = 24.0,
    squash: float = 0.35,
    outline_color: tuple[int, int, int] = (36, 42, 88),
) -> Image.Image:
    """CPU reference renderer for rapid 3D visual QA sheets across arbitrary angles."""
    H, L, W, _ = vol.shape
    diag = int(math.ceil(math.hypot(W, L))) + 8
    out_h = int(math.ceil(diag * squash)) + H + 12
    canvas = Image.new("RGBA", (diag, out_h), (0, 0, 0, 0))
    cx = diag // 2
    base_y = out_h - int(diag * squash * 0.5) - 4

    for z in range(H):
        sl = vol[z]
        if not (sl[..., 3] > 0).any():
            continue
        im = Image.fromarray(sl, "RGBA").rotate(-angle_deg, resample=Image.NEAREST, expand=True)
        sh = max(1, int(round(im.height * squash)))
        im = im.resize((im.width, sh), resample=Image.NEAREST)
        px = cx - im.width // 2
        py = base_y - z - im.height // 2
        canvas.alpha_composite(im, (px, py))

    arr = np.array(canvas)
    m = arr[..., 3] > 0
    p = np.pad(m, 1)
    ring = (~m) & (p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:])
    arr[ring] = (*outline_color, 255)
    return Image.fromarray(arr, "RGBA")


def render_animation_sheet(
    vols: list[np.ndarray],
    out_path: str,
    angles_deg: tuple[float, ...] = (0.0, 24.0, 90.0),
    squash: float = 0.35,
    outline_color: tuple[int, int, int] = (36, 42, 88),
    scale: int = 2,
):
    """Render a multi-angle x multi-frame 3D visual QA contact sheet PNG."""
    rows = []
    for ang in angles_deg:
        imgs = [render_stack_angle(v, angle_deg=ang, squash=squash, outline_color=outline_color) for v in vols]
        mw = max(i.width for i in imgs)
        mh = max(i.height for i in imgs)
        row = Image.new("RGBA", (len(imgs) * (mw + 8) + 8, mh + 8), (223, 233, 248, 255))
        for idx, im in enumerate(imgs):
            row.alpha_composite(im, (8 + idx * (mw + 8) + (mw - im.width) // 2, 4 + (mh - im.height)))
        rows.append(row)

    sheet = Image.new("RGBA", (rows[0].width, sum(r.height for r in rows)), (223, 233, 248, 255))
    y = 0
    for r in rows:
        sheet.alpha_composite(r, (0, y))
        y += r.height
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    if scale > 1:
        sheet = sheet.resize((sheet.width * scale, sheet.height * scale), Image.NEAREST)
    sheet.save(out_path)
