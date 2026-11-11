/**
 * Color-theme contract shared by the Host, the SDK, and the plugin CLI.
 *
 * A theme names semantic color roles; the Host compiles the roles onto its
 * design tokens. The same object is a plugin manifest `themes[]` entry and the
 * file the Appearance editor imports and exports. `crates/plugins` mirrors
 * these rules for install-time validation.
 */

export type ThemeScheme = 'light' | 'dark';

export const THEME_COLOR_ROLES = [
  'background',
  'foreground',
  'chrome',
  'surface',
  'popover',
  'mutedForeground',
  'subtleForeground',
  'faintForeground',
  'border',
  'borderSubtle',
  'control',
  'controlHover',
  'raisedControl',
  'raisedControlHover',
  'track',
  'accent',
  'success',
  'warning',
  'danger',
  'info',
  'terminalBackground',
  'terminalForeground',
  'syntaxKeyword',
  'syntaxFunction',
  'syntaxConstant',
  'syntaxString',
  'syntaxVariable',
  'syntaxComment',
  'syntaxTag',
  'syntaxPunctuation',
  'syntaxDeleted',
] as const;

export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number];

export const REQUIRED_THEME_COLOR_ROLES = [
  'background',
  'foreground',
] as const satisfies readonly ThemeColorRole[];

/** Roles painted as solid fills or text; translucency would composite into a
 * different color on every surface underneath. */
export const OPAQUE_THEME_COLOR_ROLES = [
  'background',
  'foreground',
  'chrome',
  'surface',
  'popover',
  'accent',
  'terminalBackground',
] as const satisfies readonly ThemeColorRole[];

export type ThemeColors = {
  readonly background: string;
  readonly foreground: string;
} & { readonly [Role in ThemeColorRole]?: string };

export interface ThemeDefinition {
  readonly id: string;
  readonly label: string;
  readonly scheme: ThemeScheme;
  readonly colors: ThemeColors;
}

export const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const THEME_LABEL_MAX_LENGTH = 64;
const COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const OPAQUE_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const ROLE_SET = new Set<string>(THEME_COLOR_ROLES);
const OPAQUE_ROLE_SET = new Set<string>(OPAQUE_THEME_COLOR_ROLES);

export interface ThemeIssue {
  readonly path: string;
  readonly message: string;
}

/** Expands `#rgb` and lowercases, so equal colors compare equal. */
export function normalizeThemeColor(value: string): string {
  const hex = value.trim().toLowerCase();
  if (hex.length !== 4) return hex;
  return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateThemeDefinition(
  value: unknown,
  path = 'theme'
): ThemeIssue[] {
  if (!isRecord(value)) {
    return [{ path, message: 'must be an object' }];
  }
  const issues: ThemeIssue[] = [];
  for (const key of Object.keys(value)) {
    if (!['id', 'label', 'scheme', 'colors'].includes(key)) {
      issues.push({ path: `${path}.${key}`, message: 'is not a theme field' });
    }
  }
  if (typeof value.id !== 'string' || !THEME_ID_PATTERN.test(value.id)) {
    issues.push({
      path: `${path}.id`,
      message: 'must be lowercase letters, digits, and hyphens',
    });
  }
  if (
    typeof value.label !== 'string' ||
    !value.label.trim() ||
    value.label.length > THEME_LABEL_MAX_LENGTH
  ) {
    issues.push({
      path: `${path}.label`,
      message: `must be 1-${THEME_LABEL_MAX_LENGTH} characters`,
    });
  }
  if (value.scheme !== 'light' && value.scheme !== 'dark') {
    issues.push({ path: `${path}.scheme`, message: 'must be light or dark' });
  }
  if (!isRecord(value.colors)) {
    issues.push({ path: `${path}.colors`, message: 'must be an object' });
    return issues;
  }
  for (const role of REQUIRED_THEME_COLOR_ROLES) {
    if (!(role in value.colors)) {
      issues.push({ path: `${path}.colors.${role}`, message: 'is required' });
    }
  }
  for (const [role, color] of Object.entries(value.colors)) {
    const rolePath = `${path}.colors.${role}`;
    if (!ROLE_SET.has(role)) {
      issues.push({ path: rolePath, message: 'is not a theme color role' });
    } else if (typeof color !== 'string' || !COLOR_PATTERN.test(color)) {
      issues.push({
        path: rolePath,
        message: 'must be a hex color (#rgb, #rrggbb, or #rrggbbaa)',
      });
    } else if (OPAQUE_ROLE_SET.has(role) && !OPAQUE_COLOR_PATTERN.test(color)) {
      issues.push({ path: rolePath, message: 'must be opaque' });
    }
  }
  return issues;
}

export function validateThemeContributions(
  value: unknown,
  path = 'themes'
): ThemeIssue[] {
  if (!Array.isArray(value)) {
    return [{ path, message: 'must be an array' }];
  }
  const issues: ThemeIssue[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    issues.push(...validateThemeDefinition(entry, entryPath));
    if (isRecord(entry) && typeof entry.id === 'string') {
      if (seen.has(entry.id)) {
        issues.push({ path: `${entryPath}.id`, message: 'is duplicated' });
      }
      seen.add(entry.id);
    }
  });
  return issues;
}

/** Returns the normalized definition, or the issues that make it invalid. */
export function parseThemeDefinition(
  value: unknown
):
  | { readonly theme: ThemeDefinition; readonly issues?: undefined }
  | { readonly theme?: undefined; readonly issues: readonly ThemeIssue[] } {
  const issues = validateThemeDefinition(value);
  if (issues.length > 0) return { issues };
  const record = value as ThemeDefinition;
  const colors: Record<string, string> = {};
  for (const role of THEME_COLOR_ROLES) {
    const color = record.colors[role];
    if (color !== undefined) colors[role] = normalizeThemeColor(color);
  }
  return {
    theme: {
      id: record.id,
      label: record.label.trim(),
      scheme: record.scheme,
      colors: colors as ThemeColors,
    },
  };
}
