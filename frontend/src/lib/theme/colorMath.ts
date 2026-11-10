/** sRGB hex math shared by the accent pipeline and color themes. */

export type Rgba = { r: number; g: number; b: number; a: number };

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function parseHexColor(value: string): Rgba | null {
  const match = HEX_PATTERN.exec(value.trim());
  if (!match) return null;
  let hex = match[1].toLowerCase();
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((digit) => digit + digit)
      .join('');
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

function requireHexColor(value: string): Rgba {
  const color = parseHexColor(value);
  if (!color) throw new TypeError(`Not a hex color: ${value}`);
  return color;
}

function channelHex(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, '0');
}

export function formatHexColor({ r, g, b, a }: Rgba): string {
  const rgb = `#${channelHex(r)}${channelHex(g)}${channelHex(b)}`;
  return a >= 1 ? rgb : `${rgb}${channelHex(a * 255)}`;
}

/** Mixes two colors like CSS `color-mix(in srgb, first weight, second)`. */
export function mixHexColors(
  first: string,
  second: string,
  weight: number
): string {
  const a = requireHexColor(first);
  const b = requireHexColor(second);
  const mix = (x: number, y: number) => x * weight + y * (1 - weight);
  return formatHexColor({
    r: mix(a.r, b.r),
    g: mix(a.g, b.g),
    b: mix(a.b, b.b),
    a: mix(a.a, b.a),
  });
}

export function withAlpha(color: string, alpha: number): string {
  return formatHexColor({ ...requireHexColor(color), a: alpha });
}

/** Flattens a translucent color onto an opaque backdrop. */
export function compositeOver(top: string, backdrop: string): string {
  const fg = requireHexColor(top);
  const bg = requireHexColor(backdrop);
  const blend = (x: number, y: number) => x * fg.a + y * (1 - fg.a);
  return formatHexColor({
    r: blend(fg.r, bg.r),
    g: blend(fg.g, bg.g),
    b: blend(fg.b, bg.b),
    a: 1,
  });
}

function linearChannel(value: number): number {
  const channel = value / 255;
  return channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: string): number {
  const { r, g, b } = requireHexColor(color);
  return (
    0.2126 * linearChannel(r) +
    0.7152 * linearChannel(g) +
    0.0722 * linearChannel(b)
  );
}

/** WCAG contrast of `first` painted on the opaque backdrop `second`. */
export function contrastRatio(first: string, second: string): number {
  const backdrop = formatHexColor({ ...requireHexColor(second), a: 1 });
  const a = relativeLuminance(compositeOver(first, backdrop));
  const b = relativeLuminance(backdrop);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function hexToHsl(color: string): { h: number; s: number; l: number } {
  const { r, g, b } = requireHexColor(color);
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;
  if (max !== min) {
    const delta = max - min;
    saturation =
      lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    switch (max) {
      case red:
        hue = (green - blue) / delta + (green < blue ? 6 : 0);
        break;
      case green:
        hue = (blue - red) / delta + 2;
        break;
      default:
        hue = (red - green) / delta + 4;
        break;
    }
    hue /= 6;
  }
  return { h: hue * 360, s: saturation, l: lightness };
}

export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = l - chroma / 2;
  const [red, green, blue] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return formatHexColor({
    r: (red + match) * 255,
    g: (green + match) * 255,
    b: (blue + match) * 255,
    a: 1,
  });
}

function formatNumber(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, '');
}

/** `H S% L%` components for the `hsl(var(--token))` token convention. */
export function hexToHslTriplet(color: string): string {
  const { h, s, l } = hexToHsl(color);
  return `${formatNumber(h, 1)} ${formatNumber(s * 100, 2)}% ${formatNumber(l * 100, 2)}%`;
}
