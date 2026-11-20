---
name: anime-pseudo-3d
description: >-
  End-to-end pipeline to turn 2D anime/character images into high-resolution (160-slice),
  24-FPS pseudo-3D characters: multi-view turnaround generation (FRONT/SIDE/BACK/TOP) and
  seam-free 3D alignment/joining, GPU SDF sculpting with tilted original-artwork faces,
  arbitrary-N FK/IK 24-FPS animations, reusable pixel-art studio UI kit, portable .ap3d
  binary package export/load/merge, and zero-dependency single-HTML WebGL 2-Pass viewers.
  Use when creating 3D sprite-stacking anime characters from images, adding arbitrary
  numbers of 24-FPS motions, building reusable pseudo-3D viewer UIs, exporting/loading
  .ap3d character packages, or fixing 3D multi-view alignment and orthographic pitch.
---

# Anime Pseudo-3D Skill & Engine (`anime-pseudo-3d`)

Create crisp, 360°-rotatable, **24-FPS anime-style pseudo-3D characters** from reference images using a strictly decoupled **4-Layer Architecture**:

1. **Multi-View Generation & Seam-Free 3D Alignment Layer** ([toolkit/multiview_fitter.py](./toolkit/multiview_fitter.py), [references/multiview_3d_reconstruction_guide.md](./references/multiview_3d_reconstruction_guide.md)): Split generated `FRONT / SIDE / BACK / TOP` orthographic sheets with exterior flood-fill, align exact Z-landmarks, compute 3D Visual Hulls + normal-weighted seam-free 6-view color joining, and validate sculpted 3D fits with orthographic Silhouette IoU QA overlays.
2. **Model Sculpting & 24-FPS Animation Toolkit** ([toolkit/gpu_sdf.py](./toolkit/gpu_sdf.py), [toolkit/anime_face_kit.py](./toolkit/anime_face_kit.py), [toolkit/rig_contracts.py](./toolkit/rig_contracts.py), [toolkit/pixel_fx_kit.py](./toolkit/pixel_fx_kit.py), [toolkit/qa_validator.py](./toolkit/qa_validator.py), [toolkit/record_gif.py](./toolkit/record_gif.py)): CuPy GPU / NumPy CPU SDF primitives, tilted original-artwork face projection (`6.5°–14.5°`), unified FK + 3D IK `PoseFrame` contracts, arbitrary-N periodic motions, and automated clipping/seam QA.
3. **Portable `.ap3d` Binary Format** ([toolkit/ap3d_format.py](./toolkit/ap3d_format.py), [engine/ap3d_codec.js](./engine/ap3d_codec.js)): Zero-dependency cross-platform binary container (`AP3D` v1) storing manifest + raw binary WebP/PNG assets (~33% smaller than base64). Supports CLI `pack / unpack / inspect / merge` AND live browser Export, Load, `+MOTION` Merge, and Canvas Drag-and-Drop over `file://`.
4. **Character-Agnostic WebGL 2-Pass Engine & Reusable Pixel UI Kit** ([engine/anime_stack_engine.js](./engine/anime_stack_engine.js), [engine/anime_ui_kit.js](./engine/anime_ui_kit.js), [engine/anime_ui_theme.css](./engine/anime_ui_theme.css), [engine/viewer_shell.html](./engine/viewer_shell.html), [engine/bundle_standalone.py](./engine/bundle_standalone.py)):
   - **True 3D Orthographic Elevation**: `y = rot.y * sin(pitch) - z * cos(pitch) * spacing` (`PITCH 15°–90°`, default `20°`, zero vertical stretching, pitch-invariant camera scale).
   - **Reusable Modular UI (`AnimeUIKit`)**: Works with **ANY number of animations** (`1` static model, `2`, `9`, `16`, `24`, `50+`) via dynamic grid layout, scrollable pixel motion shelf, optional category filter tabs (`motion.category`), `PREV / NEXT` (`[` / `]`), and hot-reloadable runtime API (`engine.loadScene(...)`, `engine.addMotions(...)`).

