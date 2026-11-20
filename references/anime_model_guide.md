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

## 3. Layered Anime Hair & Bangs
- Sculpt the head cranium/cheeks as a clean base ellipsoid first (`d_head`).
- Carve out the facial opening cleanly from the hair dome (`xp.maximum(d_hair_dome, -d_face_open)`), then layer individual sculpted bang strands (`sd_chain`) physically in front of the forehead and cheeks so bangs cast genuine 3D parallax when rotated 360°.

---

## 4. Crisp Facial Features & Expressions (Two Clean Strategies)

### Strategy A: 100% Pure 3D SDF Expressions (Recommended for Mascots, Plushies, Creatures & Bold Chibis)
- Sculpt glossy button eyes, shock sclera/pupils, animated rotating dizzy spirals, fierce angled brows, cute `> <` squished chevrons, curved blink eyelids, rosy blush, and 3D carved toothed mouths directly on the moving head/body SDF shell (`surf = occ & (d_solid >= -2.2)`).
- Stays 100% razor-sharp at ALL rotation angles and close-up zooms with zero smudging or halo risk!

### Strategy B: Hair-Free Isolated Tilted Face Projection (For Intricate Anime Humanoids)
- Standard vertical cylindrical projection foreshortens anime eyes at semi-top-down camera pitch. Project onto the moving head bone with **`project_tilted_face(..., tilt_deg=6.5..14.5)`**.
- **Strict Isolation Rule**: Copy **ONLY** the eyes, lashes, brows, and mouth onto a **100% uniform `SKIN_RGB` canvas** (stripping ALL hair strands, bang outlines, and chin borders so real 3D SDF bangs sit physically in front with zero pasted-hair halo!).
- **Head-bone locking**: Transform query coordinates into Head-local space `(HX, HY, HZ)` via `rot_inv_xyz` BEFORE evaluating `project_tilted_face`, and restrict projection strictly to the head surface (`d_head <= 0.0` & `d_hands > 0.2`) so foreground gestures never receive facial pixels.
- **Warm-Skin Anti-Halo Rule**: When synthesizing closed/blinking expressions, NEVER boost bright pixels solely by luminance (`lum > 228`), because warm peach skin `(254, 234, 227)` glows white! Restrict highlight boosts strictly to cool whites (`b >= r - 6`), as implemented in `toolkit/anime_face_kit.py::finalize_face_texture`.

---

## 5. Never Bake Black 2D Outlines Into Slices
- Baking black outlines into individual slices creates muddy internal bands and shimmer when slices stack.
- Output clean cel-shaded voxel slices with transparent alpha `0`, and let Pass 2 of `engine/anime_stack_engine.js` draw uniform anti-aliased or stepped silhouette outlines around the final 3D composite!
