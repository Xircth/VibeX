import type { ThemeDefinition } from '@vibex/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { contrastRatio } from './colorMath';
import {
  buildColorThemeStylesheet,
  compileThemeDeclarations,
  resolveThemeColors,
} from './compileTheme';
import { checkThemeContrast } from './themeContrast';

const midnight: ThemeDefinition = {
  id: 'midnight',
  label: 'Midnight',
  scheme: 'dark',
  colors: { background: '#0b0e14', foreground: '#bfbdb6', accent: '#e6b450' },
};

describe('compileTheme', () => {
  it('derives every optional role from background and foreground', () => {
    const colors = resolveThemeColors(midnight);
    expect(colors.chrome).toBe('#0b0e14');
    expect(colors.popover).toBe(colors.surface);
    expect(colors.terminalBackground).toBe('#0b0e14');
    expect(colors.borderSubtle).toBe('#bfbdb61a');
    expect(
      contrastRatio(colors.mutedForeground, colors.background)
    ).toBeGreaterThan(4.5);
  });

  it('keeps derived secondary text readable under a soft ink', () => {
    const soft: ThemeDefinition = {
      id: 'soft',
      label: 'Soft',
      scheme: 'light',
      colors: { background: '#fcfcfc', foreground: '#5c6166' },
    };
    const colors = resolveThemeColors(soft);
    expect(colors.mutedForeground).not.toBe(colors.foreground);
    expect(
      contrastRatio(colors.mutedForeground, colors.background)
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(colors.subtleForeground, colors.background)
    ).toBeGreaterThanOrEqual(3);
    expect(
      checkThemeContrast(soft).filter((issue) => issue.severity === 'error')
    ).toEqual([]);
  });

  it('writes hex tokens, triplet twins, and an overridable accent', () => {
    const declarations = new Map(compileThemeDeclarations(midnight));
    expect(declarations.get('--surface-shell')).toBe('#0b0e14');
    expect(declarations.get('--_background')).toBe('220 29.03% 6.08%');
    expect(declarations.get('--text-strong')).toBe('#bfbdb6');
    expect(declarations.get('--_primary')).toBe(
      'var(--accent-hsl, 40 75% 60.78%)'
    );
    expect(declarations.get('--_primary-foreground')).toBe(
      'var(--accent-foreground-hsl, 220 29.03% 6.08%)'
    );
  });

  it('scopes each scheme above the stock token blocks', () => {
    const css = buildColorThemeStylesheet({ dark: midnight });
    expect(css).toContain(
      'html .legacy-design.dark,\nhtml.dark .legacy-design {\n  --surface-shell: #0b0e14;'
    );
    expect(css).toContain('@media (prefers-contrast: more)');
    expect(css).not.toContain(':not(.dark)');
    expect(buildColorThemeStylesheet({})).toBe('');
  });

  it('blocks unreadable themes and warns on weak accents', () => {
    const muddy: ThemeDefinition = {
      id: 'muddy',
      label: 'Muddy',
      scheme: 'light',
      colors: {
        background: '#cccccc',
        foreground: '#999999',
        accent: '#dddddd',
      },
    };
    const issues = checkThemeContrast(muddy);
    expect(issues).toContainEqual(
      expect.objectContaining({
        foreground: 'foreground',
        background: 'background',
        severity: 'error',
      })
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ foreground: 'accent', severity: 'warning' })
    );
    expect(
      checkThemeContrast(midnight).filter((issue) => issue.severity === 'error')
    ).toEqual([]);
  });
});
