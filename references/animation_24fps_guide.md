# 24-FPS Anime Pseudo-3D Motion & FK/IK Rigging Guide

This guide documents the principles for creating ultra-fluid 24-FPS cyclic anime motions that look smooth from all 360° camera angles.

## 1. True 24-FPS Seamless Periodic Loops
- Standard clip length is **24 frames at 24 FPS** (`1.0 s` cycle, adjustable `6..36 FPS` at runtime).
- Drive rhythmic body motion with smooth periodic functions (`sin(ph)`, `cos(ph)`, `sin(ph)^2`, `_smoothstep` envelopes that start and end at `0.0`) so **frame 23 → frame 0 has zero visual seam**.
- Apply **volume-preserving squash & stretch** via `sx = volume_preserving_sx(stretch_y, squash_z)` on torso/skirt while letting runtime spring-damper physics (`springBeats` in `motion_pack.json`) add snappy elastic impact on takeoff/landing/slash beats.

## 2. Phase-Delayed Secondary Anime Motion
- Long hair, animal/whale ears, ahoge, waist bows, skirts, and tails should trail the root motion by `0.75 – 0.95 rad` (`periodic_lag(frame_idx, 24, lag_rad=0.85)`).
- This single rule immediately transforms stiff voxel puppets into living anime characters.

## 3. Unified FK + Direct 3D IK Arms
- **Use FK (`ArmPose(mode="fk")`)** for cyclical swings (idle breathing, walk arms, happy jump banzai, cheerful greeting waves).
- **Use Direct 3D IK Targets (`ArmPose(mode="ik", joints=(sh, el, wr, pm))`)** whenever a hand must hit an exact 3D landmark:
  - Finger-to-lips ("Shhh!") pose: place palm just below chin and extend an upright index finger across mouth height without touching eye height.
  - Bicep flex / proud stance: push elbows slightly forward and wider than side hair locks so fists pop cleanly outside hair silhouettes.
  - Petting a 3D orbiting companion: smoothly interpolate arm targets from rest toward the companion's front-pass coordinates while `head_yaw` tracks `cos(orbit_phase)`.
  - Attack slashes & double-arm slams: interpolate joint tuples cleanly across windup → wide exterior arc → follow-through.

## 4. Mandatory Face-Visibility Guard
- During dynamic forward lunges or ground slams (`torso_pitch > 0`), adding positive `head_pitch` points the face down at the ground, hiding the character's fierce eyes!
- **Always counter-pitch the head upward (`head_pitch < 0`)** whenever `torso_pitch > 0`, keeping `torso_pitch + head_pitch <= 12°`.
- Run `toolkit/qa_validator.py::validate_motion_poses(poses)` before GPU baking to catch seam jumps and downward face tilts in milliseconds.

## 5. Multi-Angle 3D QA Before Shipping
- Never judge a motion from slice images or a single front angle.
- Call `assert_no_border_clipping(vol, check_bottom=False)` on every baked frame, and visually inspect the 3D rendered sheet (`render_animation_sheet`) at `0°`, `24°`, and `90°` to verify clean silhouettes, readable expressions, and unobstructed gestures.