> **Credits & Inspiration**:
> - Greatly inspired by **[SpriteCook — Sprite stacking for fake 3D pixel art cars and props](https://www.spritecook.ai/blog/sprite-stacking-pixel-art)**.
> - Extends workflows from [sprite-stacking-3d](https://github.com/kuraneko1/sprite-stacking-3d) for 24-FPS anime characters & WebGL 2-Pass rendering.
> - Live flagship showcase: [kuraneko1/deepseek-chan-3d](https://github.com/kuraneko1/deepseek-chan-3d).

---

## 1. Strict Separation Rules

- **Never hardcode character or motion names inside `engine/`**. Drive everything declaratively via `motion_pack.json` (schema v1.1 in [engine/motion_pack.schema.json](./engine/motion_pack.schema.json)) or `.ap3d` packages.
- **Keep UI modular**: Reuse `window.AnimeUIKit` (`mountStudioUI` or individual widgets `createMotionShelf`, `createPixelSlider`, `createTimelineScrubber`, `createFileIOControls`) and `window.AnimeStackEngine.create(...)` instead of copy-pasting raw HTML/CSS.
- **Never sculpt blind from a single cropped portrait**: Always execute Stage 1 (Multi-View Generation) & Stage 2 (`multiview_fitter.py` alignment + Z-landmarks) first!

---

## 2. Bulletproof 6-Stage End-to-End Workflow (Fresh Session SOP)

Read the relevant reference guides before authoring:
- **Multi-View Generation & 3D Joining**: [references/multiview_3d_reconstruction_guide.md](./references/multiview_3d_reconstruction_guide.md)
- **Model & Tilted Face Projection**: [references/anime_model_guide.md](./references/anime_model_guide.md)
- **24-FPS Motion & IK Rigging**: [references/animation_24fps_guide.md](./references/animation_24fps_guide.md)
- **WebGL Engine, UI Kit & `.ap3d` API**: [references/webgl_engine_guide.md](./references/webgl_engine_guide.md)

### Stage 1: Generate Full-Body Multi-View Orthographic Sheets (Mandatory!)
1. From the user's input image(s), invoke `image-generator` to create a unified **3-View Full-Body Turnaround Sheet (`FRONT | SIDE | BACK`)** on pure `#FFFFFF` background, flat orthographic projection, neutral A-pose, identical floor baseline across all 3 views.
2. If the character has complex top hair/headdress or asymmetric left/right props, also generate a **90° `TOP` overhead view** and/or **`RIGHT SIDE` view**.
3. **Visual Gate**: Inspect the generated sheet(s) with `read_file` to verify matched head-to-body ratio, aligned landmarks, uncropped hair/feet, and clean white background before proceeding.

### Stage 2: Split, Align & Measure Blueprint (`toolkit/multiview_fitter.py`)
1. Run `split_multiview_sheet(...)` + `align_and_measure_views(..., grid_xy=112, grid_z=160, z_height=140, qa_out_path="out/qa_multiview_align.png")`.
2. Visually inspect `out/qa_multiview_align.png` to confirm horizontal Z-rulers (`z_crown`, `z_head_mid`, `z_neck`, `z_shoulders`, `z_waist`, `z_soles`) line up cleanly across `FRONT | SIDE | BACK`.
3. Use `reconstruct_visual_hull(bp)` + `project_6view_colors(occ, bp)` for fast seam-free static prototypes, OR use `bp["landmarks"]` + normal-weighted 6-view color projection to guide your bone-rigged SDF character.

### Stage 3: Sculpt Base 3D Character + Protected Tilted Face & Verify Silhouette IoU
1. Build bone-driven SDF geometry (`toolkit/gpu_sdf.py`) matching `bp["landmarks"]` (canonical `+X` right, `+Y` forward, `+Z` up).
2. Extract clean front face patch (`toolkit/anime_face_kit.py`) and project with `project_tilted_face(..., tilt_deg=6.5..14.5)`. Never bake black outlines into slices; restrict eye-white boosts strictly to cool whites (`b >= r - 6`).
3. **3D Joining QA Gate**: Run `render_multiview_fit_qa(vol_neutral, bp, "out/qa_3d_fit_overlay.png")` and visually verify Silhouette IoU (target `>= 72%`) and seam-free joins (glasses temples, collar over traps, hair crown) BEFORE baking animations!

### Stage 4: Author Arbitrary-N 24-FPS Motions (`PoseFrame`) & Bake
1. Author any number of motions (`1` static, `2`, `9`, `16`, `24+`) using [toolkit/rig_contracts.py](./toolkit/rig_contracts.py) (`ArmPose(mode="fk"|"ik")`, `volume_preserving_sx`, `periodic_lag`). Optionally tag `category` (e.g. `"BASE"`, `"POSE"`, `"ATTACK"`, `"SPECIAL"`) to activate category tabs in `AnimeUIKit` automatically.
2. Counter-pitch head upward (`head_pitch < 0`) whenever leaning torso forward (`torso_pitch > 0`) so the face stays visible.
3. Run `validate_motion_poses(poses)` pre-bake, assert `assert_no_border_clipping(vol, check_bottom=False)` on every baked frame, save lossless WebP atlases (`save_tiled_webp`), and visually inspect `render_animation_sheet`.

### Stage 5: Audit, Pack `.ap3d`, and Bundle Standalone HTML
1. Generate pixel FX sprites & 16×16 UI icons via [toolkit/pixel_fx_kit.py](./toolkit/pixel_fx_kit.py) and write `motion_pack.json`.
2. Audit 100% pixel purity across modular HTML + CSS + JS, export a portable `.ap3d` package, AND bundle a zero-dependency `file://` standalone HTML:
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
   - Build a lightweight **Universal `.ap3d` Player** (`~65 KB`, load/merge/export any `.ap3d` via drag-and-drop):
     ```bash
     python3 engine/bundle_standalone.py \
       --html engine/viewer_shell.html \
       --js engine/anime_stack_engine.js \
       --empty-player \
       --out dist/ap3d-player.html
     ```
   - Merge extra animations into an existing `.ap3d` without re-baking:
     ```bash
     python3 toolkit/ap3d_format.py merge --base char.ap3d --extra dlc_motions.ap3d --out char_expanded.ap3d
     ```

### Stage 6: Browser Verification & GIF Showcase Export
1. Verify in headless Chrome via Playwright (`--use-gl=angle --use-angle=swiftshader --enable-webgl`) on Desktop (`1280×800`) and Mobile (`390×844`, `has_touch=True`), asserting **0 console/page errors** and visually checking multiple angles (`0°`, `24°`, `90°`, `180°`) and elevation pitches (`20°`, `48°`, `90°`).
2. Record deterministic seamless README GIFs via [toolkit/record_gif.py](./toolkit/record_gif.py).
