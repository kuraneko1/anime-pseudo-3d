# Multi-View Generation & Seam-Free 3D Reconstruction Guide

> **Why this guide exists**: Reconstructing a 3D anime character directly from a single cropped portrait almost always fails on side profiles, back hair, outfit depth, and proportion consistency. Follow this **exact 2-stage multi-view generation + alignment + joining workflow** so every build succeeds cleanly on the first pass.

---

## Stage 1: Generate Consistent Orthographic Multi-View Sheets

### 1A. Primary Full-Body 3-View Turnaround Sheet (`FRONT | SIDE | BACK`)
When the user supplies 1–2 portraits or concept art images, **ALWAYS generate a unified full-body orthographic 3-view sheet FIRST** before writing any voxel/SDF code.

**Battle-Tested Prompt Template (3-View Sheet)**:
> *"Clean anime character turnaround reference sheet (3 full-body views side-by-side on one wide horizontal canvas: FRONT view on left, LEFT SIDE profile in center, BACK view on right). Based strictly on the attached reference image(s), preserving exact facial features, hairstyle, glasses/accessories, and outfit colors. Chibi / SD anime proportion (~3.5 to 4.5 heads tall, bold readable silhouette, clean cel shading). Neutral standing A-pose, arms slightly away from torso, feet flat on the exact same horizontal baseline across all 3 views. Pure flat orthographic projection (zero perspective tilt, zero camera foreshortening). Solid pure white background (#FFFFFF), zero drop shadows, zero text, zero floor grid."*

### 1B. Supplementary Views (`TOP` + Asymmetric `RIGHT SIDE` + `3/4` Check)
Generate a second supplementary sheet whenever the character has:
- Complex hair crown / maid headdress / hat / ahoge / horns -> generate a **strict 90° TOP-DOWN overhead view** on solid `#FFFFFF` background.
- Asymmetric props (single lapel pin, side ribbon, shoulder cape, hair clip on one side) -> generate a **RIGHT SIDE profile** matching the exact baseline height of the 3-view sheet.
- Complex facial likeness (glasses, jawline, bangs) -> optionally generate a **3/4 angle reference** for visual sanity-checking.

### Mandatory Visual Gate (Before Writing Any Sculpt Code!)
Inspect the generated sheet with `read_file` and verify ALL 5 items (regenerate if any fail!):
1. **Identical vertical landmarks**: Crown, eyes, chin, shoulders, waist, and soles align horizontally across `FRONT`, `SIDE`, and `BACK`.
2. **Full body uncropped**: Hair tips AND both shoes are completely inside the frame with clean white margin.
3. **True orthographic**: No dramatic low-angle/high-angle camera perspective.
4. **Arms separated from torso**: Slight A-pose gap between arms and waist so `split_multiview_sheet` and SDF fitting separate arms cleanly.
5. **Consistent outfit & colors**: Back hair, collar, belt, shoes, and pins match across all views.

---

## Stage 2: Split, Align & Measure Exact 3D Blueprint (`toolkit/multiview_fitter.py`)

Never guess head height, shoulder width, or torso depth by hand! Feed your generated sheets directly into `toolkit/multiview_fitter.py`:

```python
from PIL import Image
import numpy as np
from toolkit.multiview_fitter import (
    split_multiview_sheet,
    remove_exterior_bg,
    align_and_measure_views,
    reconstruct_visual_hull,
    project_6view_colors,
    render_multiview_fit_qa,
)

# 1. Split the 3-view sheet (uses border flood-fill so interior white shirts/eyes stay intact!)
views = split_multiview_sheet(
    "ref_3view.jpg",
    view_names=("front", "side", "back"),
    bg_tol=30.0,
)

# 2. Optional: add TOP / RIGHT views if generated separately
# views["top"] = remove_exterior_bg(np.asarray(Image.open("ref_top.png").convert("RGB")))
# views["right"] = remove_exterior_bg(np.asarray(Image.open("ref_right.png").convert("RGB")))

# 3. Normalize all views into canonical 112x112x160 voxel coordinates & print exact Z-landmarks!
bp = align_and_measure_views(
    views,
    grid_xy=112,
    grid_z=160,
    z_height=140,
    qa_out_path="out/qa_multiview_align.png",
)
print("Measured anatomical Z-landmarks:", bp["landmarks"])
```

