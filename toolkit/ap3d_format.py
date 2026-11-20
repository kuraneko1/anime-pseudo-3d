"""Anime Pseudo-3D (.ap3d) Portable Binary Container Codec & CLI.

Byte-compatible with `engine/ap3d_codec.js` (zero external dependencies in Python & Browser).

Binary Layout (Little-Endian):
  [0..4)    ASCII Magic: b"AP3D"
  [4..6)    uint16 Version: 1
  [6..8)    uint16 Flags: 0 (raw binary WebP/PNG assets)
  [8..12)   uint32 manifest_len (UTF-8 JSON manifest: motion_pack without file paths)
  [12..16)  uint32 toc_len (UTF-8 JSON TOC: [{"k": key, "m": mime, "o": offset, "s": size}, ...])
  [16..24)  uint64 payload_len (total raw asset payload byte size)
  [24 ..)   manifest_bytes + toc_bytes + raw binary asset payload
"""
import argparse
import json
import os
import struct
from typing import Any

MAGIC = b"AP3D"
VERSION = 1
HEADER_FMT = "<4sHHIIQ"
HEADER_SIZE = struct.calcsize(HEADER_FMT)  # 24 bytes

MIME_BY_EXT = {
    ".webp": "image/webp",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
}
EXT_BY_MIME = {
    "image/webp": ".webp",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
}


