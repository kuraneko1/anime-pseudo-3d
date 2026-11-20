---
name: anime-pseudo-3d
description: >-
  End-to-end pipeline to turn 2D anime/character/mascot images into crisp high-resolution (128-160 slice),
  24-FPS pseudo-3D characters: multi-view orthographic blueprint generation (FRONT/SIDE/BACK/TOP) for
  exact proportion measurement & Silhouette IoU QA (NEVER pasting 2D sheets as body textures!), pure
  bone-driven GPU SDF sculpting with procedural 3-step normal cel shading & 3D micro-relief, arbitrary-N
  physics-coupled 24-FPS animations, 3D companions, pixel-art billboards/icons, reusable studio UI kit,
  portable .ap3d packages, and zero-dependency single-HTML WebGL 2-Pass viewers.
  Use when creating 3D sprite-stacking anime characters or mascots from images, adding arbitrary
  numbers of 24-FPS motions, building reusable pseudo-3D viewer UIs, exporting/loading .ap3d packages,
  or fixing muddy texture-pasted 3D builds and orthographic pitch.
---

# Anime Pseudo-3D Skill & Engine (`anime-pseudo-3d`)

Create crisp, 360°-rotatable, **24-FPS anime-style pseudo-3D characters & mascots** from reference images using a strictly decoupled **4-Layer Architecture** and **Pure GPU SDF Sculpting**:

1. **Multi-View Blueprint & Silhouette IoU QA Layer** ([toolkit/multiview_fitter.py](./toolkit/multiview_fitter.py), [references/multiview_3d_reconstruction_guide.md](./references/multiview_3d_reconstruction_guide.md)): Connected-component splitting of generated `FRONT / SIDE / BACK / TOP` orthographic sheets with shared baseline preservation & interior white-hole clearing, exact anatomical coordinate & clean cel-palette extraction, and objective 3D-to-2D Silhouette IoU QA overlays (`>= 72%`). **Turnaround sheets are blueprints & QA rulers ONLY — never pasted as 3D body textures!**
2. **Pure GPU SDF Sculpting & 24-FPS Physics Rigging Toolkit** ([toolkit/gpu_sdf.py](./toolkit/gpu_sdf.py), [toolkit/anime_face_kit.py](./toolkit/anime_face_kit.py), [toolkit/rig_contracts.py](./toolkit/rig_contracts.py), [toolkit/pixel_fx_kit.py](./toolkit/pixel_fx_kit.py), [toolkit/qa_validator.py](./toolkit/qa_validator.py), [toolkit/record_gif.py](./toolkit/record_gif.py)): CuPy GPU / NumPy CPU SDF primitives with float32 NaN guards (`safe_sin_pow`), 3D polylines (`sd_polyline`), strap/cloth indentation + cushion bulge relief (`sdf_indent_bulge`), crisp 3-step normal cel shading (`shade_cel_3step`) + SDF AO, unified FK/IK & physics-coupled `PoseFrame` rigging, and zero-clipping QA.
3. **Portable `.ap3d` Binary Format & Optional Full-3D Mesh / `.glb` Export** ([toolkit/ap3d_format.py](./toolkit/ap3d_format.py), [engine/ap3d_codec.js](./engine/ap3d_codec.js), [toolkit/full3d_mesh_kit.py](./toolkit/full3d_mesh_kit.py), [toolkit/ap3d_to_full3d.py](./toolkit/ap3d_to_full3d.py), [engine/full3d_mesh_engine.js](./engine/full3d_mesh_engine.js)):
   - Zero-dependency `.ap3d` binary container (`AP3D` v1) for sprite-stacking (~33% smaller than base64) with live browser Load / `+MOTION` Merge / Export & Drag-and-Drop.
   - **Dual-Target Full-3D Mesh & `.glb` Pipeline**: Export ultra-lightweight (~5×–10× smaller), hardware-Z-buffered 60-FPS Full-3D polygon viewers reusing `AnimeUIKit` + `anime_ui_theme.css` unmodified — either (a) directly from GPU SDF parts (`toolkit/full3d_mesh_kit.py`: Surface Nets + outward-verified tubes/spheres/teeth + camera-aligned studio cel shading) OR (b) in 1 command from any existing `.ap3d` via `toolkit/ap3d_to_full3d.py`!
