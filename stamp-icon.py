#!/usr/bin/env python3
"""빌드 아이콘에 버전 번호를 오버레이합니다."""
import json, os, shutil, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFont

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

script_dir = os.path.dirname(os.path.abspath(__file__))
icons_dir  = os.path.join(script_dir, "src-tauri", "icons")

with open(os.path.join(script_dir, "build-number.json")) as f:
    build_number = json.load(f)["buildNumber"]

version_text  = f"v{build_number}"
original_icon = os.path.join(icons_dir, "icon.original.png")
icon_path     = os.path.join(icons_dir, "icon.png")

# 최초 실행 시 원본 백업
if not os.path.exists(original_icon):
    shutil.copy(icon_path, original_icon)
    print(f"  📦 원본 백업: icon.original.png")


def stamp(size: int) -> Image.Image:
    img = Image.open(original_icon).convert("RGBA").resize((size, size), Image.LANCZOS)
    draw = ImageDraw.Draw(img)

    font_size = max(int(size * 0.13), 7)
    for path in [
        os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts", "arialbd.ttf"),
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFNSMono.ttf",
    ]:
        try:
            font = ImageFont.truetype(path, font_size)
            break
        except Exception:
            font = ImageFont.load_default()

    bbox  = draw.textbbox((0, 0), version_text, font=font)
    tw    = bbox[2] - bbox[0]
    th    = bbox[3] - bbox[1]
    pad   = max(int(size * 0.025), 2)
    margin = max(int(size * 0.04), 3)

    x1 = size - tw - margin - pad * 2
    y1 = size - th - margin - pad * 2
    x2 = size - margin
    y2 = size - margin

    draw.rounded_rectangle([x1, y1, x2, y2], radius=int((y2 - y1) * 0.35), fill=(0, 0, 0, 190))
    draw.text((x1 + pad, y1 + pad), version_text, font=font, fill=(255, 255, 255, 255))
    return img


# 개별 PNG 스탬프
targets = [
    ("icon.png",        1024),
    ("128x128.png",      128),
    ("128x128@2x.png",   256),
    ("64x64.png",         64),
    ("32x32.png",         32),
]
for name, size in targets:
    stamp(size).save(os.path.join(icons_dir, name), "PNG")
    print(f"  ✓ {name} ({size}px)")

# Windows 설치 파일과 앱 아이콘이 쓰는 ICO를 항상 재생성
ico_path = os.path.join(icons_dir, "icon.ico")
stamp(256).save(
    ico_path,
    "ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("  ✓ icon.ico 재생성")

# iconutil은 macOS 전용이므로 macOS 빌드에서만 ICNS를 재생성
if sys.platform == "darwin":
    iconset_dir = tempfile.mkdtemp(prefix="portmanager_stamp_", suffix=".iconset")
    iconset_sizes = [
        ("icon_16x16.png",       16),
        ("icon_16x16@2x.png",    32),
        ("icon_32x32.png",       32),
        ("icon_32x32@2x.png",    64),
        ("icon_128x128.png",    128),
        ("icon_128x128@2x.png", 256),
        ("icon_256x256.png",    256),
        ("icon_256x256@2x.png", 512),
        ("icon_512x512.png",    512),
        ("icon_512x512@2x.png",1024),
    ]
    try:
        for name, size in iconset_sizes:
            stamp(size).save(os.path.join(iconset_dir, name), "PNG")

        icns_path = os.path.join(icons_dir, "icon.icns")
        subprocess.run(["iconutil", "-c", "icns", iconset_dir, "-o", icns_path], check=True)
        print("  ✓ icon.icns 재생성")
    finally:
        shutil.rmtree(iconset_dir, ignore_errors=True)
else:
    print("  ℹ icon.icns는 macOS 빌드에서 재생성")

print(f"✅ 아이콘 스탬프 완료: {version_text}")
