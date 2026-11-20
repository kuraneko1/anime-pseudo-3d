"""Deterministic WebGL 24-FPS Animated GIF Recorder for Anime Pseudo-3D Standalone Viewers.

Steps the 24-frame timeline bar cleanly in headless Chrome (SwiftShader WebGL) and encodes
palette-optimized, zero-dropped-frame seamless loop GIFs with FFmpeg.
"""
import argparse
import os
import shutil
import subprocess
import tempfile
from PIL import Image
from playwright.sync_api import sync_playwright


def record_motion_gif(
    html_path: str,
    motion_id: str,
    out_gif: str,
    angle_preset: str = "24",
    frames: int = 24,
    fps: int = 20,
    width: int = 380,
    crop_box: tuple[int, int, int, int] = (155, 85, 675, 685),
    chrome_path: str = "/usr/bin/google-chrome",
):
    tmp_dir = tempfile.mkdtemp(prefix="anime3d_gif_")
    url = "file://" + os.path.abspath(html_path)
    try:
        with sync_playwright() as p:
            launch_kwargs = dict(
                headless=True,
                args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl"],
            )
            if chrome_path and os.path.exists(chrome_path):
                launch_kwargs["executable_path"] = chrome_path
            browser = p.chromium.launch(**launch_kwargs)
            ctx = browser.new_context(viewport={"width": 1200, "height": 760})
            page = ctx.new_page()
            page.goto(url, wait_until="domcontentloaded")
            page.wait_for_timeout(1200)
            page.evaluate('document.querySelector(".stage-badge").style.display="none"; document.querySelector(".hud-chip").style.display="none";')
            page.locator(f'button[data-motion="{motion_id}"]').click()
            page.wait_for_timeout(250)
            page.locator(f'button[data-angle="{angle_preset}"]').click()
            page.wait_for_timeout(120)

            tl = page.locator("#timelineBar").bounding_box()
            for f in range(frames):
                ratio = (f + 0.5) / float(frames)
                page.mouse.click(tl["x"] + tl["width"] * ratio, tl["y"] + tl["height"] * 0.5)
                page.wait_for_timeout(75)
                fp = os.path.join(tmp_dir, f"f_{f:03d}.png")
                page.screenshot(path=fp)
                Image.open(fp).crop(crop_box).save(fp)

            ctx.close()
            browser.close()

        os.makedirs(os.path.dirname(os.path.abspath(out_gif)), exist_ok=True)
        subprocess.run([
            "ffmpeg", "-y", "-v", "error",
            "-framerate", str(fps),
            "-i", os.path.join(tmp_dir, "f_%03d.png"),
            "-vf", f"fps={fps},scale={width}:-1:flags=lanczos,split[s0][s1];"
                   f"[s0]palettegen=max_colors=192:stats_mode=diff[p];"
                   f"[s1][p]paletteuse=dither=bayer:bayer_scale=3",
            out_gif,
        ], check=True)
        print(f"Recorded GIF -> {out_gif} ({os.path.getsize(out_gif) / 1024.0:.1f} KB)")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description="Record a clean seamless GIF from an Anime Pseudo-3D standalone HTML.")
    ap.add_argument("--html", required=True)
    ap.add_argument("--motion", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--angle", default="24")
    ap.add_argument("--frames", type=int, default=24)
    ap.add_argument("--fps", type=int, default=20)
    ap.add_argument("--width", type=int, default=380)
    args = ap.parse_args()
    record_motion_gif(args.html, args.motion, args.out, args.angle, args.frames, args.fps, args.width)


if __name__ == "__main__":
    main()
