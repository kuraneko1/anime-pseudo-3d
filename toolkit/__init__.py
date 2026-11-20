"""Anime Pseudo-3D Reusable Toolkit (GPU SDF, Face Projection, FK/IK Rigging, Pixel FX, QA & GIF Recorder)."""
from .gpu_sdf import xp, USE_GPU, to_numpy
from .rig_contracts import ArmPose, LegPose, PoseFrame, volume_preserving_sx, smoothstep, lerp3, periodic_lag
from .qa_validator import assert_no_border_clipping, validate_motion_poses, save_tiled_webp, render_stack_angle, render_animation_sheet
