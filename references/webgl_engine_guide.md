# WebGL 2-Pass Engine, Reusable UI Kit (`AnimeUIKit`) & `.ap3d` Binary Package Reference

`engine/` is organized into cleanly decoupled, zero-dependency modules that work both modularly in web apps and bundled into offline `file://` single HTML files:

| File | Role |
| :--- | :--- |
| `engine/anime_stack_engine.js` | Character-agnostic, hot-reloadable WebGL 2-Pass renderer (`window.AnimeStackEngine.create`) |
| `engine/anime_ui_kit.js` | Reusable 100% pixel-art UI component library (`window.AnimeUIKit`) supporting arbitrary-N animations |
| `engine/anime_ui_theme.css` | Reusable 100% pixel-art studio theme (zero rounded corners, zero blur, Desktop + Mobile) |
| `engine/ap3d_codec.js` | Zero-dependency browser `.ap3d` binary codec (`window.AP3DCodec`: encode, decode, download) |
| `engine/viewer_shell.html` | Turnkey thin HTML shell connecting the modular engine & UI kit |
| `engine/bundle_standalone.py` | Bundles everything into a single offline HTML (`--pack`, `--ap3d`, `--export-ap3d`, or `--empty-player`) |
| `engine/audit_pixel_build.py` | Audits HTML + CSS + JS files for 100% pixel-art purity |

---

## 1. Two-Pass Anti-Shimmer & True 3D Orthographic Projection
1. **Pass 1 (Offscreen 2x-SSAA FBO)**:
   - Draws all slices in one GPU draw call with continuous float rotation (`uAngle`).
   - Uses **true 3D orthographic elevation** across `PITCH 15°–90°` (`default 20°`):
     ```js
     const sinP = Math.sin(pitchRad);
     const cosP = Math.cos(pitchRad);
     const zStep = cosP * state.spacing;
     // Vertex shader: stacked = vec2(rot.x, rot.y * sinP - aSlice.x * zStep)
     ```
   - Uses **2x interleaved sub-slices** (`charVBO2x`) when `zStep >= 0.05 && spacing <= 1.32` for solid zero-gap silhouettes.
   - Applies premultiplied-safe sharp pixel-art AA (`rgbSum / max(a, 1e-4)`).
2. **Pass 2 (Main Screen Composite & 4 Live Render Modes)**:
   - `0 = PIXEL+AA`: Square virtual pixel dots (`uVirtSize / uDotSize`) + subpixel edge AA + stepped outline.
   - `1 = RETRO PX`: Hard-edge pixels + 4-neighbor stepped outline + 28-level posterization.
   - `2 = SMOOTH AA` *(Default)*: Smooth high-res anti-aliased anime rendering + 8-direction outline.
   - `3 = SILKY 3D`: Cubic-eased bilinear figurine finish.

---

## 2. Reusing the UI Kit & Engine in Your Own App (Arbitrary-N Motions)

### Option A: One-Line Full Studio Mount
```html
<link rel="stylesheet" href="./anime_ui_theme.css" />
<div id="myViewer"></div>
<script src="./ap3d_codec.js"></script>
<script src="./anime_ui_kit.js"></script>
<script>window.ANIME_AUTO_MOUNT = false;</script>
<script src="./anime_stack_engine.js"></script>
<script>
  const root = document.getElementById("myViewer");
  let engine = null;
  const proxy = new Proxy({}, { get: (_, k) => (...a) => engine && engine[k](...a) });
  const ui = AnimeUIKit.mountStudioUI(root, proxy, {
    showFileIO: true,       // LOAD / +MOTION / EXPORT .ap3d + drag-and-drop
    showRenderModes: true,
    showViewAngles: true,
    showSliders: true,
    showToggles: true,
  });
  engine = AnimeStackEngine.create({
    canvas: ui.canvas,
    config: mySceneConfig,
    assets: mySpriteAssets,
    onHudUpdate: (txt) => ui.updateHud(txt),
    onTimelineUpdate: (f, fc) => ui.updateTimeline(f, fc),
    onStateChange: () => ui.syncAll(),
    onSceneChange: () => ui.syncScene(),
  });
  ui.syncScene();
</script>
```

### Option B: Dynamically Adding Unlimited Motions or Hot-Swapping Characters at Runtime
- **Arbitrary-N Motions**: Pass `1`, `2`, `9`, `16`, `24`, or `100` motions in `config.motions`. Adding optional `"category": "BASE" | "POSE" | "ATTACK" | "SPECIAL"` automatically renders category filter pills in `AnimeUIKit.createMotionShelf`! Users can also step through all N motions with `<` / `>` buttons or `[` / `]` keys, or hotkeys `1–9` & `0`.
- **Append motions live**: `engine.addMotions(extraMotions, extraAssets, extraCompanions)` (auto-remaps asset key collisions and updates the UI shelf!).
- **Hot-swap entire character live**: `engine.loadScene(newConfig, newAssets)` (cleanly disposes old WebGL FBOs/VBOs/textures and adapts to different slice resolutions!).

