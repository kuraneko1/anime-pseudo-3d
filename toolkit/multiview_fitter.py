"""Multi-View Orthographic Sheet Blueprint Alignment, Palette Sampling & Silhouette IoU QA.

CANONICAL WORKFLOW PRINCIPLE (Pure GPU SDF Sculpting — ZERO Body Texture Pasting!):
  Generated multi-view 2D turnaround sheets (`FRONT / SIDE / BACK / TOP`) are used STRICTLY as:
    1. Exact geometric & anatomical coordinate blueprints (`split_multiview_sheet`, `align_and_measure_views`)
    2. Clean flat cel-shading color palette references (`sample_clean_palette`)
    3. Objective 3D-to-2D Silhouette IoU QA ground truth (`render_multiview_fit_qa`, target >= 72%)

  NEVER paste/project generated turnaround images directly as 3D body/hair/clothing textures
  (that bakes muddy 2D black lineart, flat lighting, and misaligned smudges into voxel slices).
  Sculpt 100% of 3D volume, cavities, folds, hair locks, and accessories in GPU SDF (`toolkit/gpu_sdf.py`)
  and shade with crisp 3-step normal cel shading (`shade_cel_3step`)!
"""
from collections import deque
import math
import os
from typing import Any
import warnings
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

    Unlike naive chroma-keying, interior white eyes, shirts, collars, and cream plush stay intact!
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


