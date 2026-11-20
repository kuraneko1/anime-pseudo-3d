# Pure GPU SDF Sculpting, Micro-Relief & Facial Projection Guide

This reference documents the canonical modeling principles that produce crisp, figurine-grade anime & mascot sprite-stacking volumes without blurry 2D texture-pasting artifacts.

---

## 1. Adaptive Canonical Voxel Grid & Coordinate Convention
Never force a wide/horizontal creature or hanging prop into a tall narrow humanoid box! Pick the grid that matches the subject's natural proportions with generous 10+ voxel animation margins:

| Subject Silhouette | Recommended Grid (`W × L × H`) | WebP Atlas (`cols × rows`) | `fboVirtW × fboVirtH` |
| :--- | :---: | :---: | :---: |
| **Tall Anime Humanoid / Chibi** | `100 × 112 × 160` | `16 × 10` (`1600×1120`) | `196 × 440` |
| **Horizontal / Wide / Mascot / Hanging Prop** | `128 × 128 × 128` | `16 × 8` (`2048×1024`) | `220 × 360` |
| **3D Orbiting Companion** | `64 × 64 × 64` or `32 × 32 × 32` | `8 × 8` or `8 × 4` | `120 × 168` or `72 × 96` |

- **Axes (`gpu_sdf.make_grid(W, L, H)`)**:
  - Volume array layout is **`(H, L, W, 4)` indexed `[z, y, x]`**. Use `vol_zyx_to_yxz(vol)` or `input_order="zyx"` when calling `render_multiview_fit_qa`.
  - `+Y` = Forward toward FRONT (`0°`) camera | `-Y` = Back | `+X` = Viewer's right in FRONT view | `-X` = Viewer's left in FRONT view | `+Z` = Upward (`0.5 .. H-0.5`).
- **Offsetting Y (`y_offset`)**: Characters with voluminous back hair or long tails benefit from shifting `Y` back slightly (e.g., `y_offset = 5.2`) for generous rear headroom.

---

## 2. Pure GPU SDF Geometry & Tactile 3D Micro-Relief (ZERO Body Texture Pasting!)
- **NEVER paste generated 2D turnaround sheets onto the 3D body, hair, or clothing** (`project_6view_colors` is deprecated for production models). Every voxel color must come from clean procedural materials shaded with **3-step normal cel shading (`shade_cel_3step`) + SDF ambient occlusion (`ao`)**.
- **Float32 GPU NaN Guard (CRITICAL!)**: On CuPy float32 GPU, `sin(1.0 * pi) = -8.74e-8`, so `xp.sin(t * pi) ** 0.56` evaluates to **`NaN`** and silently chops off half your model! Always use `toolkit.gpu_sdf.safe_sin_pow(t, exp)` or `safe_pow(base, exp)`.
- **Real 3D Cavities & Protruding Micro-Geometry**:
  - Carve open mouths, hooded interiors, and collars cleanly with smooth SDF subtraction: `smax(d_body, -d_cavity, k)`.
  - Sculpt real 3D teeth, knotted cords/straps (`sd_polyline`), ribbons, collars, gills, and layered hair locks (`sd_chain` / `sd_bone_chain`) instead of painting flat 2D lines onto a smooth blob!
  - Use **`sdf_indent_bulge(d_body, d_strap, cinch_depth, puff_amp)`** whenever tight ropes, belts, stockings, or straps wrap soft plush/cloth — real 3D indentation grooves + cushion bulges + rope-groove `ao` look breathtaking under 360° rotation!
- **Symmetric Detail Mirroring (`xp.abs(X)` or `xp.abs(Y)`)**: Mirror symmetric harnesses, ribs, or twin limbs in SDF space for guaranteed 360° symmetry and 2× faster GPU baking—but NEVER mirror asymmetric hair clips, ahoge, side ribbons, or single-eye bangs!

---

## 3. Cute Anime & Chibi Head / Faceline Sculpting (Anti-Underbite / Tucked-Chin Rule!)
A protruding chin ("しゃくれ / underbite") or harsh dark jaw shadow destroys anime & chibi cuteness at 3/4 (`22°–55°`) and side (`90°`) angles! Follow this exact 4-part faceline recipe:

