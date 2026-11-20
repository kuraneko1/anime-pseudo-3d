"""Multi-View Orthographic Sheet Alignment, Visual Hull Blueprint & 6-View Seam-Free Color Joining.

Bridges generated multi-view 2D reference sheets (FRONT / SIDE / BACK / TOP / LEFT / RIGHT)
into the canonical 3D sprite-stacking voxel grid (+X right, +Y forward, +Z up) so ANY fresh
agent session can reconstruct consistent 3D proportions and seamlessly join all sides without
hard seams or guessing anatomy heights.
"""
from collections import deque
import math
import os
from typing import Any
import numpy as np
from PIL import Image, ImageDraw


def _sample_border_bg(rgb: np.ndarray) -> np.ndarray:
    """Estimate flat sheet background color from the 4 corners + outer edges."""
    h, w, _ = rgb.shape
    samples = np.concatenate([
        rgb[0, :, :],
        rgb[h - 1, :, :],
        rgb[:, 0, :],
        rgb[:, w - 1, :],
    ], axis=0)
    return np.median(samples, axis=0).astype(np.float32)


def remove_exterior_bg(img_rgb: np.ndarray, bg_tol: float = 28.0) -> np.ndarray:
    """Flood-fill exterior flat background from borders into alpha=0.

    Unlike naive chroma-keying, interior white eyes, shirts, collars, and lace stay 100% intact!
    """
    h, w, _ = img_rgb.shape
    bg = _sample_border_bg(img_rgb)
    diff = np.sqrt(np.sum((img_rgb.astype(np.float32) - bg) ** 2, axis=-1))
    is_bg_cand = diff <= bg_tol

    visited = np.zeros((h, w), dtype=bool)
    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        if is_bg_cand[0, x]:
            visited[0, x] = True
            q.append((0, x))
        if is_bg_cand[h - 1, x] and not visited[h - 1, x]:
            visited[h - 1, x] = True
            q.append((h - 1, x))
    for y in range(h):
        if is_bg_cand[y, 0] and not visited[y, 0]:
            visited[y, 0] = True
            q.append((y, 0))
        if is_bg_cand[y, w - 1] and not visited[y, w - 1]:
            visited[y, w - 1] = True
            q.append((y, w - 1))

    while q:
        cy, cx = q.popleft()
        for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and is_bg_cand[ny, nx]:
                visited[ny, nx] = True
                q.append((ny, nx))

    alpha = np.where(visited, 0, 255).astype(np.uint8)
    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[:, :, :3] = img_rgb
    out[:, :, 3] = alpha
    return out


def split_multiview_sheet(
    sheet_path: str,
    view_names: tuple[str, ...] = ("front", "side", "back"),
    bg_tol: float = 30.0,
    min_width_ratio: float = 0.08,
    crop_top_text_ratio: float = 0.0,
) -> dict[str, np.ndarray]:
    """Split a horizontal multi-view turnaround sheet (e.g. FRONT | SIDE | BACK) into clean RGBA cutouts.

    Handles both cleanly separated panels and minor header labels cleanly.
    """
    im = Image.open(sheet_path).convert("RGB")
    arr = np.asarray(im)
    if crop_top_text_ratio > 0.0:
        arr = arr[int(arr.shape[0] * crop_top_text_ratio):, :, :]

    rgba = remove_exterior_bg(arr, bg_tol=bg_tol)
    fg = rgba[:, :, 3] > 128
    h, w = fg.shape

    # Project foreground onto X axis to find horizontal view spans
    col_counts = fg.sum(axis=0)
    col_active = col_counts > max(3, int(h * 0.01))
    spans: list[tuple[int, int]] = []
    in_span = False
    s0 = 0
    for x in range(w):
        if col_active[x] and not in_span:
            s0 = x
            in_span = True
        elif not col_active[x] and in_span:
            if (x - s0) >= int(w * min_width_ratio):
                spans.append((s0, x))
            in_span = False
    if in_span and (w - s0) >= int(w * min_width_ratio):
        spans.append((s0, w))

    # Fallback to equal horizontal slices if sheet figures slightly touch or extra text blocks appear
    if len(spans) != len(view_names):
        n = len(view_names)
        step = w / float(n)
        spans = [(int(round(i * step)), int(round((i + 1) * step))) for i in range(n)]

    out: dict[str, np.ndarray] = {}
    for name, (x0, x1) in zip(view_names, spans):
        sub = rgba[:, x0:x1, :]
        ys, xs = np.where(sub[:, :, 3] > 128)
        if len(xs) == 0:
            out[name] = sub
            continue
        # Drop isolated tiny header label rows separated from main figure by blank vertical gap
        row_counts = (sub[:, :, 3] > 128).sum(axis=1)
        y_top, y_bot = int(ys.min()), int(ys.max())
        # Keep the largest contiguous vertical body block (eliminates "FRONT / SIDE / BACK" printed headers!)
        blocks = []
        b_in = False
        b0 = 0
        for y in range(sub.shape[0]):
            if row_counts[y] > 2 and not b_in:
                b0 = y
                b_in = True
            elif row_counts[y] <= 2 and b_in:
                blocks.append((b0, y - 1, int(row_counts[b0:y].sum())))
                b_in = False
        if b_in:
            blocks.append((b0, sub.shape[0] - 1, int(row_counts[b0:].sum())))
        if blocks:
            main_b = max(blocks, key=lambda b: b[2])
            y_top, y_bot = main_b[0], main_b[1]
        sub2 = sub[y_top : y_bot + 1, :, :]
        ys2, xs2 = np.where(sub2[:, :, 3] > 128)
        if len(xs2):
            sub2 = sub2[:, int(xs2.min()) : int(xs2.max()) + 1, :]
        out[name] = sub2
    return out


