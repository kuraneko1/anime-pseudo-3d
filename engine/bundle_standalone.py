"""Bundle a motion_pack.json + WebP/PNG assets + viewer_shell.html + anime_stack_engine.js
into a single zero-dependency standalone HTML file (works directly over file:// with zero CORS!).
"""
import argparse
import base64
import json
import os


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


def bundle_standalone(
    html_path: str,
    js_path: str,
    pack_path: str,
    assets_root: str,
    out_path: str,
    js_tag: str = '<script src="./anime_stack_engine.js"></script>',
    data_tag: str = '<script src="./scene_data.js"></script>',
):
    with open(pack_path, "r", encoding="utf-8") as f:
        pack = json.load(f)

    sprite_assets = {}
    asset_linear = {}
    for key, info in pack.get("assets", {}).items():
        fpath = os.path.join(assets_root, info["file"])
        if not os.path.exists(fpath):
            raise FileNotFoundError(f"Missing asset for key '{key}': {fpath}")
        sprite_assets[key] = encode_file_data_uri(fpath)
        if info.get("linear"):
            asset_linear[key] = True

    # Strip file paths from runtime SCENE_CONFIG to keep config clean
    scene_cfg = {k: v for k, v in pack.items() if k != "assets"}
    scene_cfg["assetLinear"] = asset_linear

    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()
    with open(js_path, "r", encoding="utf-8") as f:
        js_code = f.read()

    # Update document <title> cleanly from pack title
    if pack.get("title"):
        html = html.replace("__APP_TITLE__", pack["title"])

    inline_data = (
        "<script>\n"
        f"window.SCENE_CONFIG = {json.dumps(scene_cfg, separators=(',', ':'))};\n"
        f"window.SPRITE_ASSETS = {json.dumps(sprite_assets, separators=(',', ':'))};\n"
        "</script>"
    )
    inline_engine = f"<script>\n{js_code}\n</script>"

    if data_tag in html:
        html = html.replace(data_tag, inline_data, 1)
    else:
        html = html.replace("</body>", inline_data + "\n</body>", 1)

    if js_tag in html:
        html = html.replace(js_tag, inline_engine, 1)
    else:
        html = html.replace("</body>", inline_engine + "\n</body>", 1)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)

    sz = os.path.getsize(out_path)
    print(f"Bundled standalone HTML -> {out_path} ({sz:,} bytes, {len(sprite_assets)} assets)")


def main():
    ap = argparse.ArgumentParser(description="Bundle Anime Pseudo-3D standalone HTML.")
    ap.add_argument("--html", required=True)
    ap.add_argument("--js", required=True)
    ap.add_argument("--pack", required=True, help="Path to motion_pack.json")
    ap.add_argument("--assets-root", required=True, help="Root folder for relative paths in motion_pack.json")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    bundle_standalone(args.html, args.js, args.pack, args.assets_root, args.out)


if __name__ == "__main__":
    main()