- **ANTI-PATTERN (NEVER DO THIS!)**: Placing `d_cheeks` or `d_chin` ellipsoids forward (`HY > 0`, e.g. `HY = +1.8..+3.0`) ahead of the cranium. That pushes the lower jaw forward like a snout/underbite and leaves a thick vertical shelf beneath the mouth.
- **GROUND TRUTH — Use `toolkit.gpu_sdf.sd_anime_head(...)` (Tucked-Chin Mochi Faceline)**:
  1. **Cranium & soft mochi cheeks aligned rearward**: Keep `d_cheeks` centered nearly flush with the cranium (`cy_cheek ≈ cy_cranium + 0.025 * ry`) so the soft round cheeks widen gracefully on `±X` without bulging forward past the forehead/eyes.
  2. **Tucked-back lower jaw (`-Y`)**: Place the lower jaw ellipsoid **behind** the cranium (`cy_jaw = cy - 0.08 * ry`) so the chin tapers naturally inward toward the neck.
  3. **Tilted smooth-max chin bevel (`smax`)**: Softly shave the front-bottom chin corner backward toward the neck with a sloped bevel plane:
     ```python
     d_chin_bevel = (Y - (cy + 0.86 * ry)) * 0.68 + ((cz - 0.82 * rz) - Z) * 0.73
     d_head = smax(d_head, d_chin_bevel, k=0.20 * rz)
     ```
     This eliminates any underbite shelf across `0°`, `22°`, `45°`, `68°`, and `90°` side views!
  4. **Luminous anime skin shading & tight mouth-to-chin spacing**:
     - Use bright, soft peach skin shadows (e.g., `sh=[244, 218, 222]`, `deep=[230, 198, 206]`) and mild face AO (`ao * 0.22..0.25`) so downward-curving chin normals (`nz < -0.35`) never cast a muddy dark "beard shadow" under the mouth!
     - Keep the mouth nestled close to the tucked chin (~2.5–3.5 voxels above the chin bottom in chibi proportions) rather than leaving an overly tall blank lower jaw.
- **Mandatory 5-Angle Close-Up Head Profile Check (Visual Gate 3)**: Before baking animations on any anime/chibi humanoid, render a zoomed `3×` head-only contact sheet across `(0°, 22°, 45°, 68°, 90°)` and inspect with `read_file` to verify zero chin protrusion and clean mochi cheek curvature!

---

## 4. Layered Anime Hair & Bangs
- Sculpt the head cranium/cheeks with `sd_anime_head(...)` first (`d_head`).
- Carve out the facial opening cleanly from the hair dome (`smax(d_hair_dome, -d_face_open, k)`), then layer individual sculpted bang strands (`sd_chain`) physically in front of the forehead and cheeks so bangs cast genuine 3D parallax when rotated 360°.

---

## 5. Crisp Facial Features & Expressions (Two Clean Strategies)

### Strategy A: 100% Pure 3D SDF Expressions (Recommended for Mascots, Plushies, Creatures & Bold Chibis)
- Sculpt glossy button eyes, shock sclera/pupils, animated rotating dizzy spirals, fierce angled brows, cute `> <` squished chevrons, curved blink eyelids, rosy blush, and 3D carved toothed mouths directly on the moving head/body SDF shell (`surf = occ & (d_solid >= -2.2)`).
- Stays 100% razor-sharp at ALL rotation angles and close-up zooms with zero smudging or halo risk!

### Strategy B: Hair-Free Isolated Tilted Face Projection (For Intricate Anime Humanoids)
- Standard vertical cylindrical projection foreshortens anime eyes at semi-top-down camera pitch. Project onto the moving head bone with **`project_tilted_face(..., tilt_deg=6.5..14.5)`**.
- **Strict Isolation Rule**: Copy **ONLY** the eyes, lashes, brows, and mouth onto a **100% uniform `SKIN_RGB` canvas** (stripping ALL hair strands, bang outlines, and chin borders so real 3D SDF bangs sit physically in front with zero pasted-hair halo!).
- **Head-bone locking**: Transform query coordinates into Head-local space `(HX, HY, HZ)` via `rot_inv_xyz` BEFORE evaluating `project_tilted_face`, and restrict projection strictly to the head surface (`d_head <= 0.0` & `d_hands > 0.2`) so foreground gestures never receive facial pixels.
- **Warm-Skin Anti-Halo Rule**: When synthesizing closed/blinking expressions, NEVER boost bright pixels solely by luminance (`lum > 228`), because warm peach skin `(254, 234, 227)` glows white! Restrict highlight boosts strictly to cool whites (`b >= r - 6`), as implemented in `toolkit/anime_face_kit.py::finalize_face_texture`.

---

## 6. Never Bake Black 2D Outlines Into Slices
- Baking black outlines into individual slices creates muddy internal bands and shimmer when slices stack.
- Output clean cel-shaded voxel slices with transparent alpha `0`, and let Pass 2 of `engine/anime_stack_engine.js` draw uniform anti-aliased or stepped silhouette outlines around the final 3D composite!
