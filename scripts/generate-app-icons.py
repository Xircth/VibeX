#!/usr/bin/env python3
"""Generate desktop app icons from assets/app-icon.png.

The source is a full-bleed square. Desktop ICNS/PNG/ICO bake Apple's squircle
with a 10% canvas inset, and the mark is scaled down inside that shape so it
does not crowd the rounded edge. iOS and Android still receive an opaque square
for the platform mask.
"""

from __future__ import annotations

import struct
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "app-icon.png"
ICONS = ROOT / "src-tauri" / "icons"
MASTER_SIZE = 1024
# Apple's continuous-corner squircle is a superellipse; n≈5 matches macOS.
# 0.80 leaves a 10% margin so custom-shaped icons do not outsize system icons.
SQUIRCLE_N = 5.0
SQUIRCLE_SCALE = 0.80
# Keep the mark inside the squircle; 0.70 matches typical macOS app-icon padding.
CONTENT_SCALE = 0.70
WINDOWS_ICO_SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)
PNG_SIZES = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
}
WINDOWS_STORE_PNGS = {
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}


def squircle_mask(
    size: int, n: float = SQUIRCLE_N, scale: float = SQUIRCLE_SCALE
) -> Image.Image:
    center = (size - 1) / 2.0
    radius = size * scale / 2.0
    feather = 1.5 / radius
    data = bytearray(size * size)
    index = 0
    for y in range(size):
        y_term = abs((y - center) / radius) ** n
        for x in range(size):
            value = abs((x - center) / radius) ** n + y_term
            edge = (1.0 + feather - value) / (2.0 * feather)
            if edge >= 1:
                data[index] = 255
            elif edge <= 0:
                data[index] = 0
            else:
                edge = edge * edge * (3.0 - 2.0 * edge)
                data[index] = int(edge * 255 + 0.5)
            index += 1
    return Image.frombytes("L", (size, size), bytes(data))


def flatten_opaque(
    image: Image.Image, background: tuple[int, int, int] = (0, 0, 0)
) -> Image.Image:
    image = image.convert("RGBA")
    canvas = Image.new("RGBA", image.size, (*background, 255))
    return Image.alpha_composite(canvas, image)


def place_content(source: Image.Image, size: int, scale: float) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 255))
    content_size = max(1, round(size * scale))
    content = flatten_opaque(source).resize(
        (content_size, content_size), Image.Resampling.LANCZOS
    )
    offset = (size - content_size) // 2
    canvas.paste(content, (offset, offset))
    return canvas


def apply_squircle(image: Image.Image) -> Image.Image:
    image = image.convert("RGBA")
    mask = squircle_mask(image.size[0])
    red, green, blue, alpha = image.split()
    return Image.merge(
        "RGBA", (red, green, blue, ImageChops.multiply(alpha, mask))
    )


def resize(image: Image.Image, size: int) -> Image.Image:
    return image.resize((size, size), Image.Resampling.LANCZOS)


def write_pngs(master: Image.Image) -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    for name, size in {**PNG_SIZES, **WINDOWS_STORE_PNGS}.items():
        resize(master, size).save(ICONS / name, format="PNG")


def write_ico(master: Image.Image) -> None:
    master.save(
        ICONS / "icon.ico",
        format="ICO",
        sizes=[(size, size) for size in WINDOWS_ICO_SIZES],
    )


def write_iconset(master: Image.Image, iconset: Path) -> None:
    iconset.mkdir(parents=True, exist_ok=True)
    slots = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }
    for name, size in slots.items():
        resize(master, size).save(iconset / name, format="PNG")


def write_icns(master: Image.Image) -> None:
    with tempfile.TemporaryDirectory() as temp:
        iconset = Path(temp) / "AppIcon.iconset"
        write_iconset(master, iconset)
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(ICONS / "icon.icns")],
            check=True,
        )


def write_ios_android(master_path: Path) -> None:
    tauri = ROOT / "node_modules" / ".bin" / "tauri"
    if not tauri.exists():
        print("skipping tauri ios/android icons: @tauri-apps/cli is not installed")
        return
    subprocess.run(
        [
            str(tauri),
            "icon",
            str(master_path),
            "-o",
            str(ICONS),
            "--ios-color",
            "#000000",
        ],
        check=True,
        cwd=ROOT,
    )


def assert_ico_sizes() -> None:
    data = (ICONS / "icon.ico").read_bytes()
    count = struct.unpack_from("<H", data, 4)[0]
    sizes = []
    for index in range(count):
        offset = 6 + index * 16
        width = data[offset] or 256
        height = data[offset + 1] or 256
        sizes.append(f"{width}x{height}")
    missing = [
        f"{size}x{size}"
        for size in WINDOWS_ICO_SIZES
        if f"{size}x{size}" not in sizes
    ]
    if missing:
        raise SystemExit(f"icon.ico missing sizes: {', '.join(missing)}")


def main() -> int:
    if not SOURCE.exists():
        print(f"missing {SOURCE}", file=sys.stderr)
        return 1
    source = Image.open(SOURCE).convert("RGBA")
    if source.size[0] != source.size[1]:
        raise SystemExit(f"{SOURCE} must be square, got {source.size}")
    square = place_content(source, MASTER_SIZE, CONTENT_SCALE)
    desktop = apply_squircle(square)
    with tempfile.TemporaryDirectory() as temp:
        master_path = Path(temp) / "app-icon.png"
        square.save(master_path, format="PNG")
        write_ios_android(master_path)
    write_pngs(desktop)
    write_ico(desktop)
    write_icns(desktop)
    assert_ico_sizes()
    print(f"wrote app icons to {ICONS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
