/**
 * Shared hex color utilities
 */

export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function normalizeHexColor(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!HEX_COLOR_PATTERN.test(trimmed)) {
    return "";
  }
  return trimmed.toLowerCase();
}

/**
 * Compute a contrasting text color (black or white) for a given hex background.
 * Uses the W3C relative luminance formula.
 */
export function getContrastingTextColor(hex: string): string {
  const normalized = normalizeHexColor(hex);
  if (!normalized) {
    return "#ffffff";
  }
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#000000" : "#ffffff";
}
