"""One-Command Generic `.ap3d` / Standalone `.html` -> Animated Full-3D WebGL HTML & `.glb` Converter.

Converts ANY `.ap3d` package OR standalone `anime-pseudo-3d` HTML viewer into a hardware-Z-buffered,
60-FPS Full-3D polygon mesh viewer (reusing `engine/anime_ui_theme.css` + `engine/anime_ui_kit.js` UNMODIFIED!)
with optional multi-motion keyframe animation (`--frames-per-motion 6` / `8`), animated 3D companions,
all 6 declarative 3D depth-sorted FX types, live in-browser `.GLB` / `.GLB+PET` / `.PNG` export,
and a standalone binary glTF 2.0 (`.glb`) 3D model for Blender / Unity!

Usage:
  # Ultra-lightweight 1-mesh turntable (stride=1 full detail):
  python3 toolkit/ap3d_to_full3d.py --in dist/char.ap3d --out-html dist/char-full3d.html --out-glb dist/char.glb

  # Multi-motion animated Full-3D directly from a standalone HTML (e.g. deepseek-chan-3d):
  python3 toolkit/ap3d_to_full3d.py \\
    --in /path/to/index.html \\
    --frames-per-motion 8 --stride 2 \\
    --out-html dist/char-full3d.html --out-glb dist/char.glb
"""
import argparse
import base64
from concurrent.futures import ProcessPoolExecutor
import io
import json
import os
import re
import sys
import time
import numpy as np
from PIL import Image
from scipy import ndimage

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from toolkit.ap3d_format import decode_ap3d_bytes
from toolkit.full3d_mesh_kit import (
    extract_surface_nets,
    compute_vertex_normals,
    pack_full3d_payload,
    export_glb,
)


def decode_atlas_to_volume(raw_bytes: bytes, slice_w: int, slice_h: int, slice_count: int, cols: int) -> np.ndarray:
    """Unpack a tiled WebP/PNG sprite-stacking atlas back into `(H=slice_count, L=slice_h, W=slice_w, 4)` RGBA."""
    im = Image.open(io.BytesIO(raw_bytes)).convert("RGBA")
    arr = np.asarray(im)
    vol = np.zeros((slice_count, slice_h, slice_w, 4), dtype=np.uint8)
    for z in range(slice_count):
        r, c = z // cols, z % cols
        y0, x0 = r * slice_h, c * slice_w
        if y0 + slice_h <= arr.shape[0] and x0 + slice_w <= arr.shape[1]:
            vol[z] = arr[y0 : y0 + slice_h, x0 : x0 + slice_w]
    return vol


def volume_to_smooth_mesh(vol_rgba: np.ndarray, stride: int = 2, smooth_iters: int = 2, y_offset: float = 0.0):
    """Convert a `(H, L, W, 4)` RGBA voxel volume into a smooth Surface-Nets 3D mesh with exact surface colors."""
    H, L, W, _ = vol_rgba.shape
    occ = vol_rgba[:, :, :, 3] > 128

    # Pad 1 voxel on all 6 sides so meshes touching Z=0 close cleanly as watertight solids!
    occ_p = np.pad(occ, 1, mode="constant", constant_values=False)
    d_out = ndimage.distance_transform_edt(~occ_p).astype(np.float32)
    d_in = ndimage.distance_transform_edt(occ_p).astype(np.float32)
    sdf_full = (d_out - d_in)[1:-1, 1:-1, 1:-1]

    sdf_sub = sdf_full[::stride, ::stride, ::stride]
    xs = (np.arange(0, W, stride, dtype=np.float32) - (W - 1) * 0.5)
    ys = (np.arange(0, L, stride, dtype=np.float32) - (L - 1) * 0.5 - y_offset)
    zs = (np.arange(0, H, stride, dtype=np.float32) + 0.5)

    verts, tris = extract_surface_nets(sdf_sub, xs, ys, zs, smooth_iters=smooth_iters)
    norms = compute_vertex_normals(verts, tris)

    # Sample crisp vertex colors from nearest OCCUPIED voxel (zero transparent/black edge bleed!)
    _, nearest_idx = ndimage.distance_transform_edt(~occ, return_indices=True)
    vx = np.clip(np.round(verts[:, 0] + (W - 1) * 0.5).astype(np.int32), 0, W - 1)
    vy = np.clip(np.round(verts[:, 1] + (L - 1) * 0.5 + y_offset).astype(np.int32), 0, L - 1)
    vz = np.clip(np.round(verts[:, 2] - 0.5).astype(np.int32), 0, H - 1)
    nz_i = nearest_idx[0, vz, vy, vx]
    ny_i = nearest_idx[1, vz, vy, vx]
    nx_i = nearest_idx[2, vz, vy, vx]

    cols = np.zeros((len(verts), 4), dtype=np.uint8)
    cols[:, :3] = vol_rgba[nz_i, ny_i, nx_i, :3]
    cols[:, 3] = 0
    rigs = np.zeros((len(verts), 4), dtype=np.uint8)
    return verts, norms, cols, rigs, tris


