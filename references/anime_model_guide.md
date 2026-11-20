# Anime Model & Original-Artwork Facial Projection Guide

This reference documents best practices for sculpting high-resolution anime-style chibi characters for WebGL sprite stacking.

## 1. Canonical High-Resolution Grid & Coordinate Convention
- **Recommended Grid**: `W = 100, L = 112, H = 160` (`16×10` tiled atlas = `1600×1120 px`, lossless WebP ~40–55 KB/frame).
- **Axes**:
  - `+Y` = Character forward (face, chest, apron, toes)
  - `-Y` = Character back (long hair cape, back waist ribbon, tail)
  - `+X` = Character's **LEFT** (viewer's right in FRONT view)
  - `-X` = Character's **RIGHT** (viewer's left in FRONT view)
  - `+Z` = Upward (`Z = 0.5 .. 159.5`)
- **Offsetting Y (`y_offset`)**: Characters with voluminous back hair or long tails benefit from shifting `Y` back slightly (e.g., `y_offset = 5.2` so `Y ∈ [-60.7, +50.3]`) to leave generous rear headroom without clipping.

## 2. Layered Anime Hair & Bangs
- Sculpt the head cranium/cheeks as a clean base ellipsoid first (`d_head`).
- Carve out the facial opening cleanly from the hair dome (`cp.maximum(d_hair_dome, -d_face_open)`), then layer individual sculpted bang strands (`sd_chain`) over the forehead and cheeks so bangs cast genuine 3D parallax when rotated 360°.
- Keep asymmetric details explicit: never use `x_mirror=True` on asymmetric ribbons, hair clips, or ahoge curls!

## 3. Original-Artwork Tilted Facial Projection (`14.5°`)
- Standard vertical cylindrical projection foreshortens anime eyes at isometric/semi-top-down camera squash.
- Projecting the extracted 2D face texture onto the moving head bone with **`project_tilted_face(..., tilt_deg=14.5)`** keeps anime eyes crisp and readable from `SQUASH = 0.35` (eye-level) all the way up to `SQUASH = 0.70`.
- **Head-bone locking**: Always transform query coordinates into Head-local space `(HX, HY, HZ)` via `rot_inv_xyz` *before* evaluating `project_tilted_face`, and restrict projection strictly to the head surface (`d_head <= 0.0` & `d_hands > 0.2`) so foreground gestures (like waving or finger-to-lips poses) never receive facial pixels!

## 4. Warm-Skin Anti-Halo Rule (Critical!)
- When synthesizing closed/blinking/deadpan expressions by painting skin over open eyes, **never** boost bright pixels solely by luminance (`lum > 228`), because warm peach skin `(254, 234, 227)` has `lum ≈ 239` and will glow bright white over painted eyelids!
- Always restrict highlight boosts to **cool whites** (`b >= r - 6`), as implemented in `toolkit/anime_face_kit.py::finalize_face_texture`.

## 5. Never Bake Outlines Into Slices
- Baking black outlines into individual slices creates muddy internal bands and shimmer when slices stack.
- Output clean cel-shaded voxel slices with transparent alpha `0`, and let Pass 2 of `engine/anime_stack_engine.js` draw uniform anti-aliased or stepped silhouette outlines around the final composite!
