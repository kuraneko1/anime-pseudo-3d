"""Minimal Character-Agnostic End-to-End Demo for `anime-pseudo-3d`.

Demonstrates how a completely new character (a cute aqua spirit chibi + orbiting 3D star companion)
connects to the reusable `toolkit/` + `engine/` pipeline via `motion_pack.json` WITHOUT touching
a single line of `engine/anime_stack_engine.js` or `engine/viewer_shell.html`!
"""
import json
import math
import os
import sys
import time

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, REPO_ROOT)
sys.path.insert(0, os.path.join(REPO_ROOT, "engine"))

from toolkit.gpu_sdf import (
    xp, USE_GPU, to_numpy, make_grid,
    smin, sd_sphere, sd_ellipsoid, sd_capsule,
    compute_normals, shade_cel_3step,
)
from toolkit.rig_contracts import PoseFrame, volume_preserving_sx, smoothstep
from toolkit.pixel_fx_kit import generate_standard_fx_and_ui_pack, add_pixel_outline, draw_pattern, save_rgba
from toolkit.qa_validator import validate_motion_poses, assert_no_border_clipping, save_tiled_webp
from bundle_standalone import bundle_standalone


def evaluate_demo_pose(motion_id: str, f: int, total: int = 24) -> PoseFrame:
    ph = (f / float(total)) * math.tau
    s, c = math.sin(ph), math.cos(ph)
    if motion_id == "bounce":
        hop = (0.5 + 0.5 * s) ** 1.2
        return PoseFrame(
            motion_id=motion_id, frame_idx=f, total_frames=total,
            root_bob=4.5 * hop, stretch_y=1.0 - 0.06 * s, squash_z=1.0 + 0.06 * s,
            head_roll=4.5 * c, ear_flap_l=3.0 * math.sin(ph - 0.8), ear_flap_r=3.0 * math.sin(ph - 0.8),
        )
    # "splash" attack motion
    u = f / float(total)
    w_atk = math.sin(max(0.0, min(1.0, (f - 4.0) / 12.0)) * math.pi)
    return PoseFrame(
        motion_id=motion_id, frame_idx=f, total_frames=total,
        root_bob=3.0 * w_atk,
        stretch_y=1.0 + 0.08 * w_atk,
        squash_z=1.0 - 0.05 * w_atk,
        torso_pitch=5.0 * w_atk,
        head_pitch=-5.0 * w_atk,
        ear_flap_l=4.5 * w_atk,
        ear_flap_r=4.5 * w_atk,
    )


def sculpt_spirit_frame(X, Y, Z, pose: PoseFrame):
    sx, sy, sz = pose.sx, pose.stretch_y, pose.squash_z
    rb = pose.root_bob
    PX = X / sx
    PY = Y / sy
    PZ = (Z - rb) / sz

    # Cute round aqua spirit chibi body + head crest + floppy bunny-fin ears + rosy cheeks + big anime eyes!
    d_body = sd_ellipsoid(PX, PY, PZ, 0.0, 0.0, 22.0, 16.5, 15.5, 18.0)
    d_ear = sd_capsule(xp.abs(PX), PY, PZ, 12.0, -2.0, 32.0, 22.5, -5.0, 37.0 + pose.ear_flap_l, 4.2, 2.2)
    d_ahoge = sd_capsule(PX, PY, PZ, 0.0, 0.0, 39.0, -6.0, 4.0, 46.0 + pose.ear_flap_l * 0.4, 2.2, 1.0)
    d_all = smin(smin(d_body, d_ear, 2.2), d_ahoge, 1.4)
    occ = (d_all <= 0.0) & (Z >= 0.45)

    nx, ny, nz = compute_normals(d_all)
    col_aqua = shade_cel_3step([86, 178, 250], [162, 228, 255], [52, 126, 214], [32, 82, 168], nx, ny, nz)
    col_belly = shade_cel_3step([244, 250, 255], [255, 255, 255], [210, 224, 246], [176, 196, 228], nx, ny, nz)

    colors = col_aqua.copy()
    is_belly = occ & (PY > 3.5) & (PZ < 20.5) & (xp.abs(PX) < 11.5)
    colors[is_belly] = col_belly[is_belly]

    # Simple cute anime eyes + rosy blush + smile directly on front shell
    surf = occ & (d_all >= -2.5) & (PY > 8.0)
    for cx in (-6.0, 6.0):
        eye_bg = surf & (((PX - cx) / 3.2) ** 2 + ((PZ - 24.5) / 3.8) ** 2 <= 1.0)
        eye_hi = surf & (((PX - (cx - 0.9)) / 1.1) ** 2 + ((PZ - 26.2) / 1.1) ** 2 <= 1.0)
        blush = surf & (((PX - cx * 1.45) / 2.4) ** 2 + ((PZ - 19.8) / 1.4) ** 2 <= 1.0)
        colors[eye_bg] = xp.asarray([28, 36, 86], dtype=xp.uint8)
        colors[eye_hi] = xp.asarray([255, 255, 255], dtype=xp.uint8)
        colors[blush] = xp.asarray([255, 152, 178], dtype=xp.uint8)
    mouth = surf & ((PX / 2.2) ** 2 + ((PZ - 19.5) / 1.6) ** 2 <= 1.0)
    colors[mouth] = xp.asarray([238, 118, 140], dtype=xp.uint8)

    vol = xp.zeros((*occ.shape, 4), dtype=xp.uint8)
    vol[occ, :3] = colors[occ]
    vol[occ, 3] = 255
    return to_numpy(vol)


