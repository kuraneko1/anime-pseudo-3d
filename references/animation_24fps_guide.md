# 24-FPS Anime Pseudo-3D Motion, Physics-Coupled Rigging & FX Alignment Guide

This guide documents the proven engineering principles for ultra-fluid 24-FPS cyclic motions that look physically coherent from all 360° camera angles.

---

## 1. True 24-FPS Seamless Periodic Loops
- Standard clip length is **24 frames at 24 FPS** (`1.0 s` cycle, adjustable `6..36 FPS` at runtime).
- Drive rhythmic body motion with smooth periodic functions (`sin(ph)`, `cos(ph)`, `sin(ph)^2`, `_smoothstep` envelopes that start and end at `0.0`) so **frame 23 → frame 0 has zero visual seam**.
- Apply **volume-preserving squash & stretch** via `sx = volume_preserving_sx(stretch_y, squash_z)` on torso/body while letting runtime spring-damper physics (`springBeats` in `motion_pack.json`) add snappy elastic impact on snap/takeoff/landing beats.

---

## 2. Physics-Coupled Accessories & World-Anchored Pivots
- **World-Anchored Pivots**: If a character hangs from a peg/rope, sits on a prop, or holds a grounded staff, keep the stationary anchor in **world space** `(X, Y, Z)` and inverse-transform the moving body around that exact anchor via `rot_inv_xyz(X, Y, Z, anchor_x, anchor_y, anchor_z, ...)`!
- **Dynamic Connecting Straps / Ropes / Tails**: Compute moving attachment endpoints via the **forward transform** matching `rot_inv_xyz`, then stretch/twist connecting cords (`sd_polyline`) between the world anchor and the moving body attachment points on every frame. Similarly, any rope/ribbon wrapping a moving tail or limb MUST consume the exact same `(wag_y, curl_z)` bone offsets so cords NEVER detach or clip!
- **Phase-Delayed Secondary Inertia**: Long hair, ears, fins, ahoge, waist bows, skirts, and tails should trail root motion by `0.75 – 0.95 rad` (`periodic_lag(frame_idx, 24, lag_rad=0.85)`).

---

## 3. Unified FK + Direct 3D IK Arms
- **Use FK (`ArmPose(mode="fk")`)** for cyclical swings (idle breathing, walk arms, happy jump banzai, cheerful greeting waves).
- **Use Direct 3D IK Targets (`ArmPose(mode="ik", joints=(sh, el, wr, pm))`)** whenever a hand must hit an exact 3D landmark:
  - Finger-to-lips ("Shhh!") pose: place palm just below chin and extend an upright index finger across mouth height without touching eyes.
  - Bicep flex / proud stance: push elbows slightly forward and wider than side hair locks so fists pop cleanly outside hair silhouettes.
  - Petting an orbiting 3D companion: smoothly interpolate arm targets toward the companion's front-pass coordinates while `head_yaw` tracks `cos(orbit_phase)`.

---

## 4. Mandatory Face-Visibility Guard & Hero Camera Angle
- During dynamic forward lunges or ground slams (`torso_pitch > 0`), always counter-pitch the head upward (`head_pitch < 0`) so `torso_pitch + head_pitch <= 12°` and eyes remain visible.
- **Pick `defaults.angleDeg` intentionally**: Check whether `+22°` or `-22°` (`338°`) turns the subject's face/snout **toward** the camera! For horizontal subjects facing `-X` in FRONT view, `angleDeg = 338°` turns the snout & eyes toward the viewer for maximum immediate appeal.

---

## 5. FX Directionality & Billboard Clearance (Live WebGL Polish Check!)
- **`forward_slash_fan` fires along `+Y`** in `anime_stack_engine.js`. If your character/creature faces `-X` or `+X` (e.g., side-profile horizontal mascot), do NOT blindly attach `forward_slash_fan` (it will fire sideways out of the flank!). Instead, place explicit 3D **`sparkle_perimeter` burst coordinates** right around the snapping mouth/weapon (`[-56, ±10, 44]`, etc.) paired with centered `floor_wave_rings` (`forwardOffset: 0`)!
- **Pixel-Art Billboards**: Render text/meme bubbles with hard-edge 1-bit thresholded pixels + stepped pixel frames + 2px dark pixel outline, and verify in Stage 6 live WebGL screenshots that the billboard tail sits clear of the character's head/peg/ahoge and points naturally at the speaker.

---

## 6. Multi-Angle 3D QA & Zero-Clipping Verification
- Never judge a motion from slice atlases or a single front angle.
- Run `validate_motion_poses(poses)` pre-bake (for `PoseFrame` rigs), and call **`assert_no_border_clipping(vol)` on EVERY baked frame** (`check_bottom=True` for floating/hanging subjects, `check_bottom=False` for ground-standing feet).
- Visually inspect BOTH `qa/qa_motions_strip.png` (pre-bundle) AND `qa/browser_webgl_grid.png` (live headless Chrome WebGL across `338°/0°/90°/180°` + `20°/48°/90° TOP` + active motions) before shipping!
