import type { ThemeColorRole, ThemeDefinition } from '@vibex/plugin-sdk';

import { contrastRatio } from './colorMath';
import {
  resolveThemeColors,
  statusTextColor,
  type ResolvedThemeColors,
} from './compileTheme';

export type ThemeContrastSeverity = 'error' | 'warning';

export interface ThemeContrastIssue {
  readonly foreground: ThemeColorRole;
  readonly background: ThemeColorRole;
  readonly ratio: number;
  readonly minimum: number;
  readonly severity: ThemeContrastSeverity;
}

type ContrastCheck = readonly [
  foreground: ThemeColorRole,
  background: ThemeColorRole,
  minimum: number,
  severity: ThemeContrastSeverity,
];

/* WCAG 2.2: 4.5:1 for body text, 3:1 for large text and UI glyphs. */
const CHECKS: readonly ContrastCheck[] = [
  ['foreground', 'background', 4.5, 'error'],
  ['foreground', 'chrome', 4.5, 'error'],
  ['foreground', 'surface', 4.5, 'error'],
  ['foreground', 'popover', 4.5, 'error'],
  ['mutedForeground', 'background', 4.5, 'error'],
  ['mutedForeground', 'surface', 4.5, 'error'],
  ['terminalForeground', 'terminalBackground', 4.5, 'error'],
  ['subtleForeground', 'background', 3, 'warning'],
  ['accent', 'background', 3, 'warning'],
];

const STATUS_ROLES = ['success', 'warning', 'danger', 'info'] as const;

function colorFor(colors: ResolvedThemeColors, role: ThemeColorRole): string {
  return (STATUS_ROLES as readonly string[]).includes(role)
    ? statusTextColor(colors, role as (typeof STATUS_ROLES)[number])
    : colors[role];
}

/** Every pair that falls short; `error` blocks saving a user theme. */
export function checkThemeContrast(
  theme: ThemeDefinition
): ThemeContrastIssue[] {
  const colors = resolveThemeColors(theme);
  const checks: ContrastCheck[] = [
    ...CHECKS,
    ...STATUS_ROLES.map(
      (role) =>
        [role, 'surface', 4.5, 'warning'] as const satisfies ContrastCheck
    ),
  ];
  const issues: ThemeContrastIssue[] = [];
  for (const [foreground, background, minimum, severity] of checks) {
    const ratio = contrastRatio(
      colorFor(colors, foreground),
      colors[background]
    );
    if (ratio < minimum) {
      issues.push({ foreground, background, ratio, minimum, severity });
    }
  }
  return issues;
}