def _extract_worker(job):
    mesh_key, raw_bytes, sw, sh, sc, cols, stride, smooth_iters, y_offset = job
    vol = decode_atlas_to_volume(raw_bytes, sw, sh, sc, cols)
    mesh = volume_to_smooth_mesh(vol, stride=stride, smooth_iters=smooth_iters, y_offset=y_offset)
    zs_occ = np.where(vol[:, :, :, 3] > 128)[0]
    z_info = (int(zs_occ.min()), int(zs_occ.max())) if len(zs_occ) else (0, sc)
    return mesh_key, mesh, z_info


def load_source_package(in_path: str) -> tuple[dict, dict[str, tuple[str, bytes]]]:
    """Load `SCENE_CONFIG` and binary assets from EITHER `.ap3d` OR standalone `.html`."""
    ext = os.path.splitext(in_path)[1].lower()
    if ext in (".html", ".htm"):
        with open(in_path, "r", encoding="utf-8") as f:
            html_text = f.read()
        m_cfg = re.search(r"window\.SCENE_CONFIG\s*=\s*(\{.*?\});", html_text, re.S)
        m_ast = re.search(r"window\.SPRITE_ASSETS\s*=\s*(\{.*?\});", html_text, re.S)
        if not m_cfg or not m_ast:
            raise ValueError(f"Could not locate window.SCENE_CONFIG / window.SPRITE_ASSETS in {in_path}")
        cfg = json.loads(m_cfg.group(1))
        raw_assets = json.loads(m_ast.group(1))
        bin_assets = {}
        for k, uri in raw_assets.items():
            if isinstance(uri, str) and uri.startswith("data:") and ";base64," in uri:
                head, b64 = uri.split(";base64,", 1)
                mime = head[5:] or "application/octet-stream"
                bin_assets[k] = (mime, base64.b64decode(b64))
        return cfg, bin_assets

    with open(in_path, "rb") as f:
        return decode_ap3d_bytes(f.read())