def sculpt_star_companion(f: int, total: int = 24):
    X, Y, Z = make_grid(32, 32, 32)
    ph = (f / float(total)) * math.tau
    bob = 1.6 * math.sin(ph)
    cz = 16.0 + bob
    d0 = sd_sphere(X, Y, Z, 0.0, 0.0, cz, 7.2)
    d1 = sd_ellipsoid(X, Y, Z, 0.0, 0.0, cz, 11.2, 4.2, 4.2)
    d2 = sd_ellipsoid(X, Y, Z, 0.0, 0.0, cz, 4.2, 11.2, 4.2)
    d3 = sd_ellipsoid(X, Y, Z, 0.0, 0.0, cz, 4.2, 4.2, 11.2)
    d_all = smin(smin(d0, d1, 1.4), smin(d2, d3, 1.4), 1.4)
    occ = d_all <= 0.0
    nx, ny, nz = compute_normals(d_all)
    col = shade_cel_3step([252, 214, 92], [255, 246, 178], [224, 166, 46], [176, 118, 28], nx, ny, nz)
    vol = xp.zeros((*occ.shape, 4), dtype=xp.uint8)
    vol[occ, :3] = col[occ]
    vol[occ, 3] = 255
    return to_numpy(vol)


def main():
    t0 = time.time()
    build_dir = os.path.join(os.path.dirname(__file__), "build")
    assets_dir = os.path.join(build_dir, "assets")
    os.makedirs(assets_dir, exist_ok=True)
    print(f"Building slime_chibi_demo (backend={'CuPy GPU' if USE_GPU else 'NumPy CPU'})...")

    X, Y, Z = make_grid(64, 64, 64)
    assets = generate_standard_fx_and_ui_pack(assets_dir)

    # Generate 2 motion icons
    pal = {"C": (118, 224, 255, 255), "W": (248, 253, 255, 255), "Y": (252, 214, 92, 255), "P": (255, 142, 178, 255)}
    for name, rows in [
        ("ico_bounce", ["................","......YY........",".....YYYY.......","....CCCCCCC.....","..CCWWWWWWWCC...","..CWWCWWWCWWC...","..CWWWWWWWWWC...","..CWWPWWWPWWC...","...CCWWWWWCC....",".....CCCCC......","................","................","................","................","................","................"]),
        ("ico_splash", ["................",".....CCCCC......","...CCWWWWWCC....","..CWWCCCCCWWC...",".CWC.......CWC..",".CC.........CC..","....CC...CC.....","...CWWC.CWWC....","....CC...CC.....","................","................","................","................","................","................","................"]),
    ]:
        save_rgba(add_pixel_outline(draw_pattern(rows, pal), (14, 18, 38, 255)), os.path.join(assets_dir, f"{name}.png"))
        assets[name] = {"file": f"assets/{name}.png"}

    # Bake 2 motions x 24 frames (64x64x64 -> 8x8 atlas)
    for m in ("bounce", "splash"):
        poses = [evaluate_demo_pose(m, f, 24) for f in range(24)]
        warns = validate_motion_poses(poses)
        if warns:
            print("  QA warnings:", warns)
        for p in poses:
            vol = sculpt_spirit_frame(X, Y, Z, p)
            assert_no_border_clipping(vol, label=f"{m}_{p.frame_idx}", check_bottom=False)
            rel = f"assets/anim_{m}_{p.frame_idx:02d}.webp"
            save_tiled_webp(vol, os.path.join(build_dir, rel), cols=8)
            assets[f"anim_{m}_{p.frame_idx:02d}"] = {"file": rel}

    # Bake 24-frame orbiting 3D star companion (32x32x32 -> 8x4 atlas)
    for f in range(24):
        vol = sculpt_star_companion(f, 24)
        assert_no_border_clipping(vol, label=f"star_{f}", check_bottom=True)
        rel = f"assets/star_{f:02d}.webp"
        save_tiled_webp(vol, os.path.join(build_dir, rel), cols=8)
        assets[f"star_{f:02d}"] = {"file": rel}

    pack = {
        "schema_version": "1.0",
        "title": "SLIME SPIRIT 3D DEMO",
        "subtitle": "ANIME PSEUDO-3D ENGINE DEMO (2x24FPS)",
        "badge_icon": "ico_brand",
        "defaults": {
            "motion": "bounce",
            "animFps": 24,
            "renderMode": 2,
            "dotSize": 1.35,
            "squash": 0.35,
            "spacing": 1.0,
            "zoom": 1.45,
            "themeIdx": 1,
            "angleDeg": 22.0,
        },
        "character": {
            "sliceW": 64, "sliceH": 64, "sliceCount": 64,
            "atlasCols": 8, "atlasRows": 8, "yOffset": 0.0,
            "fboVirtW": 140, "fboVirtH": 220, "fboPivotYOffset": 56, "faceFocusZ": 36.0,
        },
        "companions": {
            "mini_star": {
                "sliceW": 32, "sliceH": 32, "sliceCount": 32,
                "atlasCols": 8, "atlasRows": 4, "frames": 24,
                "keyPrefix": "star_", "fboVirtW": 72, "fboVirtH": 96,
                "scale": 0.85, "outlineRgb": [0.42, 0.28, 0.08],
            }
        },
        "motions": [
            {
                "id": "bounce",
                "label": "BOUNCE",
                "subtitle": "3D STAR PET",
                "category": "COMPANION",
                "accent": "companion",
                "icon": "ico_bounce",
                "frames": 24,
                "keyPrefix": "anim_bounce_",
                "impulse": [0.92, 1.10],
                "companion": {"id": "mini_star", "rx": 34, "ry": 28, "zBase": 32, "zSin1": -8, "zSin2": 5, "faceTangent": False},
                "fx": [
                    {"type": "orbit_trail", "count": 14, "rx": 34, "ry": 28, "zBase": 36, "zSin1": -8, "zSin2": 5, "primarySprite": "fxHeart", "secondarySprite": "fxBubble"},
                ],
            },
            {
                "id": "splash",
                "label": "SPLASH",
                "subtitle": "AQUA SLASH",
                "category": "ATTACK",
                "accent": "attack",
                "icon": "ico_splash",
                "frames": 24,
                "keyPrefix": "anim_splash_",
                "impulse": [0.88, 1.14],
                "springBeats": [{"frame": 6, "sx": 0.88, "sy": 1.14}],
                "fx": [
                    {"type": "forward_slash_fan", "startFrame": 5, "durationFrames": 14, "count": 48, "slashZ": 28, "originZ": 26, "slashW": 56, "slashH": 30},
                    {"type": "floor_wave_rings", "count": 1, "startFrame": 5.5, "durationFrames": 11, "forwardOffset": 14, "startScale": 0.45, "expandScale": 0.85},
                ],
            },
        ],
        "assets": assets,
    }

    pack_path = os.path.join(build_dir, "motion_pack.json")
    with open(pack_path, "w", encoding="utf-8") as f:
        json.dump(pack, f, indent=2)

    out_html = os.path.join(build_dir, "slime-chibi-standalone.html")
    out_ap3d = os.path.join(build_dir, "slime-chibi.ap3d")
    bundle_standalone(
        html_path=os.path.join(REPO_ROOT, "engine", "viewer_shell.html"),
        js_path=os.path.join(REPO_ROOT, "engine", "anime_stack_engine.js"),
        pack_path=pack_path,
        assets_root=build_dir,
        out_path=out_html,
        ap3d_out=out_ap3d,
    )
    print(f"Demo build complete in {time.time() - t0:.2f}s -> {out_html} & {out_ap3d}")


if __name__ == "__main__":
    main()
