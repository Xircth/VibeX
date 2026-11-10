import type {
  ThemeColorRole,
  ThemeDefinition,
  ThemeScheme,
} from '@vibex/plugin-sdk';

import { BUILTIN_THEMES } from './builtinThemes';
import {
  compositeOver,
  contrastRatio,
  hexToHslTriplet,
  mixHexColors,
  withAlpha,
} from './colorMath';

export type ResolvedThemeColors = Readonly<Record<ThemeColorRole, string>>;

/** `ink` mixed into `paper` at `weight`, pulled toward `ink` until it reaches
 * `minimum` contrast on every surface (or becomes `ink`). */
function readableMix(
  ink: string,
  paper: string,
  weight: number,
  minimum: number,
  surfaces: readonly string[]
): string {
  for (let share = weight; share < 1; share += 0.05) {
    const color = mixHexColors(ink, paper, share);
    if (surfaces.every((surface) => contrastRatio(color, surface) >= minimum)) {
      return color;
    }
  }
  return ink;
}

/** Fills every optional role so a two-color theme still paints a coherent UI.
 * Derived text roles keep the contrast `checkThemeContrast` asks of them. */
export function resolveThemeColors(
  theme: ThemeDefinition
): ResolvedThemeColors {
  const colors = theme.colors;
  const dark = theme.scheme === 'dark';
  const stock = BUILTIN_THEMES[theme.scheme].colors;
  const background = colors.background;
  const foreground = colors.foreground;
  const surface =
    colors.surface ??
    (dark ? mixHexColors(foreground, background, 0.06) : background);
  const muted =
    colors.mutedForeground ??
    readableMix(foreground, background, 0.7, 4.5, [background, surface]);
  const raised = colors.raisedControl ?? surface;
  const pick = (role: ThemeColorRole): string =>
    colors[role] ?? (stock[role] as string);
  return {
    background,
    foreground,
    chrome:
      colors.chrome ??
      (dark ? background : mixHexColors(foreground, background, 0.055)),
    surface,
    popover: colors.popover ?? surface,
    mutedForeground: muted,
    subtleForeground:
      colors.subtleForeground ??
      readableMix(muted, background, 0.7, 3, [background]),
    faintForeground:
      colors.faintForeground ?? mixHexColors(muted, background, 0.45),
    border:
      colors.border ?? mixHexColors(foreground, background, dark ? 0.25 : 0.18),
    borderSubtle:
      colors.borderSubtle ?? withAlpha(foreground, dark ? 0.1 : 0.08),
    control: colors.control ?? withAlpha(foreground, 0.05),
    controlHover: colors.controlHover ?? withAlpha(foreground, 0.1),
    raisedControl: raised,
    raisedControlHover:
      colors.raisedControlHover ??
      mixHexColors(foreground, raised, dark ? 0.12 : 0.04),
    track:
      colors.track ??
      (dark ? surface : mixHexColors(foreground, background, 0.1)),
    accent: pick('accent'),
    success: pick('success'),
    warning: pick('warning'),
    danger: pick('danger'),
    info: pick('info'),
    terminalBackground: colors.terminalBackground ?? background,
    terminalForeground: colors.terminalForeground ?? foreground,
    syntaxKeyword: pick('syntaxKeyword'),
    syntaxFunction: pick('syntaxFunction'),
    syntaxConstant: pick('syntaxConstant'),
    syntaxString: pick('syntaxString'),
    syntaxVariable: pick('syntaxVariable'),
    syntaxComment: pick('syntaxComment'),
    syntaxTag: pick('syntaxTag'),
    syntaxPunctuation: pick('syntaxPunctuation'),
    syntaxDeleted: pick('syntaxDeleted'),
  };
}

/** Text over a status fill or tint: the status hue pulled toward the ink. */
export const STATUS_TEXT_WEIGHT = {
  success: 0.55,
  warning: 0.55,
  danger: 0.8,
  info: 0.55,
} as const;

export function statusTextColor(
  colors: ResolvedThemeColors,
  status: keyof typeof STATUS_TEXT_WEIGHT
): string {
  return mixHexColors(
    colors[status],
    colors.foreground,
    STATUS_TEXT_WEIGHT[status]
  );
}

/** Whichever of the theme's own ink and paper reads better on `fill`. */
export function onColor(colors: ResolvedThemeColors, fill: string): string {
  return contrastRatio(colors.foreground, fill) >=
    contrastRatio(colors.background, fill)
    ? colors.foreground
    : colors.background;
}

