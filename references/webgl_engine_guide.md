# WebGL 2-Pass Sprite-Stack Engine & `motion_pack.json` Reference

`engine/anime_stack_engine.js` is a completely character-agnostic WebGL1 (+ `OES_standard_derivatives`) 2-Pass renderer that eliminates all classic Canvas 2D sprite-stacking artifacts.

## 1. Two-Pass Anti-Shimmer Architecture
1. **Pass 1 (Offscreen 2x-SSAA FBO)**:
   - Draws all slices in **one GPU draw call** using continuous float rotation (`uAngle`, zero angle-quantization judder).
   - Uses **2x interleaved sub-slices** (`charVBO2x` = `2 × sliceCount` quads) whenever `spacing <= 1.32` for gap-free solid silhouettes, automatically switching to 1x slices during `SPREAD` layer inspection.
   - Applies **Premultiplied-Safe Sharp Pixel-Art AA**: averages 2×2 texels strictly normalized over opaque alpha coverage (`rgbSum / max(a, 1e-4)`), eliminating dark transparent edge bleed.
2. **Pass 2 (Main Screen Composite & Style Filter)**:
   - Remember FBO Y-orientation: `vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5)`.
   - Supports 4 real-time render styles:
     - `0 = PIXEL+AA`: Resamples 2x-SSAA FBO onto a virtual square pixel grid (`uVirtSize / uDotSize`) with subpixel AA + 4-neighbor stepped outline.
     - `1 = RETRO PX`: Crisp hard-edge square dots + 4-neighbor 1-dot outline + 28-level color posterization.
     - `2 = SMOOTH AA` *(Default)*: Smooth high-res anti-aliased anime look + 8-direction circular silhouette outline.
     - `3 = SILKY 3D`: Cubic-eased bilinear figurine finish.

## 2. Exact 3D Projection & Multi-Object Z-Sorting
Any 3D world point `(wx, wy, wz)` in the character's voxel grid maps identically to WebGL screen space via:
```js
const px = wx;
const py = wy + CHAR.yOffset;
const rx = px * Math.cos(angle) - py * Math.sin(angle);
const ry = px * Math.sin(angle) + py * Math.cos(angle); // Camera depth!
const sx = screenCx + rx * sxMul * baseUnitPx;
const sy = screenGroundY + (ry * squash - wz * spacing) * syMul * baseUnitPx;
```
- `ry < charDepth` → draw **BEHIND** the main character (Back Layer).
- `ry >= charDepth` → draw **IN FRONT** of the main character (Front Layer).
- Both 3D companion sprite stacks (`companions` rendered to their own 2x-SSAA FBO!) and 3D particles (`fx`) use this exact projection, so orbiting mascots and spiraling water vortices weave seamlessly behind and in front of the character at every 360° camera angle.

## 3. Supported Declarative FX Types in `motion_pack.json`
| `fx.type` | Effect | Key Parameters |
| :--- | :--- | :--- |
| `sparkle_perimeter` | Twinkling 2-frame sparkles around outer perimeter | `startFrame`, `durationFrames`, `points`, `sprite0`, `sprite1` |
| `orbit_trail` | Floating hearts/bubbles trailing an orbiting companion | `count`, `rx`, `ry`, `zBase`, `zSin1`, `zSin2`, `primarySprite`, `secondarySprite` |
| `burst_above` | Rising celebration icons above head | `startFrame`, `durationFrames`, `count`, `sprite`, `zBase` |
| `forward_slash_fan` | Angle-aligned 4-frame crescent slash + parabolic 3D spray | `startFrame`, `durationFrames`, `count`, `slashPrefix`, `dropletSprite`, `bubbleSprite`, `foamSprite` |
| `helix_vortex` | 3D double-helix spiraling elemental vortex | `count`, `slamFrame`, `baseRadius`, `maxHeight`, `dropletSprite`, `bubbleSprite`, `foamSprite` |
| `floor_wave_rings` | Concentric expanding stepped ground shockwave rings | `count`, `startFrame`, `durationFrames`, `staggerFrames`, `forwardOffset`, `sprite` |

## 4. Packaging & Verification
```bash
python3 engine/audit_pixel_build.py --html engine/viewer_shell.html --js engine/anime_stack_engine.js
python3 engine/bundle_standalone.py \
  --html engine/viewer_shell.html \
  --js engine/anime_stack_engine.js \
  --pack my_char/motion_pack.json \
  --assets-root my_char \
  --out dist/my-char-standalone.html
```
Verify in headless Chrome with `--use-gl=angle --use-angle=swiftshader --enable-webgl` on Desktop (`1280×800`) and Mobile (`390×844`, `has_touch=True`).