4. **Character-Agnostic WebGL 2-Pass Engine & Reusable Pixel UI Kit** ([engine/anime_stack_engine.js](./engine/anime_stack_engine.js), [engine/anime_ui_kit.js](./engine/anime_ui_kit.js), [engine/anime_ui_theme.css](./engine/anime_ui_theme.css), [engine/viewer_shell.html](./engine/viewer_shell.html), [engine/bundle_standalone.py](./engine/bundle_standalone.py)):
   - **True 3D Orthographic Elevation**: `y = rot.y * sin(pitch) - z * cos(pitch) * spacing` (`PITCH 15°–90°`, default `20°`, zero vertical stretching, pitch-invariant camera scale).
   - **Reusable Modular UI (`AnimeUIKit`)**: Works with **ANY number of animations** (`1` static model, `2`, `6`, `9`, `24`, `50+`) via dynamic grid layout, scrollable pixel motion shelf, optional category filter tabs (`motion.category`), `PREV / NEXT` (`[` / `]`), and hot-reloadable runtime API (`engine.loadScene(...)`, `engine.addMotions(...)`).

> **Credits & Inspiration**:
> - Greatly inspired by **[SpriteCook — Sprite stacking for fake 3D pixel art cars and props](https://www.spritecook.ai/blog/sprite-stacking-pixel-art)**.
> - Extends workflows from [sprite-stacking-3d](https://github.com/kuraneko1/sprite-stacking-3d) for 24-FPS anime characters & WebGL 2-Pass rendering.
> - Live flagship showcase: [kuraneko1/deepseek-chan-3d](https://github.com/kuraneko1/deepseek-chan-3d).

---

## 1. Ironclad Quality & Separation Rules (NEVER Violate!)

1. **NEVER PASTE GENERATED TURNAROUND IMAGES AS 3D BODY/HAIR/CLOTHING TEXTURES**:
   - **DO NOT** use `reconstruct_visual_hull(...)` or `project_6view_colors(...)` to build or color characters! Projecting 2D generated sheets onto voxels bakes muddy 2D black lineart, flat lighting, boxy silhouettes, and misalignment smudges into every slice.
   - Use generated multi-view turnaround sheets **STRICTLY** as: (a) exact coordinate/proportion blueprints, (b) flat base RGB palette samplers (`sample_clean_palette`), and (c) Silhouette IoU QA references (`render_multiview_fit_qa`).
   - Sculpt **100% of 3D geometry** (body, hair locks, clothes, collars, cavities, teeth, ropes/straps, knots, limbs, tails) with pure bone-driven GPU SDFs (`toolkit/gpu_sdf.py`) and shade with procedural **3-step normal cel shading (`shade_cel_3step`) + SDF ambient occlusion** — zero baked 2D outlines!
   - *Scoped facial exception*: For mascots, creatures, plushies, and bold chibis, sculpt **pure 3D SDF eyes, mouths, and expressions** (`blink / panic / dizzy / chomp / squish`). For intricate anime humanoids only, you may isolate **strictly hairline-free eyes & mouth onto a uniform `SKIN_RGB` canvas** via `anime_face_kit.py` + `project_tilted_face` (and optional alpha-masked flat shirt/back graphic decals) — never raw body/hair sheet projection!
2. **Never hardcode character or motion names inside `engine/`**: Drive everything declaratively via `motion_pack.json` (schema v1.1 in [engine/motion_pack.schema.json](./engine/motion_pack.schema.json)) or `.ap3d` packages.
3. **Choose the right voxel grid for the subject's proportions**:
   - Tall anime humanoids: `100×112×160` (`16×10` atlas, `fboVirtW=196, fboVirtH=440`)
   - Horizontal / wide / mascot / creature / hanging subjects: `128×128×128` (`16×8` atlas, `fboVirtW=220, fboVirtH=360`)
   - 3D companions: `64×64×64` (`8×8` atlas) or `32×32×32` (`8×4` atlas)
4. **Never sculpt blind or skip visual gates**: Pass ALL 6 Visual QA Gates below (`read_file` inspection at Stages 1, 2, 3, 4, and 6) before shipping!

---

## 2. Canonical 6-Stage End-to-End Workflow (Ground-Truth SOP)

Read the relevant reference guides before authoring:
- **Multi-View Blueprint & Silhouette IoU QA**: [references/multiview_3d_reconstruction_guide.md](./references/multiview_3d_reconstruction_guide.md)
- **Pure GPU SDF Sculpting, Micro-Relief & Facial Rules**: [references/anime_model_guide.md](./references/anime_model_guide.md)
- **24-FPS Motion, Physics-Coupled Rigging & FX Alignment**: [references/animation_24fps_guide.md](./references/animation_24fps_guide.md)
- **WebGL Engine, UI Kit & `.ap3d` API**: [references/webgl_engine_guide.md](./references/webgl_engine_guide.md)

### Stage 1: Generate Clean Orthographic Multi-View Blueprints (Mandatory!)
1. From the user's input image(s), invoke `image-generator` to create a wide **3-View Orthographic Turnaround Sheet (`FRONT | SIDE | BACK`)** on pure `#FFFFFF` background, flat orthographic projection, neutral pose, identical horizontal baseline across all 3 views, zero text, zero drop shadows, zero background clutter.
2. Also generate a supplementary **90° `TOP` overhead view** (and companion / asymmetric `RIGHT` view when relevant) on pure `#FFFFFF`.
3. **Visual Gate 1**: Inspect every generated sheet with `read_file` to verify matched proportions, aligned horizontal landmarks, uncropped tips/extremities, and clean white separation.

### Stage 2: Connected-Component Blueprint Split, Baseline Alignment & Palette Sampling (`toolkit/multiview_fitter.py`)
1. Run `split_multiview_sheet(..., preserve_shared_baseline=True, clear_upper_white_holes_ratio=...)` — uses connected-component isolation so adjacent panels never slice into each other, preserves shared floor/crown baselines, and clears enclosed `#FFFFFF` pockets (between ropes, arms, legs) without touching cream/white clothing or plush.
2. Run `align_and_measure_views(views, grid_xy=..., grid_z=..., z_height=..., qa_out_path="qa/qa_multiview_align.png")` and extract exact per-region voxel coordinates (`x/y/z` ranges) + clean flat RGB palette clusters (`bp["palette"]` / `sample_clean_palette`).
3. **Visual Gate 2**: Inspect `qa/qa_multiview_align.png` with `read_file` to confirm zero panel bleed, zero trapped white background triangles, and exact horizontal ruler alignment across `FRONT | SIDE | BACK | TOP`.

### Stage 3: Pure Parametric GPU SDF Sculpting + Multi-View Silhouette IoU Gate (BEFORE Baking Animations!)
1. Build **100% pure bone-driven GPU SDF geometry** (`toolkit/gpu_sdf.py`) matching the exact coordinates measured in Stage 2:
   - Guard all fractional powers with `safe_pow` / `safe_sin_pow` (prevents float32 GPU `sin(pi) = -8.7e-8 -> NaN` geometry chops!).
   - Carve real 3D cavities (`smax(d_body, -d_cavity, k)`), sculpt protruding 3D accessories/straps/knots/teeth/hair locks (`sd_polyline`, `sd_bone_chain`), and add tactile surface micro-relief (`sdf_indent_bulge` for tight ropes/belts/collars digging into soft plush/cloth + cushion bulges!).
   - Shade every material with crisp **3-step normal cel shading (`shade_cel_3step`) + SDF ambient occlusion (`ao`)** using the sampled blueprint palette. **NEVER call `project_6view_colors` or bake 2D black outlines into slices!**
2. **Visual Gate 3 (Mandatory Iteration Gate!)**:
   - Run `render_multiview_fit_qa(vol_neutral, bp, "qa/qa_3d_fit_overlay.png", input_order="zyx")` (map head-on view to `"left"` if subject faces `-X`, or `"side"`/`"right"` if facing `+X`) and verify **Silhouette IoU ≥ 72%** across all views.
   - Render a 6-angle 3D turntable check (`render_animation_sheet([vol_view], "qa/qa_turntable_neutral.png", angles_deg=(0, 24, 60, 90, 150, 180))`).
   - Inspect BOTH images with `read_file` and fix every single symmetry, cavity, proportion, or NaN defect BEFORE baking a single animation frame!

### Stage 4: Author Arbitrary-N Physics-Coupled 24-FPS Motions & Bake
1. Author seamless periodic 24-FPS motions (`frame 23 -> frame 0` zero seam) with:
   - Stationary world pivots where applicable (e.g., hanging hooks/anchors) vs inverse-transformed rig space (`rot_inv_xyz`), and **dynamic accessories/ropes/tails that deform directly with their parent bone coordinates** so nothing ever detaches or clips!
   - Phase-delayed secondary inertia (`periodic_lag(..., lag_rad=0.85)`), volume-preserving squash & stretch (`volume_preserving_sx`), and per-motion animated expressions (`blink / panic / dizzy / chomp / squish / happy`).
   - Head visibility guard: counter-pitch head upward (`head_pitch < 0`) whenever leaning torso forward (`torso_pitch > 0`).
2. Run `validate_motion_poses(poses)` (for `PoseFrame` rigs), assert `assert_no_border_clipping(vol)` on **EVERY baked frame** (all 6 faces when floating/hanging, or `check_bottom=False` when standing on `z=0`), save lossless WebP atlases (`save_tiled_webp`), and visually inspect `qa/qa_motions_strip.png` across multiple angles (**Visual Gate 4**).

### Stage 5: Pixel-Pure Companions, Billboards, Custom Icons, Audit & Bundle
1. Optionally sculpt 24-frame 3D sprite-stacked companions (`64×64×64`), generate 1-bit thresholded pixel-art speech/meme billboards (stepped pixel bubbles + 2px pixel outline), custom 16×16 character-specific motion icons, and FX sprites (`toolkit/pixel_fx_kit.py`).
2. Align declarative FX to the character's actual facing axis (`forward_slash_fan` fires along `+Y`; for subjects facing `-X`/`+X`, target explicit 3D `sparkle_perimeter` burst coordinates around the mouth/weapon!). Choose `defaults.angleDeg` to showcase the highest-charm 3/4 hero angle on load.
3. Write `motion_pack.json`, audit 100% pixel purity, export `.ap3d`, AND bundle zero-dependency `file://` standalone HTML:
   ```bash
   python3 engine/audit_pixel_build.py \
     --html engine/viewer_shell.html \
     --css engine/anime_ui_theme.css \
     --js engine/ap3d_codec.js engine/anime_ui_kit.js engine/anime_stack_engine.js

   python3 engine/bundle_standalone.py \
     --html engine/viewer_shell.html \
     --js engine/anime_stack_engine.js \
     --pack your_char/motion_pack.json \
     --assets-root your_char \
     --export-ap3d dist/your-char.ap3d \
     --out dist/your-char-standalone.html
   ```

### Optional Stage 5B: Lightweight Full-3D Polygon Mesh Viewer & Non-Conflicting Export Format Selection
Both **Sprite-Stack (`.ap3d`)** and **Full-3D (`.glb`)** outputs coexist cleanly without overwriting or conflicting with each other (`*-standalone.html` + `*.ap3d` vs `*-full3d.html` + `*.glb`), and **`AnimeUIKit` automatically offers pixel-art Export Format Selector pills** tailored to each engine:
- **Sprite-Stack viewers (`anime_stack_engine.js`)**: preserves `.AP3D` `LOAD` / `+MOTION` / `EXPORT` + Drag-and-Drop 100% intact, with selectable **`.AP3D`** | **`.PNG`** export pills.
- **Full-3D viewers (`full3d_mesh_engine.js`)**: enables live in-browser zero-dependency glTF 2.0 export with selectable **`.GLB (3D)`** | **`.GLB+PET`** | **`.PNG`** pills.

1. **Path 1 — 1-Command Conversion from ANY existing `.ap3d`** (instant lightweight turntable 3D + `.glb`, never mutates input `.ap3d`):
   ```bash
   python3 toolkit/ap3d_to_full3d.py \
     --in dist/your-char.ap3d \
     --out-html dist/your-char-full3d.html \
     --out-glb dist/your-char-full3d.glb
   ```
2. **Path 2 — Dual-Target SDF -> 60-FPS Articulated Full-3D Mesh** (best quality & full 60-FPS motion):
   - Extract smooth watertight body/limb parts via `toolkit.full3d_mesh_kit.extract_surface_nets(...)` and ropes/accessories via `make_tube_mesh(...)` / `make_sphere_mesh(...)` / `make_prism_tooth(...)` (all mathematically guarded by `ensure_outward_winding` so ropes/straps NEVER invert normals and turn dark!).
   - Render with **2-Pass 2×2-SSAA exact-ID screen-space silhouette outlines** (NO inverted-hull extrusion -> ZERO false internal lines in concave grooves/fin roots!), **camera-aligned studio key lighting** (`uLightDir`), and a **true 3D rotating turntable pedestal & shadows** (auto-pixelated in `PIXEL+AA` / `RETRO PX`, translucent glass underside when pitching below `0°` down to `-85°`).
   - Reuse `engine/anime_ui_theme.css` + `engine/anime_ui_kit.js` unmodified with `engine/full3d_mesh_engine.js` (or a character-specific vertex rig).

### Stage 6: Live Headless WebGL Verification, Visual Polish Loop & GIF Export
1. Verify in headless Chrome via Playwright (`--use-gl=angle --use-angle=swiftshader --enable-webgl`) on **Desktop (`1280×800`)** and **Mobile (`390×844`, `has_touch=True`)**, asserting **0 console/page errors**.
2. **Visual Gate 6 (Mandatory Live Polish Loop!)**: Capture & inspect via `read_file`:
   - `qa/browser_desktop_hero.png` & `qa/browser_mobile.png`
   - `qa/browser_webgl_grid.png`: 8-panel grid covering hero 3/4, `0°`, `90°`, `180°`, active motions, `PITCH 48°`, and `PITCH 90° TOP`!
   - Catch and fix any subtle composition bugs (e.g., billboard touching top peg/hair, FX firing off-axis, framing/zoom) and re-verify before final delivery!
3. Record deterministic seamless showcase GIFs (active meme/motion loop + smooth 360° turntable spin) via Playwright + FFmpeg ([toolkit/record_gif.py](./toolkit/record_gif.py)).