---

## 3. Portable `.ap3d` Binary Package Format (Export / Load / Merge)

Byte-compatible between Python (`toolkit/ap3d_format.py`) and Browser (`engine/ap3d_codec.js`), with **zero external ZIP dependencies** and ~33% smaller size than base64 JSON/HTML:

```text
[0..4)    ASCII Magic "AP3D"
[4..6)    uint16 version = 1
[6..8)    uint16 flags = 0
[8..12)   uint32 manifest_len  (UTF-8 JSON scene config)
[12..16)  uint32 toc_len       (UTF-8 JSON [{k, m, o, s}, ...])
[16..24)  uint64 payload_len   (raw concatenated WebP/PNG bytes)
[24 ..)   manifest + toc + raw binary assets
```

### Python CLI
```bash
# Pack motion_pack.json + assets into a single .ap3d binary file
python3 toolkit/ap3d_format.py pack --pack char/motion_pack.json --assets-root char --out dist/char.ap3d

# Inspect any .ap3d package
python3 toolkit/ap3d_format.py inspect --in dist/char.ap3d

# Extract .ap3d back into editable motion_pack.json + assets/
python3 toolkit/ap3d_format.py unpack --in dist/char.ap3d --out-dir unpacked_char

# Append extra animations from another .ap3d without re-baking!
python3 toolkit/ap3d_format.py merge --base dist/char.ap3d --extra dist/extra_pack.ap3d --out dist/char_full.ap3d
```

### Browser API & Drag-and-Drop
- Click **`LOAD`** (or drag-and-drop any `.ap3d` onto the 3D stage) to hot-load a character live.
- Click **`+MOTION`** (or hold **`Shift` + drag-and-drop** a `.ap3d`) to append its motions onto the currently loaded character!
- Click **`EXPORT`** (or call `await engine.exportAP3D()`) to download the current character (including merged motions) as a `.ap3d` binary file.

---

## 4. Supported Declarative FX Types in `motion_pack.json`
| `fx.type` | Effect | Key Parameters |
| :--- | :--- | :--- |
| `sparkle_perimeter` | Twinkling 2-frame sparkles around outer perimeter | `startFrame`, `durationFrames`, `points`, `sprite0`, `sprite1` |
| `orbit_trail` | Floating hearts/bubbles trailing an orbiting companion | `count`, `rx`, `ry`, `zBase`, `zSin1`, `zSin2`, `primarySprite`, `secondarySprite` |
| `burst_above` | Rising celebration icons above head | `startFrame`, `durationFrames`, `count`, `sprite`, `zBase` |
| `forward_slash_fan` | Angle-aligned 4-frame crescent slash + parabolic 3D spray | `startFrame`, `durationFrames`, `count`, `slashPrefix`, `dropletSprite`, `bubbleSprite`, `foamSprite` |
| `helix_vortex` | 3D double-helix spiraling elemental vortex | `count`, `slamFrame`, `baseRadius`, `maxHeight`, `dropletSprite`, `bubbleSprite`, `foamSprite` |
| `floor_wave_rings` | Concentric expanding stepped ground shockwave rings | `count`, `startFrame`, `durationFrames`, `staggerFrames`, `forwardOffset`, `sprite` |

---

## 5. Audit, Bundle & Universal Player
```bash
# Audit all modular HTML, CSS, and JS files
python3 engine/audit_pixel_build.py \
  --html engine/viewer_shell.html \
  --css engine/anime_ui_theme.css \
  --js engine/ap3d_codec.js engine/anime_ui_kit.js engine/anime_stack_engine.js

# Bundle standalone HTML + export .ap3d simultaneously
python3 engine/bundle_standalone.py \
  --html engine/viewer_shell.html \
  --js engine/anime_stack_engine.js \
  --pack my_char/motion_pack.json \
  --assets-root my_char \
  --export-ap3d dist/my-char.ap3d \
  --out dist/my-char-standalone.html

# Build a lightweight (~65 KB) universal drag-and-drop .ap3d Player HTML
python3 engine/bundle_standalone.py \
  --html engine/viewer_shell.html \
  --js engine/anime_stack_engine.js \
  --empty-player \
  --out dist/ap3d-player.html
```
