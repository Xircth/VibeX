#!/usr/bin/env python3
"""Generate Windows NSIS installer icon assets from assets/app-icon.png.

The redesigned installer renders the product name, version and every label as
live text, so the only raster assets are the app mark itself. Each mark is
rendered at the exact device-pixel size the installer needs for a given DPI
bucket (100/125/150/200%), so NSIS never stretches a bitmap by a
non-integral factor at runtime.

Produces in src-tauri/installer/assets/:
- icon-light-{48,60,64,72,80,96,128}.bmp  dark mark on the light surface (#FFFFFF)
- icon-dark-{48,60,64,72,80,96,128}.bmp   light mark variant on the dark surface (#1F1F1F)

Large mark (welcome / finish / uninstall confirm): 64 / 80 / 96 / 128 px.
Small mark (location / progress / error):         48 / 60 / 72 / 96 px.

BMPs are 24-bit and pre-composited on the page surface colour (the installer
surfaces are opaque), which keeps LoadImage/STM_SETIMAGE trivial and exact.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

spec = importlib.util.spec_from_file_location(
    "generate_app_icons", ROOT / "scripts" / "generate-app-icons.py"
)
assert spec and spec.loader
generate_app_icons = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generate_app_icons)

SOURCE = ROOT / "assets" / "app-icon.png"
ASSETS_DIR = ROOT / "src-tauri" / "installer" / "assets"

# Installer surface tokens (must match src-tauri/installer/theme.nsh)
LIGHT_BG = (0xFF, 0xFF, 0xFF)
DARK_BG = (0x1F, 0x1F, 0x1F)
# Dark-mode mark: light squircle with dark glyph so it does not melt into #1F1F1F
DARK_MARK_LIGHT = (0xED, 0xED, 0xED)
DARK_MARK_INK = (0x14, 0x14, 0x14)

LARGE_SIZES = (64, 80, 96, 128)
SMALL_SIZES = (48, 60, 72, 96)
SIZES = tuple(sorted(set(LARGE_SIZES + SMALL_SIZES)))


def render_mark(source: Image.Image, size: int) -> Image.Image:
    # Render at 4x and downsample once: one integral resample per output size.
    big = generate_app_icons.render_desktop_icon(
        source, size * 4, generate_app_icons.WINDOWS_CONTENT_SCALE
    )
    return big.resize((size, size), Image.Resampling.LANCZOS)


def light_variant(mark: Image.Image) -> Image.Image:
    """Swap the mark's dark squircle / white glyph for light squircle / dark glyph."""
    r, g, b, a = mark.split()
    lum = Image.merge("RGB", (r, g, b)).convert("L")
    out = Image.new("RGBA", mark.size)
    px_l = lum.load()
    px_a = a.load()
    px = out.load()
    for y in range(mark.size[1]):
        for x in range(mark.size[0]):
            t = px_l[x, y] / 255.0  # 0 = squircle ink, 1 = glyph
            px[x, y] = tuple(
                round(DARK_MARK_LIGHT[i] + (DARK_MARK_INK[i] - DARK_MARK_LIGHT[i]) * t)
                for i in range(3)
            ) + (px_a[x, y],)
    return out


def composite(mark: Image.Image, bg: tuple[int, int, int]) -> Image.Image:
    canvas = Image.new("RGBA", mark.size, (*bg, 255))
    canvas.alpha_composite(mark)
    return canvas.convert("RGB")


def main() -> int:
    if not SOURCE.exists():
        print(f"missing {SOURCE}", file=sys.stderr)
        return 1
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    for stale in ASSETS_DIR.glob("brand-*.bmp"):
        stale.unlink()
    source = Image.open(SOURCE).convert("RGBA")
    for size in SIZES:
        mark = render_mark(source, size)
        composite(mark, LIGHT_BG).save(ASSETS_DIR / f"icon-light-{size}.bmp", format="BMP")
        composite(light_variant(mark), DARK_BG).save(
            ASSETS_DIR / f"icon-dark-{size}.bmp", format="BMP"
        )
    print(f"wrote installer icon assets ({', '.join(map(str, SIZES))} px) to {ASSETS_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
