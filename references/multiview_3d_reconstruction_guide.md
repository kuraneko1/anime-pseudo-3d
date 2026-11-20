# Multi-View Blueprint & Silhouette IoU QA Guide (Pure GPU SDF Workflow)

> **CRITICAL QUALITY PRINCIPLE — NEVER PASTE GENERATED 2D SHEETS AS 3D BODY TEXTURES!**
> Reconstructing a 3D character from a single portrait fails on side profiles and back depth—**AND** pasting generated multi-view sheets onto a Visual Hull via `project_6view_colors` ruins 360° quality by baking muddy 2D black lineart, flat lighting, boxy silhouettes, and misalignment smudges into every voxel slice!
>
> Follow this **exact blueprint-measurement + pure GPU SDF sculpting + Silhouette IoU QA workflow** so every build achieves crisp, figurine-grade 360° quality on the first pass.

---

## Stage 1: Generate Clean Orthographic Multi-View Blueprint Sheets

### 1A. Primary 3-View Turnaround Sheet (`FRONT | SIDE | BACK`)
Always generate a unified orthographic 3-view sheet FIRST before writing any SDF code:

**Battle-Tested Prompt Template (3-View Sheet)**:
> *"Clean orthographic turnaround reference sheet (3 full views side-by-side on one wide horizontal canvas with generous white space separating them: FRONT view on left, SIDE/HEAD-ON profile in center, BACK view on right). Based strictly on the attached reference image(s), preserving exact silhouette, accessories, markings, and clean cel-shaded color palette. Neutral pose, identical horizontal baseline across all 3 views. Pure flat orthographic projection (zero perspective tilt, zero camera foreshortening). Solid pure white background (#FFFFFF), zero drop shadows, zero text labels, zero floor grid, completely uncropped with clean white margins."*

### 1B. Supplementary Views (`TOP` + Companion / Asymmetric Views)
Generate a clean supplementary sheet whenever the subject has:
- Detailed top-down structure (hair crown, headdress, dorsal fins, straps/ropes crossing the back) -> **strict 90° TOP-DOWN overhead view** on pure `#FFFFFF`.
- A secondary companion character (e.g., orbiting mascot/pet/witness) or asymmetric left/right props -> add a clean isolated reference panel on `#FFFFFF`.

### Visual Gate 1 (Inspect with `read_file` BEFORE coding!)
Verify ALL 5 items (regenerate if any fail):
1. **Shared horizontal landmarks**: Crown/top anchor, eyes, mid-body, and bottom baseline align horizontally across all 3 views.
2. **Completely uncropped**: All hair tips, tails, ropes, and shoes sit inside clean `#FFFFFF` margins.
3. **True orthographic**: Zero dramatic camera perspective distortion.
4. **Separated limbs/silhouette**: Clear white separation between panels and arms/body gaps.
5. **Consistent colors & details**: Markings, straps, hair, and accessories match across every view.

---

## Stage 2: Connected-Component Split, Baseline Alignment & Palette Extraction (`toolkit/multiview_fitter.py`)

Never guess voxel coordinates, radii, or colors by hand—and never rely on naive equal-third cropping!

```python
import json
from toolkit.multiview_fitter import (
    split_multiview_sheet,
    align_and_measure_views,
    sample_clean_palette,
)

# 1. Connected-component panel split + shared baseline preservation + optional interior white-hole clearing!
#    - Connected components prevent wide/close panels from slicing into neighbors.
#    - `clear_upper_white_holes_ratio=0.52` punches out trapped #FFFFFF triangles (e.g. between hanging ropes)
#      while leaving off-white shirts, cream bellies, and eye glints 100% intact!
views = split_multiview_sheet(
    "refs/ref_3view.jpg",
    view_names=("front", "side", "back"),   # Use ("front", "left", "back") if center panel looks from -X toward +X!
    bg_tol=28.0,
    preserve_shared_baseline=True,
    clear_upper_white_holes_ratio=0.0,      # Set 0.50-0.60 if V-ropes/arms enclose pure-white canvas pockets
)

# Optional TOP view from a 2-panel supplementary sheet:
# extra = split_multiview_sheet("refs/ref_top.jpg", view_names=("top", "companion"), preserve_shared_baseline=False)
# views["top"] = extra["top"]

# 2. Align into canonical voxel coordinates (choose grid to fit subject aspect ratio!)
#    - Tall humanoids: grid_xy=112, grid_z=160, z_height=140
#    - Horizontal/wide mascots or suspended props: grid_xy=128, grid_z=128, z_height=104
bp = align_and_measure_views(
    views,
    grid_xy=128,
    grid_z=128,
    z_height=104,
    qa_out_path="qa/qa_multiview_align.png",
)
print("Measured landmarks:", json.dumps(bp["landmarks"], indent=2))
print("Clean cel palette:", json.dumps(bp["palette"], indent=2))
```