def encode_ap3d_bytes(scene_cfg: dict[str, Any], assets_binary: dict[str, tuple[str, bytes]]) -> bytes:
    """Encode a scene config dict and {key: (mime, raw_bytes)} into .ap3d binary bytes."""
    manifest_clean = {k: v for k, v in scene_cfg.items() if k != "assets"}
    manifest_bytes = json.dumps(manifest_clean, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    toc = []
    chunks = []
    offset = 0
    for key in sorted(assets_binary.keys()):
        mime, raw = assets_binary[key]
        size = len(raw)
        toc.append({"k": key, "m": mime, "o": offset, "s": size})
        chunks.append(raw)
        offset += size

    toc_bytes = json.dumps(toc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    header = struct.pack(HEADER_FMT, MAGIC, VERSION, 0, len(manifest_bytes), len(toc_bytes), offset)
    return b"".join([header, manifest_bytes, toc_bytes, *chunks])


def decode_ap3d_bytes(data: bytes) -> tuple[dict[str, Any], dict[str, tuple[str, bytes]]]:
    """Decode .ap3d binary bytes into (scene_cfg, {key: (mime, raw_bytes)})."""
    if len(data) < HEADER_SIZE:
        raise ValueError(f"Invalid .ap3d file: too short ({len(data)} bytes)")
    magic, version, flags, manifest_len, toc_len, payload_len = struct.unpack_from(HEADER_FMT, data, 0)
    if magic != MAGIC:
        raise ValueError(f"Invalid .ap3d magic: {magic!r} (expected {MAGIC!r})")
    if version != VERSION:
        raise ValueError(f"Unsupported .ap3d version: {version} (expected {VERSION})")

    p_manifest = HEADER_SIZE
    p_toc = p_manifest + manifest_len
    p_payload = p_toc + toc_len
    if p_payload + payload_len > len(data):
        raise ValueError("Truncated .ap3d payload")

    scene_cfg = json.loads(data[p_manifest:p_toc].decode("utf-8"))
    toc = json.loads(data[p_toc:p_payload].decode("utf-8"))
    assets_binary: dict[str, tuple[str, bytes]] = {}
    for entry in toc:
        k = entry["k"]
        m = entry["m"]
        o = entry["o"]
        s = entry["s"]
        assets_binary[k] = (m, data[p_payload + o : p_payload + o + s])
    return scene_cfg, assets_binary


def pack_ap3d(pack_json_path: str, assets_root: str, out_ap3d_path: str) -> str:
    """Pack a motion_pack.json + assets directory into a single portable .ap3d file."""
    with open(pack_json_path, "r", encoding="utf-8") as f:
        pack = json.load(f)

    asset_linear = dict(pack.get("assetLinear", {}))
    assets_binary: dict[str, tuple[str, bytes]] = {}
    for key, info in pack.get("assets", {}).items():
        fpath = os.path.join(assets_root, info["file"])
        if not os.path.exists(fpath):
            raise FileNotFoundError(f"Missing asset '{key}': {fpath}")
        ext = os.path.splitext(fpath)[1].lower()
        mime = MIME_BY_EXT.get(ext, "application/octet-stream")
        with open(fpath, "rb") as af:
            assets_binary[key] = (mime, af.read())
        if info.get("linear"):
            asset_linear[key] = True

    scene_cfg = {k: v for k, v in pack.items() if k != "assets"}
    scene_cfg["assetLinear"] = asset_linear

    blob = encode_ap3d_bytes(scene_cfg, assets_binary)
    os.makedirs(os.path.dirname(os.path.abspath(out_ap3d_path)), exist_ok=True)
    with open(out_ap3d_path, "wb") as f:
        f.write(blob)
    print(f"Packed .ap3d -> {out_ap3d_path} ({len(blob):,} bytes, {len(assets_binary)} assets)")
    return out_ap3d_path


def unpack_ap3d(ap3d_path: str, out_dir: str) -> str:
    """Extract a .ap3d package back into motion_pack.json + assets/."""
    with open(ap3d_path, "rb") as f:
        scene_cfg, assets_binary = decode_ap3d_bytes(f.read())

    assets_dir = os.path.join(out_dir, "assets")
    os.makedirs(assets_dir, exist_ok=True)
    linear_map = scene_cfg.get("assetLinear", {})

    assets_manifest = {}
    for key, (mime, raw) in assets_binary.items():
        ext = EXT_BY_MIME.get(mime, ".bin")
        safe_name = key.replace("/", "_").replace("\\", "_")
        rel = f"assets/{safe_name}{ext}"
        with open(os.path.join(out_dir, rel), "wb") as af:
            af.write(raw)
        entry: dict[str, Any] = {"file": rel}
        if linear_map.get(key):
            entry["linear"] = True
        assets_manifest[key] = entry

    pack = dict(scene_cfg)
    pack["assets"] = assets_manifest
    pack_path = os.path.join(out_dir, "motion_pack.json")
    with open(pack_path, "w", encoding="utf-8") as f:
        json.dump(pack, f, indent=2, ensure_ascii=False)
    print(f"Unpacked .ap3d -> {out_dir} ({len(assets_binary)} assets)")
    return pack_path


def inspect_ap3d(ap3d_path: str) -> dict[str, Any]:
    """Return and print a human-readable summary of a .ap3d package."""
    with open(ap3d_path, "rb") as f:
        raw_all = f.read()
    scene_cfg, assets_binary = decode_ap3d_bytes(raw_all)
    motions = scene_cfg.get("motions", [])
    companions = scene_cfg.get("companions", {})
    ch = scene_cfg.get("character", {})
    summary = {
        "file": ap3d_path,
        "bytes": len(raw_all),
        "title": scene_cfg.get("title", ""),
        "schema_version": scene_cfg.get("schema_version", "1.0"),
        "grid": f"{ch.get('sliceW')}x{ch.get('sliceH')}x{ch.get('sliceCount')}",
        "motions": [{"id": m.get("id"), "label": m.get("label"), "frames": m.get("frames", 24), "category": m.get("category")} for m in motions],
        "companions": list(companions.keys()),
        "asset_count": len(assets_binary),
    }
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return summary


def merge_ap3d_motions(base_ap3d: str, extra_ap3d: str, out_ap3d: str, prefix: str = "ext_") -> str:
    """Append motions, companions, and assets from extra_ap3d into base_ap3d without re-baking."""
    with open(base_ap3d, "rb") as f:
        base_cfg, base_assets = decode_ap3d_bytes(f.read())
    with open(extra_ap3d, "rb") as f:
        extra_cfg, extra_assets = decode_ap3d_bytes(f.read())

    merged_cfg = json.loads(json.dumps(base_cfg))
    merged_assets = dict(base_assets)
    merged_linear = dict(merged_cfg.get("assetLinear", {}))
    extra_linear = extra_cfg.get("assetLinear", {})

    existing_motion_ids = {m["id"] for m in merged_cfg.get("motions", [])}
    existing_comp_ids = set(merged_cfg.get("companions", {}).keys())

    # Remap colliding asset keys cleanly
    key_remap: dict[str, str] = {}
    for k, val in extra_assets.items():
        if k not in merged_assets:
            merged_assets[k] = val
            if extra_linear.get(k):
                merged_linear[k] = True
            key_remap[k] = k
        elif merged_assets[k][1] == val[1]:
            key_remap[k] = k
        else:
            nk = f"{prefix}{k}"
            idx = 2
            while nk in merged_assets:
                nk = f"{prefix}{idx}_{k}"
                idx += 1
            merged_assets[nk] = val
            if extra_linear.get(k):
                merged_linear[nk] = True
            key_remap[k] = nk

    # Merge companions
    merged_comps = merged_cfg.setdefault("companions", {})
    comp_remap: dict[str, str] = {}
    for cid, cdef in extra_cfg.get("companions", {}).items():
        ncid = cid
        if ncid in existing_comp_ids:
            ncid = f"{prefix}{cid}"
        c_copy = json.loads(json.dumps(cdef))
        kp = c_copy.get("keyPrefix", "")
        sample_key = f"{kp}00"
        if sample_key in key_remap and key_remap[sample_key] != sample_key:
            c_copy["keyPrefix"] = key_remap[sample_key][:-2]
        merged_comps[ncid] = c_copy
        comp_remap[cid] = ncid

    # Append motions with unique IDs & remapped prefixes/icons/billboards
    merged_motions = merged_cfg.setdefault("motions", [])
    added = 0
    for m in extra_cfg.get("motions", []):
        m_copy = json.loads(json.dumps(m))
        mid = m_copy["id"]
        if mid in existing_motion_ids:
            idx = 2
            while f"{mid}_{idx}" in existing_motion_ids:
                idx += 1
            mid = f"{mid}_{idx}"
            m_copy["id"] = mid
        existing_motion_ids.add(mid)

        kp = m_copy.get("keyPrefix", "")
        sample_key = f"{kp}00"
        if sample_key in key_remap and key_remap[sample_key] != sample_key:
            m_copy["keyPrefix"] = key_remap[sample_key][:-2]
        if m_copy.get("icon") in key_remap:
            m_copy["icon"] = key_remap[m_copy["icon"]]
        if m_copy.get("companion") and m_copy["companion"].get("id") in comp_remap:
            m_copy["companion"]["id"] = comp_remap[m_copy["companion"]["id"]]
        if m_copy.get("billboard") and m_copy["billboard"].get("assetKey") in key_remap:
            m_copy["billboard"]["assetKey"] = key_remap[m_copy["billboard"]["assetKey"]]
        merged_motions.append(m_copy)
        added += 1

    merged_cfg["assetLinear"] = merged_linear
    blob = encode_ap3d_bytes(merged_cfg, merged_assets)
    os.makedirs(os.path.dirname(os.path.abspath(out_ap3d)), exist_ok=True)
    with open(out_ap3d, "wb") as f:
        f.write(blob)
    print(f"Merged +{added} motions -> {out_ap3d} (total {len(merged_motions)} motions, {len(blob):,} bytes)")
    return out_ap3d


def main():
    ap = argparse.ArgumentParser(description="Anime Pseudo-3D (.ap3d) binary package tool.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_pack = sub.add_parser("pack", help="Pack motion_pack.json + assets into .ap3d")
    p_pack.add_argument("--pack", required=True)
    p_pack.add_argument("--assets-root", required=True)
    p_pack.add_argument("--out", required=True)

    p_unp = sub.add_parser("unpack", help="Unpack .ap3d into motion_pack.json + assets/")
    p_unp.add_argument("--in", dest="inp", required=True)
    p_unp.add_argument("--out-dir", required=True)

    p_ins = sub.add_parser("inspect", help="Inspect .ap3d manifest & payload")
    p_ins.add_argument("--in", dest="inp", required=True)

    p_mrg = sub.add_parser("merge", help="Append motions from extra .ap3d into base .ap3d")
    p_mrg.add_argument("--base", required=True)
    p_mrg.add_argument("--extra", required=True)
    p_mrg.add_argument("--out", required=True)

    args = ap.parse_args()
    if args.cmd == "pack":
        pack_ap3d(args.pack, args.assets_root, args.out)
    elif args.cmd == "unpack":
        unpack_ap3d(args.inp, args.out_dir)
    elif args.cmd == "inspect":
        inspect_ap3d(args.inp)
    elif args.cmd == "merge":
        merge_ap3d_motions(args.base, args.extra, args.out)


if __name__ == "__main__":
    main()