/** Token declarations that repaint `.legacy-design` with this theme. */
export function compileThemeDeclarations(
  theme: ThemeDefinition
): Array<readonly [string, string]> {
  const c = resolveThemeColors(theme);
  const dark = theme.scheme === 'dark';
  const triplet = (color: string) =>
    hexToHslTriplet(compositeOver(color, c.background));
  const statusInk = (status: string) =>
    triplet(mixHexColors(status, c.foreground, 0.3));
  return [
    ['--surface-shell', c.background],
    ['--_background', triplet(c.background)],
    ['--surface-topbar', c.chrome],
    ['--_muted', triplet(c.chrome)],
    ['--_neutral', triplet(c.track)],
    ['--surface-content', c.surface],
    ['--card', triplet(c.surface)],
    ['--surface-popover', c.popover],
    ['--popover', triplet(c.popover)],
    ['--_secondary', triplet(dark ? c.surface : c.chrome)],
    ['--_input', triplet(dark ? c.surface : c.border)],
    ['--text-strong', c.foreground],
    ['--_foreground', triplet(c.foreground)],
    ['--_secondary-foreground', triplet(c.foreground)],
    ['--_accent-foreground', triplet(c.foreground)],
    ['--text-muted', c.mutedForeground],
    ['--_muted-foreground', triplet(c.mutedForeground)],
    ['--_neutral-foreground', triplet(c.mutedForeground)],
    ['--text-subtle', c.subtleForeground],
    ['--text-faint', c.faintForeground],
    ['--border-strong', c.border],
    ['--_border', triplet(c.border)],
    ['--border-subtle', c.borderSubtle],
    ['--surface-control', c.control],
    ['--surface-control-hover', c.controlHover],
    ['--surface-raised-control', c.raisedControl],
    ['--surface-raised-control-hover', c.raisedControlHover],
    ['--surface-track', c.track],
    ['--_accent', triplet(c.track)],
    ['--_primary', `var(--accent-hsl, ${triplet(c.accent)})`],
    [
      '--_primary-foreground',
      `var(--accent-foreground-hsl, ${triplet(onColor(c, c.accent))})`,
    ],
    ['--_success', triplet(c.success)],
    ['--_success-foreground', statusInk(c.success)],
    ['--_console-success', triplet(c.success)],
    ['--_warning', triplet(c.warning)],
    ['--_warning-foreground', statusInk(c.warning)],
    ['--_destructive', triplet(c.danger)],
    ['--_destructive-foreground', triplet(onColor(c, c.danger))],
    ['--_console-error', triplet(c.danger)],
    ['--_info', triplet(c.info)],
    ['--_info-foreground', statusInk(c.info)],
    ['--_console-background', triplet(c.terminalBackground)],
    ['--_console-foreground', triplet(c.terminalForeground)],
    ['--_syntax-keyword', c.syntaxKeyword],
    ['--_syntax-function', c.syntaxFunction],
    ['--_syntax-constant', c.syntaxConstant],
    ['--_syntax-string', c.syntaxString],
    ['--_syntax-variable', c.syntaxVariable],
    ['--_syntax-comment', c.syntaxComment],
    ['--_syntax-tag', c.syntaxTag],
    ['--_syntax-punctuation', c.syntaxPunctuation],
    ['--_syntax-deleted', c.syntaxDeleted],
  ];
}

/* Outrank the stock token blocks (`.legacy-design`, 0-2-0) by one element. */
const SCHEME_SELECTORS: Readonly<Record<ThemeScheme, string>> = {
  light: 'html .legacy-design:not(.dark):not(.dark .legacy-design)',
  dark: 'html .legacy-design.dark,\nhtml.dark .legacy-design',
};

const HIGH_CONTRAST_DECLARATIONS = [
  '--text-muted: var(--text-strong);',
  '--text-subtle: var(--text-strong);',
  '--border-subtle: color-mix(in srgb, var(--text-strong) 28%, transparent);',
  '--border-strong: color-mix(in srgb, var(--text-strong) 44%, transparent);',
];

/** One stylesheet for the active light and dark themes; stock schemes emit
 * nothing so the token defaults paint them. */
export function buildColorThemeStylesheet(
  themes: Readonly<Partial<Record<ThemeScheme, ThemeDefinition>>>
): string {
  const blocks: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    const theme = themes[scheme];
    if (!theme) continue;
    const selector = SCHEME_SELECTORS[scheme];
    const body = compileThemeDeclarations(theme)
      .map(([property, value]) => `  ${property}: ${value};`)
      .join('\n');
    blocks.push(`${selector} {\n${body}\n}`);
    blocks.push(
      `@media (prefers-contrast: more) {\n${selector} {\n${HIGH_CONTRAST_DECLARATIONS.map(
        (declaration) => `  ${declaration}`
      ).join('\n')}\n}\n}`
    );
  }
  return blocks.join('\n\n');
}
