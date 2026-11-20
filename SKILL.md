---
name: anime-pseudo-3d
description: >-
  Build high-resolution (160-slice), 24-FPS anime-style pseudo-3D characters, bone-rigged
  FK/IK animations, original-artwork tilted facial expressions, 3D orbiting companions,
  and depth-sorted 3D elemental FX using a character-agnostic WebGL 2-Pass Sprite-Stack Engine
  (SMOOTH AA, PIXEL+AA, RETRO PX, SILKY 3D) packaged as zero-dependency single-file HTML.
  Use when creating anime chibi 3D sprite-stacking characters, smooth 24-FPS pseudo-3D anime
  motions, multi-object Z-sorted 3D companions/mascots, meme thought-bubble overlays, or
  3D water/elemental particle attacks rendered with WebGL sprite stacking.
---

# Anime Pseudo-3D Skill & Engine (`anime-pseudo-3d`)

Create crisp, 360°-rotatable, **24-FPS anime-style pseudo-3D characters** powered by a decoupled 3-layer architecture:
1. **Model & Facial Projection Layer** ([toolkit/gpu_sdf.py](./toolkit/gpu_sdf.py), [toolkit/anime_face_kit.py](./toolkit/anime_face_kit.py)): GPU-accelerated (CuPy with NumPy CPU fallback) 3D SDF sculpting, hair-cleaned original-artwork tilted face projection (`14.5°`), and warm-skin-halo-free expression synthesis.
2. **24-FPS Animation, Rig & FX Authoring Layer** ([toolkit/rig_contracts.py](./toolkit/rig_contracts.py), [toolkit/pixel_fx_kit.py](./toolkit/pixel_fx_kit.py), [toolkit/qa_validator.py](./toolkit/qa_validator.py)): Unified FK + 3D IK `PoseFrame` contracts, seamless periodic curves, volume-preserving squash & stretch, phase-delayed spring lag, automated pre-bake & post-bake QA, and Playwright GIF recording.
3. **Character-Agnostic WebGL 2-Pass Display Engine** ([engine/anime_stack_engine.js](./engine/anime_stack_engine.js), [engine/viewer_shell.html](./engine/viewer_shell.html), [engine/bundle_standalone.py](./engine/bundle_standalone.py)): Data-driven runtime consuming declarative `motion_pack.json` with continuous 0.001° GPU rotation, 2x interleaved sub-slices, 2x-SSAA FBO, 4 live render modes (`SMOOTH AA` default, `PIXEL+AA`, `RETRO PX`, `SILKY 3D` + `DOT SIZE`), eye-level anime defaults (`SQUASH 0.35`, `ICE LAB`), multi-object 3D companion Z-sorting, floating billboard overlays, and depth-sorted 3D particles.

