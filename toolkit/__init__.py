"""Anime Pseudo-3D Reusable Toolkit (Multi-View Fitter, GPU SDF, Face Projection, FK/IK Rigging, Pixel FX, .ap3d Codec, QA & GIF Recorder)."""
from .gpu_sdf import xp, USE_GPU, to_numpy
from .rig_contracts import ArmPose, LegPose, PoseFrame, volume_preserving_sx, smoothstep, lerp3, periodic_lag
from .qa_validator import assert_no_border_clipping, validate_motion_poses, save_tiled_webp, render_stack_angle, render_animation_sheet
from .ap3d_format import pack_ap3d, unpack_ap3d, inspect_ap3d, merge_ap3d_motions
from .multiview_fitter import (
    remove_exterior_bg,
    split_multiview_sheet,
    align_and_measure_views,
    reconstruct_visual_hull,
    project_6view_colors,
    render_multiview_fit_qa,
)
