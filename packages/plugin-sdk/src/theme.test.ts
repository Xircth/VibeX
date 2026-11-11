import { describe, expect, it } from 'vitest';

import { createPluginContext } from './context.js';
import { themeRegistry } from './registry.js';
import {
  parseThemeDefinition,
  validateThemeContributions,
  validateThemeDefinition,
} from './theme.js';

const mirage = {
  id: 'mirage',
  label: 'Mirage',
  scheme: 'dark',
  colors: { background: '#1F2430', foreground: '#ccc', border: '#ffffff1a' },
};

describe('theme contract', () => {
  it('accepts a minimal definition and normalizes its colors', () => {
    expect(validateThemeDefinition(mirage)).toEqual([]);
    expect(parseThemeDefinition(mirage).theme?.colors).toEqual({
      background: '#1f2430',
      foreground: '#cccccc',
      border: '#ffffff1a',
    });
  });

  it('reports every violation in one pass', () => {
    const issues = validateThemeDefinition({
      id: 'Bad Id',
      label: '',
      scheme: 'dim',
      colors: {
        background: '#00000080',
        accent: 'orange',
        glow: '#fff',
      },
      cssVariables: {},
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      'theme.cssVariables',
      'theme.id',
      'theme.label',
      'theme.scheme',
      'theme.colors.foreground',
      'theme.colors.background',
      'theme.colors.accent',
      'theme.colors.glow',
    ]);
  });

  it('rejects duplicate ids across a contribution list', () => {
    expect(validateThemeContributions([mirage, mirage])).toEqual([
      { path: 'themes[1].id', message: 'is duplicated' },
    ]);
    expect(validateThemeContributions({})).toEqual([
      { path: 'themes', message: 'must be an array' },
    ]);
  });

  it('registers normalized plugin themes and rejects invalid ones', () => {
    const ctx = createPluginContext({ pluginId: 'acme.themes' });
    ctx.registerTheme(mirage as Parameters<typeof ctx.registerTheme>[0]);
    expect(themeRegistry.get('acme.themes:mirage')?.colors.foreground).toBe(
      '#cccccc'
    );
    expect(() =>
      ctx.registerTheme({
        ...(mirage as Parameters<typeof ctx.registerTheme>[0]),
        id: 'broken',
        colors: { background: '#fff' } as never,
      })
    ).toThrow(/colors\.foreground is required/);
    ctx.dispose();
    expect(themeRegistry.get('acme.themes:mirage')).toBeUndefined();
  });
});
