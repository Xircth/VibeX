#!/usr/bin/env python3
"""Generate desktop installer visual assets from assets/app-icon.png.

Produces:
- src-tauri/installer/assets/brand-light.bmp      (480x124, 1x Windows Light brand lockup: Logo + VibeX below)
- src-tauri/installer/assets/brand-light-2x.bmp   (960x248, 2x Windows Light brand lockup: Logo + VibeX below)
- src-tauri/installer/assets/brand-dark.bmp       (480x124, 1x Windows Dark brand lockup: Logo + VibeX below)
- src-tauri/installer/assets/brand-dark-2x.bmp    (960x248, 2x Windows Dark brand lockup: Logo + VibeX below)
- src-tauri/installer/assets/dmg-background.png   (540x360, 1x macOS DMG background with center arrow)
- src-tauri/installer/assets/dmg-background@2x.png (1080x720, 2x macOS DMG background with center arrow)
"""

from __future__ import annotations

import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import importlib.util

spec = importlib.util.spec_from_file_location(
    "generate_app_icons", ROOT / "scripts" / "generate-app-icons.py"
)
assert spec and spec.loader
generate_app_icons = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generate_app_icons)

SOURCE = ROOT / "assets" / "app-icon.png"
ASSETS_DIR = ROOT / "src-tauri" / "installer" / "assets"

# Tahoe palette tokens (DESIGN.md)
LIGHT_BG = (255, 255, 255)
LIGHT_FG = (23, 23, 23)
DARK_BG = (27, 27, 27)
DARK_FG = (250, 250, 250)
DMG_ARROW_COLOR = (115, 115, 115, 255)


def load_brand_font(pixel_size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "C:/Windows/Fonts/segoeuib.ttf",
        "C:/Windows/Fonts/msyhbd.ttc",
        "C:/Windows/Fonts/arialbd.ttf",
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            try:
                return ImageFont.truetype(str(path), pixel_size)
            except OSError:
                continue
    return ImageFont.load_default()


def render_brand_lockup(
    source: Image.Image,
    scale: int,
    bg_rgb: tuple[int, int, int],
    fg_rgb: tuple[int, int, int],
) -> Image.Image:
    """Render centered VibeX squircle icon with 'VibeX' wordmark underneath."""
    width = 480 * scale
    height = 124 * scale
    icon_size = 68 * scale
    canvas = Image.new("RGBA", (width, height), (*bg_rgb, 255))

    icon = generate_app_icons.render_desktop_icon(
        source, icon_size, generate_app_icons.WINDOWS_CONTENT_SCALE
    )
    icon_x = (width - icon_size) // 2
    icon_y = 4 * scale
    canvas.alpha_composite(icon, (icon_x, icon_y))

    # Supersample text at 2x for crisp antialiasing
    text_scale = 2
    layer_w = width * text_scale
    layer_h = height * text_scale
    text_layer = Image.new("RGBA", (layer_w, layer_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(text_layer)
    font = load_brand_font(22 * scale * text_scale)
    label = "VibeX"
    bbox = draw.textbbox((0, 0), label, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    text_x = (layer_w - text_w) // 2 - bbox[0]
    text_y = (84 * scale * text_scale) - bbox[1]
    draw.text((text_x, text_y), label, font=font, fill=(*fg_rgb, 255))

    downsampled_text = text_layer.resize(
        (width, height), Image.Resampling.LANCZOS
    )
    canvas.alpha_composite(downsampled_text)
    return canvas.convert("RGB")


def render_dmg_background(scale: int) -> Image.Image:
    """Render minimal macOS DMG canvas (540x360 @ 1x) with center arrow."""
    width = 540 * scale
    height = 360 * scale
    # Supersample 2x for smooth arrow geometry
    ss = 2
    layer = Image.new("RGBA", (width * ss, height * ss), (*LIGHT_BG, 255))
    draw = ImageDraw.Draw(layer)

    cx = (width * ss) // 2
    cy = 175 * scale * ss
    half_len = 14 * scale * ss
    head = 7 * scale * ss
    stroke = max(2, round(2 * scale * ss))

    x1 = cx - half_len
    x2 = cx + half_len
    draw.line([(x1, cy), (x2, cy)], fill=DMG_ARROW_COLOR, width=stroke)
    draw.line(
        [(x2 - head, cy - head), (x2, cy), (x2 - head, cy + head)],
        fill=DMG_ARROW_COLOR,
        width=stroke,
        joint="curve",
    )

    return layer.resize((width, height), Image.Resampling.LANCZOS)


def main() -> int:
    if not SOURCE.exists():
        print(f"missing {SOURCE}", file=sys.stderr)
        return 1

    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    source = Image.open(SOURCE).convert("RGBA")

    render_brand_lockup(source, 1, LIGHT_BG, LIGHT_FG).save(
        ASSETS_DIR / "brand-light.bmp", format="BMP"
    )
    render_brand_lockup(source, 2, LIGHT_BG, LIGHT_FG).save(
        ASSETS_DIR / "brand-light-2x.bmp", format="BMP"
    )
    render_brand_lockup(source, 1, DARK_BG, DARK_FG).save(
        ASSETS_DIR / "brand-dark.bmp", format="BMP"
    )
    render_brand_lockup(source, 2, DARK_BG, DARK_FG).save(
        ASSETS_DIR / "brand-dark-2x.bmp", format="BMP"
    )

    render_dmg_background(1).save(
        ASSETS_DIR / "dmg-background.png", format="PNG"
    )
    render_dmg_background(2).save(
        ASSETS_DIR / "dmg-background@2x.png", format="PNG"
    )

    print(f"wrote installer assets to {ASSETS_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