def _resize_rgba_to_canvas(
    rgba: np.ndarray,
    canvas_w: int,
    canvas_h: int,
    target_h: int,
    anchor: str = "bottom",
    target_w: int | None = None,
) -> np.ndarray:
    """Resize a tight RGBA cutout cleanly onto a centered canonical canvas."""
    im = Image.fromarray(rgba, mode="RGBA")
    src_w, src_h = im.size
    if target_w is not None:
        nw, nh = max(1, int(round(target_w))), max(1, int(round(target_h)))
    else:
        scale = target_h / float(max(1, src_h))
        nw = max(1, int(round(src_w * scale)))
        nh = max(1, int(round(target_h)))
        if nw > canvas_w - 4:
            shrink = (canvas_w - 4) / float(nw)
            nw = max(1, int(round(nw * shrink)))
            nh = max(1, int(round(nh * shrink)))
    resized = im.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    ox = (canvas_w - nw) // 2
    if anchor == "bottom":
        oy = canvas_h - nh
    else:
        oy = (canvas_h - nh) // 2
    canvas.paste(resized, (ox, oy), resized)
    return np.asarray(canvas)


def align_and_measure_views(
    views_rgba: dict[str, np.ndarray],
    grid_xy: int = 112,
    grid_z: int = 160,
    z_height: int = 140,
    qa_out_path: str | None = None,
) -> dict[str, Any]:
    """Align FRONT/BACK/SIDE/LEFT/RIGHT/TOP cutouts into unified voxel coordinates and extract Z-landmarks.

    Canonical conventions:
      - Standing orthographic views (`front`, `back`, `side`, `left`, `right`): shape `(grid_z, grid_xy, 4)`,
        where row `grid_z - 1 - z` corresponds to voxel slice `z` (`z=0` at bottom soles, `z=z_height` at crown).
      - Overhead view (`top`, optional `bottom`): shape `(grid_xy, grid_xy, 4)`, aligned to `(front_width, side_depth)`.
    """
    aligned: dict[str, np.ndarray] = {}
    standing_keys = [k for k in ("front", "back", "side", "left", "right") if k in views_rgba]
    for k in standing_keys:
        aligned[k] = _resize_rgba_to_canvas(views_rgba[k], grid_xy, grid_z, target_h=z_height, anchor="bottom")

    # Measure X width from front (or back) and Y depth from side/left/right
    ref_front = aligned.get("front", aligned.get("back"))
    ref_side = aligned.get("side", aligned.get("left", aligned.get("right")))

    def slice_spans(img_rgba: np.ndarray | None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        w_arr = np.zeros(grid_z, dtype=np.float32)
        c_arr = np.zeros(grid_z, dtype=np.float32)
        has = np.zeros(grid_z, dtype=bool)
        if img_rgba is None:
            return w_arr, c_arr, has
        alpha = img_rgba[:, :, 3] > 128
        for z in range(grid_z):
            row = alpha[grid_z - 1 - z]
            xs = np.where(row)[0]
            if len(xs):
                w_arr[z] = float(xs.max() - xs.min() + 1)
                c_arr[z] = float(0.5 * (xs.min() + xs.max()) - (grid_xy - 1) * 0.5)
                has[z] = True
        return w_arr, c_arr, has

    wx, cx, has_x = slice_spans(ref_front)
    dy, cy, has_y = slice_spans(ref_side)

    max_w = float(wx.max()) if has_x.any() else float(grid_xy * 0.55)
    max_d = float(dy.max()) if has_y.any() else float(max_w * 0.65)

    for k in ("top", "bottom"):
        if k in views_rgba:
            aligned[k] = _resize_rgba_to_canvas(
                views_rgba[k], grid_xy, grid_xy, target_h=int(round(max_d)), target_w=int(round(max_w)), anchor="center"
            )

    # Automatic anatomical Z-landmark detection from width profile wx(z)
    z_crown = int(np.where(has_x)[0].max()) if has_x.any() else z_height
    z_soles = int(np.where(has_x)[0].min()) if has_x.any() else 0
    span = max(1, z_crown - z_soles)
    # Locate neck pinch (local minimum in width between 50% and 82% height)
    n_lo = z_soles + int(span * 0.48)
    n_hi = z_soles + int(span * 0.84)
    z_neck = int(n_lo + np.argmin(np.where(wx[n_lo:n_hi] > 1, wx[n_lo:n_hi], 9999))) if n_hi > n_lo else int(z_soles + span * 0.68)
    # Head width & center above neck
    head_slice = wx[z_neck:z_crown + 1]
    z_head_mid = int(z_neck + np.argmax(head_slice)) if len(head_slice) else int(z_soles + span * 0.82)
    # Shoulder peak just below neck
    sh_lo = max(z_soles, z_neck - int(span * 0.20))
    z_shoulders = int(sh_lo + np.argmax(wx[sh_lo:max(sh_lo + 1, z_neck)]))
    landmarks = {
        "z_soles": z_soles,
        "z_knees": int(z_soles + span * 0.22),
        "z_hips": int(z_soles + span * 0.40),
        "z_waist": int(z_soles + span * 0.50),
        "z_shoulders": z_shoulders,
        "z_neck": z_neck,
        "z_chin": min(z_crown, z_neck + 3),
        "z_head_mid": z_head_mid,
        "z_crown": z_crown,
        "max_width_x": round(max_w, 1),
        "max_depth_y": round(max_d, 1),
        "head_width_x": round(float(wx[z_head_mid]), 1) if has_x.any() else 0.0,
        "head_depth_y": round(float(dy[z_head_mid]), 1) if has_y.any() else 0.0,
        "shoulder_width_x": round(float(wx[z_shoulders]), 1) if has_x.any() else 0.0,
    }

    if qa_out_path:
        _save_alignment_qa(aligned, landmarks, grid_xy, grid_z, qa_out_path)

    return {
        "aligned": aligned,
        "width_x": wx,
        "depth_y": dy,
        "center_x": cx,
        "center_y": cy,
        "landmarks": landmarks,
        "grid_xy": grid_xy,
        "grid_z": grid_z,
    }


def _save_alignment_qa(aligned: dict[str, np.ndarray], lm: dict[str, Any], gw: int, gh: int, out_path: str):
    order = [k for k in ("front", "side", "left", "right", "back", "top") if k in aligned]
    if not order:
        return
    scale = 2
    pw, ph = gw * scale, gh * scale
    sheet = Image.new("RGB", (pw * len(order), ph + 28), (22, 30, 54))
    draw = ImageDraw.Draw(sheet)
    ruler_specs = [
        ("z_crown", (88, 216, 255)),
        ("z_head_mid", (148, 240, 255)),
        ("z_neck", (250, 204, 21)),
        ("z_shoulders", (251, 146, 60)),
        ("z_waist", (74, 222, 128)),
        ("z_soles", (244, 114, 182)),
    ]
    for i, k in enumerate(order):
        arr = aligned[k]
        tile = Image.new("RGBA", (gw, gh), (223, 233, 248, 255))
        im_k = Image.fromarray(arr, mode="RGBA")
        if k in ("top", "bottom"):
            tile.paste(im_k, (0, (gh - gw) // 2), im_k)
        else:
            tile.paste(im_k, (0, 0), im_k)
        tile_up = tile.convert("RGB").resize((pw, ph), Image.NEAREST)
        x0 = i * pw
        sheet.paste(tile_up, (x0, 28))
        draw.text((x0 + 8, 8), f"{k.upper()}", fill=(240, 248, 255))
        if k not in ("top", "bottom"):
            for rkey, col in ruler_specs:
                y = 28 + (gh - 1 - int(lm[rkey])) * scale
                draw.line([(x0, y), (x0 + pw - 1, y)], fill=col, width=1)
        draw.line([(x0, 0), (x0, ph + 28)], fill=(12, 16, 30), width=2)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    sheet.save(out_path)


def reconstruct_visual_hull(
    blueprint: dict[str, Any],
    flip_back_x: bool = True,
    side_faces_right: bool = True,
    erode_px: int = 0,
) -> np.ndarray:
    """Intersect orthographic multi-view silhouettes (FRONT ∩ BACK ∩ SIDE/LEFT/RIGHT ∩ TOP) into a 3D occupancy volume.

    Returns boolean numpy array of shape `(grid_xy, grid_xy, grid_z)` indexed `[y, x, z]` matching `gpu_sdf.make_grid`.
    """
    aligned = blueprint["aligned"]
    gw = int(blueprint["grid_xy"])
    gh = int(blueprint["grid_z"])

    # Volume shape [H=Y, W=X, D=Z] matching make_grid(W, H, D)
    occ = np.ones((gw, gw, gh), dtype=bool)

    # FRONT (+Y viewing toward -Y): image x -> voxel +x, image row (gh-1-z) -> voxel z
    if "front" in aligned:
        m = (aligned["front"][:, :, 3] > 128)[::-1, :].T  # (X, Z)
        occ &= m[None, :, :]

    # BACK (-Y viewing toward +Y): mirrored X horizontally relative to front
    if "back" in aligned:
        m_back = (aligned["back"][:, :, 3] > 128)[::-1, :]
        if flip_back_x:
            m_back = m_back[:, ::-1]
        occ &= m_back.T[None, :, :]

    # SIDE / LEFT / RIGHT: image horizontal maps to voxel Y depth!
    side_img = aligned.get("side", aligned.get("left", aligned.get("right")))
    if side_img is not None:
        m_side = (side_img[:, :, 3] > 128)[::-1, :]  # (Z, Y_img)
        if not side_faces_right:
            m_side = m_side[:, ::-1]
        # m_side.T has shape (Y, Z) where larger Y = forward (+Y)
        occ &= m_side.T[:, None, :]

    # TOP (+Z looking down): image x -> voxel x, image y -> voxel y
    if "top" in aligned:
        m_top = aligned["top"][:, :, 3] > 128  # (Y, X)
        occ &= m_top[:, :, None]

    # Simple optional 1-voxel erosion to trim anti-aliased fringe
    if erode_px > 0:
        for _ in range(erode_px):
            er = occ.copy()
            er[1:-1, 1:-1, 1:-1] &= (
                occ[:-2, 1:-1, 1:-1] & occ[2:, 1:-1, 1:-1] &
                occ[1:-1, :-2, 1:-1] & occ[1:-1, 2:, 1:-1]
            )
            occ = er

    return occ


def project_6view_colors(
    occ: np.ndarray,
    blueprint: dict[str, Any],
    flip_back_x: bool = True,
    side_faces_right: bool = True,
    sharpness: float = 3.0,
    face_protect_mask: np.ndarray | None = None,
) -> np.ndarray:
    """Seam-free 6-view normal-weighted orthographic color projection onto any 3D occupancy volume.

    Smoothly joins FRONT, BACK, LEFT/SIDE, RIGHT, TOP, and BOTTOM artwork colors across the 3D surface
    using surface-normal directional weights (`max(0, dot(n, view_dir))^sharpness`), eliminating hard seams
    while leaving `face_protect_mask` untouched for dedicated tilted anime face projection!

    Returns uint8 RGBA volume `(Y, X, Z, 4)`.
    """
    aligned = blueprint["aligned"]
    gy, gx, gz = occ.shape

    # Estimate outward surface normals directly from binary occupancy via central finite differences
    f_occ = occ.astype(np.float32)
    ny = np.zeros_like(f_occ)
    nx = np.zeros_like(f_occ)
    nz = np.zeros_like(f_occ)
    # Outward normal points from occupied(1) -> empty(0), i.e., -grad(occ)
    ny[1:-1, :, :] = f_occ[:-2, :, :] - f_occ[2:, :, :]
    nx[:, 1:-1, :] = f_occ[:, :-2, :] - f_occ[:, 2:, :]
    nz[:, :, 1:-1] = f_occ[:, :, :-2] - f_occ[:, :, 2:]
    nlen = np.sqrt(nx * nx + ny * ny + nz * nz) + 1e-6
    nx /= nlen
    ny /= nlen
    nz /= nlen

    ys, xs, zs = np.where(occ)
    if len(xs) == 0:
        return np.zeros((gy, gx, gz, 4), dtype=np.uint8)

    vx = nx[ys, xs, zs]
    vy = ny[ys, xs, zs]
    vz = nz[ys, xs, zs]

    acc_rgb = np.zeros((len(xs), 3), dtype=np.float32)
    acc_w = np.zeros((len(xs),), dtype=np.float32)

    def add_view(view_key: str, u: np.ndarray, v: np.ndarray, dir_dot: np.ndarray):
        if view_key not in aligned:
            return
        img = aligned[view_key]
        ih, iw, _ = img.shape
        uu = np.clip(u, 0, iw - 1)
        vv = np.clip(v, 0, ih - 1)
        rgba = img[vv, uu]
        valid = rgba[:, 3] > 96
        w = np.maximum(0.0, dir_dot) ** sharpness
        w = np.where(valid, w + 1e-4, 0.0)
        acc_rgb[:, 0] += rgba[:, 0].astype(np.float32) * w
        acc_rgb[:, 1] += rgba[:, 1].astype(np.float32) * w
        acc_rgb[:, 2] += rgba[:, 2].astype(np.float32) * w
        acc_w[:] += w

    z_row = (gz - 1) - zs

    # FRONT (+Y)
    add_view("front", xs, z_row, vy)
    # BACK (-Y)
    add_view("back", (gx - 1 - xs) if flip_back_x else xs, z_row, -vy)
    # RIGHT / SIDE (+X) and LEFT (-X)
    if "right" in aligned or "left" in aligned:
        y_u_r = ys if side_faces_right else (gy - 1 - ys)
        y_u_l = (gy - 1 - ys) if side_faces_right else ys
        if "right" in aligned:
            add_view("right", y_u_r, z_row, vx)
        if "left" in aligned:
            add_view("left", y_u_l, z_row, -vx)
    elif "side" in aligned:
        y_u = ys if side_faces_right else (gy - 1 - ys)
        add_view("side", y_u, z_row, np.abs(vx))
    # TOP (+Z) and BOTTOM (-Z)
    add_view("top", xs, ys, vz)
    add_view("bottom", xs, gy - 1 - ys, -vz)

    # Fallback color for completely interior voxels (use front/median non-zero color)
    fallback = np.array([128.0, 148.0, 188.0], dtype=np.float32)
    has_c = acc_w > 1e-6
    rgb_out = np.empty((len(xs), 3), dtype=np.uint8)
    rgb_out[has_c] = np.clip(acc_rgb[has_c] / acc_w[has_c, None], 0, 255).astype(np.uint8)
    if (~has_c).any():
        if has_c.any():
            fallback = np.median(rgb_out[has_c], axis=0)
        rgb_out[~has_c] = fallback.astype(np.uint8)

    vol = np.zeros((gy, gx, gz, 4), dtype=np.uint8)
    vol[ys, xs, zs, :3] = rgb_out
    vol[ys, xs, zs, 3] = 255
    if face_protect_mask is not None:
        # Leave protected face alpha=255 so caller can composite tilted anime face cleanly
        pass
    return vol


def render_multiview_fit_qa(
    vol_rgba: np.ndarray,
    blueprint: dict[str, Any],
    out_path: str,
    flip_back_x: bool = True,
    side_faces_right: bool = True,
) -> dict[str, float]:
    """Compare sculpted 3D voxel volume against aligned reference views and save a visual QA overlay.

    Computes 2D Silhouette IoU for FRONT, SIDE, BACK, and TOP and writes a 2-row QA image:
      Row 1: Reference views
      Row 2: Sculpted 3D orthographic renders + IoU score badge
    """
    aligned = blueprint["aligned"]
    gy, gx, gz, _ = vol_rgba.shape
    occ = vol_rgba[:, :, :, 3] > 128

    def ortho_render(axis: str) -> np.ndarray:
        if axis == "front":
            # Look from +Y toward -Y (largest y wins)
            img = np.zeros((gz, gx, 4), dtype=np.uint8)
            for y in range(gy):
                sl = vol_rgba[y, :, :, :]  # (X, Z, 4)
                sl_t = np.transpose(sl, (1, 0, 2))[::-1, :, :]  # (Z_img, X, 4)
                m = sl_t[:, :, 3] > 128
                img[m] = sl_t[m]
            return img
        if axis == "back":
            img = np.zeros((gz, gx, 4), dtype=np.uint8)
            for y in range(gy - 1, -1, -1):
                sl = vol_rgba[y, :, :, :]
                sl_t = np.transpose(sl, (1, 0, 2))[::-1, :, :]
                if flip_back_x:
                    sl_t = sl_t[:, ::-1, :]
                m = sl_t[:, :, 3] > 128
                img[m] = sl_t[m]
            return img
        if axis in ("side", "right", "left"):
            img = np.zeros((gz, gy, 4), dtype=np.uint8)
            rng = range(gx) if axis != "left" else range(gx - 1, -1, -1)
            for x in rng:
                sl = vol_rgba[:, x, :, :]  # (Y, Z, 4)
                sl_t = np.transpose(sl, (1, 0, 2))[::-1, :, :]
                if not side_faces_right:
                    sl_t = sl_t[:, ::-1, :]
                m = sl_t[:, :, 3] > 128
                img[m] = sl_t[m]
            return img
        # top (+Z looking down)
        img = np.zeros((gy, gx, 4), dtype=np.uint8)
        for z in range(gz):
            sl = vol_rgba[:, :, z, :]
            m = sl[:, :, 3] > 128
            img[m] = sl[m]
        return img

    order = [k for k in ("front", "side", "left", "right", "back", "top") if k in aligned]
    ious: dict[str, float] = {}
    scale = 2
    pw, ph = gx * scale, gz * scale
    sheet = Image.new("RGB", (pw * len(order), ph * 2 + 56), (18, 26, 48))
    draw = ImageDraw.Draw(sheet)

    for i, k in enumerate(order):
        ref = aligned[k]
        ren = ortho_render(k)
        ref_m = ref[:, :, 3] > 128
        ren_m = ren[:, :, 3] > 128
        inter = int(np.logical_and(ref_m, ren_m).sum())
        union = int(np.logical_or(ref_m, ren_m).sum())
        iou = float(inter) / float(max(1, union))
        ious[k] = round(iou, 3)

        def to_rgb_tile(arr_rgba: np.ndarray) -> Image.Image:
            bg = Image.new("RGBA", (gx, gz), (223, 233, 248, 255))
            im = Image.fromarray(arr_rgba, mode="RGBA")
            oy = (gz - arr_rgba.shape[0]) // 2
            bg.paste(im, (0, oy), im)
            return bg.convert("RGB").resize((pw, ph), Image.NEAREST)

        x0 = i * pw
        sheet.paste(to_rgb_tile(ref), (x0, 28))
        sheet.paste(to_rgb_tile(ren), (x0, 56 + ph))
        draw.text((x0 + 8, 8), f"REF: {k.upper()}", fill=(200, 224, 255))
        col_iou = (74, 222, 128) if iou >= 0.72 else ((250, 204, 21) if iou >= 0.55 else (248, 113, 113))
        draw.text((x0 + 8, 36 + ph), f"3D: {k.upper()}  IoU={iou*100:.1f}%", fill=col_iou)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    sheet.save(out_path)
    return ious