**Inspect `out/qa_multiview_align.png`** right away! Confirm the colored horizontal ruler lines (`z_crown`, `z_head_mid`, `z_neck`, `z_shoulders`, `z_waist`, `z_soles`) hit the exact same anatomy across `FRONT`, `SIDE`, and `BACK`.

---

## Stage 3: Seam-Free 3D Joining (Two Proven Strategies)

### Strategy A: Visual Hull + 6-View Normal-Weighted Color Joining (Fast Static 3D / Organic Shapes)
Ideal for rapid static prototypes, props, mascots, or validating 3D volume before building an animated rig:

```python
# Intersect FRONT ∩ BACK ∩ SIDE (∩ TOP) into a 3D occupancy volume
# NOTE: Inspect `qa_multiview_align.png` first! Set `side_faces_right=False` if the character's
# nose in the SIDE view points LEFT (default `True` if nose points RIGHT).
occ_hull = reconstruct_visual_hull(bp, flip_back_x=True, side_faces_right=False)

# Seam-free normal-weighted blending across all available views (no hard 45° seams!)
vol_hull = project_6view_colors(occ_hull, bp, side_faces_right=False, sharpness=3.0)
```

### Strategy B: Hybrid SDF + Multi-View Blueprint + Tilted Face Projection (Recommended for 24-FPS Animated Characters!)
Pure visual hulls have rigid static limbs that cannot bend cleanly in 24-FPS animations. For rigged 24-FPS anime characters:
1. **Build bone-driven SDF limbs/torso/head** (`toolkit/gpu_sdf.py`) parameterized directly by `bp["landmarks"]` (`z_soles`, `z_hips`, `z_waist`, `z_shoulders`, `z_neck`, `z_head_mid`, `z_crown`, `head_width_x`, `head_depth_y`, `shoulder_width_x`).
2. **Join multi-view colors seamlessly onto static/rigid regions** (back hair patterns, jacket details, hair crown from `TOP`) using `project_6view_colors(...)`, OR sample canonical cel-shading palette directly from the aligned views.
3. **Protect the Face Hemisphere** with `toolkit/anime_face_kit.py`:
   - Crop the front face directly from `bp["aligned"]["front"]` (or original high-res portrait).
   - Project onto the moving head bone with `project_tilted_face(..., tilt_deg=6.5..14.5)` so eyes, eyebrows, glasses frames, and expressions stay razor-sharp without side/top texture blur!
4. **Tricky 3D Joining Rules (Zero-Defect Checklist)**:
   - **Glasses**: Let the tilted front face draw the razor-sharp front rims & lenses; sculpt ONLY the **3D side temple arms** connecting the eye corners back to the 3D ears (never put thick front brow voxels in front of projected eyes!).
   - **Neck-to-Collar / Traps**: Always wrap the jacket/dress collar SDF over the outer trapezius/shoulders so shirt/skin voxels never bleed through the back of the jacket.
   - **Hair Crown & Side Bangs**: Sculpt smooth rounded hair domes/locks (avoid tiny sharp cone spikes on the sides that read like horns at 3/4 angles) and blend bangs cleanly over the upper forehead (`z > z_eyebrows`).
   - **Asymmetric Details (`+X` vs `-X`)**: Remember canonical coordinates: in FRONT view, character's **left lapel/ribbon** is at **viewer-right (`+X`)**, character's **right hand** is at **viewer-left (`-X`)**.

---

## Stage 4: Mandatory 3D-to-Multi-View Silhouette IoU QA Gate

After sculpting the neutral T/A-pose frame (before baking 216 animation frames!), ALWAYS verify your 3D model against the aligned reference views:

```python
ious = render_multiview_fit_qa(vol_neutral, bp, out_path="out/qa_3d_fit_overlay.png")
print("3D Multi-View Silhouette IoU:", ious)
```

Inspect `out/qa_3d_fit_overlay.png`:
- Target **IoU ≥ 72%** across `FRONT`, `SIDE`, and `BACK` (minor arm-pose differences are fine, but head radius, torso width/depth, and leg length must align cleanly!).
- Once `qa_3d_fit_overlay.png` passes visual inspection, proceed directly to baking all N × 24-FPS motions and packaging into `.ap3d` + standalone HTML!