### Visual Gate 2 (Inspect `qa/qa_multiview_align.png` with `read_file`!)
Confirm:
- Zero bleeding/cropping between `FRONT`, `SIDE`/`LEFT`, `BACK`, and `TOP`.
- Zero trapped white background pockets remaining opaque.
- Colored horizontal Z-rulers hit the exact same anatomical landmarks across every standing panel.
- Also print exact per-color X/Y/Z coordinate ranges from `bp["aligned"]["front"]` and `bp["aligned"]["side"]` so your SDF formulas hit the blueprint to the single voxel!

---

## Stage 3: Pure Parametric GPU SDF Sculpting (Anti-Pattern vs Ground Truth)

### ANTI-PATTERN (BANNED FOR PRODUCTION!): Visual Hull + 2D Texture Projection
**DO NOT** build characters with `reconstruct_visual_hull(bp)` + `project_6view_colors(occ, bp)`:
- Visual hull silhouette intersection (`FRONT ∩ SIDE ∩ BACK`) fuses concavities (open mouths, limb gaps, waist curves, layered hair) into boxy blocks.
- `project_6view_colors` smears 2D black lineart, flat baked lighting, and alignment mismatches across 3D surfaces, colliding horribly with Pass 2 WebGL outlines and breaking 24-FPS bone deformation.

### GROUND TRUTH (MANDATORY!): Pure Bone-Driven GPU SDF + Procedural 3-Step Normal Cel Shading
1. **Sculpt 100% of 3D geometry in `toolkit/gpu_sdf.py`** parameterized directly by Stage 2's measured coordinates:
   - Smooth tapered body/torso profiles (`safe_sin_pow`, `sd_ellipsoid`, `sd_bone_chain`)
   - Carved 3D cavities (`smax(d_body, -d_mouth_carve, k)`)
   - Protruding 3D details (teeth, braided cords via `sd_polyline`, 3D knots, hair locks, collars, fins/ears/tails)
   - Tactile 3D surface relief (`sdf_indent_bulge` for tight straps/ropes/belts indenting soft plush/cloth + bulging cushions between them!)
2. **Shade purely with `shade_cel_3step` + SDF Ambient Occlusion (`ao`)**:
   - Feed the clean flat base/hi/shadow/deep RGB clusters sampled from `bp["palette"]`.
   - Zero baked black 2D outlines inside slices — let Pass 2 of `engine/anime_stack_engine.js` draw razor-sharp view-dependent outlines!
3. **Scoped Facial Exception**:
   - **Mascots / creatures / plushies / bold chibis**: Sculpt 100% pure 3D SDF eyes, mouths, blush, and expressions (`blink / panic / dizzy / chomp / squish`).
   - **Intricate anime humanoids ONLY**: You may isolate **strictly hairline-free eyes & mouth onto a 100% uniform `SKIN_RGB` canvas** (`toolkit/anime_face_kit.py` + `project_tilted_face`) and optional alpha-masked flat clothing print emblems—NEVER project raw sheet pixels across hair, body, or clothing!

---

## Stage 4: Mandatory 3D-to-Blueprint Silhouette IoU & Multi-Angle QA Gate (BEFORE Baking Animations!)

Before baking 144–216 animation frames, verify your neutral-pose pure SDF volume directly against the aligned blueprint AND inspect 6 turntable angles:

```python
from toolkit.multiview_fitter import render_multiview_fit_qa
from toolkit.qa_validator import render_animation_sheet

# Note: gpu_sdf.make_grid outputs (Z, Y, X, 4); pass input_order="zyx" (or vol_zyx_to_yxz(vol))!
ious = render_multiview_fit_qa(
    vol_neutral,
    bp,
    out_path="qa/qa_3d_fit_overlay.png",
    flip_back_x=True,
    side_faces_right=True,
    input_order="zyx",
)
print("3D Multi-View Silhouette IoU:", ious)

render_animation_sheet(
    [vol_neutral],
    out_path="qa/qa_turntable_neutral.png",
    angles_deg=(0.0, 24.0, 60.0, 90.0, 150.0, 180.0),
    squash=0.35,
    scale=2,
)
```

### Visual Gate 3 (Inspect BOTH `qa_3d_fit_overlay.png` AND `qa_turntable_neutral.png`!)
- Target **Silhouette IoU ≥ 72%** across `FRONT`, `SIDE`/`LEFT`, `BACK`, and `TOP`.
- Verify camera axis match: in `render_multiview_fit_qa`, `"left"` views from `-X -> +X` (head-on for subjects whose face/snout points `-X` in FRONT view), while `"side"`/`"right"` views from `+X -> -X`.
- Verify clean 360° symmetry, zero float32 NaN truncation, crisp cavities/accessories, and zero muddy lines BEFORE baking animations!
