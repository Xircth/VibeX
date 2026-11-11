import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

import { BUILTIN_THEMES } from './builtinThemes';
import { hslToHex, parseHexColor } from './colorMath';
import { compileThemeDeclarations } from './compileTheme';
import { checkThemeContrast } from './themeContrast';

const css = readFileSync(
  resolve(process.cwd(), 'src/styles/legacy/index.css'),
  'utf8'
);

const SCHEME_SELECTORS = {
  light: ['.legacy-design'],
  dark: ['.legacy-design.dark', '.dark .legacy-design'],
} as const;

/* Derived from roles at compile time rather than carried by one. */
const DERIVED = new Set([
  '--_primary-foreground',
  '--_success-foreground',
  '--_warning-foreground',
  '--_info-foreground',
  '--_destructive-foreground',
  '--_neutral',
  '--_neutral-foreground',
]);

function tokenBlock(selectors: readonly string[]): Map<string, string> {
  const declarations = new Map<string, string>();
  parse(css).walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && rule.parent.name === 'media') return;
    const list = rule.selectors.map((selector) => selector.trim());
    if (
      list.length !== selectors.length ||
      !selectors.every((selector) => list.includes(selector))
    ) {
      return;
    }
    rule.each((node) => {
      if (node.type === 'decl') declarations.set(node.prop, node.value);
    });
  });
  return declarations;
}

function tripletToHex(value: string): string {
  const match = /^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(value.trim());
  if (!match) throw new Error(`not an HSL triplet: ${value}`);
  return hslToHex(
    Number(match[1]),
    Number(match[2]) / 100,
    Number(match[3]) / 100
  );
}

function cssColorToHex(value: string): string {
  const fallback = /^var\(--accent-hsl,\s*(.+)\)$/.exec(value);
  if (fallback) return tripletToHex(fallback[1]);
  const hsl = /^hsl\((.+)\)$/.exec(value);
  if (hsl) return tripletToHex(hsl[1]);
  if (value.startsWith('#')) return value.toLowerCase();
  return tripletToHex(value);
}

function closeColors(actual: string, expected: string): boolean {
  const a = parseHexColor(actual);
  const b = parseHexColor(expected);
  if (!a || !b) return false;
  return (
    Math.abs(a.r - b.r) <= 3 &&
    Math.abs(a.g - b.g) <= 3 &&
    Math.abs(a.b - b.b) <= 3 &&
    Math.abs(a.a - b.a) <= 0.01
  );
}

describe('built-in themes', () => {
  const light = tokenBlock(SCHEME_SELECTORS.light);
  const dark = tokenBlock(SCHEME_SELECTORS.dark);

  it.each(['light', 'dark'] as const)(
    'matches the %s token defaults in index.css',
    (scheme) => {
      const block = scheme === 'dark' ? dark : light;
      const mismatches: string[] = [];
      for (const [property, value] of compileThemeDeclarations(
        BUILTIN_THEMES[scheme]
      )) {
        if (DERIVED.has(property)) continue;
        let declared = block.get(property) ?? light.get(property);
        for (
          let alias = /^var\((--[\w-]+)\)$/.exec(declared ?? '');
          alias;
          alias = /^var\((--[\w-]+)\)$/.exec(declared ?? '')
        ) {
          declared = block.get(alias[1]) ?? light.get(alias[1]);
        }
        if (declared === undefined) {
          mismatches.push(`${property} is not declared`);
          continue;
        }
        const expected = cssColorToHex(declared);
        if (!closeColors(cssColorToHex(value), expected)) {
          mismatches.push(`${property}: theme ${value}, css ${declared}`);
        }
      }
      expect(mismatches).toEqual([]);
    }
  );

  it('passes every blocking contrast check', () => {
    for (const theme of Object.values(BUILTIN_THEMES)) {
      expect(
        checkThemeContrast(theme).filter((issue) => issue.severity === 'error')
      ).toEqual([]);
    }
  });
});