> **Credits & Inspiration**:
> - Greatly inspired by **[SpriteCook — Sprite stacking for fake 3D pixel art cars and props](https://www.spritecook.ai/blog/sprite-stacking-pixel-art)** for foundational sprite-stacking concepts.
> - Builds upon workflows pioneered in [sprite-stacking-3d](https://github.com/kuraneko1/sprite-stacking-3d), extended specifically for high-resolution 24-FPS anime characters and real-time WebGL 2-Pass rendering.
> - Live showcase built with this approach: [kuraneko1/deepseek-chan-3d](https://github.com/kuraneko1/deepseek-chan-3d).

---

## 1. Strict 3-Layer Separation Rule

Keep **character sculpting**, **animation choreography**, and **display rendering** cleanly separated:
- **Never hardcode character/motion names inside `engine/anime_stack_engine.js`**. Define motions, companion 3D orbits, floating billboards, and 3D particle emitters declaratively in `motion_pack.json` (see [engine/motion_pack.schema.json](./engine/motion_pack.schema.json)).
- **Separate pose evaluation (`evaluate_pose(frame, total) -> PoseFrame`) from SDF geometry (`sculpt_frame(pose)`)** so outfits, proportions, or resolutions can change without rewriting animations.
- **Store baked frames as lossless WebP tiled atlases** (e.g., `16×10` grid for 160 slices = `1600×1120`, ~40–55 KB/frame) rather than huge uncompressed PNG strips.

---

## 2. Standard End-to-End Workflow (Anime Character + 24-FPS Motions)

Read the relevant reference guides before authoring:
- Model & Face Projection: [references/anime_model_guide.md](./references/anime_model_guide.md)
- 24-FPS Motion & IK Rigging: [references/animation_24fps_guide.md](./references/animation_24fps_guide.md)
- WebGL Engine & `motion_pack.json`: [references/webgl_engine_guide.md](./references/webgl_engine_guide.md)

### Step 1: Gather Reference Views
- Start from a 2D character sheet (FRONT / SIDE / BACK). If TOP, RIGHT SIDE, or 3/4 angles are missing, generate supplementary views so hair volume, waist ribbons, tails, and asymmetrical accessories (`+X` vs `-X`) are unambiguous before sculpting.

### Step 2: Build Base Anime SDF Model & Expression Atlas
- Use [toolkit/gpu_sdf.py](./toolkit/gpu_sdf.py) on a canonical high-res grid (recommended `100×112×160` for anime chibi characters, `+Y` forward, `+Z` up).
- Extract a hair-cleaned front face patch via [toolkit/anime_face_kit.py](./toolkit/anime_face_kit.py) and project it onto the moving head bone with `14.5°` upward tilt (`project_tilted_face`).
- **Critical anti-artifact rule**: When boosting eye/highlight whiteness in custom expressions, restrict the boost strictly to cool whites (`b >= r - 6`) so warm peach skin over closed/blinking eyes never develops a white halo.
- Never bake black outlines into voxel slices; let Pass 2 of the WebGL engine draw uniform anti-aliased or stepped silhouette outlines.

### Step 3: Author 24-FPS Periodic Motions (`PoseFrame`)
- Use [toolkit/rig_contracts.py](./toolkit/rig_contracts.py) (`PoseFrame`, `ArmPose(mode="fk"|"ik")`, `volume_preserving_sx`, `smoothstep`, `periodic_lag`).
- Use **FK** for rhythmic swings (idle, walk, wave, happy jump) and **direct 3D IK joint targets** `(shoulder, elbow, wrist, palm)` for precise gestures (finger-to-lips pose, flexing, petting a companion, wide attack slashes, levitating slams).
- **Face visibility guard**: When leaning torso forward during attacks (`torso_pitch > 0`), always counter-pitch the head upward (`head_pitch < 0`) so the face stays aimed at the camera instead of staring at the floor.
- Run pre-bake mathematical QA via `validate_motion_poses(poses)` in [toolkit/qa_validator.py](./toolkit/qa_validator.py) to catch loop jumps (`F23 -> F0`), downward head-tilt issues, and unsafe bounds before baking.

### Step 4: Bake Atlases & Visually Inspect 3D Stacks
- Bake all 24 frames per motion on GPU (CuPy) and call `assert_no_border_clipping(vol, check_bottom=False)` on **every single frame**.
- Save lossless WebP tiled atlases with `save_tiled_webp(vol, path, cols=16)`.
- Render multi-angle 3D peak & strip QA sheets (`render_animation_sheet`) and **visually inspect them** at `0°`, `24°`, `90°`, `180°` before bundling!

### Step 5: Declare `motion_pack.json`, Audit & Bundle Standalone HTML
- Generate pixel FX sprites & 16×16 pure pixel UI icons via [toolkit/pixel_fx_kit.py](./toolkit/pixel_fx_kit.py) (zero OS Unicode emojis, zero smooth Canvas 2D vector primitives).
- Write `motion_pack.json` declaring character grid, recommended defaults (`squash: 0.35`, `themeIdx: 1` ICE LAB, `renderMode: 2` SMOOTH AA), motions, optional 3D companion orbits, floating billboards, and 3D FX emitters.
- Audit purity & bundle into a single zero-dependency `file://`-ready HTML:
  ```bash
  python3 engine/audit_pixel_build.py --html engine/viewer_shell.html --js engine/anime_stack_engine.js
  python3 engine/bundle_standalone.py \
    --html engine/viewer_shell.html \
    --js engine/anime_stack_engine.js \
    --pack path/to/motion_pack.json \
    --assets-root path/to/assets_root \
    --out dist/character-standalone.html
  ```

### Step 6: Browser Verification & GIF Showcase Export
- Verify in headless Chrome via Playwright (`--use-gl=angle --use-angle=swiftshader --enable-webgl`) on **Desktop (`1280×800`)** and **Mobile (`390×844`, `has_touch=True`)** asserting **0 console/page errors**.
- Record deterministic, loop-seamless 24-FPS README showcase GIFs using [toolkit/record_gif.py](./toolkit/record_gif.py).
