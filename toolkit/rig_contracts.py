"""Unified FK + 3D IK Bone-Rig Contracts & Seamless 24-FPS Periodic Curve Helpers.

Decouples animation authoring (`evaluate_pose(frame, total) -> PoseFrame`) from
how a character model sculpts its geometry (`sculpt_frame(pose) -> RGBA volume`).
"""
from dataclasses import dataclass, field
import math
from typing import Literal

Vec3 = tuple[float, float, float]


def volume_preserving_sx(stretch_y: float, squash_z: float) -> float:
    """Compute X-axis compensation scale preserving 3D voxel volume under squash & stretch."""
    return 1.0 / math.sqrt(max(0.25, stretch_y * squash_z))


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    t = max(0.0, min(1.0, (x - edge0) / max(edge1 - edge0, 1e-6)))
    return t * t * (3.0 - 2.0 * t)


def lerp3(a: Vec3, b: Vec3, t: float) -> Vec3:
    return (
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    )


def periodic_lag(frame_idx: int, total: int = 24, lag_rad: float = 0.85, mult: float = 1.0) -> tuple[float, float]:
    """Return phase-delayed (sin, cos) for secondary anime spring lag (ears, hair, ribbons, tail)."""
    ph = (frame_idx / float(total)) * math.tau * mult - lag_rad
    return math.sin(ph), math.cos(ph)


@dataclass
class LegPose:
    pitch_deg: float = 0.0
    lift: float = 0.0


@dataclass
class ArmPose:
    mode: Literal["fk", "ik"] = "fk"
    # FK angles
    raise_deg: float = 0.0
    pitch_deg: float = 0.0
    forearm_wave_deg: float = 0.0
    # 3D IK target points (shoulder, elbow, wrist, palm) in torso-local space
    joints: tuple[Vec3, Vec3, Vec3, Vec3] | None = None
    hand_style: Literal["open", "fist", "shhh", "point", "hold"] = "open"
    style_weight: float = 0.0


@dataclass
class PoseFrame:
    motion_id: str
    frame_idx: int
    total_frames: int = 24
    expr: str = "smile"

    root_bob: float = 0.0
    root_sway_x: float = 0.0
    stretch_y: float = 1.0
    squash_z: float = 1.0

    torso_pitch: float = 0.0
    torso_roll: float = 0.0
    torso_yaw: float = 0.0

    leg_l: LegPose = field(default_factory=LegPose)
    leg_r: LegPose = field(default_factory=LegPose)
    arm_l: ArmPose = field(default_factory=ArmPose)
    arm_r: ArmPose = field(default_factory=ArmPose)

    skirt_flare: float = 1.0
    skirt_sway_x: float = 0.0
    bow_bob: float = 0.0

    head_bob: float = 0.0
    head_pitch: float = 0.0
    head_roll: float = 0.0
    head_yaw: float = 0.0

    ear_flap_l: float = 0.0
    ear_flap_r: float = 0.0
    ear_sweep: float = 0.0
    ahoge_bounce: float = 0.0
    ahoge_sway: float = 0.0
    tail_wag_x: float = 0.0
    tail_bob_z: float = 0.0
    hair_sway_x: float = 0.0
    hair_flare_y: float = 0.0

    @property
    def sx(self) -> float:
        return volume_preserving_sx(self.stretch_y, self.squash_z)
