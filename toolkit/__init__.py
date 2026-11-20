"""Anime Pseudo-3D Reusable Toolkit (Multi-View Blueprints, Pure GPU SDF, FK/IK Rigging, Pixel FX, .ap3d Codec, QA & GIF Recorder)."""
from .gpu_sdf import (
    xp, USE_GPU, to_numpy, vol_zyx_to_yxz,
    safe_pow, safe_sin_pow, sd_polyline, sdf_indent_bulge, sd_anime_head,
)
from .rig_contracts import ArmPose, LegPose, PoseFrame, volume_preserving_sx, smoothstep, lerp3, periodic_lag
from .qa_validator import assert_no_border_clipping, validate_motion_poses, save_tiled_webp, render_stack_angle, render_animation_sheet
from .ap3d_format import pack_ap3d, unpack_ap3d, inspect_ap3d, merge_ap3d_motions
from .multiview_fitter import (
    remove_exterior_bg,
    clear_interior_white_holes,
    split_multiview_sheet,
    sample_clean_palette,
    align_and_measure_views,
    reconstruct_visual_hull,
    project_6view_colors,
    render_multiview_fit_qa,
)