def convert_ap3d_to_full3d(
    ap3d_path: str,
    out_html: str,
    out_glb: str | None = None,
    motion_id: str | None = None,
    frame_idx: int = 0,
    stride: int = 2,
    smooth_iters: int = 2,
    frames_per_motion: int = 1,
    comp_frames: int = 0,
    compact: bool | None = None,
):
    t0 = time.time()
    cfg, bin_assets = load_source_package(ap3d_path)

    char = cfg.get("character", {})
    motions = cfg.get("motions", [])
    if not motions:
        raise ValueError("No motions found in input package")

    sw, sh, sc, acols = int(char["sliceW"]), int(char["sliceH"]), int(char["sliceCount"]), int(char["atlasCols"])
    y_off = float(char.get("yOffset", 0.0))

    # Build extraction job list
    jobs = []
    out_motions = []
    strip_prefixes = set()

    if frames_per_motion <= 1 and motion_id is not None:
        target_m = next((m for m in motions if m["id"] == motion_id), motions[0])
        key = f"{target_m['keyPrefix']}{frame_idx:02d}"
        if key not in bin_assets:
            raise KeyError(f"Frame asset '{key}' not found in package")
        jobs.append(("main", bin_assets[key][1], sw, sh, sc, acols, stride, smooth_iters, y_off))
        for m in motions:
            strip_prefixes.add(m["keyPrefix"])
            m_entry = {k: v for k, v in m.items() if k != "keyPrefix"}
            m_entry["frames"] = int(m.get("frames", 24))
            m_entry["meshKey"] = "main"
            m_entry["bobAmp"] = 2.4
            m_entry["yawAmp"] = 0.08
            out_motions.append(m_entry)
    elif frames_per_motion <= 1:
        # Default single-mesh turntable from default motion
        target_id = cfg.get("defaults", {}).get("motion") or motions[0]["id"]
        target_m = next((m for m in motions if m["id"] == target_id), motions[0])
        key = f"{target_m['keyPrefix']}{frame_idx:02d}"
        if key not in bin_assets:
            raise KeyError(f"Frame asset '{key}' not found in package")
        jobs.append(("main", bin_assets[key][1], sw, sh, sc, acols, stride, smooth_iters, y_off))
        for m in motions:
            strip_prefixes.add(m["keyPrefix"])
            m_entry = {k: v for k, v in m.items() if k != "keyPrefix"}
            m_entry["frames"] = int(m.get("frames", 24))
            m_entry["meshKey"] = "main"
            m_entry["bobAmp"] = 2.4
            m_entry["yawAmp"] = 0.08
            out_motions.append(m_entry)
    else:
        # Multi-motion animated Full-3D: extract N evenly-spaced keyframes for EVERY motion!
        for m in motions:
            kp = m["keyPrefix"]
            strip_prefixes.add(kp)
            fc = max(1, int(m.get("frames", 24)))
            n_kf = min(fc, frames_per_motion)
            kf_indices = sorted({int(round(i * fc / n_kf)) % fc for i in range(n_kf)})
            frame_keys = []
            for fi in kf_indices:
                akey = f"{kp}{fi:02d}"
                if akey not in bin_assets:
                    continue
                mkey = f"m_{m['id']}_{fi:02d}"
                jobs.append((mkey, bin_assets[akey][1], sw, sh, sc, acols, stride, smooth_iters, y_off))
                frame_keys.append(mkey)
            if not frame_keys:
                raise KeyError(f"No frames found for motion '{m['id']}' with prefix '{kp}'")
            m_entry = {k: v for k, v in m.items() if k != "keyPrefix"}
            m_entry["frames"] = fc
            m_entry["meshKey"] = frame_keys[0]
            m_entry["meshFrames"] = frame_keys
            m_entry["bobAmp"] = 0.0
            m_entry["yawAmp"] = 0.0
            out_motions.append(m_entry)

    # Extract 3D companions (animated if comp_frames > 1 or multi-motion mode!)
    eff_comp_frames = comp_frames if comp_frames > 0 else (4 if frames_per_motion > 1 else 1)
    companion_frames_meta = {}
    comp_center_z = 24.0
    for cid, cdef in (cfg.get("companions") or {}).items():
        ckp = cdef["keyPrefix"]
        strip_prefixes.add(ckp)
        cfc = max(1, int(cdef.get("frames", 24)))
        c_stride = 1 if max(int(cdef["sliceW"]), int(cdef["sliceH"]), int(cdef["sliceCount"])) <= 64 else 2
        n_ckf = min(cfc, eff_comp_frames)
        ckf_indices = sorted({int(round(i * cfc / n_ckf)) % cfc for i in range(n_ckf)})
        ckeys = []
        for fi in ckf_indices:
            akey = f"{ckp}{fi:02d}"
            if akey not in bin_assets:
                continue
            mkey = f"comp_{cid}" if len(ckf_indices) == 1 else f"comp_{cid}_{fi:02d}"
            jobs.append((mkey, bin_assets[akey][1], int(cdef["sliceW"]), int(cdef["sliceH"]), int(cdef["sliceCount"]), int(cdef["atlasCols"]), c_stride, 2, 0.0))
            ckeys.append(mkey)
        if ckeys:
            companion_frames_meta[cid] = ckeys
            comp_center_z = float(cdef["sliceCount"]) * 0.45

    print(f"Extracting {len(jobs)} 3D Surface-Nets meshes (stride={stride}, smooth={smooth_iters})...")
    meshes_map = {}
    z_min_all, z_max_all = sc, 0
    if len(jobs) >= 4:
        max_w = min(len(jobs), max(2, (os.cpu_count() or 4) // 2))
        with ProcessPoolExecutor(max_workers=max_w) as ex:
            for mkey, mesh, (z0, z1) in ex.map(_extract_worker, jobs):
                meshes_map[mkey] = mesh
                if not mkey.startswith("comp_"):
                    z_min_all = min(z_min_all, z0)
                    z_max_all = max(z_max_all, z1)
    else:
        for job in jobs:
            mkey, mesh, (z0, z1) = _extract_worker(job)
            meshes_map[mkey] = mesh
            if not mkey.startswith("comp_"):
                z_min_all = min(z_min_all, z0)
                z_max_all = max(z_max_all, z1)

    # Pick primary hero mesh for GLB export & fallback "main" alias
    hero_key = out_motions[0]["meshKey"] if "main" not in meshes_map else "main"
    mv, mn, mc, mr, mt = meshes_map[hero_key]
    print(f"Extracted {len(meshes_map)} meshes (hero '{hero_key}': {len(mv):,} verts, {len(mt):,} tris) in {time.time() - t0:.2f}s")

    if out_glb:
        export_glb(mv, mc, mt, out_glb)
        print(f"Exported GLB -> {out_glb} ({os.path.getsize(out_glb) / 1024.0:.1f} KB)")

    use_compact = (len(meshes_map) > 2) if compact is None else compact
    payload = pack_full3d_payload(meshes_map, pos_scale=0.01, compact=use_compact)
    print(
        f"Packed Full-3D binary ({'compact9d' if use_compact else 'full17'}): "
        f"{payload['rawBytes']/1024:.1f} KB raw -> {payload['gzipBytes']/1024:.1f} KB gzip"
    )

    # Strip ALL motion & companion slice atlases dynamically, keeping ONLY UI icons, FX, billboards & stage sprites!
    strip_tuple = tuple(strip_prefixes)
    ui_assets = {}
    for k, (mime, raw) in bin_assets.items():
        if strip_tuple and k.startswith(strip_tuple):
            continue
        ui_assets[k] = f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"

    z_mid = float(0.5 * (z_min_all + z_max_all)) if z_max_all > z_min_all else float(sc * 0.5)
    z_span = float(z_max_all - z_min_all) if z_max_all > z_min_all else float(sc)
    half_h = max(68.0, max(z_span, sw) * 0.78)

    scene_cfg = {
        "schema_version": "1.1",
        "title": (cfg.get("title") or "ANIME FULL-3D") + " [FULL 3D]",
        "subtitle": (
            f"ANIMATED FULL-3D MESH ({len(out_motions)} MOTIONS x {frames_per_motion}KF / 60FPS)"
            if frames_per_motion > 1
            else "CONVERTED TO REAL 3D WEBGL MESH (60FPS)"
        ),
        "badge_icon": cfg.get("badge_icon", "ico_brand"),
        "defaults": cfg.get("defaults", {}),
        "motions": out_motions,
        "assetLinear": cfg.get("assetLinear", {}),
        "full3d": {
            "centerZ": round(z_mid, 1),
            "halfHeight": round(half_h, 1),
            "faceFocusZ": round(float(char.get("faceFocusZ", z_mid * 1.15)), 1),
            "preLit": True,
            "camFlipY": False,
            "companionCenterZ": round(comp_center_z, 1),
            "companionFrames": companion_frames_meta,
        },
    }

    with open(os.path.join(REPO_ROOT, "engine", "anime_ui_theme.css"), "r", encoding="utf-8") as f:
        css_code = f.read()
    with open(os.path.join(REPO_ROOT, "engine", "anime_ui_kit.js"), "r", encoding="utf-8") as f:
        uikit_code = f.read()
    with open(os.path.join(REPO_ROOT, "engine", "full3d_mesh_engine.js"), "r", encoding="utf-8") as f:
        eng_code = f.read()

    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
<title>{scene_cfg["title"]}</title>
<style>
{css_code}
</style>
</head>
<body>
<div id="appRoot"></div>
<script>
window.SCENE_CONFIG = {json.dumps(scene_cfg, separators=(",", ":"))};
window.SPRITE_ASSETS = {json.dumps(ui_assets, separators=(",", ":"))};
window.FULL3D_MESH_DATA = {json.dumps(payload, separators=(",", ":"))};
</script>
<script>
{uikit_code}
</script>
<script>
{eng_code}
</script>
</body>
</html>
"""
    os.makedirs(os.path.dirname(os.path.abspath(out_html)), exist_ok=True)
    with open(out_html, "w", encoding="utf-8") as f:
        f.write(html)
    in_kb = os.path.getsize(ap3d_path) / 1024.0
    out_kb = os.path.getsize(out_html) / 1024.0
    print(f"Bundled Full-3D HTML -> {out_html} ({out_kb:.1f} KB vs input {in_kb:.1f} KB — {in_kb / max(out_kb, 1.0):.2f}x smaller!)")


def main():
    ap = argparse.ArgumentParser(description="Convert any .ap3d or standalone .html sprite-stack into an Animated Full-3D WebGL HTML + .glb.")
    ap.add_argument("--in", dest="in_ap3d", required=True, help="Input .ap3d OR standalone .html file")
    ap.add_argument("--out-html", required=True, help="Output standalone Full-3D HTML path")
    ap.add_argument("--out-glb", help="Optional output glTF 2.0 (.glb) 3D model path")
    ap.add_argument("--motion", help="Single motion ID to extract (when --frames-per-motion 1)")
    ap.add_argument("--frame", type=int, default=0, help="Frame index to extract (when --frames-per-motion 1)")
    ap.add_argument("--frames-per-motion", type=int, default=1, help="Keyframes per motion (1=turntable, 6-8=full multi-motion 3D animation!)")
    ap.add_argument("--comp-frames", type=int, default=0, help="Animated companion keyframes (0=auto: 4 when animated, 1 when turntable)")
    ap.add_argument("--stride", type=int, default=2, help="Surface Nets voxel stride (1=ultra-hi, 2=balanced lightweight)")
    ap.add_argument("--smooth", type=int, default=2, help="Taubin smoothing iterations (default: 2)")
    args = ap.parse_args()
    convert_ap3d_to_full3d(
        ap3d_path=args.in_ap3d,
        out_html=args.out_html,
        out_glb=args.out_glb,
        motion_id=args.motion,
        frame_idx=args.frame,
        stride=args.stride,
        smooth_iters=args.smooth,
        frames_per_motion=args.frames_per_motion,
        comp_frames=args.comp_frames,
    )


if __name__ == "__main__":
    main()