def _label_components(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """Label 4-connected foreground components (uses scipy.ndimage if available, else fast pure-Python BFS)."""
    try:
        from scipy import ndimage
        return ndimage.label(mask)
    except Exception:
        h, w = mask.shape
        lbl = np.zeros((h, w), dtype=np.int32)
        cid = 0
        for y in range(h):
            for x in range(w):
                if mask[y, x] and lbl[y, x] == 0:
                    cid += 1
                    q: deque[tuple[int, int]] = deque([(y, x)])
                    lbl[y, x] = cid
                    while q:
                        cy, cx = q.popleft()
                        for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                            if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and lbl[ny, nx] == 0:
                                lbl[ny, nx] = cid
                                q.append((ny, nx))
        return lbl, cid


def clear_interior_white_holes(
    rgba: np.ndarray,
    white_thresh: int = 247,
    max_y_ratio: float = 1.0,
    min_area: int = 120,
) -> np.ndarray:
    """Punch out enclosed pure-white canvas pockets trapped between arms, legs, hair loops, or suspension ropes.

    Restricts removal to near-pure `#FFFFFF` regions (`min(R,G,B) >= white_thresh`) of at least `min_area` pixels
    inside the top `max_y_ratio` band so off-white shirts, cream plush bellies, and small eye glints stay intact!
    """
    out = rgba.copy()
    h = out.shape[0]
    y_lim = max(1, int(round(h * max_y_ratio)))
    cand = (
        (out[:, :, 3] > 128)
        & (out[:, :, 0] >= white_thresh)
        & (out[:, :, 1] >= white_thresh)
        & (out[:, :, 2] >= white_thresh)
    )
    cand[y_lim:, :] = False
    if not cand.any():
        return out
    lbl, n = _label_components(cand)
    for cid in range(1, n + 1):
        m = (lbl == cid)
        if int(m.sum()) >= min_area:
            out[m, 3] = 0
    return out


def split_multiview_sheet(
    sheet_path: str,
    view_names: tuple[str, ...] = ("front", "side", "back"),
    bg_tol: float = 28.0,
    min_area_ratio: float = 0.008,
    crop_top_text_ratio: float = 0.0,
    preserve_shared_baseline: bool = True,
    clear_upper_white_holes_ratio: float = 0.0,
    white_hole_thresh: int = 247,
) -> dict[str, np.ndarray]:
    """Split a horizontal multi-view turnaround sheet (`FRONT | SIDE | BACK`) into clean RGBA cutouts.

    Uses connected-component isolation (`scipy.ndimage.label` / BFS fallback) sorted left-to-right so
    wide/close panels NEVER bleed or slice into neighboring panels, while preserving the exact shared
    vertical baseline (`y_min_all..y_max_all`) across all views on the sheet!
    """
    im = Image.open(sheet_path).convert("RGB")
    arr = np.asarray(im)
    if crop_top_text_ratio > 0.0:
        arr = arr[int(arr.shape[0] * crop_top_text_ratio):, :, :]

    rgba = remove_exterior_bg(arr, bg_tol=bg_tol)
    fg = rgba[:, :, 3] > 128
    h, w = fg.shape
    min_area = max(400, int(h * w * min_area_ratio))

    lbl, n_comp = _label_components(fg)
    comps = []
    for cid in range(1, n_comp + 1):
        m = (lbl == cid)
        area = int(m.sum())
        if area < min_area:
            continue
        ys, xs = np.where(m)
        comps.append({
            "cx": float(xs.mean()),
            "x0": int(xs.min()),
            "x1": int(xs.max()),
            "y0": int(ys.min()),
            "y1": int(ys.max()),
            "area": area,
            "cid": cid,
        })

    # If a sheet had slightly more major components than view_names (e.g. detached floating prop/ahoge),
    # pick the largest N components as main figures and merge any smaller components into the nearest panel!
    if len(comps) >= len(view_names):
        main_comps = sorted(comps, key=lambda c: c["area"], reverse=True)[: len(view_names)]
        main_comps.sort(key=lambda c: c["cx"])

        y_min_all = min(c["y0"] for c in main_comps)
        y_max_all = max(c["y1"] for c in main_comps)
        out: dict[str, np.ndarray] = {}
        for name, comp in zip(view_names, main_comps):
            x0, x1 = comp["x0"], comp["x1"]
            y0 = y_min_all if preserve_shared_baseline else comp["y0"]
            y1 = y_max_all if preserve_shared_baseline else comp["y1"]
            sub = rgba[y0 : y1 + 1, x0 : x1 + 1].copy()
            sub_m = (lbl[y0 : y1 + 1, x0 : x1 + 1] == comp["cid"])
            # Also retain tiny nearby detached parts (like floating sparks/hair tips) inside this panel's bbox
            # that do NOT belong to another main panel!
            other_main = np.zeros_like(sub_m)
            for oc in main_comps:
                if oc["cid"] != comp["cid"]:
                    other_main |= (lbl[y0 : y1 + 1, x0 : x1 + 1] == oc["cid"])
            sub[other_main, 3] = 0
            # Keep primary component + tiny non-other fragments cleanly
            if not preserve_shared_baseline:
                sub[~sub_m, 3] = 0
            if clear_upper_white_holes_ratio > 0.0:
                sub = clear_interior_white_holes(
                    sub,
                    white_thresh=white_hole_thresh,
                    max_y_ratio=clear_upper_white_holes_ratio,
                )
            out[name] = sub
        return out

    # Fallback: column-projection spans (handles sheets where figures slightly touch)
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
            if (x - s0) >= int(w * 0.08):
                spans.append((s0, x))
            in_span = False
    if in_span and (w - s0) >= int(w * 0.08):
        spans.append((s0, w))

    if len(spans) != len(view_names):
        n = len(view_names)
        step = w / float(n)
        spans = [(int(round(i * step)), int(round((i + 1) * step))) for i in range(n)]

    out = {}
    ys_all, _ = np.where(fg)
    y_min_all = int(ys_all.min()) if len(ys_all) else 0
    y_max_all = int(ys_all.max()) if len(ys_all) else h - 1
    for name, (x0, x1) in zip(view_names, spans):
        sub = rgba[y_min_all : y_max_all + 1, x0:x1, :].copy() if preserve_shared_baseline else rgba[:, x0:x1, :].copy()
        ys2, xs2 = np.where(sub[:, :, 3] > 128)
        if len(xs2):
            sub = sub[:, int(xs2.min()) : int(xs2.max()) + 1, :]
            if not preserve_shared_baseline:
                sub = sub[int(ys2.min()) : int(ys2.max()) + 1, :, :]
        if clear_upper_white_holes_ratio > 0.0:
            sub = clear_interior_white_holes(
                sub,
                white_thresh=white_hole_thresh,
                max_y_ratio=clear_upper_white_holes_ratio,
            )
        out[name] = sub
    return out


def sample_clean_palette(
    img_rgba: np.ndarray,
    n_colors: int = 6,
    exclude_dark_outline_lum: float = 48.0,
) -> list[dict[str, Any]]:
    """Sample clean flat cel-shading base RGB clusters from an aligned reference view (ignoring dark 2D outlines).

    Use these clean RGB clusters to parameterize `gpu_sdf.shade_cel_3step(...)` rather than pasting raw
    2D image pixels onto the 3D surface!
    """
    a = img_rgba[:, :, 3] > 128
    rgb = img_rgba[:, :, :3].astype(np.float32)
    lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    fg = a & (lum >= exclude_dark_outline_lum)
    if not fg.any():
        return []

    # Fast PIL median-cut quantization on outline-free foreground pixels
    pts = rgb[fg].astype(np.uint8)
    side = max(1, int(math.ceil(math.sqrt(len(pts)))))
    pad = np.zeros((side * side, 3), dtype=np.uint8)
    pad[: len(pts)] = pts
    if len(pts) < side * side:
        pad[len(pts) :] = pts[0]
    q_im = Image.fromarray(pad.reshape(side, side, 3), "RGB").quantize(colors=max(2, n_colors), method=Image.Quantize.MEDIANCUT)
    pal = np.asarray(q_im.getpalette()[: n_colors * 3], dtype=np.uint8).reshape(-1, 3)
    idx = np.asarray(q_im).ravel()[: len(pts)]
    counts = np.bincount(idx, minlength=len(pal))
    order = np.argsort(-counts)

    out = []
    total = float(max(1, len(pts)))
    for i in order:
        if counts[i] <= 0:
            continue
        base = pal[i].astype(np.float32)
        hi = np.clip(base * 1.18 + 14.0, 0, 255).astype(int).tolist()
        sh = np.clip(base * 0.78 - 6.0, 0, 255).astype(int).tolist()
        deep = np.clip(base * 0.56 - 10.0, 0, 255).astype(int).tolist()
        out.append({
            "ratio": round(float(counts[i]) / total, 3),
            "base": base.astype(int).tolist(),
            "hi": hi,
            "sh": sh,
            "deep": deep,
        })
    return out


def _resize_rgba_to_canvas(
    rgba: np.ndarray,
    canvas_w: int,
    canvas_h: int,
    target_h: int,
    anchor: str = "bottom",
    target_w: int | None = None,
) -> np.ndarray:
    """Resize a clean RGBA cutout onto a centered canonical voxel canvas."""
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
    oy = (canvas_h - nh) if anchor == "bottom" else ((canvas_h - nh) // 2)
    canvas.paste(resized, (ox, oy), resized)
    return np.asarray(canvas)


def align_and_measure_views(
    views_rgba: dict[str, np.ndarray],
    grid_xy: int = 112,
    grid_z: int = 160,
    z_height: int = 140,
    qa_out_path: str | None = None,
) -> dict[str, Any]:
    """Align FRONT/BACK/SIDE/LEFT/RIGHT/TOP cutouts into canonical voxel coordinates and measure landmarks + palette.

    Canonical conventions:
      - Standing orthographic views (`front`, `back`, `side`, `left`, `right`): shape `(grid_z, grid_xy, 4)`,
        where row `grid_z - 1 - z` corresponds to voxel slice `z` (`z=0` at bottom, `z=z_height` at crown).
      - Overhead view (`top`, optional `bottom`): shape `(grid_xy, grid_xy, 4)`, aligned to `(front_width, side_depth)`.
      - Use `grid_xy=112, grid_z=160, z_height=140` for tall humanoids, OR `grid_xy=128, grid_z=128, z_height=104`
        for wide/horizontal mascots, creatures, or suspended props!
    """
    aligned: dict[str, np.ndarray] = {}
    standing_keys = [k for k in ("front", "back", "side", "left", "right") if k in views_rgba]
    for k in standing_keys:
        aligned[k] = _resize_rgba_to_canvas(views_rgba[k], grid_xy, grid_z, target_h=z_height, anchor="bottom")

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

    z_crown = int(np.where(has_x)[0].max()) if has_x.any() else z_height
    z_soles = int(np.where(has_x)[0].min()) if has_x.any() else 0
    span = max(1, z_crown - z_soles)
    n_lo = z_soles + int(span * 0.48)
    n_hi = z_soles + int(span * 0.84)
    z_neck = int(n_lo + np.argmin(np.where(wx[n_lo:n_hi] > 1, wx[n_lo:n_hi], 9999))) if n_hi > n_lo else int(z_soles + span * 0.68)
    head_slice = wx[z_neck : z_crown + 1]
    z_head_mid = int(z_neck + np.argmax(head_slice)) if len(head_slice) else int(z_soles + span * 0.82)
    sh_lo = max(z_soles, z_neck - int(span * 0.20))
    z_shoulders = int(sh_lo + np.argmax(wx[sh_lo : max(sh_lo + 1, z_neck)]))

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

    palette = sample_clean_palette(ref_front, n_colors=6) if ref_front is not None else []

    if qa_out_path:
        _save_alignment_qa(aligned, landmarks, grid_xy, grid_z, qa_out_path)

    return {
        "aligned": aligned,
        "width_x": wx,
        "depth_y": dy,
        "center_x": cx,
        "center_y": cy,
        "landmarks": landmarks,
        "palette": palette,
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
    """[DEPRECATED FOR PRODUCTION CHARACTERS — DEBUG SILHOUETTE REFERENCE ONLY!]

    Visual hulls intersect silhouettes into boxy extruded blocks and cannot model concavities,
    layered hair, open mouths, or animated limbs. Always sculpt production characters purely
    with bone-driven GPU SDFs (`toolkit/gpu_sdf.py`) validated via `render_multiview_fit_qa`.
    """
    warnings.warn(
        "reconstruct_visual_hull() is debug-only and produces boxy artifacts. "
        "Sculpt production 3D models with pure GPU SDFs (toolkit/gpu_sdf.py) guided by blueprint landmarks instead.",
        UserWarning,
        stacklevel=2,
    )
    aligned = blueprint["aligned"]
    gw = int(blueprint["grid_xy"])
    gh = int(blueprint["grid_z"])

    occ = np.ones((gw, gw, gh), dtype=bool)
    if "front" in aligned:
        m = (aligned["front"][:, :, 3] > 128)[::-1, :].T
        occ &= m[None, :, :]
    if "back" in aligned:
        m_back = (aligned["back"][:, :, 3] > 128)[::-1, :]
        if flip_back_x:
            m_back = m_back[:, ::-1]
        occ &= m_back.T[None, :, :]
    side_img = aligned.get("side", aligned.get("left", aligned.get("right")))
    if side_img is not None:
        m_side = (side_img[:, :, 3] > 128)[::-1, :]
        if not side_faces_right:
            m_side = m_side[:, ::-1]
        occ &= m_side.T[:, None, :]
    if "top" in aligned:
        m_top = aligned["top"][:, :, 3] > 128
        occ &= m_top[:, :, None]

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
    """[DEPRECATED ANTI-PATTERN — DO NOT USE FOR PRODUCTION 3D CHARACTERS!]

    Projecting generated 2D turnaround sheets onto 3D voxels bakes muddy 2D black lineart,
    flat lighting, and seam smears into slices. Instead, use `sample_clean_palette()` +
    procedural 3-step normal cel shading (`gpu_sdf.shade_cel_3step`) on pure GPU SDF geometry!
    """
    warnings.warn(
        "project_6view_colors() is deprecated: pasting 2D turnaround sheets onto 3D voxels bakes muddy 2D lineart "
        "and ruins 360° quality. Use pure GPU SDF sculpting + procedural 3-step cel shading (`shade_cel_3step`) instead!",
        UserWarning,
        stacklevel=2,
    )
    aligned = blueprint["aligned"]
    gy, gx, gz = occ.shape

    f_occ = occ.astype(np.float32)
    ny = np.zeros_like(f_occ)
    nx = np.zeros_like(f_occ)
    nz = np.zeros_like(f_occ)
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
    add_view("front", xs, z_row, vy)
    add_view("back", (gx - 1 - xs) if flip_back_x else xs, z_row, -vy)
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
    add_view("top", xs, ys, vz)
    add_view("bottom", xs, gy - 1 - ys, -vz)

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
    return vol


def render_multiview_fit_qa(
    vol_rgba: np.ndarray,
    blueprint: dict[str, Any],
    out_path: str,
    flip_back_x: bool = True,
    side_faces_right: bool = True,
    input_order: str = "auto",
) -> dict[str, float]:
    """Compare a sculpted 3D SDF voxel volume against aligned orthographic blueprint views and save a QA sheet.

    Supports both `gpu_sdf.make_grid` layout `(Z, Y, X, 4)` (`input_order="zyx"` or `"auto"`)
    and `(Y, X, Z, 4)` (`input_order="yxz"`).

    Camera view mapping for standing keys:
      - `front`: looks from +Y toward -Y
      - `back`:  looks from -Y toward +Y (mirrored X when `flip_back_x=True`)
      - `right` / `side`: looks from +X toward -X
      - `left`:  looks from -X toward +X (ideal for head-on view of horizontal subjects facing -X!)
      - `top`:   looks from +Z downward
    """
    aligned = blueprint["aligned"]
    bp_xy = int(blueprint["grid_xy"])
    bp_z = int(blueprint["grid_z"])

    if input_order == "zyx":
        vol_yxz = np.transpose(vol_rgba, (1, 2, 0, 3))
    elif input_order == "yxz":
        vol_yxz = vol_rgba
    else:
        # Auto-detect (Z, Y, X, 4) vs (Y, X, Z, 4) whenever grid_z != grid_xy
        if vol_rgba.shape[0] == bp_z and vol_rgba.shape[2] == bp_xy and bp_z != bp_xy:
            vol_yxz = np.transpose(vol_rgba, (1, 2, 0, 3))
        else:
            vol_yxz = vol_rgba

    gy, gx, gz, _ = vol_yxz.shape

    def ortho_render(axis: str) -> np.ndarray:
        if axis == "front":
            img = np.zeros((gz, gx, 4), dtype=np.uint8)
            for y in range(gy):
                sl = vol_yxz[y, :, :, :]
                sl_t = np.transpose(sl, (1, 0, 2))[::-1, :, :]
                m = sl_t[:, :, 3] > 128
                img[m] = sl_t[m]
            return img
        if axis == "back":
            img = np.zeros((gz, gx, 4), dtype=np.uint8)
            for y in range(gy - 1, -1, -1):
                sl = vol_yxz[y, :, :, :]
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
                sl = vol_yxz[:, x, :, :]
                sl_t = np.transpose(sl, (1, 0, 2))[::-1, :, :]
                if not side_faces_right:
                    sl_t = sl_t[:, ::-1, :]
                m = sl_t[:, :, 3] > 128
                img[m] = sl_t[m]
            return img
        img = np.zeros((gy, gx, 4), dtype=np.uint8)
        for z in range(gz):
            sl = vol_yxz[:, :, z, :]
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
