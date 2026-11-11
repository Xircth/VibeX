import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseThemeDefinition, type ThemeDefinition } from '@vibex/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { checkThemeContrast } from './themeContrast';

const PLUGINS_DIR = resolve(process.cwd(), '../plugins');

function inTreePluginThemes(): Array<[string, unknown]> {
  return readdirSync(PLUGINS_DIR, { withFileTypes: true }).flatMap((entry) => {
    const manifestPath = join(
      PLUGINS_DIR,
      entry.name,
      '.vibex-plugin/plugin.json'
    );
    if (!entry.isDirectory() || !existsSync(manifestPath)) return [];
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      themes?: unknown[];
    };
    return (manifest.themes ?? []).map((theme, index): [string, unknown] => [
      `${entry.name} themes[${index}]`,
      theme,
    ]);
  });
}

describe('in-tree plugin themes', () => {
  const themes = inTreePluginThemes();

  it('ships at least one theme', () => {
    expect(themes.length).toBeGreaterThan(0);
  });

  it.each(themes)('%s passes the editor save gate', (_name, value) => {
    const parsed = parseThemeDefinition(value);
    expect(parsed.issues).toBeUndefined();
    const errors = checkThemeContrast(parsed.theme as ThemeDefinition).filter(
      (issue) => issue.severity === 'error'
    );
    expect(errors).toEqual([]);
  });
});
