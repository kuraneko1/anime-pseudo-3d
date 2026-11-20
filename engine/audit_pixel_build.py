"""Automated 100% Pixel-Art Purity Auditor for Anime Pseudo-3D Builds.

Verifies zero native browser range/select inputs, zero OS Unicode emojis, zero non-zero border-radius,
zero backdrop-filter blur, zero Canvas 2D vector primitives, and zero cheap Web Audio oscillators.
"""
import argparse
import re
import sys


FORBIDDEN_HTML = [
    (r"<input\b[^>]*type\s*=\s*['\"]?range", "Native HTML range control found; use custom pixel .px-slider"),
    (r"<select\b", "Native HTML select menu found; use custom pixel buttons"),
    (r"backdrop-filter\s*:", "CSS backdrop-filter blur found; keep sharp solid pixel panels"),
    (r"border-radius\s*:\s*(?!0(?:\s|;|px|%|!))\S[^;]*", "Non-zero border-radius found; keep square pixel corners"),
]

FORBIDDEN_JS = [
    (r"\.arc\s*\(", "Canvas 2D vector arc() found; use pre-baked pixel sprites or WebGL quads"),
    (r"\.ellipse\s*\(", "Canvas 2D vector ellipse() found; use dithered pixel shadow sprites"),
    (r"\.stroke\s*\(", "Canvas 2D vector stroke() found; use stepped pixel sprites"),
    (r"\.fillText\s*\(", "Canvas 2D vector fillText() found; use pixel bitmap font or pixel DOM HUD"),
    (r"\bAudioContext\b|\bcreateOscillator\b", "Raw Web Audio oscillator detected; avoid synthetic chiptune beeps"),
]

EMOJI_RE = re.compile(
    "["
    "\U0001F300-\U0001FAFF"
    "\U00002600-\U000027BF"
    "]",
    flags=re.UNICODE,
)


def audit_file(path: str, rules: list[tuple[str, str]]) -> list[str]:
    issues = []
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    for pat, msg in rules:
        for m in re.finditer(pat, text, flags=re.IGNORECASE):
            line_no = text.count("\n", 0, m.start()) + 1
            issues.append(f"{path}:{line_no}: {msg}")
    for m in EMOJI_RE.finditer(text):
        line_no = text.count("\n", 0, m.start()) + 1
        issues.append(f"{path}:{line_no}: OS Unicode emoji '{m.group(0)}' found; use 16x16 pixel PNG icons")
    return issues


def main():
    ap = argparse.ArgumentParser(description="Audit HTML and JS files for 100% pixel-art compliance.")
    ap.add_argument("--html", required=True, help="Path to viewer HTML file")
    ap.add_argument("--js", required=True, help="Path to engine/viewer JS file")
    args = ap.parse_args()

    issues = []
    issues.extend(audit_file(args.html, FORBIDDEN_HTML))
    issues.extend(audit_file(args.js, FORBIDDEN_JS))

    if issues:
        print("AUDIT FAILED:")
        for it in issues:
            print("  -", it)
        sys.exit(1)
    print("AUDIT PASSED: 100% pixel-art compliant (zero default UI, zero emojis, zero vector canvas primitives).")


if __name__ == "__main__":
    main()
