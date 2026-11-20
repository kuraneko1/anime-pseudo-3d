"""Bundle a motion_pack.json (or .ap3d package) + modular UI/Engine into a single zero-dependency HTML.

Inlines:
  - engine/anime_ui_theme.css
  - engine/ap3d_codec.js
  - engine/anime_ui_kit.js
  - engine/anime_stack_engine.js
  - SCENE_CONFIG & SPRITE_ASSETS (from motion_pack.json, a .ap3d file, or empty universal .ap3d player)
Works directly over file:// with zero CORS and zero external network requests.
"""
import argparse
import base64
import json
import os
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from toolkit.ap3d_format import decode_ap3d_bytes, pack_ap3d

MIME_BY_EXT = {
    ".webp": "image/webp",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
}


def encode_file_data_uri(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    mime = MIME_BY_EXT.get(ext, "application/octet-stream")
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def encode_bytes_data_uri(mime: str, raw: bytes) -> str:
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def _inline_local_resources(html: str, engine_dir: str, js_path: str) -> str:
    css_path = os.path.join(engine_dir, "anime_ui_theme.css")
    codec_path = os.path.join(engine_dir, "ap3d_codec.js")
    uikit_path = os.path.join(engine_dir, "anime_ui_kit.js")

    if '<link rel="stylesheet" href="./anime_ui_theme.css" />' in html and os.path.exists(css_path):
        with open(css_path, "r", encoding="utf-8") as f:
            css_code = f.read()
        html = html.replace('<link rel="stylesheet" href="./anime_ui_theme.css" />', f"<style>\n{css_code}\n</style>", 1)

    if '<script src="./ap3d_codec.js"></script>' in html and os.path.exists(codec_path):
        with open(codec_path, "r", encoding="utf-8") as f:
            codec_code = f.read()
        html = html.replace('<script src="./ap3d_codec.js"></script>', f"<script>\n{codec_code}\n</script>", 1)

    if '<script src="./anime_ui_kit.js"></script>' in html and os.path.exists(uikit_path):
        with open(uikit_path, "r", encoding="utf-8") as f:
            ui_code = f.read()
        html = html.replace('<script src="./anime_ui_kit.js"></script>', f"<script>\n{ui_code}\n</script>", 1)

    with open(js_path, "r", encoding="utf-8") as f:
        js_code = f.read()
    js_tag = '<script src="./anime_stack_engine.js"></script>'
    inline_engine = f"<script>\n{js_code}\n</script>"
    if js_tag in html:
        html = html.replace(js_tag, inline_engine, 1)
    else:
        html = html.replace("</body>", inline_engine + "\n</body>", 1)
    return html


def bundle_standalone(
    html_path: str,
    js_path: str,
    pack_path: str | None = None,
    assets_root: str | None = None,
    out_path: str = "standalone.html",
    ap3d_in: str | None = None,
    ap3d_out: str | None = None,
    empty_player: bool = False,
):
    scene_cfg: dict = {}
    sprite_assets: dict[str, str] = {}

    if empty_player:
        scene_cfg = {
            "schema_version": "1.1",
            "title": "ANIME PSEUDO-3D PLAYER",
            "subtitle": "DROP .AP3D FILE OR CLICK LOAD",
            "motions": [],
            "assetLinear": {},
        }
    elif ap3d_in:
        with open(ap3d_in, "rb") as f:
            scene_cfg, bin_assets = decode_ap3d_bytes(f.read())
        for k, (mime, raw) in bin_assets.items():
            sprite_assets[k] = encode_bytes_data_uri(mime, raw)
    else:
        if not pack_path or not assets_root:
            raise ValueError("Provide either (--pack + --assets-root), --ap3d, or --empty-player")
        with open(pack_path, "r", encoding="utf-8") as f:
            pack = json.load(f)
        asset_linear = dict(pack.get("assetLinear", {}))
        for key, info in pack.get("assets", {}).items():
            fpath = os.path.join(assets_root, info["file"])
            if not os.path.exists(fpath):
                raise FileNotFoundError(f"Missing asset for key '{key}': {fpath}")
            sprite_assets[key] = encode_file_data_uri(fpath)
            if info.get("linear"):
                asset_linear[key] = True
        scene_cfg = {k: v for k, v in pack.items() if k != "assets"}
        scene_cfg["assetLinear"] = asset_linear

        if ap3d_out:
            pack_ap3d(pack_path, assets_root, ap3d_out)

    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()

    title = scene_cfg.get("title") or "Anime Pseudo-3D Viewer"
    html = html.replace("__APP_TITLE__", title)

    inline_data = (
        "<script>\n"
        f"window.SCENE_CONFIG = {json.dumps(scene_cfg, separators=(',', ':'))};\n"
        f"window.SPRITE_ASSETS = {json.dumps(sprite_assets, separators=(',', ':'))};\n"
        "</script>"
    )
    data_tag = '<script src="./scene_data.js"></script>'
    if data_tag in html:
        html = html.replace(data_tag, inline_data, 1)
    else:
        html = html.replace("</body>", inline_data + "\n</body>", 1)

    engine_dir = os.path.dirname(os.path.abspath(js_path))
    html = _inline_local_resources(html, engine_dir, js_path)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)

    sz = os.path.getsize(out_path)
    print(f"Bundled standalone HTML -> {out_path} ({sz:,} bytes, {len(sprite_assets)} assets)")


def main():
    ap = argparse.ArgumentParser(description="Bundle Anime Pseudo-3D standalone HTML (or universal .ap3d player).")
    ap.add_argument("--html", required=True)
    ap.add_argument("--js", required=True)
    ap.add_argument("--pack", help="Path to motion_pack.json")
    ap.add_argument("--assets-root", help="Root folder for relative paths in motion_pack.json")
    ap.add_argument("--ap3d", help="Bundle directly from a .ap3d binary package")
    ap.add_argument("--export-ap3d", help="Also emit a portable .ap3d package alongside the standalone HTML")
    ap.add_argument("--empty-player", action="store_true", help="Build a lightweight universal .ap3d player HTML with no embedded character")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    bundle_standalone(
        html_path=args.html,
        js_path=args.js,
        pack_path=args.pack,
        assets_root=args.assets_root,
        out_path=args.out,
        ap3d_in=args.ap3d,
        ap3d_out=args.export_ap3d,
        empty_player=args.empty_player,
    )


if __name__ == "__main__":
    main()
